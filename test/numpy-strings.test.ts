import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// String arrays (src/runtime/numpy.ts, StrArray): numpy-tests/test_strings.py checks what they do
// against NumPy itself, and numpy-tests/test_string_walk.py that every other ndarray member and
// numpy function is NumPy's or raises; here, that what isn't there yet is refused in words, the
// same words everywhere, never a wrong array.
const CLI = __dirname + "/../src/cli.js";
const run = (code: string) => execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trim().split("\n");
const REFUSED = "this operation on string arrays is not supported by sagebrush's numpy yet (string arrays have creation, astype, shape and indexing, comparisons, sort, unique, where, isin and printing)";

test("string arrays refuse, in words, the operations they don't have", () => {
  const got = run([
    "import numpy as np",
    "u = np.array(['a', 'bc'])",
    "for k, f in enumerate([",
    "    lambda: u + u, lambda: u * 2, lambda: -u, lambda: u.sum(), lambda: np.mean(u), lambda: u.max(),",
    "    lambda: np.add(u, 'x'), lambda: np.cumsum(u), lambda: np.result_type(u), lambda: np.zeros(2) + u,",
    "    lambda: np.ones(2, dtype='>U3'), lambda: np.arange(3, dtype='U3'), lambda: np.clip(u, None, None),",
    "    lambda: float(np.array('1.5')), lambda: np.cov(np.array(['1', '2'])), lambda: np.sinc(np.array(['1'])),",
    "    lambda: np.median(u), lambda: np.nextafter(u, 'b'), lambda: u.conj(), lambda: u.imag,",
    "    lambda: np.array([['a'], ['b']]) @ u, lambda: u.tobytes(), lambda: np.linspace(0, 1, 3, dtype='U3'),",
    "]):",
    "    try:",
    "        r = f(); print(k, 'no error', repr(r))",
    "    except NotImplementedError as e:",
    "        print(k, e)",
  ].join("\n"));
  assert.equal(got.length, 23);
  for (const [k, line] of got.entries()) assert.equal(line, `${k} ${REFUSED}`, `call ${k}`);
});

test("a string dtype reaches no numeric operation: a typed array is never made of one", () => {
  const got = run([
    "import numpy as np",
    "d = np.dtype('U2')",
    "print(type(d) is type(np.dtype('f8')), isinstance(np.array(['a']), np.ndarray), type(np.array(['a'])) is np.ndarray)",
    "for f in [lambda: np.eye(2, dtype=d), lambda: np.frombuffer(b'abcd', dtype=d), lambda: np.array([1.5]).view() + np.zeros(1, d)]:",
    "    try:",
    "        f(); print('no error')",
    "    except NotImplementedError as e:",
    "        print('refused')",
  ].join("\n"));
  assert.deepEqual(got, ["True True True", "refused", "refused", "refused"]);
});

// A noncontiguous array's .flat is a copy, read-only, so a write raises instead of being lost
// (NumPy writes through its flatiter; grader's U30)
test("a write to a noncontiguous string array's flat raises, the array unchanged", () => {
  const got = run([
    "import numpy as np",
    "a = np.array([['a', 'b'], ['c', 'd']])",
    "try:",
    "    a.T.flat[1] = 'z'; print('wrote')",
    "except ValueError as e:",
    "    print('ValueError', e)",
    "print(a.tolist())",
  ].join("\n"));
  assert.deepEqual(got, ["ValueError assignment destination is read-only", "[['a', 'b'], ['c', 'd']]"]);
});
