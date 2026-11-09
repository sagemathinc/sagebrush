import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sprig's host pins for S1.1, its first host exposure (the hidden `--sprig -c`): design/sprig-mvp.md §9's baseline and
// §8 for what S1.1 makes reachable (the S1 plan, with ENGINE's E1/E2 and SEC's literal staging, Nov 9).  The corpus
// (test/sprig-corpus-*.test.ts) pins the language; these pin Sprig's boundary: no file, network or process route, names
// that stay Sprig symbols, every walk on an explicit stack, the memory ledger, and Stop never swallowed.  Nothing here
// asserts a time or this host's stack depth.
const ROOT = join(__dirname, "..", "..");
const CLI = join(__dirname, "..", "src", "cli.js");

function sprig(src: string, cwd: string) {
  const r = spawnSync(process.execPath, [CLI, "--sprig", "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Python run in the engine (Sprig's modules in-process), its stdout's last line parsed as JSON. */
function py(src: string, cwd = ROOT) {
  const r = spawnSync(process.execPath, [CLI, "-c", src], { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const HOST_DETAIL = /Traceback|File "|\.py"|RecursionError|RangeError|Maximum call stack/;

test("--sprig runs only -c in this version (hidden until S1.4), and is not in --help", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-flag-"));
  try {
    writeFileSync(join(dir, "x.sprig"), 'Print["ran"]\n');
    writeFileSync(join(dir, "x.wl"), 'Print["ran"]\n');
    for (const args of [["--sprig", "x.sprig"], ["--sprig", "x.wl"], ["--sprig"], ["--sprig", "-i", "-c", "1"], ["--sprig", "-m", "x"], ["--sprig", "--emit", "x.sprig"]]) {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", input: "1\n", timeout: 60000 });
      assert.equal(r.status, 2, args.join(" "));
      assert.equal(r.stderr, "sagebrush: --sprig runs only -c in this version of Sagebrush\n", args.join(" "));
      assert.equal(r.stdout, "", args.join(" "));
    }
    const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    assert.doesNotMatch(help.stdout + help.stderr, /sprig/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (§9: every file, network and process function is refused before any of its arguments is evaluated, with Sprig's
// message, $Failed and the session unchanged; S1.1 reaches no file at all, so the file functions are refused too)
const REFUSED: [string, string][] = [
  ['Get["probe.sprig"]', 'Get::notyet: Get isn\'t available in Sprig yet.'],
  ['Import["probe.sprig"]', "Import::notyet: Import isn't available in Sprig yet."],
  ['Import["https://example.com/x"]', "Import::nonetwork: Import can't reach the network: it is off for documents."],
  ['ReadList["probe.sprig"]', "ReadList::notyet: ReadList isn't available in Sprig yet."],
  ['ReadList["!touch made-by-sprig"]', "ReadList::noprocess: ReadList can't start a program: Sprig doesn't run programs."],
  ['OpenRead["!touch made-by-sprig"]', "OpenRead::noprocess: OpenRead can't start a program: Sprig doesn't run programs."],
  ['FileExistsQ["probe.sprig"]', "FileExistsQ::notyet: FileExistsQ isn't available in Sprig yet."],
  ['Put[1, "made-by-sprig"]', "Put::notyet: Put isn't available in Sprig yet."],
  ['PutAppend[1, "made-by-sprig"]', "PutAppend::notyet: PutAppend isn't available in Sprig yet."],
  ['Export["made-by-sprig.txt", 1]', "Export::notyet: Export isn't available in Sprig yet."],
  ['DeleteFile["probe.sprig"]', "DeleteFile::notyet: DeleteFile isn't available in Sprig yet."],
  ['RenameFile["probe.sprig", "made-by-sprig"]', "RenameFile::notyet: RenameFile isn't available in Sprig yet."],
  ['CreateDirectory["made-by-sprig"]', "CreateDirectory::notyet: CreateDirectory isn't available in Sprig yet."],
  ['SetDirectory["/"]', "SetDirectory::notyet: SetDirectory isn't available in Sprig yet."],
  ['URLRead["https://example.com"]', "URLRead::nonetwork: URLRead can't reach the network: it is off for documents."],
  ['URLFetch["https://example.com"]', "URLFetch::nonetwork: URLFetch can't reach the network: it is off for documents."],
  ['URLDownload["https://example.com", "made-by-sprig"]', "URLDownload::nonetwork: URLDownload can't reach the network: it is off for documents."],
  ['Run["touch made-by-sprig"]', "Run::noprocess: Run can't start a program: Sprig doesn't run programs."],
  ['RunProcess[{"touch", "made-by-sprig"}]', "RunProcess::noprocess: RunProcess can't start a program: Sprig doesn't run programs."],
];

test("§9: every file, network and process function is refused before any effect, the session unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-gates-"));
  try {
    writeFileSync(join(dir, "probe.sprig"), 'Print["loaded"]\n');
    for (const [call, message] of REFUSED) {
      const r = sprig(call, dir);
      assert.equal(r.status, 0, call);
      assert.equal(r.stdout, "$Failed\n", `${call}: $Failed, and nothing else printed`);
      assert.equal(r.stderr, message + "\n", call);
      assert.deepEqual(readdirSync(dir), ["probe.sprig"], `${call}: no file made or removed`);
      // (an argument with an effect, inside Sprig: it is never evaluated, so the session is as it was)
      const held = call.replace("[", "[a = 2; Print[\"evaluated\"]; ");
      const h = sprig(`a = 1;\n${held}\na`, dir);
      // (OpenRead with no literal "!cmd" is no pipe: it stays an inert, held expression, design §9)
      if (call.startsWith("OpenRead")) {
        const lines = h.stdout.split("\n");
        assert.ok(lines[0].startsWith("OpenRead[a = 2 ; Print[") && lines[1] === "1" && !h.stdout.includes("evaluated\n"), `${held}: inert (${h.stdout})`);
      } else assert.equal(h.stdout, "$Failed\n1\n", `${held}: the argument never ran`);
      assert.doesNotMatch(h.stderr, HOST_DETAIL);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: names, strings and contexts stay Sprig symbols, never Python objects (negative controls)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-names-"));
  try {
    const cases: [string, string, string][] = [
      ["os", "os\n", ""],
      ["sys", "sys\n", ""],
      ["eval", "eval\n", ""],
      ["Global`os", "os\n", ""],
      ["os[\"system\"][\"touch made-by-sprig\"]", 'os["system"]["touch made-by-sprig"]\n', ""],
      ["Head[Global`os]", "Symbol\n", ""],
      ['Symbol["os"]', "os\n", ""],
      ['Symbol["os"]["system"]["touch made-by-sprig"]', 'os["system"]["touch made-by-sprig"]\n', ""],
      ['Symbol["__import__"]', 'Symbol["__import__"]\n', "Symbol::symname: The string __import__ cannot be used for a symbol name. A symbol name must start with a letter followed by letters and numbers.\n"],
      ['Symbol["__import__"]["os"]', 'Symbol["__import__"]["os"]\n', "Symbol::symname: The string __import__ cannot be used for a symbol name. A symbol name must start with a letter followed by letters and numbers.\n"],
      ['ToExpression["os"]', "os\n", ""],
      ['ToExpression["__builtins__"]', "__*__builtins\n", ""],
      ['ToExpression["Run[\\"touch made-by-sprig\\"]"]', "$Failed\n", "Run::noprocess: Run can't start a program: Sprig doesn't run programs.\n"],
      // (functions Sprig doesn't know are inert expressions: no exit, no environment, no file, no package)
      ["Exit[3]", "Exit[3]\n", ""],
      ["Quit[]", "Quit[]\n", ""],
      ['Environment["HOME"]', 'Environment["HOME"]\n', ""],
      ['WriteString["made-by-sprig", "x"]', 'WriteString["made-by-sprig", "x"]\n', ""],
      ['Needs["os`"]', 'Needs["os`"]\n', ""],
      ['OpenRead["made-by-sprig"]', 'OpenRead["made-by-sprig"]\n', ""],
    ];
    for (const [src, out, err] of cases) {
      const r = sprig(src + "\n1 + 1", dir);
      assert.equal(r.stdout, out + "2\n", `${src}: inert, and the session answers`);
      assert.equal(r.stderr, err, src);
      assert.deepEqual(readdirSync(dir), [], `${src}: no file made`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9: the gate inventory lists every route in lib/_sprig, each with its decision (scripts/sprig-gates.mjs)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "sprig-gates.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const inventory = JSON.parse(readFileSync(join(ROOT, "scripts", "sprig-gates.json"), "utf8")).routes;
  for (const k of Object.keys(inventory)) assert.ok(!/^call:/.test(k), `${k}: Sprig calls no host builtin by name`);
  for (const k of Object.keys(inventory)) assert.ok(!/^import:(os|io|subprocess|socket|shutil|pathlib|builtins|importlib|ctypes|js)$/.test(k), `${k}: Sprig imports no host module of files, processes or the network in S1.1`);
  // (each refused builtin has a behavioural pin above)
  const pinned = new Set(REFUSED.map(([call]) => call.slice(0, call.indexOf("["))));
  for (const [k, v] of Object.entries(inventory) as [string, { decision: string }][])
    if (v.decision === "refused" && !pinned.has(k.slice("builtin:".length))) {
      const r = sprig(`${k.slice("builtin:".length)}[a = 2]\na`, ROOT);
      assert.equal(r.stdout, "$Failed\na\n", `${k}: refused before its argument ran`);
      assert.match(r.stderr, /^\w+::(notyet|nonetwork|noprocess): /, k);
    }
});

// (the census fails closed, as Rill's: each mutant plants one spelling in a copy of lib/_sprig, and the census must list
// a new route or report a problem)
test("§9: the gate census catches every planted route spelling (mutants)", async () => {
  const { census } = await import(join(ROOT, "scripts", "sprig-gates.mjs"));
  const base = census(ROOT);
  assert.deepEqual(base.problems, []);
  const MUTANTS: [string, string, RegExp][] = [
    ["mem.py", "import sys as s\n", /import the census can't read|`as`/],
    ["mem.py", "from sys import stdout\n", /absolute `from … import`/],
    ["mem.py", "import sys\nout = sys\n", /host module sys used as a value/],
    ["mem.py", "import os\nos.system('x')\n", /^host:os\.system$|^import:os$/],
    ["base.py", "BUILTINS['Evil'] = _print\n", /BUILTINS used in a form/],
    ["base.py", "BUILTINS.update(Evil=_print)\n", /BUILTINS used in a form/],
    ["base.py", 'BUILTINS["Evil"] = _print\n', /^builtin:Evil$/],
    ["base.py", 'EXTRA = ("Evil",)\nfor _n in EXTRA:\n    BUILTINS[_n] = _print\n', /^builtin:Evil$/],
    ["base.py", "for _n in names():\n    BUILTINS[_n] = _print\n", /BUILTINS loop over names|BUILTINS used in a form/],
    ["base.py", 'BUILTINS = {"Evil": _print}\n', /BUILTINS assigned more than once|^builtin:Evil$/],
    ["eval.py", "x = (1).__class__\n", /introspection attribute __class__/],
    ["eval.py", "g = Session.__globals__\n", /introspection attribute __globals__/],
    ["eval.py", "f = open('x')\n", /^call:open$/],
    ["eval.py", "e = eval('1')\n", /^call:eval$/],
    ["eval.py", "a = getattr(Session, 'x')\n", /^call:getattr$/],
    ["parse.py", "m = __import__('os')\n", /^call:__import__$/],
  ];
  for (const [file, code, want] of MUTANTS) {
    const dir = mkdtempSync(join(tmpdir(), "sprig-census-"));
    try {
      cpSync(join(ROOT, "lib", "_sprig"), join(dir, "lib", "_sprig"), { recursive: true });
      appendFileSync(join(dir, "lib", "_sprig", file), "\n" + code);
      const got = census(dir);
      const newRoutes = [...got.routes.keys()].filter((k: string) => !base.routes.has(k));
      const caught = got.problems.some((p: string) => want.test(p)) || newRoutes.some((k: string) => want.test(k));
      assert.ok(caught, `${file} + ${JSON.stringify(code)}: not caught (problems ${JSON.stringify(got.problems)}, new routes ${JSON.stringify(newRoutes)})`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// (ENGINE's condition on ruling 1: Sprig's start does no Sage work, so the offline item's declared Sage dependency
// costs a Sprig session nothing until S2)
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
    const r = run(src + "\nHold[" + src + "]\n" + "(".repeat(DEEP) + "1" + ")".repeat(DEEP) + "\n" + "{".repeat(DEEP) + "}".repeat(DEEP) + "\n1 + 1");
    assert.equal(r.status, 0, r.stderr.slice(0, 400));
    assert.doesNotMatch(r.stderr, HOST_DETAIL);
    const lines = r.stdout.split("\n");
    assert.equal(lines[0], src, "f[f[...[x]...]] evaluates to itself and prints whole");
    assert.equal(lines[1], "Hold[" + src + "]");
    assert.equal(lines[2], "1");
    assert.equal(lines[3], "{".repeat(DEEP) + "}".repeat(DEEP));
    assert.equal(lines[4], "2", "the session answers");
    // (a deep sum, nested by parentheses: flattened and added on the explicit stack)
    const sum = run("(1 + ".repeat(DEEP) + "1" + ")".repeat(DEEP));
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
      assert.match(m[1].trim(), /^(StopIteration|parse\.SprigSyntaxError|parse\.NotYetSyntax|SprigSyntaxError|NotYetSyntax|_memguard\.SagebrushMemoryError|_BeyondMachine)(\s+as\s+\w+)?$/, `${f}: catches ${m[1]}`);
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
s.own[Sym("a")] = 1
for name in ("StopNow", "StopLater"):
    try:
        s.evaluate(P.parse("1 + f[a, " + name + "[1]]")[0])
        r[name] = "swallowed"
    except KeyboardInterrupt:
        r[name] = ["propagated", mem.open_bytes(), s.evaluate(Sym("a"))]
real = P.Parser.statement
def stop_parse(self):
    raise KeyboardInterrupt
P.Parser.statement = stop_parse
try:
    _sprig.run("1", lambda t: None, lambda t: None)
    r["parse"] = "swallowed"
except KeyboardInterrupt:
    r["parse"] = ["propagated", mem.open_bytes()]
P.Parser.statement = real
real_parse = P.parse
def stop_inner(src):
    raise KeyboardInterrupt
P.parse = stop_inner
try:
    s.evaluate(Expr("ToExpression", "1 + 1"))
    r["toexpression"] = "swallowed"
except KeyboardInterrupt:
    r["toexpression"] = ["propagated", mem.open_bytes()]
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
test("§8.4: the shared reservation: the boundary, one past it, the unmeasured cap, and Stop giving back its reservation", () => {
  const got = py(`
import json
from _sprig import mem
import _memguard
G = 64 << 20
mem._allowance = lambda: (G, None)
r = {}
with mem.reserve(G, "A test", "Test"):
    r["at"] = mem.open_bytes()
try:
    with mem.reserve(G + 1, "A test", "Test"):
        r["past"] = "admitted"
except _memguard.SagebrushMemoryError as e:
    r["past"] = [e.need_bytes, e.limit_bytes, e.sprig_name]
r["after"] = mem.open_bytes()
mem._allowance = lambda: (None, "no memory figure")
with mem.reserve(mem.UNMEASURED_OPERATION_BYTES, "A test", "Test"):
    pass
try:
    with mem.reserve(mem.UNMEASURED_OPERATION_BYTES + 1, "A test", "Test"):
        pass
except _memguard.SagebrushMemoryError as e:
    r["unmeasured"] = [e.fixed, e.unmeasured]
mem._allowance = lambda: (G, None)
try:
    with mem.reserve(G, "A test", "Test"):
        raise KeyboardInterrupt
except KeyboardInterrupt:
    r["stop"] = mem.open_bytes()
print(json.dumps(r))
`);
  assert.deepEqual(got, { at: 64 << 20, past: [(64 << 20) + 1, 64 << 20, "Test"], after: 0, unmeasured: [true, "no memory figure"], stop: 0 });
});

test("§8.4: each mechanism reserves its peak first: admitted at the boundary, refused one byte past it, as General::memory", () => {
  const got = py(`
import json, _sprig
from fractions import Fraction
from _sprig import mem
from _sprig.eval import Session
from _sprig.parse import parse
from _sprig.expr import Expr, Sym
mem.SMALL_BYTES = 0
out = {}
def probe(name, need, run):
    """run() under an allowance of need - 1 bytes beyond what is open, then of need: (refused, admitted)."""
    res = []
    for extra in (-1, 0):
        mem._allowance = lambda: (need + extra - mem.open_bytes(), None)
        err = []
        try:
            v = run(err)
            # (run() reports a refusal itself, as General::memory, and goes on)
            res.append(["refused", "".join(err).split(":")[0]] if any("::memory:" in t for t in err) else v)
        except mem.SprigMemoryError as e:
            res.append(["refused", e.sprig_name, e.need_bytes])
        res[-1] = [res[-1], mem.open_bytes(), err[:1]]
    out[name] = res
# the parse: a program of n characters (a comment, so nothing is evaluated)
src = "(* " + "x" * 300 + " *)"
probe("parse", len(src) * mem.PARSE_BYTES_PER_CHAR, lambda err: _sprig.run(src, lambda t: None, err.append))
# the continuation stack's first chunk (the parse of "f[1]" is held at the same time)
p = len("f[1]") * mem.PARSE_BYTES_PER_CHAR
probe("konts", p + _sprig.eval.KONT_CHUNK * mem.KONT_BYTES, lambda err: _sprig.run("f[1]", lambda t: None, err.append))
# the printer's text, for a value of 2001 units
big = Expr("List", *[Expr("f", i) for i in range(667)])
probe("format", big.size * mem.FORMAT_BYTES_PER_NODE, lambda err: len(_sprig._formatted(big, _sprig.input_form)))
# an exact integer's computation and a list, in a session (its continuation stack's first chunk held at the same time)
s = Session(lambda t: None, lambda t: None)
chunk = _sprig.eval.KONT_CHUNK * mem.KONT_BYTES
def power(err):
    s.write_err = err.append
    return _sprig.input_form(s.evaluate(Expr("Power", 3, 10**6)))[:4]
probe("power", chunk + mem.int_bytes((3).bit_length() * 10**6), power)
probe("range", chunk + 1000 * mem.NODE_BYTES, lambda err: len(s.evaluate(Expr("Range", 1000)).args))
# an exact literal's power of ten, reserved before it is computed (the parse of its program held at the same time)
lit = "1*^20000"
bits = 1 + 20000 * 10 // 3 + 1
probe("literal", len(lit) * mem.PARSE_BYTES_PER_CHAR + mem.int_bytes(bits), lambda err: _sprig.run(lit, lambda t: None, err.append))
# a large exact sum, and the root search's trial powers
big = 2 ** 9000
probe("sum", chunk + mem.int_bytes(9002), lambda err: _sprig.input_form(s.evaluate(Expr("Plus", big, big)))[:3])
probe("root", chunk + mem.int_bytes(2 * (big + 1).bit_length()), lambda err: _sprig.input_form(s.evaluate(Expr("Power", big + 1, Fraction(1, 2))))[:3])
# a Listable call threaded over lists
probe("thread", chunk + 3 * 2 * mem.NODE_BYTES, lambda err: _sprig.input_form(s.evaluate(Expr("Plus", Expr("List", 1, 2, 3), 1))))
print(json.dumps(out))
`);
  for (const [name, [refused, admitted]] of Object.entries(got) as [string, any[]][]) {
    assert.equal(refused[0][0], "refused", `${name}: refused one byte past its peak (${JSON.stringify(refused)})`);
    assert.equal(refused[1], 0, `${name}: the refusal gave back what it held`);
    assert.notEqual(admitted[0][0], "refused", `${name}: admitted at its peak (${JSON.stringify(admitted)})`);
    assert.equal(admitted[1], 0, `${name}: given back after`);
  }
});

test("§8.4: a refusal through the CLI is General::memory with Sagebrush's figures, and the session answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-mem-"));
  try {
    const r = sprig("a = 7;\nRange[10^15]\n2^(10^15)\na + 1", dir);
    assert.equal(r.stdout, "$Aborted\n$Aborted\n8\n");
    const lines = r.stderr.split("\n");
    assert.match(lines[0], /^Range::memory: Range needs more memory than this session allows: a list of 1000000000000000 numbers needs about \d+(\.\d+)? [kMGTP]B, but Sagebrush allows about .+\.$/);
    assert.ok(lines.some((l) => /^Power::memory: Power needs more memory than this session allows: an exact number of \d+ bits needs about /.test(l)), r.stderr);
    assert.doesNotMatch(r.stderr, HOST_DETAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (ENGINE's E2 on #911: a machine Real past the machine range needs arbitrary precision, S2's: it is General::notyet,
// never a host error, Infinity or a silent 0; in a literal the program stops there, as at a syntax error, and through
// ToExpression the session goes on; in arithmetic the call stays unevaluated)
test("a machine Real past the machine range is General::notyet, at parse time and in arithmetic, and the session answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-machine-"));
  try {
    const NOTYET = "isn't available in Sprig yet.";
    const p = sprig("a = 1;\nPrint[a]\n1.*^1000000\nPrint[\"after\"]", dir);
    assert.equal(p.status, 1);
    assert.equal(p.stdout, "1\n", "the statements before it ran, none after");
    assert.equal(p.stderr, `General::notyet: A real number beyond the machine range ${NOTYET}\n`);
    for (const lit of ["1.*^309", "1.*^-400", "1.*^99999999999"]) {
      const t = sprig(`ToExpression["${lit}"]\n1 + 1`, dir);
      assert.equal(t.stdout, "$Failed\n2\n", lit);
      assert.equal(t.stderr, `ToExpression::notyet: A real number beyond the machine range ${NOTYET}\n`, lit);
    }
    const e = sprig("2.^1024\n2.^-1080\n1.5 + 10^400\n(1.*^300) (1.*^300)\n2.^1023\n1.5 + 10^400 - 10^400\n1 + 1", dir);
    assert.equal(e.status, 0);
    const out = e.stdout.split("\n");
    assert.deepEqual([out[0], out[1], out[3], out[4], out[5], out[6]], ["2.^1024", "1/2.^1080", "1.*^300*1.*^300", "8.98846567431158*^307", "1.5", "2"]);
    assert.equal(out[2], "1.5 + 1" + "0".repeat(400));
    assert.deepEqual(e.stderr.split("\n").filter(Boolean).map((l) => l.split(":")[0]), ["Power", "Power", "Plus", "Times"].map((f) => f + ""));
    assert.ok(e.stderr.split("\n").filter(Boolean).every((l) => l.endsWith(`::notyet: A real number beyond the machine range ${NOTYET}`)), e.stderr);
    assert.doesNotMatch(e.stderr + p.stderr, HOST_DETAIL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// (design §5.2: the census discovers nested library files, lib/_sprig/** included, so a refusal there needs a reviewed
// class; the other nested directories are the stated exclusions)
test("§5.2: the limits census discovers a refusal in a nested lib/_sprig file, and Sprig's sites are registered", () => {
  const dir = mkdtempSync(join(tmpdir(), "sprig-census-nested-"));
  try {
    mkdirSync(join(dir, "lib", "_sprig", "deep"), { recursive: true });
    mkdirSync(join(dir, "lib", "vendored"), { recursive: true });
    mkdirSync(join(dir, "test"), { recursive: true });
    const refusal = "def f(n):\n    if n > LIMIT:\n        raise ValueError('too large')\n";
    writeFileSync(join(dir, "lib", "_sprig", "deep", "probe.py"), refusal);
    writeFileSync(join(dir, "lib", "vendored", "probe.py"), refusal);
    writeFileSync(join(dir, "lib", "top.py"), refusal);
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["add", "."], { cwd: dir });
    // (the census is a CPython script, test/limits.test.ts's)
    const r = spawnSync("python3", ["-c", `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, "test"))})
import limit_sites as L
L.use_root(${JSON.stringify(dir)})
print(json.dumps(sorted({p for _, p, _ in L.sites()})))
`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout);
    assert.deepEqual(got, ["lib/_sprig/deep/probe.py", "lib/top.py"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const reg = JSON.parse(readFileSync(join(ROOT, "test", "limit-sites.json"), "utf8"));
  const sites = Object.entries(reg.sites ?? reg).filter(([k]) => k.startsWith("lib/_sprig/")) as [string, any][];
  assert.ok(sites.length > 0, "Sprig's sites are in the registry");
  for (const [k, v] of sites) assert.deepEqual([v.class, v.disposition, v.explained], ["2", { 2: { route: "memguard" } }, true], k);
});
