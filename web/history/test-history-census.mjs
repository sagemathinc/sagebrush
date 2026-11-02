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
const walk = function* (d) { for (const n of readdirSync(d)) { const p = join(d, n); if (/node_modules|\/dist\b/.test(p)) continue; if (statSync(p).isDirectory()) yield* walk(p); else if (/\.(ts|js|mjs|html)$/.test(n)) yield p; } };
const tokImports = [...readFileSync(join(here, "tokens.ts"), "utf8").matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1]);
if (JSON.stringify(tokImports) !== JSON.stringify(["../workspace/db"])) fails.push("Z1: tokens.ts imports more than ../workspace/db: " + JSON.stringify(tokImports));
for (const p of walk(web)) {
  const rel = p.slice(web.length + 1), src = readFileSync(p, "utf8"), isTest = /(^|\/)test-|-cases\.js$|\.page\.js$|^history\/(guard|guard-harness|census)\./.test(rel);
  if (/history\/tokens"/.test(src) && !isTest && !APP_IMPORTERS.has(rel)) fails.push(`Z1: ${rel} imports history/tokens (not a source writer)`);
  if (!isTest && /history\/(guard|guard-harness|census)(\.m?js)?"/.test(src)) fails.push(`Z2: the app file ${rel} imports a test-only history module`);
}
console.log(fails.length ? `FAIL: ${fails.length} problems\n  ` + fails.join("\n  ") : `ok: history's census, its control, and the import boundaries (Z1, Z2) (${ok.stdout.trim()})`);
process.exit(fails.length ? 1 : 0);
