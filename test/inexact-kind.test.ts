import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// A vector over a real or complex field meets a number of another such field
// in the field lib/_sage_ffmat.py _inexact_meet gives, which knows the fields
// by identity and class (_inexact_kind), never by their names: a parent named
// like a real field is not one (daybreak3's #767 FIELD-REPR-DISPATCH-1).
const TEST = __dirname + "/../../test/";
test("_inexact_kind classifies RDF, CDF, RR, CC, RealField(p), ComplexField(p) and nothing by its name", () => {
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "--sage", TEST + "inexact_kind_cases.sage"], { encoding: "utf8", timeout: 120000 });
  assert.deepEqual(out.trim().split("\n"), [
    "[(False, True, 53), (True, True, 53), (False, False, 53), (True, False, 53), (False, False, 20), (True, False, 100)]",
    "None None None",
  ]);
});
