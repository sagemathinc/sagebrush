# Browser benchmark: the same program for sagebrush and Pyodide.
# Each case: best of N wall times (ms), measured inside the runtime.
import time, json
import numpy as np

def bench(f, n=5):
    best = 1e9
    for _ in range(n):
        t0 = time.perf_counter()
        f()
        best = min(best, time.perf_counter() - t0)
    return round(best * 1000, 2)

np.random.seed(0)
a = np.random.rand(1000, 1000)
v = np.random.rand(10**6)
m300 = np.random.rand(300, 300)
m200 = np.random.rand(200, 200)
s200 = m200 + m200.T
ints = np.random.randint(0, 1000, 10**5)
x = np.linspace(0, 1, 10**5)
r = {}
r["rand(1000,1000)"] = bench(lambda: np.random.rand(1000, 1000))
r["randn(10^6)"] = bench(lambda: np.random.randn(10**6))
r["sin (10^6, 2-D)"] = bench(lambda: np.sin(a))
r["exp (10^6)"] = bench(lambda: np.exp(v))
r["sqrt (10^6)"] = bench(lambda: np.sqrt(v))
r["a*2+1 (10^6, 2-D)"] = bench(lambda: a * 2 + 1)
r["a+a.T (10^6)"] = bench(lambda: a + a.T)
r["outer broadcast 1000x1000"] = bench(lambda: v[:1000, None] * v[None, :1000])
r["sum (10^6)"] = bench(lambda: a.sum())
r["mean+std (10^6)"] = bench(lambda: (a.mean(), a.std()))
r["sum(axis=0) 1000x1000"] = bench(lambda: a.sum(axis=0))
r["a[a>0.5]"] = bench(lambda: a[a > 0.5])
r["sort 10^6"] = bench(lambda: np.sort(v), 3)
r["argsort 10^5 ints"] = bench(lambda: np.argsort(ints))
r["unique 10^5 ints"] = bench(lambda: np.unique(ints))
r["cumsum 10^6"] = bench(lambda: np.cumsum(v))
r["matmul 300x300"] = bench(lambda: m300 @ m300)
r["inv 200x200"] = bench(lambda: np.linalg.inv(m200))
m1000 = np.random.rand(1000, 1000)
r["det 1000x1000"] = bench(lambda: np.linalg.det(m1000), 2)
r["solve 200x200"] = bench(lambda: np.linalg.solve(m200, v[:200]))
r["eigh 200x200"] = bench(lambda: np.linalg.eigh(s200), 3)
r["svd 200x200"] = bench(lambda: np.linalg.svd(m200), 3)
r["eig 100x100"] = bench(lambda: np.linalg.eig(m200[:100, :100]), 3)
r["fft 2^16"] = bench(lambda: np.fft.fft(v[:65536]))
r["rfft 10^6"] = bench(lambda: np.fft.rfft(v), 3)
r["polyfit deg 5, 10^5 pts"] = bench(lambda: np.polyfit(x, np.sin(x), 5), 3)
r["histogram 10^6"] = bench(lambda: np.histogram(v, bins=50), 3)
r["python loop a[i] 10^4"] = bench(lambda: sum(v[i] for i in range(10**4)))
r["tolist 10^6"] = bench(lambda: v.tolist())

def primes(n):
    sieve = bytearray([1]) * (n + 1)
    sieve[:2] = b"\x00\x00"
    for p in range(2, int(n ** 0.5) + 1):
        if sieve[p]:
            sieve[p * p::p] = bytes(len(range(p * p, n + 1, p)))
    return sum(sieve)

def pyloop():
    s = 0
    for i in range(10**6):
        s += i * i % 7
    return s

r["pure Python loop 10^6"] = bench(pyloop, 3)
r["pure Python sieve 10^6"] = bench(lambda: primes(10**6), 3)
print("RESULT " + json.dumps(r))
