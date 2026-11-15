// SHA-1 (FIPS 180-4), synchronous, for one use only: checking a file mounted from a GitHub repository against the git
// blob id its listing gives (git's own name for the bytes, `sha1("blob <length>\0" + bytes)`), inside the worker, where
// Python's open() is synchronous and the browser's crypto.subtle isn't. Not for anything that needs SHA-1 to resist
// a chosen collision: the id comes from GitHub's listing and the bytes from raw.githubusercontent.com, at one commit.

/** The SHA-1 of these bytes, as 40 hex digits. */
export function sha1Hex(data: Uint8Array): string {
  const n = data.length, total = ((n + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(data);
  m[n] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(n / 0x20000000));
  dv.setUint32(total - 4, (n << 3) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999 : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1 : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc : (b ^ c ^ d) + 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Git's blob id for these bytes (what a tree listing names a file by): SHA-1 of "blob <length>\0" then the bytes. */
export function gitBlobSha1(data: Uint8Array): string {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  return sha1Hex(all);
}
