// `sagebrush board open --edit`'s admission (plan-board-open-edit r7 §8.3, §8.4,
// addendum 2): what decides, before a request's body is read, whether it is
// taken at all.  Per tab: one submission in flight, TAB_RATE.  For all:
// GLOBAL_RATE (every /edit and /board request), and the merge queue,
// QUEUE_MAX requests and QUEUE_BYTES of their bodies (Content-Length, or
// BODY_MAX when chunked).  A request not admitted is answered busy, with
// Retry-After, and its body never read.  The clock is passed in.
import type { Limits } from "./board-edit-limits";

/** A token bucket: `rate` a second, holding at most `rate` (one second's worth). */
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(readonly rate: number, private now: () => number) { this.tokens = rate; this.at = now(); }
  /** Whether one could be taken now; else how many ms until one could. */
  peek(): { ok: true } | { ok: false; retryMs: number } {
    const t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.at) * this.rate) / 1000);
    this.at = t;
    return this.tokens >= 1 ? { ok: true } : { ok: false, retryMs: Math.ceil(((1 - this.tokens) * 1000) / this.rate) };
  }
  /** Take one, if there is one; else how many ms until there is. */
  take(): { ok: true } | { ok: false; retryMs: number } {
    const p = this.peek();
    if (p.ok) this.tokens -= 1;
    return p;
  }
}

export type Admission = { ok: true; ticket: Ticket } | { ok: false; busy: "in-flight" | "rate" | "queue"; retryMs: number };

/** An admitted submission's place: released once, when it is answered (or its connection goes). */
export interface Ticket { tab: string; bytes: number; release(): void }

export class Gate {
  private global: TokenBucket;
  private tabs = new Map<string, TokenBucket>();
  private inFlight = new Set<string>();
  /** tabs gone while a submission of theirs was in flight: their buckets forgotten when it is released */
  private gone = new Set<string>();
  queued = 0;
  queuedBytes = 0;
  constructor(private limits: Limits, private now: () => number) { this.global = new TokenBucket(limits.GLOBAL_RATE, now); }

  /** A /board (or other counted) request: GLOBAL_RATE only. */
  read(): { ok: true } | { ok: false; retryMs: number } { return this.global.take(); }

  /** A submission from `tab`, its body declared as `length` bytes (null: chunked, counted as BODY_MAX). */
  edit(tab: string, length: number | null): Admission {
    if (this.inFlight.has(tab)) return { ok: false, busy: "in-flight", retryMs: 250 };
    let bucket = this.tabs.get(tab);
    if (!bucket) { bucket = new TokenBucket(this.limits.TAB_RATE, this.now); this.tabs.set(tab, bucket); }
    const bytes = length ?? this.limits.BODY_MAX;
    if (this.queued + 1 > this.limits.QUEUE_MAX || this.queuedBytes + bytes > this.limits.QUEUE_BYTES) return { ok: false, busy: "queue", retryMs: 1000 };
    // (the rates last, both checked before either is taken: a request refused doesn't use a token)
    const g = this.global.peek(), t = bucket.peek();
    if (!g.ok) return { ok: false, busy: "rate", retryMs: g.retryMs };
    if (!t.ok) return { ok: false, busy: "rate", retryMs: t.retryMs };
    this.global.take();
    bucket.take();
    this.inFlight.add(tab);
    this.queued++;
    this.queuedBytes += bytes;
    let done = false;
    return {
      ok: true,
      ticket: {
        tab,
        bytes,
        release: () => {
          if (done) return;
          done = true;
          this.inFlight.delete(tab);
          if (this.gone.delete(tab)) this.tabs.delete(tab);
          this.queued--;
          this.queuedBytes -= bytes;
        },
      },
    };
  }

  /** A tab gone: its bucket forgotten (a new connection starts full, as a new tab would); with a submission in
   * flight, once that is released (daybreak3 SLOW-DROP-1). */
  forget(tab: string) { if (this.inFlight.has(tab)) this.gone.add(tab); else this.tabs.delete(tab); }

  /** How many tabs have a bucket (for the tests: at most the connected tabs and those with a submission in flight). */
  get buckets() { return this.tabs.size; }
}
