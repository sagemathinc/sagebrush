// ci: none (the computer surface needs its own job: engine/py built and installed, the site's Miniflare; it is added when the harness merges)
// The agent-flow cases on the "computer" surface (surface-computer.mjs): the Agents page with the agent on one of the
// person's own computers, through a real relay (the remotes' Worker in Miniflare), a real `sagebrush remote` runner and
// the reviewed sagebrush-agent with its model scripted. Its own job: it needs this tree's engine/py built and installed
// (the runner signs with the engine's native ES256) besides the site and Chrome.
//   SAGEBRUSH_AGENTS=1 SAGEBRUSH_LATEX_PREVIEW=test bun web/build.ts && (cd engine/py && maturin build --release --out dist) && pip install engine/py/dist/*.whl
//   CHROME=chromium node web/agent-flows/test-agent-flows-computer.mjs [--case ID]
// PYTHON: the interpreter with that package (python3 by default). SITE_ORIGIN and SITE_COOKIE_FILE: a deployed site
// instead (DEV), its session from a 0600 file. RUNNER_LATE=ms: Chat here is chosen first and the runner started after.
// A case's declared known gap (gaps: { computer: "why" }) is named in the report; the case still fails there.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { startChrome, runCase, SURFACES, PANE_CELLS, sleep } from "./harness.mjs";
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
if (!cases.length && onlyCase !== "pane-reader") { console.log(`FAIL no case on the computer surface${onlyCase ? " named " + onlyCase : ""}`); process.exit(2); }

const site = await startComputerSite(process.env.SITE_ORIGIN ? { site: { origin: process.env.SITE_ORIGIN, cookieFile: process.env.SITE_COOKIE_FILE } } : {});
const page = await startChrome();
// (the surface's close is asynchronous: Disconnect, the agent's process gone, the computer revoked; runCase awaits it,
//  and what it finds wrong fails the case)
SURFACES.computer = (s, p) => computerSurface(s, p, { runnerLate: Number(process.env.RUNNER_LATE) || 0 });
const results = [];

/** The pane reader (PANE_CELLS) on this surface, both ways, with no self-run involved: the agent's notebook under a grant
 * without May run code reads as no outputs at all; after the person presses Run on each cell, it reads as the list and
 * the plot, as the person sees them. */
async function paneReader() {
  const failures = [];
  const ok = (c, msg, detail) => { console.log((c ? "ok   " : "FAIL ") + "[pane-reader computer] " + msg + (c || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 400))); if (!c) failures.push(msg); };
  const read = async () => (await page.ev(PANE_CELLS).catch(() => null)) ?? null;
  const judge = (cells) => {
    const outs = (cells ?? []).flat();
    const text = outs.map((o) => o.text ?? o.data?.["text/plain"] ?? "").join("\n");
    return { cells: cells?.length ?? 0, outputs: outs.length, images: outs.filter((o) => o.data && Object.keys(o.data).some((k) => k.startsWith("image/"))).length, errors: outs.filter((o) => o.output_type === "error").length, text: text.slice(0, 200) };
  };
  await page.fresh(site.origin);
  const surface = await SURFACES.computer(site, page);
  const path = "/pane-check.ipynb";
  try {
    await surface.connect({ folders: ["/"], write: true, run: false });
    await surface.beginTurn("make a notebook for the pane check");
    const r = await surface.tool("workspace_create", { path, mode: "python", content: { json: { cells: [
      { code: "print(list(range(5)))" },
      { code: "import matplotlib.pyplot as plt\nplt.plot([0, 1, 4, 9])\nplt.show()" },
    ] } } });
    await surface.endTurn();
    ok(!r.isError, "the agent made the notebook", r.text.slice(0, 200));
    ok(await page.until(`(${surface.shownPath}) === ${JSON.stringify(path)} && document.querySelectorAll(".pane-body .cell").length === 2`, 30000), "it is shown in the pane, its two cells rendered");
    // (negative: nothing has run it, so the reader finds the cells and no output in any)
    await sleep(1500);
    const before = judge(await read());
    ok(before.cells === 2 && before.outputs === 0, "before anyone runs it, the pane reader finds its 2 cells and no outputs", before);
    // (positive: the person's Run on each cell, in order)
    for (const i of [0, 1]) {
      await page.ev(`([...document.querySelectorAll(".pane-body .cell")][${i}].querySelector("button[title^=Run]").click(), true)`);
      await page.until(`(() => { const c = [...document.querySelectorAll(".pane-body .cell")][${i}]; return !!c && !c.classList.contains("running") && !!c.querySelector(${i === 0 ? '"pre.txt"' : '"*"'}); })()`, 60000);
    }
    let after = null;
    for (const t = Date.now(); Date.now() - t < 60000; await sleep(300)) {
      after = judge(await read());
      if (after.images >= 1 && /\[0, 1, 2, 3, 4\]/.test(after.text)) break;
    }
    ok(after.images === 1 && after.errors === 0 && /\[0, 1, 2, 3, 4\]/.test(after.text), "after the person's Run on each cell, it reads the list and one plot, no error", after);
  } catch (e) {
    ok(false, "threw: " + String(e?.stack ?? e).slice(0, 400));
  } finally {
    for (const f of (await surface.close()) ?? []) ok(false, f);
  }
  return failures;
}

try {
  if (!onlyCase || onlyCase === "pane-reader") {
    const t = Date.now();
    console.log("---- pane-reader on computer: the pane reader, before and after the person's Run");
    results.push({ id: "pane-reader", failures: await paneReader(), gap: null, s: ((Date.now() - t) / 1000).toFixed(1) });
  }
  for (const kase of cases) {
    const t = Date.now();
    console.log(`---- ${kase.id} on computer: "${kase.prompt}"`);
    const failures = await runCase(kase, "computer", { site, page });
    results.push({ id: kase.id, failures, gap: kase.gaps?.computer ?? null, s: ((Date.now() - t) / 1000).toFixed(1) });
  }
} finally {
  await page.close();
  await site.close();
}
console.log("\n---- agent flows on the computer surface");
for (const r of results) {
  if (r.gap && r.failures.length) console.log(`FAIL ${r.id} on computer (${r.s} s): ${r.failures.length} failed check(s); declared known gap: ${r.gap}`);
  else if (r.gap) console.log(`ok   ${r.id} on computer (${r.s} s): it passes now, so take its gap out of the case (${r.gap})`);
  else console.log(`${r.failures.length ? "FAIL" : "ok  "} ${r.id} on computer (${r.s} s)${r.failures.length ? ": " + r.failures.length + " failed check(s)" : ""}`);
}
const failed = results.filter((r) => r.failures.length), gaps = failed.filter((r) => r.gap);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length} case runs${gaps.length ? ` (${gaps.length} of them with a declared known gap)` : ""}` : `ok: ${results.length} case runs`);
process.exit(failed.length ? 1 : 0);
