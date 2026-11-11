# gen_linalg_ci.py: the committed linear-algebra cases (linalg-ci.txt) that tests/linalg.rs checks by default, in
# CI too. mpmath 1.4.1's python backend (CPython, MPMATH_NOGMPY=1) is the reference:
#   MPMATH_NOGMPY=1 python3 gen_linalg_ci.py > linalg-ci.txt
# Small and deterministic (seed 1013). Besides random cases, each kind of difference from the reference that a
# change could make has cases that show it:
#   - pivoting (LU_decomp's scaled pivot search, its row swaps): random dense matrices;
#   - a singular matrix found at the last pivot only: an exactly repeated last row;
#   - L_solve's rounding when b has more bits than prec: sparse matrices with wide right-hand sides, and right-hand
#     sides of zeros with one or two wide entries (a zero b[j] before a wide b[i]: the reference still rounds b[i]);
#   - inverse's guard bits (prec + 10): random inverses;
#   - an overdetermined lu_solve (A^T A and Cholesky): more rows than columns;
#   - cholesky and cholesky_solve, positive-definite or not.
# Line form (the same as the local corpora's): op rnd prec n [m] | A's raw mpfs (sign hexman exp bc) | b's | => result
import random
import mpmath
from mpmath import mp, mpf, libmp
assert libmp.BACKEND == 'python' and mpmath.__version__ == '1.4.1'
R = random.Random(1013)


def h(t):
    return "%d %x %d %d" % (t[0], t[1], t[2], t[3])


def entry(prec, wide=False):
    k = R.random()
    if k < 0.1: return mpf(0)
    if k < 0.3: return mpf(R.randint(-20, 20))
    if k < 0.5: return mpf(R.randint(-1000, 1000)) / R.randint(1, 97)
    bits = prec + R.randint(1, 80) if wide else R.randint(1, prec)
    # (make_mpf keeps a wide mantissa exact; mpf() would round it to prec)
    return mp.make_mpf(libmp.from_man_exp(R.getrandbits(bits) * R.choice([1, -1]), -R.randint(0, prec + 20)))


def emit(op, rnd, prec, n, m, A, b, out):
    ins = " ".join(h(A[i, j]._mpf_) for i in range(m) for j in range(n))
    bs = " ".join(h(b[i]._mpf_) for i in range(b.rows)) if b is not None else "-"
    head = [op, rnd, prec, n] + ([m] if m != n else [])
    print(*head, "|", ins, "|", bs, "| =>", out, flush=True)


def run(f):
    try:
        return f()
    except Exception as e:
        return "ERR " + type(e).__name__


def raws(M, rows, cols):
    return " ".join(h(M[i, j]._mpf_) for i in range(rows) for j in range(cols))


KINDS = ['random'] * 6 + ['singular-last', 'sparse-wide', 'sparse-wide', 'zeros-wide', 'zeros-wide', 'lsq', 'lsq', 'chol', 'cholsolve']
for _ in range(400):
    kind = R.choice(KINDS)
    prec = R.choice([53, 53, 64, 113, 200])
    rnd = R.choice('nnnfcdu')
    n = R.choice([2, 3, 4, 5]) if kind != 'random' else R.choice([1, 2, 3, 4, 5, 6])
    mp.prec = prec
    mp._prec_rounding[1] = rnd
    if kind in ('random', 'singular-last', 'sparse-wide', 'zeros-wide'):
        A = mp.matrix(n, n)
        for i in range(n):
            for j in range(n):
                A[i, j] = entry(prec) if kind != 'sparse-wide' or R.random() < 0.5 else mpf(0)
        if kind == 'sparse-wide':
            for i in range(n):
                A[i, i] = entry(prec) or mpf(R.randint(1, 9))
        if kind == 'singular-last':
            for j in range(n):
                A[n - 1, j] = A[0, j]
        op = 'solve' if kind in ('sparse-wide', 'zeros-wide') else R.choice(['lu', 'inv', 'inv', 'det', 'solve'])
        b = mp.matrix([entry(prec, wide=(kind == 'sparse-wide')) for _ in range(n)]) if op == 'solve' else None
        if kind == 'zeros-wide':
            b = mp.matrix([mpf(0)] * n)
            for i in R.sample(range(n), R.choice([1, 2])):
                b[i] = mp.make_mpf(libmp.from_man_exp(R.getrandbits(prec + R.randint(20, 120)) * R.choice([1, -1]) | 1, -R.randint(0, prec + 20)))
        if op == 'lu':
            def f():
                LU, p = mp.LU_decomp(A)
                return raws(LU, n, n) + " p " + " ".join(map(str, p))
        elif op == 'inv':
            f = lambda: raws(mp.inverse(A), n, n)
        elif op == 'det':
            f = lambda: (lambda d: "ZERO" if isinstance(d, int) else h(d._mpf_))(mp.det(A))
        else:
            f = lambda: raws(mp.lu_solve(A, b), n, 1)
        out = run(f)
        mp._prec_rounding[1] = 'n'
        emit(op, rnd, prec, n, n, A, b, out)
    elif kind == 'lsq':
        m = n + R.randint(1, 4)
        A = mp.matrix(m, n)
        for i in range(m):
            for j in range(n):
                A[i, j] = entry(prec)
        b = mp.matrix([entry(prec) for _ in range(m)])
        out = run(lambda: raws(mp.lu_solve(A, b), n, 1))
        mp._prec_rounding[1] = 'n'
        emit('lsq', rnd, prec, n, m, A, b, out)
    else:
        # symmetric: B^T B (+ a diagonal), exact at a high precision; some not positive-definite
        B = [[entry(prec) for j in range(n)] for i in range(n)]
        A = mp.matrix(n, n)
        k = R.random()
        with mp.workprec(20000):
            for i in range(n):
                for j in range(i, n):
                    v = sum(B[t][i] * B[t][j] for t in range(n)) if k < 0.8 else B[i][j]
                    if i == j and k < 0.6: v += R.randint(1, 5)
                    if i == j and 0.6 <= k < 0.7: v -= R.randint(1, 100)
                    A[i, j] = v
                    A[j, i] = v
        if kind == 'chol':
            b = None
            f = lambda: raws(mp.cholesky(A), n, n)
        else:
            b = mp.matrix([entry(prec) for _ in range(n)])
            f = lambda: raws(mp.cholesky_solve(A, b), n, 1)
        out = run(f)
        mp._prec_rounding[1] = 'n'
        emit(kind, rnd, prec, n, n, A, b, out)
