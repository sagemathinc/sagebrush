import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

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

test("object arrays: the object dtype's itemsize, and the dtype kept by creation and astype", () => {
  const code = [
    "import numpy as np",
    "for f in (lambda: np.dtype(object).itemsize, lambda: np.zeros(2, dtype=object).dtype, lambda: np.array(['a'], dtype=object).astype(object).dtype):",
    "    print(f())",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["8", "object", "object"]);
});
