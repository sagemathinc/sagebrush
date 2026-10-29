// The open reference server for sync's protocol (plan-cloud-split-r1 §3;
// plan-sync-slice2-client-r4 §2.0): one in-memory process that answers what
// design/sync-server.md and plan-sync-slice2-r9.md say a server answers, so
// core can test its client without the cloud's server.  It is for tests only,
// is never deployed, and has no limits beyond the protocol's own: no D1, no R2,
// no plans, quotas or purges in steps.  Every message goes through
// protocol.ts's and doc-protocol.ts's checks, as the real server's do.
//
// What it speaks:
// - the account socket, slice 1: hello/welcome (with the client's binding),
//   index and pull_index, ops (decided in dseq order, once each), index_changed;
// - the account socket, slice 2's documents: doc_claim and doc_fence (for the document's current epoch, else
//   stale_epoch), batch (with
//   fgen), pull (with upto, recv and chain), clear (its root bootstraps the
//   clearing client's new-epoch row), changed;
// - HTTP: the test sign-in, status, enable, delete, blobs/check, blob PUT/GET.
// Document sockets, tickets and snapshots come with their stages
// (2c-5, 2d); until then a ticket is refused as `invalid`.
//
// Test controls (`server.controls`): the clock, holding a batch's forward
// before its commit, dropping or faking the next answers of a kind, a session's
// revocation, and a document's clients as stored.
//   bun web/sync-protocol/test-reference-server.mjs

import {
  LIMITS, PERSON_ONLY, SyncError, VERSION, accountHash, checkBatch, checkHead, checkOp, clientOf, enc, fields, has, isDevice,
  isDocId, isHash, isNat, isSha, parseMessage, sha256Hex, toB64, type Batch, type Env, type Head, type Op,
} from "./protocol.ts";
import { batchHash, chainNext, chainSeed, checkDocClaim, checkDocFence, checkFgen, checkUpto, hex } from "./doc-protocol.ts";

/** The cookie a test session rides on: the same name as the site's, so a test front can pass it along. */
export const SESSION_COOKIE = "__Host-sb_session";
/** The largest blob a single PUT takes (design/sync-server.md §5.4). */
const MAX_PUT = 95 * 2 ** 20;
/** Unused claims a writer may hold on one document (plan-sync-slice2-2b-r4 §2.6, the default). */
const UNUSED_CLAIMS = 16;

type Json = Record<string, unknown>;
const J = JSON.stringify;

interface Session { account: string; expires: number }
interface Client { writer: string; next_cseq: number; last_id: string; fgen: number; claimed_at: number }
interface Range { first_cseq: number; last_cseq: number; first_id: string; last_id: string; seq: number; ids: string[] }
interface Stored { seq: number; epoch: number; author: string; writer: string; device: string; recv: number; envs: string; body: Uint8Array; chain: string }
interface Doc {
  doc: string;
  kind?: string;
  epoch: number;
  /** the last seq stored, in any epoch: seqs are never reused (r9 §5.1) */
  seq: number;
  /** the current epoch's head seq (0 before its first batch) */
  head: number;
  batches: Stored[];
  clients: Map<string, Client>;
  ranges: Map<string, Range[]>;
  recvLast: number;
  recvFloor: number;
  chain: Uint8Array;
}
interface Device { next_dseq: number; answers: Map<number, { seq: number } | { code: string }>; refused: number }
interface IndexOp extends Json { seq: number }
interface Account {
  id: string;
  hash: string;
  state: "off" | "active" | "deleting";
  generation: number;
  ops: IndexOp[];
  devices: Map<string, Device>;
  blobs: Map<string, Uint8Array>;
  docs: Map<string, Doc>;
  sockets: Set<RefSocket>;
}

/** What a test answers instead of the server, for the next messages of a kind. */
type Fake = { drop: true } | { error: { code: string; detail?: Json } };

/**
 * One side of a socket, as a page sees it: `send` goes to the server; the
 * server's messages arrive at `onmessage`, each on its own turn, in order.
 */
export class RefSocket {
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  closed = false;
  /** set by hello */
  device: string | null = null;
  inflight = 0;
  constructor(private server: ReferenceServer, readonly account: Account, readonly session: string) {}
  /** From the page to the server: each message starts in arrival order and runs until it awaits, as the real
   * object's requests interleave at their awaits (a fence can run while a batch's forward is held, r9 §5.8). */
  send(text: string) {
    if (this.closing) return;
    this.server.message(this, text).catch((e) => console.warn("reference server:", e));
  }
  /** set by close(): nothing more is sent or taken, and what was sent before it still arrives first */
  private closing = false;
  /** From the server to the page. */
  deliver(v: unknown) {
    if (this.closing) return;
    const text = JSON.stringify(v);
    setTimeout(() => !this.closed && this.onmessage?.(text), 0);
  }
  close(code = 1000, reason = "closed") {
    if (this.closing) return;
    this.closing = true;
    this.account.sockets.delete(this);
    setTimeout(() => {
      this.closed = true;
      this.onclose?.(code, reason);
    }, 0);
  }
}

export class ReferenceServer {
  private accounts = new Map<string, Account>();
  /** an account being made: concurrent first accesses wait for the same one (CORR-173-4) */
  private making = new Map<string, Promise<Account>>();
  private sessions = new Map<string, Session>();
  private holds = new Map<string, { wait: Promise<void>; release: () => void }>();
  private fakes = new Map<string, Fake[]>();
  private nowMs: number | null = null;
  /** Who may sync (the allowlist); everyone by default. */
  constructor(private opts: { allow?: (account: string) => boolean } = {}) {}

  // ---- test controls

  readonly controls = {
    /** The server's clock (ms); null: the real one. */
    setNow: (ms: number | null) => { this.nowMs = ms; },
    /** Hold the next batch for `doc` (and `client`, if given) after its checks and before its commit; returns the release. */
    holdForward: (doc: string, client?: string): (() => void) => {
      let release!: () => void;
      const wait = new Promise<void>((r) => (release = r));
      this.holds.set(`${doc}:${client ?? "*"}`, { wait, release });
      return () => release();
    },
    /** The next `n` answers to messages of type `t` dropped, or refused with `error`. */
    fake: (t: string, f: Fake, n = 1) => { this.fakes.set(t, [...(this.fakes.get(t) ?? []), ...Array(n).fill(f)]); },
    /** A session ended: its sockets get `revoked` and close 4401. */
    revoke: (session: string) => {
      this.sessions.delete(session);
      for (const a of this.accounts.values()) for (const s of [...a.sockets]) if (s.session === session) { s.deliver({ t: "revoked" }); s.close(4401, "session ended"); }
    },
    /** A document's clients as stored, for assertions. */
    clients: (account: string, doc: string) => {
      const d = this.accounts.get(account)?.docs.get(doc);
      return d ? Object.fromEntries([...d.clients].map(([k, c]) => [k, { ...c }])) : null;
    },
    /** A document's head and stored batches, for assertions. */
    doc: (account: string, doc: string) => {
      const d = this.accounts.get(account)?.docs.get(doc);
      return d ? { epoch: d.epoch, head: d.head, seq: d.seq, batches: d.batches.map((b) => ({ ...b })) } : null;
    },
  };

  private now() {
    return this.nowMs ?? Date.now();
  }

  // ---- sessions and accounts

  /** A session for `account` (the test sign-in), as the cookie value. */
  signIn(account: string, ttlMs = 24 * 3600_000): string {
    const token = crypto.randomUUID();
    this.sessions.set(token, { account, expires: this.now() + ttlMs });
    return token;
  }
  private sessionOf(cookie: string | null): { token: string; account: string } | null {
    const m = (cookie ?? "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    const s = m ? this.sessions.get(m[1]) : undefined;
    if (!m || !s || s.expires <= this.now()) return null;
    return { token: m[1], account: s.account };
  }
  private accountOf(id: string): Promise<Account> {
    const a = this.accounts.get(id);
    if (a) return Promise.resolve(a);
    let p = this.making.get(id);
    if (!p) {
      p = accountHash(id).then((hash) => {
        const made: Account = { id, hash, state: "off", generation: 0, ops: [], devices: new Map(), blobs: new Map(), docs: new Map(), sockets: new Set() };
        this.accounts.set(id, made);
        this.making.delete(id);
        return made;
      });
      this.making.set(id, p);
    }
    return p;
  }

  // ---- HTTP (design/sync-server.md §5.1, §5.4)

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const err = (status: number, code: string, detail: Json = {}) => json({ error: code, ...detail }, status);
    if (p === "/auth/dev" && m === "POST") {
      const b = (await req.json().catch(() => null)) as { account_id?: unknown } | null;
      if (typeof b?.account_id !== "string" || !b.account_id) return err(400, "invalid");
      const token = this.signIn(b.account_id);
      return new Response(null, { status: 204, headers: { "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax` } });
    }
    const files = p.match(/^\/__files\/([0-9a-f]{64})$/);
    if (files && m === "GET") {
      for (const a of this.accounts.values()) {
        const bytes = a.blobs.get(files[1]);
        if (bytes) return new Response(bytes.slice(), { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } });
      }
      return err(404, "missing");
    }
    if (!p.startsWith("/api/sync/")) return err(404, "not found");
    const who = this.sessionOf(req.headers.get("cookie"));
    if (!who) return err(401, "sign in first");
    const a = await this.accountOf(who.account);
    const allowed = this.opts.allow?.(who.account) ?? true;
    if (p === "/api/sync/v1/status" && m === "GET") {
      if (!allowed) return json({ available: false, reason: "not_allowlisted", state: "off", account: a.hash });
      return json({ available: true, state: a.state, ...(a.generation ? { generation: a.generation } : {}), account: a.hash });
    }
    if (!allowed) return err(403, "forbidden", { message: "sync isn't enabled for this account" });
    if (p === "/api/sync/v1/enable" && m === "POST") {
      if (a.state === "deleting") return err(409, "deleting");
      if (a.state === "off") {
        a.state = "active";
        a.generation++;
      }
      return json({ state: a.state, generation: a.generation });
    }
    if (p === "/api/sync/v1/delete" && m === "POST") {
      const b = (await req.json().catch(() => null)) as { confirm?: unknown; generation?: unknown } | null;
      if (b?.confirm !== "delete" || !isNat(b.generation) || b.generation < 1) return err(400, "invalid");
      if (b.generation !== a.generation || a.state === "off") return json({ state: "stale", request_id: crypto.randomUUID() }, 202);
      // (the sockets hear it first, then everything is gone at once: the reference has no steps)
      a.state = "deleting";
      for (const s of [...a.sockets]) { s.deliver({ t: "error", code: "deleting", detail: { message: "this account's synced data is being deleted" } }); s.close(4410, "deleting"); }
      Object.assign(a, { state: "off", ops: [], devices: new Map(), blobs: new Map(), docs: new Map() });
      return json({ state: "deleting", request_id: crypto.randomUUID(), generation: b.generation }, 202);
    }
    const bound = bindingRefusal(a, req.headers.get("x-sync-account"), req.headers.get("x-sync-generation"));
    if (bound) return err(bound.status, bound.code, { reason: bound.reason });
    if (p === "/api/sync/v1/blobs/check" && m === "POST") {
      if (a.state !== "active") return err(409, a.state === "deleting" ? "deleting" : "readonly");
      let blobs: string[];
      try {
        const b = fields(JSON.parse(await req.text()), ["blobs"], "check");
        if (!Array.isArray(b.blobs) || b.blobs.length > LIMITS.checkItems) throw new SyncError("limit", "at most " + LIMITS.checkItems, { limit: "check_items", max: LIMITS.checkItems });
        blobs = b.blobs.map((x) => {
          const o = fields(x, ["sha256", "size"], "blob");
          if (!isSha(o.sha256) || !isNat(o.size)) throw new SyncError("invalid", "blob");
          return o.sha256 as string;
        });
      } catch (e) {
        return err(e instanceof SyncError && e.code === "limit" ? 413 : 400, e instanceof SyncError ? e.code : "invalid");
      }
      return json({ missing: blobs.filter((s) => !a.blobs.has(s)) });
    }
    const g = p.match(/^\/api\/sync\/v1\/blob\/([0-9a-f]{64})$/);
    if (g && m === "PUT") {
      if (a.state !== "active") return err(409, a.state === "deleting" ? "deleting" : "readonly");
      // (admitted for this generation: rechecked after the body's await, so a PUT paused across a deletion and a
      // re-enable can't land in the next generation, CORR-173-3)
      const gen = a.generation;
      const len = Number(req.headers.get("content-length"));
      if (!Number.isSafeInteger(len) || len < 0) return err(411, "length required");
      if (len > MAX_PUT) return err(413, "limit", { limit: "put_bytes", max: MAX_PUT });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length !== len) return err(400, "invalid", { message: "the body isn't its Content-Length" });
      if ((await sha256Hex(bytes)) !== g[1]) return err(400, "invalid", { message: "the bytes don't have this sha256" });
      if (a.state !== "active" || a.generation !== gen) return err(409, "conflict", { reason: "generation", message: "this account's sync changed while the bytes came" });
      a.blobs.set(g[1], bytes);
      return json({ sha256: g[1], size: bytes.length });
    }
    if (g && m === "GET") {
      if (!a.blobs.has(g[1])) return err(404, "missing");
      return new Response(null, { status: 303, headers: { location: new URL(`/__files/${g[1]}?exp=${this.now() + 5 * 60_000}`, url).toString(), "cache-control": "no-store" } });
    }
    return err(404, "not found");
  }

  /** The account socket (GET /api/sync/v1/account, upgraded): a socket, or the refusal a page would get instead. */
  async connect(cookie: string | null): Promise<RefSocket | { status: number; code: string }> {
    const who = this.sessionOf(cookie);
    if (!who) return { status: 401, code: "sign in first" };
    if (!(this.opts.allow?.(who.account) ?? true)) return { status: 403, code: "forbidden" };
    const a = await this.accountOf(who.account);
    const s = new RefSocket(this, a, who.token);
    a.sockets.add(s);
    return s;
  }

  // ---- the account socket's messages (design/sync-server.md §5.2)

  /** One message from a page, answered on its socket. */
  async message(ws: RefSocket, raw: string): Promise<void> {
    let req: unknown;
    try {
      const m = parseMessage(raw);
      req = m.req;
      // (the session on every message: ended or expired, the socket is told and closed, nothing is done: CORR-173-5)
      const sess = this.sessions.get(ws.session);
      if (!sess || sess.expires <= this.now()) { ws.deliver({ t: "revoked" }); return ws.close(4401, "session ended"); }
      if (ws.inflight >= LIMITS.inflight) throw new SyncError("busy", "too many requests unanswered");
      ws.inflight++;
      try {
        await this.handle(ws, m);
      } finally {
        ws.inflight--;
      }
    } catch (e) {
      if (e instanceof SyncError && e.code === "limit" && e.detail?.limit === "message_bytes") return ws.close(1009, "message too large");
      const r = e instanceof SyncError ? { code: e.code, detail: { message: e.message, ...e.detail } } : { code: "busy", detail: { message: "try again" } };
      if (!(e instanceof SyncError)) console.warn("reference server:", e);
      ws.deliver({ t: "error", ...(isNat(req) ? { req } : {}), ...r });
    }
  }

  /** An answer, unless a test asked to drop or fake the next one of this kind. */
  private answer(ws: RefSocket, t: string, req: number, v: Json) {
    const f = this.fakes.get(t)?.shift();
    if (f && "drop" in f) return;
    if (f && "error" in f) return ws.deliver({ t: "error", req, code: f.error.code, detail: { message: "faked", ...f.error.detail } });
    ws.deliver(v);
  }

  private async handle(ws: RefSocket, m: Json) {
    const a = ws.account, t = m.t;
    if (t === "hello") return this.hello(ws, fields(m, ["t", "v", "device", "name", "index_after", "docs", "account", "generation"], "hello"));
    if (!ws.device) throw new SyncError("invalid", "say hello first");
    const req = m.req;
    if (!isNat(req)) throw new SyncError("invalid", "req");
    this.admit(a);
    if (t === "ops") {
      fields(m, ["t", "req", "ops"], "ops");
      const before = a.ops.length ? a.ops[a.ops.length - 1].seq : 0;
      const out = this.ops(a, ws.device, m.ops);
      this.answer(ws, "ops", req, { t: "ack", req, ops: out });
      const head = a.ops.length ? a.ops[a.ops.length - 1].seq : 0;
      if (head > before) for (const s of a.sockets) if (s !== ws && s.device) s.deliver({ t: "index_changed", head });
    } else if (t === "pull_index") {
      fields(m, ["t", "req", "after"], "pull_index");
      if (!isNat(m.after)) throw new SyncError("invalid", "after");
      this.answer(ws, "pull_index", req, { t: "index", req, ...this.index(a, m.after) });
    } else if (t === "doc_claim") {
      const c = attemptDoc(() => checkDocClaim(m));
      this.owner(a, c.owner);
      this.answer(ws, "doc_claim", req, { t: "ack", req, claim: this.claim(a, `session:${ws.device}`, c.doc, c.epoch, c.client) });
    } else if (t === "doc_fence") {
      const f = attemptDoc(() => checkDocFence(m));
      this.owner(a, f.owner);
      this.answer(ws, "doc_fence", req, { t: "ack", req, fence: { clients: this.fence(a, `session:${ws.device}`, f.doc, f.epoch, f.clients) } });
    } else if (t === "batch") {
      fields(m, ["t", "req", "owner", "doc", "epoch", "kind", "expect_head", "patches", "body", "fgen"], "batch");
      const b = checkBatch(m);
      this.owner(a, b.owner);
      const fgen = attemptDoc(() => checkFgen(m.fgen, new Set(b.patches.map((e) => clientOf(e.id)))));
      const out = await this.batch(a, ws.device, b, fgen);
      this.answer(ws, "batch", req, { t: "ack", req, batch: out });
      if (out.new > 0) this.changed(a, ws, b.doc, out.head, ws.device);
    } else if (t === "pull") {
      const o = fields(m, ["t", "req", "owner", "doc", "epoch", "after", "upto", "limit"], "pull");
      if (!isDocId(o.doc) || !isNat(o.epoch) || !isNat(o.after) || (has(o, "limit") && !isNat(o.limit))) throw new SyncError("invalid", "pull");
      this.owner(a, o.owner);
      const upto = attemptDoc(() => checkUpto(o, o.after as number));
      this.answer(ws, "pull", req, { t: "batches", req, owner: a.hash, doc: o.doc, ...this.pull(a, o.doc, o.epoch, o.after, upto, o.limit as number | undefined) });
    } else if (t === "clear") {
      fields(m, ["t", "req", "owner", "doc", "expect_head", "root", "fgen"], "clear");
      if (!isDocId(m.doc)) throw new SyncError("invalid", "clear: doc");
      this.owner(a, m.owner);
      const head = checkHead(m.expect_head, "clear: expect_head");
      const root = checkBatch({ ...fields(m.root, ["patches", "body"], "clear: root"), doc: m.doc, epoch: head.epoch });
      const fgen = attemptDoc(() => checkFgen(m.fgen, new Set(root.patches.map((e) => clientOf(e.id)))));
      const out = this.clear(a, ws.device, m.doc, head, root, fgen);
      this.answer(ws, "clear", req, { t: "ack", req, batch: out });
      this.changed(a, ws, m.doc, out.head, ws.device);
    } else if (t === "ticket") {
      throw new SyncError("invalid", "document sockets aren't in the reference server yet (stage 2c-5)");
    } else throw new SyncError("invalid", "unknown message");
  }

  /** An account that takes writes and reads: active, not being deleted. */
  private admit(a: Account) {
    if (a.state === "deleting") throw new SyncError("deleting", "this account's synced data is being deleted");
    if (a.state !== "active") throw new SyncError("readonly", "sync is off for this account");
  }
  /** A document message's owner, if it names one, is this account (phase 1: one's own documents). */
  private owner(a: Account, owner: unknown) {
    if (owner !== undefined && owner !== a.hash) throw new SyncError("unknown_doc", "another account's document");
  }

  private hello(ws: RefSocket, m: Json) {
    const a = ws.account;
    if (m.v !== VERSION) throw new SyncError("invalid", `protocol version ${VERSION} only`);
    if (!isDevice(m.device)) throw new SyncError("invalid", "device");
    if (typeof m.name !== "string" || m.name.length > 100) throw new SyncError("invalid", "name");
    if (!isNat(m.index_after)) throw new SyncError("invalid", "index_after");
    if (has(m, "docs") && (!Array.isArray(m.docs) || m.docs.length > LIMITS.helloDocs)) throw new SyncError("limit", "hello: too many docs", { limit: "hello_docs", max: LIMITS.helloDocs });
    this.admit(a);
    const b = bindingRefusal(a, m.account ?? null, m.generation ?? null);
    if (b) throw new SyncError(b.code === "forbidden" ? "forbidden" : "conflict", "the client's binding isn't this account's", { reason: b.reason });
    const docs = ((m.docs as unknown[] | undefined) ?? []).map((x) => {
      const o = fields(x, ["owner", "doc", "after"], "hello doc");
      if (!isHash(o.owner) || !isDocId(o.doc) || !isNat(o.after)) throw new SyncError("invalid", "hello: docs");
      return { owner: o.owner as string, doc: o.doc as string, after: o.after as number };
    });
    if (!a.devices.has(m.device)) a.devices.set(m.device, { next_dseq: 1, answers: new Map(), refused: 0 });
    ws.device = m.device;
    const head = a.ops.length ? a.ops[a.ops.length - 1].seq : 0;
    ws.deliver({ t: "welcome", v: VERSION, state: a.state, generation: a.generation, index_head: head, next_dseq: a.devices.get(m.device)!.next_dseq, server_time: this.now() });
    ws.deliver({ t: "index", ...this.index(a, m.index_after) });
    // (the documents the page names whose head is past its cursor: told as `changed`, as another device's batch would be)
    for (const d of docs) {
      const doc = d.owner === a.hash ? a.docs.get(d.doc) : undefined;
      if (doc && doc.head > d.after) ws.deliver({ t: "changed", owner: a.hash, doc: d.doc, head: { epoch: doc.epoch, seq: doc.head }, by_device: "" });
    }
  }

  /** A device's ops, decided in dseq order with no gaps, once each (§5.2). */
  private ops(a: Account, device: string, list: unknown): ({ dseq: number; seq: number } | { dseq: number; code: string })[] {
    if (!Array.isArray(list) || list.length === 0) throw new SyncError("invalid", "ops");
    if (list.length > LIMITS.opsPerMessage) throw new SyncError("limit", "too many ops", { limit: "ops_per_message", max: LIMITS.opsPerMessage });
    const dev = a.devices.get(device)!;
    // (decided whole, as one transaction: a gap refuses the message and changes nothing)
    let next = dev.next_dseq;
    const out: ({ dseq: number; seq: number } | { dseq: number; code: string })[] = [];
    const added: IndexOp[] = [], answers = new Map<number, { seq: number } | { code: string }>();
    let refused = dev.refused, seq = a.ops.length ? a.ops[a.ops.length - 1].seq : 0;
    for (const raw of list) {
      const dseq = (raw as { dseq?: unknown })?.dseq;
      if (!isNat(dseq) || dseq < 1) throw new SyncError("invalid", "op: dseq");
      if (dseq < next) {
        const r = dev.answers.get(dseq) ?? answers.get(dseq);
        out.push(r && "seq" in r ? { dseq, seq: r.seq } : { dseq, code: r?.code ?? "invalid" });
        continue;
      }
      if (dseq > next) throw new SyncError("order", "a gap in this device's ops", { next_dseq: next });
      try {
        const op: Op = checkOp(raw);
        if (PERSON_ONLY.has(op.op) && op.by !== "person") throw new SyncError("forbidden", "only a person may " + op.op);
        if (op.kind === "file" && op.sha256 !== undefined && !a.blobs.has(op.sha256)) throw new SyncError("missing", "upload the file's bytes before the op");
        const row: IndexOp = { seq: ++seq, device, ...op };
        added.push(row);
        answers.set(dseq, { seq: row.seq });
        out.push({ dseq, seq: row.seq });
      } catch (e) {
        if (!(e instanceof SyncError)) throw e;
        if (refused >= LIMITS.refusalsPerDevice) throw new SyncError("invalid", "too many refused ops: rebuild from the server's log");
        refused++;
        answers.set(dseq, { code: e.code });
        out.push({ dseq, code: e.code });
      }
      next++;
    }
    a.ops.push(...added);
    for (const [k, v] of answers) dev.answers.set(k, v);
    dev.next_dseq = next;
    dev.refused = refused;
    return out;
  }

  /** The log after `after`, a page at a time (§5.2, §8). */
  private index(a: Account, after: number): { ops: IndexOp[]; more: boolean } {
    const rows = a.ops.filter((o) => o.seq > after);
    const ops: IndexOp[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, LIMITS.indexPage)) {
      // (UTF-8 bytes, as the protocol's limits are: a path's characters can be 3 bytes each)
      const n = enc.encode(JSON.stringify(r)).length;
      if (ops.length > 0 && bytes + n > LIMITS.indexPageBytes) return { ops, more: true };
      bytes += n;
      ops.push(r);
    }
    return { ops, more: rows.length > LIMITS.indexPage };
  }

  // ---- documents (design/sync-server.md §4; plan-sync-slice2-r9.md §5.1, §5.5, §5.8)

  private docOf(a: Account, doc: string, make: boolean): Doc | undefined {
    let d = a.docs.get(doc);
    if (!d && make) {
      d = { doc, epoch: 1, seq: 0, head: 0, batches: [], clients: new Map(), ranges: new Map(), recvLast: 0, recvFloor: 0, chain: chainSeed(a.hash, doc, 1) };
      a.docs.set(doc, d);
    }
    return d;
  }
  private headOf(d: Doc): Head & { chain: string } {
    return { epoch: d.epoch, seq: d.head, chain: hex(d.chain) };
  }

  /** The epoch a claim or fence names must be the document's (a document not made yet is in epoch 1): else
   * stale_epoch, with the current epoch and head, and nothing changes (plan-sync-slice2-2b-r4 §2.4). */
  private sameEpoch(a: Account, doc: string, epoch: number) {
    const d = this.docOf(a, doc, false), cur = d?.epoch ?? 1;
    if (epoch !== cur) throw new SyncError("stale_epoch", "this claim or fence is for another epoch of the document", { epoch: cur, head: { epoch: cur, seq: d?.head ?? 0 } });
  }

  /** doc_claim (§5.8): binds a client to its writer before any batch of it; idempotent for the same writer. */
  private claim(a: Account, writer: string, doc: string, epoch: number, client: string): { client: string; fgen: number; next_cseq: number } {
    this.sameEpoch(a, doc, epoch);
    const d = this.docOf(a, doc, true)!;
    const c = d.clients.get(client);
    if (c) {
      if (c.writer !== writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
      return { client, fgen: c.fgen, next_cseq: c.next_cseq };
    }
    const unused = [...d.clients.values()].filter((x) => x.writer === writer && x.next_cseq === 1).length;
    if (unused >= UNUSED_CLAIMS) throw new SyncError("limit", "too many unused claims: use one you hold", { limit: "unused_claims", max: UNUSED_CLAIMS });
    d.clients.set(client, { writer, next_cseq: 1, last_id: "", fgen: 0, claimed_at: this.now() });
    return { client, fgen: 0, next_cseq: 1 };
  }

  /** doc_fence (§5.8): each client's fgen raised to its target, answered with its final next_cseq; terminal. */
  private fence(a: Account, writer: string, doc: string, epoch: number, list: { client: string; target: number }[]) {
    this.sameEpoch(a, doc, epoch);
    const d = this.docOf(a, doc, false);
    // (all checked before any changes: a foreign writer refuses the whole message)
    for (const { client } of list) {
      const c = d?.clients.get(client);
      if (c && c.writer !== writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
    }
    return list.map(({ client, target }) => {
      const c = d?.clients.get(client);
      if (!c) return { client, absent: true };
      c.fgen = Math.max(c.fgen, target);
      return { client, fgen: c.fgen, next_cseq: c.next_cseq };
    });
  }

  /** A batch (§4.1–4.4, r9 §5.1, §5.8): decided, then stored with its recv and chain, or refused whole. */
  private async batch(a: Account, device: string, b: Batch, fgen: Map<string, number>) {
    const writer = `session:${device}`;
    const d = this.docOf(a, b.doc, false);
    if (!d) throw new SyncError("unknown_client", "claim the client first", { client: clientOf(b.patches[0].id) });
    if (b.epoch !== d.epoch) throw new SyncError("epoch", "this document's history was cleared", { epoch: d.epoch, head: { epoch: d.epoch, seq: d.head } });
    if (b.kind && d.kind && b.kind !== d.kind) throw new SyncError("invalid", "this document is another kind");
    // (the forward, held by a test between its checks and its commit: then decided again, as the real object decides in one transaction)
    this.select(a, d, writer, b, fgen);
    const hold = this.holds.get(`${b.doc}:${clientOf(b.patches[0].id)}`) ?? this.holds.get(`${b.doc}:*`);
    if (hold) {
      this.holds.delete(`${b.doc}:${clientOf(b.patches[0].id)}`);
      this.holds.delete(`${b.doc}:*`);
      await hold.wait;
      // (after the await: the same account generation and the same document, or nothing commits: CORR-173-3's audit)
      this.admit(a);
      if (a.docs.get(b.doc) !== d) throw new SyncError("conflict", "this account's sync changed while the batch waited", { reason: "generation" });
      if (b.epoch !== d.epoch) throw new SyncError("epoch", "this document's history was cleared", { epoch: d.epoch, head: { epoch: d.epoch, seq: d.head } });
    }
    const sel = this.select(a, d, writer, b, fgen);
    if (sel.fresh.length === 0) return { new: 0, resent: sel.resent, head: this.headOf(d) };
    if (b.expect_head && (b.expect_head.epoch !== d.epoch || b.expect_head.seq !== d.head)) throw new SyncError("conflict", "the document moved on", { head: this.headOf(d) });
    if (b.kind && !d.kind) d.kind = b.kind;
    const seq = this.store(d, a, device, writer, sel.fresh, b.body);
    return { seq, new: sel.fresh.length, resent: sel.resent, head: this.headOf(d) };
  }

  /**
   * Which patches are new and which are resends (§4.2), against the stored
   * clients: claimed (unknown_client), bound to this writer (forbidden), in
   * order (order), a resend exactly the patch stored (conflict), and the new
   * ones under the client's current fgen (fenced; a resend under an older one
   * is still answered with its original seq), their blobs held (missing).
   * Changes nothing.
   */
  private select(a: Account, d: Doc, writer: string, b: Batch, fgen: Map<string, number>) {
    const seen = new Map<string, { next: number; last?: Env; fresh: number; lastId: string }>();
    const accepted = new Set<string>(), resent: Record<string, number> = {};
    const fresh: { env: Env; start: number }[] = [];
    let offset = 0;
    for (const env of b.patches) {
      const start = offset;
      offset += env.size;
      const client = clientOf(env.id);
      const row = d.clients.get(client);
      if (!row) throw new SyncError("unknown_client", "claim the client first", { client });
      if (row.writer !== writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
      let c = seen.get(client);
      if (!c) seen.set(client, (c = { next: row.next_cseq, fresh: 0, lastId: row.last_id }));
      if (c.last && (env.cseq !== c.last.cseq + 1 || !(env.id > c.last.id))) throw new SyncError("order", "a client's patches go in order: consecutive cseq, increasing ids", { client, next_cseq: c.next });
      c.last = env;
      if (env.cseq < c.next) {
        const r = (d.ranges.get(client) ?? []).find((x) => x.first_cseq <= env.cseq && env.cseq <= x.last_cseq);
        if (!r || r.ids[env.cseq - r.first_cseq] !== env.id) throw new SyncError("conflict", "this cseq was accepted for another patch", { client, cseq: env.cseq });
        resent[env.id] = r.seq;
        accepted.add(env.id);
        continue;
      }
      const expected = c.next + c.fresh;
      if (env.cseq !== expected) throw new SyncError("order", "a gap in this client's patches", { client, next_cseq: expected });
      if (c.fresh === 0 && !(env.id > c.lastId)) throw new SyncError("order", "a client's ids only increase", { client, next_cseq: expected });
      for (const p of env.parents) if (!accepted.has(p) && !this.known(d, p)) throw new SyncError("order", "a parent isn't accepted yet", { parent: p });
      const g = fgen.get(client)!;
      if (g < row.fgen) throw new SyncError("fenced", "this client was fenced: send under its new fgen", { client, fgen: row.fgen, next_cseq: row.next_cseq });
      if (g > row.fgen) throw new SyncError("invalid", "an fgen the server never gave", { client, fgen: row.fgen });
      // (every blob a new patch names is held before it can be stored, §4.3: CORR-173-2)
      for (const sha of env.blobs ?? []) if (!a.blobs.has(sha)) throw new SyncError("missing", "upload the patch's blob first", { sha256: sha });
      accepted.add(env.id);
      c.fresh++;
      fresh.push({ env, start });
    }
    return { fresh, resent };
  }

  /** Whether patch `id` was accepted in this epoch, exactly (§4.2). */
  private known(d: Doc, id: string): boolean {
    return (d.ranges.get(clientOf(id)) ?? []).some((r) => r.ids.includes(id));
  }

  /** The new patches stored as one batch: their payloads sliced by size, recv and chain computed (r9 §5.1). */
  private store(d: Doc, a: Account, device: string, writer: string, fresh: { env: Env; start: number }[], src: Uint8Array): number {
    const body = new Uint8Array(fresh.reduce((n, f) => n + f.env.size, 0));
    let at = 0;
    for (const f of fresh) {
      body.set(src.subarray(f.start, f.start + f.env.size), at);
      at += f.env.size;
    }
    const envs = fresh.map((f) => f.env), envsText = JSON.stringify(envs);
    const seq = ++d.seq;
    const recv = Math.max(this.now(), d.recvLast, d.recvFloor);
    const author = "person";
    d.chain = chainNext(d.chain, { seq, recv, epoch: d.epoch, author, writer, hb: batchHash(envsText, body) });
    d.batches.push({ seq, epoch: d.epoch, author, writer, device, recv, envs: envsText, body, chain: hex(d.chain) });
    d.head = seq;
    d.recvLast = recv;
    const groups = new Map<string, Env[]>();
    for (const e of envs) groups.set(clientOf(e.id), [...(groups.get(clientOf(e.id)) ?? []), e]);
    for (const [client, es] of groups) {
      d.ranges.set(client, [...(d.ranges.get(client) ?? []), { first_cseq: es[0].cseq, last_cseq: es[es.length - 1].cseq, first_id: es[0].id, last_id: es[es.length - 1].id, seq, ids: es.map((e) => e.id) }]);
      const c = d.clients.get(client)!;
      c.next_cseq = es[es.length - 1].cseq + 1;
      c.last_id = es[es.length - 1].id;
    }
    return seq;
  }

  /** Batches after `after` in `epoch`, up to `upto` (r9 §5.5), bounded in items and bytes; never a snapshot here. */
  private pull(a: Account, doc: string, epoch: number, after: number, upto: number | undefined, limit?: number) {
    const d = this.docOf(a, doc, false);
    if (!d) throw new SyncError("unknown_doc", "no such document");
    if (epoch !== d.epoch) throw new SyncError("epoch", "this document's history was cleared", { epoch: d.epoch, head: { epoch: d.epoch, seq: d.head } });
    if (upto !== undefined && upto > d.head) throw new SyncError("invalid", "pull: upto is from `after` to the head", { head: { epoch: d.epoch, seq: d.head } });
    const n = Math.min(Math.max(1, limit ?? LIMITS.pullDefault), LIMITS.pullMax);
    const rows = d.batches.filter((b) => b.seq > after && (upto === undefined || b.seq <= upto));
    const items: Json[] = [];
    let bytes = 0, more = rows.length > n;
    for (const r of rows.slice(0, n)) {
      const cost = Math.ceil(r.body.length / 3) * 4 + r.envs.length + 200;
      if (items.length > 0 && bytes + cost > LIMITS.pullBytes) {
        more = true;
        break;
      }
      bytes += cost;
      items.push({ seq: r.seq, author: r.author, writer: r.writer, device: r.device, recv: r.recv, chain: r.chain, patches: JSON.parse(r.envs), body: toB64(r.body) });
    }
    return { epoch: d.epoch, head: this.headOf(d), items, more };
  }

  /**
   * Clear history (§4.6; plan-sync-slice2-2b-r4 §2.4): the head must be
   * `expect_head`; the clearing client is claimed in the current epoch, under
   * its current fgen; the root is one parentless patch, that client's next.
   * The epoch rises, the old epoch's rows go, the root client's new-epoch row
   * is made (the only row made without a claim), and the root is stored as an
   * ordinary batch.  A resend of the same clear answers the same result.
   */
  private clear(a: Account, device: string, doc: string, expect: Head, root: Batch, fgen: Map<string, number>) {
    const writer = `session:${device}`;
    const d = this.docOf(a, doc, false);
    if (!d) throw new SyncError("unknown_doc", "no such document");
    if (root.patches.length !== 1 || root.patches[0].parents.length !== 0) throw new SyncError("invalid", "the root is one patch, with no parents");
    const env = root.patches[0], client = clientOf(env.id);
    // (a resend after a lost answer: the root is already this epoch's first batch.  It must be that root exactly, its
    // id, cseq, shape and writer, or it's refused and nothing changes (CORR-173-1); its fgen isn't asked again, as an
    // accepted patch's resend isn't)
    if (expect.epoch === d.epoch - 1) {
      const first = d.batches[0], stored = first ? (JSON.parse(first.envs) as Env[])[0] : undefined;
      if (first && stored && stored.id === env.id) {
        if (first.writer !== writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
        if (stored.cseq !== env.cseq || J(stored.parents) !== J(env.parents) || stored.size !== env.size) throw new SyncError("conflict", "this root was stored with another cseq or shape", { client, cseq: stored.cseq });
        return { seq: first.seq, new: 0, resent: { [env.id]: first.seq }, head: this.headOf(d) };
      }
    }
    if (expect.epoch !== d.epoch || expect.seq !== d.head) throw new SyncError("conflict", "the document moved on", { head: this.headOf(d) });
    const c = d.clients.get(client);
    if (!c) throw new SyncError("unknown_client", "claim the client first", { client });
    if (c.writer !== writer) throw new SyncError("forbidden", "this patchflow client belongs to another writer");
    if (fgen.get(client)! < c.fgen) throw new SyncError("fenced", "this client was fenced: send under its new fgen", { client, fgen: c.fgen, next_cseq: c.next_cseq });
    if (fgen.get(client)! > c.fgen) throw new SyncError("invalid", "an fgen the server never gave", { client, fgen: c.fgen });
    if (env.cseq !== c.next_cseq || !(env.id > c.last_id)) throw new SyncError("order", "the root is its client's next patch", { client, next_cseq: c.next_cseq });
    for (const sha of env.blobs ?? []) if (!a.blobs.has(sha)) throw new SyncError("missing", "upload the root's blob first", { sha256: sha });
    d.epoch++;
    d.batches = [];
    d.ranges = new Map();
    d.clients = new Map([[client, { writer, next_cseq: env.cseq, last_id: c.last_id, fgen: c.fgen, claimed_at: c.claimed_at }]]);
    d.chain = chainSeed(a.hash, doc, d.epoch);
    d.head = 0;
    const seq = this.store(d, a, device, writer, [{ env, start: 0 }], root.body);
    return { seq, new: 1, resent: {}, head: this.headOf(d) };
  }

  /** Every other socket of the account hears that a document's head moved (§5.3 step 3). */
  private changed(a: Account, from: RefSocket, doc: string, head: Head, device: string) {
    for (const s of a.sockets) if (s !== from && s.device) s.deliver({ t: "changed", owner: a.hash, doc, head, by_device: device });
  }
}

/** The client's binding (§5.2): the account hash and generation, each if given, must be this account's. */
function bindingRefusal(a: Account, account: unknown, generation: unknown): { status: number; code: string; reason: string } | null {
  if (account !== null && account !== undefined && account !== a.hash) return { status: 403, code: "forbidden", reason: "account" };
  if (generation !== null && generation !== undefined && Number(generation) !== a.generation) return { status: 409, code: "conflict", reason: "generation" };
  return null;
}

/** doc-protocol.ts's refusals as the server's: the same code and detail. */
function attemptDoc<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    const x = e as { code?: string; message?: string; detail?: Json };
    if (x?.code === "invalid" || x?.code === "limit") throw new SyncError(x.code, x.message ?? "invalid", x.detail);
    throw e;
  }
}
