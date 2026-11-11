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

const CEILING_RAW = 64 * 1024, CEILING_GZIP = 24 * 1024;
// (the committed caps: the first reviewed measurement plus 64 bytes each, daybreak2's rule)
// (measured at r3 (r2's reviews: the startup deadline, the documents' permission changes, the queue's count and
//  metadata) on master 733c626a, bun 1.4.4 / node 24.21.0: 17,021 B raw, 6,882 B gzip -9; r2's were 16,372 / 6,653 with
//  caps 16,436 / 6,717, r1's 14,560 / 6,074 with caps 14,624 / 6,138)
// (r7, the fit as a function of its own (fitCells, tested at its boundary), on master 2b09667c: 17,413 / 7,005, caps
//  17,477 / 7,069; r6's were 17,348 / 6,978 with caps 17,412 / 7,042)
// (PR 4b, latex_build's orchestration added (daybreak2's Q1: here, with the LaTeX chunks it uses), on master 4d5e8600:
//  21,770 / 8,540; after the review's fixes (the report fitted within the result, its final check and its last fallback): 23,171 / 9,031)
const CAP_RAW = 23235, CAP_GZIP = 9095;
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
const AGG_RAW = 147570, AGG_GZIP = 54257;
// (the reviewed inputs, relative to web/: the entry and what it imports)
const INPUTS = ["workspace/run-verbs.ts", "notebook/confine.js", "workspace/paths.ts", "workspace/agent-grant.ts"];

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
// (the aggregate, in a build with the LaTeX editor (its page names the LaTeX chunks for latex_build): each present)
if (readFileSync(join(dist, "index.html"), "utf8").includes('"sagebrush-latex-tools.js"')) {
  let raw = 0, gzip = 0;
  for (const f of LATEX_FIRST_USE) {
    if (!existsSync(join(dist, f))) { fails.push(`latex_build's first use names ${f}, which the build didn't make`); continue; }
    raw += readFileSync(join(dist, f)).length;
    gzip += Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", join(dist, f)], { encoding: "utf8" }));
  }
  console.log(`test-agent-run-size: latex_build's first use (${LATEX_FIRST_USE.join(" + ")}): ${raw} B raw (cap ${AGG_RAW}), ${gzip} B gzip -9 (cap ${AGG_GZIP})`);
  if (raw > AGG_RAW) fails.push(`latex_build's first use: ${raw} B raw is over its cap ${AGG_RAW}`);
  if (gzip > AGG_GZIP) fails.push(`latex_build's first use: ${gzip} B gzipped is over its cap ${AGG_GZIP}`);
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
const page = readFileSync(join(dist, "index.html"), "utf8");
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
