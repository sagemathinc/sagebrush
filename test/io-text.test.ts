import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// io.TextIOWrapper, io.BufferedWriter and io.IncrementalNewlineDecoder: CPython 3.14.10's pure-Python classes
// (Lib/_pyio.py, C's behaviour where they differ) in lib/_io_text.py, loaded by io's module __getattr__ on first
// use. test/io_text_cases.py; its .out is CPython 3.14.10's (its C _io).
const CLI = join(__dirname, "..", "src", "cli.js");
const TEST = join(__dirname, "..", "..", "test") + "/";

test("io.TextIOWrapper, BufferedWriter and IncrementalNewlineDecoder, as CPython 3.14.10", () => {
  const want = readFileSync(TEST + "io_text_cases.out", "utf8").split("\n");
  const got = execFileSync(process.execPath, [CLI, TEST + "io_text_cases.py"], { encoding: "utf8" }).split("\n");
  assert.ok(want.length > 150, "the recording has every case");
  for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `io_text_cases.py line ${i + 1}`);
});

// (the recording's provenance: CI's CPython, when it is 3.14.10, prints the committed .out)
test("io_text_cases.out is what CPython 3.14.10 prints", (t) => {
  const v = execFileSync("python3", ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" }).trim();
  if (v !== "3.14.10") return t.skip(`python3 is ${v}, not the recording's 3.14.10`);
  const live = execFileSync("python3", ["-I", TEST + "io_text_cases.py"], { encoding: "utf8" });
  assert.equal(live, readFileSync(TEST + "io_text_cases.out", "utf8"));
});

test("_io_text loads only when a program first uses one of its classes", () => {
  const program = [
    "import io, sys",
    "s = io.StringIO(); s.write('x'); b = io.BytesIO(b'y'); b.read()",
    "print('_io_text' in sys.modules, hasattr(io, 'StringIO'))",
    "T = io.TextIOWrapper",
    "print('_io_text' in sys.modules, T is io.TextIOWrapper, io.BufferedWriter.__module__, T.__module__)",
  ].join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", program], { encoding: "utf8" });
  assert.equal(got, "False True\nTrue True _io _io\n");
});
