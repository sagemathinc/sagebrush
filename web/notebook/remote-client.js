// The page's client of CoCalc's compute gateway (/api/compute/v1): the
// remote-compute design's HTTPS API.  Every request carries a DPoP proof
// (RFC 9449) made with this page's own P-256 key, which never leaves it
// (WebCrypto, generated non-extractable); the access token is bound to that
// key, so a copied token is useless without it.  The server's DPoP-Nonce is
// used, and a request refused for want of a fresh one is retried once.
//
// Run events arrive as a fetch-streamed text/event-stream (headers work,
// unlike EventSource); each event is refused before it is parsed if it is
// over EVENT_MAX bytes, and request bodies are checked against their
// endpoint's cap before they are sent.
//
//   const client = await RemoteClient.create({ base: "https://cocalc.ai/api/compute/v1", token: () => accessToken });
//   const r = await client.request("POST", "/bindings", { notebook, kernel, path });
//   for await (const ev of client.events(`/bindings/${b}/runs/${rq}/events`, 0)) ...

// (the largest event the page parses: the gateway's events are at most
// 897 KiB of JSON, one 896 KiB message plus its envelope)
export const EVENT_MAX = 897 * 1024;
// (request bodies: a run's code is at most 1 MiB per cell, a file chunk is
// 512 KiB raw in base64, anything else is small)
export const BODY_MAX = { run: 2.25 * 1024 * 1024, put: 768 * 1024, other: 64 * 1024 };
// (a response body read as JSON: lists are paginated within 256 KiB; a file
// chunk's answer is the largest, under 1 MiB)
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

/** An error from the gateway: `status` (HTTP), `code` (its typed error), `retryAfter` (seconds, if given). */
export class GatewayError extends Error {
  constructor(status, code, message, retryAfter = null, body = null) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

/** Why an event stream ended early: `tooLarge` if an event was over EVENT_MAX. */
export class StreamError extends Error {
  constructor(message, { tooLarge = false } = {}) {
    super(message);
    this.tooLarge = tooLarge;
  }
}

export class RemoteClient {
  /**
   * @param {object} o
   * @param {string} o.base the gateway's base URL (its configured origin and /api/compute/v1)
   * @param {() => string | Promise<string>} o.token the current access token
   * @param {typeof fetch} [o.fetch] (tests: a fake gateway)
   * @param {CryptoKeyPair} [o.keys] (default: a new non-extractable P-256 pair)
   */
  static async create({ base, token, fetch: f, keys }) {
    const pair = keys ?? (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]));
    // (a public key is always exportable; the private key never is)
    const full = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const jwk = { kty: full.kty, crv: full.crv, x: full.x, y: full.y };
    return new RemoteClient({ base, token, fetch: f, privateKey: pair.privateKey, jwk, jkt: await jwkThumbprint(jwk) });
  }

  constructor({ base, token, fetch: f, privateKey, jwk, jkt }) {
    this.base = String(base).replace(/\/+$/, "");
    this.token = token;
    this.fetch = f ?? ((...a) => globalThis.fetch(...a));
    this.privateKey = privateKey;
    this.jwk = jwk;
    this.jkt = jkt;
    this.nonce = null; // the server's latest DPoP-Nonce
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
    if (method === "POST" && /\/runs$/.test(path)) return BODY_MAX.run;
    if (method === "PUT" && /\/files\//.test(path)) return BODY_MAX.put;
    return BODY_MAX.other;
  }

  // One request with its proof; a 401 (or a /token 400) asking for a fresh
  // nonce is retried once with the nonce it gave; a second refusal is an error.
  async send(method, path, body, { accept = "application/json" } = {}) {
    const url = this.base + path;
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (text !== undefined && enc.encode(text).length > RemoteClient.bodyCap(method, path)) {
      throw new GatewayError(413, "too-large", "this request is over its size limit, so it was not sent");
    }
    const accessToken = await this.token();
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `DPoP ${accessToken}`, DPoP: await this.proof(method, url, accessToken), Accept: accept };
      if (text !== undefined) headers["Content-Type"] = "application/json";
      const res = await this.fetch(url, { method, headers, ...(text !== undefined ? { body: text } : {}) });
      const fresh = res.headers.get("DPoP-Nonce");
      if (fresh) this.nonce = fresh;
      const wantsNonce = res.status === 401 && /use_dpop_nonce/.test(res.headers.get("WWW-Authenticate") ?? "");
      if (wantsNonce && attempt === 0 && fresh) {
        await res.body?.cancel?.();
        continue;
      }
      return res;
    }
  }

  /** A JSON request; resolves to the parsed answer, or throws a GatewayError. */
  async request(method, path, body) {
    const res = await this.send(method, path, body);
    const data = await readJson(res);
    if (res.ok) return data;
    const ra = Number(res.headers.get("Retry-After"));
    throw new GatewayError(res.status, data?.error ?? null, data?.message ?? null, Number.isFinite(ra) && ra >= 0 ? ra : null, data);
  }

  /**
   * A run's events after `after` (their seq numbers), as they arrive:
   * {seq, type, ...}.  Throws StreamError if the stream breaks or an event is
   * over EVENT_MAX (never parsed), GatewayError if it is refused.
   * `signal` aborts it.
   */
  async *events(path, after, signal) {
    const res = await this.send("GET", `${path}?after=${Number(after) | 0}`, undefined, { accept: "text/event-stream" });
    if (!res.ok) {
      const data = await readJson(res).catch(() => null);
      throw new GatewayError(res.status, data?.error ?? null, data?.message ?? null, null, data);
    }
    const reader = res.body.getReader();
    const onAbort = () => reader.cancel().catch(() => {});
    signal?.addEventListener?.("abort", onAbort);
    let buf = new Uint8Array(0);
    try {
      for (;;) {
        // every complete event in the buffer, each checked for size before it is decoded
        for (;;) {
          const end = eventEnd(buf);
          if (end < 0) break;
          const raw = buf.subarray(0, end.at);
          buf = buf.slice(end.at + end.len);
          if (raw.length > EVENT_MAX) throw new StreamError("an event was over the size limit, so it was refused", { tooLarge: true });
          const ev = parseEvent(new TextDecoder().decode(raw));
          if (ev) yield ev;
        }
        // (an event still arriving that is already too big: refused without waiting for its end)
        if (buf.length > EVENT_MAX + 64) throw new StreamError("an event was over the size limit, so it was refused", { tooLarge: true });
        const { done, value } = await reader.read();
        if (done) return;
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
    } catch (e) {
      if (e instanceof StreamError || e instanceof GatewayError) throw e;
      throw new StreamError(signal?.aborted ? "aborted" : `the event stream broke: ${String(e?.message ?? e).slice(0, 200)}`);
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      reader.cancel().catch(() => {});
    }
  }
}

// (a JSON body, refused unread past RESPONSE_MAX)
async function readJson(res) {
  const len = Number(res.headers.get("Content-Length"));
  if (Number.isFinite(len) && len > RESPONSE_MAX) {
    await res.body?.cancel?.();
    throw new GatewayError(res.status, "too-large", "the gateway's answer was over its size limit");
  }
  const text = await res.text();
  if (enc.encode(text).length > RESPONSE_MAX) throw new GatewayError(res.status, "too-large", "the gateway's answer was over its size limit");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The end of the first event in `buf`: a blank line, "\n\n" or "\r\n\r\n"
// (the gateway sends "\n"); {at, len}, or -1.
function eventEnd(buf) {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] !== 10) continue;
    if (buf[i + 1] === 10) return { at: i, len: 2 };
    if (buf[i + 1] === 13 && buf[i + 2] === 10) return { at: i, len: 3 };
  }
  return -1;
}

// One server-sent event: its data lines joined, parsed as JSON; its id is
// the run's event seq.  Comments (": keep-alive") and empty events: null.
function parseEvent(text) {
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
  let ev;
  try {
    ev = JSON.parse(data.join("\n"));
  } catch {
    throw new StreamError("an event was not valid JSON");
  }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) throw new StreamError("an event was not an object");
  if (ev.seq === undefined && id !== null) ev.seq = Number(id);
  return ev;
}
