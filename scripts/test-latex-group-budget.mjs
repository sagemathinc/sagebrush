// ci: web-artifacts.1 order=5
// The LaTeX group's absolute ceiling (scripts/latex-group.mjs, the site asset budget's check 4), in CI: on the DEV
// web/dist this job has just built (bun web/build.ts; the LaTeX editor is in a build by default), the group's JS must
// be within LATEX_CAPS, raw and gzip. Before it, small synthetic trees check the measure itself: at the cap passes, one
// byte over (raw, or gzip) fails, an empty group fails, and the lazy chunks are left out.
//   bun web/build.ts && node scripts/test-latex-group-budget.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { latexGroup, LATEX_CAPS, LATEX_LAZY, gz } from "./latex-group.mjs";

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
  check(withLazy.ok && withLazy.js.join() === "dist/sagebrush-latex.js" && withLazy.css.join() === "dist/sagebrush-latex.css", "the lazy chunks and other files are not in the group; CSS is listed apart", { js: withLazy.js, css: withLazy.css });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- the real DEV build
const web = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
if (!existsSync(join(web, "dist", "sagebrush-latex.js"))) check(false, "web/dist has the LaTeX editor's bundle (build it first: bun web/build.ts)");
else {
  const g = latexGroup(files(web));
  check(g.ok, `this build's LaTeX group within ${LATEX_CAPS.raw} B raw and ${LATEX_CAPS.gzip} B gzip (scripts/latex-group.mjs)`,
    { files: g.js, raw: g.raw, gzip: g.gzip, room: { raw: LATEX_CAPS.raw - g.raw, gzip: LATEX_CAPS.gzip - g.gzip }, node: process.version, zlib: process.versions.zlib });
}

console.log(fails.length ? `FAIL: the LaTeX group's budget, ${fails.length} of ${checks}:\n  ${fails.join("\n  ")}` : `ok: the LaTeX group's budget, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
