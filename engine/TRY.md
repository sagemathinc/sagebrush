# Trying Sagebrush interactively

Sagebrush builds local, unpublished modules from the same Rust engines: a
CPython package (PyO3) and a Node.js native addon (napi-rs). Both are
multithreaded (`threads=0` means all cores), and exact coefficients have
arbitrary precision (Python `int`, JS `BigInt`). Each engine is a
submodule; today there is one, `modsym`.

## Start a REPL

    ~/sagebrush/engine/try-python     # IPython: sagebrush, and m = sagebrush.modsym
    ~/sagebrush/engine/try-node       # Node REPL: the same

Or import it yourself:

    ~/sagebrush/engine/.venv/bin/python -c "from sagebrush import modsym; print(modsym.charpoly_exact(37, 2))"
    node -e 'const { modsym } = require(process.env.HOME + "/sagebrush/engine/node"); console.log(modsym.charpolyExact(37, 2))'
    ~/sagebrush/engine/target/release/sagebrush modsym 37 2 --exact

## `sagebrush.modsym` (Python name / JS name)

| Python | JS | returns |
|---|---|---|
| `charpoly_exact(N, q, threads=0)` | `charpolyExact(N, q, threads?)` | proven charpoly of T_q over Z (constant term first), status, checks |
| `batch_exact(levels, q, threads=0)` | `batchExact(levels, q, threads?)` | the above for many levels in parallel; bad levels get `error` |
| `hecke_charpoly(N, q, p=67108859, threads=0)` | `heckeCharpoly(N, q, p?, threads?)` | charpoly mod p, dim, timings |
| `level_data(N)` | `levelData(N)` | psi, genus, cusps, Eisenstein dim, dim |
| `estimate(N, q)` | `estimate(N, q)` | predicted dim, primes, bytes, one-thread seconds |
| `commute(N, q, r, p=..., threads=0)` | `commute(N, q, r, p?, threads?)` | T_q T_r == T_r T_q mod p |
| `rational_newforms(N, bound=1000, threads=0)` | (Python only for now) | the rational newforms of level N: [(p, a_p)] for p <= bound, p not dividing N |

Space: weight 2, Gamma0(N), sign +1 modular symbols. q must be a prime
not dividing N (otherwise ValueError / a thrown Error).

## `sagebrush.ap` (Python name = JS name)

| function | returns |
|---|---|
| `ap(a, p)` | a_p of the curve a = [a1,a2,a3,a4,a6] at the prime p (None/null at bad p) |
| `aplist(a, n, threads=0)` | Python: [(p, a_p)] for p <= n. JS: {primes, ap} |
| `aplist_many(curves, n, threads=0)` | Python only: aplist for many curves, in parallel over curves |
| `moments(a, n, kmax=4, threads=0)` | (number of good p, [mean (a_p^2/p)^k for k = 1..kmax]): Sato-Tate |

    from sagebrush import ap
    ap.moments([0, -1, 1, -10, -20], 10**7)    # ~0.4 s: (664578, [1.0, 2.0, 5.0, 14.0])
    ap.moments([0, 0, 1, 0, 0], 10**7)         # CM: [1, 3, 10, 35]
    ~/sagebrush/engine/target/release/sagebrush ap "[0,-1,1,-10,-20]" 100000000

## Things to try

    m.charpoly_exact(37, 2)["charpoly"]      # [0, -6, -1, 1] = x (x - 3)(x + 2)
    m.estimate(20011, 2)                     # what would a big one cost?
    r = m.batch_exact(range(11, 500, 2), 2)  # 245 levels, well under a second
    m.charpoly_exact(2310, 13)["dim"]        # 592, coefficients up to ~1000 bits

    m.charpolyExact(389, 2).charpoly         // BigInts
    m.batchExact([33, 35, 37], 3)            // 33 fails (3 | 33), others proven

The calls are synchronous: in Node a big one blocks the REPL until it is
done, and in Python the GIL is released (other threads keep running).

## Building (once) and rebuilding after changing Rust code

    cd ~/sagebrush/engine
    uv venv .venv && uv pip install --python .venv/bin/python maturin ipython
    (cd py && ../.venv/bin/maturin develop --release)   # Python package
    node/build.sh                                       # Node addon
    cargo build --release -p sagebrush-cli              # sagebrush command
    cargo test -p sagebrush-modsym                      # tests, ~5 s

`bench/explore_exact.py` also needs `pyarrow` and `python-flint` in the
venv.

