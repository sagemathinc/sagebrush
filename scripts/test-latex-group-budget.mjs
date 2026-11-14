// ci: web-artifacts.1 order=5
// The LaTeX group's absolute ceiling (scripts/latex-group.mjs, the site asset budget's check 4), in CI: on the DEV
// web/dist this job has just built (bun web/build.ts; the LaTeX editor is in a build by default), the group's JS must
// be within LATEX_CAPS, raw and gzip, and each lazy chunk within its own cap (LATEX_LAZY_CAPS). Before it, small synthetic trees check the measure itself: at the cap passes, one
// byte over (raw, or gzip) fails, an empty group fails, and the lazy chunks are left out.
//   bun web/build.ts && node scripts/test-latex-group-budget.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { latexGroup, latexLazy, LATEX_CAPS, LATEX_LAZY, LATEX_LAZY_CAPS, gz } from "./latex-group.mjs";

const fails = [];
let checks = 0;
const check = (ok, what, detail) => { checks++; console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : " " + JSON.stringify(detail)}`); if (!ok) fails.push(what); };

// (a web/ tree's files: "dist/..." to the file on disk, as the site asset budget's inventory gives them)
function files(web) {
  const out = new Map();
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.set(relative(web, p), p);
    }
  })(join(web, "dist"));
  return out;
}

// ---- the caps themselves, as approved (a change to them is a ruling: this line changes with it)
check(LATEX_CAPS.raw === 249317 && LATEX_CAPS.gzip === 83380, "the caps are 249,317 B raw and 83,380 B gzip (2026-11-13, the LaTeX editor's bar in the notebook's colours and buttons with its Share button, and math typeset in the same step as its text: its measurement + 64; 246,769 / 82,596 before, daybreak2, 2026-11-12, the editor's File ▸ Share…: its measurement + 64; 246,659 / 82,543 before, daybreak2, 2026-11-12, a shared talk on the share page: its measurement + 64; 246,588 / 82,522 before, daybreak2, 2026-11-12, running code while presenting, renewed after its review fixes: its measurement + 64; 246,016 / 82,328 before, daybreak2, 2026-11-12, a Sage table() drawn as a table: its measurement + 64; 244,777 / 81,787 before, daybreak2, 2026-11-11, the view kept and put back (V1): its landing measurement + 64; 244,388 / 81,635 for Magma in LaTeX; 242,382 B raw and 79.5 KiB gzip before: the preview keeping its place, and @sagebrush's 2026-11-04 gzip cap for the LaTeX fidelity queue)", LATEX_CAPS);

// (and each lazy chunk's, as ruled: comments 16/6, comments-doc 40/16, agent 47,645 / 16,403 B (daybreak2, 2026-11-10,
//  for #986 r2: the grant's "May run code"; 45,952 / 16,000 for #957 r3, 44/15.5 by @sagebrush, 2026-11-04, before), tools
//  16/6, present 16/6, run 19,644 / 7,812 B (daybreak2, Nov 12, a shared talk's Run on the share page, renewed after its review fixes: its measurement + 64; 19,465 / 7,779 B before; 18,672 / 7,574 B, daybreak2, Nov 12, running code while presenting, renewed after its review fixes: its measurement + 64; 17,965 / 7,272 B, daybreak2, Nov 11, Magma in LaTeX: its landing measurement + 64; 17/7 KiB on Nov 8, the Beamer plan's PR 3; 15.5/6.5 for #804 before, 12/5.25 before
//  that), interact 5/2.5 (the same design, measured), in KiB)
// (tools 16,546 / 6,950 B: daybreak2's Q1 ruling for chat plan PR 4b, Nov 11 2026: latex_build's own code moved here out
//  of the eager group, its landing measurement + 64; was 16/6 KiB)
// (tools 17,335 / 7,231 B: renewed at the landing merge on master 14279164, 17,271 / 7,167 measured + 64; its +777 / +286
//  over 16,494 / 6,881 is inherited from #1018's shared check and tools changes)
const lazyPinned = { COMMENTS: [16384, 6144], COMMENTS_DOC: [40960, 16384], AGENT: [49666, 16943], TOOLS: [17335, 7231], PRESENT: [16384, 6144], DOC: [3584, 1792], EXAMPLES: [13312, 6144], BEAMER: [8192, 3584], PYTHONTEX: [5120, 2304], RUN: [19644, 7812], INTERACT: [9453, 3805], VIEW: [3378, 1672], SHARE: [3853, 2021] };
check(JSON.stringify(Object.fromEntries(Object.entries(LATEX_LAZY_CAPS).map(([k, c]) => [k, [c.raw, c.gzip]]))) === JSON.stringify(lazyPinned), "each lazy chunk's cap as ruled", LATEX_LAZY_CAPS);

// ---- the measure, on synthetic trees
const tmp = mkdtempSync(join(tmpdir(), "latex-group-"));
const tree = (name, members) => {
  const web = join(tmp, name);
  mkdirSync(join(web, "dist"), { recursive: true });
  for (const [f, bytes] of Object.entries(members)) writeFileSync(join(web, "dist", f), bytes);
  return latexGroup(files(web));
};
try {
  // (zeros: tiny gzip, so only raw is near its cap; random bytes: gzip about raw, so only gzip is near its cap)
  const zeros = (n) => Buffer.alloc(n);
  const atRaw = tree("at-raw", { "sagebrush-latex.js": zeros(LATEX_CAPS.raw - 100), "sagebrush-latex-worker.js": zeros(100) });
  check(atRaw.ok && atRaw.raw === LATEX_CAPS.raw, "a group exactly at the raw cap passes", { raw: atRaw.raw });
  const overRaw = tree("over-raw", { "sagebrush-latex.js": zeros(LATEX_CAPS.raw - 100), "sagebrush-latex-worker.js": zeros(101) });
  check(!overRaw.ok && overRaw.raw === LATEX_CAPS.raw + 1, "one byte over the raw cap fails", { raw: overRaw.raw });
  // (random bytes trimmed until the gzip of the whole group is just at the cap, then one more random byte)
  let n = LATEX_CAPS.gzip - 64, r = randomBytes(LATEX_CAPS.gzip + 64);
  while (gz(r.subarray(0, n + 1)) <= LATEX_CAPS.gzip) n++;
  const atGz = tree("at-gzip", { "sagebrush-latex.js": r.subarray(0, n) });
  const overGz = tree("over-gzip", { "sagebrush-latex.js": r.subarray(0, n + 1) });
  check(atGz.ok && atGz.gzip <= LATEX_CAPS.gzip && atGz.raw < LATEX_CAPS.raw, "a group at the gzip cap passes", { raw: atGz.raw, gzip: atGz.gzip });
  check(!overGz.ok && overGz.gzip > LATEX_CAPS.gzip && overGz.raw < LATEX_CAPS.raw, "over the gzip cap (raw within its own) fails", { raw: overGz.raw, gzip: overGz.gzip });
  // (the gzip is each file's own, summed: two files are measured as two, not as one stream)
  const split = tree("split", { "sagebrush-latex.js": r.subarray(0, 1000), "sagebrush-latex-worker.js": r.subarray(1000, 2000) });
  check(split.gzip === gz(r.subarray(0, 1000)) + gz(r.subarray(1000, 2000)), "the gzip is the sum of each file's own", { gzip: split.gzip });
  const empty = tree("empty", { "index.js": zeros(10) });
  check(!empty.ok && empty.js.length === 0, "no LaTeX file at all fails (a build without the editor is not a pass)", empty.js);
  const lazy = Object.fromEntries(Object.values(LATEX_LAZY).map((p) => [p.slice("dist/".length), zeros(LATEX_CAPS.raw + 1)]));
  const withLazy = tree("lazy", { "sagebrush-latex.js": zeros(1000), ...lazy, "sagebrush-latex.css": zeros(10), "other.js": zeros(LATEX_CAPS.raw + 1) });
  check(withLazy.ok && withLazy.raw === 1000 && withLazy.js.join() === "dist/sagebrush-latex.js" && withLazy.css.join() === "dist/sagebrush-latex.css", "the lazy chunks and other files are not in the group; CSS is listed apart", { js: withLazy.js, css: withLazy.css });
  // (a lazy chunk: at its cap passes, one byte over fails, a missing one is not a pass)
  const lazyTree = (name, bytes) => {
    const web = join(tmp, name);
    mkdirSync(join(web, "dist"), { recursive: true });
    if (bytes) writeFileSync(join(web, "dist", "sagebrush-latex-tools.js"), bytes);
    return latexLazy(files(web)).find((c) => c.key === "TOOLS");
  };
  const tAt = lazyTree("tools-at", zeros(LATEX_LAZY_CAPS.TOOLS.raw)), tOver = lazyTree("tools-over", zeros(LATEX_LAZY_CAPS.TOOLS.raw + 1)), tNone = lazyTree("tools-none", null);
  check(tAt.ok && !tOver.ok && tOver.raw === LATEX_LAZY_CAPS.TOOLS.raw + 1 && !tNone.present && !tNone.ok, "a lazy chunk at its cap passes, one byte over fails, a missing one is not a pass", { at: tAt.raw, over: tOver.raw, missing: tNone.present });
  // (each chunk measured from its own file: all thirteen at distinct sizes, each row's name and raw its own)
  const sizes = Object.fromEntries(Object.keys(LATEX_LAZY).map((k, i) => [k, 1000 + 111 * i]));
  const allWeb = join(tmp, "lazy-all");
  mkdirSync(join(allWeb, "dist"), { recursive: true });
  for (const [k, n] of Object.entries(sizes)) writeFileSync(join(allWeb, LATEX_LAZY[k]), zeros(n));
  const rows = latexLazy(files(allWeb));
  check(rows.length === 13 && rows.every((r) => r.present && r.name === LATEX_LAZY[r.key] && r.raw === sizes[r.key] && r.ok), "each lazy chunk is measured from its own file (thirteen at distinct sizes)", rows.map((r) => [r.key, r.name, r.raw]));
  // (over its gzip cap with raw well within its own: random bytes just past the gzip cap)
  const tGz = lazyTree("tools-gzip", randomBytes(LATEX_LAZY_CAPS.TOOLS.gzip + 64));
  check(!tGz.ok && tGz.gzip > LATEX_LAZY_CAPS.TOOLS.gzip && tGz.raw < LATEX_LAZY_CAPS.TOOLS.raw, "a lazy chunk over its gzip cap (raw within its own) fails", { raw: tGz.raw, gzip: tGz.gzip });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- the real DEV build
const web = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
if (!existsSync(join(web, "dist", "sagebrush-latex.js"))) check(false, "web/dist has the LaTeX editor's bundle (build it first: bun web/build.ts)");
else {
  const g = latexGroup(files(web));
  for (const c of latexLazy(files(web))) check(c.present && c.ok, `this build's ${c.label} within ${c.cap.raw} B raw and ${c.cap.gzip} B gzip`, c.present ? { raw: c.raw, gzip: c.gzip, room: { raw: c.cap.raw - c.raw, gzip: c.cap.gzip - c.gzip } } : { missing: c.name });
  check(g.ok, `this build's LaTeX group within ${LATEX_CAPS.raw} B raw and ${LATEX_CAPS.gzip} B gzip (scripts/latex-group.mjs)`,
    { files: g.js, raw: g.raw, gzip: g.gzip, room: { raw: LATEX_CAPS.raw - g.raw, gzip: LATEX_CAPS.gzip - g.gzip }, node: process.version, zlib: process.versions.zlib });
  // (the site serves every one of them: web/build.ts copies the LaTeX editor's files to web/site/public by name, and
  //  one left off that list is a 404 on sagebrush.space only, grader #685 E6; as web/site-dir.mts decides the site)
  const site = join(web, "site", "public");
  if (process.env.SAGEBRUSH_NO_SITE === "1" || !existsSync(join(web, "site"))) console.log("skip the site's copies: this build has no web/site (SAGEBRUSH_NO_SITE=1, or no web/site)");
  else {
    const ours = [...g.js, ...Object.values(LATEX_LAZY)].map((n) => n.slice("dist/".length));
    const bad = ours.filter((f) => !existsSync(join(site, f)) || !readFileSync(join(site, f)).equals(readFileSync(join(web, "dist", f))));
    const stale = readdirSync(site).filter((f) => f.startsWith("sagebrush-latex") && !existsSync(join(web, "dist", f)));
    check(ours.length === g.js.length + 13 && bad.length === 0 && stale.length === 0, `the site serves each of this build's ${ours.length} LaTeX editor files: web/site/public's copy is web/dist's, byte for byte, and none stale`, { bad, stale });
  }
  // (the app ships every one of them too: app/build-frontend.mjs copies web/dist's files by name (FILES), and one left
  //  off it is missing from the native app only (grader's #824 R7))
  const appSrc = readFileSync(join(web, "..", "app", "build-frontend.mjs"), "utf8");
  const appFiles = new Set([...(/const FILES = \[([^\]]*)\]/.exec(appSrc)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const ourJs = [...g.js, ...Object.values(LATEX_LAZY)].map((n) => n.slice("dist/".length));
  const notInApp = ourJs.filter((f) => !appFiles.has(f));
  check(appFiles.size > 0 && notInApp.length === 0, `the app ships each of this build's ${ourJs.length} LaTeX editor files (app/build-frontend.mjs FILES)`, { notInApp });
}

// ---- every input of the LaTeX editor's bundles selects the full tier on a pull request (scripts/ci-paths.mjs fullTierPaths), so
// a change that grows the group is checked here before it merges, not first on master
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const metaFile = join(root, "build", "latex-metafile.json");
if (!existsSync(metaFile)) check(false, "build/latex-metafile.json is there (bun web/build.ts writes it)");
else {
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  // (the group's two bundles and each lazy chunk: every LaTeX editor bundle the metafile names, at least those eight)
  const bundles = Object.keys(meta).filter((k) => k.startsWith("the LaTeX editor ("));
  const inputs = [...new Set(bundles.flatMap((k) => meta[k]))].sort();
  check(bundles.length >= 8, "the metafile names the LaTeX editor's bundles (the group's two and the six lazy chunks)", bundles);
  // (Run's code stays in Run's chunk (#824): the page imports it only lazily (loadRun) or as a type, so the page bundle's
  //  inputs never list run-core.mjs; Bun tree-shakes an eager import of a re-export down to a few bytes the caps don't
  //  see, so it is the inputs that are checked (grader's #804 RC1, @sagebrush's ruling, Nov 7))
  const pageIn = meta["the LaTeX editor (sagebrush-latex.js)"] ?? [], runIn = meta["the LaTeX editor (sagebrush-latex-run.js)"] ?? [];
  check(pageIn.length > 0 && !pageIn.includes("web/latex/run-core.mjs") && runIn.includes("web/latex/run-core.mjs"), "run-core.mjs is an input of the Run chunk only, not of the page bundle", { page: pageIn.filter((f) => /run-core/.test(f)), run: runIn.filter((f) => /run-core/.test(f)) });
  const dir = mkdtempSync(join(tmpdir(), "latex-group-paths-"));
  const notFull = inputs.filter((f) => {
    writeFileSync(join(dir, "files.txt"), f + "\n");
    const r = spawnSync(process.execPath, [join(root, "scripts", "ci-paths.mjs")], { encoding: "utf8", cwd: root,
      env: { ...process.env, CI_PATHS_FILES: join(dir, "files.txt"), GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge", CI_PR_LABELS: "" } });
    return r.status !== 0 || !/^full=true$/m.test(r.stdout);
  });
  rmSync(dir, { recursive: true, force: true });
  check(inputs.length > 0 && notFull.length === 0, `each of the LaTeX bundles' ${inputs.length} inputs selects the full tier (scripts/ci-paths.mjs)`, { notFull });
}

console.log(fails.length ? `FAIL: the LaTeX group's budget, ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX group's budget, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
