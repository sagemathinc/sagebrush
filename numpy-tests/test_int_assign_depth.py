# Assignment into a small-integer array from lists nested past the dimension limit, and from a list holding itself:
# a ValueError, the destination unchanged (never a recursion without bound). The message isn't compared: NumPy's names
# the destination's dimensions, Sagebrush's the limit (64).
import numpy as np

def nest(v, n):
    for _ in range(n):
        v = [v]
    return v
r = []
r.append(r)
for d in (np.int8, np.uint8, np.int64):
    for name, v in (("65 deep", nest(5, 65)), ("200 deep", nest(300, 200)), ("1000 deep", nest(-1, 1000)), ("itself", r), ("itself inside", [1, r])):
        for key in (Ellipsis, slice(None), [0], np.array([True])):
            a = np.zeros(1, d) + 7
            try:
                a[key] = v
                print(d.__name__, name, "written", a.tolist())
            except Exception as e:
                print(d.__name__, name, type(e).__name__, a.tolist())
# an out-of-range sibling before or after an over-deep branch: the dimension refusal, the destination unchanged.
# (Not here: a list holding itself twice, [c, c], which Sagebrush refuses at once but NumPy 2.5.1 walks for its 2**64
# paths, never finishing.)
for d in (np.int8, np.uint8):
    for name, v in (("deep then 300", [nest(5, 70), 300]), ("300 then deep", [300, nest(5, 70)]), ("300 then self", [300, r])):
        for key in (Ellipsis, slice(None), [0, 1]):
            a = np.zeros(2, d) + 7
            try:
                a[key] = v
                print(d.__name__, name, "written", a.tolist())
            except Exception as e:
                print(d.__name__, name, type(e).__name__, a.tolist())
