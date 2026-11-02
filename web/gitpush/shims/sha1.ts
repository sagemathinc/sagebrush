// In place of sha.js/sha1.js in Push to GitHub's worker (web/build.ts): an incremental SHA-1 with sha.js's surface as
// isomorphic-git uses it (new Hash().update(bytes).digest() / .digest("hex")). sha.js would bring some 25 small
// packages (Buffer and typed-array polyfills a browser doesn't need) into the worker and their license texts into
// every bundle that carries the notices. Checked against node:crypto (test/gitpush-rules.test.ts) and, end to end,
// by git itself, which refuses an object or pack whose id or checksum is wrong (web/gitpush/test-gitpush.mjs).
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const enc = new TextEncoder();

export default class Sha1 {
  private h = new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0]);
  private block = new Uint8Array(64);
  private fill = 0;
  private bytes = 0;
  private w = new Int32Array(80);

  update(data: Uint8Array | ArrayBuffer | string): this {
    const d = typeof data === "string" ? enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    this.bytes += d.length;
    let i = 0;
    while (i < d.length) {
      const n = Math.min(64 - this.fill, d.length - i);
      this.block.set(d.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === 64) { this.compress(); this.fill = 0; }
    }
    return this;
  }

  private compress() {
    const w = this.w, b = this.block;
    for (let t = 0; t < 16; t++) w[t] = (b[4 * t] << 24) | (b[4 * t + 1] << 16) | (b[4 * t + 2] << 8) | b[4 * t + 3];
    for (let t = 16; t < 80; t++) w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
    let [a, bb, c, d, e] = this.h;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (bb & c) | (~bb & d) : t < 40 ? bb ^ c ^ d : t < 60 ? (bb & c) | (bb & d) | (c & d) : bb ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc | 0 : 0xca62c1d6 | 0;
      const tmp = (rotl(a, 5) + f + e + k + w[t]) | 0;
      e = d; d = c; c = rotl(bb, 30); bb = a; a = tmp;
    }
    const h = this.h;
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }

  digest(): Uint8Array;
  digest(encoding: "hex"): string;
  digest(encoding?: "hex"): Uint8Array | string {
    const bits = this.bytes * 8;
    this.update(new Uint8Array([0x80]));
    while (this.fill !== 56) this.update(new Uint8Array([0]));
    const len = new Uint8Array(8);
    const hi = Math.floor(bits / 2 ** 32), lo = bits >>> 0;
    len[0] = hi >>> 24; len[1] = hi >>> 16; len[2] = hi >>> 8; len[3] = hi; len[4] = lo >>> 24; len[5] = lo >>> 16; len[6] = lo >>> 8; len[7] = lo;
    this.update(len);
    const out = new Uint8Array(20);
    for (let i = 0; i < 5; i++) { out[4 * i] = this.h[i] >>> 24; out[4 * i + 1] = this.h[i] >>> 16; out[4 * i + 2] = this.h[i] >>> 8; out[4 * i + 3] = this.h[i]; }
    if (encoding === "hex") return Array.from(out, (x) => x.toString(16).padStart(2, "0")).join("");
    // (a Buffer where there is one, as sha.js returns: isomorphic-git concatenates it with Buffers)
    const B = (globalThis as any).Buffer;
    return B ? B.from(out) : out;
  }
}
