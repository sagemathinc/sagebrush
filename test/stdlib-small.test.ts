import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Modules and types that the coverage corpora found missing or wrong, each
// compared with what CPython 3.14 prints for the same program.
const TEST = __dirname + "/../../test/";
const same = (name: string, norm = (s: string) => s) => {
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  assert.equal(norm(got), norm(want));
};

test("__future__, pprint and textwrap as CPython's (CPython 3.14's modules)", () => {
  // (pprint names a recursive object by its id)
  same("stdlib_small_cases.py", (s) => s.replace(/id=\d+/g, "id=?"));
});

test("collections.abc is CPython's _collections_abc; UserDict, UserList, UserString and ChainMap are CPython's", () => {
  same("collections_cases.py");
});

test("types.MappingProxyType and a class's __dict__ are read-only views; str.translate and str.maketrans; longrange_iterator", () => {
  same("views_cases.py");
});
