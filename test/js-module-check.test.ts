import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The publisher's AST checks of a js package's module (scripts/js-module-check.mjs;
// r4 addendum A1.3, A1.4): real imports are refused wherever they are in the
// code, text that only looks like one (strings, comments, template text,
// regular expressions) is not; host_req is computed from literal hostCall
// names.  And the vendored acorn is the npm tarball's (its sha256s).
const ROOT = __dirname + "/../../";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const C = require(ROOT + "scripts/js-module-check.mjs");

test("the vendored acorn files are the npm tarball's, by their recorded sha256", () => {
  const dir = ROOT + "scripts/vendor/acorn-8.19.0/";
  const v = JSON.parse(readFileSync(dir + "vendor.json", "utf8"));
  for (const [name, f] of Object.entries(v.files) as [string, { sha256: string }][]) {
    assert.equal(createHash("sha256").update(readFileSync(dir + name)).digest("hex"), f.sha256, name);
  }
});

test("real imports are refused wherever they are in the code", () => {
  const refused: [string, RegExp][] = [
    ['import x from "y";', /import declaration/],
    ['import "y";', /import declaration/],
    ['import * as ns from "y";', /import declaration/],
    ['const m = await import("y");', /dynamic import/],
    ["const f = (name) => import(name);", /dynamic import/],
    ['export { a } from "b";', /export … from/],
    ['export * from "b";', /export … from/],
    ['export * as ns from "b";', /export … from/],
    ['importScripts("x.js");', /importScripts/],
    ['self.importScripts("x.js");', /importScripts/],
    ["const { importScripts } = self;", /importScripts/],
    // (hidden: inside a template literal's expression, behind a comment, in a nested function, escaped)
    ["const s = `${import('y')}`;", /dynamic import/],
    ["/* import('y') */ import('z');", /dynamic import/],
    ["function a() { return function b() { return import('y'); }; }", /dynamic import/],
    ['import\\u0053cripts("x.js");', /importScripts/],
    ["const o = { importScripts: 1 };", /importScripts/],
  ];
  for (const [code, re] of refused) {
    const found = C.importFindings(code);
    assert.ok(found.some((f: string) => re.test(f)), `${code}: ${JSON.stringify(found)}`);
  }
});

test("text that only looks like an import is not refused (strings, comments, template text, regex)", () => {
  const accepted = [
    'const s = "import(x)";',
    "const s = 'import x from \"y\"';",
    "const s = `import(${name})`;", // (just-bash's own messages: the text import( in a template literal)
    'const m = `export * from "b"`;',
    "// import x from 'y'",
    "/* importScripts('x') */",
    "const re = /import\\(|importScripts/;",
    'const o = { "importScripts": 1 }; const p = o["importScripts"];',
    "const importer = 1; const reimport = importer;",
    "export const ok = 1; export default ok; export { ok as alias };",
  ];
  for (const code of accepted) assert.deepEqual(C.importFindings(code), [], code);
});

test("a module that doesn't parse is an error, not accepted", () => {
  assert.throws(() => C.importFindings("const = ;"), /Unexpected token/);
});

test("host_req: the highest level of the literal hostCall names; bad names and stray postMessage fail the build (A1.4)", () => {
  const table = { "fs.read": 1, "fs.write": 1, "run.result": 2 };
  const helper = "function hostCall(name, payload) { return port.postMessage({ name, payload }); }\n";
  assert.deepEqual(C.hostRequirement(helper + 'hostCall("fs.read", 1); hostCall("run.result", {});', table), { host_req: 2, names: ["fs.read", "run.result"], errors: [] });
  assert.deepEqual(C.hostRequirement(helper + 'hostCall("fs.write");', table).host_req, 1);
  assert.deepEqual(C.hostRequirement("const x = 1;", table), { host_req: 0, names: [], errors: [] });
  // (an arrow helper counts as the helper too)
  assert.deepEqual(C.hostRequirement('const hostCall = (n, p) => port.postMessage([n, p]); hostCall("fs.read");', table).errors, []);
  const errors = (code: string) => C.hostRequirement(helper + code, table).errors.join("; ");
  assert.match(errors("hostCall(name, 1);"), /not a string literal/);
  assert.match(errors("hostCall(`fs.read`);"), /not a string literal/);
  assert.match(errors('hostCall("fs.delete");'), /hostCall\("fs\.delete"\) is not in the host level table/);
  assert.match(errors("port.postMessage(1);"), /postMessage outside the hostCall helper/);
  assert.match(errors('self["postMessage"](1);'), /postMessage outside the hostCall helper/);
  assert.match(errors("const { postMessage } = self;"), /postMessage outside the hostCall helper/);
});
