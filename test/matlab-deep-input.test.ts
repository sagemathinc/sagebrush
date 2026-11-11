import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matlabToPython, MatlabSyntaxError, MAX_NESTING, MAX_CHAIN, NESTING_MESSAGE, CHAIN_MESSAGE } from "../src/matlab";

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

test("every bound: the deepest accepted input translates, one level more is MATLAB's syntax error", () => {
  for (const [name, f] of Object.entries(SHAPES)) {
    let last = 0;
    for (let n = 1; n <= MAX_NESTING + 2; n++) {
      const r = translate(f(n));
      if (r === "ok") { last = n; continue; }
      assert.equal(r, "syntax: " + NESTING_MESSAGE, `${name} ${n}: ${r}`);
      break;
    }
    assert.ok(last >= 15, `${name}: only ${last} levels accepted`);
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
