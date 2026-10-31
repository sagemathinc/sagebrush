// The app self-test's COI diagnosis stays out of the page everyone loads:
// in a built page directory (app/dist, or web/dist), index.html must name
// sagebrush-selftest.js (the call in selftest()) and carry none of the
// diagnosis's own strings, and sagebrush-selftest.js must exist and carry
// all of them.  --control: the same check on copies that break it (a
// diagnosis string put into index.html; the module missing) must FAIL.
//   node app/selftest/check-diagnose-lazy.mjs <dir> [--control]
import { readFileSync, existsSync, mkdtempSync, copyFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// (strings only the diagnosis has: its marked fetches and two of its keys; and the Terminal probe's markers)
const MARKERS = ["sb-diag=", "fetch-kernel-script", "kernel-interrupt-shared", "terminal bridge probe"];

function problems(dir) {
  const out = [];
  const page = existsSync(join(dir, "index.html")) ? readFileSync(join(dir, "index.html"), "utf8") : null;
  const mod = existsSync(join(dir, "sagebrush-selftest.js")) ? readFileSync(join(dir, "sagebrush-selftest.js"), "utf8") : null;
  if (page === null) out.push("no index.html");
  else {
    if (!page.includes("sagebrush-selftest.js")) out.push("index.html doesn't name sagebrush-selftest.js (the self-test's call)");
    for (const m of MARKERS) if (page.includes(m)) out.push(`index.html carries the diagnosis's ${JSON.stringify(m)}`);
  }
  if (mod === null) out.push("no sagebrush-selftest.js");
  else for (const m of MARKERS) if (!mod.includes(m)) out.push(`sagebrush-selftest.js lacks ${JSON.stringify(m)}`);
  return out;
}

const [dir, flag] = process.argv.slice(2);
if (!dir || (flag && flag !== "--control")) { console.error("usage: node app/selftest/check-diagnose-lazy.mjs <dir> [--control]"); process.exit(2); }
if (flag !== "--control") {
  const p = problems(dir);
  for (const x of p) console.log("FAIL " + x);
  if (p.length) process.exit(1);
  console.log(`ok: ${dir}/index.html calls sagebrush-selftest.js and carries none of the diagnosis; the module has all of it`);
} else {
  let bad = 0;
  const copy = (withModule) => {
    const t = mkdtempSync(join(tmpdir(), "diagnose-lazy-"));
    copyFileSync(join(dir, "index.html"), join(t, "index.html"));
    if (withModule) copyFileSync(join(dir, "sagebrush-selftest.js"), join(t, "sagebrush-selftest.js"));
    return t;
  };
  const expectFail = (name, t) => {
    const p = problems(t);
    if (p.length) console.log(`ok   control ${name}: FAILs (${p[0]})`);
    else { console.log(`FAIL control ${name}: passes`); bad = 1; }
    rmSync(t, { recursive: true, force: true });
  };
  for (const m of MARKERS) { const t = copy(true); appendFileSync(join(t, "index.html"), `<script>/* ${m} */</script>\n`); expectFail(`index.html with ${JSON.stringify(m)}`, t); }
  expectFail("no sagebrush-selftest.js", copy(false));
  if (bad) process.exit(1);
  console.log("ok: every control FAILs");
}
