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
