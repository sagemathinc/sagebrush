// SyncAccount: one account's sync state (design/sync-server.md §3).  Named
// idFromName("acct:" + account_hash).  Reached only from the Worker
// (server.ts), which has authenticated the session, and from the account's
// own document objects (doc.ts).
//
// This slice holds: the account socket (hibernation API, §5.1), its
// session rechecks and the allowlist (§2, §11); the index's ops, decided
// once each in dseq order (§3, §5.2); batches, whose blobs are pinned
// before the forward and settled after it (§4.3, §5.3); pulls and clears
// (§4.6); and revoke (§2).  Blob uploads, tickets and document sockets,
// grants and limits come in the next slices.

import { DurableObject } from "cloudflare:workers";
import {
  SyncError, LIMITS, RECHECK_MS, PIN_MS, VERSION, Bucket, checkBatch, checkHead, checkOp, clientOf, fields, has, isDevice, isDocId, isNat,
  parseMessage, PERSON_ONLY, attempt, randomHex, LIMITS_TTL_MS, isSha, type Batch, type DocKind, type Head, type Result,
} from "./protocol.ts";
import { patchRef, unwrap, type BatchOut } from "./doc.ts";
import { allowed, type SyncEnv } from "./env.ts";
import { MAX_PUT } from "../share/server.ts";

type Row = Record<string, ArrayBuffer | string | number | null>;

/** What a socket carries across hibernation (serializeAttachment). */
interface Attachment {
  account: string;
  session: string;
  /** the session's expiry, ms */
  expires: number;
  /** when the session was last checked against D1, ms */
  checked: number;
  device?: string;
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS devices (device TEXT PRIMARY KEY, name TEXT, created INTEGER, last_seen INTEGER, session_hash TEXT, next_dseq INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY, device TEXT NOT NULL, dseq INTEGER NOT NULL, t INTEGER, by TEXT, op TEXT, path TEXT, \"to\" TEXT, kind TEXT, ref TEXT, fid TEXT, sha256 TEXT, size INTEGER, base TEXT, recv INTEGER, UNIQUE (device, dseq))",
  "CREATE TABLE IF NOT EXISTS refused (device TEXT NOT NULL, dseq INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (device, dseq))",
  "CREATE TABLE IF NOT EXISTS docs (doc TEXT PRIMARY KEY, kind TEXT NOT NULL, created INTEGER, bytes INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 1, head_seq INTEGER NOT NULL DEFAULT 0, deleted INTEGER)",
  "CREATE TABLE IF NOT EXISTS holdings (sha256 TEXT PRIMARY KEY, key TEXT NOT NULL, size INTEGER NOT NULL, refs INTEGER NOT NULL DEFAULT 0, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS pins (doc TEXT NOT NULL, epoch INTEGER NOT NULL, ref TEXT NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER, PRIMARY KEY (doc, epoch, ref, sha256))",
  "CREATE INDEX IF NOT EXISTS pins_pending ON pins (expires) WHERE state = 'pending'",
  "CREATE TABLE IF NOT EXISTS revoked_sessions (session_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, created INTEGER)",
  "CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, key TEXT NOT NULL, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS reads (day INTEGER NOT NULL, who TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (day, who))",
];

/** The limits CoCalc gives an account (design/sync-server.md §6), as this service reads them. */
export interface Limits { storage_bytes: number; max_file_bytes: number; sync: { enabled: boolean; storage_bytes: number; version_bytes: number; read_bytes_per_day: number }; issued?: number }
/** Dev deployments with no CoCalc to ask (SHARE_DEV=1): small, fixed limits. */
const DEV_LIMITS: Limits = { storage_bytes: 1 << 30, max_file_bytes: MAX_PUT, sync: { enabled: true, storage_bytes: 1 << 30, version_bytes: 256 << 20, read_bytes_per_day: 4 << 30 } };
/** How long an upload may take before its reservation is reaped (§5.4). */
const RESERVE_MS = 3600_000;
/** An unused holding is dropped a day after its upload (§3). */
const IDLE_HOLDING_MS = 86400_000;

const send = (ws: WebSocket, v: unknown) => {
  try {
    ws.send(JSON.stringify(v));
  } catch {}
};
const refusal = (e: unknown) =>
  e instanceof SyncError ? { code: e.code, detail: { message: e.message, ...e.detail } } : { code: "busy" as const, detail: { message: "try again" } };

export class SyncAccount extends DurableObject<SyncEnv> {
  private sql: SqlStorage;
  private batches = new Bucket(LIMITS.batchBurst, LIMITS.batchRate);
  private opsRate = new Bucket(LIMITS.opsPerMinute, LIMITS.opsPerMinute / 60);
  private inflight = new WeakMap<WebSocket, number>();

  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private one(q: string, ...b: unknown[]): Row | undefined {
    return this.sql.exec(q, ...b).toArray()[0] as Row | undefined;
  }
  private get(k: string): string | undefined {
    return this.one("SELECT v FROM meta WHERE k = ?", k)?.v as string | undefined;
  }
  private set(k: string, v: string | number) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  /** Whether sync was turned on here: a refused request never makes tables (§2). */
  private exists(): boolean {
    return this.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'") !== undefined && this.get("account_id") !== undefined;
  }
  private state(): string {
    return this.get("state") ?? "active";
  }

  /** Turn sync on for this account: from a session, the only way this object gets storage. */
  async enable(a: { account: string; hash: string }): Promise<Result<{ state: string }>> {
    return attempt(() => this.ctx.storage.transactionSync(() => {
      if (!allowed(this.env, a.account)) throw new SyncError("forbidden", "sync isn't enabled for this account");
      for (const s of SCHEMA) this.sql.exec(s);
      const had = this.get("account_id");
      if (had !== undefined && had !== a.account) throw new SyncError("forbidden", "not this account");
      if (had === undefined) {
        this.set("account_id", a.account);
        this.set("account_hash", a.hash);
        this.set("created", Date.now());
        this.set("state", "active");
      }
      return { state: this.state() };
    }));
  }

  /** The checks every request makes first: this account, sync on, allowed (§2, §11). */
  private admit(account: string, write: boolean) {
    if (!this.exists() || this.get("account_id") !== account) throw new SyncError("forbidden", "turn on sync first");
    if (!allowed(this.env, account)) throw new SyncError("forbidden", "sync isn't enabled for this account");
    const st = this.state();
    if (st === "deleting") throw new SyncError("deleting", "this account's synced data is being deleted");
    if (write && st === "readonly") throw new SyncError("readonly", "sync is read-only for this account");
  }

  // ---- the account socket (§5.1)

  /** The upgrade, from the Worker, which authenticated the session and checked Origin. */
  async fetch(req: Request): Promise<Response> {
    const account = req.headers.get("x-sync-account") ?? "";
    const session = req.headers.get("x-sync-session") ?? "";
    const expires = Number(req.headers.get("x-sync-expires"));
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
    try {
      this.admit(account, false);
      if (this.one("SELECT 1 AS x FROM revoked_sessions WHERE session_hash = ?", session)) throw new SyncError("forbidden", "this session was ended");
    } catch (e) {
      return Response.json({ error: refusal(e).code }, { status: 403 });
    }
    // (at most accountSockets: the oldest is closed)
    const open = this.ctx.getWebSockets();
    if (open.length >= LIMITS.accountSockets) open[0].close(4408, "too many sockets for this account");
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`s:${session}`]);
    server.serializeAttachment({ account, session, expires, checked: Date.now() } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    let req: unknown;
    try {
      const m = parseMessage(raw);
      req = m.req;
      if (!(await this.sessionLive(ws, att))) return;
      const n = this.inflight.get(ws) ?? 0;
      if (n >= LIMITS.inflight) throw new SyncError("busy", "too many requests unanswered");
      this.inflight.set(ws, n + 1);
      try {
        await this.handle(ws, att, m);
      } finally {
        this.inflight.set(ws, (this.inflight.get(ws) ?? 1) - 1);
      }
    } catch (e) {
      if (e instanceof SyncError && e.code === "limit" && e.detail?.limit === "message_bytes") return ws.close(1009, "message too large");
      send(ws, { t: "error", ...(isNat(req) ? { req } : {}), ...refusal(e) });
    }
  }

  /**
   * The session behind a socket (§2): its expiry on every message; revoked
   * here; and D1 again after RECHECK_MS.  A session that is gone closes it.
   */
  private async sessionLive(ws: WebSocket, att: Attachment): Promise<boolean> {
    const now = Date.now();
    const end = (why: string) => {
      send(ws, { t: "revoked" });
      ws.close(4401, why);
      return false;
    };
    if (now >= att.expires) return end("session expired");
    if (!allowed(this.env, att.account)) return end("sync isn't enabled for this account");
    if (this.one("SELECT 1 AS x FROM revoked_sessions WHERE session_hash = ?", att.session)) return end("session ended");
    if (now - att.checked >= RECHECK_MS) {
      const db = this.env.SHARE_DB;
      const row = db
        ? await db.prepare("SELECT s.expires FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?1 AND s.account_id = ?2 AND s.expires > ?3 AND a.deleting IS NULL").bind(att.session, att.account, Math.floor(now / 1000)).first<{ expires: number }>()
        : null;
      if (!row) return end("session ended");
      ws.serializeAttachment({ ...att, checked: now, expires: row.expires * 1000 } satisfies Attachment);
    }
    return true;
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closed");
    } catch {}
  }

  private async handle(ws: WebSocket, att: Attachment, m: Record<string, unknown>) {
    const t = m.t;
    if (t === "hello") return this.hello(ws, att, fields(m, ["t", "v", "device", "name", "index_after", "docs"], "hello"));
    const dev = (ws.deserializeAttachment() as Attachment).device;
    if (!dev) throw new SyncError("invalid", "say hello first");
    const req = m.req;
    if (!isNat(req)) throw new SyncError("invalid", "req");
    if (t === "ops") {
      fields(m, ["t", "req", "ops"], "ops");
      send(ws, { t: "ack", req, ops: this.ops(att, dev, m.ops) });
    } else if (t === "pull_index") {
      fields(m, ["t", "req", "after"], "pull_index");
      if (!isNat(m.after)) throw new SyncError("invalid", "after");
      send(ws, { t: "index", req, ...this.index(m.after) });
    } else if (t === "batch") {
      fields(m, ["t", "req", "owner", "doc", "epoch", "kind", "expect_head", "patches", "body"], "batch");
      const out = await this.batch(att, dev, checkBatch(m));
      send(ws, { t: "ack", req, batch: { seq: out.seq, new: out.new, resent: out.resent, head: out.head } });
      if (out.new > 0) this.changed(ws, m.doc as string, out.head, dev);
    } else if (t === "pull") {
      fields(m, ["t", "req", "owner", "doc", "epoch", "after", "limit"], "pull");
      if (!isDocId(m.doc) || !isNat(m.epoch) || !isNat(m.after) || (has(m, "limit") && !isNat(m.limit))) throw new SyncError("invalid", "pull");
      this.admit(att.account, false);
      const out = unwrap(await this.docStub(m.doc).pull({ account: att.account, epoch: m.epoch, after: m.after, limit: m.limit as number | undefined }));
      send(ws, { t: "batches", req, owner: this.get("account_hash"), doc: m.doc, ...out });
    } else if (t === "clear") {
      fields(m, ["t", "req", "owner", "doc", "expect_head", "root"], "clear");
      const out = await this.clear(att, dev, m);
      send(ws, { t: "ack", req, batch: { seq: out.seq, new: out.new, resent: out.resent, head: out.head } });
      this.changed(ws, m.doc as string, out.head, dev);
    } else throw new SyncError("invalid", "unknown message");
  }

  private hello(ws: WebSocket, att: Attachment, m: Record<string, unknown>) {
    if (m.v !== VERSION) throw new SyncError("invalid", `protocol version ${VERSION} only`);
    if (!isDevice(m.device)) throw new SyncError("invalid", "device");
    if (typeof m.name !== "string" || m.name.length > 100) throw new SyncError("invalid", "name");
    if (!isNat(m.index_after)) throw new SyncError("invalid", "index_after");
    if (has(m, "docs") && (!Array.isArray(m.docs) || m.docs.length > LIMITS.helloDocs)) throw new SyncError("limit", "hello: too many docs", { limit: "hello_docs", max: LIMITS.helloDocs });
    this.admit(att.account, false);
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO devices (device, name, created, last_seen, session_hash, next_dseq) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(device) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen, session_hash = excluded.session_hash",
      m.device, m.name, now, now, att.session,
    );
    ws.serializeAttachment({ ...att, device: m.device } satisfies Attachment);
    const next = Number(this.one("SELECT next_dseq FROM devices WHERE device = ?", m.device)!.next_dseq);
    const head = Number(this.one("SELECT COALESCE(MAX(seq), 0) AS n FROM ops")!.n);
    send(ws, { t: "welcome", v: VERSION, state: this.state(), index_head: head, next_dseq: next, server_time: now });
    send(ws, { t: "index", ...this.index(m.index_after) });
  }

  // ---- the index's ops (§3, §5.2)

  /**
   * Ops from one device, decided in dseq order with no gaps, once each: an
   * op below next_dseq gets its stored answer; one above is a gap, refused
   * with the rest of the message; the next one is checked and accepted
   * (a seq) or refused (a code, kept).
   */
  private ops(att: Attachment, device: string, list: unknown): ({ dseq: number; seq: number } | { dseq: number; code: string })[] {
    this.admit(att.account, true);
    if (!Array.isArray(list) || list.length === 0) throw new SyncError("invalid", "ops");
    if (list.length > LIMITS.opsPerMessage) throw new SyncError("limit", "too many ops", { limit: "ops_per_message", max: LIMITS.opsPerMessage });
    const wait = this.opsRate.take();
    if (wait) throw new SyncError("rate", "too many ops", { retry_after: wait });
    return this.ctx.storage.transactionSync(() => {
      let next = Number(this.one("SELECT next_dseq FROM devices WHERE device = ?", device)!.next_dseq);
      const out: ({ dseq: number; seq: number } | { dseq: number; code: string })[] = [];
      const refusedCount = () => Number(this.one("SELECT COUNT(*) AS n FROM refused WHERE device = ?", device)!.n);
      for (const raw of list) {
        const dseq = (raw as { dseq?: unknown })?.dseq;
        if (!isNat(dseq) || dseq < 1) throw new SyncError("invalid", "op: dseq");
        if (dseq < next) {
          const r = this.one("SELECT seq FROM ops WHERE device = ? AND dseq = ?", device, dseq);
          const f = r ? undefined : this.one("SELECT code FROM refused WHERE device = ? AND dseq = ?", device, dseq);
          out.push(r ? { dseq, seq: Number(r.seq) } : { dseq, code: String(f?.code ?? "invalid") });
          continue;
        }
        if (dseq > next) throw new SyncError("order", "a gap in this device's ops", { next_dseq: next });
        try {
          const op = checkOp(raw);
          // (a session acts for the person; "agent:<name>" from a session is an agent in the person's page, design/agent-endpoint.md §9.2)
          if (PERSON_ONLY.has(op.op) && op.by !== "person") throw new SyncError("forbidden", "only a person may " + op.op);
          // (a data file's bytes are uploaded before the op that names them, and the entry holds them, §3)
          if (op.kind === "file" && op.sha256 !== undefined) {
            if (!this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", op.sha256)) throw new SyncError("missing", "upload the file's bytes before the op");
          }
          this.sql.exec(
            'INSERT INTO ops (device, dseq, t, by, op, path, "to", kind, ref, fid, sha256, size, base, recv) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            device, dseq, op.t, op.by, op.op, op.path, op.to ?? null, op.kind, op.ref ?? null, op.fid ?? null, op.sha256 ?? null, op.size ?? null, op.base ?? null, Date.now(),
          );
          out.push({ dseq, seq: Number(this.one("SELECT last_insert_rowid() AS n")!.n) });
          // (the reference an entry holds; it is given back when the reducer replaces the entry's bytes)
          if (op.kind === "file" && op.sha256 !== undefined) this.sql.exec("UPDATE holdings SET refs = refs + 1 WHERE sha256 = ?", op.sha256);
        } catch (e) {
          if (!(e instanceof SyncError)) throw e;
          if (refusedCount() >= LIMITS.refusalsPerDevice) throw new SyncError("invalid", "too many refused ops: rebuild from the server's log");
          this.sql.exec("INSERT INTO refused (device, dseq, code) VALUES (?, ?, ?)", device, dseq, e.code);
          out.push({ dseq, code: e.code });
        }
        next++;
        this.sql.exec("UPDATE devices SET next_dseq = ? WHERE device = ?", next, device);
      }
      return out;
    });
  }

  /** The log after `after`, a page at a time (§5.2, §8). */
  private index(after: number): { ops: Row[]; more: boolean } {
    const rows = this.sql.exec('SELECT seq, device, dseq, t, by, op, path, "to", kind, ref, fid, sha256, size, base FROM ops WHERE seq > ? ORDER BY seq LIMIT ?', after, LIMITS.indexPage + 1).toArray() as Row[];
    const ops: Row[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, LIMITS.indexPage)) {
      const o = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null));
      const n = JSON.stringify(o).length;
      if (ops.length > 0 && bytes + n > LIMITS.indexPageBytes) return { ops, more: true };
      bytes += n;
      ops.push(o);
    }
    return { ops, more: rows.length > LIMITS.indexPage };
  }

  // ---- batches (§4.3, §5.3)

  private docStub(doc: string) {
    const ns = this.env.SYNC_DOC!;
    return ns.get(ns.idFromName(`doc:${this.get("account_hash")}:${doc}`));
  }

  /** A document of this account's: made the first time a batch names it with a kind. */
  private async ensureDoc(doc: string, kind?: DocKind): Promise<void> {
    if (this.one("SELECT 1 AS x FROM docs WHERE doc = ? AND deleted IS NULL", doc)) return;
    if (this.one("SELECT 1 AS x FROM docs WHERE doc = ?", doc)) throw new SyncError("unknown_doc", "this document was deleted");
    if (!kind) throw new SyncError("unknown_doc", "a new document's first batch says its kind");
    if (Number(this.one("SELECT COUNT(*) AS n FROM docs")!.n) >= LIMITS.docsPerAccount) throw new SyncError("limit", "too many documents", { limit: "docs", max: LIMITS.docsPerAccount });
    unwrap(await this.docStub(doc).init({ owner_account: this.get("account_id")!, owner_hash: this.get("account_hash")!, doc, kind }));
    this.sql.exec("INSERT OR IGNORE INTO docs (doc, kind, created) VALUES (?, ?, ?)", doc, kind, Date.now());
  }

  /**
   * Pin a batch's blobs (§4.3): in one transaction each must be held, and
   * gets a reference and a pending pin, unless that exact pin exists.
   * Returns the pins this call made, which a refusal gives back.
   */
  private pin(doc: string, epoch: number, b: Batch, expires: number): { ref: string; sha256: string }[] {
    return this.ctx.storage.transactionSync(() => {
      const made: { ref: string; sha256: string }[] = [];
      for (const e of b.patches)
        for (const sha of e.blobs ?? []) {
          if (!this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", sha)) throw new SyncError("missing", "upload this blob first", { sha256: sha });
          const ref = patchRef(e);
          if (this.one("SELECT 1 AS x FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", doc, epoch, ref, sha)) continue;
          this.sql.exec("INSERT INTO pins (doc, epoch, ref, sha256, state, expires) VALUES (?, ?, ?, ?, 'pending', ?)", doc, epoch, ref, sha, expires);
          this.sql.exec("UPDATE holdings SET refs = refs + 1 WHERE sha256 = ?", sha);
          made.push({ ref, sha256: sha });
        }
      return made;
    });
  }
  /** How long after a pin's forward lapses its answer is asked for: then the forward can't commit any more (§4.3). */
  private settleMs(): number {
    return this.env.SYNC_TEST_PIN_MS ? 10 : 60_000;
  }
  private pinMs(): number {
    const t = Number(this.env.SYNC_TEST_PIN_MS);
    return Number.isSafeInteger(t) && t > 0 ? t : PIN_MS;
  }
  /** Give back pins (a refused batch, or a release): idempotent by the whole identity. */
  private unpin(doc: string, epoch: number, pins: { ref: string; sha256: string }[], onlyPending: boolean) {
    this.ctx.storage.transactionSync(() => {
      for (const p of pins) {
        const r = this.one("SELECT state FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", doc, epoch, p.ref, p.sha256);
        if (!r || (onlyPending && r.state !== "pending")) continue;
        this.sql.exec("DELETE FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", doc, epoch, p.ref, p.sha256);
        this.sql.exec("UPDATE holdings SET refs = refs - 1 WHERE sha256 = ?", p.sha256);
      }
    });
  }

  private async batch(att: Attachment, device: string, b: Batch): Promise<BatchOut> {
    this.admit(att.account, true);
    if (b.owner !== undefined && b.owner !== this.get("account_hash")) throw new SyncError("unknown_doc", "documents shared with you come in phase 3");
    const wait = this.batches.take();
    if (wait) throw new SyncError("rate", "too many batches", { retry_after: wait });
    await this.ensureDoc(b.doc, b.kind);
    const expires = Date.now() + this.pinMs();
    const made = this.pin(b.doc, b.epoch, b, expires);
    const out = await this.forward(b.doc, b.epoch, made, expires, (doc) => doc.batch({ account: att.account, writer: `session:${device}`, author: "person", device, batch: b, pin_expires: expires }));
    this.settle(b.doc, b.epoch, b);
    this.sql.exec("UPDATE docs SET head_seq = ?, epoch = ?, bytes = bytes + ? WHERE doc = ?", out.head.seq, out.head.epoch, out.bytes, b.doc);
    return out;
  }
  /**
   * Send a pinned batch to its document.  A refusal (a value) gives back the
   * pins this call made; a thrown error is a lost answer, which leaves them
   * pending for the alarm to settle once the forward can no longer commit (§4.3).
   */
  private async forward(doc: string, epoch: number, made: { ref: string; sha256: string }[], expires: number, call: (d: ReturnType<SyncAccount["docStub"]>) => Promise<Result<BatchOut>>): Promise<BatchOut> {
    let r: Result<BatchOut>;
    try {
      r = await call(this.docStub(doc));
    } catch (e) {
      await this.ctx.storage.setAlarm(expires + this.settleMs());
      throw new SyncError("busy", "the document didn't answer; send again");
    }
    if ("error" in r) this.unpin(doc, epoch, made, true);
    return unwrap(r);
  }

  /** The document accepted the batch (or held it already): its pins are held. */
  private settle(doc: string, epoch: number, b: Batch) {
    for (const e of b.patches) for (const sha of e.blobs ?? []) this.sql.exec("UPDATE pins SET state = 'held', expires = NULL WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", doc, epoch, patchRef(e), sha);
  }

  private async clear(att: Attachment, device: string, m: Record<string, unknown>): Promise<BatchOut> {
    this.admit(att.account, true);
    if (!isDocId(m.doc)) throw new SyncError("invalid", "doc");
    const expect = checkHead(m.expect_head, "clear: expect_head");
    const rf = fields(m.root, ["patches", "body"], "clear: root");
    const root = checkBatch({ doc: m.doc, epoch: expect.epoch + 1, patches: rf.patches, body: rf.body });
    await this.ensureDoc(m.doc);
    const expires = Date.now() + this.pinMs();
    const made = this.pin(m.doc, expect.epoch + 1, root, expires);
    const out = await this.forward(m.doc, expect.epoch + 1, made, expires, (doc) => doc.clear({ account: att.account, writer: `session:${device}`, author: "person", device, expect_head: expect, root, pin_expires: expires }));
    this.settle(m.doc, out.head.epoch, root);
    this.sql.exec("UPDATE docs SET head_seq = ?, epoch = ?, bytes = ? WHERE doc = ?", out.head.seq, out.head.epoch, out.bytes, m.doc);
    return out;
  }

  /** Tell the account's other sockets that a document changed (§5.2). */
  private changed(from: WebSocket, doc: string, head: Head, device: string) {
    for (const ws of this.ctx.getWebSockets()) if (ws !== from) send(ws, { t: "changed", owner: this.get("account_hash"), doc, head, by_device: device });
  }

  // ---- limits (§6)

  /**
   * The account's limits: cached LIMITS_TTL_MS; fetched again when older,
   * the cached value kept if CoCalc can't be reached (an outage is never
   * read as zero, or as no limit); null if nothing is known.
   */
  private async limits(): Promise<Limits | null> {
    const cached = this.get("limits");
    const fetched = Number(this.get("limits_fetched") ?? 0);
    if (cached && Date.now() - fetched < LIMITS_TTL_MS) return JSON.parse(cached);
    const env = this.env;
    if (!env.COCALC_ORIGIN || !env.COCALC_CLIENT_SECRET) return env.SHARE_DEV === "1" ? DEV_LIMITS : cached ? JSON.parse(cached) : null;
    try {
      const u = new URL("/api/v2/sagebrush/limits", env.COCALC_ORIGIN);
      u.searchParams.set("account_id", this.get("account_id")!);
      const r = await fetch(u, { headers: { authorization: "Basic " + btoa("sagebrush:" + env.COCALC_CLIENT_SECRET) }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(String(r.status));
      const l = checkLimits(await r.json());
      // (a notice newer than this answer stands: never undone by a fetch, §6)
      if (Number(this.get("limits_issued") ?? 0) > (l.issued ?? 0)) {
        this.set("limits_fetched", Date.now());
        return JSON.parse(cached!);
      }
      this.set("limits", JSON.stringify(l));
      this.set("limits_issued", l.issued ?? 0);
      this.set("limits_fetched", Date.now());
      return l;
    } catch {
      return cached ? JSON.parse(cached) : null;
    }
  }
  private used(): number {
    return Number(this.get("used_bytes") ?? 0);
  }
  private addUsed(n: number) {
    this.set("used_bytes", Math.max(0, this.used() + n));
  }

  // ---- blobs (§5.4)

  /**
   * Reserve the bytes of one upload: one transaction, against the limits,
   * with at most uploadsAtOnce running.  A blob already held needs no upload.
   */
  async reserve(a: { account: string; sha256: string; size: number }): Promise<Result<{ have: true } | { id: string; key: string }>> {
    const l = await this.limits();
    return attempt(() => this.ctx.storage.transactionSync(() => {
      this.admit(a.account, true);
      if (this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", a.sha256)) return { have: true as const };
      if (!l) throw new SyncError("busy", "this account's limits aren't known yet; try again");
      if (!l.sync.enabled) throw new SyncError("readonly", "this account's plan doesn't include sync");
      if (a.size > Math.min(l.max_file_bytes, MAX_PUT)) throw new SyncError("limit", "this file is too large", { limit: "max_file_bytes", max: Math.min(l.max_file_bytes, MAX_PUT) });
      const now = Date.now();
      if (Number(this.one("SELECT COUNT(*) AS n FROM reservations WHERE expires > ?", now)!.n) >= LIMITS.uploadsAtOnce) throw new SyncError("rate", "too many uploads at once", { retry_after: 1000 });
      if (this.used() + a.size > l.sync.storage_bytes) throw new SyncError("storage_full", "this account's synced storage is full", { limit: l.sync.storage_bytes, used: this.used() });
      const id = randomHex(16);
      const key = `s/${this.get("account_hash")!.slice(0, 32)}/${randomHex(18)}`;
      this.sql.exec("INSERT INTO reservations (id, sha256, bytes, key, expires) VALUES (?, ?, ?, ?, ?)", id, a.sha256, a.size, key, now + RESERVE_MS);
      this.addUsed(a.size);
      return { id, key };
    }));
  }

  /**
   * The upload reached R2 (which checked its SHA-256): the reservation
   * becomes a holding.  Idempotent: if the blob is held already (two
   * uploads of the same bytes at once), this upload's object goes to the
   * outbox instead; a reservation already reaped can't be finalized.
   */
  async finalize(a: { account: string; id: string; size: number }): Promise<Result<{ sha256: string }>> {
    const r = attempt(() => this.ctx.storage.transactionSync(() => {
      this.admit(a.account, true);
      const res = this.one("SELECT sha256, bytes, key, expires FROM reservations WHERE id = ?", a.id);
      if (!res || Number(res.expires) < Date.now()) throw new SyncError("busy", "this upload took too long; send it again");
      this.sql.exec("DELETE FROM reservations WHERE id = ?", a.id);
      const sha = String(res.sha256);
      if (a.size !== Number(res.bytes) || this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", sha)) {
        this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", res.key, Date.now());
        this.addUsed(-Number(res.bytes));
        if (a.size !== Number(res.bytes)) throw new SyncError("invalid", "the stored size isn't the declared one");
        return { sha256: sha };
      }
      this.sql.exec("INSERT INTO holdings (sha256, key, size, refs, created) VALUES (?, ?, ?, 0, ?)", sha, res.key, res.bytes, Date.now());
      return { sha256: sha };
    }));
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return r;
  }

  /** An upload that failed before finalize: its object and its reservation go now. */
  async abandon(a: { id: string }): Promise<void> {
    if (!this.exists()) return;
    this.ctx.storage.transactionSync(() => {
      const res = this.one("SELECT bytes, key FROM reservations WHERE id = ?", a.id);
      if (!res) return;
      this.sql.exec("DELETE FROM reservations WHERE id = ?", a.id);
      this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", res.key, Date.now());
      this.addUsed(-Number(res.bytes));
    });
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /** Which of these blobs this account must upload (advisory, §5.4). */
  async missing(a: { account: string; blobs: string[] }): Promise<Result<string[]>> {
    return attempt(() => {
      this.admit(a.account, false);
      return a.blobs.filter((sha) => !this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", sha));
    });
  }

  /**
   * A read of a held blob (§5.4): its key, after the blob's whole size is
   * debited from today's read budget of `who` (the account's devices, or a
   * grant).  Bytes authorized, at issue.
   */
  async read(a: { account: string; sha256: string; who: string }): Promise<Result<{ key: string; size: number }>> {
    const l = await this.limits();
    return attempt(() => this.ctx.storage.transactionSync(() => {
      this.admit(a.account, false);
      const h = this.one("SELECT key, size FROM holdings WHERE sha256 = ?", a.sha256);
      if (!h) throw new SyncError("missing", "no such blob");
      const day = Math.floor(Date.now() / 86400_000);
      const budget = l?.sync.read_bytes_per_day ?? 0;
      const used = Number(this.one("SELECT bytes FROM reads WHERE day = ? AND who = ?", day, a.who)?.bytes ?? 0);
      if (used + Number(h.size) > budget) throw new SyncError("rate", "today's read budget is used up", { limit: "read_bytes_per_day", max: budget, retry_after: (day + 1) * 86400_000 - Date.now() });
      this.sql.exec("INSERT INTO reads (day, who, bytes) VALUES (?, ?, ?) ON CONFLICT(day, who) DO UPDATE SET bytes = bytes + excluded.bytes", day, a.who, h.size);
      this.sql.exec("DELETE FROM reads WHERE day < ?", day - 1);
      return { key: String(h.key), size: Number(h.size) };
    }));
  }

  // ---- calls from the account's document objects, and from the Worker

  /** A document dropped history: give back its pins (§4.3), idempotently, by their whole identity. */
  async release(a: { doc: string; pins: { epoch: number; ref: string; sha256: string }[] }): Promise<void> {
    if (!this.exists()) return;
    for (const p of a.pins) this.unpin(a.doc, p.epoch, [p], false);
  }

  /** Tests only (SYNC_TEST_PIN_MS bound): a holding's refs and the pins on it. */
  async inspect(a: { sha256: string }): Promise<{ refs: number | null; pins: Row[]; used: number } | null> {
    if (!this.env.SYNC_TEST_PIN_MS || !this.exists()) return null;
    const h = this.one("SELECT refs FROM holdings WHERE sha256 = ?", a.sha256);
    return { refs: h ? Number(h.refs) : null, pins: this.sql.exec("SELECT doc, epoch, ref, state FROM pins WHERE sha256 = ? ORDER BY epoch, ref", a.sha256).toArray() as Row[], used: this.used() };
  }

  /** End a session's sockets here, and record it, so nothing it opened can write again (§2). */
  async revoke(a: { session: string; expires: number }): Promise<void> {
    if (!this.exists()) return;
    this.sql.exec("INSERT INTO revoked_sessions (session_hash, expires) VALUES (?, ?) ON CONFLICT(session_hash) DO NOTHING", a.session, a.expires);
    for (const ws of this.ctx.getWebSockets(`s:${a.session}`)) {
      send(ws, { t: "revoked" });
      ws.close(4401, "session ended");
    }
  }

  /** The alarm: settle pins whose answer was lost (§4.3), and forget revoked sessions past their expiry. */
  async alarm(): Promise<void> {
    if (!this.exists()) return;
    const now = Date.now();
    this.sql.exec("DELETE FROM revoked_sessions WHERE expires < ?", now);
    this.ctx.storage.transactionSync(() => {
      // reservations whose upload died: their bytes come back, and their object (if any) goes, unless a holding uses it
      for (const r of this.sql.exec("SELECT id, bytes, key FROM reservations WHERE expires < ? LIMIT 200", now).toArray() as Row[]) {
        this.sql.exec("DELETE FROM reservations WHERE id = ?", r.id);
        if (!this.one("SELECT 1 AS x FROM holdings WHERE key = ?", r.key)) this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", r.key, now);
        this.addUsed(-Number(r.bytes));
      }
      // holdings nothing refers to, a day after their upload
      for (const h of this.sql.exec("SELECT sha256, key, size FROM holdings WHERE refs <= 0 AND created < ? LIMIT 200", now - IDLE_HOLDING_MS).toArray() as Row[]) {
        this.sql.exec("DELETE FROM holdings WHERE sha256 = ?", h.sha256);
        this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", h.key, now);
        this.addUsed(-Number(h.size));
      }
    });
    // the outbox: R2 first, the row only once R2 has deleted it
    const bucket = this.env.SHARE_BUCKET;
    if (bucket)
      for (const o of this.sql.exec("SELECT key FROM outbox LIMIT 100").toArray() as Row[]) {
        try {
          await bucket.delete(String(o.key));
          this.sql.exec("DELETE FROM outbox WHERE key = ?", o.key);
        } catch {
          await this.ctx.storage.setAlarm(now + 60_000);
          break;
        }
      }
    const nextReap = this.one("SELECT MIN(expires) AS t FROM reservations")?.t;
    const nextIdle = this.one("SELECT MIN(created) AS t FROM holdings WHERE refs <= 0")?.t;
    const soon = [nextReap, nextIdle === null || nextIdle === undefined ? null : Number(nextIdle) + IDLE_HOLDING_MS].filter((t): t is number => t !== null && t !== undefined).map(Number);
    if (soon.length) await this.ctx.storage.setAlarm(Math.max(now + 1000, Math.min(...soon)));
    const late = this.sql.exec("SELECT doc, epoch, ref, sha256 FROM pins WHERE state = 'pending' AND expires < ? LIMIT 100", now - this.settleMs()).toArray() as Row[];
    for (const p of late) {
      const [kind, client, cseq] = String(p.ref).split(":");
      if (kind !== "patch") continue;
      try {
        const st = await this.docStub(String(p.doc)).status({ client });
        const pin = { ref: String(p.ref), sha256: String(p.sha256) };
        if (st.head.epoch === Number(p.epoch) && st.next_cseq > Number(cseq)) this.sql.exec("UPDATE pins SET state = 'held', expires = NULL WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", p.doc, p.epoch, p.ref, p.sha256);
        else this.unpin(String(p.doc), Number(p.epoch), [pin], true);
      } catch {
        await this.ctx.storage.setAlarm(now + 60_000);
        return;
      }
    }
    if (late.length === 100) await this.ctx.storage.setAlarm(now + 1000);
  }
}

/** The limits CoCalc sent, checked: every number a safe integer, never a missing one read as zero (§6). */
export function checkLimits(v: unknown): Limits {
  const o = v as Record<string, any>;
  const n = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
  if (!o || !n(o.storage_bytes) || !n(o.max_file_bytes)) throw new Error("bad limits");
  const s = o.sync;
  const sync = s && typeof s === "object" && n(s.storage_bytes) && n(s.version_bytes) && n(s.read_bytes_per_day)
    ? { enabled: s.enabled === true, storage_bytes: s.storage_bytes, version_bytes: s.version_bytes, read_bytes_per_day: s.read_bytes_per_day }
    : { enabled: false, storage_bytes: 0, version_bytes: 0, read_bytes_per_day: 0 };
  return { storage_bytes: o.storage_bytes, max_file_bytes: o.max_file_bytes, sync, ...(n(o.issued) ? { issued: o.issued } : {}) };
}
