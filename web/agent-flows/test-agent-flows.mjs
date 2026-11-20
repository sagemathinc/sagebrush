// ci: web-browser/latex order=90 runner=bun chrome
// The agent-flow scenarios (web/agent-flows/cases/*.mjs; the format in web/agent-flows/FORMAT.md): each case on each
// surface it names. Every release passes all of them.
// A case may name a known gap on a surface (gaps: { chat: "why" }): it still runs, and still fails there; the report
// names the declared gap (it doesn't say which checks it covers), and once the case passes, says to take it out.
//   SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && CHROME=chromium bun web/agent-flows/test-agent-flows.mjs [--case ID] [--surface mcp|chat]
// SHOT_DIR=dir: a screenshot at each h.shot(name).
// (in CI with the LaTeX editor's page tests, web-browser/latex: their build is the editor's test build, which the cases with
//  a .tex need, as above)
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startSite, startChrome, runCases, SURFACES } from "./harness.mjs";

const here = new URL(".", import.meta.url).pathname;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const onlyCase = arg("--case"), onlySurface = arg("--surface");
if (onlySurface && !SURFACES[onlySurface]) { console.log(`FAIL no surface ${onlySurface}: ${Object.keys(SURFACES).join(", ")}`); process.exit(2); }

const cases = [];
for (const f of readdirSync(join(here, "cases")).filter((f) => f.endsWith(".mjs")).sort()) {
  const kase = (await import(join(here, "cases", f))).default;
  if (!kase?.id || typeof kase.expect !== "function" || !Array.isArray(kase.surfaces)) { console.log(`FAIL cases/${f}: not a case (id, surfaces, expect)`); process.exit(2); }
  if (!onlyCase || kase.id === onlyCase) cases.push(kase);
}
if (!cases.length) { console.log(`FAIL no case${onlyCase ? " " + onlyCase : ""}`); process.exit(2); }

// (the site and Chrome stopped on every way out: at the end, on a failure to start, and at the process's exit or a
//  signal, Chrome's profile removed)
let site = null, page = null;
const stopNow = () => { try { page?.killSync(); } catch {} try { site?.kill(); } catch {} };
process.on("exit", stopNow);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopNow(); process.exit(130); });
let results = [], stopped = null;
try {
  site = await startSite();
  page = await startChrome();
  ({ results, stopped } = await runCases(cases, { site, page, only: onlySurface }));
  if (stopped) { console.log(`FAIL ${stopped}`); process.exitCode = 1; }
} catch (e) {
  console.log(`FAIL the harness couldn't run: ${String(e?.message ?? e).slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  // (Chrome killed and its profile removed: so a case that didn't settle loses the page with it)
  await page?.close().catch(() => page?.killSync());
  site?.close();
}
console.log("\n---- agent flows");
for (const r of results) {
  if (r.skipped) console.log(`skip ${r.id} on ${r.surface}: ${r.skipped}`);
  else if (r.gap && r.failures.length) console.log(`FAIL ${r.id} on ${r.surface} (${r.s} s): ${r.failures.length} failed check(s); declared known gap: ${r.gap}`);
  else if (r.gap) console.log(`ok   ${r.id} on ${r.surface} (${r.s} s): it passes now, so take its gap out of the case (${r.gap})`);
  else console.log(`${r.failures.length ? "FAIL" : "ok  "} ${r.id} on ${r.surface} (${r.s} s)${r.failures.length ? ": " + r.failures.length + " failed check(s)" : ""}`);
}
const failed = results.filter((r) => r.failures?.length), gaps = failed.filter((r) => r.gap);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} case runs${gaps.length ? ` (${gaps.length} of them with a declared known gap)` : ""}` : process.exitCode ? "FAIL: the harness didn't run its cases" : `ok: ${results.length} case runs`);
process.exit(failed.length || process.exitCode ? 1 : 0);
