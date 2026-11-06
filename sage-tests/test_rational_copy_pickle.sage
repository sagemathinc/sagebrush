# copy, deepcopy and pickle keep a Rational (Fraction's own build it as cls(numerator, denominator), which Sage's
# Rational(x, base) would read as a base)
import copy, pickle
a = 1/3
for name, f in [("copy", lambda: copy.copy(a)), ("deepcopy", lambda: copy.deepcopy(a)), ("deepcopy list", lambda: copy.deepcopy([a, {1: a}])),
                ("pickle", lambda: pickle.loads(pickle.dumps(a))), ("pickle2", lambda: pickle.loads(pickle.dumps([a], 2)))]:
    try:
        r = f(); print(name, r, type(r[0] if isinstance(r, list) else r).__name__)
    except Exception as e:
        print(name, "!!", type(e).__name__, str(e)[:80])
print(copy.copy(-7/4), pickle.loads(pickle.dumps(2^70/3)), copy.deepcopy((1/2, [3/4])))
