// ci: checks.2 order=61 runner=bun
// The review page's chunk's size gate: the shipped
// web/dist/sagebrush-review.js, as web/build.ts made it with CI's bun, never a synthetic bundle.
//   - its raw bytes and Node's gzip -9 bytes, each under its committed cap (the first reviewed measurement + 64), and
//     both under the absolute ceiling, 96 KiB raw / 32 KiB gzip;
//   - the same entry built again here with the same options gives the same bytes (deterministic), from exactly the
//     reviewed inputs (the census below): an unexpected or bare (package) input fails;
//   - lazy: the Agents and board pages name it only for a dynamic import, never at first paint, and carry none of it;
//   - site-only: the site serves the same bytes; the app has no copy.
//   bun web/build.ts && bun web/workspace/review/test-review-size.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const CEILING_RAW = 96 * 1024, CEILING_GZIP = 32 * 1024;
// (the committed caps: the first reviewed measurement plus 64 bytes each; measured locally with bun
//  1.3.14 at 47,638 / 18,437 (Node gzip -9) before CI's; after the code review's fixes (the board's counts without
//  recursion, the list's bounds, Markdown as text) 48,848 / 18,820 locally: renewed from CI's figures before review)
const CAP_RAW = 48912, CAP_GZIP = 18884;
// (the reviewed inputs, relative to web/: the entry and what it imports; the board's canonical text comes with
//  review-actions.ts's canonical bytes (branch-canon.ts), which an accept of a board needs)
const INPUTS = [
  "board/doc.ts", "board/ink.ts", "board/preview.ts", "board/route.ts", "graph/spring.ts", "image-size.ts",
  "workspace/branch-canon.ts", "workspace/branch-rules.ts", "workspace/branch-store.ts", "workspace/branch-wake.ts",
  "workspace/canon-doc.ts", "workspace/paths.ts", "workspace/review-actions.ts", "workspace/review/board-summary.ts",
  "workspace/review/cells.ts",
  "workspace/review/json-scan.ts", "workspace/review/line-diff.ts", "workspace/review/outputs.ts",
  "workspace/review/review-page.ts", "workspace/review/run-line.ts", "workspace/sha256-hex.ts",
];

const web = join(import.meta.dir, "..", "..");
const dist = join(web, "dist"), chunk = join(dist, "sagebrush-review.js");
const fails = [];
if (!existsSync(chunk)) { console.log("test-review-size: FAIL\n  web/dist/sagebrush-review.js is missing: run bun web/build.ts first"); process.exit(1); }
const js = readFileSync(chunk);
const gz = Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", chunk], { encoding: "utf8" }));
console.log(`test-review-size: web/dist/sagebrush-review.js: ${js.length} B raw (cap ${CAP_RAW}, ceiling ${CEILING_RAW}), ${gz} B gzip -9 by Node (cap ${CAP_GZIP}, ceiling ${CEILING_GZIP})`);
if (js.length > CEILING_RAW) fails.push(`${js.length} B raw is over the ceiling ${CEILING_RAW}`);
if (!(gz > 0) || gz > CEILING_GZIP) fails.push(`${gz} B gzipped is over the ceiling ${CEILING_GZIP}`);
if (js.length > CAP_RAW) fails.push(`${js.length} B raw is over its cap ${CAP_RAW}`);
if (gz > CAP_GZIP) fails.push(`${gz} B gzipped is over its cap ${CAP_GZIP}`);

// (built again, with web/build.ts's options: the same bytes, from exactly the reviewed inputs)
const out = mkdtempSync(join(tmpdir(), "sb-review-size-"));
try {
  const r = await Bun.build({ metafile: true, entrypoints: [join(web, "workspace", "review", "review-page.ts")], outdir: out, naming: "sagebrush-review.js", target: "browser", format: "esm", minify: true });
  if (!r.success) fails.push("the entry doesn't build: " + r.logs.join("; "));
  else {
    if (!readFileSync(join(out, "sagebrush-review.js")).equals(js)) fails.push("web/dist/sagebrush-review.js isn't what its entry builds to now");
    const inputs = Object.keys(r.metafile?.inputs ?? {}).map((p) => relative(web, join(process.cwd(), p)).replace(/\\/g, "/")).sort();
    if (JSON.stringify(inputs) !== JSON.stringify([...INPUTS].sort())) fails.push(`its inputs aren't the reviewed census: ${JSON.stringify(inputs)}`);
  }
} finally { rmSync(out, { recursive: true, force: true }); }

// (lazy: the pages that offer branches name it for a dynamic import and carry none of its code)
for (const f of [join("agents", "agents.js"), join("board", "board.js")]) {
  if (!existsSync(join(dist, f))) { fails.push(`web/dist/${f} is missing`); continue; }
  const page = readFileSync(join(dist, f), "utf8");
  if (!page.includes("sagebrush-review.js")) fails.push(`web/dist/${f} no longer names sagebrush-review.js for its dynamic import`);
  if (/import\s[^;(]*from\s*["'][^"']*sagebrush-review\.js/.test(page)) fails.push(`web/dist/${f} imports sagebrush-review.js at its start`);
  for (const mark of ["unchanged cells", "Too large to compare line by line"]) if (page.includes(mark)) fails.push(`web/dist/${f} carries the review's code (${JSON.stringify(mark)})`);
}
// (site-only: the site serves the same bytes; the app's site-only list names it)
if (existsSync(join(web, "site", "public", "index.html"))) {
  const site = join(web, "site", "public", "sagebrush-review.js");
  if (!existsSync(site) || !readFileSync(site).equals(js)) fails.push("web/site/public/sagebrush-review.js isn't the built chunk");
}
const appBuild = readFileSync(join(web, "..", "app", "build-frontend.mjs"), "utf8");
if (!/"sagebrush-review\.js"/.test(/const SITE_ONLY = new Set\(\[([^\]]*)\]\)/.exec(appBuild)?.[1] ?? "")) fails.push("app/build-frontend.mjs's SITE_ONLY doesn't name sagebrush-review.js");

if (fails.length) { console.log("test-review-size: FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("test-review-size: ok");
