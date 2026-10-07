# Check 2-isogeny descent rank bounds against Cremona allbsd (oracle data in /scratch/ec):
# node build/cli/pyjs.cjs test/ec_descent_check.py [step]
import sys, time, _sage_ec as ec
step = int(sys.argv[1]); n = exact = wrong = 0; t0 = time.time(); gap = 0
for i, line in enumerate(open('/scratch/ec/allbsd.00000-09999').read().split('\n')):
    f = line.split()
    if not f or i % step or int(f[5]) % 2:
        continue
    a = tuple(int(x) for x in f[3].strip('[]').split(','))
    r = int(f[4])
    d = ec.two_isogeny_descent(a)
    if d is None:
        print("no 2-torsion?", f[:3]); continue
    n += 1
    lo, hi = d["rank_bounds"]
    if not (lo <= r <= hi):
        wrong += 1
        if wrong < 8: print("WRONG", f[0]+f[1]+f[2], r, d["rank_bounds"], d["selmer"], d["images"])
    elif lo == hi:
        exact += 1
    else:
        gap += 1
        sha = float(f[10])
        if sha == 1 and hi - lo >= 1 and gap < 6:
            print("gap with Sha 1", f[0]+f[1]+f[2], r, d["rank_bounds"], d["selmer"], d["images"], d.get("undecided"))
print("curves with 2-torsion: %d; rank determined %d, bounds not tight %d, contradictions %d; %.1fs" % (n, exact, gap, wrong, time.time() - t0))
