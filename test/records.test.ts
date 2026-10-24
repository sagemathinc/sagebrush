import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The JSON records (lib/sagebrush/records.py; design-estimates-progress r4
// §3 and §6, design-agent-api-library r3 §7): the engine's validator answers
// as CPython's does, case by case (test/records_cases.out was written by
// CPython), and docs/schemas/*.v1.json are the module's SCHEMAS.
const ROOT = __dirname + "/../../";
const CLI = __dirname + "/../src/cli.js";

test("the record validator answers as CPython's does, case by case (test/records_cases.py)", () => {
  const got = execFileSync(process.execPath, [CLI, ROOT + "test/records_cases.py"], { encoding: "utf8" });
  assert.equal(got, readFileSync(ROOT + "test/records_cases.out", "utf8"));
});

test("docs/schemas are generated from records.SCHEMAS", () => {
  const r = spawnSync("python3", ["-I", ROOT + "lib/sagebrush/records.py", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("the validator and a reference JSON Schema validator agree on every case (when one is installed)", (t) => {
  const r = spawnSync("python3", ["-I", ROOT + "test/records_jsonschema.py"], { encoding: "utf8" });
  if (r.status === 3) return t.skip("the jsonschema package is not installed");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^agree: \d+ cases\n$/);
});
