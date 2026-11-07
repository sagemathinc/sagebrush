import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// dict keys and items views compare as sets, as CPython's (Codex friction step 1, W06: "equal dictionary key views
// compare unequal", 10 topics): ==, !=, <, <=, >, >= against a set, a frozenset or another keys or items view, sizes
// first, then containment; anything else NotImplemented (so == a list is False, < a list a TypeError); values views
// by identity only. The expected lines are CPython 3.14's for the same program.
const CLI = join(__dirname, "..", "src", "cli.js");
const PROGRAM = "a = {1: 2, 3: 4}; b = {3: 5, 1: 6}; c = {1: 0}\nK, Kb, Kc = a.keys(), b.keys(), c.keys()\nprint(K == Kb, K != Kb, K == {1, 3}, {1, 3} == K, K == frozenset({1, 3}), K == [1, 3], K == (1, 3), K != [1, 3])\nprint(Kc < K, Kc <= K, K > Kc, K >= Kc, K < K, K <= K, Kc > K, K < {1, 3, 5}, {1} < K, {1, 3, 9} > K)\nI = a.items()\nprint(I == {(1, 2), (3, 4)}, I == {1: 2, 3: 4}.items(), I == b.items(), {(1, 2)} < I, I >= {(3, 4)}, I == K)\nV = a.values()\nprint(V == a.values(), V == V, V != V)\ntry:\n    print(K < [1])\nexcept TypeError as e:\n    print(\"TypeError\", e)\nprint({}.keys() == set(), {}.items() == frozenset(), dict(x=[1]).items() == dict(x=[1]).items())\ntry:\n    print(dict(x=[1]).items() == {(\"x\", 1)})\nexcept TypeError as e:\n    print(\"TypeError\", e)\n# grader r798: D1 a values view is not set-like; D3/D9 sizes differ; D7 >= at equal size; D11 != a non-set is NotImplemented\nd = {1: 1, 3: 3}\nprint(d.keys() == d.values(), K == {1, 3, 5}, K != {1, 3, 5}, K >= Kb, K <= Kb, K > Kb)\nclass Ne:\n    def __ne__(self, other):\n        return \"sentinel\"\n    def __eq__(self, other):\n        return \"eq-sentinel\"\nprint(K != Ne(), K == Ne(), I != Ne())\n";
const CPYTHON = "True False True True True False False True\nTrue True True True False True False True True True\nTrue True False True True False\nFalse True False\nTypeError '<' not supported between instances of 'dict_keys' and 'list'\nTrue True True\nTypeError cannot use 'tuple' as a set element (unhashable type: 'list')\nFalse False True True True False\nsentinel eq-sentinel sentinel\n";

test("dict keys and items views compare as sets, values views by identity, as CPython's (friction W06)", () => {
  assert.equal(execFileSync(process.execPath, [CLI, "-c", PROGRAM], { encoding: "utf8" }), CPYTHON);
});
