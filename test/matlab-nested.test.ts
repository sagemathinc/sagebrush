import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkTreeDepth, MatlabSyntaxError, MAX_TREE_DEPTH } from "../src/matlab";

// Nested functions, in files whose functions end with `end`: which variables a nested function shares with the
// functions it is nested in, handles to nested functions, their precedence, and files whose functions don't end
// with `end`, as MATLAB's "Nested Functions" and "Function Precedence Order" pages describe them.

const cli = join(__dirname, "..", "src", "cli.js");

function run(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sb-nested-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8", timeout: 120000 });
  const got = new Map(r.stdout.split("\n").filter((l) => l.includes("|")).map((l) => [l.split("|")[0], l.slice(l.indexOf("|") + 1)] as [string, string]));
  return { got, out: r.stdout, err: r.stderr, status: r.status };
}

const lines = (...ls: string[]) => ls.join("\n") + "\n";

test("variables nested functions share, and those they don't", () => {
  const r = run({
    "main.m": lines(
      "fprintf('param|%g\\n', outer(5));",
      "[a, b] = counter(); a(); a(); fprintf('handle|%g\\n', b());",
      "[a2, b2] = counter(); a2(); fprintf('own|%g %g\\n', b(), b2());",
      "fprintf('local|%s\\n', mat2str(twice()));",
      "fprintf('fromnested|%g\\n', setter());",
      "fprintf('skip|%g\\n', skiplevel());",
      "fprintf('sibling|%s\\n', mat2str(siblings()));",
      "fprintf('shadow|%g\\n', shadow(1));",
      "[s1, n1] = snapshot(); fprintf('snapshot|%g %g\\n', s1, n1);",
      "fprintf('prec|%s\\n', prec());",
      "fprintf('outname|%g\\n', outname());",
      "fprintf('rec|%g\\n', fact(5));",
      "fprintf('anon|%g\\n', anoncall());",
      "fprintf('pathfile|%g\\n', acc(4));",
      "try, failing(); catch err, fprintf('error|%s|%s\\n', err.identifier, err.message); end",
      // (a parent's argument, changed by a nested function)
      "function r = outer(n)", "  function bump()", "    n = n + 1;", "  end", "  bump(); bump();", "  r = n;", "end",
      // (handles keep the variables of the call that made them, each call its own)
      "function [inc, get] = counter()", "  c = 0;", "  function incr(), c = c + 1; end", "  function v = getc(), v = c; end",
      "  inc = @incr; get = @getc;", "end",
      // (a variable only the nested function uses is its own, new at each of its calls)
      "function v = twice()", "  function r = once()", "    if exist('t', 'var'), t = t + 1; else, t = 1; end", "    r = t;", "  end",
      "  v = [once() once()];", "end",
      // (a variable the parent reads and only the nested function assigns)
      "function v = setter()", "  function put(), z = 42; end", "  put();", "  v = z;", "end",
      // (two levels down, through a function that doesn't use the variable)
      "function v = skiplevel()", "  w = 1;", "  function mid()", "    function inner(), w = w * 10; end", "    inner();", "  end",
      "  mid(); mid();", "  v = w;", "end",
      // (siblings' variables the parent doesn't use are each their own)
      "function v = siblings()", "  function a(), q = 1; end", "  function r = b()", "    if exist('q', 'var'), r = 1; else, r = 0; end", "  end",
      "  a(); v = [b() exist('q', 'var')];", "end",
      // (a nested function's arguments and outputs are its own)
      "function y = shadow(x)", "  x = 100;", "  function y = f(x), y = x * 2; end", "  y = f(3) + x;", "end",
      // (an anonymous function keeps the value of when it was made; a nested function reads the variable)
      "function [s, n] = snapshot()", "  k = 1;", "  h = @() k;", "  function r = now_(), r = k; end", "  k = 2;", "  s = h(); n = now_();", "end",
      // (a nested function comes before a local function of the same name)
      "function s = prec()", "  s = helper();", "  function s = helper(), s = 'nested'; end", "end",
      "function s = helper(), s = 'local'; end",
      // (a nested function's output isn't its parent's variable: here r is still the local function)
      "function v = outname()", "  function r = g(), r = 5; end", "  g();", "  v = r();", "end",
      "function s = r(), s = 9; end",
      "function r = fact(n)", "  function r = go(k)", "    if k <= 1, r = 1; else, r = k * go(k - 1); end", "  end", "  r = go(n);", "end",
      // (an anonymous function made in the parent calls a nested function)
      "function v = anoncall()", "  h = @() g();", "  v = h();", "  function r = g(), r = 3; end", "end",
      "function failing()", "  function boom(), error('nest:boom', 'boom here'); end", "  boom();", "end"),
    "acc.m": lines("function t = acc(n)", "  t = 0;", "  function add(k), t = t + k; end", "  for k = 1:n, add(k); end", "end", "",
      "function unused()", "end"),
  });
  assert.equal(r.err, "");
  assert.equal(r.got.get("param"), "7");
  assert.equal(r.got.get("handle"), "2");
  assert.equal(r.got.get("own"), "2 1");
  assert.equal(r.got.get("local"), "[1 1]");
  assert.equal(r.got.get("fromnested"), "42");
  assert.equal(r.got.get("skip"), "100");
  assert.equal(r.got.get("sibling"), "[0 0]");
  assert.equal(r.got.get("shadow"), "106");
  assert.equal(r.got.get("snapshot"), "1 2");
  assert.equal(r.got.get("prec"), "nested");
  assert.equal(r.got.get("outname"), "9");
  assert.equal(r.got.get("rec"), "120");
  assert.equal(r.got.get("anon"), "3");
  assert.equal(r.got.get("pathfile"), "10");
  assert.equal(r.got.get("error"), "nest:boom|boom here");
});

test("files whose functions don't end with end, and nested functions where none can be", () => {
  // (without `end`, each function begins the next one: no nesting)
  const plain = run({
    "main.m": lines("fprintf('plain|%g %g %g\\n', f1(2), f2(3), f3());"),
    "f1.m": lines("function y = f1(x)", "  y = g(x) + 1;", "function y = g(x)", "  y = x * 10;"),
    "f2.m": lines("function y = f2(x)", "  if x > 0", "    y = x;", "  end", "  y = y + h();", "function v = h()", "  v = 100;"),
    // (g's v is its own: nested, it would be f3's)
    "f3.m": lines("function y = f3()", "  v = 5;", "  y = g() + v;", "function y = g()", "  v = 1;", "  y = 0;"),
  });
  assert.equal(plain.err, "");
  assert.equal(plain.got.get("plain"), "21 103 5");
  // (a function in a control statement's body is refused, in either form)
  const inIf = run({ "main.m": lines("f()", "function f()", "  if true", "    function g(), end", "  end", "end") });
  assert.notEqual(inIf.status, 0);
  assert.match(inIf.err, /a function cannot be defined here/);
});

test("the tree check walks nested functions' bodies", () => {
  let d: any = { k: "num", v: "1" };
  for (let i = 0; i < MAX_TREE_DEPTH + 5; i++) d = { k: "un", op: "-", e: d };
  const inner = { name: "g", params: [], outs: [], args: [], line: 2, body: [{ k: "expr", e: d, print: true, line: 3, col: 1 }] };
  assert.throws(() => checkTreeDepth([], [{ name: "f", params: [], outs: [], args: [], line: 1, body: [], nested: [inner] } as any]), MatlabSyntaxError);
});

test("compiling a wide function with a nested function takes time linear in its width", async () => {
  const { matlabToPython } = await import("../src/matlab");
  // (the parent assigns V variables, which the nested function reads: each set made once, not once per name)
  const src = (v: number) => {
    const names = Array.from({ length: v }, (_, k) => `a${k}`);
    return ["function main()", ...names.map((n) => `  ${n} = 1;`), "  function inner()", ...names.map((n) => `    t = ${n};`), "  end", "  inner();", "end", ""].join("\n");
  };
  const cpuMs = (f: () => unknown) => { const t = process.cpuUsage(); f(); const d = process.cpuUsage(t); return (d.user + d.system) / 1000; };
  const small = src(2000), large = src(16000);
  matlabToPython(src(500), "main.m", { file: true }); // (warm up)
  // (CPU time, the two sizes interleaved, the least of 3 each, a floor, and 3 attempts)
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    let s = Infinity, b = Infinity;
    for (let r = 0; r < 3; r++) {
      s = Math.min(s, cpuMs(() => matlabToPython(small, "main.m", { file: true })));
      b = Math.min(b, cpuMs(() => matlabToPython(large, "main.m", { file: true })));
    }
    // (8 times the width: about 8 times the time when linear, 64 times when quadratic)
    if (b < 24 * Math.max(s, 20)) return;
    last = `2000: ${s.toFixed(1)} ms, 16000: ${b.toFixed(1)} ms of CPU time`;
  }
  assert.fail(last + ", 3 times");
});

test("an anonymous function made in an anonymous function resolves functions and constants by name", () => {
  // (at the top level, a captured name that may be a function stays one in the anonymous functions made inside)
  const r = run({ "main.m": lines(
    "f = @() feval(@() pi); fprintf('pi|%.4f\\n', f());",
    "f = @() feval(@() numel([1 2 3])); fprintf('numel|%g\\n', f());",
    "f = @() feval(@() max(3, 4)); fprintf('max|%g\\n', f());",
    "f = @() (@() pi); g = f(); fprintf('returned|%.4f\\n', g());",
    "s.K = 4; f = @() feval(@() s.K); fprintf('struct|%g\\n', f());",
    "k = 5; f = @() feval(@() k + 1); fprintf('var|%g\\n', f());",
    "f = @(x) feval(@(y) x + y + pi, 1); fprintf('param|%.4f\\n', f(2));",
    "f = @() @() @() max(7, 2); g = f(); h = g(); fprintf('deep|%g\\n', h());") });
  assert.equal(r.err, "");
  assert.equal(r.out, "pi|3.1416\nnumel|3\nmax|4\nreturned|3.1416\nstruct|4\nvar|6\nparam|6.1416\ndeep|7\n");
});

test("an anonymous function made after clear of a variable named like a function or constant: the function", () => {
  // (the variable while it exists, its value kept by the anonymous function made then; once cleared, the name's)
  const r = run({ "main.m": lines(
    "pi = 3; clear pi",
    "f = @() pi; g = @() sin(pi/2); h = @() feval(@() pi);",
    "fprintf('cleared|%.5f %g %.5f\\n', f(), g(), h());",
    "pi = 3; k = @() pi; clear pi; fprintf('snapshot|%g\\n', k());",
    "y = 2; m = @(t) t + y; clear y; fprintf('captured|%g\\n', m(1));",
    "x = 5; clear x; try, q = @() x; q(); catch e, fprintf('gone|%s\\n', e.message); end") });
  assert.equal(r.err, "");
  assert.equal(r.out, "cleared|3.14159 1 3.14159\nsnapshot|3\ncaptured|3\ngone|Unrecognized function or variable 'x'.\n");
});

test("ans is each function's own, never shared with a nested function (MATLAB R2026b's rows)", () => {
  const r = run({ "main.m": lines(
    "fprintf('after|%g\\n', after_());",
    "try, readp(); catch e, fprintf('read|%s|%s\\n', e.identifier, e.message); end",
    // (the parent's ans, 3, unchanged by its nested function's expression statement, 7)
    "function v = after_()", "  3;", "  function g(), 7; end", "  g();", "  v = ans;", "end",
    // (a nested function reading ans: its own, which it hasn't set, not its parent's)
    "function readp()", "  3;", "  function r = h(), r = ans; end", "  h();", "end") });
  assert.equal(r.err, "");
  assert.equal(r.out, "after|3\nread|MATLAB:UndefinedFunction|Unrecognized function or variable 'ans'.\n");
});
