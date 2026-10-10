import numpy as np
np.random.seed(0)
print(repr(np.random.rand(5)), repr(np.random.rand()), repr(np.random.rand(2, 3)))
print(repr(np.random.randn(6)), repr(np.random.randn()))
print(repr(np.random.randint(0, 10, size=12)), repr(np.random.randint(5)), repr(np.random.randint(-1000, 10**6, 4)))
print(repr(np.random.normal(5, 2, size=4)), repr(np.random.uniform(-1, 1, 3)), repr(np.random.random((2, 2))))
print(repr(np.random.exponential(2.0, 3)), repr(np.random.poisson(3.0, 8)), repr(np.random.poisson(25.0, 8)))
a = np.arange(10); np.random.shuffle(a); print(repr(a))
print(repr(np.random.permutation(8)), repr(np.random.choice(5, 6)), repr(np.random.choice([10, 20, 30], 4, p=[0.1, 0.3, 0.6])))
print(repr(np.random.choice(10, 4, replace=False)), repr(np.random.choice(["a", "b", "c"], 3) if False else 0))
rs = np.random.RandomState(42)
print(repr(rs.rand(3)), repr(rs.randn(3)), repr(rs.randint(0, 100, 5)), repr(rs.normal(size=2)))
np.random.seed(12345)
x = np.random.randn(1000)
print(repr(x.mean()), repr(x.std()), repr(np.sort(x)[:3]))
g = np.random.default_rng(42)
print(repr(g.random(5)), repr(g.integers(0, 10, 8)), repr(g.integers(100)), repr(g.uniform(1, 2, 3)))
print(repr(g.permutation(10)), repr(g.choice(10, 3)), repr(g.choice(10, 4, replace=False)), repr(g.integers(0, 2**40, 3)))
g2 = np.random.default_rng(2024)
print(repr(g2.random()), repr(g2.integers(1, 7, size=(2, 3))))
b = np.arange(6); g2.shuffle(b); print(repr(b))

# Generator's normals and exponentials: NumPy's ziggurats (with glibc's
# exp and log1p in the rare branches), bit for bit
for seed in (0, 7, 2024):
    g = np.random.default_rng(seed)
    a = g.standard_normal(200000)
    print(repr(a[:3]), repr(float(a.sum())), repr(float(a.min())), repr(float(a.max())))
    b = g.exponential(2.0, 100000)
    print(repr(b[:3]), repr(float(b.sum())), repr(float(b.max())))
    c = g.normal(5, 3, (100, 50))
    print(repr(float(c.sum())), repr(g.standard_exponential(4)), repr(g.standard_normal()), repr(g.random(2)))
x = np.random.default_rng(1).random(10**5) * 2 - 0.999
print(repr(float(np.log1p(x).sum())), repr(np.log1p(np.array([1e-300, 0.25, -0.5, 3.0, 1e6, 2.0**52]))))

# R2-NUM-F7: array parameters give one draw per broadcast element
g = np.random.default_rng(73)
a = g.normal(scale=np.ones(2)); print(a[0] != a[1], a.shape)
print(g.uniform(high=np.ones(3)).shape, g.exponential(scale=[1.0, 2.0]).shape, g.poisson(lam=[1.0, 50.0]).shape)
print(g.normal(loc=[0.0, 10.0], size=(3, 2)).shape)
try:
    g.normal(loc=[0.0, 1.0, 2.0], size=2)
except ValueError as e:
    print("ValueError")
r = np.random.RandomState(5)
print(r.normal([0.0, 1.0], 1.0).round(6).tolist(), r.uniform(0, [1.0, 2.0, 3.0]).round(6).tolist())
print(r.exponential([1.0, 2.0]).round(6).tolist(), r.poisson([1.0, 3.0, 100.0]).tolist(), r.poisson(4.0, size=3).tolist())
print(type(r.normal()).__name__, type(g.normal()).__name__, r.normal(size=2).round(6).tolist())
print(r.exponential(np.array([[1.0], [2.0]]), size=(2, 3)).round(6).tolist())
