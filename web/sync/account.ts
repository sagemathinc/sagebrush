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
import { allowed, gate, testMode, type SyncEnv } from "./env.ts";
import { MAX_PUT, SHARING_USED, nowSeconds } from "../share/server.ts";

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
  "CREATE INDEX IF NOT EXISTS holdings_key ON holdings (key)",
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
  "CREATE INDEX IF NOT EXISTS reservations_key ON reservations (key)",
  // (finalized uploads, a day: a finalize answered again gives the same answer, CORR-796-2)
  "CREATE TABLE IF NOT EXISTS finalized (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS reads (day INTEGER NOT NULL, who TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (day, who))",
  // a batch's bytes, held against the claim from its admission until its document answers; a lost
  // answer's hold stays until its attempt can no longer commit, then the document's total replaces it (§6.1)
  "CREATE TABLE IF NOT EXISTS batch_holds (id TEXT PRIMARY KEY, doc TEXT NOT NULL, bytes INTEGER NOT NULL, due INTEGER NOT NULL)",
];

/** Open batch holds an account may have at once (LIMIT-97A-2): as many as the live batches a document keeps. */
const MAX_HOLDS = LIMITS.liveBatches;

/** The limits CoCalc gives an account (design/sync-server.md §6), as this service reads them. */
/** (one storage_bytes for sharing and sync together, §6.1: sync has no storage limit of its own) */
export interface Limits { storage_bytes: number; max_file_bytes: number; sync: { enabled: boolean; version_bytes: number; read_bytes_per_day: number }; issued?: number }
/** Dev deployments with no CoCalc to ask (SHARE_DEV=1): small, fixed limits. */
const DEV_LIMITS: Limits = { storage_bytes: 1 << 30, max_file_bytes: MAX_PUT, sync: { enabled: true, version_bytes: 256 << 20, read_bytes_per_day: 4 << 30 } };
/** How long an upload may take before its reservation is reaped (§5.4). */
const RESERVE_MS = 3600_000;
/** Keys knownKeys checks in one statement (LIMIT-268-2). */
const KNOWN_CHUNK = 100;
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
      if (this.hasMeta()) this.arm();
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
  /** Whether this object has a meta table at all: an account, or a purge's tombstone. */
  private hasMeta(): boolean {
    return this.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'") !== undefined;
  }
  /** Whether sync was turned on here: a refused request never makes tables (§2). */
  private exists(): boolean {
    return this.hasMeta() && this.get("account_id") !== undefined;
  }
  /** Whether CoCalc deleted this account: for good, whatever is stored (CORR-B92-1). */
  private deleted(): boolean {
    return this.hasMeta() && this.get("deleted") !== undefined;
  }
  /** The highest generation this object has deleted (0: none). */
  private retired(): number {
    return this.hasMeta() ? Number(this.get("retired") ?? 0) : 0;
  }
  private state(): string {
    return this.get("state") ?? "active";
  }

  /**
   * Turn sync on for this account, from a session: the only way this object
   * gets storage.  This object alone decides the account's lifecycle (CORR-02C-1):
   * it holds the generation, the state and the highest generation it has
   * retired, and every enable and purge is one transaction here.  D1 is an
   * index, written afterwards and only as this object's answer says.
   *
   * From nothing (or a tombstone), the next generation is retired + 1, and the
   * account is `registering`: it takes no request until the Worker has
   * recorded that generation in D1 (the inventory finds an account's objects
   * by its row, CORR-00F-1) and confirmed it.  An account registering or on
   * answers its own generation; one being deleted refuses until it's done.
   */
  async enable(a: { account: string; hash: string }): Promise<Result<{ state: string; generation: number }>> {
    return attempt(() => this.ctx.storage.transactionSync(() => {
      if (!allowed(this.env, a.account)) throw new SyncError("forbidden", "sync isn't enabled for this account");
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
      if (this.deleted()) throw new SyncError("forbidden", "this account was deleted");
      const had = this.get("account_id");
      if (had !== undefined) {
        if (had !== a.account) throw new SyncError("forbidden", "not this account");
        if (this.state() === "deleting") throw new SyncError("deleting", "this account's synced data is still being deleted");
        return { state: this.state(), generation: Number(this.get("generation")) };
      }
      const generation = Number(this.get("retired") ?? 0) + 1;
      for (const s of SCHEMA) this.sql.exec(s);
      this.set("account_id", a.account);
      this.set("account_hash", a.hash);
      this.set("generation", generation);
      this.set("created", Date.now());
      this.set("state", "registering");
      return { state: "registering", generation };
    }));
  }

  /**
   * The Worker's word that D1 records `generation`, active: a registering
   * account of that generation is on.  Any other answer changes nothing; a
   * generation this object has retired says so (`retired`), and the Worker
   * then marks that generation's row purged, as no storage will hold it again.
   */
  async confirm(a: { account: string; generation: number }): Promise<Result<{ state: string; generation: number }>> {
    return attempt(() => {
      if (!allowed(this.env, a.account)) throw new SyncError("forbidden", "sync isn't enabled for this account");
      if (!Number.isSafeInteger(a.generation) || a.generation < 1) throw new SyncError("invalid", "generation");
      if (a.generation <= this.retired() || (this.deleted() && !this.exists())) throw new SyncError("forbidden", "this registration's synced data was deleted; turn sync on again", { retired: this.retired() });
      if (!this.exists() || this.get("account_id") !== a.account || Number(this.get("generation")) !== a.generation) throw new SyncError("conflict", "another registration holds this account's storage; try again");
      if (this.state() === "deleting") throw new SyncError("deleting", "this account's synced data is still being deleted");
      if (this.state() === "registering") this.set("state", "active");
      return { state: this.state(), generation: a.generation };
    });
  }

  /** The checks every request makes first: this account, sync on, allowed (§2, §11). */
  private admit(account: string, write: boolean) {
    if (!this.exists() || this.get("account_id") !== account) throw new SyncError("forbidden", "turn on sync first");
    if (!allowed(this.env, account)) throw new SyncError("forbidden", "sync isn't enabled for this account");
    const st = this.state();
    // (not yet in D1: nothing is taken until the Worker confirms the registration, CORR-00F-1)
    if (st === "registering") throw new SyncError("forbidden", "turn on sync first");
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
    send(ws, { t: "welcome", v: VERSION, state: this.state(), generation: Number(this.get("generation")), index_head: head, next_dseq: next, server_time: now });
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
    return testMode(this.env) ? 10 : 60_000;
  }
  private pinMs(): number {
    const t = (testMode(this.env) ? Number(this.env.SYNC_TEST_PIN_MS) : 0);
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
    const [base, cap] = testMode(this.env) ? [200, 4000] : [60_000, 600_000];
    return Math.min(cap, base * 2 ** Math.min(tries, 20));
  }

  private async batch(att: Attachment, device: string, b: Batch): Promise<BatchOut> {
    this.admit(att.account, true);
    if (b.owner !== undefined && b.owner !== this.get("account_hash")) throw new SyncError("unknown_doc", "documents shared with you come in phase 3");
    const wait = this.batches.take();
    if (wait) throw new SyncError("rate", "too many batches", { retry_after: wait });
    await this.ensureDoc(b.doc, b.kind);
    // (the batch's bytes, exactly what its document's total can grow by, held against the budget, §6.1)
    return this.heldForward(b.doc, b.body.length, b.epoch, b, (doc, expires) => doc.batch({ account: att.account, writer: `session:${device}`, author: "person", device, batch: b, pin_expires: expires }));
  }
  /**
   * Hold `bytes` against the budget, pin the batch's blobs, and forward it
   * (§6.1).  A refusal before the forward (pinning) gives the hold back at
   * once: nothing can commit (CORR-97A-3).  Any failure after the forward
   * began, with the hold still open, wakes the alarm for its due time, when
   * the document's total replaces it.
   */
  private async heldForward(doc: string, bytes: number, epoch: number, pinned: Batch, call: (d: ReturnType<SyncAccount["docStub"]>, expires: number) => Promise<Result<BatchOut>>): Promise<BatchOut> {
    await this.room(bytes, "document");
    const expires = Date.now() + this.pinMs();
    const held = this.hold(doc, bytes, expires);
    let keys: PinKey[];
    try {
      keys = this.pin(doc, epoch, pinned, expires);
    } catch (e) {
      this.unhold(held);
      throw e;
    }
    try {
      return this.answered(held, doc, await this.forward(doc, keys, expires, (d) => call(d, expires), () => this.unhold(held)));
    } catch (e) {
      if (this.one("SELECT 1 AS x FROM batch_holds WHERE id = ?", held)) this.wakeBy(expires + this.settleMs() + 1);
      throw e;
    }
  }
  /** The document answered: its total replaces the hold, in one step (no moment counts neither). */
  private answered(held: string, doc: string, out: BatchOut): BatchOut {
    this.noteHead(doc, out);
    this.unhold(held);
    return out;
  }
  /**
   * Send a pinned batch to its document.  An answer (accepted or refused)
   * ends this attempt on its pins, which are then decided from the
   * document; a thrown error is a lost answer, which leaves the attempt in
   * flight until its pins lapse, when the alarm decides them (§4.3).
   */
  private async forward(doc: string, keys: PinKey[], expires: number, call: (d: ReturnType<SyncAccount["docStub"]>) => Promise<Result<BatchOut>>, refused?: () => void): Promise<BatchOut> {
    let r: Result<BatchOut>;
    try {
      r = await this.forwarding(doc, expires, (stub) => call(stub));
    } catch (e) {
      // (a lost answer: a hold stays until the attempt can't commit, then the alarm asks the document;
      // nothing else would wake it then)
      const h = this.one("SELECT MIN(due) AS t FROM batch_holds WHERE doc = ?", doc)?.t;
      if (h !== null && h !== undefined) this.wakeBy(Number(h));
      throw new SyncError("busy", "the document didn't answer; send again");
    }
    // (refused: nothing was stored, so a hold goes at once)
    if ("error" in r) refused?.();
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
    const before = Number(this.one("SELECT bytes FROM docs WHERE doc = ?", doc)?.bytes ?? 0);
    const docs = this.docsBytes();
    this.sql.exec(
      "UPDATE docs SET head_seq = ?, epoch = ?, bytes = ? WHERE doc = ? AND (epoch < ? OR (epoch = ? AND head_seq < ?))",
      out.head.seq, out.head.epoch, out.total, doc, out.head.epoch, out.head.epoch, out.head.seq,
    );
    // (the documents' bytes as one number, §6.1: changed only if the row was)
    const after = Number(this.one("SELECT bytes FROM docs WHERE doc = ?", doc)?.bytes ?? 0);
    if (after !== before) this.set("docs_bytes", Math.max(0, docs + after - before));
  }

  private async clear(att: Attachment, device: string, m: Record<string, unknown>): Promise<BatchOut> {
    this.admit(att.account, true);
    if (!isDocId(m.doc)) throw new SyncError("invalid", "doc");
    const expect = checkHead(m.expect_head, "clear: expect_head");
    const rf = fields(m.root, ["patches", "body"], "clear: root");
    const root = checkBatch({ doc: m.doc, epoch: expect.epoch + 1, patches: rf.patches, body: rf.body });
    await this.ensureDoc(m.doc);
    // (the root's bytes held, as a batch's: the old epoch's go only once the document says so, §6.1)
    return this.heldForward(m.doc, root.body.length, expect.epoch + 1, root, (doc, expires) => doc.clear({ account: att.account, writer: `session:${device}`, author: "person", device, expect_head: expect, root, pin_expires: expires }));
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
    return testMode(this.env) ? 1000 : LEASE_MS;
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
    if (!testMode(this.env)) return;
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
    if (cached && Date.now() - fetched < (testMode(this.env) ? 1000 : LIMITS_TTL_MS)) return JSON.parse(cached);
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
      this.storeLimits(l);
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

  // ---- the one storage budget (§6.1)
  //
  // Sharing and sync share the account's storage_bytes, L.  D1's sync_accounts.claim_bytes is the most
  // sync may use, raised only here, in chunks, by one conditional statement that counts sharing's bytes
  // too; sharing's own check counts the whole claim.  So sharing + sync <= sharing + claim, and:
  //   - files (uploads) stop at L: they must fit under blob_cap, the claim as of the last time D1 found
  //     sharing + claim <= L (every release lowers it too);
  //   - document batches may take the claim past L, into a named ceiling, max(L / 10, 50 MB), and no
  //     further, so an edit never fails abruptly at the edge;
  //   - sharing never uses the ceiling: once sync is in it, sharing's check is already over L.
  // Every raise or release goes through one chain, so this object's claim is never above D1's: a raise
  // writes D1 first, a release lowers this object's claim first.

  /** Documents' bytes: their totals as they last said them, kept as one number (§6.1). */
  private docsBytes(): number {
    const v = this.get("docs_bytes");
    if (v !== undefined) return Number(v);
    const n = Number(this.one("SELECT COALESCE(SUM(bytes), 0) AS n FROM docs")!.n);
    this.set("docs_bytes", n);
    return n;
  }
  private heldBytes(): number {
    return Number(this.get("held_bytes") ?? 0);
  }
  /** All sync holds against the budget: files and reservations, documents, and batches in flight. */
  private syncUsed(): number {
    return this.used() + this.docsBytes() + this.heldBytes();
  }
  private claim(): number {
    return Number(this.get("claim") ?? 0);
  }
  private blobCap(): number {
    return Math.min(this.claim(), Number(this.get("blob_cap") ?? 0));
  }
  /** The claim as of the last time D1 found sharing + claim within L plus the ceiling: what documents may use. */
  private docCap(): number {
    return Math.min(this.claim(), Number(this.get("doc_cap") ?? 0));
  }
  /**
   * Store limits.  A new storage_bytes takes effect at once: both caps go to
   * zero, so the next write has D1 check the claim against it again, and the
   * alarm gives back what no longer fits.
   */
  private storeLimits(l: Limits) {
    const before = this.get("limits");
    if (!before || (JSON.parse(before) as Limits).storage_bytes !== l.storage_bytes) {
      this.set("blob_cap", 0);
      this.set("doc_cap", 0);
      this.set("full_until_file", 0);
      this.set("full_until_document", 0);
      this.set("limits_rev", Number(this.get("limits_rev") ?? 0) + 1);
    }
    this.set("limits", JSON.stringify(l));
  }
  /** What sync claims at a time: L / 64, between 4 and 64 MiB, never more than L (in tests, at least 64 bytes, or a seam's). */
  private chunk(L: number): number {
    if (testMode(this.env) && this.chunkOverride) return Math.min(this.chunkOverride, L);
    return Math.min(L, testMode(this.env) ? Math.max(64, Math.floor(L / 64)) : Math.min(64 << 20, Math.max(4 << 20, Math.floor(L / 64))));
  }
  private chunkOverride = 0;
  /** How far document batches may take the claim past L: max(L / 10, 50 MB) (in tests, 256 bytes at least). */
  private ceiling(L: number): number {
    return testMode(this.env) ? Math.max(256, Math.floor(L / 10)) : Math.max(Math.floor(L / 10), 50_000_000);
  }
  private fits(need: number, kind: "file" | "document"): boolean {
    return this.syncUsed() + need <= (kind === "file" ? this.blobCap() : this.docCap());
  }
  private claimChain: Promise<unknown> = Promise.resolve();
  private serially<T>(f: () => Promise<T>): Promise<T> {
    const p = this.claimChain.then(f, f);
    this.claimChain = p.catch(() => {});
    return p;
  }

  /**
   * Room for `need` more bytes of `kind`, raising the claim if it must (at
   * most twice).  storage_full if the budget can't give it; busy if the
   * limits or D1 can't be read now (never read as room).
   */
  private async room(need: number, kind: "file" | "document"): Promise<void> {
    for (let i = 0; i < 2; i++) {
      if (this.fits(need, kind)) return;
      // (found full a moment ago: refused again without asking D1, so a full budget costs at most one
      // D1 call a minute, never one an edit, LIMIT-97A-1; a new limit ends the wait)
      if (Date.now() < Number(this.get(`full_until_${kind}`) ?? 0)) throw new SyncError("storage_full", "this account's storage is full", { used: this.syncUsed() });
      const l = await this.limits();
      if (!l) throw new SyncError("busy", "this account's limits aren't known yet; try again", { retry_after: 1000 });
      const r = await this.raise(need, kind, l.storage_bytes);
      if (r === "full") {
        this.set(`full_until_${kind}`, Date.now() + (testMode(this.env) ? 500 : 60_000));
        throw new SyncError("storage_full", "this account's storage is full", { limit: l.storage_bytes, used: this.syncUsed() });
      }
      if (r === "busy") throw new SyncError("busy", "the storage budget can't be checked now; try again", { retry_after: 1000 });
    }
    if (!this.fits(need, kind)) throw new SyncError("busy", "try again", { retry_after: 200 });
  }

  /** One raise of the claim in D1, by whole chunks if they fit, else by exactly what is short. */
  private raise(need: number, kind: "file" | "document", L0: number): Promise<"ok" | "full" | "busy"> {
    return this.serially(async () => {
      if (this.fits(need, kind)) return "ok";
      const db = this.env.SHARE_DB;
      if (!db) return "busy";
      // (what this raise is for: this generation, these limits; a queued raise reads them when it runs,
      // and nothing is installed after the await unless they are still so, CORR-97A-1/2)
      const gen = Number(this.get("generation"));
      const rev = Number(this.get("limits_rev") ?? 0);
      const stored = this.get("limits");
      const L = stored ? (JSON.parse(stored) as Limits).storage_bytes : L0;
      const same = () => this.exists() && this.state() !== "deleting" && Number(this.get("generation")) === gen;
      // (short of the claim itself; nothing short, the claim is checked against the limit again)
      const short = Math.max(0, this.syncUsed() + need - this.claim());
      const C = this.chunk(L);
      const whole = short === 0 ? 0 : Math.ceil(short / C) * C;
      // One statement a cap: the claim grows by whole chunks, or by all the room left below the cap if
      // that is less, as long as it covers what is short (LIMIT-97A-1): so the last part below a cap is
      // taken in one write, never one an edit.  Nothing short, it checks the claim against the cap.
      // (files: within L only; documents: within L first, then the ceiling)
      const caps = kind === "document" ? [L, L + this.ceiling(L)] : [L];
      for (const cap of caps) {
        let r: { claim_bytes: number } | null;
        try {
          if (testMode(this.env) && this.failClaim) throw new Error("D1 unavailable (test seam)");
          r = await db.prepare(`UPDATE sync_accounts SET claim_bytes = claim_bytes + MIN(?3, ?6 - claim_bytes - (${SHARING_USED})) WHERE account_hash = ?4 AND generation = ?5 AND state = 'active' AND MIN(?3, ?6 - claim_bytes - (${SHARING_USED})) >= ?7 RETURNING claim_bytes`)
            .bind(this.get("account_id"), nowSeconds(), whole, this.get("account_hash"), Number(this.get("generation")), cap, short).first<{ claim_bytes: number }>();
        } catch {
          return "busy";
        }
        if (testMode(this.env)) {
          this.claimCalls++;
          if (r) this.claimWrites++;
          await gate(this.env, "claim-raise-answer");
        }
        // (a purge, or a new generation, since the statement: this answer is not this account's any more)
        if (!same()) return "busy";
        if (!r) continue;
        this.set("claim", r.claim_bytes);
        this.set("claim_dirty", 0);
        // (new limits since the statement: the caps stay as they set them, and the next write asks again)
        if (Number(this.get("limits_rev") ?? 0) !== rev) return "busy";
        if (cap === L) this.set("blob_cap", r.claim_bytes);
        this.set("doc_cap", r.claim_bytes);
        if (this.fits(need, kind)) return "ok";
      }
      return "full";
    });
  }

  /**
   * Give back what the claim holds beyond what sync uses, plus `keep`: this
   * object's claim first, then D1's (a failure there only leaves D1 higher,
   * room unused, until the alarm writes it).  Returns the bytes given back.
   */
  private releaseSlack(keep: number): Promise<number> {
    return this.serially(async () => {
      const target = this.syncUsed() + keep;
      const cur = this.claim();
      if (cur <= target && !Number(this.get("claim_dirty") ?? 0)) return 0;
      const to = Math.min(cur, target);
      this.set("claim", to);
      this.set("blob_cap", Math.min(Number(this.get("blob_cap") ?? 0), to));
      this.set("doc_cap", Math.min(Number(this.get("doc_cap") ?? 0), to));
      this.set("claim_dirty", 1);
      const gen = Number(this.get("generation"));
      try {
        if (testMode(this.env) && this.failClaim) throw new Error("D1 unavailable (test seam)");
        await this.env.SHARE_DB?.prepare("UPDATE sync_accounts SET claim_bytes = ?3 WHERE account_hash = ?1 AND generation = ?2 AND claim_bytes > ?3")
          .bind(this.get("account_hash"), gen, to).run();
        if (testMode(this.env)) this.claimCalls++;
        // (only for the generation it was for)
        if (this.exists() && Number(this.get("generation")) === gen) this.set("claim_dirty", 0);
      } catch {}
      return cur - to;
    });
  }

  /** Sharing, refused for space: give back every byte of the claim sync doesn't use (§6.1). */
  async releaseClaim(a: { account: string }): Promise<{ released: number }> {
    if (!this.exists() || this.get("account_id") !== a.account) return { released: 0 };
    return { released: await this.releaseSlack(0) };
  }
  /** What sync holds, for the account's usage breakdown (display only). */
  async usage(a: { account: string }): Promise<{ files: number; documents: number; claim: number } | null> {
    if (!this.exists() || this.get("account_id") !== a.account) return null;
    return { files: this.used(), documents: this.docsBytes() + this.heldBytes(), claim: this.claim() };
  }

  /** Hold a batch's bytes against the claim, until its document answers (or can't commit any more). */
  private hold(doc: string, bytes: number, expires: number): string {
    const due = expires + this.settleMs() + 1;
    const id = this.ctx.storage.transactionSync(() => {
      if (!this.fits(bytes, "document")) throw new SyncError("busy", "try again", { retry_after: 200 });
      // (at most MAX_HOLDS open, answered or not yet settled: a stream of lost answers can't grow the
      // table, LIMIT-97A-2; a zero-byte batch takes a row too)
      if (Number(this.one("SELECT COUNT(*) AS n FROM batch_holds")!.n) >= MAX_HOLDS) throw new SyncError("busy", "too many batches waiting on their documents; try again", { retry_after: 1000 });
      const id = randomHex(16);
      this.sql.exec("INSERT INTO batch_holds (id, doc, bytes, due) VALUES (?, ?, ?, ?)", id, doc, bytes, due);
      this.set("held_bytes", this.heldBytes() + bytes);
      return id;
    });
    return id;
  }
  /**
   * Holds whose answers were lost, once their attempts can no longer commit:
   * the document's total replaces them (§6.1).  A few documents a run; one
   * that can't be asked waits a backoff.
   */
  private async settleHolds(): Promise<void> {
    const now = Date.now();
    for (const d of this.sql.exec("SELECT DISTINCT doc FROM batch_holds WHERE due <= ? LIMIT 20", now).toArray() as Row[]) {
      const doc = String(d.doc);
      try {
        // (bounded: a document that doesn't answer never holds up the alarm's other work)
        const info = await Promise.race([
          this.docStub(doc).info(),
          new Promise<never>((_, no) => setTimeout(() => no(new Error("the document didn't answer")), testMode(this.env) ? 300 : 2000)),
        ]);
        this.ctx.storage.transactionSync(() => {
          this.noteHead(doc, info);
          for (const h of this.sql.exec("SELECT id FROM batch_holds WHERE doc = ? AND due <= ?", doc, now).toArray() as Row[]) this.unhold(String(h.id));
        });
      } catch {
        this.sql.exec("UPDATE batch_holds SET due = ? WHERE doc = ? AND due <= ?", Date.now() + this.backoff(1), doc, now);
      }
    }
  }
  /** The alarm's part of the budget: give back slack beyond 2 chunks, or write a release D1 missed. */
  private async tendClaim(): Promise<void> {
    const cached = this.get("limits");
    if (!cached) return;
    const C = this.chunk((JSON.parse(cached) as Limits).storage_bytes);
    const dirty = Number(this.get("claim_dirty") ?? 0) === 1;
    if (dirty && Number(this.get("claim_retry_at") ?? 0) > Date.now()) return;
    if (!dirty && this.claim() - this.syncUsed() <= 2 * C) return;
    await this.releaseSlack(C);
    if (Number(this.get("claim_dirty") ?? 0) === 1) {
      const tries = Number(this.get("claim_tries") ?? 0) + 1;
      this.set("claim_tries", tries);
      this.set("claim_retry_at", Date.now() + this.backoff(tries));
    } else this.set("claim_tries", 0);
  }
  /** When the alarm next has budget work: a hold due, a release to write, or slack to give back. */
  private claimDue(now: number): number | null {
    const t: number[] = [];
    const h = this.one("SELECT MIN(due) AS t FROM batch_holds")?.t;
    if (h !== null && h !== undefined) t.push(Number(h));
    if (Number(this.get("claim_dirty") ?? 0) === 1) t.push(Math.max(now, Number(this.get("claim_retry_at") ?? 0)));
    const cached = this.get("limits");
    if (cached && this.claim() - this.syncUsed() > 2 * this.chunk((JSON.parse(cached) as Limits).storage_bytes)) t.push(now + (testMode(this.env) ? 300 : 60_000));
    return t.length ? Math.min(...t) : null;
  }
  private unhold(id: string) {
    const h = this.one("SELECT bytes FROM batch_holds WHERE id = ?", id);
    if (!h) return;
    this.sql.exec("DELETE FROM batch_holds WHERE id = ?", id);
    this.set("held_bytes", Math.max(0, this.heldBytes() - Number(h.bytes)));
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
        this.storeLimits(l);
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
   *
   * `generation` is the one to delete: the user's own deletion names the one
   * their device was given (CORR-3ED-1), and a late request for an older one
   * leaves a newer alone (`stale`).  CoCalc's purge of a deleted account names
   * none: whatever is here goes.  With no storage, nothing is held, and
   * nothing can be until an enable makes the next generation (`none`, with the
   * highest retired, every one of which the Worker may mark purged in D1).
   *
   * CoCalc's purge also leaves this object deleted for good, storage or none
   * (CORR-B92-1): an enable or a request already past its session check when
   * the account was deleted, arriving after, is refused, as is every one
   * after it.  CoCalc never reuses an account id.
   */
  async purge(a: { request_id: string; kind: "self" | "admin"; generation?: number }): Promise<{ state: string; request_id: string; kind?: string; generation?: number; retired?: number }> {
    if (a.kind === "admin")
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
        this.set("deleted", 1);
      });
    if (!this.exists()) return { state: "none", request_id: a.request_id, retired: this.retired() };
    const generation = Number(this.get("generation"));
    if (a.generation !== undefined && a.generation !== generation) return { state: "stale", request_id: a.request_id, generation };
    const st = this.ctx.storage.transactionSync(() => {
      if (this.state() !== "deleting") {
        this.set("state", "deleting");
        this.set("purge_id", a.request_id);
        this.set("purge_kind", a.kind);
        this.set("purge_docs", Number(this.one("SELECT COUNT(*) AS n FROM docs")!.n));
        this.set("purge_bytes", this.used());
      } else if (a.kind === "admin") {
        // (CoCalc's purge joins the user's own: it then names it, as CoCalc asks after its own id)
        this.set("purge_kind", "admin");
        this.set("purge_id", a.request_id);
      }
      return { state: "deleting", request_id: this.get("purge_id")!, kind: this.get("purge_kind")!, generation };
    });
    for (const ws of this.ctx.getWebSockets()) {
      send(ws, { t: "error", code: "deleting", detail: { message: "this account's synced data is being deleted" } });
      ws.close(4410, "deleting");
    }
    this.wakeBy(Date.now());
    return st;
  }

  /**
   * Where CoCalc's purge of this account stands, from this object alone, the
   * authority (CORR-5D0-1): `deleting` while its purge runs; `purged` once it
   * has, `never_synced` if there was nothing to delete; `not_requested` if no
   * CoCalc purge has reached it (CoCalc then sends it again).  Reads only.
   */
  async purgeState(): Promise<{ state: "deleting" | "purged" | "never_synced" | "not_requested" }> {
    if (!this.deleted()) return { state: "not_requested" };
    if (this.exists()) return { state: this.state() === "deleting" ? "deleting" : "not_requested" };
    return { state: this.retired() > 0 ? "purged" : "never_synced" };
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
    // done: this object holds nothing but a tombstone naming the generation it deleted, written in the
    // same synchronous step that drops everything else, so no enable can come between (CORR-A9B-1).
    // The D1 record (counts, no id) is written after, from the tombstone, until it is (CORR-02C-1):
    // every D1 write about a generation then follows this object's decision about it.
    const generation = Number(this.get("generation") ?? 0);
    const record = JSON.stringify({ hash: this.get("account_hash"), generation, finished: Math.floor(now / 1000), request_id: this.get("purge_id"), kind: this.get("purge_kind"), docs: Number(this.get("purge_docs") ?? 0), bytes: Number(this.get("purge_bytes") ?? 0) });
    await this.ctx.storage.deleteAlarm();
    this.ctx.storage.transactionSync(() => {
      // (the high-water mark only rises: a purge of an older generation can't lower it)
      const retired = Math.max(this.retired(), generation);
      const deleted = this.deleted();
      const tables = (this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray() as Row[]).map((r) => String(r.name));
      for (const t of tables) this.sql.exec(`DROP TABLE IF EXISTS "${t}"`);
      this.sql.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('retired', ?)", String(retired));
      // (one record, whatever came before: an earlier one not yet written is covered by this one, LIMIT-B92-1)
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('purged_record', ?)", record);
      if (deleted) this.sql.exec("INSERT INTO meta (k, v) VALUES ('deleted', '1')");
    });
    this.alarmAt = null;
    await this.recordPurged();
    const due = this.recordDue();
    if (due !== null) this.wakeBy(due);
    return true;
  }

  /**
   * Write the D1 record of the last finished purge, if it is still to be
   * written and due (CORR-02C-1).  There is one record, whatever the number of
   * purges (LIMIT-B92-1): it names the newest generation deleted, whose row
   * gets its counts and request id, whatever its state; the row of any older
   * generation, all of them retired, that isn't purged yet is marked purged
   * too, keeping the request id its deletion recorded.  Neither touches a row
   * a registration since has moved on.  One D1 call per attempt; a failure
   * waits a capped exponential backoff with jitter (LIMIT-B92-2).
   */
  private async recordPurged(): Promise<void> {
    const r = this.hasMeta() ? this.get("purged_record") : undefined;
    if (r === undefined) return;
    // (no D1 bound, as a misconfigured deployment would be: a failure like any other, which waits its
    // backoff, never an alarm spinning on a record it can't write, LIMIT-BF3-1)
    const db = testMode(this.env) && this.noDb ? undefined : this.env.SHARE_DB;
    const v = JSON.parse(r) as { hash: string; generation: number; finished: number; request_id: string; kind: string; docs: number; bytes: number; tries?: number; retry_at?: number };
    const now = Date.now();
    if ((v.retry_at ?? 0) > now) return;
    try {
      if (testMode(this.env)) this.recordCalls++;
      if (testMode(this.env) && this.failRecord) throw new Error("D1 unavailable (test seam)");
      if (!db) throw new Error("no D1 bound");
      await db.batch([
        db.prepare("UPDATE sync_accounts SET state = 'purged', finished = ?2, request_id = ?3, kind = ?4, docs = ?5, bytes = ?6, claim_bytes = 0 WHERE account_hash = ?1 AND generation = ?7")
          .bind(v.hash, v.finished, v.request_id, v.kind, v.docs, v.bytes, v.generation),
        db.prepare("UPDATE sync_accounts SET state = 'purged', finished = ?2, docs = COALESCE(docs, 0), bytes = COALESCE(bytes, 0), claim_bytes = 0 WHERE account_hash = ?1 AND generation < ?3 AND state <> 'purged'")
          .bind(v.hash, v.finished, v.generation),
        // every CoCalc request still waiting on this account is done (CORR-1C2-1): its receipt, by its
        // own id, apart from the row; the account is fenced, so this purge is its last
        ...(v.kind === "admin"
          ? [db.prepare("UPDATE sync_admin_requests SET state = 'purged', finished = ?2, docs = ?3, bytes = ?4 WHERE account_hash = ?1 AND state = 'deleting'").bind(v.hash, v.finished, v.docs, v.bytes)]
          : []),
      ]);
      // (only the record written: one for a later purge, written meanwhile, stays)
      this.sql.exec("DELETE FROM meta WHERE k = 'purged_record' AND v = ?", r);
    } catch {
      const tries = (v.tries ?? 0) + 1;
      const wait = Math.round(this.backoff(tries) * (0.5 + Math.random() / 2));
      if (testMode(this.env)) this.recordWaits.push(wait);
      // (unless a later purge's record replaced it meanwhile)
      if (this.get("purged_record") === r) this.set("purged_record", JSON.stringify({ ...v, tries, retry_at: Date.now() + wait }));
    }
  }
  /** When the pending D1 record is next due, or null if none waits. */
  private recordDue(): number | null {
    const r = this.hasMeta() ? this.get("purged_record") : undefined;
    return r === undefined ? null : Math.max(Date.now(), Number((JSON.parse(r) as { retry_at?: number }).retry_at ?? 0));
  }

  // ---- blobs (§5.4)

  /**
   * Reserve the bytes of one upload: one transaction, against the limits,
   * with at most uploadsAtOnce running.  A blob already held needs no upload.
   */
  async reserve(a: { account: string; sha256: string; size: number }): Promise<Result<{ have: true } | { id: string; key: string; expires: number }>> {
    // (no storage, no sync: refused before anything reads a table, CORR-00F-1)
    if (!this.exists()) return { error: { code: "forbidden", message: "turn on sync first" } };
    const l = await this.limits();
    // room in the one budget first (§6.1), for an upload the checks below would take
    if (l && l.sync.enabled && a.size <= Math.min(l.max_file_bytes, MAX_PUT) && !this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", a.sha256)) {
      const r = await attemptAsync(async () => {
        this.admit(a.account, true);
        await this.room(a.size, "file");
      });
      if ("error" in r) return r;
    }
    return attempt(() => this.ctx.storage.transactionSync(() => {
      this.admit(a.account, true);
      if (this.one("SELECT 1 AS x FROM holdings WHERE sha256 = ?", a.sha256)) return { have: true as const };
      if (!l) throw new SyncError("busy", "this account's limits aren't known yet; try again");
      if (!l.sync.enabled) throw new SyncError("readonly", "this account's plan doesn't include sync");
      if (a.size > Math.min(l.max_file_bytes, MAX_PUT)) throw new SyncError("limit", "this file is too large", { limit: "max_file_bytes", max: Math.min(l.max_file_bytes, MAX_PUT) });
      const now = Date.now();
      if (Number(this.one("SELECT COUNT(*) AS n FROM reservations WHERE expires > ?", now)!.n) >= LIMITS.uploadsAtOnce) throw new SyncError("rate", "too many uploads at once", { retry_after: 1000 });
      // (the room was made just before, against the one budget, §6.1; taken meanwhile: try again)
      if (!this.fits(a.size, "file")) throw new SyncError("busy", "try again", { retry_after: 200 });
      const id = randomHex(16);
      const key = `s/${this.get("account_hash")!.slice(0, 32)}/${randomHex(18)}`;
      const ends = now + (testMode(this.env) ? 3000 : RESERVE_MS);
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

  /**
   * Which of these R2 keys this account is responsible for (§9's inventory):
   * a holding's, a reservation's, or one already in its outbox.  An account
   * with no storage knows none.
   */
  async knownKeys(a: { keys: string[] }): Promise<{ known: string[]; statements: number }> {
    if (!this.exists()) return { known: [], statements: 0 };
    // (set-wise: one statement per KNOWN_CHUNK keys, LIMIT-268-2)
    const known: string[] = [];
    let statements = 0;
    for (let i = 0; i < a.keys.length; i += KNOWN_CHUNK) {
      const chunk = JSON.stringify(a.keys.slice(i, i + KNOWN_CHUNK));
      const rows = this.sql.exec(
        "SELECT key FROM holdings WHERE key IN (SELECT value FROM json_each(?1)) UNION SELECT key FROM reservations WHERE key IN (SELECT value FROM json_each(?1)) UNION SELECT key FROM outbox WHERE key IN (SELECT value FROM json_each(?1))",
        chunk,
      ).toArray() as Row[];
      statements++;
      for (const r of rows) known.push(String(r.key));
    }
    return { known, statements };
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
    if (!this.exists()) return { error: { code: "forbidden", message: "turn on sync first" } };
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
    if (!testMode(this.env) || !this.exists()) return null;
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
    if (!testMode(this.env) || !this.exists()) return 0;
    for (let i = 0; i < (a.outbox ?? 0); i++) this.sql.exec("INSERT OR IGNORE INTO outbox (key, created) VALUES (?, ?)", `s/test/${i}`, Date.now());
    if (a.alarmNow) {
      this.alarmAt = Date.now();
      await this.ctx.storage.setAlarm(this.alarmAt);
    } else this.arm();
    return Number(this.one("SELECT COUNT(*) AS n FROM outbox")!.n);
  }

  /** Tests only: make revoke fail, as an unreachable object would; and documents a session had tickets for, made up. */
  async setFailRevoke(a: { on: boolean }): Promise<void> {
    if (testMode(this.env)) this.failRevoke = a.on;
  }
  private failRevoke = false;
  /** Tests only: make the D1 record of a finished purge fail, as an unreachable D1 would. */
  async setFailRecord(a: { on: boolean }): Promise<void> {
    if (testMode(this.env)) this.failRecord = a.on;
  }
  private failRecord = false;
  private recordCalls = 0;
  private failClaim = false;
  /** Tests only: the budget's chunk, as production's would be (LIMIT-97A-1); and holds seeded, due later (LIMIT-97A-2). */
  async setChunk(a: { bytes: number }): Promise<void> {
    if (testMode(this.env)) this.chunkOverride = a.bytes;
  }
  async seedHolds(a: { n: number }): Promise<number> {
    if (!testMode(this.env) || !this.exists()) return 0;
    for (let i = 0; i < a.n; i++) this.sql.exec("INSERT INTO batch_holds (id, doc, bytes, due) VALUES (?, ?, 0, ?)", randomHex(16), "0000seed0000", Date.now() + 3600_000);
    return Number(this.one("SELECT COUNT(*) AS n FROM batch_holds")!.n);
  }
  private claimCalls = 0;
  private claimWrites = 0;
  /** Tests only: make the budget's D1 writes fail, as an unreachable D1 would (§6.1). */
  async setFailClaim(a: { on: boolean }): Promise<void> {
    if (testMode(this.env)) this.failClaim = a.on;
  }
  /** Tests only: the budget as this object holds it. */
  async budget(): Promise<{ claim: number; blob_cap: number; files: number; documents: number; held: number; holds: number; dirty: boolean; calls: number; writes: number; alarm: number | null } | null> {
    if (!testMode(this.env) || !this.exists()) return null;
    return { claim: this.claim(), blob_cap: this.blobCap(), files: this.used(), documents: this.docsBytes(), held: this.heldBytes(), holds: Number(this.one("SELECT COUNT(*) AS n FROM batch_holds")!.n), dirty: Number(this.get("claim_dirty") ?? 0) === 1, calls: this.claimCalls, writes: this.claimWrites, alarm: await this.ctx.storage.getAlarm() };
  }
  private noDb = false;
  /** Tests only: run the D1 record as if SHARE_DB weren't bound. */
  async setNoDb(a: { on: boolean }): Promise<void> {
    if (testMode(this.env)) this.noDb = a.on;
  }
  private recordWaits: number[] = [];
  /** Tests only: fire the alarm now, before anything is due. */
  async wakeNow(): Promise<void> {
    if (testMode(this.env)) this.wakeBy(Date.now());
  }
  /** Tests only: the pending record's tries, as if it had failed that often (to reach the backoff's cap). */
  async setRecordTries(a: { tries: number }): Promise<void> {
    const r = testMode(this.env) && this.hasMeta() ? this.get("purged_record") : undefined;
    if (r !== undefined) this.set("purged_record", JSON.stringify({ ...JSON.parse(r), tries: a.tries }));
  }
  /** Tests only: the lifecycle this object holds, a tombstone's too. */
  async lifecycle(): Promise<{ state: string | null; generation: number | null; retired: number; deleted: boolean; record_pending: boolean; record_tries: number; record_calls: number; record_retry_at: number; record_waits: number[]; meta_rows: number; alarm: number | null } | null> {
    if (!testMode(this.env)) return null;
    const live = this.exists();
    return {
      state: live ? this.state() : null,
      generation: live ? Number(this.get("generation")) : null,
      retired: this.retired(),
      deleted: this.deleted(),
      record_pending: this.recordDue() !== null,
      record_tries: this.hasMeta() && this.get("purged_record") ? Number(JSON.parse(this.get("purged_record")!).tries ?? 0) : 0,
      record_calls: this.recordCalls,
      record_retry_at: this.hasMeta() && this.get("purged_record") ? Number(JSON.parse(this.get("purged_record")!).retry_at ?? 0) : 0,
      record_waits: [...this.recordWaits],
      meta_rows: this.hasMeta() ? Number(this.one("SELECT COUNT(*) AS n FROM meta")!.n) : 0,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
  async seedTicketDocs(a: { session: string; n: number }): Promise<void> {
    if (!testMode(this.env)) return;
    for (let i = 0; i < a.n; i++) this.sql.exec("INSERT OR IGNORE INTO ticket_docs (session_hash, doc, expires) VALUES (?, ?, ?)", a.session, i.toString(16).padStart(12, "0"), Date.now() + 3600_000);
  }

  /** Tests only: hold a purge's steps (the account stays `deleting`) until released. */
  async holdPurge(a: { on: boolean }): Promise<void> {
    if (!testMode(this.env)) return;
    this.purgeHeld = a.on;
    if (!a.on) this.wakeBy(Date.now());
  }
  private purgeHeld = false;

  /** Tests only: forget the alarm and restart this object, as a crash after a pin would (CORR-321-3). */
  async crash(): Promise<void> {
    if (!testMode(this.env)) return;
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
    if (a.testNoFence && testMode(this.env)) return { complete: false };
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
    // (a finished purge's D1 record still unwritten: a tombstone has nothing else to wait for)
    const record = this.recordDue();
    if (record !== null) t.push(record);
    if (!this.exists()) {
      if (t.length) this.wakeBy(t[0]);
      return;
    }
    // (a pending pin is due at its lapse, or at its retry if a lookup failed, whichever is later)
    const pin = this.one("SELECT MIN(max(lapse + ?, COALESCE(retry_at, 0))) AS t FROM pins WHERE state = 'pending'", this.settleMs() + 1)?.t;
    if (pin !== null && pin !== undefined) t.push(Number(pin));
    const res = this.one("SELECT MIN(expires) AS t FROM reservations")?.t;
    if (res !== null && res !== undefined) t.push(Number(res));
    const idle = this.one("SELECT MIN(created) AS t FROM holdings WHERE refs <= 0")?.t;
    if (idle !== null && idle !== undefined) t.push(Number(idle) + IDLE_HOLDING_MS);
    // (the budget: holds to settle, a release to write, slack to give back, §6.1)
    const budget = this.claimDue(now);
    if (budget !== null) t.push(budget);
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
    if (!this.hasMeta()) return;
    // (the last purge's D1 record, if it is still to be written: a failure is retried, from arm())
    await this.recordPurged();
    if (!this.exists()) {
      this.arm();
      return;
    }
    if (this.state() === "deleting") {
      let done = false;
      try {
        if (!this.purgeHeld) done = await this.purgeStep();
      } catch {}
      if (!done) this.wakeBy(Date.now() + (testMode(this.env) ? 200 : 30_000));
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
    await this.settleHolds();
    await this.tendClaim();
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
  if (!s || typeof s !== "object" || typeof s.enabled !== "boolean" || !n(s.version_bytes) || !n(s.read_bytes_per_day)) throw new Error("bad limits");
  // (a sync.storage_bytes CoCalc may still send is ignored: storage_bytes is the one budget, §6.1)
  const sync = { enabled: s.enabled, version_bytes: s.version_bytes, read_bytes_per_day: s.read_bytes_per_day };
  return { storage_bytes: o.storage_bytes, max_file_bytes: o.max_file_bytes, sync, ...(n(o.issued) ? { issued: o.issued } : {}) };
}

/** A pin's whole identity (§4.3). */
interface PinKey { doc: string; epoch: number; ref: string; sha256: string }
/** The patch id in a pin's ref, `patch:<client>:<cseq>:<id>`. */
const idOfRef = (ref: string) => ref.slice(ref.lastIndexOf(":") + 1);
