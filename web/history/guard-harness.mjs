// For a browser test harness (web/**/test-*.mjs): with HISTORY_GUARD=1 the suite runs GUARDED (Stage A layer 1, design
// stage-a-l1 r2.2 §4 [G1, G5]): history's census guard (web/history/guard.js) built beside the page and installed, by a
// module script of its own, before the page's cases load, so every database the suite opens has history active and
// every change by the app's code must carry its token.  After the run: the guard's violations, as failures, and a
// guard that judged nothing is a failure too (it wasn't installed).  Without HISTORY_GUARD, nothing here does anything.
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export const GUARDED = process.env.HISTORY_GUARD === "1";
const here = new URL(".", import.meta.url).pathname;
/** Build the guard into the harness's site directory (guarded runs only). */
export async function buildGuard(site) {
  if (!GUARDED) return;
  const b = await Bun.build({ entrypoints: [join(here, "guard.js")], outdir: site, naming: "guard.js", target: "browser", format: "esm" });
  if (!b.success) throw new Error("the history guard didn't build: " + b.logs.join("\n"));
  writeFileSync(join(site, "guard-install.js"), 'import { installGuard } from "./guard.js";\ninstallGuard();\n');
}
/** The module script that installs it, to put BEFORE the page's own module script ("" when not guarded). */
export const guardScript = () => (GUARDED ? '<script type="module" src="./guard-install.js"></script>' : "");
/** The files the harness's server must serve for it. */
export const guardFiles = GUARDED ? ["/guard.js", "/guard-install.js"] : [];
/** After the run: the guard's verdict, as failure lines (none when not guarded). */
export async function guardFails(ev) {
  if (!GUARDED) return [];
  const g = JSON.parse(await ev("JSON.stringify({ v: window.__historyGuard?.violations ?? null, checked: window.__historyGuard?.checked ?? 0, txs: window.__historyGuard?.txs ?? 0 })"));
  if (g.v === null) return ["history guard: not installed in the page"];
  const out = g.v.slice(0, 50).map((x) => `history guard: ${x.db}/${x.store} changed ${x.ident} (${x.why}) with no token in its transaction`);
  if (g.checked === 0) out.push(`history guard: judged no change at all (${g.txs} transactions): not exercising anything`);
  if (process.env.SHOW) console.log(`history guard: ${g.checked} changes judged in ${g.txs} transactions, ${g.v.length} violations`);
  return out;
}
