import numpy as np
x = np.array([0.0, 0.5, 1.0, 2.0, 10.0])
for f in [np.sqrt, np.exp, np.log1p, np.sin, np.cos, np.tan, np.arctan, np.sinh, np.cosh, np.tanh, np.floor, np.ceil,
          np.rint, np.trunc, np.square, np.sign, np.exp2, np.expm1, np.cbrt, np.deg2rad, np.rad2deg, np.arcsinh]:
    print(f.__name__, repr(f(x)))
y = np.array([1.0, 2.0, 10.0, 100.0])
print(repr(np.log(y)), repr(np.log10(y)), repr(np.log2(y)), repr(np.arcsin(np.array([0, 0.5, 1]))), repr(np.arccos(np.array([1, 0.5]))))
print(repr(np.sin(np.arange(4))), repr(np.sqrt(np.array([4, 9], dtype=np.int32))), repr(np.sqrt(np.array([2, 3], dtype=np.float32))))
print(repr(np.isnan(np.array([1, np.nan]))), repr(np.isinf(np.array([np.inf, -np.inf, 0]))), repr(np.isfinite(np.array([1, np.nan, np.inf]))))
print(repr(np.arctan2(np.array([1, -1]), np.array([-1, -1]))), repr(np.hypot(3, 4)), repr(np.hypot(np.array([3.0]), np.array([4.0]))))
print(repr(np.round(np.array([0.5, 1.5, 2.5, -0.5, 2.675]), 0)), repr(np.round(np.array([1.2345, 2.5678]), 2)), repr(np.around(3.14159, 3)))
print(repr(np.clip(np.arange(10), 2, 7)), repr(np.clip(np.array([-1.5, 0.5, 9.0]), 0, 1)))
print(repr(np.sin(np.pi)), repr(np.sqrt(2)), repr(np.exp(1)), repr(np.abs(-3)), repr(np.floor(-2.5)), repr(np.maximum(1, 2.5)))
print(repr(np.add.reduce(np.arange(5))), repr(np.multiply.reduce(np.arange(1, 6))), repr(np.add.accumulate(np.arange(5))), repr(np.multiply.outer(np.arange(3), np.arange(3))))
print(repr(np.add(np.arange(3), 1, out=np.zeros(3))), np.add, np.sin)
print(repr(np.logical_and(np.array([1, 0, 1]), np.array([1, 1, 0]))), repr(np.logical_not(np.array([True, False]))), repr(np.logical_xor(True, False)))
print(repr(np.sqrt(-1.0)), repr(np.sqrt(np.array([-1 + 0j]))), repr(np.exp(np.array([1j * np.pi]))))
print(repr(np.copysign(1, -0.0)), repr(np.fmax(np.array([1, np.nan]), np.array([np.nan, 2]))), repr(np.maximum(np.array([1, np.nan]), 0)))
