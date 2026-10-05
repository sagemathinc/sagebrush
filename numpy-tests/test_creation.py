import numpy as np
for a in [np.array([1, 2, 3]), np.array([1.0, 2, 3]), np.array([[1, 2], [3, 4]]), np.array([True, False]),
          np.array([1, 2.5]), np.array([1 + 2j, 3]), np.array(5), np.array(2.5), np.array([]), np.zeros((2, 0)),
          np.array([[1.5, -2.25], [1e3, 0.125]]), np.array([0.1, 0.2, 0.3]), np.array([1/3, 2/3])]:
    print(repr(a), a.dtype, a.shape, a.ndim, a.size)
    print(a)
print(repr(np.arange(5)), repr(np.arange(1, 10, 2)), repr(np.arange(0, 1, 0.25)), repr(np.arange(5.0)))
print(repr(np.linspace(0, 1, 11)), repr(np.linspace(-1, 1, 4)), repr(np.linspace(0, 10, 5, endpoint=False)))
print(repr(np.zeros(3)), repr(np.ones((2, 3), dtype=int)), repr(np.full((2, 2), 7)), repr(np.full(3, 1.5)))
print(repr(np.eye(3)), repr(np.eye(2, 3, k=1)), repr(np.identity(2, dtype=int)))
print(repr(np.zeros_like(np.arange(4))), repr(np.ones_like(np.array([1.5, 2]))), repr(np.full_like(np.arange(3), 9)))
print(repr(np.array([1, 2, 3], dtype=np.float32)), repr(np.array([1, 2, 3], dtype="int8")), repr(np.array([200, 5], dtype=np.uint8)))
for bad in ([300, -5], [-1]):
    try:
        np.array(bad, dtype=np.uint8)
    except OverflowError as err:
        print("OverflowError:", err)
try:
    np.array([1, 2], dtype=np.int8) + 300
except OverflowError as err:
    print("OverflowError:", err)
print(repr(np.array([[1, 2], [3, 4]], dtype=float)), repr(np.array([1.7, -1.7]).astype(int)), repr(np.arange(3).astype(bool)))
print(repr(np.array(range(4))), repr(np.array((1, 2))), repr(np.array([np.arange(2), np.arange(2)])))
print(repr(np.logspace(0, 2, 3)), repr(np.diag([1, 2, 3])), repr(np.diag(np.arange(9).reshape(3, 3))))
print(repr(np.tri(3)), repr(np.tril(np.ones((3, 3)))), repr(np.triu(np.arange(9).reshape(3, 3), 1)))
X, Y = np.meshgrid(np.arange(3), np.arange(2))
print(repr(X), repr(Y))
print(np.array([1, 2]).dtype == np.int64, np.dtype("float64"), repr(np.dtype(float)), np.dtype("i4").name, np.float64 is np.double)
print(np.array([1, 2], dtype=np.float32).dtype, np.empty(3).shape, np.array(3.0).item(), type(np.array([1]).tolist()[0]).__name__)
