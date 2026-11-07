// The page side of test_remote_terminal_page.py: web/notebook/remote-terminal.js, the page's real terminal client, with
// a real WebCrypto P-256 key and real DPoP proofs, its socket bridged over stdio to the test, which plays the relay in
// front of a real runner.  Lines in: the runner's messages to this page (JSON).  Lines out: "W <json>" for a message
// to the runner, "E <json>" for a client event, "D <base64>" for bytes drawn.
//   bun engine/py/remote_terminal_page.mjs <remote_id> <scenario> [session]
import { webcrypto, createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { RemoteTerminal, toB64 } from "../../web/notebook/remote-terminal.js";

const [remoteId, scenario, session] = process.argv.slice(2);
const { subtle } = webcrypto;
const b64u = (b) => Buffer.from(b).toString("base64url");
const say = (kind, o) => process.stdout.write(kind + " " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n");

const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const { kty, crv, x, y } = await subtle.exportKey("jwk", k.publicKey);
const jwk = { kty, crv, x, y };
const jkt = b64u(createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest());
const key = {
  jwk, jkt,
  async proof(htm, htu, token, nonce) {
    const h = b64u(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }));
    const c = b64u(JSON.stringify({ jti: b64u(randomBytes(24)), htm, htu, iat: Math.floor(Date.now() / 1000),
      ath: b64u(createHash("sha256").update(token).digest()), nonce }));
    const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(h + "." + c));
    return `${h}.${c}.${b64u(sig)}`;
  },
};

class StdioSocket {
  constructor() {
    this.handlers = { open: [], message: [], close: [], error: [] };
    StdioSocket.it = this;
    setTimeout(() => this.fire("open", {}), 0);
  }
  addEventListener(kind, f) { this.handlers[kind].push(f); }
  fire(kind, e) { for (const f of this.handlers[kind]) f(e); }
  send(text) { say("W", text); }
  close(code, why) { say("E", { t: "socket-close", code, why }); }
}

const view = { write(bytes, done) { say("D", toB64(bytes)); done(); } };
const t = new RemoteTerminal({ url: "wss://relay.invalid/page", remoteId, key, view, rows: 24, cols: 80,
  session: session || undefined, WebSocket: StdioSocket,
  on: (e) => {
    say("E", e);
    if (e.t === "live" && scenario === "echo") t.input("hello-e2e\n");
    if (e.t === "live" && scenario === "ctrlc") setTimeout(() => t.input("\x03"), 300);
  } }).start();

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "CLOSE") return StdioSocket.it.fire("close", { code: 1000, reason: "" });
  StdioSocket.it.fire("message", { data: line });
});
