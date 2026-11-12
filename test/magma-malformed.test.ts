import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Malformed Magma input ends as Magma's error, never as a crash of the host: no JS exception escapes the
// translator (src/magma.ts), no Python error reaches the user, and nothing loops or exhausts memory. Where
// Magma 2.18-5 and Sagebrush agree, magma-tests/ pins the exact text (test_error_literal_*, test_error_eof_*,
// test_literal_ident, test_deep_nesting, test_long_chain); here, the inputs where they differ or that are too
// large to keep, the bounds exactly, and the property for any input at all, with Node's default stack and with
// a 250 KB one (smaller than a browser worker's).
const CLI = join(__dirname, "../src/cli.js");
const MAGMA_JS = join(__dirname, "../src/magma.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const M = require(MAGMA_JS);
const { magmaToPython, MagmaSyntaxError, TOO_DEEP, TOO_LONG, tooDeep, MAX_NESTING, MAX_PY_NEST, MAX_PY_BLOCKS, CHAIN_FLAT, MAX_OPS } = M;

const deep = (open: string, close: string, n: number) => "x := " + open.repeat(n) + "1" + close.repeat(n) + ";";
const ifs = (n: number, inner = "x := 1;") => "if true then\n".repeat(n) + inner + "\n" + "end if;\n".repeat(n);
const terms = (n: number, t = "1", op = "+") => Array(n).fill(t).join(` ${op} `);
const HOST = /Traceback|RecursionError|IndentationError|RangeError|Maximum call stack|TypeError|SyntaxError|at .*\.js:\d/;
const REFUSED = /User error: this (statement is nested too deeply|expression is too long) for Sagebrush/;

// each with the line Magma's (or Sagebrush's) error must start
const CASES: [string, string, RegExp][] = [
  ["a lone quote", "'", /User error: Unexpected newline in literal identifier/],
  ["an open literal identifier", "x := 1;\n'abc\nprint 2;", /User error: Unexpected newline in literal identifier/],
  ["the end inside a function's header", "function f(", /User error: syntax error at end of input/],
  ["the end inside a procedure", "procedure p()", /User error: syntax error at end of input/],
  ["the end inside an if", "if true then", /User error: syntax error at end of input/],
  ["5000 parentheses", deep("(", ")", 5000), REFUSED],
  ["3000 brackets", deep("[", "]", 3000), REFUSED],
  ["2000 minus signs", "x := " + "-".repeat(2000) + "1;", REFUSED],
  ["1000 nots", "x := " + "not ".repeat(1000) + "true;", REFUSED],
  ["5000 nested selects", "x := " + "true select ".repeat(5000) + "1" + " else 2".repeat(5000) + ";", REFUSED],
  ["5000 time prefixes", "time ".repeat(5000) + "x := 1;", REFUSED],
  ["5000 nested computed fields", "r := 1;\nx := " + "assigned r``".repeat(5000) + "\"a\";", REFUSED],
  ["3000 nested tuples", deep("<1, ", ">", 3000), REFUSED],
  ["a sum of 5000 terms", "x := " + terms(5000) + ";", /User error: this expression is too long for Sagebrush/],
  ["1000 nested ifs", ifs(1000), REFUSED],
  ["a literal identifier with a space", "'a b' := 1;", /User error: 'a b' \(a literal identifier that isn't a plain name\) is not supported yet/],
  ["an empty literal identifier", "'' := 1;", /User error: '' \(a literal identifier that isn't a plain name\) is not supported yet/],
];

// runs each source through __pyjs_compile_magma__ (the shared-document route) in one child process: [how it
// ended, what it printed]
const DRIVER = String.raw`
import io, json, sys
def run(src):
    out, old = io.StringIO(), sys.stdout
    sys.stdout = out
    end = "ok"
    try:
        exec(__pyjs_compile_magma__(src, "item", "exec"), {})
    except SystemExit as e:
        end = "exit %d" % e.code
    except BaseException as e:
        end = "raised %s: %s" % (type(e).__name__, str(e)[:200])
    finally:
        sys.stdout = old
    return [end, out.getvalue()]
print(json.dumps([run(src) for src in json.loads(sys.stdin.read())]))
`;
function api(srcs: string[], stack?: number): [string, string][] {
  const r = spawnSync(process.execPath, [...(stack ? [`--stack-size=${stack}`] : []), "--max-old-space-size=512", CLI, "-c", DRIVER], { input: JSON.stringify(srcs), encoding: "utf8", timeout: 600000, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

// the translator alone in a child process (file recovery): "py" with whether the statement was refused, or the
// error that escaped
const TRANSLATE = String.raw`
const M = require(process.argv[1]);
const srcs = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(JSON.stringify(srcs.map((s) => {
  try {
    const py = M.magmaToPython(s, "t.m", { recover: "file" });
    if (typeof py !== "string") return "not a string";
    return /this (statement is nested too deeply|expression is too long) for Sagebrush/.test(py) ? "refused" : "py";
  } catch (e) { return "escaped " + (e && e.constructor && e.constructor.name) + ": " + String(e && e.message).slice(0, 100); }
})));
`;
function translate(srcs: string[], stack?: number): string[] {
  const r = spawnSync(process.execPath, [...(stack ? [`--stack-size=${stack}`] : []), "-e", TRANSLATE, MAGMA_JS], { input: JSON.stringify(srcs), encoding: "utf8", timeout: 600000, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  return JSON.parse(r.stdout.trim());
}

for (const stack of [undefined, 250]) {
  const at = stack ? ` with a ${stack} KB stack` : "";
  test(`malformed Magma, through __pyjs_compile_magma__${at}: Magma's error and the file stopped, never a Python or JS error`, () => {
    const res = api(CASES.map((c) => c[1]), stack);
    CASES.forEach(([what, , want], k) => {
      const [end, out] = res[k];
      assert.equal(end, "exit 1", `${what}: ends as a stopped file (${end})`);
      assert.match(out, want, `${what}: ${JSON.stringify(out.slice(0, 300))}`);
      assert.doesNotMatch(out, HOST, what);
    });
  });
  test(`malformed Magma, through the translator${at}: Python, the statement refused, never an escaped error`, () => {
    const res = translate(CASES.map((c) => c[1]), stack);
    CASES.forEach(([what], k) => assert.ok(res[k] === "py" || res[k] === "refused", `${what}: ${res[k]}`));
  });
}

// The reproducers of the review (Node 24, 250 KB): 100 parentheses and 100 alternating -( pairs, through the
// translator, the CLI (a file and -c) and __pyjs_compile_magma__: Magma's error, no JS stack, no Python error.
test("the review's reproducers, at the default stack and 250 KB, through every route", () => {
  const srcs = [deep("(", ")", 100), deep("-(", ")", 100)];
  const dir = mkdtempSync(join(tmpdir(), "magma-malformed-"));
  try {
    for (const stack of [undefined, 250]) {
      const flag = stack ? [`--stack-size=${stack}`] : [];
      assert.deepEqual(translate(srcs, stack), ["refused", "refused"], `translator ${stack}`);
      for (const [end, out] of api(srcs, stack)) {
        assert.equal(end, "exit 1", `api ${stack}`);
        assert.match(out, /line 1, column 1:[^]*User error: this statement is nested too deeply for Sagebrush/, `api ${stack}`);
        assert.doesNotMatch(out, HOST, `api ${stack}`);
      }
      srcs.forEach((src, k) => {
        writeFileSync(join(dir, `r${k}.m`), src + "\n");
        for (const args of [["--magma", `r${k}.m`], ["--magma", "-c", src]]) {
          const r = spawnSync(process.execPath, [...flag, CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 120000 });
          assert.match(r.stdout, /User error: this statement is nested too deeply for Sagebrush/, `${args[1]} ${stack}: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
          assert.doesNotMatch(r.stdout + r.stderr, HOST, `${args[1]} ${stack}`);
        }
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed Magma, through the CLI: the lone quote ends in a small heap with Magma's words", () => {
  const dir = mkdtempSync(join(tmpdir(), "magma-malformed-"));
  try {
    for (const [name, src, want] of [["q.m", "'\n", /line 1, column 2:\n>> '\n {4}\^\nUser error: Unexpected newline in literal identifier\n$/], ["f.m", "function f(\n", /^\nUser error: syntax error at end of input\n$/]] as [string, string, RegExp][]) {
      writeFileSync(join(dir, name), src);
      const r = spawnSync(process.execPath, ["--max-old-space-size=128", CLI, "--magma", name], { cwd: dir, encoding: "utf8", timeout: 120000 });
      assert.equal(r.status, 1, `${name}: ${r.stderr.slice(-500)}`);
      assert.match(r.stdout, want, name);
      assert.doesNotMatch(r.stderr, /at .*magma\.js|RangeError|TypeError|heap/, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (a seeded generator: the same 3000 inputs every run, from Magma's tokens, brackets, quotes and stray characters)
function inputs(count: number): string[] {
  let s = 0x9e3779b9;
  const rand = (n: number) => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) % n);
  const parts = ["x", "y", "f", ":=", ";", "(", ")", "[", "]", "{", "}", "<", ">", ",", "'", "'a'", "'a b", "\"s\"", "\"",
    "1", "2.5", "+", "-", "*", "^", "not", "and", "if", "then", "else", "end", "for", "in", "do", "while", "function",
    "procedure", "return", "print", "case", "when", "select", "..", "|", "#", "&", "~", "$$", "\n", " ", "@", "`", "\\", "time"];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const n = 1 + rand(40);
    let src = "";
    for (let j = 0; j < n; j++) src += parts[rand(parts.length)] + (rand(3) ? " " : "");
    out.push(src);
  }
  return out;
}

test("any input: the translator returns Python (file recovery) or a MagmaSyntaxError (a cell), and nothing else", () => {
  let n = 0;
  for (const src of inputs(3000)) {
    assert.equal(typeof magmaToPython(src, "t.m", { recover: "file" }), "string", JSON.stringify(src));
    try {
      magmaToPython(src, "t.m");
    } catch (e) {
      assert.ok(e instanceof MagmaSyntaxError, `${JSON.stringify(src)}: ${(e as Error)?.constructor?.name} ${(e as Error)?.message}`);
      n++;
    }
  }
  assert.ok(n > 100, `the inputs are malformed often enough to test the errors (${n})`);
});

// ---- the bounds, exactly: for each construct alone, the deepest Sagebrush runs, and one more refused

const SHAPES: [string, (n: number) => string, number][] = [
  // (bounded by the generated Python: MAX_PY_NEST, less the top-level try: block's ceil(1/5))
  ["parentheses", (n) => deep("(", ")", n), 47],
  ["-( pairs", (n) => deep("-(", ")", n), 23],
  ["lists", (n) => deep("[", "]", n), 23],
  ["sets", (n) => deep("{", "}", n), 23],
  ["calls", (n) => deep("Abs(", ")", n), 24],
  ["indexes", (n) => "a := [1];\n" + deep("a[", "]", n), 46],
  ["tuples", (n) => deep("<1, ", ">", n), 23],
  ["minus signs", (n) => "x := " + "-".repeat(n) + "1;", 47],
  ["#", (n) => "x := " + "#".repeat(n) + "[1];", 45],
  ["not", (n) => "x := " + "not ".repeat(n) + "true;", 23],
  ["select, in its first branch", (n) => "x := " + "true select ".repeat(n) + "1" + " else 2".repeat(n) + ";", 46],
  ["select, in its second branch", (n) => "x := " + "false select 1 else ".repeat(n) + "2;", 46],
  ["func< >", (n) => "f := " + "func<a | ".repeat(n) + "1" + ">".repeat(n) + ";", 47],
  ["computed fields, nested", (n) => "r := 1;\nx := " + "assigned r``".repeat(n) + "\"a\";", 47],
  // (bounded by the parser's budget, MAX_NESTING: these emit no nesting)
  ["plus signs", (n) => "x := " + "+".repeat(n) + "1;", 97],
  ["time", (n) => "time ".repeat(n) + "x := 1;", 97],
  // (bounded by the Python's indentation, MAX_PY_BLOCKS, less the try: block)
  ["ifs", (n) => ifs(n), 89],
  ["fors", (n) => "for i in [1] do\n".repeat(n) + "x := 1;\n" + "end for;\n".repeat(n), 89],
  ["whiles", (n) => "while false do\n".repeat(n) + "x := 1;\n" + "end while;\n".repeat(n), 89],
  // (bounded by MAX_OPS)
  ["a sum", (n) => "x := " + terms(n + 1) + ";", MAX_OPS],
  ["an and", (n) => "x := " + terms(n + 1, "true", "and") + ";", MAX_OPS],
];

const fate = (src: string) => {
  const py = magmaToPython(src, "t.m", { recover: "file" }) as string;
  if (py.includes(TOO_DEEP)) return "deep";
  if (py.includes(TOO_LONG)) return "long";
  return "py";
};

test("the bounds, exactly: each construct alone at its deepest runs, and one more is refused at the statement's start", () => {
  assert.deepEqual([MAX_NESTING, MAX_PY_NEST, MAX_PY_BLOCKS, CHAIN_FLAT, MAX_OPS], [100, 50, 90, 32, 2000]);
  for (const [what, f, n] of SHAPES) {
    assert.equal(fate(f(n)), "py", `${what}: ${n} run`);
    assert.equal(fate(f(n + 1)), n === MAX_OPS ? "long" : "deep", `${what}: ${n + 1} refused`);
  }
  // (at the statement's first token, in Magma's form: a file stops there)
  assert.match(magmaToPython("y := 1;\n  " + deep("(", ")", 48), "t.m", { recover: "file" }), /_m\._syntax_error\(2, 3, "this statement is nested too deeply for Sagebrush", True\)/);
  assert.throws(() => magmaToPython(deep("[", "]", 400), "t.m"), (e: any) => e instanceof MagmaSyntaxError && e.verbatim && e.line === 1 && e.col === 1);
});

test("the bounds add up: constructs mixed are bounded as their sum, by the budget and by the Python's shape", () => {
  // blocks and brackets: lists (two brackets each, x = _m._own(...) two more) in 40 ifs, at I = 41 (the try: block),
  // have 48 - ceil(41/5) = 39 brackets: 19 lists (floor, or /4, would give 20 or 18)
  const p = (n: number) => fate(ifs(40, "x := " + "[".repeat(n) + "1" + "]".repeat(n) + ";"));
  assert.equal(p(19), "py");
  assert.equal(p(20), "deep");
  // parentheses in ifs: the parser's budget, each if one step and each parenthesis two
  assert.equal(fate(ifs(60, deep("(", ")", 18))), "py");
  assert.equal(fate(ifs(60, deep("(", ")", 19))), "deep");
  // the parser's budget, shared: time prefixes and plus signs together
  const q = (a: number, b: number) => fate("time ".repeat(a) + "x := " + "+".repeat(b) + "1;");
  assert.equal(q(48, 49), "py");
  assert.equal(q(48, 50), "deep");
  assert.equal(q(49, 49), "deep");
  // selects inside time inside ifs inside a function: refused as the whole, not as any one part
  const mix = (k: number) => fate("f := function(a)\n" + ifs(k, "time ".repeat(k) + "x := " + "true select ".repeat(k) + "1" + " else 2".repeat(k) + ";") + "return 1;\nend function;");
  assert.equal(mix(31), "py");
  assert.equal(mix(32), "deep");
});

test("the generated Python's bound, at its edges: brackets + ceil(I/5) <= 50, and I <= 90", () => {
  const line = (I: number, b: number) => " ".repeat(4 * I) + "x = " + "(".repeat(b) + "1" + ")".repeat(b);
  for (const [I, room] of [[0, 50], [7, 48], [10, 48], [11, 47], [20, 46], [21, 45], [90, 32]]) {
    assert.equal(tooDeep([line(I, room)]), false, `I=${I}: ${room} brackets`);
    assert.equal(tooDeep([line(I, room + 1)]), true, `I=${I}: ${room + 1} brackets`);
  }
  assert.equal(tooDeep([line(90, 0)]), false);
  assert.equal(tooDeep([line(91, 0)]), true);
  // (strings aren't brackets; each line on its own; lines inside one entry too)
  assert.equal(tooDeep(['x = "' + "(".repeat(200) + '"']), false);
  assert.equal(tooDeep([line(0, 30), line(0, 30)]), false);
  assert.equal(tooDeep([line(0, 30) + "\n" + line(91, 0)]), true);
});

// ---- the parser's recursion: every cycle of the call graph is charged to the budget

// Parser's methods and the calls between them, from the source (TypeScript's own parser): a call is charged when
// it is made as this.deeper(() => this.f(...)); returns each cycle-free run of uncharged calls' longest length,
// or throws on a cycle with no charge in it
function auditParser(source: string): { charged: number; longest: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require("typescript-api");
  const sf = ts.createSourceFile("magma.ts", source, ts.ScriptTarget.Latest, true);
  const edges = new Map<string, { to: string; charged: boolean }[]>();
  const isThisCall = (x: any, name?: string) => ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) &&
    x.expression.expression.kind === ts.SyntaxKind.ThisKeyword && (name === undefined || x.expression.name.text === name);
  ts.forEachChild(sf, (n: any) => {
    if (!ts.isClassDeclaration(n) || n.name?.text !== "Parser") return;
    const names = new Set(n.members.filter((m: any) => ts.isMethodDeclaration(m)).map((m: any) => m.name.getText()));
    for (const m of n.members) {
      if (!ts.isMethodDeclaration(m) || !m.body) continue;
      const out: { to: string; charged: boolean }[] = [];
      (function walk(x: any) {
        if (isThisCall(x) && names.has(x.expression.name.text) && x.expression.name.text !== "deeper") {
          const arrow = x.parent;
          out.push({ to: x.expression.name.text, charged: ts.isArrowFunction(arrow) && arrow.body === x && isThisCall(arrow.parent, "deeper") });
        }
        ts.forEachChild(x, walk);
      })(m.body);
      edges.set(m.name.getText(), [...(edges.get(m.name.getText()) ?? []), ...out]);
    }
  });
  const memo = new Map<string, string[]>(), on = new Set<string>();
  const longest = (v: string): string[] => {
    if (memo.has(v)) return memo.get(v)!;
    if (on.has(v)) throw new Error(`a cycle with no charge, through ${v}`);
    on.add(v);
    let best = [v];
    for (const e of edges.get(v) ?? []) if (!e.charged) { const p = longest(e.to); if (p.length + 1 > best.length) best = [v, ...p]; }
    on.delete(v);
    memo.set(v, best);
    return best;
  };
  let worst: string[] = [];
  for (const v of edges.keys()) { const p = longest(v); if (p.length > worst.length) worst = p; }
  return { charged: [...edges.values()].flat().filter((e) => e.charged).length, longest: worst };
}

test("the parser's recursion: every cycle passes a charge, and at most 12 calls run between two", () => {
  const src = readFileSync(join(__dirname, "../../src/magma.ts"), "utf8");
  const a = auditParser(src);
  assert.ok(a.longest.length <= 12, a.longest.join(" > "));
  assert.equal(a.charged, 9);
  // (the audit itself: a charge taken away, or made beside the recursive call, is a cycle with none)
  for (const [from, to] of [
    ["const a = this.deeper(() => this.selectExpr());", "const a = this.selectExpr();"],
    ['this.deeper(() => this.stmt()); this.emit("_m._time_end()")', 'this.stmt(); this.emit("_m._time_end()")'],
    ["this.deeper(() => this.primary())", "(this.deeper(() => 0), this.primary())"],
  ]) {
    assert.ok(src.includes(from), from);
    assert.throws(() => auditParser(src.replace(from, to)), /a cycle with no charge/, to);
  }
  // (a charge that only shortens the runs between two: a tuple element's, which would leave a run of 16 calls)
  const tuple = "tupleElem(): string {\n    return this.deeper(() => this.selectExpr());";
  assert.ok(src.includes(tuple));
  assert.ok(auditParser(src.replace(tuple, "tupleElem(): string {\n    return this.selectExpr();")).longest.length > 12);
});

// a seeded mix of every recursive construct, statements and expressions, around the bounds
function mixed(count: number): string[] {
  let s = 0x2545f491;
  const rand = (n: number) => ((s = (Math.imul(s ^ (s >>> 13), 0x5bd1e995) + 0x7f4a7c15) >>> 0) % n);
  const E: ((x: string) => string)[] = [
    (x) => `(${x})`, (x) => `[${x}]`, (x) => `{${x}}`, (x) => `I(${x})`, (x) => `-${x}`, (x) => `+${x}`, (x) => `#[${x}]`,
    (x) => `<${x}, 1>`, (x) => `(true select ${x} else 1)`, (x) => `(false select 1 else ${x})`, (x) => `func<a | ${x}>(1)`,
    (x) => `[${x}][1]`, (x) => `(not (${x} eq 1))`, (x) => `-(${x})`, (x) => `${x} + ${terms(1 + rand(30))}`,
    (x) => `${terms(1 + rand(20))} * (${x})`, (x) => `[${x}] cat [1]`,
  ];
  const S: ((x: string) => string)[] = [
    (x) => `if true then\n${x}\nend if;`, (x) => `for i in [1] do\n${x}\nend for;`, (x) => `while false do\n${x}\nend while;`,
    (x) => `time ${x}`, (x) => `case 1:\nwhen 1:\n${x}\nend case;`, (x) => `f := function(a)\n${x}\nreturn 1;\nend function;`,
  ];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    let e = "1";
    const de = rand(4) ? rand(30) : rand(110);
    for (let j = 0; j < de; j++) e = E[rand(E.length)](e);
    let st = `x := ${e};`;
    const ds = rand(4) ? rand(20) : rand(100);
    for (let j = 0; j < ds; j++) st = S[rand(S.length)](st);
    out.push("I := func<a | a>;\n" + st + "\nprint \"after\";");
  }
  return out;
}

test("a seeded mix of every recursive construct: Python or Magma's error, never an escaped error, at 250 KB too", () => {
  const srcs = mixed(240);
  const fates = translate(srcs);
  assert.deepEqual(translate(srcs, 250), fates, "the translator decides the same with 250 KB");
  assert.ok(fates.every((f) => f === "py" || f === "refused"), fates.find((f) => f !== "py" && f !== "refused") ?? "");
  const n = fates.filter((f) => f === "refused").length;
  assert.ok(n > 40 && n < 200, `both run and refused programs (${n} refused)`);
  // run: with a 400 KB stack, each accepted program runs, and each refused one is Magma's error; with 250 KB, an
  // accepted program may meet Python's own recursion limit (as the engine's compiler has a smaller stack there),
  // never a JS error
  for (const stack of [400, 250]) {
    api(srcs, stack).forEach(([end, out], k) => {
      const what = `${stack} KB, ${JSON.stringify(srcs[k].slice(0, 120))}`;
      assert.doesNotMatch(out + end, /RangeError|Maximum call stack|at .*\.js:\d/, what);
      if (fates[k] === "refused") {
        assert.equal(end, "exit 1", what);
        assert.match(out, REFUSED, what);
        assert.doesNotMatch(out, HOST, what);
      } else if (stack === 400) {
        // (it runs to the end, or stops at a run-time error in Magma's form: the generator's values needn't fit)
        assert.doesNotMatch(out + end, HOST, what);
        assert.match(out, /^after$|In file "item", line \d+, column \d+:\n[^]*(Runtime|User) error/m, what);
      }
    });
  }
});

// ---- long operator chains

test("chains: up to 32 operators keep their nested Python exactly, 33 are one flat _m._chain, walrus operands stay nested", () => {
  assert.equal(CHAIN_FLAT, 32);
  const py = (src: string) => magmaToPython(src, "t.m", { recover: "file" }) as string;
  // x := 1 + 1 + ...: the kth + at column 8 + 4k
  const nested = (ops: number) => { let e = "1"; for (let k = 0; k < ops; k++) e = `_m._add(${e}, 1, (1, ${8 + 4 * k}))`; return `x = _m._own(_m._first(${e}), "x")`; };
  assert.ok(py("x := " + terms(32) + ";").includes(nested(31)), "31 operators: the nested form");
  assert.ok(py("x := " + terms(33) + ";").includes(nested(32)), "32 operators: the nested form");
  const flat = py("x := " + terms(34) + ";");
  assert.ok(flat.includes("x = _m._own(_m._first(_m._chain(1, " + Array.from({ length: 33 }, (_, k) => `_m._add, lambda: 1, (1, ${8 + 4 * k})`).join(", ") + ')), "x")'), flat);
  assert.doesNotMatch(flat, /_m\._add\(/);
  // each operator its own helper and place; and/or/xor by name
  assert.match(py("x := " + terms(34, "1", "-") + " + " + terms(9, "2", "*") + ";"), /_m\._chain\(1, _m\._sub, lambda: 1, \(1, 8\)[^]*_m\._add, lambda: _m\._mul\(/);
  assert.match(py("x := " + terms(35, "true", "or") + ";"), /_m\._chain\(True, "or", lambda: True, None, "or"/);
  assert.match(py("x := " + terms(35, "[1]", "cat") + ";"), /_m\._chain\(_m\._seq\(\[1\], universe=None\), _m\._cat, lambda: _m\._seq\(\[1\], universe=None\), \(1, 10\)/);
  // (an operand that binds names, a quantifier's witness: the nested form, so the witness stays the statement's)
  const w = py("S := [1, 2];\nx := " + terms(34) + " + (exists(t){t : t in S | t gt 1} select 1 else 0);");
  assert.doesNotMatch(w, /_m\._chain/);
  // a nested chain counts against the Python's bound as brackets do: 32 operators in 14 parentheses or 74 ifs, one
  // more refused; 33 operators, flat, in 45 parentheses or 89 ifs
  const fate = (s: string) => { const p = py(s); return p.includes(TOO_DEEP) ? "deep" : "py"; };
  const inParens = (ops: number, k: number) => fate("x := " + "(".repeat(k) + terms(ops + 1) + ")".repeat(k) + ";");
  const inIfs = (ops: number, k: number) => fate(ifs(k, "x := " + terms(ops + 1) + ";"));
  assert.deepEqual([inParens(32, 14), inParens(32, 15), inIfs(32, 74), inIfs(32, 75)], ["py", "deep", "py", "deep"]);
  assert.deepEqual([inParens(33, 45), inParens(33, 46), inIfs(33, 89), inIfs(33, 90)], ["py", "deep", "py", "deep"]);
});

// ---- rows for the edges a mutation run found unpinned

test("the generated Python's bound skips strings whole, escaped quotes included", () => {
  // (a string holding \" and brackets, then brackets: only the ones outside the string count)
  const line = (b: number) => 'x = "a\\"((((((((((" + ' + "(".repeat(b) + "1" + ")".repeat(b);
  assert.equal(tooDeep([line(50)]), false);
  assert.equal(tooDeep([line(51)]), true);
});

test("a lexical error counts only at the failing token: one just past it is Magma's bad syntax at the failing one", () => {
  const err = (src: string) => magmaToPython(src, "t.m", { recover: "file" }).split("\n").find((l: string) => l.includes("_m._syntax_error(")) ?? "";
  // (Magma 2.18-5: `for not 'abc` is bad syntax at `not`, column 5; magma-tests/test_error_literal_after)
  assert.match(err("for not 'abc\nprint 1;"), /_m\._syntax_error\(1, 5, "expected an identifier but found 'not'"\)$/);
  assert.match(err("x := 1;\nfunction ~ 'abc\nprint 2;"), /_m\._syntax_error\(2, 10, /);
  assert.doesNotMatch(err("x := 1;\nfunction ~ 'abc\nprint 2;"), /Unexpected newline/);
  // (the failing token itself lexical: Magma's own words, at that token)
  assert.match(err("x := 'abc\nprint 1;"), /_m\._syntax_error\(1, 10, "Unexpected newline in literal identifier", True\)$/);
  assert.match(err("x := 1 + 'abc\n;"), /_m\._syntax_error\(1, 14, "Unexpected newline in literal identifier", True\)$/);
});

test("an error in Magma's words inside an assignment target ends the statement, without parsing it again", () => {
  // (each level a function inside an index of an assignment target, the innermost statement past the parser's budget:
  // parsed once, a few milliseconds; parsed again at every level, as an expression after the target failed, the work
  // would triple every two levels, minutes at 20)
  let src = "y := " + "(".repeat(200) + "1" + ")".repeat(200) + ";";
  for (let k = 0; k < 20; k++) src = `x[function(a)\n${src}\nreturn 1;\nend function] := 1;`;
  const t0 = Date.now(), before = M.parseWork.fails;
  const py = magmaToPython(src, "t.m", { recover: "file" }) as string;
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(M.parseWork.fails - before, 0, "the budget's refusal is no parse failure: nothing retried");
  assert.match(py, /_m\._syntax_error\(1, 1, "this statement is nested too deeply for Sagebrush", True\)/);
});

test("__pyjs_compile_magma__: a MagmaSyntaxError escaping translation is raised as Python's SyntaxError, never dropped", () => {
  // (no input reaches this path, as file-mode translation reports its errors in the Python: the translator is made
  // to throw, in a child process, so the builtin's own catch runs)
  const script = String.raw`
    const path = require("path"), D = process.argv[1];
    const M = require(path.join(D, "src/magma.js")), C = require(path.join(D, "src/compile.js")), B = require(path.join(D, "src/magma-builtin.js"));
    M.magmaToPython = () => { throw new M.MagmaSyntaxError("made to fail", 2, 3); };
    B.installMagmaCompile(C.R);
    try { C.R.callObj(C.R.builtins.__pyjs_compile_magma__, ["x := 1;\ny := (;\n", "item", "exec"]); console.log("returned"); }
    catch (e) { console.log(JSON.stringify({ msg: e.msg, filename: e.filename, lineno: e.lineno, offset: e.offset, text: e.text })); }`;
  const r = spawnSync(process.execPath, ["-e", script, join(__dirname, "..")], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr.slice(-1000));
  assert.deepEqual(JSON.parse(r.stdout.trim()), { msg: "bad syntax: made to fail", filename: "item", lineno: 2, offset: 3, text: "y := (;" });
});

test("an ordinary syntax error inside nested assignment targets is met once: the work stays one failure at any depth", () => {
  // (the target's fallback to an expression would meet an error inside a nested statement again, at every level:
  // 2^N failures and statements parsed for N levels; counted by the translator's own parseWork, not by time)
  const nest = (k: number, inner: string) => { let s = inner; for (let j = 0; j < k; j++) s = `x[function(a)\n${s}\nreturn 1;\nend function] := 1;`; return s; };
  for (const [inner, want] of [
    ["for not 'abc", /_m\._syntax_error\(17, 5, "expected an identifier but found 'not'"\)$/m],
    ["y := ;", /_m\._syntax_error\(17, 6, "unexpected ';'"\)$/m],
    ["y := 1;\nlocal z;", /_m\._syntax_error\(18, 1, "'local' only at the start of a function"\)$/m],
  ] as [string, RegExp][]) {
    const stmts: number[] = [], ks = [0, 4, 8, 12, 16];
    for (const k of ks) {
      const fails = M.parseWork.fails, statements = M.parseWork.statements;
      const py = magmaToPython(nest(k, inner), "t.m", { recover: "file" }) as string;
      assert.equal(M.parseWork.fails - fails, 1, `${inner} in ${k} targets: ${M.parseWork.fails - fails} failures`);
      stmts.push(M.parseWork.statements - statements);
      if (k === 16) assert.match(py, want, inner);
    }
    // (each statement begun once: one more for each level, where 2^N would double them with each)
    assert.ok(stmts[0] >= 1 && stmts[0] <= 2, `${inner}: statements ${stmts}`);
    assert.deepEqual(stmts, ks.map((k) => stmts[0] + k), `${inner}: statements ${stmts}`);
  }
  // (the fallback itself stays: a target that isn't one is parsed again as an expression, once)
  const before = M.parseWork.fails;
  assert.doesNotMatch(magmaToPython("L := [1, 2, 3];\nL[2..3];", "t.m", { recover: "file" }) as string, /_syntax_error/);
  assert.ok(M.parseWork.fails - before <= 2, `${M.parseWork.fails - before}`);
  // (and every ordinary error goes through fail(), which stamps its level: a syntax error made anywhere else is in
  // Magma's words, which tryLhsList never parses again)
  const src = readFileSync(join(__dirname, "../../src/magma.ts"), "utf8");
  const made = [...src.matchAll(/new MagmaSyntaxError\(([^()]*)\)/g)].map((m) => m[1]);
  const inFail = /^\s*fail\(msg: string[^]*?^\s*throw e;$/m.exec(src)?.[0] ?? "";
  assert.ok(made.length >= 5, `${made.length}`);
  for (const args of made) if (!inFail.includes(args)) assert.match(args, /, true$/, `an ordinary error made outside fail(): ${args}`);
  assert.doesNotMatch(src, /throw new Error|throw new SyntaxError/, "the parser throws only MagmaSyntaxError");
});

test("no parse reads on past a lexical error: in a constructor not implemented yet, after &, Magma's words or its error", () => {
  const err = (src: string) => (magmaToPython(src, "t.m", { recover: "file" }) as string).split("\n").find((l) => l.includes("_m._syntax_error(")) ?? "";
  // (Magma 2.18-5: magma-tests/test_error_literal_ctor and test_error_reduction)
  assert.match(err("foo<'abc>;"), /_m\._syntax_error\(1, 11, "Unexpected newline in literal identifier", True\)$/);
  assert.match(err("sub<'abc>;"), /_m\._syntax_error\(1, 11, "Unexpected newline in literal identifier", True\)$/);
  for (const s of ["x := &'abc\n;", "x := &foo [1];", "x := & [1];"]) assert.match(err(s), /_m\._syntax_error\(1, 6, "Bad reduction operator", True\)$/, s);
  assert.equal(err("x := &+ [1, 2];"), "");
});
