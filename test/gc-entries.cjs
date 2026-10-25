// Preloaded by test/sbx.test.ts (node --require) into the CLI's process: the
// V8 GC performance entries of the whole run, written as JSON to
// $SAGEBRUSH_GC_LOG, {"entries": [[startTime ms, duration ms, kind], ...],
// "expected": n, "complete": bool}, on the same clock as pyjs's
// time.perf_counter().
//
// An entry reaches the observer only after the event loop turns, a number of
// turns no API promises (a single zero timer lost all of them in 5 of 60
// runs: astra2's CORR-PR151-1).  So the number of collections is taken from
// a source that needs no turn: v8.GCProfiler, whose stop() returns every
// collection since start() at once.  At the first beforeExit the loop is
// turned (setImmediate) until that many entries have arrived, or 2 s have
// passed; the log says how many were expected and whether all came, so an
// empty log is never read as no collections.  A run ending in process.exit()
// has no beforeExit: "exit" then writes what was delivered, marked
// incomplete unless all of them were.
const { PerformanceObserver } = require("node:perf_hooks");
const v8 = require("node:v8");
const out = process.env.SAGEBRUSH_GC_LOG;
if (out) {
  const entries = [];
  const keep = (list) => {
    for (const e of list) entries.push([e.startTime, e.duration, e.detail?.kind ?? 0]);
  };
  const obs = new PerformanceObserver((l) => keep(l.getEntries()));
  obs.observe({ type: "gc" });
  const prof = new v8.GCProfiler();
  prof.start();
  let expected = null, written = false, draining = false;
  const count = () => {
    if (expected === null) expected = prof.stop()?.statistics?.length ?? -1;
    return expected;
  };
  const write = () => {
    if (written) return;
    written = true;
    keep(obs.takeRecords());
    const n = count();
    obs.disconnect();
    require("node:fs").writeFileSync(out, JSON.stringify({ entries, expected: n, complete: n >= 0 && entries.length >= n }));
  };
  process.on("beforeExit", () => {
    if (draining) return;
    draining = true;
    const n = count();
    const until = Date.now() + 2000;
    const step = () => {
      keep(obs.takeRecords());
      if (n < 0 || entries.length >= n || Date.now() > until) write();
      else setImmediate(step);
    };
    setImmediate(step);
  });
  process.on("exit", write);
}
