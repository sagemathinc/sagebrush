import numpy as np
from numpy.exceptions import AxisError

# np.take_along_axis: arr's values at indices along one axis, the indices broadcasting against arr on every other
# axis; axis None takes from arr flattened; NumPy's refusals


def show(name, f):
    try:
        r = f()
        print(name, "->", repr(r), r.dtype, r.shape)
    except AxisError as e:
        print(name, "AxisError", str(e))
    except (ValueError, IndexError, TypeError, AttributeError) as e:
        print(name, type(e).__name__, str(e))


a = np.array([[10, 30, 20], [60, 40, 50]])
b = np.arange(24.0).reshape(2, 3, 4) * np.array([1.0, -1.0, 0.5, 2.0])
show("sort rows", lambda: np.take_along_axis(a, np.argsort(a, axis=1), axis=1))
show("sort columns", lambda: np.take_along_axis(a, np.argsort(a, axis=0), axis=0))
show("default axis -1", lambda: np.take_along_axis(a, np.argsort(a)))
show("max keepdims", lambda: np.take_along_axis(a, np.argmax(a, axis=1, keepdims=True), axis=1))
show("min and max", lambda: np.take_along_axis(a, np.concatenate([np.argmin(a, axis=1, keepdims=True), np.argmax(a, axis=1, keepdims=True)], axis=1), axis=1))
show("negative axis", lambda: np.take_along_axis(a, np.array([[2], [0]]), axis=-1))
show("negative indices", lambda: np.take_along_axis(a, np.array([[-1, -3], [-2, 0]]), axis=1))
show("indices broadcast on axis 0", lambda: np.take_along_axis(a, np.array([[2, 0, 1, 1]]), axis=1))
show("arr broadcast", lambda: np.take_along_axis(np.array([[1, 2, 3]]), np.array([[0], [2], [1]]), axis=1))
for ax in (0, 1, 2, -1, -3):
    show(f"3-d sort axis {ax}", lambda: np.take_along_axis(b, np.argsort(b, axis=ax), axis=ax))
show("3-d gather", lambda: np.take_along_axis(b, np.array([[[3, 0]], [[1, 2]]]), axis=2))
show("1-d", lambda: np.take_along_axis(np.array([5.0, 6.0, 7.0]), np.array([2, 2, 0, 1]), axis=0))
show("axis None", lambda: np.take_along_axis(a, np.array([5, 0, 3]), axis=None))
show("axis None view", lambda: np.take_along_axis(a.T, np.array([1, 4]), axis=None))
show("int8 indices", lambda: np.take_along_axis(a, np.array([[1], [2]], dtype=np.int8), axis=1))
show("uint indices", lambda: np.take_along_axis(a, np.array([[1], [2]], dtype=np.uint32), axis=1))
show("empty indices", lambda: np.take_along_axis(a, np.zeros((2, 0), dtype=np.int64), axis=1))
show("float arr", lambda: np.take_along_axis(np.array([[1.5, -0.0, np.nan]]), np.array([[2, 1, 0]]), axis=1))
show("complex arr", lambda: np.take_along_axis(np.array([[1 + 2j, 3j]]), np.array([[1, 0]]), axis=1))
show("bool arr", lambda: np.take_along_axis(np.array([[True, False]]), np.array([[1, 1]]), axis=1))
show("string arr", lambda: np.take_along_axis(np.array([["b", "a", "c"]]), np.argsort(np.array([["b", "a", "c"]])), axis=1))
r = np.take_along_axis(a, np.argsort(a, axis=1), axis=1)
r[0, 0] = 99
print("a copy:", a[0].tolist())

# refusals
show("axis out of range", lambda: np.take_along_axis(a, np.array([[0], [1]]), axis=2))
show("axis -3", lambda: np.take_along_axis(a, np.array([[0], [1]]), axis=-3))
show("float indices", lambda: np.take_along_axis(a, np.array([[0.0], [1.0]]), axis=1))
show("bool indices", lambda: np.take_along_axis(a, np.array([[True], [False]]), axis=1))
show("fewer dims", lambda: np.take_along_axis(a, np.array([0, 1]), axis=1))
show("more dims", lambda: np.take_along_axis(a, np.zeros((2, 1, 1), dtype=int), axis=1))
show("axis None, 2-d indices", lambda: np.take_along_axis(a, np.array([[0]]), axis=None))
show("index out of bounds", lambda: np.take_along_axis(a, np.array([[3], [0]]), axis=1))
show("index too negative", lambda: np.take_along_axis(a, np.array([[0], [-4]]), axis=1))
show("shapes don't broadcast", lambda: np.take_along_axis(a, np.zeros((3, 1), dtype=int), axis=1))
show("list arr", lambda: np.take_along_axis([[1, 2]], np.array([[0]]), axis=1))

# an advanced index's arrays that don't broadcast together: NumPy's IndexError, in its words (any fancy index)
m = np.zeros((2, 3))
show("fancy index shapes", lambda: m[np.zeros((2, 1), dtype=int), np.zeros((3, 1), dtype=int)])
show("fancy index lists", lambda: m[[0, 1], [0, 1, 2]])
show("fancy index 3 arrays", lambda: np.zeros((2, 2, 2))[[0], [0, 1], [0, 1, 1]])
show("fancy index broadcast ok", lambda: m[np.array([[0], [1]]), np.array([0, 2])])
show("operands still ValueError", lambda: np.ones(3) + np.ones(2))
