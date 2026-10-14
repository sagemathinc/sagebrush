import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// sys.exit(status) from `sagebrush -c`: the process's exit code and what it
// writes, by CPython's rule (src/cli.ts exitCode), from the status's Python
// type, not how the runtime holds it. Each row is CPython 3's own result.
const run = (status: string) => spawnSync(process.execPath, [__dirname + "/../src/cli.js", "-c", `import sys\nclass Code(int): pass\nsys.exit(${status})`], { encoding: "utf8" });

test("sys.exit(status): the exit code and stderr CPython gives", () => {
  const rows: [string, number, string][] = [
    ["", 0, ""], ["None", 0, ""], ["0", 0, ""], ["3", 3, ""], ["263", 7, ""], ["-1", 255, ""],
    ["True", 1, ""], ["False", 0, ""], ["2**100", 255, ""], ["-(2**63)", 0, ""], ["2**63", 255, ""],
    ["Code(3)", 3, ""], ["Code(0)", 0, ""],
    ["-2.5", 1, "-2.5\n"], ["0.0", 1, "0.0\n"], ["'a message'", 1, "a message\n"], ["[1]", 1, "[1]\n"],
  ];
  for (const [status, code, err] of rows) {
    const r = run(status);
    assert.deepEqual([r.status, r.stderr], [code, err], `sys.exit(${status})`);
  }
});
