import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// np.genfromtxt (lib/numpy/__init__.py): numpy-tests/test_genfromtxt.py checks it against NumPy
// itself; here, what Sagebrush's numpy doesn't have yet is said in words, never a wrong array:
// structured arrays (names=, dtype=None with columns of different types), masked arrays, text.
const CLI = __dirname + "/../src/cli.js";
test("genfromtxt refuses, in words, the arrays Sagebrush's numpy doesn't have", () => {
  const code = [
    "import io, numpy as np",
    "S = io.StringIO",
    "for k, f in enumerate([",
    "    lambda: np.genfromtxt(S('a,b\\n1,2\\n'), delimiter=',', names=True),",
    "    lambda: np.genfromtxt(S('1,2\\n'), delimiter=',', names='a,b'),",
    "    lambda: np.genfromtxt(S('1,2.5\\n3,4\\n'), delimiter=',', dtype=None),",
    "    lambda: np.genfromtxt(S('a,2\\nb,4\\n'), delimiter=',', dtype=None),",
    "    lambda: np.genfromtxt(S('1,2\\n'), delimiter=',', dtype=str),",
    "    lambda: np.genfromtxt(S('1,,3\\n'), delimiter=',', usemask=True),",
    "]):",
    "    try:",
    "        f(); print(k, 'no error')",
    "    except NotImplementedError as e:",
    "        print(k, e)",
  ].join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(got, [
    "0 genfromtxt with names=: structured arrays are not supported by sagebrush's numpy yet",
    "1 genfromtxt with names=: structured arrays are not supported by sagebrush's numpy yet",
    "2 genfromtxt with dtype=None and columns of different types: structured arrays are not supported by sagebrush's numpy yet",
    "3 genfromtxt with dtype=None and text fields: string arrays are not supported by sagebrush's numpy yet",
    "4 string arrays are not supported by sagebrush's numpy yet",
    "5 genfromtxt with usemask=True: masked arrays are not supported by sagebrush's numpy yet",
  ]);
});
