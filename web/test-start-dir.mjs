// ci: web-runner order=175 runner=bun
// The notebook folder the page gives the interpreter (web/start-dir.ts, the Nov 4 ruling: a notebook runs in its own
// folder): only a plain absolute path is taken; anything that could name another place, or the runtime's own files, is
// refused (null: the session stays in "/").
//   bun web/test-start-dir.mjs
import { startDirOf } from "./start-dir.ts";
let failures = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
for (const [v, want] of [
  ["/", "/"], ["/Book", "/Book"], ["/QRPM book/Chapter 3", "/QRPM book/Chapter 3"], ["/a/b/c", "/a/b/c"],
  ["", null], ["Book", null], ["./Book", null], ["/Book/", null], ["//Book", null], ["/Book//x", null],
  ["/..", null], ["/Book/..", null], ["/Book/../..", null], ["/./Book", null], ["/Book/.", null],
  ["/$pyjs", null], ["/$pyjs/lib", null], ["/$x", null], ["/Book\u0000x", null], ["/Book\nx", null],
  ["/Book\u001fx", null], ["/Book\u007fx", null], ["/Book~x", "/Book~x"], ["/Café", "/Café"], ["/Book\u0080x", "/Book\u0080x"],
  ["/" + "a".repeat(1024), null], [42, null], [null, null], [["/Book"], null], [{ toString: () => "/Book" }, null],
]) ok(startDirOf(v) === want, `${JSON.stringify(typeof v === "string" ? v.slice(0, 40) : String(v))} -> ${JSON.stringify(want)}`);
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
