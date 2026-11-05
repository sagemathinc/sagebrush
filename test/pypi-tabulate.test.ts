import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const TEST = join(ROOT, "test/tabulate_cases.py");

test("tabulate 0.8.9: headers, mixed values and fancy_grid, as CPython", () => {
  const want = execFileSync("python3", [TEST], {
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: join(ROOT, "packages/pypi-tabulate/py") },
  });
  const got = execFileSync(
    process.execPath,
    [join(__dirname, "../src/cli.js"), TEST],
    { encoding: "utf8" },
  );
  assert.equal(got, want);
});
