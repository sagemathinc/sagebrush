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
