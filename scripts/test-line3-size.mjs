// Line 3's size controls (line-3 case §4c, D-3a..g): a source change in a worktree, the page built six ways (PROD and
// DEV, shipped and measuring, each measuring flavour twice), line 3 run on it with the stated block, the change
// undone and the worktree checked clean before the next. Each control's expected outcome is closed: the exact
// reasons, and both halves of the cap line.
//   node scripts/test-line3-size.mjs --worktree DIR [--keep OUTDIR]
// DIR is a checkout whose dependencies are installed and whose tsc and build-cli have run (as for web/build.ts); bun
// on PATH. --keep copies each control's six pages to OUTDIR/<control>/.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BASE_BLOCK, checkLine3, tokens } from "./line3-measure.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const W = arg("--worktree"), KEEP = arg("--keep");
if (!W) { console.error("usage: --worktree DIR [--keep OUTDIR]"); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const ts = createRequire(join(here, "..", "package.json"))("typescript-api");
const bun = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
const env = { bun, typescript: ts.version, node: process.version, zlib: process.versions.zlib };
const H = Array.from({ length: 8 }, (_, i) => createHash("sha256").update(`l3-ctl-${i}`).digest("hex")).join("");
// (§5: the two R1 renewed blocks, computed by tolerances-r2.py from line3-calib-n24 and line3-calib-n24-d3f)
const D3D_BLOCK = { ...BASE_BLOCK, fragment: { raw: 2653, gzip: 1398 }, band: [281, 458] };
const D3F_BLOCK = { ...BASE_BLOCK, fragment: { raw: 2621, gzip: 1367 }, band: [277, 454] };
const SHARED = ["web/workspace/preview.ts", '"This table is empty."'];
const DEVONLY = ["web/latex/boot.ts", "\"The LaTeX editor isn't enabled here.\""];
const FLAG = ["web/workspace/preview.ts", "(globalThis as any).__sbTexP?.(e, actions);"];
const inLiteral = ([file, lit], add) => [file, lit, lit.slice(0, -1) + add + lit.slice(-1)];
const extraArg = ([file, call], add) => [file, call, call.replace("(e, actions);", `(e, actions, "${add}");`)];
let bad = 0;
const report = (name, ok, got) => { if (!ok) bad++; console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got).slice(0, 500)}`); };
const git = (...a) => execFileSync("git", ["-C", W, ...a], { encoding: "utf8" });
if (git("status", "--porcelain").trim()) { console.error("control-precondition: the worktree isn't clean"); process.exit(1); }
const build = (vars) => {
  rmSync(join(W, "web/dist"), { recursive: true, force: true });
  const e = { ...process.env, ...vars }; delete e.SAGEBRUSH_PREVIEW_HOST; delete e.SAGEBRUSH_SOURCE_REF;
  if (!("SAGEBRUSH_LATEX_PREVIEW" in vars)) delete e.SAGEBRUSH_LATEX_PREVIEW;
  if (!("SAGEBRUSH_MEASURE_IDS" in vars)) delete e.SAGEBRUSH_MEASURE_IDS;
  execFileSync("bun", ["web/build.ts"], { cwd: W, env: e, stdio: ["ignore", "ignore", "inherit"] });
  return readFileSync(join(W, "web/dist/index.html"));
};
const six = () => ({
  prodShip: build({}), devShip: build({ SAGEBRUSH_LATEX_PREVIEW: "1" }),
  prodMeas: build({ SAGEBRUSH_MEASURE_IDS: "keep" }), devMeas: build({ SAGEBRUSH_MEASURE_IDS: "keep", SAGEBRUSH_LATEX_PREVIEW: "1" }),
  prodMeas2: build({ SAGEBRUSH_MEASURE_IDS: "keep" }), devMeas2: build({ SAGEBRUSH_MEASURE_IDS: "keep", SAGEBRUSH_LATEX_PREVIEW: "1" }),
});
const withEdit = (name, [file, from, to], fn) => {
  const p = join(W, file), s = readFileSync(p, "utf8");
  if (s.split(from).length !== 2) { bad++; console.log(`FAIL ${name}: control-precondition (the edit site occurs ${s.split(from).length - 1} times in ${file})`); return; }
  writeFileSync(p, s.replace(from, to));
  try { fn(); } finally { git("checkout", "--", file); }
  if (git("status", "--porcelain").trim()) { bad++; console.log(`FAIL ${name}: control-precondition (the worktree isn't clean after undoing the edit)`); }
};
const capHalves = (r) => { const l = r.lines.find((x) => x.startsWith("line 3 cap ")); const m = l && /cap raw \S+ (pass|FAIL), gzip \S+ (pass|FAIL)/.exec(l); return m ? [m[1], m[2]] : null; };
const keep = (name, pages) => { if (!KEEP) return; const d = join(KEEP, name); mkdirSync(d, { recursive: true }); for (const [k, v] of Object.entries(pages)) writeFileSync(join(d, k + ".html"), v); };
const expect = (name, pages, block, want, halves) => {
  const r = checkLine3(ts, pages, env, block);
  const ok = JSON.stringify([...r.reasons].sort()) === JSON.stringify([...want].sort()) && JSON.stringify(capHalves(r)) === JSON.stringify(halves);
  report(name, ok, { reasons: r.reasons, lines: r.lines.slice(2) });
  return r;
};
// the cap-mechanism-only block (D-3e, D-3g): the base block with ONLY the two fragment fields replaced by this build's
const measuredBlock = (pages) => { const r = checkLine3(ts, pages, env, BASE_BLOCK); return r.metrics ? { ...BASE_BLOCK, fragment: { ...r.metrics.fragment } } : null; };

withEdit("D-3a", inLiteral(SHARED, H.slice(0, 256)), () => { const p = six(); keep("D-3a", p); expect("D-3a shared +256 hex", p, BASE_BLOCK, [], ["pass", "pass"]); });
withEdit("D-3b", inLiteral(DEVONLY, H.slice(0, 256)), () => {
  const p = six(); keep("D-3b", p);
  expect("D-3b DEV-only +256 hex", p, BASE_BLOCK, ["baseline-fragment", "cap"], ["FAIL", "FAIL"]);
  const b = measuredBlock(p);
  if (!b) { bad++; console.log("FAIL D-3e: control-precondition (no measurement to take the fragment from)"); }
  else { console.log(`     D-3e block: the base block with fragment ${JSON.stringify(b.fragment)}`); expect("D-3e DEV-only +256 hex, cap mechanism only", p, b, ["cap"], ["FAIL", "FAIL"]); }
});
withEdit("D-3c", extraArg(FLAG, H.slice(0, 256)), () => { const p = six(); keep("D-3c", p); expect("D-3c flag branch in a shared module +256 hex", p, BASE_BLOCK, ["baseline-fragment", "cap"], ["FAIL", "FAIL"]); });
withEdit("D-3d", inLiteral(DEVONLY, H.slice(0, 64)), () => { const p = six(); keep("D-3d", p); expect("D-3d DEV-only +64 hex, R1 block", p, D3D_BLOCK, ["cap"], ["pass", "FAIL"]); });
withEdit("D-3f", inLiteral(DEVONLY, H.slice(0, 32)), () => { const p = six(); keep("D-3f", p); expect("D-3f DEV-only +32 hex, R1 block", p, D3F_BLOCK, [], ["pass", "pass"]); });
withEdit("D-3g", inLiteral(DEVONLY, "x".repeat(256)), () => {
  const p = six(); keep("D-3g", p);
  const b = measuredBlock(p);
  if (!b) { bad++; console.log("FAIL D-3g: control-precondition (no measurement to take the fragment from)"); }
  else { console.log(`     D-3g block: the base block with fragment ${JSON.stringify(b.fragment)}`); expect("D-3g DEV-only +256 x, cap mechanism only", p, b, ["cap"], ["FAIL", "pass"]); }
});
rmSync(join(W, "web/dist"), { recursive: true, force: true });
console.log(bad ? `FAIL: line 3 size controls, ${bad} failed` : "ok: line 3 size controls");
process.exit(bad ? 1 : 0);
