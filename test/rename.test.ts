import test from "node:test";
import assert from "node:assert/strict";
import { renameInCell, renameRedefinitions } from "../src/rename";
import { analyzeCell } from "../src/dataflow";

// src/rename.ts: renaming a global in cells, for the fix of multiple definitions.

test("renaming a global, with Python's scoping", () => {
  assert.equal(renameInCell("x = x + 1\nprint(x)", "x", "x_2", { from: "definition" }), "x_2 = x + 1\nprint(x_2)");
  assert.equal(renameInCell("print(x)\nx = 1\ny = x", "x", "x_2", { from: "definition" }), "print(x)\nx_2 = 1\ny = x_2");
  // locals, parameters, comprehensions, attributes and keyword arguments are not the global
  assert.equal(
    renameInCell("def f(x):\n    return x\ndef g():\n    x = 2\n    return x\ndef h():\n    return x\nz = [x for x in range(3)]\nw = [x + i for i in range(3)]\no.x = f(x=x)", "x", "x_2"),
    "def f(x):\n    return x\ndef g():\n    x = 2\n    return x\ndef h():\n    return x_2\nz = [x for x in range(3)]\nw = [x_2 + i for i in range(3)]\no.x = f(x=x_2)",
  );
  // global in a function; def, class and import names; strings and comments are not touched
  assert.equal(renameInCell("def f():\n    global x\n    x = 1\nprint('x', x)  # x", "x", "y"), "def f():\n    global y\n    y = 1\nprint('x', y)  # x");
  assert.equal(renameInCell("def x(): pass\nclass x: pass\nimport numpy as x\nfrom m import x\nimport x", "x", "x_2"), "def x_2(): pass\nclass x_2: pass\nimport numpy as x_2\nfrom m import x as x_2\nimport x as x_2");
  assert.equal(renameInCell("import x.y", "x", "x_2"), null);
  // non-ASCII before the name
  assert.equal(renameInCell("s = 'é'; x = 1", "x", "x_2"), "s = 'é'; x_2 = 1");
});

test("Sage cells are renamed through the preparser", () => {
  assert.equal(renameInCell("x = 2^3\nprint(x/2)", "x", "x_2", { mode: "sage" }), "x_2 = 2^3\nprint(x_2/2)");
  assert.equal(renameInCell("x = x^2 + 1", "x", "x_2", { mode: "sage", from: "definition" }), "x_2 = x^2 + 1");
  assert.equal(renameInCell("x := 1;", "x", "y", { mode: "magma" }), null);
});

test("a notebook in Jupyter's order: each later definition gets a new name", () => {
  const codes = ["x = 1", "print(x)", "x = x + 1", "print(x)", "x = x * 10", "y = x"];
  const cells = codes.map((code, i) => { const a = analyzeCell(code); return { id: `c${i}`, code, defines: a.defs.has("x"), reads: a.refs.has("x") }; });
  const r = renameRedefinitions(cells, "x", new Set(["x", "y", "x_2"]));
  assert.deepEqual(Object.fromEntries(r!), { c2: "x_3 = x + 1", c3: "print(x_3)", c4: "x_4 = x_3 * 10", c5: "y = x_4" });
});
