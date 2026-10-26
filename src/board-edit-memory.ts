// `sagebrush board open --edit`'s memory ledger (plan-board-open-edit r7 §8.2,
// addendum 2's "Memory admission"): one count, MEMORY_MAX, of what the hub
// holds, every charge admitted before what it covers is made.  The charges
// are stated formulas of facts known before parsing, with fixed factors,
// measured by shape with headroom (addendum 2's table):
//
//   a submission, before its body is parsed:  R  = 18·b + 256·t
//   a version the hub keeps:                  Rv =  6·b + 128·t
//
// b being the bytes of the records as JSON lines and t their structural
// tokens: the bytes `{`, `[`, `,` and `:` outside JSON strings, counted in one
// pass that allocates nothing.  A charge past MEMORY_MAX / 2 can never be
// admitted (refused, for good); one that doesn't fit now waits (busy).

export const SUBMIT_PER_BYTE = 18, SUBMIT_PER_TOKEN = 256;
export const KEPT_PER_BYTE = 6, KEPT_PER_TOKEN = 128;

/** The structural tokens of JSON text as UTF-8 bytes: `{`, `[`, `,` and `:` outside strings. */
export function tokensOf(b: Uint8Array): number {
  let t = 0, inString = false, escaped = false;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b || c === 0x2c || c === 0x3a) t++;
  }
  return t;
}

/** The same count on a string (UTF-16; the structural characters are ASCII either way). */
function tokensOfString(s: string): number {
  let t = 0, inString = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 0x5c) escaped = true;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b || c === 0x2c || c === 0x3a) t++;
  }
  return t;
}

/** R: what a submission of these body bytes reserves before it is parsed. */
export const submitCharge = (body: Uint8Array) => SUBMIT_PER_BYTE * body.length + SUBMIT_PER_TOKEN * tokensOf(body);

/** Rv: what a kept version of these records is charged, counted one record at a time as JSON lines. */
export function keptCharge(records: readonly unknown[]): number {
  let b = 0, t = 0;
  for (const r of records) {
    const s = JSON.stringify(r);
    b += Buffer.byteLength(s, "utf8") + 1;
    t += tokensOfString(s);
  }
  return KEPT_PER_BYTE * b + KEPT_PER_TOKEN * t;
}

/** The ledger: charges admitted before what they cover, released when it is gone. */
export class Ledger {
  used = 0;
  peak = 0;
  constructor(readonly max: number) {}
  /** Whether n could ever be admitted (at most half the cap: the rest is compaction's and the kept versions'). */
  admissible(n: number) { return n <= this.max / 2; }
  /** Admit n, if it fits now. */
  admit(n: number): boolean {
    if (n < 0 || this.used + n > this.max) return false;
    this.used += n;
    if (this.used > this.peak) this.peak = this.used;
    return true;
  }
  release(n: number) { this.used = Math.max(0, this.used - n); }
  /** A reservation of n, if it fits now: what it covers is retained out of it, the rest released when it closes. */
  reserve(n: number): Reservation | null { return this.admit(n) ? new Reservation(this, n) : null; }
}

/**
 * Part of the ledger held for one operation (LIMIT-BOARD-ADD2-1).  What the operation keeps is converted out of
 * it, so a kept version is charged with no interval uncharged and no admission that could fail: `retain(n)`
 * moves n from the reservation to the kept charges (the ledger's total unchanged).  `close()`, in a finally,
 * releases what remains, on every path.  A retain past what remains (the formula not covering it, which the
 * measurements say doesn't happen) is charged anyway: the ledger then shows more than its cap, and admits
 * nothing until it is back under.
 */
export class Reservation {
  private open = true;
  constructor(private ledger: Ledger, public left: number) {}
  retain(n: number) {
    const from = Math.min(n, this.left);
    this.left -= from;
    this.ledger.used += n - from;
    if (this.ledger.used > this.ledger.peak) this.ledger.peak = this.ledger.used;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.ledger.release(this.left);
    this.left = 0;
  }
}
