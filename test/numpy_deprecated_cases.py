# The six names NumPy 2.0 removed, which Sagebrush keeps for old scripts:
# their values, as NumPy 1.x's (values only: the warnings are Sagebrush's
# own, checked in test/numpy-deprecated.test.ts)
import warnings
import numpy as np

warnings.simplefilter("ignore")
a = np.array([[1, 2], [3, 4]])
print(np.asfarray([1, 2]).tolist(), np.asfarray([1, 2]).dtype.name, np.asfarray([1, 2], dtype=np.int32).dtype.name,
      np.asfarray([1, 2], dtype=np.float32).dtype.name, np.asfarray([1j], dtype=complex).dtype.name)
print(np.in1d([1, 2, 3, 4], [2, 4]).tolist(), np.in1d([1, 2, 3], [1], invert=True).tolist())
print(int(np.product([1, 2, 3, 4])), np.product(a, axis=0).tolist())
print(float(np.round_(2.675, 2)), np.round_(np.array([1.5, 2.5, -0.5])).tolist())
print(np.row_stack(([1, 2], [3, 4])).tolist())
print(float(np.trapz([1, 2, 3])), float(np.trapz([1, 2, 3], x=[0, 1, 3])), float(np.trapz([1.0, 4.0], dx=0.5)))
# dtype=None keeps the input's type; in1d is 1-D; round_ writes out (CORR-B12-1)
print(np.asfarray([1, 2], dtype=None).dtype.name, np.asfarray([True], dtype=None).dtype.name, np.asfarray([1j], dtype=None).dtype.name, np.asfarray([1, 2]).dtype.name)
print(np.in1d(np.array([[1, 2], [3, 4]]), [2, 3]).tolist(), np.in1d(np.array([[1, 2], [3, 4]]), [2, 3]).shape)
o = np.zeros(3)
r = np.round_(np.array([1.25, 2.5, -0.75]), 1, out=o)
print(r is o, o.tolist())
o = np.zeros(2, dtype=np.int64)
try:
    np.round_(np.array([1.6, -2.4]), out=o)
except TypeError:
    print('float into int out: TypeError', o.tolist())
o = np.zeros(2)
print(np.round_(np.array([3, 4]), out=o).tolist(), o.dtype.name)
# round_ into out: same shape, same_kind casting, computed in the wider type (CORR-90C-1..3)
def tt(f):
    try:
        r = f()
        return repr(r.tolist()) + ' ' + r.dtype.name
    except TypeError:
        return 'TypeError'
    except ValueError as e:
        return 'ValueError: ' + str(e)
for label, f in [
    ('shape', lambda: np.round_(np.arange(3.0), out=np.zeros((2, 3)))),
    ('i32 to u8', lambda: np.round_(np.array([-1], np.int32), out=np.zeros(1, np.uint8))),
    ('int, negative decimals, to int', lambda: np.round_(np.array([155]), -1, out=np.zeros(1, np.int64))),
    ('i64 to i32', lambda: np.round_(np.array([155]), out=np.zeros(1, np.int32))),
    ('i32 to i64', lambda: np.round_(np.array([155], np.int32), out=np.zeros(1, np.int64))),
    ('int to f64', lambda: np.round_(np.array([155]), out=np.zeros(1))),
    ('int, negative decimals, to f64', lambda: np.round_(np.array([155]), -1, out=np.zeros(1))),
    ('f32 to f64', lambda: np.round_(np.array([125.125], np.float32), 1, out=np.zeros(1))),
    ('f64 to f32', lambda: np.round_(np.array([125.125]), 1, out=np.zeros(1, np.float32))),
    ('c128 to f64', lambda: np.round_(np.array([1.25 + 0j]), 1, out=np.zeros(1))),
    ('bool to bool', lambda: np.round_(np.array([True]), out=np.zeros(1, bool))),
    ('0-d', lambda: np.round_(np.array(1.5), out=np.zeros(()))),
    ('list out', lambda: np.round_(np.array([1.5]), out=[0.0])),
]:
    print(label, '|', tt(f))
