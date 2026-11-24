import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { slowSkip } from "./slow-tests";

// The object dtype (numpy-tests/test_object.py compares what it has with
// NumPy): arithmetic and the other ufuncs on object arrays aren't in
// Sagebrush's numpy yet, and each refuses in so many words, never computes
// something else or fails obscurely.
const CLI = __dirname + "/../src/cli.js";
const REFUSAL = "NotImplementedError: this operation on object arrays is not supported by sagebrush's numpy yet";
test("object arrays: arithmetic and the other ufuncs refuse with NotImplementedError", () => {
  const cases = [
    "np.array([1, 2], dtype=object).sum()",
    "np.array([1, 2], dtype=object) + 1",
    "1 + np.array([1, 2], dtype=object)",
    "np.arange(2) * np.array([1, 2], dtype=object)",
    "np.abs(np.array([-1], dtype=object))",
    "np.sqrt(np.array([4.0], dtype=object))",
    "np.mean(np.array([1, 2], dtype=object))",
    "np.add(np.array([1], dtype=object), 1)",
    "np.zeros(2, dtype=object) @ np.zeros(2)",
    "np.array([1, None]).max()",
  ];
  const code = ["import numpy as np"]
    .concat(cases.map((c) => `try:\n    ${c}\n    print("computed")\nexcept Exception as e:\n    print(type(e).__name__ + ": " + str(e))`))
    .join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out.length, cases.length);
  out.forEach((line, i) => assert.ok(line.startsWith(REFUSAL), `${cases[i]}: ${line}`));
});

test("object arrays: a function that needs numbers refuses an object array, never converts it silently", () => {
  const cases = ["np.isnan(o)", "np.any(o)", "np.all(o)", "np.nonzero(o)", "np.dot(o, o)", "np.cumsum(o)", "np.round(o)", "np.clip(o, 0, 1)", "np.diff(o)", "np.histogram(o)", "np.interp(1.5, o, o)", "np.percentile(o, 50)", "np.argmax(o)"];
  const code = ["import numpy as np", "o = np.array([1.0, 2.0], dtype=object)"]
    .concat(cases.map((c) => `try:\n    ${c}\n    print("computed")\nexcept Exception as e:\n    print(type(e).__name__ + ": " + str(e))`))
    .join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out.length, cases.length);
  out.forEach((line, i) => assert.ok(line.startsWith(REFUSAL), `${cases[i]}: ${line}`));
});

test("object arrays: an array inside the data that the result's shape cuts off refuses, never stores its parts", () => {
  // (NumPy assigns such an array whole into its place, broadcasting, or raises; not here yet)
  const cases = [
    "np.array([np.zeros((2, 2)), np.zeros((2, 3))], dtype=object)",
    "np.array([[deep(63, 1)]], dtype=object)",
    "np.array([[deep(63, 2)]], dtype=object)",
    "np.array([deep(64, 1)], dtype=object)",
  ];
  const code = [
    "import numpy as np",
    "def deep(k, last):",
    "    a = np.empty((1,) * (k - 1) + (last,), dtype=object)",
    "    a[...] = 'e'",
    "    return a",
  ]
    .concat(cases.map((c) => `try:\n    ${c}\n    print("computed")\nexcept Exception as e:\n    print(type(e).__name__ + ": " + str(e))`))
    .join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.equal(out.length, cases.length);
  out.forEach((line, i) => assert.ok(line.startsWith(REFUSAL), `${cases[i]}: ${line}`));
});

// (shared sublists make the walk's levels grow as 2**depth from a few bytes: each level is admitted, as the
// array it becomes, before it is built, so a lowered element limit refuses at once, with MemoryError)
test("object arrays: discovery of shared sublists is admitted level by level (elements lowered to 2**16)", { timeout: 60_000 }, async () => {
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
    np.ARRAY_LIMITS.elements = 2 ** 16;
    const code = (setup: string) =>
      `import numpy as np, time\n${setup}\nt = time.time()\ntry:\n    np.array(x, dtype=object)\n    print('made')\nexcept MemoryError as e:\n    print('refused', str(e).split(' for ')[0], time.time() - t < 5)`;
    for (const levels of [20, 40]) {
      const out = await run(code(`x = [0]\nfor _ in range(${levels}):\n    x = [x, x]`));
      assert.match(out, /^refused Unable to allocate 1\.00 MiB True\n$/, `${levels} levels: ${out}`);
    }
    // (a list that holds itself twice: 2**64 elements at NumPy's 64 dimensions, refused as soon as a level passes the limit)
    const cyc = await run(code("x = []\nx.append(x)\nx.append(x)"));
    assert.match(cyc, /^refused Unable to allocate 1\.00 MiB True\n$/, cyc);
    // (one under the limit is made)
    assert.equal(await run("x = [0]\nfor _ in range(15):\n    x = [x, x]\nprint(np.array(x, dtype=object).size)"), "32768\n");
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }
});

// (Stop reaches every loop of the walk: one wide list, read through a proxy that asks for Stop at its 4096th
// read, stops within 4096 more reads, with a KeyboardInterrupt, never reading it all)
test("object arrays: Stop interrupts the walk over one wide list within 4096 reads", () => {
  const code = [
    `const C = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    `const I = require(${JSON.stringify(__dirname + "/../src/runtime/interrupt.js")});`,
    "Promise.resolve(C.initParser && C.initParser()).then(() => {",
    "  C.R.importModule('sys').path.push(C.libDir());",
    "  C.execModule('import numpy as np\\n', '<warm>', '__main__');",
    "  let reads = 0;",
    "  const isIndex = (k) => typeof k === 'string' && k !== '' && String(Number(k)) === k;",
    "  const input = new Proxy(new Array(65536).fill(0), { get(t, k, r) { if (isIndex(k) && ++reads === 4096) I.requestCtrlC(); return Reflect.get(t, k, r); } });",
    "  C.R.importModule('builtins')._wide = input;",
    "  let caught = 'none';",
    "  try { C.execModule('import numpy as np\\nimport builtins\\nnp.array(builtins._wide, dtype=object)\\n', '<wide>', '__main__'); }",
    "  catch (e) { caught = C.R.formatException(e).trim().split('\\n').pop(); }",
    "  console.log(JSON.stringify({ after: reads - 4096, caught }));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.equal(r.caught, "KeyboardInterrupt");
  assert.ok(r.after <= 4096, `${r.after} reads after Stop was asked for`);
});

// (the walk's own memory goes through the heap's admission at its measured cost, OBJ_WALK_ITEM_BYTES an item:
// with the heap shown nearly full, 128 MiB free, nested shared lists of 2**22 elements, about 192 MiB at that
// cost, are refused before they are built; at a floor of 8 bytes a reference they would be made)
test("object arrays: discovery's own memory is admitted by the heap at its measured cost (128 MiB shown free)", { timeout: 60_000 }, async () => {
  const H = require("../src/runtime/heap");
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
  await run("import numpy as np\nx = [0]\nfor _ in range(22):\n    x = [x, x]");
  const saved = { ...H.heapProbe };
  try {
    H.heapProbe.used = () => H.heapLimit() - 2 ** 27;
    H.heapProbe.collect = () => false;
    const out = await run("try:\n    np.array(x, dtype=object)\n    print('made')\nexcept MemoryError as e:\n    print('refused', str(e))");
    assert.match(out, /^refused making an object array of shape \((2, ){21}2\) from nested data needs about \d+ MiB, but this session's heap has only about 128 MiB free/, out);
  } finally {
    Object.assign(H.heapProbe, saved);
  }
  assert.equal(await run("print(np.array(x, dtype=object).size)"), `${2 ** 22}\n`);
});

// (at the default limits, nested shared lists 40 levels deep are refused by that admission with MemoryError,
// never run the process out of memory: slow, about 11 s and 1.8 GB on the CLI, so CI's long tier)
test("object arrays: at the default limits, 40 levels of shared lists are refused with MemoryError", { skip: slowSkip, timeout: 120_000 }, () => {
  const code = "import numpy as np\nx = [0]\nfor _ in range(40):\n    x = [x, x]\ntry:\n    np.array(x, dtype=object)\n    print('made')\nexcept MemoryError as e:\n    print('refused', str(e).split(' needs ')[0][:22])";
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", timeout: 90_000 });
  assert.equal(out, "refused making an object array\n");
});

test("object arrays: the object dtype's itemsize, and the dtype kept by creation and astype", () => {
  const code = [
    "import numpy as np",
    "for f in (lambda: np.dtype(object).itemsize, lambda: np.zeros(2, dtype=object).dtype, lambda: np.array(['a'], dtype=object).astype(object).dtype):",
    "    print(f())",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["8", "object", "object"]);
});
