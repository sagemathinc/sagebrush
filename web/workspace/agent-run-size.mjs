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
//   bun web/build.ts && bun web/workspace/agent-run-size.mjs
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const CEILING_RAW = 64 * 1024, CEILING_GZIP = 24 * 1024;
// (the committed caps: the first reviewed measurement plus 64 bytes each, daybreak2's rule)
// (first measured on chat-pr4a merged with master 7ebd72f4, bun 1.4.4 / node 24.21.0: 14,560 B raw, 6,074 B gzip -9)
const CAP_RAW = 14624, CAP_GZIP = 6138;
// (the reviewed inputs, relative to web/: the entry and what it imports)
const INPUTS = ["workspace/run-verbs.ts", "notebook/confine.js", "workspace/paths.ts", "workspace/agent-grant.ts"];

const web = join(import.meta.dir, "..");
const dist = join(web, "dist"), chunk = join(dist, "sagebrush-agent-run.js");
const fails = [];
if (!existsSync(chunk)) { console.log("agent-run-size: FAIL\n  web/dist/sagebrush-agent-run.js is missing: run bun web/build.ts first"); process.exit(1); }
const js = readFileSync(chunk);
const gz = Number(execFileSync("node", ["-e", "process.stdout.write(String(require('zlib').gzipSync(require('fs').readFileSync(process.argv[1]), { level: 9 }).length))", chunk], { encoding: "utf8" }));
console.log(`agent-run-size: web/dist/sagebrush-agent-run.js: ${js.length} B raw (cap ${CAP_RAW}, ceiling ${CEILING_RAW}), ${gz} B gzip -9 by Node (cap ${CAP_GZIP}, ceiling ${CEILING_GZIP})`);
if (js.length > CEILING_RAW) fails.push(`${js.length} B raw is over the ceiling ${CEILING_RAW}`);
if (!(gz > 0) || gz > CEILING_GZIP) fails.push(`${gz} B gzipped is over the ceiling ${CEILING_GZIP}`);
if (CAP_RAW && js.length > CAP_RAW) fails.push(`${js.length} B raw is over its cap ${CAP_RAW}`);
if (CAP_GZIP && gz > CAP_GZIP) fails.push(`${gz} B gzipped is over its cap ${CAP_GZIP}`);
if (!CAP_RAW || !CAP_GZIP) fails.push("the caps aren't set: the first reviewed measurement + 64 each");

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
const app = join(web, "..", "app", "dist");
if (existsSync(app) && existsSync(join(app, "sagebrush-agent-run.js"))) fails.push("the app carries sagebrush-agent-run.js, which it never runs");

if (fails.length) { console.log("agent-run-size: FAIL\n  " + fails.join("\n  ")); process.exit(1); }
console.log("agent-run-size: ok");
