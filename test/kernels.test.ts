import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// The WebAssembly kernels (kernels/src) must give exactly the bits of the
// JavaScript code they replace.
const program = `
import numpy as np, _nplinalg
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
for a in mats:
    rec(*np.linalg.eigh(a + a.T))
    w, v = np.linalg.eig(a)
    rec(w.real, w.imag, v.real, v.imag)
    rec(*np.linalg.svd(a))
    rec(*np.linalg.qr(a))
    rec(a @ a.T, np.linalg.det(a), np.linalg.slogdet(a))
    try:
        rec(np.linalg.inv(a), np.linalg.solve(a, np.arange(len(a) * 1.0)))
    except np.linalg.LinAlgError as e:
        print(e)
for shape in [(40, 9), (9, 40), (300, 8), (17, 12)]:
    a = np.random.randn(*shape)
    rec(*np.linalg.svd(a, full_matrices=False))
    rec(*np.linalg.qr(a, mode="complete"))
    rec(np.linalg.pinv(a), np.linalg.lstsq(a, np.arange(shape[0] * 1.0), rcond=None)[0])
x = np.linspace(0, 1, 1000)
rec(np.polyfit(x, np.sin(x), 9), np.roots(np.arange(1.0, 15.0)))
`;

const run = (noWasm: boolean) =>
  execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", program], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: { ...process.env, SAGEBRUSH_NO_WASM: noWasm ? "1" : "" },
  });

test("WebAssembly kernels: bit-identical to the JavaScript fallback", () => {
  const w = run(false), j = run(true);
  assert.match(w, /^wasm True\n/);
  assert.match(j, /^wasm False\n/);
  const wl = w.split("\n").slice(1), jl = j.split("\n").slice(1);
  assert.ok(wl.length > 300);
  for (let i = 0; i < wl.length; i++) assert.equal(wl[i], jl[i], `line ${i + 2}`);
});
