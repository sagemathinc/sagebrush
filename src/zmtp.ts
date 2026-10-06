// The part of ZeroMQ a Jupyter kernel needs, in plain Node: ZMTP 3.x
// (https://rfc.zeromq.org/spec/23/ and /37/) over TCP with the NULL
// mechanism, and the bound side of ROUTER (shell, control, stdin), PUB
// (iopub) and REP (heartbeat) sockets.  No native ZeroMQ library, so the
// kernel runs wherever Node (or the self-contained executable) does.
//
// Frames: a flags byte (bit 0 MORE, bit 1 LONG size, bit 2 COMMAND), the
// size (1 byte, or 8 bytes big-endian), the body.  A connection starts
// with a 64-byte greeting from each side, then a READY command each way
// carrying the Socket-Type (and optionally Identity) properties.

import * as net from "net";

export type SocketType = "ROUTER" | "PUB" | "REP";

export class Peer {
  buf: Buffer = Buffer.alloc(0);
  greeted = false;
  ready = false;
  frames: Buffer[] = [];
  identity: Buffer = Buffer.alloc(0);
  constructor(public socket: net.Socket) {}
}

function frame(body: Buffer, more: boolean, command = false): Buffer {
  const flags = (more ? 1 : 0) | (command ? 4 : 0);
  if (body.length < 256) {
    const h = Buffer.alloc(2);
    h[0] = flags;
    h[1] = body.length;
    return Buffer.concat([h, body]);
  }
  const h = Buffer.alloc(9);
  h[0] = flags | 2;
  h.writeBigUInt64BE(BigInt(body.length), 1);
  return Buffer.concat([h, body]);
}

function greeting(): Buffer {
  const g = Buffer.alloc(64);
  g[0] = 0xff;
  g[9] = 0x7f;
  g[10] = 3; // version 3.1
  g[11] = 1;
  g.write("NULL", 12, "ascii");
  g[32] = 0; // as-server: unused by NULL
  return g;
}

function readyCommand(type: SocketType): Buffer {
  const props: Buffer[] = [];
  const prop = (name: string, value: Buffer) => {
    const n = Buffer.from(name, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(value.length);
    props.push(Buffer.from([n.length]), n, len, value);
  };
  prop("Socket-Type", Buffer.from(type, "ascii"));
  const name = Buffer.from("READY", "ascii");
  return frame(Buffer.concat([Buffer.from([name.length]), name, ...props]), false, true);
}

function parseProps(body: Buffer, at: number): Map<string, Buffer> {
  const m = new Map<string, Buffer>();
  while (at < body.length) {
    const nl = body[at++];
    const name = body.subarray(at, at + nl).toString("ascii");
    at += nl;
    const vl = body.readUInt32BE(at);
    at += 4;
    m.set(name.toLowerCase(), body.subarray(at, at + vl));
    at += vl;
  }
  return m;
}

export class ZSocket {
  server: net.Server;
  peers = new Set<Peer>();
  private nextId = 1;
  onMessage: (frames: Buffer[], peer: Peer) => void = () => {};

  constructor(public type: SocketType) {
    this.server = net.createServer((s) => this.accept(s));
  }

  bind(ip: string, port: number): Promise<number> {
    return new Promise((res, rej) => {
      this.server.once("error", rej);
      this.server.listen(port, ip === "*" ? "0.0.0.0" : ip, () => res((this.server.address() as net.AddressInfo).port));
    });
  }

  close() {
    for (const p of this.peers) p.socket.destroy();
    this.server.close();
  }

  private accept(s: net.Socket) {
    const p = new Peer(s);
    s.setNoDelay(true);
    this.peers.add(p);
    s.write(greeting());
    s.on("data", (d: Buffer) => this.data(p, d));
    const drop = () => this.peers.delete(p);
    s.on("close", drop);
    s.on("error", drop);
  }

  private data(p: Peer, d: Buffer) {
    p.buf = p.buf.length ? Buffer.concat([p.buf, d]) : d;
    if (!p.greeted) {
      if (p.buf.length < 64) return;
      if (p.buf[0] !== 0xff || p.buf[9] !== 0x7f || p.buf[10] < 3) {
        p.socket.destroy(); // not ZMTP 3
        return;
      }
      p.greeted = true;
      p.buf = p.buf.subarray(64);
      p.socket.write(readyCommand(this.type));
    }
    for (;;) {
      if (p.buf.length < 2) return;
      const flags = p.buf[0];
      let size: number, at: number;
      if (flags & 2) {
        if (p.buf.length < 9) return;
        size = Number(p.buf.readBigUInt64BE(1));
        at = 9;
      } else {
        size = p.buf[1];
        at = 2;
      }
      if (p.buf.length < at + size) return;
      const body = Buffer.from(p.buf.subarray(at, at + size));
      p.buf = p.buf.subarray(at + size);
      if (flags & 4) {
        this.command(p, body);
        continue;
      }
      p.frames.push(body);
      if (!(flags & 1)) {
        const msg = p.frames;
        p.frames = [];
        this.message(p, msg);
      }
    }
  }

  private command(p: Peer, body: Buffer) {
    const nl = body[0];
    const name = body.subarray(1, 1 + nl).toString("ascii");
    if (name === "READY") {
      const props = parseProps(body, 1 + nl);
      const id = props.get("identity");
      if (id && id.length) p.identity = Buffer.from(id);
      else {
        // as libzmq: a 5-byte routing id starting with 0
        p.identity = Buffer.alloc(5);
        p.identity.writeUInt32BE(this.nextId++, 1);
      }
      p.ready = true;
    }
    // SUBSCRIBE / CANCEL / PING: PUB here sends everything to everyone
    // (Jupyter clients subscribe to all topics)
    if (name === "PING") {
      const ctx = body.subarray(1 + nl + 2);
      const pong = Buffer.from("PONG", "ascii");
      p.socket.write(frame(Buffer.concat([Buffer.from([pong.length]), pong, ctx]), false, true));
    }
  }

  private message(p: Peer, frames: Buffer[]) {
    if (this.type === "PUB") return; // a ZMTP 3.0 subscription message
    if (this.type === "REP") {
      // heartbeat: echo, envelope included
      this.write(p, frames);
      return;
    }
    this.onMessage([p.identity, ...frames], p);
  }

  private write(p: Peer, frames: Buffer[]) {
    if (!p.ready && !p.greeted) return;
    p.socket.write(Buffer.concat(frames.map((f, i) => frame(f, i < frames.length - 1))));
  }

  /** ROUTER: the first frame names the peer.  PUB: to every peer. */
  send(frames: Buffer[]) {
    if (this.type === "PUB") {
      for (const p of this.peers) if (p.greeted) this.write(p, frames);
      return;
    }
    const [id, ...rest] = frames;
    for (const p of this.peers) {
      if (p.identity.equals(id)) {
        this.write(p, rest);
        return;
      }
    }
  }
}
