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

test("object arrays: the object dtype's itemsize, and the dtype kept by creation and astype", () => {
  const code = [
    "import numpy as np",
    "for f in (lambda: np.dtype(object).itemsize, lambda: np.zeros(2, dtype=object).dtype, lambda: np.array(['a'], dtype=object).astype(object).dtype):",
    "    print(f())",
  ].join("\n");
  const out = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["8", "object", "object"]);
});
