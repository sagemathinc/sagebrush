// Browser stand-ins for the Node APIs the runtime touches.  Loaded first.
const g = globalThis as any;
g.process ??= {
  env: {},
  argv: [],
  platform: "browser",
  pid: 1,
  version: "v0.0.0",
  versions: {},
  cwd: () => "/",
  chdir: () => {},
  cpuUsage: () => ({ user: 0, system: 0 }),
  hrtime: Object.assign(() => [0, 0], { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  exitCode: 0,
  stdout: { isTTY: false },
  stderr: { isTTY: false },
  stdin: { isTTY: false },
  on: () => {},
  exit: () => {},
};

// Just enough of Buffer (latin1/utf8/hex, includes, alloc).
class MiniBuffer extends Uint8Array {
  static from(x: any, a?: any, b?: any): MiniBuffer {
    if (typeof x === "string") {
      if (a === "latin1" || a === "binary") return new MiniBuffer(Array.from(x, (c) => c.charCodeAt(0) & 255));
      if (a === "hex") return new MiniBuffer((x.match(/../g) ?? []).map((h) => parseInt(h, 16)));
      return new MiniBuffer(new TextEncoder().encode(x));
    }
    if (x instanceof ArrayBuffer) return new MiniBuffer(x, a ?? 0, b ?? x.byteLength - (a ?? 0));
    return new MiniBuffer(x);
  }
  static alloc(n: number) {
    return new MiniBuffer(n);
  }
  static isBuffer(x: any) {
    return x instanceof MiniBuffer;
  }
  toString(enc?: string, start = 0, end = this.length): string {
    const v = this.subarray(start, end);
    if (enc === "latin1" || enc === "binary") {
      let s = "";
      for (let i = 0; i < v.length; i += 8192) s += String.fromCharCode(...v.subarray(i, i + 8192));
      return s;
    }
    if (enc === "hex") return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
    return new TextDecoder().decode(v);
  }
  includes(needle: any): boolean {
    const n = needle instanceof Uint8Array ? needle : MiniBuffer.from(String(needle));
    if (n.length === 0) return true;
    outer: for (let i = 0; i + n.length <= this.length; i++) {
      for (let j = 0; j < n.length; j++) if (this[i + j] !== n[j]) continue outer;
      return true;
    }
    return false;
  }
}
g.Buffer ??= MiniBuffer;
