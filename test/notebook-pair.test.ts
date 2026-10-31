import test from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairServer, PAIR_LIMITS, PAIR_PATH, PAGE_ORIGIN, runNotebookPair } from "../src/notebook-pair";

// `sagebrush notebook --pair` (src/notebook-pair.ts), phase 2: the pairing alone.  Cases K1–K23 as frozen with the
// grader (/scratch/sagebrush-reviews/grader-local-kernel-phase2-cases-FROZEN.md); each test's name starts with its
// case.  A raw socket plays the page (so a handshake or a frame can be wrong on purpose), on an injected clock.

// ---- an injected clock
function clock() {
  let t = 1_000_000, n = 0, q: { at: number; f: () => void; id: number }[] = [];
  return {
    now: () => t,
    setTimeout(f: () => void, ms: number) { const id = ++n; q.push({ at: t + ms, f, id }); return id; },
    clearTimeout(id: any) { q = q.filter((x) => x.id !== id); },
    advance(ms: number) { t += ms; const due = q.filter((x) => x.at <= t); q = q.filter((x) => x.at > t); for (const d of due) d.f(); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

// ---- the page's key
function pageKey() {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j: any = publicKey.export({ format: "jwk" });
  const jwk = { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  const jkt = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");
  return { jwk, jkt };
}

// ---- a raw client
type Ev = { type: "text"; data: any; raw: string } | { type: "close"; code: number; reason: string } | { type: "end" };
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
  send(obj: unknown) { this.frame(0x1, Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj))); }
  end() { this.sock.destroy(); }
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
