import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matlabToPython, matlabFunctionFileToPython, matlabHostOps, checkTreeDepth, MatlabSyntaxError, MAX_NESTING, MAX_CHAIN, MAX_TREE_DEPTH, NESTING_MESSAGE, CHAIN_MESSAGE } from "../src/matlab";

// Malformed or extreme MATLAB is MATLAB's error, never a host crash: whatever the input, the translator returns Python
// or raises MatlabSyntaxError, never a JS exception (a RangeError of the host's stack above all), and the generated
// Python stays inside what the engine's compiler accepts.  Notebooks, the Terminal, .m files and a shared LaTeX
// document's MATLAB all reach the translator.  The bounds (MAX_NESTING, MAX_CHAIN, and the generated Python's) were
// measured end to end with Node's default stack and with 400 KB and 250 KB (see src/matlab.ts).
const CLI = join(__dirname, "..", "src", "cli.js");
const HOST = /RangeError|Maximum call stack|TypeError|Traceback|RecursionError|at .*\.js:\d+/;

/** "ok" (Python), "syntax: <message>" (MatlabSyntaxError), or "HOST <class>: <message>" */
function translate(src: string): string {
  try {
    matlabToPython(src, "matlabblock 1", { cell: true });
    return "ok";
  } catch (e) {
    if (e instanceof MatlabSyntaxError) return "syntax: " + e.message;
    return `HOST ${(e as Error).constructor.name}: ${String((e as Error).message).slice(0, 80)}`;
  }
}

const rep = (s: string, n: number) => s.repeat(n);
const SHAPES: Record<string, (n: number) => string> = {
  parens: (n) => "x = " + rep("(", n) + "1" + rep(")", n),
  brackets: (n) => "x = " + rep("[", n) + "1" + rep("]", n),
  cells: (n) => "x = " + rep("{", n) + "1" + rep("}", n),
  calls: (n) => "x = " + rep("abs(", n) + "-1" + rep(")", n),
  index: (n) => "a = 5; x = a" + rep("(1)", n),
  minus: (n) => "x = " + rep("-", n) + "1",
  transpose: (n) => "x = 1" + rep("'", n),
  power: (n) => "x = 1" + rep("^1", n),
  ifs: (n) => rep("if 1\n", n) + "x = 1\n" + rep("end\n", n),
  fors: (n) => rep("for i = 1:1\n", n) + "x = 1\n" + rep("end\n", n),
  anon: (n) => "f = " + rep("@(x) ", n) + "1",
};

test("the inputs that crashed the host: each is now MATLAB's syntax error", () => {
  for (const [name, f] of Object.entries(SHAPES)) {
    for (const n of [1000, 100000]) {
      const r = translate(f(n));
      assert.equal(r, "syntax: " + NESTING_MESSAGE, `${name} ${n}: ${r}`);
    }
  }
  for (const n of [MAX_CHAIN + 1, 100000, 500000]) assert.equal(translate("x = " + Array(n + 1).fill("1").join("+")), "syntax: " + CHAIN_MESSAGE, `chain ${n}`);
});

// (measured at this head: parentheses vanish in the Python, so only the budget binds them; brackets, braces and calls
// are bound by the generated Python's brackets (50); blocks by its indentation (90, a cell's code one level in);
// signs, transposes and powers by the budget, two levels a step for signs and transposes)
const DEEPEST: Record<string, number> = {
  parens: 99, brackets: 25, cells: 16, calls: 24, index: 49, minus: 50, transpose: 50, power: 99, ifs: 89, fors: 89, anon: 50,
};

test("every bound: the deepest accepted input translates, one level more is MATLAB's syntax error", () => {
  for (const [name, f] of Object.entries(SHAPES)) {
    let last = 0;
    for (let n = 1; n <= MAX_NESTING + 2; n++) {
      const r = translate(f(n));
      if (r === "ok") { last = n; continue; }
      assert.equal(r, "syntax: " + NESTING_MESSAGE, `${name} ${n}: ${r}`);
      break;
    }
    // (each shape's deepest accepted depth, exactly: whichever bound binds it, the shared nesting budget, the
    // generated Python's brackets or its indentation, a change to that bound moves this number)
    assert.equal(last, DEEPEST[name], `${name}: the deepest accepted depth`);
    for (let n = last + 1; n <= last + 3; n++) assert.equal(translate(f(n)), "syntax: " + NESTING_MESSAGE, `${name} ${n}`);
  }
  assert.equal(translate("x = " + Array(MAX_CHAIN + 1).fill("1").join("+")), "ok", "a chain of MAX_CHAIN operators");
  assert.equal(translate("x = " + Array(MAX_CHAIN + 2).fill("1").join("+")), "syntax: " + CHAIN_MESSAGE);
});

test("unterminated text, end of input inside a construct, and other malformed input: MATLAB's errors", () => {
  const cases: [string, RegExp | "ok"][] = [
    ["x = 'abc", /unterminated character vector/], ['x = "abc', /unterminated string/], ["x = '" + "a".repeat(200000), /unterminated/],
    ["if x > 1\n y = 2", /expected 'end'/], ["for i = 1:3\n disp(i)", /expected 'end'/], ["while true", /expected 'end'/],
    ["switch x\n case 1", /expected 'end'/], ["try\n x = 1", /expected/], ["x = [1 2", /end of input|expected/], ["x = {1, 2", /end of input|expected/],
    ["x = f(1, 2", /expected '\)'/], ["x = 1 +", /end of input/], ["x = 1 + ...", /end of input/], ["f = @(x", /end of input/],
    ["x{", /end of input/], ["end", /unexpected 'end'/], ["x = 1]", /unexpected/], ["function", /end of input/], ["x = 1\u0000 + 2", /invalid character/],
    // (valid MATLAB: a function file's last function needs no end, and an unclosed %{ comments out the rest)
    ["function y = f(x)\n y = x", "ok"], ["%{\nnot closed\nx = 1", "ok"],
  ];
  for (const [src, want] of cases) {
    const r = translate(src);
    if (want === "ok") assert.equal(r, "ok", JSON.stringify(src.slice(0, 40)));
    else assert.match(r, new RegExp("^syntax: .*" + want.source), `${JSON.stringify(src.slice(0, 40))}: ${r}`);
  }
});

test("fuzz: random MATLAB-like token soup, shallow and deep, is always Python or MATLAB's syntax error", () => {
  // (a fixed seed: the same cases every run)
  let seed = 0x5eed1234;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const TOKENS = ["x", "y", "1", "2.5", "'s'", '"t"', "(", ")", "[", "]", "{", "}", "+", "-", "*", "/", "^", ".*", "'", ".'", ",", ";", "\n",
    ":", "==", "~=", "&&", "||", "&", "|", "~", "@", "@(x)", "end", "if", "for", "while", "switch", "case", "function", "try", "catch",
    "%", "%{", "%}", "...", " ", "=", "f(", "a{", ".b", "1e309", "0x1F", "'unterminated", "\"open", "\t", "!", "#", "$"];
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    const len = 1 + rnd(i % 10 === 0 ? 3000 : 60);
    const parts: string[] = [];
    for (let k = 0; k < len; k++) parts.push(TOKENS[rnd(TOKENS.length)]);
    const r = translate(parts.join(i % 3 ? " " : ""));
    assert.doesNotMatch(r, /^HOST/, `case ${i}: ${r}`);
    n++;
  }
  // (deep random nests: an opener chosen at random at each level)
  const OPEN = [["(", ")"], ["[", "]"], ["{", "}"], ["abs(", ")"], ["-(", ")"]];
  for (let i = 0; i < 200; i++) {
    const depth = 1 + rnd(400);
    let a = "", b = "";
    for (let k = 0; k < depth; k++) { const [o, c] = OPEN[rnd(OPEN.length)]; a += o; b = c + b; }
    const r = translate("x = " + a + "1" + b);
    assert.ok(r === "ok" || r === "syntax: " + NESTING_MESSAGE, `deep case ${i} (${depth}): ${r}`);
    n++;
  }
  assert.equal(n, 3200);
});

test("through the CLI: past a bound, MATLAB's error and exit status 1, never host detail; at the bounds, the program runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "matlab-deep-"));
  try {
    const run = (name: string, src: string) => {
      writeFileSync(join(dir, name), src);
      return spawnSync(process.execPath, [CLI, "--matlab", name], { cwd: dir, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
    };
    for (const [name, f] of Object.entries(SHAPES)) {
      const r = run(`deep_${name}.m`, f(5000) + "\n");
      assert.equal(r.status, 1, `${name}: ${r.stderr.slice(0, 300)}`);
      assert.match(r.stderr, new RegExp(`File: deep_${name}\\.m Line: \\d+ Column: \\d+\\n${NESTING_MESSAGE}`), name);
      assert.doesNotMatch(r.stderr, HOST, name);
    }
    const chain = run("chain.m", "x = " + Array(MAX_CHAIN + 1).fill("1").join("+") + ";\ndisp(x)\n");
    assert.equal(chain.stdout.trim(), String(MAX_CHAIN + 1), chain.stderr.slice(0, 300));
    const long = run("long.m", "x = " + Array(MAX_CHAIN + 2).fill("1").join("+") + ";\n");
    assert.equal(long.status, 1);
    assert.match(long.stderr, new RegExp(CHAIN_MESSAGE));
    assert.doesNotMatch(long.stderr, HOST);
    const ok = run("ok.m", "x = " + rep("(", 99) + "1" + rep(")", 99) + "; y = " + rep("abs(", 20) + "-2" + rep(")", 20) + "; z = " + rep("[", 20) + "3" + rep("]", 20) + ";\ndisp([x y z])\n");
    assert.equal(ok.stdout.trim(), "1     2     3", ok.stderr.slice(0, 300));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a long chain is emitted flat and keeps MATLAB's order: operands left to right, an error stops it there, && short-circuits", () => {
  const dir = mkdtempSync(join(tmpdir(), "matlab-chain-"));
  try {
    // p(k) prints k and returns 1
    writeFileSync(join(dir, "p.m"), "function y = p(k)\n  fprintf('%d ', k);\n  y = 1;\nend\n");
    const terms = (n: number) => Array.from({ length: n }, (_, k) => `p(${k + 1})`);
    const run = (src: string) => spawnSync(process.execPath, [CLI, "--matlab", "-c", src], { cwd: dir, encoding: "utf8", timeout: 300000 });
    const sum = run("x = " + terms(40).join(" + ") + "; fprintf('\\n%d\\n', x)");
    assert.equal(sum.stdout, Array.from({ length: 40 }, (_, k) => k + 1).join(" ") + " \n40\n", sum.stderr);
    // (the 21st step fails: [1 2] + [1 2 3]; MATLAB never evaluates p(22) onward)
    const t = terms(40);
    t[20] = "[1 2]";
    t[21] = "[1 2 3]";
    const err = run("x = " + t.join(" + "));
    assert.match(err.stdout, /^1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 $/);
    assert.match(err.stderr, /Arrays have incompatible sizes for this operation\./);
    // (&& stops at the first false operand)
    const sc = terms(40);
    sc[30] = "0";
    const and = run("x = " + sc.join(" && ") + "; fprintf('\\n%d\\n', x)");
    assert.equal(and.stdout, Array.from({ length: 30 }, (_, k) => k + 1).join(" ") + " \n0\n", and.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chains of up to 32 operators are emitted exactly as before (nested calls, no _ch)", () => {
  const py = matlabToPython("x = a + b - c .* d;", "s", { cell: true });
  assert.match(py, /_m\.minus\(_m\.plus\(/);
  assert.doesNotMatch(py, /_ch/);
  const long = matlabToPython("x = " + Array(40).fill("a").join(" + ") + ";", "s", { cell: true });
  assert.match(long, /\(_ch := /);
});

// (SEC and ENGINE on 5bf5d4de: the bounds must compose.  Signs, postfix operators, indexes, fields and powers charge
// the same nesting budget as groups and blocks, so a mix can't build a deep tree from many short runs; and the whole
// tree is checked with an explicit stack, before any recursive walk, at every entry: script, cell, function file)
const MIXED: Record<string, (n: number) => string> = {
  "signs in groups": (n) => "x=" + ("-".repeat(100) + "(").repeat(n) + "1" + ")".repeat(n),
  "transposes after groups": (n) => "a=1; x=" + "(".repeat(n) + "a" + (")" + "'".repeat(100)).repeat(n),
  "indexes after groups": (n) => "a=1; x=" + "(".repeat(n) + "a" + (")" + "(1)".repeat(100)).repeat(n),
  "powers after groups": (n) => "x=" + "(".repeat(n) + "1" + (")" + "^1".repeat(100)).repeat(n),
  "fields after groups": (n) => "s.a=1; x=" + "(".repeat(n) + "s" + (")" + ".a".repeat(100)).repeat(n),
  "signs and groups alternating": (n) => "x=" + "---(".repeat(n) + "1" + ")".repeat(n),
};

test("mixed nesting adds up: every mix is MATLAB's syntax error past the shared bound, through every entry point", () => {
  const cell = matlabHostOps().matlab_cell;
  for (const [name, f] of Object.entries(MIXED)) {
    for (const n of [40, 95, 2000]) {
      const src = f(n);
      assert.equal(translate(src), "syntax: " + NESTING_MESSAGE, `${name} ${n}`);
      const body = "function y = g()\n" + src.replace(/^(a=1; |s\.a=1; )/, "").replace(/^x=/, "y=") + "\nend\n";
      assert.throws(() => matlabFunctionFileToPython(body), (e: unknown) => e instanceof MatlabSyntaxError && e.message === NESTING_MESSAGE, `${name} ${n}: function file`);
      // (the host operation turns MATLAB's syntax error into Python that reports it: never a JS exception)
      assert.match(String(cell(src, "matlabblock 1")), /this code is nested too deeply/, `${name} ${n}: matlab_cell`);
    }
  }
  // (astra's reproducer, exactly)
  assert.equal(translate("x=" + ("-".repeat(100) + "(").repeat(40) + "1" + ")".repeat(40)), "syntax: " + NESTING_MESSAGE);
  // (a mix inside the budget translates)
  assert.equal(translate("x=" + ("-".repeat(10) + "(").repeat(5) + "1" + ")".repeat(5)), "ok");
});

test("the tree check, on its own: a tree deeper than MAX_TREE_DEPTH is refused with an explicit stack, at any depth", () => {
  for (const depth of [MAX_TREE_DEPTH - 2, MAX_TREE_DEPTH + 1, 200000]) {
    let e: any = { k: "num", v: "1" };
    for (let i = 0; i < depth; i++) e = { k: "un", op: "-", e };
    const run = () => checkTreeDepth([{ k: "expr", e, print: true, line: 3, col: 7 } as any], []);
    if (depth <= MAX_TREE_DEPTH - 2) assert.doesNotThrow(run);
    else assert.throws(run, (x: unknown) => x instanceof MatlabSyntaxError && x.message === NESTING_MESSAGE && x.line === 3, String(depth));
  }
  // (a chain's left spine is flat, as the walks treat it: 100000 operators deep on the left is depth 2)
  let c: any = { k: "num", v: "1" };
  for (let i = 0; i < 100000; i++) c = { k: "bin", op: "+", l: c, r: { k: "num", v: "1" } };
  assert.doesNotThrow(() => checkTreeDepth([{ k: "expr", e: c, print: true, line: 1, col: 1 } as any], []));
  // (a function's body is checked too)
  let d: any = { k: "num", v: "1" };
  for (let i = 0; i < MAX_TREE_DEPTH + 5; i++) d = { k: "un", op: "-", e: d };
  assert.throws(() => checkTreeDepth([], [{ name: "f", params: [], outs: [], args: [], line: 1, body: [{ k: "expr", e: d, print: true, line: 2, col: 1 } as any] } as any]), MatlabSyntaxError);
});

// (with a 250 KB stack, a program inside these bounds can still reach the engine's own Python compiler limit, about 33
// nested brackets there, which is Python's RecursionError and the engine's to lift; past MATLAB's bounds, the refusal
// itself must never reach the host's stack, which is what this pins)
test("through the CLI with a 250 KB stack: the mixed inputs are MATLAB's error, never host detail", () => {
  const dir = mkdtempSync(join(tmpdir(), "matlab-mixed-"));
  try {
    for (const [name, f] of Object.entries(MIXED)) {
      const file = `mixed_${name.replace(/\W+/g, "_")}.m`;
      writeFileSync(join(dir, file), f(40) + "\n");
      const r = spawnSync(process.execPath, ["--stack-size=250", CLI, "--matlab", file], { cwd: dir, encoding: "utf8", timeout: 300000 });
      assert.equal(r.status, 1, `${name}: ${r.stderr.slice(0, 300)}`);
      assert.match(r.stderr, new RegExp(NESTING_MESSAGE), name);
      assert.doesNotMatch(r.stderr, HOST, name);
      const c = spawnSync(process.execPath, ["--stack-size=250", CLI, "--matlab", "-c", f(40)], { cwd: dir, encoding: "utf8", timeout: 300000 });
      assert.match(c.stderr, new RegExp(NESTING_MESSAGE), `${name}: -c`);
      assert.doesNotMatch(c.stderr, HOST, `${name}: -c`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an anonymous function's captures keep their order: left to right, as before (a + b + c captures a, b, c)", () => {
  const py = matlabToPython("f = @() a + b + c;", "s", { cell: true });
  const sig = py.match(/lambda ([^:]*):/)![1];
  assert.ok(sig.indexOf("a=") < sig.indexOf("b=") && sig.indexOf("b=") < sig.indexOf("c="), sig);
  // (the same Python as before this change, exactly)
  assert.equal(sig, '_n, *, a=(_m.cp(a) if "a" in globals() else _m.NOVAR), b=(_m.cp(b) if "b" in globals() else _m.NOVAR), c=(_m.cp(c) if "c" in globals() else _m.NOVAR)');
  // (a long chain in a handle: captured in order, walked in a loop)
  const names = Array.from({ length: 50 }, (_, k) => `v${k}`);
  const long = matlabToPython("f = @() " + names.join(" + ") + ";", "s", { cell: true });
  const ls = long.match(/lambda ([^:]*):/)![1];
  const pos = names.map((n) => ls.indexOf(n + "="));
  assert.ok(pos.every((p, k) => p > 0 && (k === 0 || p > pos[k - 1])), ls.slice(0, 200));
});

// (the budget is given back as each construct ends: many short runs side by side, in one statement or in many,
// never add up the way nested ones do)
test("side by side, not nested: 150 sign runs, transposes and indexes in one statement translate, and so do many statements", () => {
  for (const t of ["-a", "a'", "a(1)", "-a'", "~a", "a.'", "-(a)"]) {
    assert.equal(translate("a = 1; x = " + Array(150).fill(t).join(" + ") + ";"), "ok", t);
  }
  const deep = "x = " + rep("(", 99) + "1" + rep(")", 99) + ";\n";
  assert.equal(translate(rep(deep, 300)), "ok", "300 statements, each 99 levels deep");
  assert.equal(translate(rep("y = " + rep("-", 50) + "1;\n", 300)), "ok", "300 statements of 50 signs");
});

test("the chain bound holds for every operator: MAX_CHAIN operators translate, one more is refused", () => {
  for (const op of ["+", "-", "*", "/", ".*", "./", "==", "~=", "<", "&", "|", "&&", "||"]) {
    const src = (n: number) => "x = " + Array(n + 1).fill("1").join(" " + op + " ") + ";";
    assert.equal(translate(src(MAX_CHAIN)), "ok", op);
    assert.equal(translate(src(MAX_CHAIN + 1)), "syntax: " + CHAIN_MESSAGE, op);
  }
});

// (unparse's text reaches the user: a function handle's display and func2str; its parentheses keep their meaning)
test("a function handle's text keeps its parentheses: func2str and the display, short and long chains", () => {
  const r = spawnSync(process.execPath, [CLI, "--matlab", "-c", [
    "f = @() a - (b - c); disp(func2str(f))", "f = @() a - b - c; disp(func2str(f))", "f = @() (a - b) - c; disp(func2str(f))",
    "f = @() a / (b * c); disp(func2str(f))", "f = @() a ^ (b ^ c); disp(func2str(f))", "f = @() (a ^ b) ^ c; disp(func2str(f))",
    "f = @() -(a + b); disp(func2str(f))", "f = @() " + Array(40).fill("a").join(" - ") + " - (b - c); disp(func2str(f))",
  ].join("\n")], { encoding: "utf8", timeout: 300000 });
  assert.equal(r.stdout, [
    "@()a-(b-c)", "@()a-b-c", "@()a-b-c", "@()a/(b*c)", "@()a^(b^c)", "@()a^b^c", "@()-(a+b)",
    "@()" + Array(40).fill("a").join("-") + "-(b-c)", "",
  ].join("\n"), r.stderr);
});
