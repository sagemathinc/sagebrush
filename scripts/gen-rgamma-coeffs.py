"""The Taylor coefficients of 1/Gamma(z) about 0, for lib/_special.py's
Temme series of Y_mu (it prints the table that lib/_special.py holds
between the markers "# ---- 1/Gamma coefficients" and "# ---- end").

    python3 scripts/gen-rgamma-coeffs.py [--check]

DLMF 5.7.1: 1/Gamma(z) = sum_{k>=1} c_k z^k, with c_1 = 1, c_2 = gamma and
the recurrence DLMF 5.7.2, (k - 1) c_k = gamma c_(k-1) - zeta(2) c_(k-2) +
zeta(3) c_(k-3) - ... + (-1)^k zeta(k-1) c_1.  The table is computed with
mpmath at 60 digits (a development-time tool; nothing here runs in
Sagebrush) by that recurrence, and --check compares it with mpmath's own
Taylor expansion of rgamma.  Temme's Gamma_1(mu) and Gamma_2(mu), for
|mu| <= 1/2, need c_1 to c_28: c_k / 2^k is below 1e-26 beyond.
"""
import sys

import mpmath as mp

mp.mp.dps = 60
N = 28


def coefficients(n):
    c = [mp.mpf(0), mp.mpf(1)]
    for k in range(2, n + 1):
        s = mp.euler * c[k - 1]
        for j in range(2, k):
            s += (-1) ** (j + 1) * mp.zeta(j) * c[k - j]
        c.append(s / (k - 1))
    return c


c = coefficients(N)
if "--check" in sys.argv:
    t = mp.taylor(mp.rgamma, 0, N)
    worst = max(abs(c[k] - t[k]) for k in range(1, N + 1))
    print("largest difference from mpmath's Taylor series:", mp.nstr(worst, 5))
    sys.exit(0 if worst < mp.mpf(10) ** -40 else 1)
print("# ---- 1/Gamma coefficients (scripts/gen-rgamma-coeffs.py): c_1 .. c_%d of DLMF 5.7.1" % N)
print("_RGAMMA_C = (")
for k in range(1, N + 1):
    print("    %r," % float(c[k]))
print(")")
print("# ---- end")
