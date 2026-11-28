import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NumberField.number_of_roots_of_unity() returns the engine's count only when it is proven (lib/_sage_nf.py): the
// roots found are a lower bound, so an unproven count, or one without its proof flag, is NotImplementedError, and a
// proven one is returned as it is.  The field's data is injected, so this row tests that guard on its own.

const cli = (...args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8" });

test("number_of_roots_of_unity refuses an unproven count and returns a proven one", () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-w-guard-"));
  try {
    const f = join(dir, "w.sage");
    writeFileSync(
      f,
      `x = polygen(QQ, 'x')
K = NumberField(x^2 - 2, 'a')
for d in [{"w": 0, "w_proven": False}, {"w": 2, "w_proven": False}, {"w": 2}, {"w": 2, "w_proven": True}, {"w": 4, "w_proven": True}]:
    K._nfdata = lambda d=d: d
    try:
        print(K.number_of_roots_of_unity())
    except NotImplementedError as e:
        print("NotImplementedError")
`,
    );
    assert.equal(cli(f), "NotImplementedError\nNotImplementedError\nNotImplementedError\n2\n4\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
