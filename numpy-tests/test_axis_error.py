import numpy as np
import numpy.exceptions
from numpy.exceptions import AxisError, ComplexWarning, DTypePromotionError, ModuleDeprecationWarning, RankWarning, TooHardError, VisibleDeprecationWarning

# numpy.exceptions.AxisError: what the listed axis-validation paths raise for an axis out of range (trapezoid keeps
# NumPy's plain IndexError); both a ValueError and an IndexError, with the axis and the number of dimensions; and an
# axis named twice refused as NumPy refuses it

print(hasattr(np, "AxisError"), np.exceptions is __import__("numpy.exceptions").exceptions, AxisError.__module__)
print([c.__name__ for c in AxisError.__mro__], issubclass(AxisError, ValueError), issubclass(AxisError, IndexError))
print(numpy.exceptions.__all__, [(c.__name__, c.__mro__[1].__name__) for c in (ComplexWarning, VisibleDeprecationWarning, ModuleDeprecationWarning, RankWarning, TooHardError, DTypePromotionError)])
for args in [(2, 1), (2, 1, "pre"), (-3, 2), ("a message",), (1, None, "p"), (None, 3)]:
    e = AxisError(*args)
    print(args, repr(str(e)), e.axis, e.ndim, isinstance(e, ValueError), isinstance(e, IndexError))
try:
    raise AxisError(5, 2)
except IndexError as e:
    print("caught as IndexError:", e)
try:
    raise AxisError(5, 2)
except ValueError as e:
    print("caught as ValueError:", e)


def show(name, f):
    try:
        r = f()
        print(name, "->", repr(r))
    except AxisError as e:
        print(name, "AxisError", e.axis, e.ndim, str(e))
    except (ValueError, IndexError, TypeError) as e:
        # (an IndexError's text here is the interpreter's own list message: only its kind is compared)
        print(name, type(e).__name__, str(e) if not isinstance(e, IndexError) else "")


a = np.arange(24.0).reshape(2, 3, 4)
m = np.arange(6.0).reshape(2, 3)
out_of_range = [
    ("sum", lambda: m.sum(axis=2)), ("sum -3", lambda: m.sum(axis=-3)), ("sum tuple", lambda: m.sum(axis=(0, 2))),
    ("mean", lambda: np.mean(m, axis=5)), ("std", lambda: m.std(axis=2)), ("var", lambda: np.var(m, axis=-3)),
    ("max", lambda: m.max(axis=2)), ("min", lambda: np.min(m, axis=2)), ("prod", lambda: m.prod(axis=2)),
    ("argmax", lambda: m.argmax(axis=2)), ("argmin", lambda: np.argmin(m, axis=-3)), ("cumsum", lambda: np.cumsum(m, axis=3)),
    ("cumprod", lambda: m.cumprod(axis=2)), ("any", lambda: m.any(axis=2)), ("all", lambda: np.all(m, axis=2)),
    ("sort", lambda: np.sort(m, axis=2)), ("argsort", lambda: np.argsort(m, axis=2)), ("median", lambda: np.median(m, axis=2)),
    ("percentile", lambda: np.percentile(m, 50, axis=2)), ("ptp", lambda: np.ptp(m, axis=2)), ("count_nonzero", lambda: np.count_nonzero(m, axis=2)),
    ("nansum", lambda: np.nansum(m, axis=2)), ("average", lambda: np.average(m, axis=2)), ("linalg.norm", lambda: np.linalg.norm(m, axis=2)),
    ("concatenate", lambda: np.concatenate([m, m], axis=2)), ("stack", lambda: np.stack([m, m], axis=4)), ("stack -4", lambda: np.stack([m, m], axis=-4)),
    ("expand_dims", lambda: np.expand_dims(m, 4)), ("expand_dims tuple", lambda: np.expand_dims(m, (0, 5))), ("squeeze", lambda: np.squeeze(m, axis=3)),
    ("moveaxis source", lambda: np.moveaxis(m, 2, 0)), ("moveaxis destination", lambda: np.moveaxis(m, 0, -3)),
    ("swapaxes axis2", lambda: m.swapaxes(0, 2)), ("swapaxes axis1", lambda: np.swapaxes(m, 5, 0)),
    ("take", lambda: np.take(m, [0], axis=2)), ("diff", lambda: np.diff(m, axis=2)), ("flip", lambda: np.flip(m, axis=2)),
    ("flip tuple", lambda: np.flip(m, axis=(0, -3))), ("roll", lambda: np.roll(m, 1, axis=2)), ("roll tuple", lambda: np.roll(m, (1, 1), axis=(0, 2))),
    ("delete", lambda: np.delete(m, 0, axis=2)), ("insert", lambda: np.insert(m, 0, 1.0, axis=2)), ("apply_along_axis", lambda: np.apply_along_axis(np.sum, 2, m)),
    ("unique", lambda: np.unique(m, axis=2)), ("gradient", lambda: np.gradient(m, axis=2)), ("trapezoid", lambda: np.trapezoid(m, axis=2)),
    ("split", lambda: np.split(m, 2, axis=2)), ("0-d sum", lambda: np.sum(np.float64(1.0), axis=1)), ("0-d sum tuple", lambda: np.sum(np.array(1.0), axis=(0,))), ("0-d mean", lambda: np.mean(np.float64(2.0), axis=1)),
    ("3-d sum", lambda: a.sum(axis=3)), ("3-d moveaxis", lambda: np.moveaxis(a, (0, 3), (1, 2))),
]
for name, f in out_of_range:
    show(name, f)

# an axis named twice
for name, f in [("sum (0, 0)", lambda: m.sum(axis=(0, 0))), ("sum (0, -2)", lambda: m.sum(axis=(0, -2))), ("mean (1, -1)", lambda: np.mean(m, axis=(1, -1))),
                ("max (0, 0)", lambda: m.max(axis=(0, 0))), ("any (1, 1)", lambda: m.any(axis=(1, 1))),
                ("squeeze (0, 0)", lambda: np.squeeze(np.zeros((1, 3)), axis=(0, 0))), ("expand_dims (0, 0)", lambda: np.expand_dims(m, (0, 0))),
                ("flip (0, 0)", lambda: np.flip(m, axis=(0, 0))), ("moveaxis (0, 0)", lambda: np.moveaxis(a, (0, 0), (1, 2))),
                ("moveaxis lengths", lambda: np.moveaxis(a, (0, 1), (2,))), ("gradient (0, 0)", lambda: np.gradient(m, axis=(0, 0))),
                ("average (0, 0)", lambda: np.average(m, axis=(0, 0))), ("diff 0-d", lambda: np.diff(np.float64(1.0))),
                ("roll shift/axis lengths", lambda: np.roll(m, (1, 2, 3), axis=(0, 1))), ("roll 2-d shift", lambda: np.roll(m, [[1]], axis=0)),
                ("median (0, 0)", lambda: np.median(a, axis=(0, 0))), ("quantile (0, 3)", lambda: np.quantile(a, 0.5, axis=(0, 3)))]:
    show(name, f)

# valid axes: the same results as before
for name, f in [("moveaxis", lambda: np.moveaxis(a, 0, -1).shape), ("moveaxis tuple", lambda: np.moveaxis(a, (0, 1), (-1, -2)).shape),
                ("expand_dims", lambda: np.expand_dims(m, (0, -1)).shape), ("expand_dims -1", lambda: np.expand_dims(m, -1).shape),
                ("stack -1", lambda: np.stack([m, m], axis=-1).shape), ("squeeze", lambda: np.squeeze(np.zeros((1, 3, 1)), axis=(0, -1)).shape),
                ("flip", lambda: np.flip(m, axis=(0, 1))), ("flip -1", lambda: np.flip(m, -1)), ("roll", lambda: np.roll(m, 1, axis=1)),
                ("roll tuple", lambda: np.roll(a, (1, -2), axis=(0, 2))), ("roll same axis twice", lambda: np.roll(m, (1, 1), axis=(1, 1))),
                ("roll one shift, two axes", lambda: np.roll(m, 1, axis=(0, 1))), ("roll empty axis", lambda: np.roll(np.zeros((0, 3)), 1, axis=0).shape),
                ("take", lambda: np.take(m, [2, 0], axis=-1)), ("diff", lambda: np.diff(m, axis=0)), ("delete", lambda: np.delete(m, 1, axis=-1)),
                ("insert", lambda: np.insert(m, 1, 9.0, axis=-1)), ("apply_along_axis", lambda: np.apply_along_axis(np.sum, -1, m)),
                ("gradient", lambda: np.gradient(m, axis=-1)), ("average", lambda: np.average(m, axis=-1)), ("trapezoid", lambda: np.trapezoid(m, axis=0)),
                ("swapaxes", lambda: a.swapaxes(-1, 0).shape), ("sum (0, -1)", lambda: a.sum(axis=(0, -1))), ("median", lambda: np.median(a, axis=(0, 2))),
                ("median keepdims", lambda: np.median(a, axis=(0, 2), keepdims=True)), ("quantile (1, 0)", lambda: np.quantile(a, [0.25, 0.5], axis=(1, 0))),
                ("quantile keepdims", lambda: np.quantile(a, [0.25, 0.5], axis=(2, 0), keepdims=True)), ("percentile (0, -1)", lambda: np.percentile(a, 30, axis=(0, -1))),
                ("median -1", lambda: np.median(a, axis=-1)), ("roll shift list, one axis", lambda: np.roll(m, [1, 2], axis=1)),
                ("roll float shift", lambda: np.roll(m, 1.5, axis=1)), ("roll float shift, no axis", lambda: np.roll(m, 1.5)),
                ("roll negative float shifts", lambda: np.roll(a, (np.float64(-1.7), 2.9), axis=(0, 2)))]:
    show(name, f)

# (out= with keepdims=True and several axes: out has every dimension, the reduced ones kept as 1; the result is
# written there, and out itself returned)
for name, f, q, method, ax in [("quantile out keepdims (2, 0)", np.quantile, [0.25, 0.5], "linear", (2, 0)),
                               ("percentile out keepdims (0, 1)", np.percentile, 30, "linear", (0, 1)),
                               ("quantile out keepdims nearest (1, 2)", np.quantile, 0.4, "nearest", (1, 2)),
                               ("quantile out keepdims midpoint (0, 1, 2)", np.quantile, [0.5], "midpoint", (0, 1, 2))]:
    o = np.full(np.quantile(a, q, axis=ax, keepdims=True).shape, -1.0)
    show(name, lambda: (f(a, q, axis=ax, keepdims=True, method=method, out=o) is o, o))
show("quantile out keepdims (2, 0), out of the wrong shape",
     lambda: np.quantile(a, 0.5, axis=(2, 0), keepdims=True, out=np.zeros((1, 3, 4))))
