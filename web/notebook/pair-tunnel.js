// The tunnel to "Your computer (paired)": the page's RemoteClient (remote-client.js) speaks the compute gateway's
// HTTP API, and here each of its requests becomes a frame on the one WebSocket paired with `sagebrush remote
// --loopback` on this computer (engine/py/python/sagebrush/remote/pair.py and gateway.py; the reviewed contract is
// local-kernel plan r2 §3 with deltas r3 D2-D4 and r3.1 R3-1..R3-3).
//
//   const t = await pairTunnel({ port, code, jwk: client.jwk, jkt: client.jkt, remember: true });
//   const client = await RemoteClient.create({ base: SYNTHETIC_BASE, token: t.tokenSource, fetch: t.fetch, keys });
//
// The rules it keeps:
// - A closed table, never a generic proxy (r2 §3): a URL under SYNTHETIC_BASE, one of eight routes, ids by the
//   client's pattern, the only query `after` on the events route.  Anything else is refused, unsent.
// - Dispatch in fetch's own turn (r2 §3): the socket open, fewer than 8 ids open at the runner, the route, the
//   frame's size, then socket.send, with no await and no queue between them.  A refusal there is thrown
//   synchronously as TunnelNotSent, the one failure remote-client.js turns into NotSentError (D5); anything after
//   the send stays ambiguous.  Nothing is ever replayed.
// - Zero network fallback (D2): it never calls fetch, XMLHttpRequest, sendBeacon, or any WebSocket but the paired one.
// - Ids `t<n>` increase and are never reused (D3).  A cancel after the send (an abort, a reader that stops, a slow
//   stream) moves the id to `retired` and sends {cancel}; the runner answers {retired: true} as that id's last
//   frame (R3-1), and only that answer forgets it.  Frames for a retired id meanwhile are ignored and counted.
//   A frame for an id never issued, a second answer, an unsolicited `retired` or a malformed frame closes the
//   socket (4002: a page may only send 1000 or 3000-4999).  256 retired ids at once: the socket is closed and
//   the page pairs again (a rotation), never a silent eviction.
// - Bounds (D4): an event stream holds at most 1 MiB not yet read, all of them 16 MiB; past either, that stream
//   errors (the client resumes from its last seq) and is cancelled.  An incoming frame over FRAME_IN_MAX closes
//   the socket before it is parsed; answers are capped again by the client (RESPONSE_MAX) before decoding.
// - The pairing code and the session secret go only in the hello, never in a request frame.

export const SYNTHETIC_BASE = "https://local.sagebrush.invalid/api/compute/v1";
export const PAIR_PATH = "/sagebrush-kernel";
const MiB = 1024 * 1024;
export const TUNNEL_LIMITS = Object.freeze({
  open: 8, // ids open at the runner: pending ones, and cancelled requests not yet answered
  retired: 256,
  subBytes: MiB, // one event stream's bytes not yet read
  allSubBytes: 16 * MiB,
  frameIn: 8 * MiB, // an incoming frame's text, before it is parsed (the runner's own send buffer)
  helloMs: 30_000,
});

const ID = "[A-Za-z0-9._~-]{1,64}";
const ID_RE = new RegExp(`^${ID}$`);
const FRAME_ID_RE = /^t[1-9]\d{0,14}$/;
const NULL_BODY = new Set([204, 205, 304]);
// The oldest runner this page pairs with: the one place it is set, at the release that first ships `sagebrush remote`
// (William's call).  null until then: any runner that reports a version (a source checkout reports "dev").
export const RUNNER_MIN = null;
const VERSION_RE = /^(dev|\d{1,6}(\.\d{1,6}){0,3}[0-9A-Za-z.+-]{0,24})$/;

/** Is version v ("1.2.3", maybe a suffix, or "dev") at least need?  Numbers compared part by part; "dev" always is. */
export function versionAtLeast(v, need) {
  if (v === "dev") return true;
  const nums = (s) => /^\d+(\.\d+)*/.exec(String(s))?.[0].split(".").map(Number) ?? null;
  const a = nums(v), b = nums(need);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
} // (fetch's null-body statuses at or above 200)
// (method, path pattern, rpc, the ref's members in path order)
const ROUTES = [
  ["POST", /^\/bindings$/, "g.bind", []],
  ["POST", new RegExp(`^/bindings/(${ID})/runs$`), "g.run", ["b"]],
  ["GET", new RegExp(`^/bindings/(${ID})/runs/(${ID})$`), "g.record", ["b", "r"]],
  ["GET", new RegExp(`^/bindings/(${ID})/runs/(${ID})/events$`), "g.events", ["b", "r"]],
  ["POST", new RegExp(`^/bindings/(${ID})/interrupt$`), "g.interrupt", ["b"]],
  ["POST", new RegExp(`^/bindings/(${ID})/restart$`), "g.restart", ["b"]],
  ["POST", new RegExp(`^/bindings/(${ID})/takeover$`), "g.takeover", ["b"]],
  ["POST", new RegExp(`^/bindings/(${ID})/complete$`), "g.complete", ["b"]],
];

/** The tunnel's own refusal before anything was sent: remote-client.js makes it a NotSentError (D5). */
export class TunnelNotSent extends Error {
  constructor(message) {
    super(message);
    this.name = "TunnelNotSent";
  }
}

/** The runner refused the hello (its message, as it said it), or the pairing could not be made. */
export class PairError extends Error {
  constructor(message, { kind = "refused", sent = true } = {}) {
    super(message);
    this.name = "PairError";
    this.kind = kind; // "refused" | "protocol" | "closed" | "timeout" | "unreachable" | "old"
    // (whether the hello, and with it the code, may have reached the runner: only a failure before it was handed to
    // the socket is false, and only then may the same code be tried again (astra's RETRY-2))
    this.sent = sent;
  }
}

/** A request's {rpc, ref, events}, from its method and URL, or TunnelNotSent: the closed table (r2 §3). */
export function route(method, url) {
  const s = String(url);
  if (!s.startsWith(SYNTHETIC_BASE + "/")) throw new TunnelNotSent("not this computer's gateway address");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new TunnelNotSent("not a URL");
  }
  if (u.origin + u.pathname !== s.split(/[?#]/)[0] || u.hash || u.username || u.password) throw new TunnelNotSent("not a gateway path");
  const path = u.pathname.slice(new URL(SYNTHETIC_BASE).pathname.length);
  for (const [m, re, rpc, names] of ROUTES) {
    const hit = re.exec(path);
    if (!hit || m !== method) continue;
    const ref = {};
    names.forEach((k, i) => (ref[k] = hit[i + 1]));
    if (rpc === "g.events") {
      const q = /^\?after=(0|[1-9]\d{0,15})$/.exec(u.search);
      if (!q || Number(q[1]) > Number.MAX_SAFE_INTEGER) throw new TunnelNotSent("an events request takes only after=N");
      ref.after = Number(q[1]);
    } else if (u.search) throw new TunnelNotSent("this request takes no query");
    return { rpc, ref, events: rpc === "g.events" };
  }
  throw new TunnelNotSent(`not one of this computer's gateway requests: ${method} ${path.slice(0, 80)}`);
}

const header = (h, name) => {
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : String(h[k]);
};
const enc = new TextEncoder();
const lost = (why) => new TypeError(`the connection to your computer closed (${why})`);

/**
 * One paired socket.  `fetch` and `tokenSource` are what RemoteClient is given; `onClose(why)` is called once,
 * when the socket goes (whoever closed it); `stats` counts what was ignored.
 */
export class Tunnel {
  constructor(ws, result, { onClose } = {}) {
    this.ws = ws;
    this.token = result.token;
    this.nonce = result.nonce;
    this.incarnation = result.incarnation;
    this.frameMax = result.limits.frame;
    this.closed = false;
    this.closeReason = null;
    this.next = 1;
    this.pending = new Map(); // id -> {events, resolve, reject, state: "head" | "stream", ctl, sig, off}
    this.retired = new Map(); // id -> counts at the runner (a cancelled request not yet answered)
    this.stats = { late: 0, sent: 0 };
    this.onClose = onClose ?? (() => {});
    this.fetch = (url, init) => this.send(url, init ?? {});
    this.tokenSource = () => (this.closed ? Promise.reject(new Error("your computer isn't connected")) : this.token);
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = (e) => this.gone(e?.code === 1001 ? "the runner on your computer stopped" : e?.code === 1000 ? "your computer closed the connection" : "the connection dropped");
    ws.onerror = () => this.gone("the connection dropped");
  }

  /** Ids open at the runner: its own count (gateway.py s.open), which it caps at 8. */
  openAtRunner() {
    let n = this.pending.size;
    for (const counts of this.retired.values()) if (counts) n++;
    return n;
  }

  // RemoteClient's fetch: every check, then the send, in this one turn.
  send(url, init) {
    if (this.closed || this.ws.readyState !== 1) throw new TunnelNotSent("your computer isn't connected");
    if (init.signal?.aborted) throw new TunnelNotSent("aborted before it was sent");
    const method = String(init.method ?? "GET").toUpperCase();
    const { rpc, ref, events } = route(method, url);
    if (this.openAtRunner() >= TUNNEL_LIMITS.open) throw new TunnelNotSent("8 requests are already open on your computer");
    const auth = header(init.headers, "Authorization");
    const dpop = header(init.headers, "DPoP");
    const accept = header(init.headers, "Accept") ?? "application/json";
    if (typeof auth !== "string" || typeof dpop !== "string") throw new TunnelNotSent("a request without its proof");
    const hasBody = method === "POST";
    if (hasBody !== (init.body !== undefined)) throw new TunnelNotSent(hasBody ? "a POST without its body" : "a GET with a body");
    if (hasBody && typeof init.body !== "string") throw new TunnelNotSent("a request body is text");
    const id = `t${this.next}`;
    const frame = { id, rpc, ref, auth, dpop, accept };
    if (hasBody) frame.body = init.body;
    const text = JSON.stringify(frame);
    if (enc.encode(text).length > this.frameMax) throw new TunnelNotSent("this request is over the frame limit, so it was not sent");
    let p;
    const entry = { events, state: "head" };
    p = new Promise((resolve, reject) => Object.assign(entry, { resolve, reject }));
    this.next++;
    this.pending.set(id, entry);
    try {
      this.ws.send(text);
    } catch (e) {
      // (the socket failed during the send: maybe sent, so ambiguous, and the socket is ended with everything on it)
      this.fail(4000, `the socket failed: ${String(e?.message ?? e).slice(0, 80)}`);
      return p;
    }
    this.stats.sent++;
    if (init.signal) {
      const onAbort = () => this.cancel(id, "aborted");
      init.signal.addEventListener("abort", onAbort, { once: true });
      entry.off = () => init.signal.removeEventListener("abort", onAbort);
    }
    return p;
  }

  // A sent id given up by the page: retired, and the runner told (R3-1).
  cancel(id, why) {
    const e = this.pending.get(id);
    if (!e || this.closed) return;
    this.pending.delete(id);
    e.off?.();
    if (e.state === "head") e.reject(Object.assign(new Error(why), { name: "AbortError" }));
    else {
      try { e.ctl.error(new Error(why)); } catch {}
    }
    // (the runner keeps a cancelled id open until its answer, or its stream would start; a stream it drops at once)
    this.retired.set(id, e.state === "head");
    if (this.retired.size > TUNNEL_LIMITS.retired) return this.fail(4000, "too many retired requests: pairing again");
    this.ws.send(JSON.stringify({ cancel: id }));
  }

  fail(code, reason) {
    try { this.ws.close(code, reason.slice(0, 100)); } catch {}
    this.gone(reason);
  }

  gone(why) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = why;
    for (const [, e] of this.pending) {
      e.off?.();
      if (e.state === "head") e.reject(lost(why));
      else {
        try { e.ctl.error(lost(why)); } catch {}
      }
    }
    this.pending.clear();
    this.retired.clear();
    this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
    this.onClose(why);
  }

  // the bytes not yet read across every stream
  buffered() {
    let n = 0;
    for (const e of this.pending.values()) if (e.state === "stream") n += TUNNEL_LIMITS.subBytes - (e.ctl.desiredSize ?? 0);
    return n;
  }

  receive(data) {
    if (this.closed) return;
    if (typeof data !== "string") return this.fail(4003, "text frames only");
    if (data.length > TUNNEL_LIMITS.frameIn) return this.fail(4009, "a frame over its limit");
    let m;
    try {
      m = JSON.parse(data);
    } catch {
      return this.fail(4002, "a frame that isn't JSON");
    }
    if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.id !== "string" || !FRAME_ID_RE.test(m.id)) return this.fail(4002, "a malformed frame");
    const id = m.id;
    if (Number(id.slice(1)) >= this.next) return this.fail(4002, "a frame for an id never sent");
    if (this.retired.has(id)) {
      if (m.retired === true && Object.keys(m).length === 2) this.retired.delete(id);
      else this.stats.late++;
      return;
    }
    const e = this.pending.get(id);
    if (!e) return this.fail(4002, "a second answer, or an unsolicited retirement");
    const keys = Object.keys(m).sort().join(",");
    if (e.state === "head") {
      if (keys !== "body,headers,id,status" && keys !== "headers,id,status") return this.fail(4002, "a malformed answer");
      const { status, headers, body } = m;
      if (!Number.isInteger(status) || status < 200 || status > 599) return this.fail(4002, "an answer's status");
      if (!headers || typeof headers !== "object" || Array.isArray(headers) || !Object.values(headers).every((v) => typeof v === "string")) return this.fail(4002, "an answer's headers");
      if (body !== undefined && typeof body !== "string") return this.fail(4002, "an answer's body");
      // (a status that can't carry a body, checked here and not left to the runtime's Response, which differs)
      if (body !== undefined && NULL_BODY.has(status)) return this.fail(4002, "a body on an answer that can't have one");
      if (e.events && status === 200) {
        if (body !== undefined) return this.fail(4002, "an event stream's head has no body");
        let ctl;
        const stream = new ReadableStream(
          { start: (c) => { ctl = c; }, cancel: () => this.cancel(id, "the reader stopped") },
          { highWaterMark: TUNNEL_LIMITS.subBytes, size: (chunk) => chunk.byteLength },
        );
        let res;
        try {
          res = new Response(stream, { status, headers });
        } catch {
          return this.fail(4002, "an answer that isn't a valid response"); // (the entry still pending: ambiguous)
        }
        e.ctl = ctl;
        e.state = "stream";
        return e.resolve(res);
      }
      // (a status that can't have a body, a header name or value fetch refuses: the socket closes, the request with
      // every other in flight ambiguous, astra's PROTO-1; never a request left unsettled)
      let res;
      try {
        res = new Response(body ?? null, { status, headers });
      } catch {
        return this.fail(4002, "an answer that isn't a valid response");
      }
      this.pending.delete(id);
      e.off?.();
      return e.resolve(res);
    }
    // a stream's frames
    if (keys === "chunk,id" && typeof m.chunk === "string") {
      e.ctl.enqueue(enc.encode(m.chunk));
      if (e.ctl.desiredSize < 0 || this.buffered() > TUNNEL_LIMITS.allSubBytes) this.cancel(id, "the page isn't reading this stream");
      return;
    }
    if (keys === "end,id" && m.end === true) {
      this.pending.delete(id);
      e.off?.();
      e.ctl.close();
      return;
    }
    if (keys === "id,streamError" && m.streamError === "slow") {
      // (a stream error, not an end: the client resumes from its last seq; then the one handshake, R3-1)
      return this.cancel(id, "your computer ended a stream the page read too slowly");
    }
    return this.fail(4002, "a malformed stream frame");
  }

  /** The page's Disconnect: the socket closed, every request in flight ambiguous. */
  close(why = "disconnected") {
    this.fail(1000, why);
  }
}

/**
 * Pair with the runner on this computer: a hello with the pairing code (or a remembered session) and the
 * RemoteClient's public key.  Resolves to a Tunnel; rejects with PairError.  Only 127.0.0.1, only a port number.
 */
export function pairTunnel({ port, code, session, remember = false, jwk, jkt, WebSocket: WS = globalThis.WebSocket, onClose, timeoutMs = TUNNEL_LIMITS.helloMs, min = RUNNER_MIN }) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return Promise.reject(new PairError("the port is a number from 1 to 65535", { kind: "unreachable", sent: false }));
  if ((typeof code === "string") === (typeof session === "string")) return Promise.reject(new PairError("a pairing needs its code (or a remembered session)", { sent: false }));
  const params = { protocol: 1, purpose: "kernel", jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, jkt };
  if (min) params.needs = min; // (so a runner too old for this page says so on its own side too)
  if (typeof code === "string") {
    params.code = code.trim().toUpperCase();
    if (remember) params.remember = true;
  } else params.session = session;
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    const finish = (err, tunnel) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        if (ws) ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws?.close(1000); } catch {}
        reject(err);
      } else resolve(tunnel);
    };
    let sent = false; // (set as the hello is handed to the socket: from then on it may have arrived)
    const timer = setTimeout(() => finish(new PairError(sent ? "your computer didn't answer the pairing: run sagebrush remote --loopback again for a new link" : "your computer didn't answer", { kind: "timeout", sent })), timeoutMs);
    try {
      ws = new WS(`ws://127.0.0.1:${n}${PAIR_PATH}`);
    } catch (e) {
      return finish(new PairError(`couldn't connect: ${e?.message ?? e}`, { kind: "unreachable", sent: false }));
    }
    let opened = false;
    ws.onopen = () => {
      opened = true;
      sent = true;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "h1", method: "hello", params }));
    };
    ws.onerror = () => {};
    ws.onclose = (e) => finish(new PairError(opened ? `your computer closed the connection (${e?.code ?? "?"})` : "nothing answered on that port: is sagebrush remote --loopback running?", { kind: opened ? "closed" : "unreachable", sent }));
    ws.onmessage = (e) => {
      let m;
      try {
        if (typeof e.data !== "string" || e.data.length > 64 * 1024) throw new Error();
        m = JSON.parse(e.data);
      } catch {
        return finish(new PairError("your computer's answer wasn't a pairing answer", { kind: "protocol" }));
      }
      if (m?.error && typeof m.error.message === "string") return finish(new PairError(m.error.message.slice(0, 200), { kind: m.error.data?.code === "protocol" ? "protocol" : "refused" }));
      const r = m?.result;
      const ok = m?.id === "h1" && r && r.protocol === 1 && r.purpose === "kernel" && typeof r.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(r.token)
        && typeof r.nonce === "string" && r.nonce.length > 0 && r.nonce.length <= 256 && typeof r.incarnation === "string" && /^[0-9a-f]{16}$/.test(r.incarnation)
        && Number.isInteger(r.limits?.frame) && r.limits.frame > 0 && (r.session === undefined || (typeof r.session === "string" && r.session.length <= 128))
        && typeof r.version === "string" && VERSION_RE.test(r.version);
      if (!ok) return finish(new PairError("your computer's answer wasn't a pairing answer", { kind: "protocol" }));
      // (a runner older than this page needs: refused before anything is bound; the code was seen, so a new link)
      if (min && !versionAtLeast(r.version, min)) return finish(new PairError(`your computer's sagebrush is ${r.version}; this page needs ${min} or newer`, { kind: "old" }));
      const t = new Tunnel(ws, r, { onClose });
      t.session = r.session ?? null;
      finish(null, t);
    };
  });
}

/** The runner's link (`…/?kpair=CODE&kport=PORT`, or the two pasted): {code, port}, or null. */
export function parsePairLink(text) {
  const s = String(text ?? "").trim();
  let q;
  try {
    q = s.includes("kpair=") ? new URL(s, "https://sagebrush.space/").searchParams : null;
  } catch {
    q = null;
  }
  const code = q?.get("kpair") ?? null;
  const port = q?.get("kport") ?? null;
  if (!code || !/^[A-Za-z2-7]{26}$/.test(code) || !/^[1-9]\d{0,4}$/.test(port ?? "") || Number(port) > 65535) return null;
  return { code: code.toUpperCase(), port: Number(port) };
}
