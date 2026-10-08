# Check general 2-descent against Cremona's allbsd (oracle data in /scratch/ec):
#   node build/cli/pyjs.cjs test/ec_twodescent_check.py NMIN NMAX STEP
# For curves without rational 2-torsion, dim Sel^2 = r + dim Sha[2]; Sha[2]
# is taken as (Z/2)^2 when #Sha is even (true for all curves here, as far as
# the check is concerned: a mismatch is printed).
#   (or python3 test/ec_twodescent_check.py ... with the CPython package)
import sys, time
try:
    import sagebrush.sage  # CPython: puts the Sage layer on the path
except ImportError:
    pass
import _sage_ec as ec
lo, hi, step = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
n = bad = exact = big = grh = 0
t0 = time.time()
slow = (0, None)
for i, line in enumerate(open('/scratch/ec/allbsd.00000-09999').read().split('\n')):
    f = line.split()
    if not f or i % step or not (lo <= int(f[0]) <= hi) or int(f[5]) % 2 == 0:
        continue
    a = ec.minimal_model(tuple(int(x) for x in f[3].strip('[]').split(',')))
    r, sha = int(f[4]), int(round(float(f[10])))
    t = time.time()
    try:
        d = ec.two_descent(a)
    except NotImplementedError:
        big += 1
        continue
    except ArithmeticError as e:
        bad += 1
        print("ERROR", f[0] + f[1] + f[2], f[3], "r=%d sha=%d" % (r, sha), str(e)[:120], flush=True)
        continue
    dt = time.time() - t
    if dt > 5:
        print("SLOW %s %.1fs work %s c4=%d" % (f[0] + f[1] + f[2], dt, d.get("work"), ec._c(a)[0]), flush=True)
    if dt > slow[0]:
        slow = (dt, f[0] + f[1] + f[2], d.get("work"))
    n += 1
    grh += bool(d.get("grh"))
    l, u = d["rank_bounds"]
    sel = r + (2 if sha % 2 == 0 else 0)
    if u != sel or not (l <= r <= u) or not d["closed"]:
        bad += 1
        if bad < 12:
            print("MISMATCH", f[0] + f[1] + f[2], "r=%d sha=%d" % (r, sha), d["rank_bounds"], d["selmer"], d["closed"], d["undecided"])
    elif l == u:
        exact += 1
print("curves %d (no 2-torsion): Selmer rank right %d, rank determined %d, mismatches %d, too large %d, upper bound from the cubic field (GRH) %d; %.1fs; slowest %s" % (n, n - bad, exact, bad, big, grh, time.time() - t0, slow))
