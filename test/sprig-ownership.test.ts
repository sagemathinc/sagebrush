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
    # (astra's probe: a fresh name, then an alternative, n times: each choice point copies the bindings so far, so
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
