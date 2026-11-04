// The threads demo's workers as one crew (numerics-core r4.2, M0; E3/ND-M3): every worker is registered the
// moment it exists, before anything is posted to it, with error handlers for its whole life; the crew is torn
// down as a whole, best-effort (each worker's terminate is tried even if another's throws), at most once. So a
// pool that fails while starting (a constructor or a postMessage throwing after some workers were made)
// leaves no worker behind, and the original error is the one reported.

/** What the crew needs of a Worker (the page passes real Workers; tests pass fakes). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  // (handlers typed loosely, so that a DOM Worker, whose handlers take its own event types, is one)
  onerror: ((e: any) => any) | null;
  onmessageerror: ((e: any) => any) | null;
  onmessage: ((e: any) => any) | null;
}

export class Crew<W extends WorkerLike = WorkerLike> {
  readonly workers: W[] = [];
  dead = false;
  private readonly ready: Promise<any>[] = [];

  /** `make` constructs a worker; `fail` is told of any worker's failure (once the crew is dead, never). */
  constructor(private readonly make: () => W, private readonly fail: (why: string) => void) {}

  /** A new worker named `name`, registered, then sent `init`; its first message settles `started()`. */
  add(name: string, init: unknown): W {
    const w = this.make();
    this.workers.push(w);
    let settle: ((v: any) => void) | null = null;
    this.ready.push(new Promise((res) => (settle = res)));
    w.onerror = (e) => this.failed(`${name} failed: ${e?.message || "error"}`);
    w.onmessageerror = () => this.failed(`${name}: a message could not be read`);
    w.onmessage = (e) => {
      if (e.data?.helperError) return this.failed(e.data.helperError);
      if (settle) { const s = settle; settle = null; s(e.data); }
    };
    w.postMessage(init);
    return w;
  }

  /** Every added worker's first message, in order of adding. */
  started(): Promise<any[]> {
    return Promise.all(this.ready);
  }

  private failed(why: string) {
    if (!this.dead) this.fail(why);
  }

  /** Terminate every worker made (best-effort: one throwing does not stop the rest); idempotent. */
  end() {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        // (nothing more can be done for this one; the others are still terminated)
      }
    }
  }
}
