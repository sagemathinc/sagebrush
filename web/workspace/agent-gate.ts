// The page-wide gates: signing and digests outstanding at once, each charged until its promise settles (WebCrypto
// can't be cancelled), across close and Chat here again (agent-relay.ts's bounds). Apart from the agent leg so that
// the Agents page's chat (agent-chat/session.ts, its permission cards' digests) shares the one digest gate without
// loading the leg itself: in the desktop app the leg is never loaded.

export const SIGNS_MAX = 1;
export const DIGESTS_MAX = 4;
/** A digest's charge: its whole input (the domain, the fixed keys, four identities of at most 1 KiB and an input of at
 * most 16 KiB: 20,556 bytes at most, rounded to 21 KiB), six times: the canonical text and the domain-prefixed text as
 * JS strings (at most twice their UTF-8 each), the UTF-8 bytes, and WebCrypto's own copy of them (its digest takes a
 * snapshot before it runs). A payload figure: object and GC overhead aren't counted. */
export const DIGEST_CHARGE = 6 * 21 * 1024;

export class Gate {
  active = 0;
  bytes = 0;
  peak = 0;
  peakBytes = 0;
  private waiting: { bytes: number; live: () => boolean; go: (r: (() => void) | null) => void }[] = [];
  readonly max: number;
  readonly waitMax: number;
  constructor(max: number, waitMax: number) { this.max = max; this.waitMax = waitMax; }
  /** A place, once one is free, as its release; null if `live()` turned false while it waited (nothing charged), or
   * at once if `waitMax` are already waiting (the work isn't done: its caller fails closed). */
  acquire(bytes: number, live: () => boolean): Promise<(() => void) | null> {
    this.sweep();
    if (this.active >= this.max && this.waiting.length >= this.waitMax) return Promise.resolve(null);
    return new Promise((go) => { this.waiting.push({ bytes, live, go }); this.next(); });
  }
  get queued() { return this.waiting.length; }
  private next() {
    while (this.waiting.length && this.active < this.max) {
      const w = this.waiting.shift()!;
      if (!w.live()) { w.go(null); continue; }
      this.active++;
      this.bytes += w.bytes;
      this.peak = Math.max(this.peak, this.active);
      this.peakBytes = Math.max(this.peakBytes, this.bytes);
      let done = false;
      w.go(() => { if (done) return; done = true; this.active--; this.bytes -= w.bytes; this.next(); });
    }
  }
  /** Waiters whose work is no longer wanted, dropped now (a closed pairing's). */
  sweep() { this.waiting = this.waiting.filter((w) => (w.live() ? true : (w.go(null), false))); }
  resetPeaks() { this.peak = this.active; this.peakBytes = this.bytes; }
}
// (waiting, at most: the sends of the legs that can be open at once (a leg pumps one at a time) and the hello; the
//  current pairing's open questions, the agent's own limit)
export const signGate = new Gate(SIGNS_MAX, 4);
export const digestGate = new Gate(DIGESTS_MAX, DIGESTS_MAX);
