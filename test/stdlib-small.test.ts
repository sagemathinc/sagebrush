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

test("mappingproxy's | and comparisons are its mapping's; translate and maketrans take int and str subclasses; UserString.maketrans is static; set and dict subclasses' operators are their own; |= on a frozenset makes a new one", () => {
  same("stdlib_small_fix_cases.py");
});

test("textwrap refuses text with characters beyond U+FFFF, which Sagebrush's strings count as two, rather than cut one in half", () => {
  const code = "import textwrap\nfor f in (lambda: textwrap.wrap('\\U0001F600', width=1), lambda: textwrap.fill('a \\U0001F30E b', width=3), lambda: textwrap.shorten('hi \\U0001F600 there', width=8)):\n    try:\n        print(f())\n    except NotImplementedError as e:\n        print(e)\nprint(textwrap.wrap('\\u4f60\\u597d world', width=5))\n";
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  const msg = (c: string) => `textwrap: text with characters beyond U+FFFF (such as '${c}') is not supported in Sagebrush yet`;
  assert.equal(got, [msg("\u{1F600}"), msg("\u{1F30E}"), msg("\u{1F600}"), "['你好', 'world']", ""].join("\n"));
});
