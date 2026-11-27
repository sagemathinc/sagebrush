import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// random.Random's seeds and randbytes (lib/random.py _seed_value, src/runtime/modules.ts MT.seed), as CPython 3.14's:
// a str, bytes or bytearray seeds by int.from_bytes(a + sha512(a)) (version 2) or by the older string hash (version
// 1), a float by its exact hash cast to unsigned, other types refused; randbytes(n) is getrandbits(8n)'s bytes,
// little-endian. test/random_seed_cases.py's .out is CPython 3.14.10's (python3 -I).
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(ROOT, "test/random_seed_cases.py");
const OUT = join(ROOT, "test/random_seed_cases.out");

test("random seeds (str, bytes, bytearray, both versions, ints, floats, refusals) and randbytes are CPython 3.14.10's", () => {
  const want = readFileSync(OUT, "utf8").split("\n");
  const got = execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 50, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `random_seed_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("random_seed_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});
