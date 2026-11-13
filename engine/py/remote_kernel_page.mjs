// The page side of test_remote_kernel_page.py: the page's own RemoteKernel and RemoteClient (web/notebook/remote-kernel.js,
// remote-client.js, with a real WebCrypto P-256 key and DPoP proofs) through web/notebook/relay-tunnel.js, its socket
// bridged over stdio to the test, which plays the relay in front of a real runner.  Lines in: the runner's messages to
// this page, and the relay's controls (JSON text).  Lines out: "W <text>" for a message the page sends on its leg,
// "E <json>" for an event of this script.
//   bun engine/py/remote_kernel_page.mjs <remote_id> <scenario>
// Scenarios: "run" (pair, bind, runs, an error, Stop of a busy run, Restart, Disconnect), "big" (one run printing
// several MiB, so the relay's receipts come and are acked), "idle" (pair, then wait: the pings).
import { createInterface } from "node:readline";
import { RemoteClient } from "../../web/notebook/remote-client.js";
import { RemoteKernel } from "../../web/notebook/remote-kernel.js";
import { relayTunnel, RELAY_TUNNEL, SYNTHETIC_BASE } from "../../web/notebook/relay-tunnel.js";
// (PING_MS: a shorter ping interval, for the give-up test)
if (process.env.PING_MS) RELAY_TUNNEL.pingMs = Number(process.env.PING_MS);

const [remoteId, scenario] = process.argv.slice(2);
const say = (kind, o) => process.stdout.write(kind + " " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n");

class StdioSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    StdioSocket.it = this;
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 0);
  }
  send(text) {
    if (this.readyState !== 1) throw new Error("not open");
    say("W", text);
  }
  close(code = 1000, why = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    say("E", { t: "socket-close", code, why });
    setTimeout(() => this.onclose?.({ code }), 0);
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const s = StdioSocket.it;
  if (!s || s.readyState !== 1) return;
  if (line === "CLOSE") {
    s.readyState = 3;
    return s.onclose?.({ code: 1001 });
  }
  s.onmessage?.({ data: line });
});

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
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
async function run(kernel, code, ms = 20_000) {
  const s = sink();
  kernel.execute(code, { mode: "python" }, s);
  const t = await within(s.ended, ms);
  return { text: s.text, errors: s.errors, terminal: t === "timeout" ? ["timeout"] : s.terminal };
}

try {
  let tunnel = null;
  const client = await RemoteClient.create({ base: SYNTHETIC_BASE, token: () => tunnel.tokenSource(), fetch: (url, init) => tunnel.fetch(url, init) });
  tunnel = await relayTunnel({
    url: `wss://relay.invalid/api/remote/v1/page?remote=${encodeURIComponent(remoteId)}&chan=kernel`,
    jwk: client.jwk, jkt: client.jkt, WebSocket: StdioSocket,
    onClose: (why) => say("E", { t: "closed", why }),
  });
  client.nonce = tunnel.nonce;
  say("E", { t: "paired", incarnation: tunnel.incarnation, channels: tunnel.channels, frameMax: tunnel.frameMax });
  if (scenario === "idle") {
    await new Promise(() => {}); // (the test ends this process)
  }
  const kernel = new RemoteKernel({ client, notebook: "nb-relay", clientId: "p1" });
  say("E", { t: "started", ok: await kernel.start() });
  if (scenario === "big") {
    const r = await run(kernel, "import sys\nfor i in range(30000): sys.stdout.write('%06d' % i + 'z' * 93 + chr(10))\nprint('big-done')", 60_000);
    say("E", { t: "big", bytes: r.text.length, tail: r.text.slice(-9), terminal: r.terminal });
  } else {
    let r = await run(kernel, "import sys\nx = 6 * 7\nprint('hello via the relay', sys.implementation.name)\nx");
    say("E", { t: "run", ...r });
    r = await run(kernel, "1/0");
    say("E", { t: "error-run", ...r });
    r = await run(kernel, "x + 1");
    say("E", { t: "again", ...r });
    const busy = sink();
    kernel.execute("import time\nwhile True: time.sleep(0.01)", { mode: "python" }, busy);
    await new Promise((res) => setTimeout(res, 1500));
    kernel.interrupt();
    const stopped = await within(busy.ended, 20_000);
    say("E", { t: "stopped", timeout: stopped === "timeout", terminal: busy.terminal, text: busy.text + busy.errors });
    r = await run(kernel, "x");
    say("E", { t: "after-stop", ...r });
    kernel.restart();
    await new Promise((res) => setTimeout(res, 1500));
    r = await run(kernel, "'x' in dir()");
    say("E", { t: "after-restart", ...r });
    kernel.close();
    tunnel.close();
  }
  say("E", { t: "done" });
} catch (e) {
  say("E", { t: "error", name: e?.name, kind: e?.kind, message: String(e?.message ?? e) });
}
