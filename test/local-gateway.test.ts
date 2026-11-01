import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { PairServer, PAIR_LIMITS } from "../src/notebook-pair";
import { GATEWAY_LIMITS, SYNTHETIC_BASE, BODY_MAX, RESPONSE_MAX, type SessionPort, type WorkerHandle } from "../src/local-gateway";

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
function stubSock() {
  const on: Record<string, ((...a: any[]) => void)[]> = {};
  const st: any = {
    writableLength: 0, destroyed: false, ended: 0, writes: [] as Buffer[], on,
    write(b: Buffer) { st.writes.push(Buffer.from(b)); return true; },
    end() { st.ended++; },
    destroy() { st.destroyed = true; },
  };
  st.on = (ev: string, fn: (...a: any[]) => void) => { (on[ev] ??= []).push(fn); return st; };
  st.emit = (ev: string) => { for (const f of on[ev] ?? []) f(); };
  return st;
}
/** The JSON text frames written to a stub socket, in order (the hello's result first). */
const texts = (st: any) => st.writes.map((w: Buffer) => serverFrame(w)).filter((f: any) => f.op === 0x1).map((f: any) => JSON.parse(f.payload.toString()));
const closeOf = (st: any) => { for (const w of st.writes) { const f = serverFrame(w); if (f.op === 0x8) return f.payload.readUInt16BE(0); } return null; };

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
function newPage(s: PairServer, clk: ReturnType<typeof clock>, key = keyPair()) {
  const st = stubSock();
  const c = s.attach(st);
  c.feed(maskedText({ jsonrpc: "2.0", id: "h1", method: "hello", params: { protocol: 1, purpose: "kernel", code: s.code, page: { origin: "https://sagebrush.space", path: "/" }, jwk: key.jwk, jkt: key.jkt } }));
  const r = texts(st)[0]?.result;
  assert.ok(r?.token, "paired");
  let n = 0;
  const page = {
    st, c, key, token: r.token as string, nonce: r.nonce as string,
    nextId: () => `t${++n}`,
    /** A proof for (method, path), signed by `signer` (default the page's key), its claims overridable. */
    proof(method: string, path: string, over: { header?: any; claims?: any; signer?: any; raw?: string } = {}) {
      if (over.raw !== undefined) return over.raw;
      const header = { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk, ...(over.header ?? {}) };
      const claims = { jti: b64u(randomBytes(16)), htm: method, htu: SYNTHETIC_BASE + path, iat: Math.floor(clk.now() / 1000), ath: b64u(createHash("sha256").update(page.token).digest()), nonce: page.nonce, ...(over.claims ?? {}) };
      for (const k of Object.keys(claims)) if ((claims as any)[k] === undefined) delete (claims as any)[k];
      for (const k of Object.keys(header)) if ((header as any)[k] === undefined) delete (header as any)[k];
      const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
      const sig = edSign("sha256", Buffer.from(input), { key: over.signer ?? key.privateKey, dsaEncoding: "ieee-p1363" });
      return `${input}.${b64u(sig)}`;
    },
    /** Send one request frame; resolves to its answer frame (the first frame for its id). */
    request(rpc: string, ref: any, body?: unknown, over: { id?: string; auth?: string; dpop?: string; proof?: any; method?: string; path?: string } = {}) {
      const id = over.id ?? page.nextId();
      const row = ROUTES[rpc];
      const method = over.method ?? row.method;
      const path = over.path ?? row.path(ref);
      const frame: any = { id, rpc, ref, auth: over.auth ?? `DPoP ${page.token}`, dpop: over.dpop ?? page.proof(method, path, over.proof), accept: rpc === "g.events" ? "text/event-stream" : "application/json" };
      if (body !== undefined) frame.body = typeof body === "string" ? body : JSON.stringify(body);
      const before = st.writes.length;
      c.feed(maskedText(frame));
      return { id, answer: () => waitFor(st, id, before) };
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
/** Every effect a refusal must not have had (cases v3 §4). */
function zeroEffects(s: PairServer, port: Scripted, before: { posted: number; bytes: number }) {
  assert.equal(s.gateway.binding === null || before.posted >= 0, true);
  assert.equal(port.posted.length, before.posted, "no SessionPort call");
  assert.equal(s.gateway.stats.queuedPayloadBytes, before.bytes, "queuedPayloadBytes unchanged");
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

/** A refusal case: the request answered 401 with `error`, its reason counted, zero effects. */
async function refused(t: { s: PairServer; port: Scripted }, req: { answer(): Promise<any> }, reason: string, error = "invalid_dpop_proof", o: { bound?: boolean; status?: number } = {}) {
  const bindingBefore = t.s.gateway.binding;
  const before = { posted: t.port.posted.length, bytes: t.s.gateway.stats.queuedPayloadBytes };
  const r0 = t.s.gateway.stats.authRefusals[reason] ?? 0;
  const a = await req.answer();
  assert.equal(a?.status, o.status ?? 401, `${o.status ?? 401} (${a?.body})`);
  assert.equal(bodyOf(a).error, error);
  assert.equal((t.s.gateway.stats.authRefusals[reason] ?? 0) - r0, 1, `refused for its own reason: ${reason} (${JSON.stringify(t.s.gateway.stats.authRefusals)})`);
  zeroEffects(t.s, t.port, before);
  if (o.bound) assert.equal(t.s.gateway.binding, bindingBefore, "the binding unchanged");
  else assert.equal(t.s.gateway.binding, null, "no binding made");
}

test("L2a another socket's token: 401 invalid_token", async () => {
  const t = await setup();
  try {
    const other = newPage(t.s, t.clk);
    t.s.pairedConn = t.page.c; // (one paired page at a time: the test reinstates the first as the paired one)
    await refused(t, t.page.request("g.bind", {}, {}, { auth: `DPoP ${other.token}` }), "token", "invalid_token");
  } finally { await t.s.close(); }
});

test("L2b a token from a closed socket: 401 invalid_token", async () => {
  const t = await setup();
  try {
    const old = t.page.token;
    t.page.st.emit("close"); // (the first socket gone)
    const p2 = newPage(t.s, t.clk);
    await refused({ s: t.s, port: t.port }, p2.request("g.bind", {}, {}, { auth: `DPoP ${old}` }), "token", "invalid_token");
  } finally { await t.s.close(); }
});

const headerCases: [string, any, string][] = [
  ["L3a typ missing", { header: { typ: undefined } }, "typ-missing"],
  ["L3b typ not dpop+jwt", { header: { typ: "jwt" } }, "typ"],
  ["L3c alg none", { header: { alg: "none" } }, "alg"],
  ["L3c alg HS256", { header: { alg: "HS256" } }, "alg"],
  ["L3c alg ES384", { header: { alg: "ES384" } }, "alg"],
];
for (const [name, over, reason] of headerCases) {
  test(`${name}: 401, refused for ${reason}`, async () => {
    const t = await setup();
    try { await refused(t, t.page.request("g.bind", {}, {}, { proof: over }), reason); } finally { await t.s.close(); }
  });
}

test("L3d a JWK with d (private): 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, d: b64u(randomBytes(32)) } } } }), "jwk-private"); } finally { await t.s.close(); }
});
test("L3e a JWK with an extra member: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, kid: "k1" } } } }), "jwk-extra"); } finally { await t.s.close(); }
});
test("L3f a JWK missing y: 401", async () => {
  const t = await setup();
  try { const { y, ...noY } = t.page.key.jwk; await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: noY } } }), "jwk-members"); } finally { await t.s.close(); }
});
test("L3g-kty kty not EC: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, kty: "RSA" } } } }), "kty"); } finally { await t.s.close(); }
});
test("L3g-crv crv not P-256: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, crv: "P-384" } } } }), "crv"); } finally { await t.s.close(); }
});
test("L3h off-curve coordinates: 401", async () => {
  const t = await setup();
  try {
    const x = Buffer.from(t.page.key.jwk.x, "base64url"); x[31] ^= 1; // (a point off the curve, almost surely)
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, x: b64u(x) } } } }), "curve");
  } finally { await t.s.close(); }
});
test("L3i coordinates not 43 characters or not 32 bytes: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: { ...t.page.key.jwk, x: b64u(randomBytes(31)) } } } }), "coords"); } finally { await t.s.close(); }
});
test("L3j a thumbprint not the socket's jkt (another valid key, validly signed): 401", async () => {
  const t = await setup();
  try {
    const k2 = keyPair();
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { header: { jwk: k2.jwk }, signer: k2.privateKey } }), "thumbprint");
  } finally { await t.s.close(); }
});
test("L4a a bad signature: 401", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    const sig = Buffer.from(p[2], "base64url"); sig[5] ^= 0xff;
    await refused(t, t.page.request("g.bind", {}, {}, { dpop: `${p[0]}.${p[1]}.${b64u(sig)}` }), "signature");
  } finally { await t.s.close(); }
});
test("L4b a signature not 64 bytes: 401", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    await refused(t, t.page.request("g.bind", {}, {}, { dpop: `${p[0]}.${p[1]}.${b64u(randomBytes(63))}` }), "sig-length");
  } finally { await t.s.close(); }
});
test("L4c parseJwt, one parse step: 2 parts, 4 parts, non-base64url, non-JSON, a JSON non-object: 401 each", async () => {
  const t = await setup();
  try {
    const p = t.page.proof("POST", "/bindings").split(".");
    for (const raw of [`${p[0]}.${p[1]}`, `${p[0]}.${p[1]}.${p[2]}.${p[2]}`, `${p[0]}.${p[1]}+.${p[2]}`, `${b64u("{nope")}.${p[1]}.${p[2]}`, `${b64u("[1]")}.${p[1]}.${p[2]}`]) {
      await refused(t, t.page.request("g.bind", {}, {}, { dpop: raw }), "parse");
    }
  } finally { await t.s.close(); }
});
test("L4d a proof over 4096 B: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { dpop: "a".repeat(4097) }), "proof-size"); } finally { await t.s.close(); }
});
test("L4e a decoded segment over 1024 B: 401, before any key import", async () => {
  const t = await setup();
  try {
    const imports = t.s.gateway.stats.keyImports;
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { pad: "x".repeat(1100) } } }), "segment-size");
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
      await refused(t, t.page.request(rpc, ref, ROUTES[rpc].method === "POST" ? {} : undefined, { proof: { claims: { htm: wrong } } }), "htm");
    }
  } finally { await t.s.close(); }
});
test("L6a htu a URL taken as-is (another path), for each rpc: 401", async () => {
  const t = await setup();
  try {
    for (const rpc of Object.keys(ROUTES)) {
      const ref = rpc === "g.bind" ? {} : rpc === "g.record" ? { b: "b1", r: "r1" } : rpc === "g.events" ? { b: "b1", r: "r1", after: 0 } : { b: "b1" };
      await refused(t, t.page.request(rpc, ref, ROUTES[rpc].method === "POST" ? {} : undefined, { proof: { claims: { htu: SYNTHETIC_BASE + "/somewhere/else" } } }), "htu");
    }
  } finally { await t.s.close(); }
});
test("L6b htu with a query: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { htu: SYNTHETIC_BASE + "/bindings?x=1" } } }), "htu"); } finally { await t.s.close(); }
});
test("L6c cross-binding substitution: htu names binding B while ref.b = A: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.interrupt", { b: "A" }, {}, { path: "/bindings/B/interrupt" }), "htu"); } finally { await t.s.close(); }
});
test("L6d cross-run substitution: htu names run r2 while ref.r = r1: 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.record", { b: "b1", r: "r1" }, undefined, { path: "/bindings/b1/runs/r2" }), "htu"); } finally { await t.s.close(); }
});
test("L7 ath not SHA-256(token): 401", async () => {
  const t = await setup();
  try { await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { ath: b64u(randomBytes(32)) } } }), "ath"); } finally { await t.s.close(); }
});
test("L8a iat 61 s old: 401; L8a+ at exactly 60 s: passes", async () => {
  const t = await setup();
  try {
    const now = Math.floor(t.clk.now() / 1000);
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now - 61 } } }), "iat-past");
    const a = await t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now - 60 } } }).answer();
    assert.equal(a.status, 200, "L8a+");
  } finally { await t.s.close(); }
});
test("L8b iat 6 s ahead: 401; L8b+ at exactly 5 s: passes", async () => {
  const t = await setup();
  try {
    const now = Math.floor(t.clk.now() / 1000);
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { iat: now + 6 } } }), "iat-future");
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
        const claimsText = `{"jti":"${b64u(randomBytes(16))}","htm":"POST","htu":"${SYNTHETIC_BASE}/bindings","iat":1e999,"ath":"${b64u(createHash("sha256").update(t.page.token).digest())}","nonce":"${t.page.nonce}"}`;
        const input = `${header}.${b64u(claimsText)}`;
        const sig = edSign("sha256", Buffer.from(input), { key: t.page.key.privateKey, dsaEncoding: "ieee-p1363" });
        await refused(t, t.page.request("g.bind", {}, {}, { dpop: `${input}.${b64u(sig)}` }), "iat-type");
      } else await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { iat: v } } }), "iat-type");
    }
  } finally { await t.s.close(); }
});
test("L9a a jti reused within 120 s: 401; L9a+ the same jti at 121 s: passes", async () => {
  const t = await setup();
  try {
    const jti = b64u(randomBytes(16));
    assert.equal((await t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }).answer()).status, 200);
    t.clk.advance(1000);
    await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { jti, iat: Math.floor(t.clk.now() / 1000) } } }), "jti-reused", "invalid_dpop_proof", { bound: true });
    t.clk.advance(120_000);
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
      else await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }), reason);
    } finally { await t.s.close(); }
  });
}
test("L9d jti not a string (missing, 123, null, an array that would coerce): 401 each, nothing stored", async () => {
  const t = await setup();
  try {
    for (const jti of [undefined, 123, null, ["a".repeat(22)]]) await refused(t, t.page.request("g.bind", {}, {}, { proof: { claims: { jti } } }), "jti-type");
  } finally { await t.s.close(); }
});
test("L10a a stale nonce: 401 use_dpop_nonce with a fresh DPoP-Nonce", async () => {
  const t = await setup();
  try {
    const before = { posted: t.port.posted.length, bytes: t.s.gateway.stats.queuedPayloadBytes };
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
    const before = { posted: t.port.posted.length, bytes: t.s.gateway.stats.queuedPayloadBytes };
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
    await refused({ s: t.s, port: t.port }, p2.request("g.bind", {}, {}, { auth: `DPoP ${old}` }), "token", "invalid_token");
    assert.equal((await p2.request("g.bind", {}, {}).answer()).status, 200, "the new token works");
  } finally { await t.s.close(); }
});
