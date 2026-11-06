import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The WebAssembly kernels (kernels/src: linear algebra, FFT, exp/log, sin/cos, sort, random) must give
// exactly the bits of the JavaScript code they replace.
const program = `
import numpy as np, _nplinalg
from numpy.linalg import _ldexp, _scaled
def _qtb(a, b, complete):
    m, e = _scaled(a)
    c, r = _nplinalg.qr_qtb(m, b, complete)
    return c, _ldexp(r, -e)
np.random.seed(7)
print("wasm", _nplinalg.wasm())
def rec(*xs):
    for x in xs:
        print(repr(np.asarray(x).tolist()))
mats = []
for n in [1, 3, 8, 9, 33, 64]:
    mats += [np.random.rand(n, n), np.random.randn(n, n)]
r = np.random.rand(20, 3)
th = 0.7
R = np.array([[np.cos(th), -np.sin(th)], [np.sin(th), np.cos(th)]])
mats += [np.zeros((10, 10)), np.eye(12), np.ones((9, 9)), r @ r.T, np.kron(np.eye(6), R),
         np.diag(np.arange(10.0)) + np.diag(np.ones(9), 1), np.triu(np.random.rand(11, 11))]
# (balanced companion matrices, and a matrix whose balancing permutes rows and columns)
for s in [1e8, 1e14, 1e20]:
    c = np.convolve([1.0, s, 1.0], [1.0, 3.0, 2.0])
    mats.append(np.vstack([-c[1:] / c[0], np.eye(3, 4)]))
c = np.array([1.0, 1e6, -3e-4, 2e9, 5.0, -1e-7, 7e3])
mats.append(np.vstack([-c[1:] / c[0], np.eye(5, 6)]))
b = np.random.rand(7, 7)
b[3, :3] = 0
b[3, 4:] = 0
b[:5, 5] = 0
b[6:, 5] = 0
mats.append(b)
for a in mats:
    rec(*np.linalg.eigh(a + a.T))
    w, v = np.linalg.eig(a)
    rec(w.real, w.imag, v.real, v.imag)
    rec(*np.linalg.svd(a))
    rec(*np.linalg.qr(a))
    # (Q^T B without forming Q: B from cos so the random stream the later lines read is unchanged)
    rec(*_qtb(a, np.cos(np.arange(len(a) * 3.0)).reshape(-1, 3), False))
    rec(a @ a.T, np.linalg.det(a), np.linalg.slogdet(a))
    try:
        rec(np.linalg.inv(a), np.linalg.solve(a, np.arange(len(a) * 1.0)))
    except np.linalg.LinAlgError as e:
        print(e)
for shape in [(40, 9), (9, 40), (300, 8), (17, 12)]:
    a = np.random.randn(*shape)
    rec(*np.linalg.svd(a, full_matrices=False))
    rec(*np.linalg.qr(a, mode="complete"))
    rec(*_qtb(a, np.sin(np.arange(shape[0] * 2.0)).reshape(-1, 2), True))
    rec(np.linalg.pinv(a), np.linalg.lstsq(a, np.arange(shape[0] * 1.0), rcond=None)[0])
x = np.linspace(0, 1, 1000)
rec(np.polyfit(x, np.sin(x), 9), np.roots(np.arange(1.0, 15.0)))
for n in [64, 96, 250, 343, 1331, 2310, 4096, 1009]:
    z = np.random.randn(n) + 1j * np.random.randn(n)
    f = np.fft.fft(z)
    rec(f.real, f.imag, np.fft.ifft(z).real)
    if n % 2 == 0:
        r = np.fft.rfft(z.real)
        rec(r.real, r.imag)
edge = [0.0, -0.0, 1.0, -1.0, np.inf, -np.inf, np.nan, 709.7, 709.8, -745.1, -745.2, -708.5, -720.0,
        5e-324, 1e-310, 2.2e-308, 1.7976931348623157e308, 0.95, 1.0000001, 1.06, 0.9375, 1.064697265625]
for x in [np.random.randn(3001) * 300, np.random.rand(3001) * 3, 1 + np.random.randn(3001) * 0.03,
          np.exp(np.random.uniform(-744, 709, 3001)), np.array(edge * 5)]:
    with np.errstate(all="ignore"):
        rec(np.exp(x), np.log(x))
# sin and cos (kernels/src/crsin.rs, crmath's fast path; the elements it can't round go to crmath):
# near multiples of pi/2 and of 1/32, past the kernel's 2^20 pi/2, tiny, the specials, a view at an offset
k = np.random.randint(-10**6, 10**6, 3001)
trig_edge = [0.0, -0.0, np.inf, -np.inf, np.nan, 5e-324, 7.45e-9, -7.46e-9, 0.7853981633974483, 0.7853981634,
             1647099.3291652855, 1647099.33, -1647099.3291652855, 1e22, 1.7976931348623157e308, 0.03125, -0.8125]
for x in [np.random.randn(3001) * 300, np.random.rand(3001) * 3, k * (np.pi / 2), k * (np.pi / 2) + 1e-9,
          np.random.randint(-26, 27, 3001) / 32 + np.random.randn(3001) * 1e-13, np.random.uniform(-2e6, 2e6, 3001),
          np.exp(np.random.uniform(-700, 700, 3001)), np.array(trig_edge * 5), (np.random.randn(3010) * 9)[7:]]:
    with np.errstate(all="ignore"):
        rec(np.sin(x), np.cos(x))
f = np.random.randn(3000)
f[::7] = np.nan; f[::11] = 0.0; f[::13] = -0.0; f[::17] = np.inf; f[::19] = -np.inf; f[::23] = f[5]
for x in [f, np.random.randint(0, 50, 2000), np.random.randint(-10**12, 10**12, 2000), np.random.randint(-100, 100, 999).astype(np.int8),
          np.random.rand(500).astype(np.float32), np.ones(300), np.random.randint(0, 20, (40, 70)).astype(float)]:
    s = np.sort(x)
    print(repr(s.tolist()), repr(np.signbit(s).tolist()), repr(np.argsort(x).tolist()), repr(np.unique(x).tolist()))
for seed in (0, [1, 2, 3]):
    np.random.seed(seed)
    rec(np.random.rand(700), np.random.randn(999), np.random.randn(3), np.random.randn(1001), np.random.standard_exponential(300),
        np.random.randint(0, 1000, 600), np.random.randint(0, 2**32, 300), np.random.randint(0, 2**40, 300), np.random.rand(5))
    g = np.random.default_rng(seed)
    rec(g.random(700), g.integers(0, 1000, 999), g.integers(0, 7, 3), g.normal(size=777), g.random(5), g.integers(-100, 100, 1000))
`;

const run = (env: Record<string, string>) =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, SAGEBRUSH_NO_WASM: "", SAGEBRUSH_NO_RELAXED: "", ...env },
  });

// three ways: the relaxed-SIMD exp/log (hardware FMA, where fused), the main
// module only (software FMA), and no WebAssembly at all
test("WebAssembly kernels: bit-identical to the JavaScript fallback", () => {
  const w = run({}), s = run({ SAGEBRUSH_NO_RELAXED: "1" }), j = run({ SAGEBRUSH_NO_WASM: "1" });
  assert.match(w, /^wasm True\n/);
  assert.match(s, /^wasm True\n/);
  assert.match(j, /^wasm False\n/);
  const wl = w.split("\n").slice(1), sl = s.split("\n").slice(1), jl = j.split("\n").slice(1);
  assert.ok(wl.length > 300);
  for (let i = 0; i < wl.length; i++) {
    assert.equal(sl[i], jl[i], `software FMA, line ${i + 2}`);
    assert.equal(wl[i], jl[i], `relaxed SIMD, line ${i + 2}`);
  }
});

// Q^T B without forming Q (QR PR 1, the reflectors applied to B: _nplinalg.qr_qtb with qr's scaling, and MATLAB's [C, R] = qr(S, B)):
// the same R as qr's, bit for bit; C equal to the explicit Q^T B to rounding (relative 1e-13), with qr's shapes,
// complete and reduced, square, tall, wide, rank-deficient (a zero column: a reflector with beta 0), a 1 x 1, and
// a matrix scaled to 1e-300 (qr's power-of-2 scaling); with and without WebAssembly
const qtbProgram = `
import numpy as np, _nplinalg
from numpy.linalg import _ldexp, _scaled
def _qtb(a, b, complete):
    m, e = _scaled(a)
    c, r = _nplinalg.qr_qtb(m, b, complete)
    return c, _ldexp(r, -e)
rng = np.random.default_rng(11)
cases = [rng.standard_normal((m, n)) for (m, n) in [(1, 1), (5, 3), (3, 5), (40, 40), (120, 30), (64, 64), (25, 60)]]
z = rng.standard_normal((30, 8)); z[:, 2] = 0.0; cases.append(z)
cases.append(rng.standard_normal((50, 20)) * 1e-300)
for a in cases:
    m, n = a.shape
    for nb in (1, 4):
        b = rng.standard_normal((m, nb))
        for complete in (True, False):
            c, r = _qtb(a, b, complete)
            q, r2 = np.linalg.qr(a, mode="complete" if complete else "reduced")
            ref = q.T @ b
            err = float(np.max(np.abs(c - ref))) / max(1.0, float(np.max(np.abs(ref))))
            print(m, n, nb, complete, c.shape == ref.shape, bool(np.array_equal(r, r2)), err < 1e-13)
`;
const matlabProgram = `
rng(3); A = rand(30, 12); b = rand(30, 2); S = rand(9, 9); s = rand(9, 1);
[C, R] = qr(A, b); [Q, R2] = qr(A); fprintf('%d %d %d %d\\n', size(C), isequal(R, R2), max(max(abs(C - Q' * b))) < 1e-13);
[C, R] = qr(A, b, 'econ'); [Q, R2] = qr(A, 'econ'); fprintf('%d %d %d %d\\n', size(C), isequal(R, R2), max(max(abs(C - Q' * b))) < 1e-13);
[C, R] = qr(S, s, 0); x = R \\ C; fprintf('%d\\n', norm(S * x - s) < 1e-12);
[C, R] = qr(A, rand(30, 40)); fprintf('%d %d\\n', size(C));
T = A * 1e-300;
[C, R] = qr(T, b); [Q, R2] = qr(T); fprintf('%d %d %d %d\\n', size(C), isequal(R, R2), max(max(abs(C - Q' * b))) < 1e-13);
[C, R] = qr(T, b, 'econ'); [Q, R2] = qr(T, 'econ'); fprintf('%d %d %d %d\\n', size(C), isequal(R, R2), max(max(abs(C - Q' * b))) < 1e-13);
[C, R] = qr(single(S), single(s)); [Q, R2] = qr(single(S)); fprintf('%s %s %d %d\\n', class(C), class(R), isequal(R, R2), max(abs(C - Q' * single(s))) < 1e-5);
w = s + 1i * rand(9, 1); [C, R] = qr(S, w); [Q, R2] = qr(S); fprintf('%d %d %d\\n', isreal(C), isequal(R, R2), max(abs(C - Q' * w)) < 1e-13);
Z = S + 1i * rand(9, 9);
try, [C, R] = qr(Z, s); e1 = ''; catch err, e1 = err.message; end
try, [Q, R2] = qr(Z); e2 = ''; catch err, e2 = err.message; end
fprintf('%d\\n', strcmp(e1, e2));
`;
for (const noWasm of ["", "1"]) {
  test(`Q^T B without forming Q: qr's R, explicit Q^T B to rounding, qr's shapes${noWasm ? " (no WebAssembly)" : ""}`, () => {
    const env = { ...process.env, SAGEBRUSH_NO_WASM: noWasm, SAGEBRUSH_NO_RELAXED: "" };
    const lines = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", qtbProgram], { encoding: "utf8", env }).trim().split("\n");
    assert.equal(lines.length, 9 * 2 * 2);
    for (const l of lines) assert.match(l, / True True True$/, l);
    const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "qtb-"));
    writeFileSync(join(dir, "q.m"), matlabProgram);
    const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--matlab", join(dir, "q.m")], { encoding: "utf8", env });
    rmSync(dir, { recursive: true, force: true });
    // (complete: C is 30 x 2; econ: 12 x 2; then the least-squares solve; then 40 columns, more than Q's 30: formed Q;
    // then A scaled to 1e-300, so qr's power-of-2 scaling is nonzero: R unscaled, C not; then single stays single;
    // a complex b takes the general path; a complex S fails exactly as qr(S) does)
    assert.equal(out, "30 2 1 1\n12 2 1 1\n1\n30 40\n30 2 1 1\n12 2 1 1\nsingle single 1 1\n0 1 1\n1\n");
  });
}
