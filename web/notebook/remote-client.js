// The page's client of CoCalc's compute gateway (/api/compute/v1): the
// remote-compute design's HTTPS API.  Every request carries a DPoP proof
// (RFC 9449) made with this page's own P-256 key, which never leaves it
// (WebCrypto, generated non-extractable); the access token is bound to that
// key, so a copied token is useless without it.  The server's DPoP-Nonce is
// used, and a resource request refused for want of a fresh one is retried
// once.  (The /token endpoint's 400 nonce challenge is the grant flow's, not
// implemented in this client.)
//
// Transport: the gateway's base must be an https: URL (RFC 9449 §2: DPoP
// does not replace TLS), with no user info; every request stays under that
// base, and redirects are refused (fetch's redirect: "error"), so a request
// carrying a token or proof never goes anywhere else.
//
// Sizes: a request body over its endpoint's cap is never sent; a response
// body is read as a stream and refused at the first byte past RESPONSE_MAX;
// run events (a fetch-streamed text/event-stream, so headers work) are
// refused at the first byte past their cap, before they are decoded.
//
// Three kinds of failure, because they mean different things to a run:
//   NotSentError  the request was never sent (a cap, a bad path, aborted first): it had no effect
//   GatewayError  the gateway answered with a typed refusal ({error: code}): definitive
//   AmbiguousError it was sent, and no valid answer came back (network, abort, oversized or
//                  unreadable answer): it may or may not have taken effect
//
//   const client = await RemoteClient.create({ base: "https://cocalc.ai/api/compute/v1", token: () => accessToken });
//   const r = await client.request("POST", "/bindings", { notebook, kernel, path }, { signal });
//   for await (const ev of client.events(`/bindings/${b}/runs/${rq}/events`, 0, signal)) ...

// (an event's JSON is at most 897 KiB: one 896 KiB message and its envelope;
// its SSE framing, "id: <seq>\ndata: ", at most 64 bytes more)
export const EVENT_DATA_MAX = 897 * 1024;
export const EVENT_FRAME_MAX = 64;
export const EVENT_RAW_MAX = EVENT_DATA_MAX + EVENT_FRAME_MAX;
// (request bodies: a run's code is at most 1 MiB per cell, a file chunk is
// 512 KiB raw in base64, anything else is small)
export const BODY_MAX = { run: 2.25 * 1024 * 1024, put: 768 * 1024, other: 64 * 1024 };
// (a JSON answer: lists are paginated within 256 KiB; a file chunk's answer is the largest)
export const RESPONSE_MAX = 1024 * 1024;

const enc = new TextEncoder();

export function b64url(bytes) {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlJson = (o) => b64url(enc.encode(JSON.stringify(o)));
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const randomId = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** RFC 7638 thumbprint of a P-256 public JWK: its required members, in order, no spaces. */
export async function jwkThumbprint(jwk) {
  return b64url(await sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/** Never sent: no effect anywhere.  `stale`: a send guard refused it (what it was checked against changed). */
export class NotSentError extends Error {
  constructor(message, { aborted = false, stale = false } = {}) {
    super(message);
    this.aborted = aborted;
    this.stale = stale;
  }
}
/** The gateway's typed refusal: `status` (HTTP), `code` (its error), `retryAfter` (seconds, if given). */
export class GatewayError extends Error {
  constructor(status, code, message, retryAfter = null, body = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}
/** Sent, without a valid answer: it may have taken effect. */
export class AmbiguousError extends Error {
  constructor(message, { aborted = false, tooLarge = false, status = null } = {}) {
    super(message);
    this.aborted = aborted;
    this.tooLarge = tooLarge;
    this.status = status;
  }
}
/** Why an event stream ended early: `tooLarge` if an event was over its cap, `aborted` if asked to. */
export class StreamError extends Error {
  constructor(message, { tooLarge = false, aborted = false } = {}) {
    super(message);
    this.tooLarge = tooLarge;
    this.aborted = aborted;
  }
}

// Test-only fault: an await between a send's guard and its fetch (a test shows the same-turn probe sees it).
// Never set outside tests (a census test checks that).
let testHooks = null;
/** Tests only: set (or clear, with null) the fault above ({awaitAfterGuard: async () => {}}). */
export function setTestHooks(h) {
  testHooks = h;
}

const notSentIfAborted = (signal) => {
  if (signal?.aborted) throw new NotSentError("aborted before it was sent", { aborted: true });
};
// A wait that an abort ends at once (NotSentError), even if what it waits
// for never settles: getting the token, signing the proof.
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new NotSentError("aborted before it was sent", { aborted: true }));
    const onAbort = () => reject(new NotSentError("aborted before it was sent", { aborted: true }));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

// A promise raced with `signal`: its abort rejects at once (the promise's own late outcome is dropped).
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { promise.catch(() => {}); return reject(new Error("aborted")); }
    const onAbort = () => { promise.catch(() => {}); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** The gateway's base URL, checked: absolute https:, no user info, query or fragment. */
export function checkBase(base) {
  let u;
  try {
    u = new URL(String(base));
  } catch {
    throw new TypeError("the compute gateway's address is not a URL");
  }
  if (u.protocol !== "https:") throw new TypeError("the compute gateway must be reached over https");
  if (u.username || u.password) throw new TypeError("the compute gateway's address must not contain credentials");
  if (u.search || u.hash) throw new TypeError("the compute gateway's address must not have a query or fragment");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

// (a request path under the base: plain segments only, never "..", "//" or a backslash)
const PATH_RE = /^(\/[A-Za-z0-9._~%-]+)+$/;
function checkPath(path) {
  const p = String(path);
  if (!PATH_RE.test(p) || p.split("/").some((s) => s === "." || s === ".." || /%2f|%5c|%2e/i.test(s))) {
    throw new NotSentError(`not a gateway path: ${p.slice(0, 80)}`);
  }
  return p;
}

export class RemoteClient {
  /**
   * @param {object} o
   * @param {string} o.base the gateway's base URL: https:, its configured origin and /api/compute/v1
   * @param {(o: {signal?: AbortSignal}) => string | Promise<string>} o.token the current access token
   *   (given the request's signal; the client stops waiting for it on abort either way)
   * @param {typeof fetch} [o.fetch] (tests: a fake gateway)
   * @param {CryptoKeyPair} [o.keys] (default, and the only sound choice: a new non-extractable
   *   P-256 pair; a supplied pair whose private key is extractable is refused)
   */
  static async create({ base, token, fetch: f, keys, timers }) {
    const checked = checkBase(base);
    if (keys && keys.privateKey?.extractable !== false) throw new TypeError("the DPoP private key must not be extractable");
    const pair = keys ?? (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]));
    // (a public key is always exportable; the private key never is)
    const full = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jwk = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
    return new RemoteClient({ base: checked, token, fetch: f, privateKey: pair.privateKey, jwk, jkt: await jwkThumbprint(jwk), timers });
  }

  constructor({ base, token, fetch: f, privateKey, jwk, jkt, timers }) {
    this.base = checkBase(base);
    this.token = token;
    this.fetch = f ?? ((...a) => globalThis.fetch(...a));
    this.privateKey = privateKey;
    this.jwk = jwk;
    this.jkt = jkt;
    this.nonce = null; // the server's latest DPoP-Nonce
    // (a request's deadline runs on these: tests inject a clock; the page's timers don't keep a process alive)
    this.timers = timers ?? { setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t?.unref?.(); return t; }, clearTimeout: (t) => clearTimeout(t) };
  }

  /** A DPoP proof for one request (RFC 9449 §4.2): htu is the URL without query or fragment. */
  async proof(method, url, accessToken) {
    const u = new URL(url);
    const claims = {
      jti: randomId(16), // (128 bits)
      htm: method,
      htu: u.origin + u.pathname,
      iat: Math.floor(Date.now() / 1000),
      ...(accessToken ? { ath: b64url(await sha256(accessToken)) } : {}),
      ...(this.nonce ? { nonce: this.nonce } : {}),
    };
    const input = `${b64urlJson({ typ: "dpop+jwt", alg: "ES256", jwk: this.jwk })}.${b64urlJson(claims)}`;
    // (WebCrypto's ECDSA signature is r || s, 64 bytes: JWS's ES256 form)
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, enc.encode(input));
    return `${input}.${b64url(sig)}`;
  }

  // (the cap on a request body: by the endpoint's kind)
  static bodyCap(method, path) {
    if (method === "POST" && /^\/bindings\/[^/]+\/runs$/.test(path)) return BODY_MAX.run;
    if (method === "PUT" && /^\/bindings\/[^/]+\/files\/[^/]+$/.test(path)) return BODY_MAX.put;
    return BODY_MAX.other;
  }

  // One request with its proof; a 401 asking for a fresh nonce is retried
  // once with the nonce it gave.  Resolves to the Response; throws
  // NotSentError before anything was sent, AmbiguousError after.
  // `guard(attempt)`, if given, is called synchronously right before each
  // fetch (after the token and the proof are ready): anything but true, and
  // that fetch is not made (NotSentError, stale).
  async send(method, path, body, { accept = "application/json", signal, query = "", guard } = {}) {
    const p = checkPath(path);
    const url = this.base + p + query;
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && enc.encode(text).length > RemoteClient.bodyCap(method, p)) {
      throw new NotSentError("this request is over its size limit, so it was not sent");
    }
    notSentIfAborted(signal);
    // (the token and the proof are waited for only until an abort: a token
    // source or signer that never answers can't hold a cancelled request)
    let accessToken;
    try {
      accessToken = await untilAborted(Promise.resolve().then(() => this.token({ signal })), signal);
    } catch (e) {
      if (e instanceof NotSentError) throw e;
      throw new NotSentError(`no access token: ${String(e?.message ?? e).slice(0, 200)}`);
    }
    if (typeof accessToken !== "string" || !accessToken) throw new NotSentError("no access token");
    for (let attempt = 0; ; attempt++) {
      notSentIfAborted(signal);
      let proof;
      try {
        proof = await untilAborted(Promise.resolve().then(() => this.proof(method, url, accessToken)), signal);
      } catch (e) {
        if (e instanceof NotSentError) throw e;
        throw new NotSentError(`the request could not be signed: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      notSentIfAborted(signal);
      const headers = { Authorization: `DPoP ${accessToken}`, DPoP: proof, Accept: accept };
      if (text !== undefined) headers["Content-Type"] = "application/json";
      // (the same turn as the fetch: nothing can change between the guard and the send)
      if (guard && guard(attempt) !== true) throw new NotSentError("not sent: changed since it was checked", { stale: true });
      if (testHooks?.awaitAfterGuard) await testHooks.awaitAfterGuard();
      let res;
      try {
        // (raced with the signal: a fetch that ignored its abort can't hold the request past its deadline)
        res = await raceAbort(this.fetch(url, { method, headers, redirect: "error", credentials: "omit", cache: "no-store", signal, ...(text !== undefined ? { body: text } : {}) }), signal);
      } catch (e) {
        throw new AmbiguousError(signal?.aborted ? "aborted after it was sent" : `the request failed: ${String(e?.message ?? e).slice(0, 200)}`, { aborted: !!signal?.aborted });
      }
      const fresh = res.headers.get("DPoP-Nonce");
      if (fresh) this.nonce = fresh;
      const wantsNonce = res.status === 401 && /use_dpop_nonce/.test(res.headers.get("WWW-Authenticate") ?? "");
      // (a nonce challenge is a refusal before any effect: retried once)
      if (wantsNonce && attempt === 0 && fresh) {
        // (not awaited: a body whose cancel never settles can't hold the request past its deadline)
        res.body?.cancel?.().catch?.(() => {});
        continue;
      }
      return res;
    }
  }

  /**
   * A JSON request: resolves to the parsed object.  Throws NotSentError,
   * GatewayError (a non-2xx answer with a typed {error}), or AmbiguousError
   * (no valid answer: a 2xx that isn't a JSON object, an untyped error, an
   * answer over RESPONSE_MAX, a broken or aborted read).
   */
  async request(method, path, body, { signal, guard, timeoutMs } = {}) {
    if (!timeoutMs) return this.requestUnder(method, path, body, signal, guard);
    // (plan r8 F4: an active deadline over every await of the request, the token, the proof, the headers and the
    // body: its own signal, aborted by the caller's or by the timer; neither is ever left behind)
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    if (signal?.aborted) ctl.abort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
    const t = this.timers.setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      return await this.requestUnder(method, path, body, ctl.signal, guard);
    } catch (e) {
      if (!timedOut || signal?.aborted) throw e;
      // (the same kind it would be as an abort: not sent before the fetch, ambiguous after)
      if (e instanceof NotSentError) throw new NotSentError(`no answer in ${timeoutMs} ms, so it was not sent`, { aborted: true });
      if (e instanceof AmbiguousError) throw new AmbiguousError(`no answer in ${timeoutMs} ms`, { aborted: true, status: e.status });
      throw e;
    } finally {
      this.timers.clearTimeout(t);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async requestUnder(method, path, body, signal, guard) {
    const res = await this.send(method, path, body, { signal, guard });
    let data;
    try {
      data = await readJson(res, signal);
      // (a read the abort ended is no answer, whatever it read)
      if (signal?.aborted) throw new Error("aborted while the answer was read");
    } catch (e) {
      throw new AmbiguousError(e?.message ?? "the answer could not be read", { aborted: !!signal?.aborted, tooLarge: !!e?.tooLarge, status: res.status });
    }
    const isObject = data && typeof data === "object" && !Array.isArray(data);
    if (res.ok) {
      if (!isObject) throw new AmbiguousError("the gateway's answer was not a JSON object", { status: res.status });
      return data;
    }
    if (isObject && typeof data.error === "string") {
      const ra = Number(res.headers.get("Retry-After"));
      throw new GatewayError(res.status, data.error, typeof data.message === "string" ? data.message : null, Number.isFinite(ra) && ra >= 0 ? ra : null, data);
    }
    throw new AmbiguousError(`the gateway answered ${res.status} without a typed error`, { status: res.status });
  }

  /**
   * A run's events after `after`, as they arrive: {seq, type, ...}.  Throws
   * StreamError if the stream breaks, is aborted, or an event is over its
   * cap (refused before it is decoded); GatewayError if it is refused.
   */
  async *events(path, after, signal) {
    // (the abort is watched from the first moment: one that happens while
    // waiting for the response's headers cancels that wait too)
    if (signal?.aborted) throw new StreamError("aborted", { aborted: true });
    let reader = null;
    const onAbort = () => reader?.cancel().catch(() => {});
    signal?.addEventListener?.("abort", onAbort);
    try {
      let res;
      try {
        res = await this.send("GET", `${path}/events`, undefined, { accept: "text/event-stream", signal, query: `?after=${Number(after) | 0}` });
      } catch (e) {
        if (signal?.aborted) throw new StreamError("aborted", { aborted: true });
        throw new StreamError(`the event stream could not be opened: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      if (!res.ok) {
        let data = null;
        try { data = await readJson(res, signal); } catch {}
        if (data && typeof data.error === "string") throw new GatewayError(res.status, data.error, null, null, data);
        throw new StreamError(`the event stream was refused (${res.status})`);
      }
      reader = res.body.getReader();
      if (signal?.aborted) throw new StreamError("aborted", { aborted: true });
      let buf = new Uint8Array(0);
      for (;;) {
        // every complete event in the buffer, each checked for size before it is decoded
        for (;;) {
          const end = eventEnd(buf);
          if (end === null) break;
          const raw = buf.subarray(0, end.at);
          buf = buf.slice(end.at + end.len);
          if (raw.length > EVENT_RAW_MAX) throw new StreamError("an event was over the size limit, so it was refused", { tooLarge: true });
          const ev = parseEvent(raw);
          if (ev) yield ev;
          if (signal?.aborted) throw new StreamError("aborted", { aborted: true });
        }
        // (an event still arriving: refused as soon as it is past the cap, not counting
        // the start of its separator, without waiting for its end)
        if (pendingLength(buf) > EVENT_RAW_MAX) throw new StreamError("an event was over the size limit, so it was refused", { tooLarge: true });
        let r;
        try {
          r = await reader.read();
        } catch (e) {
          throw new StreamError(signal?.aborted ? "aborted" : `the event stream broke: ${String(e?.message ?? e).slice(0, 200)}`, { aborted: !!signal?.aborted });
        }
        if (signal?.aborted) throw new StreamError("aborted", { aborted: true });
        if (r.done) return;
        const next = new Uint8Array(buf.length + r.value.length);
        next.set(buf);
        next.set(r.value, buf.length);
        buf = next;
      }
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      reader?.cancel().catch(() => {});
    }
  }
}

/**
 * A JSON body, read as a stream and refused at the first byte past
 * RESPONSE_MAX, before it is decoded or parsed (a declared length past it is
 * refused unread).  Empty: null.
 */
export async function readJson(res, signal) {
  const tooLarge = () => Object.assign(new Error("the gateway's answer was over its size limit"), { tooLarge: true });
  const len = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(len) && len > RESPONSE_MAX) {
    res.body?.cancel?.().catch?.(() => {}); // (not awaited, as above)
    throw tooLarge();
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener?.("abort", onAbort);
  const chunks = [];
  let n = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > RESPONSE_MAX) throw tooLarge();
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener?.("abort", onAbort);
    reader.cancel().catch(() => {});
  }
  if (!n) return null;
  const all = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    return undefined; // (unreadable: not an object, so never a valid answer)
  }
}

// The end of the first event in `buf`: a blank line, "\n\n" or "\n\r\n"
// (the gateway sends "\n"); {at, len}, or null.
function eventEnd(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] !== 10) continue;
    if (buf[i + 1] === 10) return { at: i, len: 2 };
    if (buf[i + 1] === 13 && i + 2 < buf.length && buf[i + 2] === 10) return { at: i, len: 3 };
  }
  return null;
}
// The length of an incomplete event, without a trailing partial separator ("\n", "\n\r").
function pendingLength(buf) {
  let n = buf.length;
  if (n && buf[n - 1] === 13) n--;
  if (n && buf[n - 1] === 10) n--;
  return n;
}

// One server-sent event: its data lines joined (at most EVENT_DATA_MAX
// bytes, checked before parsing), parsed as JSON; its id is the run's event
// seq.  Comments (": keep-alive") and empty events: null.
function parseEvent(raw) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new StreamError("an event was not valid UTF-8");
  }
  const data = [];
  let id = null;
  for (const line0 of text.split("\n")) {
    const line = line0.endsWith("\r") ? line0.slice(0, -1) : line0;
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return null;
  const json = data.join("\n");
  if (enc.encode(json).length > EVENT_DATA_MAX) throw new StreamError("an event was over the size limit, so it was refused", { tooLarge: true });
  let ev;
  try {
    ev = JSON.parse(json);
  } catch {
    throw new StreamError("an event was not valid JSON");
  }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) throw new StreamError("an event was not an object");
  if (ev.seq === undefined && id !== null && /^\d+$/.test(id)) ev.seq = Number(id);
  return ev;
}
