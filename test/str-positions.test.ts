import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// str positions count code points, as CPython's (PY-E4A-9; test/str_positions_cases.py):
// len, indexing, slicing, find/index/count, zfill and re's positions on strings
// with characters beyond U+FFFF, and the plain path for strings without them.
const TEST = __dirname + "/../../test/";
const CLI = __dirname + "/../src/cli.js";
test("str's len, indexing, slicing, find/index/count, zfill and re's positions count code points (PY-E4A-9)", () => {
  const want = execFileSync("python3", [TEST + "str_positions_cases.py"], { encoding: "utf8" });
  const got = execFileSync(process.execPath, [CLI, TEST + "str_positions_cases.py"], { encoding: "utf8" });
  const w = want.split("\n"), g = got.split("\n");
  for (let i = 0; i < Math.max(w.length, g.length); i++) assert.equal(g[i], w[i], `line ${i + 1}`);
});

// A loop that indexes a long string scans it for surrogates once (the
// answer is kept), with or without astral characters, so it stays linear.
test("indexing every character of a 2-million-character string, with or without astral characters, is linear", () => {
  const code = (fill: string) => [
    "import time",
    `s = ${fill} * 1000000 + 'z' * 1000000`,
    "t = time.perf_counter()",
    "n = 0",
    "for i in range(0, len(s), 1000):",
    "    n += len(s[i]) + s.find('z', i, i + 2) + len(s)",
    "print(n, round(time.perf_counter() - t, 3))",
  ].join("\n");
  for (const fill of ["'a'", "'\\U0001F600'"]) {
    const out = execFileSync(process.execPath, [CLI, "-c", code(fill)], { encoding: "utf8", timeout: 60000 }).trim().split(" ");
    assert.ok(Number(out[1]) < 2, `${fill}: ${out.join(" ")}`);
  }
});

// The index of a string's surrogate pairs is sparse and made in place
// (HARD-AF6-1): a string of ten million astral characters, or of every
// astral character four times over, is measured, indexed and searched in a
// 96 MiB heap, where the per-pair table aborted Node.
test("a string of millions of astral characters is indexed in a 96 MiB heap (HARD-AF6-1)", () => {
  const code = [
    "s = chr(0x1F600) * 10_000_000",
    "print(len(s), s[5_000_000] == chr(0x1F600), s[-1] == chr(0x1F600), s.find('x'), len(s[9_999_990:]))",
    "s = None",
    "t = ''.join(map(chr, range(0x10000, 0x110000))) * 4",
    "print(len(t), t[1_048_576 * 3 + 5] == chr(0x10005), t.index(chr(0x10FFFF)), t.rfind(chr(0x10000)))",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", code], { encoding: "utf8", timeout: 120000 });
  assert.equal(out, "10000000 True True -1 10\n4194304 True 1048575 3145728\n");
});
