# A ufunc's where= mask, as NumPy's _wheremask_converter makes it: an array only by a safe cast to bool (an integer or
# float array a TypeError, before anything is written, casting='unsafe' or not), any other value converted; and fmod,
# floor_divide, remainder, mod and divmod have no bool loop (dtype=bool refused; bool inputs alone give int8).
import numpy as np
for w in ([True, False], [1, 0], np.array([1, 0]), np.array([1.0, 0.0]), np.array([True, False]), True, False, 1, np.array(1), [1.5, 0], np.array([1, 0], np.uint8), np.int64(1), np.bool_(True)):
    for f in ('divmod', 'add'):
        q = np.full(2, 9); r = np.full(2, 9)
        try:
            if f == 'divmod': np.divmod([7, 8], 3, out=(q, r), where=w)
            else: np.add([7, 8], 3, out=q, where=w)
            print(f, repr(w), q.tolist(), r.tolist())
        except Exception as e:
            print(f, repr(w), type(e).__name__, e, q.tolist(), r.tolist())
q = np.full(2, 9); r = np.full(2, 9)
try:
    np.divmod([7, 8], 3, out=(q, r), where=np.array([1, 0]), casting="unsafe")
except TypeError as e:
    print("unsafe", e, q.tolist(), r.tolist())

t = np.array([True, False]); e = np.array([], dtype=bool)
for f in (np.fmod, np.floor_divide, np.remainder, np.divmod, np.mod):
    for name, a in (("bool", t), ("empty", e), ("scalar", True)):
        for dt in (bool, None, np.int8, np.float64):
            try:
                with np.errstate(all="ignore"):
                    r = f(a, np.ones_like(a) if name != "scalar" else True, dtype=dt)
                print(f.__name__, name, dt, [x.dtype.name for x in r] if isinstance(r, tuple) else np.asarray(r).dtype.name)
            except Exception as ex:
                print(f.__name__, name, dt, type(ex).__name__)
