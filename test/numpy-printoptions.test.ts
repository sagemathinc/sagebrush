import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// numpy's printing options where Sagebrush differs from NumPy on purpose
// (numpy-tests/test_printoptions.py and test_dragon4.py compare the rest with
// NumPy itself): legacy printing is not implemented, and refusals happen when
// the option is set, not later when an array prints.
const py = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("numpy printing: what is not implemented is an error, and options stay as they were", () => {
  const out = py(`
import numpy as np
for kw in [dict(legacy="1.13"), dict(legacy="2.1"), dict(precision=-1), dict(nanstr=3), dict(formatter=[1]),
           dict(formatter={"float": 3}), dict(override_repr=3)]:
    try:
        np.set_printoptions(**kw)
        print("no error", kw)
    except (NotImplementedError, ValueError, TypeError) as e:
        print(type(e).__name__, str(e)[:60])
print(np.get_printoptions()["precision"], np.get_printoptions()["legacy"], np.array([1 / 3]))
for f in [lambda: np.array2string(np.array([1.]), legacy="1.13"), lambda: np.nextafter(1.0, 2.0, where=True)]:
    try:
        f()
        print("no error")
    except NotImplementedError as e:
        print("NotImplementedError", str(e)[:60])
`);
  assert.equal(out, [
    "NotImplementedError legacy='1.13' (NumPy's older printing) is not implemented in",
    "NotImplementedError legacy='2.1' (NumPy's older printing) is not implemented in ",
    "ValueError precision must be >= 0",
    "TypeError nanstr must be a string",
    "TypeError formatter must be a dict",
    "TypeError formatter['float'] must be callable",
    "TypeError override_repr must be callable",
    "8 False [0.33333333]",
    "NotImplementedError legacy='1.13' (NumPy's older printing) is not implemented in",
    "NotImplementedError nextafter: where are not implemented in Sagebrush",
    "",
  ].join("\n"));
});

// numpy-tests/test_printoptions_limits.py compares the review's reproductions
// with NumPy; these are the same ones as assertions, plus nextafter's float16
// loop, which Sagebrush (without float16) refuses rather than answering in
// float32.
test("numpy printing: Dragon4's buffer, nextafter's dtypes, edgeitems <= 0 and operator.index", () => {
  const out = py(`
import numpy as np, operator, warnings
def t(fn):
    try:
        r = fn()
        print(repr(r) if not isinstance(r, str) or len(r) < 60 else (len(r), r[-6:]))
    except Exception as e:
        print(type(e).__name__, str(e)[:70])
t(lambda: np.format_float_positional(1.25, precision=20000, unique=False))
t(lambda: np.format_float_scientific(1.25, precision=20000, unique=False))
t(lambda: np.format_float_positional(1.25, precision=10**100, unique=False))
t(lambda: np.format_float_positional(1.25, pad_left=-1))
t(lambda: np.format_float_scientific(1.25, exp_digits=-1))
t(lambda: np.format_float_scientific(1.25, pad_left=16390))
t(lambda: np.nextafter(np.float32(1), 2.0))
t(lambda: np.nextafter(np.float32(1), 2))
t(lambda: np.nextafter(np.array([1], dtype=np.float32), 2.0))
t(lambda: np.nextafter(np.int8(1), np.float32(2)))
for a in [(np.int8(1), 2), (np.uint8(1), np.uint8(2)), (True, np.bool(False)), (np.array([1], np.int8), 2.0)]:
    t(lambda: np.nextafter(*a))
np.set_printoptions(edgeitems=-1, threshold=0)
t(lambda: np.array2string(np.arange(10)))
t(lambda: np.array2string(np.arange(24).reshape(4, 6)))
t(lambda: str(np.arange(3.).reshape(3, 1)))
np.set_printoptions(edgeitems=3, threshold=1000)
class IntOverride(int):
    def __index__(self): return 9
class RetTrue:
    def __index__(self): return True
class RetFloat:
    def __index__(self): return 2.5
t(lambda: (operator.index(IntOverride(3)), type(operator.index(IntOverride(3))).__name__))
with warnings.catch_warnings(record=True) as w:
    warnings.simplefilter("always")
    t(lambda: (operator.index(RetTrue()), type(operator.index(RetTrue())).__name__))
print([c.category.__name__ for c in w])
t(lambda: np.format_float_positional(1.25, precision=RetFloat()))
t(lambda: operator.index(np.True_))
`);
  const f16 = "NotImplementedError nextafter: NumPy computes this in float16 (for bool, int8 and uint8 in";
  assert.equal(out, [
    "RuntimeError Float formatting result too large",
    "(16387, '00e+00')",
    "OverflowError Python int too large to convert to C long",
    "ValueError pad_left must be >= 0",
    "ValueError exp_digits must be >= 0",
    "(16383, '      ')",
    "np.float32(1.0000001)",
    "np.float32(1.0000001)",
    "array([1.0000001], dtype=float32)",
    "np.float32(1.0000001)",
    f16, f16, f16, "array([1.])",
    "'[... 9]'",
    "'[...\\n [... 23]]'",
    "TypeError 'NoneType' object cannot be interpreted as an integer",
    "(3, 'int')",
    "(1, 'int')",
    "['DeprecationWarning', 'DeprecationWarning']",
    "TypeError '<' not supported between instances of 'RetFloat' and 'int'",
    "TypeError 'numpy.bool' object cannot be interpreted as an integer",
    "",
  ].join("\n"));
});
