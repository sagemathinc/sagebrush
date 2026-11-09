import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI, HOST_DETAIL, py, ROOT, sprig } from "./sprig-helpers";

// Sprig's memory ledger and number range (design/sprig-mvp.md §8.4, §5.2): each mechanism admitted at its peak and
// refused one byte past it, machine Reals past the machine range, and the limits census's nested discovery.

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
# an exact literal's power of ten, reserved by the parser before it is computed
bits = 1 + 20000 * 10 // 3 + 1
probe("literal", mem.int_bytes(bits), lambda err: len(parse("1*^20000")))
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

// (astra2 on #911 r2: under the production policy, SMALL_BYTES as shipped, many small reservations held at once are
// checked as their sum, and Print reserves its whole line, sized by every argument, a long number by its digits)
test("§8.4, the default policy: stacked continuation chunks are checked as their sum, and the allowance is read", () => {
  const got = py(`
import json
from _sprig import mem, eval as E
from _sprig.eval import Session
from _sprig.expr import Expr, Sym
reads = [0]
def none_left():
    reads[0] += 1
    return (0, None)
mem._allowance = none_left
r = {"small": mem.SMALL_BYTES, "chunk": E.KONT_CHUNK * mem.KONT_BYTES}
a = mem.reserve(r["chunk"], "A test", "Test").acquire()
r["first"] = [mem.open_bytes(), reads[0]]
try:
    mem.reserve(r["chunk"], "A test", "Test").acquire()
    r["second"] = "admitted"
except mem.SprigMemoryError as e:
    r["second"] = ["refused", e.need_bytes, e.limit_bytes, reads[0]]
a.release()
r["after"] = mem.open_bytes()
# through the evaluator: an expression two chunks deep, with no memory left past the first
deep = Sym("x")
for _ in range(E.KONT_CHUNK + 10):
    deep = Expr("f", deep)
s = Session(lambda t: None, lambda t: None)
try:
    s.evaluate(deep)
    r["deep"] = "admitted"
except mem.SprigMemoryError as e:
    r["deep"] = ["refused", e.sprig_name, mem.open_bytes()]
print(json.dumps(r))
`);
  assert.ok(got.chunk < got.small && 2 * got.chunk > got.small, `one chunk is small, two aren't (${got.chunk}, ${got.small})`);
  assert.deepEqual(got.first, [got.chunk, 0], "the first chunk is admitted without reading the memory figure");
  assert.deepEqual(got.second, ["refused", got.chunk, 0, 1], "the second is checked as the sum, with the figure read");
  assert.equal(got.after, 0);
  assert.deepEqual(got.deep, ["refused", "Evaluation", 0], "a deep evaluation's second chunk is refused, and gives everything back");
});

test("§8.4, the default policy: Print reserves its whole line, a long number by its digits, admitted at its peak and refused one byte past it", () => {
  const got = py(`
import json, _sprig
from fractions import Fraction
from _sprig import mem, base
from _sprig.eval import Session, KONT_CHUNK
from _sprig.expr import Expr
big = 3 ** 200000
args = ("x = ", big, Fraction(big, 7))
need = KONT_CHUNK * mem.KONT_BYTES + base.format_bytes(args)
r = {"need": need, "small": mem.SMALL_BYTES, "per_digit_ok": base.format_bytes((big,)) >= len(str(big))}
for extra in (-1, 0):
    mem._allowance = lambda: (need + extra - mem.open_bytes(), None)
    out = []
    s = Session(out.append, out.append)
    try:
        s.evaluate(Expr("Print", *args))
        r[str(extra)] = ["admitted", len("".join(out)), mem.open_bytes()]
    except mem.SprigMemoryError as e:
        r[str(extra)] = ["refused", e.sprig_name, len("".join(out)), mem.open_bytes()]
print(json.dumps(r))
`);
  assert.ok(got.need > got.small, "the line is past the small-operation size, so the figure is read");
  assert.ok(got.per_digit_ok, "a long number is charged at least a byte per digit");
  assert.deepEqual(got["-1"], ["refused", "Print", 0, 0], "one byte short: refused before anything is written, and given back");
  assert.equal(got["0"][0], "admitted");
  assert.ok(got["0"][1] > 2 * 95000, "the whole line is written");
  assert.equal(got["0"][2], 0, "given back after the write");
});

// (ENGINE's E1 and SEC's (3) on #911 r2: the state a session keeps, under the shipped SMALL_BYTES: each definition is
// charged while it is defined (reserved before it is published; a replacement gives back the old charge, a refusal
// keeps the old definition, Stop leaves it, teardown gives back everything); ToExpression's parse is charged while its
// statements run; a session's names go with it; a rational result's bound covers it)
test("§8.4, the default policy: definitions stay charged; aggregate small ones at the boundary and +1; replace, refusal, aliasing, Stop and teardown", () => {
  const got = py(`
import json, _sprig
from _sprig import mem, base
from _sprig.eval import Session
from _sprig.expr import Expr, Sym, size_of
r = {"small": mem.SMALL_BYTES}
val = Expr("List", *range(1000))
D = (size_of(val) + 1) * mem.NODE_BYTES
r["D"] = D
def run(G, k):
    mem._allowance = lambda: (G - mem.open_bytes(), None)
    s = Session(lambda t: None, lambda t: None)
    res = []
    for i in range(k):
        try:
            s.define(Sym("v%d" % i), val, "Set")
            res.append("ok")
        except mem.SprigMemoryError as e:
            res.append("refused")
    held = mem.open_bytes()
    s.close()
    return res, held, mem.open_bytes()
r["at"] = run(3 * D, 4)
r["short"] = run(3 * D - 1, 3)
# replacement, refusal of a replacement, aliasing, through Set in a session
mem._allowance = lambda: (10**12, None)
s = Session(lambda t: None, lambda t: None)
s.evaluate(Expr("Set", Sym("a"), val))
one = mem.open_bytes()
s.evaluate(Expr("Set", Sym("b"), Sym("a")))
r["alias"] = [one == D, mem.open_bytes() == 2 * D]
s.evaluate(Expr("Set", Sym("a"), 5))
r["replace"] = mem.open_bytes() == D + 2 * mem.NODE_BYTES
mem._allowance = lambda: (0, None)
big = Expr("List", *range(5000))
try:
    s.define(Sym("b"), big, "Set")
    r["refused"] = "admitted"
except mem.SprigMemoryError:
    held = mem.open_bytes()
    mem._allowance = lambda: (10**12, None)
    r["refused"] = [s.evaluate(Sym("b")) == val, held == D + 2 * mem.NODE_BYTES]
# Stop while the new value is computed: the old definition and its charge stay
mem._allowance = lambda: (10**12, None)
def stop(sess, e):
    raise KeyboardInterrupt
s.builtins = dict(s.builtins, StopNow=stop)
before = mem.open_bytes()
try:
    s.evaluate(Expr("Set", Sym("b"), Expr("StopNow")))
except KeyboardInterrupt:
    r["stop"] = [s.evaluate(Sym("b")) == val, mem.open_bytes() == before]
s.close()
r["teardown"] = mem.open_bytes()
# through the CLI's run(): 40 definitions of Range[2000], each small, charged together, and all given back at the end
mem._allowance = lambda: (10**12, None)
seen = []
def probe(sess, e):
    seen.append(mem.open_bytes())
    return 0
base.BUILTINS["Probe"] = probe
_sprig.run("".join("v%d = Range[2000];\\n" % i for i in range(40)) + "Probe[]", lambda t: None, lambda t: None)
del base.BUILTINS["Probe"]
r["forty"] = [seen[0] >= 40 * 2000 * mem.NODE_BYTES, mem.open_bytes()]
print(json.dumps(r))
`);
  assert.ok(got.D < got.small && 3 * got.D > got.small, `each definition is small, three aren't (${got.D}, ${got.small})`);
  assert.deepEqual(got.at, [["ok", "ok", "ok", "refused"], 3 * got.D, 0], "three admitted at their sum, the fourth refused; teardown gives all back");
  assert.deepEqual(got.short, [["ok", "ok", "refused"], 2 * got.D, 0], "one byte short of three: the third refused");
  assert.deepEqual(got.alias, [true, true], "an alias is a definition of its own, charged on its own");
  assert.equal(got.replace, true, "a replacement gives back the old value's charge");
  assert.deepEqual(got.refused, [true, true], "a refused replacement keeps the old definition and charge");
  assert.deepEqual(got.stop, [true, true], "Stop while the new value is computed leaves the old definition and charge");
  assert.equal(got.teardown, 0);
  assert.deepEqual(got.forty, [true, 0], "40 definitions held are charged together, and the run's end gives them back");
});

test("§8.4, the default policy: ToExpression's parse is charged while its statements run, and Stop gives it back", () => {
  const got = py(`
import json
from _sprig import mem, base, eval as E
from _sprig.eval import Session
from _sprig.expr import Expr
mem._allowance = lambda: (10**12, None)
seen = []
def probe(sess, e):
    seen.append(mem.open_bytes())
    return 0
def stop(sess, e):
    raise KeyboardInterrupt
s = Session(lambda t: None, lambda t: None)
s.builtins = dict(s.builtins, Probe=probe, StopNow=stop)
src = "Probe[]; Probe[]"
s.evaluate(Expr("ToExpression", src))
after = mem.open_bytes()
try:
    s.evaluate(Expr("ToExpression", "Probe[]; StopNow[]"))
    stopped = "swallowed"
except KeyboardInterrupt:
    stopped = [mem.open_bytes(), len(s.holds)]
print(json.dumps({"seen": seen, "parse": len(src) * mem.PARSE_BYTES_PER_CHAR, "chunk": E.KONT_CHUNK * mem.KONT_BYTES, "after": after, "stopped": stopped}))
`);
  for (const v of got.seen.slice(0, 2)) assert.ok(v >= got.parse + got.chunk, `the parse is held with the stack (${v} >= ${got.parse} + ${got.chunk})`);
  assert.equal(got.after, 0);
  assert.deepEqual(got.stopped, [0, 0], "Stop inside a statement gives back the parse's hold");
});

test("a session's names go with it: the shared table holds only Sprig's own, and constants keep their identity", () => {
  const got = py(`
import json, _sprig
from _sprig.expr import Sym, TRUE
shared, loose = len(Sym._table), len(Sym._loose)
_sprig.run_cases([("c%d" % k, " + ".join("name%d" % (k * 1000 + i) for i in range(1000))) for k in range(10)])
res = _sprig.run_cases([("c", "u = 3; {u, u + 1, True}")])
print(json.dumps({"shared": len(Sym._table) - shared, "loose": len(Sym._loose) - loose, "true": Sym("True") is TRUE, "res": res[0]["result"]}))
`);
  assert.deepEqual(got, { shared: 0, loose: 0, true: true, res: "{3, 4, True}" });
});

test("a rational sum's or product's result bits are within the bound reserved for it", () => {
  const got = py(`
import json, random
from fractions import Fraction
from _sprig.base import result_bits, _bits
rnd = random.Random(911)
bad = []
for _ in range(400):
    k = rnd.choice([1, 8, 64, 512])
    a = Fraction(rnd.getrandbits(k * 3) + 1, rnd.getrandbits(k) + 1)
    b = rnd.choice([Fraction(rnd.getrandbits(k) + 1, rnd.getrandbits(k * 2) + 1), rnd.getrandbits(k * 2) + 1])
    for op in "+*":
        v = a + b if op == "+" else a * b
        if _bits(v) > result_bits(op, a, b):
            bad.append([op, str(a)[:40], str(b)[:40]])
# astra2's case: 512-bit denominators
a, b = Fraction(1, 2**512 - 1), Fraction(1, 2**511 + 1)
print(json.dumps({"bad": bad, "astra2": [_bits(a + b), result_bits("+", a, b)]}))
`);
  assert.deepEqual(got.bad, []);
  assert.ok(got.astra2[0] <= got.astra2[1], JSON.stringify(got.astra2));
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
  // (the ledger's sites are class 2, through the memory guard; the machine Real range's are coverage: arbitrary precision
  // is S2's, General::notyet until then, not a cap)
  for (const [k, v] of sites) {
    if (v.class === "coverage") assert.match(v.reason, /machine Real range/, k);
    else assert.deepEqual([v.class, v.disposition, v.explained], ["2", { 2: { route: "memguard" } }, true], k);
  }
});
