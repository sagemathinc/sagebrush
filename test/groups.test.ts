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

test("elliptic curves (lib/_sage_ec.py): Tate's algorithm, torsion, periods, L_ratio, Sha", () => {
  const out = cli("--sage", "-c", `
E = EllipticCurve('11a1')
print(E.conductor(), E.tamagawa_numbers(), E.kodaira_symbol(11), E.torsion_order(), E.root_number(), E.analytic_rank())
print(E.lseries().L_ratio(), E.sha().an(), round(float(E.period_lattice().omega()), 10))
F = EllipticCurve([1,1,0,-1154,-15345])
print(F.conductor(), F.tamagawa_product(), F.torsion_order(), F.lseries().L_ratio(), F.sha().an())
K = EllipticCurve([0,0,0,-192,512])
print(K.is_minimal(), K.minimal_model().a_invariants(), K.conductor(), K.kodaira_symbol(2), K.kodaira_symbol(3))
H = EllipticCurve('37a1')
print(H.root_number(), H.analytic_rank())
`);
  assert.deepEqual(out.trim().split("\n"), [
    "11 [5] I5 5 1 0",
    "1/5 1 1.2692093043",
    "681 4 4 9/4 9",
    "False (0, 0, 0, -12, 8) 5184 I0* II",
    "-1 1",
  ]);
});

test("elliptic curves: points, canonical heights, regulators, Sha in rank 1", () => {
  const out = cli("--sage", "-c", `
E = EllipticCurve('37a1')
P = E(0, 0)
print(P, 2*P, -P, P.order(), round(float(P.height()), 12))
print(E.gens(), round(float(E.regulator()), 12), E.sha().an())
print(EllipticCurve('11a1').torsion_points())
G = EllipticCurve('389a1')
print(round(float(G.regulator_of_points([G(-1,1), G(0,0)])), 12))
print([EllipticCurve(l).sha().an() for l in ['43a1', '53a1', '58a1', '61a1']])
`);
  assert.deepEqual(out.trim().split("\n"), [
    "(0 : 0 : 1) (1 : 0 : 1) (0 : -1 : 1) +Infinity 0.05111140824",
    "[(0 : -1 : 1)] 0.05111140824 1",
    "[(0 : 1 : 0), (5 : -6 : 1), (5 : 5 : 1), (16 : -61 : 1), (16 : 60 : 1)]",
    "0.152460177943",
    "[1, 1, 1, 1]",
  ]);
});

test("elliptic curves: descent via 2-isogeny and ranks", () => {
  const out = cli("--sage", "-c", `
E = EllipticCurve([0,1,0,-21504,-1220940])
print(E.two_descent_by_two_isogeny(), E.rank(), E.sha().an())
F = EllipticCurve([0,0,0,-36,0])
print(F.two_descent_by_two_isogeny(), F.rank(), F.sha().an())
H = EllipticCurve([0,0,0,-1681,0])
print(H.two_descent_by_two_isogeny(), H.rank())
`);
  assert.deepEqual(out.trim().split("\n"), ["(0, 2) 0 4", "(1, 1) 1 1", "(2, 2) 2"]);
});

test("elliptic curves: general 2-descent (no rational 2-torsion)", () => {
  const out = cli("--sage", "-c", `
for ai in [[0,1,1,-2,0], [0,0,1,-7,6], [0,-1,1,-929,-10595]]:
    E = EllipticCurve(ai)
    print(E.two_descent(), E.selmer_rank(), E.rank_bounds())
`);
  // 389a1 rank 2, 5077a1 rank 3; 571a1 has Sha = (Z/2)^2, so descent cannot
  // decide, but analytic rank 0 proves rank 0
  assert.deepEqual(out.trim().split("\n"), ["True 2 (2, 2)", "True 3 (3, 3)", "False 2 (0, 0)"]);
});

test("elliptic curves: generators in rank >= 2 (saturation)", () => {
  const out = cli("--sage", "-c", `
E = EllipticCurve('389a1')
G = E.gens()
print(G, round(float(E.regulator_of_points(G)), 10))
P, Q = G
S, n, R = E.saturation([P + Q, 3*Q])
print(n, round(float(R), 10))
E = EllipticCurve('37a1')
print(E.saturation([5*E(0, 0)])[:2])
`);
  // the regulators are Cremona's: 389a1 0.152460177943144
  assert.deepEqual(out.trim().split("\n"), ["[(0 : -1 : 1), (1 : -1 : 1)] 0.1524601779", "3 0.1524601779", "([(0 : 0 : 1)], 5)"]);
});

test("elliptic curves: 2-descent through the cubic field", () => {
  const out = cli("--sage", "-c", `
for lab in ['11a1', '37a1', '389a1', '5077a1', '571a1']:
    E = EllipticCurve([0, 0, 1, -7, 6] if lab == '5077a1' else lab)
    E.two_descent(algorithm="cubic")
    print(lab, E.selmer_rank(), E.rank_bounds())
E = EllipticCurve([1,-1,0,-79,289])
E.two_descent(algorithm="cubic")
print(E.selmer_rank())
# 9709b3: |j| ~ 4e20, the quartic search's floating-point bounds lose half
# the Selmer group; the cubic field's count corrects the upper bound
E = EllipticCurve([0,1,1,-3145717,-2148521298])
print(E.rank_bounds(), E._descent_assumes_grh())
# 8255g2: too many quartics; rank 2 from the cubic field, assuming GRH
E = EllipticCurve([0,1,1,-169525,179243204])
try:
    E.rank()
except NotImplementedError as e:
    print(str(e)[:30])
print(E.rank(proof=False), round(float(E.regulator_of_points(E.gens(proof=False))), 10))
`);
  // Selmer ranks: Sha(571a1)[2] = (Z/2)^2; 234446a1 has rank 4.  8255g2's
  // regulator is Cremona's 0.182887025652959
  assert.deepEqual(out.trim().split("\n"), [
    "11a1 0 (0, 0)", "37a1 1 (1, 1)", "389a1 2 (2, 2)", "5077a1 3 (3, 3)", "571a1 2 (0, 0)", "4",
    "(0, 2) True", "the rank is 2 assuming GRH (th", "2 0.1828870257",
  ]);
});

test("elliptic curves: the CPS height bound proves generators (5510b1)", () => {
  const out = cli("--sage", "-c", `
print(round(float(EllipticCurve('11a1').CPS_height_bound()), 4), round(float(EllipticCurve('37a1').CPS_height_bound()), 3))
E = EllipticCurve([1,1,0,-6308,170512])
print(round(float(E.regulator_of_points(E.gens(proof=False))), 10))
try:
    E.gens()
except NotImplementedError as e:
    print("gens() refused:", "GRH" in str(E.descent_assumptions()))
`);
  // 11a1: 6/5 log 11 = 2.8775 (split I5 at 11; the archimedean term is a
  // certified lower bound, EC-F10), sharper than Sage/Magma's 4/3 log 11;
  // 37a1 as Magma's SiksekBound.  5510b1 needed a search to naive height
  // 18.1 with Silverman's bound: Cremona's regulator 0.394907586803796.
  // Its rank 2 rests on the cubic field's class group (GRH; R2-EC-F1), so
  // only gens(proof=False) accepts it.
  assert.deepEqual(out.trim().split("\n"), ["2.8775 0.164", "0.3949075868", "gens() refused: True"]);
});

test("elliptic curves: analytic rank (numerical beyond 1; proof=True only for 0 and 1)", () => {
  const out = cli("--sage", "-c", `
for ai in [[0,0,1,-1,0], [0,1,1,-2,0], [0,0,1,-7,6]]:
    E = EllipticCurve(ai)
    r, lc = E.analytic_rank(leading_coefficient=True)
    try:
        p = E.analytic_rank(proof=True)
    except NotImplementedError:
        p = "-"
    print(r, round(float(lc), 5), p, E.rank(proof=False))
`);
  // L'(37a,1), L''(389a,1), L'''(5077a,1), as Sage's analytic_rank(leading_coefficient=True)
  assert.deepEqual(out.trim().split("\n"), ["1 0.306 1 1", "2 1.51863 - 2", "3 10.3911 - 3"]);
});
