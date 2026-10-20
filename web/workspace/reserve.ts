// The page's one reservation for bytes read whole into memory
// (design/capabilities.md §8, §2b): the migrator now, the file broker's
// reads later.  A read reserves its size before it reads anything; while the
// reservation can't hold it, it waits, first come first served.  One larger
// than the whole reservation waits until nothing else is held, then has it
// alone.  Released when done, in a finally, and idempotently.

/** The page-wide reservation: 256 MiB. */
export const RESERVE_BYTES = 256 * 2 ** 20;

let held = 0;
const waiting: { n: number; go: () => void }[] = [];

function fits(n: number) {
  return held === 0 || held + n <= RESERVE_BYTES;
}
function next() {
  while (waiting.length && fits(waiting[0].n)) {
    const w = waiting.shift()!;
    held += w.n;
    w.go();
  }
}

/** `n` bytes reserved (waiting for room, in order); resolves to the release, which may be called more than once. */
export function reserve(n: number): Promise<() => void> {
  n = Math.max(0, Math.ceil(n));
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    held -= n;
    next();
  };
  if (!waiting.length && fits(n)) {
    held += n;
    return Promise.resolve(release);
  }
  return new Promise((ok) => {
    waiting.push({ n, go: () => ok(release) });
  });
}

/** What is reserved now, and how many wait (for tests and the Storage panel). */
export function reserved(): { held: number; waiting: number } {
  return { held, waiting: waiting.length };
}
