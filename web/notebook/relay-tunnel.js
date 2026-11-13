// The tunnel to one of your enrolled computers through the site's relay: the same tunnel as "Your computer (paired)"
// (pair-tunnel.js: RemoteClient's gateway requests as frames, its closed route table, its dispatch rules, ids and
// bounds, all unchanged), carried on the relay's kernel page leg (`/api/remote/v1/page?remote=<id>&chan=kernel`) to
// `sagebrush remote` (engine/py/python/sagebrush/remote/relay.py) instead of a loopback socket.
//
//   const t = await relayTunnel({ url: pageLegUrl(remoteId, "kernel"), jwk: client.jwk, jkt: client.jkt });
//   const client = await RemoteClient.create({ base: SYNTHETIC_BASE, token: t.tokenSource, fetch: t.fetch, keys });
//
// What differs from the loopback pairing:
// - The hello is {protocol 1, purpose "kernel", via "relay", jwk, jkt}: no pairing code and no session.  The relay
//   already checked this page's site session and that the account may use this computer; the runner refuses a code
//   or a session hello on the relay, and a kernel hello on any other channel.  Its answer carries no version (the
//   relay channel is newer than the oldest runner this page pairs with), and must say via "relay" and list "kernel"
//   among the runner's channels.
// - The relay's own controls on this leg (cloud web/cloud/remote/relay.ts PAGE_OPS), kept exactly as the terminal's
//   page keeps them (remote-terminal.js): every {"relay":"receipt","r","upto"} is acked at once with
//   {"relay":"ack","r"}, each upto above the last; the page pings {"relay":"ping"} every 15 s from the leg's open, and
//   after 2 pings unanswered ends the leg (4002); any other control, or one not in its exact serialization, ends the
//   leg (4000).  Controls never reach the tunnel's frame handling, and the tunnel's frames are never read as controls.
// - A request frame is also held to the relay's cap for this channel (relay-caps.ts: the runner's kernel
//   pageToPeer), whichever of that and the runner's own limit is lower.
//
// Nothing here is a fallback to anything else: no fetch, no other socket, nothing replayed.

import { Tunnel, PairError, SYNTHETIC_BASE } from "./pair-tunnel.js";

export { SYNTHETIC_BASE };
const MiB = 1024 * 1024;
export const RELAY_TUNNEL = {
  helloMs: 30_000,
  pingMs: 15_000, // between the page's pings to the relay (relay.py RELAY_LIMITS["pingMs"])
  missedPongs: 2, // pings unanswered: the leg is dead
  pageToPeer: Math.round(2.25 * MiB) + 64 * 1024, // the relay's cap on a kernel page's message (relay-caps.ts)
  answerMax: 64 * 1024, // the hello's answer, before it is parsed
};
const RELAY_CONTROL = '{"relay":"';
const LEG_URL = /^wss?:\/\/[^/?#]+\/api\/remote\/v1\/page\?/;

/**
 * The relay's controls on one page leg: the pings, and the receipts and pongs the relay sends.  `send(obj)` writes to
 * the leg; `dead(why)` is called once the pongs stop.  `control(text)` returns null, or why the leg must end.
 */
class RelayLeg {
  constructor(send, dead, timers) {
    this.send = send;
    this.dead = dead;
    this.timers = timers;
    this.pinger = null;
    this.missedPongs = 0; // pings sent since the last pong
    this.receiptUpto = -1; // the last receipt's upto: each next one must be higher (cumulative, never repeated)
  }

  start() {
    if (this.pinger === null) this.pinger = this.timers.setInterval(() => this.ping(), RELAY_TUNNEL.pingMs);
  }

  stop() {
    if (this.pinger !== null) this.timers.clearInterval(this.pinger);
    this.pinger = null;
  }

  ping() {
    if (this.missedPongs >= RELAY_TUNNEL.missedPongs) {
      this.stop();
      return this.dead("no pong");
    }
    this.missedPongs++;
    this.send({ relay: "ping" });
  }

  control(text) {
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return "a malformed relay control";
    }
    if (!o || typeof o !== "object" || Array.isArray(o) || JSON.stringify(o) !== text) return "a malformed relay control";
    const keys = Object.keys(o).join();
    if (o.relay === "receipt" && keys === "relay,r,upto" && typeof o.r === "string" && /^[A-Za-z0-9_-]{22}$/.test(o.r)
        && Number.isSafeInteger(o.upto) && o.upto >= 0) {
      if (o.upto <= this.receiptUpto) return "a receipt out of order";
      this.receiptUpto = o.upto;
      this.send({ relay: "ack", r: o.r });
      return null;
    }
    if (o.relay === "pong" && keys === "relay") {
      this.missedPongs = 0;
      return null;
    }
    return "an unknown relay control";
  }
}

/** A paired tunnel on the relay: pair-tunnel's Tunnel, with the leg's relay controls taken off before its frames. */
export class RelayTunnel extends Tunnel {
  constructor(ws, result, leg, { onClose } = {}) {
    super(ws, result, { onClose });
    this.leg = leg;
    this.frameMax = Math.min(this.frameMax, RELAY_TUNNEL.pageToPeer);
    this.channels = result.channels;
    leg.send = (o) => this.ws.send(JSON.stringify(o));
    leg.dead = (why) => this.fail(4002, why);
  }

  receive(data) {
    if (this.closed) return;
    if (typeof data === "string" && data.startsWith(RELAY_CONTROL)) {
      const why = this.leg.control(data);
      return why === null ? undefined : this.fail(4000, why);
    }
    return super.receive(data);
  }

  gone(why) {
    this.leg.stop();
    super.gone(why);
  }
}

const B64URL43 = /^[A-Za-z0-9_-]{43}$/;

/**
 * Open the kernel page leg to an enrolled computer and pair on it: resolves to a RelayTunnel, or rejects with
 * PairError ("refused" with the runner's own message, "protocol", "closed", "timeout", "unreachable" or "config").
 */
export function relayTunnel({ url, jwk, jkt, WebSocket: WS = globalThis.WebSocket, onClose, timeoutMs = RELAY_TUNNEL.helloMs, timers = globalThis }) {
  if (typeof url !== "string" || !LEG_URL.test(url) || new URL(url.replace(/^ws/, "http")).searchParams.get("chan") !== "kernel") {
    return Promise.reject(new PairError("not a kernel page leg on this site's relay", { kind: "config", sent: false }));
  }
  const params = { protocol: 1, purpose: "kernel", via: "relay", jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, jkt };
  return new Promise((resolve, reject) => {
    let done = false;
    let ws;
    let sent = false; // (set as the hello is handed to the socket)
    const leg = new RelayLeg((o) => ws.send(JSON.stringify(o)), (why) => finish(new PairError(`the relay stopped answering (${why})`, { kind: "closed", sent })), timers);
    const finish = (err, tunnel) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        leg.stop();
        if (ws) ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws?.close(1000); } catch {}
        reject(err);
      } else resolve(tunnel);
    };
    const timer = setTimeout(() => finish(new PairError("your computer didn't answer through the relay", { kind: "timeout", sent })), timeoutMs);
    try {
      ws = new WS(url);
    } catch (e) {
      return finish(new PairError(`couldn't reach the relay: ${e?.message ?? e}`, { kind: "unreachable", sent: false }));
    }
    let opened = false;
    ws.onopen = () => {
      opened = true;
      sent = true;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: "h1", method: "hello", params }));
      leg.start();
    };
    ws.onerror = () => {};
    ws.onclose = (e) => finish(new PairError(opened ? `the relay closed the connection (${e?.code ?? "?"})` : "couldn't reach your computer through the relay", { kind: opened ? "closed" : "unreachable", sent }));
    ws.onmessage = (e) => {
      if (typeof e.data === "string" && e.data.startsWith(RELAY_CONTROL)) {
        const why = leg.control(e.data);
        return why === null ? undefined : finish(new PairError(why, { kind: "protocol", sent }));
      }
      let m;
      try {
        if (typeof e.data !== "string" || e.data.length > RELAY_TUNNEL.answerMax) throw new Error();
        m = JSON.parse(e.data);
      } catch {
        return finish(new PairError("your computer's answer wasn't a pairing answer", { kind: "protocol" }));
      }
      if (m?.error && typeof m.error.message === "string") return finish(new PairError(m.error.message.slice(0, 200), { kind: m.error.data?.code === "protocol" ? "protocol" : "refused" }));
      const r = m?.result;
      const ok = m?.id === "h1" && r && r.protocol === 1 && r.purpose === "kernel" && r.via === "relay"
        && typeof r.token === "string" && B64URL43.test(r.token)
        && typeof r.nonce === "string" && r.nonce.length > 0 && r.nonce.length <= 256
        && typeof r.incarnation === "string" && /^[0-9a-f]{16}$/.test(r.incarnation)
        && Number.isInteger(r.limits?.frame) && r.limits.frame > 0
        && Array.isArray(r.channels) && r.channels.length <= 8 && r.channels.every((c) => typeof c === "string") && r.channels.includes("kernel");
      if (!ok) return finish(new PairError("your computer's answer wasn't a pairing answer", { kind: "protocol" }));
      finish(null, new RelayTunnel(ws, r, leg, { onClose }));
    };
  });
}
