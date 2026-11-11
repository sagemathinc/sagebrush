import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Malformed Magma input ends as Magma's error, never as a crash of the host: no JS exception escapes the
// translator (src/magma.ts), no Python error reaches the user, and nothing loops or exhausts memory. Where
// Magma 2.18-5 and Sagebrush agree, magma-tests/ pins the exact text (test_error_literal_*, test_error_eof_*,
// test_literal_ident, test_deep_nesting); here, the inputs where they differ or that are too large to keep,
// and the property for any input at all.
const CLI = join(__dirname, "../src/cli.js");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { magmaToPython, MagmaSyntaxError, TOO_DEEP } = require("../src/magma.js");

const deep = (open: string, close: string, n: number) => "x := " + open.repeat(n) + "1" + close.repeat(n) + ";";
const ifs = (n: number) => "if true then\n".repeat(n) + "x := 1;\n" + "end if;\n".repeat(n);

// each with the line Magma's (or Sagebrush's) error must start
const CASES: [string, string, RegExp][] = [
  ["a lone quote", "'", /User error: Unexpected newline in literal identifier/],
  ["an open literal identifier", "x := 1;\n'abc\nprint 2;", /User error: Unexpected newline in literal identifier/],
  ["the end inside a function's header", "function f(", /User error: syntax error at end of input/],
  ["the end inside a procedure", "procedure p()", /User error: syntax error at end of input/],
  ["the end inside an if", "if true then", /User error: syntax error at end of input/],
  ["5000 parentheses", deep("(", ")", 5000), /User error: this statement is nested too deeply for Sagebrush/],
  ["3000 brackets", deep("[", "]", 3000), /User error: this statement is nested too deeply for Sagebrush/],
  ["2000 minus signs", "x := " + "-".repeat(2000) + "1;", /User error: this statement is nested too deeply for Sagebrush/],
  ["1000 nots", "x := " + "not ".repeat(1000) + "true;", /User error: this statement is nested too deeply for Sagebrush/],
  ["a sum of 5000 terms", "x := " + Array(5000).fill("1").join("+") + ";", /User error: this statement is nested too deeply for Sagebrush/],
  ["1000 nested ifs", ifs(1000), /User error: this statement is nested too deeply for Sagebrush/],
  ["a literal identifier with a space", "'a b' := 1;", /User error: 'a b' \(a literal identifier that isn't a plain name\) is not supported yet/],
  ["an empty literal identifier", "'' := 1;", /User error: '' \(a literal identifier that isn't a plain name\) is not supported yet/],
];

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

test("malformed Magma, through __pyjs_compile_magma__: Magma's error and the file stopped, never a Python or JS error", () => {
  const r = spawnSync(process.execPath, ["--max-old-space-size=512", CLI, "-c", DRIVER], { input: JSON.stringify(CASES.map((c) => c[1])), encoding: "utf8", timeout: 300000 });
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  const res = JSON.parse(r.stdout.trim().split("\n").pop()!) as [string, string][];
  CASES.forEach(([what, , want], k) => {
    const [end, out] = res[k];
    assert.equal(end, "exit 1", `${what}: ends as a stopped file (${end})`);
    assert.match(out, want, `${what}: ${JSON.stringify(out.slice(0, 300))}`);
    assert.doesNotMatch(out, /Traceback|RecursionError|IndentationError|RangeError|TypeError|SyntaxError/, what);
  });
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
    "procedure", "return", "print", "case", "when", "select", "..", "|", "#", "&", "~", "$$", "\n", " ", "@", "`", "\\"];
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

test("depth: a statement past the bound is refused at its start, and one inside it still runs", () => {
  const py = (src: string) => magmaToPython(src, "t.m", { recover: "file" }) as string;
  assert.match(py(deep("(", ")", 150)), /_m\._own\(/);
  assert.doesNotMatch(py(deep("(", ")", 150)), new RegExp(TOO_DEEP));
  assert.match(py("y := 1;\n" + deep("(", ")", 400)), /_m\._syntax_error\(2, 1, "this statement is nested too deeply for Sagebrush", True\)/);
  assert.throws(() => magmaToPython(deep("[", "]", 400), "t.m"), (e: any) => e instanceof MagmaSyntaxError && e.verbatim && e.line === 1 && e.col === 1);
});
