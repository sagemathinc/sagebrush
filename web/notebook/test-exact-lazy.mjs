// Exact merges cost nothing at startup (plan-exact-only r1 §6, the grader's E-5): cocalc-ai's merge (db-merge3.ts) and
// patchflow's text merge (its merge3.js, with diff-match-patch) are in the lazily loaded history bundle
// (sagebrush-history.js, built from history.js) and NOT in the page's own script (index.html's, which web/build.ts
// bundles into the page every visit loads).  Checked by the bundler's metafile: whether a module is in an output.
//   bun web/notebook/test-exact-lazy.mjs
// The built-in control: the page's script with a static import of db-merge3.ts added is caught by the same check.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const MERGE = [/web\/notebook\/db-merge3\.ts$/, /patchflow\/dist\/esm\/merge3\.js$/];

// (the modules of `MERGE` an entry's bundle carries, by its metafile)
async function carried(file) {
  const r = await Bun.build({ entrypoints: [file], target: "browser", format: "iife", minify: true, metafile: true, define: { __SB_LATEX__: "false" } });
  if (!r.success) throw new Error(r.logs.join("\n"));
  const out = Object.values(r.metafile.outputs)[0];
  return MERGE.map((re) => Object.keys(out.inputs).some((k) => re.test(k) && out.inputs[k].bytesInOutput > 0));
}

const dir = mkdtempSync(join(tmpdir(), "sb-exact-lazy-"));
const appFile = join(here, "..", ".exact-lazy-app.tmp.js"), ctlFile = join(here, "..", ".exact-lazy-ctl.tmp.js");
try {
  const entry = join(dir, "history-entry.js");
  writeFileSync(entry, `import * as H from ${JSON.stringify(join(here, "history.js"))};\nglobalThis.out = H;\n`);
  const h = await carried(entry);
  check(h[0] && h[1], "the history bundle carries the exact merge (db-merge3.ts and patchflow's merge3): " + JSON.stringify(h));
  const html = readFileSync(join(here, "../index.html"), "utf8"), app = /<script id="app">([\s\S]*?)<\/script>/.exec(html)?.[1];
  check(!!app, "the page's script is in web/index.html");
  if (app) {
    const body = app.replace('import { latexBoot } from "./latex/boot.ts";\n', "") + "\nexport {};\n";
    writeFileSync(appFile, body);
    const p = await carried(appFile);
    check(!p[0] && !p[1], "the page's own script carries neither (startup unchanged; the history bundle loads them when a notebook's history opens): " + JSON.stringify(p));
    // (the control: a static import of the merge from the page is caught by the same check)
    writeFileSync(ctlFile, `import { dbMerge3 } from "./notebook/db-merge3.ts";\nglobalThis.sbCtl = dbMerge3;\n` + body);
    const c = await carried(ctlFile);
    check(c[0], "the control: the page's script with a static import of db-merge3.ts is caught: " + JSON.stringify(c));
  }
} finally {
  for (const f of [appFile, ctlFile]) rmSync(f, { force: true });
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: exact merges load lazily (the history bundle), not with the page, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
