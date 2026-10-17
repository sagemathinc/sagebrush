import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// int(), float() and complex() of a str read Unicode decimal digits and
// whitespace as CPython 3.14 does (test/unicode_digits_cases.py)
const TEST = __dirname + "/../../test/";
test("int(), float() and complex() of Unicode digits and whitespace: CPython's results", () => {
  const name = "unicode_digits_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// a million non-ASCII characters that are neither digits nor spaces: complex()
// finds the first marker in one scan and refuses at once, as int and float do
test("complex(), int() and float() of a million invalid non-ASCII characters refuse quickly", () => {
  const code = [
    "import time",
    "s = 'é' * 10**6",
    "for f in (complex, int, float):",
    "    t = time.perf_counter()",
    "    try: f(s)",
    "    except ValueError as e: print(f.__name__, str(e).split(':')[0], time.perf_counter() - t < 2)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(out, ["complex complex() arg is a malformed string True", "int invalid literal for int() with base 10 True", "float could not convert string to float True"]);
});
