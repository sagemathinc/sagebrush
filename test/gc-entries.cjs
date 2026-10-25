// Preloaded by test/sbx.test.ts (node --require) into the CLI's process: the
// V8 GC performance entries of the whole run, written as JSON to
// $SAGEBRUSH_GC_LOG ([startTime ms, duration ms, kind]), on the same clock as
// pyjs's time.perf_counter().  V8 makes a GC's entry only once the event loop
// turns, and a Python run never yields: a synchronous run has none queued
// even at exit, so takeRecords() alone finds nothing.  So at the first
// beforeExit the loop is kept for one more turn, which delivers them, with
// their real start times; then the log is written.  A run ending in
// process.exit() has no beforeExit: "exit" then writes what was delivered,
// and the entry count shows how much that was.
const { PerformanceObserver } = require("node:perf_hooks");
const out = process.env.SAGEBRUSH_GC_LOG;
if (out) {
  const entries = [];
  const keep = (list) => {
    for (const e of list) entries.push([e.startTime, e.duration, e.detail?.kind ?? 0]);
  };
  const obs = new PerformanceObserver((l) => keep(l.getEntries()));
  obs.observe({ type: "gc" });
  let written = false, turned = false;
  const write = () => {
    if (written) return;
    written = true;
    keep(obs.takeRecords());
    obs.disconnect();
    require("node:fs").writeFileSync(out, JSON.stringify(entries));
  };
  process.on("beforeExit", () => {
    if (!turned) {
      turned = true;
      setTimeout(write, 0);
    }
  });
  process.on("exit", write);
}
