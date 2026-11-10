import test from "node:test";
import assert from "node:assert/strict";
import { slowSkip } from "./slow-tests";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { PairServer, PAIR_LIMITS } from "../src/notebook-pair";
import { GATEWAY_LIMITS, SYNTHETIC_BASE, BODY_MAX, RESPONSE_MAX, workerPort, type SessionPort, type WorkerHandle } from "../src/local-gateway";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

// The local gateway (src/local-gateway.ts), local kernel phase 3a: the frozen cases
// /scratch/sagebrush-reviews/remote-compute/local-kernel-p3a-cases-v3/cases.md (59dcf129, SUMS dde00911); each test's
// name starts with its case.  A stub socket is paired through phase 2's real hello; the page's requests are frames
// with real DPoP proofs (ES256, the page's own key); the Worker is a scripted port (the real Worker in the cases
// that say so), on an injected clock.

// ---- an injected clock
function clock() {
  let t = 1_800_000_000_000, n = 0, q: { at: number; f: () => void; id: number }[] = [];
  return {
    now: () => t,
    setTimeout(f: () => void, ms: number) { const id = ++n; q.push({ at: t + ms, f, id }); return id; },
    clearTimeout(id: any) { q = q.filter((x) => x.id !== id); },
    advance(ms: number) { t += ms; const due = q.filter((x) => x.at <= t); q = q.filter((x) => x.at > t); for (const d of due) d.f(); },
    pending: () => q.length,
  };
}
async function until(f: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
const MiB = 1024 * 1024;
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

// ---- frames by hand (a client's, masked; a server's, read back)
function masked(op: number, payload: Buffer, fin = true) {
  const n = payload.length;
  const len = n < 126 ? Buffer.from([0x80 | n]) : n < 65536 ? Buffer.from([0x80 | 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(9); b[0] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 1); return b; })();
  const key = randomBytes(4);
  const m = Buffer.from(payload);
  for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, key, m]);
}
const maskedText = (obj: unknown) => masked(0x1, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj)));
function serverFrame(b: Buffer) {
  let len = b[1] & 0x7f, at = 2;
  if (len === 126) { len = b.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(b.readBigUInt64BE(2)); at = 10; }
  return { op: b[0] & 0x0f, payload: b.subarray(at, at + len) };
}

// ---- a stub socket: every write recorded; writableLength set by the test; its "close" handlers callable
const allSocks: any[] = []; // (every case's sockets: L20's census over their frame logs)
function stubSock() {
  const on: Record<string, ((...a: any[]) => void)[]> = {};
  const st: any = {
    writableLength: 0, destroyed: false, ended: 0, writes: [] as Buffer[], on, cancels: new Set<string>(),
    write(b: Buffer) { st.writes.push(Buffer.from(b)); return true; },
    end() { st.ended++; },
    destroy() { st.destroyed = true; },
  };
  st.on = (ev: string, fn: (...a: any[]) => void) => { (on[ev] ??= []).push(fn); return st; };
  st.emit = (ev: string) => { for (const f of on[ev] ?? []) f(); };
  allSocks.push(st);
  return st;
}
/** The JSON text frames written to a stub socket, in order (the hello's result first). */
const texts = (st: any) => st.writes.map((w: Buffer) => serverFrame(w)).filter((f: any) => f.op === 0x1).map((f: any) => JSON.parse(f.payload.toString()));
const closeOf = (st: any) => { for (const w of st.writes) { const f = serverFrame(w); if (f.op === 0x8) return f.payload.readUInt16BE(0); } return null; };
/** The close frame's reason text (each 1002 names its own guard). */
const closeReason = (st: any) => { for (const w of st.writes) { const f = serverFrame(w); if (f.op === 0x8) return f.payload.subarray(2).toString(); } return null; };

// ---- the scripted Worker: what the gateway posts, and the messages the test makes it answer
type Scripted = SessionPort & { workers: any[]; posted: any[]; last(): any };
function scriptedPort(): Scripted {
  const port: any = { workers: [], posted: [] };
  port.start = (onMessage: (m: any) => void, onExit: (why: string) => void): WorkerHandle => {
    const w: any = { onMessage, onExit, posted: [], interrupts: [] as number[], terminated: false };
    port.workers.push(w);
    return {
      post: (m) => { w.posted.push(m); port.posted.push(m); },
      interrupt: (upTo) => w.interrupts.push(upTo),
      terminate: () => { w.terminated = true; },
    };
  };
  port.last = () => port.workers[port.workers.length - 1];
  return port;
}

// ---- the page: its key, the paired socket, and requests with DPoP proofs
type PageOpts = { gateway?: any; clk?: ReturnType<typeof clock> };
async function setup(o: PageOpts = {}) {
  const clk = o.clk ?? clock();
  const port = scriptedPort();
  const s = new PairServer({ timers: clk, err: () => {}, gateway: { port, ...(o.gateway ?? {}) } });
  const page = newPage(s, clk);
  return { s, clk, port, page };
}
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j: any = publicKey.export({ format: "jwk" });
  const jwk = { kty: "EC", crv: "P-256", x: j.x, y: j.y };
  const jkt = b64u(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
  return { jwk, jkt, privateKey };
}
/** (a code pairs once: the first page asks to be remembered, and every later socket pairs with that session) */
const sessions = new WeakMap<PairServer, string>();
function newPage(s: PairServer, clk: ReturnType<typeof clock>, key = keyPair()) {
  const st = stubSock();
  const c = s.attach(st);
  const sess = sessions.get(s);
  c.feed(maskedText({ jsonrpc: "2.0", id: "h1", method: "hello", params: { protocol: 1, purpose: "kernel", page: { origin: "https://sagebrush.space", path: "/" }, jwk: key.jwk, jkt: key.jkt, ...(sess ? { session: sess } : { code: s.code, remember: true }) } }));
  const r = texts(st)[0]?.result;
  assert.ok(r?.token, `paired: ${JSON.stringify(texts(st)[0])}`);
  if (r.session) sessions.set(s, r.session);
  let n = 0;
  const page = {
    st, c, key, token: r.token as string, nonce: r.nonce as string,
    nextId: () => `t${++n}`,
    /** A proof for (method, path), signed by `signer` (default the page's key), its claims overridable. */
    proof(method: string, path: string, over: { header?: any; claims?: any; signer?: any; raw?: string } = {}) {
      if (over.raw !== undefined) return over.raw;
      const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk, ...(over.header ?? {}) };
      const claims = { jti: b64u(randomBytes(24)), htm: method, htu: SYNTHETIC_BASE + path, iat: Math.floor(clk.now() / 1000), ath: b64u(createHash("sha256").update(page.token).digest()), nonce: page.nonce, ...(over.claims ?? {}) };
      for (const k of Object.keys(claims)) if ((claims as any)[k] === undefined) delete (claims as any)[k];
      for (const k of Object.keys(header)) if ((header as any)[k] === undefined) delete (header as any)[k];
      const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
      const sig = edSign("sha256", Buffer.from(input), { key: over.signer ?? key.privateKey, dsaEncoding: "ieee-p1363" });
      return `${input}.${b64u(sig)}`;
    },
    /** The page's {cancel: id} notification (recorded: L20). */
    cancel(id: string) { st.cancels.add(id); c.feed(maskedText({ cancel: id })); },
    /** One request frame's bytes, not sent (its id, and a real proof). */
    frameOf(rpc: string, ref: any, body?: unknown, over: { id?: string; auth?: string; dpop?: string; proof?: any; method?: string; path?: string } = {}) {
      const id = over.id ?? page.nextId();
      const row = ROUTES[rpc];
      const method = over.method ?? row.method;
      const path = over.path ?? row.path(ref);
      const frame: any = { id, rpc, ref, auth: over.auth ?? `DPoP ${page.token}`, dpop: over.dpop ?? page.proof(method, path, over.proof), accept: rpc === "g.events" ? "text/event-stream" : "application/json" };
      if (body !== undefined) frame.body = typeof body === "string" ? body : JSON.stringify(body);
      return { id, bytes: maskedText(frame) };
    },
    /** Send one request frame; resolves to its answer frame (the first frame for its id). */
    request(rpc: string, ref: any, body?: unknown, over: { id?: string; auth?: string; dpop?: string; proof?: any; method?: string; path?: string } = {}) {
      const f = page.frameOf(rpc, ref, body, over);
      const before = st.writes.length;
      c.feed(f.bytes);
      return { id: f.id, answer: () => waitFor(st, f.id, before) };
    },
  };
  return page;
}
const ROUTES: Record<string, { method: string; path: (r: any) => string }> = {
  "g.bind": { method: "POST", path: () => "/bindings" },
  "g.run": { method: "POST", path: (r) => `/bindings/${r.b}/runs` },
  "g.record": { method: "GET", path: (r) => `/bindings/${r.b}/runs/${r.r}` },
  "g.events": { method: "GET", path: (r) => `/bindings/${r.b}/runs/${r.r}/events` },
  "g.interrupt": { method: "POST", path: (r) => `/bindings/${r.b}/interrupt` },
  "g.restart": { method: "POST", path: (r) => `/bindings/${r.b}/restart` },
  "g.takeover": { method: "POST", path: (r) => `/bindings/${r.b}/takeover` },
  "g.complete": { method: "POST", path: (r) => `/bindings/${r.b}/complete` },
};
async function waitFor(st: any, id: string, from = 0) {
  let found: any = null;
  await until(() => { found = texts(st).slice(0).find((t: any) => t.id === id && t.status !== undefined) ?? null; return !!found || st.destroyed || closeOf(st) !== null; }, `the answer to ${id}`);
  return found;
}
const bodyOf = (a: any) => (a?.body ? JSON.parse(a.body) : null);
/** Every effect a refusal must not have (cases v3 §4), as a snapshot to compare: each SessionPort call (Worker
 * starts, posts, interrupts, terminations), the binding (identity, generation, epoch, incarnation, its records, their
 * order, the busy run, event bytes), both slots, executions and Worker starts, the payload charge, raw bodies and the
 * records' bytes.  (Taken before the request is sent: a POST's decode reserves its slot synchronously.) */
function effects(s: PairServer, port: Scripted) {
  const g = s.gateway, b = g.binding;
  return {
    starts: port.workers.length, posted: port.posted.length,
    interrupts: port.workers.reduce((n: number, w: any) => n + w.interrupts.length, 0),
    terminated: port.workers.filter((w: any) => w.terminated).length,
    binding: b ? { id: b.id, gen: b.gen, epoch: b.epoch, incarnation: b.incarnation, runs: b.runs.size, order: b.order.length, busy: b.busy?.request ?? null, eventBytes: b.eventBytes } : null,
    runSlot: g.runSlot ? ("rpc" in (g.runSlot as any) ? "request" : "run") : null, completeSlot: g.completeSlot !== null,
    executions: g.stats.executions, workersStarted: g.stats.workersStarted,
    bytes: g.stats.queuedPayloadBytes, raw: g.stats.rawBodyRefs, recordBytes: g.stats.recordBytes,
  };
}
/** The requests open on every paired or pairing socket (a refused request is answered: its id no longer open). */
const openRequests = (s: PairServer) => [...((s as any).conns as Set<any>)].reduce((n, c) => n + (s.gateway.sockets.get(c)?.open.size ?? 0), 0);
function zeroEffects(s: PairServer, port: Scripted, before: ReturnType<typeof effects>) {
  assert.deepEqual(effects(s, port), before, "zero effects");
  assert.equal(s.gateway.stats.rawBodyRefs, 0, "no raw body held");
}
/** The cleanup census every case ends with (cases v3 §4). */
function census(s: PairServer) {
  assert.equal(s.gateway.stats.queuedPayloadBytes, 0, "census: no payload charged");
  assert.equal(s.gateway.stats.rawBodyRefs, 0, "census: no raw body");
}
const refusalDelta = (s: PairServer, reason: string, f: () => Promise<void>) => async () => {
  const before = s.gateway.stats.authRefusals[reason] ?? 0;
  await f();
  assert.equal((s.gateway.stats.authRefusals[reason] ?? 0) - before, 1, `refused for ${reason}`);
};

/** A bound page: g.bind answered 200; returns the binding id. */
async function bind(page: ReturnType<typeof newPage>) {
  const a = await page.request("g.bind", {}, {}).answer();
  assert.equal(a.status, 200, `bind: ${a.body}`);
  return bodyOf(a).binding as string;
}

// ================= 4.1 D2: the proof's shape, header and key

test("L1 a good g.bind: 200, with dpop-nonce (the positive witness)", async () => {
  const { s, page } = await setup();
  try {
    const a = await page.request("g.bind", {}, {}).answer();
    assert.equal(a.status, 200);
    assert.equal(typeof a.headers["dpop-nonce"], "string");
    assert.ok(bodyOf(a).binding);
    census(s);
  } finally { await s.close(); }
});

/** A refusal case: the request (sent by `send`, after the snapshot) answered 401 with `error`, its reason counted,
 * zero effects, no request left open. */
async function refused(t: { s: PairServer; port: Scripted }, send: () => { answer(): Promise<any> }, reason: string, error = "invalid_dpop_proof", o: { bound?: boolean; status?: number } = {}) {
  const bindingBefore = t.s.gateway.binding;
  const before = effects(t.s, t.port), open = openRequests(t.s);
  const r0 = t.s.gateway.stats.authRefusals[reason] ?? 0;
  const a = await send().answer();
  assert.equal(a?.status, o.status ?? 401, `${o.status ?? 401} (${a?.body})`);
  assert.equal(bodyOf(a).error, error);
  assert.equal((t.s.gateway.stats.authRefusals[reason] ?? 0) - r0, 1, `refused for its own reason: ${reason} (${JSON.stringify(t.s.gateway.stats.authRefusals)})`);
  zeroEffects(t.s, t.port, before);
  assert.equal(openRequests(t.s), open, "no request left open");
  if (o.bound) assert.equal(t.s.gateway.binding, bindingBefore, "the binding unchanged");
  else assert.equal(t.s.gateway.binding, null, "no binding made");
}

test("L2a a token this socket wasn't given (one paired socket at a time: an unknown token of a token's shape): 401 invalid_token", async () => {
  const t = await setup();
  try {
    await refused(t, () => t.page.request("g.bind", {}, {}, { auth: `DPoP ${b64u(randomBytes(32))}` }), "token", "invalid_token");
  } finally { await t.s.close(); }
});

test("L2b a token from a closed socket: 401 invalid_token", async () => {
  const t = await setup();
  try {
    const old = t.page.token;
    t.page.st.emit("close"); // (the first socket gone)
    const p2 = newPage(t.s, t.clk);
    await refused({ s: t.s, port: t.port }, () => p2.request("g.bind", {}, {}, { auth: `DPoP ${old}` }), "token", "invalid_token");
  } finally { await t.s.close(); }
});

const headerCases: [string, any, string][] = [
  ["L3a typ missing", { header: { typ: undefined } }, "typ-missing"],
  ["L3b typ not dpop+jwt", { header: { typ: "jwt" } }, "typ"],
  ["L3c-none alg none", { header: { alg: "none" } }, "alg"],
  ["L3c-HS256 alg HS256", { header: { alg: "HS256" } }, "alg"],
  ["L3c-ES384 alg ES384", { header: { alg: "ES384" } }, "alg"],
];
for (const [name, over, reason] of headerCases) {
  test(`${name}: 401, refused for ${reason}`, async () => {
    const t = await setup();
    try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: over }), reason); } finally { await t.s.close(); }
  });
}

test("L3d a JWK with d (private): 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, d: b64u(randomBytes(32)) } } } }), "jwk-private"); } finally { await t.s.close(); }
});
test("L3e a JWK with an extra member: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, kid: "k1" } } } }), "jwk-extra"); } finally { await t.s.close(); }
});
test("L3f a JWK missing y: 401", async () => {
  const t = await setup();
  try { const { y, ...noY } = t.page.key.jwk; await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: noY } } }), "jwk-members"); } finally { await t.s.close(); }
});
test("L3g-kty kty not EC: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, kty: "RSA" } } } }), "kty"); } finally { await t.s.close(); }
});
test("L3g-crv crv not P-256: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, crv: "P-384" } } } }), "crv"); } finally { await t.s.close(); }
});
test("L3h off-curve coordinates: 401", async () => {
  const t = await setup();
  try {
    const x = Buffer.from(t.page.key.jwk.x, "base64url"); x[31] ^= 1; // (a point off the curve, almost surely)
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, x: b64u(x) } } } }), "curve");
  } finally { await t.s.close(); }
});
test("L3i coordinates not 43 characters or not 32 bytes: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, x: b64u(randomBytes(31)) } } } }), "coords"); } finally { await t.s.close(); }
});
test("L3j a thumbprint not the socket's jkt (another valid key, validly signed): 401", async () => {
  const t = await setup();
  try {
    const k2 = keyPair();
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { header: { jwk: k2.jwk }, signer: k2.privateKey } }), "thumbprint");
  } finally { await t.s.close(); }
});
test("L4a a bad signature: 401", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    const sig = Buffer.from(p[2], "base64url"); sig[5] ^= 0xff;
    await refused(t, () => t.page.request("g.bind", {}, {}, { dpop: `${p[0]}.${p[1]}.${b64u(sig)}` }), "signature");
  } finally { await t.s.close(); }
});
test("L4b a signature not 64 bytes: 401", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    await refused(t, () => t.page.request("g.bind", {}, {}, { dpop: `${p[0]}.${p[1]}.${b64u(randomBytes(63))}` }), "sig-length");
  } finally { await t.s.close(); }
});
test("L4c parseJwt, one parse step: 2 parts, 4 parts, non-base64url, non-JSON, a JSON non-object: 401 each", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    for (const raw of [`${p[0]}.${p[1]}`, `${p[0]}.${p[1]}.${p[2]}.${p[2]}`, `${p[0]}.${p[1]}+.${p[2]}`, `${b64u("{nope")}.${p[1]}.${p[2]}`, `${b64u("[1]")}.${p[1]}.${p[2]}`]) {
      await refused(t, () => t.page.request("g.bind", {}, {}, { dpop: raw }), "parse");
    }
  } finally { await t.s.close(); }
});
test("L4d a proof over 4096 B: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { dpop: "a".repeat(4097) }), "proof-size"); } finally { await t.s.close(); }
});
test("L4e a decoded segment over 1024 B: 401, before any key import", async () => {
  const t = await setup();
  try {
    const imports = t.s.gateway.stats.keyImports;
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { pad: "x".repeat(1100) } } }), "segment-size");
    assert.equal(t.s.gateway.stats.keyImports, imports, "no key imported");
  } finally { await t.s.close(); }
});

// ================= 4.2 D2: the claims, each validly signed by the socket's own key

test("L5 htm not the rpc's method, for each of the 8 rpcs: 401", async () => {
  const t = await setup();
  try {
    for (const rpc of Object.keys(ROUTES)) {
      const ref = rpc === "g.bind" ? {} : rpc === "g.record" ? { b: "b1", r: "r1" } : rpc === "g.events" ? { b: "b1", r: "r1", after: 0 } : { b: "b1" };
      const wrong = ROUTES[rpc].method === "GET" ? "POST" : "GET";
      await refused(t, () => t.page.request(rpc, ref, ROUTES[rpc].method === "POST" ? {} : undefined, { proof: { claims: { htm: wrong } } }), "htm");
    }
  } finally { await t.s.close(); }
});
test("L6a htu a URL taken as-is (another path), for each rpc: 401", async () => {
  const t = await setup();
  try {
    for (const rpc of Object.keys(ROUTES)) {
      const ref = rpc === "g.bind" ? {} : rpc === "g.record" ? { b: "b1", r: "r1" } : rpc === "g.events" ? { b: "b1", r: "r1", after: 0 } : { b: "b1" };
      await refused(t, () => t.page.request(rpc, ref, ROUTES[rpc].method === "POST" ? {} : undefined, { proof: { claims: { htu: SYNTHETIC_BASE + "/somewhere/else" } } }), "htu");
    }
  } finally { await t.s.close(); }
});
test("L6b htu with a query: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { htu: SYNTHETIC_BASE + "/bindings?x=1" } } }), "htu"); } finally { await t.s.close(); }
});
test("L6c cross-binding substitution: htu names binding B while ref.b = A: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.interrupt", { b: "A" }, {}, { path: "/bindings/B/interrupt" }), "htu"); } finally { await t.s.close(); }
});
test("L6d cross-run substitution: htu names run r2 while ref.r = r1: 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.record", { b: "b1", r: "r1" }, undefined, { path: "/bindings/b1/runs/r2" }), "htu"); } finally { await t.s.close(); }
});
test("L7 ath not SHA-256(token): 401", async () => {
  const t = await setup();
  try { await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { ath: b64u(randomBytes(32)) } } }), "ath"); } finally { await t.s.close(); }
});
test("L8a iat 61 s old: 401; L8a+ at exactly 60 s: passes", async () => {
  const t = await setup();
  try {
    const now = Math.floor(t.clk.now() / 1000);
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now - 61 } } }), "iat-past");
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now - 60 } } }).answer();
    assert.equal(a.status, 200, "L8a+");
  } finally { await t.s.close(); }
});
test("L8b iat 6 s ahead: 401; L8b+ at exactly 5 s: passes", async () => {
  const t = await setup();
  try {
    const now = Math.floor(t.clk.now() / 1000);
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now + 6 } } }), "iat-future");
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now + 5 } } }).answer();
    assert.equal(a.status, 200, "L8b+");
  } finally { await t.s.close(); }
});
test("L8c iat by type: missing, a string, null, true, 1.5, 1e999, 2^53: 401 each, before any arithmetic", async () => {
  const t = await setup();
  try {
    const raws: unknown[] = [undefined, "1730000000", null, true, 1.5, "1e999", 2 ** 53];
    for (const v of raws) {
      if (v === "1e999") {
        // (a JSON number that parses to Infinity: the claims segment written by hand)
        const header = b64u(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: t.page.key.jwk }));
        const claimsText = `{"jti":"${b64u(randomBytes(24))}","htm":"POST","htu":"${SYNTHETIC_BASE}/bindings","iat":1e999,"ath":"${b64u(createHash("sha256").update(t.page.token).digest())}","nonce":"${t.page.nonce}"}`;
        const input = `${header}.${b64u(claimsText)}`;
        const sig = edSign("sha256", Buffer.from(input), { key: t.page.key.privateKey, dsaEncoding: "ieee-p1363" });
        await refused(t, () => t.page.request("g.bind", {}, {}, { dpop: `${input}.${b64u(sig)}` }), "iat-type");
      } else await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { iat: v } } }), "iat-type");
    }
  } finally { await t.s.close(); }
});
test("L9a a jti reused within 120 s, and at exactly 120 s: 401; L9a+ the same jti 1 ms later: passes", async () => {
  const t = await setup();
  try {
    const jti = b64u(randomBytes(24));
    assert.equal((await t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }).answer()).status, 200);
    t.clk.advance(1000);
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { jti, iat: Math.floor(t.clk.now() / 1000) } } }), "jti-reused", "invalid_dpop_proof", { bound: true });
    t.clk.advance(GATEWAY_LIMITS.jtiMs - 1000); // (exactly 120 s after it was stored)
    await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { jti, iat: Math.floor(t.clk.now() / 1000) } } }), "jti-reused", "invalid_dpop_proof", { bound: true });
    t.clk.advance(1);
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { jti, iat: Math.floor(t.clk.now() / 1000) } } }).answer();
    assert.notEqual(a.status, 401, "L9a+: past 120 s the jti is accepted again (then 409 in-use: bound already)");
    census(t.s);
  } finally { await t.s.close(); }
});
for (const [name, jti, reason, ok] of [
  ["L9b a jti of 21 characters: 401", "a".repeat(21), "jti-min", false], ["L9b+ 22: passes", "a".repeat(22), "", true],
  ["L9c a jti of 65 characters: 401", "a".repeat(65), "jti-max", false], ["L9c+ 64: passes", "a".repeat(64), "", true],
  ["L9e a jti outside the charset (22 characters with . or +): 401", "a".repeat(20) + ".+", "jti-charset", false],
] as [string, string, string, boolean][]) {
  test(name, async () => {
    const t = await setup();
    try {
      if (ok) assert.equal((await t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }).answer()).status, 200);
      else await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }), reason);
    } finally { await t.s.close(); }
  });
}
test("L9d jti not a string (missing, 123, null, an array that would coerce): 401 each, nothing stored", async () => {
  const t = await setup();
  try {
    for (const jti of [undefined, 123, null, ["a".repeat(22)]]) await refused(t, () => t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }), "jti-type");
  } finally { await t.s.close(); }
});
test("L10a a stale nonce: 401 use_dpop_nonce with a fresh DPoP-Nonce", async () => {
  const t = await setup();
  try {
    const before = effects(t.s, t.port);
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { nonce: "stale" } } }).answer();
    assert.equal(a.status, 401);
    assert.equal(bodyOf(a).error, "use_dpop_nonce");
    assert.match(a.headers["www-authenticate"], /use_dpop_nonce/);
    assert.equal(typeof a.headers["dpop-nonce"], "string");
    zeroEffects(t.s, t.port, before);
  } finally { await t.s.close(); }
});
test("L10b the nonce rotates at 5 min: the old one passes before, 401 after", async () => {
  const t = await setup();
  try {
    const old = t.page.nonce;
    t.clk.advance(GATEWAY_LIMITS.nonceMs - 1000);
    assert.equal((await t.page.request("g.bind", {}, {}, { proof: { claims: { nonce: old } } }).answer()).status, 200, "before the rotation");
    t.clk.advance(1000);
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { nonce: old } } }).answer();
    assert.equal(bodyOf(a).error, "use_dpop_nonce", "after it");
    assert.notEqual(a.headers["dpop-nonce"], old);
  } finally { await t.s.close(); }
});
test("L10c every refusal carries the current DPoP-Nonce", async () => {
  const t = await setup();
  try {
    for (const over of [{ auth: "DPoP nope" }, { proof: { claims: { htm: "GET" } } }, { proof: { claims: { nonce: "stale" } } }]) {
      const a = await t.page.request("g.bind", {}, {}, over as any).answer();
      assert.equal(a.status, 401);
      assert.equal(a.headers["dpop-nonce"], t.s.gateway.nonce);
    }
  } finally { await t.s.close(); }
});
test("L10d every 200 carries the current DPoP-Nonce", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    for (const [rpc, ref, body] of [["g.interrupt", { b }, { epoch: 1 }], ["g.record", { b, r: "none" }, undefined]] as any[]) {
      const a = await t.page.request(rpc, ref, body).answer();
      assert.equal(a.headers["dpop-nonce"], t.s.gateway.nonce, `${rpc}: ${a.status}`);
    }
  } finally { await t.s.close(); }
});
test("L11 the replay store: the 4096th jti admitted (L11+), the 4097th 503 limit with Retry-After 1, nothing evicted", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page); // (one jti)
    for (let i = 2; i <= GATEWAY_LIMITS.jtis; i++) {
      const a = await t.page.request("g.record", { b, r: "x" }, undefined).answer();
      assert.equal(a.status, 404, `jti ${i} admitted`);
    }
    const before = effects(t.s, t.port);
    const a = await t.page.request("g.record", { b, r: "x" }, undefined).answer();
    assert.equal(a.status, 503);
    assert.equal(bodyOf(a).error, "limit");
    assert.equal(a.headers["retry-after"], "1");
    zeroEffects(t.s, t.port, before);
  } finally { await t.s.close(); }
});
test("L12 a reconnect: a new token; the old token on the new socket 401", async () => {
  const t = await setup();
  try {
    const old = t.page.token;
    t.page.st.emit("close");
    const p2 = newPage(t.s, t.clk, t.page.key);
    assert.notEqual(p2.token, old, "a new token");
    await refused({ s: t.s, port: t.port }, () => p2.request("g.bind", {}, {}, { auth: `DPoP ${old}` }), "token", "invalid_token");
    assert.equal((await p2.request("g.bind", {}, {}).answer()).status, 200, "the new token works");
  } finally { await t.s.close(); }
});

// ================= 4.3 Frames [G1]: refused at decode with close 1002, before any authentication

/** A request frame fed as is (refused before authentication, so its proof is never read); the close code after it. */
function rawFrame(page: ReturnType<typeof newPage>, over: any) {
  const frame = { id: page.nextId(), rpc: "g.bind", ref: {}, auth: `DPoP ${page.token}`, dpop: "a.b.c", accept: "application/json", body: "{}", ...over };
  for (const k of Object.keys(frame)) if (frame[k] === undefined) delete frame[k];
  page.c.feed(maskedText(frame));
  return closeOf(page.st);
}
/** A decode refusal: close 1002, no answer for the frame, zero effects, nothing authenticated. */
function closed1002(t: { s: PairServer; port: Scripted; clk: ReturnType<typeof clock>; page: ReturnType<typeof newPage> }, over: any, what: string, reason: string) {
  const before = effects(t.s, t.port);
  const imports = t.s.gateway.stats.keyImports;
  const n = texts(t.page.st).length;
  assert.equal(rawFrame(t.page, over), 1002, what);
  assert.equal(closeReason(t.page.st), reason, `${what}: closed by its own guard`);
  assert.equal(texts(t.page.st).length, n, `${what}: no answer`);
  assert.equal(t.s.gateway.stats.keyImports, imports, `${what}: nothing authenticated`);
  zeroEffects(t.s, t.port, before);
  freshWitness(t, what);
}
/** [G2] a protocol-error close leaves the pairing (the code and the session) to the page: a fresh socket pairs again. */
function freshWitness(t: { s: PairServer; clk: ReturnType<typeof clock>; page: ReturnType<typeof newPage> }, what: string) {
  const p2 = newPage(t.s, t.clk, t.page.key);
  assert.ok(p2.token && p2.token !== t.page.token, `${what}: a fresh socket pairs again (a new token)`);
}
const decodeCases: [string, (b: string) => any, string][] = [
  ["L13a an unknown rpc", () => ({ rpc: "g.nope" }), "an unknown rpc"],
  // (S1: a JSON value that isn't a string, never coerced as a key: the guard comes before any TABLE lookup)
  ["L13a-obj an rpc that is an object with toString null", () => ({ rpc: { toString: null } }), "an unknown rpc"],
  ["L13a-arr an rpc that is an array", () => ({ rpc: ["g.bind"] }), "an unknown rpc"],
  ["L13a-num an rpc that is a number", () => ({ rpc: 1 }), "an unknown rpc"],
  ["L13a-null an rpc that is null", () => ({ rpc: null }), "an unknown rpc"],
  ["L13a-proto an rpc naming an inherited member (__proto__, toString)", () => ({ rpc: "toString" }), "an unknown rpc"],
  ["L13b a ref member failing the ID pattern", () => ({ rpc: "g.run", ref: { b: "b/1" } }), "a ref member not an id"],
  ["L13c a ref member the rpc doesn't take (after on g.run)", (b) => ({ rpc: "g.run", ref: { b, after: 0 } }), "a ref member the rpc doesn't take"],
  ["L14a-pfx the frame id x1", () => ({ id: "x1" }), "a frame id is t and digits"],
  ["L14a-lz-t0 the frame id t0", () => ({ id: "t0" }), "a frame id has no leading zero"],
  ["L14a-lz-t01 the frame id t01", () => ({ id: "t01" }), "a frame id has no leading zero"],
  ["L14a-len the frame id t + 16 digits", () => ({ id: "t" + "1".repeat(16) }), "a frame id is at most 15 digits"],
  ["L14e-type after \"1\"", (b) => ({ rpc: "g.events", ref: { b, r: "r1", after: "1" }, body: undefined }), "after: type"],
  ["L14e-int after 1.5", (b) => ({ rpc: "g.events", ref: { b, r: "r1", after: 1.5 }, body: undefined }), "after: int"],
  ["L14e-sign after -1", (b) => ({ rpc: "g.events", ref: { b, r: "r1", after: -1 }, body: undefined }), "after: sign"],
  ["L14e-range after 2^53", (b) => ({ rpc: "g.events", ref: { b, r: "r1", after: 2 ** 53 }, body: undefined }), "after: range"],
];
for (const [name, over, reason] of decodeCases) {
  test(`${name}: 1002`, async () => {
    const t = await setup();
    try {
      const b = await bind(t.page);
      closed1002(t, over(b), name, reason);
      census(t.s);
    } finally { await t.s.close(); }
  });
}
test("L14a-len+ the frame id t + 15 digits: passes", async () => {
  const t = await setup();
  try {
    const a = await t.page.request("g.bind", {}, {}, { id: "t" + "1".repeat(15) }).answer();
    assert.equal(a.status, 200);
    assert.equal(closeOf(t.page.st), null);
  } finally { await t.s.close(); }
});
test("L14b a reused frame id: 1002", async () => {
  const t = await setup();
  try {
    assert.equal((await t.page.request("g.bind", {}, {}, { id: "t7" }).answer()).status, 200);
    closed1002(t, { id: "t7", rpc: "g.record", ref: { b: "b1", r: "r1" }, body: undefined }, "t7 again", "a frame id reused");
  } finally { await t.s.close(); }
});
test("L14c a frame id not above the last one: 1002", async () => {
  const t = await setup();
  try {
    assert.equal((await t.page.request("g.bind", {}, {}, { id: "t5" }).answer()).status, 200);
    closed1002(t, { id: "t3", rpc: "g.record", ref: { b: "b1", r: "r1" }, body: undefined }, "t3 after t5", "a frame id not above the last");
  } finally { await t.s.close(); }
});

/** A single run admitted on the scripted Worker; `finish()` makes the Worker end it. */
async function admitRun(t: { s: PairServer; port: Scripted; page: ReturnType<typeof newPage> }, b: string, request: string, code = "x = 1", extra: any = {}) {
  const a = await t.page.request("g.run", { b }, { request, epoch: 1, payload: { code }, ...extra }).answer();
  assert.equal(a.status, 202, `admitted: ${a.body}`);
  await until(() => t.port.posted.some((m) => m.code === code), "the run posted");
  const posted = [...t.port.posted].reverse().find((m) => m.code === code);
  return { a, workerId: posted.id as number, finish: () => t.port.last().onMessage({ id: posted.id, done: true, ms: 1 }) };
}
test("L14d the same request under a new frame id: the prior ack, zero executions", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    r.finish();
    await until(() => t.s.gateway.binding!.runs.get("req-1")!.outcome !== null, "the run ended");
    const ex = t.s.gateway.stats.executions, posted = t.port.posted.length;
    const a = await t.page.request("g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x = 1" } }).answer();
    assert.equal(a.status, 202);
    assert.deepEqual(bodyOf(a), { request: "req-1", state: "done" });
    assert.equal(t.s.gateway.stats.executions, ex, "zero executions");
    assert.equal(t.port.posted.length, posted, "nothing posted");
    census(t.s);
  } finally { await t.s.close(); }
});
test("L14e-range+ after 2^53 - 1 and 0: pass (a 200 head each)", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    for (const after of [2 ** 53 - 1, 0]) {
      const a = await t.page.request("g.events", { b, r: "req-1", after }).answer();
      assert.equal(a.status, 200, `after ${after}`);
      assert.equal(a.headers["content-type"], "text/event-stream");
    }
    assert.equal(closeOf(t.page.st), null);
    r.finish();
  } finally { await t.s.close(); }
});

/** JSON text of exactly n UTF-8 bytes, mostly 3-byte characters, counted by TextEncoder (not the gateway's
 * Buffer.byteLength): {...extra, pad}. */
function bodyOfBytes(n: number, extra: any = {}) {
  const u8 = (s: string) => new TextEncoder().encode(s).length;
  let room = n - u8(JSON.stringify({ ...extra, pad: "" }));
  assert.ok(room >= 0);
  const pad = "€".repeat(Math.floor(room / 3)) + "a".repeat(room % 3);
  const s = JSON.stringify({ ...extra, pad });
  assert.equal(u8(s), n, "the oracle's count");
  return s;
}
test("L15 a body of exactly BODY_MAX for its rpc, multibyte: passes (L15+); one byte more: 1002", async () => {
  // g.complete (BODY_MAX.other)
  {
    const t = await setup();
    try {
      const b = await bind(t.page);
      const a = await t.page.request("g.complete", { b }, bodyOfBytes(BODY_MAX.other, { epoch: 2 })).answer();
      assert.equal(a.status, 409, `L15+ complete: decoded and dispatched (${a.body})`); // (the wrong epoch: answered after decode)
      assert.equal(bodyOf(a).error, "epoch");
      census(t.s);
      closed1002(t, { rpc: "g.complete", ref: { b }, body: bodyOfBytes(BODY_MAX.other + 1, { epoch: 2 }) }, "complete + 1 B", "a body over its limit");
      census(t.s);
    } finally { await t.s.close(); }
  }
  // g.run (BODY_MAX.run)
  {
    const t = await setup();
    try {
      const b = await bind(t.page);
      const body = bodyOfBytes(BODY_MAX.run, { request: "big", epoch: 1, payload: { code: "x = 1" } });
      const a = await t.page.request("g.run", { b }, body).answer();
      assert.equal(a.status, 202, `L15+ run (${a.body})`);
      assert.equal(t.s.gateway.stats.queuedPayloadBytes, BODY_MAX.run, "charged its bytes");
      t.port.last().onMessage({ id: t.port.posted[t.port.posted.length - 1].id, done: true, ms: 1 });
      await until(() => t.s.gateway.stats.queuedPayloadBytes === 0, "released at its end");
      closed1002(t, { rpc: "g.run", ref: { b }, body: bodyOfBytes(BODY_MAX.run + 1, { request: "big2", epoch: 1, payload: { code: "x = 1" } }) }, "run + 1 B", "a body over its limit");
      census(t.s);
    } finally { await t.s.close(); }
  }
});
test("L16 8 open ids pass (L16+); a 9th open id: 1002", async () => {
  const holds: (() => void)[] = [];
  const t = await setup({ gateway: { authHold: () => new Promise<void>((r) => holds.push(r)) } });
  try {
    for (let i = 1; i <= GATEWAY_LIMITS.openIds; i++) t.page.request("g.record", { b: "b1", r: "r" + i });
    await until(() => holds.length === GATEWAY_LIMITS.openIds, "8 held");
    assert.equal(closeOf(t.page.st), null, "L16+ 8 open ids pass");
    closed1002(t, { rpc: "g.record", ref: { b: "b1", r: "r9" }, body: undefined }, "a 9th open id", "too many open requests");
    for (const h of holds) h();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(texts(t.page.st).filter((x: any) => x.status !== undefined).length, 0, "the closed socket's held requests answered nothing");
    census(t.s);
  } finally { await t.s.close(); }
});

// ================= 4.4 Retirement

/** Every frame written for `id`, in order. */
const framesFor = (st: any, id: string) => texts(st).filter((x: any) => x.id === id);
test("L17a cancel a pending request: its one answer, then retired as the id's last frame", async () => {
  const H = holder();
  const t = await setup({ gateway: { authHold: H.hold } }); // (L17a: only the cancelled request is held)
  try {
    const r = await heldRequest(H, t.page, "g.bind", {}, {});
    t.page.cancel(r.id);
    assert.deepEqual(framesFor(t.page.st, r.id), [], "nothing before its answer");
    assert.ok(r.held(), "the cancelled request still held");
    r.release();
    await until(() => framesFor(t.page.st, r.id).length === 2, "the answer and retired");
    const fs = framesFor(t.page.st, r.id);
    assert.equal(fs[0].status, 200, "its one answer");
    assert.deepEqual(fs[1], { id: r.id, retired: true }, "then retired");
    // L17b: after retired, no frame for that id (a census over the frame log after more traffic)
    await t.page.request("g.record", { b: bodyOf(fs[0]).binding, r: "x" }).answer();
    const all = framesFor(t.page.st, r.id);
    assert.equal(all.length, 2, "L17b no frame after retired");
    assert.equal(all[all.length - 1].retired, true);
    census(t.s);
  } finally { await t.s.close(); }
});
test("L18 cancel a subscription: the frames already queued, then retired", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const run = await admitRun(t, b, "req-1");
    t.port.last().onMessage({ id: run.workerId, stream: "stdout", text: "one\n" });
    const ev = t.page.request("g.events", { b, r: "req-1", after: 0 });
    assert.equal((await ev.answer()).status, 200);
    await until(() => framesFor(t.page.st, ev.id).filter((x: any) => x.chunk).length === 2, "start and the stream queued");
    t.page.cancel(ev.id);
    const fs = framesFor(t.page.st, ev.id);
    assert.deepEqual(fs[fs.length - 1], { id: ev.id, retired: true }, "retired last");
    assert.equal(fs.filter((x: any) => x.chunk).length, 2, "the queued chunks, then retired");
    t.port.last().onMessage({ id: run.workerId, stream: "stdout", text: "two\n" });
    run.finish();
    await until(() => t.s.gateway.binding!.runs.get("req-1")!.outcome !== null, "ended");
    assert.equal(framesFor(t.page.st, ev.id).length, fs.length, "nothing after retired");
    census(t.s);
  } finally { await t.s.close(); }
});
test("L19a cancel a never-issued frame id: 1002", async () => {
  const t = await setup();
  try {
    await bind(t.page); // (t1)
    t.page.cancel("t9");
    assert.equal(closeOf(t.page.st), 1002);
    assert.equal(closeReason(t.page.st), "a cancel for an id never sent");
    freshWitness(t, "L19a");
  } finally { await t.s.close(); }
});
test("L19b cancel an already-answered id: retired at once", async () => {
  const t = await setup();
  try {
    const r = t.page.request("g.bind", {}, {});
    assert.equal((await r.answer()).status, 200);
    t.page.cancel(r.id);
    const fs = framesFor(t.page.st, r.id);
    assert.deepEqual(fs[fs.length - 1], { id: r.id, retired: true });
    assert.equal(fs.length, 2);
  } finally { await t.s.close(); }
});

// ================= 4.5 Streams and output budgets

/** A text frame's bytes on the wire (RFC 6455, server side: unmasked), for an oracle of the gate's sums. */
const wireBytes = (text: string) => { const n = Buffer.byteLength(text, "utf8"); return n + (n < 126 ? 2 : n < 65536 ? 4 : 10); };
test("L21 g.events: exactly a 200 head, the chunks in seq order, then one {id, end: true} at the terminal", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const run = await admitRun(t, b, "req-1");
    const ev = t.page.request("g.events", { b, r: "req-1", after: 0 });
    assert.equal((await ev.answer()).status, 200);
    for (const s of ["a\n", "b\n", "c\n"]) t.port.last().onMessage({ id: run.workerId, stream: "stdout", text: s });
    run.finish();
    await until(() => framesFor(t.page.st, ev.id).some((x: any) => x.end), "the end");
    const fs = framesFor(t.page.st, ev.id);
    assert.equal(fs[0].status, 200, "the head first");
    assert.equal(fs.filter((x: any) => x.status !== undefined).length, 1, "exactly one head");
    const chunks = fs.slice(1, -1);
    assert.ok(chunks.every((x: any) => typeof x.chunk === "string"), "then chunks only");
    const seqs = chunks.map((x: any) => Number(/^id: (\d+)\n/.exec(x.chunk)![1]));
    assert.deepEqual(seqs, seqs.map((_: number, i: number) => i + 1), "seq order from 1, no gap");
    assert.equal(JSON.parse(chunks[chunks.length - 1].chunk.split("data: ")[1]).type, "terminal", "the terminal last");
    assert.deepEqual(fs[fs.length - 1], { id: ev.id, end: true }, "one end, last");
    assert.equal(fs.filter((x: any) => x.end).length, 1);
    census(t.s);
  } finally { await t.s.close(); }
});
test("L22 a chunk with buffered + frame = exactly 7 MiB is sent (L22+); one byte more: streamError slow, not appended; cancel then retired", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const run = await admitRun(t, b, "req-1");
    const ev = t.page.request("g.events", { b, r: "req-1", after: 0 });
    assert.equal((await ev.answer()).status, 200);
    await until(() => framesFor(t.page.st, ev.id).length === 2, "the start chunk");
    // (the next chunk, built by the test as an oracle: seq 2, a stream event)
    const chunkFor = (seq: number, text: string) => JSON.stringify({ id: ev.id, chunk: `id: ${seq}\ndata: ${JSON.stringify({ seq, type: "stream", name: "stdout", text })}\n\n` });
    const c2 = chunkFor(2, "x\n");
    t.page.st.writableLength = PAIR_LIMITS.outData - wireBytes(c2);
    let n = t.page.st.writes.length;
    t.port.last().onMessage({ id: run.workerId, stream: "stdout", text: "x\n" });
    assert.equal(t.page.st.writes.length, n + 1, "L22+ sent");
    assert.equal(serverFrame(t.page.st.writes[n]).payload.toString(), c2, "the oracle's chunk, byte for byte");
    const c3 = chunkFor(3, "y\n");
    t.page.st.writableLength = PAIR_LIMITS.outData - wireBytes(c3) + 1;
    n = t.page.st.writes.length;
    t.port.last().onMessage({ id: run.workerId, stream: "stdout", text: "y\n" });
    const after = t.page.st.writes.slice(n).map((w: Buffer) => JSON.parse(serverFrame(w).payload.toString()));
    assert.deepEqual(after, [{ id: ev.id, streamError: "slow" }], "the chunk not appended; streamError slow (a control frame)");
    t.page.st.writableLength = 0;
    t.page.cancel(ev.id);
    const fs = framesFor(t.page.st, ev.id);
    assert.deepEqual(fs[fs.length - 1], { id: ev.id, retired: true }, "the cancel gets retired");
    assert.equal(closeOf(t.page.st), null, "the socket stays open");
    run.finish();
  } finally { await t.s.close(); }
});
test("L23 an answer at exactly 7 MiB is sent (L23+); one byte more: close 1013, not appended", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page); // t1
    // (the answer's size, measured on an identical request whose id has as many digits)
    let n = t.page.st.writes.length;
    assert.equal((await t.page.request("g.record", { b, r: "x" }).answer()).status, 404); // t2
    const L = t.page.st.writes[n].length;
    t.page.st.writableLength = PAIR_LIMITS.outData - L;
    n = t.page.st.writes.length;
    const a3 = await t.page.request("g.record", { b, r: "x" }).answer(); // t3
    assert.equal(a3?.status, 404, "L23+ sent");
    assert.equal(t.page.st.writes[n].length, L, "the same size");
    t.page.st.writableLength = PAIR_LIMITS.outData - L + 1;
    n = t.page.st.writes.length;
    const r4 = t.page.request("g.record", { b, r: "x" }); // t4
    await until(() => closeOf(t.page.st) !== null, "closed");
    assert.equal(closeOf(t.page.st), 1013);
    assert.equal(framesFor(t.page.st, r4.id).length, 0, "not appended");
    assert.equal(t.page.st.writes.length, n + 1, "only the close frame written");
  } finally { await t.s.close(); }
});
test("L24a a control frame at exactly 8 MiB is sent (L24+); L24b one byte more: the transport destroyed, nothing appended", async () => {
  const t = await setup();
  try {
    const r = t.page.request("g.bind", {}, {});
    assert.equal((await r.answer()).status, 200);
    const retired = JSON.stringify({ id: r.id, retired: true });
    t.page.st.writableLength = PAIR_LIMITS.outTotal - wireBytes(retired);
    let n = t.page.st.writes.length;
    t.page.cancel(r.id);
    assert.equal(t.page.st.writes.length, n + 1, "L24+ sent");
    assert.equal(serverFrame(t.page.st.writes[n]).payload.toString(), retired);
    t.page.st.writableLength = PAIR_LIMITS.outTotal - wireBytes(retired) + 1;
    n = t.page.st.writes.length;
    const overflows = t.s.stats.overflows;
    t.page.cancel(r.id);
    // (what was written, asserted apart from why: nothing; the transport destroyed)
    assert.equal(t.page.st.writes.length, n, "L24b nothing written");
    assert.equal(t.page.st.destroyed, true, "destroyed");
    assert.equal(t.s.stats.overflows - overflows, 1, "counted as an overflow");
  } finally { await t.s.close(); }
});
test("L25 completion matches whose answer is RESPONSE_MAX + 1 B: 502 answer-too-large instead; L25+ exactly RESPONSE_MAX sent as is", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const base = JSON.stringify({ matches: [""], prefix: "" }).length;
    for (const [extra, want] of [[0, 200], [1, 502]] as const) {
      const r = t.page.request("g.complete", { b }, { epoch: 1, code: "x" });
      await until(() => t.port.posted.some((m) => m.complete === "x" && !m.$answered), "the completion posted");
      const m = t.port.posted.find((m) => m.complete === "x" && !m.$answered);
      m.$answered = true;
      const s = "a".repeat(RESPONSE_MAX - base + extra);
      t.port.last().onMessage({ id: m.id, matches: [s], prefix: "" });
      const a = await r.answer();
      assert.equal(a.status, want, `+${extra}`);
      if (want === 200) {
        assert.equal(Buffer.byteLength(a.body, "utf8"), RESPONSE_MAX, "L25+ exactly RESPONSE_MAX, as is");
        assert.equal(bodyOf(a).matches[0], s);
      } else {
        assert.deepEqual(bodyOf(a), { error: "answer-too-large" });
        assert.ok(Buffer.byteLength(a.body, "utf8") <= RESPONSE_MAX);
      }
    }
    census(t.s);
  } finally { await t.s.close(); }
});

// ================= 4.6 The binding

/** A run admitted and ended on the scripted Worker (the page's nonce refreshed from each answer). */
async function runToEnd(t: { s: PairServer; port: Scripted; page: ReturnType<typeof newPage> }, b: string, request: string, code = "x = 1") {
  const a = await t.page.request("g.run", { b }, { request, epoch: t.s.gateway.binding!.epoch, payload: { code } }).answer();
  t.page.nonce = a.headers["dpop-nonce"];
  assert.equal(a.status, 202, `${request}: ${a.body}`);
  const posted = t.port.posted[t.port.posted.length - 1];
  t.port.last().onMessage({ id: posted.id, done: true, ms: 1 });
  await until(() => t.s.gateway.binding!.runs.get(request)?.outcome != null, `${request} ended`);
}
test("L26 a second g.bind while bound: 409 in-use", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const a = await t.page.request("g.bind", {}, {}).answer();
    assert.equal(a.status, 409);
    assert.equal(bodyOf(a).error, "in-use");
    assert.equal(t.s.gateway.binding!.id, b, "the binding unchanged");
  } finally { await t.s.close(); }
});
test("L27a the same request and payload: the existing ack; L27b a different payload: 409 conflict", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1", "x = 1");
    const ex = t.s.gateway.stats.executions;
    const same = await t.page.request("g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x = 1" } }).answer();
    assert.equal(same.status, 202);
    assert.deepEqual(bodyOf(same), { request: "req-1", state: "running" }, "L27a the existing ack");
    const other = await t.page.request("g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x = 2" } }).answer();
    assert.equal(other.status, 409);
    assert.equal(bodyOf(other).error, "conflict", "L27b");
    assert.equal(t.s.gateway.stats.executions, ex, "neither executed");
    r.finish();
  } finally { await t.s.close(); }
});
test("L27c the record: the 64-hex digest, no payload; at the widest request id and the largest summary, at most 512 encoded bytes", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const MARK = "PAYLOAD-MARKER-7f3a";
    const request = "r".repeat(64);
    await admitRun(t, b, request, `x = "${MARK}"`);
    // (the largest summary: a Worker exit whose detail is all quotes, each escaped twice in the record)
    t.port.last().onExit('"'.repeat(300));
    const run = t.s.gateway.binding!.runs.get(request)!;
    await until(() => run.outcome !== null, "ended");
    assert.match(run.digest, /^[0-9a-f]{64}$/);
    const held = JSON.stringify({ ...run, events: [], listeners: undefined });
    assert.ok(!held.includes(MARK), "no payload or payload substring in the record");
    assert.ok(run.recordBytes <= GATEWAY_LIMITS.recordBytes, `${run.recordBytes} <= 512`);
    // (and every quote-heavy detail length near the summary's cap, the record still within 512)
    for (let n = 0; n <= 140; n++) {
      const t2 = await setup();
      try {
        const b2 = await bind(t2.page);
        await admitRun(t2, b2, request);
        t2.port.last().onExit('"'.repeat(n));
        const r2 = t2.s.gateway.binding!.runs.get(request)!;
        await until(() => r2.outcome !== null, "ended");
        assert.ok(r2.recordBytes <= GATEWAY_LIMITS.recordBytes, `detail of ${n} quotes: ${r2.recordBytes}`);
      } finally { await t2.s.close(); }
    }
  } finally { await t.s.close(); }
});
test("L28 a run while one runs: 409 busy", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    const ex = t.s.gateway.stats.executions;
    const a = await t.page.request("g.run", { b }, { request: "req-2", epoch: 1, payload: { code: "y = 1" } }).answer();
    assert.equal(a.status, 409);
    assert.equal(bodyOf(a).error, "busy");
    assert.equal(t.s.gateway.stats.executions, ex);
    assert.equal(t.s.gateway.binding!.runs.has("req-2"), false, "no record");
    r.finish();
  } finally { await t.s.close(); }
});
// (268 s on master: a slow test, test/slow-tests.ts)
test("L29a the 10,000th record admitted (L29a+), the 10,001st 429 runs; L29b restarts at the cap: still 429, the count unchanged; L29c recordBytes <= 5,120,000", { skip: slowSkip }, async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    for (let i = 1; i <= GATEWAY_LIMITS.runs; i++) {
      if (i % 4000 === 0) t.clk.advance(GATEWAY_LIMITS.jtiMs + 1000); // (the replay store's window: its jtis expire)
      await runToEnd(t, b, `req-${i}`);
    }
    const g = t.s.gateway;
    assert.equal(g.binding!.runs.size, GATEWAY_LIMITS.runs, "L29a+ the 10,000th admitted");
    const over = await t.page.request("g.run", { b }, { request: "req-over", epoch: 1, payload: { code: "x" } }).answer();
    t.page.nonce = over.headers["dpop-nonce"];
    assert.equal(over.status, 429);
    assert.deepEqual(bodyOf(over), { error: "limit", reason: "runs" });
    // L29b: a restart (every record a tombstone) at the cap
    const rs = await t.page.request("g.restart", { b }, { epoch: 1 }).answer();
    t.page.nonce = rs.headers["dpop-nonce"];
    assert.equal(rs.status, 200);
    const again = await t.page.request("g.run", { b }, { request: "req-over2", epoch: 1, payload: { code: "x" } }).answer();
    assert.equal(again.status, 429, "L29b still 429");
    assert.equal(g.binding!.runs.size, GATEWAY_LIMITS.runs, "L29b the count unchanged");
    // L29c
    assert.ok([...g.binding!.runs.values()].every((r) => r.tomb), "all tombstones");
    assert.ok(g.stats.recordBytes <= GATEWAY_LIMITS.runs * GATEWAY_LIMITS.recordBytes, `L29c ${g.stats.recordBytes}`);
    assert.equal(g.stats.recordBytes, [...g.binding!.runs.values()].reduce((n, r) => n + r.recordBytes, 0), "the aggregate is the records' sum");
  } finally { await t.s.close(); }
});
test("L30 after a restart, an old request: its tombstone's terminal, zero executions", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    await runToEnd(t, b, "req-1");
    const rs = await t.page.request("g.restart", { b }, { epoch: 1 }).answer();
    assert.equal(rs.status, 200);
    assert.equal(t.s.gateway.binding!.runs.get("req-1")!.tomb, true);
    const ex = t.s.gateway.stats.executions;
    const a = await t.page.request("g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x = 1" } }).answer();
    assert.equal(a.status, 202);
    assert.deepEqual(bodyOf(a), { request: "req-1", state: "done" });
    const rec = await t.page.request("g.record", { b, r: "req-1" }).answer();
    assert.equal(bodyOf(rec).state, "done", "the record's terminal");
    assert.equal(t.s.gateway.stats.executions, ex, "zero executions");
  } finally { await t.s.close(); }
});
/** A new binding (cases v3's "rebind"): the socket lost, the Worker's 10 idle minutes (the binding fenced, the
 * session kept: an unpair would forget it, and a code pairs once), then the page pairs again by its session. */
async function rebind(t: { s: PairServer; clk: ReturnType<typeof clock>; page: ReturnType<typeof newPage> }) {
  t.page.st.emit("close");
  t.clk.advance(GATEWAY_LIMITS.idleMs);
  assert.equal(t.s.gateway.binding, null, "the idle Worker gone, the binding fenced");
  const p2 = newPage(t.s, t.clk, t.page.key);
  return { p2, b2: await bind(p2) };
}
test("L31 after a new binding (the socket lost, the idle exit, then pair and bind): the old binding's ids 410 binding-gone; new runs admitted", async () => {
  const t = await setup();
  try {
    const b1 = await bind(t.page);
    await runToEnd(t, b1, "req-1");
    const { p2, b2 } = await rebind(t);
    assert.notEqual(b2, b1);
    const old = await p2.request("g.record", { b: b1, r: "req-1" }).answer();
    assert.equal(old.status, 410);
    assert.equal(bodyOf(old).error, "binding-gone");
    const oldRun = await p2.request("g.run", { b: b1 }, { request: "req-9", epoch: 1, payload: { code: "x" } }).answer();
    assert.equal(oldRun.status, 410);
    await runToEnd({ s: t.s, port: t.port, page: p2 }, b2, "req-new");
    census(t.s);
  } finally { await t.s.close(); }
});

// ---- event retention [G1]
/** An event's encoded size, as the gateway counts it (an oracle: the same object, JSON-encoded). */
const evBytes = (seq: number, ev: any) => Buffer.byteLength(JSON.stringify({ seq, ...ev }), "utf8");
/** A stream event's text that makes it exactly `n` encoded bytes at `seq` (ASCII, nothing escaped). */
function textFor(seq: number, n: number) {
  const base = evBytes(seq, { type: "stream", name: "stdout", text: "" });
  assert.ok(n >= base, `${n} >= ${base}`);
  return "a".repeat(n - base);
}
test("L32a-count a run's 10,000th event retained (L32a-count+), the 10,001st drops the oldest; L32c the cursor at the first retained event passes, one below 410", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    const run = t.s.gateway.binding!.runs.get("req-1")!;
    for (let i = run.events.length; i < GATEWAY_LIMITS.eventsPerRun; i++) t.port.last().onMessage({ id: r.workerId, stream: "stdout", text: "x" });
    assert.equal(run.events.length, GATEWAY_LIMITS.eventsPerRun);
    assert.equal(run.firstSeq, 1, "L32a-count+ all retained");
    t.port.last().onMessage({ id: r.workerId, stream: "stdout", text: "x" });
    assert.equal(run.events.length, GATEWAY_LIMITS.eventsPerRun);
    assert.equal(run.firstSeq, 2, "the oldest dropped");
    const at = await t.page.request("g.events", { b, r: "req-1", after: run.firstSeq - 1 }).answer();
    assert.equal(at.status, 200, "L32c at the first retained event");
    const below = await t.page.request("g.events", { b, r: "req-1", after: run.firstSeq - 2 }).answer();
    assert.equal(below.status, 410);
    assert.equal(bodyOf(below).error, "expired-cursor");
    r.finish();
  } finally { await t.s.close(); }
});
test("L32a-bytes a run's events at exactly 4 MiB retained (L32a-bytes+); one byte more drops the oldest", async () => {
  for (const extra of [0, 1]) {
    const t = await setup();
    try {
      const b = await bind(t.page);
      const r = await admitRun(t, b, "req-1");
      const run = t.s.gateway.binding!.runs.get("req-1")!;
      const seq = run.nextSeq;
      t.port.last().onMessage({ id: r.workerId, stream: "stdout", text: textFor(seq, GATEWAY_LIMITS.runEventBytes - run.eventBytes + extra) });
      if (extra === 0) {
        assert.equal(run.eventBytes, GATEWAY_LIMITS.runEventBytes, "exactly 4 MiB");
        assert.equal(run.firstSeq, 1, "L32a-bytes+ all retained");
      } else {
        assert.equal(run.firstSeq, 2, "one byte more: the oldest dropped");
        assert.ok(run.eventBytes <= GATEWAY_LIMITS.runEventBytes);
      }
      r.finish();
    } finally { await t.s.close(); }
  }
});
test("L32b per binding: at exactly 64 MiB all retained (L32b+); one byte more: the oldest ended run's events go first, its record stays", async () => {
  for (const extra of [0, 1]) {
    const t = await setup();
    try {
      const b = await bind(t.page);
      const g = t.s.gateway;
      // 16 ended runs, each 1 KiB under 4 MiB (its terminal included), then a running one making up the rest
      const per = GATEWAY_LIMITS.runEventBytes - 1024;
      for (let i = 1; i <= 16; i++) {
        const r = await admitRun(t, b, `req-${i}`, `x = ${i}`);
        const run = g.binding!.runs.get(`req-${i}`)!;
        const term = evBytes(run.nextSeq + 1, { type: "terminal", outcome: { status: "ok", ms: 1 } });
        t.port.last().onMessage({ id: r.workerId, stream: "stdout", text: textFor(run.nextSeq, per - run.eventBytes - term) });
        r.finish();
        await until(() => run.outcome !== null, `req-${i} ended`);
        assert.equal(run.eventBytes, per, `req-${i}: ${per} bytes, its terminal included`);
      }
      const r17 = await admitRun(t, b, "req-17", "x = 17");
      const run17 = g.binding!.runs.get("req-17")!;
      t.port.last().onMessage({ id: r17.workerId, stream: "stdout", text: textFor(run17.nextSeq, GATEWAY_LIMITS.bindingEventBytes - g.binding!.eventBytes + extra) });
      const first = g.binding!.runs.get("req-1")!;
      if (extra === 0) {
        assert.equal(g.binding!.eventBytes, GATEWAY_LIMITS.bindingEventBytes, "exactly 64 MiB");
        assert.ok([...g.binding!.runs.values()].every((r) => r.firstSeq === 1), "L32b+ all retained");
      } else {
        assert.ok(g.binding!.eventBytes <= GATEWAY_LIMITS.bindingEventBytes);
        assert.ok(first.firstSeq > 1, "the oldest ended run's events went first");
        assert.ok(g.binding!.runs.has("req-1") && first.outcome !== null, "its record stays");
        for (let i = 2; i <= 17; i++) assert.equal(g.binding!.runs.get(`req-${i}`)!.firstSeq, 1, `req-${i} untouched`);
      }
      r17.finish();
    } finally { await t.s.close(); }
  }
});

test("L34a complete with no binding: refused (404), nothing posted", async () => {
  const t = await setup();
  try {
    const before = effects(t.s, t.port);
    const a = await t.page.request("g.complete", { b: "b1" }, { epoch: 1, code: "x" }).answer();
    assert.equal(a.status, 404);
    zeroEffects(t.s, t.port, before);
    census(t.s);
  } finally { await t.s.close(); }
});
test("L34b a second complete in flight: 409 busy", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const first = t.page.request("g.complete", { b }, { epoch: 1, code: "x" });
    await until(() => t.port.posted.some((m) => m.complete === "x"), "the first posted");
    const posted = t.port.posted.length;
    const second = await t.page.request("g.complete", { b }, { epoch: 1, code: "y" }).answer();
    assert.equal(second.status, 409);
    assert.equal(bodyOf(second).error, "busy");
    assert.equal(t.port.posted.length, posted, "the second not posted");
    const m = t.port.posted.find((m) => m.complete === "x");
    t.port.last().onMessage({ id: m.id, matches: ["xa"], prefix: "x" });
    assert.equal((await first.answer()).status, 200);
    census(t.s);
  } finally { await t.s.close(); }
});

// ---- waves [G8]
const entry = (k: number, code: string, over: any = {}) => ({ cell: `c${k}`, auto: true, est: 0, code, parents: [], desc: [], defs: [], mode: "python", ...over });
const wave = (entries: any[]) => ({ mode: "python", policy: { all: true, budget: null }, forget: [], entries });
const waveCases: [string, () => any[]][] = [
  ["L35a-size an entry's code over its size limit", () => [entry(0, "a = 1"), entry(1, "b".repeat(GATEWAY_LIMITS.cellCode + 1))]],
  ["L35a-count 257 entries", () => Array.from({ length: 257 }, (_, k) => entry(k, `v${k} = ${k}`))],
  ["L35a-ref an entry with a bad ref (a parent not before it)", () => [entry(0, "a = 1"), entry(1, "b = 2", { parents: [{ in: 1 }] })]],
];
for (const [name, entries] of waveCases) {
  test(`${name}: 400 malformed, zero admissions and executions for the whole envelope`, async () => {
    const t = await setup();
    try {
      const b = await bind(t.page);
      const before = effects(t.s, t.port);
      const ex = t.s.gateway.stats.executions;
      const a = await t.page.request("g.run", { b }, { request: "w1", epoch: 1, kind: "wave", payload: wave(entries()) }).answer();
      assert.equal(a.status, 400, a.body);
      assert.equal(bodyOf(a).error, "malformed");
      assert.equal(t.s.gateway.binding!.runs.size, 0, "zero admissions");
      assert.equal(t.s.gateway.stats.executions, ex, "zero executions");
      zeroEffects(t.s, t.port, before);
      census(t.s);
    } finally { await t.s.close(); }
  });
}
test("L35b a valid wave: its entries run in order under src/wave-policy.ts", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const codes = ["a = 1", "b = a + 1", "c = b + 1"];
    const a = await t.page.request("g.run", { b }, { request: "w1", epoch: 1, kind: "wave", payload: wave(codes.map((c, k) => entry(k, c))) }).answer();
    assert.equal(a.status, 202, a.body);
    const seen: string[] = [];
    for (let k = 0; k < codes.length; k++) {
      await until(() => t.port.posted.filter((m) => typeof m.code === "string" && m.code !== "").length === k + 1, `entry ${k} posted`);
      const m = t.port.posted.filter((m) => typeof m.code === "string" && m.code !== "")[k];
      seen.push(m.code);
      assert.equal(t.port.posted.filter((x) => typeof x.code === "string" && x.code !== "").length, k + 1, "the next not before this one ends");
      t.port.last().onMessage({ id: m.id, done: true, ms: 1 });
    }
    const run = t.s.gateway.binding!.runs.get("w1")!;
    await until(() => run.outcome !== null, "the wave's terminal");
    assert.deepEqual(seen, codes, "in order");
    assert.deepEqual(run.outcome, { status: "done" });
    census(t.s);
  } finally { await t.s.close(); }
});

// ================= 4.9 Lifecycle (scripted Worker; L33 on the real one, below)

test("L37 socket lost: the Worker kept, alive at 9:59 (L37+), gone after 10 idle minutes", async () => {
  const t = await setup();
  try {
    await bind(t.page);
    const w = t.port.last();
    t.page.st.emit("close");
    t.clk.advance(GATEWAY_LIMITS.idleMs - 1000);
    assert.equal(w.terminated, false, "L37+ alive at 9:59");
    assert.ok(t.s.gateway.binding, "the binding kept");
    t.clk.advance(1000);
    assert.equal(w.terminated, true, "terminated at 10:00");
    assert.equal(t.s.gateway.binding, null);
  } finally { await t.s.close(); }
});
test("L38 a reconnect in the Worker's life: an admitted run reconciled by request, the Worker (its variables) kept, no new run without a Run", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    t.page.st.emit("close");
    r.finish(); // (it ends while no page is paired)
    const p2 = newPage(t.s, t.clk, t.page.key);
    assert.equal(t.s.gateway.stats.workersStarted, 1, "the same Worker: its variables kept");
    const posted = t.port.posted.length;
    const rec = await p2.request("g.record", { b, r: "req-1" }).answer();
    assert.equal(rec.status, 200);
    assert.equal(bodyOf(rec).state, "done", "reconciled by request");
    const again = await p2.request("g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x = 1" } }).answer();
    assert.deepEqual(bodyOf(again), { request: "req-1", state: "done" }, "the same request: its record, not a new run");
    assert.equal(t.port.posted.length, posted, "no new run without a Run");
  } finally { await t.s.close(); }
});
test("L39 explicit unpair: the Worker terminated; late frames on the old socket ignored, its Worker's late output dropped", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r = await admitRun(t, b, "req-1");
    const w = t.port.last();
    t.page.c.feed(maskedText({ unpair: true }));
    assert.equal(w.terminated, true);
    assert.equal(t.s.gateway.binding, null);
    const writes = t.page.st.writes.length, posted = t.port.posted.length;
    t.page.request("g.run", { b }, { request: "req-2", epoch: 1, payload: { code: "y" } }); // (fed to the closed socket)
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(t.page.st.writes.length, writes, "nothing written for a late frame");
    assert.equal(t.port.posted.length, posted, "nothing posted");
    const stale = t.s.gateway.stats.staleOutputs;
    w.onMessage({ id: r.workerId, done: true, ms: 1 });
    assert.equal(t.s.gateway.stats.staleOutputs, stale + 1, "the old Worker's output dropped, counted");
    census(t.s);
  } finally { await t.s.close(); }
});
test("L40 server.close(): the Worker terminated", async () => {
  const t = await setup();
  await bind(t.page);
  const w = t.port.last();
  await t.s.close();
  assert.equal(w.terminated, true);
  census(t.s);
});

// ================= 4.7 The authentication-to-dispatch fence [S2, G1]

/** Requests held between their decode and their authentication, by their socket and frame id (frame ids repeat
 * across sockets: each page counts from t1), until released. */
function holder() {
  const ids = new WeakMap<object, Set<string>>(), waiting = new Map<string, () => void>(), names = new WeakMap<object, number>();
  const all = new Set<string>(); // (every held id, of any socket: only control Y42j-idonly reads it)
  let n = 0;
  const key = (c: object, id: string) => { if (!names.has(c)) names.set(c, ++n); return `${names.get(c)}:${id}`; };
  return {
    hold: (id: string, c: object) => (ids.get(c)?.has(id) ? new Promise<void>((r) => waiting.set(key(c, id), r)) : Promise.resolve()),
    add: (c: object, id: string) => { let s = ids.get(c); if (!s) ids.set(c, (s = new Set())); s.add(id); all.add(id); },
    held: (c: object, id: string) => waiting.has(key(c, id)),
    release: (c: object, id: string) => { const k = key(c, id); const r = waiting.get(k); waiting.delete(k); r?.(); },
  };
}
/** A request whose authentication is held (only it: its socket and id): the request, and its release. */
async function heldRequest(H: ReturnType<typeof holder>, page: ReturnType<typeof newPage>, rpc: string, ref: any, body?: unknown) {
  const id = page.nextId();
  H.add(page.c, id);
  const r = page.request(rpc, ref, body, { id });
  await until(() => H.held(page.c, id), `${rpc} held`);
  return { ...r, held: () => H.held(page.c, id), release: () => H.release(page.c, id) };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
/** A fence case: its held requests refused by the guard it names, each counted (G-open: closed; G-gen: stale). */
async function fenced(name: string, want: { closed: number; stale: number }, f: (t: any, H: ReturnType<typeof holder>) => Promise<void>) {
  test(name, async () => {
    const H = holder();
    const t: any = await setup({ gateway: { authHold: H.hold } });
    try {
      const before = { ...t.s.gateway.stats.fenced };
      await f(t, H);
      assert.deepEqual({ closed: t.s.gateway.stats.fenced.closed - before.closed, stale: t.s.gateway.stats.fenced.stale - before.stale }, want, "refused by its own guard");
      assert.equal(t.s.gateway.stats.invariantFailures, 0);
      census(t.s);
    } finally { await t.s.close(); }
  });
}
// across sockets (G-open)
fenced("L42a a held g.run, then the socket closes: nothing admitted, nothing sent", { closed: 1, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x" } });
  const writes = t.page.st.writes.length, posted = t.port.posted.length;
  t.page.st.emit("close");
  r.release(); await settle();
  assert.equal(t.s.gateway.binding.runs.size, 0, "nothing admitted");
  assert.equal(t.port.posted.length, posted);
  assert.equal(t.page.st.writes.length, writes, "nothing sent");
});
fenced("L42b a held g.run, then an unpair: nothing admitted, nothing sent", { closed: 1, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x" } });
  const posted = t.port.posted.length;
  t.page.c.feed(maskedText({ unpair: true }));
  const writes = t.page.st.writes.length;
  r.release(); await settle();
  assert.equal(t.port.posted.length, posted, "nothing admitted or posted");
  assert.equal(t.page.st.writes.length, writes, "nothing sent");
});
fenced("L42c a held g.run, then a rebind: no admission in the new binding, no answer on the new socket", { closed: 1, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x" } });
  const { p2, b2 } = await rebind(t);
  const posted = t.port.posted.length, w2 = p2.st.writes.length;
  r.release(); await settle();
  assert.equal(t.s.gateway.binding.id, b2);
  assert.equal(t.s.gateway.binding.runs.size, 0, "no admission in the new binding");
  assert.equal(t.port.posted.length, posted);
  assert.equal(p2.st.writes.length, w2, "no answer on the new socket");
});
fenced("L42d a held g.interrupt and a held g.restart, then a rebind: the new Worker neither interrupted nor restarted", { closed: 2, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const i = await heldRequest(H, t.page, "g.interrupt", { b }, { epoch: 1 });
  const rs = await heldRequest(H, t.page, "g.restart", { b }, { epoch: 1 });
  const { p2 } = await rebind(t);
  const w = t.port.last(), started = t.s.gateway.stats.workersStarted, w2 = p2.st.writes.length;
  i.release(); rs.release(); await settle();
  assert.deepEqual(w.interrupts, [], "not interrupted");
  assert.equal(w.terminated, false);
  assert.equal(t.s.gateway.stats.workersStarted, started, "not restarted");
  assert.equal(p2.st.writes.length, w2);
});
fenced("L42e a held g.complete, then a rebind: nothing delivered into the new binding", { closed: 1, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const c = await heldRequest(H, t.page, "g.complete", { b }, { epoch: 1, code: "x" });
  const { p2 } = await rebind(t);
  const posted = t.port.posted.length, w2 = p2.st.writes.length;
  c.release(); await settle();
  assert.equal(t.port.posted.length, posted, "no completion posted to the new Worker");
  assert.equal(p2.st.writes.length, w2);
});
fenced("L42i a held g.bind, then an unpair: no binding created", { closed: 1, stale: 0 }, async (t, H) => {
  const r = await heldRequest(H, t.page, "g.bind", {}, {});
  t.page.c.feed(maskedText({ unpair: true }));
  r.release(); await settle();
  assert.equal(t.s.gateway.binding, null);
  assert.equal(t.s.gateway.stats.workersStarted, 0, "no Worker started");
});
fenced("L42j a held g.bind, then a replacement (socket B pairs and binds): A's bind has no effect, B's binding untouched", { closed: 1, stale: 0 }, async (t, H) => {
  const r = await heldRequest(H, t.page, "g.bind", {}, {});
  t.page.st.emit("close");
  const p2 = newPage(t.s, t.clk, t.page.key);
  const b2 = await bind(p2); // (B's own t1 progresses: only A's t1 is held)
  assert.ok(r.held(), "A's bind still held while B binds");
  const before = { ...t.s.gateway.binding }, started = t.s.gateway.stats.workersStarted;
  r.release(); await settle();
  assert.equal(t.s.gateway.binding.id, b2);
  assert.equal(t.s.gateway.binding.conn, p2.c, "B's binding untouched");
  assert.equal(t.s.gateway.binding.gen, before.gen);
  assert.equal(t.s.gateway.stats.workersStarted, started);
});
fenced("L42k a held g.takeover, then the socket closes: no epoch change", { closed: 1, stale: 0 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.takeover", { b }, { from_epoch: 1 });
  t.page.st.emit("close");
  r.release(); await settle();
  assert.equal(t.s.gateway.binding.epoch, 1, "no epoch change");
});
// on the same open socket (G-gen)
fenced("L42f a held g.interrupt, then a g.restart completes on the same socket: the interrupt 409 stale, the new Worker not interrupted", { closed: 0, stale: 1 }, async (t, H) => {
  const b = await bind(t.page);
  const i = await heldRequest(H, t.page, "g.interrupt", { b }, { epoch: 1 });
  assert.equal((await t.page.request("g.restart", { b }, { epoch: 1 }).answer()).status, 200);
  const w2 = t.port.last();
  i.release();
  const a = await i.answer();
  assert.equal(a.status, 409);
  assert.equal(bodyOf(a).error, "stale");
  assert.deepEqual(w2.interrupts, []);
});
fenced("L42g a held g.run, then a g.takeover on the same socket: 409 stale, zero admissions", { closed: 0, stale: 1 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x" } });
  assert.equal((await t.page.request("g.takeover", { b }, { from_epoch: 1 }).answer()).status, 200);
  r.release();
  const a = await r.answer();
  assert.equal(a.status, 409);
  assert.equal(bodyOf(a).error, "stale");
  assert.equal(t.s.gateway.binding.runs.size, 0);
});
fenced("L42h a held g.complete, then the 2 s fallback: 409 stale; nothing delivered, no completion to the new Worker", { closed: 0, stale: 1 }, async (t, H) => {
  const b = await bind(t.page);
  const run = await admitRun(t, b, "req-1");
  const c = await heldRequest(H, t.page, "g.complete", { b }, { epoch: 1, code: "x" });
  assert.equal((await t.page.request("g.interrupt", { b }, { epoch: 1 }).answer()).status, 200);
  t.clk.advance(GATEWAY_LIMITS.fallbackMs); // (the scripted Worker ignores the interrupt)
  assert.equal(t.s.gateway.stats.fallbacks, 1);
  const w2 = t.port.last();
  c.release();
  const a = await c.answer();
  assert.equal(a.status, 409);
  assert.equal(bodyOf(a).error, "stale");
  assert.ok(!w2.posted.some((m: any) => m.complete !== undefined), "no completion dispatched to the new Worker");
  void run;
});
fenced("L42l a held g.takeover, then a g.restart on the same socket: 409 stale, no epoch change", { closed: 0, stale: 1 }, async (t, H) => {
  const b = await bind(t.page);
  const r = await heldRequest(H, t.page, "g.takeover", { b }, { from_epoch: 1 });
  assert.equal((await t.page.request("g.restart", { b }, { epoch: 1 }).answer()).status, 200);
  r.release();
  const a = await r.answer();
  assert.equal(a.status, 409);
  assert.equal(bodyOf(a).error, "stale");
  assert.equal(t.s.gateway.binding.epoch, 1, "no epoch change");
});
test("L42-inv the fence's invariant fails closed: an open conn that is no longer the paired one (forced): no effect, nothing sent, counted", async () => {
  const H = holder();
  const t: any = await setup({ gateway: { authHold: H.hold } });
  try {
    const b = await bind(t.page);
    const r = await heldRequest(H, t.page, "g.run", { b }, { request: "req-1", epoch: 1, payload: { code: "x" } });
    const writes = t.page.st.writes.length, posted = t.port.posted.length;
    t.s.pairedConn = null; // (unreachable in this code: pairedConn is cleared only after closed is set; forced here)
    r.release(); await settle();
    assert.equal(t.s.gateway.stats.invariantFailures, 1, "counted");
    assert.equal(t.s.gateway.binding.runs.size, 0, "no effect");
    assert.equal(t.port.posted.length, posted);
    assert.equal(t.page.st.writes.length, writes, "nothing sent");
    census(t.s);
  } finally { await t.s.close(); }
});
test("L43 old-generation Worker output after a restart and after the fallback: dropped and counted; it reaches no run or answer of the new generation", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const r1 = await admitRun(t, b, "req-1");
    const w1 = t.port.last();
    assert.equal((await t.page.request("g.restart", { b }, { epoch: 1 }).answer()).status, 200);
    const r2 = await admitRun(t, b, "req-2", "y = 2");
    const w2 = t.port.last();
    const run2 = t.s.gateway.binding!.runs.get("req-2")!;
    const ev2 = run2.events.length, stale = t.s.gateway.stats.staleOutputs;
    w1.onMessage({ id: r1.workerId, stream: "stdout", text: "late" });
    w1.onMessage({ id: r2.workerId, stream: "stdout", text: "late, with the new run's id" });
    w1.onMessage({ id: r2.workerId, done: true, ms: 1 });
    w1.onMessage({ id: r2.workerId, matches: ["late"], prefix: "" });
    assert.equal(t.s.gateway.stats.staleOutputs, stale + 4, "each dropped, counted");
    assert.equal(run2.events.length, ev2, "nothing reached the new run");
    assert.equal(run2.outcome, null);
    // and after the fallback
    assert.equal((await t.page.request("g.interrupt", { b }, { epoch: 1 }).answer()).status, 200);
    t.clk.advance(GATEWAY_LIMITS.fallbackMs);
    assert.notEqual(t.port.last(), w2, "a new Worker");
    const r3 = await admitRun(t, b, "req-3", "z = 3");
    const run3 = t.s.gateway.binding!.runs.get("req-3")!;
    const s2 = t.s.gateway.stats.staleOutputs;
    w2.onMessage({ id: r3.workerId, done: true, ms: 1 });
    assert.equal(t.s.gateway.stats.staleOutputs, s2 + 1);
    assert.equal(run3.outcome, null, "the new generation's run untouched");
    r3.finish();
  } finally { await t.s.close(); }
});

// ================= the real Worker (cases v3 §6): L33, L36

const CLI_ENTRY = join(__dirname, "..", "src", "cli.js");
/** A server whose gateway runs the production port (src/notebook.ts's Worker, dist/src/cli.js as the entry), each
 * Worker's own messages and exit seen by the test (the observer runs before the gateway's listener). */
async function setupReal(o: { gateway?: any } = {}) {
  const clk = clock();
  const seen = { workers: [] as any[], msgs: [] as any[][], exits: [] as number[], onMsg: null as null | ((m: any, k: number) => void) };
  const dir = mkdtempSync(join(tmpdir(), "lk-real-"));
  const port = workerPort(dir, CLI_ENTRY, (w) => {
    const k = seen.workers.length;
    seen.workers.push(w);
    seen.msgs.push([]);
    w.on("message", (m: any) => { seen.msgs[k].push(m); seen.onMsg?.(m, k); });
    w.on("exit", () => seen.exits.push(k));
    w.unref(); // (a control that leaves a Worker running mustn't keep the run's process alive)
  });
  const s = new PairServer({ timers: clk, err: () => {}, gateway: { port, ...(o.gateway ?? {}) } });
  const page = newPage(s, clk);
  return { s, clk, page, seen, dir };
}
const sawMsg = (t: any, pred: (m: any) => boolean) => t.seen.msgs.some((a: any[]) => a.some(pred));
const LOOP = "import time\nwhile True:\n    time.sleep(0.005)\n";
/** The hold (L33b, L36f-fb-B, L36f-fb-wave's entry 100): a program that ignores the interrupt, import-free.  Its ready
 * marker is the first statement inside the inner try, so it prints only once the handler is active; the outer try
 * covers the loop's header between iterations; KeyboardInterrupt is caught at both levels. */
const HOLD = "try:\n    while True:\n        try:\n            print(\"lk-hold-ready\", flush=True)\n            while True:\n                pass\n        except KeyboardInterrupt:\n            pass\nexcept KeyboardInterrupt:\n    pass\n";
/** The hold's ready marker, on that run's own stdout (the exact line), within a bound that fails in its own words. */
const waitReady = (t: any, workerId: number) =>
  until(() => sawMsg(t, (m) => m.id === workerId && m.stream === "stdout" && String(m.text ?? "").split("\n").includes("lk-hold-ready")), "the hold's ready marker (lk-hold-ready)", 30_000);
/** After the interrupt and before the fake clock moves: the held run still live (no done for it, no outcome, no
 * Worker exit), after a 300 ms window for the Worker's messages to arrive. */
async function liveAfterInterrupt(t: any, run: any, workerId: number) {
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!sawMsg(t, (m) => m.id === workerId && m.done), "live after the interrupt: no done");
  assert.equal(run.outcome, null, "live after the interrupt: no outcome");
  assert.deepEqual(t.seen.exits, [], "live after the interrupt: the Worker up");
}
/** The 2 s fallback, witnessed: the hold ready, the interrupt, still live, then the clock: the fallback fires and the
 * held Worker exits. */
async function fallbackWitnessed(t: any, run: any, workerId: number) {
  await waitReady(t, workerId);
  const b = t.s.gateway.binding.id;
  assert.equal((await t.page.request("g.interrupt", { b }, { epoch: t.s.gateway.binding.epoch }).answer()).status, 200);
  await liveAfterInterrupt(t, run, workerId);
  t.clk.advance(GATEWAY_LIMITS.fallbackMs);
  assert.equal(t.s.gateway.stats.fallbacks, 1, "the fallback fired");
  await until(() => t.seen.exits.includes(0), "the held Worker's exit event", 30_000);
}
/** A g.run body of exactly n UTF-8 bytes (TextEncoder's count): `code0`, then a comment of 3-byte characters. */
function runBodyOfBytes(n: number, request: string, code0: string) {
  const mk = (pad: string) => JSON.stringify({ request, epoch: 1, payload: { code: code0 + "# " + pad + "\n" } });
  const u8 = (x: string) => new TextEncoder().encode(x).length;
  const room = n - u8(mk(""));
  const s = mk("€".repeat(Math.floor(room / 3)) + "a".repeat(room % 3));
  assert.equal(u8(s), n, "the oracle's count");
  return s;
}
async function startReal(t: any, b: string, request: string, code: string) {
  const a = await t.page.request("g.run", { b }, typeof code === "string" && code.startsWith("{") ? code : { request, epoch: 1, payload: { code } }).answer();
  assert.equal(a.status, 202, a.body);
  const run = t.s.gateway.binding!.runs.get(request)!;
  await until(() => sawMsg(t, (m) => m.id === run.workerId && m.start), `${request}: the Worker's start`, 60_000);
  return run;
}

test("L33a Stop on the real Worker: the run ends when the Worker says it ended", async () => {
  const t = await setupReal();
  try {
    const b = await bind(t.page);
    const run = await startReal(t, b, "loop", LOOP);
    assert.equal((await t.page.request("g.interrupt", { b }, { epoch: 1 }).answer()).status, 200);
    assert.equal(run.outcome, null, "not ended at the request");
    await until(() => run.outcome !== null, "the run's end", 30_000);
    assert.ok(sawMsg(t, (m) => m.id === run.workerId && m.done), "the Worker said it ended");
    assert.notEqual(run.outcome!.status, "stopped", "its own end, not the fallback's");
    assert.equal(t.s.gateway.stats.fallbacks, 0);
  } finally { await t.s.close(); }
});
test("L33b the fallback on the fake clock, the real Worker ignoring the interrupt: not at 1999 ms; at 2000 ms terminated (its exit) and restarted (a new generation answers a run), the run stopped; all within 60 s", async () => {
  const t0 = Date.now();
  const t = await setupReal();
  try {
    const b = await bind(t.page);
    const run = await startReal(t, b, "hold", HOLD);
    await waitReady(t, run.workerId);
    assert.equal((await t.page.request("g.interrupt", { b }, { epoch: 1 }).answer()).status, 200);
    await liveAfterInterrupt(t, run, run.workerId);
    t.clk.advance(GATEWAY_LIMITS.fallbackMs - 1);
    assert.equal(t.s.gateway.stats.fallbacks, 0, "not at 1999 ms");
    assert.equal(run.outcome, null);
    assert.equal(t.seen.workers.length, 1);
    t.clk.advance(1);
    assert.equal(t.s.gateway.stats.fallbacks, 1, "at 2000 ms");
    assert.deepEqual(run.outcome, { status: "stopped", reason: "fallback" });
    await until(() => t.seen.exits.includes(0), "the old Worker's exit event", 30_000);
    assert.equal(t.seen.workers.length, 2, "restarted");
    const next = await startReal(t, b, "after", "x = 41 + 1\n");
    await until(() => next.outcome !== null, "the new generation's run", 30_000);
    assert.equal(next.outcome!.status, "ok");
    assert.ok(Date.now() - t0 < 60_000, "the real-time sanity bound");
  } finally { await t.s.close(); }
});

// ================= 4.8 Payload

test("L36a-c on the real Worker: a held run of exactly BODY_MAX.run bytes charged gateway- and Worker-owned, 0 only after its end; L36b a 64 KiB completion: peak 2,424,832; L36c another run and completion busy, uncharged", async () => {
  const t = await setupReal();
  try {
    const b = await bind(t.page);
    const g = t.s.gateway;
    const r = t.page.request("g.run", { b }, runBodyOfBytes(BODY_MAX.run, "big", LOOP));
    // (gateway-owned: read as the frame's decode returns, before the dispatch microtask)
    assert.equal(g.stats.queuedPayloadBytes, BODY_MAX.run, "gateway-owned: charged its size");
    assert.equal(g.stats.rawBodyRefs, 0, "no raw body held");
    assert.ok(g.runSlot && "rpc" in (g.runSlot as any), "held by its request");
    assert.equal((await r.answer()).status, 202);
    const run = g.binding!.runs.get("big")!;
    await until(() => sawMsg(t, (m) => m.id === run.workerId && m.start), "the Worker's start", 60_000);
    assert.equal(run.owner, "worker");
    assert.equal(g.stats.queuedPayloadBytes, BODY_MAX.run, "Worker-owned: the same charge (not 0 at postMessage)");
    assert.equal(g.stats.rawBodyRefs, 0);
    // L36b
    const c = t.page.request("g.complete", { b }, bodyOfBytes(BODY_MAX.other, { epoch: 1, code: "pri" }));
    await until(() => g.completeWaiter !== null, "the completion dispatched");
    assert.equal(g.stats.maxQueuedPayloadBytes, 2_424_832, "the peak: one run and one completion");
    // L36c
    const held = g.stats.queuedPayloadBytes;
    const r2 = await t.page.request("g.run", { b }, { request: "other", epoch: 1, payload: { code: "y = 1" } }).answer();
    assert.equal(r2.status, 409); assert.equal(bodyOf(r2).error, "busy");
    const c2 = await t.page.request("g.complete", { b }, { epoch: 1, code: "y" }).answer();
    assert.equal(c2.status, 409); assert.equal(bodyOf(c2).error, "busy");
    assert.equal(g.stats.queuedPayloadBytes, held, "neither charged");
    // the end: the charge is 0 only after the Worker's done for that run
    let atDone = -1;
    t.seen.onMsg = (m) => { if (m.id === run.workerId && m.done) atDone = g.stats.queuedPayloadBytes; };
    assert.equal((await t.page.request("g.interrupt", { b }, { epoch: 1 }).answer()).status, 200);
    await until(() => run.outcome !== null, "the run's end", 30_000);
    assert.ok(atDone >= BODY_MAX.run, `still charged when the Worker's done arrived (${atDone})`);
    assert.equal((await c.answer()).status, 200, "the completion answered after the run");
    await until(() => g.stats.queuedPayloadBytes === 0, "the charge 0");
    census(t.s);
  } finally { await t.s.close(); }
});
test("L36d one write of 8 max-body g.run frames: one admitted, seven 409 busy after auth, uncharged, the peak one body; likewise 8 g.complete frames", async () => {
  const t = await setup();
  try {
    const b = await bind(t.page);
    const g = t.s.gateway;
    const runs = Array.from({ length: 8 }, (_, k) => t.page.frameOf("g.run", { b }, runBodyOfBytes(BODY_MAX.run, `r${k}`, "x = 1\n")));
    t.page.c.feed(Buffer.concat(runs.map((f) => f.bytes)));
    const ra = await Promise.all(runs.map((f) => waitFor(t.page.st, f.id)));
    assert.deepEqual(ra.map((a) => a.status).sort(), [202, 409, 409, 409, 409, 409, 409, 409]);
    assert.ok(ra.filter((a) => a.status === 409).every((a) => bodyOf(a).error === "busy"), "busy, after authentication");
    assert.deepEqual(g.stats.authRefusals, {}, "every one authenticated");
    assert.equal(g.stats.maxQueuedPayloadBytes, BODY_MAX.run, "the peak: one body");
    assert.equal(g.stats.queuedPayloadBytes, BODY_MAX.run);
    const comps = Array.from({ length: 8 }, () => t.page.frameOf("g.complete", { b }, bodyOfBytes(BODY_MAX.other, { epoch: 1, code: "c" })));
    t.page.c.feed(Buffer.concat(comps.map((f) => f.bytes)));
    await until(() => comps.filter((f) => texts(t.page.st).some((x: any) => x.id === f.id && x.status === 409)).length === 7, "seven completions busy");
    // The admitted completion is held by the scripted Worker until its reply below.  Its post and the seven busy
    // answers are independent continuations: seeing the refusals does not order the post (L36d's CI flake).
    await until(() => t.port.posted.filter((m) => m.complete !== undefined).length === 1, "one completion admitted");
    assert.equal(t.port.posted.filter((m) => m.complete !== undefined).length, 1, "one completion admitted");
    assert.equal(g.stats.maxQueuedPayloadBytes, BODY_MAX.run + BODY_MAX.other);
    const cm = t.port.posted.find((m) => m.complete !== undefined);
    t.port.last().onMessage({ id: cm.id, matches: [], prefix: "" });
    const admitted = runs[ra.findIndex((a) => a.status === 202)];
    void admitted;
    const rm = t.port.posted.find((m) => typeof m.code === "string");
    t.port.last().onMessage({ id: rm.id, done: true, ms: 1 });
    await until(() => g.stats.queuedPayloadBytes === 0, "released");
    census(t.s);
  } finally { await t.s.close(); }
});
/** A 256-entry wave whose whole g.run body is exactly `n` bytes (ASCII padding, spread over the entries). */
function waveBodyOfBytes(n: number, request: string, codeOf: (k: number) => string) {
  const mk = (pads: string[]) => JSON.stringify({ request, epoch: 1, kind: "wave", payload: wave(pads.map((p, k) => entry(k, codeOf(k) + "# " + p + "\n"))) });
  const base = Buffer.byteLength(mk(Array(256).fill("")), "utf8");
  const room = n - base;
  const pads = Array.from({ length: 256 }, (_, k) => "a".repeat(Math.floor(room / 256) + (k === 255 ? room % 256 : 0)));
  const s = mk(pads);
  assert.equal(new TextEncoder().encode(s).length, n);
  return s;
}
test("L36e a 256-entry wave at the body cap, on the real Worker: wave-owned until its terminal; after each dispatch the entry's code gone; no raw body; one charge, 0 at the terminal", async () => {
  const t = await setupReal();
  try {
    const b = await bind(t.page);
    const g = t.s.gateway;
    const checks: string[] = [];
    let run: any = null;
    t.seen.onMsg = (m) => {
      if (!run || !m.start || m.id !== run.workerId) return;
      const k = run.current;
      if (run.owner !== "wave") checks.push(`entry ${k}: owner ${run.owner}`);
      for (let j = 0; j <= k; j++) if (run.wave.entries[j].code !== undefined) checks.push(`entry ${k}: entry ${j}'s code kept`);
      if (g.stats.rawBodyRefs !== 0) checks.push(`entry ${k}: a raw body`);
      if (g.stats.queuedPayloadBytes !== BODY_MAX.run) checks.push(`entry ${k}: charge ${g.stats.queuedPayloadBytes}`);
    };
    const a = await t.page.request("g.run", { b }, waveBodyOfBytes(BODY_MAX.run, "w", (k) => `v${k} = ${k}\n`)).answer();
    assert.equal(a.status, 202, a.body);
    run = g.binding!.runs.get("w")!;
    assert.equal(run.owner, "wave");
    await until(() => run.outcome !== null, "the wave's terminal", 120_000);
    assert.deepEqual(checks, [], "at every entry's start");
    assert.deepEqual(run.outcome, { status: "done" });
    assert.equal(g.stats.queuedPayloadBytes, 0, "0 at the terminal");
    assert.equal(run.owner, null);
    census(t.s);
  } finally { await t.s.close(); }
});

// L36f: the charge returns to 0 on every cleanup path [G1]: (A) a held run and a held completion, both
// gateway-owned (held at authentication), and (B) a Worker-owned run with a dispatched completion
type Path = "err" | "exit" | "fb" | "unpair" | "rebind" | "close";
async function cleanup(t: any, path: Path) {
  const k = t.seen.workers.length - 1;
  if (path === "err") t.seen.workers[k].emit("error", new Error("an error from the Worker (L36f-err)"));
  else if (path === "exit") await t.seen.workers[k].terminate();
  else if (path === "fb") throw new Error("the fallback path is fallbackWitnessed (it needs the held run)");
  else if (path === "unpair") t.page.c.feed(maskedText({ unpair: true }));
  else if (path === "rebind") { t.page.st.emit("close"); t.clk.advance(GATEWAY_LIMITS.idleMs); newPage(t.s, t.clk, t.page.key); }
  else await t.s.close();
}
for (const path of ["err", "exit", "unpair", "rebind", "close"] as Path[]) {
  test(`L36f-${path}-A a gateway-owned held run and completion: the charge returns to 0`, async () => {
    const H = holder();
    const t: any = await setupReal({ gateway: { authHold: H.hold } });
    try {
      const b = await bind(t.page);
      const r = await heldRequest(H, t.page, "g.run", { b }, { request: "held", epoch: 1, payload: { code: "x = 1\n" } });
      const c = await heldRequest(H, t.page, "g.complete", { b }, bodyOfBytes(BODY_MAX.other, { epoch: 1, code: "c" }));
      assert.ok(t.s.gateway.stats.queuedPayloadBytes > 0);
      await cleanup(t, path);
      r.release(); c.release();
      await until(() => t.s.gateway.stats.queuedPayloadBytes === 0, `${path}: the charge 0`, 30_000);
      census(t.s);
    } finally { await t.s.close(); }
  });
}
for (const path of ["err", "exit", "fb", "unpair", "rebind", "close"] as Path[]) {
  test(`L36f-${path}-B a Worker-owned run and a dispatched completion: the charge returns to 0`, async () => {
    const t: any = await setupReal();
    try {
      const b = await bind(t.page);
      const run = await startReal(t, b, "held", path === "fb" ? HOLD : LOOP);
      t.page.request("g.complete", { b }, bodyOfBytes(BODY_MAX.other, { epoch: 1, code: "c" }));
      await until(() => t.s.gateway.completeWaiter !== null, "the completion dispatched");
      assert.ok(t.s.gateway.stats.queuedPayloadBytes > BODY_MAX.other, "the run and the completion charged");
      if (path === "fb") await fallbackWitnessed(t, run, run.workerId);
      else await cleanup(t, path);
      await until(() => t.s.gateway.stats.queuedPayloadBytes === 0, `${path}: the charge 0`, 30_000);
      census(t.s);
    } finally { await t.s.close(); }
  });
}
test("L36f-fb-wave mid-wave: L36e's wave, its entry 100 ignoring the interrupt; the fallback returns the charge to 0", async () => {
  const t: any = await setupReal();
  try {
    const b = await bind(t.page);
    const a = await t.page.request("g.run", { b }, waveBodyOfBytes(BODY_MAX.run, "w", (k) => (k === 100 ? HOLD : `v${k} = ${k}\n`))).answer();
    assert.equal(a.status, 202);
    const run = t.s.gateway.binding.runs.get("w");
    await until(() => run.current === 100 && sawMsg(t, (m) => m.id === run.workerId && m.start), "entry 100 running", 120_000);
    await fallbackWitnessed(t, run, run.workerId);
    await until(() => t.s.gateway.stats.queuedPayloadBytes === 0, "the charge 0", 30_000);
    assert.equal(run.outcome.status, "stopped");
    census(t.s);
  } finally { await t.s.close(); }
});

// ================= 4.10 The fake census: fail closed [S3, G6]

const tsapi = require("typescript-api");
/** The bare packages the CLI bundle may import (astra's ruling on the L41 boundary): reviewed, each pinned to its exact
 * version and its reviewed importers.  A TRUSTED boundary: the census does not walk into them, and a listed package
 * could itself import files of this tree, so the list is what the census checks, not proof of all Bun bundles. */
const BUNDLED_PACKAGES: Record<string, { version: string; importers: string[] }> = {
  "marked": { version: "18.0.14", importers: ["web/board/svg.ts"] },
  "mathjax-full": { version: "3.2.2", importers: ["src/board-math.ts"] },
  // (`sagebrush latex`'s math: src/latex-cli.ts, in its own lazily loaded file, LAZY_REVIEWED below)
  "katex": { version: "0.19.0", importers: ["src/latex-cli.ts"] },
};
/** The closure's reviewed lazily loaded modules: file -> {fn, target, sha256}. `sagebrush latex`'s module,
 * src/latex-cli.ts, is built as its own file beside the bundle (scripts/build-cli.mjs) and loaded by path only by
 * src/cli.ts's loadLatex, through createRequire. That one createRequire is accepted only inside that function, once,
 * and only while the function's whole source (whitespace runs as one space: fnPin) is the reviewed one, its sha256 here:
 * what the returned require loads (its fixed candidates, all sagebrush-latex.cjs) is part of what is pinned, so any
 * change to the loader fails until it is reviewed and the pin renewed (astra's L41-LAZY-1). The census then follows it
 * into the target, whose closure is checked like the rest; any other createRequire fails.
 * (Renewed for the relocatable lookup: loadLatex looks first beside the CLI's real entry, the launcher's worker naming
 * the bundle, then where it looked before; the candidates are still only files named sagebrush-latex.cjs.) */
const LAZY_REVIEWED: Record<string, { fn: string; target: string; sha256: string }> = {
  "src/cli.ts": { fn: "loadLatex", target: "src/latex-cli.ts", sha256: "1f552beb751df4236041c510b167762f1646cad48ddb68dfdd849a6bdb720303" },
};
/** The lockfile's package entries, parsed exactly (the `packages:` section's `name@version:` keys). */
function lockEntries(root: string) {
  const out = new Set<string>();
  let inPackages = false;
  for (const line of readFileSync(join(root, "pnpm-lock.yaml"), "utf8").split("\n")) {
    if (/^\S/.test(line)) inPackages = line === "packages:";
    else if (inPackages) { const m = /^  '?([^\s':]+@[^\s':()]+)'?:\s*$/.exec(line); if (m) out.add(m[1]); }
  }
  return out;
}
const { builtinModules } = require("node:module");
const REPO = join(__dirname, "..", "..");
const FAKE = "web/notebook/remote-fake.js";
const CANON_ENTRY = "require.main?.filename ?? process.argv[1]";
/** The closure's reviewed dynamic-code sites: the compiler's generated accessors and numpy's kernels, each a
 * `new Function` over its own parameters with no module in reach; their count per file, exactly (any other fails). */
const DYNAMIC_REVIEWED: Record<string, number> = { "src/runtime/index.ts": 1, "src/runtime/numpy.ts": 3, "src/runtime/object.ts": 4 };
/** The function declaration a node is in, or null. */
function enclosingFn(n: any): any {
  for (let p = n.parent; p; p = p.parent) if (tsapi.isFunctionDeclaration(p)) return p;
  return null;
}
/** A function declaration's pin: the sha256 of its source, each run of whitespace one space. */
const fnPin = (f: any, sf: any) => createHash("sha256").update(f.getText(sf).replace(/\s+/g, " ")).digest("hex");
/** The runtime module closure of `entry` under root's tsconfig: every import / export-from, import-equals, require()
 * and import() edge (type-only imports are not runtime), resolved with ts.resolveModuleName; it fails closed (a
 * problem) on a non-literal require or import(), eval, createRequire, X.require(), a Worker whose entry isn't the
 * CLI's own, an unreviewed `new Function`, an unresolved relative specifier, and a bare specifier that is neither a
 * node builtin nor a package.json dependency. */
function runtimeClosure(root: string, entry: string, reviewed: Record<string, number> = {}, lazy: Record<string, { fn: string; target: string; sha256: string }> = {}) {
  const cfg = tsapi.readConfigFile(join(root, "tsconfig.json"), tsapi.sys.readFile);
  const options = { ...tsapi.parseJsonConfigFileContent(cfg.config ?? {}, tsapi.sys, root).options, allowJs: true };
  const locks = lockEntries(root);
  const files = new Set<string>(), problems: string[] = [], dyn: Record<string, number> = {}, resolved: string[] = [], lazySeen: Record<string, number> = {};
  const rel = (f: string) => relative(root, f).split(sep).join("/");
  const queue = [join(root, entry)];
  const canonDecl = new RegExp(`\\bentry(: string)? = ${CANON_ENTRY.replace(/[.?*+^$()[\]{}|\\]/g, "\\$&")}`);
  while (queue.length) {
    const f = queue.shift()!;
    const r = rel(f);
    if (files.has(r)) continue;
    files.add(r);
    const text = readFileSync(f, "utf8");
    const sf = tsapi.createSourceFile(f, text, tsapi.ScriptTarget.Latest, true);
    const at = (n: any) => `${r}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const spec = (n: any, x: string) => {
      if (x.startsWith("node:") || builtinModules.includes(x) || builtinModules.includes(x.split("/")[0])) return;
      if (!x.startsWith(".") && !x.startsWith("/")) {
        // a bare package: each condition its own refusal, in this order (the boundary's five checks)
        const pkg = x.startsWith("@") ? x.split("/").slice(0, 2).join("/") : x.split("/")[0];
        const pol = Object.prototype.hasOwnProperty.call(BUNDLED_PACKAGES, pkg) ? BUNDLED_PACKAGES[pkg] : undefined;
        if (!pol) { problems.push(`${at(n)}: not a reviewed bundled package: ${x}`); return; }
        if (!pol.importers.includes(r)) { problems.push(`${at(n)}: ${pkg} from an unreviewed importer`); return; }
        const res = tsapi.resolveModuleName(x, f, options, tsapi.sys).resolvedModule;
        if (!res) { problems.push(`${at(n)}: unresolved: ${x}`); return; }
        // its canonical root: the resolved file's real path inside node_modules/.pnpm/<entry>/node_modules/<pkg>/
        const store = realpathSync(join(root, "node_modules")) + sep + ".pnpm" + sep;
        const real = realpathSync(res.resolvedFileName);
        resolved.push(real);
        const inner = real.startsWith(store) ? real.slice(store.length).split(sep) : [];
        const depth = pkg.split("/").length;
        const pkgDir = inner.length > 2 + depth && inner[1] === "node_modules" && inner.slice(2, 2 + depth).join("/") === pkg ? store + inner.slice(0, 2 + depth).join(sep) : null;
        const pj = pkgDir ? JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) : null;
        if (!pkgDir || pj.name !== pkg) { problems.push(`${at(n)}: ${pkg} resolves outside its reviewed root or is not that package`); return; }
        if (pj.version !== pol.version) { problems.push(`${at(n)}: ${pkg} version ${pj.version}, reviewed ${pol.version}`); return; }
        if (!locks.has(`${pkg}@${pol.version}`)) { problems.push(`${at(n)}: ${pkg}@${pol.version} not in the lockfile`); return; }
        return;
      }
      const res = tsapi.resolveModuleName(x, f, options, tsapi.sys).resolvedModule;
      if (!res || res.isExternalLibraryImport || /\.d\.[mc]?ts$/.test(res.resolvedFileName)) problems.push(`${at(n)}: unresolved: ${x}`);
      else queue.push(res.resolvedFileName);
    };
    const visit = (n: any): void => {
      if ((tsapi.isImportDeclaration(n) || tsapi.isExportDeclaration(n)) && n.moduleSpecifier && tsapi.isStringLiteral(n.moduleSpecifier)) {
        if (!(n.importClause?.isTypeOnly || n.isTypeOnly)) spec(n, n.moduleSpecifier.text);
      } else if (tsapi.isImportEqualsDeclaration(n) && tsapi.isExternalModuleReference(n.moduleReference)) {
        const e = n.moduleReference.expression;
        if (tsapi.isStringLiteral(e)) spec(n, e.text); else problems.push(`${at(n)}: a non-literal import-equals`);
      } else if (tsapi.isCallExpression(n)) {
        const c = n.expression;
        const isReq = tsapi.isIdentifier(c) && c.text === "require", isImp = c.kind === tsapi.SyntaxKind.ImportKeyword;
        if (isReq || isImp) {
          const a = n.arguments[0];
          if (n.arguments.length === 1 && tsapi.isStringLiteralLike(a)) spec(n, a.text);
          else problems.push(`${at(n)}: a non-literal ${isReq ? "require" : "import()"}`);
        } else if (tsapi.isIdentifier(c) && c.text === "createRequire" && lazy[r] && enclosingFn(n)?.name?.text === lazy[r].fn) {
          const pin = fnPin(enclosingFn(n), sf);
          if (pin !== lazy[r].sha256) problems.push(`${at(n)}: createRequire in ${lazy[r].fn}, whose source isn't the reviewed one (its pin is ${pin})`);
          else { lazySeen[r] = (lazySeen[r] ?? 0) + 1; queue.push(join(root, lazy[r].target)); }
        } else if (tsapi.isIdentifier(c) && (c.text === "eval" || c.text === "createRequire")) problems.push(`${at(n)}: ${c.text}`);
        else if (tsapi.isPropertyAccessExpression(c) && c.name.text === "require") problems.push(`${at(n)}: ${c.getText(sf)}`);
      } else if (tsapi.isNewExpression(n) && tsapi.isIdentifier(n.expression)) {
        if (n.expression.text === "Function") dyn[r] = (dyn[r] ?? 0) + 1;
        else if (n.expression.text === "Worker") {
          const a = n.arguments?.[0];
          const ok = a && (a.getText(sf) === CANON_ENTRY || (tsapi.isIdentifier(a) && a.text === "entry" && canonDecl.test(text)));
          if (!ok) problems.push(`${at(n)}: a Worker whose entry isn't the CLI's own`);
        }
      }
      tsapi.forEachChild(n, visit);
    };
    visit(sf);
  }
  for (const [f, n] of Object.entries(dyn)) if (reviewed[f] !== n) problems.push(`${f}: ${n} new Function site(s), ${reviewed[f] ?? 0} reviewed`);
  for (const [f, l] of Object.entries(lazy)) if (files.has(f) && lazySeen[f] !== 1) problems.push(`${f}: ${lazySeen[f] ?? 0} reviewed lazy load(s) in ${l.fn}, 1 reviewed`);
  for (const f of Object.keys(reviewed)) if (!(f in dyn)) problems.push(`${f}: its reviewed new Function sites are gone`);
  return { files, problems, resolved };
}
const verdict = (c: { files: Set<string>; problems: string[] }) => (c.problems.length === 0 && !c.files.has(FAKE) ? "pass" : "fail");

test("L41 the production CLI's runtime closure: remote-fake.js not in it, nothing in it unaccounted for", () => {
  const c = runtimeClosure(REPO, "src/cli.ts", DYNAMIC_REVIEWED, LAZY_REVIEWED);
  assert.deepEqual(c.problems, [], "the census fails closed on nothing");
  assert.ok(c.files.has("src/latex-cli.ts") && c.files.has("web/latex/engine/render.mjs"), "the lazily loaded latex module and its closure are in it");
  assert.ok(c.files.has("src/local-gateway.ts") && c.files.has("src/notebook-pair.ts"), "the gateway is in it (the positive witness)");
  assert.equal(c.files.has(FAKE), false, "remote-fake.js is not in the closure");
  assert.equal(verdict(c), "pass");
});
/** A small tree for the census: tsconfig, package.json, the fake, and `files`. */
function fixtureTree(files: Record<string, string>, parent = tmpdir()) {
  const d = mkdtempSync(join(parent, "lk-census-"));
  const all: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs", target: "es2022", moduleResolution: "node", strict: false } }),
    "package.json": JSON.stringify({ name: "fx", dependencies: {} }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n",
    [FAKE]: "exports.faults = []; exports.intercept = 0; exports.raw = 0; exports.pause = 0; exports.soleAlways = 0; exports.applied = [];\n",
    ...files,
  };
  for (const [p, t] of Object.entries(all)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), t); }
  return d;
}
const fxCases: [string, Record<string, string>, "pass" | "fail"][] = [
  ["L41-fx1 a production-like file using the words raw, pause and applied passes", { "src/cli.ts": 'import { step } from "./x";\nexport const raw = 1;\nconst pause = () => 0;\nexport const applied = [raw, pause, step];\n', "src/x.ts": "export const step = 2;\n" }, "pass"],
  ["L41-fx2 a helper reaching remote-fake.js through require fails", { "src/cli.ts": 'import { x } from "./helper";\nexport const y = x;\n', "src/helper.ts": 'declare const require: any;\nconst f = require("../web/notebook/remote-fake.js");\nexport const x = f.faults;\n' }, "fail"],
  ["L41-fx3 through a re-export chain fails", { "src/cli.ts": 'import { faults } from "./a";\nexport const y = faults;\n', "src/a.ts": 'export * from "./b";\n', "src/b.ts": '// @ts-ignore\nexport { faults } from "../web/notebook/remote-fake.js";\n' }, "fail"],
  ["L41-fx4 a non-literal require fails", { "src/cli.ts": 'declare const require: any;\nconst p = "./x";\nexport const m = require(p);\n', "src/x.ts": "export const z = 1;\n" }, "fail"],
  ["L41-fx5 an unresolved relative import fails", { "src/cli.ts": 'import "./missing";\nexport const y = 1;\n' }, "fail"],
  ["L41-fx6 createRequire(…)(…) fails", { "src/cli.ts": 'import { createRequire } from "node:module";\nexport const f = createRequire(__filename)("../web/notebook/remote-fake.js");\n' }, "fail"],
];
for (const [name, files, want] of fxCases) {
  test(name, () => {
    const c = runtimeClosure(fixtureTree(files), "src/cli.ts");
    assert.equal(verdict(c), want, `${JSON.stringify([...c.files])} ${JSON.stringify(c.problems)}`);
  });
}
// (the reviewed lazy load, LAZY_REVIEWED: followed into its target, whose closure is checked like the rest; the same
// createRequire anywhere else fails)
const LOADER_FN = 'export function loadLatex() { return createRequire(__filename)("./lazy-built.cjs"); }';
const LOADER = 'import { createRequire } from "node:module";\n' + LOADER_FN + "\n";
const LAZY_FX = { "src/cli.ts": { fn: "loadLatex", target: "src/lazy.ts", sha256: createHash("sha256").update(LOADER_FN.replace(/\s+/g, " ")).digest("hex") } };
for (const [name, files, want] of [
  ["L41-lazy1 the reviewed lazy load, its target clean: pass", { "src/cli.ts": LOADER, "src/lazy.ts": "export const x = 1;\n" }, "pass"],
  ["L41-lazy2 the reviewed lazy load is followed: its target reaching remote-fake.js fails", { "src/cli.ts": LOADER, "src/lazy.ts": 'export * from "../web/notebook/remote-fake.js";\n' }, "fail"],
  ["L41-lazy3 createRequire in another function of the reviewed file fails", { "src/cli.ts": LOADER + "export function other() { return createRequire(__filename)(process.argv[1]); }\n", "src/lazy.ts": "export const x = 1;\n" }, "fail"],
  ["L41-lazy4 the reviewed lazy load twice in its function fails", { "src/cli.ts": 'import { createRequire } from "node:module";\nexport function loadLatex() { createRequire(__filename); return createRequire(__filename)(process.argv[1]); }\n', "src/lazy.ts": "export const x = 1;\n" }, "fail"],
  ["L41-lazy5 the reviewed loader's function loading another target (remote-fake.js) fails", { "src/cli.ts": 'import { createRequire } from "node:module";\nexport function loadLatex() { return createRequire(__filename)("../web/notebook/remote-fake.js"); }\n', "src/lazy.ts": "export const x = 1;\n" }, "fail"],
  ["L41-lazy6 the reviewed loader's returned handle kept and used again fails", { "src/cli.ts": 'import { createRequire } from "node:module";\nexport function loadLatex() { const r = createRequire(__filename); r("../web/notebook/remote-fake.js"); return r("./lazy-built.cjs"); }\n', "src/lazy.ts": "export const x = 1;\n" }, "fail"],
  ["L41-lazy7 the reviewed loader with a changed argument (process.argv[1]) fails", { "src/cli.ts": 'import { createRequire } from "node:module";\nexport function loadLatex() { return createRequire(__filename)(process.argv[1]); }\n', "src/lazy.ts": "export const x = 1;\n" }, "fail"],
] as [string, Record<string, string>, string][]) {
  test(name, () => {
    const c = runtimeClosure(fixtureTree(files), "src/cli.ts", {}, LAZY_FX);
    assert.equal(verdict(c), want, `${JSON.stringify([...c.files])} ${JSON.stringify(c.problems)}`);
  });
}
// ---- the boundary's fixtures (astra's L41 ruling): each negative violates exactly ONE of the five conditions and
// satisfies the other four; its refusal is checked by its own words.  Packages are stubbed in pnpm's layout:
// node_modules/.pnpm/<name>@<dirVersion>/node_modules/<name>/{package.json, files}, and node_modules/<name> a symlink.
// r3.2 (the r3.1 run's BASE failure): the stubs are TYPED (index.d.ts and `types`; mathjax-full's subpath its own
// js/mathjax.d.ts), because the resolver tries declarations in every ancestor's node_modules before a JS file: an
// untyped stub let a typed package above the fixture win.  So every fixture is made inside a parent that holds typed
// decoys of the same packages (POISON), whatever TMPDIR is, and each case asserts that every resolved file is inside
// its fixture: the hermeticity witness, on every host.
const STUB_TYPES = true;
const typed = (dts: Record<string, string>) => (STUB_TYPES ? dts : {});
const POISON: Record<string, string> = {
  "node_modules/marked/package.json": JSON.stringify({ name: "marked", version: "18.0.14", main: "index.js", types: "index.d.ts" }),
  "node_modules/marked/index.js": "module.exports = {};\n",
  "node_modules/marked/index.d.ts": "export declare const POISON: true;\n",
  "node_modules/mathjax-full/package.json": JSON.stringify({ name: "mathjax-full", version: "3.2.2" }),
  "node_modules/mathjax-full/js/mathjax.js": "exports.mathjax = {};\n",
  "node_modules/mathjax-full/js/mathjax.d.ts": "export declare const POISON: true;\n",
  "node_modules/katex/package.json": JSON.stringify({ name: "katex", version: "0.19.0", main: "index.js", types: "index.d.ts" }),
  "node_modules/katex/index.js": "module.exports = {};\n",
  "node_modules/katex/index.d.ts": "export declare const POISON: true;\n",
};
type Stub = { name: string; dirVersion: string; pj: { name: string; version: string }; files: Record<string, string> };
function stubbedTree(files: Record<string, string>, stubs: Stub[], lock: string[]) {
  const parent = mkdtempSync(join(tmpdir(), "lk-census-poisoned-"));
  for (const [p, t] of Object.entries(POISON)) { mkdirSync(dirname(join(parent, p)), { recursive: true }); writeFileSync(join(parent, p), t); }
  const d = fixtureTree({ ...files, "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\npackages:\n\n" + lock.map((e) => `  ${e}:\n    resolution: {integrity: sha512-x}\n`).join("\n") }, parent);
  for (const st of stubs) {
    const dir = join(d, "node_modules", ".pnpm", `${st.name}@${st.dirVersion}`, "node_modules", st.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...st.pj, main: "index.js", ...(STUB_TYPES ? { types: "index.d.ts" } : {}) }));
    for (const [p, t] of Object.entries({ "index.js": "module.exports = {};\n", ...typed({ "index.d.ts": "export {};\n" }), ...st.files })) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
    symlinkSync(join(".pnpm", `${st.name}@${st.dirVersion}`, "node_modules", st.name), join(d, "node_modules", st.name));
  }
  return d;
}
const MARKED: Stub = { name: "marked", dirVersion: "18.0.14", pj: { name: "marked", version: "18.0.14" }, files: {} };
const MATHJAX: Stub = { name: "mathjax-full", dirVersion: "3.2.2", pj: { name: "mathjax-full", version: "3.2.2" }, files: { "js/mathjax.js": "exports.mathjax = {};\n", ...typed({ "js/mathjax.d.ts": "export {};\n" }) } };
const CHALK: Stub = { name: "chalk", dirVersion: "5.3.0", pj: { name: "chalk", version: "5.3.0" }, files: {} };
const LOCK = ["marked@18.0.14", "mathjax-full@3.2.2", "chalk@5.3.0"];
const REVIEWED_IMPORTERS = {
  "src/cli.ts": 'import "./board-math";\nimport "../web/board/svg";\nexport const y = 1;\n',
  "src/board-math.ts": '// @ts-ignore\nimport { mathjax } from "mathjax-full/js/mathjax.js";\nexport const m = mathjax;\n',
  "web/board/svg.ts": '// @ts-ignore\nimport { Lexer } from "marked";\nexport const l = Lexer;\n',
};
const boundaryCases: [string, Record<string, string>, Stub[], string[], RegExp | null][] = [
  // [name, files, stubs, lockfile entries, the expected refusal (null: passes)]
  ["L41-fx11 the reviewed packages, from their reviewed importers, at their versions, in the lockfile: pass", REVIEWED_IMPORTERS, [MARKED, MATHJAX], LOCK, null],
  ["L41-fx7 membership only: chalk, otherwise valid (its stub, its version, the lockfile), is not a reviewed package", { "src/cli.ts": '// @ts-ignore\nimport chalk from "chalk";\nexport const k = chalk;\n' }, [CHALK], LOCK, /src\/cli\.ts:\d+: not a reviewed bundled package: chalk$/],
  ["L41-fx8 importer only: marked from src/cli.ts, not its reviewed importer", { "src/cli.ts": '// @ts-ignore\nimport { Lexer } from "marked";\nexport const l = Lexer;\n' }, [MARKED], LOCK, /src\/cli\.ts:\d+: marked from an unreviewed importer$/],
  ["L41-fx12 identity only: marked's reviewed root holds a package named evil", REVIEWED_IMPORTERS, [{ ...MARKED, pj: { name: "evil", version: "18.0.14" } }, MATHJAX], LOCK, /web\/board\/svg\.ts:\d+: marked resolves outside its reviewed root or is not that package$/],
  ["L41-fx9 version only: marked 18.0.13 at its root", REVIEWED_IMPORTERS, [{ ...MARKED, dirVersion: "18.0.13", pj: { name: "marked", version: "18.0.13" } }, MATHJAX], LOCK, /web\/board\/svg\.ts:\d+: marked version 18\.0\.13, reviewed 18\.0\.14$/],
  ["L41-fx10 lockfile only: marked@18.0.14 missing from the lockfile", REVIEWED_IMPORTERS, [MARKED, MATHJAX], LOCK.filter((e) => e !== "marked@18.0.14"), /web\/board\/svg\.ts:\d+: marked@18\.0\.14 not in the lockfile$/],
  ["L41-fx13 no masking: a listed package absent from the closure doesn't admit an unlisted one (chalk from src/x.ts)", { "src/cli.ts": 'import "./x";\nexport const y = 1;\n', "src/x.ts": '// @ts-ignore\nimport chalk from "chalk";\nexport const k = chalk;\n' }, [MARKED, MATHJAX, CHALK], LOCK, /src\/x\.ts:\d+: not a reviewed bundled package: chalk$/],
  ["L41-fx14 root only: node_modules/marked a real directory holding a valid marked 18.0.14, outside .pnpm", { ...REVIEWED_IMPORTERS, "node_modules/marked/package.json": JSON.stringify({ name: "marked", version: "18.0.14", main: "index.js", ...(STUB_TYPES ? { types: "index.d.ts" } : {}) }), "node_modules/marked/index.js": "module.exports = {};\n", ...typed({ "node_modules/marked/index.d.ts": "export {};\n" }) }, [MATHJAX], LOCK, /web\/board\/svg\.ts:\d+: marked resolves outside its reviewed root or is not that package$/],
];
// (r3.2: how many bare imports each case resolves before its verdict: the reviewed pair in the positive and in the
// one-fault cases after membership and importer; none where membership or the importer refuses first)
const RESOLVES: Record<string, number> = { "L41-fx11": 2, "L41-fx7": 0, "L41-fx8": 0, "L41-fx12": 2, "L41-fx9": 2, "L41-fx10": 2, "L41-fx13": 0, "L41-fx14": 2 };
for (const [name, files, stubs, lock, refusal] of boundaryCases) {
  test(name, () => {
    const root = stubbedTree(files, stubs, lock);
    assert.ok(existsSync(join(dirname(root), "node_modules", "marked", "index.d.ts")) && existsSync(join(dirname(root), "node_modules", "mathjax-full", "js", "mathjax.d.ts")), "the poisoning parent is in place");
    const c = runtimeClosure(root, "src/cli.ts");
    const inside = realpathSync(root) + sep;
    for (const f of c.resolved) assert.ok(f.startsWith(inside), `resolved inside its fixture (hermetic): ${f}`);
    assert.equal(c.resolved.length, RESOLVES[name.split(" ")[0]], `resolved locally: ${JSON.stringify(c.resolved)}`);
    if (refusal === null) assert.deepEqual(c.problems, [], "passes: no problem");
    else {
      assert.equal(c.problems.length, 1, `exactly one refusal: ${JSON.stringify(c.problems)}`);
      assert.match(c.problems[0], refusal, "refused in its own words");
    }
    assert.equal(c.files.has(FAKE), false);
  });
}
test("L41w the production Worker: local-gateway.ts constructs it as notebook.ts does (the CLI's entry, the workerData key); the CLI passes no authHold, port or observer", () => {
  const gw = readFileSync(join(REPO, "src/local-gateway.ts"), "utf8");
  const nb = readFileSync(join(REPO, "src/notebook.ts"), "utf8");
  const np = readFileSync(join(REPO, "src/notebook-pair.ts"), "utf8");
  for (const [name, t] of [["local-gateway.ts", gw], ["notebook.ts", nb]]) {
    assert.ok(t.includes(CANON_ENTRY), `${name}: the CLI's own entry`);
    assert.match(t, /new Worker\(entry, \{ workerData: \{ sagebrushNotebook: \{ dir/, `${name}: the same workerData key`);
  }
  assert.match(gw, /this\.port = opts\.port \?\? workerPort\(opts\.dir \?\? process\.cwd\(\)\);/, "the default port: no entry, no observer");
  assert.match(nb, /\.runNotebookPair\(args\);/, "the CLI's one call: no options");
  assert.match(np, /new LocalGateway\(this, opts\.gateway\);/, "the gateway's options are only the caller's");
  assert.doesNotMatch(nb, /authHold|observe|gateway:/, "notebook.ts passes no test hook");
});
// L20: no retired without a cancel, over every case's frame log (this file's sockets: its last test, top-level tests
// running in file order)
test("L20 no retired without a cancel: a census over every case's frame log", () => {
  let n = 0;
  for (const st of allSocks) {
    for (const f of texts(st)) {
      if (f.retired === undefined) continue;
      n++;
      assert.ok(st.cancels.has(f.id), `L20 retired ${f.id} without a cancel`);
    }
  }
  assert.ok(n >= 4, `L20 the census saw the retirements (${n})`);
});
