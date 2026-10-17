import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// numpy.prod of real arrays multiplied in their dtype, as NumPy's loops:
// float32 products rounded at each step (found by the MATLAB sweep:
// [1e-30, 1e-30, 1e30] was 1e-30, NumPy's 0.0), integers wrapping
// (test/numpy_prod_cases.py), compared with CPython's NumPy.
const TEST = __dirname + "/../../test/";
test("numpy.prod of real arrays is NumPy's: each product in the array's dtype", () => {
  const name = "numpy_prod_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `${name} line ${i + 1}`);
});

// (an int64 product a double cannot hold exactly, NumPy's wrapped value: a
// NotImplementedError naming it, never a nearby double)
test("an int64 product Sagebrush's int64 arrays cannot hold exactly is refused", () => {
  const src = "import numpy as np\nfor a in ([3**20, 3**20, 3], [3**30, 3**10]):\n    try:\n        np.prod(np.array(a))\n    except NotImplementedError as e:\n        print(type(e).__name__)\ntry:\n    np.cumprod(np.array([3**20, 3**20, 3]))\nexcept NotImplementedError as e:\n    print(type(e).__name__)";
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8" });
  assert.equal(out, "NotImplementedError\nNotImplementedError\nNotImplementedError\n");
});
