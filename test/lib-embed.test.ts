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

// (the lazy part, P3a: names whose files come from a second blob, decoded on the first read of one of them; grader's
// r820 pins) a blob that isn't exactly the named files, one missing, one extra, or the same count with another
// name, throws at that first read and settles nothing: every lazy name stays its getter, and a later read throws
// again rather than finding a partial library; a name the eager part also has, or listed twice, is refused at install
test("the lazy part: a blob that isn't exactly its named files throws at the first read and settles none of them", () => {
  const eager = payloadOf({ "a.py": "1\n" });
  const names = ["l1.py", "l2.py"];
  const blobs: [string, Record<string, string>][] = [
    ["a name missing", { "l1.py": "x\n" }],
    ["an extra name", { "l1.py": "x\n", "l2.py": "y\n", "l3.py": "z\n" }],
    ["the same count, another name", { "l1.py": "x\n", "lx.py": "y\n" }],
  ];
  for (const [what, files] of blobs) {
    const g: any = {};
    installEmbeddedLib(g, eager, payloadOf(files), names);
    const lib = g.__PYJS_LIB__;
    assert.equal(lib["a.py"], "1\n", `${what}: the eager part is there`);
    for (const n of names) {
      assert.throws(() => lib[n], /the embedded library's lazy part is not the files it names/, `${what}: reading ${n}`);
      for (const m of names) assert.equal(typeof Object.getOwnPropertyDescriptor(lib, m)!.get, "function", `${what}: ${m} not settled after reading ${n}`);
    }
    assert.equal("lx.py" in lib || "l3.py" in lib, false, `${what}: no file of the bad blob installed`);
  }
  // (and the right blob settles both names as plain values, decoded once)
  const g: any = {};
  installEmbeddedLib(g, eager, payloadOf({ "l1.py": "x\n", "l2.py": "y\n" }), names);
  const lib = g.__PYJS_LIB__, before = libEmbedStats.lazyDecodes;
  assert.equal(lib["l2.py"], "y\n");
  assert.equal(lib["l1.py"], "x\n");
  assert.equal(libEmbedStats.lazyDecodes, before + 1, "decoded once");
  for (const n of names) assert.equal(Object.getOwnPropertyDescriptor(lib, n)!.value, lib[n], `${n} a plain value`);
});

test("the lazy part: a name the eager part also has, or a name listed twice, is refused", () => {
  const g: any = {};
  installEmbeddedLib(g, payloadOf({ "a.py": "1\n" }), payloadOf({ "a.py": "2\n" }), ["a.py"]);
  assert.throws(() => g.__PYJS_LIB__, /the embedded library names a\.py twice/);
  const h: any = {};
  installEmbeddedLib(h, payloadOf({ "a.py": "1\n" }), payloadOf({ "l.py": "2\n" }), ["l.py", "l.py"]);
  assert.throws(() => h.__PYJS_LIB__, /the embedded library names l\.py twice/);
});
