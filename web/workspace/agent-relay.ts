// The page's agent leg to one of your computers (`sagebrush remote --serve-agents`): the relay's page leg on channel
// "agent" (`/api/remote/v1/page?remote=<id>&chan=agent`), the runner's agent protocol (engine/py/python/sagebrush/remote/
// relay.py), and an AgentPairing's link (agent-pair.ts) on top. The other end is the person's own agent, a child
// process of the runner (`sagebrush-agent --stdio`).
//
// The protocol, page side:
// - the relay's controls, as remote-terminal.js answers them: every {"relay":"receipt","r","upto"} acked at once with
//   {"relay":"ack","r"}; a ping every 15 s; 2 pings unanswered and the leg is dead;
// - the hello: {"a":"DPoP ","p":proof,"m":hello-text}, self-signed by this page's key, its htu
//   "sb-agent-hello:<remote_id>#<sha256 of hello-text>", method AGENT. It asks `fresh`: nothing is remembered in B;
// - its result: token, nonce, gen, incarnation, remote_id and limits.frame (F, the bound on a whole envelope);
// - every later message: {"a":"DPoP <token>","p":proof,"m":payload}, htu
//   "sb-agent:<remote_id>/<incarnation>/<gen>#<sha256 of payload>", with the nonce. {"unpair":true} stops the agent;
// - the runner's own words: agent.ended (then it closes this page) and agent.notice.
//
// The bounds, counted in UTF-8 wire bytes of whole envelopes:
// - an envelope's length is exact before it is signed (envelopeBytes): an envelope of exactly F is sent, F + 1 isn't;
// - the send queue: at most QUEUE_ENTRIES and 2F, from admission to ws.send; a message that doesn't fit now is refused
//   at once ("full"), never held; one over F alone is refused ("over");
// - written only while bufferedAmount plus the envelope is at most F (polled every BUFFER_POLL_MS); the relay's own
//   controls (acks, pings) and the hello, not queued, go while bufferedAmount stays within F plus controlAllowance
//   (4 KiB), else the leg ends: the browser's buffer is at most F + 4 KiB;
// - every call from the agent takes a reply slot when it arrives (owe), REPLY_SLOTS in all, and keeps it until its
//   reply is written; an answer that doesn't fit the queue is replaced by a small error from the reply reserve
//   (one place per slot, RESERVE_ENVELOPE bytes each), so an owed reply always has a place; past REPLY_SLOTS the
//   pairing ends (fail closed);
// - the control reserve, apart: grant.changed {} and {"unpair":true} at Disconnect;
// - page-wide, across close and Chat here again: at most SIGNS_MAX signing and DIGESTS_MAX digests outstanding, each
//   charged until its promise settles (WebCrypto can't be cancelled).
// - the permission cards kept (agent-cards.ts): at most CARDS_MAX, each within 16 KiB of input and 4 KiB of identities
//   as UTF-8; at most DIGESTS_MAX Allows waiting for a digest place, each holding only its card.
// The heap these allow is an accounted model, not a browser ceiling: a JS string takes at most 2 bytes per UTF-8 byte.

import { listRunners, pageLegUrl, type Runner } from "./remote-runners";

export const LEG = {
  helloMs: 10_000,
  pingMs: 15_000,
  missedPongs: 2,
  unpairMs: 2000,
  queueEntries: 64,
  replySlots: 32, // (the vendored agent's own REQUESTS_MAX: a conforming agent never has more outstanding)
  reserveEnvelope: 4096, // (one reserve place: a whole limit-error envelope, by envelopeBytes)
  errorPayloadMax: 512,
  tokenMax: 1024,
  bufferPollMs: 50,
  controlAllowance: 4096, // (the relay's acks and pings, over F in the browser's buffer: a few dozen bytes each)
  frameMin: 64 * 1024,
  frameMax: 16 * 1024 * 1024,
};
export const SIGNS_MAX = 1;
export const DIGESTS_MAX = 4;
/** A digest's charge: its canonical text (16 KiB of UTF-8, twice that as a JS string) and the WebCrypto input. */
export const DIGEST_CHARGE = 3 * 16 * 1024;

const RELAY_CONTROL = '{"relay":"';
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64len = (n: number) => Math.ceil((n * 4) / 3);
async function sha256(subtle: SubtleCrypto, text: string): Promise<string> {
  return b64url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(text))));
}

/** The UTF-8 length of `s` written as a JSON string literal (quotes and escapes included), exactly as JSON.stringify
 * writes it (ES2019: a lone surrogate as \udxxx), counted without making the copy. */
export function jsonStringBytes(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) n += 2;
    else if (c < 0x20) n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    else if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) { n += 4; i++; } else n += 6;
    } else if (c >= 0xdc00 && c <= 0xdfff) n += 6;
    else n += 3;
  }
  return n;
}

// ---- the page-wide gates: outstanding work, charged until it settles

export class Gate {
  active = 0;
  bytes = 0;
  peak = 0;
  peakBytes = 0;
  private waiting: { bytes: number; live: () => boolean; go: (r: (() => void) | null) => void }[] = [];
  readonly max: number;
  readonly waitMax: number;
  constructor(max: number, waitMax: number) { this.max = max; this.waitMax = waitMax; }
  /** A place, once one is free, as its release; null if `live()` turned false while it waited (nothing charged), or
   * at once if `waitMax` are already waiting (the work isn't done: its caller fails closed). */
  acquire(bytes: number, live: () => boolean): Promise<(() => void) | null> {
    this.sweep();
    if (this.active >= this.max && this.waiting.length >= this.waitMax) return Promise.resolve(null);
    return new Promise((go) => { this.waiting.push({ bytes, live, go }); this.next(); });
  }
  get queued() { return this.waiting.length; }
  private next() {
    while (this.waiting.length && this.active < this.max) {
      const w = this.waiting.shift()!;
      if (!w.live()) { w.go(null); continue; }
      this.active++;
      this.bytes += w.bytes;
      this.peak = Math.max(this.peak, this.active);
      this.peakBytes = Math.max(this.peakBytes, this.bytes);
      let done = false;
      w.go(() => { if (done) return; done = true; this.active--; this.bytes -= w.bytes; this.next(); });
    }
  }
  /** Waiters whose work is no longer wanted, dropped now (a closed pairing's). */
  sweep() { this.waiting = this.waiting.filter((w) => (w.live() ? true : (w.go(null), false))); }
  resetPeaks() { this.peak = this.active; this.peakBytes = this.bytes; }
}
// (waiting, at most: the sends of the legs that can be open at once (a leg pumps one at a time) and the hello; the
//  current pairing's open questions, the agent's own limit)
export const signGate = new Gate(SIGNS_MAX, 4);
export const digestGate = new Gate(DIGESTS_MAX, DIGESTS_MAX);

// ---- the page's key

export type LegKey = { jwk: { kty: string; crv: string; x: string; y: string }; jkt: string; sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> };

/** A new non-extractable P-256 key for one leg: its public JWK, its RFC 7638 thumbprint, and ES256 signing. */
export async function legKey(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<LegKey> {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const { kty, crv, x, y } = await subtle.exportKey("jwk", pair.publicKey) as JsonWebKey;
  const jwk = { kty: kty!, crv: crv!, x: x!, y: y! };
  const jkt = await sha256(subtle, JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  return { jwk, jkt, sign: async (input) => new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, input)) };
}

// ---- the leg

export type LegResult = { token: string; nonce: string; gen: number; incarnation: string; remote_id: string; frame: number };
/** Why a leg ended: lost (the connection), ended (the runner's agent.ended, in its words), refused (the hello),
 * full (more replies owed than REPLY_SLOTS), disconnected (the person's Disconnect, its drain done or timed out). */
export type LegEnd = { kind: "lost" | "ended" | "refused" | "full" | "disconnected"; why: string };
type Kind = "note" | "reply" | "reserve" | "control";
type Entry = { text: string; bytes: number; kind: Kind; done?: () => void };
export type SendResult = "ok" | "full" | "over" | "closed";
export type Clock = { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval; now(): number };

export class AgentLeg {
  state: "new" | "hello" | "open" | "draining" | "closed" = "new";
  result: LegResult | null = null;
  ended: LegEnd | null = null;
  private ws: WebSocket | null = null;
  private q: Entry[] = [];
  private queueBytes = 0;
  private queueEntries = 0;
  private reserved = 0;
  private owed = 0;
  private started: Entry | null = null; // (the entry being signed or waiting for the buffer: it is written even in a drain)
  private pumping = false;
  private proofLen = 0;
  private tokenText = "";
  private pinger: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private unpairTimer: ReturnType<typeof setTimeout> | null = null;
  private missed = 0;
  private receiptUpto = -1;
  private drained: (() => void) | null = null;
  private readonly onMessage = new Set<(text: string) => void>();
  private readonly onEnd = new Set<(e: LegEnd) => void>();
  private readonly onNotice = new Set<(text: string) => void>();
  private readonly onOpen = new Set<(r: LegResult) => void>();
  private readonly clock: Clock;
  private readonly subtle: SubtleCrypto;
  /** Peaks, for the bounds' rows: entries and wire bytes in the queue, places used in the reply reserve, owed replies,
   * and the browser's buffer as seen before each write. */
  peaks = { entries: 0, bytes: 0, reserved: 0, owed: 0, buffered: 0 };
  /** Every written envelope's computed and actual UTF-8 length (a row checks they are equal). */
  lengths: { computed: number; actual: number }[] | null = null;

  readonly o: { remoteId: string; url: string; key: LegKey; WebSocket?: typeof WebSocket; clock?: Partial<Clock>; subtle?: SubtleCrypto; recordLengths?: boolean };
  constructor(o: { remoteId: string; url: string; key: LegKey; WebSocket?: typeof WebSocket; clock?: Partial<Clock>; subtle?: SubtleCrypto; recordLengths?: boolean }) {
    this.o = o;
    this.clock = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis), now: () => Date.now(), ...o.clock };
    this.subtle = o.subtle ?? globalThis.crypto.subtle;
    if (o.recordLengths) this.lengths = [];
  }

  on(ev: "message", cb: (text: string) => void): () => void;
  on(ev: "end", cb: (e: LegEnd) => void): () => void;
  on(ev: "notice", cb: (text: string) => void): () => void;
  on(ev: "open", cb: (r: LegResult) => void): () => void;
  on(ev: string, cb: (x: any) => void) {
    const set = ({ message: this.onMessage, end: this.onEnd, notice: this.onNotice, open: this.onOpen } as Record<string, Set<(x: any) => void>>)[ev];
    set.add(cb);
    return () => void set.delete(cb);
  }
  private fire<T>(set: Set<(x: T) => void>, x: T) { for (const cb of [...set]) { try { cb(x); } catch { /* (a listener must not break the protocol) */ } } }

  /** Live counters, for the rows and the bounds' accounting. */
  counters() {
    return { entries: this.queueEntries, bytes: this.queueBytes, reserved: this.reserved, controls: this.q.filter((e) => e.kind === "control").length, owed: this.owed, timers: (this.pinger ? 1 : 0) + (this.helloTimer ? 1 : 0) + (this.unpairTimer ? 1 : 0), listeners: this.onMessage.size + this.onEnd.size + this.onNotice.size + this.onOpen.size, queued: this.q.length };
  }

  start() {
    if (this.state !== "new") throw new Error("AgentLeg.start: already started");
    this.state = "hello";
    const WS = this.o.WebSocket ?? WebSocket;
    const ws = (this.ws = new WS(this.o.url));
    this.helloTimer = this.clock.setTimeout(() => { this.helloTimer = null; if (this.state === "hello") this.end({ kind: "lost", why: "no answer from the computer" }); }, LEG.helloMs);
    ws.addEventListener("open", () => {
      if (this.state !== "hello") return;
      this.pinger = this.clock.setInterval(() => this.ping(), LEG.pingMs);
      void this.hello();
    });
    ws.addEventListener("message", (e: MessageEvent) => this.message(e.data));
    ws.addEventListener("close", (e: CloseEvent) => this.closed(e.code, e.reason || ""));
    ws.addEventListener("error", () => {});
    return this;
  }

  /** The relay's own controls (an ack, a ping, the hello): not queued, within CONTROL_ALLOWANCE over F in the
   * browser's buffer; past it the leg ends (fail closed) rather than buffer more. */
  private raw(obj: unknown) {
    const text = JSON.stringify(obj);
    try {
      if (!this.ws || this.ws.readyState !== 1) return;
      if (this.ws.bufferedAmount + text.length > (this.result?.frame ?? LEG.frameMin) + LEG.controlAllowance) return this.end({ kind: "lost", why: "" });
      this.ws.send(text);
    } catch { /* (closing) */ }
  }

  private ping() {
    if (this.state === "closed") return;
    if (this.missed >= LEG.missedPongs) return this.end({ kind: "lost", why: "" });
    this.missed++;
    this.raw({ relay: "ping" });
  }

  /** The relay's controls on this leg, strictly (remote-terminal.js's _relayControl): receipt acked, pong. */
  private relayControl(text: string) {
    let o: any;
    try { o = JSON.parse(text); } catch { return this.end({ kind: "lost", why: "" }); }
    if (!o || typeof o !== "object" || Array.isArray(o) || JSON.stringify(o) !== text) return this.end({ kind: "lost", why: "" });
    const keys = Object.keys(o).join();
    if (o.relay === "receipt" && keys === "relay,r,upto" && typeof o.r === "string" && /^[A-Za-z0-9_-]{22}$/.test(o.r) && Number.isSafeInteger(o.upto) && o.upto > this.receiptUpto) {
      this.receiptUpto = o.upto;
      return this.raw({ relay: "ack", r: o.r });
    }
    if (o.relay === "pong" && keys === "relay") { this.missed = 0; return; }
    this.end({ kind: "lost", why: "" });
  }

  private async hello() {
    const params = { protocol: 1, purpose: "agent", via: "relay", jwk: this.o.key.jwk, jkt: this.o.key.jkt, fresh: true };
    const m = JSON.stringify({ jsonrpc: "2.0", id: "a1", method: "hello", params });
    const release = await signGate.acquire(2 * enc.encode(m).length + 4096, () => this.state === "hello");
    if (!release) { if (this.state === "hello") this.end({ kind: "lost", why: "" }); return; }
    try {
      const proof = await this.proof(`sb-agent-hello:${this.o.remoteId}#${await sha256(this.subtle, m)}`, "", null);
      if (this.state !== "hello") return;
      this.raw({ a: "DPoP ", p: proof, m });
    } catch {
      if (this.state === "hello") this.end({ kind: "lost", why: "this browser couldn't sign the connection" });
    } finally { release(); }
  }

  /** A DPoP proof (ES256) for `htu`, the token's ath, and the nonce if any. */
  private async proof(htu: string, token: string, nonce: string | null): Promise<string> {
    const part = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));
    const iat = Math.floor(this.clock.now() / 1000);
    const claims: Record<string, unknown> = { jti: b64url(globalThis.crypto.getRandomValues(new Uint8Array(16))), htm: "AGENT", htu, iat, ath: await sha256(this.subtle, token) };
    if (nonce !== null) claims.nonce = nonce;
    const input = `${part({ typ: "dpop+jwt", alg: "ES256", jwk: this.o.key.jwk })}.${part(claims)}`;
    return `${input}.${b64url(await this.o.key.sign(enc.encode(input)))}`;
  }

  /** The proof's length on this leg, fixed: every part but the jti, the iat and the digest is the leg's own, and those
   * are 22 characters, 10 digits and 43 characters. */
  private proofLength(r: LegResult): number {
    const header = enc.encode(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: this.o.key.jwk })).length;
    const htu = `sb-agent:${r.remote_id}/${r.incarnation}/${r.gen}#${"A".repeat(43)}`;
    const claims = enc.encode(JSON.stringify({ jti: "A".repeat(22), htm: "AGENT", htu, iat: 1_000_000_000, ath: "A".repeat(43), nonce: r.nonce })).length;
    return b64len(header) + 1 + b64len(claims) + 1 + b64len(64);
  }

  /** The exact UTF-8 length of the envelope that carries `payload` on this leg. */
  envelopeBytes(payload: string): number {
    // {"a":"DPoP <token>","p":"<proof>","m":<payload as a JSON string>}
    return 5 + this.tokenText.length + 2 + 5 + this.proofLen + 2 + 5 + jsonStringBytes(payload) + 1;
  }

  private async message(data: unknown) {
    if (this.state === "closed") return;
    if (typeof data !== "string") return this.end({ kind: "lost", why: "" });
    if (data.startsWith(RELAY_CONTROL)) return this.relayControl(data);
    if (this.state === "hello") return this.helloAnswer(data);
    let m: any = null;
    try { m = JSON.parse(data); } catch { /* (the pairing says so) */ }
    // (the runner's own words: shown as they are)
    if (m && m.jsonrpc === "2.0" && m.id === undefined && (m.method === "agent.ended" || m.method === "agent.notice") && typeof m.params?.text === "string") {
      const text = m.params.text.slice(0, 500);
      if (m.method === "agent.notice") return this.fire(this.onNotice, text);
      this.endedText = text;
      return;
    }
    this.fire(this.onMessage, data);
  }
  private endedText = "";

  private helloAnswer(data: string) {
    let m: any;
    try { m = JSON.parse(data); } catch { return this.end({ kind: "refused", why: "the computer answered in a form this page doesn't know" }); }
    const r = m?.result;
    if (!r) return this.end({ kind: "refused", why: String(m?.error?.data?.message ?? m?.error?.message ?? "the computer refused the connection").slice(0, 300) });
    const ok = r.purpose === "agent" && typeof r.token === "string" && /^[A-Za-z0-9_-]+$/.test(r.token) && r.token.length <= LEG.tokenMax
      && typeof r.nonce === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.nonce) && Number.isSafeInteger(r.gen) && r.gen >= 0
      && typeof r.incarnation === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.incarnation) && r.remote_id === this.o.remoteId
      && Number.isSafeInteger(r.limits?.frame) && r.limits.frame >= LEG.frameMin && r.limits.frame <= LEG.frameMax;
    if (!ok) return this.end({ kind: "refused", why: "the computer answered in a form this page doesn't know" });
    if (this.helloTimer) { this.clock.clearTimeout(this.helloTimer); this.helloTimer = null; }
    this.result = { token: r.token, nonce: r.nonce, gen: r.gen, incarnation: r.incarnation, remote_id: r.remote_id, frame: r.limits.frame };
    this.tokenText = "DPoP " + r.token;
    this.tokenText = JSON.stringify(this.tokenText).slice(1, -1); // (base64url: nothing to escape; kept exact anyway)
    this.proofLen = this.proofLength(this.result);
    this.state = "open";
    this.fire(this.onOpen, this.result);
  }

  /** A notification or answer for the agent (a JSON text, as JSON.stringify gives it). "ok": admitted, written in
   * order; "full": the queue has no room now; "over": its envelope alone is over F; "closed". */
  send(text: string): SendResult {
    if (this.state !== "open" || !this.result) return "closed";
    const bytes = this.envelopeBytes(text);
    if (bytes > this.result.frame) return "over";
    if (this.queueEntries + 1 > LEG.queueEntries || this.queueBytes + bytes > 2 * this.result.frame) return "full";
    this.admit({ text, bytes, kind: "note" });
    return "ok";
  }

  /** A reply slot, for a call that just arrived (accepted or refused alike); false: REPLY_SLOTS are already owed, and
   * the leg ends (fail closed). */
  owe(): boolean {
    if (this.state !== "open") return false;
    if (this.owed >= LEG.replySlots) {
      this.end({ kind: "full", why: "the agent sent too many requests at once" });
      return false;
    }
    this.owed++;
    this.peaks.owed = Math.max(this.peaks.owed, this.owed);
    return true;
  }

  /** An owed reply: `text` if it fits the queue, else `fallback` (a limit error of at most errorPayloadMax bytes) from
   * the reply reserve, which always has its place. The slot is given back once it is written. */
  reply(text: string, fallback: string): boolean {
    if (this.state !== "open" || !this.result || this.owed <= 0) return false;
    const done = () => { this.owed = Math.max(0, this.owed - 1); };
    const bytes = this.envelopeBytes(text);
    if (bytes <= this.result.frame && this.queueEntries + 1 <= LEG.queueEntries && this.queueBytes + bytes <= 2 * this.result.frame) {
      this.admit({ text, bytes, kind: "reply", done });
      return true;
    }
    const fb = this.envelopeBytes(fallback);
    if (enc.encode(fallback).length > LEG.errorPayloadMax || fb > LEG.reserveEnvelope || this.reserved >= LEG.replySlots) {
      // (unreachable: a fixed small error, and a place per owed reply; failing closed if it ever were)
      this.end({ kind: "full", why: "the agent sent too many requests at once" });
      return false;
    }
    this.admit({ text: fallback, bytes: fb, kind: "reserve", done });
    return true;
  }

  private admit(e: Entry) {
    this.q.push(e);
    if (e.kind === "note" || e.kind === "reply") { this.queueEntries++; this.queueBytes += e.bytes; }
    else if (e.kind === "reserve") this.reserved++;
    this.peaks.entries = Math.max(this.peaks.entries, this.queueEntries);
    this.peaks.bytes = Math.max(this.peaks.bytes, this.queueBytes);
    this.peaks.reserved = Math.max(this.peaks.reserved, this.reserved);
    void this.pump();
  }
  private unadmit(e: Entry) {
    if (e.kind === "note" || e.kind === "reply") { this.queueEntries--; this.queueBytes -= e.bytes; }
    else if (e.kind === "reserve") this.reserved--;
  }

  private writable() { return this.state === "open" || this.state === "draining"; }

  /** One envelope at a time: the page-wide signing place, the proof, the browser's buffer under F, then ws.send. */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.q.length && this.writable() && this.result) {
        const e = this.q[0], r = this.result;
        // (charged: the envelope (2 bytes a unit in the heap) until it is written or dropped)
        const release = await signGate.acquire(2 * e.bytes, () => this.writable() && this.q[0] === e);
        if (!release) {
          // (its entry dropped meanwhile (a Disconnect): on to what the queue holds now; else no place could be had)
          if (this.writable() && this.q[0] !== e) continue;
          if (this.writable()) this.end({ kind: "lost", why: "" });
          return;
        }
        // (started only now, holding the page's signing place: a Disconnect while it waited dropped it)
        if (!this.writable() || this.q[0] !== e) { release(); continue; }
        this.started = e;
        try {
          let env: string;
          try {
            const htu = `sb-agent:${r.remote_id}/${r.incarnation}/${r.gen}#${await sha256(this.subtle, e.text)}`;
            const p = await this.proof(htu, r.token, r.nonce);
            env = JSON.stringify({ a: "DPoP " + r.token, p, m: e.text });
          } catch {
            // (a signing that failed: one terminal close, nothing written after it)
            return this.end({ kind: this.state === "draining" ? "disconnected" : "lost", why: this.state === "draining" ? "" : "this browser couldn't sign a message" });
          }
          while (this.writable() && this.ws && this.ws.bufferedAmount + e.bytes > r.frame) await new Promise((res) => this.clock.setTimeout(res, LEG.bufferPollMs));
          if (!this.writable() || !this.ws || this.ws.readyState !== 1 || this.q[0] !== e) return;
          this.peaks.buffered = Math.max(this.peaks.buffered, this.ws.bufferedAmount);
          if (this.lengths) this.lengths.push({ computed: e.bytes, actual: enc.encode(env).length });
          this.ws.send(env);
          this.q.shift();
          this.unadmit(e);
          this.started = null;
          e.done?.();
          if (this.state === "draining" && !this.q.length) this.finishDrain();
        } finally { release(); }
      }
    } finally {
      this.pumping = false;
      this.started = null;
    }
  }

  /** Disconnect (and Revoke): nothing new admitted, the unstarted sends dropped, then grant.changed {} and
   * {"unpair":true} from the control reserve, written in that order after the one being written, then the close; or
   * the close after UNPAIR_MS. The stop is requested, never confirmed: the runner doesn't report the agent's exit. */
  disconnect(): Promise<void> {
    if (this.state === "closed") return Promise.resolve();
    if (this.state !== "open") { this.end({ kind: "disconnected", why: "" }); return Promise.resolve(); }
    this.state = "draining";
    const keep = this.started && this.q[0] === this.started ? [this.started] : [];
    for (const e of this.q) if (!keep.includes(e)) this.unadmit(e);
    this.q = keep;
    this.owed = 0;
    this.q.push({ text: JSON.stringify({ jsonrpc: "2.0", method: "grant.changed", params: {} }), bytes: 0, kind: "control" });
    this.q.push({ text: JSON.stringify({ unpair: true }), bytes: 0, kind: "control" });
    for (const e of this.q) if (e.kind === "control") e.bytes = this.envelopeBytes(e.text);
    const done = new Promise<void>((res) => { this.drained = res; });
    this.unpairTimer = this.clock.setTimeout(() => { this.unpairTimer = null; this.end({ kind: "disconnected", why: "" }); }, LEG.unpairMs);
    void this.pump();
    return done;
  }
  private finishDrain() { this.end({ kind: "disconnected", why: "" }); }

  /** This leg as a pairing's socket (agent-pair.ts): its messages, its end (said to `ended` first, for the page's
   * words), a close that writes nothing more. Sends go through the leg itself (send, answer), never through this. */
  socket(ended: (e: LegEnd) => void): WebSocket {
    const s: any = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close: () => this.close() };
    this.on("message", (data) => s.onmessage?.({ data }));
    this.on("end", (e) => { s.readyState = 3; ended(e); s.onclose?.({ code: 1000, reason: e.why || e.kind }); });
    return s as WebSocket;
  }

  /** An agent.ready (on each attach): who the agent is and its child, the identity its permission digests bind;
   * undefined for any other message, false for one in an unknown form. */
  ready(msg: any): { agent: { name: string; client: string; version?: string }; features: string[]; child: string } | false | undefined {
    if (msg?.method !== "agent.ready" || msg.id !== undefined) return undefined;
    const r = msg.params;
    if (!r || !r.agent || typeof r.agent.name !== "string" || typeof r.child !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.child)) return false;
    const features = Array.isArray(r.features) ? r.features.filter((f: unknown): f is string => f === "notebook.edit" || f === "permission.digest") : [];
    return { agent: { name: String(r.agent.name).slice(0, 80), client: String(r.agent.client ?? "").slice(0, 40), version: r.agent.version ? String(r.agent.version).slice(0, 40) : undefined }, features, child: r.child };
  }

  /** An owed reply: the first of `tries` whose envelope is within F, else a limit error; in the queue, or the limit
   * error in the reply reserve if the queue has no room. */
  answer(id: string, tries: unknown[]) {
    const frame = this.result?.frame ?? 0;
    const fallback = JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "the answer would be over the frame bound", data: { code: "limit", message: `the answer would be over ${frame} bytes as a message` } } });
    for (const m of tries) {
      const text = JSON.stringify(m);
      if (this.envelopeBytes(text) <= frame) { this.reply(text, fallback); return; }
    }
    this.reply(fallback, fallback);
  }

  /** Close now, with nothing more written (a superseded attempt, or the page leaving). */
  close() { this.end({ kind: "disconnected", why: "" }); }

  private closed(code: number, reason: string) {
    if (this.state === "closed") return;
    // (after this page's own unpair, the runner says agent.ended "The agent stopped. …" before it closes: the person's
    //  Disconnect, not news, so the page's own line stands)
    if (this.state === "draining") return this.end({ kind: "disconnected", why: "" });
    // (the runner's agent.ended came first: its words, as it says them)
    if (this.endedText) return this.end({ kind: "ended", why: this.endedText });
    if (this.state === "hello") return this.end({ kind: "refused", why: reason || "the computer refused the connection" });
    this.end({ kind: "lost", why: code === 1006 ? "" : reason.slice(0, 200) });
  }

  private end(e: LegEnd) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.ended = e;
    if (this.pinger) { this.clock.clearInterval(this.pinger); this.pinger = null; }
    if (this.helloTimer) { this.clock.clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.unpairTimer) { this.clock.clearTimeout(this.unpairTimer); this.unpairTimer = null; }
    for (const x of this.q) this.unadmit(x);
    this.q = [];
    this.owed = 0;
    signGate.sweep();
    try { this.ws?.close(1000); } catch { /* (already closing) */ }
    this.drained?.();
    this.drained = null;
    this.fire(this.onEnd, e);
    this.onMessage.clear();
    this.onNotice.clear();
    this.onOpen.clear();
    this.onEnd.clear();
  }
}

export { listRunners, pageLegUrl, type Runner };
