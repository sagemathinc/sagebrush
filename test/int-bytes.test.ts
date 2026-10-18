import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// int.from_bytes and int.to_bytes as CPython 3.14's (test/int_bytes_cases.py)
const TEST = __dirname + "/../../test/";
test("int.from_bytes and int.to_bytes as CPython's", () => {
  const name = "int_bytes_cases.py";
  const want = execFileSync("python3", [TEST + name], { encoding: "utf8" }).split("\n");
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", TEST + name], { encoding: "utf8" }).split("\n");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
});

// (linear: a byte at a time was quadratic, 23 s for to_bytes of 415 KB;
// these 4 MB each way take well under a second)
test("int.from_bytes and int.to_bytes are linear", () => {
  const src = [
    "import time",
    "b = bytes(range(256)) * 16384",
    "t = time.perf_counter()",
    "x = int.from_bytes(b, 'little')",
    "c = x.to_bytes(len(b), 'little')",
    "d = time.perf_counter() - t",
    "print(c == b, d < 3)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out.trim(), "True True");
});
