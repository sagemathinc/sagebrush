// SHA-256 whose state can be saved between calls (design/tiered-files.md
// §4.1, step 5): a chunked file's whole hash is computed a few chunks per
// request, and the state between requests is stored in the account object.
// Implemented from the standard, FIPS 180-4 §4.1.2, §5.1.1, §6.2: eight
// 32-bit words, the length so far, and at most 63 bytes not yet in a block.
// WebCrypto's digest can't be resumed, so it isn't used here.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** The saved state: hex of the eight words (64 chars), the bytes hashed so far, and the pending bytes (hex, < 64 bytes). */
export interface ShaState { h: string; n: number; rest: string }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);

export class Sha256 {
  private h = new Uint32Array(H0);
  private buf = new Uint8Array(64);
  private used = 0;
  /** bytes hashed so far (a safe integer: files here are at most a few hundred MiB) */
  private n = 0;
  private w = new Uint32Array(64);

  static from(s: ShaState | null): Sha256 {
    const x = new Sha256();
    if (!s) return x;
    if (!/^[0-9a-f]{64}$/.test(s.h) || !/^(?:[0-9a-f]{2}){0,63}$/.test(s.rest) || !Number.isSafeInteger(s.n) || s.n < 0 || s.n % 64 !== s.rest.length / 2) throw new Error("bad SHA-256 state");
    for (let i = 0; i < 8; i++) x.h[i] = parseInt(s.h.slice(i * 8, i * 8 + 8), 16);
    const r = unhex(s.rest);
    x.buf.set(r);
    x.used = r.length;
    x.n = s.n;
    return x;
  }

  save(): ShaState {
    const b = new Uint8Array(32);
    const v = new DataView(b.buffer);
    for (let i = 0; i < 8; i++) v.setUint32(i * 4, this.h[i]);
    return { h: hex(b), n: this.n, rest: hex(this.buf.subarray(0, this.used)) };
  }

  get length(): number {
    return this.n;
  }

  update(data: Uint8Array): this {
    let i = 0;
    this.n += data.length;
    if (this.used) {
      const take = Math.min(64 - this.used, data.length);
      this.buf.set(data.subarray(0, take), this.used);
      this.used += take;
      i = take;
      if (this.used < 64) return this;
      this.block(this.buf, 0);
      this.used = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.used = data.length - i;
    }
    return this;
  }

  /** The digest, as lowercase hex.  The object isn't changed: a copy is padded (§5.1.1). */
  hexDigest(): string {
    const c = Sha256.from(this.save());
    const bits = this.n * 8;
    const pad = new Uint8Array(((this.used < 56 ? 56 : 120) - this.used) + 8);
    pad[0] = 0x80;
    const v = new DataView(pad.buffer);
    v.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    v.setUint32(pad.length - 4, bits >>> 0);
    c.update(pad);
    return c.save().h;
  }

  private block(m: Uint8Array, at: number) {
    const w = this.w;
    for (let t = 0; t < 16; t++) w[t] = (m[at + 4 * t] << 24) | (m[at + 4 * t + 1] << 16) | (m[at + 4 * t + 2] << 8) | m[at + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3], e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += d; this.h[4] += e; this.h[5] += f; this.h[6] += g; this.h[7] += h;
  }
}
