# Browser benchmark: the same program for sagebrush and Pyodide.
# Each case: best of N wall times (ms), measured inside the runtime.
import time, json
import numpy as np

def digest(y):
    """A summary of a result, compared between the runtimes outside the timers
    (a timing of a wrong answer is not a benchmark)."""
    if isinstance(y, (tuple, list)) and not (y and isinstance(y[0], (int, float))):
        return [digest(z) for z in y]
    a = np.asarray(y)
    if a.dtype.kind in "iub":
        return [list(a.shape), int(a.astype(np.int64).sum())]
    t = float(np.abs(a).sum())
    return [list(a.shape), float("%.6g" % t) if t == t and abs(t) != float("inf") else str(t)]


r, med, chk = {}, {}, {}


def case(name, f, n=5):
    """Best and median of n wall times (ms), and a digest of the answer."""
    times, y = [], None
    for _ in range(n):
        t0 = time.perf_counter()
        y = f()
        times.append(time.perf_counter() - t0)
    times.sort()
    r[name] = round(times[0] * 1000, 2)
    med[name] = round(times[len(times) // 2] * 1000, 2)
    chk[name] = digest(y)

np.random.seed(0)
a = np.random.rand(1000, 1000)
v = np.random.rand(10**6)
m300 = np.random.rand(300, 300)
m200 = np.random.rand(200, 200)
s200 = m200 + m200.T
ints = np.random.randint(0, 1000, 10**5)
x = np.linspace(0, 1, 10**5)
case("rand(1000,1000)", lambda: np.random.rand(1000, 1000))
case("randn(10^6)", lambda: np.random.randn(10**6))
case("sin (10^6, 2-D)", lambda: np.sin(a))
case("exp (10^6)", lambda: np.exp(v))
case("sqrt (10^6)", lambda: np.sqrt(v))
case("a*2+1 (10^6, 2-D)", lambda: a * 2 + 1)
case("a+a.T (10^6)", lambda: a + a.T)
case("outer broadcast 1000x1000", lambda: v[:1000, None] * v[None, :1000])
case("sum (10^6)", lambda: a.sum())
case("mean+std (10^6)", lambda: (a.mean(), a.std()))
case("sum(axis=0) 1000x1000", lambda: a.sum(axis=0))
case("a[a>0.5]", lambda: a[a > 0.5])
case("sort 10^6", lambda: np.sort(v), 3)
case("argsort 10^5 ints", lambda: np.argsort(ints))
case("unique 10^5 ints", lambda: np.unique(ints))
case("cumsum 10^6", lambda: np.cumsum(v))
case("matmul 300x300", lambda: m300 @ m300)
case("inv 200x200", lambda: np.linalg.inv(m200))
m1000 = np.random.rand(1000, 1000)
case("det 1000x1000", lambda: np.linalg.det(m1000), 2)
case("solve 200x200", lambda: np.linalg.solve(m200, v[:200]))
case("eigh 200x200", lambda: np.linalg.eigh(s200), 3)
case("svd 200x200", lambda: np.linalg.svd(m200), 3)
case("eig 100x100", lambda: np.linalg.eig(m200[:100, :100]), 3)
case("fft 2^16", lambda: np.fft.fft(v[:65536]))
case("rfft 10^6", lambda: np.fft.rfft(v), 3)
case("polyfit deg 5, 10^5 pts", lambda: np.polyfit(x, np.sin(x), 5), 3)
case("histogram 10^6", lambda: np.histogram(v, bins=50), 3)
case("python loop a[i] 10^4", lambda: sum(v[i] for i in range(10**4)))
case("tolist 10^6", lambda: v.tolist())

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

case("pure Python loop 10^6", pyloop, 3)
case("pure Python sieve 10^6", lambda: primes(10**6), 3)
print("RESULT " + json.dumps({"best": r, "median": med, "check": chk}))
