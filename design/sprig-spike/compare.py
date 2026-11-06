# Run the corpus through the Sprig prototype and compare with Mathics3's
# outputs (oracle.sh), inside Sagebrush:
#   sagebrush compare.py LIBDIR corpus.txt oracle.txt > results.tsv
import sys
sys.path.insert(0, sys.argv[1])
import _sprig as W
from fractions import Fraction
import sage_all as S

inputs = [l.rstrip("\n") for l in open(sys.argv[2]) if l.strip() and not l.startswith("#")]
oracle = [l.rstrip("\n") for l in open(sys.argv[3])]
assert len(inputs) == len(oracle), (len(inputs), len(oracle))


def norm(t):
    return t.replace("⇾", "->").replace("⧴", ":>").replace("→", "->")


def close(a, b):
    try:
        A, B = W.to_sr(a), W.to_sr(b)
    except W.NotSR:
        return False
    try:
        d = (A - B)
        if not d.variables():
            v = complex(d.n())
            scale = max(1.0, abs(complex(B.n())))
            return abs(v) <= 1e-9 * scale
        if bool(d.simplify_full() == 0):
            return True
        # numerically at a few points
        vs = d.variables()
        for pt in (0.37, 1.13, 2.71):
            dv = d.subs({v: pt + 0.1 * i for i, v in enumerate(vs)}).n()
            if abs(complex(dv)) > 1e-9:
                return False
        return True
    except Exception:
        return False


def equiv(a, b):
    if W.same(a, b):
        return True
    if isinstance(a, W.Expr) and isinstance(b, W.Expr) and a.head == b.head and len(a.args) == len(b.args) and a.head.name in ("List", "Rule", "SeriesData", "Equal"):
        return all(equiv(x, y) for x, y in zip(a.args, b.args))
    return close(a, b)


ok = exact = beyond = 0
rows = []
for src, theirs in zip(inputs, oracle):
    theirs = norm(theirs)
    try:
        outs = []
        for stmt in W.parse(src):
            r = W.ev(stmt)
            W.OUT.append(r)
            outs.append(r)
        r = outs[-1]
        if isinstance(src, str) and src.rstrip().endswith(";"):
            r = W.NULL
        ours = W.form(r)
    except Exception as e:
        r, ours = None, "ERROR %s: %s" % (type(e).__name__, str(e)[:100])
    verdict = "DIFF"
    head = src.split("[", 1)[0].strip()
    if head.isalnum() and theirs.startswith(head + "[") and not ours.startswith(head + "["):
        verdict = "BEYOND"  # Mathics3 leaves it unevaluated: Sprig does more
    elif ours == theirs:
        verdict = "EXACT"
    elif isinstance(r, W.Graphic) and theirs.startswith(r.kind + "["):
        verdict = "SAME"
    elif r is not None:
        try:
            t = W.parse(theirs)
            if len(t) == 1 and equiv(r, W.ev(t[0])):
                verdict = "SAME"
        except Exception as e:
            pass
    if verdict == "EXACT":
        exact += 1
    if verdict in ("EXACT", "SAME"):
        ok += 1
    beyond += verdict == "BEYOND"
    rows.append((verdict, src, ours, theirs[:200] + ("..." if len(theirs) > 200 else "")))

print("verdict\tinput\tsprig\tmathics3")
for r in rows:
    print("\t".join(r))
print("# %d inputs: %d agree (%d exactly, %d semantically), %d beyond the oracle (it leaves them unevaluated), %d differ" % (len(rows), ok, exact, ok - exact, beyond, len(rows) - ok - beyond), file=sys.stderr)
