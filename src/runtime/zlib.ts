// The zlib and binascii modules: inflate (RFC 1951) for zlib (RFC 1950),
// raw and gzip streams, a deflate that writes stored blocks (valid streams,
// no compression), crc32 and adler32; base64 and hex for binascii.  Enough
// for scipy.io.loadmat's compressed MATLAB arrays and for base64 data.

import { T, PyBytes, raise, objectType, tuple } from "./object";
import { newBuiltinModule } from "./modules";

let ZlibError: any;

function bytesOf(b: any): Uint8Array {
  if (b instanceof PyBytes) return b.a.subarray(0, b.n);
  if (typeof b === "string") return new TextEncoder().encode(b);
  raise(T.TypeError, "a bytes-like object is required");
}

// ------------------------------------------------------------------ inflate

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A canonical Huffman code as a table indexed by up to `bits` reversed
// bits: (symbol << 4) | length.
interface Huff { table: Int32Array; bits: number }

function huffman(lengths: ArrayLike<number>, n: number): Huff {
  let max = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > max) max = lengths[i];
  const count = new Int32Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const next = new Int32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) {
    code = (code + count[b - 1]) << 1;
    next[b] = code;
  }
  const bits = Math.max(max, 1);
  const table = new Int32Array(1 << bits).fill(-1);
  for (let s = 0; s < n; s++) {
    const len = lengths[s];
    if (!len) continue;
    let c = next[len]++;
    // reverse len bits
    let r = 0;
    for (let i = 0; i < len; i++) {
      r = (r << 1) | (c & 1);
      c >>= 1;
    }
    for (let j = r; j < 1 << bits; j += 1 << len) table[j] = (s << 4) | len;
  }
  return { table, bits };
}

let FIXED_L: Huff | null = null, FIXED_D: Huff | null = null;
function fixed(): [Huff, Huff] {
  if (!FIXED_L) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144);
    l.fill(9, 144, 256);
    l.fill(7, 256, 280);
    l.fill(8, 280, 288);
    FIXED_L = huffman(l, 288);
    FIXED_D = huffman(new Uint8Array(30).fill(5), 30);
  }
  return [FIXED_L, FIXED_D!];
}

/** Inflate a raw deflate stream starting at `pos`; returns the data and
 *  the position after the final block. */
function inflateRaw(src: Uint8Array, pos: number): [Uint8Array, number] {
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let op = 0;
  let bitbuf = 0, bitcnt = 0;
  const need = (n: number) => {
    while (bitcnt < n) {
      if (pos >= src.length) raise(ZlibError, "Error -5 while decompressing data: incomplete or truncated stream");
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
  };
  const bits = (n: number) => {
    need(n);
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n;
    bitcnt -= n;
    return v;
  };
  const decode = (h: Huff) => {
    // fill as many bits as available up to h.bits
    while (bitcnt < h.bits && pos < src.length) {
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
    const e = h.table[bitbuf & ((1 << h.bits) - 1)];
    if (e < 0 || (e & 15) > bitcnt) raise(ZlibError, "Error -3 while decompressing data: invalid code");
    bitbuf >>>= e & 15;
    bitcnt -= e & 15;
    return e >> 4;
  };
  const grow = (n: number) => {
    if (op + n <= out.length) return;
    let m = out.length * 2;
    while (m < op + n) m *= 2;
    const o2 = new Uint8Array(m);
    o2.set(out.subarray(0, op));
    out = o2;
  };
  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > src.length) raise(ZlibError, "Error -5 while decompressing data: incomplete or truncated stream");
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      grow(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len;
      pos += len;
      continue;
    }
    let lit: Huff, dist: Huff;
    if (type === 1) [lit, dist] = fixed();
    else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
      const clh = huffman(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = decode(clh);
        if (sym < 16) lens[i++] = sym;
        else {
          let rep = 0, val = 0;
          if (sym === 16) {
            if (i === 0) raise(ZlibError, "Error -3 while decompressing data: invalid bit length repeat");
            val = lens[i - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          while (rep--) lens[i++] = val;
        }
      }
      lit = huffman(lens.subarray(0, hlit), hlit);
      dist = huffman(lens.subarray(hlit), hdist);
    } else raise(ZlibError, "Error -3 while decompressing data: invalid block type");
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        grow(1);
        out[op++] = sym;
      } else if (sym === 256) break;
      else {
        const li = sym - 257;
        const len = LBASE[li] + bits(LEXT[li]);
        const di = decode(dist);
        const d = DBASE[di] + bits(DEXT[di]);
        if (d > op) raise(ZlibError, "Error -3 while decompressing data: invalid distance too far back");
        grow(len);
        for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
      }
    }
  }
  // (decode reads ahead: whole unread bytes in the bit buffer are not the
  // stream's)
  return [out.subarray(0, op), pos - (bitcnt >> 3)];
}

function adler32(a: Uint8Array, start = 1): number {
  let s1 = start & 0xffff, s2 = (start >>> 16) & 0xffff;
  for (let i = 0; i < a.length; ) {
    const n = Math.min(3800, a.length - i);
    for (let j = 0; j < n; j++, i++) {
      s1 += a[i];
      s2 += s1;
    }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

let CRC: Uint32Array | null = null;
function crc32(a: Uint8Array, start = 0): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = (start ^ 0xffffffff) >>> 0;
  for (let i = 0; i < a.length; i++) c = CRC[(c ^ a[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const TRUNCATED = "Error -5 while decompressing data: incomplete or truncated stream";

/** One gzip member at `start`: its data, checked against the trailer's
 *  CRC-32 and length (as zlib checks them: corrupt or truncated files were
 *  accepted, the systematic review's R2-DOC-F6), and the position after it. */
export function gunzipMember(data: Uint8Array, start: number): [Uint8Array, number] {
  if (data[start] !== 0x1f || data[start + 1] !== 0x8b || data[start + 2] !== 8) raise(ZlibError, "Error -3 while decompressing data: incorrect header check");
  if (start + 10 > data.length) raise(ZlibError, TRUNCATED);
  const flg = data[start + 3];
  let p = start + 10;
  if (flg & 4) p += 2 + (data[p] | (data[p + 1] << 8));
  if (flg & 8) while (p < data.length && data[p++]) {}
  if (flg & 16) while (p < data.length && data[p++]) {}
  if (flg & 2) p += 2;
  const [out, end] = inflateRaw(data, p);
  if (end + 8 > data.length) raise(ZlibError, TRUNCATED);
  const le = (i: number) => (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
  if (le(end) !== crc32(out)) raise(ZlibError, "Error -3 while decompressing data: incorrect data check");
  if (le(end + 4) !== out.length >>> 0) raise(ZlibError, "Error -3 while decompressing data: incorrect length check");
  return [out, end + 8];
}

/** zlib (wbits 9..15), raw deflate (wbits < 0) or gzip (wbits >= 16 + 9):
 *  the first stream, as CPython's zlib.decompress. */
export function decompress(data: Uint8Array, wbits = 15): Uint8Array {
  if (wbits < 0) return inflateRaw(data, 0)[0];
  const magic = data[0] === 0x1f && data[1] === 0x8b;
  if ((wbits >= 24 && wbits < 32) || (wbits >= 40 && magic)) return gunzipMember(data, 0)[0];
  if (data.length < 2 || ((data[0] << 8) | data[1]) % 31 !== 0 || (data[0] & 15) !== 8) raise(ZlibError, "Error -3 while decompressing data: incorrect header check");
  const [out, end] = inflateRaw(data, 2);
  // the Adler-32 trailer (a corrupted one was accepted: R2-DOC-F6)
  if (end + 4 > data.length) raise(ZlibError, TRUNCATED);
  const a = ((data[end] << 24) | (data[end + 1] << 16) | (data[end + 2] << 8) | data[end + 3]) >>> 0;
  if (a !== adler32(out)) raise(ZlibError, "Error -3 while decompressing data: incorrect data check");
  return out;
}

/** A valid zlib stream of stored (uncompressed) blocks. */
export function compress(data: Uint8Array): Uint8Array {
  const nblocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + nblocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let op = 2;
  for (let b = 0; b < nblocks; b++) {
    const start = b * 65535, len = Math.min(65535, data.length - start);
    out[op++] = b === nblocks - 1 ? 1 : 0;
    out[op++] = len & 255;
    out[op++] = len >> 8;
    out[op++] = ~len & 255;
    out[op++] = (~len >> 8) & 255;
    out.set(data.subarray(start, start + len), op);
    op += len;
  }
  const a = adler32(data);
  out[op++] = a >>> 24;
  out[op++] = (a >>> 16) & 255;
  out[op++] = (a >>> 8) & 255;
  out[op++] = a & 255;
  return out.subarray(0, op);
}

newBuiltinModule("zlib", (m) => {
  ZlibError = objectType("error", [T.Exception], new Map(), "zlib");
  m.error = ZlibError;
  m.MAX_WBITS = 15;
  m.DEFLATED = 8;
  m.Z_DEFAULT_COMPRESSION = -1;
  m.ZLIB_VERSION = "1.3.1";
  const fn = (name: string, f: any) => {
    f.__name__ = name;
    m[name] = f;
  };
  fn("decompress", (data: any, wbits: any = 15, _bufsize: any = 16384) => new PyBytes(decompress(bytesOf(data), Number(wbits))));
  fn("compress", (data: any, _level: any = -1, _wbits: any = 15) => new PyBytes(compress(bytesOf(data))));
  // (Sagebrush's: one gzip member and the offset after it, for readers of
  // multi-member files, which zlib.decompress stops after the first of)
  fn("_gzip_member", (data: any, start: any = 0) => {
    const [out, end] = gunzipMember(bytesOf(data), Number(start));
    return tuple([new PyBytes(out), end]);
  });
  fn("crc32", (data: any, start: any = 0) => crc32(bytesOf(data), Number(start)));
  fn("adler32", (data: any, start: any = 1) => adler32(bytesOf(data), Number(start)));
});

// ------------------------------------------------------------------ binascii

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64INV = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64INV[B64.charCodeAt(i)] = i;
B64INV["-".charCodeAt(0)] = 62;
B64INV["_".charCodeAt(0)] = 63;

export function b64encode(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(a.length / 3) * 4);
  let o = 0, i = 0;
  for (; i + 2 < a.length; i += 3) {
    const v = (a[i] << 16) | (a[i + 1] << 8) | a[i + 2];
    out[o++] = B64.charCodeAt(v >> 18);
    out[o++] = B64.charCodeAt((v >> 12) & 63);
    out[o++] = B64.charCodeAt((v >> 6) & 63);
    out[o++] = B64.charCodeAt(v & 63);
  }
  if (i < a.length) {
    const v = (a[i] << 16) | ((i + 1 < a.length ? a[i + 1] : 0) << 8);
    out[o++] = B64.charCodeAt(v >> 18);
    out[o++] = B64.charCodeAt((v >> 12) & 63);
    out[o++] = i + 1 < a.length ? B64.charCodeAt((v >> 6) & 63) : 61;
    out[o++] = 61;
  }
  return out;
}

export function b64decode(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.floor((a.length * 3) / 4) + 3);
  let o = 0, acc = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const v = B64INV[a[i]];
    if (v < 0) continue; // padding, newlines
    acc = (acc << 6) | v;
    if (++n === 4) {
      out[o++] = (acc >> 16) & 255;
      out[o++] = (acc >> 8) & 255;
      out[o++] = acc & 255;
      acc = 0;
      n = 0;
    }
  }
  if (n === 2) out[o++] = (acc >> 4) & 255;
  else if (n === 3) {
    out[o++] = (acc >> 10) & 255;
    out[o++] = (acc >> 2) & 255;
  }
  return out.subarray(0, o);
}

newBuiltinModule("binascii", (m) => {
  m.Error = objectType("Error", [T.ValueError], new Map(), "binascii");
  m.Incomplete = objectType("Incomplete", [T.Exception], new Map(), "binascii");
  const fn = (name: string, f: any) => {
    f.__name__ = name;
    m[name] = f;
  };
  fn("b2a_base64", (data: any, newline: any = true) => {
    const e = b64encode(bytesOf(data));
    if (!newline) return new PyBytes(e);
    const out = new Uint8Array(e.length + 1);
    out.set(e);
    out[e.length] = 10;
    return new PyBytes(out);
  });
  m.b2a_base64.$kw = (pos: any[], names: string[], values: any[]) => m.b2a_base64(pos[0], names.includes("newline") ? values[names.indexOf("newline")] : true);
  fn("a2b_base64", (data: any) => new PyBytes(b64decode(bytesOf(data))));
  fn("hexlify", (data: any) => {
    const a = bytesOf(data);
    const out = new Uint8Array(a.length * 2);
    const h = "0123456789abcdef";
    for (let i = 0; i < a.length; i++) {
      out[2 * i] = h.charCodeAt(a[i] >> 4);
      out[2 * i + 1] = h.charCodeAt(a[i] & 15);
    }
    return new PyBytes(out);
  });
  m.b2a_hex = m.hexlify;
  fn("unhexlify", (data: any) => {
    const a = bytesOf(data);
    if (a.length % 2) raise(m.Error, "Odd-length string");
    const out = new Uint8Array(a.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(String.fromCharCode(a[2 * i], a[2 * i + 1]), 16);
    return new PyBytes(out);
  });
  m.a2b_hex = m.unhexlify;
  fn("crc32", (data: any, start: any = 0) => crc32(bytesOf(data), Number(start)));
});
