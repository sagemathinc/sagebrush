// ci: none (new with the editor's Run: a wiring candidate for the web-latex follow-up, runner=node after build-cli, about 10 s)
// The editor's Run (run-core.mjs), without a browser: the session's script run in the CLI's own Sage (the same
// engine's Python and preparser as the page's runner), its printed results parsed and turned into the results file's
// states; then those states shown by the renderer's own rule (sagetex.mjs savedStates/stateOf). William's case: a
// value, a computation, a name defined again later (page order), a failing item whose later readers show Sage's
// NameError and the rest still run, a plot as an SVG; and the parts alone: refused items, a session that stopped,
// unreadable lines, bounds, a traceback without the script's frames.
//   node scripts/build-cli.mjs && node web/latex/test-latex-run.mjs
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { driver, runnable, parseOutput, statesOf, resultsText, msgOf, MARK, RUN_LIMITS, RESULTS_FORMAT } from "./run-core.mjs";
import { itemKey, savedStates, stateOf, WRAPPER_VERSION, MAX_RESULT } from "./engine/sagetex.mjs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
// (an item as the worker's check sends it: its key, and its code unless refused)
// (the renderer's item, as itemOf makes it: a refused one has no code)
const real = (mode, code, extra = {}) => (extra.err ? { mode, opts: [], ...extra } : { mode, code, opts: [] });
const item = (mode, code, extra = {}) => { const it = real(mode, code, extra); return { mode, err: it.err ?? null, key: itemKey(it), ...(it.err ? {} : { code }), ...(it.name ? { name: it.name } : {}) }; };

// ---- the parts alone
{
  const its = [item("silent", "x = 1"), item("sage", "x", { err: "cs", name: "foo" }), item("sage", "x")];
  check("runnable: refused items aren't sent", JSON.stringify(runnable(its)) === JSON.stringify([{ mode: "silent", code: "x = 1" }, { mode: "sage", code: "x" }]), runnable(its));
  const st = statesOf(its, [{ s: "ok" }, { s: "ok", latex: "1" }], "");
  check("statesOf: a refused item says why, the next one is the next result", st[1].s === "error" && /TeX command/.test(st[1].msg) && st[2].s === "ok" && st[2].latex === "1", st);
  check("statesOf: every state has its item's key", st.every((s, k) => s.key === its[k].key), st);
  const cut = statesOf([item("silent", "a"), item("sage", "b")], [{ s: "ok" }], "the run was stopped");
  check("statesOf: an item after the session stopped says so", cut[1].s === "error" && cut[1].msg === "not run: the run was stopped", cut);
  const big = statesOf([item("sage", "b")], [{ s: "ok", latex: "x".repeat(MAX_RESULT + 1) }], "");
  check("statesOf: a result over MAX_RESULT is an error", big[0].s === "error" && /over/.test(big[0].msg), big);
  const notSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<script>alert(1)</script>" }], "");
  check("statesOf: a plot that isn't an SVG is an error", notSvg[0].s === "error" && !notSvg[0].src, notSvg);
  const bigSvg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg>" + "x".repeat(RUN_LIMITS.svg) }], "");
  check("statesOf: a plot over the SVG limit is an error", bigSvg[0].s === "error", bigSvg);
  const svg = statesOf([item("plot", "p")], [{ s: "ok", svg: "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>" }], "");
  check("statesOf: a plot becomes a base64 SVG data URL (UTF-8)", svg[0].s === "ok" && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+=*$/.test(svg[0].src) && Buffer.from(svg[0].src.split(",")[1], "base64").toString() === "<svg xmlns='http://www.w3.org/2000/svg'>é</svg>", svg);
  const out = `hello\n${MARK}{"s": "ok"}\n${MARK}not json\n${MARK}3\nbye`;
  const got = parseOutput(out);
  check("parseOutput: only marked lines; an unreadable one is an error", got.length === 3 && got[0].s === "ok" && got[1].s === "error" && got[2].s === "error", got);
  const tb = 'Traceback (most recent call last):\n  File "<cell>", line 15, in <module>\n    _sbtx_r = {"s": "ok"}\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined\n';
  check("msgOf: the script's own frames are dropped", msgOf(tb) === 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n    y\nNameError: name \'y\' is not defined', msgOf(tb));
  const j = JSON.parse(resultsText(st));
  check("resultsText: results v1 of this wrapper", j.format === RESULTS_FORMAT && j.version === 1 && j.wrapper === WRAPPER_VERSION && j.items.length === 3, j);
  // (the code reaches the script only as base64: quotes, newlines and backslashes can't end its string)
  const evil = '"); import os; ("\n\\x1eSBTX{}';
  const d = driver([{ mode: "silent", code: evil }]);
  check("driver: code only as base64", !d.includes("import os") && !d.includes('"); '), d.slice(0, 200));
}

// ---- the script in Sage (the CLI's own: build/cli/pyjs.cjs --sage)
const CLI = new URL("../../build/cli/pyjs.cjs", import.meta.url).pathname;
if (!existsSync(CLI)) {
  console.log("FAIL: no build/cli/pyjs.cjs: run node scripts/build-cli.mjs first");
  process.exit(1);
}
const sage = (code) => new Promise((res) => {
  const dir = mkdtempSync(join(tmpdir(), "sb-latex-run-")), f = join(dir, "run.sage");
  writeFileSync(f, code);
  const p = spawn(process.execPath, [CLI, "--sage", f], { cwd: dir });
  let o = "", e = "";
  p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (e += x));
  p.on("close", (c) => { rmSync(dir, { recursive: true, force: true }); res({ code: c, out: o, err: e }); });
});
{
  const spec = [
    ["silent", "var('t')\nx = 2^10"],
    ["sage", "x"],
    ["sage", "integrate(t^2, t, 0, 1)"],
    ["silent", "y = 1/0"],
    ["sage", "y"],
    ["sage", "x", { err: "cs", name: "foo" }],
    ["block", "x = 7\nprint('not a result')"],
    ["sage", "x"],
    ["plot", "plot(sin(t), (t, 0, 3))"],
  ];
  const its = spec.map((a) => item(...a)), reals = spec.map((a) => real(...a));
  const r = await sage(driver(runnable(its)));
  const st = statesOf(its, parseOutput(r.out), "");
  const show = (k) => stateOf(savedStates(reals, st), k, reals[k]);
  check("sage: the session ran", r.code === 0, r.err.slice(-600));
  check("sage: \\sage{x} is 1024", st[1].s === "ok" && st[1].latex === "1024", st[1]);
  check("sage: integrate is \\frac{1}{3}", st[2].s === "ok" && st[2].latex === "\\frac{1}{3}", st[2]);
  check("sage: 1/0 shows ZeroDivisionError", st[3].s === "error" && /ZeroDivisionError/.test(st[3].msg) && !/<cell>|_sbtx_/.test(st[3].msg), st[3]);
  check("sage: a later reader of y shows Sage's NameError", st[4].s === "error" && /NameError: name 'y' is not defined/.test(st[4].msg), st[4]);
  check("sage: a refused item says why", st[5].s === "error" && /TeX command/.test(st[5].msg), st[5]);
  check("sage: the rest still run after failures", st[6].s === "ok", st[6]);
  check("sage: x defined again later is 7 (page order)", st[7].s === "ok" && st[7].latex === "7", st[7]);
  check("sage: an item's own printing isn't a result", !r.out.split("\n").some((l) => l === "not a result"), r.out.slice(0, 300));
  check("sage: the plot is an SVG data URL", st[8].s === "ok" && /^data:image\/svg\+xml;base64,/.test(st[8].src ?? ""), { ...st[8], src: String(st[8].src).slice(0, 80) });
  check("sage: every state is shown by the renderer's rule (keys match, in order)", savedStates(reals, st).length === its.length, null);
  check("sage: the renderer shows 1024 for item 2", show(1).s === "ok" && show(1).latex === "1024", show(1));
  // a second Run in the same session starts from the session's first globals: a name of the first Run is gone
  const two = await sage(driver([{ mode: "silent", code: "z = 5" }]) + driver([{ mode: "sage", code: "z" }]));
  const g2 = parseOutput(two.out);
  check("sage: a second Run doesn't see the first Run's names", g2.length === 2 && g2[0].s === "ok" && g2[1].s === "error" && /NameError/.test(g2[1].msg), g2);
  // (and a Sage name the first Run redefined, or a var() it made, is as Sage has it again)
  const three = await sage(driver([{ mode: "silent", code: "x = 7\nvar('w')" }]) + driver([{ mode: "sage", code: "x" }, { mode: "sage", code: "w" }]));
  const g3 = parseOutput(three.out);
  check("sage: a second Run sees Sage's own x, not the first Run's", g3.length === 3 && g3[1].s === "ok" && g3[1].latex === "x" && g3[2].s === "error" && /NameError/.test(g3[2].msg), g3);
}

const bad = results.filter(([, ok]) => !ok);
console.log(`${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
