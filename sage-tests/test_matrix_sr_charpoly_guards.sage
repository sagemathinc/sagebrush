# Matrices over SR (lane 4b-2): sagebrush-only checks of the characteristic polynomial's gates (G0 the size,
# G2 the work, G3 each expansion, G4 the characters).  No Sage counterpart: the .out is ours, each line a
# structural fact.  Boundary pairs: the last input a gate admits and the first it refuses, with the count
# the refusal reports.  Spies show a refusal comes before the work it bounds.
import _sage_matrix_sr as S
var("y")
def which(f):
    try:
        f()
        return 'ok'
    except Exception as e:
        t = type(e).__name__
        if t != 'SagebrushMemoryError':
            return t
        s = str(e).splitlines()[1]
        g = ('G0' if ' rows,' in s else 'G2' if 'terms of work' in s else 'G3' if 'An expansion' in s
             else 'G4-product' if 'matrix product' in s else 'shift' if 'shifted' in s else 'G4' if 'characteristic polynomial' in s else '?')
        return '%s %s %s' % (t, g, e.need_bytes if g in ('G0', 'G2', 'G3') else '')
def spied(name, f):
    orig = getattr(S, name)
    def boom(*a, **k):
        raise RuntimeError('reached ' + name)
    setattr(S, name, boom)
    try:
        return which(f)
    finally:
        setattr(S, name, orig)
print(S._SR_CHARPOLY_MAX, S._SR_TERMS_MAX, S._SR_WORK_MAX, S._SR_MAX_CHARS)
# G0: 10 x 10 admitted, 11 x 11 refused before any expansion (and det, adjugate through it)
print(which(lambda: matrix(SR, 10, 10, lambda i, j: x if i == j else i + j).charpoly()))
print(spied('_expand_bounded', lambda: matrix(SR, 11, 11, lambda i, j: x if i == j else i + j).charpoly()))
print(which(lambda: matrix(SR, 11, 11, lambda i, j: x if i == j else i + j).det()))
print(which(lambda: matrix(SR, 11, 11, lambda i, j: x if i == j else i + j).adjugate()))
# (a 3 x 3 det is Sage's formula, not the characteristic polynomial)
print(spied('_expand_bounded', lambda: matrix(SR, 3, 3, lambda i, j: x^(i + j)).det()))
# G2: [[E, 0], [0, y]] with E of k terms costs 4k + 4 terms of work: k = 24999 is 100000, k = 25000 is 100004
def g2(a, b):
    return matrix(SR, [[sum(x^i for i in range(a)) * sum(y^j for j in range(b)), 0], [0, y]])
print(which(lambda: g2(39, 641).charpoly()))
print(which(lambda: g2(125, 200).charpoly()))
# (refused before the expansion that would pass the budget: the generic 7 x 7 determinant)
calls = []
orig = S._expand_bounded
def counting(e):
    calls.append(1)
    return orig(e)
S._expand_bounded = counting
print(which(lambda: matrix(SR, 7, 7, var(' '.join('m%d' % i for i in range(49)))).det()), len(calls) < 400)
S._expand_bounded = orig
# G3: a 1 x 1 entry expanding to 50000 terms is admitted (work 100000), to 50250 refused by the engine
print(which(lambda: matrix(SR, [[sum(x^i for i in range(250)) * sum(y^j for j in range(200))]]).charpoly()))
print(which(lambda: matrix(SR, [[sum(x^i for i in range(250)) * sum(y^j for j in range(201))]]).charpoly()))
# G4: the working entries' characters (names of 450000 and 1000000 characters)
print(which(lambda: matrix(SR, 2, 2, [var('a' * 450000), 1, 1, var('b' * 450000)]).charpoly()))
print(which(lambda: matrix(SR, 2, 2, [var('a' * 10^6), 1, 1, var('b' * 10^6)]).charpoly()))
# G4: the adjugate's matrix product, refused before it (diagonal, so the characteristic polynomial is small)
def g4p(L):
    return matrix(SR, 3, 3, [var('u' * L), 0, 0, 0, var('v' * L), 0, 0, 0, var('w' * L)])
print(which(lambda: g4p(100000).adjugate()))
print(which(lambda: g4p(200000).adjugate()))
print(which(lambda: g4p(200000).charpoly()))
# the cache: refusals are not cached, a changed entry clears it
A = matrix(SR, [[x, 1], [1, y]]); c = A.charpoly(); A[0, 0] = 2; print(A.charpoly() == c, A.det())
# shift: a positive shift is bounded by the matrices' entry cap (the first shift past it refused, never allocated)
import _sage_matrix as M
p = matrix(SR, [[x, 1], [1, x]]).charpoly()
print(which(lambda: p.shift(M._MAX_ENTRIES - 2)), M._MAX_ENTRIES - 3 + len(p.list()) == M._MAX_ENTRIES, p.shift(2), p.shift(-5))
