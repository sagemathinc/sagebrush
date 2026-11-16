// CRC-32 (the zip format's: IEEE 802.3, reflected, init and final xor 0xffffffff), over slices.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The running value after `bytes`; start from crc32Init(), end with crc32Final(). */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
export const crc32Init = (): number => 0xffffffff;
export const crc32Final = (crc: number): number => (crc ^ 0xffffffff) >>> 0;
