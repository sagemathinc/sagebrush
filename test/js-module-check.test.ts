import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  assert.deepEqual(C.hostRequirement(helper + 'hostCall("fs.read", 1); hostCall("run.result", {});', table), { host_req: 2, names: ["fs.read", "run.result"], fields: [], errors: [] });
  assert.deepEqual(C.hostRequirement(helper + 'hostCall("fs.write");', table).host_req, 1);
  assert.deepEqual(C.hostRequirement("const x = 1;", table), { host_req: 0, names: [], fields: [], errors: [] });
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

test("host_req: a widened field sent raises it to the widening's level; a widened message's payload must be an object literal (A1.4, F13)", () => {
  const table = { "shell.result": 1, "fs.request": 2 }, fields = { "shell.result.rejected.refusal": 2 };
  const helper = "function hostCall(name, payload) { return port.postMessage({ name, payload }); }\n";
  const req = (code: string) => C.hostRequirement(helper + code, { "shell.result": 1 }, fields);
  // (the field sent, nested: level 2; not sent: the message's own level 1)
  assert.deepEqual(req('hostCall("shell.result", { id, rejected: { message: m, refusal: r } });'), { host_req: 2, names: ["shell.result"], fields: ["shell.result.rejected.refusal"], errors: [] });
  assert.deepEqual(req('hostCall("shell.result", { id, rejected: { message: m } });'), { host_req: 1, names: ["shell.result"], fields: [], errors: [] });
  assert.deepEqual(req('hostCall("shell.result", { id, exit: { code: 0, refusal: 1 } });').host_req, 1, "only the widened path counts");
  assert.deepEqual(req('hostCall("shell.result", { id, "rejected": { "refusal": r } });').host_req, 2, "string keys too");
  // (what it sends can't be read: the build fails)
  for (const bad of ['hostCall("shell.result", payload);', 'hostCall("shell.result", { ...p });', 'hostCall("shell.result", { [k]: 1 });', 'hostCall("shell.result", { rejected: x });'])
    assert.match(req(bad).errors.join("; "), /isn't an object literal: its fields have levels/, bad);
  // (a message with no widenings may send anything)
  assert.deepEqual(C.hostRequirement(helper + 'hostCall("fs.request", payload);', table, fields).errors, []);
  // (the committed table: the shipped module's protocol)
  const levels = JSON.parse(readFileSync(join(__dirname, "..", "..", "web", "shell", "host-levels.json"), "utf8"));
  // (level 3, bash step 3: the result's output count and the module's own limit; PR 279's first CI, run 40757814227
  // job 123062107758, failed here on the table's previous single field)
  assert.deepEqual(levels.fields, {
    "shell.result.rejected.refusal": 2,
    "shell.result.output.producedBytes": 3,
    "shell.result.output.deliveredBytes": 3,
    "shell.result.output.exceeded": 3,
    "shell.result.output.truncated": 3,
    "shell.result.limit.key": 3,
    "shell.result.limit.value": 3,
  });
  assert.equal(levels.names["shell.result"], 1, "the message keeps the level that introduced it");
});

test("the notices checks (A1.1a, A1.3): the module's banner, an entry per package, the bundle's own banner", () => {
  // the banner: the module's first bytes are a /*! comment that points to the notices
  assert.deepEqual(C.bannerFindings('/*! @sagebrush/bash 0.1.0: just-bash 3.6.0 (Apache-2.0); full notices in this chunk\'s "notices" */\nvar x;'), []);
  assert.match(C.bannerFindings("var x; /*! notices */").join(), /doesn't begin with a \/\*! legal comment/);
  assert.match(C.bannerFindings("/* notices */ var x;").join(), /doesn't begin with a \/\*! legal comment/);
  assert.match(C.bannerFindings("/*! just-bash */ var x;").join(), /doesn't point to the chunk's notices/);
  // an entry per package: a header line "<name> <version> (", the exact version
  const notices = "Third-party notices\n\n=====\njust-bash 3.6.0 (Apache-2.0; its LICENSE)\n=====\nre2js 1.3.3 (MIT; its LICENSE)\n@borewit/text-codec 0.2.2 (MIT)\n";
  assert.deepEqual(C.missingNotices(notices, [{ name: "just-bash", version: "3.6.0" }, { name: "re2js", version: "1.3.3" }, { name: "@borewit/text-codec", version: "0.2.2" }]), []);
  assert.deepEqual(C.missingNotices(notices, [{ name: "re2js", version: "1.3.2" }, { name: "ieee754", version: "1.2.1" }]), ["re2js 1.3.2", "ieee754 1.2.1"]);
  // (a version mentioned in passing isn't an entry)
  assert.deepEqual(C.missingNotices("see papaparse 5.6.0 for details\n", [{ name: "papaparse", version: "5.6.0" }]), ["papaparse 5.6.0"]);
  // the bundle's own license banner (esbuild's legal comment) against a fixture vendor.json's inlined list
  const bundle = `var a;\n/*! Bundled license information:\n\nre2js/build/index.esm.js:\n  (*!\n   * re2js\n   * @version v1.3.3\n   *)\n\nieee754/index.js:\n  (*! ieee754. BSD-3-Clause License. *)\n\npapaparse/papaparse.js:\n  (* @license\n  Papa Parse\n  v5.6.0\n  *)\n*/\n`;
  const inlined = [{ name: "re2js", version: "1.3.3" }, { name: "ieee754", version: "1.2.1" }, { name: "papaparse", version: "5.6.0" }];
  assert.deepEqual(C.inlinedFindings(bundle, inlined), []);
  assert.deepEqual(C.inlinedFindings(bundle, [{ ...inlined[0] }, inlined[1], { name: "papaparse", version: "5.7.0" }]), ["papaparse: the bundle's banner says 5.6.0, vendor.json 5.7.0"]);
  assert.deepEqual(C.inlinedFindings(bundle, [inlined[0], inlined[2]]), ["ieee754 is in the bundle's license banner but not in vendor.json's inlined packages"]);
  assert.deepEqual(C.inlinedFindings("var x;", inlined), [], "a bundle without a banner says nothing");
});
