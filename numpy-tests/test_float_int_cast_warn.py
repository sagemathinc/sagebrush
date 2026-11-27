# A float cast to an integer type: NumPy's warning and its error modes (#2149). The warning "invalid value
# encountered in <op>" names the operation as NumPy's does: a ufunc's name when it writes into an integer out=,
# "reduce" for a reduction into one, "cast" for astype, assignment, np.array and np.full; np.errstate and np.seterr
# say whether it warns, is ignored or raises FloatingPointError. Also: a whole float past 2**53 packed into a narrow
# type refused as NumPy's int() refuses it, and np.full casting a float into int64 and uint64.
import numpy as np
import warnings

nan, inf = float("nan"), float("inf")


def show(tag, f):
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            r = f()
            s = repr(r) if isinstance(r, (dict, list, str)) or r is None else repr(np.asarray(r).tolist())
        except Exception as e:
            base = next(c for c in (TypeError, IndexError, ValueError, FloatingPointError, OverflowError, Exception)
                        if isinstance(e, c))
            s = "!! " + base.__name__ + " " + str(e)[:100]
    print(tag, s, [(m.category.__name__, str(m.message)) for m in w])


o = lambda *s: np.zeros(s, np.int8)
x = np.array([nan, 1.0, 300.7])

# (the operation each warning names)
ops = {
    "astype": lambda: x.astype(np.int8),
    "assign": lambda: o(3).__setitem__(slice(None), x),
    "np.array": lambda: np.array(x, dtype=np.int8),
    "np.full": lambda: np.full(2, np.float64(nan), dtype=np.int8),
    "add out": lambda: np.add(x, 0.0, out=o(3), casting="unsafe"),
    "add scalars out": lambda: np.add(np.float64(nan), 0.0, out=o(), casting="unsafe"),
    "multiply out": lambda: np.multiply(x, 1.0, out=o(3), casting="unsafe"),
    "sqrt out": lambda: np.sqrt(np.array([nan, 4.0]), out=o(2), casting="unsafe"),
    "floor out": lambda: np.floor(x, out=o(3), casting="unsafe"),
    "sum out": lambda: np.sum(x, out=o()),
    "sum axis out": lambda: np.sum(np.array([[nan, 1.0], [2.0, 3.0]]), axis=1, out=o(2)),
    "prod out": lambda: np.prod(x, out=o()),
    "mean out": lambda: np.mean(x, out=o()),
    "var out": lambda: np.var(x, out=o()),
    "add.reduce out": lambda: np.add.reduce(x, out=o()),
    "max out, NaN not first": lambda: np.max(np.array([1.0, nan]), out=o()),
    "min out, NaN not first": lambda: np.min(np.array([1.0, nan]), out=o()),
    "astype valid": lambda: np.array([1.5, -2.5]).astype(np.int8),
    "add out valid": lambda: np.add(np.array([1.5]), 0.0, out=o(1), casting="unsafe"),
    "sum out valid": lambda: np.sum(np.array([1.5, 2.0]), out=o()),
}
for k, f in ops.items():
    show(k, f)


# (np.errstate: 'ignore', 'warn' and 'raise' for the cast, restored on leaving; nested; as a decorator; np.seterr and
# np.geterr)
def under(f, **modes):
    def run():
        with np.errstate(**modes):
            r = f()
        return r
    return run


for mode in ("ignore", "warn", "raise"):
    for k in ("astype", "add out", "sum out", "np.full", "assign", "astype valid"):
        show(f"errstate invalid={mode} {k}", under(ops[k], invalid=mode))
    show(f"errstate all={mode} astype", under(ops["astype"], all=mode))
show("errstate all=raise invalid=ignore", under(ops["astype"], all="raise", invalid="ignore"))
show("errstate divide=raise only", under(ops["astype"], divide="raise"))
show("after the errstates", ops["astype"])


def nested():
    seen = []
    with np.errstate(invalid="raise"):
        with np.errstate(invalid="ignore"):
            seen.append(x.astype(np.int8).tolist())
            seen.append(np.geterr()["invalid"])
        try:
            x.astype(np.int8)
        except FloatingPointError as e:
            seen.append(str(e))
        seen.append(np.geterr()["invalid"])
    seen.append(np.geterr()["invalid"])
    return seen


show("nested errstates", nested)


def raised_inside():
    try:
        with np.errstate(invalid="ignore"):
            raise KeyError("k")
    except KeyError:
        pass
    return np.geterr()


show("errstate left by an exception", raised_inside)


@np.errstate(invalid="raise")
def decorated(a):
    return a.astype(np.int8)


show("decorated", lambda: decorated(x))
show("decorated, valid", lambda: decorated(np.array([1.5])))
show("after the decorated call", lambda: np.geterr())
show("decorated name", lambda: decorated.__name__)


def twice():
    e = np.errstate(invalid="ignore")
    with e:
        pass
    with e:
        pass


show("an errstate entered twice", twice)


def twice_nested():
    e = np.errstate(invalid="ignore")
    with e:
        with e:
            pass


show("an errstate entered inside itself", twice_nested)
show("errstate bad mode", lambda: under(ops["astype"], invalid="bogus")())
show("errstate bad key", lambda: np.errstate(bogus="raise"))
show("errstate enter returns", lambda: str(np.errstate(invalid="ignore").__enter__()))
np.seterr(invalid="warn")
show("geterr", np.geterr)


def seterr_round():
    old = np.seterr(invalid="raise")
    now = np.geterr()
    try:
        x.astype(np.int8)
        r = "no raise"
    except FloatingPointError as e:
        r = str(e)
    back = np.seterr(**old)
    return [sorted(old.items()), sorted(now.items()), r, sorted(back.items()), sorted(np.geterr().items())]


show("seterr round trip", seterr_round)


def seterr_all():
    old = np.seterr(all="ignore", over="raise")
    now = np.geterr()
    np.seterr(**old)
    return sorted(now.items())


show("seterr all and one key", seterr_all)
show("seterr bad mode", lambda: np.seterr(invalid="bogus"))
show("seterr bad key", lambda: np.seterr(bogus="raise"))
show("geterr at the end", np.geterr)

# (a whole float past 2**53, a Python float or a NumPy float scalar, into a narrow type: refused as NumPy's int()
# refuses it ("Python integer N out of bounds"), the array unchanged; a NumPy float scalar into an unsigned type cast)
for v in (2.0 ** 53, 2.0 ** 53 + 2, 2.0 ** 60, -2.0 ** 60, 2.0 ** 63 - 1024, -2.0 ** 63, 2.0 ** 63, 1e19, 1e300):
    for d in ("int8", "int16", "int32", "uint8", "uint16", "uint32"):
        for name, w in (("float", v), ("np.float64", np.float64(v))) + ((("np.float32", np.float32(v)),) if v < 3e38 else ()):
            def put(k):
                a = np.full(2, 7, dtype=d)
                try:
                    a[k] = w
                except OverflowError as e:
                    return ["!! OverflowError " + str(e), a.tolist()]
                return a.tolist()
            show(f"pack {name} {v!r} {d} item", lambda: put(0))
            show(f"pack {name} {v!r} {d} slice", lambda: put(slice(None)))
            show(f"pack {name} {v!r} {d} np.array", lambda: np.array([w], dtype=d))
            show(f"pack {name} {v!r} {d} ctor", lambda: np.dtype(d).type(w))

# (np.full casts a float fill into int64 and uint64, as NumPy's copyto(casting='unsafe') does; results within what
# Sagebrush's 64-bit stores hold: a uint64 of -2147483648.9 is 2**64 - 2**31, exactly a double)
for v in (-2147483648.9, 5.7, -5.7, -3e9, 2.0 ** 52, np.float64(-7.5), np.float32(3.5)):
    show(f"full int64 {v!r}", lambda: np.full(2, v, dtype="int64"))
for v in (-2147483648.9, 5.7, 2.0 ** 52, np.float64(7.5), np.float32(3.5)):
    show(f"full uint64 {v!r}", lambda: np.full(2, v, dtype="uint64"))


# (pre-review of the fixes: all= checked even when every key is given; any callable decorated; clip with one bound
# named as the ufunc it is)
def all_bogus():
    try:
        np.seterr(all="bogus", divide="warn", over="warn", under="ignore", invalid="warn")
        r = "accepted"
    except ValueError as e:
        r = "ValueError " + str(e)
    return [r, sorted(np.geterr().items())]


show("seterr all bogus, every key given", all_bogus)


def errstate_all_bogus():
    with np.errstate(all="bogus", divide="warn", over="warn", under="ignore", invalid="warn"):
        return sorted(np.geterr().items())


show("errstate all bogus, every key given", errstate_all_bogus)


class Callable:
    def __call__(self):
        return np.geterr()["invalid"]


show("decorating a callable object", lambda: np.errstate(invalid="ignore")(Callable())())
show("after it", lambda: np.geterr()["invalid"])
show("clip lower bound only", lambda: np.clip(np.array([nan]), 0, None, out=o(1), casting="unsafe"))
show("clip upper bound only", lambda: np.clip(np.array([nan]), None, 1, out=o(1), casting="unsafe"))
show("clip both bounds", lambda: np.clip(np.array([nan]), 0, 1, out=o(1), casting="unsafe"))
