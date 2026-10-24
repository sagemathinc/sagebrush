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
  /** Take one, if there is one; else how many ms until there is. */
  take(): { ok: true } | { ok: false; retryMs: number } {
    const t = this.now();
    this.tokens = Math.min(this.rate, this.tokens + ((t - this.at) * this.rate) / 1000);
    this.at = t;
    if (this.tokens >= 1) { this.tokens -= 1; return { ok: true }; }
    return { ok: false, retryMs: Math.ceil(((1 - this.tokens) * 1000) / this.rate) };
  }
}

export type Admission = { ok: true; ticket: Ticket } | { ok: false; busy: "in-flight" | "rate" | "queue"; retryMs: number };

/** An admitted submission's place: released once, when it is answered (or its connection goes). */
export interface Ticket { tab: string; bytes: number; release(): void }

export class Gate {
  private global: TokenBucket;
  private tabs = new Map<string, TokenBucket>();
  private inFlight = new Set<string>();
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
    // (the rates last: a request refused for another reason doesn't use a token)
    const g = this.global.take();
    if (!g.ok) return { ok: false, busy: "rate", retryMs: g.retryMs };
    const t = bucket.take();
    if (!t.ok) return { ok: false, busy: "rate", retryMs: t.retryMs };
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
          this.queued--;
          this.queuedBytes -= bytes;
        },
      },
    };
  }

  /** A tab gone: its bucket forgotten (a new connection starts full, as a new tab would). */
  forget(tab: string) { if (!this.inFlight.has(tab)) this.tabs.delete(tab); }
}
