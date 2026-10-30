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
// (the hello's field as a minifier writes it: `merge:` and the two names in a literal array.  The array alone isn't
// enough: doc-protocol.ts's MERGE_MODES, a frozen array of the same two names, is in the page as a constant)
const LIST = /merge:\["legacy","exact-v1"\]/;
// (the exact reader: db-merge3.ts.  Its text has no marker of its own (patchflow's merge3, which ships anyway, has the
// same token pattern), so it is found by the bundler's metafile: whether the module is in the output)

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
  // (the reader: the page's own script (index.html's, as web/build.ts bundles it) and history.js, each built with the
  // define false (as production) and true; db-merge3.ts in the output only with it true)
  const reader = async (file, on) => {
    const r = await Bun.build({ entrypoints: [file], target: "browser", format: "iife", minify: true, metafile: true, define: { __SB_EXACT_MERGE__: on ? "true" : "false", __SB_LATEX__: "false" } });
    if (!r.success) throw new Error(r.logs.join("\n"));
    const out = Object.values(r.metafile.outputs)[0];
    return Object.keys(out.inputs).some((k) => /db-merge3\.ts$/.test(k) && out.inputs[k].bytesInOutput > 0);
  };
  writeFileSync(entry, `import { codecFor } from ${JSON.stringify(join(here, "../notebook/history.js"))};\nglobalThis.out = codecFor;\n`);
  const hOff = await reader(entry, false), hOn = await reader(entry, true);
  check(!hOff && hOn, "history.js: the exact reader (db-merge3.ts) in the output only with the define true: " + JSON.stringify({ off: hOff, on: hOn }));
  const html = readFileSync(join(here, "../index.html"), "utf8"), app = /<script id="app">([\s\S]*?)<\/script>/.exec(html)?.[1];
  check(!!app, "the page's script is in web/index.html");
  if (app) {
    const appFile = join(here, "..", ".merge-off-app.tmp.js");
    writeFileSync(appFile, app.replace('import { latexBoot } from "./latex/boot.ts";\n', "") + "\nexport {};\n");
    try {
      const pOff = await reader(appFile, false), pOn = await reader(appFile, true);
      // (the page loads TimeTravel's history lazily, as its own bundle (sagebrush-history.js, built from history.js with the
      // same define: checked above), so its script carries no reader either way)
      check(!pOff && !pOn, "the page's script carries no exact reader (its history is the lazily loaded sagebrush-history.js, checked above): " + JSON.stringify({ off: pOff, on: pOn }));
    } finally {
      rmSync(appFile, { force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: the built page's hello says no merge (exact merges off in production), ${checks} checks`);
process.exit(fails.length ? 1 : 0);
