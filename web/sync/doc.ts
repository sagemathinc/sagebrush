// SyncDoc: one notebook's, board's or chat's patch log (design/sync-server.md
// §4).  Named idFromName("doc:" + owner_hash + ":" + doc), so two accounts
// never name the same object.  Reached only from its owner's account object
// (account.ts), which authenticates, pins blobs and admits grants' writes;
// this object holds the graph and the access list, and decides each batch:
//
// - membership is exact (§4.2): each patchflow client's patches carry a
//   consecutive cseq; clients.next_cseq is the next one, so every cseq below
//   it was accepted and none at or above it was; a resend is matched by id
//   in `ranges`; every parent is looked up exactly;
// - the graph is checked and returned beside opaque payloads (§4.1): the
//   server slices payloads by size and never parses them;
// - one batch row per batch, one `ranges` row per client in it (§4);
// - expect_head is compare-and-swap in the same transaction (§4.4);
// - a grant's write commits only if its admission isn't fenced or expired
//   (§4.5); a forward after its pin_expires is refused (§4.3);
// - clearing history installs the root in the new epoch in the same
//   transaction (§4.6).

import { DurableObject } from "cloudflare:workers";
import { SyncError, LIMITS, RECHECK_MS, attempt, attemptAsync, clientOf, enc, fields, isNat, parseMessage, toB64, type Batch, type Env, type Head, type Result } from "./protocol.ts";
export { unwrap, type Result } from "./protocol.ts";
import { testMode, type SyncEnv } from "./env.ts";

/** Who sent a batch, as the account object authenticated it. */
export interface Writer {
  /** the account whose session or grant this is */
  account: string;
  /** "session:<device>" or "grant:<id>": a patchflow client is bound to one (§4.2) */
  writer: string;
  /** "person" or "agent:<name>": set by the server, never by the client (§5.2) */
  author: string;
  device: string;
}
export interface BatchIn extends Writer {
  batch: Batch;
  /** the account object's pin of the batch's blobs lapses then (§4.3) */
  pin_expires: number;
  /** a grant's write: its admission (§4.5) */
  admit?: { id: string; expires: number };
}
export interface BatchOut {
  head: Head;
  /** the bytes stored (the new patches' payloads) */
  bytes: number;
  /** the document's bytes in all, after this batch: what the account object records (CORR-321-2) */
  total: number;
  /** the seq of the stored batch, if any patch was new */
  seq?: number;
  new: number;
  /** resent patches, by id: the seq they were first stored in */
  resent: Record<string, number>;
  /** the blobs the new patches use (the account object holds their pins) */
  blobs: string[];
}
export interface PullOut {
  epoch: number;
  head: Head;
  items: { seq: number; author: string; writer: string; device: string; patches: Env[]; body: string }[];
  more: boolean;
}

type Row = Record<string, SqlStorageValue>;
const send = (ws: WebSocket, v: unknown) => {
  try {
    ws.send(JSON.stringify(v));
  } catch {}
};
/** A patch's pin reference (design/sync-server.md §4.3). */
export const patchRef = (e: Env) => `patch:${clientOf(e.id)}:${e.cseq}:${e.id}`;
type SqlStorageValue = ArrayBuffer | string | number | null;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS acl (account TEXT PRIMARY KEY, role TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS batches (seq INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, author TEXT, writer TEXT, device TEXT, recv INTEGER, envs TEXT NOT NULL, body BLOB NOT NULL, blobs TEXT, admission TEXT)",
  "CREATE INDEX IF NOT EXISTS batches_admission ON batches (admission) WHERE admission IS NOT NULL",
  "CREATE TABLE IF NOT EXISTS clients (client TEXT PRIMARY KEY, writer TEXT NOT NULL, next_cseq INTEGER NOT NULL, last_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ranges (client TEXT NOT NULL, first_cseq INTEGER NOT NULL, last_cseq INTEGER NOT NULL, first_id TEXT NOT NULL, last_id TEXT NOT NULL, seq INTEGER NOT NULL, ids TEXT NOT NULL, PRIMARY KEY (client, first_cseq))",
  "CREATE INDEX IF NOT EXISTS ranges_id ON ranges (client, first_id)",
  "CREATE TABLE IF NOT EXISTS fenced (admission TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
  // (a pin's whole identity: (doc, epoch, ref, sha256), so a late release can only remove its own pin, CORR-D81-3)
  "CREATE TABLE IF NOT EXISTS releases (epoch INTEGER NOT NULL, ref TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (epoch, ref, sha256))",
  // (revoked sessions this document was told of: checked before an attach and on every message, CORR-D81-7)
  "CREATE TABLE IF NOT EXISTS session_fences (session_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)",
];

/** What a document socket carries across hibernation. */
interface SocketAtt { account: string; session: string; session_expires: number; device: string; socket: string; role: string; checked: number }
/** A presence message's largest size, in UTF-8 bytes, and how many a socket relays a second: never stored (§7.9). */
const PRESENCE_BYTES = 4096;
const PRESENCE_RATE = 10;

export class SyncDoc extends DurableObject<SyncEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: SyncEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // (no table is made until the owner's account object initializes the document)
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
  private exists(): boolean {
    return this.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'") !== undefined && this.get("doc") !== undefined;
  }
  private head(): Head {
    return { epoch: Number(this.get("epoch") ?? 0), seq: Number(this.get("head_seq") ?? 0) };
  }
  /** The caller's role, or a refusal that looks like a missing document. */
  private role(account: string, write: boolean): string {
    if (!this.exists() || this.get("deleted")) throw new SyncError("unknown_doc", "no such document");
    const r = this.one("SELECT role FROM acl WHERE account = ?", account)?.role as string | undefined;
    if (!r) throw new SyncError("unknown_doc", "no such document");
    if (write && r !== "owner" && r !== "editor") throw new SyncError("forbidden", "this document is read-only for you");
    return r;
  }

  /** Made by its owner's account object, once; again is a no-op. */
  async init(a: { owner_account: string; owner_hash: string; doc: string; kind: string; expires?: number }): Promise<Result<Head>> {
    await this.gate(`init:${a.doc}`);
    // (a call the account object has stopped waiting for can't make the document, CORR-5E2-1)
    if (a.expires !== undefined && Date.now() > a.expires) return { error: { code: "busy", message: "this call expired; send again" } };
    // (the object's name holds the owner: anything else is a caller's mistake, never a claim)
    return attempt(() => this.ctx.storage.transactionSync(() => {
      if (this.ctx.id.name !== undefined && this.ctx.id.name !== `doc:${a.owner_hash}:${a.doc}`) throw new SyncError("forbidden", "not this document");
      for (const s of SCHEMA) this.sql.exec(s);
      const had = this.get("doc");
      if (had !== undefined) {
        if (had !== a.doc || this.get("owner_account") !== a.owner_account) throw new SyncError("forbidden", "not this document");
        if (this.get("deleted")) throw new SyncError("unknown_doc", "this document was deleted");
        return this.head();
      }
      this.set("doc", a.doc);
      this.set("owner_account", a.owner_account);
      this.set("owner_hash", a.owner_hash);
      this.set("kind", a.kind);
      this.set("created", Date.now());
      this.set("epoch", 1);
      this.set("head_seq", 0);
      this.set("bytes", 0);
      this.sql.exec("INSERT INTO acl (account, role) VALUES (?, 'owner')", a.owner_account);
      return this.head();
    }));
  }

  /** Decide one batch (§4.1-4.5), in one transaction. */
  async batch(a: BatchIn): Promise<Result<BatchOut>> {
    const id = a.batch.patches[0]?.id ?? "";
    await this.gate(`before:${id}`);
    const r = this.batchNow(a);
    await this.gate(`after:${id}`);
    if (this.lose) {
      this.lose = false;
      throw new Error("the answer was lost (test seam)");
    }
    return r;
  }
  private batchNow(a: BatchIn): Result<BatchOut> {
    const now = Date.now();
    return attempt(() => this.ctx.storage.transactionSync(() => {
      this.role(a.account, true);
      const b = a.batch;
      const head = this.head();
      if (b.epoch !== head.epoch) throw new SyncError("epoch", "this document's history was cleared", { epoch: head.epoch, head });
      // (a forward the account object has given up on can't commit: §4.3)
      if (now > a.pin_expires) throw new SyncError("busy", "this forward expired; send again");
      if (a.admit) {
        if (now > a.admit.expires || this.one("SELECT 1 AS x FROM fenced WHERE admission = ?", a.admit.id)) throw new SyncError("forbidden", "this write's grant changed; it was not committed");
      }
      const out = this.decide(a, head, now);
      // (the test seam: this document's answers are lost after the commit, §4.3)
      if (testMode(this.env) && this.env.SYNC_TEST_LOSE === b.doc && out.new > 0) this.lose = true;
      return out;
    }));
  }
  private lose = false;

  // ---- test seams (SYNC_TEST_PIN_MS bound, in web/sync/test-sync.mjs only): gates that hold one
  // batch before it is decided, or after it is decided and before it answers, for interleavings
  private gates = new Map<string, { wait: Promise<void>; open: () => void }>();
  async hold(a: { name: string }): Promise<void> {
    if (!testMode(this.env)) return;
    let open!: () => void;
    const wait = new Promise<void>((r) => (open = r));
    this.gates.set(a.name, { wait, open });
  }
  async open(a: { name: string }): Promise<void> {
    const g = this.gates.get(a.name) ?? this.opened.get(a.name);
    this.gates.delete(a.name);
    g?.open();
  }
  private opened = new Map<string, { wait: Promise<void>; open: () => void }>();
  private async gate(name: string): Promise<void> {
    const g = this.gates.get(name);
    if (!g) return;
    // (each gate holds one batch: the first to reach it)
    this.gates.delete(name);
    this.opened.set(name, g);
    await g.wait;
    this.opened.delete(name);
  }

  private decide(a: BatchIn, head: Head, now: number): BatchOut {
    const b = a.batch;
    // ---- per client: consecutive cseq, increasing ids, resends matched exactly (§4.2)
    const byClient = new Map<string, { next: number; writer: string | null; lastId: string; last?: Env; fresh: number }>();
    const accepted = new Set<string>(); // ids of this batch already known: earlier in it, resent or new
    const resent: Record<string, number> = {};
    const fresh: { env: Env; start: number }[] = [];
    let offset = 0;
    for (const env of b.patches) {
      const start = offset;
      offset += env.size;
      const client = clientOf(env.id);
      let c = byClient.get(client);
      if (!c) {
        const row = this.one("SELECT writer, next_cseq, last_id FROM clients WHERE client = ?", client);
        c = { next: row ? Number(row.next_cseq) : 1, writer: row ? String(row.writer) : null, lastId: row ? String(row.last_id) : "", fresh: 0 };
        if (c.writer !== null && c.writer !== a.writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
        byClient.set(client, c);
      }
      if (c.last) {
        if (env.cseq !== c.last.cseq + 1 || !(env.id > c.last.id)) throw new SyncError("order", "a client's patches go in order: consecutive cseq, increasing ids", { client, next_cseq: c.next });
      }
      c.last = env;
      if (env.cseq < c.next) {
        // a resend: it must be exactly the patch stored at that cseq
        const r = this.one("SELECT first_cseq, seq, ids FROM ranges WHERE client = ? AND first_cseq <= ? AND last_cseq >= ? ORDER BY first_cseq DESC LIMIT 1", client, env.cseq, env.cseq);
        const ids = r ? (JSON.parse(String(r.ids)) as string[]) : [];
        if (!r || ids[env.cseq - Number(r.first_cseq)] !== env.id) throw new SyncError("conflict", "this cseq was accepted for another patch", { client, cseq: env.cseq });
        resent[env.id] = Number(r.seq);
        accepted.add(env.id);
        continue;
      }
      // new: exactly the next one (a gap is refused, never skipped)
      const expected = c.next + c.fresh;
      if (env.cseq !== expected) throw new SyncError("order", "a gap in this client's patches", { client, next_cseq: expected });
      // (and a later patch has a larger id than every one accepted before it)
      if (c.fresh === 0 && !(env.id > c.lastId)) throw new SyncError("order", "a client's ids only increase", { client, next_cseq: expected });
      for (const p of env.parents) if (!accepted.has(p) && !this.known(p)) throw new SyncError("order", "a parent isn't accepted yet", { parent: p });
      accepted.add(env.id);
      c.fresh++;
      fresh.push({ env, start });
    }
    if (fresh.length === 0) return { head, bytes: 0, total: Number(this.get("bytes") ?? 0), new: 0, resent, blobs: [] };
    // ---- compare-and-swap on the head (§4.4), only for a batch with something new
    if (b.expect_head && (b.expect_head.epoch !== head.epoch || b.expect_head.seq !== head.seq)) throw new SyncError("conflict", "the document moved on", { head });
    // ---- store: the new patches only, their payloads sliced out by size, never parsed (§4.2)
    const body = new Uint8Array(fresh.reduce((n, f) => n + f.env.size, 0));
    let at = 0;
    for (const f of fresh) {
      body.set(b.body.subarray(f.start, f.start + f.env.size), at);
      at += f.env.size;
    }
    const seq = head.seq + 1;
    const envs = fresh.map((f) => f.env);
    const blobs = [...new Set(envs.flatMap((e) => e.blobs ?? []))];
    this.sql.exec(
      "INSERT INTO batches (seq, epoch, author, writer, device, recv, envs, body, blobs, admission) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      seq, head.epoch, a.author, a.writer, a.device, now, JSON.stringify(envs), body, blobs.length ? JSON.stringify(blobs) : null, a.admit?.id ?? null,
    );
    const groups = new Map<string, Env[]>();
    for (const e of envs) groups.set(clientOf(e.id), [...(groups.get(clientOf(e.id)) ?? []), e]);
    for (const [client, es] of groups) {
      this.sql.exec(
        "INSERT INTO ranges (client, first_cseq, last_cseq, first_id, last_id, seq, ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
        client, es[0].cseq, es[es.length - 1].cseq, es[0].id, es[es.length - 1].id, seq, JSON.stringify(es.map((e) => e.id)),
      );
      this.sql.exec(
        "INSERT INTO clients (client, writer, next_cseq, last_id) VALUES (?, ?, ?, ?) ON CONFLICT(client) DO UPDATE SET next_cseq = excluded.next_cseq, last_id = excluded.last_id",
        client, a.writer, es[es.length - 1].cseq + 1, es[es.length - 1].id,
      );
    }
    this.set("head_seq", seq);
    const total = Number(this.get("bytes") ?? 0) + body.length;
    this.set("bytes", total);
    return { head: { epoch: head.epoch, seq }, bytes: body.length, total, seq, new: fresh.length, resent, blobs };
  }

  /** Whether patch `id` was accepted, exactly (§4.2): its client's range, and that range's ids. */
  private known(id: string): boolean {
    const r = this.one("SELECT last_id, ids FROM ranges WHERE client = ? AND first_id <= ? ORDER BY first_id DESC LIMIT 1", clientOf(id), id);
    return !!r && id <= String(r.last_id) && (JSON.parse(String(r.ids)) as string[]).includes(id);
  }

  /** Batches after `after` in `epoch` (§5.2), bounded in items and bytes. */
  async pull(a: { account: string; epoch: number; after: number; limit?: number }): Promise<Result<PullOut>> {
    return attempt(() => this.pullNow(a));
  }
  private pullNow(a: { account: string; epoch: number; after: number; limit?: number }): PullOut {
    this.role(a.account, false);
    const head = this.head();
    if (a.epoch !== head.epoch) throw new SyncError("epoch", "this document's history was cleared", { epoch: head.epoch, head });
    const limit = Math.min(Math.max(1, a.limit ?? LIMITS.pullDefault), LIMITS.pullMax);
    const rows = this.sql.exec("SELECT seq, author, writer, device, envs, body FROM batches WHERE epoch = ? AND seq > ? ORDER BY seq LIMIT ?", head.epoch, a.after, limit + 1).toArray() as Row[];
    const items: PullOut["items"] = [];
    let bytes = 0;
    let more = rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      const body = new Uint8Array(r.body as ArrayBuffer);
      // (base64 is 4/3 of the bytes; the envelopes are counted as stored)
      const cost = Math.ceil(body.length / 3) * 4 + String(r.envs).length + 200;
      if (items.length > 0 && bytes + cost > LIMITS.pullBytes) {
        more = true;
        break;
      }
      bytes += cost;
      items.push({ seq: Number(r.seq), author: String(r.author), writer: String(r.writer), device: String(r.device), patches: JSON.parse(String(r.envs)), body: toB64(body) });
    }
    return { epoch: head.epoch, head, items, more };
  }

  /**
   * Clear history (§4.6): from the owner's session only.  In one
   * transaction: the head must be `expect_head`; the epoch rises; every
   * older batch goes, its blobs to `releases`; the clients and ranges are
   * emptied; and `root`, one parentless patch holding the current value,
   * is the new epoch's first batch.  So the document always has a value.
   */
  async clear(a: Writer & { expect_head: Head; root: Batch; pin_expires: number }): Promise<Result<BatchOut>> {
    return attemptAsync(() => this.clearNow(a));
  }
  private async clearNow(a: Writer & { expect_head: Head; root: Batch; pin_expires: number }): Promise<BatchOut> {
    const now = Date.now();
    const out = this.ctx.storage.transactionSync(() => {
      if (this.role(a.account, true) !== "owner" || !a.writer.startsWith("session:") || a.author !== "person") throw new SyncError("forbidden", "only the owner, from a session, clears history");
      if (now > a.pin_expires) throw new SyncError("busy", "this forward expired; send again");
      const head = this.head();
      if (a.expect_head.epoch !== head.epoch || a.expect_head.seq !== head.seq) throw new SyncError("conflict", "the document moved on", { head });
      const r = a.root;
      if (r.patches.length !== 1 || r.patches[0].parents.length !== 0 || r.patches[0].cseq !== 1) throw new SyncError("invalid", "the root is one patch, with no parents, its client's first");
      for (const row of this.sql.exec("SELECT epoch, envs FROM batches WHERE blobs IS NOT NULL").toArray() as Row[])
        for (const e of JSON.parse(String(row.envs)) as Env[])
          for (const sha of e.blobs ?? []) this.sql.exec("INSERT OR IGNORE INTO releases (epoch, ref, sha256) VALUES (?, ?, ?)", row.epoch, patchRef(e), sha);
      this.sql.exec("DELETE FROM batches");
      this.sql.exec("DELETE FROM clients");
      this.sql.exec("DELETE FROM ranges");
      this.sql.exec("DELETE FROM fenced");
      this.set("bytes", 0);
      this.set("epoch", head.epoch + 1);
      return this.decide({ ...a, batch: { ...r, epoch: head.epoch + 1 }, pin_expires: a.pin_expires }, { epoch: head.epoch + 1, seq: head.seq }, now);
    });
    // (the released blobs go back to the account object from the alarm)
    await this.ctx.storage.setAlarm(now);
    return out;
  }

  /**
   * Fence admissions (§4.5): from now until each one's expiry, a write
   * carrying it is refused.  Answers with the ones already committed, and
   * their seq, so the account object logs them as committed.
   */
  async fence(a: { ids: { id: string; expires: number }[] }): Promise<Record<string, number>> {
    if (!this.exists()) return {};
    return this.ctx.storage.transactionSync(() => {
      const done: Record<string, number> = {};
      for (const f of a.ids) {
        this.sql.exec("INSERT INTO fenced (admission, expires) VALUES (?, ?) ON CONFLICT(admission) DO UPDATE SET expires = max(expires, excluded.expires)", f.id, f.expires);
        const r = this.one("SELECT seq FROM batches WHERE admission = ?", f.id);
        if (r) done[f.id] = Number(r.seq);
      }
      this.sql.exec("DELETE FROM fenced WHERE expires < ?", Date.now() - 60_000);
      return done;
    });
  }

  /**
   * Which of these patches this document holds, exactly (§4.2, §4.3): by
   * epoch and id, answered as "epoch:id".  A patch of an epoch that isn't
   * the current one is never held: clearing dropped it.
   */
  async accepted(a: { ids: { epoch: number; id: string }[] }): Promise<Result<string[]>> {
    // (test seams: each call may be held by its own gate, accepted:<id>#<n>; and every call may fail)
    const id = a.ids[0]?.id ?? "";
    const n = (this.acceptedCalls.get(id) ?? 0) + 1;
    this.acceptedCalls.set(id, n);
    if (this.failAccepted) throw new Error("the document is unavailable (test seam)");
    const before = this.acceptedNow(a);
    await this.gate(`accepted:${id}#${n}`);
    return before;
  }
  private acceptedCalls = new Map<string, number>();
  private failAccepted = false;
  /** Tests only: make accepted() fail, as an outage would. */
  async setFailAccepted(a: { on: boolean }): Promise<void> {
    if (testMode(this.env)) this.failAccepted = a.on;
  }
  private acceptedNow(a: { ids: { epoch: number; id: string }[] }): Result<string[]> {
    return attempt(() => {
      if (!this.exists()) return [];
      const epoch = this.head().epoch;
      return a.ids.filter((x) => x.epoch === epoch && this.known(x.id)).map((x) => `${x.epoch}:${x.id}`);
    });
  }

  /** What this object has accepted from a client: for settling a pin or an admission whose answer was lost. */
  async status(a: { client: string; admission?: string }): Promise<{ next_cseq: number; committed?: number; head: Head }> {
    if (!this.exists()) return { next_cseq: 1, head: { epoch: 0, seq: 0 } };
    const c = this.one("SELECT next_cseq FROM clients WHERE client = ?", a.client);
    const r = a.admission ? this.one("SELECT seq FROM batches WHERE admission = ?", a.admission) : undefined;
    return { next_cseq: c ? Number(c.next_cseq) : 1, ...(r ? { committed: Number(r.seq) } : {}), head: this.head() };
  }

  /** The head and the document's total bytes: for settling a batch's hold whose answer was lost (§6.1). */
  async info(): Promise<{ head: Head; total: number }> {
    if (!this.exists()) return { head: { epoch: 0, seq: 0 }, total: 0 };
    return { head: this.head(), total: Number(this.get("bytes") ?? 0) };
  }

  // ---- document sockets (§2, §5.1)

  private ownerAccount() {
    const ns = this.env.SYNC_ACCOUNT!;
    return ns.get(ns.idFromName("acct:" + this.get("owner_hash")));
  }
  private fencedSession(session: string): boolean {
    return this.one("SELECT 1 AS x FROM session_fences WHERE session_hash = ? AND expires > ?", session, Date.now()) !== undefined;
  }

  /**
   * The upgrade, from the Worker, which authenticated the session: the
   * ticket is redeemed once from the account object, then the session's
   * fence and the access list are checked and the socket accepted, with
   * no await between those checks and the accept (CORR-D81-7).
   */
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
    const account = req.headers.get("x-sync-account") ?? "";
    const session = req.headers.get("x-sync-session") ?? "";
    const nonce = new URL(req.url).searchParams.get("ticket") ?? "";
    const no = (status: number, error: string) => Response.json({ error }, { status });
    if (!this.exists() || this.get("deleted")) return no(404, "unknown_doc");
    const r = await this.ownerAccount().redeem({ nonce, doc: this.get("doc")!, account, session });
    if ("error" in r) return no(403, r.error.code);
    // ---- from here to acceptWebSocket, nothing awaits
    if (this.fencedSession(session)) {
      this.ctx.waitUntil(this.ownerAccount().lease({ socket: r.ok.socket, release: true }));
      return no(403, "forbidden");
    }
    const role = this.one("SELECT role FROM acl WHERE account = ?", account)?.role as string | undefined;
    if (!role || this.ctx.getWebSockets().length >= LIMITS.docSocketsPerDoc) {
      this.ctx.waitUntil(this.ownerAccount().lease({ socket: r.ok.socket, release: true }));
      return no(role ? 503 : 404, role ? "busy" : "unknown_doc");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`s:${session}`, `a:${account}`]);
    pair[1].serializeAttachment({ account, session, session_expires: r.ok.session_expires, device: r.ok.device, socket: r.ok.socket, role, checked: Date.now() } satisfies SocketAtt);
    const n = this.ctx.getWebSockets().length;
    for (const ws of this.ctx.getWebSockets()) send(ws, { t: "watching", doc: this.get("doc"), n });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as SocketAtt;
    let req: unknown;
    try {
      // (the fence and the access list, on every message, before anything else)
      if (this.fencedSession(att.session) || Date.now() >= att.session_expires) return this.end(ws, "session ended");
      const role = this.one("SELECT role FROM acl WHERE account = ?", att.account)?.role as string | undefined;
      if (!role) return this.end(ws, "no access");
      const m = parseMessage(raw);
      req = m.req;
      if (Date.now() - att.checked >= RECHECK_MS) {
        if (!(await this.recheck(ws, att))) return;
      }
      if (m.t === "presence") {
        fields(m, ["t", "state"], "presence");
        const text = JSON.stringify(m.state ?? null);
        // (in UTF-8 bytes; and coalesced per socket, the latest wins, at most PRESENCE_RATE a second, LIMIT-6D6-2)
        if (enc.encode(text).length > PRESENCE_BYTES) throw new SyncError("limit", "presence is small", { limit: "presence_bytes", max: PRESENCE_BYTES });
        this.presence(ws, att.device, m.state ?? null);
        return;
      }
      if (!isNat(req)) throw new SyncError("invalid", "req");
      if (m.t === "batch") {
        if (role !== "owner" && role !== "editor") throw new SyncError("forbidden", "this document is read-only for you");
        fields(m, ["t", "req", "doc", "epoch", "expect_head", "patches", "body"], "batch");
        if (m.doc !== this.get("doc")) throw new SyncError("invalid", "this socket is for another document");
        // (at most `inflight` unanswered on a socket, LIMIT-6D6-1)
        const n = this.inflight.get(ws) ?? 0;
        if (n >= LIMITS.inflight) throw new SyncError("busy", "too many requests unanswered");
        this.inflight.set(ws, n + 1);
        let r: Result<BatchOut>;
        try {
          // the account object decides it, as for a batch from its own socket: its rate limits, the
          // session not revoked, blobs pinned, then this object's batch(), and the head it records
          // itself (LIMIT-6D6-1, CORR-6D6-2, CORR-6D6-3)
          r = await this.ownerAccount().socketBatch({ account: att.account, session: att.session, device: att.device, batch: { owner: this.get("owner_hash"), ...Object.fromEntries(["doc", "epoch", "expect_head", "patches", "body"].filter((k) => Object.prototype.hasOwnProperty.call(m, k)).map((k) => [k, m[k]])) } });
        } finally {
          this.inflight.set(ws, (this.inflight.get(ws) ?? 1) - 1);
        }
        if ("error" in r) throw new SyncError(r.error.code, r.error.message, r.error.detail);
        send(ws, { t: "ack", req, batch: { seq: r.ok.seq, new: r.ok.new, resent: r.ok.resent, head: r.ok.head } });
        if (r.ok.new > 0 && r.ok.seq !== undefined) {
          const item = this.sql.exec("SELECT seq, author, writer, device, envs, body FROM batches WHERE seq = ?", r.ok.seq).toArray()[0] as Row | undefined;
          if (item) {
            const live = { t: "batches", doc: m.doc, epoch: r.ok.head.epoch, items: [{ seq: Number(item.seq), author: String(item.author), writer: String(item.writer), device: String(item.device), patches: JSON.parse(String(item.envs)), body: toB64(new Uint8Array(item.body as ArrayBuffer)) }], more: false };
            for (const o of this.ctx.getWebSockets()) if (o !== ws) send(o, live);
          }
        }
        return;
      }
      throw new SyncError("invalid", "unknown message");
    } catch (e) {
      if (e instanceof SyncError && e.code === "limit" && e.detail?.limit === "message_bytes") return ws.close(1009, "message too large");
      const x = e instanceof SyncError ? { code: e.code, detail: { message: e.message, ...e.detail } } : { code: "busy", detail: { message: "try again" } };
      send(ws, { t: "error", ...(isNat(req) ? { req } : {}), ...x });
    }
  }

  private inflight = new WeakMap<WebSocket, number>();
  private presenceAt = new WeakMap<WebSocket, { last: number; pending?: unknown; timer?: ReturnType<typeof setTimeout> }>();
  /** Relay a socket's presence to the others: at most PRESENCE_RATE a second, the latest kept, never stored. */
  private presence(ws: WebSocket, device: string, state: unknown) {
    const now = Date.now();
    const p = this.presenceAt.get(ws) ?? { last: 0 };
    this.presenceAt.set(ws, p);
    const gap = 1000 / PRESENCE_RATE;
    const flush = (st: unknown) => {
      p.last = Date.now();
      p.pending = undefined;
      p.timer = undefined;
      for (const o of this.ctx.getWebSockets()) if (o !== ws) send(o, { t: "presence", device, state: st });
    };
    if (now - p.last >= gap && !p.timer) return flush(state);
    p.pending = state;
    p.timer ??= setTimeout(() => flush(p.pending), Math.max(0, gap - (now - p.last)));
  }

  /** Every RECHECK_MS of use: the D1 session, and the socket's lease renewed (§2, LIMIT-D817-4). */
  private async recheck(ws: WebSocket, att: SocketAtt): Promise<boolean> {
    const now = Date.now();
    const db = this.env.SHARE_DB;
    const row = db
      ? await db.prepare("SELECT s.expires FROM sessions s JOIN accounts a ON a.account_id = s.account_id WHERE s.token_hash = ?1 AND s.account_id = ?2 AND s.expires > ?3 AND a.deleting IS NULL").bind(att.session, att.account, Math.floor(now / 1000)).first<{ expires: number }>()
      : null;
    if (!row) {
      this.end(ws, "session ended");
      return false;
    }
    const l = await this.ownerAccount().lease({ socket: att.socket });
    if ("error" in l) {
      this.end(ws, "this socket's lease ended");
      return false;
    }
    // (after the awaits: the fence again, since a revoke may have landed meanwhile)
    if (this.fencedSession(att.session)) {
      this.end(ws, "session ended");
      return false;
    }
    ws.serializeAttachment({ ...att, checked: now, session_expires: row.expires * 1000 } satisfies SocketAtt);
    return true;
  }

  private end(ws: WebSocket, why: string) {
    send(ws, { t: "revoked" });
    try {
      ws.close(4401, why);
    } catch {}
  }

  async webSocketClose(ws: WebSocket, code: number) {
    const att = ws.deserializeAttachment() as SocketAtt | null;
    if (att?.socket) this.ctx.waitUntil(this.ownerAccount().lease({ socket: att.socket, release: true }).catch(() => {}));
    try {
      ws.close(code, "closed");
    } catch {}
  }

  /**
   * A revoked session (§2): recorded durably, then its sockets closed.  The
   * account object's revoke completes only once this has answered.
   */
  async fenceSession(a: { session: string; expires: number; keepOpen?: boolean }): Promise<void> {
    if (!this.exists()) return;
    this.sql.exec("INSERT INTO session_fences (session_hash, expires) VALUES (?, ?) ON CONFLICT(session_hash) DO UPDATE SET expires = max(expires, excluded.expires)", a.session, a.expires);
    this.sql.exec("DELETE FROM session_fences WHERE expires < ?", Date.now());
    // (keepOpen, a test seam: the fence without its close, so the check on every message is what refuses)
    if (a.keepOpen && testMode(this.env)) return;
    for (const ws of this.ctx.getWebSockets(`s:${a.session}`)) this.end(ws, "session ended");
  }

  /**
   * Change an account's access (§7.9; from the owner's account object): in
   * the same request, the sockets of an account that lost access close, and
   * those whose role changed carry the new role.  The owner can't be removed.
   */
  async setAccess(a: { account: string; role: "editor" | "viewer" | null }): Promise<Result<null>> {
    return attempt(() => {
      if (!this.exists()) throw new SyncError("unknown_doc", "no such document");
      if (a.account === this.get("owner_account")) throw new SyncError("forbidden", "the owner's access can't change");
      if (a.role === null) this.sql.exec("DELETE FROM acl WHERE account = ?", a.account);
      else this.sql.exec("INSERT INTO acl (account, role) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET role = excluded.role", a.account, a.role);
      for (const ws of this.ctx.getWebSockets(`a:${a.account}`)) {
        if (a.role === null) this.end(ws, "no access");
        else ws.serializeAttachment({ ...(ws.deserializeAttachment() as SocketAtt), role: a.role } satisfies SocketAtt);
      }
      return null;
    });
  }

  /**
   * Delete this document (§7), from its owner's account object: in one
   * transaction it is marked deleted and its history, access list and
   * records dropped; its sockets close; then its storage is wiped.  Its
   * blobs are the account's, which deletes them itself.  Idempotent.
   */
  async purge(): Promise<{ done: true }> {
    if (this.exists()) {
      this.ctx.storage.transactionSync(() => {
        this.set("deleted", Date.now());
        for (const t of ["batches", "clients", "ranges", "fenced", "releases", "acl", "session_fences"]) this.sql.exec(`DELETE FROM ${t}`);
      });
      for (const ws of this.ctx.getWebSockets()) this.end(ws, "this document was deleted");
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { done: true };
  }

  /** The alarm: hands released blobs back to the owner's account object until it acknowledges (§4.3). */
  async alarm(): Promise<void> {
    if (!this.exists()) return;
    const rows = this.sql.exec("SELECT epoch, ref, sha256 FROM releases LIMIT 500").toArray() as Row[];
    if (rows.length === 0) return;
    const owner = this.get("owner_hash")!;
    const doc = this.get("doc")!;
    const account = this.env.SYNC_ACCOUNT.get(this.env.SYNC_ACCOUNT.idFromName("acct:" + owner));
    try {
      await account.release({ doc, pins: rows.map((r) => ({ epoch: Number(r.epoch), ref: String(r.ref), sha256: String(r.sha256) })) });
      this.ctx.storage.transactionSync(() => {
        for (const r of rows) this.sql.exec("DELETE FROM releases WHERE epoch = ? AND ref = ? AND sha256 = ?", r.epoch, r.ref, r.sha256);
      });
      if (rows.length === 500) await this.ctx.storage.setAlarm(Date.now());
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }
}
