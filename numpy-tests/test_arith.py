import numpy as np
a = np.array([1, 2, 3, 4])
b = np.array([0.5, -1.5, 2.0, 8.0])
for r in [a + b, a - b, a * b, a / b, a // 3, a % 3, a ** 2, b ** 2, -a, abs(-b), a + 1, 2 * b, 1 / a, a / 2, a // 2.5,
          b // 2, b % 2, -b % 3, a == 2, a != 2, a < 3, b >= 2, a & 1, a | 8, a ^ 3, ~a, a << 2, a >> 1,
          np.maximum(a, 2.5), np.minimum(b, 0), np.power(a, 3), np.mod(a, -3), np.floor_divide(-a, 3), np.true_divide(a, 4)]:
    print(repr(r))
m = np.arange(6).reshape(2, 3)
print(repr(m + np.array([10, 20, 30])), repr(m * np.array([[2], [3]])), repr(m[:, None, :] + m[None, :, :]))
print(repr(np.array([True, False]) + np.array([True, True])), repr(np.array([True, False]) & np.array([True, True])))
print(repr(np.array([1, 2], dtype=np.int8) + 1), repr(np.array([1, 2], dtype=np.int8) + 1.5), repr(np.array([1.5], dtype=np.float32) * 2))
print(repr(np.array([100], dtype=np.int8) * 2), repr(np.array([1, 2], dtype=np.int32) + np.array([1, 2], dtype=np.int64)))
print(repr(np.array([1, 2], dtype=np.uint8) - 3), repr(np.array([1.0, 2]) / 0), repr(np.array([-1.0, 0, 1]) / 0))
c = np.array([1 + 2j, 3 - 1j])
print(repr(c * c), repr(c + 1), repr(c / (1 + 1j)), repr(abs(c)), repr(c.real), repr(c.imag), repr(c.conj()))
x = np.arange(5.0)
x += 1; x *= 2; x -= 0.5; x /= 2
print(repr(x))
y = np.arange(5)
y += 3; y *= 2; y //= 3
print(repr(y))
print(repr(np.float64(1.5) + 1), repr(np.int64(7) // 2), repr(np.int64(7) / 2), repr(np.float64(2) ** 0.5), repr(np.int32(3) * 2))
print(repr(a.sum() + 0.5), repr(a.max() * 2), repr(np.float64(1) == 1), repr(np.bool_(True) + 1))
print(repr(np.array([1, 2]) == np.array([1, 3])), np.array_equal([1, 2], [1, 2]), repr(np.array([np.nan]) == np.nan))
