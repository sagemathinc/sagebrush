# Check the cubic-field 2-Selmer group (lib/_sage_ec_cubic.py) against
# Cremona's allbsd (oracle data in /scratch/ec), for curves without
# rational 2-torsion:
#   node build/cli/pyjs.cjs test/ec_cubic_descent_check.py NMIN NMAX STEP [v]
# dim Sel_2 = r + dim Sha[2], and with |Sha| = n^2 (analytic): dim Sha[2] is
# even, 0 if n is odd, 2 if v_2(n) = 1, at most 2 v_2(n).
#   (or python3 test/ec_cubic_descent_check.py ... with the CPython package)
import sys, time, math
try:
    import sagebrush.sage  # CPython: puts the Sage layer on the path
except ImportError:
    pass
import _sage_ec_cubic as cd
# (or NMIN = --labels FILE: just the curves listed there)
only = None
if sys.argv[1] == "--labels":
    only = set(open(sys.argv[2]).read().split())
    lo, hi, step = 0, 10 ** 9, 1
else:
    lo, hi, step = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
verbose = len(sys.argv) > 4 and sys.argv[1] != "--labels" or len(sys.argv) > 3 and sys.argv[1] == "--labels"
n = good = bad = 0
t0 = time.time()
slow = (0, None)
for i, line in enumerate(open('/scratch/ec/allbsd.00000-09999').read().split('\n')):
    f = line.split()
    if not f or i % step or not (lo <= int(f[0]) <= hi) or int(f[5]) % 2 == 0:
        continue
    if only is not None and f[0] + f[1] + f[2] not in only:
        continue
    a = [int(x) for x in f[3].strip('[]').split(',')]
    r = int(f[4])
    sha = round(float(f[10]))
    m = math.isqrt(sha)
    v2 = 0
    while m % 2 == 0 and m:
        m //= 2
        v2 += 1
    lab = f[0] + f[1] + f[2]
    if verbose:
        print("...", lab, flush=True)
    t = time.time()
    try:
        s = cd.selmer(a)["dim"]
    except Exception as e:
        bad += 1
        print("ERROR", lab, a, type(e).__name__, str(e)[:120], flush=True)
        continue
    dt = time.time() - t
    n += 1
    d = s - r
    ok = d >= 0 and d % 2 == 0 and d <= 2 * v2 and (v2 != 1 or d == 2) and (v2 != 0 or d == 0)
    if ok:
        good += 1
    else:
        bad += 1
        print("WRONG", lab, a, "rank", r, "Sha", sha, "Selmer dim", s, flush=True)
    if dt > slow[0]:
        slow = (dt, lab)
print("curves %d, consistent %d, wrong/errors %d; %.1fs; slowest %.1fs %s" % (n, good, bad, time.time() - t0, slow[0], slow[1]))
