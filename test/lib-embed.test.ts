import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { installEmbeddedLib, libEmbedStats } from "../src/lib-embed";

// The CLI's embedded library, compressed (src/lib-embed.ts; plan cli-lib-gzip-plan-r1): the payload made exactly as
// scripts/build-cli.mjs makes it, decoded by the production installer on a fresh global object.

const ROOT = join(__dirname, "..", "..");
// (scripts/build-id.mjs is the library's one definition, which build-cli.mjs uses too)
const libFiles = async () => (await import(join(ROOT, "scripts", "build-id.mjs"))).libFiles(ROOT + "/") as Record<string, string>;
const payloadOf = (lib: unknown) => gzipSync(Buffer.from(JSON.stringify(lib), "utf8"), { level: 9 }).toString("base64");

test("the embedded library decodes to exactly the library: every path, every source, byte for byte", async () => {
  const lib = await libFiles();
  assert.ok(Object.keys(lib).length > 100, "the real library");
  const g: any = {};
  installEmbeddedLib(g, payloadOf(lib));
  const got = g.__PYJS_LIB__;
  assert.deepEqual(Object.keys(got).sort(), Object.keys(lib).sort());
  for (const k of Object.keys(lib)) assert.ok(Buffer.from(got[k], "utf8").equals(Buffer.from(lib[k], "utf8")), `${k}: the same bytes`);
});

test("decoded once: the getter becomes a plain data property (a global assignment's flags), the compressed string goes, the same object after", async () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "x = 1\n", "b/c.py": "é\n" }));
  assert.equal(typeof g.__PYJS_LIB_GZ__, "string", "compressed until read");
  assert.equal(typeof Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!.get, "function", "a getter until read");
  const before = libEmbedStats.decodes;
  const first = g.__PYJS_LIB__;
  assert.equal(libEmbedStats.decodes, before + 1, "the production decoder ran once");
  const d = Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!;
  assert.deepEqual({ get: d.get, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable }, { get: undefined, writable: true, enumerable: true, configurable: true });
  assert.equal("__PYJS_LIB_GZ__" in g, false, "the compressed string deleted");
  assert.equal(g.__PYJS_LIB__, first, "the same object on the second read");
  assert.equal(libEmbedStats.decodes, before + 1, "and no second decode");
  assert.deepEqual(first, { "a.py": "x = 1\n", "b/c.py": "é\n" });
});

test("a failed decode throws its own error and installs nothing: the getter and the compressed string stay", () => {
  const g: any = {};
  installEmbeddedLib(g, Buffer.from("not gzip").toString("base64"));
  assert.throws(() => g.__PYJS_LIB__, (e: any) => e && /header|gzip|incorrect/i.test(String(e.message ?? e)));
  assert.equal(typeof g.__PYJS_LIB_GZ__, "string", "the compressed string kept");
  assert.equal(typeof Object.getOwnPropertyDescriptor(g, "__PYJS_LIB__")!.get, "function", "still the getter");
  // (not UTF-8 inside a valid gzip: the decoder's TypeError, nothing installed.  The bytes are valid JSON but for
  // the 0xff inside the string, so a lossy decode would parse and install {"a.py": "\ufffd"}: this pins fatal: true)
  const h: any = {};
  installEmbeddedLib(h, gzipSync(Buffer.concat([Buffer.from('{"a.py":"', "utf8"), Buffer.from([0xff]), Buffer.from('"}', "utf8")])).toString("base64"));
  assert.throws(() => h.__PYJS_LIB__, TypeError);
  assert.equal(typeof h.__PYJS_LIB_GZ__, "string", "the compressed string kept");
  assert.equal(typeof Object.getOwnPropertyDescriptor(h, "__PYJS_LIB__")!.get, "function", "still the getter");
});

test("an assignment before any read replaces the getter with the value, as a plain global would", () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "1\n" }));
  const before = libEmbedStats.decodes;
  g.__PYJS_LIB__ = { "z.py": "2\n" };
  assert.deepEqual(g.__PYJS_LIB__, { "z.py": "2\n" });
  assert.equal(libEmbedStats.decodes, before, "nothing decoded");
  assert.equal("__PYJS_LIB_GZ__" in g, false);
});
