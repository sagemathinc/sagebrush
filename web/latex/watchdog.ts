// The preview's watchdog (editor.ts request): a request the engine worker doesn't answer in WATCHDOG_MS is taken as
// hung, and the worker replaced. Its time is the page's: when the page's own main thread is blocked past the due time
// (a long synchronous task: laying out a very long source line), the timer and the worker's reply, sent in time, wait
// together, and the timer could run first, replacing a worker that had answered. So a timer that runs more than LATE_MS
// past its due time (the page was blocked) waits once more, LATE_MS, for a reply already queued; only then is the
// worker hung. (Issue 619)
export const WATCHDOG_MS = 15000, LATE_MS = 1000;

export type Clock = { now(): number; set(f: () => void, ms: number): unknown; clear(h: unknown): void };
const PAGE: Clock = { now: () => performance.now(), set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as any) };

/** start(hung): `hung` is called once this request has gone unanswered for `ms` of the page's own time; stop(): the
 * reply came (or the request was dropped). */
export function watchdog(o: { ms?: number; late?: number; clock?: Clock } = {}) {
  const ms = o.ms ?? WATCHDOG_MS, late = o.late ?? LATE_MS, c = o.clock ?? PAGE;
  let h: unknown = null;
  const stop = () => { if (h !== null) c.clear(h); h = null; };
  const arm = (wait: number, graced: boolean, hung: () => void) => {
    const due = c.now() + wait;
    h = c.set(() => {
      h = null;
      if (!graced && c.now() - due > late) return arm(late, true, hung);
      hung();
    }, wait);
  };
  return { start: (hung: () => void) => { stop(); arm(ms, false, hung); }, stop };
}
