// A bounded gzip (RFC 1952) and DEFLATE (RFC 1951) decoder for arXiv sources (design/arxiv-proxy.md §4, LIMITS L1).
// DecompressionStream isn't used: it promises no bound on an output chunk.
//
// The bounds:
//   - input: push() takes any chunk, and hands it to the decoder in slices of at most 1 KiB, each copied into a fixed
//     2 KiB input window (the decoder needs at most about 570 bytes for one step, a dynamic block's header, so the
//     window always has room for the unconsumed tail plus one slice);
//   - output: a fixed 1 MiB slab. When it's full the decoder stops mid-block, hands the slab to `sink` (which must
//     use or copy what it needs before returning), and goes on; the 32 KiB window for back-references is fixed too;
//   - the ratio and total caps are checked before each output byte is put in the slab: the output so far may be at
//     most `ratio` times the compressed bytes the decoder has consumed, and the decoder stops exactly there. The decoder pulls input bits only when it
//     needs them, and a step that runs out of input is rolled back whole, so `consumed` at any output byte depends on
//     the stream alone, never on how it was chunked: the same bomb is refused at the same byte however it arrives.
//   - completion: end() requires the member's trailer (CRC-32 and length) to match; any byte after the first member,
//     a second member included, refuses.
// Every refusal is a TarError (errors.ts).

import { crc32Final, crc32Init, crc32Update } from "../zip/crc32.ts";
import { TarError } from "./errors.ts";

/** The output slab, the back-reference window, the input window, and the most input handed over at once. */
export const SLAB = 1 << 20, WINDOW = 1 << 15, INPUT_WINDOW = 2048, INPUT_SLICE = 1024;

export interface InflateLimits {
  /** the most output bytes in all */
  total: number;
  /** the most output bytes per compressed byte consumed */
  ratio: number;
}

// (thrown inside a step that needs more input than the window holds; the step is rolled back)
const MORE = new Error("more input");

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code (as in zlib's puff): how many codes of each length, and the symbols in code order. */
type Huff = { count: Uint16Array; symbol: Uint16Array };
const huff = (n: number): Huff => ({ count: new Uint16Array(16), symbol: new Uint16Array(n) });

/** Fills `h` from code lengths; 0 for a complete code, > 0 incomplete, < 0 over-subscribed. */
function construct(h: Huff, length: ArrayLike<number>, n: number): number {
  h.count.fill(0);
  for (let s = 0; s < n; s++) h.count[length[s]]++;
  if (h.count[0] === n) return 0;
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= h.count[len];
    if (left < 0) return left;
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + h.count[len];
  for (let s = 0; s < n; s++) if (length[s] !== 0) h.symbol[offs[length[s]]++] = s;
  return left;
}

const FIXED_L = huff(288), FIXED_D = huff(30);
{
  const l = new Uint8Array(288);
  for (let s = 0; s < 288; s++) l[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  construct(FIXED_L, l, 288);
  construct(FIXED_D, new Uint8Array(30).fill(5), 30);
}

type Phase = "head" | "block" | "stored" | "codes" | "trailer" | "done";

export class GzipInflater {
  private inp = new Uint8Array(INPUT_WINDOW);
  private len = 0;
  private pos = 0;
  /** input bytes dropped from the front of the window */
  private gone = 0;
  private bitbuf = 0;
  private bitcnt = 0;
  private win = new Uint8Array(WINDOW);
  private wpos = 0;
  private slab = new Uint8Array(SLAB);
  private fill = 0;
  private crc = crc32Init();
  /** output bytes so far */
  out = 0;
  private phase: Phase = "head";
  private last = false;
  private stored = 0;
  private lcode: Huff = FIXED_L;
  private dcode: Huff = FIXED_D;
  private dynL = huff(288);
  private dynD = huff(30);
  private clen = huff(19);
  private lengths = new Uint8Array(286 + 30);
  // (the gzip header: what is still to be read)
  private flags = -1;
  private hcrc = crc32Init();
  private xlen = -1;

  constructor(private sink: (out: Uint8Array) => void, private limits: InflateLimits) {
    // (a stored byte consumes one input byte for one output byte, so with a ratio of at least 1 it can't pass the cap:
    //  the check then depends on the stream alone, never on where input slices end)
    if (!(Number.isFinite(limits.ratio) && limits.ratio >= 1)) throw new RangeError("the ratio cap must be a number of at least 1");
    if (!(Number.isSafeInteger(limits.total) && limits.total >= 0)) throw new RangeError("the total cap must be a whole number of bytes");
  }

  /** Compressed bytes the decoder has consumed (pulled into its bit buffer), the ratio's denominator. */
  get consumed(): number {
    return this.gone + this.pos;
  }

  /** Whether the member and its trailer have been read. */
  get done(): boolean {
    return this.phase === "done";
  }

  /** Decodes `chunk`, handing out full slabs as they fill. */
  push(chunk: Uint8Array): void {
    for (let off = 0; off < chunk.length; off += INPUT_SLICE) {
      const slice = chunk.subarray(off, Math.min(chunk.length, off + INPUT_SLICE));
      if (this.phase === "done") throw new TarError("trailing", "data after the end of the gzip stream");
      // (the unconsumed tail moved to the front: at most one step's input, so a slice always fits after it)
      if (this.pos > 0) {
        this.inp.copyWithin(0, this.pos, this.len);
        this.len -= this.pos;
        this.gone += this.pos;
        this.pos = 0;
      }
      if (this.len + slice.length > INPUT_WINDOW) throw new TarError("deflate", "the input window overflowed");
      this.inp.set(slice, this.len);
      this.len += slice.length;
      this.run(false);
    }
  }

  /** The input has ended: the stream must be complete, with its trailer; the last slab is handed out. */
  end(): void {
    this.run(true);
    if (this.phase !== "done") throw new TarError("truncated", "the gzip stream ended early");
  }

  private run(final: boolean): void {
    for (;;) {
      if (this.phase === "done") {
        if (this.pos < this.len) throw new TarError("trailing", "data after the end of the gzip stream");
        return;
      }
      const pos = this.pos, bitbuf = this.bitbuf, bitcnt = this.bitcnt;
      try {
        this.step();
      } catch (e) {
        if (e !== MORE) throw e;
        this.pos = pos;
        this.bitbuf = bitbuf;
        this.bitcnt = bitcnt;
        if (final) throw new TarError("truncated", "the gzip stream ended early");
        return;
      }
    }
  }

  private bits(n: number): number {
    let buf = this.bitbuf, cnt = this.bitcnt;
    while (cnt < n) {
      if (this.pos >= this.len) throw MORE;
      buf |= this.inp[this.pos++] << cnt;
      cnt += 8;
    }
    this.bitbuf = buf >>> n;
    this.bitcnt = cnt - n;
    return buf & ((1 << n) - 1);
  }

  private byte(): number {
    return this.bits(8);
  }

  private decode(h: Huff): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new TarError("deflate", "an invalid Huffman code");
  }

  /** How many of the next `n` output bytes the caps allow now: all of them, or those before the first byte that would
   * pass a cap (never negative: the output never passes a cap, and `consumed` only grows). */
  private room(n: number): number {
    return Math.min(n, this.limits.total - this.out, Math.floor(this.limits.ratio * this.consumed) - this.out);
  }

  /** The next output byte would pass a cap: refused there. */
  private refuse(): never {
    const { total, ratio } = this.limits;
    if (this.out >= total) throw new TarError("cap-total", `the source expands past ${total} bytes (at byte ${total + 1})`);
    throw new TarError("cap-ratio", `the source expands more than ${ratio} times (at byte ${this.out + 1}, after ${this.consumed} compressed bytes)`);
  }

  private put(b: number): void {
    this.win[this.wpos] = b;
    this.wpos = (this.wpos + 1) & (WINDOW - 1);
    this.slab[this.fill++] = b;
    this.out++;
    if (this.fill === SLAB) this.drain();
  }

  private drain(): void {
    if (!this.fill) return;
    const view = this.slab.subarray(0, this.fill);
    this.crc = crc32Update(this.crc, view);
    this.fill = 0;
    this.sink(view);
  }

  private step(): void {
    switch (this.phase) {
      case "head": return this.head();
      case "block": return this.block();
      case "stored": return this.copyStored();
      case "codes": return this.symbol();
      case "trailer": return this.trailer();
    }
  }

  // The gzip header, a few bytes per step (a name or comment can be long: it is skipped, never kept).
  private head(): void {
    // (the header's bytes go into its CRC only once the step has them all: a step can be rolled back)
    const got: number[] = [];
    const hb = () => {
      const b = this.byte();
      got.push(b);
      return b;
    };
    const keep = () => (this.hcrc = crc32Update(this.hcrc, Uint8Array.from(got)));
    if (this.flags < 0) {
      const id1 = hb(), id2 = hb(), cm = hb(), flg = hb();
      for (let i = 0; i < 6; i++) hb();
      if (id1 !== 0x1f || id2 !== 0x8b) throw new TarError("gzip", "not a gzip stream");
      if (cm !== 8) throw new TarError("gzip", "a gzip compression method other than DEFLATE");
      if (flg & 0xe0) throw new TarError("gzip", "reserved gzip flags set");
      keep();
      this.flags = flg;
      return;
    }
    if (this.flags & 4) {
      if (this.xlen < 0) {
        const x = hb() | (hb() << 8);
        keep();
        this.xlen = x;
        return;
      }
      if (this.xlen > 0) {
        hb();
        keep();
        this.xlen--;
        return;
      }
      this.flags &= ~4;
      return;
    }
    for (const f of [8, 16]) {
      if (this.flags & f) {
        const b = hb();
        keep();
        if (b === 0) this.flags &= ~f;
        return;
      }
    }
    if (this.flags & 2) {
      const want = crc32Final(this.hcrc) & 0xffff;
      const got16 = this.byte() | (this.byte() << 8);
      if (got16 !== want) throw new TarError("gzip", "the gzip header's CRC doesn't match");
      this.flags &= ~2;
      return;
    }
    this.phase = "block";
  }

  private block(): void {
    const last = this.bits(1) === 1, type = this.bits(2);
    if (type === 0) {
      this.bitbuf = 0;
      this.bitcnt = 0;
      const len = this.byte() | (this.byte() << 8), nlen = this.byte() | (this.byte() << 8);
      if (len !== (~nlen & 0xffff)) throw new TarError("deflate", "a stored block's length doesn't match its complement");
      this.last = last;
      this.stored = len;
      this.phase = "stored";
      return;
    }
    if (type === 1) {
      this.lcode = FIXED_L;
      this.dcode = FIXED_D;
    } else if (type === 2) {
      this.dynamic();
      this.lcode = this.dynL;
      this.dcode = this.dynD;
    } else {
      throw new TarError("deflate", "an invalid block type");
    }
    this.last = last;
    this.phase = "codes";
  }

  private dynamic(): void {
    const nlen = this.bits(5) + 257, ndist = this.bits(5) + 1, ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new TarError("deflate", "too many length or distance codes");
    const lengths = this.lengths;
    lengths.fill(0);
    for (let i = 0; i < ncode; i++) lengths[ORDER[i]] = this.bits(3);
    if (construct(this.clen, lengths, 19) !== 0) throw new TarError("deflate", "an incomplete code-length code");
    let index = 0;
    const total = nlen + ndist;
    const codeLengths = new Uint8Array(total);
    while (index < total) {
      let symbol = this.decode(this.clen);
      if (symbol < 16) {
        codeLengths[index++] = symbol;
        continue;
      }
      let len = 0;
      if (symbol === 16) {
        if (index === 0) throw new TarError("deflate", "a repeat with no previous length");
        len = codeLengths[index - 1];
        symbol = 3 + this.bits(2);
      } else if (symbol === 17) {
        symbol = 3 + this.bits(3);
      } else {
        symbol = 11 + this.bits(7);
      }
      if (index + symbol > total) throw new TarError("deflate", "too many code lengths");
      while (symbol--) codeLengths[index++] = len;
    }
    if (codeLengths[256] === 0) throw new TarError("deflate", "no end-of-block code");
    let err = construct(this.dynL, codeLengths, nlen);
    if (err && (err < 0 || nlen !== this.dynL.count[0] + this.dynL.count[1])) throw new TarError("deflate", "an invalid literal/length code");
    err = construct(this.dynD, codeLengths.subarray(nlen), ndist);
    if (err && (err < 0 || ndist !== this.dynD.count[0] + this.dynD.count[1])) throw new TarError("deflate", "an invalid distance code");
  }

  private copyStored(): void {
    if (this.stored === 0) {
      this.phase = this.last ? "trailer" : "block";
      return;
    }
    const n = Math.min(this.stored, this.len - this.pos);
    if (n === 0) throw MORE;
    // (the input is consumed first, so the caps see it, as for every step)
    const at = this.pos;
    this.pos += n;
    const room = this.room(n);
    for (let i = 0; i < room; i++) this.put(this.inp[at + i]);
    if (room < n) this.refuse();
    this.stored -= n;
  }

  private symbol(): void {
    const s = this.decode(this.lcode);
    if (s < 256) {
      if (this.room(1) < 1) this.refuse();
      this.put(s);
      return;
    }
    if (s === 256) {
      this.phase = this.last ? "trailer" : "block";
      return;
    }
    const li = s - 257;
    if (li >= 29) throw new TarError("deflate", "an invalid length symbol");
    const len = LBASE[li] + this.bits(LEXT[li]);
    const ds = this.decode(this.dcode);
    if (ds >= 30) throw new TarError("deflate", "an invalid distance symbol");
    const dist = DBASE[ds] + this.bits(DEXT[ds]);
    if (dist > this.out) throw new TarError("deflate", "a distance too far back");
    const room = this.room(len);
    let from = (this.wpos - dist) & (WINDOW - 1);
    for (let i = 0; i < room; i++) {
      this.put(this.win[from]);
      from = (from + 1) & (WINDOW - 1);
    }
    if (room < len) this.refuse();
  }

  private trailer(): void {
    // (byte-aligned: what's left of the last byte's bits is padding)
    this.bitbuf = 0;
    this.bitcnt = 0;
    const b = [] as number[];
    for (let i = 0; i < 8; i++) b.push(this.byte());
    this.drain();
    const crc = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    const isize = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
    if (crc !== crc32Final(this.crc)) throw new TarError("crc", "the gzip trailer's CRC doesn't match the data");
    if (isize !== this.out % 2 ** 32) throw new TarError("length", "the gzip trailer's length doesn't match the data");
    this.phase = "done";
  }
}
