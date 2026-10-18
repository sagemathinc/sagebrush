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

// (linear: a byte at a time was quadratic, 23 s for to_bytes of 415 KB, so
// it would take minutes for this 1 MB; linear, it takes well under a
// second on an idle machine. The bound is wide, 10 s: a shared VM at a load
// of 100 took over 3 s for 4 MB, so a tight bound was flaky)
test("int.from_bytes and int.to_bytes are linear", () => {
  const src = [
    "import time",
    "b = bytes(range(256)) * 4096",
    "t = time.perf_counter()",
    "x = int.from_bytes(b, 'little')",
    "c = x.to_bytes(len(b), 'little')",
    "d = time.perf_counter() - t",
    "print(c == b, d < 10)",
  ].join("\n");
  const out = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out.trim(), "True True");
});

// (padding costs nothing but the output: a negative value's padding is
// written as 0xff, not made as a BigInt and its digits; with V8's heap
// capped at 128 MiB, a 100 MB padded result, whose bytes live outside that
// heap, still converts; daybreak2's limits finding on 6ce60e6b)
test("int.to_bytes pads without making the padding as a number", () => {
  const src = [
    "n = 100_000_000",
    "b = (-1).to_bytes(n, 'big', signed=True)",
    "c = (-(2**61) - 7).to_bytes(n, 'little', signed=True)",
    "d = (2**61 + 7).to_bytes(1000, 'big')",
    "print(len(b), b[:2], b[-2:], c[:8], c[-2:], d[:2], d[-8:])",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", __dirname + "/../src/cli.js", "-c", src], { encoding: "utf8", timeout: 120000 });
  assert.equal(out.trim(), String.raw`100000000 b'\xff\xff' b'\xff\xff' b'\xf9\xff\xff\xff\xff\xff\xff\xdf' b'\xff\xff' b'\x00\x00' b' \x00\x00\x00\x00\x00\x00\x07'`);
});
