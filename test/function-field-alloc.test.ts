import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = __dirname + "/../../test/";

test("the reviewed R0 rational-function allocation sites do not change silently", () => {
  const got = JSON.parse(execFileSync("python3", [join(ROOT, "function_field_alloc_sites.py")], { encoding: "utf8" }));
  const want = JSON.parse(readFileSync(join(ROOT, "function-field-alloc-sites.json"), "utf8"));
  assert.deepEqual(got, want,
    "review every new site against _FunBudget and the R0a caps, then regenerate function-field-alloc-sites.json");
});

test("R0a preflights result allocation and bounds every strong cache", () => {
  assert.equal(execFileSync("python3", [join(ROOT, "function_field_preflight.py")], {
    encoding: "utf8", timeout: 60_000,
  }), "ok\n");
});
