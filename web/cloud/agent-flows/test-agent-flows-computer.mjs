// ci: none (the computer surface needs its own job: engine/py built and installed, the site's Miniflare and Chrome)
// The agent-flow cases on the "computer" surface (surface-computer.mjs): the Agents page with the agent on one of the
// person's own computers, through a real relay (the remotes' Worker in Miniflare), a real `sagebrush remote` runner and
// the reviewed sagebrush-agent with its model scripted. The cases are this folder's (cases/*.mjs), in the harness's
// format (web/agent-flows/FORMAT.md), run by the harness's runCases with this surface added; the harness is MIT and
// this folder imports it, never the reverse.
//   SAGEBRUSH_AGENTS=1 SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && (cd engine/py && maturin build --release --out dist) && pip install engine/py/dist/*.whl
//   CHROME=chromium node web/cloud/agent-flows/test-agent-flows-computer.mjs [--case ID]
// PYTHON: the interpreter with that package (python3 by default). SITE_ORIGIN and SITE_COOKIE_FILE: a deployed site
// instead (DEV), its session from a 0600 file. RUNNER_LATE=ms: Chat here is chosen first and the runner started after.
// A case's declared known gap (gaps: { computer: "why" }) is named in the report; the case still fails there.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startChrome, runCases } from "../../agent-flows/harness.mjs";
import { startComputerSite, computerSurface } from "./surface-computer.mjs";

const here = new URL(".", import.meta.url).pathname;
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const onlyCase = arg("--case");

const cases = [];
for (const f of readdirSync(join(here, "cases")).filter((f) => f.endsWith(".mjs")).sort()) {
  const kase = (await import(join(here, "cases", f))).default;
  if (!kase?.id || typeof kase.expect !== "function" || !Array.isArray(kase.surfaces)) { console.log(`FAIL cases/${f}: not a case (id, surfaces, expect)`); process.exit(2); }
  if (kase.surfaces.includes("computer") && (!onlyCase || kase.id === onlyCase)) cases.push(kase);
}
if (!cases.length) { console.log(`FAIL no case on the computer surface${onlyCase ? " named " + onlyCase : ""}`); process.exit(2); }

// (the site and Chrome stopped on every way out: at the end, on a failure to start, and at the process's exit or a
//  signal, Chrome's profile removed; the relay's Miniflare and the surface's runner and agent with them)
let site = null, page = null;
const stopNow = () => { try { page?.killSync(); } catch {} };
process.on("exit", stopNow);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopNow(); process.exit(130); });
// (the surface's close is asynchronous: Disconnect, the agent's process gone, the computer revoked; runCase awaits it
//  within CLEANUP_MS, and what it finds wrong fails the case)
const surfaces = { computer: (s, p) => computerSurface(s, p, { runnerLate: Number(process.env.RUNNER_LATE) || 0 }) };
let results = [], stopped = null;
try {
  site = await startComputerSite(process.env.SITE_ORIGIN ? { site: { origin: process.env.SITE_ORIGIN, cookieFile: process.env.SITE_COOKIE_FILE } } : {});
  page = await startChrome();
  ({ results, stopped } = await runCases(cases, { site, page, only: "computer", surfaces }));
  if (stopped) { console.log(`FAIL ${stopped}`); process.exitCode = 1; }
} catch (e) {
  console.log(`FAIL the harness couldn't run: ${String(e?.message ?? e).slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  await page?.close().catch(() => page?.killSync());
  await site?.close();
}
console.log("\n---- agent flows on the computer surface");
for (const r of results) {
  if (r.gap && r.failures.length) console.log(`FAIL ${r.id} on computer (${r.s} s): ${r.failures.length} failed check(s); declared known gap: ${r.gap}`);
  else if (r.gap) console.log(`ok   ${r.id} on computer (${r.s} s): it passes now, so take its gap out of the case (${r.gap})`);
  else console.log(`${r.failures.length ? "FAIL" : "ok  "} ${r.id} on computer (${r.s} s)${r.failures.length ? ": " + r.failures.length + " failed check(s)" : ""}`);
}
const failed = results.filter((r) => r.failures?.length), gaps = failed.filter((r) => r.gap);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} case runs${gaps.length ? ` (${gaps.length} of them with a declared known gap)` : ""}` : process.exitCode ? "FAIL: the harness didn't run its cases" : `ok: ${results.length} case runs`);
process.exit(failed.length || process.exitCode ? 1 : 0);
