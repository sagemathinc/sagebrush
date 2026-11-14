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

// ------------------------------------------------------------------ a Terminal prompt's output

/** One segment of a prompt's output: stdout (1) or stderr (2), in the order written. */
export type PromptSegment = { fd: 1 | 2; text: string };

/**
 * A Terminal prompt's output, one statement at a time, in the order written (design term-prompt r1 §4–§5, r1a): every
 * write comes here as it happens.  Per statement, with IN its bytes and RES stderr's reserve within them: a stdout
 * byte is kept while out + err < IN − RES, a stderr byte while out + err < IN; the rest is counted as omitted, and
 * one line, "… N bytes of output omitted", closes the statement's output.  Cuts fall at scalar boundaries.  The
 * statement's counters start at begin() and are never reset by a flush: a flush frees storage only, so nothing is
 * kept or shown twice and a flush (at input(), or forced) refills nothing.
 *
 * Kept text is held as segments, each an array of parts (adjacent writes to one fd push onto the last segment's
 * parts; nothing is joined until a flush), at most `perFlush` segments held: a write that would open one more flushes first.
 * `flush` sends the segments (the worker's `out`, which blocks until the page has taken them).
 */
export class PromptOutput {
  private segs: { fd: 1 | 2; parts: string[] }[] = [];
  private out = 0;
  private err = 0;
  private omitted = 0;
  /** delivered across the session (the page charges each flush as it arrives) */
  delivered = 0;
  constructor(
    readonly inBytes: number,
    readonly reserve: number,
    readonly perFlush: number,
    private flushTo: (segs: PromptSegment[]) => void,
  ) {}
  /** A statement starts: its counters at zero. */
  begin() {
    this.out = this.err = this.omitted = 0;
  }
  write(fd: 1 | 2, s: string) {
    if (!s) return;
    const room = fd === 1 ? this.inBytes - this.reserve - (this.out + this.err) : this.inBytes - (this.out + this.err);
    const p = utf8Prefix(s, Math.max(0, room));
    const piece = p.end === s.length ? s : s.slice(0, p.end);
    const kept = p.end === s.length ? p.bytes : utf8Prefix(piece, Infinity).bytes;
    this.omitted += p.bytes - kept;
    if (!piece) return;
    if (fd === 1) this.out += kept;
    else this.err += kept;
    const last = this.segs[this.segs.length - 1];
    if (last && last.fd === fd) last.parts.push(piece);
    else {
      if (this.segs.length >= this.perFlush) this.flush();
      this.segs.push({ fd, parts: [piece] });
    }
  }
  /** Send what is held, in order, and let it go. */
  flush() {
    if (!this.segs.length) return;
    const segs = this.segs.map((g) => ({ fd: g.fd, text: g.parts.join("") }));
    this.segs = [];
    for (const g of segs) this.delivered += utf8Prefix(g.text, Infinity).bytes;
    this.flushTo(segs);
  }
  /** A statement ends: the omitted line, if any, then everything held is sent. */
  end() {
    if (this.omitted > 0) {
      const n = this.omitted;
      this.omitted = 0;
      // (past the statement's bytes: the line is the panel's own, sent outside the cut)
      const last = this.segs[this.segs.length - 1];
      const line = `… ${n} bytes of output omitted\n`;
      if (last && last.fd === 2) last.parts.push(line);
      else {
        if (this.segs.length >= this.perFlush) this.flush();
        this.segs.push({ fd: 2, parts: [line] });
      }
    }
    this.flush();
  }
  /** Held now, in segments (the tests' probe: never more than perFlush). */
  held(): number {
    return this.segs.length;
  }
}
