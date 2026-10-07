# Check canonical heights and regulators against Cremona allbsd/allgens (oracle data in /scratch/ec;
# see test/ec_cremona_check.py for downloading): node build/cli/pyjs.cjs test/ec_regulator_check.py [step]
import sys, _sage_ec as ec, math, time
from fractions import Fraction as F
reg = {}
for line in open('/scratch/ec/allbsd.00000-09999'):
    f = line.split()
    if f and int(f[4]) > 0:
        reg[(f[0], f[1], f[2])] = float(f[9])
step = int(sys.argv[1]) if len(sys.argv) > 1 else 1
n = bad = 0; t0 = time.time(); worst = 0
for i, line in enumerate(open('/scratch/ec/allgens.00000-09999')):
    f = line.split()
    if len(f) < 6 or int(f[4]) == 0 or i % step:
        continue
    key = (f[0], f[1], f[2]); r = int(f[4])
    a = tuple(int(x) for x in f[3].strip('[]').split(','))
    pts = [t for t in f[5:] if t.startswith('[') and ':' in t][:r]
    P = []
    for t in pts:
        X, Y, Z = (int(v) for v in t.strip('[]').split(':'))
        P.append((F(X, Z), F(Y, Z)))
    bp = [p for p, _ in ec._factor_int(ec._disc(a))]
    R = ec.regulator(a, P, bp)
    n += 1
    err = abs(R - reg[key]) / reg[key]
    worst = max(worst, err)
    if err > 1e-8:
        bad += 1
        if bad <= 10: print("BAD", key, r, R, reg[key])
print("checked %d curves of positive rank, %d bad, worst rel err %.2e, %.1fs" % (n, bad, worst, time.time() - t0))
