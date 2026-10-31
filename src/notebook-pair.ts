// `sagebrush notebook --pair`: this computer's side of "Your computer (paired)", the sagebrush.space page's
// third runner (design: /scratch/sagebrush-reviews/remote-compute/local-kernel-plan-r3.1, plan-r2 + delta-r3 +
// delta-r3.1).  Phase 2: the pairing alone; no kernel yet (a request after the hello is refused, "not-yet").
//
// The contract is the agent pairing's (design/workspace-agent-protocol.md §2), at its own path:
//   - a WebSocket on the loopback address only, at GET /sagebrush-kernel (any other path: 400, before any
//     WebSocket, so no hello and no code is spent; the agent helper listens on /sagebrush);
//   - the Origin exactly https://sagebrush.space (or the one development origin SAGEBRUSH_KERNEL_DEV_ORIGIN names,
//     compared as a whole string), the Host 127.0.0.1:<port> or localhost:<port> (no DNS rebinding);
//   - a 128-bit code, single use, for 5 minutes, compared in constant time; 5 wrong attempts retire it;
//   - the hello carries purpose "kernel", exactly one of code and session, and the page's DPoP public key and its
//     RFC 7638 thumbprint; the result, a token for this socket and that key, a DPoP nonce, and (asked to remember)
//     a session secret, kept here only as its SHA-256, in memory;
//   - one paired page at a time; at most 8 sockets in their handshake or hello; 8 KiB before the hello; the hello
//     within 30 s; RFC 6455 framing, strict, as a server must read a client's.
import * as http from "http";
import type { Duplex } from "stream";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const PAIR_PATH = "/sagebrush-kernel";
export const PAGE_ORIGIN = "https://sagebrush.space";
export const PAIR_LIMITS = Object.freeze({
  codeMs: 5 * 60_000, // a code's life
  wrongAttempts: 5, // wrong codes (or wrong purposes) before the code is retired; wrong sessions before it is forgotten
  helloMs: 30_000, // from connecting to the hello
  unpaired: 8, // sockets in their handshake or hello at once
  preHello: 8 * 1024, // a frame (a message) before the hello
  frame: 2.25 * 1024 * 1024 + 64 * 1024, // a message after it: a run's body (BODY_MAX.run, remote-client.js) and its envelope
});
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

type Timers = { now(): number; setTimeout(f: () => void, ms: number): any; clearTimeout(t: any): void };
const REAL: Timers = { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };

export type PairOptions = {
  port?: number; // 0 (the default): the system's choice
  devOrigin?: string | null; // SAGEBRUSH_KERNEL_DEV_ORIGIN
  timers?: Timers;
  out?: (s: string) => void; // the link (stdout)
  err?: (s: string) => void; // the code and notes (stderr)
};

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();
function base32(b: Buffer) {
  let bits = 0, v = 0, s = "";
  for (const x of b) {
    v = (v << 8) | x;
    bits += 8;
    while (bits >= 5) { s += B32[(v >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) s += B32[(v << (5 - bits)) & 31];
  return s;
}
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The RFC 7638 thumbprint of an EC P-256 public JWK: SHA-256 over {crv, kty, x, y} in that order. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }) {
  return b64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}
const B64URL = /^[A-Za-z0-9_-]+$/;
/** Exactly {kty:"EC", crv:"P-256", x, y}, each coordinate 32 bytes as base64url. */
function jwkShape(j: any) {
  if (!j || typeof j !== "object" || Array.isArray(j)) return false;
  const keys = Object.keys(j).sort();
  if (keys.join() !== "crv,kty,x,y") return false;
  return j.kty === "EC" && j.crv === "P-256" && [j.x, j.y].every((c) => typeof c === "string" && B64URL.test(c) && Buffer.from(c, "base64url").length === 32);
}

/**
 * Strict JSON: valid JSON (RFC 8259) with no key twice in an object, or an Error.  (JSON.parse takes the last of
 * two equal keys silently; the pairing refuses such a message as malformed, 1007.)
 */
export function strictJson(text: string): any {
  let i = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const fail = (): never => { throw new Error("malformed JSON"); };
  const str = (): string => {
    const start = i;
    if (text[i] !== '"') fail();
    i++;
    for (;;) {
      if (i >= text.length) fail();
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === "\\") { i += text[i + 1] === "u" ? 6 : 2; continue; }
      if (c < " ") fail();
      i++;
    }
    return JSON.parse(text.slice(start, i));
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) fail();
        seen.add(k);
        ws();
        if (text[i] !== ":") fail();
        i++;
        value();
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return; }
      for (;;) {
        value();
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        fail();
      }
    }
    if (c === '"') { str(); return; }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) fail();
    i += m![0].length;
  };
  value();
  ws();
  if (i !== text.length) fail();
  return JSON.parse(text);
}

// ---- one socket's frames (RFC 6455 §5, read as a server reads a client: masked, no reserved bits or opcodes)

class Conn {
  buf: Buffer = Buffer.alloc(0);
  parts: Buffer[] = [];
  partsLen = 0;
  closed = false;
  paired = false;
  token: string | null = null;
  jkt: string | null = null;
  helloTimer: any = null;
  constructor(readonly sock: Duplex, readonly server: PairServer) {}

  send(obj: unknown) {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(obj));
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    this.sock.write(Buffer.concat([head, payload]));
  }
  close(code: number, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 120));
    const body = Buffer.concat([Buffer.from([code >> 8, code & 255]), r]);
    this.sock.write(Buffer.concat([Buffer.from([0x88, body.length]), body]));
    this.closed = true;
    this.sock.end();
    this.server.dropped(this);
  }
  cap() { return this.paired ? PAIR_LIMITS.frame : PAIR_LIMITS.preHello; }

  feed(chunk: Buffer) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.closed || this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, rsv = b0 & 0x70, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      if (rsv) return this.close(1002, "reserved bits");
      if (!masked) return this.close(1002, "a client frame must be masked");
      let len = b1 & 0x7f, at = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(PAIR_LIMITS.frame) * 2n) return this.close(1009, "too big");
        len = Number(big); at = 10;
      }
      const control = op >= 0x8;
      if (control && (len > 125 || !fin)) return this.close(1002, "bad control frame");
      // (the cap, checked from the length alone, before any of the payload is buffered or parsed)
      if (!control && this.partsLen + len > this.cap()) return this.close(1009, "message too big");
      if (this.buf.length < at + 4 + len) return;
      const mask = this.buf.subarray(at, at + 4);
      const payload = Buffer.from(this.buf.subarray(at + 4, at + 4 + len));
      for (let k = 0; k < payload.length; k++) payload[k] ^= mask[k & 3];
      this.buf = this.buf.subarray(at + 4 + len);
      if (op === 0x8) return this.close(1000);
      if (op === 0x9) { this.sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0xa) continue;
      if (op === 0x2) return this.close(1003, "text frames only");
      if (op === 0x1) { if (this.parts.length) return this.close(1002, "a new message inside a fragmented one"); }
      else if (op === 0x0) { if (!this.parts.length) return this.close(1002, "a continuation with nothing to continue"); }
      else return this.close(1002, "reserved opcode");
      this.parts.push(payload);
      this.partsLen += payload.length;
      if (!fin) continue;
      const whole = Buffer.concat(this.parts);
      this.parts = [];
      this.partsLen = 0;
      let text: string, msg: any;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(whole); } catch { return this.close(1007, "not UTF-8"); }
      try { msg = strictJson(text); } catch { return this.close(1007, "malformed JSON"); }
      this.server.message(this, msg);
    }
  }
}

export class PairServer {
  readonly http: http.Server;
  readonly timers: Timers;
  readonly devOrigin: string | null;
  readonly err: (s: string) => void; // (notes for the person, on stderr: never a secret)
  port = 0;
  code: string;
  codeIssued: number;
  codeUsed = false;
  codeRetired = false;
  wrong = 0; // wrong codes or purposes, against the current code
  session: Buffer | null = null; // the remembered session's SHA-256, in memory only
  sessionWrong = 0;
  pairedConn: Conn | null = null;
  unpairedCount = 0;
  conns = new Set<Conn>();
  nonce = b64url(randomBytes(16));
  workersStarted = 0; // (phase 3 starts the session's worker for the first run; until then, never)

  constructor(opts: PairOptions = {}) {
    this.timers = opts.timers ?? REAL;
    this.devOrigin = opts.devOrigin ?? null;
    this.err = opts.err ?? ((s: string) => process.stderr.write(s));
    this.code = base32(randomBytes(16)); // (128 bits, 26 letters and digits)
    this.codeIssued = this.timers.now();
    this.http = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.http.on("upgrade", (req, sock, head) => this.upgrade(req, sock, head));
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(port, "127.0.0.1", () => {
        this.port = (this.http.address() as any).port;
        resolve(this.port);
      });
    });
  }
  link() { return `${this.devOrigin ?? PAGE_ORIGIN}/?kpair=${this.code}&kport=${this.port}`; }

  close() {
    for (const c of this.conns) { c.closed = true; c.sock.destroy(); }
    this.conns.clear();
    return new Promise<void>((r) => this.http.close(() => r()));
  }

  private refuseHttp(sock: Duplex, status: number, text: string) {
    sock.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  private upgrade(req: http.IncomingMessage, sock: Duplex, head: Buffer) {
    sock.on("error", () => {});
    const path = (req.url ?? "").split("?")[0];
    if (path !== PAIR_PATH) return this.refuseHttp(sock, 400, "Bad Request");
    // (a repeated header is refused before anything reads it: node merges or drops repeats in req.headers)
    const count = (name: string) => { let n = 0; for (let k = 0; k < req.rawHeaders.length; k += 2) if (req.rawHeaders[k].toLowerCase() === name) n++; return n; };
    if (["origin", "host", "sec-websocket-key", "sec-websocket-version", "upgrade", "connection"].some((h) => count(h) > 1)) return this.refuseHttp(sock, 400, "Bad Request");
    const origin = req.headers.origin;
    if (!(origin === PAGE_ORIGIN || (this.devOrigin !== null && origin === this.devOrigin))) return this.refuseHttp(sock, 403, "Forbidden");
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.refuseHttp(sock, 403, "Forbidden");
    const key = req.headers["sec-websocket-key"];
    const keyOk = typeof key === "string" && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, "base64").length === 16;
    if (req.method !== "GET" || !keyOk || req.headers["sec-websocket-version"] !== "13" || String(req.headers.upgrade).toLowerCase() !== "websocket") return this.refuseHttp(sock, 403, "Forbidden");
    if (this.unpairedCount >= PAIR_LIMITS.unpaired) return this.refuseHttp(sock, 503, "Service Unavailable");
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const c = new Conn(sock, this);
    this.conns.add(c);
    this.unpairedCount++;
    c.helloTimer = this.timers.setTimeout(() => { if (!c.paired) c.close(1008, "no hello in time"); }, PAIR_LIMITS.helloMs);
    sock.on("data", (d: Buffer) => c.feed(d));
    // (the page gone: its FIN ("end"; an upgraded socket is half-open, so "close" alone would wait for ours) or
    // the socket's close; either ends the pairing it held)
    const gone = () => { if (!c.closed) { c.closed = true; sock.end(); this.dropped(c); } };
    sock.on("end", gone);
    sock.on("close", gone);
    if (head?.length) c.feed(head);
  }

  /** A socket gone: its hello timer, its place among the unpaired, or the pairing it held (and its token). */
  dropped(c: Conn) {
    this.timers.clearTimeout(c.helloTimer);
    if (!this.conns.delete(c)) return;
    if (c.paired) { if (this.pairedConn === c) this.pairedConn = null; c.token = null; }
    else this.unpairedCount--;
  }

  private refuse(c: Conn, id: unknown, kind: "refused" | "protocol", message: string) {
    c.send({ jsonrpc: "2.0", id: typeof id === "string" ? id : null, error: { code: -32000, message, data: { code: kind, message } } });
    c.close(kind === "refused" ? 1008 : 1002, message);
  }

  private retireIfSpent() {
    if (this.wrong >= PAIR_LIMITS.wrongAttempts) this.codeRetired = true;
  }

  message(c: Conn, msg: any) {
    if (!c.paired) return this.hello(c, msg);
    // (after the hello: notifications, and requests the kernel will answer, phase 3)
    if (msg && typeof msg === "object" && !Array.isArray(msg) && msg.unpair === true && Object.keys(msg).length === 1) {
      this.session = null;
      this.sessionWrong = 0;
      return c.close(1000, "unpaired");
    }
    if (msg && typeof msg === "object" && typeof msg.id === "string" && /^t\d{1,15}$/.test(msg.id)) {
      return c.send({ id: msg.id, status: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not-yet", message: "this computer's kernel isn't available in this version" }) });
    }
    return c.close(1002, "not a message of this protocol");
  }

  private hello(c: Conn, msg: any) {
    const ok = msg && typeof msg === "object" && !Array.isArray(msg) && msg.jsonrpc === "2.0" && typeof msg.id === "string" && msg.method === "hello" && msg.params && typeof msg.params === "object" && !Array.isArray(msg.params);
    if (!ok) return this.refuse(c, msg?.id, "protocol", "the first message must be the hello");
    const p = msg.params;
    if (p.protocol !== 1) return this.refuse(c, msg.id, "protocol", "protocol 1 only");
    const hasCode = typeof p.code === "string", hasSession = typeof p.session === "string";
    if (hasCode === hasSession) return this.refuse(c, msg.id, "refused", "a hello carries exactly one of code and session");
    if (!jwkShape(p.jwk)) return this.refuse(c, msg.id, "refused", "the page's key must be an EC P-256 public key");
    if (typeof p.jkt !== "string" || p.jkt !== jwkThumbprint(p.jwk)) return this.refuse(c, msg.id, "refused", "the key's thumbprint doesn't match");
    if (hasCode) {
      if (this.codeUsed) return this.refuse(c, msg.id, "refused", "this code was used: run the command again for a new one");
      if (this.codeRetired) return this.refuse(c, msg.id, "refused", "too many wrong attempts: run the command again for a new code");
      if (this.timers.now() - this.codeIssued > PAIR_LIMITS.codeMs) return this.refuse(c, msg.id, "refused", "this code expired: run the command again for a new one");
      if (!sameText(p.code.toUpperCase(), this.code)) {
        this.wrong++;
        this.retireIfSpent();
        return this.refuse(c, msg.id, "refused", "wrong code");
      }
      // (the right code with a wrong purpose: a wrong attempt, and the code is NOT spent)
      if (p.purpose !== "kernel") {
        this.wrong++;
        this.retireIfSpent();
        return this.refuse(c, msg.id, "refused", "this is a kernel's pairing (purpose \"kernel\")");
      }
      if (this.pairedConn) return this.refuse(c, msg.id, "refused", "another page is paired with this computer");
      this.codeUsed = true;
      let session: string | undefined;
      if (p.remember === true) {
        session = b64url(randomBytes(32));
        this.session = sha256(session);
        this.sessionWrong = 0;
      }
      return this.paired(c, msg.id, p.jkt, session);
    }
    if (p.purpose !== "kernel") return this.refuse(c, msg.id, "refused", "this is a kernel's pairing (purpose \"kernel\")");
    if (!this.session) return this.refuse(c, msg.id, "refused", "this computer doesn't remember a page: pair with a new code");
    if (!timingSafeEqual(sha256(p.session), this.session)) {
      if (++this.sessionWrong >= PAIR_LIMITS.wrongAttempts) { this.session = null; this.sessionWrong = 0; }
      return this.refuse(c, msg.id, "refused", "wrong session");
    }
    if (this.pairedConn) return this.refuse(c, msg.id, "refused", "another page is paired with this computer");
    return this.paired(c, msg.id, p.jkt, undefined);
  }

  private paired(c: Conn, id: string, jkt: string, session: string | undefined) {
    this.timers.clearTimeout(c.helloTimer);
    c.paired = true;
    c.jkt = jkt;
    c.token = b64url(randomBytes(32)); // (this socket's and this key's; never written anywhere)
    this.unpairedCount--;
    this.pairedConn = c;
    this.err("A page is paired.\n");
    c.send({ jsonrpc: "2.0", id, result: { protocol: 1, purpose: "kernel", token: c.token, nonce: this.nonce, limits: { frame: PAIR_LIMITS.frame, inFlight: 8 }, ...(session ? { session } : {}) } });
  }
}

/** `sagebrush notebook --pair [--port N]`: the link on stdout, the code on stderr; runs until stopped. */
export async function runNotebookPair(args: string[], opts: PairOptions = {}) {
  let port = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = Number(args[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice(7));
    else if (a !== "--pair") throw new Error(`sagebrush notebook --pair: unknown argument ${a}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port takes a port number");
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const devOrigin = opts.devOrigin !== undefined ? opts.devOrigin : (process.env.SAGEBRUSH_KERNEL_DEV_ORIGIN || null);
  const server = new PairServer({ ...opts, devOrigin, err });
  await server.listen(port);
  out(`${server.link()}\n`);
  err(`Open the link above in Chrome, Edge or Firefox, or paste it in the page's "Your computer (paired)" dialog.\n` +
    `Pairing code: ${server.code} (single use, for 5 minutes). Code you run there will run on this computer, with your files and permissions.\n`);
  return server;
}
