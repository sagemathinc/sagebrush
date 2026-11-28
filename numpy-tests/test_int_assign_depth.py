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
# an array among the lists counts its own dimensions: 300 beside a 64-d array (either order) is the dimension
# refusal, not the value's; a 2-d array beside an in-range value is a valid control. And 300 at the bottom of 65
# lists: the dimension refusal at the limit exactly.
for d in (np.int8, np.uint8):
    for name, v in (("300 then 64-d", [300, np.zeros((1,) * 64)]), ("64-d then 300", [np.zeros((1,) * 64), 300]), ("5 then 1x1", [5, np.zeros((1, 1))]), ("300 then 63-d", [300, np.zeros((1,) * 63)])):
        a = np.zeros(2, d) + 7
        try:
            a[...] = v
            print(d.__name__, name, "written", a.tolist())
        except Exception as e:
            print(d.__name__, name, type(e).__name__, a.tolist())
    a = np.zeros(1, d)
    try:
        a[...] = nest(300, 65)
        print(d.__name__, "300 under 65", "written", a.tolist())
    except Exception as e:
        print(d.__name__, "300 under 65", type(e).__name__, a.tolist())
# the same beside a list subclass with __array__ (its own array, [1, 2]): still the dimension refusal. (Not here:
# [LS([0]), 300], which NumPy refuses as ragged once the protocol has given its array; this walk leaves that object to
# its one later conversion and so sees only the 300.)
class LS(list):
    def __array__(self, dtype=None, copy=None):
        return np.array([1, 2])
for d in (np.int8,):
    for name, v in (("LS then 300 under 65", [LS([0]), nest(300, 65)]), ("LS then 300 under 64", [LS([0]), nest(300, 64)]), ("LS then 64-d", [LS([0]), np.zeros((1,) * 64)]), ("LS, 300, 64-d", [LS([0]), 300, np.zeros((1,) * 64)]), ("LS, 300, 65 deep", [LS([0]), 300, nest(5, 65)])):
        a = np.zeros(2, d) + 7
        try:
            a[...] = v
            print(d.__name__, name, "written", a.tolist())
        except Exception as e:
            print(d.__name__, name, type(e).__name__, a.tolist())
