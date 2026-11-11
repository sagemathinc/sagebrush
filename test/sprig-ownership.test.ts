import test from "node:test";
import assert from "node:assert/strict";
import { LEDGER_PY, py } from "./sprig-helpers";

// Sprig's ownership of what it retains (design/sprig-mvp.md §8.4, lib/_sprig/mem.py's Held): each holder charged
// before it grows, at the boundary and one byte past it under the shipped SMALL_BYTES, measured and with no memory
// figure; the aggregates (completed siblings, a rewrite's old and new values, a definition retired while a reader has
// it); every hand-off covered; and the ledger back where it started after a refusal or a Stop.  Each boundary is found
// through the ledger itself (LEDGER_PY's boundary), and checked against a lower bound from the structure it holds.

const K = 3000;

test("§8.4: each holder at its boundary and one byte short, measured and unmeasured, the ledger back after", () => {
  const got = py(`${LEDGER_PY}
K = ${K}
NB, BIND, GOAL = mem.NODE_BYTES, mem.BIND_BYTES, mem.GOAL_BYTES
cases = {
    # (a fresh name, then an alternative, n times: each choice point copies the bindings so far, so
    # the copies hold n(n+1)/2 bindings while the condition at the end is evaluated)
    "wide": ("n = 150; MatchQ[f @@ Table1, f[" + ", ".join("x%d_, _ | _" % i for i in range(150)) + "] /; True]",
             150 * 151 // 2 * BIND),
    # a sequence pattern's tests, one goal per element of each length tried
    "tests": ("MatchQ[Range[%d], {x__?IntegerQ, y_ /; y < 0}]" % 400, 400 * GOAL),
    # a substitution's result: four copies of the argument
    "subst": ("g[x_] := {x, x, x, x}; Length[g[Range[%d]]]" % K, 4 * K * NB),
    # a replacement's result: each element replaced by a list of two
    "replace": ("Length[Range[%d] /. n_Integer :> {n, n}]" % K, 3 * K * NB),
    # completed siblings held together until their list is made
    "siblings": ("Length[{Range[%d], Range[%d], Range[%d]}]" % (K, K, K), 3 * K * NB),
    # ReplaceRepeated: the value, its replacement and the replacement evaluated, at once
    "repeated": ("Length[r[Range[%d]] //. r[l_] :> s[l, l]]" % K, 3 * K * NB),
    # Nest: the next value held before the previous is given back
    "nest": ("Length[Nest[w, Range[%d], 2]]" % K, 2 * K * NB),
}
out = {}
for name, (src, floor) in cases.items():
    src = src.replace("f @@ Table1", "f[" + ", ".join(["1"] * 300) + "]")
    run = program(src)
    for unmeasured in (False, True):
        A, short, ok = boundary(run, unmeasured)
        out[name + ("-unmeasured" if unmeasured else "")] = [A - mem.SMALL_BYTES >= floor, short, ok[0], ok[2], A - mem.SMALL_BYTES, floor]
print(json.dumps(out))
`);
  for (const [k, [covers, short, ok, left, a, floor]] of Object.entries(got) as [string, any[]][]) {
    assert.equal(covers, true, `${k}: the boundary (${a}) covers what it holds (${floor})`);
    assert.equal(short[0], "refused", `${k}: refused one byte short (${JSON.stringify(short)})`);
    assert.equal(short[2], 0, `${k}: the refusal gave back everything`);
    assert.equal(ok, "ok", `${k}: admitted at the boundary`);
    assert.equal(left, 0, `${k}: given back after`);
    assert.ok(typeof short[1] === "string" && short[1].length > 0, `${k}: the refusal names an operation (${short[1]})`);
  }
});

test("§8.4: what is held at a condition, a test or a call is charged while it is held", () => {
  const got = py(`${LEDGER_PY}
K = ${K}
NB, BIND, GOAL, SLOT = mem.NODE_BYTES, mem.BIND_BYTES, mem.GOAL_BYTES, mem.SLOT_BYTES
r = {}
def held(name, src):
    probe(name, Sym("True"))
    base0 = mem.open_bytes()
    program(src)()
    r[name] = [max(seen[name]) - base0 if seen[name] else None, mem.open_bytes() - base0]
# the wide pattern at its condition: the bindings' copies, n(n+1)/2
n = 150
held("Wide", "MatchQ[f[" + ", ".join(["1"] * (2 * n)) + "], f[" + ", ".join("x%d_, _ | _" % i for i in range(n)) + "] /; Wide[]]")
# completed siblings, and a symbol's value read before its definition is cleared
held("Siblings", "{Range[%d], Range[%d], Siblings[]}" % (K, K))
held("Read", "x = Range[%d]; {x, Clear[x]; Read[]}" % K)
# a definition cleared inside its own condition: still charged while its reader has it, given back after
held("Retired", "f[n_ /; (Clear[f]; Retired[])] = Range[%d]; f[1]" % K)
# the statement's value, through its formatting; given back once the next statement replaces it
fmt = []
real = _sprig._formatted
def formatted(value, how):
    fmt.append(mem.open_bytes())
    return real(value, how)
_sprig._formatted = formatted
base0 = mem.open_bytes()
_sprig.run_cases([("c", "Range[%d]" % K)])
_sprig._formatted = real
r["format"] = [min(fmt) - base0, mem.open_bytes() - base0]
held("Next", "Range[%d]\\nNext[]" % K)
# the bindings handed to the caller: charged when the substitution begins
subs = []
from _sprig import pattern
real_sub = pattern.substitute
def sub(e, b, into):
    subs.append([mem.open_bytes(), len(b)])
    return real_sub(e, b, into)
pattern.substitute = sub
base0 = mem.open_bytes()
program("h[a_, b_, c_] := {a, b, c}; h[1, 2, 3]")()
pattern.substitute = real_sub
r["bindings"] = [subs[0][0] - base0 >= 3 * BIND, subs[0][1], mem.open_bytes() - base0]
r["units"] = {"K": K, "NB": NB, "BIND": BIND, "n": n}
print(json.dumps(r))
`);
  const { K: k, NB, BIND, n } = got.units;
  assert.ok(got.Wide[0] >= (n * (n + 1) / 2) * BIND, `the wide pattern's copies are charged at its condition (${got.Wide[0]})`);
  assert.ok(got.Siblings[0] >= 2 * k * NB, `completed siblings are charged together (${got.Siblings[0]})`);
  assert.ok(got.Read[0] >= k * NB, `a value read stays charged after its definition is cleared (${got.Read[0]})`);
  assert.ok(got.Retired[0] >= k * NB, `a definition cleared by its own condition stays charged while its reader has it (${got.Retired[0]})`);
  assert.ok(got.format[0] >= k * NB, `the statement's value is charged through its formatting (${got.format[0]})`);
  assert.ok(got.Next[0] < k * NB, `the previous statement's value is given back once replaced (${got.Next[0]})`);
  assert.deepEqual(got.bindings, [true, 3, 0], "the bindings are charged when handed to the substitution");
  for (const key of ["Wide", "Siblings", "Read", "Retired", "Next"]) assert.equal(got[key][1], 0, `${key}: the ledger is back where it started`);
  assert.equal(got.format[1], 0);
});

test("§8.4: a definition's publication copy, the retired definition's pins, and Stop or a refusal inside a condition", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Definition
r = {}
# the (m+1)th definition: its copy of the table reserved before it is made
m = 200
src = "".join("f[%d] = %d;\\n" % (i, i) for i in range(m))
A, short, ok = boundary(program(src + "f[%d] = 0" % m))
r["copy"] = [short[0], short[1], ok[0], short[2], ok[2]]
# a reader's pins: Clear inside the condition retires every definition; each is given back when the reader ends, once
def stop(sess, e):
    raise KeyboardInterrupt
base.BUILTINS["StopHere"] = stop
base0 = mem.open_bytes()
try:
    program("f[n_ /; (Clear[f]; StopHere[])] = Range[3000]; f[1]")()
    r["stop"] = "swallowed"
except KeyboardInterrupt:
    r["stop"] = [mem.open_bytes() - base0, mem.made.used, mem.received.used]
# a refusal inside a condition: the match, its pins and the condition's charges given back
A, short, ok = boundary(program("g[n_ /; Length[Range[20000]] > 0] = 1; g[1]"))
r["refusal"] = [short[0], short[2], ok[0], ok[2]]
print(json.dumps(r))
`);
  assert.deepEqual(got.copy.slice(0, 1), ["refused"], JSON.stringify(got.copy));
  assert.deepEqual([got.copy[2], got.copy[3], got.copy[4]], ["ok", 0, 0], "admitted at the boundary; the refusal gave back everything");
  assert.deepEqual(got.stop, [0, 0, 0], "Stop inside the condition: the ledger and the hand-offs back where they started");
  assert.deepEqual(got.refusal, ["refused", 0, "ok", 0]);
});

test("§8.4: a Stop during the clean-up itself still closes every suspended generator, and goes on", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
closed = []
def outer(sess, e):
    h = mem.Held("A test", "Outer")
    h.grow(1000)
    try:
        yield ("eval", Expr("Inner"))
    finally:
        h.release()
        closed.append("outer")
def inner(sess, e):
    try:
        yield ("eval", Expr("StopHere"))
    finally:
        closed.append("inner")
        raise KeyboardInterrupt
def stop(sess, e):
    raise KeyboardInterrupt
s = Session(lambda t: None, lambda t: None)
s.builtins = dict(s.builtins, Outer=outer, Inner=inner, StopHere=stop)
base0 = mem.open_bytes()
try:
    s.evaluate(Expr("Outer"))
    r = "swallowed"
except KeyboardInterrupt:
    r = [closed, mem.open_bytes() - base0, mem.made.used, mem.received.used]
s.close()
print(json.dumps(r))
`);
  assert.deepEqual(got, [["inner", "outer"], 0, 0, 0]);
});

test("§8.4: a Stop partway through a reader's pins unpins exactly those pinned; retired definitions are then given back", () => {
  const got = py(`${LEDGER_PY}
from _sprig import eval as E
from _sprig.eval import Session, _Pins
import _sprig.parse as P
class StopAfter(tuple):
    """The definitions' tuple, with a Stop as the second is reached (the pins' loop, partway)."""
    def __iter__(self):
        for i, d in enumerate(tuple.__iter__(self)):
            if i == 1:
                raise KeyboardInterrupt
            yield d
r = {}
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
base0 = mem.open_bytes()
for st in P.parse("f[1] = Range[500]; f[2] = Range[500]; f[n_] := n"):
    s.evaluate(st)
    s.keep_value(0)
f = Sym("f")
# directly: two of three pinned when the Stop comes? one: the Stop comes before the second
p = _Pins(StopAfter(s.down[f]))
try:
    p.pin()
    r["direct"] = "no stop"
except KeyboardInterrupt:
    pinned = [d.pins for d in s.down[f]]
    p.unpin()
    r["direct"] = [pinned, [d.pins for d in s.down[f]]]
# through an evaluation: the reader's pins made through StopAfter, at a condition's first suspension
real = E._Pins
class Partial(real):
    def __init__(self, rules):
        real.__init__(self, StopAfter(rules))
E._Pins = Partial
try:
    for st in P.parse("g[1] = Range[500]; g[2] = Range[500]; g[n_ /; True] := n"):
        s.evaluate(st)
        s.keep_value(0)
    s.evaluate(P.parse("g[3]")[0])
    r["evaluate"] = "no stop"
except KeyboardInterrupt:
    r["evaluate"] = [d.pins for d in s.down[Sym("g")]]
E._Pins = real
for st in P.parse("Clear[f, g]"):
    s.evaluate(st)
    s.keep_value(0)
r["cleared"] = mem.open_bytes() - base0 - s.name_reserved
s.close()
Session.restore(prev)
r["closed"] = mem.open_bytes() - base0
print(json.dumps(r))
`);
  assert.deepEqual(got.direct, [[1, 0, 0], [0, 0, 0]], "one pinned when the Stop came, none after unpin");
  assert.deepEqual(got.evaluate, [0, 0, 0], "the evaluation's clean-up unpinned what its reader had pinned");
  assert.equal(got.cleared, 0, "Clear gives back every retired definition");
  assert.equal(got.closed, 0);
});

test("§8.4: a statement's value is charged through its formatting even when it is an atom or a part of the program", () => {
  const got = py(`${LEDGER_PY}
fmt = []
real = _sprig._formatted
def formatted(value, how):
    fmt.append([mem.open_bytes(), size_of(value)])
    return real(value, how)
_sprig._formatted = formatted
r = {}
for name, src in (("literal", "1*^3000"), ("held", "Hold[{" + ", ".join(["x"] * 3000) + "}]"), ("symbol", "x")):
    del fmt[:]
    base0 = mem.open_bytes()
    _sprig.run_cases([("c", src)])
    r[name] = [min(o - base0 >= n * mem.NODE_BYTES for o, n in fmt), mem.open_bytes() - base0]
_sprig._formatted = real
# a direct evaluate of an atom built outside any parse: charged until the caller drops it
s = Session(lambda t: None, lambda t: None)
base0 = mem.open_bytes()
v = s.evaluate(10 ** 30000)
held = mem.open_bytes() - base0
s.keep_value(0)
r["direct"] = [held >= size_of(v) * mem.NODE_BYTES, mem.open_bytes() - base0]
s.close()
# the literal's charge at its boundary and one byte short, as General::memory, the ledger back after
def case():
    res = _sprig.run_cases([("c", "1*^30000")])[0]
    if "::memory:" in res["output"]:
        raise Refused(res["output"].split("::")[0])
    return res["result"][:3]
A, short, ok = boundary(case)
r["boundary"] = [short[0], short[2], ok[0], ok[1], ok[2]]
print(json.dumps(r))
`);
  assert.deepEqual(got.literal, [true, 0], "a literal integer");
  assert.deepEqual(got.held, [true, 0], "a held part of the program");
  assert.deepEqual(got.symbol, [true, 0], "a symbol with no value");
  assert.deepEqual(got.direct, [true, 0], "an atom given to evaluate directly, until keep_value drops it");
  assert.deepEqual(got.boundary, ["refused", 0, "ok", "100", 0], "refused one byte short, giving everything back; admitted at the boundary");
});

test("§8.4: Unset's copies, a single-length sequence, retained direct results, and Stop while a value is formatted", () => {
  const got = py(`${LEDGER_PY}
import _sprig.parse as P
from _sprig.expr import same
r = {}
# Unset of one of 2000 definitions: the removed and kept copies of the table, reserved first
m = 2000
us = Session(lambda t: None, lambda t: None)
uprev = us.activate()
for st in P.parse("".join("f[%d] = %d;\\n" % (i, i) for i in range(m))):
    us.evaluate(st)
    us.keep_value(0)
unset = P.parse("f[5] =.")[0]
def unset_once():
    # (f[5] removed under the allowance being tried, then defined again with no limit, so that each run starts alike)
    try:
        v = us.evaluate(unset)
        us.keep_value(0)
        return str(v)
    finally:
        if not any(same(d.lhs, Expr("f", 5)) for d in us.down[Sym("f")]):
            lim = mem._allowance
            mem._allowance = lambda: (1 << 50, None)
            us.define_down(Sym("f"), Expr("f", 5), 5, "Set")
            mem._allowance = lim
A, short, ok = boundary(unset_once)
r["unset"] = [short[0], short[1], short[2], ok[0], ok[2]]
us.close()
Session.restore(uprev)
# a sequence with one length to try: its options object reserved before it is made
A, short, ok = boundary(program("MatchQ[{1}, {x__}]"))
r["single"] = [short[0], short[2], ok[0], ok[1], ok[2]]
# direct results kept until keep_value: each charged its value and its place in the list; past the
# allowance, the next is refused and the ones before stay charged
s = Session(lambda t: None, lambda t: None)
base0 = mem.open_bytes()
for i in range(1000):
    s.evaluate(Expr("List", i, i))
many = mem.open_bytes() - base0
mem._allowance = lambda: (0, None)
mem.SMALL_BYTES, small = 0, mem.SMALL_BYTES
try:
    s.evaluate(Expr("List", 1, 2))
    r["refused"] = "admitted"
except mem.SprigMemoryError as e:
    r["refused"] = [e.sprig_name, mem.open_bytes() - base0 == many]
mem.SMALL_BYTES = small
mem._allowance = lambda: (1 << 50, None)
s.keep_value(0)
r["many"] = [many >= 1000 * (3 * mem.NODE_BYTES + mem.SLOT_BYTES), len(s.value_charges), mem.open_bytes() - base0]
s.close()
# Stop while the statement's value is formatted: the session's end gives its charge back
real = _sprig._formatted
def stop(value, how):
    raise KeyboardInterrupt
_sprig._formatted = stop
base0 = mem.open_bytes()
try:
    _sprig.run_cases([("c", "Range[3000]")])
    r["stop"] = "swallowed"
except KeyboardInterrupt:
    r["stop"] = mem.open_bytes() - base0
_sprig._formatted = real
print(json.dumps(r))
`);
  assert.deepEqual(got.unset, ["refused", "Unset", 0, "ok", 0], "Unset's copies: the peak's last admission, refused one byte short, admitted at the boundary, given back");
  assert.deepEqual(got.single, ["refused", 0, "ok", "True\n", 0]);
  assert.deepEqual(got.refused, ["Evaluation", true], "past the allowance the next result is refused; the kept ones stay charged");
  assert.deepEqual(got.many, [true, 0, 0], "1000 kept results charged together, all given back by keep_value");
  assert.equal(got.stop, 0, "Stop while formatting: the value's charge given back");
});

test("§8.4: a Stop at any step of pinning or unpinning leaves no pin and no charge behind", () => {
  const got = py(`${LEDGER_PY}
from _sprig import eval as E
from _sprig.eval import Session, Definition
import _sprig.parse as P
class Faulty(Definition):
    """A definition whose pins raise a Stop once, at the set's chosen call, before or after the change is stored."""
    __slots__ = ("_p",)
    plan = {}
    @property
    def pins(self):
        return self._p
    @pins.setter
    def pins(self, v):
        n = Faulty.plan.get("n", 0) + 1
        Faulty.plan["n"] = n
        if n == Faulty.plan.get("at") and Faulty.plan["when"] == "before":
            raise KeyboardInterrupt
        self._p = v
        if n == Faulty.plan.get("at") and Faulty.plan["when"] == "after":
            raise KeyboardInterrupt
real = E.Definition
r = {}
# (pins' sets, in order: 0 the constructor's; then pin: 1, 2, 3 for the three definitions; then unpin: 4, 5, 6)
for at in (2, 3, 5, 6):
    for when in ("before", "after"):
        E.Definition = Faulty
        Faulty.plan = {}
        s = Session(lambda t: None, lambda t: None)
        prev = s.activate()
        base0 = mem.open_bytes()
        for st in P.parse("f[1] = Range[300]; f[2] = Range[300]; f[n_ /; (Clear[f]; True)] := n"):
            s.evaluate(st)
            s.keep_value(0)
        n0 = Faulty.plan.get("n", 0)
        Faulty.plan.update({"n": 0, "at": at, "when": when})
        try:
            s.evaluate(P.parse("f[3]")[0])
            s.keep_value(0)
            stopped = False
        except KeyboardInterrupt:
            stopped = True
        Faulty.plan["at"] = None
        # (a Stop while pinning comes before the condition's Clear: the definitions are still published, unpinned; a
        # Stop while unpinning comes after it: they are retired, and must all be given back now)
        defs = s.down.get(Sym("f"), ())
        left = mem.open_bytes() - base0 - s.name_reserved
        s.close()
        Session.restore(prev)
        E.Definition = real
        r["%d-%s" % (at, when)] = [stopped, [d.pins for d in defs], len(defs), left if not defs else 0, mem.open_bytes() - base0]
print(json.dumps(r))
`);
  for (const [k, [stopped, pins, published, left, closed]] of Object.entries(got) as [string, any[]][]) {
    assert.equal(stopped, true, `${k}: the Stop propagated`);
    assert.ok(pins.every((p: number) => p === 0), `${k}: no pin left (${pins})`);
    assert.equal(published, k.startsWith("2") || k.startsWith("3") ? 3 : 0, `${k}: published before the Clear, retired after it`);
    assert.equal(left, 0, `${k}: every retired definition given back before the session ends (${left})`);
    assert.equal(closed, 0, `${k}: the ledger back where it started`);
  }
});

test("§8.4: a program's expanded exact numbers are charged from the parse until the program ends", () => {
  const got = py(`${LEDGER_PY}
probe("Here")
src = "{" + ", ".join(["1*^30000"] * 4) + ", Here[]}"
base0 = mem.open_bytes()
program(src)()
lit = 10 ** 30000
r = {"siblings": [seen["Here"][0] - base0 >= 4 * lit.bit_length() * 3, mem.open_bytes() - base0]}
# at their boundary: the parse's own admission of a later literal refused one byte short, given back
A, short, ok = boundary(program("{" + ", ".join(["1*^30000"] * 4) + "} // Length"))
r["boundary"] = [short[0], short[2], ok[0], ok[2]]
# ToExpression's statements: charged while they run
src = 'ToExpression["{1*^30000, 1*^30000, Here[]}"]'
del seen["Here"][:]
base0 = mem.open_bytes()
program(src)()
r["toexpression"] = [seen["Here"][0] - base0 >= 2 * lit.bit_length() * 3, mem.open_bytes() - base0]
print(json.dumps(r))
`);
  assert.deepEqual(got.siblings, [true, 0], "four expanded literals charged together while the statement runs");
  assert.deepEqual(got.boundary, ["refused", 0, "ok", 0]);
  assert.deepEqual(got.toexpression, [true, 0]);
});

test("§8.4: a Stop at a clean-up loop's own checkpoint, between steps, still finishes the rest: unpin, the release lists, the generators", () => {
  const got = py(`${LEDGER_PY}
from _sprig import eval as E
from _sprig.eval import Session, Definition, _drain, _close_all
import _sprig.parse as P
r = {}
class Reads(Definition):
    """A definition whose pins, read for the n-th time while the plan is on, raise a Stop (a loop's setup)."""
    plan = {}
    def __getattribute__(self, name):
        if name == "pins" and Reads.plan.get("on"):
            Reads.plan["n"] += 1
            if Reads.plan["n"] == Reads.plan["at"]:
                raise KeyboardInterrupt
        return object.__getattribute__(self, name)
real = E.Definition
res = []
for at in range(1, 13):
    E.Definition = Reads
    s = Session(lambda t: None, lambda t: None)
    prev = s.activate()
    base0 = mem.open_bytes()
    for st in P.parse("f[1] = Range[300]; f[2] = Range[300]; f[n_ /; (Clear[f]; True)] := n"):
        s.evaluate(st)
        s.keep_value(0)
    Reads.plan = {"on": True, "n": 0, "at": at}
    try:
        s.evaluate(P.parse("f[3]")[0])
        s.keep_value(0)
        stopped = False
    except KeyboardInterrupt:
        stopped = True
    Reads.plan = {}
    defs = s.down.get(Sym("f"), ())
    left = mem.open_bytes() - base0 - s.name_reserved
    s.close()
    Session.restore(prev)
    E.Definition = real
    res.append([at, stopped, [object.__getattribute__(d, "pins") for d in defs], left if not defs else 0, mem.open_bytes() - base0])
r["unpin"] = res
class Once(list):
    """A list whose length, asked for the n-th time, raises a Stop (the loop's checkpoint)."""
    def __init__(self, items, at):
        list.__init__(self, items)
        self.n, self.at = 0, at
    def __len__(self):
        self.n += 1
        if self.n == self.at:
            raise KeyboardInterrupt
        return list.__len__(self)
    def __bool__(self):
        return len(self) > 0
out = []
for at in (1, 2, 3, 4):
    base0 = mem.open_bytes()
    rs = Once([mem.reserve(100, "A test", "Test").acquire() for _ in range(3)], at)
    try:
        _drain(rs, 0)
    except KeyboardInterrupt:
        pass
    out.append([list.__len__(rs), mem.open_bytes() - base0])
r["drain"] = out
class G:
    closed = []
    def __init__(self, i):
        self.i = i
    def close(self):
        G.closed.append(self.i)
out = []
for at in (1, 2, 3, 4):
    G.closed = []
    ks = Once([("gen", G(i), None, 0) for i in range(3)], at)
    try:
        _close_all(ks)
    except KeyboardInterrupt:
        pass
    out.append([list.__len__(ks), sorted(set(G.closed))])
r["close"] = out
print(json.dumps(r))
`);
  for (const [at, stopped, pins, left, closed] of got.unpin) {
    assert.ok(pins.every((p: number) => p === 0), `read ${at}: no pin left (${pins}, stopped ${stopped})`);
    assert.equal(left, 0, `read ${at}: the retired definitions given back`);
    assert.equal(closed, 0, `read ${at}: the ledger back where it started`);
  }
  assert.ok(got.unpin.some((u: any[]) => u[1]), "some reads were the loops' own");
  for (const [n, left] of got.drain) assert.deepEqual([n, left], [0, 0], "every reservation released and popped");
  for (const [n, closed] of got.close) assert.deepEqual([n, closed], [0, [0, 1, 2]], "every generator closed and popped");
});

test("§8.4: the session's end drains its tables in place: a Stop at any entry still gives back every one", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
import _sprig.parse as P
class Stopping(mem.Reservation):
    """A reservation whose first release raises a Stop before giving anything back."""
    def release(self):
        if not getattr(self, "stopped", False):
            self.stopped = True
            raise KeyboardInterrupt
        mem.Reservation.release(self)
res = []
for table in ("own", "down"):
    for pos in range(3):
        base0 = mem.open_bytes()
        s = Session(lambda t: None, lambda t: None)
        prev = s.activate()
        for st in P.parse("a = Range[100]; b = Range[100]; c = Range[100]; f[1] = Range[100]; g[1] = Range[100]; h[1] = Range[100]"):
            s.evaluate(st)
            s.keep_value(0)
        # (one entry's reservation swapped for a Stopping one of the same size, already held)
        if table == "own":
            k = list(s.own)[pos]
            v, r = s.own[k]
            x = Stopping(r.nbytes, "A test", "Test")
            x.held = True
            r.held = False
            s.own[k] = (v, x)
        else:
            k = list(s.down)[pos]
            d = s.down[k][0]
            x = Stopping(d.r.nbytes, "A test", "Test")
            x.held = True
            d.r.held = False
            d.r = x
        try:
            s.close()
            stopped = False
        except KeyboardInterrupt:
            stopped = True
        Session.restore(prev)
        res.append([table, pos, stopped, len(s.own), len(s.down), mem.open_bytes() - base0])
print(json.dumps(res))
`);
  for (const [table, pos, stopped, own, down, left] of got) {
    assert.equal(stopped, true, `${table} ${pos}: the Stop went on`);
    assert.deepEqual([own, down, left], [0, 0, 0], `${table} ${pos}: every entry given back and removed`);
  }
});

// (each site's own charge, seen exactly: every request a site makes is logged (a holder's growth,
// a reservation's acquiring), so each site's bytes show whatever a holder already had in reserve; a holder's release
// shows what it still covered; a retired definition's reservation shows whether it is still held.)
test("§8.4: each site's own charge, exactly: pins, copies, the matcher's choice points, goals and bindings", () => {
  const got = py(`${LEDGER_PY}
import _sprig.parse as P
from _sprig import eval as E, pattern as PT
from _sprig.eval import Session
from _sprig.expr import size_of
mem.HELD_CHUNK = 0
SLOT, BIND, GOAL, KB, NB = mem.SLOT_BYTES, mem.BIND_BYTES, mem.GOAL_BYTES, mem.KONT_BYTES, mem.NODE_BYTES
log = []
# (every request a site makes: a holder's growth, whether or not its reservation already covers it, and a
# reservation's acquiring)
real_grow = mem.Held.grow
def grow(self, n, what=None):
    log.append([mem._subject(what or self.what), n, self.name])
    real_grow(self, n, what)
mem.Held.grow = grow
real_acquire = mem.Reservation.acquire
def acquire(self):
    log.append([mem._subject(self.what), self.nbytes, self.name])
    return real_acquire(self)
mem.Reservation.acquire = acquire
released = []
real_release = mem.Held.release
def release(self):
    released.append([self.name, self.used])
    real_release(self)
mem.Held.release = release
def session():
    s = Session(lambda t: None, lambda t: None)
    return s, s.activate()
def ev(s, src):
    v = None
    for st in P.parse(src):
        v = s.evaluate(st)
        s.keep_value(0)
    return v
r = {}
# N1: a definition cleared by its own condition stays held while its reader has it
s, prev = session()
ev(s, "f[n_ /; (Clear[f]; Held[])] = Range[50]")
defs = list(s.down[Sym("f")])
seen = []
base.BUILTINS["Held"] = lambda sess, e: seen.append([d.r.held for d in defs]) or Sym("True")
ev(s, "f[1]")
r["N1"] = [seen, [d.r.held for d in defs]]
s.close(); Session.restore(prev)
# N3: the reader's pin charges the tuple's references, len(rules) * SLOT
s, prev = session()
ev(s, "g[1] = 1; g[2] = 2; g[n_ /; True] := n")
del log[:]
ev(s, "g[5]")
r["N3"] = [[need for what, need, name in log if what == "A definition's references"], 3 * SLOT]
s.close(); Session.restore(prev)
# D1 and U1: a new definition's copy and generality walk; Unset's two copies
s, prev = session()
ev(s, "h[1] = 1; h[2] = 2")
lhs = P.parse("h[" + ", ".join("a%d_" % i for i in range(300)) + "]")[0]
del log[:]
ev(s, "h[" + ", ".join("a%d_" % i for i in range(300)) + "] := 0")
r["D1"] = [[need for what, need, name in log if name == "SetDelayed"], (2 * (2 + 1) + size_of(E.Expr(Sym("h"), *[P.parse("a%d_" % i)[0] for i in range(300)]))) * SLOT]
del log[:]
ev(s, "h[1] =.")
r["U1"] = [[need for what, need, name in log if name == "Unset"], 2 * 3 * SLOT]
s.close(); Session.restore(prev)
# Q1: a sequence with one length to try: its options object (256) before its goals
s, prev = session()
del log[:]
ev(s, "MatchQ[{1}, {x__}]")
r["Q1"] = [[need for what, need, name in log if name == "Pattern"], [GOAL, 2 * GOAL, PT._SeqOptions.BYTES, 3 * GOAL, BIND]]
# M3: the bindings handed to MatchQ's holder: the dict, 3 bindings
del log[:]
ev(s, "MatchQ[f[1, 2, 3], f[a_, b_, c_]]")
r["M3"] = [[need for what, need, name in log if name == "MatchQ"], 3 * BIND]
# M1: each return to a choice point copies the 30 bindings it saved, reserved first
del log[:]
ev(s, "MatchQ[f[" + ", ".join(str(i) for i in range(30)) + ", c], f[" + ", ".join("x%d_" % i for i in range(30)) + ", a | b | c]]")
r["M1"] = [len([need for what, need, name in log if name == "Pattern" and need >= 30 * BIND]), 3]
# M5: each length tried reserves a test goal per element: the longest, 50
del log[:]
ev(s, "MatchQ[Range[50], {x__?IntegerQ, y_ /; y < 0}]")
r["M5"] = [max(need for what, need, name in log if name == "Pattern") >= 50 * GOAL]
# M2: an exhausted choice point gives its saved copy back: at the failed match's end only the current bindings remain
del released[:]
ev(s, "MatchQ[f[" + ", ".join(str(i) for i in range(100)) + ", z], f[" + ", ".join("x%d_" % i for i in range(100)) + ", a | b]]")
used = [u for name, u in released if name == "Pattern"]
r["M2"] = [max(used) < 100 * BIND + 50 * GOAL, max(used), 100 * BIND]
s.close(); Session.restore(prev)
mem.Held.grow = real_grow
mem.Reservation.acquire = real_acquire
mem.Held.release = real_release
print(json.dumps(r))
`);
  assert.ok(got.N1[0].length === 1 && got.N1[0][0].length > 0 && got.N1[0][0].every((h: boolean) => h), `held while its reader has it (${JSON.stringify(got.N1)})`);
  assert.ok(got.N1[1].every((h: boolean) => !h), "given back once the reader ends");
  assert.deepEqual(got.N3[0], [got.N3[1]], "the reader's references: one admission of len(rules) * SLOT");
  assert.ok(got.D1[0].includes(got.D1[1]), `the definition's copy and generality walk (${got.D1[0]} has ${got.D1[1]})`);
  assert.ok(got.U1[0].includes(got.U1[1]), `Unset's two copies of the table's references (${got.U1[0]} has ${got.U1[1]})`);
  assert.deepEqual(got.Q1[0], got.Q1[1], "the single length's options object, then its goals");
  assert.deepEqual(got.M3[0], [got.M3[1]], "the three bindings, charged to MatchQ's holder");
  assert.ok(got.M1[0] >= got.M1[1], `the choice point's copy and each return's (${got.M1[0]} >= ${got.M1[1]})`);
  assert.deepEqual(got.M5, [true], "the longest length's per-element goals");
  assert.equal(got.M2[0], true, `an exhausted choice point gives its copy back (${got.M2[1]} < ${got.M2[2]} + goals)`);
});

test("§8.4: the session's end, interrupted in its tail, still clears its symbols before their names' charge and empties every collection", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
import _sprig.parse as P
class OnceDict(dict):
    def clear(self):
        if not getattr(self, "stopped", False):
            self.stopped = True
            raise KeyboardInterrupt
        dict.clear(self)
res = []
for where in ("symbols", "user_attrs", "kept", "names"):
    base0 = mem.open_bytes()
    s = Session(lambda t: None, lambda t: None)
    prev = s.activate()
    for st in P.parse("SetAttributes[q, Listable]; qq1 = 1; qq2 = 2"):
        s.evaluate(st)
    order = []
    if where == "symbols":
        s.symbols = OnceDict(s.symbols)
        Sym._local = s.symbols
    elif where == "user_attrs":
        s.user_attrs = OnceDict(s.user_attrs)
    elif where == "kept":
        k0 = s.kept
        realk = k0.release
        def krelease(realk=realk):
            if not getattr(k0, "stopped", False):
                k0.stopped = True
                raise KeyboardInterrupt
            realk()
        k0.release = krelease
    else:
        r0 = s.names[0]
        real = r0.release
        def release(real=real):
            if not getattr(r0, "stopped", False):
                r0.stopped = True
                raise KeyboardInterrupt
            order.append(len(s.symbols))
            real()
        r0.release = release
    try:
        s.close()
        stopped = False
    except KeyboardInterrupt:
        stopped = True
    Session.restore(prev)
    res.append([where, stopped, len(s.symbols), len(s.user_attrs), len(s.value_charges), len(s.names), order, mem.open_bytes() - base0])
print(json.dumps(res))
`);
  for (const [where, stopped, symbols, attrs, values, names, order, left] of got) {
    assert.equal(stopped, true, `${where}: the Stop went on`);
    assert.deepEqual([symbols, attrs, values, names, left], [0, 0, 0, 0, 0], `${where}: everything cleared and given back`);
    if (where === "names") assert.deepEqual(order, [0], "the symbols were gone before their names' charge was given back");
  }
});

test("§8.4: the evaluation's parts are given back before its own holder: normal, Stop and refusal with ToExpression's numbers held", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
def stop(sess, e):
    raise KeyboardInterrupt
base.BUILTINS["StopProbe"] = stop
cover = []
def check(sess, e):
    # (inside the run: the root covers what its parts hold, and reserves what it covers)
    ev = sess._ev
    parts = [h for h in sess.holds if isinstance(h, mem.Held)]
    cover.append([ev.used >= sum(h.used for h in parts), ev.reserved >= ev.used, all(h.used >= 0 and h.reserved >= 0 for h in parts), len(parts)])
    return Sym("True")
base.BUILTINS["Cover"] = check
res = {}
for name, src in (("normal", "{1*^1000, 1*^1000, Cover[]}"), ("stop", "{1*^1000, 1*^1000, Cover[], StopProbe[]}"),
                  ("refusal", "{1*^1000, 1*^1000, Cover[], Range[10^15]}")):
    del cover[:]
    s = Session(lambda t: None, lambda t: None)
    prev = s.activate()
    base0 = mem.open_bytes()
    try:
        s.evaluate(Expr("ToExpression", src))
        s.keep_value(0)
        how = "returned"
    except KeyboardInterrupt:
        how = "stopped"
    except mem.SprigMemoryError:
        how = "refused"
    ev = s._ev
    res[name] = [how, cover, [ev.used, ev.reserved], len(s.holds), mem._pool[0] is None,
                 [mem.made.used, mem.received.used], mem.open_bytes() - base0 - s.name_reserved]
    s.close()
    Session.restore(prev)
print(json.dumps(res))
`);
  for (const [name, how] of [["normal", "returned"], ["stop", "stopped"], ["refusal", "refused"]]) {
    const [h, cover, root, holds, pool, handoffs, left] = got[name];
    assert.equal(h, how, name);
    assert.deepEqual(cover, [[true, true, true, 1]], `${name}: inside, the root covers its parts (ToExpression's numbers among them)`);
    assert.deepEqual([root, holds, pool, handoffs, left], [[0, 0], 0, true, [0, 0], 0], `${name}: after, the root at zero, no hold, the pool and hand-offs restored, the ledger back`);
  }
});

test("§8.4: a match's and a rewrite's holders don't each consult the host: /. over 1000 elements reads the memory figure a few dozen times at most", () => {
  const got = py(`${LEDGER_PY}
import _capacity
reads = [0]
real = _capacity.capacity
def capacity(*a, **k):
    reads[0] += 1
    return real(*a, **k)
_capacity.capacity = capacity
admits = [0]
real_admit = mem._admit
def admit(need, what, name):
    if mem._open[0] + need > mem.SMALL_BYTES:
        admits[0] += 1
    return real_admit(need, what, name)
mem._admit = admit
def allowance():
    capacity()
    return (1 << 40, None)
mem._allowance = allowance
# (a program's parse past SMALL_BYTES, so every admission is a checked one)
src = "(* " + "x" * 3000 + " *)\\nLength[Range[1000] /. n_Integer :> n + 1]"
out = []
_sprig.run(src, out.append, out.append)
print(json.dumps({"out": "".join(out), "reads": reads[0], "admits": admits[0]}))
`);
  assert.equal(got.out, "1000\n");
  assert.ok(got.admits <= 32 && got.reads <= 32, `checked admissions ${got.admits}, memory reads ${got.reads} (4,007 before holders were parts of the evaluation's)`);
});

test("§8.4: a Stop as the evaluation's own holder is given back still leaves it at zero, the hand-offs emptied and detached, the pool restored", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
def stop(sess, e):
    raise KeyboardInterrupt
base.BUILTINS["StopProbe"] = stop
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
base0 = mem.open_bytes()
ev = s._ev
real = ev.release
calls = [0]
def release():
    calls[0] += 1
    if calls[0] == 1:
        raise KeyboardInterrupt
    real()
ev.release = release
md, rc = s._handoffs
try:
    s.evaluate(Expr("ToExpression", "{1*^1000, StopProbe[]}"))
    r = "swallowed"
except KeyboardInterrupt:
    r = [calls[0], [ev.used, ev.reserved], [md.used, md.reserved, md.parent is None], [rc.used, rc.reserved, rc.parent is None],
         mem._pool[0] is None, mem.made is not md, len(s.holds), mem.open_bytes() - base0 - s.name_reserved]
s.close()
Session.restore(prev)
print(json.dumps(r))
`);
  assert.deepEqual(got, [2, [0, 0], [0, 0, true], [0, 0, true], true, true, 0, 0], "retried once; holder, hand-offs, pool, holds and ledger all back");
});

test("§8.4: a Stop at each step of the evaluation's clean-up, at a normal end and during a Stop: holder, hand-offs, pool and ledger all restored", () => {
  const got = py(`${LEDGER_PY}
from _sprig.eval import Session
def stop(sess, e):
    raise KeyboardInterrupt
base.BUILTINS["StopProbe"] = stop
class Once(mem.Held):
    """A hand-off whose count, set to 0 for the first time while armed, raises a Stop first."""
    armed = False
    @property
    def used(self):
        return self.__dict__["_u"]
    @used.setter
    def used(self, v):
        if Once.armed and v == 0 and self.__dict__.get("_u"):
            Once.armed = False
            raise KeyboardInterrupt
        self.__dict__["_u"] = v
outer = (mem.made, mem.received, mem._pool[0])
res = []
# (a hold is in the clean-up only when a Stop ends ToExpression: at a normal end it gives its holds back itself)
for step, how in [("hold", "stop")] + [(st, h) for st in ("root", "made", "received") for h in ("normal", "stop")]:
    if True:
        s = Session(lambda t: None, lambda t: None)
        prev = s.activate()
        base0 = mem.open_bytes()
        ev = s._ev
        md, rc = s._handoffs
        if step == "root":
            real = ev.release
            n = [0]
            def release(real=real, n=n):
                n[0] += 1
                if n[0] == 1:
                    raise KeyboardInterrupt
                real()
            ev.release = release
        if step in ("made", "received"):
            h = md if step == "made" else rc
            u = h.__dict__.pop("used")
            h.__class__ = Once
            h.__dict__["_u"] = u
            # (a nonzero count to zero: the hand-off is given a byte of the root's on the way)
            Once.armed = True
        src = "{1*^1000, StopProbe[]}" if how == "stop" else "{1*^1000, 1}"
        if step == "hold":
            import _sprig.eval as EV
            real_drain = EV._drain
            def drain(items, lo, real_drain=real_drain, fired=[False]):
                for it in items[lo:]:
                    if isinstance(it, mem.Held) and not fired[0]:
                        fired[0] = True
                        r0 = it.release
                        def once(r0=r0, it=it, k=[0]):
                            k[0] += 1
                            if k[0] == 1:
                                raise KeyboardInterrupt
                            r0()
                        it.release = once
                return real_drain(items, lo)
            EV._drain = drain
        if step in ("made", "received"):
            # (the hand-off holds something at the clean-up: a byte grown through it, as a part, into the root)
            def park(sess, e, h=h):
                h.grow(1)
                return Sym("Null")
            base.BUILTINS["Park"] = park
            src = "{1*^1000, Park[], StopProbe[]}" if how == "stop" else "{1*^1000, Park[], 1}"
        try:
            s.evaluate(Expr("ToExpression", src))
            s.keep_value(0)
            seen = "returned"
        except KeyboardInterrupt:
            seen = "stopped"
        if step == "hold":
            EV._drain = real_drain
        Once.armed = False
        res.append([step, how, seen, [ev.used, ev.reserved], [md.used, md.reserved, md.parent is None],
                     [rc.used, rc.reserved, rc.parent is None], (mem.made, mem.received, mem._pool[0]) == outer,
                     len(s.holds), mem.open_bytes() - base0 - s.name_reserved - s.kept.reserved])
        s.close()
        Session.restore(prev)
        res[-1].append(mem.open_bytes() - base0)
print(json.dumps(res))
`);
  for (const [step, how, seen, root, md, rc, ambient, holds, left, closed] of got) {
    assert.equal(seen, "stopped", `${step} ${how}: the Stop is what the caller sees`);
    assert.deepEqual([root, md, rc, ambient, holds, left, closed], [[0, 0], [0, 0, true], [0, 0, true], true, 0, 0, 0],
      `${step} ${how}: the holder at zero, the hand-offs emptied and detached, the pool and hand-offs restored, the ledger back (a value already kept is the session's until it ends)`);
  }
});
