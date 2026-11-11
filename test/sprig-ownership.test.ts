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
# direct results kept until keep_value: each charged its value, its holder and its place in the list; past the
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
r["many"] = [many >= 1000 * (4 * mem.NODE_BYTES + mem.KONT_BYTES), len(s.value_charges), mem.open_bytes() - base0]
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
