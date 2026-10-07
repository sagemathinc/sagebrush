# Check gens() in rank >= 2 against Cremona's allbsd (oracle data in /scratch/ec):
#   node build/cli/pyjs.cjs test/ec_gens_check.py NMIN NMAX STEP
# The regulator of the generators must equal Cremona's: then they generate
# E(Q) modulo torsion (the saturation proves it on its own; this checks it).
import sys, time
from sage_all import EllipticCurve
lo, hi, step = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
verbose = len(sys.argv) > 4
n = good = bad = skipped = 0
t0 = time.time()
slow = (0, None)
for i, line in enumerate(open('/scratch/ec/allbsd.00000-09999').read().split('\n')):
    f = line.split()
    if not f or i % step or not (lo <= int(f[0]) <= hi) or int(f[4]) < 2:
        continue
    a = [int(x) for x in f[3].strip('[]').split(',')]
    reg = float(f[9])
    E = EllipticCurve(a)
    if verbose:
        print("...", f[0] + f[1] + f[2], flush=True)
    t = time.time()
    try:
        G = E.gens()
    except (NotImplementedError, ArithmeticError) as e:
        skipped += 1
        print("SKIP", f[0] + f[1] + f[2], str(e)[:100], flush=True)
        continue
    dt = time.time() - t
    n += 1
    r = float(E.regulator_of_points(G))
    if len(G) == int(f[4]) and abs(r - reg) < 1e-8 * max(1, reg):
        good += 1
    else:
        bad += 1
        print("WRONG", f[0] + f[1] + f[2], "rank", f[4], "got", len(G), r, "Cremona", reg, flush=True)
    if dt > slow[0]:
        slow = (dt, f[0] + f[1] + f[2])
print("rank >= 2 curves: %d, regulator right %d, wrong %d, skipped %d; %.1fs; slowest %s" % (n, good, bad, skipped, time.time() - t0, slow))
