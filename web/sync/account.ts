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
  parseMessage, PERSON_ONLY, attempt, attemptAsync, randomHex, TICKET_MS, LIMITS_TTL_MS, isSha, type Batch, type DocKind, type Head, type Result,
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
  // a pin (§4.3): its identity is the patch's own, (doc, epoch, client, cseq, id, sha256), so two
  // attempts at one cseq with different ids are two pins (CORR-321-1); `inflight` counts the forwards
  // that use it and haven't answered, and `lapse` is the latest pin_expires of any of them: after it,
  // none can commit, so the pin is decided by asking the document, never by one attempt's answer
  // (gen rises with every attempt, so an answer asked for before an attempt began never decides the pin, CORR-B8A-1)
  "CREATE TABLE IF NOT EXISTS pins (doc TEXT NOT NULL, epoch INTEGER NOT NULL, ref TEXT NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, inflight INTEGER NOT NULL DEFAULT 0, lapse INTEGER, gen INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (doc, epoch, ref, sha256))",
  "CREATE INDEX IF NOT EXISTS pins_pending ON pins (lapse) WHERE state = 'pending'",
  "CREATE TABLE IF NOT EXISTS revoked_sessions (session_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  // calls to a document that may still commit: until each answers or lapses, a purge waits (CORR-5E2-1)
  "CREATE TABLE IF NOT EXISTS forwards (id TEXT PRIMARY KEY, doc TEXT NOT NULL, expires INTEGER NOT NULL)",
  // document sockets (§2): a ticket is used once; ticket_docs says which documents a revoke must
  // fence; a socket's slot is a lease that ends by itself if its close is never reported
  "CREATE TABLE IF NOT EXISTS tickets (nonce TEXT PRIMARY KEY, session_hash TEXT NOT NULL, device TEXT NOT NULL, doc TEXT NOT NULL, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ticket_docs (session_hash TEXT NOT NULL, doc TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (session_hash, doc))",
  "CREATE TABLE IF NOT EXISTS doc_sockets (socket TEXT PRIMARY KEY, doc TEXT NOT NULL, session_hash TEXT NOT NULL, expires INTEGER NOT NULL)",
  // (each retried item keeps its own retry time and tries, so an outage backs off per item, CORR-B8A-2)
  "CREATE TABLE IF NOT EXISTS fences_due (session_hash TEXT NOT NULL, doc TEXT NOT NULL, expires INTEGER NOT NULL, retry_at INTEGER, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_hash, doc))",
  "CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, created INTEGER, retry_at INTEGER, tries INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, key TEXT NOT NULL, expires INTEGER NOT NULL)",
  // (finalized uploads, a day: a finalize answered again gives the same answer, CORR-796-2)
  "CREATE TABLE IF NOT EXISTS finalized (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS reads (day INTEGER NOT NULL, who TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (day, who))",
];

/** The limits CoCalc gives an account (design/sync-server.md §6), as this service reads them. */
export interface Limits { storage_bytes: number; max_file_bytes: number; sync: { enabled: boolean; storage_bytes: number; version_bytes: number; read_bytes_per_day: number }; issued?: number }
/** Dev deployments with no CoCalc to ask (SHARE_DEV=1): small, fixed limits. */
const DEV_LIMITS: Limits = { storage_bytes: 1 << 30, max_file_bytes: MAX_PUT, sync: { enabled: true, storage_bytes: 1 << 30, version_bytes: 256 << 20, read_bytes_per_day: 4 << 30 } };
/** How long an upload may take before its reservation is reaped (§5.4). */
const RESERVE_MS = 3600_000;
/** Tickets issued a minute, per session and per account (LIMIT-6D6-3). */
const TICKETS_PER_MINUTE_SESSION = 60;
const TICKETS_PER_MINUTE_ACCOUNT = 240;
/** Fences a revoke sends before it answers; the rest go from the alarm, paged (LIMIT-6D6-4). */
const FENCES_AT_ONCE = 100;
/** A document socket's lease (§2, LIMIT-D817-4): renewed at each recheck while the socket is used. */
const LEASE_MS = 15 * 60_000;
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
  private urls = new Bucket(LIMITS.urlsPerMinute, LIMITS.urlsPerMinute / 60);
  private ticketsAll = new Bucket(TICKETS_PER_MINUTE_ACCOUNT, TICKETS_PER_MINUTE_ACCOUNT / 60);
  private ticketsBySession = new Map<string, Bucket>();
  private ticketBucket(session: string): Bucket {
    let b = this.ticketsBySession.get(session);
    if (!b) {
      if (this.ticketsBySession.size >= 1000) this.ticketsBySession.delete(this.ticketsBySession.keys().next().value!);
      b = new Bucket(TICKETS_PER_MINUTE_SESSION, TICKETS_PER_MINUTE_SESSION / 60);
      this.ticketsBySession.set(session, b);
    }
    return b;
  }
  private inflight = new WeakMap<WebSocket, number>();
  /** The alarm as last set (read at start): so it can be set earlier without an await (CORR-321-3). */
  private alarmAt: number | null = null;
  /** Alarms run since this object started (tests: an outage mustn't loop). */
  private alarms = 0;
  /** Have the alarm fire by `t`: never later than one already set, and without awaiting. */
  private wakeBy(t: number) {
    const now = Date.now();
    if (this.alarmAt === null || this.alarmAt < now || t < this.alarmAt) {
      this.alarmAt = Math.max(now + 1, t);
      this.ctx.storage.setAlarm(this.alarmAt);
    }
  }

  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // (after a restart: whatever the stored state still needs, the alarm is armed for, CORR-321-3)
    ctx.blockConcurrencyWhile(async () => {
      this.alarmAt = await ctx.storage.getAlarm();
      if (this.exists()) this.arm();
    });
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
    } else if (t === "ticket") {
      fields(m, ["t", "req", "owner", "doc"], "ticket");
      send(ws, { t: "ticket", req, ...this.ticket(att, dev, m.doc) });
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
    // (every op counts, resent or new: LIMIT-321-2)
    const wait = this.opsRate.take(list.length);
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
    // (the row first, so a purge that starts while the document is being made still deletes it, CORR-5E2-1)
    this.sql.exec("INSERT OR IGNORE INTO docs (doc, kind, created) VALUES (?, ?, ?)", doc, kind, Date.now());
    await this.forwarding(doc, Date.now() + this.pinMs(), async (stub, expires) => unwrap(await stub.init({ owner_account: this.get("account_id")!, owner_hash: this.get("account_hash")!, doc, kind, expires })));
  }
  /**
   * A call to a document that may commit something: recorded in `forwards`
   * until it answers, and given `expires`, after which the document refuses
   * it, so a purge can wait for every one to end (CORR-5E2-1).
   */
  private async forwarding<T>(doc: string, expires: number, call: (stub: ReturnType<SyncAccount["docStub"]>, expires: number) => Promise<T>): Promise<T> {
    const id = randomHex(8);
    this.sql.exec("INSERT INTO forwards (id, doc, expires) VALUES (?, ?, ?)", id, doc, expires);
    try {
      return await call(this.docStub(doc), expires);
    } finally {
      this.sql.exec("DELETE FROM forwards WHERE id = ?", id);
    }
  }

  /**
   * Pin a batch's blobs (§4.3), in one transaction: each must be held; a
   * pin new to this patch takes a reference; every pin of the batch counts
   * this attempt as in flight until `expires`.  The alarm is armed in the
   * same step, before anything awaits (CORR-321-3).  Returns the pins.
   */
  private pin(doc: string, epoch: number, b: Batch, expires: number): PinKey[] {
    const keys = this.ctx.storage.transactionSync(() => {
      const keys: PinKey[] = [];
      for (const e of b.patches)
        for (const sha of e.blobs ?? []) {
          if (!this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", sha)) throw new SyncError("missing", "upload this blob first", { sha256: sha });
          const k = { doc, epoch, ref: patchRef(e), sha256: sha };
          const had = this.one("SELECT state FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", doc, epoch, k.ref, sha);
          if (!had) {
            this.sql.exec("INSERT INTO pins (doc, epoch, ref, sha256, state, inflight, lapse, gen) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?)", doc, epoch, k.ref, sha, expires, this.nextGen());
            this.sql.exec("UPDATE holdings SET refs = refs + 1 WHERE sha256 = ?", sha);
          } else if (had.state === "pending") {
            this.sql.exec("UPDATE pins SET inflight = inflight + 1, lapse = max(lapse, ?), gen = ? WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", expires, this.nextGen(), doc, epoch, k.ref, sha);
          } else continue; // held: nothing this attempt does can change it
          keys.push(k);
        }
      return keys;
    });
    if (keys.length) this.wakeBy(expires + this.settleMs() + 1);
    return keys;
  }
  /**
   * The next pin generation: one counter for the whole account, never
   * reused, so a pin dropped and made again can't take an old generation
   * that a stale answer still names (CORR-6D6-1).
   */
  private nextGen(): number {
    const g = Number(this.get("pin_gen") ?? 0) + 1;
    this.set("pin_gen", g);
    return g;
  }
  /** How long after a pin's forward lapses its answer is asked for: then the forward can't commit any more (§4.3). */
  private settleMs(): number {
    return this.env.SYNC_TEST_PIN_MS ? 10 : 60_000;
  }
  private pinMs(): number {
    const t = Number(this.env.SYNC_TEST_PIN_MS);
    return Number.isSafeInteger(t) && t > 0 ? t : PIN_MS;
  }
  /** Take back a pin, by its whole identity, idempotently: its reference goes too. */
  private drop(k: PinKey) {
    if (!this.one("SELECT 1 AS x FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256)) return;
    this.sql.exec("DELETE FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256);
    this.sql.exec("UPDATE holdings SET refs = refs - 1 WHERE sha256 = ?", k.sha256);
  }
  /**
   * Decide pending pins (§4.3) from what the document accepted, never from
   * one attempt's answer: a pin is decided once no attempt is in flight (or
   * all have lapsed); then it is held if the document holds its patch, and
   * dropped if not.  Its state is read again after the call, so an attempt
   * that started meanwhile keeps it pending.
   */
  private async decidePins(doc: string, keys: PinKey[]): Promise<void> {
    const now = Date.now();
    const settle = this.settleMs();
    const state = (k: PinKey) => this.one("SELECT state, inflight, lapse, gen FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256);
    const ready = (r: Row | undefined) => !!r && r.state === "pending" && (Number(r.inflight) <= 0 || Number(r.lapse) + settle < now);
    // (each pin's generation as the question is asked: an answer applies only if it is still that)
    const todo = keys.map((k) => ({ k, r: state(k) })).filter((x) => ready(x.r)).map((x) => ({ k: x.k, gen: Number(x.r!.gen) }));
    if (todo.length === 0) return;
    let r: Result<string[]>;
    try {
      r = await this.docStub(doc).accepted({ ids: todo.map((x) => ({ epoch: x.k.epoch, id: idOfRef(x.k.ref) })) });
    } catch (e) {
      r = { error: { code: "busy", message: String(e) } };
    }
    this.ctx.storage.transactionSync(() => {
      for (const { k, gen } of todo) {
        const cur = state(k);
        if (!ready(cur) || Number(cur!.gen) !== gen) continue;
        if ("error" in r) {
          // (the document didn't answer: this pin tries again after its own backoff, CORR-B8A-2)
          this.sql.exec("UPDATE pins SET retry_at = ?, tries = tries + 1 WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", Date.now() + this.backoff(Number(this.one("SELECT tries FROM pins WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256)!.tries)), k.doc, k.epoch, k.ref, k.sha256);
          continue;
        }
        if (new Set(r.ok).has(`${k.epoch}:${idOfRef(k.ref)}`)) this.sql.exec("UPDATE pins SET state = 'held', inflight = 0, lapse = NULL, retry_at = NULL WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256);
        else this.drop(k);
      }
    });
  }
  /** A retried item's wait after `tries` failures: doubling from a minute to ten (a second to four, in tests). */
  private backoff(tries: number): number {
    const [base, cap] = this.env.SYNC_TEST_PIN_MS ? [200, 4000] : [60_000, 600_000];
    return Math.min(cap, base * 2 ** Math.min(tries, 20));
  }

  private async batch(att: Attachment, device: string, b: Batch): Promise<BatchOut> {
    this.admit(att.account, true);
    if (b.owner !== undefined && b.owner !== this.get("account_hash")) throw new SyncError("unknown_doc", "documents shared with you come in phase 3");
    const wait = this.batches.take();
    if (wait) throw new SyncError("rate", "too many batches", { retry_after: wait });
    await this.ensureDoc(b.doc, b.kind);
    const expires = Date.now() + this.pinMs();
    const keys = this.pin(b.doc, b.epoch, b, expires);
    const out = await this.forward(b.doc, keys, expires, (doc) => doc.batch({ account: att.account, writer: `session:${device}`, author: "person", device, batch: b, pin_expires: expires }));
    this.noteHead(b.doc, out);
    return out;
  }
  /**
   * Send a pinned batch to its document.  An answer (accepted or refused)
   * ends this attempt on its pins, which are then decided from the
   * document; a thrown error is a lost answer, which leaves the attempt in
   * flight until its pins lapse, when the alarm decides them (§4.3).
   */
  private async forward(doc: string, keys: PinKey[], expires: number, call: (d: ReturnType<SyncAccount["docStub"]>) => Promise<Result<BatchOut>>): Promise<BatchOut> {
    let r: Result<BatchOut>;
    try {
      r = await this.forwarding(doc, expires, (stub) => call(stub));
    } catch (e) {
      throw new SyncError("busy", "the document didn't answer; send again");
    }
    this.ctx.storage.transactionSync(() => {
      for (const k of keys) this.sql.exec("UPDATE pins SET inflight = max(0, inflight - 1) WHERE doc = ? AND epoch = ? AND ref = ? AND sha256 = ?", k.doc, k.epoch, k.ref, k.sha256);
    });
    await this.decidePins(doc, keys);
    return unwrap(r);
  }
  /**
   * The document's head and bytes, as it said them: only ever forward,
   * (epoch, seq), and the bytes are the document's own total, so a reply
   * that arrives late, or a resend's, can't move them back (CORR-321-2).
   */
  private noteHead(doc: string, out: { head: Head; total: number }) {
    this.sql.exec(
      "UPDATE docs SET head_seq = ?, epoch = ?, bytes = ? WHERE doc = ? AND (epoch < ? OR (epoch = ? AND head_seq < ?))",
      out.head.seq, out.head.epoch, out.total, doc, out.head.epoch, out.head.epoch, out.head.seq,
    );
  }

  private async clear(att: Attachment, device: string, m: Record<string, unknown>): Promise<BatchOut> {
    this.admit(att.account, true);
    if (!isDocId(m.doc)) throw new SyncError("invalid", "doc");
    const expect = checkHead(m.expect_head, "clear: expect_head");
    const rf = fields(m.root, ["patches", "body"], "clear: root");
    const root = checkBatch({ doc: m.doc, epoch: expect.epoch + 1, patches: rf.patches, body: rf.body });
    await this.ensureDoc(m.doc);
    const expires = Date.now() + this.pinMs();
    const keys = this.pin(m.doc, expect.epoch + 1, root, expires);
    const out = await this.forward(m.doc, keys, expires, (doc) => doc.clear({ account: att.account, writer: `session:${device}`, author: "person", device, expect_head: expect, root, pin_expires: expires }));
    this.noteHead(m.doc, out);
    return out;
  }

  // ---- document sockets (§2)

  /**
   * A batch from one of this account's document sockets: decided exactly
   * as one from the account socket (the session not revoked, the rates,
   * blobs pinned, the head recorded here), so a document socket is no way
   * around any of them (LIMIT-6D6-1, CORR-6D6-2, CORR-6D6-3).
   */
  async socketBatch(a: { account: string; session: string; device: string; batch: Record<string, unknown> }): Promise<Result<BatchOut>> {
    return attemptAsync(async () => {
      if (this.one("SELECT 1 AS x FROM revoked_sessions WHERE session_hash = ?", a.session)) throw new SyncError("forbidden", "this session was ended");
      const b = checkBatch(a.batch);
      const out = await this.batch({ account: a.account, session: a.session, expires: Infinity, checked: Date.now() }, a.device, b);
      if (out.new > 0) this.changed(null, b.doc, out.head, a.device);
      return out;
    });
  }

  private leaseMs(): number {
    return this.env.SYNC_TEST_PIN_MS ? 1000 : LEASE_MS;
  }
  /** A ticket for a document socket: used once, within TICKET_MS, by this session only. */
  private ticket(att: Attachment, device: string, doc: unknown): { ticket: string; expires: number } {
    this.admit(att.account, false);
    // (issued at a rate, per session and per account, whether or not they are used: LIMIT-6D6-3)
    const wait = Math.max(this.ticketsAll.take(), this.ticketBucket(att.session).take());
    if (wait) throw new SyncError("rate", "too many tickets", { retry_after: wait });
    if (!isDocId(doc) || !this.one("SELECT 1 AS x FROM docs WHERE doc = ? AND deleted IS NULL", doc)) throw new SyncError("unknown_doc", "no such document");
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM tickets WHERE expires < ?", now);
      if (Number(this.one("SELECT COUNT(*) AS n FROM tickets WHERE session_hash = ?", att.session)!.n) >= LIMITS.ticketsPerSession) throw new SyncError("busy", "too many tickets unused");
      const nonce = randomHex(16);
      const expires = now + TICKET_MS;
      this.sql.exec("INSERT INTO tickets (nonce, session_hash, device, doc, expires) VALUES (?, ?, ?, ?, ?)", nonce, att.session, device, doc, expires);
      // (where a revoke of this session must reach, until the session itself would have ended)
      this.sql.exec("INSERT INTO ticket_docs (session_hash, doc, expires) VALUES (?, ?, ?) ON CONFLICT(session_hash, doc) DO UPDATE SET expires = max(expires, excluded.expires)", att.session, doc, att.expires);
      return { ticket: nonce, expires };
    });
  }

  /**
   * Redeem a ticket (from the document object, at its socket's upgrade), in
   * one transaction: it exists, is for this document, account and session,
   * hasn't expired, and its session isn't revoked; it is used up; and the
   * socket takes a lease within the account's and the session's limits.
   */
  async redeem(a: { nonce: string; doc: string; account: string; session: string }): Promise<Result<{ socket: string; device: string; session_expires: number }>> {
    const r = this.redeemNow(a);
    // (the test seam: an answer held after the redemption commits, for astra's revoke race)
    if (this.redeemGate) {
      const g = this.redeemGate;
      this.redeemGate = null;
      await g.wait;
    }
    return r;
  }
  private redeemGate: { wait: Promise<void>; open: () => void } | null = null;
  /** Tests only: hold the next redemption's answer until released. */
  async holdRedeem(a: { release?: boolean }): Promise<void> {
    if (!this.env.SYNC_TEST_PIN_MS) return;
    if (a.release) return void this.heldRedeem?.open();
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    this.redeemGate = { wait, open };
    this.heldRedeem = this.redeemGate;
  }
  private heldRedeem: { wait: Promise<void>; open: () => void } | null = null;
  private redeemNow(a: { nonce: string; doc: string; account: string; session: string }): Result<{ socket: string; device: string; session_expires: number }> {
    return attempt(() => this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.admit(a.account, false);
      const t = typeof a.nonce === "string" && /^[0-9a-f]{32}$/.test(a.nonce) ? this.one("SELECT session_hash, device, doc, expires FROM tickets WHERE nonce = ?", a.nonce) : undefined;
      if (!t || t.doc !== a.doc || t.session_hash !== a.session || Number(t.expires) < now) throw new SyncError("forbidden", "not a valid ticket");
      this.sql.exec("DELETE FROM tickets WHERE nonce = ?", a.nonce);
      if (this.one("SELECT 1 AS x FROM revoked_sessions WHERE session_hash = ?", a.session)) throw new SyncError("forbidden", "this session was ended");
      if (Number(this.one("SELECT COUNT(*) AS n FROM doc_sockets WHERE expires > ?", now)!.n) >= LIMITS.docSocketsPerAccount) throw new SyncError("busy", "too many document sockets for this account");
      if (Number(this.one("SELECT COUNT(*) AS n FROM doc_sockets WHERE session_hash = ? AND expires > ?", a.session, now)!.n) >= LIMITS.docSocketsPerSession) throw new SyncError("busy", "too many document sockets for this session");
      const socket = randomHex(16);
      this.sql.exec("INSERT INTO doc_sockets (socket, doc, session_hash, expires) VALUES (?, ?, ?, ?)", socket, a.doc, a.session, now + this.leaseMs());
      const te = this.one("SELECT expires FROM ticket_docs WHERE session_hash = ? AND doc = ?", a.session, a.doc);
      return { socket, device: String(t.device), session_expires: Number(te?.expires ?? now) };
    }));
  }

  /** Renew a document socket's lease, or release it (LIMIT-D817-4); a lease that has ended can't be renewed. */
  async lease(a: { socket: string; release?: boolean }): Promise<Result<null>> {
    return attempt(() => {
      if (!this.exists()) throw new SyncError("forbidden", "no account");
      if (a.release) {
        this.sql.exec("DELETE FROM doc_sockets WHERE socket = ?", a.socket);
        return null;
      }
      const now = Date.now();
      const r = this.one("SELECT session_hash FROM doc_sockets WHERE socket = ? AND expires > ?", a.socket, now);
      if (!r || this.one("SELECT 1 AS x FROM revoked_sessions WHERE session_hash = ?", r.session_hash)) throw new SyncError("forbidden", "this socket's lease ended");
      this.sql.exec("UPDATE doc_sockets SET expires = ? WHERE socket = ?", now + this.leaseMs(), a.socket);
      return null;
    });
  }

  /** Tell the account's other sockets that a document changed (§5.2). */
  private changed(from: WebSocket | null, doc: string, head: Head, device: string) {
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
    if (cached && Date.now() - fetched < (this.env.SYNC_TEST_PIN_MS ? 1000 : LIMITS_TTL_MS)) return JSON.parse(cached);
    const env = this.env;
    if (!env.COCALC_ORIGIN || !env.COCALC_CLIENT_SECRET) return env.SHARE_DEV === "1" ? DEV_LIMITS : cached ? JSON.parse(cached) : null;
    try {
      const u = new URL("/api/v2/sagebrush/limits", env.COCALC_ORIGIN);
      u.searchParams.set("account_id", this.get("account_id")!);
      const r = await fetch(u, { headers: { authorization: "Basic " + btoa("sagebrush:" + env.COCALC_CLIENT_SECRET) }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(String(r.status));
      const l = checkLimits(await r.json());
      // (after the await: what is stored now, since a notice may have landed meanwhile; a newer one
      // stands, never undone by a fetch, §6, CORR-5E2-3)
      const now = this.get("limits");
      if (now && Number(this.get("limits_issued") ?? 0) > (l.issued ?? 0)) {
        this.set("limits_fetched", Date.now());
        return JSON.parse(now);
      }
      this.set("limits", JSON.stringify(l));
      this.set("limits_issued", l.issued ?? 0);
      this.set("limits_fetched", Date.now());
      return l;
    } catch {
      // (the plan stored now, not the one read before the await)
      const now = this.get("limits");
      return now ? JSON.parse(now) : null;
    }
  }
  private used(): number {
    return Number(this.get("used_bytes") ?? 0);
  }
  private addUsed(n: number) {
    this.set("used_bytes", Math.max(0, this.used() + n));
  }

  /**
   * CoCalc's signed plan notice (§6), already verified by the Worker:
   * applied only if `issued` is newer than what this account holds, so a
   * replay or a late notice can never undo a newer one.  An account that
   * never turned sync on gets nothing made for it.
   */
  async notice(a: { account: string; issued: number; limits: unknown }): Promise<Result<{ applied: boolean }>> {
    return attempt(() => {
      if (!this.exists() || this.get("account_id") !== a.account) return { applied: false };
      let l: Limits;
      try {
        l = checkLimits({ ...(a.limits as object), issued: a.issued });
      } catch {
        throw new SyncError("invalid", "these limits aren't well-formed");
      }
      if (Number(this.get("limits_issued") ?? 0) >= a.issued) return { applied: false };
      this.ctx.storage.transactionSync(() => {
        this.set("limits", JSON.stringify(l));
        this.set("limits_issued", a.issued);
        this.set("limits_fetched", Date.now());
      });
      return { applied: true };
    });
  }

  // ---- deleting (§7)

  /**
   * Start deleting everything this account synced: "Delete my synced data"
   * (kind self) or CoCalc's purge of the account (kind admin).  In one
   * transaction the account becomes `deleting`, so every request is refused
   * from then on; its sockets close; the alarm does the rest (purgeStep).
   * Idempotent by request id; a different id while one runs joins it.
   */
  async purge(a: { request_id: string; kind: "self" | "admin" }): Promise<{ state: string; request_id: string }> {
    if (!this.exists()) return { state: "none", request_id: a.request_id };
    const st = this.ctx.storage.transactionSync(() => {
      if (this.state() !== "deleting") {
        this.set("state", "deleting");
        this.set("purge_id", a.request_id);
        this.set("purge_kind", a.kind);
        this.set("purge_docs", Number(this.one("SELECT COUNT(*) AS n FROM docs")!.n));
        this.set("purge_bytes", this.used());
      } else if (a.kind === "admin") this.set("purge_kind", "admin");
      return { state: "deleting", request_id: this.get("purge_id")! };
    });
    for (const ws of this.ctx.getWebSockets()) {
      send(ws, { t: "error", code: "deleting", detail: { message: "this account's synced data is being deleted" } });
      ws.close(4410, "deleting");
    }
    this.wakeBy(Date.now());
    return st;
  }

  /**
   * One step of a purge, from the alarm: each document deletes itself; every
   * holding, reservation and export goes to the outbox; the outbox empties;
   * the whole s/<hash>/ prefix is listed and deleted (whatever the tables
   * missed).  When all of that is done, the D1 record keeps counts and no
   * id, and this object's storage is wiped.  Returns true when done.
   */
  private async purgeStep(): Promise<boolean> {
    const now = Date.now();
    // first, nothing may still commit: every call to a document has answered or lapsed (CORR-5E2-1),
    // and every upload has finalized, been abandoned, or ended (CORR-5E2-2)
    this.sql.exec("DELETE FROM forwards WHERE expires < ?", now - this.settleMs());
    if (this.one("SELECT 1 AS x FROM forwards LIMIT 1")) return false;
    for (const r of this.sql.exec("SELECT id, key FROM reservations WHERE expires < ?", now).toArray() as Row[]) {
      this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", r.key, now);
      this.sql.exec("DELETE FROM reservations WHERE id = ?", r.id);
    }
    if (this.one("SELECT 1 AS x FROM reservations LIMIT 1")) return false;
    for (const d of this.sql.exec("SELECT doc FROM docs LIMIT 50").toArray() as Row[]) {
      try {
        await this.docStub(String(d.doc)).purge();
        this.sql.exec("DELETE FROM docs WHERE doc = ?", d.doc);
      } catch {
        return false;
      }
    }
    if (this.one("SELECT 1 AS x FROM docs LIMIT 1")) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) SELECT key, ? FROM holdings", now);
      this.sql.exec("DELETE FROM holdings");
      this.sql.exec("DELETE FROM pins");
    });
    const bucket = this.env.SHARE_BUCKET;
    if (!bucket) return false;
    for (const o of this.sql.exec("SELECT key FROM outbox LIMIT 500").toArray() as Row[]) {
      await bucket.delete(String(o.key));
      this.sql.exec("DELETE FROM outbox WHERE key = ?", o.key);
    }
    if (this.one("SELECT 1 AS x FROM outbox LIMIT 1")) return false;
    const prefix = `s/${this.get("account_hash")!.slice(0, 32)}/`;
    const l = await bucket.list({ prefix, limit: 1000 });
    if (l.objects.length) {
      await bucket.delete(l.objects.map((o) => o.key));
      return false;
    }
    // done: the record keeps counts, no id; then this object holds nothing
    const db = this.env.SHARE_DB;
    if (db) {
      await db.prepare("UPDATE sync_accounts SET state = 'purged', finished = ?2, request_id = ?3, kind = ?4, docs = ?5, bytes = ?6 WHERE account_hash = ?1")
        .bind(this.get("account_hash"), Math.floor(now / 1000), this.get("purge_id"), this.get("purge_kind"), Number(this.get("purge_docs") ?? 0), Number(this.get("purge_bytes") ?? 0)).run();
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.alarmAt = null;
    return true;
  }

  // ---- blobs (§5.4)

  /**
   * Reserve the bytes of one upload: one transaction, against the limits,
   * with at most uploadsAtOnce running.  A blob already held needs no upload.
   */
  async reserve(a: { account: string; sha256: string; size: number }): Promise<Result<{ have: true } | { id: string; key: string; expires: number }>> {
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
      const ends = now + (this.env.SYNC_TEST_PIN_MS ? 3000 : RESERVE_MS);
      this.sql.exec("INSERT INTO reservations (id, sha256, bytes, key, expires) VALUES (?, ?, ?, ?, ?)", id, a.sha256, a.size, key, ends);
      this.addUsed(a.size);
      // (a dead upload's bytes come back at its end, even if nothing else happens here: LIMIT-7FB-1)
      this.wakeBy(ends + 1);
      return { id, key, expires: ends };
    }));
  }

  /**
   * The upload reached R2 (which checked its SHA-256): the reservation
   * becomes a holding.  Idempotent: if the blob is held already (two
   * uploads of the same bytes at once), this upload's object goes to the
   * outbox instead; a reservation already reaped can't be finalized.
   */
  async finalize(a: { account: string; id: string; size: number }): Promise<Result<{ sha256: string }>> {
    // (during a purge: the upload's object is the purge's to delete, handed over in a transaction of its
    // own, which a refusal can't roll back, CORR-5E2-2)
    if (this.exists() && this.state() === "deleting") {
      this.ctx.storage.transactionSync(() => {
        const res = this.one("SELECT key FROM reservations WHERE id = ?", a.id);
        if (res) {
          this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", res.key, Date.now());
          this.sql.exec("DELETE FROM reservations WHERE id = ?", a.id);
        }
      });
      this.wakeBy(Date.now());
      return { error: { code: "deleting", message: "this account's synced data is being deleted" } };
    }
    const r = attempt(() => this.ctx.storage.transactionSync(() => {
      this.admit(a.account, true);
      const res = this.one("SELECT sha256, bytes, key, expires FROM reservations WHERE id = ?", a.id);
      if (!res) {
        // (finalized already: the same answer for the same size, a conflict for another)
        const f = this.one("SELECT sha256, size FROM finalized WHERE id = ?", a.id);
        if (f && Number(f.size) === a.size) return { sha256: String(f.sha256) };
        if (f) throw new SyncError("conflict", "this upload was finalized with another size");
        throw new SyncError("busy", "this upload took too long; send it again");
      }
      if (Number(res.expires) < Date.now()) throw new SyncError("busy", "this upload took too long; send it again");
      this.sql.exec("DELETE FROM reservations WHERE id = ?", a.id);
      const sha = String(res.sha256);
      if (a.size === Number(res.bytes)) this.sql.exec("INSERT INTO finalized (id, sha256, size, at) VALUES (?, ?, ?, ?)", a.id, sha, a.size, Date.now());
      if (a.size !== Number(res.bytes) || this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", sha)) {
        this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", res.key, Date.now());
        this.addUsed(-Number(res.bytes));
        if (a.size !== Number(res.bytes)) throw new SyncError("invalid", "the stored size isn't the declared one");
        return { sha256: sha };
      }
      this.sql.exec("INSERT INTO holdings (sha256, key, size, refs, created) VALUES (?, ?, ?, 0, ?)", sha, res.key, res.bytes, Date.now());
      return { sha256: sha };
    }));
    this.wakeBy(Date.now() + 5000);
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
    this.wakeBy(Date.now() + 1000);
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
      // (signed URLs issued: at most urlsPerMinute, LIMIT-7FB-2)
      const wait = this.urls.take();
      if (wait) throw new SyncError("rate", "too many reads", { limit: "urls_per_minute", max: LIMITS.urlsPerMinute, retry_after: wait });
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
    this.ctx.storage.transactionSync(() => {
      for (const p of a.pins) this.drop({ doc: a.doc, ...p });
    });
  }



  /** Tests only (SYNC_TEST_PIN_MS bound): a holding's refs and the pins on it. */
  async inspect(a: { sha256?: string; doc?: string }): Promise<{ refs: number | null; pins: Row[]; used: number; alarms: number; fences_due: number; reservations: number; leases: number; outbox: number; doc?: Row; alarm: number | null } | null> {
    if (!this.env.SYNC_TEST_PIN_MS || !this.exists()) return null;
    const h = a.sha256 ? this.one("SELECT refs FROM holdings WHERE sha256 = ?", a.sha256) : undefined;
    return {
      refs: h ? Number(h.refs) : null,
      pins: a.sha256 ? (this.sql.exec("SELECT doc, epoch, ref, state, inflight, gen, tries FROM pins WHERE sha256 = ? ORDER BY epoch, ref", a.sha256).toArray() as Row[]) : [],
      used: this.used(),
      alarms: this.alarms,
      fences_due: Number(this.one("SELECT COUNT(*) AS n FROM fences_due")!.n),
      reservations: Number(this.one("SELECT COUNT(*) AS n FROM reservations")!.n),
      leases: Number(this.one("SELECT COUNT(*) AS n FROM doc_sockets WHERE expires > ?", Date.now())!.n),
      outbox: Number(this.one("SELECT COUNT(*) AS n FROM outbox")!.n),
      ...(a.doc ? { doc: this.one("SELECT head_seq, epoch, bytes FROM docs WHERE doc = ?", a.doc) } : {}),
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  /** Tests only: R2 keys put in the outbox, and the alarm set to now (an alarm earlier than what is pending). */
  async seed(a: { outbox?: number; alarmNow?: boolean }): Promise<number> {
    if (!this.env.SYNC_TEST_PIN_MS || !this.exists()) return 0;
    for (let i = 0; i < (a.outbox ?? 0); i++) this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", `s/test/${i}`, Date.now());
    if (a.alarmNow) {
      this.alarmAt = Date.now();
      await this.ctx.storage.setAlarm(this.alarmAt);
    } else this.arm();
    return Number(this.one("SELECT COUNT(*) AS n FROM outbox")!.n);
  }

  /** Tests only: make revoke fail, as an unreachable object would; and documents a session had tickets for, made up. */
  async setFailRevoke(a: { on: boolean }): Promise<void> {
    if (this.env.SYNC_TEST_PIN_MS) this.failRevoke = a.on;
  }
  private failRevoke = false;
  async seedTicketDocs(a: { session: string; n: number }): Promise<void> {
    if (!this.env.SYNC_TEST_PIN_MS) return;
    for (let i = 0; i < a.n; i++) this.sql.exec("INSERT OR IGNORE INTO ticket_docs (session_hash, doc, expires) VALUES (?, ?, ?)", a.session, i.toString(16).padStart(12, "0"), Date.now() + 3600_000);
  }

  /** Tests only: hold a purge's steps (the account stays `deleting`) until released. */
  async holdPurge(a: { on: boolean }): Promise<void> {
    if (!this.env.SYNC_TEST_PIN_MS) return;
    this.purgeHeld = a.on;
    if (!a.on) this.wakeBy(Date.now());
  }
  private purgeHeld = false;

  /** Tests only: forget the alarm and restart this object, as a crash after a pin would (CORR-321-3). */
  async crash(): Promise<void> {
    if (!this.env.SYNC_TEST_PIN_MS) return;
    await this.ctx.storage.deleteAlarm();
    // (flushed first: an abort drops writes not yet durable, and the point is a lost alarm)
    await this.ctx.storage.sync();
    this.alarmAt = null;
    this.ctx.abort("test crash");
  }

  /** End a session's sockets here, and record it, so nothing it opened can write again (§2). */
  /**
   * End a session (§2, CORR-D81-7): recorded as revoked, its unused tickets
   * dropped and its leases ended, in one transaction; its account sockets
   * closed; and each document it had a ticket for fenced, durably.  The
   * revoke is complete when every fence is acknowledged; those that fail
   * are retried by the alarm (fences_due).
   */
  async revoke(a: { session: string; expires: number; testNoFence?: boolean }): Promise<{ complete: boolean }> {
    if (this.failRevoke) throw new Error("the account object is unavailable (test seam)");
    if (!this.exists()) return { complete: true };
    const docs = this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO revoked_sessions (session_hash, expires) VALUES (?, ?) ON CONFLICT(session_hash) DO UPDATE SET expires = max(expires, excluded.expires)", a.session, a.expires);
      this.sql.exec("DELETE FROM tickets WHERE session_hash = ?", a.session);
      this.sql.exec("DELETE FROM doc_sockets WHERE session_hash = ?", a.session);
      const docs = (this.sql.exec("SELECT doc FROM ticket_docs WHERE session_hash = ?", a.session).toArray() as Row[]).map((r) => String(r.doc));
      for (const d of docs) this.sql.exec("INSERT INTO fences_due (session_hash, doc, expires) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", a.session, d, a.expires);
      return docs;
    });
    for (const ws of this.ctx.getWebSockets(`s:${a.session}`)) {
      send(ws, { t: "revoked" });
      ws.close(4401, "session ended");
    }
    // (a test seam: the revoke recorded, its fences not yet delivered)
    if (a.testNoFence && this.env.SYNC_TEST_PIN_MS) return { complete: false };
    // (the first FENCES_AT_ONCE now, the rest from the alarm; complete only when none is due)
    await this.fenceDue(a.session);
    this.arm();
    return { complete: !this.one("SELECT 1 AS x FROM fences_due WHERE session_hash = ?", a.session) };
  }
  /** Send the fences still due (all, or one session's); true if none is left. */
  private async fenceDue(session?: string): Promise<boolean> {
    const due = (session
      ? this.sql.exec("SELECT session_hash, doc, expires, tries FROM fences_due WHERE session_hash = ? LIMIT ?", session, FENCES_AT_ONCE)
      : this.sql.exec("SELECT session_hash, doc, expires, tries FROM fences_due WHERE retry_at IS NULL OR retry_at <= ? LIMIT 100", Date.now())).toArray() as Row[];
    let all = true;
    for (const f of due) {
      try {
        await this.docStub(String(f.doc)).fenceSession({ session: String(f.session_hash), expires: Number(f.expires) });
        this.sql.exec("DELETE FROM fences_due WHERE session_hash = ? AND doc = ?", f.session_hash, f.doc);
      } catch {
        all = false;
        this.sql.exec("UPDATE fences_due SET retry_at = ?, tries = tries + 1 WHERE session_hash = ? AND doc = ?", Date.now() + this.backoff(Number(f.tries)), f.session_hash, f.doc);
      }
    }
    return all;
  }

  /**
   * Arm the alarm for the earliest thing the stored state needs (§4.3,
   * §5.4): a lapsed pin, a reservation's end, an idle holding, the outbox;
   * never later than an alarm already set, and `retry` if a step failed.
   */
  private arm(): void {
    const now = Date.now();
    const t: number[] = [];
    // (a pending pin is due at its lapse, or at its retry if a lookup failed, whichever is later)
    const pin = this.one("SELECT MIN(max(lapse + ?, COALESCE(retry_at, 0))) AS t FROM pins WHERE state = 'pending'", this.settleMs() + 1)?.t;
    if (pin !== null && pin !== undefined) t.push(Number(pin));
    const res = this.one("SELECT MIN(expires) AS t FROM reservations")?.t;
    if (res !== null && res !== undefined) t.push(Number(res));
    const idle = this.one("SELECT MIN(created) AS t FROM holdings WHERE refs <= 0")?.t;
    if (idle !== null && idle !== undefined) t.push(Number(idle) + IDLE_HOLDING_MS);
    // (outbox keys and fences: at once if never tried, else at their own retry)
    for (const table of ["outbox", "fences_due"]) {
      const r = this.one(`SELECT MIN(COALESCE(retry_at, ?)) AS t FROM ${table}`, now + 1000)?.t;
      if (r !== null && r !== undefined) t.push(Number(r));
    }
    if (t.length === 0) return;
    this.wakeBy(Math.min(...t));
  }

  /** The alarm: settle pins whose answer was lost (§4.3), and forget revoked sessions past their expiry. */
  async alarm(): Promise<void> {
    // (this alarm has fired: the next is whatever arm() sets at the end)
    this.alarmAt = null;
    if (!this.exists()) return;
    if (this.state() === "deleting") {
      let done = false;
      try {
        if (!this.purgeHeld) done = await this.purgeStep();
      } catch {}
      if (!done) this.wakeBy(Date.now() + (this.env.SYNC_TEST_PIN_MS ? 200 : 30_000));
      return;
    }
    const now = Date.now();
    this.sql.exec("DELETE FROM revoked_sessions WHERE expires < ?", now);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM finalized WHERE at < ?", now - IDLE_HOLDING_MS);
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
    // the outbox: R2 first, the row only once R2 has deleted it; a key that fails waits its own backoff
    const bucket = this.env.SHARE_BUCKET;
    if (bucket)
      for (const o of this.sql.exec("SELECT key, tries FROM outbox WHERE retry_at IS NULL OR retry_at <= ? LIMIT 100", now).toArray() as Row[]) {
        try {
          await bucket.delete(String(o.key));
          this.sql.exec("DELETE FROM outbox WHERE key = ?", o.key);
        } catch {
          this.sql.exec("UPDATE outbox SET retry_at = ?, tries = tries + 1 WHERE key = ?", Date.now() + this.backoff(Number(o.tries)), o.key);
        }
      }
    // fences a revoke couldn't deliver yet, and expired leases, tickets and records
    await this.fenceDue();
    this.sql.exec("DELETE FROM doc_sockets WHERE expires < ?", now);
    this.sql.exec("DELETE FROM tickets WHERE expires < ?", now);
    this.sql.exec("DELETE FROM ticket_docs WHERE expires < ?", now);
    // pins whose every attempt has lapsed (a lost answer, or a crash): decided from the document
    const late = this.sql.exec("SELECT doc, epoch, ref, sha256 FROM pins WHERE state = 'pending' AND lapse + ? < ? AND (retry_at IS NULL OR retry_at <= ?) LIMIT 100", this.settleMs(), now, now).toArray() as Row[];
    const byDoc = new Map<string, PinKey[]>();
    for (const p of late) byDoc.set(String(p.doc), [...(byDoc.get(String(p.doc)) ?? []), { doc: String(p.doc), epoch: Number(p.epoch), ref: String(p.ref), sha256: String(p.sha256) }]);
    for (const [doc, keys] of byDoc) await this.decidePins(doc, keys);
    this.alarms++;
    this.arm();
  }
}

/** The limits CoCalc sent, checked: every number a safe integer, never a missing one read as zero (§6). */
export function checkLimits(v: unknown): Limits {
  const o = v as Record<string, any>;
  const n = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 0;
  if (!o || !n(o.storage_bytes) || !n(o.max_file_bytes)) throw new Error("bad limits");
  const s = o.sync;
  // (a missing or malformed sync plan is CoCalc not answering properly: an outage, which keeps the
  // last good limits, never "sync off" or zero, LIMIT-7FB-3; a plan without sync says enabled: false)
  if (!s || typeof s !== "object" || typeof s.enabled !== "boolean" || !n(s.storage_bytes) || !n(s.version_bytes) || !n(s.read_bytes_per_day)) throw new Error("bad limits");
  const sync = { enabled: s.enabled, storage_bytes: s.storage_bytes, version_bytes: s.version_bytes, read_bytes_per_day: s.read_bytes_per_day };
  return { storage_bytes: o.storage_bytes, max_file_bytes: o.max_file_bytes, sync, ...(n(o.issued) ? { issued: o.issued } : {}) };
}

/** A pin's whole identity (§4.3). */
interface PinKey { doc: string; epoch: number; ref: string; sha256: string }
/** The patch id in a pin's ref, `patch:<client>:<cseq>:<id>`. */
const idOfRef = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);
