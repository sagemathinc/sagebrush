import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// Gamma's reflection near its poles takes the sine of pi (q - n), q - n exact,
// so it loses no bits there before any check of RealNumberMP.gamma (whose
// Ziv check would otherwise need four times the working precision: minutes
// at 100 bits).  The values are Sage 10.9's.
test("gamma's reflection near a pole, unchecked, is Sage's value", () => {
  const src = [
    "from _sage_real import _gamma",
    "print(RealField(100)(_gamma(-1 + QQ(2)^-97, 100)))",
    "print(RealField(100)(_gamma(-3 - QQ(2)^-90, 100)))",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out, "-1.5845632502852867518708790067e29\n2.0632333988089671248318737046e26\n");
});
