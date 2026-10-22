import test from "node:test";
import assert from "node:assert/strict";

// LIMIT-PR55-3 (daybreak2): an operation's outputs and scratch are admitted
// together at its start (admitWork), before any is allocated. A spy counts
// every typed array the runtime allocates (each typed-array class replaced,
// in this process, before the runtime loads, by a subclass that adds up the
// bytes of each new buffer; views of an existing buffer are not counted).
// For each operation: run it with the default caps and count what it
// allocates (A); then lower the cap to A - 1 and run it again: it must be
// refused, and the refused call must allocate nothing. So each operation's
// preflight is never less than what it allocates, and it runs first.
const counter = { bytes: 0 };
for (const name of ["Float64Array", "Float32Array", "Int8Array", "Int16Array", "Int32Array", "Uint8Array", "Uint16Array", "Uint32Array", "BigInt64Array", "BigUint64Array"]) {
  const Base = (globalThis as any)[name];
  const Counted = class extends Base {
    constructor(...args: any[]) {
      super(...args);
      const a = args[0];
      if (!(a instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer)) counter.bytes += (this as any).byteLength;
    }
  };
  Object.defineProperty(Counted, "name", { value: name });
  (globalThis as any)[name] = Counted;
}

test("each widening operation is refused one byte under what it allocates, allocating nothing", async () => {
  const { notebookSession } = require("../src/notebook-session");
  const np = require("../src/runtime/numpy");
  const Obj = require("../src/runtime/object");
  const F = require("../src/runtime/format");
  const s = notebookSession(() => {}, { captureStreams: true });
  await s.ready;
  await s.handle({
    id: 1,
    code: [
      "import numpy as np, _numpy as N, _npfft as FFT, _nplinalg as L",
      "rng = np.random.default_rng(7)",
      "U8 = rng.integers(0, 256, 5000).astype(np.uint8)",
      "F2 = rng.standard_normal((60, 70))",
      "C1 = rng.standard_normal(300) + 1j * rng.standard_normal(300)",
      "A = rng.standard_normal((30, 40)); B = rng.standard_normal((40, 20))",
      "CA = A + 1j * A; CB = B - 1j * B",
      "MASK = F2 > 0",
      "I64 = np.arange(3000, dtype=np.int64)",
      "IDX = np.array([1, 3, 5, 7])",
      "X97 = (rng.standard_normal(97) + 0j); X128 = (rng.standard_normal(128) + 0j); R128 = rng.standard_normal((3, 128))",
      "OUT65 = np.zeros((3, 65), complex)",
      "S = rng.standard_normal((40, 40)); SPD = S @ S.T + 40 * np.eye(40); V = rng.standard_normal(40); BM = rng.standard_normal((40, 5))",
      "TALL = rng.standard_normal((90, 12)); WIDE = TALL.T.copy(); ROT = np.array([[0.0, -1.0], [1.0, 0.0]])",
    ].join("\n"),
  });
  const main = Obj.getattr(require("../src/runtime").R.importModule("__main__"), "__dict__");
  const g = (name: string) => Obj.callObj(Obj.getattr(main, "__getitem__"), [name]);
  const call = (mod: string, fname: string, args: any[]) => Obj.callObj(Obj.getattr(g(mod), fname), args);
  const CASES: [string, () => any][] = [
    ["sort uint8", () => call("N", "sort", [g("U8")])],
    ["argsort uint8", () => call("N", "argsort", [g("U8")])],
    ["argsort rows", () => call("N", "argsort", [g("F2"), 1])],
    ["sort complex", () => call("N", "sort", [g("C1")])],
    ["sum uint8 as float64", () => call("N", "sum", [g("U8"), null, false, "float64"])],
    ["sum over axis 0", () => call("N", "sum", [g("F2"), 0])],
    ["matmul", () => call("N", "matmul", [g("A"), g("B")])],
    ["matmul complex", () => call("N", "matmul", [g("CA"), g("CB")])],
    ["nonzero", () => call("N", "nonzero", [g("MASK")])],
    ["fancy index", () => Obj.callObj(Obj.getattr(g("F2"), "__getitem__"), [g("IDX")])],
    ["tobytes int64", () => call("N", "_tobytes", [g("I64")])],
    ["fft rows, Bluestein (97)", () => call("FFT", "rows", [g("X97"), 1, 97, false])],
    ["fft rows (128)", () => call("FFT", "rows", [g("X128"), 1, 128, false])],
    ["rfft rows", () => call("FFT", "rfft_rows", [g("R128"), 3, 128, g("OUT65")])],
    ["det", () => call("L", "det", [g("S")])],
    ["slogdet", () => call("L", "slogdet", [g("S")])],
    ["solve vector", () => call("L", "solve", [g("S"), g("V")])],
    ["solve matrix", () => call("L", "solve", [g("S"), g("BM")])],
    ["inv", () => call("L", "inv", [g("S")])],
    ["qr", () => call("L", "qr", [g("TALL"), false])],
    ["qr complete", () => call("L", "qr", [g("TALL"), true])],
    ["cholesky", () => call("L", "cholesky", [g("SPD")])],
    ["eigh", () => call("L", "eigh", [g("SPD"), false])],
    ["eig", () => call("L", "eig", [g("S"), false])],
    ["eig complex", () => call("L", "eig", [g("ROT"), false])],
    ["svd tall", () => call("L", "svd", [g("TALL"), false, true])],
    ["svd tall full", () => call("L", "svd", [g("TALL"), true, true])],
    ["svd wide full", () => call("L", "svd", [g("WIDE"), true, true])],
  ];
  const saved = { ...np.ARRAY_LIMITS };
  try {
    for (const [name, f] of CASES) {
      counter.bytes = 0;
      f();
      const A = counter.bytes;
      assert.ok(A > 0, `${name}: allocates something`);
      np.ARRAY_LIMITS.bytes = A - 1;
      counter.bytes = 0;
      let refused: any = null;
      try {
        f();
      } catch (e) {
        refused = e;
      }
      const after = counter.bytes;
      np.ARRAY_LIMITS.bytes = saved.bytes;
      assert.ok(refused !== null && Obj.isinstance(refused, Obj.T.MemoryError), `${name}: not refused one byte under its ${A} bytes`);
      assert.match(F.str(refused), /needs .* of working memory, more than Sagebrush's limit of|Unable to allocate/, name);
      assert.equal(after, 0, `${name}: the refused call allocated ${after} bytes`);
    }
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
});
