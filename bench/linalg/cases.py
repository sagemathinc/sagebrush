# Shared inputs for sage_layer.py (sagebrush.sage, old and new) and
# sage_layer.sage (Sage): deterministic, full rank, exact.
from fractions import Fraction
def mat(n, m, mod, off, a=2, b=3):
    return [[pow(i + a, j + b, mod) - off for j in range(m)] for i in range(n)]

def qmat(n):
    return [[Fraction(pow(i + 2, j + 3, 101) - 50, 1 + (i * j) % 7) for j in range(n)] for i in range(n)]

def poly(n, mod, off, k):
    return [((i * i * k + 3 * i + 1) % mod) - off for i in range(n)]
