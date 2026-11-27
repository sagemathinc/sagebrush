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

// (an object array has no element count of Sagebrush's own (LIMITS ruling on #1894; follow-up #2304): its references
// are admitted by the heap, and their dense JS array is bounded only by the JS engine: V8's known bound checked
// before the array is asked for, elsewhere the engine's RangeError where it is made, either way the MemoryError. With
// the bound stubbed to 10 elements: 10 made, 11 refused naming the engine's storage bound; with the heap shown full,
// refused by the heap before any store is asked for)
test("object arrays: no count of Sagebrush's own; the heap, then the JS engine's dense-array bound, refuse", () => {
  const np = require("../src/runtime/numpy");
  const H = require("../src/runtime/heap");
  const R = require("../src/runtime/index.js");
  const msg = (f: () => any) => {
    try {
      f();
      return "made";
    } catch (e) {
      return R.formatException(e).trim();
    }
  };
  const saved = { ...H.heapProbe }, make = np.objBackend.makeRefs, limit = np.objBackend.denseLimit;
  const refused = "MemoryError: Unable to allocate 88 bytes for an array with shape (11,) and data type object: more elements than this JavaScript engine's largest dense array holds (its storage bound, not Sagebrush's)";
  let asked = 0;
  try {
    np.objBackend.makeRefs = (n: number) => {
      asked++;
      if (n > 10) throw new RangeError("Invalid array length");
      return make(n);
    };
    // (an engine whose bound is met where the array is made: its RangeError)
    np.objBackend.denseLimit = null;
    assert.equal(msg(() => np.objEmpty([10])), "made");
    assert.equal(msg(() => np.objEmpty([2, 5])), "made");
    assert.equal(msg(() => np.objEmpty([11])), refused);
    // (V8, whose bound is known: refused before the array is asked for)
    np.objBackend.denseLimit = 10;
    asked = 0;
    assert.equal(msg(() => np.objEmpty([10])), "made");
    assert.equal(msg(() => np.objEmpty([11])), refused);
    assert.equal(asked, 1);
    // (the heap first: shown full, a large request is refused before the engine is asked for its store)
    H.heapProbe.collect = () => false;
    H.heapProbe.used = () => H.heapLimit();
    asked = 0;
    assert.match(msg(() => np.objEmpty([2 ** 26])), /^MemoryError: an object array of shape \(67108864,\) needs about 512 MiB/);
    assert.equal(asked, 0);
  } finally {
    np.objBackend.makeRefs = make;
    np.objBackend.denseLimit = limit;
    Object.assign(H.heapProbe, saved);
  }
});

// (on V8 itself, the standard build's bound, 2**27 (fixed-array.h's kMaxFixedArrayCapacity): 2**27 + 1 references,
// with the heap shown to have room, are refused before any array is asked for (V8 would build most of it first), so
// nothing of that size is allocated)
test("object arrays: on V8, 2**27 + 1 elements are refused by the engine's dense-array bound, as a MemoryError", (t) => {
  if (typeof (globalThis as any).process?.versions?.v8 !== "string" || (globalThis as any).process.versions.bun) return t.skip("not V8");
  const np = require("../src/runtime/numpy");
  const H = require("../src/runtime/heap");
  const R = require("../src/runtime/index.js");
  const need = 8 * (2 ** 27 + 1);
  if (H.heapLimit() <= need + 2 ** 21) return t.skip(`this host's heap limit (${H.heapLimit()} bytes) is below one such array`);
  const saved = { ...H.heapProbe }, make = np.objBackend.makeRefs;
  try {
    H.heapProbe.collect = () => false;
    H.heapProbe.used = () => H.heapLimit() - need - 2 ** 21;
    np.objBackend.makeRefs = () => assert.fail("the array was asked for");
    assert.equal(np.objBackend.denseLimit, 2 ** 27);
    assert.throws(() => np.objEmpty([2 ** 27 + 1]), (e: any) => /^MemoryError: Unable to allocate 1\.00 GiB for an array with shape \(134217729,\) and data type object: more elements than this JavaScript engine's largest dense array holds/.test(R.formatException(e).trim()));
  } finally {
    np.objBackend.makeRefs = make;
    Object.assign(H.heapProbe, saved);
  }
});

// (at the default limits, nested shared lists 40 levels deep are refused by that admission with MemoryError,
// never run the process out of memory: slow, about 11 s and 1.8 GB on the CLI, so CI's long tier)
test("object arrays: at the default limits, 40 levels of shared lists are refused with MemoryError", { skip: slowSkip, timeout: 120_000 }, () => {
  const code = "import numpy as np\nx = [0]\nfor _ in range(40):\n    x = [x, x]\ntry:\n    np.array(x, dtype=object)\n    print('made')\nexcept MemoryError as e:\n    print('refused', str(e).split(' needs ')[0][:22])";
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8", timeout: 90_000 });
  assert.equal(out, "refused making an object array\n");
});

// (the scans of the last level, where the walk stops, poll Stop too: 65536 items, each read through a proxy
// that asks for Stop at the 4096th item the ragged-data check looks at, stop within 4096 more items, with a
// KeyboardInterrupt; the three terminal scans share that polled loop)
test("object arrays: Stop interrupts the scan of the last level within 4096 items", () => {
  const code = [
    `const C = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    `const I = require(${JSON.stringify(__dirname + "/../src/runtime/interrupt.js")});`,
    "Promise.resolve(C.initParser && C.initParser()).then(() => {",
    "  C.R.importModule('sys').path.push(C.libDir());",
    "  C.execModule('import numpy as np\\nclass E:\\n    pass\\nimport builtins\\nbuiltins._E = E\\n', '<warm>', '__main__');",
    "  const B = C.R.importModule('builtins');",
    "  let looks = 0, armed = false;",
    "  const seen = new Set();",
    "  const items = [];",
    "  for (let i = 0; i < 65536; i++)",
    "    items.push(new Proxy(C.R.callObj(B._E, []), { getPrototypeOf(t) { if (armed && !seen.has(t)) { seen.add(t); if (++looks === 4096) I.requestCtrlC(); } return Reflect.getPrototypeOf(t); } }));",
    "  items.push([1]);",
    "  B._items = items;",
    "  B._arm = () => { armed = true; return null; };",
    "  let caught = 'none';",
    "  try { C.execModule('import numpy as np, builtins\\nbuiltins._arm()\\nnp.array(builtins._items)\\n', '<scan>', '__main__'); }",
    "  catch (e) { caught = C.R.formatException(e).trim().split('\\n').pop(); }",
    "  console.log(JSON.stringify({ after: looks - 4096, caught }));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.equal(r.caught, "KeyboardInterrupt");
  assert.ok(r.after <= 4096, `${r.after} items looked at after Stop was asked for`);
});

// (arrays inside the data: the walk takes a one-dimensional array's elements as values (OBJ_VALUE_BYTES each)
// and makes a view of each part of a larger one (OBJ_VIEW_BYTES each), both admitted before they are made: on a
// host that gives 64 MiB, with the heap shown nearly full, 12 MiB free, a (262144, 2) array's 262144 views and a
// 262144-element array's values are refused; a 1000-element array is made)
test("object arrays: the views and values taken from arrays inside the data are admitted (12 MiB of 64 shown free)", { timeout: 60_000 }, () => {
  const code = [
    "globalThis.__SAGEBRUSH_MEMORY__ = 64 * 2 ** 20;",
    `const C = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    `const H = require(${JSON.stringify(__dirname + "/../src/runtime/heap.js")});`,
    "Promise.resolve(C.initParser && C.initParser()).then(() => {",
    "  C.R.importModule('sys').path.push(C.libDir());",
    "  C.execModule('import numpy as np, builtins\\nbuiltins._a2 = np.zeros((262144, 2))\\nbuiltins._a1 = np.zeros(262144)\\nbuiltins._small = np.zeros(1000)\\n', '<warm>', '__main__');",
    "  H.heapProbe.used = () => H.heapLimit() - 12 * 2 ** 20;",
    "  H.heapProbe.collect = () => false;",
    "  const out = [];",
    "  for (const x of ['a2', 'a1', 'small']) {",
    "    try { C.execModule(`import numpy as np\\nimport __main__\\n__main__._r = np.array([_${x}], dtype=object).shape\\n`, '<m>', '__main__'); out.push('made'); }",
    "    catch (e) { out.push(C.R.formatException(e).trim().split('\\n').pop().split(' needs ')[0]); }",
    "  }",
    "  console.log(JSON.stringify(out));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.deepEqual(r, [
    "MemoryError: making an object array of shape (1, 262144) from nested data",
    "MemoryError: making an object array of shape (1, 262144) from nested data",
    "made",
  ]);
});

// (a range makes a new int for each item, unlike a list, whose items exist: each is charged from the range's
// endpoints before it is made. On a host that gives 64 MiB with 12 MiB shown free, 16384 ints of 8193 bits,
// about 17 MB, are refused; 100 of them are made)
test("object arrays: the ints a range makes are admitted before they are made (12 MiB of 64 shown free)", { timeout: 60_000 }, () => {
  const code = [
    "globalThis.__SAGEBRUSH_MEMORY__ = 64 * 2 ** 20;",
    `const C = require(${JSON.stringify(__dirname + "/../src/compile.js")});`,
    `const H = require(${JSON.stringify(__dirname + "/../src/runtime/heap.js")});`,
    "Promise.resolve(C.initParser && C.initParser()).then(() => {",
    "  C.R.importModule('sys').path.push(C.libDir());",
    "  C.execModule('import numpy as np\\n', '<warm>', '__main__');",
    "  H.heapProbe.used = () => H.heapLimit() - 12 * 2 ** 20;",
    "  H.heapProbe.collect = () => false;",
    "  const out = [];",
    "  for (const n of [16384, 100]) {",
    "    try { C.execModule(`import numpy as np\\nimport __main__\\n__main__._r = np.array(range(2**8192, 2**8192 + ${n}), dtype=object).shape\\n`, '<m>', '__main__'); out.push('made'); }",
    "    catch (e) { out.push(C.R.formatException(e).trim().split('\\n').pop().split(' needs ')[0]); }",
    "  }",
    "  console.log(JSON.stringify(out));",
    "});",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8" }).trim());
  assert.deepEqual(r, ["MemoryError: making an object array of shape (16384,) from nested data", "made"]);
});

// (a range is never made into a list to find its length: range(2**40) is refused by its length, with the
// element limit lowered to 16; ranges inside the data are made into items only after their level is admitted)
test("object arrays: a range's length is read without making its items", { timeout: 60_000 }, async () => {
  const np = require("../src/runtime/numpy");
  const ops = require("../src/runtime/ops");
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
  await run("import numpy as np");
  const saved = { ...np.ARRAY_LIMITS }, toArray = ops.toArray;
  let made = 0;
  try {
    np.ARRAY_LIMITS.elements = 16;
    ops.toArray = (x: any, ...rest: any[]) => {
      if (x instanceof Object && x.constructor && /Range$/.test(x.constructor.name)) made++;
      return toArray(x, ...rest);
    };
    const tryMake = (x: string) => run(`try:\n    print(np.array(${x}, dtype=object).tolist())\nexcept MemoryError as e:\n    print('refused')`);
    assert.equal(await tryMake("range(2**40)"), "refused\n");
    assert.equal(await tryMake("[range(2**40), range(2**40)]"), "refused\n");
    assert.equal(await tryMake("range(2**70, 2**70 + 2**40)"), "refused\n");
    assert.equal(await tryMake("[range(3), range(2, -4, -2)]"), "[[0, 1, 2], [2, 0, -2]]\n");
    assert.equal(made, 0, "a range was made into a list");
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
    ops.toArray = toArray;
  }
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
