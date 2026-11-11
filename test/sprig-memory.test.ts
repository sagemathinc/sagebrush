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
from _sprig import mem, base
from _sprig.eval import Session
from _sprig.parse import parse
from _sprig.expr import Expr, Sym
mem.SMALL_BYTES = 0
out = {}
def _drop():
    # (a statement's value evaluated here is the test's to drop)
    if "s" in globals():
        s.keep_value(0)
def probe(name, need, run):
    """run()'s peak, read from the ledger's own admissions (their high-water mark), which must cover need, the
    mechanism's own reservation; then run() under an allowance one byte short of the peak, and at it: (refused,
    admitted, covered)."""
    real, top = mem._admit, [0]
    def admit(n, what, nm):
        real(n, what, nm)
        top[0] = max(top[0], mem._open[0])
    mem._admit = admit
    mem._allowance = lambda: (1 << 50, None)
    try:
        run([])
    finally:
        mem._admit = real
        _drop()
    peak = top[0]
    res = []
    for extra in (-1, 0):
        mem._allowance = lambda: (peak + extra - mem.open_bytes(), None)
        err = []
        try:
            v = run(err)
            # (run() reports a refusal itself, as General::memory, and goes on)
            res.append(["refused", "".join(err).split(":")[0]] if any("::memory:" in t for t in err) else v)
        except mem.SprigMemoryError as e:
            res.append(["refused", e.sprig_name, e.need_bytes])
        _drop()
        res[-1] = [res[-1], mem.open_bytes(), err[:1]]
    out[name] = res + [[peak >= need, peak, need]]
# the parse: a program of n characters (a comment, so nothing is evaluated)
src = "(* " + "x" * 300 + " *)"
probe("parse", len(src) * mem.PARSE_BYTES_PER_CHAR, lambda err: _sprig.run(src, lambda t: None, err.append))
# the continuation stack's first chunk (the parse of "Head[1]" is held at the same time; its names are all Sprig's own,
# so none is charged to the session)
p = len("Head[1]") * mem.PARSE_BYTES_PER_CHAR
probe("konts", p + _sprig.eval.KONT_CHUNK * mem.KONT_BYTES, lambda err: _sprig.run("Head[1]", lambda t: None, err.append))
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
# (grader's A10) a product of two exact numbers, reserved before it is computed: its bound, the operands' bits + 1
p1, p2 = 3 ** 300000, 7 ** 200000
probe("times", chunk + mem.int_bytes(base.result_bits("*", p1, p2)), lambda err: _sprig.input_form(s.evaluate(Expr("Times", p1, p2)))[:3])
# a Listable call threaded over lists
probe("thread", chunk + 3 * 2 * mem.NODE_BYTES, lambda err: _sprig.input_form(s.evaluate(Expr("Plus", Expr("List", 1, 2, 3), 1))))
print(json.dumps(out))
`);
  for (const [name, [refused, admitted, covered]] of Object.entries(got) as [string, any[]][]) {
    assert.equal(covered[0], true, `${name}: its peak covers the mechanism's own reservation (${JSON.stringify(covered)})`);
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
s.recursion_limit = None   # ($RecursionLimit = Infinity: the memory guard is what bounds this)
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
own = KONT_CHUNK * mem.KONT_BYTES + base.format_bytes(args)
# (the peak, read from the ledger's own admissions: at least the stack's chunk and the line)
real, top = mem._admit, [0]
def admit(n, what, nm):
    real(n, what, nm)
    top[0] = max(top[0], mem._open[0])
mem._admit = admit
mem._allowance = lambda: (1 << 50, None)
s = Session(lambda t: None, lambda t: None)
s.evaluate(Expr("Print", *args))
s.close()
mem._admit = real
need = top[0]
r = {"need": need, "covered": need >= own, "small": mem.SMALL_BYTES, "per_digit_ok": base.format_bytes((big,)) >= len(str(big))}
for extra in (-1, 0):
    mem._allowance = lambda: (need + extra - mem.open_bytes(), None)
    out = []
    s = Session(out.append, out.append)
    try:
        s.evaluate(Expr("Print", *args))
        s.keep_value(0)
        r[str(extra)] = ["admitted", len("".join(out)), mem.open_bytes()]
    except mem.SprigMemoryError as e:
        r[str(extra)] = ["refused", e.sprig_name, len("".join(out)), mem.open_bytes()]
print(json.dumps(r))
`);
  assert.ok(got.need > got.small, "the line is past the small-operation size, so the figure is read");
  assert.ok(got.covered, "the peak covers the stack's chunk and the whole line");
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
def ev(e):
    # (the statement's value is the caller's: dropped here)
    v = s.evaluate(e)
    s.keep_value(0)
    return v
ev(Expr("Set", Sym("a"), val))
one = mem.open_bytes()
ev(Expr("Set", Sym("b"), Sym("a")))
r["alias"] = [one == D, mem.open_bytes() == 2 * D]
ev(Expr("Set", Sym("a"), 5))
r["replace"] = mem.open_bytes() == D + 2 * mem.NODE_BYTES
mem._allowance = lambda: (0, None)
big = Expr("List", *range(5000))
try:
    s.define(Sym("b"), big, "Set")
    r["refused"] = "admitted"
except mem.SprigMemoryError:
    held = mem.open_bytes()
    mem._allowance = lambda: (10**12, None)
    r["refused"] = [ev(Sym("b")) == val, held == D + 2 * mem.NODE_BYTES]
# Stop while the new value is computed: the old definition and its charge stay
mem._allowance = lambda: (10**12, None)
def stop(sess, e):
    raise KeyboardInterrupt
s.builtins = dict(s.builtins, StopNow=stop)
before = mem.open_bytes()
try:
    ev(Expr("Set", Sym("b"), Expr("StopNow")))
except KeyboardInterrupt:
    r["stop"] = [mem.open_bytes() == before, ev(Sym("b")) == val]
    r["stop"] = [r["stop"][1], r["stop"][0]]
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
s.keep_value(0)
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

// (ENGINE and SEC on #911 r3: with no memory figure, the fixed cap bounds everything open at once, at the shipped cap;
// a session's names are charged while it lives, a long name by its length; and a symbol's size counts its name)
test("§8.4, no memory figure: the fixed cap bounds the sum of what is open, at the shipped cap's boundary and +1", () => {
  const got = py(`
import json
from _sprig import mem, eval as E
from _sprig.eval import Session
from _sprig.expr import Expr, Sym, size_of
mem._allowance = lambda: (None, "no memory figure")
CAP = mem.UNMEASURED_OPERATION_BYTES
chunk = E.KONT_CHUNK * mem.KONT_BYTES
r = {"cap": CAP}
def try_(n):
    try:
        x = mem.reserve(n, "A test", "Test").acquire()
        x.release()
        return "ok"
    except mem.SprigMemoryError as e:
        return ["refused", e.fixed, e.unmeasured]
held = mem.reserve(CAP - 1000, "A test", "Test").acquire()
r["reservations"] = [try_(1000), try_(1001)]
held.release()
r["reservations"].append(mem.open_bytes())
# a deep evaluation's chunks against what is already open: one chunk (with the first of the evaluation's own holder)
# fits exactly, the second doesn't
held = mem.reserve(CAP - chunk - mem.HELD_CHUNK, "A test", "Test").acquire()
s = Session(lambda t: None, lambda t: None)
s.recursion_limit = None   # ($RecursionLimit = Infinity: the memory guard is what bounds this)
def deep(n):
    e = Sym("x")
    for _ in range(n):
        e = Expr("f", e)
    return e
try:
    s.evaluate(deep(10))
    s.keep_value(0)
    r["one"] = "ok"
except mem.SprigMemoryError:
    r["one"] = "refused"
try:
    s.evaluate(deep(E.KONT_CHUNK + 10))
    r["two"] = "ok"
except mem.SprigMemoryError:
    r["two"] = "refused"
held.release()
r["after"] = mem.open_bytes()
# retained definitions, each below the cap (a reduced cap, so the values stay small; two together are past
# SMALL_BYTES, so the shortcut doesn't apply): two fit exactly, a third doesn't
val = Expr("List", *range(2000))
D = (size_of(val) + 1) * mem.NODE_BYTES
for slack, key in ((0, "at"), (-1, "short")):
    mem.UNMEASURED_OPERATION_BYTES = 2 * D + slack
    s = Session(lambda t: None, lambda t: None)
    res = []
    for name in ("a", "b", "c"):
        try:
            s.define(Sym(name), val, "Set")
            res.append("ok")
        except mem.SprigMemoryError:
            res.append("refused")
    held2 = mem.open_bytes()
    s.close()
    r[key] = [res, held2 == 2 * D if key == "at" else held2 == D, mem.open_bytes()]
print(json.dumps(r))
`);
  assert.equal(got.cap, 268435456);
  assert.deepEqual(got.reservations, ["ok", ["refused", true, "no memory figure"], 0], "the shipped cap's boundary, and one byte past it");
  assert.deepEqual([got.one, got.two, got.after], ["ok", "refused", 0], "the stack's second chunk is refused at the cap");
  assert.deepEqual(got.at, [["ok", "ok", "refused"], true, 0]);
  assert.deepEqual(got.short, [["ok", "refused", "refused"], true, 0]);
});

test("§8.4: a session's names are charged while it lives (a long one by its length), a refused name is never made, and Print sizes a symbol by its name", () => {
  const got = py(`
import json, _sprig
from _sprig import mem, base
from _sprig.eval import Session
from _sprig.expr import Expr, Sym, size_of
mem._allowance = lambda: (10**12, None)
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
names = ["n%d_%s" % (i, "q" * 500) for i in range(300)]
for n in names:
    Sym(n)
want = sum(mem.SYM_BYTES + mem.SYM_BYTES_PER_CHAR * len(n) for n in names)
r = {"charged": [s.name_bytes == want, mem.open_bytes() >= want]}
# names left by a finished ToExpression stay charged
before = s.name_bytes
s.evaluate(Expr("ToExpression", "brandnew1 + brandnew2"))
r["toexpression"] = s.name_bytes - before == 2 * mem.SYM_BYTES + mem.SYM_BYTES_PER_CHAR * 18
# a refusal: enough is open that the figure is read, and it says nothing is left
full = mem.reserve(mem.SMALL_BYTES, "A test", "Test").acquire()
mem._allowance = lambda: (0, None)
try:
    Sym("never_made_" + "z" * (mem.NAME_CHUNK))
    r["refused"] = "made"
except mem.SprigMemoryError:
    r["refused"] = ["refused", ("never_made_" + "z" * mem.NAME_CHUNK) in s.symbols]
full.release()
mem._allowance = lambda: (10**12, None)
s.close()
Session.restore(prev)
r["after"] = mem.open_bytes()
long = Sym("w" * 1028)
r["width"] = [size_of(long) >= 1028 // 16, base.format_bytes((long,)) >= 1028]
print(json.dumps(r))
`);
  assert.deepEqual(got, { charged: [true, true], toexpression: true, refused: ["refused", false], after: 0, width: [true, true] });
});

test("every head Sprig writes itself is one of its own names, shared and never charged to a session", () => {
  const got = py(`
import json, os, re, _sprig
from _sprig.expr import Sym
d = os.path.dirname(_sprig.__file__)
src = "".join(re.sub(r'"""[\\s\\S]*?"""', "", open(os.path.join(d, f)).read()) for f in os.listdir(d) if f.endswith(".py"))
names = set(re.findall(r'(?:Expr|Sym)\\("([A-Za-z$\\x60]+)"', src))
print(json.dumps({"names": len(names), "missing": sorted(n for n in names if n not in Sym._table)}))
`);
  assert.ok(got.names > 20, `the scan finds the heads (${got.names})`);
  assert.deepEqual(got.missing, []);
});

// (the grader's rows on #911 r4: a long name's own-size charge, the charge handed back with the session, the unmeasured
// refusal's stated figure, and the refusals' singular and plural subjects)
test("§8.4: a name longer than one chunk is charged at its own size, and restore takes the session's charge away", () => {
  const got = py(`
import json
from _sprig import mem
from _sprig.eval import Session
from _sprig.expr import Sym
mem._allowance = lambda: (10**12, None)
r = {"chunk": mem.NAME_CHUNK, "sym": mem.SYM_BYTES, "per": mem.SYM_BYTES_PER_CHAR}
a = Session(lambda t: None, lambda t: None)
before_charge = Sym._charge
prev = a.activate()
Sym("short_name")
reserved0, bytes0 = a.name_reserved, a.name_bytes
Sym("L" * 40000)
r["long"] = [a.name_reserved - reserved0, a.name_bytes - bytes0]
Session.restore(prev)
r["restored"] = Sym._charge is before_charge
bytes1 = a.name_bytes
Sym("made_outside_any_session")
b = Session(lambda t: None, lambda t: None)
prevb = b.activate()
Sym("made_in_session_b")
Session.restore(prevb)
r["after"] = [a.name_bytes == bytes1, b.name_bytes == mem.SYM_BYTES + mem.SYM_BYTES_PER_CHAR * len("made_in_session_b"), Sym._charge is before_charge]
a.close(); b.close()
r["open"] = mem.open_bytes()
print(json.dumps(r))
`);
  const own = got.sym + got.per * 40000;
  assert.ok(own > got.chunk, `the name is longer than a chunk (${own} > ${got.chunk})`);
  assert.deepEqual(got.long, [own, own], "charged and reserved at its own size, not one chunk");
  assert.equal(got.restored, true, "restore puts back the charge that was there before activate");
  assert.deepEqual(got.after, [true, true, true], "a name made after restore, outside any session or in another one, isn't charged to the first");
  assert.equal(got.open, 0);
});

test("§8.4, no memory figure: a refusal states what is left under the cap, not the whole cap", () => {
  const got = py(`
import json
from _sprig import mem
from _sprig.eval import Session
from _sprig.expr import Expr, Sym, size_of
mem._allowance = lambda: (None, "no memory figure")
CAP = mem.UNMEASURED_OPERATION_BYTES
s = Session(lambda t: None, lambda t: None)
held = mem.reserve(CAP - 3 * 10**6, "A test", "Test").acquire()
val = Expr("List", *range(2000))
X = mem.open_bytes()
try:
    s.define(Sym("a"), val, "Set")
    s.define(Sym("b"), Expr("List", *range(20000)), "Set")
    r = "admitted"
except mem.SprigMemoryError as e:
    r = [e.limit_bytes, CAP - mem.open_bytes(), e.need_bytes, str(e).split("\\n")[1]]
s.close(); held.release()
print(json.dumps({"cap": CAP, "r": r, "open": mem.open_bytes()}))
`);
  const [limit, left, need, line] = got.r;
  assert.equal(got.cap, 268435456);
  assert.equal(limit, left, "the refusal's figure is what is left under the cap, with the retained definitions counted");
  assert.ok(limit < got.cap && need > limit, `${limit} < ${got.cap}, ${need} > ${limit}`);
  assert.doesNotMatch(line, /268 MB/, "the whole cap isn't the figure");
  assert.equal(got.open, 0);
});

test("the refusals' subjects count their nouns: one item and one character in the singular", () => {
  const got = py(`
import json
from _sprig import mem
from _sprig.eval import Session
from _sprig.expr import Expr, Sym
mem.SMALL_BYTES = 0
mem._allowance = lambda: (0, None)
def what(f):
    try:
        f()
        return "admitted"
    except mem.SprigMemoryError as e:
        return e.what
s = Session(lambda t: None, lambda t: None)
mem._allowance = lambda: (mem.open_bytes() and 0, None)
r = {}
# Print, past its continuation chunk: the allowance is the chunk alone, so Print's own reservation is refused
from _sprig import eval as E
chunk = E.KONT_CHUNK * mem.KONT_BYTES
# (and the evaluation's first chunk of its own holder, which the call's argument list takes)
mem._allowance = lambda: (chunk + mem.HELD_CHUNK - mem.open_bytes(), None)
r["print1"] = what(lambda: s.evaluate(Expr("Print", Sym("x"))))
r["print2"] = what(lambda: s.evaluate(Expr("Print", Sym("x"), Sym("y"))))
# a session's name: nothing is left
mem._allowance = lambda: (0, None)
prev = s.activate()
r["name1"] = what(lambda: Sym("q"))
r["name12"] = what(lambda: Sym("qwertyuiopas"))
Session.restore(prev)
s.close()
print(json.dumps(r))
`);
  assert.deepEqual(got, { print1: "Formatting 1 item", print2: "Formatting 2 items", name1: "A name of 1 character", name12: "A name of 12 characters" });
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
  // is S2's, General::notyet until then, not a cap; the language's own limits, S1.2's, are class 3 with the language
  // disposition, never host authority and never none (design §5.2); a site that refuses nothing is none, with its reason)
  for (const [k, v] of sites) {
    if (v.class === "coverage") assert.match(v.reason, /machine Real range/, k);
    else if (v.class === "3") assert.deepEqual(v.disposition, { 3: { language: "sprig" } }, k);
    else if (v.class === "none") assert.match(v.reason, /refuses nothing/, k);
    else assert.deepEqual([v.class, v.disposition, v.explained], ["2", { 2: { route: "memguard" } }, true], k);
  }
  // (the three language limits' checks are all registered as class 3)
  for (const needle of ['self._limit("$RecursionLimit", "reclim", rl)', 'self._limit("$IterationLimit", "itlim", il)', "while limit is None or passes < limit:"])
    assert.ok(sites.some(([k, v]) => k.includes(needle) && v.class === "3"), needle);
});
