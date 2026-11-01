import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairServer, PAIR_LIMITS, PAIR_PATH, PAGE_ORIGIN, runNotebookPair } from "../src/notebook-pair";
import type { Conn } from "../src/notebook-pair";

// `sagebrush notebook --pair` (src/notebook-pair.ts), phase 2: the pairing alone.  Cases K1–K23 as frozen with the
// grader (/scratch/sagebrush-reviews/grader-local-kernel-phase2-cases-FROZEN.md), and r2's K24–K36 (the v3 addendum
// 0ed06c46 with amendment A 41231169; the run authority 704bf85c and its fixture notes 202fcacc and 1ed98a23); each
// test's name starts with its case.  A raw socket plays the page (so a handshake or a frame can be wrong on purpose),
// on an injected clock; the gate's cases use a stub socket whose buffered bytes the test sets.

// ---- an injected clock
function clock() {
  let t = 1_000_000, n = 0, q: { at: number; f: () => void; id: number }[] = [];
  return {
    now: () => t,
    setTimeout(f: () => void, ms: number) { const id = ++n; q.push({ at: t + ms, f, id }); return id; },
    clearTimeout(id: any) { q = q.filter((x) => x.id !== id); },
    advance(ms: number) { t += ms; const due = q.filter((x) => x.at <= t); q = q.filter((x) => x.at > t); for (const d of due) d.f(); },
    pending: () => q.length,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
async function until(f: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const MiB = 1024 * 1024;

// ---- the page's key
function pageKey() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j: any = publicKey.export({ format: "jwk" });
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  const jkt = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
  return { jwk, jkt };
}

// ---- a raw client
type Ev = { type: "text"; data: any; raw: string } | { type: "close"; code: number; reason: string } | { type: "pong"; data: Buffer } | { type: "end" };
class Client {
  buf: Buffer = Buffer.alloc(0);
  events: Ev[] = [];
  waiters: ((e: Ev) => void)[] = [];
  constructor(readonly sock: net.Socket, rest: Buffer) {
    sock.on("data", (d: Buffer) => this.feed(d));
    sock.on("close", () => this.push({ type: "end" }));
    sock.on("error", () => {});
    if (rest.length) this.feed(rest);
  }
  private push(e: Ev) { const w = this.waiters.shift(); if (w) w(e); else this.events.push(e); }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f;
      let len = this.buf[1] & 0x7f, at = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); at = 10; }
      if (this.buf.length < at + len) return;
      const p = this.buf.subarray(at, at + len);
      this.buf = this.buf.subarray(at + len);
      if (op === 0x1) { const raw = p.toString("utf8"); this.push({ type: "text", data: JSON.parse(raw), raw }); }
      else if (op === 0x8) this.push({ type: "close", code: p.length >= 2 ? p.readUInt16BE(0) : 1005, reason: p.subarray(2).toString("utf8") });
      else if (op === 0xa) this.push({ type: "pong", data: Buffer.from(p) });
    }
  }
  next(ms = 2000): Promise<Ev> {
    const e = this.events.shift();
    if (e) return Promise.resolve(e);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ type: "end" }), ms);
      this.waiters.push((x) => { clearTimeout(t); resolve(x); });
    });
  }
  /** The next close (skipping any text before it), or "end". */
  async closeCode(): Promise<number | "end"> {
    for (;;) { const e = await this.next(); if (e.type === "close") return e.code; if (e.type === "end") return "end"; }
  }
  frame(op: number, payload: Buffer, { mask = true, fin = true }: { mask?: boolean; fin?: boolean } = {}) {
    const n = payload.length;
    const b0 = (fin ? 0x80 : 0) | op;
    const len = n < 126 ? Buffer.from([(mask ? 0x80 : 0) | n]) : n < 65536 ? Buffer.from([(mask ? 0x80 : 0) | 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(9); b[0] = (mask ? 0x80 : 0) | 127; b.writeBigUInt64BE(BigInt(n), 1); return b; })();
    if (!mask) return this.sock.write(Buffer.concat([Buffer.from([b0]), len, payload]));
    const key = randomBytes(4);
    const m = Buffer.from(payload);
    for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
    this.sock.write(Buffer.concat([Buffer.from([b0]), len, key, m]));
  }
  /** A masked frame whose length is in the form given (126: 16 bits, 127: 64 bits), shortest or not. */
  rawFrame(op: number, payload: Buffer, form: 126 | 127) {
    const len = form === 126 ? Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 255]) : (() => { const b = Buffer.alloc(9); b[0] = 0x80 | 127; b.writeBigUInt64BE(BigInt(payload.length), 1); return b; })();
    const key = randomBytes(4);
    const m = Buffer.from(payload);
    for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
    this.sock.write(Buffer.concat([Buffer.from([0x80 | op]), len, key, m]));
  }
  send(obj: unknown) { this.frame(0x1, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))); }
  end() { this.sock.destroy(); }
}

// ---- frames by hand, for a stub socket: a client's (masked, shortest length) and a server's (read back)
function masked(op: number, payload: Buffer, fin = true) {
  const n = payload.length;
  const len = n < 126 ? Buffer.from([0x80 | n]) : n < 65536 ? Buffer.from([0x80 | 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(9); b[0] = 0x80 | 127; b.writeBigUInt64BE(BigInt(n), 1); return b; })();
  const key = randomBytes(4);
  const m = Buffer.from(payload);
  for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op]), len, key, m]);
}
const maskedText = (obj: unknown) => masked(0x1, Buffer.from(JSON.stringify(obj)));
function serverFrame(b: Buffer) {
  let len = b[1] & 0x7f, at = 2;
  if (len === 126) { len = b.readUInt16BE(2); at = 4; } else if (len === 127) { len = Number(b.readBigUInt64BE(2)); at = 10; }
  assert.equal(b.length, at + len, "one whole frame per write");
  return { op: b[0] & 0x0f, payload: b.subarray(at) };
}
/** The encoded size of a server frame with an n-byte payload. */
const frameBytes = (n: number) => n + (n < 126 ? 2 : n < 65536 ? 4 : 10);
const notYetAnswer = (id: string) => ({ id, status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not-yet", message: "this computer's kernel isn't available in this version" }) });
/** A stub socket: writableLength set by the test, every write recorded (and never counted into writableLength). */
function stubSock() {
  const st: any = {
    writableLength: 0, destroyed: false, ended: 0, writes: [] as Buffer[],
    write(b: Buffer) { st.writes.push(Buffer.from(b)); return true; },
    end() { st.ended++; },
    destroy() { st.destroyed = true; },
    on() { return st; },
  };
  return st;
}
/** A stub socket paired by a real hello fed through its conn. */
function stubPaired(s: PairServer) {
  const st = stubSock();
  const c = s.attach(st);
  c.feed(maskedText(codeHello(s)));
  assert.equal(st.writes.length, 1);
  assert.ok(JSON.parse(serverFrame(st.writes[0]).payload.toString()).result?.token, "the stub paired");
  return { st, c };
}

type Up = { origin?: string | null; host?: string; path?: string; key?: string; version?: string; extra?: string[] };
/** An upgrade request, by hand: the status, and a Client when it switched (101). */
function upgrade(port: number, o: Up = {}): Promise<{ status: number; client: Client | null }> {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let head: Buffer = Buffer.alloc(0), done = false;
    const lines = [
      `GET ${o.path ?? PAIR_PATH} HTTP/1.1`,
      `Host: ${o.host ?? `127.0.0.1:${port}`}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${o.key ?? randomBytes(16).toString("base64")}`,
      `Sec-WebSocket-Version: ${o.version ?? "13"}`,
      ...(o.origin === null ? [] : [`Origin: ${o.origin ?? PAGE_ORIGIN}`]),
      ...(o.extra ?? []),
    ];
    sock.on("error", () => { if (!done) { done = true; resolve({ status: 0, client: null }); } });
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0 || done) return;
      done = true;
      sock.off("data", onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head.toString("latin1"))?.[1] ?? 0);
      if (status === 101) resolve({ status, client: new Client(sock, head.subarray(end + 4)) });
      else { sock.destroy(); resolve({ status, client: null }); }
    };
    sock.on("data", onData);
    sock.on("close", () => { if (!done) { done = true; resolve({ status: 0, client: null }); } });
    sock.write(lines.join("\r\n") + "\r\n\r\n");
  });
}
async function open(port: number, o: Up = {}) {
  const r = await upgrade(port, o);
  assert.equal(r.status, 101, `the upgrade switched (${r.status})`);
  return r.client!;
}
function helloMsg(params: any) { return { jsonrpc: "2.0", id: "h1", method: "hello", params }; }
function codeHello(s: PairServer, extra: any = {}) { const k = pageKey(); return helloMsg({ protocol: 1, purpose: "kernel", code: s.code, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt, ...extra }); }
/** A hello on a fresh socket: its answer (result or error), and the socket. */
async function hello(s: PairServer, msg: any) {
  const c = await open(s.port);
  c.send(msg);
  const e = await c.next();
  return { c, e, result: e.type === "text" ? e.data.result : undefined, error: e.type === "text" ? e.data.error : undefined };
}
async function server(opts: any = {}) {
  const clk = clock();
  const s = new PairServer({ timers: clk, ...opts });
  await s.listen(0);
  return { s, clk };
}

test("K1 origin: only https://sagebrush.space (no dev origin unless one is set)", async () => {
  const { s } = await server();
  try {
    for (const origin of ["https://evil.example", "http://sagebrush.space", "https://sagebrush.space.evil.test", "http://localhost:5173", null]) {
      assert.equal((await upgrade(s.port, { origin })).status, 403, `origin ${origin}`);
    }
    (await open(s.port)).end();
  } finally { await s.close(); }
});

test("K1b dev origin: compared as a whole string", async () => {
  const { s } = await server({ devOrigin: "http://localhost:5173" });
  try {
    (await open(s.port, { origin: "http://localhost:5173" })).end();
    for (const origin of ["http://localhost:5174", "http://localhost:5173.evil.test", "http://localhost:51730", "https://localhost:5173", "http://127.0.0.1:5173"]) {
      assert.equal((await upgrade(s.port, { origin })).status, 403, `origin ${origin}`);
    }
  } finally { await s.close(); }
});

test("K2 host: 127.0.0.1:<port> or localhost:<port> only (no DNS rebinding)", async () => {
  const { s } = await server();
  try {
    for (const host of ["evil.test", `evil.test:${s.port}`, `127.0.0.1:${s.port + 1}`, "127.0.0.1"]) {
      assert.equal((await upgrade(s.port, { host })).status, 403, `host ${host}`);
    }
    (await open(s.port, { host: `localhost:${s.port}` })).end();
  } finally { await s.close(); }
});

test("K3 path: another path is refused at the upgrade (400), and the code still pairs", async () => {
  const { s } = await server();
  try {
    for (const path of ["/sagebrush", "/", "/sagebrush-kernel/x", "/x"]) assert.equal((await upgrade(s.port, { path })).status, 400, `path ${path}`);
    const h = await hello(s, codeHello(s));
    assert.ok(h.result?.token, "the code pairs afterwards");
    h.c.end();
  } finally { await s.close(); }
});

test("K3b a wrong path doesn't count: 5 of them (each 400), then the code pairs", async () => {
  const { s } = await server();
  try {
    for (let i = 0; i < PAIR_LIMITS.wrongAttempts; i++) assert.equal((await upgrade(s.port, { path: "/sagebrush" })).status, 400);
    const h = await hello(s, codeHello(s));
    assert.ok(h.result?.token, "not retired");
    h.c.end();
  } finally { await s.close(); }
});

test("K4a a repeated header is refused (400)", async () => {
  const { s } = await server();
  try {
    assert.equal((await upgrade(s.port, { extra: [`Origin: ${PAGE_ORIGIN}`] })).status, 400, "Origin twice");
    assert.equal((await upgrade(s.port, { extra: [`Host: 127.0.0.1:${s.port}`] })).status, 400, "Host twice");
    assert.equal((await upgrade(s.port, { extra: [`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`] })).status, 400, "the key twice");
  } finally { await s.close(); }
});

test("K4b a bad key or version is refused (403)", async () => {
  const { s } = await server();
  try {
    assert.equal((await upgrade(s.port, { key: "abc" })).status, 403, "a short key");
    assert.equal((await upgrade(s.port, { key: randomBytes(15).toString("base64") })).status, 403, "15 bytes");
    assert.equal((await upgrade(s.port, { version: "8" })).status, 403, "version 8");
  } finally { await s.close(); }
});

test("K5 a code is single use: after its page closed, the same code is refused (used)", async () => {
  const { s } = await server();
  try {
    const msg = codeHello(s);
    const a = await hello(s, msg);
    assert.ok(a.result?.token);
    a.c.end();
    await settle();
    const b = await hello(s, codeHello(s));
    assert.ok(b.error, "refused");
    assert.match(b.error.message, /used/);
    assert.equal(await b.c.closeCode(), 1008);
  } finally { await s.close(); }
});

test("K6 a code expires after 5 minutes", async () => {
  const { s, clk } = await server();
  try {
    clk.advance(PAIR_LIMITS.codeMs + 1000);
    const h = await hello(s, codeHello(s));
    assert.ok(h.error);
    assert.match(h.error.message, /expired/);
  } finally { await s.close(); }
});

test("K7 5 wrong codes retire it: then even the right one is refused", async () => {
  const { s } = await server();
  try {
    for (let i = 0; i < PAIR_LIMITS.wrongAttempts; i++) {
      const h = await hello(s, codeHello(s, { code: "A".repeat(26) }));
      assert.ok(h.error, `wrong ${i + 1} refused`);
    }
    const h = await hello(s, codeHello(s));
    assert.ok(h.error, "the right code, retired");
    assert.match(h.error.message, /wrong attempts/);
  } finally { await s.close(); }
});

test("K8 purpose: the right code with a wrong or missing purpose is refused, not spent, and counted", async () => {
  const { s } = await server();
  try {
    for (const purpose of ["agent", undefined]) {
      const h = await hello(s, codeHello(s, { purpose }));
      assert.ok(h.error, `purpose ${purpose} refused`);
      assert.equal(await h.c.closeCode(), 1008);
    }
    const ok = await hello(s, codeHello(s));
    assert.ok(ok.result?.token, "(b) the code wasn't spent: a correct hello pairs");
    ok.c.end();
  } finally { await s.close(); }
  const t = await server();
  try {
    for (let i = 0; i < PAIR_LIMITS.wrongAttempts; i++) assert.ok((await hello(t.s, codeHello(t.s, { purpose: "agent" }))).error);
    const h = await hello(t.s, codeHello(t.s));
    assert.ok(h.error, "(c) counted: 5 wrong purposes retire the code");
  } finally { await t.s.close(); }
});

test("K9 one page at a time: a hello while a page is paired is refused", async () => {
  const { s } = await server();
  try {
    const a = await hello(s, codeHello(s, { remember: true }));
    assert.ok(a.result?.session);
    const k = pageKey();
    const b = await hello(s, helloMsg({ protocol: 1, purpose: "kernel", session: a.result.session, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt }));
    assert.ok(b.error, "refused");
    assert.match(b.error.message, /another page/);
    a.c.end();
  } finally { await s.close(); }
});

test("K10 the pre-hello cap: a frame over 8 KiB closes (1009), measured before it is parsed", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    c.frame(0x1, Buffer.from("x".repeat(PAIR_LIMITS.preHello + 1))); // (not JSON: 1009, not 1007, pins the order)
    assert.equal(await c.closeCode(), 1009);
  } finally { await s.close(); }
});

test("K11 the hello within 30 s", async () => {
  const { s, clk } = await server();
  try {
    const c = await open(s.port);
    clk.advance(PAIR_LIMITS.helloMs - 1);
    await settle();
    clk.advance(1);
    assert.equal(await c.closeCode(), 1008);
  } finally { await s.close(); }
});

test("K12 at most 8 sockets in their handshake or hello: the 9th is refused", async () => {
  const { s } = await server();
  try {
    const cs: Client[] = [];
    for (let i = 0; i < PAIR_LIMITS.unpaired; i++) cs.push(await open(s.port));
    assert.equal((await upgrade(s.port)).status, 503);
    for (const c of cs) c.end();
  } finally { await s.close(); }
});

test("K13 a hello carries exactly one of code and session", async () => {
  const { s } = await server();
  try {
    const both = await hello(s, codeHello(s, { session: "x".repeat(43) }));
    assert.ok(both.error, "both refused");
    const k = pageKey();
    const neither = await hello(s, helloMsg({ protocol: 1, purpose: "kernel", page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt }));
    assert.ok(neither.error, "neither refused");
    const ok = await hello(s, codeHello(s));
    assert.ok(ok.result?.token, "the code wasn't spent by either");
    ok.c.end();
  } finally { await s.close(); }
});

test("K14a the key's thumbprint must match", async () => {
  const { s } = await server();
  try {
    const h = await hello(s, codeHello(s, { jkt: pageKey().jkt }));
    assert.ok(h.error);
    assert.equal(await h.c.closeCode(), 1008);
  } finally { await s.close(); }
});

test("K14b the key is exactly {kty: EC, crv: P-256, x, y}", async () => {
  const { s } = await server();
  try {
    const k = pageKey();
    const bad = [{ ...k.jwk, d: k.jwk.x }, { ...k.jwk, kid: "1" }, { ...k.jwk, kty: "RSA" }, { ...k.jwk, crv: "P-384" }, { kty: "EC", crv: "P-256", x: k.jwk.x }];
    for (const jwk of bad) {
      const jkt = createHash("sha256").update(JSON.stringify({ crv: (jwk as any).crv, kty: jwk.kty, x: (jwk as any).x, y: (jwk as any).y })).digest("base64url");
      const h = await hello(s, codeHello(s, { jwk, jkt }));
      assert.ok(h.error, `refused: ${JSON.stringify(Object.keys(jwk))}`);
    }
  } finally { await s.close(); }
});

test("K15 the result: protocol, purpose, a token, a nonce, the limits; a session only when asked to remember", async () => {
  const { s } = await server();
  try {
    const h = await hello(s, codeHello(s));
    const r = h.result;
    assert.equal(r.protocol, 1);
    assert.equal(r.purpose, "kernel");
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(typeof r.nonce, "string");
    assert.equal(typeof r.limits?.frame, "number");
    assert.deepEqual(Object.keys(r.limits), ["frame"], "no inFlight in phase 2 (phase 3 advertises and enforces it)");
    assert.equal(r.session, undefined, "no session without remember");
    h.c.end();
  } finally { await s.close(); }
  const t = await server();
  try {
    const h = await hello(t.s, codeHello(t.s, { remember: true }));
    assert.match(h.result.session, /^[A-Za-z0-9_-]{43}$/);
    h.c.end();
  } finally { await t.s.close(); }
});

test("K16 a reconnect with the session pairs, with a new token", async () => {
  const { s } = await server();
  try {
    const a = await hello(s, codeHello(s, { remember: true }));
    const session = a.result.session, token1 = a.result.token;
    a.c.end();
    await settle();
    const k = pageKey();
    const b = await hello(s, helloMsg({ protocol: 1, purpose: "kernel", session, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt }));
    assert.ok(b.result?.token, `paired (${JSON.stringify(b.error)})`);
    assert.notEqual(b.result.token, token1, "a new token");
    assert.equal(b.result.session, undefined, "a session hello doesn't rotate the secret");
    b.c.end();
  } finally { await s.close(); }
});

test("K17 5 wrong session secrets forget the session", async () => {
  const { s } = await server();
  try {
    const a = await hello(s, codeHello(s, { remember: true }));
    const session = a.result.session;
    a.c.end();
    await settle();
    const k = pageKey();
    const msg = (sess: string) => helloMsg({ protocol: 1, purpose: "kernel", session: sess, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt });
    for (let i = 0; i < PAIR_LIMITS.wrongAttempts; i++) assert.ok((await hello(s, msg("y".repeat(43)))).error);
    const h = await hello(s, msg(session));
    assert.ok(h.error, "forgotten");
  } finally { await s.close(); }
});

test("K18 an explicit unpair invalidates the session and closes the socket", async () => {
  const { s } = await server();
  try {
    const a = await hello(s, codeHello(s, { remember: true }));
    const session = a.result.session;
    a.c.send({ unpair: true });
    assert.equal(await a.c.closeCode(), 1000);
    await settle();
    const k = pageKey();
    const h = await hello(s, helloMsg({ protocol: 1, purpose: "kernel", session, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt }));
    assert.ok(h.error, "the session is gone");
  } finally { await s.close(); }
});

test("K19 a new server process doesn't know an old session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-pair-"));
  const prev = process.env.SAGEBRUSH_PAIR_TEST_DIR;
  process.env.SAGEBRUSH_PAIR_TEST_DIR = dir; // (where a mutant that persists sessions would keep them)
  try {
    const a = await server();
    const h = await hello(a.s, codeHello(a.s, { remember: true }));
    const session = h.result.session;
    h.c.end();
    await a.s.close();
    const b = await server();
    try {
      const k = pageKey();
      const r = await hello(b.s, helloMsg({ protocol: 1, purpose: "kernel", session, page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt }));
      assert.ok(r.error, "unknown to the new server");
    } finally { await b.s.close(); }
  } finally {
    if (prev === undefined) delete process.env.SAGEBRUSH_PAIR_TEST_DIR; else process.env.SAGEBRUSH_PAIR_TEST_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("K20a an unmasked client frame closes (1002)", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    c.frame(0x1, Buffer.from("{}"), { mask: false });
    assert.equal(await c.closeCode(), 1002);
  } finally { await s.close(); }
});

test("K20b1 invalid UTF-8 inside a JSON string closes (1007): only the UTF-8 check can refuse it", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    c.frame(0x1, Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"h1","method":"hello","params":{"x":"'), Buffer.from([0xff]), Buffer.from('"}}')]));
    assert.equal(await c.closeCode(), 1007);
  } finally { await s.close(); }
});

test("K20b2 a key twice closes (1007)", async () => {
  const { s } = await server();
  try {
    const d = await open(s.port);
    d.send('{"jsonrpc":"2.0","id":"h1","id":"h2","method":"hello","params":{}}');
    assert.equal(await d.closeCode(), 1007);
  } finally { await s.close(); }
});

test("K20c after the hello, a frame over its cap closes (1009)", async () => {
  const { s } = await server();
  try {
    const h = await hello(s, codeHello(s));
    assert.ok(h.result?.token);
    // (a header announcing one byte over the cap, and a few bytes: refused from the length alone)
    const n = PAIR_LIMITS.frame + 1;
    const hdr = Buffer.alloc(14);
    hdr[0] = 0x81; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(n), 2); randomBytes(4).copy(hdr, 10);
    h.c.sock.write(Buffer.concat([hdr, Buffer.alloc(64)]));
    assert.equal(await h.c.closeCode(), 1009);
  } finally { await s.close(); }
});

test("K21 no kernel yet: a request after the hello is refused (not-yet), and no worker starts", async () => {
  const { s } = await server();
  try {
    const h = await hello(s, codeHello(s));
    h.c.send({ id: "t1", rpc: "g.run", ref: { b: "b1" }, auth: "DPoP x", dpop: "x", accept: "application/json", body: "{}" });
    const e = await h.c.next();
    assert.equal(e.type, "text");
    const a = (e as any).data;
    assert.equal(a.id, "t1");
    assert.equal(a.status, 503);
    assert.equal(JSON.parse(a.body).error, "not-yet");
    assert.equal(s.workersStarted, 0);
    h.c.end();
  } finally { await s.close(); }
  // (the phase-2 invariant: each execution RPC is answered before its frame's feed() returns; nothing waits)
  const t = await server();
  try {
    const { st, c } = stubPaired(t.s);
    const rpcs = ["g.bind", "g.run", "g.record", "g.events", "g.interrupt", "g.restart", "g.takeover", "g.complete"];
    rpcs.forEach((rpc, i) => {
      const n0 = st.writes.length;
      c.feed(maskedText({ id: `t${i + 1}`, rpc, ref: { b: "b1" }, auth: "DPoP x", dpop: "x", accept: "application/json", body: "{}" }));
      assert.equal(st.writes.length, n0 + 1, `${rpc}: answered before feed() returned`);
      const a = JSON.parse(serverFrame(st.writes[n0]).payload.toString());
      assert.equal(a.id, `t${i + 1}`);
      assert.equal(a.status, 503);
      assert.equal(JSON.parse(a.body).error, "not-yet");
    });
    assert.equal(t.s.pending, 0, "no request pending");
    assert.equal(t.clk.pending(), 0, "no timer for the conn");
    assert.equal(t.s.queue.length, 0, "nothing queued");
    assert.equal(t.s.workersStarted, 0, "no worker");
  } finally { await t.s.close(); }
});

test("K22 secrets: the code only in the link and on stderr; the token and the session nowhere", async () => {
  let out = "", err = "";
  const clk = clock();
  const s = await runNotebookPair(["--pair"], { timers: clk, devOrigin: null, out: (x) => (out += x), err: (x) => (err += x) });
  try {
    const u = new URL(out.trim());
    assert.equal(u.origin + u.pathname, PAGE_ORIGIN + "/");
    assert.deepEqual([...u.searchParams.keys()].sort(), ["kpair", "kport"]);
    assert.equal(u.searchParams.get("kpair"), s.code);
    assert.equal(u.searchParams.get("kport"), String(s.port));
    assert.equal(out, `${u.href}\n`, "stdout is the link alone");
    assert.ok(err.includes(s.code), "the code on stderr");
    const h = await hello(s, codeHello(s, { remember: true }));
    const { token, session } = h.result;
    h.c.send({ id: "t1", rpc: "g.run", ref: { b: "b1" } });
    await h.c.next();
    h.c.end();
    await settle();
    for (const secret of [token, session]) assert.ok(!out.includes(secret) && !err.includes(secret), "never written");
  } finally { await s.close(); }
});

test("K23 the server listens on 127.0.0.1 only", async () => {
  const { s } = await server();
  try {
    assert.equal((s.http.address() as any).address, "127.0.0.1");
  } finally { await s.close(); }
});

// ---- r2: the outbound gate (stub sockets: the test sets writableLength and records each write)

test("K24 the data cap: an answer past 7 MiB is not appended; a 1013 close is, in the 1 MiB headroom; then nothing", async () => {
  const { s } = await server();
  try {
    assert.equal(PAIR_LIMITS.outData, 7 * MiB);
    assert.equal(PAIR_LIMITS.outTotal, 8 * MiB);
    const { st, c } = stubPaired(s);
    st.writableLength = 7 * MiB - 100;
    const answer = notYetAnswer("t1");
    assert.ok(frameBytes(Buffer.byteLength(JSON.stringify(answer))) >= 101, "the answer is at least 101 bytes encoded");
    const n0 = st.writes.length;
    c.send(answer);
    assert.equal(st.writableLength, 7 * MiB - 100, "writableLength the same before and after");
    const after = st.writes.slice(n0);
    assert.equal(after.length, 1, "only the close was written, no data frame");
    const f = serverFrame(after[0]);
    assert.equal(f.op, 0x8);
    assert.equal(f.payload.readUInt16BE(0), 1013);
    assert.ok(after[0].length <= 125, "the close frame is at most 125 bytes");
    assert.ok(7 * MiB - 100 + after[0].length <= 8 * MiB, "it fits in the headroom");
    assert.ok(c.closed);
    assert.equal(s.pairedConn, null, "the pairing ended");
    c.send(notYetAnswer("t2"));
    c.feed(masked(0x9, Buffer.from("p")));
    assert.equal(st.writes.length, n0 + 1, "nothing after the 1013: no answer, no pong");
  } finally { await s.close(); }
});

test("K24e the data cap exactly: buffered + the whole frame = 7 MiB is written", async () => {
  const { s } = await server();
  try {
    const { st, c } = stubPaired(s);
    const answer = notYetAnswer("t1");
    const n = frameBytes(Buffer.byteLength(JSON.stringify(answer)));
    st.writableLength = 7 * MiB - n;
    const n0 = st.writes.length;
    c.send(answer);
    assert.equal(st.writes.length, n0 + 1);
    const f = serverFrame(st.writes[n0]);
    assert.equal(f.op, 0x1, "the answer was written");
    assert.equal(st.writes[n0].length, n);
    assert.ok(!c.closed);
  } finally { await s.close(); }
});

function srcText() {
  for (const p of [join(__dirname, "../src/notebook-pair.ts"), join(__dirname, "../../src/notebook-pair.ts")]) if (existsSync(p)) return readFileSync(p, "utf8");
  return assert.fail("src/notebook-pair.ts not found");
}

test("K24b pongs and closes go through the one gate: a pong past 8 MiB is refused and the socket destroyed; static: the only socket writes", async () => {
  const { s } = await server();
  try {
    const { st, c } = stubPaired(s);
    st.writableLength = 8 * MiB - 10;
    const n0 = st.writes.length;
    c.feed(masked(0x9, Buffer.alloc(125, 0x61)));
    assert.equal(st.writes.length, n0, "the pong was not appended");
    assert.ok(st.destroyed, "the socket destroyed");
  } finally { await s.close(); }
  // (static: every socket write is the gate's or the 101 handshake's; every end with an argument is refuseHttp's)
  const src = srcText();
  const gateStart = src.indexOf('  write(frame: Buffer, kind: "data" | "control") {');
  assert.ok(gateStart > 0, "the gate, Conn.write");
  const gateEnd = src.indexOf("\n  }\n", gateStart);
  const refuseStart = src.indexOf("  private refuseHttp(");
  const refuseEnd = src.indexOf("\n  }\n", refuseStart);
  const bad: string[] = [];
  let gate = 0, handshake = 0, refuse = 0;
  for (const m of src.matchAll(/([\w$.]*)\.write\(/g)) {
    const at = m.index!;
    if (m[1] === "process.stdout" || m[1] === "process.stderr") continue; // (the terminal, not a socket)
    if (m[1] === "this" && at > src.indexOf("export class Conn {") && at < src.indexOf("export class PairServer {")) continue; // (a call of the gate itself)
    if (m[1] === "this.sock" && at > gateStart && at < gateEnd) gate++;
    else if (m[1] === "sock" && src.startsWith("sock.write(`HTTP/1.1 101 ", at)) handshake++;
    else bad.push(src.slice(at, at + 60));
  }
  for (const m of src.matchAll(/([\w$.]*)\.end\((\))?/g)) {
    if (m[2]) continue; // (.end() appends nothing)
    const at = m.index!;
    if (m[1] === "sock" && src.startsWith("sock.end(`HTTP/1.1 ${status}", at) && at > refuseStart && at < refuseEnd) refuse++;
    else bad.push(src.slice(at, at + 60));
  }
  for (const re of [/\.(?:write|end)\b(?!\()/g, /\b(?:cork|uncork|writev)\b/g, /\[\s*["'`](?:write|end)["'`]\s*\]/g]) for (const m of src.matchAll(re)) bad.push(src.slice(m.index!, m.index! + 60));
  assert.deepEqual(bad, [], "no other socket write or end, and no alias");
  assert.equal(gate, 1, "one write in the gate");
  assert.equal(handshake, 1, "one write of the 101 handshake");
  assert.equal(refuse, 1, "one end with an argument, refuseHttp's");
});

test("K24t the total cap exactly: buffered + a 127-byte pong = 8 MiB is written", async () => {
  const { s } = await server();
  try {
    const { st, c } = stubPaired(s);
    st.writableLength = 8 * MiB - 127;
    const n0 = st.writes.length;
    c.feed(masked(0x9, Buffer.alloc(125, 0x61)));
    assert.equal(st.writes.length, n0 + 1);
    assert.equal(serverFrame(st.writes[n0]).op, 0xa);
    assert.equal(st.writes[n0].length, 127);
    assert.ok(!st.destroyed);
  } finally { await s.close(); }
});

test("K24u past the total cap: the pong refused, the socket destroyed, and nothing after", async () => {
  const { s } = await server();
  try {
    const { st, c } = stubPaired(s);
    st.writableLength = 8 * MiB - 126;
    const n0 = st.writes.length;
    c.feed(masked(0x9, Buffer.alloc(125, 0x61)));
    assert.equal(st.writes.length, n0, "not appended");
    assert.ok(st.destroyed);
    c.feed(masked(0x9, Buffer.from("p")));
    assert.equal(st.writes.length, n0, "a further pong records nothing");
  } finally { await s.close(); }
});

// ---- r2: the key's sizes, encoding and point, before the thumbprint and the code

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const thumb = (jwk: any) => createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");

test("K26 the sizes before work: jkt, x or y of 65 characters is refused (too long), with no thumbprint", async () => {
  const { s } = await server();
  try {
    for (const field of ["jkt", "x", "y"]) {
      const k = pageKey();
      const jwk: any = { ...k.jwk };
      let jkt = k.jkt;
      if (field === "jkt") jkt = "A".repeat(65); else jwk[field] = "A".repeat(65);
      const t0 = s.stats.thumbprints;
      const h = await hello(s, codeHello(s, { jwk, jkt }));
      assert.ok(h.error, `${field} of 65 refused`);
      assert.match(h.error.message, /too long/, field);
      assert.equal(s.stats.thumbprints, t0, `${field}: no thumbprint`);
      h.c.end();
    }
  } finally { await s.close(); }
});

test("K26e 64 characters pass the size bound and are refused as not canonical, with no thumbprint; a valid key, one", async () => {
  const { s } = await server();
  try {
    for (const field of ["jkt", "x", "y"]) {
      const k = pageKey();
      const jwk: any = { ...k.jwk };
      let jkt = k.jkt;
      if (field === "jkt") jkt = "A".repeat(64); else jwk[field] = "A".repeat(64);
      const t0 = s.stats.thumbprints;
      const h = await hello(s, codeHello(s, { jwk, jkt }));
      assert.ok(h.error, `${field} of 64 refused`);
      assert.match(h.error.message, /not canonical/, field);
      assert.equal(s.stats.thumbprints, t0, `${field}: no thumbprint`);
      h.c.end();
    }
    const t0 = s.stats.thumbprints;
    const ok = await hello(s, codeHello(s));
    assert.ok(ok.result?.token, "a valid key pairs");
    assert.equal(s.stats.thumbprints, t0 + 1, "its thumbprint computed exactly once");
    ok.c.end();
  } finally { await s.close(); }
});

/** Until the socket the server closed is gone: nothing paired, unpaired or closing. */
const gone = (s: PairServer) => until(() => s.pairedConn === null && s.conns.size === 0 && s.closing.size === 0, "the socket gone");

test("K31 an off-curve key (x = y = 0) with its correct jkt is refused before the code: the same code then pairs", async () => {
  const { s } = await server();
  try {
    const zero = Buffer.alloc(32).toString("base64url");
    const jwk = { kty: "EC", crv: "P-256", x: zero, y: zero };
    const h = await hello(s, codeHello(s, { jwk, jkt: thumb(jwk) }));
    assert.ok(h.error, "the off-curve key refused");
    assert.equal(await h.c.closeCode(), 1008);
    h.c.end();
    await gone(s);
    const ok = await hello(s, codeHello(s));
    assert.ok(ok.result?.token, `the code wasn't spent (${JSON.stringify(ok.error)})`);
    ok.c.end();
  } finally { await s.close(); }
});

test("K31b not canonical: a coordinate with its unused bits set (the same point, its own jkt), a jkt of 42 or 44; refused, no thumbprint, the code kept", async () => {
  const { s } = await server();
  try {
    for (const n of [42, 44]) {
      const k = pageKey();
      const jkt = n === 42 ? k.jkt.slice(0, 42) : k.jkt + "A";
      const t0 = s.stats.thumbprints;
      const h = await hello(s, codeHello(s, { jwk: k.jwk, jkt }));
      assert.ok(h.error, `a jkt of ${n} refused`);
      assert.match(h.error.message, /not canonical/, `jkt ${n}: the canonical check's reason`);
      assert.equal(s.stats.thumbprints, t0, `jkt ${n}: no thumbprint`);
      h.c.end();
      await gone(s);
    }
    const k = pageKey();
    const i = B64.indexOf(k.jwk.x[42]);
    const x = k.jwk.x.slice(0, 42) + B64[i ^ 1]; // (only an unused bit: the same 32 bytes, so the same point)
    assert.ok(Buffer.from(x, "base64url").equals(Buffer.from(k.jwk.x, "base64url")));
    const jwk = { ...k.jwk, x };
    const t0 = s.stats.thumbprints;
    const h = await hello(s, codeHello(s, { jwk, jkt: thumb(jwk) }));
    assert.ok(h.error, "the non-canonical coordinate refused");
    assert.match(h.error.message, /not canonical/, "the coordinate: the canonical check's reason");
    assert.equal(s.stats.thumbprints, t0, "the coordinate: no thumbprint");
    h.c.end();
    await gone(s);
    const ok = await hello(s, codeHello(s));
    assert.ok(ok.result?.token, "the code wasn't spent");
    ok.c.end();
  } finally { await s.close(); }
});

// ---- r2: a live slow reader

test("K27 a live slow reader: every write within 20 KiB, the last the 1013 close past the data boundary, then nothing", async () => {
  const DATA = 16 * 1024, TOTAL = 20 * 1024;
  const { s } = await server({ outCaps: { data: DATA, total: TOTAL } });
  let h: any;
  try {
    h = await hello(s, codeHello(s));
    assert.ok(h.result?.token);
    const conn = [...s.conns][0] as any;
    const sock = conn.sock;
    const rec: { kind: string; wl: number; len: number; op: number; code: number | null }[] = [];
    const w = sock.write.bind(sock), e = sock.end.bind(sock);
    sock.write = (b: Buffer, ...r: any[]) => { rec.push({ kind: "write", wl: sock.writableLength, len: b.length, op: b[0] & 0x0f, code: (b[0] & 0x0f) === 0x8 ? b.readUInt16BE(2) : null }); return w(b, ...r); };
    sock.end = (...r: any[]) => { rec.push({ kind: "end", wl: sock.writableLength, len: r[0] ? r[0].length : 0, op: -1, code: null }); return e(...r); };
    h.c.sock.pause();
    const frames: Buffer[] = [];
    for (let i = 0; i < 60_000; i++) frames.push(maskedText({ id: `t${i}`, rpc: "g.run", ref: { b: "b1" } }));
    h.c.sock.write(Buffer.concat(frames));
    await until(() => s.pairedConn === null, "the pairing ended", 30_000);
    const writes = rec.filter((r) => r.kind === "write");
    for (const r of writes) assert.ok(r.wl + r.len <= TOTAL, `a write within the total (${r.wl} + ${r.len})`);
    const last = writes[writes.length - 1];
    assert.equal(last.op, 0x8, "the last write is a close");
    assert.equal(last.code, 1013);
    const largest = Math.max(...writes.filter((r) => r.op === 0x1).map((r) => r.len));
    assert.ok(last.wl > DATA - largest, `the data queue past the data boundary (${last.wl})`);
    assert.ok(rec.slice(rec.indexOf(last) + 1).every((r) => r.kind === "end" && r.len === 0), "nothing after it");
    assert.ok(s.stats.overflows >= 1);
    h.c.sock.resume();
    let lastFrame: Ev | null = null;
    for (;;) { const ev = await h.c.next(5000); if (ev.type === "end") break; lastFrame = ev; }
    assert.equal(lastFrame?.type, "close", "the reader's last frame is the close");
    assert.equal((lastFrame as any).code, 1013);
  } finally { h?.c.end(); await s.close(); }
});

// ---- r2: RFC 6455 framing

test("K29a a Close with a 1-byte payload closes 1002", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    c.frame(0x8, Buffer.from([0x03]));
    assert.equal(await c.closeCode(), 1002);
  } finally { await s.close(); }
});

test("K29b a Close whose status a peer may not send closes 1002", async () => {
  const { s } = await server();
  try {
    for (const status of [1005, 1006, 1015, 999, 1004, 5000]) {
      const c = await open(s.port);
      c.frame(0x8, Buffer.from([status >> 8, status & 255]));
      assert.equal(await c.closeCode(), 1002, `status ${status}`);
      c.end();
    }
  } finally { await s.close(); }
});

test("K29c a Close 1000 whose reason isn't UTF-8 closes 1007", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    c.frame(0x8, Buffer.from([0x03, 0xe8, 0xff]));
    assert.equal(await c.closeCode(), 1007);
  } finally { await s.close(); }
});

test("K29d a valid Close (empty, or 1000 \"bye\") is answered with Close 1000, and the socket ends", async () => {
  const { s } = await server();
  try {
    for (const payload of [Buffer.alloc(0), Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("bye")])]) {
      const c = await open(s.port);
      c.frame(0x8, payload);
      assert.equal(await c.closeCode(), 1000, `payload of ${payload.length}`);
      assert.equal((await c.next()).type, "end", "then the socket ends");
    }
  } finally { await s.close(); }
});

test("K30 a length not in its shortest form closes 1002 before anything reads the frame, and the code isn't spent", async (t) => {
  // (two independent halves, each on its own server; both outcomes recorded before either is asserted)
  const out: Record<string, string> = {};
  const a = await server();
  try {
    const c = await open(a.s.port);
    const txt = Buffer.from(JSON.stringify(codeHello(a.s)));
    assert.ok(txt.length >= 126 && txt.length < 65536);
    c.rawFrame(0x1, txt, 127);
    const ev = await c.next();
    out.hello127 = ev.type === "close" ? `close ${ev.code}` : ev.type === "text" ? `text ${ev.data.result ? "result" : "error"}` : ev.type;
    c.end();
    await gone(a.s);
    const ok = await hello(a.s, codeHello(a.s));
    out.hello127retry = ok.result?.token ? "paired" : `refused ${ok.error?.message}`;
    ok.c.end();
  } finally { await a.s.close(); }
  const b = await server();
  try {
    const c = await open(b.s.port);
    c.rawFrame(0x9, Buffer.from("p"), 126);
    const ev = await c.next();
    out.ping126 = ev.type === "close" ? `close ${ev.code}` : ev.type;
    c.end();
    await gone(b.s);
    const ok = await hello(b.s, codeHello(b.s));
    out.ping126retry = ok.result?.token ? "paired" : `refused ${ok.error?.message}`;
    ok.c.end();
  } finally { await b.s.close(); }
  t.diagnostic(`K30 outcomes: ${JSON.stringify(out)}`);
  assert.deepEqual(out, { hello127: "close 1002", hello127retry: "paired", ping126: "close 1002", ping126retry: "paired" });
});

test("K32 valid framing is read: a hello in 3 fragments around a ping pairs (the pong comes back); 16- and 64-bit lengths after it", async () => {
  const { s } = await server();
  try {
    const c = await open(s.port);
    const txt = Buffer.from(JSON.stringify(codeHello(s)));
    c.frame(0x1, txt.subarray(0, 50), { fin: false });
    c.frame(0x9, Buffer.from("hi"));
    c.frame(0x0, txt.subarray(50, 100), { fin: false });
    c.frame(0x0, txt.subarray(100));
    const pong = await c.next();
    assert.equal(pong.type, "pong");
    assert.equal((pong as any).data.toString(), "hi");
    const r = await c.next();
    assert.ok(r.type === "text" && r.data.result?.token, "paired");
    for (const [id, pad] of [["t1", 200], ["t2", 70_000]] as const) {
      c.send({ id, rpc: "g.run", pad: "x".repeat(pad) }); // (200: a 16-bit length; 70,000: a 64-bit one)
      const e = await c.next();
      assert.ok(e.type === "text", `${id} answered`);
      assert.equal((e as any).data.id, id);
      assert.equal(JSON.parse((e as any).data.body).error, "not-yet");
    }
    c.end();
  } finally { await s.close(); }
});

// ---- r2: closing sockets, bounded

test("K33 a closing socket whose page isn't reading stays in closing until it is destroyed after closingMs", async () => {
  const { s, clk } = await server();
  let h: any;
  try {
    h = await hello(s, codeHello(s));
    const conn = s.pairedConn as Conn;
    h.c.send({ unpair: true });
    h.c.sock.pause();
    await until(() => s.closing.size === 1, "closing");
    assert.ok(s.closing.has(conn));
    await settle();
    clk.advance(PAIR_LIMITS.closingMs - 1);
    assert.ok(s.closing.has(conn), "still closing before closingMs");
    assert.ok(!conn.sock.destroyed);
    clk.advance(1);
    assert.equal(s.closing.size, 0, "out of closing at closingMs");
    assert.ok(conn.sock.destroyed, "destroyed");
  } finally { h?.c.end(); await s.close(); }
});

test("K34 server.close() clears every hello and closing timer and destroys every socket", async () => {
  const { s, clk } = await server();
  let u: Client | null = null, h: any;
  try {
    u = await open(s.port);
    h = await hello(s, codeHello(s));
    h.c.send({ unpair: true });
    h.c.sock.pause();
    await until(() => s.closing.size === 1 && s.conns.size === 1, "one closing, one in its hello");
    const socks = [...s.conns, ...s.closing].map((c) => c.sock);
    const done = s.close();
    assert.equal(clk.pending(), 0, "no timer left");
    assert.equal(s.conns.size, 0);
    assert.equal(s.closing.size, 0);
    assert.ok(socks.every((x) => x.destroyed), "every socket destroyed");
    await done;
  } finally { u?.end(); h?.c.end(); await s.close(); }
});

test("K36 at most 8 closing at once: 20 refused hellos with paused readers; past the cap destroyed at once, no timer kept; drained after 5 s", async () => {
  const { s, clk } = await server();
  const clients: Client[] = [], conns: Conn[] = [];
  try {
    const d0 = s.stats.destroyedAtCap;
    let timers = 0; // (after the previous close)
    for (let i = 0; i < 20; i++) {
      const c = await open(s.port);
      clients.push(c);
      await until(() => s.conns.size === 1, "the socket attached");
      const conn = [...s.conns][0];
      conns.push(conn);
      const k = pageKey();
      c.send(helloMsg({ protocol: 1, purpose: "kernel", page: { origin: PAGE_ORIGIN, path: "/" }, jwk: k.jwk, jkt: k.jkt })); // (neither code nor session: 1008)
      c.sock.pause();
      await until(() => s.conns.size === 0, "closed by the server");
      // (sampled after each close; no socket is in its hello now, so every timer is a closing timer)
      assert.ok(s.closing.size <= PAIR_LIMITS.closing, `closing ${s.closing.size} after close ${i + 1}`);
      assert.ok(clk.pending() <= PAIR_LIMITS.closing, `closing timers ${clk.pending()} after close ${i + 1}`);
      if (i >= PAIR_LIMITS.closing) {
        assert.ok(!s.closing.has(conn), `close ${i + 1}: not closing`);
        assert.equal(clk.pending(), timers, `close ${i + 1}: no closing timer kept`);
        assert.ok(conn.sock.destroyed, `close ${i + 1}: destroyed at once`);
      }
      timers = clk.pending();
    }
    assert.ok(s.stats.destroyedAtCap - d0 >= 12, `destroyed at the cap: ${s.stats.destroyedAtCap - d0}`);
    clk.advance(PAIR_LIMITS.closingMs);
    assert.equal(s.closing.size, 0, "drained after 5 s");
    assert.equal(clk.pending(), 0, "no timer left");
    assert.ok(conns.every((c) => c.sock.destroyed), "every transport destroyed");
  } finally { for (const c of clients) c.end(); await s.close(); }
});

// ---- r3: the fragment bound (local-kernel-p2-r3-canonical, frozen jointly before the run)
const lastClose = (st: any) => {
  const f = serverFrame(st.writes[st.writes.length - 1]);
  return f.op === 0x8 ? { code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString() } : null;
};
const pairedOn = (st: any) => st.writes.some((w: Buffer) => {
  const f = serverFrame(w);
  if (f.op !== 0x1) return false;
  try { return typeof JSON.parse(f.payload.toString()).result?.token === "string"; } catch { return false; }
});
const pongs = (st: any) => st.writes.map((w: Buffer) => serverFrame(w)).filter((f: any) => f.op === 0xa).map((f: any) => f.payload.toString());
/** `buf` cut into `n` non-empty pieces, as even as possible. */
function cut(buf: Buffer, n: number) {
  const out: Buffer[] = [];
  for (let i = 0, at = 0; i < n; i++) {
    const size = Math.floor(buf.length / n) + (i < buf.length % n ? 1 : 0);
    out.push(buf.subarray(at, at + size));
    at += size;
  }
  return out;
}
/** Text fragments: the first a text frame, the rest continuations; the last one final unless `open`. */
const fragmentsOf = (pieces: Buffer[], open = false) => pieces.map((p, i) => masked(i === 0 ? 0x1 : 0x0, p, !open && i === pieces.length - 1));
const padded = (s: PairServer, size = 1100) => { const t = JSON.stringify(codeHello(s)); return Buffer.from(t + " ".repeat(size - t.length)); };
const unpaired = (s: PairServer) => { const st = stubSock(); return { st, c: s.attach(st) }; };

test("K37 empty storm: one byte, then 1100 empty continuations: closed 1009 (too many fragments), maxFragments === 1024", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    c.feed(masked(0x1, Buffer.from("{"), false));
    for (let i = 0; i < 1100 && !st.ended; i++) c.feed(masked(0x0, Buffer.alloc(0), false));
    assert.deepEqual(lastClose(st), { code: 1009, reason: "too many fragments" });
    assert.equal(s.stats.maxFragments, 1024);
  } finally { await s.close(); }
});

test("K37s one-byte storm: 1100 one-byte continuations (under 8 KiB): closed 1009 (too many fragments), maxFragments === 1024", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    c.feed(masked(0x1, Buffer.from("{"), false));
    for (let i = 0; i < 1100 && !st.ended; i++) c.feed(masked(0x0, Buffer.from(" "), false));
    assert.deepEqual(lastClose(st), { code: 1009, reason: "too many fragments" });
    assert.equal(s.stats.maxFragments, 1024);
  } finally { await s.close(); }
});

test("K37a at the cap: a padded hello in exactly 1024 non-empty fragments pairs, maxFragments === 1024", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    for (const f of fragmentsOf(cut(padded(s), 1024))) c.feed(f);
    assert.ok(pairedOn(st), "paired (result.token)");
    assert.equal(s.stats.maxFragments, 1024);
  } finally { await s.close(); }
});

test("K37b cap + 1: the same hello in 1025 fragments: closed 1009 (too many fragments), maxFragments === 1024, not paired, the code not spent", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    for (const f of fragmentsOf(cut(padded(s), 1025))) { if (st.ended) break; c.feed(f); }
    assert.deepEqual(lastClose(st), { code: 1009, reason: "too many fragments" });
    assert.equal(s.stats.maxFragments, 1024);
    assert.ok(!pairedOn(st), "not paired");
    const b = unpaired(s);
    b.c.feed(maskedText(codeHello(s)));
    assert.ok(pairedOn(b.st), "a following hello pairs");
  } finally { await s.close(); }
});

test("K37e empty first: an empty non-final text frame, then the hello in 2 continuations, pairs", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    const t = Buffer.from(JSON.stringify(codeHello(s)));
    c.feed(masked(0x1, Buffer.alloc(0), false));
    c.feed(masked(0x0, t.subarray(0, 50), false));
    c.feed(masked(0x0, t.subarray(50), true));
    assert.ok(pairedOn(st), "paired");
  } finally { await s.close(); }
});

test("K37p ping inside: text, empty, ping, empty, the rest (non-empty, final): the pong comes back and it pairs", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    const t = Buffer.from(JSON.stringify(codeHello(s)));
    c.feed(masked(0x1, t.subarray(0, 50), false));
    c.feed(masked(0x0, Buffer.alloc(0), false));
    c.feed(masked(0x9, Buffer.from("hi")));
    c.feed(masked(0x0, Buffer.alloc(0), false));
    c.feed(masked(0x0, t.subarray(50), true));
    assert.deepEqual(pongs(st), ["hi"]);
    assert.ok(pairedOn(st), "paired");
  } finally { await s.close(); }
});

test("K37q near-cap ping: 1000 fragments, a ping, 25 more (1025): the pong, then closed 1009 (too many fragments), maxFragments === 1024, not paired", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    const frames = fragmentsOf(cut(padded(s), 1025));
    for (const f of frames.slice(0, 1000)) c.feed(f);
    c.feed(masked(0x9, Buffer.from("q")));
    for (const f of frames.slice(1000)) { if (st.ended) break; c.feed(f); }
    assert.deepEqual(pongs(st), ["q"]);
    assert.deepEqual(lastClose(st), { code: 1009, reason: "too many fragments" });
    assert.equal(s.stats.maxFragments, 1024);
    assert.ok(!pairedOn(st), "not paired");
  } finally { await s.close(); }
});

test("K37c byte vs count on one frame: 1024 one-byte fragments, then an 8 KiB 1025th: closed 1009 by the byte cap (message too big)", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    c.feed(masked(0x1, Buffer.from("{"), false));
    for (let i = 0; i < 1023; i++) c.feed(masked(0x0, Buffer.from(" "), false));
    assert.equal(st.ended, 0, "1024 fragments: still open");
    c.feed(masked(0x0, Buffer.alloc(8192, 0x20), false));
    assert.deepEqual(lastClose(st), { code: 1009, reason: "message too big" });
  } finally { await s.close(); }
});

test("K38 a 64-bit length with its top bit set closes 1002", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    const h = Buffer.alloc(14);
    h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE((1n << 63n) + 1n, 2); randomBytes(4).copy(h, 10);
    c.feed(h);
    assert.deepEqual(lastClose(st), { code: 1002, reason: "a 64-bit length's top bit must be 0" });
  } finally { await s.close(); }
});

test("K39e ended() releases: one write (a fragment, a reserved opcode, 3 trailing bytes): closing with no input kept", async () => {
  const { s } = await server();
  try {
    const { st, c } = unpaired(s);
    c.feed(Buffer.concat([masked(0x1, Buffer.from("{"), false), masked(0x3, Buffer.alloc(0)), Buffer.from([0x81, 0x85, 0x01])]));
    assert.equal(lastClose(st)?.code, 1002);
    assert.ok(s.closing.has(c), "closing");
    assert.deepEqual([c.buf.length, c.parts.length, c.partsLen, c.inMsg, c.fragments], [0, 0, 0, false, 0]);
  } finally { await s.close(); }
});

test("K39d destroy() releases: a half-read message, then a refused pong past the total cap: destroyed with no input kept", async () => {
  const { s } = await server();
  try {
    const { st, c } = stubPaired(s);
    st.writableLength = 8 * MiB - 126;
    c.feed(masked(0x1, Buffer.from("{"), false));
    assert.equal(c.inMsg, true, "a message half read");
    c.feed(Buffer.concat([masked(0x9, Buffer.alloc(125, 0x61)), Buffer.from([0x81, 0x85, 0x01])]));
    assert.ok(st.destroyed, "destroyed (the pong refused)");
    assert.deepEqual([c.buf.length, c.parts.length, c.partsLen, c.inMsg, c.fragments], [0, 0, 0, false, 0]);
  } finally { await s.close(); }
});

// ---- r4: every path that stops reading releases (the socket's abrupt close, and server.close())
const inputState = (c: any) => [c.buf.length, c.parts.length, c.partsLen, c.inMsg, c.fragments];
/** A half-read message (a non-empty fragment) and the first 3 bytes of the next header, in one feed. */
const halfRead = () => Buffer.concat([masked(0x1, Buffer.from("{"), false), Buffer.from([0x81, 0x85, 0x01])]);

test("K39a abrupt close releases: a half-read message and a partial header, then the socket's close (no FIN): dropped with no input kept", async () => {
  const { s } = await server();
  try {
    const st = stubSock(), on: any = {};
    st.on = (ev: string, fn: () => void) => { (on[ev] ??= []).push(fn); return st; };
    const c = s.attach(st);
    c.feed(halfRead());
    assert.deepEqual(inputState(c), [3, 1, 1, true, 1], "half read");
    for (const fn of on.close) fn();
    assert.ok(c.closed && !s.conns.has(c) && !s.closing.has(c), "dropped");
    assert.deepEqual(inputState(c), [0, 0, 0, false, 0]);
  } finally { await s.close(); }
});

test("K39s server close releases: a half-read message and a partial header on an open socket, then server.close(): destroyed with no input kept", async () => {
  const { s } = await server();
  let shut = false;
  try {
    const { st, c } = unpaired(s);
    c.feed(halfRead());
    assert.deepEqual(inputState(c), [3, 1, 1, true, 1], "half read");
    shut = true;
    await s.close();
    assert.ok(st.destroyed, "destroyed");
    assert.deepEqual(inputState(c), [0, 0, 0, false, 0]);
  } finally { if (!shut) await s.close(); }
});
