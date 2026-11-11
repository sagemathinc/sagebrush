import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { py, ROOT } from "./sprig-helpers";

// Sprig's evaluator, S1.2 (design/sprig-mvp.md §5.2, §8.3, §8.4; the S1 plan's S1.2 row and ruling 2): definitions,
// the matcher on the evaluator's own stack, and the language's limits at their recorded defaults.  Each boundary below
// was measured against the oracle (Mathics3 10.0.1, sprig-tests/PROVENANCE.json) and is the same there; the corpus
// (sprig-tests/core) records the language, these pin the boundaries and the ledger.

/** Sprig cases, each in a fresh session: [result, messages] per case. */
function cases(cs: string[]): [string, string[]][] {
  const got = py(`
import json, _sprig
cs = json.loads(${JSON.stringify(JSON.stringify(cs))})
print(json.dumps([[r["result"], r["messages"]] for r in _sprig.run_cases([(str(i), c) for i, c in enumerate(cs)])]))
`);
  return got;
}

const nest = (d: number, leaf: string) => "{".repeat(d) + leaf + "}".repeat(d);
const RECLIM = "$RecursionLimit::reclim: Recursion depth of 200 exceeded.";
const ITLIM = "$IterationLimit::itlim: Iteration limit of 4096 exceeded.";

// (§5.2, ruling 2: the limits at the default, the default + 1, raised, and Infinity.  The counting is the oracle's,
// measured on definitions (sums, lists, mutual and Map-routed recursion, a body ending in a compound expression) in a
// statement of its own and in a compound one: each boundary below is the oracle's.  A literal nested list at the end of
// a compound statement is the one shape where the oracle allows a level more than its own rule; it is left unpinned)
test("$RecursionLimit: 200 by default, counted as the oracle counts, raised, and Infinity", () => {
  const got = cases([
    "{$RecursionLimit, $IterationLimit}",
    nest(199, "x"),
    nest(200, "x"),
    "g[0] = 0; g[n_] := 1 + g[n - 1]; g[197]",
    "g[0] = 0; g[n_] := 1 + g[n - 1]; g[198]",
    "u[0] = 0; u[n_] := 1 + v[n - 1]; v[n_] := 1 + u[n]; u[99]",
    "u[0] = 0; u[n_] := 1 + v[n - 1]; v[n_] := 1 + u[n]; u[100]",
    "t[0] = 0; t[n_] := t /@ {n - 1}; t[197]",
    "t[0] = 0; t[n_] := t /@ {n - 1}; t[198]",
    "$RecursionLimit = 300\n" + nest(299, "x"),
    "$RecursionLimit = 300\n" + nest(300, "x"),
    "$RecursionLimit = Infinity; g[0] = 0; g[n_] := 1 + g[n - 1]; g[20000]",
    "x = x + 1",
    "g[0] = 0; g[n_] := g[n - 1]; g[5000]",
    "g[0] = 0\ng[n_] := 1 + g[n - 1]\ng[198]",
    "g[0] = 0\ng[n_] := 1 + g[n - 1]\ng[199]",
    "f[0] = 0; f[n_] := (Null; f[n - 1]); f[197]",
    "f[0] = 0; f[n_] := (Null; f[n - 1]); f[198]",
  ]);
  assert.deepEqual(got[0], ["{200, 4096}", []]);
  assert.deepEqual(got[1][1], [], "199 levels around a symbol evaluate");
  assert.deepEqual(got[2], ["$Aborted", [RECLIM]], "200 don't");
  assert.deepEqual(got[3], ["197", []]);
  assert.deepEqual(got[4], ["$Aborted", [RECLIM]]);
  assert.deepEqual(got[5], ["198", []], "mutual recursion: two levels a round");
  assert.deepEqual(got[6], ["$Aborted", [RECLIM]]);
  assert.deepEqual(got[7], [nest(197, "0"), []], "recursion routed through Map");
  assert.deepEqual(got[8], ["$Aborted", [RECLIM]]);
  assert.deepEqual(got[9], [nest(299, "x"), []], "raised to 300: 299 levels evaluate");
  assert.deepEqual(got[10], ["$Aborted", ["$RecursionLimit::reclim: Recursion depth of 300 exceeded."]]);
  assert.deepEqual(got[11], ["20000", []], "Infinity: Sprig's own stack, bounded only by memory");
  assert.deepEqual(got[12], ["$Aborted", [RECLIM]], "a value defined by itself recurses to the limit");
  assert.deepEqual(got[13], ["$Aborted", [ITLIM]], "a rewrite in place doesn't nest: it is the iteration limit that stops it");
  assert.deepEqual(got[14], ["198", []], "a statement of its own: one level more than inside a compound one");
  assert.deepEqual(got[15], ["$Aborted", [RECLIM]]);
  assert.deepEqual(got[16], ["0", []], "a body ending in a compound expression nests a level each time");
  assert.deepEqual(got[17], ["$Aborted", [RECLIM]]);
});

test("$IterationLimit: 4096 by default, raised and lowered, and a fixed point is no iteration", () => {
  const got = cases([
    "c[n_ /; n < 4095] := c[n + 1]; c[0]",
    "c[n_ /; n < 4096] := c[n + 1]; c[0]",
    "$IterationLimit = 50; c[n_ /; n < 49] := c[n + 1]; c[0]",
    "$IterationLimit = 50; c[n_ /; n < 50] := c[n + 1]; c[0]",
    "$IterationLimit = Infinity; c[n_ /; n < 10000] := c[n + 1]; c[0]",
    "p := q; q := p; p",
    "h[n_] := h[n]; h[1]",
  ]);
  assert.deepEqual(got[0], ["c[4095]", []]);
  assert.deepEqual(got[1], ["$Aborted", [ITLIM]]);
  assert.deepEqual(got[2], ["c[49]", []]);
  assert.deepEqual(got[3], ["$Aborted", ["$IterationLimit::itlim: Iteration limit of 50 exceeded."]]);
  assert.deepEqual(got[4], ["c[10000]", []]);
  // (the oracle's own host fails on this one, so it is pinned here rather than recorded: sprig-tests/KNOWN.json)
  assert.deepEqual(got[5], ["$Aborted", [ITLIM]], "own values that cycle");
  assert.deepEqual(got[6], ["h[1]", []], "a rewrite to the same expression is the call's value");
});

test("the limits' assignments: below 20 or not a number is refused with limset, Unset restores the default", () => {
  const got = cases([
    "$RecursionLimit = 5; $RecursionLimit",
    "$IterationLimit = a; $IterationLimit",
    "$RecursionLimit = 20; $RecursionLimit",
    "$RecursionLimit = 300; $RecursionLimit =.; $RecursionLimit",
    "$IterationLimit = Infinity; $IterationLimit",
  ]);
  assert.deepEqual(got[0], ["200", ["$RecursionLimit::limset: Cannot set $RecursionLimit to 5; value must be an integer between 20 and Infinity."]]);
  assert.deepEqual(got[1], ["4096", ["$IterationLimit::limset: Cannot set $IterationLimit to a; value must be an integer between 20 and Infinity."]]);
  assert.deepEqual(got[2], ["20", []]);
  assert.deepEqual(got[3], ["200", []]);
  assert.deepEqual(got[4], ["Infinity", []]);
});

test("§8.3: Nest 10^5 deep and a match against 10^5 arguments run on Sprig's own stack", () => {
  const got = cases([
    "f[x_] := x + 1; Nest[f, 0, 100000]",
    "Length[Range[100000] /. {a__, b_} :> {b}]",
    "MatchQ[Range[100000], {__Integer}]",
  ]);
  assert.deepEqual(got[0], ["100000", []]);
  assert.deepEqual(got[1], ["1", []]);
  assert.deepEqual(got[2], ["True", []]);
});

// (§8.3: nothing re-enters the evaluator, so S1.2 has no re-entry bound S to measure: a condition and a test yield
// to the trampoline, and replacement walks on explicit stacks)
test("§8.3: evaluate() is called only by the statement loop; no builtin or the matcher re-enters it", () => {
  const dir = join(ROOT, "lib", "_sprig");
  const calls: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".py"))) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/\bevaluate\(/.test(l) && !/^\s*def evaluate\(/.test(l) && !/^\s*#|"""|evaluate\(\) /.test(l)) calls.push(`${f}:${i + 1}`);
    });
  }
  assert.equal(calls.length, 1, calls.join(", "));
  assert.match(calls[0], /^__init__\.py:/);
});

// (§8.4: definitions are charged while they are defined and given back when replaced, removed or at the session's
// end; the matcher's choice points are reserved as they grow and given back however the match ends)
test("§8.4: definitions and the matcher's choice points are charged to the ledger and given back", () => {
  const got = py(`
import json
from _sprig import mem
from _sprig.eval import Session
from _sprig.expr import Expr, Sym
import _sprig.parse as P
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
def run(src):
    v = None
    for st in P.parse(src):
        v = s.evaluate(st)
    return v
base = mem.open_bytes()
run("f[x_] := x^2; f[0] = 1; g[x_, y_] := x + y")
defined = mem.open_bytes() - base
run("f[x_] := x^3")
replaced = mem.open_bytes() - base
run("f[0] =.")
unset = mem.open_bytes() - base
run("Clear[f]")
cleared = mem.open_bytes() - base
# a match with many open alternatives: every split of a long list tried, none succeeding
run("Range[200] /. {a__, b__, c_ /; c > 10^9} :> 0")
after_match = mem.open_bytes() - base
s.close()
Session.restore(prev)
print(json.dumps({"defined": defined, "replaced": replaced, "unset": unset, "cleared": cleared,
                  "after_match": after_match, "closed": mem.open_bytes() - base}))
`);
  assert.ok(got.defined > 0, JSON.stringify(got));
  assert.ok(got.replaced > 0 && got.replaced <= got.defined + 64, JSON.stringify(got));
  assert.ok(got.unset < got.replaced, JSON.stringify(got));
  assert.ok(got.cleared < got.unset, JSON.stringify(got));
  assert.equal(got.after_match, got.cleared, "the match gave back its choice points");
  assert.equal(got.closed, 0, "the session's end gives back every definition");
});

test("§8.1: Stop inside a condition propagates out of the matcher and the evaluator, giving back what was held", () => {
  const got = py(`
import json
from _sprig import mem, base
from _sprig.eval import Session
from _sprig.expr import Expr, Sym
import _sprig.parse as P
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
def stop(sess, e):
    raise KeyboardInterrupt()
base.BUILTINS["StopHere"] = stop
before = mem.open_bytes()
for st in P.parse("k[x_ /; StopHere[x]] := 1"):
    s.evaluate(st)
mark = mem.open_bytes()
out = []
for src in ("Range[2000] /. {a__, b_ /; StopHere[b]} :> 0", "k[3]"):
    try:
        for st in P.parse(src):
            s.evaluate(st)
        out.append("not stopped")
    except KeyboardInterrupt:
        out.append("stopped")
del base.BUILTINS["StopHere"]
held = mem.open_bytes() - mark
s.close()
Session.restore(prev)
print(json.dumps({"out": out, "held_after_stop": held, "closed": mem.open_bytes() - before}))
`);
  assert.deepEqual(got.out, ["stopped", "stopped"], "Stop in a replacement's condition, and in a definition's");
  assert.equal(got.held_after_stop, 0, "the evaluation's stack and the matcher's choice points given back");
  assert.equal(got.closed, 0, JSON.stringify(got));
});

// (§5.2's Infinity pins: with a limit at Infinity an endless computation runs until Stop ends it, and the session
// then answers, with nothing of the stopped evaluation still held)
test("§5.2: at Infinity, an endless rewrite and an endless recursion run until Stop, and the session answers after", () => {
  const got = py(`
import json
from _sprig import mem, base
from _sprig.eval import Session
import _sprig.parse as P
calls = [0]
def tick(sess, e):
    calls[0] += 1
    if calls[0] >= 5000:
        raise KeyboardInterrupt()
    return e.args[0]
base.BUILTINS["Tick"] = tick
s = Session(lambda t: None, lambda t: None)
prev = s.activate()
def run(src):
    v = None
    for st in P.parse(src):
        v = s.evaluate(st)
    return v
out = {}
for name, setup, endless in (("iteration", "$IterationLimit = Infinity; k[n_] := k[Tick[n]]", "k[1]"),
                             ("recursion", "$RecursionLimit = Infinity; g[n_] := 1 + g[Tick[n]]", "g[1]")):
    calls[0] = 0
    run(setup)
    mark = mem.open_bytes()
    try:
        run(endless)
        out[name] = "ended"
    except KeyboardInterrupt:
        out[name] = ["stopped after %d steps" % calls[0], mem.open_bytes() - mark, str(run("1 + 1"))]
del base.BUILTINS["Tick"]
s.close()
Session.restore(prev)
print(json.dumps(out))
`);
  assert.deepEqual(got, {
    iteration: ["stopped after 5000 steps", 0, "2"],
    recursion: ["stopped after 5000 steps", 0, "2"],
  });
});
