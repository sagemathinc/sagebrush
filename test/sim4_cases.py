# Sim run 4's NumPy gap: ufunc.at (np.add.at, ...); matplotlib's semilogx,
# semilogy and loglog are sim4_mpl_cases.py. Run by
# test/sim4-gaps.test.ts, which compares what this prints with python3's
# (NumPy 2.5.1).
import numpy as np


def show(f):
    try:
        r = f()
        print(repr(r))
    except Exception as e:
        print(type(e).__name__, e)


# ufunc.at: unbuffered, a repeated index operated on as many times
a = np.zeros(5); np.add.at(a, [0, 1, 1, 3], 1); print(a)
a = np.arange(6.0); np.add.at(a, [0, 0, 2], [10, 20, 30]); print(a)
a = np.zeros((3, 3)); np.add.at(a, (np.array([0, 0, 2]), np.array([1, 1, 0])), 1); print(a)
a = np.zeros((3, 3)); np.add.at(a, [0, 0], [1, 2, 3]); print(a)
a = np.zeros((2, 3)); np.add.at(a, (slice(None), [0, 0]), 1); print(a)
a = np.arange(5); np.negative.at(a, [0, 2]); print(a)
a = np.array([5, 1, 7]); np.maximum.at(a, [0, 1, 1], [3, 9, 4]); print(a)
a = np.array([5, 1, 7]); np.minimum.at(a, [2, 2], [6, 3]); print(a)
a = np.ones(4); np.multiply.at(a, [1, 1, 2], 3); print(a)
a = np.arange(5); np.subtract.at(a, [4, 4], 1); print(a)
a = np.array([1, 2, 3]); np.add.at(a, 0, 1.5); print(a, a.dtype)
a = np.zeros(3, dtype=int); np.add.at(a, [True, False, True], 1); print(a)
a = np.zeros(3); np.add.at(a, -1, 5); print(a)
a = np.zeros(4); np.add.at(a, np.array([[0, 1], [1, 3]]), np.array([[1, 2], [3, 4]])); print(a)
a = np.zeros(5); np.add.at(a, slice(1, 4), 2); print(a)
a = np.zeros(5); np.add.at(a, [], 2); print(a)
a = np.zeros(3, dtype=np.int32); np.add.at(a, [0, 0], 2**31 - 1); print(a, a.dtype)
print(np.add.at(np.zeros(3), [0], 1))
# (a histogram by np.add.at, as the run's notebook did)
rng = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5]
counts = np.zeros(10, dtype=int); np.add.at(counts, rng, 1); print(counts)
show(lambda: np.add.at([1, 2], 0, 1))
show(lambda: np.add.at(np.zeros(3), [5], 1))
show(lambda: np.negative.at(np.zeros(3), [0], 1))
show(lambda: np.add.at(np.zeros(3), [0, 1], [1, 2, 3]))
