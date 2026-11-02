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
console.log(fails.length ? `FAIL: ${fails.length} of 2 checks\n  ` + fails.join("\n  ") : `ok: history's census and its control, 2 checks (${ok.stdout.trim()})`);
process.exit(fails.length ? 1 : 0);
