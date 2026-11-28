# np.hypot of float64 as NumPy 2.5.5 gives it on x86-64 Linux, where it calls glibc 2.43's hypot (the 2021
# rewrite, built without FMA): one value per line as float.hex(), compared in test/numpy-hypot.test.ts. Includes
# the inputs where that is one ulp from the correctly rounded value, the scaling thresholds (2^511, 2^-459) and
# their edges, subnormals, and Inf/NaN.
import numpy as np
rows = [(3.1622776601683795, 2.0), (-1.0, 3.0), (0.0, 0.0), (-0.0, 0.0), (3.0, 4.0), (1.0, 1.0),
        (float("inf"), float("nan")), (float("nan"), float("-inf")), (float("nan"), 1.0),
        (5e-324, 5e-324), (2.2250738585072014e-308, 1e-310), (1.7976931348623157e308, 1.7976931348623157e308),
        (2.0 ** 511, 2.0 ** 500), (2.0 ** 512, 1.5 * 2.0 ** 490), (2.0 ** -459, 2.0 ** -459), (2.0 ** -460, 3.0 * 2.0 ** -470),
        (1.0, 2.0 ** -54), (1.0, 2.0 ** -53), (1e300, 1e300), (1e-300, 3e-300)]
s = 0x2389
for _ in range(80):
    s = (s * 6364136223846793005 + 1442695040888963407) % 2 ** 64
    x = ((s >> 11) / 2 ** 53 - 0.5) * 20
    s = (s * 6364136223846793005 + 1442695040888963407) % 2 ** 64
    y = ((s >> 11) / 2 ** 53 - 0.5) * 20
    rows.append((x, y))
for x, y in rows:
    print(float(np.hypot(np.float64(x), np.float64(y))).hex())
print(" ".join(float(v).hex() for v in np.hypot(np.array([r[0] for r in rows[:6]]), np.array([r[1] for r in rows[:6]]))))
