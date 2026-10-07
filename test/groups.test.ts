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
