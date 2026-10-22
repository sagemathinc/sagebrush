import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { numpyOracle } from "./numpy-oracle";

// np.arange's values were start + i * step, and its length ceil((stop -
// start) / step) without NumPy's underflow case; np.linspace truncated for an
// integer dtype and ignored delta when num <= 1. So arange(-1, 1, 0.1)[10]
// was 0.0 (NumPy: -2.220446049250313e-16), arange(0, 5, 0.5, dtype=int)
// counted up (NumPy: all zeros), and linspace(-1, 0, 4, dtype=int) was
// [-1, 0, 0, 0] (NumPy: [-1, -1, -1, 0]). Compared with CPython's NumPy,
// every element to the bit: test/numpy_arange_linspace_cases.py.
const TEST = __dirname + "/../../test/";
test("np.arange and np.linspace give NumPy's elements, to the bit, and its lengths and errors", () => {
  const name = "numpy_arange_linspace_cases.py";
  const want = numpyOracle(TEST + name);
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8", maxBuffer: 1 << 26 }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// LIMIT-PR55-1 (daybreak2): every array is admitted before it is allocated
// (admitArray, in empty): at most 2**32 elements and 2**32 bytes, both
// inclusive. Each dtype width at the limit is admitted, and one element more
// refused, without allocating anything (admitArray only counts).
test("admitArray: each dtype's limit admitted, one element more refused, nothing allocated", () => {
  const np = require("../src/runtime/numpy");
  const F = require("../src/runtime/format");
  const D: Record<string, any> = {};
  for (const name of ["bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "complex64", "complex128"]) D[name] = np.toDtype(name);
  const before = process.memoryUsage().arrayBuffers;
  for (const [name, dt] of Object.entries(D)) {
    const at = Math.min(np.ARRAY_MAX_ELEMENTS, Math.floor(np.ARRAY_MAX_BYTES / dt.itemsize));
    assert.doesNotThrow(() => np.admitArray([at], dt), name);
    assert.doesNotThrow(() => np.admitArray([at / 2, 2], dt), name + " (2-D)");
    assert.throws(() => np.admitArray([at + 1], dt), (e: any) => /Unable to allocate .* for an array with shape \(\d+,\) and data type /.test(F.str(e)), name);
    // (the bytes count scratch too)
    assert.throws(() => np.admitArray([at], dt, 1), (e: any) => e !== undefined, name + " with scratch");
  }
  assert.ok(process.memoryUsage().arrayBuffers - before < 1 << 20, "nothing allocated");
});

test("arange, linspace and zeros past the caps fail fast with the refusal, before allocating", () => {
  const code = [
    "import numpy as np, time",
    "for f in (lambda: np.arange(0, 2**33), lambda: np.arange(0.0, 2.0**33), lambda: np.arange(0, 2**30, 0.25),",
    "          lambda: np.linspace(0, 1, 2**33), lambda: np.linspace(0, 1, 2**29 + 1), lambda: np.zeros(2**33, np.int8),",
    "          lambda: np.arange(0, 2**29 + 1, dtype=np.complex128), lambda: np.arange(0, 2**33, 1, dtype=np.uint8)):",
    "    t = time.perf_counter()",
    "    try:",
    "        f()",
    "        print('allocated')",
    "    except MemoryError as e:",
    "        print(type(e).__name__, str(e).split(' for ')[0], time.perf_counter() - t < 1)",
  ].join("\n");
  const r = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });
  assert.deepEqual(r.trim().split("\n"), [
    "MemoryError Unable to allocate 64.0 GiB True",
    "MemoryError Unable to allocate 64.0 GiB True",
    "MemoryError Unable to allocate 32.0 GiB True",
    "MemoryError Unable to allocate 64.0 GiB True",
    "MemoryError Unable to allocate 4.00 GiB True",
    "MemoryError Unable to allocate 8.00 GiB True",
    "MemoryError Unable to allocate 8.00 GiB True",
    "MemoryError Unable to allocate 8.00 GiB True",
  ]);
});
