import numpy as np
m = np.arange(24, dtype=float).reshape(2, 3, 4) * 0.1
for ax in [None, 0, 1, 2, -1, (0, 2), (1, 2)]:
    print(ax, repr(m.sum(axis=ax)), repr(m.mean(axis=ax)), repr(m.max(axis=ax)), repr(m.min(axis=ax)))
    print(repr(m.std(axis=ax)), repr(m.var(axis=ax, ddof=1)), repr(m.prod(axis=ax)))
print(repr(m.sum(axis=1, keepdims=True)), repr(m.mean(axis=(0, 1), keepdims=True)))
r = np.arange(1000) * 0.1
print(repr(r.sum()), repr(r.mean()), repr(r.std()), repr(np.sum(r ** 2)), repr((r * 1.1).sum()))
z = np.linspace(0, 1, 1001)
print(repr(z.sum()), repr(np.sin(z).sum()), repr(np.cos(z * 7).mean()), repr(np.var(z)))
i = np.arange(12).reshape(3, 4)
print(repr(i.sum()), repr(i.sum(axis=0)), repr(i.mean()), repr(i.mean(axis=1)), repr(i.prod(axis=1)), repr(i.std()), repr(i.var(axis=0)))
print(repr(i.argmax()), repr(i.argmax(axis=0)), repr(i.argmin(axis=1)), repr(np.argmax(np.array([1, 5, 5, 2]))))
print(repr(i.cumsum()), repr(i.cumsum(axis=0)), repr(i.cumprod(axis=1)), repr(np.cumsum(np.array([0.1] * 10))))
print(repr(np.all(i > -1)), repr(np.any(i > 10)), repr(i.all(axis=0)), repr((i % 2 == 0).any(axis=1)))
print(repr(np.median(np.array([3, 1, 4, 1, 5]))), repr(np.median(i, axis=1)), repr(np.percentile(np.arange(10), [10, 50, 90])))
print(repr(np.quantile(np.array([1.0, 2, 4, 8]), 0.3)), repr(np.average(np.array([1, 2, 3]), weights=[3, 2, 1])))
print(repr(np.ptp(i)), repr(np.count_nonzero(i)), repr(np.nansum(np.array([1, np.nan, 2]))), repr(np.nanmean(np.array([1, np.nan, 3]))))
print(repr(np.nanmax(np.array([1, np.nan, 3]))), repr(np.max(np.array([1, np.nan, 3]))), repr(np.sum(np.array([True, True, False]))))
b = np.array([1, 2, 3], dtype=np.int8)
print(repr(b.sum()), repr(b.sum().dtype), repr(np.array([1.5], dtype=np.float32).sum()), repr(np.array([], dtype=float).sum()))
print(repr(np.cov(np.array([[1, 2, 3], [2, 4, 7]]))), repr(np.corrcoef(np.array([1, 2, 3, 4]), np.array([2, 4, 5, 9]))))
