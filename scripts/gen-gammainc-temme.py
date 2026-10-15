"""The coefficients of Temme's uniform asymptotic expansion of the
incomplete gamma functions, for lib/_special.py, computed exactly from the
definition (run with CPython; it prints the table that lib/_special.py
holds between the markers "# ---- Temme coefficients" and "# ---- end").

    python3 scripts/gen-gammainc-temme.py [--check]

DLMF 8.12.3 and 8.12.4 (Temme 1979):

    Q(a, x) = erfc(eta sqrt(a/2)) / 2 + R_a(eta),
    R_a(eta) ~ exp(-a eta^2 / 2) / sqrt(2 pi a) * sum_k c_k(eta) a^-k,

with lambda = x/a and eta^2/2 = lambda - 1 - log lambda (eta the sign of
lambda - 1).  The c_k follow from the integral Q(a, x) = sqrt(a / (2 pi))
/ Gamma*(a) * int_eta^inf exp(-a z^2 / 2) f(z) dz, where f = eta /
(lambda - 1) and Gamma*(a) = Gamma(a) / (sqrt(2 pi) a^(a - 1/2) e^-a), by
integrating by parts (DLMF 8.12.8 gives c_0, and the recurrence gives
8.12.9's c_1):

    c_0 = 1/(lambda - 1) - 1/eta,
    c_k = (c_(k-1)' + gamma_k f) / eta,

gamma_k being the coefficients of 1/Gamma*(a) ~ sum_k gamma_k a^-k, from
Stirling's series (DLMF 5.11.1).  Every c_k is analytic at eta = 0: the
constant term of c_(k-1)' + gamma_k f vanishes (checked below).  The table
is each c_k's Taylor series in eta, which lib/_special.py sums for small
|eta| where the closed forms cancel.
"""
import sys
from fractions import Fraction as F
from math import comb

K = 20          # c_0 .. c_(K-1)
DEG = 26        # the Taylor degree kept for each c_k
N = DEG + 2 * K + 4


def mul(p, q):
    r = [F(0)] * N
    for i, x in enumerate(p):
        if x:
            for j in range(N - i):
                r[i + j] += x * q[j]
    return r


def inv(p):
    # (1/p for p[0] != 0)
    r = [F(0)] * N
    r[0] = 1 / p[0]
    for n in range(1, N):
        r[n] = -sum(p[k] * r[n - k] for k in range(1, n + 1)) / p[0]
    return r


def sqrt1(p):
    # (sqrt(p) for p[0] = 1)
    r = [F(0)] * N
    r[0] = F(1)
    for n in range(1, N):
        r[n] = (p[n] - sum(r[k] * r[n - k] for k in range(1, n))) / 2
    return r


def compose(p, q):
    # (p(q(e)) for q[0] = 0)
    r = [F(0)] * N
    qp = [F(1)] + [F(0)] * (N - 1)
    for c in p:
        if c:
            r = [x + c * y for x, y in zip(r, qp)]
        qp = mul(qp, q)
    return r


def revert(p):
    # (the inverse series t(e) of e = p(t), p[0] = 0, p[1] = 1, by Newton-free iteration)
    t = [F(0)] * N
    t[1] = F(1)
    for n in range(2, N):
        # (fix the coefficient of e^n: p(t(e)) = e)
        c = compose(p, t)[n]
        t[n] -= c
    return t


# eta = t h(t), h(t) = sqrt(2 (t - log(1 + t)) / t^2) = sqrt(sum_{n>=0} 2 (-1)^n t^n / (n + 2))
g = [F(2 * (-1) ** n, n + 2) for n in range(N)]
h = sqrt1(g)
eta_of_t = [F(0)] + h[:N - 1]
t = revert(eta_of_t)                      # lambda - 1 as a series in eta
t_over_e = t[1:] + [F(0)]                 # t / eta
inv_t_over_e = inv(t_over_e)              # eta / t = f
f = inv_t_over_e
# c_0 = 1/t - 1/eta = (f - 1) / eta
c = [(f[1:] + [F(0)])]
c[0] = [x for x in c[0]]

# 1/Gamma*(a) = exp(-sum_j B_2j / (2j (2j - 1)) a^(1 - 2j)) as a series in 1/a
B = [F(1)]
for m in range(1, 2 * K + 4):
    B.append(-sum(F(comb(m + 1, k)) * B[k] for k in range(m)) / (m + 1))
L = [F(0)] * (K + 2)
for j in range(1, (K + 3) // 2 + 1):
    if 2 * j - 1 < len(L):
        L[2 * j - 1] = -B[2 * j] / (2 * j * (2 * j - 1))
# exp of the series L (L[0] = 0)
G = [F(0)] * len(L)
G[0] = F(1)
for n in range(1, len(L)):
    G[n] = sum(k * L[k] * G[n - k] for k in range(1, n + 1)) / n
gam = G

for k in range(1, K):
    prev = c[-1]
    d = [(i + 1) * prev[i + 1] for i in range(N - 1)] + [F(0)]
    s = [x + gam[k] * y for x, y in zip(d, f)]
    assert s[0] == 0, ("c_%d: constant term %s" % (k, s[0]))
    c.append(s[1:] + [F(0)])

if "--check" in sys.argv:
    print("gamma_k:", [str(x) for x in gam[:5]])
    print("c_k(0):", [str(ck[0]) for ck in c[:5]])
    print("c_0 series:", [str(x) for x in c[0][:6]])
    sys.exit(0)

print("# ---- Temme coefficients (scripts/gen-gammainc-temme.py): c_k's Taylor coefficients in eta")
print("_TEMME_C = [")
for ck in c:
    print("    [%s]," % ", ".join(repr(float(x)) for x in ck[:DEG + 1]))
print("]")
print("# ---- end")
