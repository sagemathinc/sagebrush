// In place of crc-32 in Push to GitHub's worker (web/build.ts): CRC-32 (IEEE), crc-32's `buf` as isomorphic-git
// uses it (a pack's index; signed, as crc-32 returns it). Checked against node:zlib (test/gitpush-rules.test.ts).
const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}
export function buf(data: Uint8Array, seed = 0): number {
  let c = ~seed;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c;
}
export default { buf };
