import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { decideEngine, decideHost, gatherEngineProbes, type EngineProbes } from "../src/runtime/js-engine";

// Kedlaya's Frobenius matrix without a default work limit (cliff audit rank
// 14, plan-kedlaya-optin r6): E.padic_lseries(p).frobenius(prec) runs until
// done or stopped, under the opt-in limit padic.kedlaya_work and the memory
// guard (lib/_sage_padic_lseries.py _kd_preflight).  The pure parts run the
// same under python3 and Sagebrush; the ledger's object sizes are checked
// against each runtime's own accounting (CPython: tracemalloc and getsizeof;
// V8: its live heap and the heap limit a call completes in; JavaScriptCore,
// under Bun: its live heap); the engine detection on fixtures and on the
// real hosts; and Stop at four stages.
const TEST = __dirname + "/../../test/";
const DIST = __dirname + "/..";
const CLI = DIST + "/src/cli.js";
const opts = { encoding: "utf8" as const, maxBuffer: 1 << 26 };
const py3 = (...args: string[]) => execFileSync("python3", ["-I", ...args], opts);
const sb = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], opts);
const dir = mkdtempSync(join(tmpdir(), "sb-kedlaya-"));

test("the planner, the ledger's digit count and L = p: the same under python3 and Sagebrush", () => {
  const want = [
    "planner: 0 disagreements",
    "ledger: smaller L, smaller U: cpython True, jsc True, v8 True; admission charges L = [97]",
    "digits: [((5, True), 100), ((7, True), 294), ((11, True), 1210)]; curves all L = p: True",
    "",
  ].join("\n");
  assert.equal(py3(TEST + "kedlaya_cases.py", "planner", "ledger", "digits"), want);
  assert.equal(sb(TEST + "kedlaya_cases.py", "planner", "ledger", "digits"), want);
});

test("the offset-add reduction gives the padded one's forms, G and matrix (python3; the whole grid: kedlaya_cases.py full)", () => {
  const out = py3(TEST + "kedlaya_cases.py", "equivalence");
  assert.doesNotMatch(out, /DIFFERENT/);
  assert.match(out, /^equivalence: \d+ reductions compared$/m);
});

test("the preflight: the necessary minimum, the finite limit, the budget at 4U, the engines without a table, D1's memory error at the smallest totals (python3 = Sagebrush)", () => {
  const want = readFileSync(TEST + "kedlaya_guard_cases.out", "utf8");
  const limits = ["5136128", "5136127", "5000000", "4695888", "unlimited", "0"];
  let a = "", b = "";
  for (const s of ["min", "budget", "engines", "tiny"]) {
    a += py3(TEST + "kedlaya_guard_cases.py", s);
    b += sb(TEST + "kedlaya_guard_cases.py", s);
  }
  for (const l of limits) {
    a += py3(TEST + "kedlaya_guard_cases.py", "finite", l);
    const f = join(dir, `limit-${l}.json`);
    writeFileSync(f, JSON.stringify({ "padic.kedlaya_work": l === "unlimited" ? l : Number(l) }));
    b += sb("--limits", f, TEST + "kedlaya_guard_cases.py", "finite", l);
  }
  assert.equal(a, want);
  // (the getsizeof line is CPython's alone)
  assert.equal(b, want.split("\n").filter((l) => !l.includes("bytes of P")).join("\n"));
});

test("frobenius() itself: no default limit, a finite one refuses as the old default did, and 10^100 at once", () => {
  // 27a1 at p = 173, prec 3: _kd_cost 1136366, above the old 2^20 refusal.
  // Sage (matrix_of_frobenius, a black-box oracle, its own basis): det 173 +
  // O(173^3), trace O(173^3), so phi = F/p has det 1/173, trace 0, and a
  // non-scalar 2 x 2 matrix is determined up to similarity by those
  const code = "phi = EllipticCurve('27a1').padic_lseries(173).frobenius(3)\nprint(phi.det(), phi.trace())";
  assert.equal(sb("--sage", "-c", code), "173^-1 + O(173^2) O(173^3)\n");
  const lim = join(dir, "kedlaya-2-20.json");
  writeFileSync(lim, '{"padic.kedlaya_work": 1048576}');
  const refused = (E: string, p: number, n: number) => `try:\n    EllipticCurve('${E}').padic_lseries(${p}).frobenius(${n})\nexcept NotImplementedError as e:\n    print(e)\n`;
  assert.equal(
    sb("--limits", lim, "--sage", "-c", refused("27a1", 2003, 2) + refused("14a1", 5, 408) + refused("27a1", 173, 3)),
    [
      "the Frobenius matrix at p = 2003 to precision 2 is beyond the limit padic.kedlaya_work (estimated work 100300225 > 1048576)",
      "the Frobenius matrix at p = 5 to precision 408 is beyond the limit padic.kedlaya_work (estimated work 4223025 > 1048576)",
      "the Frobenius matrix at p = 173 to precision 3 is beyond the limit padic.kedlaya_work (estimated work 1077444 > 1048576)",
      "",
    ].join("\n"),
  );
  // the memory refusals are D1's memory error, with the CLI's routes
  const big = sb("--sage", "-c", "try:\n    EllipticCurve('14a1').padic_lseries(5).frobenius(10^100)\nexcept MemoryError as e:\n    print(type(e).__name__, e.fixed, e.need_bytes > e.limit_bytes > 0)\n    print(e)\n");
  const lines = big.split("\n");
  assert.equal(lines[0], "SagebrushMemoryError False True", big);
  assert.equal(lines[1], "Not enough memory for this computation.", big);
  assert.match(lines[2], /^At the least, the Frobenius matrix at p = 5 to precision 10{100} \(just its working modulus p\^\(prec \+ 4\)\) needs about \d+(\.\d+)? GB, but Sagebrush allows about \d+(\.\d+)? [MG]B for this whole process here\.$/, big);
  assert.match(big, /NODE_OPTIONS=--max-old-space-size/, big);
});

test("the CPython object sizes: high-water, per-term and lifetime checks with their mutants, layout steps (python3)", () => {
  const peaks = py3(TEST + "kedlaya_peaks.py", "peaks");
  for (const l of peaks.trim().split("\n")) assert.match(l, /U >= peak: True/, peaks);
  const terms = py3(TEST + "kedlaya_peaks.py", "terms");
  assert.match(terms, /^terms dense: \d+ checks at 7 hook calls, failing: none$/m, terms);
  assert.match(terms, /^terms sparse: \d+ checks at 7 hook calls, failing: none$/m, terms);
  assert.match(terms, /^terms dense: 9 mutants \(one term dropped each\), each failing its own check: True$/m, terms);
  assert.match(terms, /^terms sparse: 9 mutants \(one term dropped each\), each failing its own check: True$/m, terms);
  assert.match(terms, /the check call within its own terms and sizes: True; the mutant charging it as \(K, W\) fails at: bits of cur, entries of cur, entries of forms$/m, terms);
  assert.equal(py3(TEST + "kedlaya_peaks.py", "layouts"), "layouts: all within\n");
});

test("the V8 object sizes: layout steps from the live heap, and the heap limit a call completes in (Node)", () => {
  const lay = sb(TEST + "kedlaya_v8.py", "layouts");
  assert.match(lay, /^v8 layouts: all within;/, lay);
  // the smallest --max-old-space-size (MiB) a call completes in, by
  // bisection, less its live heap before the call, is at most U: a
  // completion threshold (transients and the collector's slack included),
  // the acceptance evidence beside the layouts, not a count of live bytes
  const MiB = 1 << 20;
  for (const [p, prec, curve] of [["101", "2", "dense"], ["5", "50", "sparse"], ["97", "3", "dense"]]) {
    const run = (heap: number) =>
      spawnSync(process.execPath, [`--max-old-space-size=${heap}`, "--max-semi-space-size=1", CLI, TEST + "kedlaya_v8.py", "peak", p, prec, curve], { ...opts, timeout: 300000 });
    const first = run(4096);
    const m = /^baseline (\d+) U (\d+)$/m.exec(first.stdout);
    assert.ok(m && first.stdout.includes("done"), first.stdout + first.stderr);
    const [base, U] = [Number(m[1]), Number(m[2])];
    let lo = Math.floor(base / MiB), hi = Math.ceil((base + U) / MiB) + 1;
    const ok = (h: number) => run(h).stdout.includes("done");
    assert.ok(ok(hi), `p = ${p} prec ${prec} ${curve}: not completed in ${hi} MiB (baseline ${base}, U ${U})`);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    console.log(`v8 p = ${p} prec ${prec} ${curve}: completes in ${hi} MiB; baseline ${(base / MiB).toFixed(1)} MiB; U ${(U / MiB).toFixed(2)} MiB`);
    assert.ok(hi * MiB - base <= U + MiB, `p = ${p}: ${hi} MiB - baseline > U + 1 MiB (the bisection's step)`);
  }
});

test("the JavaScriptCore object sizes, under Bun: layout steps, and the live heap at the call's peaks", () => {
  const lay = JSON.parse(execFileSync("bun", [TEST + "kedlaya_jsc.mjs", DIST, "layouts"], opts));
  assert.deepEqual(lay.bad, [], JSON.stringify(lay));
  for (const [p, prec, curve] of [["101", "2", "dense"], ["5", "50", "sparse"]]) {
    const r = JSON.parse(execFileSync("bun", [TEST + "kedlaya_jsc.mjs", DIST, "peak", p, prec, curve], opts));
    console.log(`jsc p = ${p} prec ${prec} ${curve}: the live heap's largest growth at the ${r.hooks} peaks ${r.most}, U ${r.U}`);
    assert.ok(r.hooks > 0 && r.most <= r.U, JSON.stringify(r));
  }
});

// ---- the engine

const probes = (o: Partial<EngineProbes>): EngineProbes => ({ bun: false, denoV8: false, nodeV8: false, callSites: false, internalError: false, userAgent: null, nanSignKept: true, ...o });
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const PW_WEBKIT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const CHROMIUM = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/138.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";

test("js_engine's decision on probe vectors (plan-kedlaya-optin r6's fixtures)", () => {
  const cases: [string, Partial<EngineProbes>, string, string][] = [
    ["Bun's real vector: versions.bun, canonical NaNs, V8's call sites", { bun: true, nodeV8: true, callSites: true, nanSignKept: false }, "jsc", "bun"],
    ["Node", { nodeV8: true, callSites: true }, "v8", "node"],
    ["Deno", { denoV8: true, callSites: true }, "v8", "deno"],
    ["versions.bun and InternalError: the host decides first", { bun: true, internalError: true }, "jsc", "bun"],
    ["Chromium (its user agent says AppleWebKit), call sites", { callSites: true, userAgent: CHROMIUM }, "v8", "browser"],
    ["Firefox: InternalError", { internalError: true, userAgent: FIREFOX }, "spidermonkey", "browser"],
    ["Safari, canonical NaNs", { userAgent: SAFARI, nanSignKept: false }, "jsc", "browser"],
    ["Playwright's WebKit, canonical NaNs", { userAgent: PW_WEBKIT, nanSignKept: false }, "jsc", "browser"],
    ["a WebKit user agent with NaN signs kept: the signals conflict", { userAgent: SAFARI, nanSignKept: true }, "unknown", "browser"],
    ["a WebKit user agent and NaN behaviour unknown", { userAgent: SAFARI, nanSignKept: null }, "unknown", "browser"],
    ["Chrome on iOS (CriOS): no family signal of its own", { userAgent: IOS_CHROME, nanSignKept: false }, "unknown", "browser"],
    ["call sites and InternalError both", { callSites: true, internalError: true }, "unknown", "browser"],
    ["no signal at all", {}, "unknown", "browser"],
    ["an unknown runtime with JSC-like NaNs (no call sites, no InternalError, no WebKit agent, no process or Deno)", { nanSignKept: false }, "unknown", "browser"],
  ];
  for (const [what, o, engine, host] of cases) {
    assert.equal(decideEngine(probes(o)), engine, what);
    assert.equal(decideHost(probes(o)), host, what);
  }
  // the gathering: a probe that throws is no signal
  const hostile = new Proxy({}, { get: () => { throw new Error("no"); } });
  assert.deepEqual(gatherEngineProbes(hostile), { bun: false, denoV8: false, nodeV8: false, callSites: false, internalError: false, userAgent: null, nanSignKept: null });
  assert.equal(decideEngine(gatherEngineProbes(hostile)), "unknown");
});

test("js_engine on the real hosts: Node and Deno V8, Bun JavaScriptCore (its table), and their ledger labels", () => {
  const probe = "import _sbengine, _sage_padic_lseries as L\nprint(_sbengine.js_engine(), _sbengine.js_host(), L._kd_engine())";
  assert.equal(sb("-c", probe), "v8 node v8\n");
  assert.equal(execFileSync("bun", [CLI, "-c", probe], opts), "jsc bun jsc\n");
  assert.equal(execFileSync("deno", ["run", "-A", CLI, "-c", probe], opts), "v8 deno v8\n");
  // and the CPython package's is its own table
  assert.equal(py3("-c", "import sys; sys.path.insert(0, " + JSON.stringify(DIST + "/../lib") + "); import _sage_padic_lseries as L; print(L._kd_engine())"), "cpython\n");
});

// ---- progress and Stop

// a worker computing frobenius(prec) at p for 27a1 while this thread reads
// its progress; Stop (Ctrl-C) once `stage` shows done > 0: the time to
// KeyboardInterrupt, the slot released, and a later call's value
function stopAt(p: number, prec: number, stage: number): Promise<any> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      try {
        const sys = c.R.importModule("sys");
        sys.path.push(c.libDir());
        c.execModule("import sage_all", "<setup>", "__main__");
        parentPort.postMessage({ intr: c.R.INTR.buffer, progress: c.R.progress.buffer.buffer });
        c.execModule([
          "import sys, time, sage_all",
          "from sagebrush import progress",
          "L = sage_all.EllipticCurve('27a1').padic_lseries(" + workerData.p + ")",
          "try:",
          "    L.frobenius(" + workerData.prec + ")",
          "    sys._kd_r = ['finished']",
          "except KeyboardInterrupt:",
          "    t = time.time() * 1000",
          "    left = progress.snapshot()",
          "    phi = sage_all.EllipticCurve('14a1').padic_lseries(5).frobenius(5)",
          "    sys._kd_r = ['interrupted', t, len(left), str(phi.det())]",
        ].join("\\n"), "<run>", "__main__");
        const r = c.R.importModule("sys")._kd_r;
        parentPort.postMessage({ done: [...r].map(String) });
      } catch (e) {
        parentPort.postMessage({ done: ["error", c.R.formatException(e).slice(-800)] });
      }
    });`,
    { eval: true, workerData: { dist: DIST, p, prec } },
  );
  return new Promise((resolve, reject) => {
    let timer: any, sent = 0, seen = "";
    const P = require(DIST + "/src/runtime/progress.js");
    const kill = setTimeout(() => (clearInterval(timer), w.terminate(), resolve({ done: ["timed out"], seen })), 600000);
    w.on("message", (m) => {
      if (m.progress) {
        const buf = new Int32Array(m.progress), intr = new Int32Array(m.intr);
        timer = setInterval(() => {
          for (let i = 0; i < P.SLOTS && !sent; i++) {
            const words = P.read(i, buf);
            if (!words) continue;
            const s = P.decode(words);
            if (s.inUse) seen = `${s.stageIndex}:${s.done}`;
            if (s.inUse && s.stageIndex === stage && s.done > 0) {
              sent = Date.now();
              Atomics.or(intr, 0, 1);
            }
          }
        }, 2);
      }
      if (m.done) (clearTimeout(kill), clearInterval(timer), w.terminate(), resolve({ done: m.done, sent, seen }));
    });
    w.on("error", reject);
  });
}

for (const [what, p, prec, stage] of [
  ["setup: Q^p", 4001, 2, 1],
  ["series", 5, 400, 3],
  // (the plan's p = 401, prec 3 and p = 4001 for stages 4 and 6: the first's
  // reduction lasts 0.2 s in CPython, under progress's 250 ms write
  // interval, and the second reaches stage 6 only after its series, hours
  // in; at p = 1013, prec 1 both stages last 0.5 s or more, in every host)
  ["reduce dx/y", 1013, 1, 4],
  ["check: setup Q^p", 1013, 1, 6],
] as [string, number, number, number][]) {
  test(`Stop during stage ${stage} (${what}), p = ${p}, prec ${prec}: KeyboardInterrupt within 1 s, the slot released, a later call right`, async () => {
    const r = await stopAt(p, prec, stage);
    assert.equal(r.done[0], "interrupted", JSON.stringify(r));
    const ms = Number(r.done[1]) - r.sent;
    console.log(`Stop in stage ${stage} (${what}) at p = ${p}, prec ${prec}: KeyboardInterrupt ${ms.toFixed(0)} ms after Stop`);
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(r.done[2], "0", "progress slots left in use");
    assert.equal(r.done[3], "5^-1 + O(5^4)");
  });
}
