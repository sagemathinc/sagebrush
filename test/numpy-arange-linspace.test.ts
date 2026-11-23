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
// (admitArray, in empty): at most 2**32 elements and, in a browser, 2**32
// bytes, both inclusive (on the person's own computer, the desktop app's engine
// and the CLI, there is no byte cap: the test below it). Each dtype width at
// a browser's limit is admitted, and one element more refused, without
// allocating anything (admitArray only counts).
const BROWSER_CAPS = { elements: 2 ** 32, bytes: 2 ** 32 };
test("admitArray: each dtype's limit admitted, one element more refused, nothing allocated", () => {
  const np = require("../src/runtime/numpy");
  const F = require("../src/runtime/format");
  const D: Record<string, any> = {};
  for (const name of ["bool", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "complex64", "complex128"]) D[name] = np.toDtype(name);
  const before = process.memoryUsage().arrayBuffers;
  const saved = { ...np.ARRAY_LIMITS };
  Object.assign(np.ARRAY_LIMITS, BROWSER_CAPS);
  try {
  for (const [name, dt] of Object.entries(D)) {
    const at = Math.min(np.ARRAY_LIMITS.elements, Math.floor(np.ARRAY_LIMITS.bytes / dt.itemsize));
    assert.doesNotThrow(() => np.admitArray([at], dt), name);
    assert.doesNotThrow(() => np.admitArray([at / 2, 2], dt), name + " (2-D)");
    assert.throws(() => np.admitArray([at + 1], dt), (e: any) => /Unable to allocate .* for an array with shape \(\d+,\) and data type /.test(F.str(e)), name);
    // (the bytes count scratch too)
    assert.throws(() => np.admitArray([at], dt, 1), (e: any) => e !== undefined, name + " with scratch");
  }
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
  assert.ok(process.memoryUsage().arrayBuffers - before < 1 << 20, "nothing allocated");
});

test("arange, linspace and zeros past a browser's caps fail fast with the refusal, before allocating", async () => {
  // (in this process, with a browser's caps set: on the person's own computer there are none, and these would be made)
  const np = require("../src/runtime/numpy");
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  const code = [
    "import numpy as np, time",
    "r = []",
    "for f in (lambda: np.arange(0, 2**33), lambda: np.arange(0.0, 2.0**33), lambda: np.arange(0, 2**30, 0.25),",
    "          lambda: np.linspace(0, 1, 2**33), lambda: np.linspace(0, 1, 2**29 + 1), lambda: np.zeros(2**33, np.int8),",
    "          lambda: np.arange(0, 2**29 + 1, dtype=np.complex128), lambda: np.arange(0, 2**33, 1, dtype=np.uint8)):",
    "    t = time.perf_counter()",
    "    try:",
    "        f()",
    "        r.append('allocated')",
    "    except MemoryError as e:",
    "        r.append(type(e).__name__ + ' ' + str(e).split(' for ')[0] + ' ' + str(time.perf_counter() - t < 1))",
    "print('\\n'.join(r))",
  ].join("\n");
  const saved = { ...np.ARRAY_LIMITS };
  Object.assign(np.ARRAY_LIMITS, BROWSER_CAPS);
  let out = "";
  try {
    await s.handle({ id: 1, code });
    out = msgs.filter((m) => m.id === 1 && m.stream).map((m) => m.text).join("");
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
  assert.deepEqual(out.trim().split("\n"), [
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

test("on the person's own computer (the CLI) there is no byte cap: an array of more than 4 GiB is made", () => {
  // (np.zeros: the operating system's zeroed pages, none touched, so nothing is spent; a browser refuses it)
  const r = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", "import numpy as np\na = np.zeros(2**31 + 4, np.uint16)\nprint(a.nbytes, a.shape)"], { encoding: "utf8" });
  assert.equal(r.trim(), `${2 ** 32 + 8} (${2 ** 31 + 4},)`);
});

// LIMIT-PR55-2 (daybreak2): frombuffer and histogram's counts are admitted
// before they allocate. With the caps lowered to 1 MiB in this process:
// exactly 1 MiB is made, one element more refused, and the refused call
// allocates nothing (arrayBuffers, measured around it); int64 and uint64 are
// read in place into the one output array.
test("frombuffer and histogram admit before allocating (caps lowered to 1 MiB)", async () => {
  const np = require("../src/runtime/numpy");
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && m.stream).map((m) => m.text).join("");
  };
  const saved = { ...np.ARRAY_LIMITS };
  try {
    await run("import numpy as np, struct\nB = bytes(2**20)\nW = struct.pack('<4q', 1, -2, 2**53, -2**62) + struct.pack('>2Q', 7, 2**63)");
    np.ARRAY_LIMITS.elements = 2 ** 32;
    np.ARRAY_LIMITS.bytes = 2 ** 20;
    for (const dt of ["float64", "int64", "uint64", "int32", "uint8", "complex128"]) {
      assert.equal(await run(`print(np.frombuffer(B, '${dt}').nbytes)`), `${2 ** 20}\n`, dt + " at the cap");
      await run(`B2 = bytes(2**20 + np.dtype('${dt}').itemsize)`);
      const before = process.memoryUsage().arrayBuffers;
      const out = await run(`try:\n    np.frombuffer(B2, '${dt}')\nexcept MemoryError as e:\n    print('refused', str(e).split(' for ')[0])`);
      const grew = process.memoryUsage().arrayBuffers - before;
      assert.match(out, /^refused Unable to allocate 1\.00 MiB/, dt + " one element over");
      assert.ok(grew < 2 ** 19, `${dt}: ${grew} bytes allocated by a refused call`);
    }
    // (int64 and uint64 read exactly, little and big endian)
    assert.equal(await run("print(np.frombuffer(W[:32], np.int64).tolist(), np.frombuffer(W[32:], '>u8').tolist())"), "[1, -2, 9007199254740992, -4611686018427387904] [7, 9223372036854775808]\n");
    // histogram: its counts (8 bytes a bin) and output admitted together
    np.ARRAY_LIMITS.bytes = 2 ** 20 - 8;
    assert.match(await run("try:\n    np.histogram([0.5], bins=2**16)\nexcept MemoryError as e:\n    print('refused', e)"), /^refused Unable to allocate 512\. KiB for an array with shape \(65536,\) and data type int64/);
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
});
