// The local gateway: this computer's side of "Your computer (paired)" after the pairing (local kernel phase 3a; the
// frozen cases: /scratch/sagebrush-reviews/remote-compute/local-kernel-p3a-cases-v3).  The page's RemoteClient
// speaks the compute gateway's HTTP API; its requests come here as frames on the paired socket (src/notebook-pair.ts),
// each authenticated as the gateway authenticates them (DPoP, RFC 9449, bound to this socket's token and the page's
// key), and run on one binding: the session Worker of `sagebrush notebook` (src/notebook-session.ts), one notebook.
//
// Frames (plan delta r3 D2/D3, r3.1):
//   page -> here   {id:"t<n>", rpc, ref, auth, dpop, accept, body?}   a request (the table below), and {cancel:"t<n>"}
//   here -> page   {id, status, headers, body}                       an answer
//                  {id, chunk} ... {id, end: true}                    a run's events (g.events), after a 200 head
//                  {id, streamError: "slow"}                          a stream ended for want of room (r3.1 R3-1)
//                  {id, retired: true}                                the last frame for a cancelled id
//
// Bounds, all finite and stated where they are kept: 8 open ids; one run (or wave) and one completion admitted at a
// time, their payloads charged as logical bytes (queuedPayloadBytes <= BODY_MAX.run + BODY_MAX.other); 10,000
// records per binding (tombstones counted), each at most 512 encoded bytes; events per run 10,000 or 4 MiB, 64 MiB
// per binding; 4096 jtis per socket for 120 s; answers at most RESPONSE_MAX; output through the socket's gate.
//
// The fence: after every await in a request's path, before any effect, the request's conn must still be open and
// the binding generation it saw at decode unchanged (a restart, a takeover or the 2 s fallback advances it);
// otherwise it has no effect (409 stale if its conn is open; nothing sent if not).  "Still the paired conn" and "the
// same binding" are not separate checks: in this code they change only together with the conn's `closed` (see
// fenceInvariant), which the fence asserts, failing closed.
import { createHash, createPublicKey, webcrypto } from "crypto";
import { Worker } from "worker_threads";
import type { Conn, PairServer } from "./notebook-pair";
import { waveEnvelopeInvalid, newWaveState, waveDecide, waveRecord, waveRunResult, waveStop } from "./wave-policy";
import { requestCtrlC } from "./runtime/interrupt";
import { sessionLimits } from "./limits";

const MiB = 1024 * 1024;
/** The client's request body caps (web/notebook/remote-client.js BODY_MAX), by rpc. */
export const BODY_MAX = Object.freeze({ run: 2.25 * MiB, other: 64 * 1024 });
export const RESPONSE_MAX = MiB;
export const GATEWAY_LIMITS = Object.freeze({
  openIds: 8, // requests not yet answered plus subscriptions not ended, per socket
  frameIdDigits: 15,
  runs: 10_000, // admission records per binding, tombstones included
  recordBytes: 512, // one record, encoded
  summary: 256, // a record's terminal summary, encoded
  eventsPerRun: 10_000,
  runEventBytes: 4 * MiB,
  bindingEventBytes: 64 * MiB,
  jtis: 4096, // the replay store, per socket
  jtiMs: 120_000,
  jtiMin: 22,
  jtiMax: 64,
  iatPast: 60, // seconds
  iatFuture: 5,
  nonceMs: 5 * 60_000,
  proofMax: 4096,
  segmentMax: 1024, // a proof's decoded header or claims
  cellCode: MiB, // one cell's code in a wave (the client's per-cell limit)
  fallbackMs: 2_000, // a Stop the Worker doesn't honour: then it is terminated and restarted
  idleMs: 10 * 60_000, // the Worker with no paired page
});
export const SYNTHETIC_BASE = "https://local.sagebrush.invalid/api/compute/v1";
const ID_RE = /^[A-Za-z0-9._~-]{1,64}$/;
const JTI_CHARSET = /^[A-Za-z0-9_-]*$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const B64URL43 = /^[A-Za-z0-9_-]{43}$/;

// ---- the dispatch table (plan r2 §3; cases v3 §2): method, the path rebuilt from ref, the ref's members
type Rpc = "g.bind" | "g.run" | "g.record" | "g.events" | "g.interrupt" | "g.restart" | "g.takeover" | "g.complete";
const TABLE: Record<Rpc, { method: "GET" | "POST"; ref: string[]; path: (r: any) => string }> = {
  "g.bind": { method: "POST", ref: [], path: () => "/bindings" },
  "g.run": { method: "POST", ref: ["b"], path: (r) => `/bindings/${r.b}/runs` },
  "g.record": { method: "GET", ref: ["b", "r"], path: (r) => `/bindings/${r.b}/runs/${r.r}` },
  "g.events": { method: "GET", ref: ["b", "r", "after"], path: (r) => `/bindings/${r.b}/runs/${r.r}/events` },
  "g.interrupt": { method: "POST", ref: ["b"], path: (r) => `/bindings/${r.b}/interrupt` },
  "g.restart": { method: "POST", ref: ["b"], path: (r) => `/bindings/${r.b}/restart` },
  "g.takeover": { method: "POST", ref: ["b"], path: (r) => `/bindings/${r.b}/takeover` },
  "g.complete": { method: "POST", ref: ["b"], path: (r) => `/bindings/${r.b}/complete` },
};
const FRAME_KEYS = new Set(["id", "rpc", "ref", "auth", "dpop", "accept", "body"]);

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const enc = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
/** An integer JSON number in [0, 2^53 - 1]: four checks, each its own (cases v3 §1). */
function numberProblem(v: unknown): string | null {
  if (typeof v !== "number") return "type";
  if (!Number.isInteger(v)) return "int";
  if (v < 0) return "sign";
  if (v > Number.MAX_SAFE_INTEGER) return "range";
  return null;
}

// ---- the session Worker, behind a port (tests inject a scripted one that speaks the same messages)

/** One Worker: post the session protocol's messages, interrupt runs up to an id, terminate. */
export interface WorkerHandle {
  post(m: any): void;
  interrupt(upTo: number): void;
  terminate(): void;
}
/** Starts Workers: each reports its messages and its exit (code, or the error) through the callbacks. */
export interface SessionPort {
  start(onMessage: (m: any) => void, onExit: (why: string) => void): WorkerHandle;
}

/** The production port: the Worker `sagebrush notebook` runs (src/notebook.ts notebookWorker), in `dir`.  (`entry` is
 * the CLI's own, as notebook.ts resolves it; tests pass dist/src/cli.js, and `observe` to see each Worker's events.
 * The CLI passes neither: cases v3 L41w.) */
export function workerPort(dir: string, entry: string = require.main?.filename ?? process.argv[1], observe?: (w: Worker) => void): SessionPort {
  return {
    start(onMessage, onExit) {
      const worker = new Worker(entry, { workerData: { sagebrushNotebook: { dir }, sagebrushLimits: sessionLimits() }, stdout: false, stderr: false });
      observe?.(worker);
      let intr: Int32Array | null = null;
      let gone = false;
      worker.on("message", (m: any) => {
        if (m?.$intr) { intr = new Int32Array(m.$intr); delete m.$intr; }
        onMessage(m);
      });
      const exit = (why: string) => { if (!gone) { gone = true; onExit(why); } };
      worker.on("error", (e: any) => exit(`error: ${String(e?.message ?? e).slice(0, 200)}`));
      worker.on("exit", (code) => exit(`exit ${code}`));
      return {
        post: (m) => worker.postMessage(m),
        interrupt: (upTo) => { if (intr) { Atomics.store(intr, 1, upTo); requestCtrlC(intr); } },
        terminate: () => { gone = true; void worker.terminate(); },
      };
    },
  };
}

// ---- records, runs and the binding

type Outcome = Record<string, unknown> & { status: string };
type Owner = "gateway" | "worker" | "wave" | null;
interface Run {
  request: string;
  digest: string;
  wave: any | null; // (a wave's envelope: its entries' code deleted as each is handed to the Worker)
  payload: any | null; // (a single run's payload until dispatch; null after)
  events: any[]; // retained: {seq, ...}, oldest first
  eventBytes: number;
  firstSeq: number; // the seq of events[0] (events before it were dropped)
  nextSeq: number;
  outcome: Outcome | null;
  tomb: boolean;
  listeners: Set<(e: any) => void>;
  charge: number; // logical payload bytes charged for it, released at its end or cleanup
  owner: Owner;
  workerId: number; // the session id it runs under (a wave: its current entry's)
  ends: any[] | null; // a wave's entries' ends
  current: number; // a wave's running entry, or -1
  stopLatched: boolean;
  stop: number | null;
  recordBytes: number;
}
interface Binding {
  id: string;
  conn: Conn;
  epoch: number;
  incarnation: number;
  gen: number; // advanced by a restart, a takeover and the fallback (the fence's)
  runs: Map<string, Run>; // every admission record, tombstones included (never evicted)
  order: Run[]; // in admission order (event retention drops the oldest ended runs' events first)
  busy: Run | null;
  eventBytes: number;
  applied: { op_id: string; kind: string; epoch: number }[]; // (restarts applied, for a takeover's evidence; at most 64)
  appliedTruncated: boolean;
}

/** A request in flight on a socket. */
interface Req {
  id: string;
  n: number;
  rpc: Rpc;
  ref: any;
  conn: Conn;
  auth: string;
  dpop: string;
  accept: string;
  raw: string | null; // the raw body text, held only within the synchronous decode step
  body: any; // the parsed body (null for a GET)
  bytes: number;
  digest: string | null;
  slot: "run" | "complete" | null; // the slot this request reserved (and charged)
  busy: boolean; // its slot was taken: answered 409 busy after authentication
  gen: number; // the binding generation at decode
  binding: string | null; // the binding id at decode
  cancelled: boolean;
  answered: boolean;
  sub: { run: Run; listener: (e: any) => void } | null;
}

/** Per-socket request state: open ids, the last frame id, the replay store. */
interface SocketState {
  last: number; // the greatest frame id seen
  open: Map<string, Req>;
  jtis: Map<string, number>; // jti -> when seen
}

export type GatewayOptions = {
  port?: SessionPort; // (tests: a scripted Worker)
  dir?: string; // the notebook's directory (the production port's)
  authHold?: (id: string) => Promise<void>; // (tests: hold one request at its await; none in production)
};

export class LocalGateway {
  readonly server: PairServer;
  readonly port: SessionPort;
  readonly authHold: ((id: string) => Promise<void>) | null;
  binding: Binding | null = null;
  worker: WorkerHandle | null = null;
  workerGen = 0; // the current Worker's generation (L43: any other's messages are dropped)
  nextBinding = 1;
  nextWorkerId = 1; // the session protocol's run ids, increasing
  runSlot: Req | Run | null = null; // one g.run: reserved by a request, then held by its run until its end
  completeSlot: Req | null = null; // one g.complete, until its answer
  completeWaiter: { workerId: number; done: (r: any) => void } | null = null;
  workerRuns = new Map<number, (m: any) => void>(); // session id -> its run's message handler
  fallbackTimer: any = null;
  idleTimer: any = null;
  nonce: string;
  nonceAt: number;
  sockets = new WeakMap<Conn, SocketState>();
  stats = {
    queuedPayloadBytes: 0, maxQueuedPayloadBytes: 0, rawBodyRefs: 0, recordBytes: 0, staleOutputs: 0,
    invariantFailures: 0, keyImports: 0, workersStarted: 0, fallbacks: 0, executions: 0,
    fenced: { closed: 0, stale: 0 }, // requests the fence refused, by guard (G-open, G-gen)
    authRefusals: {} as Record<string, number>,
  };

  constructor(server: PairServer, opts: GatewayOptions = {}) {
    this.server = server;
    this.port = opts.port ?? workerPort(opts.dir ?? process.cwd());
    this.authHold = opts.authHold ?? null;
    this.nonce = b64url(webcrypto.getRandomValues(new Uint8Array(16)));
    this.nonceAt = server.timers.now();
  }

  // ---- the frame side (called by PairServer.message for a paired conn)

  private state(c: Conn): SocketState {
    let s = this.sockets.get(c);
    if (!s) { s = { last: 0, open: new Map(), jtis: new Map() }; this.sockets.set(c, s); }
    return s;
  }

  /** A notification {cancel: id}: the retirement handshake's start (r3.1 R3-1). */
  cancel(c: Conn, id: unknown) {
    const s = this.state(c);
    const n = typeof id === "string" && /^t[1-9]\d{0,14}$/.test(id) ? Number(id.slice(1)) : NaN;
    if (!(n <= s.last)) return c.close(1002, "a cancel for an id never sent");
    const req = s.open.get(id as string);
    if (!req) return this.sendControl(c, { id, retired: true }); // (answered already: retired at once)
    req.cancelled = true;
    if (req.sub) { // (a subscription: stopped; nothing of it is queued here, so retired now)
      req.sub.run.listeners.delete(req.sub.listener);
      req.sub = null;
      s.open.delete(req.id);
      return this.sendControl(c, { id, retired: true });
    }
    // (a request: its one answer still comes, then retired, as its last frame)
  }

  /** A request frame: checked and decoded synchronously (its payload slot reserved), then authenticated. */
  frame(c: Conn, msg: any) {
    const s = this.state(c);
    // the frame id (cases v3 §1): the prefix, leading zeros, the length; then above every id before it
    const id = msg.id;
    if (typeof id !== "string" || !/^t\d+$/.test(id)) return c.close(1002, "a frame id is t and digits");
    if (/^t0/.test(id)) return c.close(1002, "a frame id has no leading zero");
    if (id.length - 1 > GATEWAY_LIMITS.frameIdDigits) return c.close(1002, "a frame id is at most 15 digits");
    const n = Number(id.slice(1));
    if (s.open.has(id) || n === s.last) return c.close(1002, "a frame id reused");
    if (n < s.last) return c.close(1002, "a frame id not above the last");
    s.last = n;
    for (const k of Object.keys(msg)) if (!FRAME_KEYS.has(k)) return c.close(1002, "an unknown frame member");
    const rpc = msg.rpc as Rpc;
    const row = TABLE[rpc];
    if (typeof rpc !== "string" || !Object.prototype.hasOwnProperty.call(TABLE, rpc)) return c.close(1002, "an unknown rpc");
    const ref = msg.ref;
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return c.close(1002, "a ref is an object");
    for (const k of Object.keys(ref)) if (!row.ref.includes(k)) return c.close(1002, "a ref member the rpc doesn't take");
    for (const k of row.ref) {
      if (!(k in ref)) return c.close(1002, "a ref member missing");
      if (k === "after") {
        const p = numberProblem(ref.after);
        if (p) return c.close(1002, `after: ${p}`);
      } else if (typeof ref[k] !== "string" || !ID_RE.test(ref[k])) return c.close(1002, "a ref member not an id");
    }
    if (typeof msg.auth !== "string" || typeof msg.dpop !== "string" || typeof msg.accept !== "string") return c.close(1002, "a request's headers");
    const hasBody = row.method === "POST";
    if (hasBody ? typeof msg.body !== "string" : msg.body !== undefined) return c.close(1002, "a request's body");
    if (s.open.size >= GATEWAY_LIMITS.openIds) return c.close(1002, "too many open requests");
    const req: Req = {
      id, n, rpc, ref, conn: c, auth: msg.auth, dpop: msg.dpop, accept: msg.accept, raw: null, body: null, bytes: 0,
      digest: null, slot: null, busy: false, gen: this.binding?.gen ?? 0, binding: this.binding?.id ?? null,
      cancelled: false, answered: false, sub: null,
    };
    if (hasBody) {
      // (the synchronous step, before any await: the length, the digest, the parse; then the raw text dropped)
      req.raw = msg.body;
      this.stats.rawBodyRefs++;
      req.bytes = Buffer.byteLength(req.raw!, "utf8");
      if (req.bytes > (rpc === "g.run" ? BODY_MAX.run : BODY_MAX.other)) { this.dropRaw(req, msg); return c.close(1002, "a body over its limit"); }
      try { req.body = JSON.parse(req.raw!); } catch { req.body = undefined; }
      if (rpc === "g.run" && req.body && typeof req.body === "object") req.digest = sha256hex(JSON.stringify(req.body.payload ?? null));
      this.dropRaw(req, msg);
      this.reserve(req);
    }
    s.open.set(id, req);
    void this.handle(req);
  }

  private dropRaw(req: Req, msg: any) {
    req.raw = null;
    delete msg.body;
    this.stats.rawBodyRefs--;
  }

  /** The payload slots, reserved synchronously (cases v3 §3): a request whose slot is taken is busy, uncharged. */
  private reserve(req: Req) {
    const b = this.binding;
    if (req.rpc === "g.run") {
      const request = req.body?.request;
      if (b && typeof request === "string" && b.runs.has(request)) return; // (answered from its record: no charge)
      if (this.runSlot) { req.busy = true; req.body = null; return; }
      this.runSlot = req;
      req.slot = "run";
      this.charge(req.bytes);
    } else if (req.rpc === "g.complete") {
      if (this.completeSlot) { req.busy = true; req.body = null; return; }
      this.completeSlot = req;
      req.slot = "complete";
      this.charge(req.bytes);
    }
  }
  private charge(n: number) {
    this.stats.queuedPayloadBytes += n;
    this.stats.maxQueuedPayloadBytes = Math.max(this.stats.maxQueuedPayloadBytes, this.stats.queuedPayloadBytes);
  }
  /** A request's reservation released (refused, fenced, or answered without a run). */
  private unreserve(req: Req) {
    if (req.slot === "run" && this.runSlot === req) { this.runSlot = null; this.stats.queuedPayloadBytes -= req.bytes; }
    else if (req.slot === "complete" && this.completeSlot === req) { this.completeSlot = null; this.stats.queuedPayloadBytes -= req.bytes; }
    req.slot = null;
    req.body = null;
  }

  /** The fence (cases v3 §4.7): may this request still have an effect?  "closed": no, and nothing is sent. */
  private fence(req: Req): "ok" | "stale" | "closed" {
    const c = req.conn;
    // (the invariant, for an open conn only: !c.closed => it is the paired conn and owns the binding; it fails closed)
    if (!c.closed && !this.fenceInvariant(c)) { this.stats.invariantFailures++; return "closed"; }
    if (c.closed) { this.stats.fenced.closed++; return "closed"; }
    const b = this.binding;
    if ((b?.gen ?? 0) !== req.gen || (b?.id ?? null) !== req.binding) { this.stats.fenced.stale++; return "stale"; }
    return "ok";
  }
  /** An open conn is the paired one, and owns the binding if there is one (L26 refuses a second bind; pairedConn
   * is cleared only in dropped(), after closed is set, on every stop path of notebook-pair.ts). */
  private fenceInvariant(c: Conn) {
    return this.server.pairedConn === c && (!this.binding || this.binding.conn === c);
  }

  private async handle(req: Req) {
    let refusal: { status: number; error: string; headers?: Record<string, string> } | null;
    try {
      if (this.authHold) await this.authHold(req.id);
      refusal = await this.verify(req);
    } catch {
      refusal = { status: 401, error: "invalid_dpop_proof" };
    }
    const f = this.fence(req);
    if (f === "closed") { this.unreserve(req); this.forget(req); return; }
    if (refusal) { this.unreserve(req); return this.answer(req, refusal.status, { error: refusal.error }, refusal.headers); }
    if (f === "stale") { this.unreserve(req); return this.answer(req, 409, { error: "stale" }); }
    if (req.busy) return this.answer(req, 409, { error: "busy" });
    this.dispatch(req);
  }
  private forget(req: Req) {
    this.sockets.get(req.conn)?.open.delete(req.id);
  }

  // ---- authentication (plan delta r3 D2; the order of cases v3 §2: cheap checks before any crypto or key import)

  private refused(reason: string, error = "invalid_dpop_proof") {
    this.stats.authRefusals[reason] = (this.stats.authRefusals[reason] ?? 0) + 1;
    return { status: 401, error };
  }

  private async verify(req: Req): Promise<{ status: number; error: string; headers?: Record<string, string> } | null> {
    const c = req.conn;
    if (!(req.auth.startsWith("DPoP ") && c.token !== null && req.auth.slice(5) === c.token)) return this.refused("token", "invalid_token");
    const proof = req.dpop;
    // 1. sizes
    if (proof.length > GATEWAY_LIMITS.proofMax) return this.refused("proof-size");
    const parts = proof.split(".");
    // 2. parseJwt: three base64url segments, the first two JSON objects (one parse step)
    if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return this.refused("parse");
    const hb = Buffer.from(parts[0], "base64url"), cb = Buffer.from(parts[1], "base64url"), sig = Buffer.from(parts[2], "base64url");
    if (hb.length > GATEWAY_LIMITS.segmentMax || cb.length > GATEWAY_LIMITS.segmentMax) return this.refused("segment-size");
    let header: any, claims: any;
    try {
      header = JSON.parse(hb.toString("utf8"));
      claims = JSON.parse(cb.toString("utf8"));
    } catch { return this.refused("parse"); }
    if (!header || typeof header !== "object" || Array.isArray(header) || !claims || typeof claims !== "object" || Array.isArray(claims)) return this.refused("parse");
    if (sig.length !== 64) return this.refused("sig-length");
    // 3. the header
    if (header.typ === undefined) return this.refused("typ-missing");
    if (header.typ !== "dpop+jwt") return this.refused("typ");
    if (header.alg !== "ES256") return this.refused("alg");
    const jwk = header.jwk;
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return this.refused("jwk-members");
    if ("d" in jwk) return this.refused("jwk-private");
    if (Object.keys(jwk).some((k) => k !== "kty" && k !== "crv" && k !== "x" && k !== "y" && k !== "d")) return this.refused("jwk-extra");
    if (!("kty" in jwk && "crv" in jwk && "x" in jwk && "y" in jwk)) return this.refused("jwk-members");
    if (jwk.kty !== "EC") return this.refused("kty");
    if (jwk.crv !== "P-256") return this.refused("crv");
    if (!(typeof jwk.x === "string" && typeof jwk.y === "string" && B64URL43.test(jwk.x) && B64URL43.test(jwk.y) &&
      Buffer.from(jwk.x, "base64url").length === 32 && Buffer.from(jwk.y, "base64url").length === 32)) return this.refused("coords");
    // 4. the claims, by type, no coercion
    if (!Number.isSafeInteger(claims.iat)) return this.refused("iat-type");
    if (typeof claims.jti !== "string") return this.refused("jti-type");
    if (!JTI_CHARSET.test(claims.jti)) return this.refused("jti-charset");
    if (claims.jti.length < GATEWAY_LIMITS.jtiMin) return this.refused("jti-min");
    if (claims.jti.length > GATEWAY_LIMITS.jtiMax) return this.refused("jti-max");
    if (typeof claims.htm !== "string" || typeof claims.htu !== "string" || typeof claims.ath !== "string") return this.refused("claim-types");
    if (claims.nonce !== undefined && typeof claims.nonce !== "string") return this.refused("claim-types");
    // 5. the key: on the curve (the import checks it), its thumbprint this socket's
    let key: any;
    try {
      this.stats.keyImports++;
      key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    } catch { return this.refused("curve"); }
    const thumb = b64url(createHash("sha256").update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y })).digest());
    if (thumb !== c.jkt) return this.refused("thumbprint");
    // 6. the signature (WebCrypto: an await, as the gateway's verify is)
    const pub = await webcrypto.subtle.importKey("jwk", key.export({ format: "jwk" }), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, Buffer.from(`${parts[0]}.${parts[1]}`));
    if (!ok) return this.refused("signature");
    // 7. the claims' values: htm, htu (rebuilt here, never the page's), ath, the iat window, the jti, the nonce
    const row = TABLE[req.rpc];
    if (claims.htm !== row.method) return this.refused("htm");
    if (claims.htu !== SYNTHETIC_BASE + row.path(req.ref)) return this.refused("htu");
    if (claims.ath !== b64url(createHash("sha256").update(c.token!).digest())) return this.refused("ath");
    const now = Math.floor(this.server.timers.now() / 1000);
    if (claims.iat < now - GATEWAY_LIMITS.iatPast) return this.refused("iat-past");
    if (claims.iat > now + GATEWAY_LIMITS.iatFuture) return this.refused("iat-future");
    const s = this.state(c);
    const t = this.server.timers.now();
    for (const [j, at] of s.jtis) if (t - at > GATEWAY_LIMITS.jtiMs) s.jtis.delete(j);
    if (s.jtis.has(claims.jti)) return this.refused("jti-reused");
    this.rotateNonce();
    if (claims.nonce !== this.nonce) {
      this.stats.authRefusals["nonce"] = (this.stats.authRefusals["nonce"] ?? 0) + 1;
      return { status: 401, error: "use_dpop_nonce", headers: { "www-authenticate": 'DPoP error="use_dpop_nonce"' } };
    }
    if (s.jtis.size >= GATEWAY_LIMITS.jtis) {
      this.stats.authRefusals["jti-store"] = (this.stats.authRefusals["jti-store"] ?? 0) + 1;
      return { status: 503, error: "limit", headers: { "retry-after": "1" } };
    }
    s.jtis.set(claims.jti, t);
    return null;
  }

  /** The DPoP nonce a page is given at pairing (the one its first proof must carry). */
  currentNonce() {
    this.rotateNonce();
    return this.nonce;
  }
  private rotateNonce() {
    const t = this.server.timers.now();
    if (t - this.nonceAt >= GATEWAY_LIMITS.nonceMs) {
      this.nonce = b64url(webcrypto.getRandomValues(new Uint8Array(16)));
      this.nonceAt = t;
    }
  }

  // ---- answers and output

  /** An answer: its JSON body at most RESPONSE_MAX (else 502 answer-too-large), through the gate as data. */
  private answer(req: Req, status: number, data: unknown, headers: Record<string, string> = {}) {
    const c = req.conn;
    const s = this.sockets.get(c);
    s?.open.delete(req.id);
    req.answered = true;
    if (c.closed) return;
    this.rotateNonce();
    let body = JSON.stringify(data);
    if (Buffer.byteLength(body, "utf8") > RESPONSE_MAX) { status = 502; body = JSON.stringify({ error: "answer-too-large" }); }
    const frame = { id: req.id, status, headers: { "content-type": "application/json", "dpop-nonce": this.nonce, "content-length": String(Buffer.byteLength(body, "utf8")), ...headers }, body };
    c.sendText(frameText(frame), "data");
    if (req.cancelled && !c.closed) this.sendControl(c, { id: req.id, retired: true });
  }
  private sendControl(c: Conn, obj: unknown) {
    if (!c.closed) c.sendText(frameText(obj), "control");
  }

  // ---- the gateway's routes, after authentication and the fence

  private dispatch(req: Req) {
    const b = this.binding;
    const body = req.body;
    if (req.rpc === "g.bind") {
      if (b) return this.answer(req, 409, { error: "in-use" });
      return this.bind(req);
    }
    if (!b || req.ref.b !== b.id) { this.unreserve(req); return this.answer(req, b ? 410 : 404, { error: b ? "binding-gone" : "not-found" }); }
    if (req.rpc === "g.record" || req.rpc === "g.events") {
      const run = b.runs.get(req.ref.r);
      if (!run) return this.answer(req, 404, { error: "not-found" });
      if (req.rpc === "g.record") return this.answer(req, 200, this.recordView(run));
      return this.subscribe(req, run, req.ref.after);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) { this.unreserve(req); return this.answer(req, 400, { error: "malformed" }); }
    if (req.rpc === "g.takeover") return this.takeover(req, b, body);
    if (body.epoch !== b.epoch) { this.unreserve(req); return this.answer(req, 409, { error: "epoch" }); }
    if (req.rpc === "g.run") return this.postRun(req, b, body);
    if (req.rpc === "g.interrupt") return this.interrupt(req, b);
    if (req.rpc === "g.restart") return this.restart(req, b, body);
    return this.complete(req, body);
  }

  private bind(req: Req) {
    const id = `b${this.nextBinding++}`;
    this.binding = { id, conn: req.conn, epoch: 1, incarnation: 1, gen: 1, runs: new Map(), order: [], busy: null, eventBytes: 0, applied: [], appliedTruncated: false };
    this.stats.recordBytes = 0;
    this.ensureWorker();
    this.answer(req, 200, { binding: id, epoch: 1, incarnation: 1, state: "ready" });
  }

  private recordView(run: Run) {
    return { request: run.request, state: run.outcome ? "done" : "running", ...(run.outcome ? { outcome: run.outcome } : {}), ...(run.wave ? { entries: run.ends, stop: run.stop } : {}) };
  }

  private postRun(req: Req, b: Binding, body: any) {
    const request = body.request;
    if (typeof request !== "string" || !ID_RE.test(request)) { this.unreserve(req); return this.answer(req, 400, { error: "malformed" }); }
    const had = b.runs.get(request);
    if (had) {
      this.unreserve(req);
      if (had.digest !== req.digest) return this.answer(req, 409, { error: "conflict" });
      return this.answer(req, 202, { request, state: had.outcome ? "done" : "running" });
    }
    if (b.runs.size >= GATEWAY_LIMITS.runs) { this.unreserve(req); return this.answer(req, 429, { error: "limit", reason: "runs" }); }
    const isWave = body.kind === "wave";
    if (isWave) {
      const bad = waveEnvelopeInvalid(body.payload) ?? this.cellCodeTooLarge(body.payload);
      if (bad) { this.unreserve(req); return this.answer(req, 400, { error: "malformed", detail: bad }); }
    } else if (!body.payload || typeof body.payload !== "object" || typeof body.payload.code !== "string") {
      this.unreserve(req);
      return this.answer(req, 400, { error: "malformed" });
    }
    const run: Run = {
      request, digest: req.digest!, wave: isWave ? body.payload : null, payload: isWave ? null : body.payload, events: [], eventBytes: 0,
      firstSeq: 1, nextSeq: 1, outcome: null, tomb: false, listeners: new Set(), charge: req.bytes, owner: isWave ? "wave" : "gateway",
      workerId: 0, ends: isWave ? body.payload.entries.map(() => null) : null, current: -1, stopLatched: false, stop: null, recordBytes: 0,
    };
    // (the request's reservation becomes the run's: the same slot, the same charge)
    this.runSlot = run;
    req.slot = null;
    req.body = null;
    run.recordBytes = this.recordSize(run);
    this.stats.recordBytes += run.recordBytes;
    b.runs.set(request, run);
    b.order.push(run);
    b.busy = run;
    this.answer(req, 202, { request, state: "admitted" });
    if (isWave) this.runWave(b, run);
    else this.runSingle(b, run);
  }

  /** A wave's entry with code over the client's per-cell limit (waveEnvelopeInvalid checks shapes, not sizes). */
  private cellCodeTooLarge(w: any): string | null {
    for (const e of w.entries) if (typeof e.code === "string" && Buffer.byteLength(e.code, "utf8") > GATEWAY_LIMITS.cellCode) return "an entry's code over its size limit";
    return null;
  }

  /** A record's encoded size: {request, digest, terminal summary, tomb?}. */
  private recordSize(run: Run) {
    return enc({ request: run.request, digest: run.digest, terminal: run.outcome ? summary(run.outcome) : null, ...(run.tomb ? { tomb: true } : {}) });
  }

  // ---- the Worker

  private ensureWorker() {
    if (this.worker) return;
    const gen = ++this.workerGen;
    this.stats.workersStarted++;
    this.worker = this.port.start((m) => this.fromWorker(gen, m), (why) => this.workerGone(gen, why));
  }
  private fromWorker(gen: number, m: any) {
    if (gen !== this.workerGen) { this.stats.staleOutputs++; return; }
    if (!m || typeof m !== "object" || typeof m.id !== "number") return;
    if (this.completeWaiter && m.id === this.completeWaiter.workerId && (m.matches !== undefined || m.interrupted || m.error !== undefined)) {
      const w = this.completeWaiter;
      this.completeWaiter = null;
      return w.done(m);
    }
    this.workerRuns.get(m.id)?.(m);
  }
  private workerGone(gen: number, why: string) {
    if (gen !== this.workerGen) return;
    this.worker = null;
    this.endAllRuns({ status: "stopped", reason: "kernel exited", detail: why.slice(0, 120) });
  }

  /** Every running run ended (the Worker gone, restarted, or this binding fenced): its charge released. */
  private endAllRuns(outcome: Outcome) {
    const b = this.binding;
    this.workerRuns.clear();
    if (this.completeWaiter) { const w = this.completeWaiter; this.completeWaiter = null; w.done(null); }
    if (b?.busy) this.terminal(b, b.busy, outcome);
    if (this.fallbackTimer) { this.server.timers.clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
  }

  /** One run's code to the Worker; its messages become the run's events; resolves to its outcome. */
  private execute(run: Run, code: string, p: any, onEvent: (ev: any) => void): Promise<Outcome | null> {
    const w = this.worker;
    if (!w) return Promise.resolve({ status: "stopped", reason: "kernel exited" });
    const id = this.nextWorkerId++;
    run.workerId = id;
    const mode = typeof p.mode === "string" ? p.mode : "python";
    const msg: any = { id, code, ...(mode === "sage" ? { sage: true } : mode === "magma" ? { magma: true } : mode === "matlab" ? { matlab: true } : {}) };
    if (Array.isArray(p.forget) && p.forget.length) msg.forget = [...p.forget];
    if (typeof p.mangle === "string") msg.mangle = p.mangle;
    if (typeof p.seed === "string") msg.seed = p.seed;
    if (p.scoped && typeof p.scoped === "object") msg.scoped = { ...p.scoped };
    return new Promise((resolve) => {
      this.workerRuns.set(id, (m) => {
        if (m.start) return onEvent({ type: "start" });
        if (typeof m.stream === "string") return onEvent({ type: "stream", name: m.stream === "stderr" ? "stderr" : "stdout", text: String(m.text ?? "") });
        if (m.display) return onEvent({ type: "display", data: m.display });
        if (m.clear) return onEvent({ type: "clear" });
        if (m.interact) return onEvent({ type: "stream", name: "stderr", text: "(interactive controls aren't shown from a remote kernel yet)\n" });
        if (m.skipped) { this.workerRuns.delete(id); return resolve({ status: "refused", reason: "cancelled" }); }
        if (m.done) { this.workerRuns.delete(id); return resolve(m.error ? { status: "error", ms: Number(m.ms) || 0 } : { status: "ok", ms: Number(m.ms) || 0 }); }
      });
      this.stats.executions++;
      w.post(msg);
    });
  }

  private async runSingle(b: Binding, run: Run) {
    const p = run.payload;
    run.payload = null; // (handed to the Worker: the gateway keeps no reference)
    run.owner = "worker";
    this.emit(b, run, { type: "start" });
    const outcome = await this.execute(run, p.code, p, (ev) => { if (ev.type !== "start") this.emit(b, run, ev); });
    if (outcome && !run.outcome) this.terminal(b, run, outcome);
  }

  private async runWave(b: Binding, run: Run) {
    const w = run.wave;
    if (w.forget.length) await this.execute(run, "", { mode: w.mode, forget: w.forget }, () => {});
    const st = newWaveState();
    const cancelled: string[] = [];
    for (let k = 0; k < w.entries.length; k++) {
      if (run.outcome) return;
      if (run.stopLatched && !st.stopped) { waveStop(st); run.stop = k; this.emit(b, run, { type: "stop", before: k }); }
      const e = w.entries[k];
      const d = waveDecide(w.policy, st, k, e);
      if (d.kind !== "run") {
        waveRecord(st, k, e, d);
        if (d.kind === "cancelled") cancelled.push(...(e.defs ?? []));
        this.entryEnd(b, run, k, d);
        continue;
      }
      const code = e.code;
      e.code = undefined; // (the destructive handoff: the gateway keeps no dispatched code)
      this.emit(b, run, { type: "start", entry: k });
      run.current = k;
      const outcome = await this.execute(run, code, e, (ev) => { if (ev.type !== "start" && !run.ends![k]) this.emit(b, run, { ...ev, entry: k }); });
      run.current = -1;
      if (!outcome || run.outcome) return;
      waveRecord(st, k, e, d, waveRunResult(outcome));
      this.entryEnd(b, run, k, d, outcome);
    }
    if (run.outcome) return;
    if (cancelled.length) await this.execute(run, "", { mode: w.mode, forget: cancelled }, () => {});
    this.terminal(b, run, { status: "done" });
  }
  private entryEnd(b: Binding, run: Run, k: number, decision: any, outcome?: Outcome) {
    if (run.ends![k]) return;
    run.ends![k] = { decision, ...(outcome ? { outcome } : {}) };
    this.emit(b, run, { type: "end", entry: k, decision, ...(outcome ? { outcome } : {}) });
  }

  /** A run's terminal: once; its charge released; the binding free for the next run. */
  private terminal(b: Binding, run: Run, outcome: Outcome) {
    if (run.outcome) return;
    run.outcome = outcome;
    this.emit(b, run, { type: "terminal", outcome });
    if (b.busy === run) b.busy = null;
    if (this.runSlot === run) { this.runSlot = null; this.stats.queuedPayloadBytes -= run.charge; }
    run.charge = 0;
    run.owner = null;
    run.payload = null;
    if (run.wave) for (const e of run.wave.entries) e.code = undefined;
    this.workerRuns.delete(run.workerId);
    if (this.fallbackTimer) { this.server.timers.clearTimeout(this.fallbackTimer); this.fallbackTimer = null; }
    const before = run.recordBytes;
    run.recordBytes = this.recordSize(run);
    this.stats.recordBytes += run.recordBytes - before;
  }

  // ---- events: retained per run and per binding, streamed to subscriptions

  private emit(b: Binding, run: Run, ev: any) {
    const e = { seq: run.nextSeq++, ...ev };
    const bytes = enc(e);
    run.events.push(e);
    run.eventBytes += bytes;
    b.eventBytes += bytes;
    // per run: the oldest events go past 10,000 or 4 MiB
    while (run.events.length > GATEWAY_LIMITS.eventsPerRun || run.eventBytes > GATEWAY_LIMITS.runEventBytes) this.dropOldest(b, run);
    // per binding: past 64 MiB, the oldest ended runs' events first (never their records)
    for (const r of b.order) {
      if (b.eventBytes <= GATEWAY_LIMITS.bindingEventBytes) break;
      if (!r.outcome || r === run) continue;
      while (r.events.length && b.eventBytes > GATEWAY_LIMITS.bindingEventBytes) this.dropOldest(b, r);
    }
    for (const f of [...run.listeners]) f(e);
  }
  private dropOldest(b: Binding, run: Run) {
    const e = run.events.shift();
    const n = enc(e);
    run.eventBytes -= n;
    b.eventBytes -= n;
    run.firstSeq = e.seq + 1;
  }

  private subscribe(req: Req, run: Run, after: number) {
    const c = req.conn;
    // (a cursor below the retained window: 410; the page then takes the outcome from the record)
    if (after + 1 < run.firstSeq && !(after === 0 && run.firstSeq === 1)) return this.answer(req, 410, { error: "expired-cursor" });
    const s = this.state(c);
    s.open.set(req.id, req);
    c.sendText(frameText({ id: req.id, status: 200, headers: { "content-type": "text/event-stream", "dpop-nonce": this.nonce } }), "data");
    if (c.closed) return;
    const done = () => { run.listeners.delete(listener); req.sub = null; s.open.delete(req.id); };
    const listener = (e: any) => {
      if (c.closed) return done();
      if (e.seq <= after) return;
      const chunk = frameText({ id: req.id, chunk: `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n` });
      if (!c.fits(Buffer.byteLength(chunk, "utf8"), "data")) { done(); return this.sendControl(c, { id: req.id, streamError: "slow" }); }
      c.sendText(chunk, "data");
      if (e.type === "terminal") { done(); this.sendControl(c, { id: req.id, end: true }); }
    };
    req.sub = { run, listener };
    for (const e of [...run.events]) { listener(e); if (!req.sub) return; }
    run.listeners.add(listener);
  }

  // ---- interrupt, restart, takeover, complete

  private interrupt(req: Req, b: Binding) {
    const run = b.busy;
    if (run?.wave) {
      if (run.current >= 0) this.stopWorker(b, run);
      else if (!run.outcome) run.stopLatched = true;
    } else if (run && run.owner === "worker" && !run.outcome) this.stopWorker(b, run);
    this.answer(req, 200, { ok: true });
  }
  /** A Stop: the Worker interrupted; if the run hasn't ended in fallbackMs, the Worker is terminated and restarted. */
  private stopWorker(b: Binding, run: Run) {
    this.worker?.interrupt(run.workerId);
    if (this.fallbackTimer) return;
    this.fallbackTimer = this.server.timers.setTimeout(() => {
      this.fallbackTimer = null;
      if (run.outcome) return;
      this.stats.fallbacks++;
      this.replaceWorker(b, { status: "stopped", reason: "fallback" });
    }, GATEWAY_LIMITS.fallbackMs);
  }
  /** The Worker terminated and a new one started: a new generation; every running run ended with `outcome`. */
  private replaceWorker(b: Binding, outcome: Outcome) {
    const w = this.worker;
    this.worker = null;
    this.workerGen++; // (the old Worker's late messages are dropped from now on)
    w?.terminate();
    this.endAllRuns(outcome);
    b.gen++;
    b.incarnation++;
    for (const r of b.runs.values()) this.tombstone(b, r);
    this.ensureWorker();
  }
  private tombstone(b: Binding, r: Run) {
    if (!r.outcome || r.tomb) return;
    r.tomb = true;
    b.eventBytes -= r.eventBytes;
    r.events = [];
    r.eventBytes = 0;
    r.firstSeq = r.nextSeq;
    const before = r.recordBytes;
    r.recordBytes = this.recordSize(r);
    this.stats.recordBytes += r.recordBytes - before;
  }

  private restart(req: Req, b: Binding, body: any) {
    this.replaceWorker(b, { status: "stopped", reason: "kernel restarted" });
    if (typeof body.op_id === "string") {
      b.applied.push({ op_id: body.op_id.slice(0, 64), kind: "restart", epoch: b.epoch });
      if (b.applied.length > 64) { b.applied.shift(); b.appliedTruncated = true; }
    }
    this.answer(req, 200, { outcome: { status: "done", incarnation: b.incarnation } });
  }

  private takeover(req: Req, b: Binding, body: any) {
    const from = Number.isSafeInteger(body.from_epoch) ? body.from_epoch : null;
    const fence = typeof body.fence === "string" && body.fence ? body.fence : null;
    b.epoch++;
    b.gen++;
    const evidence = from !== null ? b.applied.filter((a) => a.epoch >= from) : b.applied.splice(0);
    this.answer(req, 200, {
      epoch: b.epoch, state: "ready", incarnation: b.incarnation, applied_before_takeover: evidence.map(({ op_id, kind }) => ({ op_id, kind })), in_flight: [],
      // (one page per pairing: its own continuity, unless evidence older than the kept history was asked for)
      ...(from !== null && fence ? { continuity: { from_epoch: from, sole: !(b.appliedTruncated && from < b.epoch - 1) } } : {}),
    });
  }

  private complete(req: Req, body: any) {
    const w = this.worker;
    const code = typeof body.code === "string" ? body.code : "";
    if (!w) { this.unreserve(req); return this.answer(req, 503, { error: "unavailable" }); }
    const id = this.nextWorkerId++;
    const mode = typeof body.mode === "string" ? body.mode : "python";
    const gen = this.workerGen;
    this.completeWaiter = {
      workerId: id,
      done: (m) => {
        this.unreserve(req);
        if (this.fence(req) !== "ok" || gen !== this.workerGen) return this.answer(req, 409, { error: "stale" });
        if (!m || m.interrupted || m.error) return this.answer(req, 200, { matches: [], prefix: "" });
        this.answer(req, 200, { matches: Array.isArray(m.matches) ? m.matches : [], prefix: typeof m.prefix === "string" ? m.prefix : "" });
      },
    };
    w.post({ id, complete: code, ...(mode === "sage" ? { sage: true } : mode === "magma" ? { magma: true } : mode === "matlab" ? { matlab: true } : {}) });
  }

  // ---- lifecycle

  /** The paired socket gone: its binding stays with the Worker, idle-limited (the plan's §5 table). */
  socketLost(c: Conn) {
    const s = this.sockets.get(c);
    if (s) {
      for (const req of s.open.values()) { req.sub?.run.listeners.delete(req.sub.listener); this.unreserve(req); }
      s.open.clear();
    }
    if (this.binding?.conn !== c) return;
    if (this.idleTimer) this.server.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.server.timers.setTimeout(() => { this.idleTimer = null; if (!this.server.pairedConn) this.shutdown(); }, GATEWAY_LIMITS.idleMs);
  }
  /** A page paired again (a reconnect within the Worker's life): the binding moves to its socket. */
  socketPaired(c: Conn) {
    if (this.idleTimer) { this.server.timers.clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.binding) this.binding.conn = c;
  }
  /** Unpair, "Forget this computer", or the server closing: the Worker terminated, the binding fenced. */
  shutdown() {
    if (this.idleTimer) { this.server.timers.clearTimeout(this.idleTimer); this.idleTimer = null; }
    const b = this.binding;
    const w = this.worker;
    this.worker = null;
    this.workerGen++;
    w?.terminate();
    this.endAllRuns({ status: "stopped", reason: "unpaired" });
    if (this.completeSlot) this.unreserve(this.completeSlot);
    if (this.runSlot && !("rpc" in this.runSlot)) { this.stats.queuedPayloadBytes -= (this.runSlot as Run).charge; (this.runSlot as Run).charge = 0; this.runSlot = null; }
    if (b) b.gen++;
    this.binding = null;
    this.stats.recordBytes = 0;
  }
}

/** A frame's text: compact JSON. */
function frameText(obj: unknown) {
  return JSON.stringify(obj);
}
/** An outcome's summary for its record: its JSON, at most GATEWAY_LIMITS.summary bytes as the record holds it (a
 * JSON string, its escapes counted: a detail of quotes would otherwise double past the record's 512), detail cut to
 * fit. */
function summary(o: Outcome): string {
  let s = JSON.stringify(o);
  if (enc(s) <= GATEWAY_LIMITS.summary) return s;
  const short: any = { status: o.status };
  for (const k of ["reason", "ename", "ms", "incarnation"]) if (o[k] !== undefined) short[k] = typeof o[k] === "string" ? String(o[k]).slice(0, 64) : o[k];
  s = JSON.stringify(short);
  return enc(s) <= GATEWAY_LIMITS.summary ? s : JSON.stringify({ status: String(o.status).slice(0, 32) });
}
