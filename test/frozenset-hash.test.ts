import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// hash() of tuples, tuple subclasses and frozensets as CPython's, exactly: tuplehash and frozenset_hash on 64-bit lanes of the
// elements' exact hashes. Before, a frozenset xored each element's hash times 3644798167 as a double, whose low 32
// bits are all 0 once the hash is large (a tuple's): 50 frozensets of tuples shared 1 hash, and with them every
// non-constant polynomial over ZZ[x,y] (poly_hash hashes a frozenset of (monomial, coefficient-hash) tuples), so
// hash(x) == hash(-x). Results stayed right; dicts and sets of them degraded. (Strings and None are left out: CPython
// randomizes str hashes, and this runtime's None hash is its own.) The expected lines are CPython 3.14's and
// SageMath 10.10's for the same programs.
const CLI = join(__dirname, "..", "src", "cli.js");
function run(name: string, text: string): string {
  const d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "fzhash-"));
  try {
    writeFileSync(join(d, name), text);
    return execFileSync(process.execPath, [CLI, name], { cwd: d, encoding: "utf8" });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test("frozensets of tuples hash apart, and tuples and frozensets hash exactly as CPython's", () => {
  assert.equal(run("h.py", "print(hash((1, 2)), hash((1, 2, 3)), hash((\"x\", 1)) == hash((\"x\", 1)), hash(2**61), hash(-1), hash(10**20))\nprint(hash(frozenset()), hash(frozenset([1])), hash(frozenset([1, 2, 3])), hash(frozenset([(1, 2)])), hash(frozenset([frozenset([1])])))\nprint(len({hash(frozenset([(('x', i),)])) for i in range(50)}), len({hash(frozenset([(i, i + 1)])) for i in range(50)}))\n"), "-3550055125485641917 529344067295497451 True 1 -2 848750603811160107\n133146708735736 -558064481276695278 -272375401224217160 3819360209092968377 5515263749738256364\n50 50\n");
  assert.equal(run("p.py", "vals = [(), (0,), (-1,), (-2,), (1, 1.0), (2**61 - 1,), (2**61,), (-2**63,), (10**30, -10**30), (0.5, 1e300, -0.25),\n        (True, False), ((1, 2), (3, (4, 5))), frozenset(), frozenset([-1]), frozenset([-2]), frozenset([0, 1, 2**64]),\n        frozenset([(1, 2), (2, 1)]), frozenset([frozenset([1]), frozenset([2])]), (frozenset([1, 2]), 3),\n        frozenset(range(100)), frozenset([1.5, 2.5, 1e-9]), frozenset([(i, -i) for i in range(20)])]\nfor v in vals:\n    print(hash(v))\nprint(hash((1,)) == hash((1.0,)), hash(frozenset([1])) == hash(frozenset([1.0])), hash(frozenset([2**70])) == hash(frozenset([float(2**70)])))\nd = {frozenset([((\"x\", i),)]): i for i in range(200)}\nprint(len(d), d[frozenset([((\"x\", 7),)])])\n"), "5740354900026072187\n-8753497827991233192\n8078679518589016365\n8078679518589016365\n8389048192121911274\n-8753497827991233192\n-6644214454873602895\n-7584273899265469182\n-2217109306549935668\n-534929839309889382\n-5164621852614943976\n8418944986667272387\n133146708735736\n6776983852052281967\n6776983852052281967\n8442810467632123794\n-1106010475548004360\n304806268181062474\n-1361043499962750972\n4411996150312757951\n104007686495576180\n6414006660582723091\nTrue True True\n200 7\n");
});

// (a tuple subclass, struct_time among them, hashes as its tuple; a __hash__ result in the 64-bit range is the hash,
// as CPython's slot_tp_hash, a larger one hashed; equal keys of either kind find each other)
test("a tuple subclass hashes as its tuple, and a __hash__ result in range is the hash, as CPython's", () => {
  assert.equal(run("s.py", "import time\nclass T(tuple): pass\nclass A:\n    def __init__(self, h): self.h = h\n    def __hash__(self): return self.h\nst = time.gmtime(0)\nprint(hash(st) == hash(tuple(st)), hash(T((1, 2))) == hash((1, 2)), hash(T((1, 2))))\nprint([hash(A(h)) for h in (2**62, -2**63, 2**63, -1, 2**61 - 1, 2**61, 10**30)])\nd = {(1, 2): \"t\"}; print(d[T((1, 2))], {T((1, 2)): 1}[(1, 2)], d.get(st, \"no\"))\nprint(hash(frozenset([T((1, 2))])) == hash(frozenset([(1, 2)])))\n"), "True True -3550055125485641917\n[4611686018427387904, -9223372036854775808, 4, -2, 2305843009213693951, 2305843009213693952, 465258685558744706]\nt 1 no\nTrue\n");
});

// (daybreak3's HASH-EXACT-CONSUMER-1: a GenericAlias's hash, origin ^ args, and a union's, xored over its members,
// combine exact hashes, now often bigints, on one 64-bit lane; equal aliases and unions find each other as keys)
test("generic aliases and unions hash, equal ones alike, as CPython's", () => {
  assert.equal(run("g.py", "a, b = list[int], list[int]\nprint(hash(a) == hash(b), {a: 1}[b], hash(dict[str, tuple[int, ...]]) == hash(dict[str, tuple[int, ...]]))\nu, v = int | list[int], list[int] | int\nprint(hash(u) == hash(v), {u: \"u\"}[v], hash(int | str) == hash(str | int), type(hash(u)).__name__, type(hash(a)).__name__)\nprint(len({list[int], list[int], list[str], dict[str, int], int | list[int], list[int] | int}))\n"), "True 1 True\nTrue u True int int\n4\n");
});

test("polynomials over ZZ[x,y] hash apart, as in Sage (hash(x) != hash(-x))", () => {
  assert.equal(run("q.sage", "R.<x,y> = ZZ[]\nprint(hash(x) == hash(-x), hash(x + y) == hash(x - y), len({hash(x^i * y^j) for i in range(8) for j in range(8)}))\nF = R.fraction_field()\nprint(hash(F(x)/y) == hash(F(-x)/y))\n"), "False False 64\nFalse\n");
});
