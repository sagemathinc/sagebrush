import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/compile";
import { BIG_CALL as EMIT_BIG_CALL } from "../src/emit";
import { BIG_CALL } from "../src/runtime/object";

// Long statements: a statement's length no longer costs JavaScript stack.
// - A call of BIG_CALL arguments or more is one array (callObj, a method's
//   siteCallA), never spread.
// - A literal's elements, a dict's pairs and such a call's arguments share
//   their temporaries (emit.ts's pooled()).
// - Hoisted constants past 8,192 go in one table.
// - A chain of binary operators is converted, scoped and emitted with no stack
//   per term.
// - Nesting keeps CPython's limit and errors: the 201st bracket is "too many
//   nested parentheses", and the parser running out of stack first is
//   "MemoryError: Parser stack overflowed".
// test/long_statements_cases.py is checked against CPython; the rows here are
// what CPython can't check: our own limits under a small stack (250 KB, where
// master failed at 26k walrus elements, 40k arguments and under 8k `+` terms),
// the emitted form at each boundary, and MATLAB's rows.
const TEST = join(__dirname, "../../test");
const CLI = join(__dirname, "../src/cli.js");
const run = (args: string[], stack: number | null = null, cwd?: string) =>
  spawnSync(process.execPath, [...(stack === null ? [] : [`--stack-size=${stack}`]), CLI, ...args], { encoding: "utf8", cwd, maxBuffer: 64 << 20 });
const nums = (n: number, f: (i: number) => string = String) => Array.from({ length: n }, (_, i) => f(i)).join(", ");

for (const stack of [null, 250]) {
  test(`test/long_statements_cases.py: CPython's output${stack === null ? "" : `, under --stack-size=${stack}`}`, () => {
    const want = execFileSync("python3", [join(TEST, "long_statements_cases.py")], { encoding: "utf8" });
    const r = run([join(TEST, "long_statements_cases.py")], stack);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, want);
  });
}

test("BIG_CALL: the compiler's choice and the runtime's are the same number", () => {
  assert.equal(EMIT_BIG_CALL, BIG_CALL);
  assert.equal(BIG_CALL, 2048);
});

test("a call's form either side of BIG_CALL: a plain call's callObj array, a method's siteCallA, else the direct call", () => {
  const code = (src: string) => compile(src, "<t>", "__main__").code;
  const plain = (n: number) => code(`x = f(${nums(n)})\n`);
  const method = (n: number) => code(`x = o.m(${nums(n)})\n`);
  assert.match(plain(BIG_CALL), /\$g\.x = callObj\(\(\(\$\d+ = \$g\.f\) !== undefined \? \$\d+ : R\.builtinName\(\$B, "f"\)\), \[0, 1, 2, /);
  assert.doesNotMatch(plain(BIG_CALL - 1), /callObj\([^,]*, \[0, 1, 2, /);
  assert.match(plain(BIG_CALL - 1), /typeof \$\d+ === "function" \? \$\d+\(\$\d+, \$\d+/);
  assert.match(method(BIG_CALL), /R\.siteCallA\("m"\)/);
  assert.doesNotMatch(method(BIG_CALL), /R\.siteCall\("m", /);
  assert.match(method(BIG_CALL - 1), new RegExp(`R\\.siteCall\\("m", ${BIG_CALL - 1}\\)`));
  assert.doesNotMatch(method(BIG_CALL - 1), /siteCallA/);
});

test("hoisted constants: the first 8,192 as constants of their own, the rest in one table, read unbound", () => {
  const code = (n: number) => compile(`x = [${nums(n, (i) => `${i}.0`)}]\n`, "<t>", "__main__").code;
  assert.doesNotMatch(code(8192), /\$KT/);
  const c = code(8193);
  assert.match(c, /const \$K8191 = fbox\(8191\);\nconst \$KT = \[\];\n\$KT\[0\] = fbox\(8192\);/);
  assert.match(c, /\$K8191, \(0, \$KT\[0\]\)\]/);
});

test("under --stack-size=250: 120,000 walrus elements and nested elements, 200,000-argument calls and sites run 3 times, 200,000 floats, 30,000-term + chains, MATLAB's 200,000-element row", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-long-"));
  try {
    const cases: [string, string, string][] = [
      ["walrus", `x = (${nums(120000, () => "(_c := 1)")})[-1]\nprint(x, _c)\n`, "1 1\n"],
      ["call", `def f(*a): return len(a), a[-1]\nprint(f(${nums(200000)}))\n`, "(200000, 199999)\n"],
      ["method", `class O:\n    def m(self, *a): return len(a), a[-1]\nprint(O().m(${nums(200000)}))\n`, "(200000, 199999)\n"],
      ["floats", `x = [${nums(200000, (i) => `${i}.0`)}]\nprint(len(x), x[-1], sum(x))\n`, "200000 199999.0 19999900000.0\n"],
      ["chain", `x = ${Array.from({ length: 30000 }, (_, i) => i).join(" + ")}\nprint(x)\n`, "449985000\n"],
      // (each term a temporary, shared with the later terms)
      ["walrus chain", `x = ${Array.from({ length: 30000 }, (_, i) => `(c := ${i})`).join(" + ")}\nprint(x, c)\n`, "449985000 29999\n"],
      // (a file written once in the statement: suspends() walks the chain)
      ["file chain", `n = open(F, "w").write(${Array.from({ length: 30000 }, () => "'a'").join(" + ")})\nprint(n, len(open(F).read()))\n`, "30000 30000\n"],
      // (nested elements draw on their outer siblings' temporaries too)
      ...["[a]", "[(_c := 1)]", "((_c := 1),)"].map((e): [string, string, string] => [`nested ${e}`, `a = 1\nx = (${nums(120000, () => e)})\nprint(len(x), x[-1])\n`, `120000 ${e === "((_c := 1),)" ? "(1,)" : "[1]"}\n`]),
      // (each site run 3 times: the cached paths keep the receiver and pass the array)
      ["sites run 3 times", `class O:\n    def m(self, *a): return len(a), a[-1], self is o\n    @staticmethod\n    def s(*a): return len(a), a[-1]\no = O()\nfor _ in range(3):\n    print(o.m(${nums(200000)}), O.s(${nums(200000)}), '{}'.format(${nums(200000)}))\n`, "(200000, 199999, True) (200000, 199999) 0\n".repeat(3)],
    ];
    for (const [name, src, want] of cases) {
      writeFileSync(join(dir, `${name}.py`), src.replace(/\bF\b/g, JSON.stringify(join(dir, "out.txt"))));
      const r = run([join(dir, `${name}.py`)], 250);
      assert.equal(r.stdout + r.stderr, want, name);
    }
    writeFileSync(join(dir, "row.m"), `x = [${nums(200000).replace(/,/g, "")}];\ndisp(numel(x))\n`);
    const m = run(["--matlab", join(dir, "row.m")], 250);
    assert.equal((m.stdout + m.stderr).trim(), "200000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a builtin with no array adapter: CPython's TypeError at BIG_CALL, and the stack running out on 100,000 arguments a RecursionError naming the call", () => {
  const src = "import operator\nfor n in (2048, 100000):\n    try:\n        operator.add(*range(n))\n    except BaseException as e:\n        print(n, type(e).__name__, e)\n";
  assert.equal(run(["-c", src]).stdout, "2048 TypeError add() takes 2 positional arguments but 2048 were given\n100000 TypeError add() takes 2 positional arguments but 100000 were given\n");
  assert.equal(run(["-c", src], 250).stdout, "2048 TypeError add() takes 2 positional arguments but 2048 were given\n100000 RecursionError too many arguments in a call to add (100000)\n");
});

test("nesting: well inside the parser's measured limits, it compiles; past them, CPython's MemoryError; the 201st bracket CPython's SyntaxError", () => {
  // (measured on this branch, Nov 11: 158 lists at Node's default stack, 33 under --stack-size=250, a level or so either
  // way with V8's tiers; CPython takes 200, so between there and 200 we refuse what CPython takes)
  const nest = (n: number) => `x = ${"[".repeat(n)}${"]".repeat(n)}\nprint("ok")\n`;
  const overflow = "MemoryError: Parser stack overflowed - Python source too complex to parse";
  const last = (r: ReturnType<typeof run>) => (r.stdout + r.stderr).trim().split("\n").pop();
  for (const [stack, ok, refused] of [[null, 140, 180], [250, 30, 40]] as const) {
    assert.equal(last(run(["-c", nest(ok)], stack)), "ok", `${ok} at ${stack ?? "the default"}`);
    assert.equal(last(run(["-c", nest(refused)], stack)), overflow, `${refused} at ${stack ?? "the default"}`);
    assert.equal(last(run(["-c", nest(201)], stack)), "SyntaxError: too many nested parentheses");
  }
  assert.equal(last(run(["-c", `x = ${"-".repeat(100000)}1`])), overflow);
});

test("MATLAB rows of BIG_CALL - 1 and BIG_CALL calls, and their error versions: the output recorded on master, byte for byte", () => {
  const dir = join(TEST, "long-statements-matlab");
  for (const name of ["row-2047", "row-2048", "row-2047-error", "row-2048-error"]) {
    const r = run(["--matlab", `${name}.m`], null, dir);
    assert.equal(r.stdout, readFileSync(join(dir, `${name}.expected.stdout`), "utf8"), `${name} stdout`);
    assert.equal(r.stderr, readFileSync(join(dir, `${name}.expected.stderr`), "utf8"), `${name} stderr`);
    assert.equal(`${name} status ${r.status}`, readFileSync(join(dir, `${name}.expected.status`), "utf8").trim(), `${name} status`);
  }
});
