// ci: web-runner order=187 runner=bun chrome
// The agent-flow scenarios (web/agent-flows/cases/*.mjs; the format in web/agent-flows/FORMAT.md): each case on each
// surface it names. Every release passes all of them.
// A case may name a known gap on a surface (gaps: { chat: "why" }): it still runs, and still fails there; the report
// says it is the known gap, and once it passes, to take the gap out of the case.
//   bun web/build.ts && CHROME=chromium bun web/agent-flows/test-agent-flows.mjs [--case ID] [--surface mcp|chat]
// SHOT_DIR=dir: a screenshot at each h.shot(name).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startSite, startChrome, runCase, SURFACES } from "./harness.mjs";

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

const site = await startSite();
const page = await startChrome();
const results = [];
try {
  for (const kase of cases) {
    for (const s of kase.surfaces) {
      if (onlySurface && s !== onlySurface) continue;
      if (!SURFACES[s]) { results.push({ id: kase.id, surface: s, skipped: `no surface ${s} in this harness yet` }); continue; }
      const t = Date.now();
      console.log(`---- ${kase.id} on ${s}: "${kase.prompt}"`);
      const failures = await runCase(kase, s, { site, page });
      results.push({ id: kase.id, surface: s, failures, gap: kase.gaps?.[s] ?? null, s: ((Date.now() - t) / 1000).toFixed(1) });
    }
  }
} finally {
  await page.close();
  site.close();
}
console.log("\n---- agent flows");
for (const r of results) {
  if (r.skipped) console.log(`skip ${r.id} on ${r.surface}: ${r.skipped}`);
  else if (r.gap && r.failures.length) console.log(`FAIL ${r.id} on ${r.surface} (${r.s} s): ${r.failures.length} failed check(s), the known gap: ${r.gap}`);
  else if (r.gap) console.log(`ok   ${r.id} on ${r.surface} (${r.s} s): it passes now, so take its gap out of the case (${r.gap})`);
  else console.log(`${r.failures.length ? "FAIL" : "ok  "} ${r.id} on ${r.surface} (${r.s} s)${r.failures.length ? ": " + r.failures.length + " failed check(s)" : ""}`);
}
const failed = results.filter((r) => r.failures?.length), gaps = failed.filter((r) => r.gap);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} case runs${gaps.length ? ` (${gaps.length} of them a known gap)` : ""}` : `ok: ${results.length} case runs`);
process.exit(failed.length ? 1 : 0);
