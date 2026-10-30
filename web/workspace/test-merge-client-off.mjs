// P2b is inert in production (plan-merge-align r3.2; the grader's G-P2b-1): every production build defines
// __SB_EXACT_MERGE__ as false (web/build.ts), so the built page's hello says no `merge` and its claims ask for none.
// Checked on the BUILT page (web/dist/index.html, which cli/pyjs.cjs embeds; run after `bun web/build.ts`): the hello's
// merge list isn't in it.  The positive control builds merge-client.ts's hello field the way the page is built
// (minified, browser), once with the define false and once true: only the true build carries the list, so the check
// can't pass for want of the text.
//   bun web/workspace/test-merge-client-off.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
// (the hello's list as a minifier writes it: the two names in a literal array, in this order)
const LIST = /\["legacy","exact-v1"\]/;

const page = join(here, "../dist/index.html");
check(existsSync(page), "the built page is there (run bun web/build.ts first): " + page);
if (existsSync(page)) {
  const html = readFileSync(page, "utf8");
  check(/SyncClient|sync\/v1\/account/.test(html), "the built page carries the sync client (so the check is about it)");
  check(!LIST.test(html), "the built page's hello says no merge: its list isn't in the page");
}
// (the control: the hello field built as the page is, the define false, then true)
const dir = mkdtempSync(join(tmpdir(), "sb-merge-off-"));
try {
  const entry = join(dir, "entry.js");
  writeFileSync(entry, `import { helloMergeField } from ${JSON.stringify(join(here, "merge-client.ts"))};\nglobalThis.out = helloMergeField();\n`);
  const build = async (on) => {
    const r = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", minify: true, define: { __SB_EXACT_MERGE__: on ? "true" : "false" } });
    if (!r.success) throw new Error(r.logs.join("\n"));
    return await r.outputs[0].text();
  };
  const off = await build(false), on = await build(true);
  check(!LIST.test(off) && LIST.test(on), "the control: built with the define false the list isn't there, with it true it is: " + JSON.stringify({ off: off.length, on: on.length }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the built page's hello says no merge (exact merges off in production), ${checks} checks`);
process.exit(fails.length ? 1 : 0);
