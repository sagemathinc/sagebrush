"""Python mode's functions for the notebook's search box: a signature, a
one-line summary and a short example for each significant function of the
libraries Sagebrush provides (numpy with linalg, fft, random and polynomial,
scipy.integrate and scipy.io, math, cmath, fractions, itertools, functools,
collections, random, bisect, heapq), written for Sagebrush, and the output
Sagebrush prints for each example (lib/_python_docsearch.py builds the index
from them).

The outputs are Sagebrush's own, checked: test/python-doc-examples.test.ts
runs every example and compares its output exactly, and
scripts/python-doc-examples.py --cpython runs them under CPython with NumPy
and SciPy and compares there too.  scripts/python-doc-examples.py --update
rewrites OUTPUTS (at the end of this file) after a change.

Examples run one after another, each in a fresh namespace that has
PRELUDE's imports, and show what a Python prompt would: the value of a last
line that is an expression (its repr), after what the code prints.
"""

import io as _io
import sys as _sys

# what every example may use without importing it
PRELUDE = "import numpy as np\nimport math, cmath, itertools, functools, collections, random, bisect, heapq\nfrom fractions import Fraction"


def run(code, ns=None):
    """What the example prints at a Python prompt: its output, then the repr
    of its last line when that is an expression (and not None)."""
    if ns is None:
        ns = {}
        exec(PRELUDE, ns)
    lines = code.split("\n")
    last = lines[-1]
    try:
        compile(last, "<example>", "eval")
        is_expr = not last.startswith((" ", "\t"))
    except SyntaxError:
        is_expr = False
    body = "\n".join(lines[:-1] if is_expr else lines)
    buf = _io.StringIO()
    old = _sys.stdout
    _sys.stdout = buf
    try:
        if body.strip():
            exec(compile(body, "<example>", "exec"), ns)
        if is_expr:
            v = eval(compile(last, "<example>", "eval"), ns)
            if v is not None:
                print(repr(v))
    finally:
        _sys.stdout = old
    return buf.getvalue()


def run_all():
    """{code: output} for every example"""
    return {code: run(code) for _, _, _, codes in ENTRIES for code in codes}


def examples():
    """name -> [(code, output)], for the examples whose output is recorded"""
    out = {}
    for name, _, _, codes in ENTRIES:
        out[name] = [(c, OUTPUTS[c]) for c in codes if c in OUTPUTS]
    return out


# (name, signature, summary, [example code]): the significant functions
ENTRIES = [
    # ---------------------------------------------------------------- numpy: making arrays
    ("numpy.array", "(object, dtype=None)", "An array from a list, a nested list, a scalar or another array.",
     ["np.array([[1, 2], [3, 4]])"]),
    ("numpy.asarray", "(a, dtype=None)", "a as an array, without copying it if it already is one with that dtype.",
     ["np.asarray([1.5, 2])"]),
    ("numpy.arange", "([start,] stop[, step], dtype=None)", "Evenly spaced values in the half-open interval [start, stop).",
     ["np.arange(5)", "np.arange(1, 2, 0.25)"]),
    ("numpy.linspace", "(start, stop, num=50, endpoint=True, retstep=False, dtype=None)", "num evenly spaced numbers from start to stop.",
     ["np.linspace(0, 1, 5)"]),
    ("numpy.logspace", "(start, stop, num=50, endpoint=True, base=10.0)", "Numbers spaced evenly on a log scale, from base**start to base**stop.",
     ["np.logspace(0, 3, 4)"]),
    ("numpy.geomspace", "(start, stop, num=50, endpoint=True)", "A geometric progression from start to stop.",
     ["np.geomspace(1, 256, 5)"]),
    ("numpy.zeros", "(shape, dtype=float)", "An array of zeros.", ["np.zeros((2, 3))"]),
    ("numpy.ones", "(shape, dtype=float)", "An array of ones.", ["np.ones(3, dtype=int)"]),
    ("numpy.full", "(shape, fill_value, dtype=None)", "An array filled with one value.", ["np.full((2, 2), 7)"]),
    ("numpy.empty", "(shape, dtype=float)", "An array whose values are not set (here, zeros).", []),
    ("numpy.zeros_like", "(a, dtype=None)", "Zeros with the shape and dtype of a.", ["np.zeros_like(np.array([[1, 2], [3, 4]]))"]),
    ("numpy.ones_like", "(a, dtype=None)", "Ones with the shape and dtype of a.", ["np.ones_like(np.arange(3.0))"]),
    ("numpy.full_like", "(a, fill_value, dtype=None)", "An array like a, filled with one value.", ["np.full_like(np.arange(4), 9)"]),
    ("numpy.eye", "(N, M=None, k=0, dtype=float)", "A 2-D array with ones on a diagonal and zeros elsewhere.", ["np.eye(3, k=1)"]),
    ("numpy.identity", "(n, dtype=float)", "The n x n identity matrix.", ["np.identity(2)"]),
    ("numpy.diag", "(v, k=0)", "The diagonal of a 2-D array, or a diagonal matrix from a 1-D one.",
     ["np.diag([1, 2, 3])", "np.diag(np.arange(9).reshape(3, 3))"]),
    ("numpy.tri", "(N, M=None, k=0, dtype=float)", "Ones at and below a diagonal, zeros above.", ["np.tri(3)"]),
    ("numpy.tril", "(m, k=0)", "The lower triangle of an array, zeros above it.", ["np.tril(np.arange(1, 10).reshape(3, 3))"]),
    ("numpy.triu", "(m, k=0)", "The upper triangle of an array, zeros below it.", ["np.triu(np.arange(1, 10).reshape(3, 3), 1)"]),
    ("numpy.vander", "(x, N=None, increasing=False)", "The Vandermonde matrix of x: columns are powers of x.", ["np.vander([1, 2, 3])"]),
    ("numpy.meshgrid", "(*xi, indexing='xy')", "Coordinate matrices from coordinate vectors.",
     ["X, Y = np.meshgrid([1, 2, 3], [10, 20])\nX + Y"]),
    ("numpy.indices", "(dimensions)", "An array of the indices of a grid.", ["np.indices((2, 3))"]),
    ("numpy.fromfunction", "(function, shape, dtype=float)", "An array whose value at each index is function(*index).",
     ["np.fromfunction(lambda i, j: i + 10 * j, (2, 3))"]),
    ("numpy.fromiter", "(iterable, dtype, count=-1)", "A 1-D array from an iterable.", ["np.fromiter((x * x for x in range(5)), dtype=int)"]),
    ("numpy.copy", "(a)", "A copy of an array.", ["a = np.arange(3)\nb = np.copy(a)\nb[0] = 9\na"]),
    ("numpy.loadtxt", "(fname, dtype=float, delimiter=None, skiprows=0, usecols=None)", "An array from a text file of numbers.", []),
    ("numpy.savetxt", "(fname, X, fmt='%.18e', delimiter=' ', header='')", "Writes an array to a text file.", []),
    # ---------------------------------------------------------------- numpy: shapes
    ("numpy.reshape", "(a, newshape)", "The same data in another shape (-1 for the dimension that fits).",
     ["np.reshape(np.arange(6), (2, -1))"]),
    ("numpy.ravel", "(a)", "The array flattened to 1-D.", ["np.ravel([[1, 2], [3, 4]])"]),
    ("numpy.transpose", "(a, axes=None)", "The array with its axes reversed or permuted.", ["np.transpose(np.arange(6).reshape(2, 3))"]),
    ("numpy.swapaxes", "(a, axis1, axis2)", "The array with two axes interchanged.", ["np.swapaxes(np.zeros((2, 3, 4)), 0, 2).shape"]),
    ("numpy.moveaxis", "(a, source, destination)", "The array with an axis moved to a new position.", ["np.moveaxis(np.zeros((2, 3, 4)), 0, -1).shape"]),
    ("numpy.expand_dims", "(a, axis)", "The array with a new axis of length one.", ["np.expand_dims(np.array([1, 2]), 0)"]),
    ("numpy.squeeze", "(a, axis=None)", "The array without its axes of length one.", ["np.squeeze(np.zeros((1, 3, 1))).shape"]),
    ("numpy.atleast_2d", "(*arys)", "Inputs as arrays of at least two dimensions.", ["np.atleast_2d([1, 2])"]),
    ("numpy.concatenate", "(arrays, axis=0)", "Arrays joined along an existing axis.", ["np.concatenate([[1, 2], [3], [4, 5]])"]),
    ("numpy.stack", "(arrays, axis=0)", "Arrays joined along a new axis.", ["np.stack([[1, 2], [3, 4]], axis=1)"]),
    ("numpy.vstack", "(tup)", "Arrays stacked as rows (vertically).", ["np.vstack([[1, 2], [3, 4]])"]),
    ("numpy.hstack", "(tup)", "Arrays stacked horizontally (along columns).", ["np.hstack([[1, 2], [3]])"]),
    ("numpy.column_stack", "(tup)", "1-D arrays stacked as the columns of a 2-D array.", ["np.column_stack([[1, 2], [3, 4]])"]),
    ("numpy.split", "(ary, indices_or_sections, axis=0)", "An array split into equal parts, or at the given indices.",
     ["np.split(np.arange(6), 3)"]),
    ("numpy.array_split", "(ary, indices_or_sections, axis=0)", "An array split into nearly equal parts.", ["np.array_split(np.arange(5), 2)"]),
    ("numpy.tile", "(A, reps)", "An array made by repeating A.", ["np.tile([1, 2], 3)"]),
    ("numpy.repeat", "(a, repeats, axis=None)", "Each element repeated.", ["np.repeat([1, 2], [2, 3])"]),
    ("numpy.flip", "(m, axis=None)", "The array with the order of its elements reversed.", ["np.flip(np.arange(4))"]),
    ("numpy.roll", "(a, shift, axis=None)", "Elements shifted cyclically.", ["np.roll(np.arange(5), 2)"]),
    ("numpy.rot90", "(m, k=1, axes=(0, 1))", "An array rotated by 90 degrees, k times.", ["np.rot90([[1, 2], [3, 4]])"]),
    ("numpy.pad", "(array, pad_width, mode='constant', constant_values=0)", "An array with values added at its edges.",
     ["np.pad([1, 2, 3], (2, 1))", "np.pad([1, 2, 3], 2, mode='edge')"]),
    ("numpy.insert", "(arr, obj, values, axis=None)", "Values inserted before the given indices.", ["np.insert([1, 2, 3], 1, 9)"]),
    ("numpy.delete", "(arr, obj, axis=None)", "The array without the given elements.", ["np.delete(np.arange(6), [0, 2])"]),
    ("numpy.append", "(arr, values, axis=None)", "Values added at the end of an array.", ["np.append([1, 2], [3, 4])"]),
    ("numpy.broadcast_to", "(array, shape)", "A view of an array broadcast to a shape.", ["np.broadcast_to([1, 2, 3], (2, 3))"]),
    ("numpy.shape", "(a)", "The shape of an array.", ["np.shape([[1, 2, 3], [4, 5, 6]])"]),
    ("numpy.ndim", "(a)", "The number of dimensions of an array.", ["np.ndim([[1], [2]])"]),
    ("numpy.size", "(a, axis=None)", "The number of elements of an array.", ["np.size(np.zeros((3, 4)))"]),
    # ---------------------------------------------------------------- numpy: elementwise math
    ("numpy.add", "(x1, x2)", "Elementwise sum (the ufunc behind +).", ["np.add([1, 2], [10, 20])"]),
    ("numpy.subtract", "(x1, x2)", "Elementwise difference (-).", ["np.subtract(5, [1, 2])"]),
    ("numpy.multiply", "(x1, x2)", "Elementwise product (*).", ["np.multiply([1, 2, 3], 2)"]),
    ("numpy.divide", "(x1, x2)", "Elementwise true division (/).", ["np.divide([1, 2, 3], 4)"]),
    ("numpy.floor_divide", "(x1, x2)", "Elementwise floor division (//).", ["np.floor_divide([7, -7], 2)"]),
    ("numpy.mod", "(x1, x2)", "Elementwise remainder with the divisor's sign (%).", ["np.mod([7, -7], 3)"]),
    ("numpy.power", "(x1, x2)", "Elementwise power (**).", ["np.power([2, 3], [3, 2])"]),
    ("numpy.sqrt", "(x)", "Elementwise square root.", ["np.sqrt([1, 4, 2])"]),
    ("numpy.cbrt", "(x)", "Elementwise cube root.", ["np.cbrt([27, -8])"]),
    ("numpy.square", "(x)", "Elementwise square.", ["np.square([1, -2, 3])"]),
    ("numpy.abs", "(x)", "Elementwise absolute value (also of complex numbers).", ["np.abs([-1.5, 2, 3 + 4j])"]),
    ("numpy.sign", "(x)", "Elementwise sign: -1, 0 or 1.", ["np.sign([-2, 0, 5])"]),
    ("numpy.exp", "(x)", "Elementwise e**x.", ["np.exp([0, 1])"]),
    ("numpy.expm1", "(x)", "Elementwise exp(x) - 1, accurate for small x.", ["np.expm1(1e-10)"]),
    ("numpy.log", "(x)", "Elementwise natural logarithm.", ["np.log([1, np.e])"]),
    ("numpy.log10", "(x)", "Elementwise base-10 logarithm.", ["np.log10([10, 1000])"]),
    ("numpy.log2", "(x)", "Elementwise base-2 logarithm.", ["np.log2([8, 0.5])"]),
    ("numpy.log1p", "(x)", "Elementwise log(1 + x), accurate for small x.", ["np.log1p(1e-10)"]),
    ("numpy.sin", "(x)", "Elementwise sine (radians).", ["np.sin([0, np.pi / 2])"]),
    ("numpy.cos", "(x)", "Elementwise cosine (radians).", ["np.cos([0, np.pi])"]),
    ("numpy.tan", "(x)", "Elementwise tangent (radians).", ["np.tan(np.pi / 4)"]),
    ("numpy.arcsin", "(x)", "Elementwise inverse sine.", ["np.arcsin([0, 1])"]),
    ("numpy.arccos", "(x)", "Elementwise inverse cosine.", ["np.arccos([1, 0])"]),
    ("numpy.arctan", "(x)", "Elementwise inverse tangent.", ["np.arctan(1)"]),
    ("numpy.arctan2", "(x1, x2)", "Elementwise angle of the point (x2, x1), in (-pi, pi].", ["np.arctan2([1, -1], [-1, -1])"]),
    ("numpy.hypot", "(x1, x2)", "Elementwise sqrt(x1**2 + x2**2).", ["np.hypot(3, [4, 5])"]),
    ("numpy.sinh", "(x)", "Elementwise hyperbolic sine.", ["np.sinh([0, 1])"]),
    ("numpy.cosh", "(x)", "Elementwise hyperbolic cosine.", ["np.cosh([0, 1])"]),
    ("numpy.tanh", "(x)", "Elementwise hyperbolic tangent.", ["np.tanh([0, 1])"]),
    ("numpy.degrees", "(x)", "Radians converted to degrees.", ["np.degrees(np.pi)"]),
    ("numpy.radians", "(x)", "Degrees converted to radians.", ["np.radians([90, 180])"]),
    ("numpy.round", "(a, decimals=0)", "Elements rounded to some decimals (halves to even).", ["np.round([1.25, 2.5, -0.5], 1)", "np.round([2.5, 3.5])"]),
    ("numpy.floor", "(x)", "Elementwise floor.", ["np.floor([-1.5, 1.5])"]),
    ("numpy.ceil", "(x)", "Elementwise ceiling.", ["np.ceil([-1.5, 1.5])"]),
    ("numpy.trunc", "(x)", "Elementwise truncation toward zero.", ["np.trunc([-1.7, 1.7])"]),
    ("numpy.rint", "(x)", "Elements rounded to the nearest integer (halves to even).", ["np.rint([0.5, 1.5, 2.6])"]),
    ("numpy.clip", "(a, a_min, a_max)", "Values limited to an interval.", ["np.clip(np.arange(6), 1, 4)"]),
    ("numpy.maximum", "(x1, x2)", "Elementwise maximum (nan wins).", ["np.maximum([1, 5, 3], [4, 2, 6])"]),
    ("numpy.minimum", "(x1, x2)", "Elementwise minimum (nan wins).", ["np.minimum([1, 5, 3], 2)"]),
    ("numpy.fmax", "(x1, x2)", "Elementwise maximum, ignoring nan.", ["np.fmax([1, np.nan], [np.nan, 2])"]),
    ("numpy.gcd", "(x1, x2)", "Elementwise greatest common divisor.", ["np.gcd([12, 20], 8)"]),
    ("numpy.lcm", "(x1, x2)", "Elementwise least common multiple.", ["np.lcm([4, 6], 10)"]),
    ("numpy.real", "(val)", "The real parts.", ["np.real([1 + 2j, 3])"]),
    ("numpy.imag", "(val)", "The imaginary parts.", ["np.imag([1 + 2j, 3])"]),
    ("numpy.conj", "(x)", "Elementwise complex conjugate.", ["np.conj([1 + 2j, 3 - 1j])"]),
    ("numpy.angle", "(z, deg=False)", "The angles of complex numbers.", ["np.angle([1j, -1], deg=True)"]),
    ("numpy.isnan", "(x)", "Whether each element is nan.", ["np.isnan([1, np.nan])"]),
    ("numpy.isinf", "(x)", "Whether each element is infinite.", ["np.isinf([np.inf, -np.inf, 1])"]),
    ("numpy.isfinite", "(x)", "Whether each element is finite.", ["np.isfinite([1, np.nan, np.inf])"]),
    ("numpy.nan_to_num", "(x, nan=0.0, posinf=None, neginf=None)", "nan and infinities replaced by numbers.", ["np.nan_to_num([np.nan, 1.5, np.inf])"]),
    ("numpy.heaviside", "(x1, x2)", "The Heaviside step function, x2 at 0.", ["np.heaviside([-1, 0, 2], 0.5)"]),
    ("numpy.sinc", "(x)", "The normalized sinc function sin(pi x)/(pi x).", ["np.sinc([0, 0.5])"]),
    ("numpy.interp", "(x, xp, fp, left=None, right=None)", "Linear interpolation of the points (xp, fp) at x.", ["np.interp([0.5, 1.5], [0, 1, 2], [0, 10, 0])"]),
    ("numpy.piecewise", "(x, condlist, funclist)", "A function defined piece by piece by conditions.",
     ["x = np.array([-2, -1, 0, 1, 2])\nnp.piecewise(x, [x < 0, x >= 0], [lambda t: -t, lambda t: t ** 2])"]),
    ("numpy.where", "(condition, x, y)", "Elements from x where the condition holds, from y elsewhere (or the indices where it holds).",
     ["np.where(np.arange(5) > 2, 1, -1)", "np.where([0, 3, 0, 5])"]),
    ("numpy.select", "(condlist, choicelist, default=0)", "Elements chosen by the first condition that holds.",
     ["x = np.arange(6)\nnp.select([x < 2, x > 3], [x, x ** 2], -1)"]),
    ("numpy.vectorize", "(pyfunc)", "A Python function made to act elementwise on arrays.",
     ["f = np.vectorize(lambda a, b: a if a > b else b)\nf([1, 5, 3], 2)"]),
    # ---------------------------------------------------------------- numpy: reductions and statistics
    ("numpy.sum", "(a, axis=None, keepdims=False)", "The sum of the elements, of all or along an axis.",
     ["np.sum([[1, 2], [3, 4]])", "np.sum([[1, 2], [3, 4]], axis=0)"]),
    ("numpy.prod", "(a, axis=None, keepdims=False)", "The product of the elements.", ["np.prod([1, 2, 3, 4])"]),
    ("numpy.cumsum", "(a, axis=None)", "Cumulative sums.", ["np.cumsum([1, 2, 3, 4])"]),
    ("numpy.cumprod", "(a, axis=None)", "Cumulative products.", ["np.cumprod([1, 2, 3, 4])"]),
    ("numpy.diff", "(a, n=1, axis=-1)", "Differences between consecutive elements (n times).", ["np.diff([1, 4, 9, 16])", "np.diff([1, 4, 9, 16], n=2)"]),
    ("numpy.gradient", "(f, *varargs, axis=None)", "The gradient by central differences inside, one-sided at the ends.",
     ["np.gradient([1, 4, 9, 16])"]),
    ("numpy.min", "(a, axis=None, keepdims=False)", "The smallest element (amin).", ["np.min([[3, 1], [4, 1]], axis=1)"]),
    ("numpy.max", "(a, axis=None, keepdims=False)", "The largest element (amax).", ["np.max([3, 9, 4])"]),
    ("numpy.argmin", "(a, axis=None)", "The index of the smallest element.", ["np.argmin([3, 1, 2])"]),
    ("numpy.argmax", "(a, axis=None)", "The index of the largest element.", ["np.argmax([[1, 9], [5, 2]], axis=0)"]),
    ("numpy.ptp", "(a, axis=None)", "The range of the values, max - min.", ["np.ptp([4, 9, 1])"]),
    ("numpy.mean", "(a, axis=None, keepdims=False)", "The arithmetic mean.", ["np.mean([1, 2, 3, 4])", "np.mean([[1, 2], [3, 4]], axis=1)"]),
    ("numpy.average", "(a, axis=None, weights=None)", "The weighted average.", ["np.average([1, 2, 3], weights=[3, 1, 1])"]),
    ("numpy.median", "(a, axis=None)", "The median.", ["np.median([3, 1, 4, 1, 5])"]),
    ("numpy.std", "(a, axis=None, ddof=0)", "The standard deviation (ddof=1 for the sample's).", ["np.std([2, 4, 4, 4, 5, 5, 7, 9])", "np.std([1, 2, 3, 4], ddof=1)"]),
    ("numpy.var", "(a, axis=None, ddof=0)", "The variance.", ["np.var([1, 2, 3, 4])"]),
    ("numpy.percentile", "(a, q, axis=None, method='linear')", "The q-th percentiles.", ["np.percentile([1, 2, 3, 4, 5], [25, 50, 90])"]),
    ("numpy.quantile", "(a, q, axis=None, method='linear')", "The q-th quantiles, q in [0, 1].", ["np.quantile(np.arange(11), 0.35)"]),
    ("numpy.nanmean", "(a, axis=None)", "The mean, ignoring nan.", ["np.nanmean([1, np.nan, 3])"]),
    ("numpy.nansum", "(a, axis=None)", "The sum, treating nan as zero.", ["np.nansum([1, np.nan, 3])"]),
    ("numpy.nanmax", "(a, axis=None)", "The largest element, ignoring nan.", ["np.nanmax([1, np.nan, 3])"]),
    ("numpy.cov", "(m, y=None, rowvar=True, ddof=None)", "The covariance matrix of variables (rows) observed in columns.",
     ["np.cov([[1, 2, 3], [2, 4, 7]])"]),
    ("numpy.corrcoef", "(x, y=None, rowvar=True)", "Pearson correlation coefficients.", ["np.corrcoef([1, 2, 3, 4], [2, 4, 5, 9])"]),
    ("numpy.histogram", "(a, bins=10, range=None, density=False)", "Counts of the values in bins, and the bins' edges.",
     ["np.histogram([1, 2, 2, 3, 3, 3], bins=3)"]),
    ("numpy.bincount", "(x, weights=None, minlength=0)", "How many times each non-negative integer occurs.", ["np.bincount([0, 1, 1, 3])"]),
    ("numpy.digitize", "(x, bins, right=False)", "The index of the bin each value falls in.", ["np.digitize([0.5, 1.5, 3.2], [0, 1, 2, 3])"]),
    ("numpy.count_nonzero", "(a, axis=None)", "How many elements are not zero.", ["np.count_nonzero([[0, 1], [2, 0]])"]),
    ("numpy.all", "(a, axis=None)", "Whether every element is true.", ["np.all([[True, False], [True, True]], axis=0)"]),
    ("numpy.any", "(a, axis=None)", "Whether some element is true.", ["np.any([0, 0, 3])"]),
    ("numpy.trapezoid", "(y, x=None, dx=1.0, axis=-1)", "The integral of sampled values by the trapezoid rule.",
     ["x = np.linspace(0, 1, 101)\nnp.trapezoid(x ** 2, x)"]),
    # ---------------------------------------------------------------- numpy: sorting, searching, sets
    ("numpy.sort", "(a, axis=-1)", "A sorted copy.", ["np.sort([3, 1, 2])", "np.sort([[3, 1], [0, 2]], axis=0)"]),
    ("numpy.argsort", "(a, axis=-1)", "The indices that sort an array.", ["np.argsort([30, 10, 20])"]),
    ("numpy.lexsort", "(keys)", "The indices that sort by several keys (the last key first).", ["np.lexsort(([1, 2, 1], [0, 0, 1]))"]),
    ("numpy.searchsorted", "(a, v, side='left')", "Where values would be inserted to keep a sorted array sorted.",
     ["np.searchsorted([1, 3, 5, 7], [4, 7])"]),
    ("numpy.nonzero", "(a)", "The indices of the elements that are not zero.", ["np.nonzero([[1, 0], [0, 2]])"]),
    ("numpy.argwhere", "(a)", "The indices of the non-zero elements, one row each.", ["np.argwhere(np.arange(6).reshape(2, 3) > 3)"]),
    ("numpy.unique", "(ar, return_index=False, return_inverse=False, return_counts=False)", "The sorted distinct elements (and how often each occurs).",
     ["np.unique([3, 1, 3, 2, 1])", "np.unique([3, 1, 3, 2, 1], return_counts=True)"]),
    ("numpy.isin", "(element, test_elements)", "Whether each element is among the test elements.", ["np.isin([1, 2, 3, 4], [2, 4])"]),
    ("numpy.intersect1d", "(ar1, ar2)", "The sorted common elements.", ["np.intersect1d([1, 2, 3, 4], [3, 4, 5])"]),
    ("numpy.union1d", "(ar1, ar2)", "The sorted elements of either.", ["np.union1d([1, 2], [2, 5])"]),
    ("numpy.setdiff1d", "(ar1, ar2)", "The sorted elements of ar1 not in ar2.", ["np.setdiff1d([1, 2, 3, 4], [2, 4])"]),
    # ---------------------------------------------------------------- numpy: comparison and logic
    ("numpy.allclose", "(a, b, rtol=1e-05, atol=1e-08)", "Whether two arrays are equal within a tolerance.", ["np.allclose([1.0, 2.0], [1.0, 2.0 + 1e-9])"]),
    ("numpy.isclose", "(a, b, rtol=1e-05, atol=1e-08)", "Elementwise equality within a tolerance.", ["np.isclose([1.0, 2.0], [1.0, 2.1])"]),
    ("numpy.array_equal", "(a1, a2)", "Whether two arrays have the same shape and elements.", ["np.array_equal([1, 2], [1, 2])"]),
    ("numpy.logical_and", "(x1, x2)", "Elementwise logical and.", ["np.logical_and([True, True, False], [True, False, False])"]),
    ("numpy.logical_not", "(x)", "Elementwise logical not.", ["np.logical_not([True, False])"]),
    # ---------------------------------------------------------------- numpy: products and linear algebra helpers
    ("numpy.dot", "(a, b)", "The dot product: of vectors, or matrix products of 2-D arrays.", ["np.dot([1, 2, 3], [4, 5, 6])", "np.dot([[1, 2], [3, 4]], [1, 1])"]),
    ("numpy.matmul", "(x1, x2)", "The matrix product (the @ operator).", ["np.array([[1, 2], [3, 4]]) @ np.array([[0, 1], [1, 0]])"]),
    ("numpy.inner", "(a, b)", "The inner product of vectors.", ["np.inner([1, 2], [3, 4])"]),
    ("numpy.outer", "(a, b)", "The outer product of two vectors.", ["np.outer([1, 2], [1, 10, 100])"]),
    ("numpy.cross", "(a, b)", "The cross product of 3-vectors.", ["np.cross([1, 0, 0], [0, 1, 0])"]),
    ("numpy.vdot", "(a, b)", "The dot product, conjugating the first vector.", ["np.vdot([1j, 2], [1j, 3])"]),
    ("numpy.kron", "(a, b)", "The Kronecker product.", ["np.kron([[1, 2], [3, 4]], [[1, 1]])"]),
    ("numpy.tensordot", "(a, b, axes=2)", "Sums of products over the given axes.", ["np.tensordot(np.arange(6).reshape(2, 3), np.arange(3), axes=1)"]),
    ("numpy.einsum", "(subscripts, *operands)", "Products and sums written in Einstein's summation notation.",
     ["np.einsum('ij,j->i', [[1, 2], [3, 4]], [10, 1])", "np.einsum('ij,ij->', [[1, 2], [3, 4]], [[1, 0], [0, 1]])"]),
    ("numpy.trace", "(a, offset=0)", "The sum along a diagonal.", ["np.trace([[1, 2], [3, 4]])"]),
    ("numpy.convolve", "(a, v, mode='full')", "The discrete convolution of two sequences (polynomial multiplication).", ["np.convolve([1, 2], [1, 3, 1])"]),
    ("numpy.correlate", "(a, v, mode='valid')", "The cross-correlation of two sequences.", ["np.correlate([1, 2, 3], [0, 1, 0.5], mode='same')"]),
    # ---------------------------------------------------------------- numpy: polynomials (the classic functions)
    ("numpy.polyval", "(p, x)", "A polynomial (highest power first) evaluated at x.", ["np.polyval([1, 0, -2], [0, 1, 2])"]),
    ("numpy.polyfit", "(x, y, deg)", "The least-squares polynomial of degree deg through the points (highest power first).",
     ["np.polyfit([0, 1, 2, 3], [1, 3, 5, 7], 1)"]),
    ("numpy.roots", "(p)", "The roots of a polynomial (highest power first).", ["np.roots([1, -3, 2])"]),
    ("numpy.poly", "(seq_of_zeros)", "The coefficients of the polynomial with the given roots.", ["np.poly([1, 2])"]),
    ("numpy.polyder", "(p, m=1)", "The derivative of a polynomial.", ["np.polyder([1, 2, 3])"]),
    ("numpy.polyint", "(p, m=1, k=None)", "An antiderivative of a polynomial.", ["np.polyint([3, 2, 1])"]),
    ("numpy.polyadd", "(a1, a2)", "The sum of two polynomials.", ["np.polyadd([1, 2], [1, 0, 0])"]),
    ("numpy.polymul", "(a1, a2)", "The product of two polynomials.", ["np.polymul([1, 1], [1, -1])"]),
    ("numpy.polydiv", "(u, v)", "The quotient and remainder of polynomial division.", ["np.polydiv([1, 0, -1], [1, 1])"]),
    ("numpy.poly1d", "(c_or_r, r=False)", "A polynomial object (highest power first), callable.", ["p = np.poly1d([1, 0, -2])\np(3)", "print(np.poly1d([2, -3, 1]))"]),
    ("numpy.polynomial.Polynomial", "(coef)", "A polynomial in the power basis (lowest power first), with fit, roots, deriv and integ.",
     ["P = np.polynomial.Polynomial([1, 2, 3])\nP(2)", "np.polynomial.Polynomial([-1, 0, 1]).roots()"]),
    # ---------------------------------------------------------------- numpy: types and printing
    ("numpy.dtype", "(obj)", "A data type: float64, int64, complex128, bool, ...", ["np.dtype('float32')", "np.arange(3).dtype"]),
    ("numpy.finfo", "(dtype)", "The limits of a floating-point type.", ["np.finfo(np.float64).eps"]),
    ("numpy.iinfo", "(dtype)", "The limits of an integer type.", ["np.iinfo(np.int8).max"]),
    ("numpy.set_printoptions", "(precision=None, threshold=None, edgeitems=None, linewidth=None, suppress=None, ...)", "How arrays print: digits, summarizing, line width, ...",
     ["with np.printoptions(precision=3):\n    print(np.array([1 / 3, 2 / 3]))"]),
    ("numpy.format_float_positional", "(x, precision=None, unique=True, trim='k', ...)", "A float in positional notation, as NumPy formats it.",
     ["np.format_float_positional(1 / 3, precision=5)"]),
    ("numpy.format_float_scientific", "(x, precision=None, unique=True, exp_digits=None, ...)", "A float in scientific notation, as NumPy formats it.",
     ["np.format_float_scientific(12345.678, precision=2)"]),
    ("numpy.errstate", "(**kwargs)", "A context in which floating-point errors are handled as asked.",
     ["with np.errstate(divide='ignore'):\n    print(np.array([1.0]) / 0)"]),
    # ---------------------------------------------------------------- numpy.linalg
    ("numpy.linalg.solve", "(a, b)", "The solution x of the linear system a x = b.", ["np.linalg.solve([[3, 1], [1, 2]], [9, 8])"]),
    ("numpy.linalg.inv", "(a)", "The inverse of a matrix.", ["np.linalg.inv([[1.0, 2.0], [3.0, 4.0]])"]),
    ("numpy.linalg.det", "(a)", "The determinant.", ["round(np.linalg.det([[1, 2], [3, 4]]), 10)"]),
    ("numpy.linalg.eig", "(a)", "Eigenvalues and right eigenvectors.", ["w, v = np.linalg.eig([[2.0, 0.0], [0.0, 3.0]])\nw"]),
    ("numpy.linalg.eigh", "(a, UPLO='L')", "Eigenvalues (ascending) and eigenvectors of a symmetric or Hermitian matrix.",
     ["w, v = np.linalg.eigh([[2.0, 1.0], [1.0, 2.0]])\nw"]),
    ("numpy.linalg.eigvals", "(a)", "The eigenvalues of a matrix.", ["np.linalg.eigvals([[0.0, 1.0], [-2.0, -3.0]])"]),
    ("numpy.linalg.svd", "(a, full_matrices=True, compute_uv=True)", "The singular value decomposition u s vh.",
     ["np.linalg.svd([[3.0, 0.0], [0.0, 4.0]], compute_uv=False)"]),
    ("numpy.linalg.qr", "(a, mode='reduced')", "The QR decomposition.", ["q, r = np.linalg.qr([[3.0, 1.0], [4.0, 2.0]])\nnp.round(abs(r), 6)"]),
    ("numpy.linalg.cholesky", "(a)", "The lower-triangular Cholesky factor L, a = L L^H.", ["np.linalg.cholesky([[4.0, 2.0], [2.0, 3.0]])"]),
    ("numpy.linalg.norm", "(x, ord=None, axis=None)", "A vector or matrix norm.", ["np.linalg.norm([3, 4])", "np.linalg.norm([[1, 2], [3, 4]], 'fro')"]),
    ("numpy.linalg.matrix_rank", "(A, tol=None)", "The rank of a matrix.", ["np.linalg.matrix_rank([[1, 2], [2, 4]])"]),
    ("numpy.linalg.matrix_power", "(a, n)", "A matrix raised to an integer power.", ["np.linalg.matrix_power([[1, 1], [1, 0]], 10)"]),
    ("numpy.linalg.lstsq", "(a, b, rcond=None)", "The least-squares solution of a x = b.",
     ["x, res, rank, sv = np.linalg.lstsq([[1, 0], [1, 1], [1, 2]], [1, 2, 4])\nx"]),
    ("numpy.linalg.pinv", "(a)", "The Moore-Penrose pseudo-inverse.", ["np.linalg.pinv([[1.0, 2.0], [2.0, 4.0]])"]),
    ("numpy.linalg.cond", "(x, p=None)", "The condition number of a matrix.", ["np.linalg.cond([[1, 0], [0, 4]])"]),
    ("numpy.linalg.slogdet", "(a)", "The sign and the log of the absolute value of the determinant.", ["np.linalg.slogdet([[2.0, 0.0], [0.0, 3.0]])"]),
    ("numpy.linalg.multi_dot", "(arrays)", "The product of several matrices, in the cheapest order.", ["np.linalg.multi_dot([[[1, 2]], [[3], [4]], [[5]]])"]),
    # ---------------------------------------------------------------- numpy.fft
    ("numpy.fft.fft", "(a, n=None, axis=-1, norm=None)", "The discrete Fourier transform.", ["np.fft.fft([1, 0, -1, 0])"]),
    ("numpy.fft.ifft", "(a, n=None, axis=-1, norm=None)", "The inverse discrete Fourier transform.", ["np.fft.ifft([0, 2, 0, 2]).real"]),
    ("numpy.fft.rfft", "(a, n=None, axis=-1, norm=None)", "The Fourier transform of real input (the non-negative frequencies).", ["np.fft.rfft([1, 2, 3, 4])"]),
    ("numpy.fft.irfft", "(a, n=None, axis=-1, norm=None)", "The inverse of rfft.", ["np.fft.irfft([10, -2 + 2j, -2])"]),
    ("numpy.fft.fft2", "(a, s=None, axes=(-2, -1))", "The 2-D discrete Fourier transform.", ["np.fft.fft2([[1, 1], [1, 1]])"]),
    ("numpy.fft.fftfreq", "(n, d=1.0)", "The sample frequencies of an n-point transform.", ["np.fft.fftfreq(4, d=0.5)"]),
    ("numpy.fft.rfftfreq", "(n, d=1.0)", "The sample frequencies of rfft's output.", ["np.fft.rfftfreq(6)"]),
    ("numpy.fft.fftshift", "(x, axes=None)", "The spectrum with the zero frequency moved to the center.", ["np.fft.fftshift(np.fft.fftfreq(5))"]),
    # ---------------------------------------------------------------- numpy.random
    ("numpy.random.default_rng", "(seed=None)", "A random Generator (PCG64), NumPy's recommended source of random numbers.",
     ["rng = np.random.default_rng(42)\nrng.integers(0, 10, size=5)"]),
    ("numpy.random.Generator.random", "(size=None)", "Uniform floats in [0, 1).", ["np.random.default_rng(0).random(3)"]),
    ("numpy.random.Generator.integers", "(low, high=None, size=None, endpoint=False)", "Random integers in [low, high).", ["np.random.default_rng(1).integers(1, 7, size=6)"]),
    ("numpy.random.Generator.normal", "(loc=0.0, scale=1.0, size=None)", "Samples of a normal (Gaussian) distribution.", ["np.random.default_rng(2).normal(10, 2, size=3)"]),
    ("numpy.random.Generator.uniform", "(low=0.0, high=1.0, size=None)", "Samples of a uniform distribution on [low, high).", ["np.random.default_rng(3).uniform(-1, 1, size=2)"]),
    ("numpy.random.Generator.choice", "(a, size=None, replace=True, p=None)", "A random sample of the elements of a.",
     ["np.random.default_rng(4).choice([10, 20, 30], size=4, p=[0.5, 0.25, 0.25])", "np.random.default_rng(4).choice(10, size=3, replace=False)"]),
    ("numpy.random.Generator.permutation", "(x)", "A randomly permuted copy, or a permutation of range(x).", ["np.random.default_rng(5).permutation(5)"]),
    ("numpy.random.Generator.shuffle", "(x)", "Shuffles an array in place.", ["a = np.arange(5)\nnp.random.default_rng(6).shuffle(a)\na"]),
    ("numpy.random.Generator.exponential", "(scale=1.0, size=None)", "Samples of an exponential distribution.", ["np.random.default_rng(7).exponential(2.0, size=2)"]),
    ("numpy.random.Generator.poisson", "(lam=1.0, size=None)", "Samples of a Poisson distribution.", ["np.random.default_rng(8).poisson(3, size=5)"]),
    ("numpy.random.seed", "(seed=None)", "Seeds the legacy global generator (MT19937), for np.random.rand and friends.",
     ["np.random.seed(0)\nnp.random.rand(2)"]),
    ("numpy.random.rand", "(*shape)", "Uniform floats in [0, 1) of the given shape (legacy).", ["np.random.seed(1)\nnp.random.rand(2, 2)"]),
    ("numpy.random.randn", "(*shape)", "Standard normal samples of the given shape (legacy).", ["np.random.seed(2)\nnp.random.randn(3)"]),
    ("numpy.random.randint", "(low, high=None, size=None)", "Random integers in [low, high) (legacy).", ["np.random.seed(3)\nnp.random.randint(0, 100, 4)"]),
    # ---------------------------------------------------------------- scipy.integrate
    ("scipy.integrate.quad", "(func, a, b, args=(), epsabs=1.49e-08, epsrel=1.49e-08, limit=50)", "The integral of func from a to b (QUADPACK's adaptive rules), and an error estimate.",
     ["from scipy.integrate import quad\nquad(lambda x: x ** 2, 0, 3)", "from scipy.integrate import quad\nquad(lambda x: np.exp(-x), 0, np.inf)[0]"]),
    ("scipy.integrate.odeint", "(func, y0, t, args=(), rtol=None, atol=None, tfirst=False)", "The solution of dy/dt = func(y, t) at the times t (LSODA).",
     ["from scipy.integrate import odeint\nt = np.linspace(0, 1, 3)\nnp.round(odeint(lambda y, t: -y, 1.0, t)[:, 0], 6)"]),
    ("scipy.integrate.solve_ivp", "(fun, t_span, y0, method='RK45', t_eval=None, dense_output=False, events=None, rtol=1e-3, atol=1e-6)", "The solution of an initial value problem dy/dt = fun(t, y) (RK45, RK23, DOP853, Radau, BDF, LSODA).",
     ["from scipy.integrate import solve_ivp\nsol = solve_ivp(lambda t, y: -2 * y, [0, 1], [1.0], t_eval=[0, 0.5, 1], rtol=1e-8)\nnp.round(sol.y[0], 6)"]),
    ("scipy.integrate.trapezoid", "(y, x=None, dx=1.0, axis=-1)", "The integral of samples by the trapezoid rule.",
     ["from scipy.integrate import trapezoid\ntrapezoid([0, 1, 4, 9], dx=1.0)"]),
    ("scipy.integrate.simpson", "(y, x=None, dx=1.0, axis=-1)", "The integral of samples by Simpson's rule.",
     ["from scipy.integrate import simpson\nx = np.linspace(0, 2, 5)\nsimpson(x ** 3, x=x)"]),
    ("scipy.integrate.cumulative_trapezoid", "(y, x=None, dx=1.0, axis=-1, initial=None)", "The running integral of samples by the trapezoid rule.",
     ["from scipy.integrate import cumulative_trapezoid\ncumulative_trapezoid([1, 2, 3, 4], initial=0)"]),
    ("scipy.integrate.dblquad", "(func, a, b, gfun, hfun)", "The double integral of func(y, x), x from a to b, y from gfun(x) to hfun(x).",
     ["from scipy.integrate import dblquad\ndblquad(lambda y, x: x * y, 0, 1, 0, 2)[0]"]),
    ("scipy.io.loadmat", "(file_name, mdict=None, squeeze_me=False)", "The variables of a MATLAB .mat file, as a dict of arrays.", []),
    ("scipy.io.savemat", "(file_name, mdict, oned_as='row')", "Writes a dict of arrays to a MATLAB .mat file.", []),
    # ---------------------------------------------------------------- math
    ("math.sqrt", "(x)", "The square root of x.", ["math.sqrt(2)"]),
    ("math.isqrt", "(n)", "The integer square root of a non-negative integer.", ["math.isqrt(10**20 + 1)"]),
    ("math.exp", "(x)", "e raised to the power x.", ["math.exp(1)"]),
    ("math.log", "(x, base=e)", "The logarithm of x, natural or to a base.", ["math.log(100, 10)", "math.log(math.e)"]),
    ("math.log10", "(x)", "The base-10 logarithm.", ["math.log10(0.001)"]),
    ("math.log2", "(x)", "The base-2 logarithm.", ["math.log2(1024)"]),
    ("math.pow", "(x, y)", "x raised to the power y, as floats.", ["math.pow(2, 0.5)"]),
    ("math.sin", "(x)", "The sine of x (radians).", ["math.sin(math.pi / 6)"]),
    ("math.cos", "(x)", "The cosine of x (radians).", ["math.cos(math.pi / 3)"]),
    ("math.tan", "(x)", "The tangent of x (radians).", ["math.tan(math.pi / 4)"]),
    ("math.atan2", "(y, x)", "The angle of the point (x, y), in radians.", ["math.atan2(1, -1)"]),
    ("math.hypot", "(*coordinates)", "The Euclidean norm, sqrt(sum of squares).", ["math.hypot(3, 4, 12)"]),
    ("math.dist", "(p, q)", "The Euclidean distance between two points.", ["math.dist((0, 0), (3, 4))"]),
    ("math.degrees", "(x)", "Radians converted to degrees.", ["math.degrees(math.pi / 2)"]),
    ("math.radians", "(x)", "Degrees converted to radians.", ["math.radians(180)"]),
    ("math.floor", "(x)", "The largest integer <= x.", ["math.floor(-2.5)"]),
    ("math.ceil", "(x)", "The smallest integer >= x.", ["math.ceil(2.1)"]),
    ("math.trunc", "(x)", "x truncated toward zero, as an integer.", ["math.trunc(-2.7)"]),
    ("math.fabs", "(x)", "The absolute value, as a float.", ["math.fabs(-3)"]),
    ("math.factorial", "(n)", "n! (exact).", ["math.factorial(20)"]),
    ("math.comb", "(n, k)", "The number of ways to choose k items from n.", ["math.comb(10, 3)"]),
    ("math.perm", "(n, k=None)", "The number of ordered ways to choose k items from n.", ["math.perm(5, 2)"]),
    ("math.gcd", "(*integers)", "The greatest common divisor.", ["math.gcd(84, 36, 60)"]),
    ("math.lcm", "(*integers)", "The least common multiple.", ["math.lcm(4, 6, 10)"]),
    ("math.fsum", "(iterable)", "An accurate floating-point sum.", ["math.fsum([0.1] * 10)", "sum([0.1] * 10)"]),
    ("math.prod", "(iterable, start=1)", "The product of the elements.", ["math.prod([1, 2, 3, 4])"]),
    ("math.isclose", "(a, b, rel_tol=1e-09, abs_tol=0.0)", "Whether two values are close.", ["math.isclose(0.1 + 0.2, 0.3)"]),
    ("math.isnan", "(x)", "Whether x is nan.", ["math.isnan(float('nan'))"]),
    ("math.isinf", "(x)", "Whether x is infinite.", ["math.isinf(-math.inf)"]),
    ("math.copysign", "(x, y)", "The magnitude of x with the sign of y.", ["math.copysign(3, -0.0)"]),
    ("math.fmod", "(x, y)", "The remainder of x / y with the sign of x (C's fmod).", ["math.fmod(-7, 3)", "-7 % 3"]),
    ("math.remainder", "(x, y)", "The IEEE 754 remainder of x by y: x - n*y with n the integer nearest x / y (ties to even).",
     ["math.remainder(7, 3)", "math.remainder(7.5, 2)"]),
    ("math.modf", "(x)", "The fractional and integer parts of x.", ["math.modf(3.75)"]),
    ("math.frexp", "(x)", "The mantissa and exponent of x: x = m * 2**e.", ["math.frexp(40.0)"]),
    ("math.ldexp", "(x, i)", "x * 2**i.", ["math.ldexp(0.625, 6)"]),
    ("math.erf", "(x)", "The error function.", ["math.erf(1)"]),
    ("math.gamma", "(x)", "The Gamma function.", ["math.gamma(5.5)"]),
    ("math.lgamma", "(x)", "The natural log of the absolute value of the Gamma function.", ["math.lgamma(100)"]),
    ("math.nextafter", "(x, y)", "The next float after x toward y.", ["math.nextafter(1.0, 2.0)"]),
    ("math.ulp", "(x)", "The value of the least significant bit of x.", ["math.ulp(1.0)"]),
    # ---------------------------------------------------------------- cmath
    ("cmath.sqrt", "(z)", "The complex square root.", ["cmath.sqrt(-4)"]),
    ("cmath.exp", "(z)", "The complex exponential.", ["cmath.exp(1j * math.pi)"]),
    ("cmath.log", "(z, base=e)", "The complex logarithm.", ["cmath.log(-1)"]),
    ("cmath.phase", "(z)", "The argument of z, in (-pi, pi].", ["cmath.phase(-1 + 0j)"]),
    ("cmath.polar", "(z)", "z as (modulus, argument).", ["cmath.polar(1j)"]),
    ("cmath.rect", "(r, phi)", "The complex number with modulus r and argument phi.", ["cmath.rect(2, math.pi / 2)"]),
    ("cmath.isclose", "(a, b, rel_tol=1e-09, abs_tol=0.0)", "Whether two complex values are close.", ["cmath.isclose(cmath.exp(1j * math.pi), -1)"]),
    # ---------------------------------------------------------------- fractions
    ("fractions.Fraction", "(numerator=0, denominator=None)", "An exact rational number, from integers, a string or a float.",
     ["Fraction(3, 4) + Fraction(1, 6)", "Fraction('1.25')", "Fraction(0.1)"]),
    ("fractions.Fraction.limit_denominator", "(max_denominator=1000000)", "The closest fraction with a denominator at most max_denominator.",
     ["Fraction(math.pi).limit_denominator(100)"]),
    # ---------------------------------------------------------------- itertools
    ("itertools.product", "(*iterables, repeat=1)", "The Cartesian product, as tuples.", ["list(itertools.product('ab', [1, 2]))"]),
    ("itertools.permutations", "(iterable, r=None)", "The orderings of r elements.", ["list(itertools.permutations([1, 2, 3], 2))"]),
    ("itertools.combinations", "(iterable, r)", "The subsets of r elements, in order.", ["list(itertools.combinations('abcd', 2))"]),
    ("itertools.combinations_with_replacement", "(iterable, r)", "Combinations in which an element may repeat.", ["list(itertools.combinations_with_replacement('ab', 2))"]),
    ("itertools.accumulate", "(iterable, func=operator.add, initial=None)", "Running totals (or of another function).", ["list(itertools.accumulate([1, 2, 3, 4]))", "list(itertools.accumulate([3, 1, 4, 1, 5], max))"]),
    ("itertools.chain", "(*iterables)", "The elements of each iterable in turn.", ["list(itertools.chain([1, 2], 'ab'))"]),
    ("itertools.count", "(start=0, step=1)", "Numbers counting up forever.", ["list(itertools.islice(itertools.count(10, 5), 4))"]),
    ("itertools.cycle", "(iterable)", "The elements repeated forever.", ["list(itertools.islice(itertools.cycle('ab'), 5))"]),
    ("itertools.repeat", "(object, times=None)", "An object over and over.", ["list(itertools.repeat(7, 3))"]),
    ("itertools.islice", "(iterable, stop) or (iterable, start, stop, step=1)", "A slice of an iterator.", ["list(itertools.islice(range(100), 2, 10, 3))"]),
    ("itertools.groupby", "(iterable, key=None)", "Runs of consecutive equal (or equal-key) elements.",
     ["[(k, len(list(g))) for k, g in itertools.groupby('aaabccdd')]"]),
    ("itertools.pairwise", "(iterable)", "Consecutive overlapping pairs.", ["list(itertools.pairwise([1, 4, 9, 16]))"]),
    ("itertools.zip_longest", "(*iterables, fillvalue=None)", "zip, continuing to the longest input.", ["list(itertools.zip_longest([1, 2, 3], 'ab', fillvalue='-'))"]),
    ("itertools.starmap", "(function, iterable)", "function applied to each tuple of arguments.", ["list(itertools.starmap(pow, [(2, 3), (3, 2)]))"]),
    ("itertools.takewhile", "(predicate, iterable)", "Elements while a condition holds.", ["list(itertools.takewhile(lambda x: x < 5, [1, 3, 6, 2]))"]),
    # ---------------------------------------------------------------- functools
    ("functools.reduce", "(function, iterable[, initial])", "A sequence folded into one value by a two-argument function.", ["functools.reduce(lambda a, b: a * b, [1, 2, 3, 4, 5])"]),
    ("functools.partial", "(func, *args, **keywords)", "A function with some arguments fixed.", ["int2 = functools.partial(int, base=2)\nint2('1011')"]),
    ("functools.lru_cache", "(maxsize=128)", "A decorator that remembers a function's results.",
     ["@functools.lru_cache(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nfib(80)"]),
    ("functools.cache", "(user_function)", "A decorator that remembers all of a function's results.",
     ["@functools.cache\ndef f(n):\n    return n * n\n[f(3), f(3), f.cache_info().hits]"]),
    # ---------------------------------------------------------------- collections
    ("collections.Counter", "(iterable=None)", "Counts of hashable items, a dict subclass.", ["collections.Counter('mississippi').most_common(2)"]),
    ("collections.defaultdict", "(default_factory)", "A dict that creates missing values with a factory.",
     ["d = collections.defaultdict(list)\nd['a'].append(1)\ndict(d)"]),
    ("collections.deque", "(iterable=(), maxlen=None)", "A double-ended queue.", ["d = collections.deque([1, 2, 3], maxlen=3)\nd.append(4)\nd"]),
    ("collections.namedtuple", "(typename, field_names)", "A tuple subclass with named fields.", ["P = collections.namedtuple('P', 'x y')\nP(1, 2)._replace(y=5)"]),
    ("collections.OrderedDict", "(items)", "A dict that remembers insertion order, with move_to_end.",
     ["d = collections.OrderedDict(a=1, b=2)\nd.move_to_end('a')\nlist(d)"]),
    # ---------------------------------------------------------------- random, bisect, heapq
    ("random.seed", "(a=None)", "Seeds Python's random generator (Mersenne Twister).", ["random.seed(1)\nrandom.random()"]),
    ("random.randint", "(a, b)", "A random integer in [a, b].", ["random.seed(2)\n[random.randint(1, 6) for _ in range(5)]"]),
    ("random.choice", "(seq)", "A random element of a sequence.", ["random.seed(3)\nrandom.choice('abcdef')"]),
    ("random.shuffle", "(x)", "Shuffles a list in place.", ["random.seed(4)\nx = list(range(6))\nrandom.shuffle(x)\nx"]),
    ("random.uniform", "(a, b)", "A random float between a and b.", ["random.seed(5)\nrandom.uniform(10, 20)"]),
    ("bisect.bisect_left", "(a, x)", "Where x would be inserted to keep the sorted list a sorted (before equal elements).",
     ["bisect.bisect_left([1, 2, 4, 4, 8], 4)"]),
    ("bisect.insort", "(a, x)", "x inserted into a sorted list, keeping it sorted.", ["a = [1, 3, 5]\nbisect.insort(a, 4)\na"]),
    ("heapq.heappush", "(heap, item)", "An item pushed onto a heap (a list with the smallest first).",
     ["h = []\nfor x in [5, 1, 4, 2]:\n    heapq.heappush(h, x)\n[heapq.heappop(h) for _ in range(4)]"]),
    ("heapq.nlargest", "(n, iterable, key=None)", "The n largest elements.", ["heapq.nlargest(2, [5, 1, 8, 3])"]),
    ("heapq.nsmallest", "(n, iterable, key=None)", "The n smallest elements.", ["heapq.nsmallest(2, [5, 1, 8, 3])"]),
]

# The other public functions and classes: a summary each (no example)
SUMMARIES = {
    # matplotlib: pyplot (on the current figure and axes), Axes and Figure
    "matplotlib.axes.Axes.annotate": "A text annotation at a point, with an optional arrow to it from the text's position.",
    "matplotlib.axes.Axes.axhline": "A horizontal line across the axes at height y.",
    "matplotlib.axes.Axes.axis": "Sets the limits from [xmin, xmax, ymin, ymax]; 'off' hides the axes, and 'equal', 'scaled' or 'square' give equal units. Returns None, where matplotlib returns the limits.",
    "matplotlib.axes.Axes.axvline": "A vertical line across the axes at x.",
    "matplotlib.axes.Axes.bar": "A bar chart: bars at x with the given heights (width, bottom, color, label).",
    "matplotlib.axes.Axes.barh": "A horizontal bar chart: bars at y with the given widths.",
    "matplotlib.axes.Axes.cla": "Clear the axes: their plots, limits and labels.",
    "matplotlib.axes.Axes.clear": "Clear the axes: their plots, limits and labels.",
    "matplotlib.axes.Axes.contourf": "Filled contours of a 2D array Z over a grid (levels, cmap).",
    "matplotlib.axes.Axes.errorbar": "Points with error bars (yerr, xerr), optionally joined by lines.",
    "matplotlib.axes.Axes.fill_between": "Fill the region between two curves y1 and y2 (y2 = 0 by default) over x.",
    "matplotlib.axes.Axes.get_position": "The axes' position in the figure, as fractions (left, bottom, width, height).",
    "matplotlib.axes.Axes.get_xlim": "The x axis's limits (left, right).",
    "matplotlib.axes.Axes.get_ylim": "The y axis's limits (bottom, top).",
    "matplotlib.axes.Axes.get_yticks": "The positions of the y axis's ticks.",
    "matplotlib.axes.Axes.grid": "Show or hide the grid lines.",
    "matplotlib.axes.Axes.hist": "A histogram of the data: counts in bins (bins, range, density, cumulative, histtype); returns (n, bins, patches).",
    "matplotlib.axes.Axes.imshow": "An image of a 2D array (through a colormap) or an RGB(A) array.",
    "matplotlib.axes.Axes.legend": "A legend of the labelled lines, markers and patches (loc).",
    "matplotlib.axes.Axes.pie": "A pie chart of the values (labels, colors, autopct, startangle).",
    "matplotlib.axes.Axes.plot": "Lines and/or markers through the points: plot(y), plot(x, y), with a format string such as 'r--o'.",
    "matplotlib.axes.Axes.scatter": "Markers at the points (x, y), with sizes s and colors c (through a colormap when numbers).",
    "matplotlib.axes.Axes.set": "Set several properties at once: set(xlabel=..., ylim=..., title=...) calls set_xlabel, set_ylim, set_title.",
    "matplotlib.axes.Axes.set_aspect": "The ratio of a unit of y to a unit of x on screen ('equal' for 1, or 'auto').",
    "matplotlib.axes.Axes.set_rasterization_zorder": "Accepted and does nothing in Sagebrush (its filled contours are drawn as pictures already).",
    "matplotlib.axes.Axes.set_title": "The axes' title.",
    "matplotlib.axes.Axes.set_xlabel": "The x axis's label.",
    "matplotlib.axes.Axes.set_xlim": "The x axis's limits: set_xlim(left, right), or one of them; left > right inverts the axis.",
    "matplotlib.axes.Axes.set_xscale": "The x axis's scale: 'linear' or 'log'.",
    "matplotlib.axes.Axes.set_xticklabels": "The labels of the x axis's ticks.",
    "matplotlib.axes.Axes.set_xticks": "The positions of the x axis's ticks (and their labels).",
    "matplotlib.axes.Axes.set_ylabel": "The y axis's label.",
    "matplotlib.axes.Axes.set_ylim": "The y axis's limits: set_ylim(bottom, top), or one of them; bottom > top inverts the axis.",
    "matplotlib.axes.Axes.set_yscale": "The y axis's scale: 'linear' or 'log'.",
    "matplotlib.axes.Axes.set_yticklabels": "The labels of the y axis's ticks.",
    "matplotlib.axes.Axes.set_yticks": "The positions of the y axis's ticks (and their labels).",
    "matplotlib.axes.Axes.stem": "A stem plot: a vertical line from the baseline to each point, with a marker on top.",
    "matplotlib.axes.Axes.step": "A step plot: a staircase through the points (where='pre', 'post' or 'mid').",
    "matplotlib.axes.Axes.text": "Text at the point (x, y) in data coordinates.",
    "matplotlib.axes.Axes.tick_params": "The tick labels' size (labelsize); Sagebrush applies no other option.",
    "matplotlib.figure.Figure.add_gridspec": "A GridSpec of rows and columns in this figure, for placing subplots.",
    "matplotlib.figure.Figure.add_subplot": "Axes at one place of a grid: add_subplot(nrows, ncols, index) or add_subplot(111).",
    "matplotlib.figure.Figure.clear": "Remove the figure's axes.",
    "matplotlib.figure.Figure.clf": "Remove the figure's axes.",
    "matplotlib.figure.Figure.colorbar": "A colorbar for an image, contour set or scatter (mappable) beside its axes.",
    "matplotlib.figure.Figure.description": "A text description of the figure as drawn (Sagebrush's: its axes, plots and labels).",
    "matplotlib.figure.Figure.gca": "The figure's current axes (made if there are none).",
    "matplotlib.figure.Figure.set_size_inches": "The figure's size in inches: set_size_inches(w, h).",
    "matplotlib.figure.Figure.show": "Show the figure in the notebook or board now.",
    "matplotlib.figure.Figure.suptitle": "A title above all the figure's axes.",
    "matplotlib.figure.Figure.tight_layout": "Accepted: Sagebrush lays out the axes' labels without overlap already.",
    "matplotlib.pyplot.Axes": "A set of axes in a figure: what subplots and gca return, with the plotting methods.",
    "matplotlib.pyplot.Figure": "A figure: the axes in it, its size, and savefig.",
    "matplotlib.pyplot.GridSpec": "A grid of rows and columns for placing subplots (spans by slicing).",
    "matplotlib.pyplot.Line2D": "A line drawn by plot: its data, color, style and label.",
    "matplotlib.pyplot.annotate": "A text annotation at a point, with an optional arrow to it from the text's position.",
    "matplotlib.pyplot.axhline": "A horizontal line across the axes at height y.",
    "matplotlib.pyplot.axis": "Sets the limits from [xmin, xmax, ymin, ymax]; 'off' hides the axes, and 'equal', 'scaled' or 'square' give equal units. Returns None, where matplotlib returns the limits.",
    "matplotlib.pyplot.axvline": "A vertical line across the axes at x.",
    "matplotlib.pyplot.bar": "A bar chart: bars at x with the given heights (width, bottom, color, label).",
    "matplotlib.pyplot.barh": "A horizontal bar chart: bars at y with the given widths.",
    "matplotlib.pyplot.cla": "Clear the current axes.",
    "matplotlib.pyplot.clf": "Clear the current figure: remove its axes.",
    "matplotlib.pyplot.close": "Close a figure (or the current one, or 'all').",
    "matplotlib.pyplot.colorbar": "A colorbar for an image, contour set or scatter (mappable) beside its axes.",
    "matplotlib.pyplot.contourf": "Filled contours of a 2D array Z over a grid (levels, cmap).",
    "matplotlib.pyplot.errorbar": "Points with error bars (yerr, xerr), optionally joined by lines.",
    "matplotlib.pyplot.figure": "A new figure (figsize, dpi), made the current one.",
    "matplotlib.pyplot.fill_between": "Fill the region between two curves y1 and y2 (y2 = 0 by default) over x.",
    "matplotlib.pyplot.gca": "The current axes (made if there are none).",
    "matplotlib.pyplot.gcf": "The current figure (made if there is none).",
    "matplotlib.pyplot.grid": "Show or hide the grid lines.",
    "matplotlib.pyplot.hist": "A histogram of the data: counts in bins (bins, range, density, cumulative, histtype); returns (n, bins, patches).",
    "matplotlib.pyplot.imshow": "An image of a 2D array (through a colormap) or an RGB(A) array.",
    "matplotlib.pyplot.ioff": "Accepted for compatibility: Sagebrush shows figures when the cell ends.",
    "matplotlib.pyplot.ion": "Accepted for compatibility: Sagebrush shows figures when the cell ends.",
    "matplotlib.pyplot.legend": "A legend of the labelled lines, markers and patches (loc).",
    "matplotlib.pyplot.pie": "A pie chart of the values (labels, colors, autopct, startangle).",
    "matplotlib.pyplot.plot": "Lines and/or markers through the points: plot(y), plot(x, y), with a format string such as 'r--o'.",
    "matplotlib.pyplot.rc_context": "A with-block in which the given rcParams apply, restored after it.",
    "matplotlib.pyplot.rcdefaults": "Restore the default rcParams.",
    "matplotlib.pyplot.savefig": "Save the current figure to a file: SVG, or PNG (dpi, transparent, facecolor).",
    "matplotlib.pyplot.scatter": "Markers at the points (x, y), with sizes s and colors c (through a colormap when numbers).",
    "matplotlib.pyplot.stem": "A stem plot: a vertical line from the baseline to each point, with a marker on top.",
    "matplotlib.pyplot.step": "A step plot: a staircase through the points (where='pre', 'post' or 'mid').",
    "matplotlib.pyplot.subplot": "Axes at one place of a grid of rows and columns: subplot(nrows, ncols, index) or subplot(221).",
    "matplotlib.pyplot.subplots": "A figure and a grid of axes: fig, ax = subplots(), or fig, axs = subplots(nrows, ncols).",
    "matplotlib.pyplot.suptitle": "A title above all the figure's axes.",
    "matplotlib.pyplot.text": "Text at the point (x, y) in data coordinates.",
    "matplotlib.pyplot.tight_layout": "Accepted: Sagebrush lays out the axes' labels without overlap already.",
    "matplotlib.pyplot.title": "The current axes' title.",
    "matplotlib.pyplot.xlabel": "The current axes' x label.",
    "matplotlib.pyplot.xlim": "Get, or set, the current axes' x limits: xlim(), xlim(left, right).",
    "matplotlib.pyplot.xscale": "The current axes' x scale: 'linear' or 'log'.",
    "matplotlib.pyplot.xticks": "Get, or set, the current axes' x tick positions (and labels).",
    "matplotlib.pyplot.ylabel": "The current axes' y label.",
    "matplotlib.pyplot.ylim": "Get, or set, the current axes' y limits: ylim(), ylim(bottom, top).",
    "matplotlib.pyplot.yscale": "The current axes' y scale: 'linear' or 'log'.",
    "matplotlib.pyplot.yticks": "Get, or set, the current axes' y tick positions (and labels).",
    # numpy: math, comparison and bits
    "numpy.absolute": "Elementwise absolute value (abs).",
    "numpy.arccosh": "Elementwise inverse hyperbolic cosine.",
    "numpy.arcsinh": "Elementwise inverse hyperbolic sine.",
    "numpy.arctanh": "Elementwise inverse hyperbolic tangent.",
    "numpy.copysign": "Elementwise magnitude of x1 with the sign of x2.",
    "numpy.deg2rad": "Degrees converted to radians.",
    "numpy.rad2deg": "Radians converted to degrees.",
    "numpy.exp2": "Elementwise 2**x.",
    "numpy.fabs": "Elementwise absolute value, as floats.",
    "numpy.float_power": "Elementwise power, computed in floating point.",
    "numpy.fmin": "Elementwise minimum, ignoring nan.",
    "numpy.logaddexp": "Elementwise log(exp(x1) + exp(x2)), without overflow.",
    "numpy.negative": "Elementwise negation.",
    "numpy.positive": "Elementwise +x (a copy).",
    "numpy.reciprocal": "Elementwise 1/x.",
    "numpy.remainder": "Elementwise remainder with the divisor's sign (mod, %).",
    "numpy.true_divide": "Elementwise true division (/).",
    "numpy.signbit": "Whether each element's sign bit is set (negative, -0.0 included).",
    "numpy.conjugate": "Elementwise complex conjugate (conj).",
    "numpy.equal": "Elementwise ==.",
    "numpy.not_equal": "Elementwise !=.",
    "numpy.greater": "Elementwise >.",
    "numpy.greater_equal": "Elementwise >=.",
    "numpy.less": "Elementwise <.",
    "numpy.less_equal": "Elementwise <=.",
    "numpy.logical_or": "Elementwise logical or.",
    "numpy.logical_xor": "Elementwise logical exclusive or.",
    "numpy.bitwise_and": "Elementwise bitwise and (&) of integers or booleans.",
    "numpy.bitwise_or": "Elementwise bitwise or (|).",
    "numpy.bitwise_xor": "Elementwise bitwise exclusive or (^).",
    "numpy.bitwise_not": "Elementwise bitwise not (~), invert.",
    "numpy.bitwise_invert": "Elementwise bitwise not (~).",
    "numpy.invert": "Elementwise bitwise not (~); logical not of booleans.",
    "numpy.left_shift": "Elementwise <<.",
    "numpy.right_shift": "Elementwise >>.",
    "numpy.isneginf": "Whether each element is negative infinity.",
    "numpy.isposinf": "Whether each element is positive infinity.",
    "numpy.iscomplexobj": "Whether the input has a complex dtype.",
    "numpy.isrealobj": "Whether the input does not have a complex dtype.",
    "numpy.array_equiv": "Whether two arrays are equal after broadcasting.",
    # numpy: making and reshaping arrays
    "numpy.asanyarray": "The input as an array.",
    "numpy.asfarray": "The input as a float array.",
    "numpy.empty_like": "An array with the shape and dtype of a, its values not set.",
    "numpy.atleast_1d": "Inputs as arrays of at least one dimension.",
    "numpy.atleast_3d": "Inputs as arrays of at least three dimensions.",
    "numpy.dstack": "Arrays stacked along a third axis.",
    "numpy.row_stack": "Arrays stacked as rows (vstack).",
    "numpy.concat": "Arrays joined along an axis (concatenate).",
    "numpy.hsplit": "An array split into columns.",
    "numpy.vsplit": "An array split into rows.",
    "numpy.fliplr": "The columns in reverse order.",
    "numpy.flipud": "The rows in reverse order.",
    "numpy.diagonal": "A diagonal of an array.",
    "numpy.resize": "An array with a new shape, its data repeated to fill it.",
    "numpy.take": "Elements at the given indices (along an axis).",
    "numpy.broadcast_arrays": "Arrays broadcast against each other.",
    "numpy.broadcast_shapes": "The shape that shapes broadcast to.",
    "numpy.apply_along_axis": "A function applied to the 1-D slices of an array along an axis.",
    "numpy.flatnonzero": "The indices of the non-zero elements of the flattened array.",
    "numpy.genfromtxt": "An array from a text file, with missing values allowed.",
    # numpy: reductions
    "numpy.cumulative_sum": "Cumulative sums (the array API's cumsum).",
    "numpy.cumulative_prod": "Cumulative products (the array API's cumprod).",
    "numpy.ediff1d": "The differences between consecutive elements of the flattened array.",
    "numpy.nanargmax": "The index of the largest element, ignoring nan.",
    "numpy.nanargmin": "The index of the smallest element, ignoring nan.",
    "numpy.nanmedian": "The median, ignoring nan.",
    "numpy.nanmin": "The smallest element, ignoring nan.",
    "numpy.nanprod": "The product, treating nan as one.",
    "numpy.nanstd": "The standard deviation, ignoring nan.",
    "numpy.nanvar": "The variance, ignoring nan.",
    "numpy.histogram_bin_edges": "The edges of the bins histogram would use.",
    "numpy.in1d": "Whether each element of a 1-D array is in another (isin).",
    "numpy.sort_complex": "Sorted, as complex numbers (by real part, then imaginary).",
    "numpy.polysub": "The difference of two polynomials.",
    # numpy: types and settings
    "numpy.ndarray": "NumPy's n-dimensional array type.",
    "numpy.ufunc": "The type of NumPy's elementwise functions (np.add, np.sin, ...).",
    "numpy.can_cast": "Whether a cast between data types is safe.",
    "numpy.promote_types": "The smallest type both data types cast to safely.",
    "numpy.result_type": "The type NumPy's promotion rules give the operands.",
    "numpy.issubdtype": "Whether a data type is a kind of another (np.floating, np.integer, ...).",
    "numpy.array_repr": "An array's repr as a string, with print options.",
    "numpy.array_str": "An array's str as a string, with print options.",
    "numpy.get_printoptions": "The current print options.",
    "numpy.seterr": "How floating-point errors are handled.",
    "numpy.geterr": "How floating-point errors are handled now.",
    "numpy.float64": "NumPy's 64-bit float scalar type (a Python float).",
    "numpy.float32": "NumPy's 32-bit float scalar type.",
    "numpy.float16": "NumPy's half-precision type (stored as float32 in Sagebrush).",
    "numpy.complex128": "NumPy's complex scalar type of two 64-bit floats.",
    "numpy.complex64": "NumPy's complex scalar type of two 32-bit floats.",
    "numpy.int64": "NumPy's 64-bit integer scalar type.",
    "numpy.int32": "NumPy's 32-bit integer scalar type.",
    "numpy.int16": "NumPy's 16-bit integer scalar type.",
    "numpy.int8": "NumPy's 8-bit integer scalar type.",
    "numpy.uint64": "NumPy's 64-bit unsigned integer scalar type.",
    "numpy.uint32": "NumPy's 32-bit unsigned integer scalar type.",
    "numpy.uint16": "NumPy's 16-bit unsigned integer scalar type.",
    "numpy.uint8": "NumPy's 8-bit unsigned integer scalar type.",
    "numpy.floating": "The abstract type of NumPy's float scalars.",
    "numpy.complexfloating": "The abstract type of NumPy's complex scalars.",
    "numpy.integer": "The abstract type of NumPy's integer scalars.",
    "numpy.signedinteger": "The abstract type of NumPy's signed integer scalars.",
    "numpy.unsignedinteger": "The abstract type of NumPy's unsigned integer scalars.",
    "numpy.inexact": "The abstract type of NumPy's float and complex scalars.",
    "numpy.number": "The abstract type of NumPy's numeric scalars.",
    # numpy.linalg, numpy.fft
    "numpy.linalg.EigResult": "eig's result: eigenvalues and eigenvectors.",
    "numpy.linalg.EighResult": "eigh's result: eigenvalues and eigenvectors.",
    "numpy.linalg.QRResult": "qr's result: Q and R.",
    "numpy.linalg.SVDResult": "svd's result: U, S and Vh.",
    "numpy.linalg.LinAlgError": "The error of a linear algebra function (a singular matrix, say).",
    "numpy.linalg.eigvalsh": "The eigenvalues of a symmetric or Hermitian matrix, ascending.",
    "numpy.linalg.svdvals": "The singular values of a matrix.",
    "numpy.linalg.matrix_norm": "A matrix norm (Frobenius by default).",
    "numpy.linalg.vector_norm": "A vector norm (2-norm by default).",
    "numpy.linalg.cross": "The cross product of 3-vectors.",
    "numpy.linalg.outer": "The outer product of two vectors.",
    "numpy.linalg.matmul": "The matrix product.",
    "numpy.linalg.trace": "The sum along a diagonal.",
    "numpy.linalg.diagonal": "A diagonal of a matrix (or of a stack of them).",
    "numpy.linalg.tensorinv": "The inverse of an N-dimensional array, seen as a linear map.",
    "numpy.linalg.tensorsolve": "The solution x of tensordot(a, x) = b.",
    "numpy.fft.ifft2": "The inverse 2-D discrete Fourier transform.",
    "numpy.fft.fftn": "The N-dimensional discrete Fourier transform.",
    "numpy.fft.ifftn": "The inverse N-dimensional discrete Fourier transform.",
    "numpy.fft.rfft2": "The 2-D Fourier transform of real input.",
    "numpy.fft.irfft2": "The inverse of rfft2.",
    "numpy.fft.rfftn": "The N-dimensional Fourier transform of real input.",
    "numpy.fft.irfftn": "The inverse of rfftn.",
    "numpy.fft.hfft": "The Fourier transform of a signal with Hermitian symmetry (a real spectrum).",
    "numpy.fft.ihfft": "The inverse of hfft.",
    "numpy.fft.ifftshift": "The inverse of fftshift.",
    "numpy.polynomial.polynomial": "Functions on power-series coefficient arrays (polyval, polyfit, ... lowest power first).",
    # numpy.random
    "numpy.random.Generator": "NumPy's random number generator (use default_rng).",
    "numpy.random.RandomState": "The legacy random generator (Mersenne Twister) behind np.random.rand and friends.",
    "numpy.random.MT19937": "The Mersenne Twister bit generator.",
    "numpy.random.PCG64": "The PCG64 bit generator, default_rng's.",
    "numpy.random.SeedSequence": "Mixes seeds into the state of bit generators, as NumPy does.",
    "numpy.random.random": "Uniform floats in [0, 1) (legacy).",
    "numpy.random.random_sample": "Uniform floats in [0, 1) (legacy).",
    "numpy.random.sample": "Uniform floats in [0, 1) (legacy).",
    "numpy.random.ranf": "Uniform floats in [0, 1) (legacy).",
    "numpy.random.uniform": "Samples of a uniform distribution (legacy).",
    "numpy.random.normal": "Samples of a normal distribution (legacy).",
    "numpy.random.standard_normal": "Standard normal samples (legacy).",
    "numpy.random.exponential": "Samples of an exponential distribution (legacy).",
    "numpy.random.standard_exponential": "Samples of the standard exponential distribution (legacy).",
    "numpy.random.poisson": "Samples of a Poisson distribution (legacy).",
    "numpy.random.choice": "A random sample of the elements of an array (legacy).",
    "numpy.random.permutation": "A random permutation (legacy).",
    "numpy.random.shuffle": "Shuffles an array in place (legacy).",
    "numpy.random.random_integers": "Random integers in [low, high], inclusive (legacy, deprecated).",
    "numpy.random.get_state": "The legacy generator's state.",
    "numpy.random.set_state": "Sets the legacy generator's state.",
    # scipy.io
    "scipy.io.MatReadError": "The error of reading a .mat file Sagebrush cannot read.",
    "scipy.io.whosmat": "The variables of a .mat file: names, shapes and classes.",
    # math, cmath
    "math.acos": "The arc cosine of x, in radians.",
    "math.asin": "The arc sine of x, in radians.",
    "math.atan": "The arc tangent of x, in radians.",
    "math.acosh": "The inverse hyperbolic cosine.",
    "math.asinh": "The inverse hyperbolic sine.",
    "math.atanh": "The inverse hyperbolic tangent.",
    "math.cosh": "The hyperbolic cosine.",
    "math.sinh": "The hyperbolic sine.",
    "math.tanh": "The hyperbolic tangent.",
    "math.cbrt": "The cube root.",
    "math.exp2": "2 raised to the power x.",
    "math.expm1": "exp(x) - 1, accurate for small x.",
    "math.log1p": "log(1 + x), accurate for small x.",
    "math.erfc": "The complementary error function 1 - erf(x).",
    "math.isfinite": "Whether x is neither infinite nor nan.",
    "cmath.cos": "The complex cosine.",
    "cmath.sin": "The complex sine.",
    "cmath.tan": "The complex tangent.",
    "cmath.acos": "The complex arc cosine.",
    "cmath.asin": "The complex arc sine.",
    "cmath.atan": "The complex arc tangent.",
    "cmath.cosh": "The complex hyperbolic cosine.",
    "cmath.sinh": "The complex hyperbolic sine.",
    "cmath.tanh": "The complex hyperbolic tangent.",
    "cmath.acosh": "The complex inverse hyperbolic cosine.",
    "cmath.asinh": "The complex inverse hyperbolic sine.",
    "cmath.atanh": "The complex inverse hyperbolic tangent.",
    "cmath.log10": "The complex base-10 logarithm.",
    "cmath.isfinite": "Whether both parts are finite.",
    "cmath.isinf": "Whether either part is infinite.",
    "cmath.isnan": "Whether either part is nan.",
    # itertools, functools, collections, random, bisect
    "itertools.batched": "Tuples of n consecutive elements.",
    "itertools.compress": "The elements whose selector is true.",
    "itertools.dropwhile": "The elements after a condition first fails.",
    "itertools.filterfalse": "The elements for which a condition is false.",
    "itertools.tee": "n independent iterators over one iterable.",
    "functools.cached_property": "A property computed once and then stored on the instance.",
    "collections.ChainMap": "Several mappings searched as one.",
    "collections.UserDict": "A dict wrapper to subclass.",
    "collections.UserList": "A list wrapper to subclass.",
    "collections.UserString": "A str wrapper to subclass.",
    "random.Random": "A random generator of its own (Mersenne Twister).",
    "random.random": "A random float in [0, 1).",
    "random.randrange": "A random element of range(start, stop, step).",
    "random.choices": "k random elements, with replacement, optionally weighted.",
    "random.sample": "k distinct random elements.",
    "random.gauss": "A sample of a normal distribution.",
    "random.getrandbits": "A random integer of k bits.",
    "bisect.bisect": "Where x would be inserted to keep a sorted list sorted (after equal elements).",
    "bisect.bisect_right": "Where x would be inserted to keep a sorted list sorted (after equal elements).",
    "bisect.insort_left": "x inserted into a sorted list, before equal elements.",
    "bisect.insort_right": "x inserted into a sorted list, after equal elements.",
}


# ---------------------------------------------------------------- outputs
# (written by scripts/python-doc-examples.py --update: Sagebrush's output for
# each example's code)
OUTPUTS = {
    'np.array([[1, 2], [3, 4]])':
        'array([[1, 2],\n       [3, 4]])\n',
    'np.asarray([1.5, 2])':
        'array([1.5, 2. ])\n',
    'np.arange(5)':
        'array([0, 1, 2, 3, 4])\n',
    'np.arange(1, 2, 0.25)':
        'array([1.  , 1.25, 1.5 , 1.75])\n',
    'np.linspace(0, 1, 5)':
        'array([0.  , 0.25, 0.5 , 0.75, 1.  ])\n',
    'np.logspace(0, 3, 4)':
        'array([   1.,   10.,  100., 1000.])\n',
    'np.geomspace(1, 256, 5)':
        'array([  1.,   4.,  16.,  64., 256.])\n',
    'np.zeros((2, 3))':
        'array([[0., 0., 0.],\n       [0., 0., 0.]])\n',
    'np.ones(3, dtype=int)':
        'array([1, 1, 1])\n',
    'np.full((2, 2), 7)':
        'array([[7, 7],\n       [7, 7]])\n',
    'np.zeros_like(np.array([[1, 2], [3, 4]]))':
        'array([[0, 0],\n       [0, 0]])\n',
    'np.ones_like(np.arange(3.0))':
        'array([1., 1., 1.])\n',
    'np.full_like(np.arange(4), 9)':
        'array([9, 9, 9, 9])\n',
    'np.eye(3, k=1)':
        'array([[0., 1., 0.],\n       [0., 0., 1.],\n       [0., 0., 0.]])\n',
    'np.identity(2)':
        'array([[1., 0.],\n       [0., 1.]])\n',
    'np.diag([1, 2, 3])':
        'array([[1, 0, 0],\n       [0, 2, 0],\n       [0, 0, 3]])\n',
    'np.diag(np.arange(9).reshape(3, 3))':
        'array([0, 4, 8])\n',
    'np.tri(3)':
        'array([[1., 0., 0.],\n       [1., 1., 0.],\n       [1., 1., 1.]])\n',
    'np.tril(np.arange(1, 10).reshape(3, 3))':
        'array([[1, 0, 0],\n       [4, 5, 0],\n       [7, 8, 9]])\n',
    'np.triu(np.arange(1, 10).reshape(3, 3), 1)':
        'array([[0, 2, 3],\n       [0, 0, 6],\n       [0, 0, 0]])\n',
    'np.vander([1, 2, 3])':
        'array([[1, 1, 1],\n       [4, 2, 1],\n       [9, 3, 1]])\n',
    'X, Y = np.meshgrid([1, 2, 3], [10, 20])\nX + Y':
        'array([[11, 12, 13],\n       [21, 22, 23]])\n',
    'np.indices((2, 3))':
        'array([[[0, 0, 0],\n        [1, 1, 1]],\n\n       [[0, 1, 2],\n        [0, 1, 2]]])\n',
    'np.fromfunction(lambda i, j: i + 10 * j, (2, 3))':
        'array([[ 0., 10., 20.],\n       [ 1., 11., 21.]])\n',
    'np.fromiter((x * x for x in range(5)), dtype=int)':
        'array([ 0,  1,  4,  9, 16])\n',
    'a = np.arange(3)\nb = np.copy(a)\nb[0] = 9\na':
        'array([0, 1, 2])\n',
    'np.reshape(np.arange(6), (2, -1))':
        'array([[0, 1, 2],\n       [3, 4, 5]])\n',
    'np.ravel([[1, 2], [3, 4]])':
        'array([1, 2, 3, 4])\n',
    'np.transpose(np.arange(6).reshape(2, 3))':
        'array([[0, 3],\n       [1, 4],\n       [2, 5]])\n',
    'np.swapaxes(np.zeros((2, 3, 4)), 0, 2).shape':
        '(4, 3, 2)\n',
    'np.moveaxis(np.zeros((2, 3, 4)), 0, -1).shape':
        '(3, 4, 2)\n',
    'np.expand_dims(np.array([1, 2]), 0)':
        'array([[1, 2]])\n',
    'np.squeeze(np.zeros((1, 3, 1))).shape':
        '(3,)\n',
    'np.atleast_2d([1, 2])':
        'array([[1, 2]])\n',
    'np.concatenate([[1, 2], [3], [4, 5]])':
        'array([1, 2, 3, 4, 5])\n',
    'np.stack([[1, 2], [3, 4]], axis=1)':
        'array([[1, 3],\n       [2, 4]])\n',
    'np.vstack([[1, 2], [3, 4]])':
        'array([[1, 2],\n       [3, 4]])\n',
    'np.hstack([[1, 2], [3]])':
        'array([1, 2, 3])\n',
    'np.column_stack([[1, 2], [3, 4]])':
        'array([[1, 3],\n       [2, 4]])\n',
    'np.split(np.arange(6), 3)':
        '[array([0, 1]), array([2, 3]), array([4, 5])]\n',
    'np.array_split(np.arange(5), 2)':
        '[array([0, 1, 2]), array([3, 4])]\n',
    'np.tile([1, 2], 3)':
        'array([1, 2, 1, 2, 1, 2])\n',
    'np.repeat([1, 2], [2, 3])':
        'array([1, 1, 2, 2, 2])\n',
    'np.flip(np.arange(4))':
        'array([3, 2, 1, 0])\n',
    'np.roll(np.arange(5), 2)':
        'array([3, 4, 0, 1, 2])\n',
    'np.rot90([[1, 2], [3, 4]])':
        'array([[2, 4],\n       [1, 3]])\n',
    'np.pad([1, 2, 3], (2, 1))':
        'array([0, 0, 1, 2, 3, 0])\n',
    "np.pad([1, 2, 3], 2, mode='edge')":
        'array([1, 1, 1, 2, 3, 3, 3])\n',
    'np.insert([1, 2, 3], 1, 9)':
        'array([1, 9, 2, 3])\n',
    'np.delete(np.arange(6), [0, 2])':
        'array([1, 3, 4, 5])\n',
    'np.append([1, 2], [3, 4])':
        'array([1, 2, 3, 4])\n',
    'np.broadcast_to([1, 2, 3], (2, 3))':
        'array([[1, 2, 3],\n       [1, 2, 3]])\n',
    'np.shape([[1, 2, 3], [4, 5, 6]])':
        '(2, 3)\n',
    'np.ndim([[1], [2]])':
        '2\n',
    'np.size(np.zeros((3, 4)))':
        '12\n',
    'np.add([1, 2], [10, 20])':
        'array([11, 22])\n',
    'np.subtract(5, [1, 2])':
        'array([4, 3])\n',
    'np.multiply([1, 2, 3], 2)':
        'array([2, 4, 6])\n',
    'np.divide([1, 2, 3], 4)':
        'array([0.25, 0.5 , 0.75])\n',
    'np.floor_divide([7, -7], 2)':
        'array([ 3, -4])\n',
    'np.mod([7, -7], 3)':
        'array([1, 2])\n',
    'np.power([2, 3], [3, 2])':
        'array([8, 9])\n',
    'np.sqrt([1, 4, 2])':
        'array([1.        , 2.        , 1.41421356])\n',
    'np.cbrt([27, -8])':
        'array([ 3., -2.])\n',
    'np.square([1, -2, 3])':
        'array([1, 4, 9])\n',
    'np.abs([-1.5, 2, 3 + 4j])':
        'array([1.5, 2. , 5. ])\n',
    'np.sign([-2, 0, 5])':
        'array([-1,  0,  1])\n',
    'np.exp([0, 1])':
        'array([1.        , 2.71828183])\n',
    'np.expm1(1e-10)':
        'np.float64(1.00000000005e-10)\n',
    'np.log([1, np.e])':
        'array([0., 1.])\n',
    'np.log10([10, 1000])':
        'array([1., 3.])\n',
    'np.log2([8, 0.5])':
        'array([ 3., -1.])\n',
    'np.log1p(1e-10)':
        'np.float64(9.999999999500001e-11)\n',
    'np.sin([0, np.pi / 2])':
        'array([0., 1.])\n',
    'np.cos([0, np.pi])':
        'array([ 1., -1.])\n',
    'np.tan(np.pi / 4)':
        'np.float64(0.9999999999999999)\n',
    'np.arcsin([0, 1])':
        'array([0.        , 1.57079633])\n',
    'np.arccos([1, 0])':
        'array([0.        , 1.57079633])\n',
    'np.arctan(1)':
        'np.float64(0.7853981633974483)\n',
    'np.arctan2([1, -1], [-1, -1])':
        'array([ 2.35619449, -2.35619449])\n',
    'np.hypot(3, [4, 5])':
        'array([5.        , 5.83095189])\n',
    'np.sinh([0, 1])':
        'array([0.        , 1.17520119])\n',
    'np.cosh([0, 1])':
        'array([1.        , 1.54308063])\n',
    'np.tanh([0, 1])':
        'array([0.        , 0.76159416])\n',
    'np.degrees(np.pi)':
        'np.float64(180.0)\n',
    'np.radians([90, 180])':
        'array([1.57079633, 3.14159265])\n',
    'np.round([1.25, 2.5, -0.5], 1)':
        'array([ 1.2,  2.5, -0.5])\n',
    'np.round([2.5, 3.5])':
        'array([2., 4.])\n',
    'np.floor([-1.5, 1.5])':
        'array([-2.,  1.])\n',
    'np.ceil([-1.5, 1.5])':
        'array([-1.,  2.])\n',
    'np.trunc([-1.7, 1.7])':
        'array([-1.,  1.])\n',
    'np.rint([0.5, 1.5, 2.6])':
        'array([0., 2., 3.])\n',
    'np.clip(np.arange(6), 1, 4)':
        'array([1, 1, 2, 3, 4, 4])\n',
    'np.maximum([1, 5, 3], [4, 2, 6])':
        'array([4, 5, 6])\n',
    'np.minimum([1, 5, 3], 2)':
        'array([1, 2, 2])\n',
    'np.fmax([1, np.nan], [np.nan, 2])':
        'array([1., 2.])\n',
    'np.gcd([12, 20], 8)':
        'array([4, 4])\n',
    'np.lcm([4, 6], 10)':
        'array([20, 30])\n',
    'np.real([1 + 2j, 3])':
        'array([1., 3.])\n',
    'np.imag([1 + 2j, 3])':
        'array([2., 0.])\n',
    'np.conj([1 + 2j, 3 - 1j])':
        'array([1.-2.j, 3.+1.j])\n',
    'np.angle([1j, -1], deg=True)':
        'array([ 90., 180.])\n',
    'np.isnan([1, np.nan])':
        'array([False,  True])\n',
    'np.isinf([np.inf, -np.inf, 1])':
        'array([ True,  True, False])\n',
    'np.isfinite([1, np.nan, np.inf])':
        'array([ True, False, False])\n',
    'np.nan_to_num([np.nan, 1.5, np.inf])':
        'array([0.00000000e+000, 1.50000000e+000, 1.79769313e+308])\n',
    'np.heaviside([-1, 0, 2], 0.5)':
        'array([0. , 0.5, 1. ])\n',
    'np.sinc([0, 0.5])':
        'array([1.        , 0.63661977])\n',
    'np.interp([0.5, 1.5], [0, 1, 2], [0, 10, 0])':
        'array([5., 5.])\n',
    'x = np.array([-2, -1, 0, 1, 2])\nnp.piecewise(x, [x < 0, x >= 0], [lambda t: -t, lambda t: t ** 2])':
        'array([2, 1, 0, 1, 4])\n',
    'np.where(np.arange(5) > 2, 1, -1)':
        'array([-1, -1, -1,  1,  1])\n',
    'np.where([0, 3, 0, 5])':
        '(array([1, 3]),)\n',
    'x = np.arange(6)\nnp.select([x < 2, x > 3], [x, x ** 2], -1)':
        'array([ 0,  1, -1, -1, 16, 25])\n',
    'f = np.vectorize(lambda a, b: a if a > b else b)\nf([1, 5, 3], 2)':
        'array([2, 5, 3])\n',
    'np.sum([[1, 2], [3, 4]])':
        'np.int64(10)\n',
    'np.sum([[1, 2], [3, 4]], axis=0)':
        'array([4, 6])\n',
    'np.prod([1, 2, 3, 4])':
        'np.int64(24)\n',
    'np.cumsum([1, 2, 3, 4])':
        'array([ 1,  3,  6, 10])\n',
    'np.cumprod([1, 2, 3, 4])':
        'array([ 1,  2,  6, 24])\n',
    'np.diff([1, 4, 9, 16])':
        'array([3, 5, 7])\n',
    'np.diff([1, 4, 9, 16], n=2)':
        'array([2, 2])\n',
    'np.gradient([1, 4, 9, 16])':
        'array([3., 4., 6., 7.])\n',
    'np.min([[3, 1], [4, 1]], axis=1)':
        'array([1, 1])\n',
    'np.max([3, 9, 4])':
        'np.int64(9)\n',
    'np.argmin([3, 1, 2])':
        'np.int64(1)\n',
    'np.argmax([[1, 9], [5, 2]], axis=0)':
        'array([1, 0])\n',
    'np.ptp([4, 9, 1])':
        'np.int64(8)\n',
    'np.mean([1, 2, 3, 4])':
        'np.float64(2.5)\n',
    'np.mean([[1, 2], [3, 4]], axis=1)':
        'array([1.5, 3.5])\n',
    'np.average([1, 2, 3], weights=[3, 1, 1])':
        'np.float64(1.6)\n',
    'np.median([3, 1, 4, 1, 5])':
        'np.float64(3.0)\n',
    'np.std([2, 4, 4, 4, 5, 5, 7, 9])':
        'np.float64(2.0)\n',
    'np.std([1, 2, 3, 4], ddof=1)':
        'np.float64(1.2909944487358056)\n',
    'np.var([1, 2, 3, 4])':
        'np.float64(1.25)\n',
    'np.percentile([1, 2, 3, 4, 5], [25, 50, 90])':
        'array([2. , 3. , 4.6])\n',
    'np.quantile(np.arange(11), 0.35)':
        'np.float64(3.5)\n',
    'np.nanmean([1, np.nan, 3])':
        'np.float64(2.0)\n',
    'np.nansum([1, np.nan, 3])':
        'np.float64(4.0)\n',
    'np.nanmax([1, np.nan, 3])':
        'np.float64(3.0)\n',
    'np.cov([[1, 2, 3], [2, 4, 7]])':
        'array([[1.        , 2.5       ],\n       [2.5       , 6.33333333]])\n',
    'np.corrcoef([1, 2, 3, 4], [2, 4, 5, 9])':
        'array([[1.        , 0.96476382],\n       [0.96476382, 1.        ]])\n',
    'np.histogram([1, 2, 2, 3, 3, 3], bins=3)':
        '(array([1, 2, 3]), array([1.        , 1.66666667, 2.33333333, 3.        ]))\n',
    'np.bincount([0, 1, 1, 3])':
        'array([1, 2, 0, 1])\n',
    'np.digitize([0.5, 1.5, 3.2], [0, 1, 2, 3])':
        'array([1, 2, 4])\n',
    'np.count_nonzero([[0, 1], [2, 0]])':
        'np.int64(2)\n',
    'np.all([[True, False], [True, True]], axis=0)':
        'array([ True, False])\n',
    'np.any([0, 0, 3])':
        'np.True_\n',
    'x = np.linspace(0, 1, 101)\nnp.trapezoid(x ** 2, x)':
        'np.float64(0.33335000000000004)\n',
    'np.sort([3, 1, 2])':
        'array([1, 2, 3])\n',
    'np.sort([[3, 1], [0, 2]], axis=0)':
        'array([[0, 1],\n       [3, 2]])\n',
    'np.argsort([30, 10, 20])':
        'array([1, 2, 0])\n',
    'np.lexsort(([1, 2, 1], [0, 0, 1]))':
        'array([0, 1, 2])\n',
    'np.searchsorted([1, 3, 5, 7], [4, 7])':
        'array([2, 3])\n',
    'np.nonzero([[1, 0], [0, 2]])':
        '(array([0, 1]), array([0, 1]))\n',
    'np.argwhere(np.arange(6).reshape(2, 3) > 3)':
        'array([[1, 1],\n       [1, 2]])\n',
    'np.unique([3, 1, 3, 2, 1])':
        'array([1, 2, 3])\n',
    'np.unique([3, 1, 3, 2, 1], return_counts=True)':
        '(array([1, 2, 3]), array([2, 1, 2]))\n',
    'np.isin([1, 2, 3, 4], [2, 4])':
        'array([False,  True, False,  True])\n',
    'np.intersect1d([1, 2, 3, 4], [3, 4, 5])':
        'array([3, 4])\n',
    'np.union1d([1, 2], [2, 5])':
        'array([1, 2, 5])\n',
    'np.setdiff1d([1, 2, 3, 4], [2, 4])':
        'array([1, 3])\n',
    'np.allclose([1.0, 2.0], [1.0, 2.0 + 1e-9])':
        'True\n',
    'np.isclose([1.0, 2.0], [1.0, 2.1])':
        'array([ True, False])\n',
    'np.array_equal([1, 2], [1, 2])':
        'True\n',
    'np.logical_and([True, True, False], [True, False, False])':
        'array([ True, False, False])\n',
    'np.logical_not([True, False])':
        'array([False,  True])\n',
    'np.dot([1, 2, 3], [4, 5, 6])':
        'np.int64(32)\n',
    'np.dot([[1, 2], [3, 4]], [1, 1])':
        'array([3, 7])\n',
    'np.array([[1, 2], [3, 4]]) @ np.array([[0, 1], [1, 0]])':
        'array([[2, 1],\n       [4, 3]])\n',
    'np.inner([1, 2], [3, 4])':
        'np.int64(11)\n',
    'np.outer([1, 2], [1, 10, 100])':
        'array([[  1,  10, 100],\n       [  2,  20, 200]])\n',
    'np.cross([1, 0, 0], [0, 1, 0])':
        'array([0, 0, 1])\n',
    'np.vdot([1j, 2], [1j, 3])':
        'np.complex128(7+0j)\n',
    'np.kron([[1, 2], [3, 4]], [[1, 1]])':
        'array([[1, 1, 2, 2],\n       [3, 3, 4, 4]])\n',
    'np.tensordot(np.arange(6).reshape(2, 3), np.arange(3), axes=1)':
        'array([ 5, 14])\n',
    "np.einsum('ij,j->i', [[1, 2], [3, 4]], [10, 1])":
        'array([12, 34])\n',
    "np.einsum('ij,ij->', [[1, 2], [3, 4]], [[1, 0], [0, 1]])":
        'np.int64(5)\n',
    'np.trace([[1, 2], [3, 4]])':
        'np.int64(5)\n',
    'np.convolve([1, 2], [1, 3, 1])':
        'array([1, 5, 7, 2])\n',
    "np.correlate([1, 2, 3], [0, 1, 0.5], mode='same')":
        'array([2. , 3.5, 3. ])\n',
    'np.polyval([1, 0, -2], [0, 1, 2])':
        'array([-2, -1,  2])\n',
    'np.polyfit([0, 1, 2, 3], [1, 3, 5, 7], 1)':
        'array([2., 1.])\n',
    'np.roots([1, -3, 2])':
        'array([2., 1.])\n',
    'np.poly([1, 2])':
        'array([ 1., -3.,  2.])\n',
    'np.polyder([1, 2, 3])':
        'array([2, 2])\n',
    'np.polyint([3, 2, 1])':
        'array([1., 1., 1., 0.])\n',
    'np.polyadd([1, 2], [1, 0, 0])':
        'array([1, 1, 2])\n',
    'np.polymul([1, 1], [1, -1])':
        'array([ 1,  0, -1])\n',
    'np.polydiv([1, 0, -1], [1, 1])':
        '(array([ 1., -1.]), array([0.]))\n',
    'p = np.poly1d([1, 0, -2])\np(3)':
        'np.int64(7)\n',
    'print(np.poly1d([2, -3, 1]))':
        '   2\n2 x - 3 x + 1\n',
    'P = np.polynomial.Polynomial([1, 2, 3])\nP(2)':
        'np.float64(17.0)\n',
    'np.polynomial.Polynomial([-1, 0, 1]).roots()':
        'array([-1.,  1.])\n',
    "np.dtype('float32')":
        "dtype('float32')\n",
    'np.arange(3).dtype':
        "dtype('int64')\n",
    'np.finfo(np.float64).eps':
        'np.float64(2.220446049250313e-16)\n',
    'np.iinfo(np.int8).max':
        '127\n',
    'with np.printoptions(precision=3):\n    print(np.array([1 / 3, 2 / 3]))':
        '[0.333 0.667]\n',
    'np.format_float_positional(1 / 3, precision=5)':
        "'0.33333'\n",
    'np.format_float_scientific(12345.678, precision=2)':
        "'1.23e+04'\n",
    "with np.errstate(divide='ignore'):\n    print(np.array([1.0]) / 0)":
        '[inf]\n',
    'np.linalg.solve([[3, 1], [1, 2]], [9, 8])':
        'array([2., 3.])\n',
    'np.linalg.inv([[1.0, 2.0], [3.0, 4.0]])':
        'array([[-2. ,  1. ],\n       [ 1.5, -0.5]])\n',
    'round(np.linalg.det([[1, 2], [3, 4]]), 10)':
        'np.float64(-2.0)\n',
    'w, v = np.linalg.eig([[2.0, 0.0], [0.0, 3.0]])\nw':
        'array([2.+0.j, 3.+0.j])\n',
    'w, v = np.linalg.eigh([[2.0, 1.0], [1.0, 2.0]])\nw':
        'array([1., 3.])\n',
    'np.linalg.eigvals([[0.0, 1.0], [-2.0, -3.0]])':
        'array([-1.+0.j, -2.+0.j])\n',
    'np.linalg.svd([[3.0, 0.0], [0.0, 4.0]], compute_uv=False)':
        'array([4., 3.])\n',
    'q, r = np.linalg.qr([[3.0, 1.0], [4.0, 2.0]])\nnp.round(abs(r), 6)':
        'array([[5. , 2.2],\n       [0. , 0.4]])\n',
    'np.linalg.cholesky([[4.0, 2.0], [2.0, 3.0]])':
        'array([[2.        , 0.        ],\n       [1.        , 1.41421356]])\n',
    'np.linalg.norm([3, 4])':
        'np.float64(5.0)\n',
    "np.linalg.norm([[1, 2], [3, 4]], 'fro')":
        'np.float64(5.477225575051661)\n',
    'np.linalg.matrix_rank([[1, 2], [2, 4]])':
        'np.int64(1)\n',
    'np.linalg.matrix_power([[1, 1], [1, 0]], 10)':
        'array([[89, 55],\n       [55, 34]])\n',
    'x, res, rank, sv = np.linalg.lstsq([[1, 0], [1, 1], [1, 2]], [1, 2, 4])\nx':
        'array([0.83333333, 1.5       ])\n',
    'np.linalg.pinv([[1.0, 2.0], [2.0, 4.0]])':
        'array([[0.04, 0.08],\n       [0.08, 0.16]])\n',
    'np.linalg.cond([[1, 0], [0, 4]])':
        'np.float64(4.0)\n',
    'np.linalg.slogdet([[2.0, 0.0], [0.0, 3.0]])':
        'SlogdetResult(sign=np.float64(1.0), logabsdet=np.float64(1.791759469228055))\n',
    'np.linalg.multi_dot([[[1, 2]], [[3], [4]], [[5]]])':
        'array([[55]])\n',
    'np.fft.fft([1, 0, -1, 0])':
        'array([0.+0.j, 2.+0.j, 0.+0.j, 2.+0.j])\n',
    'np.fft.ifft([0, 2, 0, 2]).real':
        'array([ 1.,  0., -1.,  0.])\n',
    'np.fft.rfft([1, 2, 3, 4])':
        'array([10.+0.j, -2.+2.j, -2.+0.j])\n',
    'np.fft.irfft([10, -2 + 2j, -2])':
        'array([1., 2., 3., 4.])\n',
    'np.fft.fft2([[1, 1], [1, 1]])':
        'array([[4.+0.j, 0.+0.j],\n       [0.+0.j, 0.+0.j]])\n',
    'np.fft.fftfreq(4, d=0.5)':
        'array([ 0. ,  0.5, -1. , -0.5])\n',
    'np.fft.rfftfreq(6)':
        'array([0.        , 0.16666667, 0.33333333, 0.5       ])\n',
    'np.fft.fftshift(np.fft.fftfreq(5))':
        'array([-0.4, -0.2,  0. ,  0.2,  0.4])\n',
    'rng = np.random.default_rng(42)\nrng.integers(0, 10, size=5)':
        'array([0, 7, 6, 4, 4])\n',
    'np.random.default_rng(0).random(3)':
        'array([0.63696169, 0.26978671, 0.04097352])\n',
    'np.random.default_rng(1).integers(1, 7, size=6)':
        'array([3, 4, 5, 6, 1, 1])\n',
    'np.random.default_rng(2).normal(10, 2, size=3)':
        'array([10.37810676,  8.95450312,  9.17387291])\n',
    'np.random.default_rng(3).uniform(-1, 1, size=2)':
        'array([-0.82870167, -0.52637899])\n',
    'np.random.default_rng(4).choice([10, 20, 30], size=4, p=[0.5, 0.25, 0.25])':
        'array([30, 20, 30, 10])\n',
    'np.random.default_rng(4).choice(10, size=3, replace=False)':
        'array([5, 9, 8])\n',
    'np.random.default_rng(5).permutation(5)':
        'array([4, 3, 1, 2, 0])\n',
    'a = np.arange(5)\nnp.random.default_rng(6).shuffle(a)\na':
        'array([2, 4, 0, 3, 1])\n',
    'np.random.default_rng(7).exponential(2.0, size=2)':
        'array([1.41505851, 2.0504067 ])\n',
    'np.random.default_rng(8).poisson(3, size=5)':
        'array([5, 2, 2, 1, 4])\n',
    'np.random.seed(0)\nnp.random.rand(2)':
        'array([0.5488135 , 0.71518937])\n',
    'np.random.seed(1)\nnp.random.rand(2, 2)':
        'array([[4.17022005e-01, 7.20324493e-01],\n       [1.14374817e-04, 3.02332573e-01]])\n',
    'np.random.seed(2)\nnp.random.randn(3)':
        'array([-0.41675785, -0.05626683, -2.1361961 ])\n',
    'np.random.seed(3)\nnp.random.randint(0, 100, 4)':
        'array([24,  3, 56, 72])\n',
    'from scipy.integrate import quad\nquad(lambda x: x ** 2, 0, 3)':
        '(9.000000000000002, 9.992007221626411e-14)\n',
    'from scipy.integrate import quad\nquad(lambda x: np.exp(-x), 0, np.inf)[0]':
        '1.0000000000000002\n',
    'from scipy.integrate import odeint\nt = np.linspace(0, 1, 3)\nnp.round(odeint(lambda y, t: -y, 1.0, t)[:, 0], 6)':
        'array([1.      , 0.606531, 0.367879])\n',
    'from scipy.integrate import solve_ivp\nsol = solve_ivp(lambda t, y: -2 * y, [0, 1], [1.0], t_eval=[0, 0.5, 1], rtol=1e-8)\nnp.round(sol.y[0], 6)':
        'array([1.      , 0.36788 , 0.135335])\n',
    'from scipy.integrate import trapezoid\ntrapezoid([0, 1, 4, 9], dx=1.0)':
        'np.float64(9.5)\n',
    'from scipy.integrate import simpson\nx = np.linspace(0, 2, 5)\nsimpson(x ** 3, x=x)':
        'np.float64(4.0)\n',
    'from scipy.integrate import cumulative_trapezoid\ncumulative_trapezoid([1, 2, 3, 4], initial=0)':
        'array([0. , 1.5, 4. , 7.5])\n',
    'from scipy.integrate import dblquad\ndblquad(lambda y, x: x * y, 0, 1, 0, 2)[0]':
        '0.9999999999999999\n',
    'math.sqrt(2)':
        '1.4142135623730951\n',
    'math.isqrt(10**20 + 1)':
        '10000000000\n',
    'math.exp(1)':
        '2.718281828459045\n',
    'math.log(100, 10)':
        '2.0\n',
    'math.log(math.e)':
        '1.0\n',
    'math.log10(0.001)':
        '-3.0\n',
    'math.log2(1024)':
        '10.0\n',
    'math.pow(2, 0.5)':
        '1.4142135623730951\n',
    'math.sin(math.pi / 6)':
        '0.49999999999999994\n',
    'math.cos(math.pi / 3)':
        '0.5000000000000001\n',
    'math.tan(math.pi / 4)':
        '0.9999999999999999\n',
    'math.atan2(1, -1)':
        '2.356194490192345\n',
    'math.hypot(3, 4, 12)':
        '13.0\n',
    'math.dist((0, 0), (3, 4))':
        '5.0\n',
    'math.degrees(math.pi / 2)':
        '90.0\n',
    'math.radians(180)':
        '3.141592653589793\n',
    'math.floor(-2.5)':
        '-3\n',
    'math.ceil(2.1)':
        '3\n',
    'math.trunc(-2.7)':
        '-2\n',
    'math.fabs(-3)':
        '3.0\n',
    'math.factorial(20)':
        '2432902008176640000\n',
    'math.comb(10, 3)':
        '120\n',
    'math.perm(5, 2)':
        '20\n',
    'math.gcd(84, 36, 60)':
        '12\n',
    'math.lcm(4, 6, 10)':
        '60\n',
    'math.fsum([0.1] * 10)':
        '1.0\n',
    'sum([0.1] * 10)':
        '1.0\n',
    'math.prod([1, 2, 3, 4])':
        '24\n',
    'math.isclose(0.1 + 0.2, 0.3)':
        'True\n',
    "math.isnan(float('nan'))":
        'True\n',
    'math.isinf(-math.inf)':
        'True\n',
    'math.copysign(3, -0.0)':
        '-3.0\n',
    'math.fmod(-7, 3)':
        '-1.0\n',
    '-7 % 3':
        '2\n',
    'math.remainder(7, 3)':
        '1.0\n',
    'math.remainder(7.5, 2)':
        '-0.5\n',
    'math.modf(3.75)':
        '(0.75, 3.0)\n',
    'math.frexp(40.0)':
        '(0.625, 6)\n',
    'math.ldexp(0.625, 6)':
        '40.0\n',
    'math.erf(1)':
        '0.8427007929497149\n',
    'math.gamma(5.5)':
        '52.34277778455352\n',
    'math.lgamma(100)':
        '359.1342053695754\n',
    'math.nextafter(1.0, 2.0)':
        '1.0000000000000002\n',
    'math.ulp(1.0)':
        '2.220446049250313e-16\n',
    'cmath.sqrt(-4)':
        '2j\n',
    'cmath.exp(1j * math.pi)':
        '(-1+1.2246467991473532e-16j)\n',
    'cmath.log(-1)':
        '3.141592653589793j\n',
    'cmath.phase(-1 + 0j)':
        '3.141592653589793\n',
    'cmath.polar(1j)':
        '(1.0, 1.5707963267948966)\n',
    'cmath.rect(2, math.pi / 2)':
        '(1.2246467991473532e-16+2j)\n',
    'cmath.isclose(cmath.exp(1j * math.pi), -1)':
        'True\n',
    'Fraction(3, 4) + Fraction(1, 6)':
        'Fraction(11, 12)\n',
    "Fraction('1.25')":
        'Fraction(5, 4)\n',
    'Fraction(0.1)':
        'Fraction(3602879701896397, 36028797018963968)\n',
    'Fraction(math.pi).limit_denominator(100)':
        'Fraction(311, 99)\n',
    "list(itertools.product('ab', [1, 2]))":
        "[('a', 1), ('a', 2), ('b', 1), ('b', 2)]\n",
    'list(itertools.permutations([1, 2, 3], 2))':
        '[(1, 2), (1, 3), (2, 1), (2, 3), (3, 1), (3, 2)]\n',
    "list(itertools.combinations('abcd', 2))":
        "[('a', 'b'), ('a', 'c'), ('a', 'd'), ('b', 'c'), ('b', 'd'), ('c', 'd')]\n",
    "list(itertools.combinations_with_replacement('ab', 2))":
        "[('a', 'a'), ('a', 'b'), ('b', 'b')]\n",
    'list(itertools.accumulate([1, 2, 3, 4]))':
        '[1, 3, 6, 10]\n',
    'list(itertools.accumulate([3, 1, 4, 1, 5], max))':
        '[3, 3, 4, 4, 5]\n',
    "list(itertools.chain([1, 2], 'ab'))":
        "[1, 2, 'a', 'b']\n",
    'list(itertools.islice(itertools.count(10, 5), 4))':
        '[10, 15, 20, 25]\n',
    "list(itertools.islice(itertools.cycle('ab'), 5))":
        "['a', 'b', 'a', 'b', 'a']\n",
    'list(itertools.repeat(7, 3))':
        '[7, 7, 7]\n',
    'list(itertools.islice(range(100), 2, 10, 3))':
        '[2, 5, 8]\n',
    "[(k, len(list(g))) for k, g in itertools.groupby('aaabccdd')]":
        "[('a', 3), ('b', 1), ('c', 2), ('d', 2)]\n",
    'list(itertools.pairwise([1, 4, 9, 16]))':
        '[(1, 4), (4, 9), (9, 16)]\n',
    "list(itertools.zip_longest([1, 2, 3], 'ab', fillvalue='-'))":
        "[(1, 'a'), (2, 'b'), (3, '-')]\n",
    'list(itertools.starmap(pow, [(2, 3), (3, 2)]))':
        '[8, 9]\n',
    'list(itertools.takewhile(lambda x: x < 5, [1, 3, 6, 2]))':
        '[1, 3]\n',
    'functools.reduce(lambda a, b: a * b, [1, 2, 3, 4, 5])':
        '120\n',
    "int2 = functools.partial(int, base=2)\nint2('1011')":
        '11\n',
    '@functools.lru_cache(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nfib(80)':
        '23416728348467685\n',
    '@functools.cache\ndef f(n):\n    return n * n\n[f(3), f(3), f.cache_info().hits]':
        '[9, 9, 1]\n',
    "collections.Counter('mississippi').most_common(2)":
        "[('i', 4), ('s', 4)]\n",
    "d = collections.defaultdict(list)\nd['a'].append(1)\ndict(d)":
        "{'a': [1]}\n",
    'd = collections.deque([1, 2, 3], maxlen=3)\nd.append(4)\nd':
        'deque([2, 3, 4], maxlen=3)\n',
    "P = collections.namedtuple('P', 'x y')\nP(1, 2)._replace(y=5)":
        'P(x=1, y=5)\n',
    "d = collections.OrderedDict(a=1, b=2)\nd.move_to_end('a')\nlist(d)":
        "['b', 'a']\n",
    'random.seed(1)\nrandom.random()':
        '0.13436424411240122\n',
    'random.seed(2)\n[random.randint(1, 6) for _ in range(5)]':
        '[1, 1, 1, 3, 2]\n',
    "random.seed(3)\nrandom.choice('abcdef')":
        "'b'\n",
    'random.seed(4)\nx = list(range(6))\nrandom.shuffle(x)\nx':
        '[3, 5, 4, 0, 2, 1]\n',
    'random.seed(5)\nrandom.uniform(10, 20)':
        '16.22901694889702\n',
    'bisect.bisect_left([1, 2, 4, 4, 8], 4)':
        '2\n',
    'a = [1, 3, 5]\nbisect.insort(a, 4)\na':
        '[1, 3, 4, 5]\n',
    'h = []\nfor x in [5, 1, 4, 2]:\n    heapq.heappush(h, x)\n[heapq.heappop(h) for _ in range(4)]':
        '[1, 2, 4, 5]\n',
    'heapq.nlargest(2, [5, 1, 8, 3])':
        '[8, 5]\n',
    'heapq.nsmallest(2, [5, 1, 8, 3])':
        '[1, 3]\n',
}
