# Kedlaya's Frobenius matrix (lib/_sage_padic_lseries.py, plan-kedlaya-optin
# r6): the parts that run the same under python3 and Sagebrush, run by
# test/kedlaya.test.ts under both.  sys.argv[1:]: the sections to run
# (default all but "full"); "full" is the whole equivalence grid, a long run.
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from fractions import Fraction as F
import _sage_padic_lseries as L

# (name, a-invariants): 36a1's model y^2 = x^3 + 1 is the sparse one, 27a1's
# y^2 + y = x^3 + 3 x^2 + 3 x - 6 the dense one
CURVES = [("11a1", [0, -1, 1, -10, -20]), ("14a1", [1, 0, 1, 4, -6]), ("27a1 dense", [0, 3, 1, 3, -6]),
          ("36a1 sparse", [0, 0, 0, 0, 1]), ("37a1", [0, 0, 1, -1, 0])]


def qc(a):
    a1, a2, a3, a4, a6 = [F(x) for x in a]
    return [(a3 * a3 + 4 * a6) / 4, (2 * a4 + a1 * a3) / 2, (a1 * a1 + 4 * a2) / 4, F(1)]


def good(a, p):
    P = p ** 2
    Q = [L._kd_mod(c, P) for c in qc(a)]
    try:
        L._kd_bezout(Q, [Q[1], 2 * Q[2] % P, 3], p, P)
        return True
    except ArithmeticError:
        return False


def ref_reduce(B, Q, Qd, S, p, P, N, i, seen):
    """The reduction as it was before the offset-add (each term padded to
    its offset in a dictionary of polynomials), with the same hook points."""
    shift = p * i + p - 1
    polys = {}
    for j, A in B.items():
        polys[p + 2 * j] = [0] * shift + [p * x % P for x in A]
    forms = {}
    G = []
    top = max(polys) if polys else 1
    carry = []
    for s in range(top, 0, -2):
        poly = L._kd_padd(polys.get(s, []), carry, P)
        if s == 1:
            G = poly
            break
        Rq, Sr = L._kd_divmod_Q(poly, Q, P)
        forms[s] = Sr
        carry = L._kd_trim(list(Rq))
    for s in range(top, 2, -2):
        T = forms.get(s)
        if T is None or not any(T):
            continue
        Bp = L._kd_divmod_Q(L._kd_pmul(T, S, P), Q, P)[1]
        num = L._kd_psub(T, L._kd_pmul(Bp, Qd, P), P)
        A, _ = L._kd_divmod_Q(num + [0] * max(0, 4 - len(num)), Q, P)
        Bd = [Bp[1], 2 * Bp[2] % P]
        red = L._kd_padd(A, [L._kd_pdiv(2 * x, s - 2, p, P) for x in Bd], P)
        if s - 2 == 1:
            G = L._kd_padd(G, red, P)
        else:
            forms[s - 2] = L._kd_padd(forms.get(s - 2, [0, 0, 0]), red, P)
    seen.append((dict(forms), list(G)))
    G = L._kd_trim(list(G))
    while len(G) > 2:
        m = len(G) - 1
        lc = G[m]
        if lc:
            rel = L._kd_padd([0] * (m - 2) + Qd, [0] * (m - 3) + [2 * (m - 2) * x % P for x in Q], P)
            f = L._kd_pdiv(lc, 2 * m - 1, p, P)
            G = L._kd_psub(G, [f * x % P for x in rel], P)
        G = L._kd_trim(G[:m])
    G = G + [0] * (2 - len(G))
    return [G[0] % p ** N, G[1] % p ** N]


def equivalence(grid):
    """The offset-add reduction against the padded one, on the same series:
    forms and G when forms is complete (both columns, the main call and the
    check's terms), and the matrix."""
    n = 0
    for name, a in CURVES:
        Qc = qc(a)
        for p, precs in grid:
            if not good(a, p):
                continue
            for prec in precs:
                N = prec + 1
                K, W = L._kd_plan_fast(p, N)
                for (KK, WW, tf) in ((K, W, 0), (K + 2, W + 3, K + 1)):
                    P, Q, Qd, S, digits = L._kd_setup(Qc, p, WW, L._KD_NO_PROGRESS, 1)
                    B = L._kd_series(digits, Q, p, P, KK, tf, L._KD_NO_PROGRESS, 3)
                    got, want = [], []
                    L._kd_hook = lambda point, v: got.append((dict(v["forms"]), list(v["G"]))) if point == "forms" else None
                    try:
                        new = [L._kd_reduce(B, Q, Qd, S, p, P, N, i, L._KD_NO_PROGRESS, 4) for i in (0, 1)]
                    finally:
                        L._kd_hook = None
                    old = [ref_reduce(B, Q, Qd, S, p, P, N, i, want) for i in (0, 1)]
                    if got != want or new != old:
                        print("DIFFERENT", name, p, prec, tf)
                    n += 1
                M = L._kd_frobenius_matrix(Qc, p, N)
                P, Q, Qd, S, digits = L._kd_setup(Qc, p, W, L._KD_NO_PROGRESS, 1)
                B = L._kd_series(digits, Q, p, P, K, 0, L._KD_NO_PROGRESS, 3)
                c = [ref_reduce(B, Q, Qd, S, p, P, N, i, []) for i in (0, 1)]
                if M != [[c[0][0], c[1][0]], [c[0][1], c[1][1]]]:
                    print("DIFFERENT M", name, p, prec)
    print("equivalence: %d reductions compared" % n)


def planner():
    """_kd_plan_fast is _kd_plan, and at N = 10^k (k <= 30), where the
    definition's loop can't run, it satisfies the defining inequalities."""
    bad = 0
    for p in (5, 7, 11, 13, 31, 97, 1009):
        # (_kd_plan's loop, once for every N: K only grows with N)
        K = 1
        for N in range(1, 20001):
            while (K + 1) - 1 - L._kd_ilog(3 * (K + 1), p) < N:
                K += 1
            if L._kd_plan_fast(p, N) != (K, N + 3 + L._kd_ilog(3 * K, p)):
                bad += 1
        for N in (1, 2, 3, 50, 999):
            bad += L._kd_plan_fast(p, N) != L._kd_plan(p, N)
    def flog(n, p):  # floor(log_p n) by exact powers: p^e <= n < p^(e + 1)
        e = 0
        while p ** (e + 1) <= n:
            e += 1
        assert p ** e <= n < p ** (e + 1)
        return e
    def h(k, p):
        return k - 1 - flog(3 * k, p)
    for p in (5, 7, 11, 13, 31, 97, 1009):
        for k in range(1, 31):
            N = 10 ** k
            K, W = L._kd_plan_fast(p, N)
            ok = h(K + 1, p) >= N and (K == 1 or h(K, p) < N) and W == N + 3 + flog(3 * K, p)
            bad += not ok
    print("planner: %d disagreements" % bad)


def ledger():
    """The ledger takes L as a parameter: a smaller L gives a smaller U, and
    the admission charges exactly p (it has no digits)."""
    out = []
    for name, t in sorted(L._KD_TABLES.items()):
        p, N = 97, 11
        K, W = L._kd_plan_fast(p, N)
        u_p = L._kd_ledger(p, N, K, W, p, 8, t)
        u_less = L._kd_ledger(p, N, K, W, p - 1, 8, t)
        out.append("%s %s" % (name, u_less < u_p))
    seen = []
    real = L._kd_ledger
    L._kd_ledger = lambda p, N, K, W, Lh, a, t: seen.append(Lh) or real(p, N, K, W, Lh, a, t)
    try:
        L._kd_admit(97, 11, *L._kd_plan_fast(97, 11), 8, "cpython", "x", 1 << 40)
    finally:
        L._kd_ledger = real
    print("ledger: smaller L, smaller U: %s; admission charges L = %s" % (", ".join(out), seen))


def digits_count():
    """L = p: every monic squarefree cubic mod p has exactly p Q-adic digits
    of E (p = 5, 7, 11), and so do 11a1, 14a1 and 27a1 at p = 5 ... 97."""
    counts = {}
    for p in (5, 7, 11):
        for q0 in range(p):
            for q1 in range(p):
                for q2 in range(p):
                    Qc = [F(q0), F(q1), F(q2), F(1)]
                    if not good_q(Qc, p):
                        continue
                    n = len(L._kd_setup(Qc, p, 4, L._KD_NO_PROGRESS, 1)[4])
                    counts[(p, n == p)] = counts.get((p, n == p), 0) + 1
    curves = []
    for name, a in CURVES[:3]:
        for p in (5, 7, 11, 13, 97):
            if good(a, p):
                curves.append(len(L._kd_setup(qc(a), p, 4, L._KD_NO_PROGRESS, 1)[4]) == p)
    print("digits: %s; curves all L = p: %s" % (sorted(counts.items()), all(curves)))


def good_q(Qc, p):
    P = p ** 2
    Q = [L._kd_mod(c, P) for c in Qc]
    try:
        L._kd_bezout(Q, [Q[1], 2 * Q[2] % P, 3], p, P)
        return True
    except ArithmeticError:
        return False


SMALL = [(5, range(1, 13)), (7, range(1, 13)), (11, range(1, 13)), (13, range(1, 13)), (97, range(1, 3)), (197, range(1, 2))]
FULL = [(p, range(1, 13)) for p in (5, 7, 11, 13, 97, 197)]

sections = sys.argv[1:] or ["equivalence", "planner", "ledger", "digits"]
for s in sections:
    if s == "equivalence":
        equivalence(SMALL)
    elif s == "full":
        equivalence(FULL)
    elif s == "planner":
        planner()
    elif s == "ledger":
        ledger()
    elif s == "digits":
        digits_count()
