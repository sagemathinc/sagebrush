import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { R } from "../src/compile";

// A BigInt past the JavaScript engine's largest (JavaScriptCore's is 2^20
// bits, so Bun's executable could not hold a 10^6-digit integer) was a
// "SystemError: internal error: RangeError: ...": it is a MemoryError, as
// CPython's when an int cannot be allocated (src/runtime/object.ts, toPyExc).
test("an engine's BigInt size limit is a MemoryError, not an internal error", () => {
  for (const message of ["Out of memory: BigInt generated from this operation is too big", "Maximum BigInt size exceeded"]) {
    const exc = R.toPyExc(new RangeError(message));
    assert.ok(R.typeOf(exc) === R.T.MemoryError, `${message}: ${R.typeOf(exc).$name}`);
  }
  // (other RangeErrors stay internal errors)
  assert.ok(R.typeOf(R.toPyExc(new RangeError("toFixed() digits argument must be between 0 and 100"))) === R.T.SystemError);
});

const PROGRAM = [
  "try:",
  "    x = int('f' * 300000, 16)",
  "    print('made', x.bit_length())",
  "except MemoryError as e:",
  "    print('MemoryError', repr(e))",
].join("\n");
const cli = __dirname + "/../src/cli.js";
test("a 1.2-million-bit int: made under Node, a MemoryError where the engine cannot hold it (Bun)", () => {
  assert.equal(execFileSync(process.execPath, [cli, "-c", PROGRAM], { encoding: "utf8" }), "made 1200000\n");
  if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) return;
  const out = execFileSync("bun", [cli, "-c", PROGRAM], { encoding: "utf8" });
  assert.ok(out === "made 1200000\n" || out === "MemoryError MemoryError()\n", out);
});
