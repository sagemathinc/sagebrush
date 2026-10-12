import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "../src/compile";

// `global x` / `nonlocal x` after what in the same scope: CPython 3.14's
// answers (compile() of each, as a module and in a function), REACT-D2C5-3.
// Imports never count; a `:=` in a comprehension counts in a function but
// not at a module's top level; annotations of other names are evaluated
// later, in scopes of their own.
const USED = "is used prior to global declaration", ASSIGNED = "is assigned to before global declaration", ANNOTATED = "can't be global";
const CASES: [string, string, string | null, string | null][] = [
  // [what, statement before `global x`, at module level, in a function]
  ["assign", "x = 1", ASSIGNED, ASSIGNED],
  ["augassign", "x += 1", ASSIGNED, ASSIGNED],
  ["annotation", "x: int", ANNOTATED, ANNOTATED],
  ["annotation with a value", "x: int = 1", ANNOTATED, ANNOTATED],
  ["read", "print(x)", USED, USED],
  ["del", "del x", ASSIGNED, ASSIGNED],
  ["import", "import x", null, null],
  ["import as", "import math as x", null, null],
  ["import in an if", "if False:\n    import math as x", null, null],
  ["from import", "from math import x", null, null],
  ["from import as", "from math import floor as x", null, null],
  ["for", "for x in []: pass", ASSIGNED, ASSIGNED],
  ["with", "with a as x: pass", ASSIGNED, ASSIGNED],
  ["except", "try: pass\nexcept E as x: pass", ASSIGNED, ASSIGNED],
  ["def", "def x(): pass", ASSIGNED, ASSIGNED],
  ["class", "class x: pass", ASSIGNED, ASSIGNED],
  ["walrus", "(x := 2)", ASSIGNED, ASSIGNED],
  ["walrus in a comprehension", "[(x := 2) for _ in [0]]", null, ASSIGNED],
  ["walrus in an empty comprehension", "[(x := 2) for _ in []]", null, ASSIGNED],
  ["read in a comprehension", "[x for _ in [0]]", null, null],
  ["read in a comprehension's first iterable", "[_ for _ in x]", USED, USED],
  ["read in a lambda", "lambda: x", null, null],
  ["read in a default", "def f(a=x): pass", USED, USED],
  ["parameter annotation", "def f(a: x): pass", null, null],
  ["return annotation", "def f() -> x: pass", null, null],
  ["another name's annotation", "y: x", null, null],
  ["another name's annotation with a value", "y: x = 3", null, null],
  ["import then read", "import math as x\nprint(x)", USED, USED],
  ["global, assign", "global x\nx = 1", ASSIGNED, ASSIGNED],
  ["global twice", "global x", null, null],
];

const error = (src: string): string | null => {
  try {
    compile(src, "<test>", "__main__");
    return null;
  } catch (e: any) {
    return String(e?.msg ?? e?.message ?? e);
  }
};

test("global after what, as CPython 3.14 (REACT-D2C5-3)", () => {
  const wrong: string[] = [];
  for (const [what, before, mod, fn] of CASES) {
    for (const [where, src, want] of [
      ["module", before + "\nglobal x", mod],
      ["function", "def g():\n" + (before + "\nglobal x").split("\n").map((l) => "    " + l).join("\n"), fn],
    ] as const) {
      const got = error(src);
      if (want === null ? got !== null : !got?.includes(want)) wrong.push(`${what} (${where}): got ${got}, want ${want}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("nonlocal after what, as CPython 3.14", () => {
  const inner = (body: string) => "def g():\n    x = 2\n    def h():\n" + body.split("\n").map((l) => "        " + l).join("\n") + "\n        nonlocal x";
  assert.match(error(inner("x = 1"))!, /is assigned to before nonlocal declaration/);
  assert.match(error(inner("print(x)"))!, /is used prior to nonlocal declaration/);
  assert.equal(error(inner("import math as x")), null);
  // (class bodies: the same)
  assert.equal(error("class C:\n    import math as x\n    global x"), null);
  assert.match(error("class C:\n    print(x)\n    global x")!, /is used prior to global declaration/);
});
