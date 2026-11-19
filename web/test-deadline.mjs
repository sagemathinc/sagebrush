// ci: none (shared browser/page test deadlines; not shipped)
export const WAIT_MS = 30_000;

export class TestTimeout extends Error {
  constructor(helper, what, elapsed) {
    super(`${helper}(${String(what).replace(/[\r\n]/g, " ").slice(0, 240)}) timed out after ${(elapsed / 1000).toFixed(3)} s`);
    this.name = "TestTimeout";
  }
}

// Keep the timer referenced: a hung promise must fail, not silently exit.
// The operation receives a signal so polling/fetching can stop after expiry.
export async function deadline(helper, what, operation, ms = WAIT_MS) {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${helper}: timeout must be finite and positive`);
  const start = performance.now(), abort = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(abort.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = new TestTimeout(helper, what, performance.now() - start);
        abort.abort(error);
        reject(error);
      }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

// The deadline bounds each asynchronous probe too, not just the spaces between
// probes. Supply the remaining budget to CDP calls so their slots are released.
export function waitFor(helper, what, probe, ms = WAIT_MS) {
  const start = performance.now();
  return deadline(helper, what, async (signal) => {
    while (!signal.aborted) {
      let value;
      try { value = await probe(Math.max(1, Math.ceil(ms - (performance.now() - start))), signal); }
      catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof TestTimeout) throw error; }
      if (signal.aborted) throw signal.reason;
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, ms - (performance.now() - start)))));
    }
    throw signal.reason;
  }, ms);
}
