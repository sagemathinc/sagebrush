import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real numbers' str() options sagebrush does not implement are refused,
// not ignored: a base other than 10 printed decimal digits as if they were
// that base's (RR(2).str(16) was '2.000000000000000', Sage's is
// '2.0000000000000'), and e and skip_zeroes were dropped. What
// Sage prints is compared in sage-tests/test_rr_methods.sage.
test("RR, RR past the doubles and RealField(p) str(): another base, e or skip_zeroes refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-real-str-"));
  try {
    const f = join(dir, "t.sage");
    writeFileSync(f, [
      "for nm, v in [('RR', RR(2)), ('big', RR(2)^2000), ('R30', RealField(30)(2))]:",
      "    for kw in ({'base': 16}, {'base': 2}, {'e': 'E'}, {'skip_zeroes': True}):",
      "        try: print(nm, kw, v.str(**kw))",
      "        except NotImplementedError as e: print(nm, kw, e)",
      "    try: print(nm, v.str(16))",
      "    except NotImplementedError as e: print(nm, 'str(16)', e)",
    ].join("\n"));
    const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", f], { encoding: "utf8" }).split("\n").filter(Boolean);
    const field = { RR: "RR", big: "RealField(53)", R30: "RealField(30)" } as Record<string, string>;
    const want: string[] = [];
    for (const nm of ["RR", "big", "R30"]) {
      const F = field[nm];
      want.push(`${nm} {'base': 16} ${F} str() in base 16 is not available in sagebrush yet`);
      want.push(`${nm} {'base': 2} ${F} str() in base 2 is not available in sagebrush yet`);
      for (const kw of ["{'e': 'E'}", "{'skip_zeroes': True}"])
        want.push(`${nm} ${kw} ${F} str() with e or skip_zeroes is not available in sagebrush yet`);
      want.push(`${nm} str(16) ${F} str() in base 16 is not available in sagebrush yet`);
    }
    assert.deepEqual(out, want);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
