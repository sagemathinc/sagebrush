// The page's side of a terminal on a paired runner (terminal addendum T1.4 §T3-§T5; build step T-3): one terminal
// page leg on the relay (`/api/remote/v1/page?remote=<id>&chan=terminal`), the runner's protocol
// (engine/py/python/sagebrush/remote/terminal.py and terminal_output.py), and nothing about how it is drawn.  The
// view is any object with
//
//   write(bytes: Uint8Array, done: () => void)   bytes in arrival order; done() once they are on screen
//   reset?()                                      optional; the replay's own leading reset (\x1bc) clears it anyway
//
// so xterm (whichever build) sits behind a thin adapter and this module is tested without it.
//
// The protocol, page side:
// - hello {protocol 1, purpose "terminal", jwk, jkt} -> {token, nonce, gen}; then
//   open {body, auth "DPoP <token>", dpop} with a proof over the synthetic open URL that binds this remote, this page's
//   generation and the body's exact bytes (T5).  A reattach is the same with {"session": id} in the body: always a
//   fresh hello and a fresh proof, never a reused one.
// - output: replay, out..., live, then live out...; exit is the last output message.  Each out frame is canonical
//   base64 of the exact PTY bytes; the page acks {"t":"ack","upto":n} once the view has drawn them, n counting
//   decoded out bytes from 0 at this open (replay included).  The runner holds at most 256 KiB unacknowledged.
// - input: {"t":"in","b":<base64>} frames of at most 16,384 bytes, with at most 64 KiB sent but not yet inacked; the
//   rest waits here, in the page, never in the runner.
// - "elsewhere": another page opened this session; this page's grant has ended.

export const TERMINAL = {
  inFrame: 16_384,        // decoded bytes in one input frame (TERMINAL_LIMITS["in"])
  inPending: 64 * 1024,   // sent but not inacked (terminal_output.IN_PENDING)
  frame: 65_536,          // a terminal message's whole serialization (relay.py TERMINAL_FRAME)
  helloMs: 10_000,
};
export const SYNTHETIC_BASE = "https://local.sagebrush.invalid/api/compute/v1";
const OUT_TYPES = new Set(["replay", "out", "live", "inack", "exit", "opened", "error"]);

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The URL an open's proof is made over (terminal.py open_htu). */
export async function openHtu(remoteId, gen, body, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const q = new URLSearchParams({ remote: remoteId, gen: String(gen), body: b64u(digest) });
  return `${SYNTHETIC_BASE}/terminal/open?${q}`;
}

/** Canonical base64 of bytes (chunked so a 16 KiB frame doesn't overflow an argument list). */
export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Bytes of a canonical base64 string, or null. */
export function fromB64(s) {
  if (typeof s !== "string") return null;
  let bin;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return toB64(out) === s ? out : null;
}

export class RemoteTerminal {
  /**
   * @param o.url        the relay page-leg URL (wss://…/api/remote/v1/page?remote=<id>&chan=terminal)
   * @param o.remoteId   the remote's id (bound into the open's proof)
   * @param o.key        { jwk, jkt, proof(htm, htu, token, nonce) -> Promise<string> }: the page's own DPoP key
   * @param o.view       { write(bytes, done) }
   * @param o.rows, o.cols
   * @param o.session    a session id to reattach to (absent: a new session)
   * @param o.on         (event) => void: {t:"opened",session} {t:"live"} {t:"exit",code,signal} {t:"elsewhere"}
   *                     {t:"error",error,reason?} {t:"closed",code,why}
   * @param o.WebSocket  injectable
   */
  constructor(o) {
    this.o = o;
    this.WS = o.WebSocket ?? globalThis.WebSocket;
    this.state = "new";          // new -> hello -> opening -> attached -> ended
    this.session = o.session ?? null;
    this.received = 0;           // decoded out bytes received at this open
    this.acked = 0;              // ... and drawn (acked)
    this.exited = false;
    this.inq = [];               // input waiting here (Uint8Array pieces)
    this.inSent = 0;             // input bytes sent at this open
    this.inAcked = 0;            // ... and inacked
    this.ws = null;
    this.gen = null;
    this.token = null;
    this.nonce = null;
  }

  start() {
    if (this.state !== "new") throw new Error("RemoteTerminal.start: already started");
    this.state = "hello";
    const ws = (this.ws = new this.WS(this.o.url));
    ws.addEventListener("open", () => this._send({ jsonrpc: "2.0", id: "t1", method: "hello",
      params: { protocol: 1, purpose: "terminal", jwk: this.o.key.jwk, jkt: this.o.key.jkt } }));
    ws.addEventListener("message", (e) => this._message(e.data));
    ws.addEventListener("close", (e) => this._closed(e.code, e.reason || ""));
    ws.addEventListener("error", () => {});
    return this;
  }

  _emit(ev) {
    try {
      this.o.on?.(ev);
    } catch {
      // (the page's handler must not break the protocol)
    }
  }

  _send(obj) {
    if (!this.ws || this.state === "ended") return false;
    const text = JSON.stringify(obj);
    if (text.length > TERMINAL.frame) return false; // (never sent: the relay would close the leg)
    this.ws.send(text);
    return true;
  }

  _fail(why) {
    // (anything the runner shouldn't send: this page ends; reattaching makes a fresh, clean attachment)
    this._emit({ t: "error", error: "protocol", reason: why });
    this.close(4000, why);
  }

  async _message(data) {
    if (this.state === "ended") return;
    let m;
    try {
      m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch {
      return this._fail("not JSON");
    }
    if (this.state === "hello") return this._helloAnswer(m);
    if (!m || typeof m !== "object" || !OUT_TYPES.has(m.t)) return this._fail("an unknown message");
    if (this.exited) return this._fail("a message after the exit");
    switch (m.t) {
      case "opened":
        if (this.state !== "opening" || typeof m.session !== "string") return this._fail("an unexpected opened");
        this.state = "attached";
        this.session = m.session;
        this.nonce = m.nonce;
        return this._emit({ t: "opened", session: m.session });
      case "replay":
        return this.o.view.reset?.();
      case "live":
        return this._emit({ t: "live" });
      case "out": {
        const bytes = fromB64(m.b);
        if (!bytes || Object.keys(m).length !== 2) return this._fail("a malformed out frame");
        this.received += bytes.length;
        const upto = this.received;
        // (the view draws in arrival order; each frame is acked once drawn, cumulatively)
        this.o.view.write(bytes, () => {
          if (upto > this.acked && this.state === "attached" && !this.closedFor) {
            this.acked = upto;
            this._send({ t: "ack", upto });
          }
        });
        return undefined;
      }
      case "inack":
        if (!Number.isInteger(m.upto) || m.upto < this.inAcked || m.upto > this.inSent) return this._fail("a bad inack");
        this.inAcked = m.upto;
        return this._pumpInput();
      case "exit":
        this.exited = true;
        return this._emit({ t: "exit", code: m.code ?? null, signal: m.signal ?? null });
      case "error":
        if (m.error === "elsewhere") {
          this.closedFor = "elsewhere";
          return this._emit({ t: "elsewhere" });
        }
        return this._emit({ t: "error", error: m.error, reason: m.reason });
    }
    return undefined;
  }

  async _helloAnswer(m) {
    const r = m && m.result;
    if (!r || r.purpose !== "terminal" || typeof r.token !== "string" || !Number.isInteger(r.gen)) {
      const why = m?.error?.message ?? "the hello was refused";
      this._emit({ t: "error", error: "hello", reason: why });
      return this.close(4001, why);
    }
    this.token = r.token;
    this.nonce = r.nonce;
    this.gen = r.gen;
    this.state = "opening";
    const b = this.session ? { session: this.session, rows: this.o.rows, cols: this.o.cols } : { rows: this.o.rows, cols: this.o.cols };
    const body = JSON.stringify(b);
    const htu = await openHtu(this.o.remoteId, this.gen, body, this.o.subtle);
    const dpop = await this.o.key.proof("POST", htu, this.token, this.nonce);
    if (this.state !== "opening") return undefined;
    this._send({ t: "open", body, auth: "DPoP " + this.token, dpop });
    return undefined;
  }

  /** Keystrokes or a paste: sent in frames as the runner's input credit allows; the rest waits here. */
  input(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new TextEncoder().encode(String(bytes));
    if (!bytes.length || this.exited || this.state === "ended") return;
    this.inq.push(bytes);
    this._pumpInput();
  }

  pendingInput() {
    return this.inq.reduce((n, b) => n + b.length, 0);
  }

  _pumpInput() {
    if (this.state !== "attached" || this.closedFor) return;
    while (this.inq.length) {
      const room = Math.min(TERMINAL.inFrame, TERMINAL.inPending - (this.inSent - this.inAcked));
      if (room <= 0) return;
      const head = this.inq[0];
      const piece = head.subarray(0, room);
      if (piece.length === head.length) this.inq.shift();
      else this.inq[0] = head.subarray(room);
      this.inSent += piece.length;
      this._send({ t: "in", b: toB64(piece) });
    }
  }

  resize(rows, cols) {
    this.o.rows = rows;
    this.o.cols = cols;
    if (this.state === "attached" && !this.closedFor) this._send({ t: "resize", rows, cols });
  }

  kill() {
    if (this.state === "attached" && this.session && !this.closedFor) this._send({ t: "kill", session: this.session });
  }

  close(code = 1000, why = "") {
    if (this.state === "ended") return;
    this.state = "ended";
    try {
      this.ws?.close(code < 4000 && code !== 1000 ? 1000 : code, why.slice(0, 100));
    } catch {
      // (already closing)
    }
    this._emit({ t: "closed", code, why });
  }

  _closed(code, why) {
    if (this.state === "ended") return;
    this.state = "ended";
    this._emit({ t: "closed", code, why });
  }
}
