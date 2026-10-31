// The loss cascade (plan r8, C1): 20 independent cells Run at once over a seeded lossy link, in each mode (waves,
// and cell by cell).  A lost reply loses the whole answer (the gateway did the work); a lost stream chunk breaks
// the stream.  Every decision is the seed's LCG, in the order the messages arrive: no timers, no Math.random.
// Two links, the same draws:
//   (a) lossy: each reply or chunk lost on its own; F3's GETs then find nearly every record, so few runs end unknown;
//   (b) doomed: once a run's submit reply is lost, its resend and every record GET of that request are lost too, so
//       each such run ends unknown and goes to the fence: what follows is F1's to keep (the queued Runs still go).
//   - lossRun(seed, waves, {doomed}): the per-cell outcomes of one seed, and how many requests were doomed;
//   - lossPass(o): link (a)'s rule: every run done, except at most one whose outcome is unknown;
//   - doomedPass(o, n, execs): link (b)'s: one unknown per doomed request, every other run done (none refused),
//     however many requests are doomed, in both modes (the Runs go one at a time, so each wave holds one cell); and
//     no cell's code executed twice;
//   - SEEDS: the seeds that cascaded on the pre-fix code (master 3c6429d0) in either mode, from a fresh sweep, plus
//     16 ordinary ones (no unknown in either mode); each runs in both modes.
// Run by test-remote-kernel.mjs: runLossTests(check).

import { page } from "./test-remote-gate.mjs";

// (the LCG: a = 1103515245, c = 12345, m = 2^31; its first draw from seed s is (a*s + c) mod m, divided by m)
export const lcg = (seed) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
export const LOSS = 0.1;

// (`doomed`: link (b)'s set of requests whose every later reply is lost; null for link (a))
const lossy = (rand, p, log, on, doomed = null) => (f) => async (url, init) => {
  const res = await f(url, init);
  if (!on.v) return res;
  const stream = (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream");
  const method = init?.method ?? "GET", path = new URL(String(url)).pathname;
  const tag = `${method} ${path.replace(/^.*\/bindings/, "")}`;
  let req = null;
  if (doomed) {
    if (method === "POST" && /\/runs$/.test(path)) req = JSON.parse(init.body).request;
    const get = method === "GET" && /\/runs\/([^/]+)$/.exec(path);
    if (get) req = decodeURIComponent(get[1]);
    if (req && doomed.has(req)) { log.push("doomed " + tag); throw new TypeError("lost (the test's network)"); }
  }
  if (!stream) {
    if (rand() < p) {
      if (doomed && method === "POST" && req) doomed.add(req);
      log.push("lost reply " + tag);
      throw new TypeError("lost (the test's network)");
    }
    return res;
  }
  const reader = res.body.getReader();
  return new Response(new ReadableStream({
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) return c.close();
      if (rand() < p) { log.push("broke stream " + tag); reader.cancel().catch(() => {}); return c.error(new TypeError("broke (the test's network)")); }
      c.enqueue(value);
    },
  }), { status: res.status, headers: res.headers });
};

const CELLS = 20;
/** One seed in one mode: each cell's outcome ("done", "unknown", or what it was), the network's log, and (link (b))
 * how many requests were doomed. */
export async function lossRun(seed, waves, { doomed = false } = {}) {
  const log = [], on = { v: false }, lost = doomed ? new Set() : null;
  const codes = Array.from({ length: CELLS }, (_, i) => [`c${i}`, `v${i} = ${i}`]);
  const p = await page(codes, { waves, net: lossy(lcg(seed), LOSS, log, on, lost) });
  on.v = true; // (the binding is made before the link turns lossy)
  await Promise.all(codes.map(([id]) => p.gesture([id])));
  const outcomes = codes.map(([id]) => {
    const st = p.states.get(id), r = p.results.get(id);
    if (st?.state === "done" && st.ok) return "done";
    if (/whether this ran is unknown/.test(r?.note ?? "")) return "unknown";
    return `${st?.state ?? "-"}${st?.why ? ":" + st.why : ""}${(st?.note ?? r?.note) ? ":" + String(st?.note ?? r?.note).trim().slice(0, 60) : ""}`;
  });
  // (how many times the gateway executed each cell's code: an unknown run is never executed again)
  const execs = codes.map(([, code]) => p.fake.executions.filter((x) => x.code === code).length);
  return { outcomes, log, doomed: lost ? lost.size : 0, execs };
}
/** Link (a)'s rule: every run done, except at most one whose outcome is unknown. */
export const lossPass = (o) => o.filter((x) => x !== "done").length <= 1 && o.every((x) => x === "done" || x === "unknown");
/** Link (b)'s rule: one unknown per doomed request, every other run done; nothing executed twice. */
export const doomedPass = (o, n, execs) => o.every((x) => x === "done" || x === "unknown") && o.filter((x) => x === "unknown").length === n && execs.every((k) => k <= 1);

// (from the pre-fix sweep of seeds 1..1000 on master 3c6429d0 plus this harness (1db21ab7), Oct 31: the seeds that
// failed the rule in each mode; and 16 of the 964 seeds clean in both modes, no unknown and no failure)
export const CASCADE_SEEDS = {
  waves: [58, 162, 172, 195, 218, 229, 263, 285, 302, 345, 368, 512, 532, 538, 624, 660, 687, 771, 782, 818, 838, 841, 884, 962],
  cells: [162, 218, 229, 233, 263, 302, 359, 430, 486, 498, 582, 612, 660, 677, 771, 794, 818],
};
export const ORDINARY_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
export const SEEDS = [...new Set([...CASCADE_SEEDS.waves, ...CASCADE_SEEDS.cells, ...ORDINARY_SEEDS])].sort((a, b) => a - b);

export async function runLossTests(check) {
  const t0 = Date.now(), failed = { waves: [], cells: [] }, doomedFailed = { waves: [], cells: [] }, withDoomed = { waves: 0, cells: 0 };
  for (const waves of [true, false]) {
    const mode = waves ? "waves" : "cells";
    for (const seed of SEEDS) {
      const { outcomes } = await lossRun(seed, waves);
      if (!lossPass(outcomes)) failed[mode].push(seed);
      const b = await lossRun(seed, waves, { doomed: true });
      if (b.doomed) withDoomed[mode]++;
      if (!doomedPass(b.outcomes, b.doomed, b.execs)) doomedFailed[mode].push(seed);
    }
  }
  console.log(`info C1 seeded loss: ${SEEDS.length} seeds x 2 modes x 2 links in ${((Date.now() - t0) / 1000).toFixed(1)} s; failing (a) ${JSON.stringify(failed)}, (b) ${JSON.stringify(doomedFailed)}; seeds with a doomed request ${JSON.stringify(withDoomed)}`);
  const none = (f) => f.waves.length === 0 && f.cells.length === 0;
  check(none(failed) && none(doomedFailed), `C1 seeded loss: every seed passes in both modes on both links: (a) every run done but at most one unknown, failing ${JSON.stringify(failed)}; (b) one unknown per doomed request, every other run done, none executed twice, failing ${JSON.stringify(doomedFailed)}`);
  return 1;
}
