import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, HOST_DETAIL, py, ROOT, sprig } from "./sprig-helpers";

// Sprig's explicit stack and Stop (design/sprig-mvp.md §8.1, §8.3): every walk S1.1 reaches is iterative, pinned by
// deep parsed input and a deep expression built after parsing; catches name their classes; Stop propagates.

test("a Sprig session imports no Sage module: its start and its arithmetic are native", () => {
  const got = py(`
import json, sys, _sprig
_sprig.run("x = 2/3 + 1; {x^2, 2^100, 1.5 x}", lambda t: None, lambda t: None)
print(json.dumps(sorted(m for m in sys.modules if m.startswith("sage") or m.startswith("_sage"))))
`);
  assert.deepEqual(got, []);
});

// (§8.3, ENGINE's E1: every walk S1.1 reaches runs on an explicit stack, pinned twice over: through deep parsed input,
// and through a deep expression built after parsing, so the parser's safety and the other walks' are independent.  The
// depth, 10^5, is far past any host stack here; what is asserted is completion and the result's shape, never a time)
const DEEP = 100000;

test("§8.3: input nested 10^5 deep parses, evaluates and prints, with no host stack error", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-deep-"));
  try {
    // (the program is too long for a command line: run() reads it from a file, the same path as -c)
    const run = (program: string) => {
      writeFileSync(join(dir, "deep.sprig"), program);
      const r = spawnSync(process.execPath, [CLI, "-c", "import sys, _sprig\nsys.exit(_sprig.run(open('deep.sprig').read()))\n"], { cwd: dir, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    };
    const src = "f[".repeat(DEEP) + "x" + "]".repeat(DEEP);
    // (the language's $RecursionLimit lifted, S1.2: what is pinned here is that no host stack is reached)
    const r = run("$RecursionLimit = Infinity;\n" + src + "\nHold[" + src + "]\n" + "(".repeat(DEEP) + "1" + ")".repeat(DEEP) + "\n" + "{".repeat(DEEP) + "}".repeat(DEEP) + "\n1 + 1");
    assert.equal(r.status, 0, r.stderr.slice(0, 400));
    assert.doesNotMatch(r.stderr, HOST_DETAIL);
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], src, "f[f[...[x]...]] evaluates to itself and prints whole");
    assert.equal(lines[1], "Hold[" + src + "]");
    assert.equal(lines[2], "1");
    assert.equal(lines[3], "{".repeat(DEEP) + "}".repeat(DEEP));
    assert.equal(lines[4], "2", "the session answers");
    // (a deep sum, nested by parentheses: flattened and added on the explicit stack)
    const sum = run("$RecursionLimit = Infinity;\n" + "(1 + ".repeat(DEEP) + "1" + ")".repeat(DEEP));
    assert.equal(sum.stdout, `${DEEP + 1}\n`);
    assert.doesNotMatch(sum.stderr, HOST_DETAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§8.3: an expression 10^5 deep built after parsing: evaluation, both printers, equality, order and hash", () => {
  const got = py(`
import json
from _sprig.expr import Expr, Sym, same, compare, hash_of
from _sprig.eval import Session
from _sprig.fmt import input_form, full_form
f, g = Sym("f"), Sym("g")
def deep(n, leaf):
    e = leaf
    for _ in range(n):
        e = Expr(f, e)
    return e
a, b, c = deep(${DEEP}, Sym("x")), deep(${DEEP}, Sym("x")), deep(${DEEP}, Sym("y"))
s = Session(lambda t: None, lambda t: None)
s.recursion_limit = None   # ($RecursionLimit = Infinity: what is pinned is the host stack, not the language limit)
v = s.evaluate(a)
plus = Sym("x")
for _ in range(${DEEP}):
    plus = Expr(g, Expr("Plus", plus, 1))
w = s.evaluate(Expr("Hold", plus))
t = input_form(a)
u = full_form(c)
print(json.dumps({"same": same(v, a), "depth": v.depth, "input": [len(t), t[:6], t[-6:]], "full": [len(u), u[-6:]],
                  "eq": [same(a, b), same(a, c), a == b], "cmp": [compare(a, c), compare(c, a), compare(a, b)],
                  "hash": hash_of(a) == hash_of(b), "held": w.depth}))
`);
  assert.deepEqual(got, {
    same: true, depth: DEEP, input: [3 * DEEP + 1, "f[f[f[", "]]]]]]"], full: [3 * DEEP + 1, "]]]]]]"],
    eq: [true, false, true], cmp: [-1, 1, 0], hash: true, held: 2 * DEEP + 1,
  });
});

// (§8.1, from S1.1's first catches, SEC's staging: Stop and SystemExit always propagate; Sprig catches only its own
// classes, by name)
test("§8.1: no bare except, no except BaseException or Exception in lib/_sprig, and every catch names its class", () => {
  const dir = join(ROOT, "lib", "_sprig");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py"))) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(text, /^\s*except\s*:/m, `${f}: a bare except`);
    assert.doesNotMatch(text, /^\s*except\s*\(?[^)\n]*\b(BaseException|Exception|KeyboardInterrupt|SystemExit|MemoryError)\b/m, `${f}: except of a broad class, Stop or exit`);
    for (const m of text.matchAll(/^\s*except\s+([^:]+):/gm))
      assert.match(m[1].trim(), /^(StopIteration|parse\.SprigSyntaxError|parse\.NotYetSyntax|SprigSyntaxError|NotYetSyntax|_memguard\.SagebrushMemoryError|_BeyondMachine|SprigAbort)(\s+as\s+\w+)?$/, `${f}: catches ${m[1]}`);
  }
});

test("§8: Stop propagates out of the evaluator, a generator builtin and the parser, giving back what it held", () => {
  const got = py(`
import json, _sprig
from _sprig import mem, base, parse as P
from _sprig.eval import Session
from _sprig.expr import Expr, Sym
r = {}
def stop_pure(sess, e):
    with mem.reserve(10, "A test", "Stop"):
        raise KeyboardInterrupt
def stop_gen(sess, e):
    yield ("eval", Expr("Plus", 1, 1))
    raise KeyboardInterrupt
s = Session(lambda t: None, lambda t: None)
s.builtins = dict(s.builtins, StopNow=stop_pure, StopLater=stop_gen)
s.define(Sym("a"), 1, "Set")
base0 = mem.open_bytes()   # (a's definition, charged while it is defined)
for name in ("StopNow", "StopLater"):
    try:
        s.evaluate(P.parse("1 + f[a, " + name + "[1]]")[0])
        r[name] = "swallowed"
    except KeyboardInterrupt:
        r[name] = ["propagated", mem.open_bytes() - base0, s.evaluate(Sym("a"))]
        s.keep_value(0)
real = P.Parser.statement
def stop_parse(self):
    raise KeyboardInterrupt
P.Parser.statement = stop_parse
try:
    _sprig.run("1", lambda t: None, lambda t: None)
    r["parse"] = "swallowed"
except KeyboardInterrupt:
    r["parse"] = ["propagated", mem.open_bytes() - base0]
P.Parser.statement = real
real_parse = P.parse
def stop_inner(src, literals=None):
    raise KeyboardInterrupt
P.parse = stop_inner
try:
    s.evaluate(Expr("ToExpression", "1 + 1"))
    r["toexpression"] = "swallowed"
except KeyboardInterrupt:
    r["toexpression"] = ["propagated", mem.open_bytes() - base0]
P.parse = real_parse
print(json.dumps(r))
`);
  assert.deepEqual(got, { StopNow: ["propagated", 0, 1], StopLater: ["propagated", 0, 1], parse: ["propagated", 0], toexpression: ["propagated", 0] });
});

// (Stop through the CLI launcher, for real, without a timer: the program prints a marker, then loops; SIGINT is sent
// when the marker arrives, so the evaluation was running.  Asserted: the process ends by SIGINT, nothing after the
// loop runs, and there is no host traceback.  The kill after 120 s only keeps a hang from stalling the suite.)
function interruptedAtMarker(src: string, cwd: string): Promise<{ signal: string | null; code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "--sprig", "-c", src], { cwd });
    let stdout = "", stderr = "", sent = false;
    const guard = setTimeout(() => p.kill("SIGKILL"), 120000);
    p.stdout.on("data", (d: Buffer) => {
      stdout += d;
      if (!sent && stdout.includes("started\n")) {
        sent = true;
        p.kill("SIGINT");
      }
    });
    p.stderr.on("data", (d: Buffer) => (stderr += d));
    p.on("close", (code: number | null, signal: string | null) => (clearTimeout(guard), resolve({ signal, code, stdout, stderr })));
  });
}

test("§8: Stop (SIGINT) ends an endless evaluation through the CLI, and nothing after it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-sigint-"));
  try {
    // (an endless chain of values, x -> y -> x: S1.1 has no language limit, S1.2 adds $IterationLimit)
    for (const loop of ["x := y; y := x; x", "x = x + 1; x"]) {
      const r = await interruptedAtMarker(`Print["started"]\n${loop}\nPrint["finished"]`, dir);
      assert.equal(r.signal, "SIGINT", `${loop}: ended by the interrupt (${r.signal ?? r.code}; ${r.stderr.slice(0, 300)})`);
      assert.equal(r.stdout, "started\n", `${loop}: nothing after the loop ran`);
      assert.doesNotMatch(r.stderr, HOST_DETAIL);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (§8.4, ENGINE's E2: the ledger covers the state S1.1 introduces: the parse, the continuation stack, the printers'
// text, exact integers and lists; each mechanism admitted at its boundary and refused one byte past it, the refusal
// General::memory, and every reservation given back on a refusal or Stop)
