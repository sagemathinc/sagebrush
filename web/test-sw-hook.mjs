// The service worker's test hook stays out of what ships (web/sw-hook.mts; the grader's ruling on B8's cases):
// one block cut out byte for byte, no marker left, the hook's seams assigned only at their declarations, the
// counters only written, and no deployable directory carrying the test build.  Each check against its own mutant.
//
//   node web/test-sw-hook.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHook, assertShipped, assertNoHookIn } from "./sw-hook.mts";

let failures = 0;
const ok = (c, name) => (console.log((c ? "ok   " : "FAIL ") + name), c || failures++);
const refuses = (f, re) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };
const here = new URL(".", import.meta.url).pathname;
const src = readFileSync(join(here, "sw.js"), "utf8");

const shipped = stripHook(src);
ok(shipped.length < src.length && !shipped.includes("offlineTest"), "web/sw.js: its block is cut out and the rest passes");
const at = src.indexOf("// <offline-test>"), end = src.indexOf("// </offline-test>\n") + "// </offline-test>\n".length;
ok(shipped === src.slice(0, at) + src.slice(end), "the shipped text is the source minus exactly the block's bytes");
ok(refuses(() => stripHook(src + "// <offline-test>\n// </offline-test>\n"), /2 test hook blocks/), "two blocks are refused");
ok(refuses(() => stripHook(src.replace("// <offline-test>", "// <offline-tst>")), /0 test hook blocks/), "no block is refused");
ok(refuses(() => stripHook(src.replace("// </offline-test>\n", "// </offline-test>\nself.offlineTest = 1;\n")), /offlineTest/), "a marker left outside the block is refused");
// (v2 addition 1) the seams assigned only at their declarations
ok(refuses(() => assertShipped(shipped + "\ntimeScale = 0.001;\n"), /timeScale is assigned 2 times/), "timeScale assigned outside the block is refused");
ok(refuses(() => assertShipped(shipped + "\nestimateFn = async () => ({ quota: 1e12, usage: 0 });\n"), /estimateFn is assigned 2 times/), "estimateFn assigned outside the block is refused");
// (v2 addition 2) the counters only written
for (const [name, line] of [["keysLooked", "if (keysLooked > 1200) throw 0;"], ["inflightPeak", "const x = inflightPeak;"], ["budgetPeak", "self.p = budgetPeak;"]])
  ok(refuses(() => assertShipped(shipped + "\n" + line + "\n"), new RegExp(`counter ${name} is read`)), `the counter ${name} read in shipped code is refused`);
// the hook's other seams (cases v2): never in shipped code; the package code's own `const reserve` is not one
for (const [what, line] of [["a patched Cache API", "const f = Cache.prototype.put;"], ["a patched Cache API", "caches.open = async (n) => null;"],
  ["reserve rebound", "reserve = (n) => Promise.resolve(() => {});"], ["the stop point", "let stopAt = null;"], ["the grant log", "const grants = [];"],
  ["the probe forced", "probed = Promise.resolve(true);"]])
  ok(refuses(() => assertShipped(shipped + "\n" + line + "\n"), new RegExp(what)), `${what} in shipped code is refused: ${line}`);
ok(/^\s*const reserve = /m.test(shipped), "(the package code's own local `const reserve` is in the shipped text, and passes)");
// the scheduler's frozen limits (daybreak2's and daybreak3's rulings): 64 waiting places, 8 files a job, 8 <= 64 / 8,
// each used where it bounds
{
  const lim = /^const MAX_BODY_WAITERS = (\d+), MAX_JOB_FILES = (\d+);$/m.exec(shipped);
  ok(lim && Number(lim[1]) === 64 && Number(lim[2]) === 8 && Number(lim[2]) <= Number(lim[1]) / 8, "the limits are frozen: MAX_BODY_WAITERS 64, MAX_JOB_FILES 8, and MAX_JOB_FILES <= MAX_BODY_WAITERS / 8: " + (lim?.slice(1) ?? "missing"));
  ok(/waiters\.length >= MAX_BODY_WAITERS\) return Promise\.reject/.test(shipped) && /running\.size < MAX_JOB_FILES &&/.test(shipped), "the semaphore refuses at MAX_BODY_WAITERS, and a job runs at most MAX_JOB_FILES files");
}
// (v2 addition 3) no deployable directory carries the test build
const d = mkdtempSync(join(tmpdir(), "sw-hook-"));
mkdirSync(join(d, "sub"));
writeFileSync(join(d, "sw.js"), shipped);
writeFileSync(join(d, "sub", "x.json"), "{}");
let clean = true;
try { await assertNoHookIn(d); } catch { clean = false; }
ok(clean, "a deployable directory with the shipped sw.js passes");
writeFileSync(join(d, "sub", "sw.test.js"), src);
let r1 = false;
try { await assertNoHookIn(d); } catch (e) { r1 = /sw\.test\.js/.test(String(e)); }
ok(r1, "a deployable directory holding sw.test.js is refused");
rmSync(join(d, "sub", "sw.test.js"));
writeFileSync(join(d, "copy.js"), src);
let r2 = false;
try { await assertNoHookIn(d); } catch (e) { r2 = /test hook/.test(String(e)); }
ok(r2, "a deployable file carrying the hook block is refused");
rmSync(d, { recursive: true });
console.log(failures ? `${failures} failure(s)` : "service worker test hook: all controls pass");
process.exit(failures ? 1 : 0);
