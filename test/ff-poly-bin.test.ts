import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { binCall } from "../src/runtime/engine";

// GF(p)[x] through the engine's binary entry point (SBW1) in pyjs: the cases
// of test/ff_poly_bin.py (shared with CPython, run by CI's CPython job).
const CLI = join(__dirname, "..", "src", "cli.js");
const CASES = join(__dirname, "..", "..", "test", "ff_poly_bin.py");

test("GF(p)[x] through the binary entry point in pyjs", (t) => {
  // (an engine build from before the entry point: the library keeps JSON)
  if (binCall(new Uint8Array(0)) === null) return t.skip("this engine build predates sb_bin_call");
  const r = spawnSync(process.execPath, [CLI, "--sage", CASES], { encoding: "utf8", timeout: 600000, maxBuffer: 1 << 24 });
  assert.ifError(r.error);
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-2000));
  assert.match(r.stdout, /^ok ff_poly_bin: \d+ cases/m);
});

test("binCall: a malformed request is an error record, never a trap", (t) => {
  const r = binCall(new TextEncoder().encode('{"fn":"nmod_poly_mul"}'));
  if (r === null) return t.skip("this engine build predates sb_bin_call");
  assert.equal(new TextDecoder().decode(r.subarray(0, 6)), "SBW1er");
  // code 2: the header
  assert.equal(r[6] | (r[7] << 8), 2);
});
