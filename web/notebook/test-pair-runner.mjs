// ci: none (run by engine/py/test_remote_pair.py, in the job that builds the runner: it needs `sagebrush remote`)
// "Your computer (paired)" end to end, without a browser: the page's own RemoteKernel and RemoteClient
// (remote-kernel.js, remote-client.js) through pair-tunnel.js to the real runner, `python -m sagebrush.cli remote
// --loopback`, on 127.0.0.1.  A browser's WebSocket sends the page's Origin, and Node's can't, so the socket here
// is a small RFC 6455 client (OriginSocket) with the browser API's shape, sending Origin: https://sagebrush.space.
// The pairing, a Python run and its output, an error, Stop of a busy run, Restart (variables gone), a request
// refused unsent while the socket is down (never replayed), Disconnect, and pairing again with the remembered
// session (the binding and its variables kept).  Every wait is bounded.
//   PYTHON=python3 node web/notebook/test-pair-runner.mjs      (PYTHONPATH must reach the sagebrush package)
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { RemoteClient, NotSentError } from "./remote-client.js";
import { RemoteKernel } from "./remote-kernel.js";
import { pairTunnel, SYNTHETIC_BASE, parsePairLink } from "./pair-tunnel.js";

setTimeout(() => { console.log("FAIL the tests did not finish within 120 s"); process.exit(1); }, 120_000).unref?.();
let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };
const within = (p, ms = 20_000) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), new Promise((r) => setTimeout(() => r({ timeout: true }), ms))]);
const PAGE_ORIGIN = "https://sagebrush.space";

/** A WebSocket client with the browser API's shape (readyState, send, close, on*), sending an Origin. */
export class OriginSocket {
  constructor(url, { origin = PAGE_ORIGIN } = {}) {
    const u = new URL(url);
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    const key = randomBytes(16).toString("base64");
    this.sock = connect(Number(u.port), u.hostname, () => {
      this.sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
    });
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    let head = true;
    this.sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      if (head) {
        const end = this.buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const text = this.buf.subarray(0, end).toString("latin1");
        this.buf = this.buf.subarray(end + 4);
        head = false;
        if (!/^HTTP\/1\.1 101 /.test(text) || !text.includes(accept)) return this.end(1006);
        this.readyState = 1;
        this.onopen?.({});
      }
      this.frames();
    });
    this.sock.on("error", () => { this.onerror?.({}); this.end(1006); });
    this.sock.on("close", () => this.end(1006));
  }

  frames() {
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      let n = b1 & 0x7f, at = 2;
      if (n === 126) { if (this.buf.length < 4) return; n = this.buf.readUInt16BE(2); at = 4; }
      else if (n === 127) { if (this.buf.length < 10) return; n = Number(this.buf.readBigUInt64BE(2)); at = 10; }
      if (this.buf.length < at + n) return;
      const payload = this.buf.subarray(at, at + n);
      this.buf = this.buf.subarray(at + n);
      const op = b0 & 0x0f;
      if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (this.readyState === 1) this.frame(0x8, payload.subarray(0, 2));
        return this.end(code);
      }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      this.parts.push(Buffer.from(payload));
      if (b0 & 0x80) {
        const whole = Buffer.concat(this.parts);
        this.parts = [];
        this.onmessage?.({ data: op === 0x1 || op === 0x0 ? whole.toString("utf8") : whole });
      }
    }
  }

  frame(op, payload) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("not open");
    this.frame(0x1, Buffer.from(String(text), "utf8"));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 1) {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code);
      this.frame(0x8, Buffer.concat([b, Buffer.from(reason, "utf8")]));
      this.readyState = 2;
    }
    setTimeout(() => this.sock.destroy(), 50).unref?.();
  }

  end(code) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.sock.destroy();
    this.onclose?.({ code });
  }
}

function sink() {
  let end;
  const s = {
    text: "", errors: "", terminal: null,
    ended: new Promise((r) => (end = r)),
    start() {},
    out(t, e) { if (e) s.errors += t; else s.text += t; },
    display() {}, interact() {}, clear() {},
    done(ms, x) { s.terminal ??= ["done", x ?? {}]; end(); },
    stopped(m) { s.terminal ??= ["stopped", m]; end(); },
    skipped() { s.terminal ??= ["skipped"]; end(); },
  };
  return s;
}
async function run(kernel, code) {
  const s = sink();
  kernel.execute(code, { mode: "python" }, s);
  const t = await within(s.ended);
  if (t.timeout) check(false, `a terminal for ${JSON.stringify(code).slice(0, 40)} in time`);
  return s;
}

const py = process.env.PYTHON ?? "python3";
const runner = spawn(py, ["-m", "sagebrush.cli", "remote", "--loopback", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
runner.stderr.on("data", (d) => (stderr += d));
try {
  const link = await new Promise((resolve, reject) => {
    let out = "";
    runner.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(out.split("\n")[0]); });
    runner.on("exit", (c) => reject(new Error(`the runner exited ${c}: ${stderr.slice(0, 400)}`)));
  });
  const pairing = parsePairLink(link);
  check(!!pairing, "the runner's link parses to its code and port");
  check(parsePairLink(link.replace(/kport=\d+/, "kport=99999")) === null && parsePairLink("kpair=short&kport=1") === null, "a link with a bad port or code doesn't");

  let tunnel = null;
  const sent = [];
  const client = await RemoteClient.create({
    base: SYNTHETIC_BASE,
    token: () => tunnel.tokenSource(),
    fetch: (url, init) => tunnel.fetch(url, init),
  });
  const open = async (o) => {
    tunnel = await pairTunnel({ port: pairing.port, jwk: client.jwk, jkt: client.jkt, WebSocket: OriginSocket, ...o });
    client.nonce = tunnel.nonce;
    const raw = tunnel.ws.send.bind(tunnel.ws);
    tunnel.ws.send = (t) => { sent.push(t); raw(t); };
    return tunnel;
  };
  // a wrong code first: refused, as the runner says it
  const bad = await within(pairTunnel({ port: pairing.port, code: "A".repeat(26), jwk: client.jwk, jkt: client.jkt, WebSocket: OriginSocket }));
  check(bad.e?.name === "PairError" && bad.e.message === "wrong code", `a wrong code is refused: ${bad.e?.message}`);
  const first = await open({ code: pairing.code.toLowerCase(), remember: true });
  check(typeof first.session === "string" && /^[0-9a-f]{16}$/.test(first.incarnation), "paired, with a remembered session");

  const kernel = new RemoteKernel({ client, notebook: "nb-pair", clientId: "p1" });
  check(await kernel.start(), "the kernel binds on your computer");
  let s = await run(kernel, "import sys\nx = 6 * 7\nprint('hello from', sys.implementation.name)\nx");
  check(s.text === "hello from cpython\n42\n" && s.terminal?.[0] === "done", `a run's output: ${JSON.stringify(s.text)} ${JSON.stringify(s.terminal)}`);
  s = await run(kernel, "1/0");
  check(/ZeroDivisionError/.test(s.text + s.errors), "an error's traceback");
  s = await run(kernel, "x + 1");
  check(s.text === "43\n", "variables persist between runs");

  // Stop a busy run
  const busy = sink();
  kernel.execute("import time\nwhile True: time.sleep(0.01)", { mode: "python" }, busy);
  await new Promise((r) => setTimeout(r, 1500));
  kernel.interrupt();
  const stopped = await within(busy.ended);
  check(!stopped.timeout && /KeyboardInterrupt|stopped|interrupt/i.test(JSON.stringify(busy.terminal) + busy.text + busy.errors), `Stop ends a busy run: ${JSON.stringify(busy.terminal)}`);
  s = await run(kernel, "x");
  check(s.text === "42\n", "after Stop the kernel and its variables are there");

  // the code and the session secret are in no request frame
  const requests = sent.filter((t) => t.includes('"rpc"'));
  check(requests.length > 0 && requests.every((t) => !t.includes(pairing.code) && !t.includes(first.session)), "the code and the session appear in no request frame");

  // Disconnect: every request now is refused unsent, and nothing is replayed later
  const before = tunnel.stats.sent;
  tunnel.close();
  const r = await within(client.request("POST", "/bindings/x/interrupt", { epoch: 1, op_id: "o" }));
  check(r.e instanceof NotSentError, `a request while disconnected is NotSent: ${r.e?.name} ${r.e?.message}`);
  // pair again with the session: the same runner, the same binding, its variables kept
  const again = await open({ session: first.session });
  check(again.incarnation === first.incarnation && tunnel.stats.sent === 0 && before > 0, "paired again by session, the same runner; nothing replayed");
  s = await run(kernel, "x * 2");
  check(s.text === "84\n", `the binding and its variables survive a reconnect: ${JSON.stringify(s.text)} ${JSON.stringify(s.terminal)}`);

  // Restart: variables gone
  kernel.restart();
  await new Promise((r) => setTimeout(r, 1500));
  s = await run(kernel, "'x' in dir()");
  check(s.text === "False\n", `Restart: a fresh interpreter: ${JSON.stringify(s.text)}`);
  kernel.close();
  tunnel.close();
} catch (e) {
  check(false, `unexpected: ${e?.stack ?? e}`);
} finally {
  runner.kill("SIGINT");
  const exit = await within(new Promise((r) => runner.on("exit", r)), 10_000);
  if (exit.timeout) runner.kill("SIGKILL");
}
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
