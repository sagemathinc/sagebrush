// ci: web-runner order=270 runner=bun
// History's static census (web/history/census.mjs) and its control: the tree as it is passes, every site classified;
// a fixture with one new readwrite transaction on "entries", outside the map, fails it, named.
//   bun web/history/test-history-census.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname, census = join(here, "census.mjs");
const fails = [];
const run = (...a) => spawnSync(process.execPath, [census, ...a], { encoding: "utf8" });
const ok = run();
if (ok.status !== 0) fails.push("the tree's census fails: " + (ok.stderr || ok.stdout).slice(0, 2000));
const dir = mkdtempSync(join(tmpdir(), "sb-census-")), fixture = join(dir, "new-writer.ts");
writeFileSync(fixture, 'export const f = (w) => inTx(w.ws, "entries", "readwrite", async (tx) => { tx.objectStore("entries").put({ path: "/x" }); });\n');
const bad = run("--extra", fixture);
if (bad.status === 0 || !bad.stderr.includes("UNMAPPED") || !bad.stderr.includes("new-writer.ts")) fails.push("control: a fixture with a new readwrite site on entries didn't fail the census: " + (bad.stderr || bad.stdout).slice(0, 2000));
rmSync(dir, { recursive: true, force: true });
// (Z1, Z2, daybreak2: tokens.ts is a leaf, imported only by the source writers; the guard, its harness and the census
// are imported by no app file (tests only), so none can reach the built output)
import { readdirSync, readFileSync, statSync } from "node:fs";
const web = join(here, ".."), APP_IMPORTERS = new Set(["workspace/api.ts", "workspace/sync-fetch.ts", "workspace/sync-replay.ts", "notebook/stores.js"]);
const walk = function* (d) { for (const n of readdirSync(d)) { const p = join(d, n); if (/node_modules|\/dist\b|\/build\b|\/site\/public\b|\/app\.tmp\.js$/.test(p)) continue; if (statSync(p).isDirectory()) yield* walk(p); else if (/\.(ts|js|mjs|html)$/.test(n)) yield p; } };
{
  // (A1.2: tokens.ts's MAX_ANCESTORS is paths.ts's MAX_DEPTH less one)
  const md = /MAX_DEPTH = (\d+)/.exec(readFileSync(join(web, "workspace/paths.ts"), "utf8"))?.[1], ma = /MAX_ANCESTORS = (\d+)/.exec(readFileSync(join(here, "tokens.ts"), "utf8"))?.[1];
  if (!(Number(md) === 32 && Number(ma) === Number(md) - 1)) fails.push(`A1.2: MAX_ANCESTORS (${ma}) must be paths.ts MAX_DEPTH (${md}) - 1, and MAX_DEPTH 32`);
}
// (A1-T9: every delete of a board's row or a notebook's record goes through its ONE helper (boardRowWrite in api.ts,
// deleteNotebookRecord in stores.js), which writes the token; a direct delete anywhere else in the app fails, and the
// control, a fixture with one, must be caught)
const DIRECT = /objectStore\("(boards|notebooks)"\)\.delete\(|\b(idb|mainTx)\([^)]*"notebooks",\s*"readwrite"[^)]*\)\s*=>\s*\w+\.delete\(|\bmainTx\("notebooks",\s*"readwrite"/;
const helperOk = (rel, line) => (rel === "workspace/api.ts" && /^\s*if \(row === null\) st\.delete\(id\);/.test(line)) || (rel === "notebook/stores.js" && /tx\.objectStore\("notebooks"\)\.delete\(id\);/.test(line));
const directDeletes = (files) => {
  const out = [];
  for (const p of files) {
    const rel = p.startsWith(web) ? p.slice(web.length + 1) : p, lines = readFileSync(p, "utf8").split("\n");
    if (/(^|\/)test-|-cases\.js$|\.page\.js$/.test(rel)) continue;
    lines.forEach((l, i) => { if ((DIRECT.test(l) || /\bst\.delete\(/.test(l) && /boards|notebooks/.test(lines.slice(Math.max(0, i - 3), i + 1).join("\n"))) && !helperOk(rel, l)) out.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`); });
  }
  return out;
};
const tokImports = [...readFileSync(join(here, "tokens.ts"), "utf8").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
if (JSON.stringify(tokImports) !== JSON.stringify(["../workspace/db"])) fails.push("Z1: tokens.ts imports more than ../workspace/db: " + JSON.stringify(tokImports));
{
  const found = directDeletes(walk(web));
  if (found.length) fails.push("A1-T9: a board or notebook deleted outside its helper:\n    " + found.join("\n    "));
  const fxd = mkdtempSync(join(tmpdir(), "sb-census-")), fx = join(fxd, "direct-delete.ts");
  writeFileSync(fx, 'export const g = (db, id) => { const tx = db.transaction("notebooks", "readwrite"); tx.objectStore("notebooks").delete(id); };\n');
  if (!directDeletes([fx]).length) fails.push("A1-T9 control: a fixture's direct notebook delete wasn't caught");
  rmSync(fxd, { recursive: true, force: true });
}
for (const p of walk(web)) {
  const rel = p.slice(web.length + 1), src = readFileSync(p, "utf8"), isTest = /(^|\/)test-|-cases\.js$|\.page\.js$|^history\/(guard|guard-harness|census)\./.test(rel);
  if (/history\/tokens"/.test(src) && !isTest && !APP_IMPORTERS.has(rel)) fails.push(`Z1: ${rel} imports history/tokens (not a source writer)`);
  if (!isTest && /history\/(guard|guard-harness|census)(\.m?js)?"/.test(src)) fails.push(`Z2: the app file ${rel} imports a test-only history module`);
}
console.log(fails.length ? `FAIL: ${fails.length} problems\n  ` + fails.join("\n  ") : `ok: history's census, its control, and the import boundaries (Z1, Z2) (${ok.stdout.trim()})`);
process.exit(fails.length ? 1 : 0);
