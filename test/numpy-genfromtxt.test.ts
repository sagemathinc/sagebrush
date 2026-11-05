import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// np.genfromtxt (lib/numpy/__init__.py): numpy-tests/test_genfromtxt.py checks it against NumPy
// itself; here, what Sagebrush's numpy doesn't have yet is said in words, never a wrong array:
// structured arrays (names=, a structured dtype, dtype=None with columns of different types), masked
// arrays, text.
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
    "    lambda: np.genfromtxt(S('1,2\\n'), delimiter=',', dtype=[('a', int), ('b', float)]),",
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
    "6 genfromtxt with a structured dtype: structured arrays are not supported by sagebrush's numpy yet",
  ]);
});

// A column name as a dictionary key needs names= (NumPy looks it up there, and without names= fails
// with an AttributeError of its own code): refused, the same way for each of the three options,
// before any of them is used
test("genfromtxt refuses a column name key without names=", () => {
  const code = [
    "import io, numpy as np",
    "S = io.StringIO",
    "for opt, d in [('missing_values', {'a': 'x'}), ('filling_values', {'a': 7}), ('converters', {'a': float}),",
    "               ('missing_values', {0: 'x', 'b': 'y'}), ('filling_values', {None: 1, 'c': 7})]:",
    "    try:",
    "        r = np.genfromtxt(S('1,2\\n'), delimiter=',', **{opt: d}); print(opt, 'no error', r)",
    "    except ValueError as e:",
    "        print(opt, e)",
  ].join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(got, [
    "missing_values genfromtxt: column name key 'a' needs names=",
    "filling_values genfromtxt: column name key 'a' needs names=",
    "converters genfromtxt: column name key 'a' needs names=",
    "missing_values genfromtxt: column name key 'b' needs names=",
    "filling_values genfromtxt: column name key 'c' needs names=",
  ]);
});
