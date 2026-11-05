// The zlib and binascii modules: inflate (RFC 1951) for zlib (RFC 1950),
// raw and gzip streams, a deflate that writes stored blocks (valid streams,
// no compression), crc32 and adler32; base64 and hex for binascii.  Enough
// for scipy.io.loadmat's compressed MATLAB arrays and for base64 data.

import { T, PyBytes, raise, objectType, tuple, typeName, withExport } from "./object";
import { newBuiltinModule } from "./modules";
import { ARRAY_LIMITS } from "./numpy";
import * as Ty from "./types";
import { sig, builtin } from "./object";
import * as O from "./ops";

let ZlibError: any;

function bytesOf(b: any): Uint8Array {
  if (b instanceof PyBytes) return b.a.subarray(0, b.n);
  if (typeof b === "string") return new TextEncoder().encode(b);
  raise(T.TypeError, `a bytes-like object is required, not '${typeName(b)}'`);
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

// The inflater, resumable (design note-zlib-decompressobj r2): a state
// machine over input given in pieces and output taken in pieces.  It decodes
// in units, a block header, a dynamic block's whole code table, one literal
// or one match; before each it saves its place, and if the input runs out
// inside a unit it goes back there and waits for more, keeping that input.
// Output goes to `buf` after the last 32 KiB it made (all a back-reference
// can reach), and a call never makes more than the room it is given: a match
// or stored block that doesn't fit is kept, and finished by the next call.
// zlib.decompress, gzip and _decompress_limited use it with all their input
// at once; zlib.decompressobj with the input and room each call gives.
const WSIZE = 32768;
const NEED = { need: true };
const PH_HEADER = 0, PH_STORED = 1, PH_CODES = 2, PH_DONE = 3;

export class Inflater {
  inp: Uint8Array = new Uint8Array(0);
  pos = 0;
  bitbuf = 0;
  bitcnt = 0;
  phase = PH_HEADER;
  final = 0;
  stored = 0;
  lit: Huff | null = null;
  dist: Huff | null = null;
  // a match the room ran out in: its bytes left and its distance
  mlen = 0;
  mdist = 0;
  // the window and the output: buf[0, bp), its last WSIZE bytes the window
  buf: Uint8Array = new Uint8Array(1024);
  bp = 0;
  // every byte ever made (a distance can't reach before the first)
  total = 0;

  get done(): boolean {
    return this.phase === PH_DONE;
  }

  /** Append input (what wasn't read of the earlier input stays first);
   *  `own`: the input is the inflater's to keep as it is (no copy). */
  feed(data: Uint8Array, own = false): void {
    if (!data.length) return;
    if (own && this.pos >= this.inp.length && this.bitcnt < 8) {
      this.inp = data;
      this.pos = 0;
      return;
    }
    // (the whole bytes in the bit buffer were read ahead, from inp: kept)
    const keep = this.pos - (this.bitcnt >> 3);
    const rest = this.inp.subarray(keep);
    const n = new Uint8Array(rest.length + data.length);
    n.set(rest);
    n.set(data, rest.length);
    this.inp = n;
    this.pos -= keep;
  }

  /** Between calls (its output copied out): keep only the window, and give
   *  back a buffer grown for a large call, so a paused stream holds at most
   *  the window and its unread input (astra's ZLIB687-WINDOW-1). */
  compact(): void {
    const keep = Math.min(this.bp, WSIZE);
    if (this.buf.length <= Math.max(2 * WSIZE, 1024) && this.bp <= WSIZE) return;
    const b = new Uint8Array(Math.max(keep, 1024));
    b.set(this.buf.subarray(this.bp - keep, this.bp));
    this.buf = b;
    this.bp = keep;
  }

  /** The whole input bytes not yet read (the bit buffer's partial byte stays
   *  in it), removed from the input: CPython's unconsumed_tail. */
  takeUnread(): Uint8Array {
    const whole = this.bitcnt >> 3;
    const from = this.pos - whole;
    this.bitbuf &= (1 << (this.bitcnt & 7)) - 1;
    this.bitcnt &= 7;
    const t = this.inp.slice(from);
    this.inp = new Uint8Array(0);
    this.pos = 0;
    return t;
  }

  /** The input after the stream's end (its trailer comes from here). */
  rest(): Uint8Array {
    return this.inp.subarray(this.pos - (this.bitcnt >> 3));
  }

  /** Make at most `room` bytes of output; returns them (fewer when the
   *  input runs out or the stream ends).  `over`: the error past `cap`, a
   *  hard bound on one call's room given with room = Infinity. */
  run(room: number, cap = Infinity, over?: () => never): Uint8Array {
    // (the window: only its last WSIZE bytes are kept before this call's output)
    if (this.bp > WSIZE) {
      this.buf.copyWithin(0, this.bp - WSIZE, this.bp);
      this.bp = WSIZE;
    }
    const start = this.bp;
    const limit = Math.min(room, cap);
    const left = () => limit - (this.bp - start);
    const ensure = (n: number) => {
      if (this.bp + n <= this.buf.length) return;
      let m = this.buf.length * 2;
      while (m < this.bp + n) m *= 2;
      // (never a buffer past what this call may make: the window and its room)
      if (m > start + limit) m = Math.max(this.bp + n, start + limit);
      const b = new Uint8Array(m);
      b.set(this.buf.subarray(0, this.bp));
      this.buf = b;
    };
    const full = () => {
      if (left() > 0) return false;
      // (room = Infinity with a cap: past the cap is an error, never more output)
      if (room > cap && over) over();
      return true;
    };
    const src = () => this.inp;
    const need = (n: number) => {
      while (this.bitcnt < n) {
        if (this.pos >= this.inp.length) throw NEED;
        this.bitbuf |= this.inp[this.pos++] << this.bitcnt;
        this.bitcnt += 8;
      }
    };
    const bits = (n: number) => {
      need(n);
      const v = this.bitbuf & ((1 << n) - 1);
      this.bitbuf >>>= n;
      this.bitcnt -= n;
      return v;
    };
    const decode = (h: Huff) => {
      const inp = src();
      while (this.bitcnt < h.bits && this.pos < inp.length) {
        this.bitbuf |= inp[this.pos++] << this.bitcnt;
        this.bitcnt += 8;
      }
      const e = h.table[this.bitbuf & ((1 << h.bits) - 1)];
      if (e < 0 || (e & 15) > this.bitcnt) {
        // (too few bits for a code yet: wait for more input, else it is invalid)
        if (this.bitcnt < h.bits) throw NEED;
        raise(ZlibError, "Error -3 while decompressing data: invalid code");
      }
      this.bitbuf >>>= e & 15;
      this.bitcnt -= e & 15;
      return e >> 4;
    };
    for (;;) {
      if (this.mlen > 0) {
        const n = Math.min(this.mlen, left());
        if (n > 0) {
          ensure(n);
          const b = this.buf, d = this.mdist;
          for (let k = 0; k < n; k++, this.bp++) b[this.bp] = b[this.bp - d];
          this.mlen -= n;
          this.total += n;
        }
        if (this.mlen > 0 && full()) break;
      }
      if (this.phase === PH_DONE) break;
      if (this.phase === PH_STORED) {
        if (this.stored > 0) {
          const inp = this.inp;
          const n = Math.min(this.stored, left(), inp.length - this.pos);
          if (n > 0) {
            ensure(n);
            this.buf.set(inp.subarray(this.pos, this.pos + n), this.bp);
            this.bp += n;
            this.pos += n;
            this.stored -= n;
            this.total += n;
          }
          if (this.stored > 0) {
            if (full()) break;
            break; // (waiting for input)
          }
        }
        this.phase = this.final ? PH_DONE : PH_HEADER;
        continue;
      }
      // a unit: saved first, so input that runs out inside it is waited for
      const sp = this.pos, sb = this.bitbuf, sc = this.bitcnt;
      try {
        if (this.phase === PH_HEADER) {
          const fin = bits(1);
          const type = bits(2);
          if (type === 0) {
            // (to a byte boundary; whole bytes read ahead are the block's)
            this.bitbuf >>>= this.bitcnt & 7;
            this.bitcnt -= this.bitcnt & 7;
            const len = bits(16), nlen = bits(16);
            if ((len ^ 0xffff) !== nlen) raise(ZlibError, "Error -3 while decompressing data: invalid stored block lengths");
            // (the bit buffer is empty now: 32 bits read from a byte boundary)
            this.final = fin;
            this.stored = len;
            this.phase = PH_STORED;
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
                if (i + rep > hlit + hdist) raise(ZlibError, "Error -3 while decompressing data: invalid bit length repeat");
                while (rep--) lens[i++] = val;
              }
            }
            lit = huffman(lens.subarray(0, hlit), hlit);
            dist = huffman(lens.subarray(hlit), hdist);
          } else raise(ZlibError, "Error -3 while decompressing data: invalid block type");
          this.final = fin;
          this.lit = lit;
          this.dist = dist;
          this.phase = PH_CODES;
          continue;
        }
        // PH_CODES: literals and matches until the room is full or the block ends
        const lit = this.lit!, dist = this.dist!;
        // (the fast path, as zlib's inflate_fast: with 8 bytes of input and 258 of room left no unit can run out
        // of either, so it decodes in locals with no saves; the careful loop below does the last units)
        if (this.mlen === 0) {
          const inp = this.inp, end = inp.length - 8;
          const lt = lit.table, lmask = (1 << lit.bits) - 1, lbits = lit.bits;
          const dt = dist.table, dmask = (1 << dist.bits) - 1, dbits = dist.bits;
          const opEnd = limit === Infinity ? Infinity : start + limit - 258;
          let p = this.pos, bb = this.bitbuf, bc = this.bitcnt, op = this.bp, buf = this.buf;
          const op0 = op, total0 = this.total;
          while (p < end && op <= opEnd) {
            if (op + 258 > buf.length) {
              this.bp = op;
              ensure(258);
              buf = this.buf;
            }
            while (bc < lbits) {
              bb |= inp[p++] << bc;
              bc += 8;
            }
            let e = lt[bb & lmask];
            if (e < 0) raise(ZlibError, "Error -3 while decompressing data: invalid code");
            bb >>>= e & 15;
            bc -= e & 15;
            const sym = e >> 4;
            if (sym < 256) {
              buf[op++] = sym;
              continue;
            }
            if (sym === 256) {
              this.phase = this.final ? PH_DONE : PH_HEADER;
              break;
            }
            const li = sym - 257;
            if (li >= 29) raise(ZlibError, "Error -3 while decompressing data: invalid literal/length code");
            let ext = LEXT[li];
            while (bc < ext) {
              bb |= inp[p++] << bc;
              bc += 8;
            }
            const len = LBASE[li] + (bb & ((1 << ext) - 1));
            bb >>>= ext;
            bc -= ext;
            while (bc < dbits) {
              bb |= inp[p++] << bc;
              bc += 8;
            }
            e = dt[bb & dmask];
            if (e < 0) raise(ZlibError, "Error -3 while decompressing data: invalid code");
            bb >>>= e & 15;
            bc -= e & 15;
            const di = e >> 4;
            if (di >= 30) raise(ZlibError, "Error -3 while decompressing data: invalid distance code");
            ext = DEXT[di];
            while (bc < ext) {
              bb |= inp[p++] << bc;
              bc += 8;
            }
            const d = DBASE[di] + (bb & ((1 << ext) - 1));
            bb >>>= ext;
            bc -= ext;
            if (d > total0 + (op - op0)) raise(ZlibError, "Error -3 while decompressing data: invalid distance too far back");
            for (let k = 0; k < len; k++, op++) buf[op] = buf[op - d];
          }
          this.pos = p;
          this.bitbuf = bb;
          this.bitcnt = bc;
          this.bp = op;
          this.total += op - op0;
          if (this.phase !== PH_CODES) continue;
        }
        let stop = false;
        for (;;) {
          const s0 = this.pos, b0 = this.bitbuf, c0 = this.bitcnt;
          let sym: number, len = 0, d = 0;
          try {
            sym = decode(lit);
            if (sym > 256) {
              const li = sym - 257;
              if (li >= 29) raise(ZlibError, "Error -3 while decompressing data: invalid literal/length code");
              len = LBASE[li] + bits(LEXT[li]);
              const di = decode(dist);
              if (di >= 30) raise(ZlibError, "Error -3 while decompressing data: invalid distance code");
              d = DBASE[di] + bits(DEXT[di]);
            }
          } catch (e) {
            if (e === NEED) {
              this.pos = s0;
              this.bitbuf = b0;
              this.bitcnt = c0;
            }
            throw e;
          }
          if (sym !== 256 && left() <= 0) {
            // (a byte to make and no room: the symbol is decoded again next call)
            this.pos = s0;
            this.bitbuf = b0;
            this.bitcnt = c0;
            stop = true;
            break;
          }
          if (sym < 256) {
            ensure(1);
            this.buf[this.bp++] = sym;
            this.total++;
          } else if (sym === 256) {
            this.phase = this.final ? PH_DONE : PH_HEADER;
            break;
          } else {
            if (d > this.total) raise(ZlibError, "Error -3 while decompressing data: invalid distance too far back");
            this.mlen = len;
            this.mdist = d;
            const n = Math.min(len, left());
            ensure(n);
            const b = this.buf;
            for (let k = 0; k < n; k++, this.bp++) b[this.bp] = b[this.bp - d];
            this.mlen -= n;
            this.total += n;
            if (this.mlen > 0) {
              stop = true;
              break;
            }
          }
        }
        if (stop && full()) break;
      } catch (e) {
        if (e !== NEED) throw e;
        if (this.phase !== PH_CODES) {
          this.pos = sp;
          this.bitbuf = sb;
          this.bitcnt = sc;
        }
        break;
      }
    }
    return this.buf.subarray(start, this.bp);
  }
}

/** Inflate a raw deflate stream starting at `pos`, all its input given;
 *  returns the data and the position after the final block (the one-shot
 *  users: zlib.decompress, gzip, _decompress_limited). */
function inflateRaw(src: Uint8Array, pos: number, limit = Infinity): [Uint8Array, number] {
  const f = new Inflater();
  f.feed(src.subarray(pos), true);
  // (zlib.decompress and gzip with no limit of their own: the array limit, as decompressobj's calls (astra's ZLIB687-CAP-1))
  const cap = Math.min(limit, ARRAY_LIMITS.bytes);
  const out = f.run(Infinity, cap, () =>
    raise(ZlibError, cap < limit ? `Error -5 while decompressing data: output exceeds Sagebrush's limit of ${cap} bytes` : `Error -5 while decompressing data: more than ${limit} bytes`),
  );
  if (!f.done) raise(ZlibError, "Error -5 while decompressing data: incomplete or truncated stream");
  return [out, pos + (f.pos - (f.bitcnt >> 3))];
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
  if (flg & 0xe0) raise(ZlibError, "Error -3 while decompressing data: unknown header flags set");
  let p = start + 10;
  if (flg & 4) p += 2 + (data[p] | (data[p + 1] << 8));
  if (flg & 8) while (p < data.length && data[p++]) {}
  if (flg & 16) while (p < data.length && data[p++]) {}
  if (flg & 2) {
    if (p + 2 > data.length) raise(ZlibError, TRUNCATED);
    if ((crc32(data.subarray(start, p)) & 0xffff) !== (data[p] | (data[p + 1] << 8))) raise(ZlibError, "Error -3 while decompressing data: header crc mismatch");
    p += 2;
  }
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

/** A zlib stream's data, at most `limit` bytes of it (else an error), and the
 *  position after the stream's trailer: for readers of untrusted files. */
export function decompressLimited(data: Uint8Array, limit: number): [Uint8Array, number] {
  if (data.length < 2 || ((data[0] << 8) | data[1]) % 31 !== 0 || (data[0] & 15) !== 8) raise(ZlibError, "Error -3 while decompressing data: incorrect header check");
  const [out, end] = inflateRaw(data, 2, limit);
  if (end + 4 > data.length) raise(ZlibError, TRUNCATED);
  const a = ((data[end] << 24) | (data[end + 1] << 16) | (data[end + 2] << 8) | data[end + 3]) >>> 0;
  if (a !== adler32(out)) raise(ZlibError, "Error -3 while decompressing data: incorrect data check");
  return [out, end + 4];
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

// zlib.decompressobj's objects (design note-zlib-decompressobj r3.1): a
// stream's header, its deflate data through the resumable Inflater, and its
// trailer, each read as its bytes arrive.  decompress(data, max_length) never
// makes more than max_length bytes: it stops, keeps its place, and gives the
// input it didn't read back as unconsumed_tail (whose bytes it then no longer
// holds), as CPython does; with max_length 0 a call's output is bounded by
// the array limit, past which it is zlib.error.
class PyDecompress {
  inf = new Inflater();
  // "zlib", "raw", "gzip", or "auto" (zlib or gzip, by the header)
  kind: string;
  phase = 0; // 0 the header, 1 the deflate data, 2 the trailer, 3 the end
  pre: Uint8Array = new Uint8Array(0); // the header's or the trailer's bytes so far
  check = 0;
  size = 0;
  eof = false;
  unused: Uint8Array = new Uint8Array(0);
  tail: Uint8Array = new Uint8Array(0);
  constructor(wbits: number) {
    if (wbits >= -15 && wbits <= -8) this.kind = "raw";
    else if ((wbits >= 8 && wbits <= 15) || wbits === 0) this.kind = "zlib";
    else if (wbits >= 24 && wbits <= 31) this.kind = "gzip";
    else if (wbits >= 40 && wbits <= 47) this.kind = "auto";
    else raise(T.ValueError, "Invalid initialization option");
    if (this.kind === "raw") this.phase = 1;
    this.check = this.kind === "zlib" ? 1 : 0;
  }
}

const cat = (a: Uint8Array, b: Uint8Array) => {
  if (!a.length) return b;
  const n = new Uint8Array(a.length + b.length);
  n.set(a);
  n.set(b, a.length);
  return n;
};

/** The header's length if `h` holds all of it (0: not yet), checking it. */
function headerLength(d: PyDecompress, h: Uint8Array): number {
  if (d.kind === "auto") {
    if (h.length < 2) return 0;
    d.kind = h[0] === 0x1f && h[1] === 0x8b ? "gzip" : "zlib";
    d.check = d.kind === "zlib" ? 1 : 0;
  }
  if (d.kind === "zlib") {
    if (h.length < 2) return 0;
    if (((h[0] << 8) | h[1]) % 31 !== 0 || (h[0] & 15) !== 8) raise(ZlibError, "Error -3 while decompressing data: incorrect header check");
    // (a preset dictionary, which needs zdict: not here)
    if (h[1] & 0x20) raise(ZlibError, "Error 2 while decompressing data");
    return 2;
  }
  if (h.length < 10) return 0;
  if (h[0] !== 0x1f || h[1] !== 0x8b || h[2] !== 8) raise(ZlibError, "Error -3 while decompressing data: incorrect header check");
  const flg = h[3];
  // (as zlib: reserved flags refused, and the header's CRC-16 checked when FHCRC says it is there; daybreak3's ZLIB687-GZIPHDR-1)
  if (flg & 0xe0) raise(ZlibError, "Error -3 while decompressing data: unknown header flags set");
  let p = 10;
  if (flg & 4) {
    if (h.length < p + 2) return 0;
    p += 2 + (h[p] | (h[p + 1] << 8));
  }
  for (const f of [8, 16]) {
    if (!(flg & f)) continue;
    while (p < h.length && h[p]) p++;
    if (p >= h.length) return 0;
    p++;
  }
  if (flg & 2) {
    if (h.length < p + 2) return 0;
    if ((crc32(h.subarray(0, p)) & 0xffff) !== (h[p] | (h[p + 1] << 8))) raise(ZlibError, "Error -3 while decompressing data: header crc mismatch");
    p += 2;
  }
  return h.length >= p ? p : 0;
}

/** The output of one call: inflate up to `room` (Infinity: the array limit),
 *  then the trailer if the stream ended; returns the bytes made. */
function step(d: PyDecompress, room: number): Uint8Array {
  let out: Uint8Array = new Uint8Array(0);
  if (d.phase === 1) {
    const cap = ARRAY_LIMITS.bytes;
    const o = d.inf.run(room, cap, () => raise(ZlibError, `Error -5 while decompressing data: output exceeds Sagebrush's limit of ${cap} bytes`));
    out = o.slice();
    d.inf.compact();
    if (d.kind === "zlib") d.check = adler32(out, d.check);
    else if (d.kind === "gzip") {
      d.check = crc32(out, d.check);
      d.size = (d.size + out.length) >>> 0;
    }
    if (d.inf.done) {
      d.phase = 2;
      d.pre = d.inf.rest().slice();
      d.inf = new Inflater();
    }
  }
  if (d.phase === 2) {
    const need = d.kind === "raw" ? 0 : d.kind === "zlib" ? 4 : 8;
    if (d.pre.length >= need) {
      const t = d.pre;
      if (d.kind === "zlib") {
        const a = ((t[0] << 24) | (t[1] << 16) | (t[2] << 8) | t[3]) >>> 0;
        if (a !== d.check) raise(ZlibError, "Error -3 while decompressing data: incorrect data check");
      } else if (d.kind === "gzip") {
        const le = (i: number) => (t[i] | (t[i + 1] << 8) | (t[i + 2] << 16) | (t[i + 3] << 24)) >>> 0;
        if (le(0) !== d.check) raise(ZlibError, "Error -3 while decompressing data: incorrect data check");
        if (le(4) !== d.size) raise(ZlibError, "Error -3 while decompressing data: incorrect length check");
      }
      d.unused = cat(d.unused, t.slice(need));
      d.pre = new Uint8Array(0);
      d.phase = 3;
      d.eof = true;
    }
  }
  return out;
}

function decompressCall(d: PyDecompress, data: any, maxLength: any): PyBytes {
  const input = bytesOf(data);
  const ml = maxLength === undefined ? 0 : Number(O.index(maxLength));
  if (ml < 0) raise(T.ValueError, "max_length must be non-negative");
  d.tail = new Uint8Array(0);
  if (d.phase === 3) {
    d.unused = cat(d.unused, input.slice());
    return new PyBytes(new Uint8Array(0));
  }
  if (d.phase === 0) {
    d.pre = cat(d.pre, input.slice());
    const n = headerLength(d, d.pre);
    if (!n) return new PyBytes(new Uint8Array(0));
    d.inf.feed(d.pre.subarray(n));
    d.pre = new Uint8Array(0);
    d.phase = 1;
  } else if (d.phase === 1) d.inf.feed(input);
  else d.pre = cat(d.pre, input.slice());
  const out = step(d, ml || Infinity);
  // (stopped by max_length: the input it didn't read is the caller's again)
  if (ml && out.length === ml && d.phase === 1) d.tail = d.inf.takeUnread();
  return new PyBytes(out);
}

function flushCall(d: PyDecompress): PyBytes {
  if (d.phase === 3) return new PyBytes(new Uint8Array(0));
  // (CPython's flush reads the unconsumed tail too, and has no output bound: length is only a buffer size)
  const t = d.tail;
  d.tail = new Uint8Array(0);
  if (d.phase === 0) {
    d.pre = cat(d.pre, t);
    const n = headerLength(d, d.pre);
    if (!n) return new PyBytes(new Uint8Array(0));
    d.inf.feed(d.pre.subarray(n));
    d.pre = new Uint8Array(0);
    d.phase = 1;
  } else if (d.phase === 1) d.inf.feed(t);
  else d.pre = cat(d.pre, t);
  return new PyBytes(step(d, Infinity));
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
  // (Sagebrush's: decompress with a bound on the output, and the offset
  // after the stream, so that a reader can refuse what follows it)
  fn("_decompress_limited", (data: any, limit: any) => {
    const [out, end] = decompressLimited(bytesOf(data), Number(limit));
    return tuple([new PyBytes(out), end]);
  });
  fn("crc32", (data: any, start: any = 0) => crc32(bytesOf(data), Number(start)));
  fn("adler32", (data: any, start: any = 1) => adler32(bytesOf(data), Number(start)));
  // zlib.decompressobj (CPython's; zdict and copy() are not here)
  const D = Ty.builtinTypeFor("Decompress", PyDecompress, "zlib", () => raise(T.TypeError, "cannot create 'zlib.Decompress' instances"));
  Ty.method(D, "decompress", (d: PyDecompress, data: any, maxLength: any = undefined) => decompressCall(d, data, maxLength), sig(["self", "data", "max_length"], { posonly: 2 }));
  Ty.method(D, "flush", (d: PyDecompress, length: any = undefined) => {
    if (length !== undefined && Number(O.index(length)) <= 0) raise(T.ValueError, "length must be greater than zero");
    return flushCall(d);
  });
  Ty.method(D, "copy", () => raise(T.NotImplementedError, "zlib: Decompress.copy() is not in Sagebrush's zlib"));
  Ty.getset(D, "unused_data", (d: PyDecompress) => new PyBytes(d.unused.slice()));
  Ty.getset(D, "unconsumed_tail", (d: PyDecompress) => new PyBytes(d.tail.slice()));
  Ty.getset(D, "eof", (d: PyDecompress) => d.eof);
  m.decompressobj = builtin(
    (wbits: any = 15, zdict: any = undefined) => {
      if (zdict !== undefined && bytesOf(zdict).length) raise(T.NotImplementedError, "zlib: decompressobj(zdict=) is not in Sagebrush's zlib");
      return new PyDecompress(Number(O.index(wbits === undefined ? 15 : wbits)));
    },
    "decompressobj",
    sig(["wbits", "zdict"]),
  );
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
  // (newline is keyword-only, as CPython's: b2a_base64(data, False) is a TypeError)
  const b2a = (data: any, newline: any = true) => {
    // (as CPython: the buffer first, then newline's truth, which may run
    // Python code, then the encoding, of the buffer as it is then, CORR-644-1)
    // (a bytearray's buffer is exported meanwhile, as CPython's: newline's
    // __bool__ may write it but not re-size it, and the encoding reads the
    // storage as it is after, CORR-59A-1, -2)
    bytesOf(data);
    const nl = withExport(data, () => O.truth(newline)); // (Python's truth: newline=[] is false, and __bool__'s errors propagate)
    const e = b64encode(bytesOf(data));
    if (!nl) return new PyBytes(e);
    const out = new Uint8Array(e.length + 1);
    out.set(e);
    out[e.length] = 10;
    return new PyBytes(out);
  };
  fn("b2a_base64", (data: any) => b2a(data));
  m.b2a_base64.$kw = (pos: any[], names: string[], values: any[]) => {
    if (pos.length !== 1) raise(T.TypeError, `b2a_base64() takes exactly one positional argument (${pos.length} given)`);
    for (const n of names) if (n !== "newline") raise(T.TypeError, `b2a_base64() got an unexpected keyword argument '${n}'`);
    return b2a(pos[0], names.includes("newline") ? values[names.indexOf("newline")] : true);
  };
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
