import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// random.getrandbits (src/runtime/modules.ts MT.getrandbits): CPython's bits for every k, made in time linear in k
// (the int built once from the words' hex, not OR-ed in a word at a time); CPython's errors for a bad k.
// test/getrandbits_cases.py's .out is CPython 3.14.10's (python3 -I).
const ROOT = join(__dirname, "../..");
const CLI = join(__dirname, "../src/cli.js");
const CASES = join(ROOT, "test/getrandbits_cases.py");
const OUT = join(ROOT, "test/getrandbits_cases.out");

test("getrandbits gives CPython 3.14.10's bits, the stream in step after large calls, and its errors", () => {
  assert.equal(execFileSync(process.execPath, [CLI, CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});

test("getrandbits(2**22) is linear: well under 2 s (the word-at-a-time build took 53 s)", () => {
  const r = spawnSync(process.execPath, [CLI, "-c", "import random, time\nt = time.perf_counter()\nx = random.Random(1).getrandbits(2**22)\nprint(time.perf_counter() - t, x.bit_length() > 2**22 - 64)"], { encoding: "utf8", timeout: 120_000 });
  const [s, ok] = r.stdout.trim().split(" ");
  assert.equal(ok, "True", r.stderr);
  assert.ok(Number(s) < 2, `${s} s`);
});

test("a k too large for memory is a MemoryError naming the call, before any word is made", () => {
  const r = spawnSync(process.execPath, [CLI, "-c", "import random\ntry:\n    random.getrandbits(2**63)\nexcept MemoryError as e:\n    print(e)"], { encoding: "utf8", timeout: 120_000 });
  assert.match(r.stdout, /^getrandbits\(9223372036854775808\) needs about \d+ MiB, more than this session's \d+ MiB\n$/);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("getrandbits_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  assert.equal(execFileSync("python3", ["-I", CASES], { encoding: "utf8" }), readFileSync(OUT, "utf8"));
});
