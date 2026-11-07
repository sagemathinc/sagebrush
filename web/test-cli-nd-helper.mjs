// ci: checks.3 order=11 -- build/cli/pyjs.cjs
// The CLI bundle carries engine/nd's thread-pool helper (src/runtime/nd-helper.ts, scripts/build-cli.mjs) once, as
// the code its worker_threads helpers run (src/runtime/nd.ts): without it the CLI's large products never get
// threads (grader K1 on #775). Checked by taking the helper's code out of the bundle and running it as nd.ts does,
// as a Worker of that code: sent a malformed bootstrap, it must answer that it refused it.
//   node web/test-cli-nd-helper.mjs [bundle]      (default build/cli/pyjs.cjs)
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const bundle = process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname;
const src = readFileSync(bundle, "utf8");
// (the bundler writes the string as a quoted string or a template literal: take the literal up to its closing
// quote, skipping escapes, and evaluate that literal alone)
function helperLiteral(text) {
  const at = /__SAGEBRUSH_ND_HELPER__\s*=\s*(["`])/.exec(text);
  if (!at) return null;
  const q = at[1];
  let i = at.index + at[0].length;
  for (; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++;
  return i < text.length ? text.slice(at.index + at[0].length - 1, i + 1) : null;
}
const lit = helperLiteral(src);
const m = lit === null ? null : [lit, lit];
let fail = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) fail++;
};
ok(m !== null, "the bundle defines __SAGEBRUSH_ND_HELPER__ as a string");
if (m) {
  const code = new Function(`return ${m[1]};`)();
  ok(code.length > 500 && !/^\s*(import|export)\b/m.test(code), `the helper's code is a script (${code.length} bytes, no import or export)`);
  const answer = await new Promise((resolve) => {
    const w = new Worker(code, { eval: true });
    const done = (v) => {
      void w.terminate();
      resolve(v);
    };
    w.on("message", (d) => done(d?.helperError ?? JSON.stringify(d)));
    w.on("error", (e) => done(`error: ${e?.message ?? e}`));
    setTimeout(() => done("no answer in 10 s"), 10000).unref();
    w.postMessage({ id: 0 });
  });
  ok(answer === "the pool's helper was sent a malformed bootstrap", `the bundled helper runs, and refuses a malformed bootstrap: ${JSON.stringify(answer)}`);
}
process.exit(fail ? 1 : 0);
