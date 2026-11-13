// ci: checks.2 order=60 runner=bun
// The runs' chunk's size gate (chat plan PR 4a; daybreak2's binding ruling on packet r3, "Code placement and size
// gates"): the shipped web/dist/sagebrush-agent-run.js, as web/build.ts made it with CI's bun, never a synthetic bundle.
//   - its raw bytes and Node's gzip -9 bytes, each under its committed cap (the first reviewed measurement + 64), and
//     both under the absolute ceiling, 64 KiB raw / 24 KiB gzip;
//   - the same entry built again here with the same options gives the same bytes (deterministic), from exactly the
//     reviewed inputs (the census below): an unexpected or bare (package) input fails;
//   - lazy: the notebook page names it only for a dynamic import, never at first paint; the pairing chunk
//     (sagebrush-agent.js) carries none of it;
//   - site-only: the site serves the same bytes; the app has no copy (§6 refuses runs there).
// No edit of scripts/size-measure.mjs: this is its own gate, not an epoch reset.
//   bun web/build.ts && bun web/workspace/test-agent-run-size.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readPage } from "../../scripts/notebook-page.mjs";
import { latexModeName, expectsLatex } from "../latex/build-mode.mjs";

const CEILING_RAW = 64 * 1024, CEILING_GZIP = 24 * 1024;
// (the committed caps: the first reviewed measurement plus 64 bytes each, daybreak2's rule)
// (measured at r3 (r2's reviews: the startup deadline, the documents' permission changes, the queue's count and
//  metadata) on master 733c626a, bun 1.4.4 / node 24.21.0: 17,021 B raw, 6,882 B gzip -9; r2's were 16,372 / 6,653 with
//  caps 16,436 / 6,717, r1's 14,560 / 6,074 with caps 14,624 / 6,138)
// (r7, the fit as a function of its own (fitCells, tested at its boundary), on master 2b09667c: 17,413 / 7,005, caps
//  17,477 / 7,069; r6's were 17,348 / 6,978 with caps 17,412 / 7,042)
// (PR 4b, latex_build's orchestration added (daybreak2's Q1: here, with the LaTeX chunks it uses), on master 4d5e8600:
//  21,770 / 8,540; after the review's fixes (the report fitted within the result, its final check and its last fallback): 23,171 / 9,031)
// (the review page's run note: a finished run in a branch notes its target's blob id (the canonical bytes under the
//  branch's canon, from the run's own snapshot) and wakes the branch's subscribers: 23,171 / 9,031 -> 25,150 / 9,659
//  (+1,979 / +628), measured by CI (bun 1.4.4, Node 24.21.0's gzip -9) on the head merged with master 48f0b854; + 64)
const CAP_RAW = 25214, CAP_GZIP = 9723;
// (latex_build's first use: this chunk and the three LaTeX chunks it fetches (the page module, its tools, Run's code),
//  together, so that moving code between them can't hide growth (daybreak2's Q1 aggregate cap: the landing measurement
//  + 64 each), measured on master 4d4225f9 after the review's fixes: 23,171 + 88,703 + 16,494 + 17,241 = 145,609 raw,
//  9,031 + 30,596 + 6,881 + 7,049 = 53,557 gzip -9)
const LATEX_FIRST_USE = ["sagebrush-agent-run.js", "sagebrush-latex.js", "sagebrush-latex-tools.js", "sagebrush-latex-run.js"];
// (renewed at the landing merge on master 14279164: 145,609 / 53,557 before it -> 147,165 / 54,078 after, +1,556 / +521:
//  inherited from the base's move, #1018 growing the tools chunk +777 / +286, the page module +77 / +57 and Run's chunk
//  +660 / +159; this PR's own +42 / +19, the run chunk's overlay check; + 64)
// (renewed on master e45ae971 for the kept LaTeX view: 147,165 / 54,078 -> 147,506 / 54,193, +341 / +115, the view's
//  eager glue in the page module; + 64)
// (renewed for the review page's run note, in this chunk alone: 147,506 / 54,193 -> 149,443 / 54,802, +1,937 / +609,
//  measured by CI on the head merged with master 48f0b854; + 64)
// (renewed for running code while presenting, daybreak2, Nov 12, after its review fixes: 149,443 / 54,803 -> 150,267 /
//  55,145, +824 / +342, the Run chunk's kept values and the page's stop while presenting, measured on master 4e69d8e4; + 64)
// (renewed for a shared talk's Run on the share page, daybreak2, Nov 12: 150,267 / 55,145 -> 151,131 / 55,371, +864 /
//  +226, Run's chunk +793 / +205 and the page module's +71 / +21, measured on master 8431bd54; + 64; renewed after its
//  review fixes: 151,310 / 55,404, Run's chunk +179 / +33 more, measured on master 9534e419; + 64)
// (renewed for the editor's File ▸ Share…, daybreak2, Nov 12: 151,310 / 55,404 -> 151,420 / 55,457, +110 / +53, the
//  page module's, measured on master 831ff4eb; + 64)
const AGG_RAW = 151484, AGG_GZIP = 55521;
// (the reviewed inputs, relative to web/: the entry and what it imports)
// (the review page's run line: a finished run's note in its branch, canon-doc.ts's canonical bytes and blob id, and branch-wake.ts's
//  wake, which needs sha256-hex.ts for the branch store's name)
const INPUTS = ["workspace/run-verbs.ts", "notebook/confine.js", "workspace/paths.ts", "workspace/agent-grant.ts", "workspace/canon-doc.ts", "workspace/branch-wake.ts", "workspace/sha256-hex.ts"];

const web = join(import.meta.dir, "..");
const dist = join(web, "dist"), chunk = join(dist, "sagebrush-agent-run.js");
const fails = [];
if (!existsSync(chunk)) { console.log("test-agent-run-size: FAIL\n  web/dist/sagebrush-agent-run.js is missing: run bun web/build.ts first"); process.exit(1); }
const js = readFileSync(chunk);
const gz = Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", chunk], { encoding: "utf8" }));
console.log(`test-agent-run-size: web/dist/sagebrush-agent-run.js: ${js.length} B raw (cap ${CAP_RAW}, ceiling ${CEILING_RAW}), ${gz} B gzip -9 by Node (cap ${CAP_GZIP}, ceiling ${CEILING_GZIP})`);
if (js.length > CEILING_RAW) fails.push(`${js.length} B raw is over the ceiling ${CEILING_RAW}`);
if (!(gz > 0) || gz > CEILING_GZIP) fails.push(`${gz} B gzipped is over the ceiling ${CEILING_GZIP}`);
if (CAP_RAW && js.length > CAP_RAW) fails.push(`${js.length} B raw is over its cap ${CAP_RAW}`);
if (CAP_GZIP && gz > CAP_GZIP) fails.push(`${gz} B gzipped is over its cap ${CAP_GZIP}`);
if (!CAP_RAW || !CAP_GZIP) fails.push("the caps aren't set: the first reviewed measurement + 64 each");
// (the aggregate, on the SHIPPED LaTeX build: what latex_build's first use costs a visitor. The build says its mode in
//  version.json (latexMode: "shipped", "test" or "off"); a test build carries the LaTeX tests' seams and hosts, so it
//  isn't measured against these caps. Fail closed: a build that should have the editor and doesn't, a missing chunk,
//  or a page that doesn't name the tools chunk is a failure, never a skipped check)
/** The aggregate's verdict for a build: its mode, the row it prints and its failures. `expectLatex`: the run expects
 *  the editor (SAGEBRUSH_LATEX_PREVIEW unset or "1", the build's own default); `gzip` measures one chunk's bytes. */
export function latexAggregate({ version, page, chunks, expectLatex, gzip }) {
  const fails = [], label = "latex_build's first use";
  const mode = version?.latexMode;
  if (!version) return { mode: null, fails: [`${label}: web/dist/version.json is missing or not JSON`] };
  if (!["shipped", "test", "off"].includes(mode)) return { mode: null, fails: [`${label}: version.json's latexMode is ${JSON.stringify(mode)}, not shipped, test or off`] };
  if (version.latex !== (mode !== "off")) fails.push(`${label}: version.json says latex ${JSON.stringify(version.latex)} with latexMode ${mode}`);
  if (mode === "test") return { mode, fails: [...fails, `${label}: this measures the shipped LaTeX build, and this is a test build; rebuild without SAGEBRUSH_LATEX_PREVIEW=test`] };
  if (mode === "off") {
    if (expectLatex) fails.push(`${label}: this build has no LaTeX editor (latexMode off), and this run expects it`);
    return { mode, fails, row: `${label}: not measured, no LaTeX editor in this build` };
  }
  if (!page.includes('"sagebrush-latex-tools.js"')) fails.push(`${label}: the page doesn't name sagebrush-latex-tools.js, in a build with the editor`);
  let raw = 0, gz = 0;
  for (const f of LATEX_FIRST_USE) {
    const b = chunks[f];
    if (!b) { fails.push(`${label} names ${f}, which the build didn't make`); continue; }
    raw += b.length;
    gz += gzip(f);
  }
  const core = typeof version.core === "string" ? version.core.slice(0, 12) : "unknown";
  if (raw > AGG_RAW) fails.push(`${label}: ${raw} B raw is over its cap ${AGG_RAW}`);
  if (gz > AGG_GZIP) fails.push(`${label}: ${gz} B gzipped is over its cap ${AGG_GZIP}`);
  return { mode, fails, raw, gzip: gz, row: `${label} [shipped build, core ${core}] (${LATEX_FIRST_USE.join(" + ")}): ${raw} B raw (cap ${AGG_RAW}), ${gz} B gzip -9 (cap ${AGG_GZIP})` };
}
const gzipFile = (path) => Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", path], { encoding: "utf8" }));
{
  let version = null;
  try { version = JSON.parse(readFileSync(join(dist, "version.json"), "utf8")); } catch {}
  const chunks = Object.fromEntries(LATEX_FIRST_USE.map((f) => [f, existsSync(join(dist, f)) ? readFileSync(join(dist, f)) : null]));
  const expectLatex = expectsLatex(process.env.SAGEBRUSH_LATEX_PREVIEW);
  // (the page as one file: its script, dist/sagebrush-app.js, back inline where the page names it: scripts/notebook-page.mjs)
  const r = latexAggregate({ version, page: readPage(join(dist, "index.html")).toString("utf8"), chunks, expectLatex, gzip: (f) => gzipFile(join(dist, f)) });
  if (r.row) console.log(`test-agent-run-size: ${r.row}`);
  fails.push(...r.fails);
  // (its controls, on fixtures beside the real build: a shipped fixture passes, so the verdict can't just refuse
  //  everything; each fail-closed case fails with its own reason)
  const small = Object.fromEntries(LATEX_FIRST_USE.map((f) => [f, Buffer.from(f)]));
  const fx = (o) => latexAggregate({ version: { core: "0".repeat(40), latex: true, latexMode: "shipped" }, page: 'x("sagebrush-latex-tools.js")', chunks: small, expectLatex: true, gzip: (f) => small[f].length, ...o });
  const controls = [
    ["a shipped fixture passes", fx({}), (v) => v.fails.length === 0 && v.mode === "shipped" && /\[shipped build, core 000000000000\]/.test(v.row)],
    ["a test build is refused, with how to rebuild", fx({ version: { latex: true, latexMode: "test" } }), (v) => v.fails.some((m) => m.includes("rebuild without SAGEBRUSH_LATEX_PREVIEW=test"))],
    ["a page that doesn't name the tools chunk, with latex true, fails", fx({ page: "" }), (v) => v.fails.some((m) => m.includes("doesn't name sagebrush-latex-tools.js"))],
    ["a missing chunk fails", fx({ chunks: { ...small, "sagebrush-latex-run.js": null } }), (v) => v.fails.some((m) => m.includes("sagebrush-latex-run.js, which the build didn't make"))],
    ["no editor when the run expects one fails", fx({ version: { latex: false, latexMode: "off" } }), (v) => v.fails.some((m) => m.includes("this run expects it"))],
    ["no editor in a build without it (SAGEBRUSH_LATEX_PREVIEW=0) passes, unmeasured", fx({ version: { latex: false, latexMode: "off" }, expectLatex: false }), (v) => v.fails.length === 0 && /not measured/.test(v.row)],
    ["a version.json without latexMode fails", fx({ version: { latex: true } }), (v) => v.fails.some((m) => m.includes("latexMode is undefined"))],
    ["no version.json fails", fx({ version: null }), (v) => v.fails.some((m) => m.includes("version.json is missing"))],
    ["latex and latexMode disagreeing fails", fx({ version: { latex: false, latexMode: "shipped" } }), (v) => v.fails.some((m) => m.includes("says latex false with latexMode shipped"))],
    ["over the raw cap fails", fx({ chunks: { ...small, "sagebrush-latex.js": Buffer.alloc(AGG_RAW) } }), (v) => v.fails.some((m) => m.includes("raw is over its cap"))],
    ["over the gzip cap (raw within its own) fails", fx({ gzip: (f) => (f === "sagebrush-latex.js" ? AGG_GZIP : small[f].length) }), (v) => v.fails.some((m) => m.includes("gzipped is over its cap")) && !v.fails.some((m) => m.includes("raw is over"))],
  ];
  for (const [name, v, ok] of controls) if (!ok(v)) fails.push(`control: ${name}: ${JSON.stringify(v)}`);
  // (the build's mode and the run's expectation, as the build and this check compute them: a test build named
  //  shipped, or a run that ignores SAGEBRUSH_LATEX_PREVIEW, would otherwise go unseen, since CI's checks job sees only
  //  the shipped build)
  const modes = [["1", "shipped"], ["test", "test"], ["0", "off"]];
  for (const [m, want] of modes) if (latexModeName(m) !== want) fails.push(`control: SAGEBRUSH_LATEX_PREVIEW=${m} builds latexMode ${JSON.stringify(latexModeName(m))}, not ${want}`);
  let threw = false;
  try { latexModeName("yes"); } catch { threw = true; }
  if (!threw) fails.push("control: an unknown SAGEBRUSH_LATEX_PREVIEW gives a latexMode instead of stopping the build");
  const expects = [[undefined, true], ["", true], ["1", true], ["0", false], ["test", false]];
  for (const [env, want] of expects) if (expectsLatex(env) !== want) fails.push(`control: SAGEBRUSH_LATEX_PREVIEW=${JSON.stringify(env)} ${want ? "should" : "shouldn't"} expect the editor`);
  console.log(`test-agent-run-size: the aggregate's ${controls.length} controls checked, and the build mode's ${modes.length + 1 + expects.length}`);
}

// (built again, with web/build.ts's options: the same bytes, from exactly the reviewed inputs)
const out = mkdtempSync(join(tmpdir(), "sb-agent-run-size-"));
try {
  const r = await Bun.build({ metafile: true, entrypoints: [join(web, "workspace", "run-verbs.ts")], outdir: out, naming: "sagebrush-agent-run.js", target: "browser", format: "esm", minify: true });
  if (!r.success) fails.push("the entry doesn't build: " + r.logs.join("; "));
  else {
    if (!readFileSync(join(out, "sagebrush-agent-run.js")).equals(js)) fails.push("web/dist/sagebrush-agent-run.js isn't what its entry builds to now");
    const inputs = Object.keys(r.metafile?.inputs ?? {}).map((p) => relative(web, join(process.cwd(), p)).replace(/\\/g, "/")).sort();
    const want = [...INPUTS].sort();
    if (JSON.stringify(inputs) !== JSON.stringify(want)) fails.push(`its inputs aren't the reviewed census: ${JSON.stringify(inputs)} (want ${JSON.stringify(want)})`);
  }
} finally { rmSync(out, { recursive: true, force: true }); }

// (lazy, and not in the pairing chunk)
const page = readPage(join(dist, "index.html")).toString("utf8");
if (!page.includes('"sagebrush-agent-run.js"')) fails.push("index.html no longer names sagebrush-agent-run.js for its dynamic import");
if (/<script[^>]*sagebrush-agent-run\.js|import\s[^;(]*from\s*["'][^"']*sagebrush-agent-run\.js|<link[^>]*sagebrush-agent-run\.js/.test(page)) fails.push("index.html loads sagebrush-agent-run.js at first paint");
const pairing = readFileSync(join(dist, "sagebrush-agent.js"), "utf8");
for (const mark of ["sandbox didn't start", "the files you can read are over"]) if (pairing.includes(mark)) fails.push(`the pairing chunk carries the runs' code (${JSON.stringify(mark)})`);
// (site-only: the site serves the same bytes; the app none)
if (existsSync(join(web, "site", "public", "index.html"))) {
  const site = join(web, "site", "public", "sagebrush-agent-run.js");
  if (!existsSync(site) || !readFileSync(site).equals(js)) fails.push("web/site/public/sagebrush-agent-run.js isn't the built chunk");
}
// (pinned in the app's build, statically: its site-only list names the chunk, so the app never ships it (daybreak2's
//  SIZE-APP-4); and, where the app is built, its output has none)
const appBuild = readFileSync(join(web, "..", "app", "build-frontend.mjs"), "utf8");
const siteOnly = /const SITE_ONLY = new Set\(\[([^\]]*)\]\)/.exec(appBuild)?.[1] ?? "";
if (!/"sagebrush-agent-run\.js"/.test(siteOnly)) fails.push("app/build-frontend.mjs's SITE_ONLY doesn't name sagebrush-agent-run.js");
const app = join(web, "..", "app", "dist");
if (existsSync(app) && existsSync(join(app, "sagebrush-agent-run.js"))) fails.push("the app carries sagebrush-agent-run.js, which it never runs");

if (fails.length) { console.log("test-agent-run-size: FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("test-agent-run-size: ok");
