import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sbx (lib/_sbx.py), board interchange between languages (D4): on plain
// Python values exactly what CPython does with the same module
// (test/sbx_cases.py); between the four modes, each mode's own values
// encoded, decoded in every mode and encoded again (test/sbx_modes_cases.py).
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("sbx on plain Python values: CPython's output, every value read back as it was, every bad one refused saying why", () => {
  const want = execFileSync("python3", [TEST + "sbx_cases.py"], { encoding: "utf8" });
  assert.ok(want.endsWith("done\n") && !want.includes("FAIL"), want);
  assert.equal(cli([TEST + "sbx_cases.py"]), want);
});

test("sbx between Python, Sage, Magma and MATLAB: each mode's values in every mode, and what a mode can't hold refused", () => {
  const out = cli([TEST + "sbx_modes_cases.py"]);
  assert.ok(out.trimEnd().endsWith("all passed"), out.split("\n").filter((l) => !l.startsWith("ok")).join("\n"));
});
