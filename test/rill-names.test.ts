import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// lib/_rill/r_names.py, the names Rill reports as "R has it: not implemented in Sagebrush yet" rather than unknown,
// is catalog/rill/upstream.txt's names (recorded from R as a black box), the same set.
const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "src", "cli.js");

test("Rill's R names are the catalog's upstream names", () => {
  const upstream = new Set<string>();
  for (const line of readFileSync(join(ROOT, "catalog", "rill", "upstream.txt"), "utf8").split("\n")) {
    const i = line.indexOf("::");
    if (!line.startsWith("#") && i >= 0) upstream.add(line.slice(i + 2).trim());
  }
  const r = spawnSync(process.execPath, [CLI, "-c", "import sys\nfrom _rill.r_names import NAMES\nsys.stdout.write('\\n'.join(sorted(NAMES)))"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n"), [...upstream].sort());
});
