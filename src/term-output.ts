// A Terminal command's output, bounded while it is received (PR 3a (b1) design r3 §2, plan-term-3a r1.7 §3.4): every
// write to stdout or stderr comes here as it happens, never collected whole and cut afterwards.
//
// The cap is the run's: min(the remaining allowance, the shell's fixed backstop), and it is AGGREGATE.  The result is
// stdout's prefix, then stderr's in what is left of the cap, the order the shell module's bounded() uses; so stdout
// keeps its prefix up to the cap, stderr keeps only the space stdout's prefix leaves, and when stdout grows after
// stderr has kept some, stderr's prefix is trimmed back to the space now left.  Each fragment is cut at a scalar
// boundary before it is appended.  So what is retained is at most `cap` bytes at every moment, and always exactly the
// result's prefix so far.  Past its space a stream only counts.  Counts are exact UTF-8, as TextEncoder encodes (a
// lone surrogate is U+FFFD, 3 bytes).

/** The UTF-8 length of `s`, and the end (a UTF-16 index) of its longest prefix of at most `budget` bytes ending at a
 * scalar boundary. */
export function utf8Prefix(s: string, budget: number): { bytes: number; end: number } {
  let n = 0, end = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let w = 1, b: number;
    if (c <= 0x7f) b = 1;
    else if (c <= 0x7ff) b = 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) (b = 4), (w = 2);
    else b = 3;
    if (end === s.length && n + b > budget) end = i;
    n += b;
    i += w - 1;
  }
  return { bytes: n, end };
}

/** One stream's retained prefix: its pieces, their UTF-8 total, and every byte it produced. */
class Stream {
  pieces: string[] = [];
  kept = 0;
  produced = 0;
  full = false;
  // what of `s` fits in `room` bytes: the piece to keep, its bytes, and all of s's bytes (nothing changed yet)
  plan(s: string, room: number): { piece: string; bytes: number; produced: number; cut: boolean } {
    const p = utf8Prefix(s, this.full ? 0 : Math.max(0, room - this.kept));
    const piece = p.end === s.length ? s : s.slice(0, p.end);
    return { piece, bytes: p.end === s.length ? p.bytes : utf8Prefix(piece, Infinity).bytes, produced: p.bytes, cut: p.end < s.length };
  }
  // keep a planned piece; past the room, only count
  commit(q: { piece: string; bytes: number; produced: number; cut: boolean }) {
    this.produced += q.produced;
    if (q.piece) {
      this.pieces.push(q.piece);
      this.kept += q.bytes;
    }
    if (q.cut) this.full = true;
  }
  // cut the retained prefix back to `room` bytes, at a scalar boundary (stderr, when stdout has grown)
  trim(room: number) {
    if (this.kept <= room) return;
    let left = room;
    const out: string[] = [];
    for (const piece of this.pieces) {
      const b = utf8Prefix(piece, left);
      if (b.end === piece.length) {
        out.push(piece);
        left -= b.bytes;
        continue;
      }
      if (b.end > 0) {
        out.push(piece.slice(0, b.end));
        left -= utf8Prefix(piece.slice(0, b.end), Infinity).bytes;
      }
      break;
    }
    this.pieces = out;
    this.kept = room - left;
    this.full = true;
  }
  text() {
    const s = this.pieces.join("");
    this.pieces = [s];
    return s;
  }
}

export type OutputCount = { producedBytes: number; deliveredBytes: number; exceeded: boolean; truncated: boolean };

/** The sink: write(fd, text) as the program writes; result() once it ends. */
export class TermOutput {
  readonly cap: number;
  private out = new Stream();
  private err = new Stream();
  /** the most ever retained at once, measured after every change, inside a write too (the tests' probe) */
  highWater = 0;
  constructor(readonly allowance: number, readonly backstop: number) {
    this.cap = Math.max(0, Math.min(allowance, backstop));
  }
  write(fd: 1 | 2, s: string) {
    if (!s) return;
    if (fd === 1) {
      // (stdout grows: stderr is first trimmed to the space stdout's new prefix will leave, then stdout's piece is
      // kept, so the retained total never passes the cap, not even between the two)
      const q = this.out.plan(s, this.cap);
      this.err.trim(this.cap - (this.out.kept + q.bytes));
      this.mark();
      this.out.commit(q);
    } else this.err.commit(this.err.plan(s, this.cap - this.out.kept));
    this.mark();
  }
  private mark() {
    this.highWater = Math.max(this.highWater, this.out.kept + this.err.kept);
  }
  /** What is retained now, in bytes (the tests' probe: never more than the cap). */
  retained(): number {
    return this.out.kept + this.err.kept;
  }
  result(): { stdout: string; stderr: string; output: OutputCount } {
    const produced = this.out.produced + this.err.produced;
    const delivered = this.out.kept + this.err.kept;
    const over = produced > this.cap;
    const exceeded = over && produced > this.allowance;
    return { stdout: this.out.text(), stderr: this.err.text(), output: { producedBytes: produced, deliveredBytes: delivered, exceeded, truncated: over && !exceeded } };
  }
}
