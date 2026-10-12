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

test("page-order scoping's names (x\u02b92), and Sage chains", () => {
  const codes = ["x = 1", "x = x + 1", "x = x * 10", "print(x)"];
  const cells = codes.map((code, i) => { const a = analyzeCell(code); return { id: `c${i}`, code, defines: a.defs.has("x"), reads: a.refs.has("x") }; });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(cells, "x", new Set(["x"]), "python", "\u02b9")!), { c1: "x\u02b92 = x + 1", c2: "x\u02b93 = x\u02b92 * 10", c3: "print(x\u02b93)" });
  const sage = ["R.<x> = QQ[]", "x = var('x')", "f = x^2 + 1/2\nx = 3"].map((code, i) => { const a = analyzeCell(code, "c", { mode: "sage" }); return { id: `c${i}`, code, defines: a.defs.has("x"), reads: a.refs.has("x") }; });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(sage, "x", new Set(["x"]), "sage", "\u02b9")!), { c1: "x\u02b92 = SR.var('x')", c2: "f = x\u02b92^2 + 1/2\nx\u02b93 = 3" });
});

test("a Sage cell defining x by var('x') alone", () => {
  const codes = ["x = polygen(QQ)", "var('x')\nprint(x^2)", "print(x)"];
  const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode: "sage" }); return { id: `c${i}`, code, defines: a.defs.has("x"), reads: a.refs.has("x") }; });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(cells, "x", new Set(["x"]), "sage", "\u02b9")!), { c1: 'x\u02b92 = SR.var("x")\nprint(x\u02b92^2)', c2: "print(x\u02b92)" });
});

test("Sage's K.<a> = ... (the preparser adds an occurrence of K)", () => {
  const codes = ["K.<a> = NumberField(x^3 - 11)\nK, K.discriminant()", "K.<a> = NumberField(x^7 - 11)\nK, K.discriminant(), a^7", "K", "print(a, K.degree())"];
  const cells = (name: string) => codes.map((code, i) => { const an = analyzeCell(code, "c", { mode: "sage" }); return { id: `c${i}`, code, defines: an.defs.has(name), reads: an.refs.has(name) }; });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(cells("K"), "K", new Set(["K", "a"]), "sage", "\u02b9")!), {
    c1: "K\u02b92.<a> = NumberField(x^7 - 11)\nK\u02b92, K\u02b92.discriminant(), a^7", c2: "K\u02b92", c3: "print(a, K\u02b92.degree())",
  });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(cells("a"), "a", new Set(["K", "a"]), "sage", "\u02b9")!), {
    c1: "K.<a\u02b92> = NumberField(x^7 - 11)\nK, K.discriminant(), a\u02b92^7", c3: "print(a\u02b92, K.degree())",
  });
  // a keyword argument is not the name
  assert.equal(renameInCell("K = 1\nf(K=K)", "K", "K2", { mode: "sage" }), "K2 = 1\nf(K=K2)");
});

test("review cases: compound statements, class attributes, x += 1, Sage var (REACT-F6, F7)", () => {
  const q = (codes: string[], name: string, mode: "python" | "sage" = "python") => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode }); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), mode, "\u02b9");
    return r && Object.fromEntries(r);
  };
  // the loop's body reads the loop's x; the iterable reads the old one
  assert.deepEqual(q(["x = 10", "for x in [2, 3]:\n    print(x)", "print(x)"], "x"), { c1: "for x\u02b92 in [2, 3]:\n    print(x\u02b92)", c2: "print(x\u02b92)" });
  assert.deepEqual(q(["x = 10", "for x in [x, 3]:\n    print(x)"], "x"), { c1: "for x\u02b92 in [x, 3]:\n    print(x\u02b92)" });
  assert.deepEqual(q(["x = 10", "if True:\n    x = 2\n    print(x)"], "x"), { c1: "if True:\n    x\u02b92 = 2\n    print(x\u02b92)" });
  // a use in a loop before the definition in that loop, a loop that may not
  // run: the new name starts as the previous value and every occurrence is
  // the new name (before William's decision of October 12: refused)
  assert.deepEqual(q(["x = 10", "while x < 20:\n    x = x + 1"], "x"), { c1: "if 'x' in (lambda: 0).__globals__ or 'x' in (lambda: 0).__builtins__: xʹ2 = (lambda: x)()  # page-order scoping\nwhile xʹ2 < 20:\n    xʹ2 = xʹ2 + 1" });
  // methods do not see class attributes
  assert.deepEqual(q(["x = 1", "x = 2\nclass C:\n    x = 100\n    def f(self):\n        return x", "print(C().f(), x)"], "x"), {
    c1: "x\u02b92 = 2\nclass C:\n    x = 100\n    def f(self):\n        return x\u02b92", c2: "print(C().f(), x\u02b92)",
  });
  // x += 1: the new x starts from the old one
  assert.deepEqual(q(["x = 1", "x += 1", "print(x)"], "x"), { c1: "x\u02b92 = x; x\u02b92 += 1", c2: "print(x\u02b92)" });
  // Sage: x = var('x') redefining x does not set the first x
  assert.deepEqual(q(["x = 123", "print(x)", "x = var('x')", "print(x)"], "x", "sage"), { c2: "x\u02b92 = SR.var('x')", c3: "print(x\u02b92)" });
});

test("Sage cells with names of other scripts are renamed", () => {
  const codes = ["\u03b1 = 1", "\u03b1 = \u03b1 + 1", "print(\u03b1^2)"];
  const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode: "sage" }); return { id: `c${i}`, code, defines: a.defs.has("\u03b1"), reads: a.refs.has("\u03b1") }; });
  assert.deepEqual(Object.fromEntries(renameRedefinitions(cells, "\u03b1", new Set(["\u03b1"]), "sage", "\u02b9")!), { c1: "\u03b1\u02b92 = \u03b1 + 1", c2: "print(\u03b1\u02b92^2)" });
});

test("second review: method defaults, global in a function, var in strings", () => {
  const q = (codes: string[], name: string, mode: "python" | "sage" = "python") => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode }); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), mode, "\u02b9");
    return r && Object.fromEntries(r);
  };
  // a method's default is evaluated in the class body (its x); the method's body sees the module's
  assert.deepEqual(q(["x = 1", "print(x)", "x = 2\nclass C:\n    x = 100\n    def f(self, a=x):\n        return a, x", "print(C().f(), x)"], "x"), {
    c2: "x\u02b92 = 2\nclass C:\n    x = 100\n    def f(self, a=x):\n        return a, x\u02b92", c3: "print(C().f(), x\u02b92)",
  });
  // global x and the assignment it declares get the same name
  assert.deepEqual(q(["x = 1", "def f():\n    global x\n    x = 2\nf()", "print(x)"], "x"), { c1: "def f():\n    global x\u02b92\n    x\u02b92 = 2\nf()", c2: "print(x\u02b92)" });
  // var in a string is a string
  assert.deepEqual(q(["x = 1", "print(x)", "x = 2\nprint(\"var('x')\")", "print(x)"], "x", "sage"), { c2: "x\u02b92 = 2\nprint(\"var('x')\")", c3: "print(x\u02b92)" });
});

test("third review: class bodies in execution order, nested classes, multi-line strings", () => {
  const q = (codes: string[], name: string, mode: "python" | "sage" = "python") => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode }); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), mode, "\u02b9");
    return r && Object.fromEntries(r);
  };
  // a default evaluated before the class assigns x reads the module's x
  assert.deepEqual(q(["x = 1", "print(x)", "x = 2\nclass C:\n    def f(self, a=x):\n        return a\n    x = 100", "print(C().f(), x)"], "x"), {
    c2: "x\u02b92 = 2\nclass C:\n    def f(self, a=x\u02b92):\n        return a\n    x = 100", c3: "print(C().f(), x\u02b92)",
  });
  // a nested class's method sees the module's x, not the nested class's attribute
  assert.deepEqual(q(["x = 1", "print(x)", "x = 2\nclass C:\n    class D:\n        x = 100\n        def f(self):\n            return x", "print(C.D().f(), x)"], "x"), {
    c2: "x\u02b92 = 2\nclass C:\n    class D:\n        x = 100\n        def f(self):\n            return x\u02b92", c3: "print(C.D().f(), x\u02b92)",
  });
  // var('x') inside a triple-quoted string spanning lines is text
  assert.deepEqual(q(["x = 1", "print(x)", 'x = 2\nprint("""hello\nvar(\'x\')\nbye""")', "print(x)"], "x", "sage"), {
    c2: 'x\u02b92 = 2\nprint("""hello\nvar(\'x\')\nbye""")', c3: "print(x\u02b92)",
  });
});

test("fourth review: class bodies through compound statements and nested scopes, Sage var keywords", () => {
  const q = (codes: string[], name: string, mode: "python" | "sage" = "python") => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c", { mode }); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), mode, "\u02b9");
    return r && Object.fromEntries(r);
  };
  const S = "x\u02b92";
  // after `del x` the class body reads the module's x again
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    del x\n    y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    x=100\n    del x\n    y=${S}`, c3: `print(C.y,${S})` });
  // a binding inside an if is seen after it in its branch
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    if True:\n        x=100\n        y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    if True:\n        x=100\n        y=x`, c3: `print(C.y,${S})` });
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    if True:\n        x=100\n    y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    if True:\n        x=100\n    y=x`, c3: `print(C.y,${S})` });
  // ... and before it, the module's
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    for i in range(2):\n        y=1\n    z=x\n    with open('f') as x:\n        pass", "print(C.z,x)"], "x"), { c2: `${S}=2\nclass C:\n    for i in range(2):\n        y=1\n    z=${S}\n    with open('f') as x:\n        pass`, c3: `print(C.z,${S})` });
  // lambdas, comprehensions and functions under a compound statement do not see the class's x
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    f=lambda self: x", "print(C().f(),x)"], "x"), { c2: `${S}=2\nclass C:\n    x=100\n    f=lambda self: ${S}`, c3: `print(C().f(),${S})` });
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    ys=[x for _i in range(1)]", "print(C.ys,x)"], "x"), { c2: `${S}=2\nclass C:\n    x=100\n    ys=[${S} for _i in range(1)]`, c3: `print(C.ys,${S})` });
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    if True:\n        def f(self): return x", "print(C().f(),x)"], "x"), { c2: `${S}=2\nclass C:\n    x=100\n    if True:\n        def f(self): return ${S}`, c3: `print(C().f(),${S})` });
  // the first iterable of a comprehension is evaluated in the class body
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=[100]\n    ys=[i for i in x]", "print(C.ys,x)"], "x"), { c2: `${S}=2\nclass C:\n    x=[100]\n    ys=[i for i in x]`, c3: `print(C.ys,${S})` });
  // a load that reads the class's x or the module's depending on the run cannot be renamed
  assert.equal(q(["x=1", "print(x)", "x=2\nclass C:\n    if c:\n        x=100\n    y=x", "print(C.y,x)"], "x"), null);
  assert.equal(q(["x=1", "print(x)", "x=2\nclass C:\n    for i in range(2):\n        y=x\n        x=i", "print(C.y,x)"], "x"), null);
  assert.equal(q(["x=1", "print(x)", "x=2\nclass C:\n    x+=1", "print(C.x,x)"], "x"), null);
  // `except E as x` deletes x at its end; `global x` in a class body makes it the module's
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    try:\n        pass\n    except E as x:\n        pass\n    y=x", "print(C.y,x)"], "x"), null);
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    global x\n    x=3\n    y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    global ${S}\n    ${S}=3\n    y=${S}`, c3: `print(C.y,${S})` });
  // var('x') after an escaped triple quote in a string is text
  assert.deepEqual(q(["x=1", "print(x)", 'x=2\nprint("""hello\\"""\nvar(\'x\')\nbye""")', "print(x)"], "x", "sage"), { c2: `${S}=2\nprint("""hello\\"""\nvar('x')\nbye""")`, c3: `print(${S})` });
});

test("fifth review: break, continue, loop else, with, del of a tuple, walrus, bare annotations, except as", () => {
  const q = (codes: string[], name: string) => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c"); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), "python", "\u02b9");
    return r && Object.fromEntries(r);
  };
  const S = "x\u02b92";
  // a loop that binds or deletes the name leaves its reads after it undetermined: refused
  for (const loop of ["    for _i in range(1):\n        del x\n        break\n        x=200", "    for _i in range(1):\n        del x\n        continue\n        x=200", "    for _i in range(1):\n        break\n    else:\n        del x"]) {
    assert.equal(q(["x=1", "print(x)", `x=2\nclass C:\n    x=100\n${loop}\n    y=x`, "print(C.y,x)"], "x"), null, loop);
  }
  // a with body may stop anywhere (a context manager may suppress the exception)
  assert.equal(q(["x=1", "print(x)", "x=2\nclass C:\n    with Ignore():\n        1/0\n        x=100\n    y=x", "print(C.y,x)"], "x"), null);
  // del (x, z) deletes x
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x=100\n    z=200\n    del (x,z)\n    y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    x=100\n    z=200\n    del (x,z)\n    y=${S}`, c3: `print(C.y,${S})` });
  // a walrus in a test binds the class's x
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    if (x:=100):\n        y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    if (x:=100):\n        y=x`, c3: `print(C.y,${S})` });
  // `x: int` alone binds nothing
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    x: int\n    y=x", "print(C.y,x)"], "x"), { c2: `${S}=2\nclass C:\n    x: int\n    y=${S}`, c3: `print(C.y,${S})` });
  // `except E as x` binding the global (a class body's global, or the module's)
  assert.deepEqual(q(["x=1", "print(x)", "x=2\nclass C:\n    global x\n    try:\n        1/0\n    except ZeroDivisionError as x:\n        y=str(x)", "print(C.y)"], "x"), { c2: `${S}=2\nclass C:\n    global ${S}\n    try:\n        1/0\n    except ZeroDivisionError as ${S}:\n        y=str(${S})` });
  assert.deepEqual(q(["x=1", "print(x)", "x=2\ntry:\n    1/0\nexcept ZeroDivisionError as x:\n    y=str(x)", "print(y, x)"], "x"), { c2: `${S}=2\ntry:\n    1/0\nexcept ZeroDivisionError as ${S}:\n    y=str(${S})`, c3: `print(y, ${S})` });
  // deep loops are analyzed in linear time
  const deep = "x=2\nclass C:\n" + Array.from({ length: 40 }, (_, i) => " ".repeat(4 * (i + 1)) + `for _i${i} in range(1):`).join("\n") + "\n" + " ".repeat(164) + "z=x";
  const t = Date.now();
  assert.ok(q(["x=1", "print(x)", deep, "print(C.z,x)"], "x"));
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
});

test("sixth review: walrus that may not run, bindings in def and class headers, except as after its type", () => {
  const q = (codes: string[], name: string) => {
    const cells = codes.map((code, i) => { const a = analyzeCell(code, "c"); return { id: `c${i}`, code, defines: a.defs.has(name), reads: a.refs.has(name) }; });
    const r = renameRedefinitions(cells, name, new Set([name]), "python", "\u02b9");
    return r && Object.fromEntries(r);
  };
  const S = "x\u02b92";
  const cls = (body: string) => q(["x=1", "print(x)", `x=2\nclass C:\n${body}`, "print(C.y,x)"], "x");
  // a := that may not run: the read after it is undetermined (refused)
  for (const body of ["    if 0 > 1 > (x:=100):\n        pass\n    y=x", "    assert True,(x:=100)\n    y=x", "    if False and (x:=100):\n        pass\n    y=x", "    if True or (x:=100):\n        y=x", "    (x:=100) if False else None\n    y=x"]) assert.equal(cls(body), null, body);
  // one that surely runs binds the class's x
  assert.deepEqual(cls("    (x:=100) and False\n    y=x"), { c2: `${S}=2\nclass C:\n    (x:=100) and False\n    y=x`, c3: `print(C.y,${S})` });
  // := in a def's defaults or a class's bases binds the class's x
  assert.deepEqual(cls("    def f(a=(x:=100)):\n        pass\n    y=x"), { c2: `${S}=2\nclass C:\n    def f(a=(x:=100)):\n        pass\n    y=x`, c3: `print(C.y,${S})` });
  assert.deepEqual(cls("    class D(object if (x:=100) else object):\n        pass\n    y=x"), { c2: `${S}=2\nclass C:\n    class D(object if (x:=100) else object):\n        pass\n    y=x`, c3: `print(C.y,${S})` });
  // x = x + 1 in a class body reads the module's x (not refused)
  assert.deepEqual(cls("    x = x + 1\n    y=x"), { c2: `${S}=2\nclass C:\n    x = ${S} + 1\n    y=x`, c3: `print(C.y,${S})` });
  // the target of `except E as x` is the one after E, not text in a string
  assert.deepEqual(q(["x=1", "print(x)", "x=2\ntry:\n    1/0\nexcept (ZeroDivisionError if 'as x:' else Exception) as x:\n    result=str(x)", "print(result, x)"], "x"),
    { c2: `${S}=2\ntry:\n    1/0\nexcept (ZeroDivisionError if 'as x:' else Exception) as ${S}:\n    result=str(${S})`, c3: `print(result, ${S})` });
  assert.deepEqual(q(["x=1", "print(x)", "x=2\ntry:\n    1/0\nexcept (ValueError, ZeroDivisionError) as x:\n    result=str(x)", "print(result, x)"], "x"),
    { c2: `${S}=2\ntry:\n    1/0\nexcept (ValueError, ZeroDivisionError) as ${S}:\n    result=str(${S})`, c3: `print(result, ${S})` });
  // a function's := in a comprehension makes x its local
  assert.deepEqual(q(["x=1", "print(x)", "x=2\ndef f():\n    [(x := i) for i in range(3)]\n    return x", "print(f(), x)"], "x"), { c2: `${S}=2\ndef f():\n    [(x := i) for i in range(3)]\n    return x`, c3: `print(f(), ${S})` });
});
