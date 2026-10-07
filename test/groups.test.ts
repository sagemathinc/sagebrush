import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("permutation groups (engine/group): Sage's API, exact orders, blocks, derived series", () => {
  const out = cli("--sage", "-c", `
G = PermutationGroup(['(1,2,3)(4,5)', '(1,4)'])
print(G, G.order(), G.is_transitive(), G.is_primitive())
g, h = G.gens()
print(g*h, h*g, g^-1, g.order(), g.cycle_type(), g.sign(), g(1))
print(SymmetricGroup(5), AlternatingGroup(5).is_solvable(), SymmetricGroup(4).is_solvable())
print([H.order() for H in SymmetricGroup(4).derived_series()])
M = MathieuGroup(24); print(M, M.transitivity())
print(MathieuGroup(23).order(), MathieuGroup(22).order(), MathieuGroup(12).order(), MathieuGroup(11).order())
D = DihedralGroup(6); print(D.blocks_all(), D.is_primitive(), D.blocks_all(representatives=False)[0])
print('(1,2)' in AlternatingGroup(4), '(1,2,3)' in AlternatingGroup(4), AlternatingGroup(4).is_normal(SymmetricGroup(4)))
print(sorted(MathieuGroup(11).cycle_type_counts().values()))
print(PSL(2, 7).order(), SymmetricGroup(30).order() == factorial(30), SymmetricGroup(6).stabilizer(3).order())
`);
  assert.deepEqual(out.trim().split("\n"), [
    "Permutation Group with generators [(1,2,3)(4,5), (1,4)] 120 True True",
    "(1,2,3,4,5) (1,5,4,2,3) (1,3,2)(4,5) 6 [3, 2] -1 2",
    "Symmetric group of order 5! as a permutation group False True",
    "[24, 12, 4, 1]",
    "Mathieu group of degree 24 and order 244823040 as a permutation group 5",
    "10200960 443520 95040 7920",
    "[[1, 4], [1, 3, 5]] False [[1, 4], [2, 5], [3, 6]]",
    "False True True",
    "[1, 165, 440, 990, 1320, 1440, 1584, 1980]",
    "168 True 120",
  ]);
});

test("Galois groups (engine/galois): f.galois_group(), NumberField, TransitiveGroup", () => {
  const out = cli("--sage", "-c", `
R.<x> = QQ[]
print([f.galois_group().transitive_label() for f in [x^2 + 1, x^3 - 2, x^4 - 2, x^5 - x - 1, x^6 + x^5 + x^4 + x^3 + x^2 + x + 1]])
G = (x^5 - 2).galois_group(); print(G, G.order(), G.name(), G.proven)
K.<a> = NumberField(x^4 - 10*x^2 + 1); print(K.galois_group(), K.is_galois())
print([g.transitive_label() for g in [sum(x^i for i in range(13)).galois_group(), (x^12 - 2).galois_group(), ((x^4 - 2)(x^3 - 3*x + 1)).galois_group()]])
print((x^3 + x/2 + 1/3).galois_group().transitive_label())
print([TransitiveGroups(n).cardinality() for n in range(1, 13)], TransitiveGroup(12, 295).name(), TransitiveGroup(12, 295).order())
try:
    (x^4 - 1).galois_group()
except ValueError as e:
    print(e)
`);
  assert.deepEqual(out.trim().split("\n"), [
    "['2T1', '3T2', '4T3', '5T5', '6T1']",
    "Transitive group number 3 of degree 5 20 F(5) = 5:4 True",
    "Galois group 4T2 (E(4) = 2[x]2) with order 4 of x^4 - 10*x^2 + 1 True",
    "['12T1', '12T28', '12T274']",
    "3T2",
    "[1, 1, 2, 5, 5, 16, 7, 50, 34, 45, 8, 301] M(12) 95040",
    "the polynomial must be irreducible",
  ]);
});
