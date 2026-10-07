# Check lib/_sage_ec.py against Cremona's allbsd tables (used as an oracle; Artistic
# License 2.0, not shipped): conductor, Tamagawa product, torsion, real period, root
# number, L(E,1) or L'(E,1), and Sha_an in rank 0.  Get the data with
#   curl -O https://raw.githubusercontent.com/JohnCremona/ecdata/master/allbsd/allbsd.00000-09999
# and run:  node build/cli/pyjs.cjs test/ec_cremona_check.py allbsd.00000-09999 [step]
# (all 64,687 curves of conductor < 10^4 agree, Oct 7 2026; 44 min)
import sys, time, math
import _sage_ec as ec
from sagebrush import ap as _ap

path = sys.argv[1]
step = int(sys.argv[2]) if len(sys.argv) > 2 else 1
lines = open(path).read().split("\n")
bad = 0
n = 0
t0 = time.time()
for i, line in enumerate(lines):
    if not line or i % step:
        continue
    f = line.split()
    N = int(f[0])
    a = tuple(int(x) for x in f[3].strip("[]").split(","))
    r, T, cp = int(f[4]), int(f[5]), int(f[6])
    Om, Lr, Reg, Sha = float(f[7]), float(f[8]), float(f[9]), f[10]
    n += 1
    errs = []
    m = ec.minimal_model(a)
    if m != a:
        errs.append("minimal model %s" % (m,))
    ld = ec.local_data(a)
    cond = 1
    for p, (kod, fp, c) in ld.items():
        cond *= p ** fp
    if cond != N:
        errs.append("conductor %d %s" % (cond, ld))
    cprod = 1
    for p, (kod, fp, c) in ld.items():
        cprod *= c
    if cprod != cp:
        errs.append("tamagawa %d %s" % (cprod, ld))
    aps = _ap.aplist(a, 200)
    try:
        tor = ec.torsion_order(a, aps)
    except Exception as ex:
        tor = -1
    if tor != T:
        errs.append("torsion %d" % tor)
    om = ec.real_period(a)
    if abs(om - Om) > 1e-9 * Om:
        errs.append("period %.12g vs %.12g" % (om, Om))
    if not errs:
        from _sage_modular import EllipticCurve_rational_field as E
        an = E(a).anlist(ec.terms_needed(N))
        ldat = ec._LData(an, N)
        w = ec.root_number(ldat)
        if w != (-1) ** r:
            errs.append("root number %d (rank %d)" % (w, r))
        elif r == 0:
            L = ec.L1(ldat, w)
            if abs(L - Lr) > 1e-9 * max(1, Lr):
                errs.append("L(E,1) %.12g vs %s" % (L, Lr))
            q = ec.recognize(L / om, [d for d in range(1, 2 * T * T + 1) if (2 * T * T) % d == 0])
            sha = None if q is None else q * T * T / cp
            if sha is None or sha != int(Sha):
                errs.append("Sha %s vs %s (L/Om = %s)" % (sha, Sha, q))
        elif r == 1:
            d = ec.L1_derivative(ldat)
            if abs(d - Lr) > 1e-8 * max(1, Lr):
                errs.append("L'(E,1) %.12g vs %s" % (d, Lr))
    if errs:
        bad += 1
        if bad <= 15:
            print("BAD", f[0] + f[1] + f[2], a, errs)
print("checked %d curves, %d bad, %.1fs" % (n, bad, time.time() - t0))
