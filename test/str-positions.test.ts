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
// (HARD-AF6-1): a string of ten million astral characters, or of 262,144
// distinct astral characters sixteen times over, is measured, indexed and
// searched in a 96 MiB heap, where the per-pair table aborted Node.  (Each
// half alone takes 56 MiB at most: the index is an eighth of the string's
// bytes; the rest is the string and V8's flattening of it for find.  The
// second string is joined from 2^18 one-character strings, not 2^20, whose
// list alone took most of the heap and once aborted under load.)
test("a string of millions of astral characters is indexed in a 96 MiB heap (HARD-AF6-1)", () => {
  const code = [
    "s = chr(0x1F600) * 10_000_000",
    "print(len(s), s[5_000_000] == chr(0x1F600), s[-1] == chr(0x1F600), s.find('x'), len(s[9_999_990:]))",
    "s = None",
    "t = ''.join(map(chr, range(0x10000, 0x50000))) * 16",
    "print(len(t), t[262_144 * 3 + 5] == chr(0x10005), t.index(chr(0x4FFFF)), t.rfind(chr(0x10000)))",
  ].join("\n");
  const out = execFileSync(process.execPath, ["--max-old-space-size=96", CLI, "-c", code], { encoding: "utf8", timeout: 120000 });
  assert.equal(out, "10000000 True True -1 10\n4194304 True 262143 3932160\n");
});

// A JS string cannot keep '\ud83d' + '\ude00' as the two code points CPython
// keeps: they would read as U+1F600 (CORR-C4D-1).  Every operation that would
// put a lone high surrogate right before a lone low one refuses
// (NotImplementedError; a literal written so is a SyntaxError), and
// everything else, astral characters included, is unchanged.
test("joining a lone high surrogate to a lone low one is refused, not read as one character (CORR-C4D-1)", () => {
  const cases: [string, string][] = [
    ["h + l", "NotImplementedError"],
    ["chr(0xd83d) + chr(0xde00)", "NotImplementedError"],
    ["eval('h') + eval('l')", "NotImplementedError"],
    ["''.join([h, l])", "NotImplementedError"],
    ["''.join([h, '', l])", "NotImplementedError"],
    ["h.join(['a', l + 'b'])", "NotImplementedError"],
    ["(l + h) * 2", "NotImplementedError"],
    ["2 * (l + h)", "NotImplementedError"],
    ["(l + h)[::-1]", "NotImplementedError"],
    ["('a' + l + 'x' + h)[::2]", "'ax'"],
    ["(h + 'x' + l)[::2]", "NotImplementedError"],
    ["('\\U0001F600' + l + h)[::-1]", "NotImplementedError"],
    ["f'{h}{l}'", "NotImplementedError"],
    ["f'{h}' f'{l}'", "NotImplementedError"],
    ["'%s%s' % (h, l)", "NotImplementedError"],
    ["'{}{}'.format(h, l)", "NotImplementedError"],
    ["l.rjust(3, h)", "NotImplementedError"],
    ["format(l, h + '>3')", "NotImplementedError"],
    ["('a' + h + 'b').replace('b', l)", "NotImplementedError"],
    ["eval(\"'\\\\ud83d\\\\ude00'\")", "SyntaxError"],
    ["(h + '\\t' + l).expandtabs(0)", "NotImplementedError"],
    ["(h + 'x' + l).replace('x', '')", "NotImplementedError"],
    ["''.join(reversed(l + h))", "NotImplementedError"],
    ["''.join(sorted(l + h))", "NotImplementedError"],
    ["(h + 'x' + l).translate({ord('x'): None})", "NotImplementedError"],
    ["('a' + l).translate({ord('a'): h})", "NotImplementedError"],
    ["(h + 'x').translate({ord('x'): 0xde00})", "NotImplementedError"],
    ["len((h + 'x' + l).translate({ord('x'): 'y'}))", "3"],
    ["len((h + '\\t' + l).expandtabs(4))", "5"],
    ["eval(\"'\\\\ud83d' '\\\\ude00'\")", "SyntaxError"],
    ["len(h + 'x' + l)", "3"],
    ["len(l + h)", "2"],
    ["len(f'{h}x{l}')", "3"],
    ["len('\\U0001F600' + 'x' + '\\ud83d')", "3"],
    ["len('{}{}'.format('\\U0001F600', l))", "2"],
    ["len(('\\U0001F600' * 3)[::-1])", "3"],
  ];
  const code = ["h = '\\ud83d'", "l = '\\ude00'"]
    .concat(cases.map(([e]) => `try:\n    print(ascii(${e}))\nexcept Exception as x:\n    print(type(x).__name__)`))
    .join("\n");
  const got = execFileSync(process.execPath, [CLI, "-c", code], { encoding: "utf8" }).trimEnd().split("\n");
  cases.forEach(([e, want], i) => assert.equal(got[i], want, e));
});

// An equal string that is another object (each json.dumps result) costs one
// full comparison with the string last indexed, not one per position:
// json.loads of a new dumps was 25 times slower from its second call on
// (sage2's report, perf-json-loads-slowdown)
test("indexing a new string equal to the last one indexed is not slower: json.loads of each new json.dumps", () => {
  const code = [
    "import json, time",
    "data = [[i, str(i)] for i in range(20000)]",
    "ts = []",
    "for k in range(3):",
    "    s = json.dumps(data)",
    "    a = time.time(); json.loads(s); ts.append(time.time() - a)",
    "print(ts[0], max(ts[1:]))",
  ].join("\n");
  const [first, later] = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8", timeout: 120000 }).trim().split(" ").map(Number);
  // (generous: a loaded machine; the bug was 25x)
  assert.ok(later < Math.max(first * 5, 1.0), `first ${first} s, later ${later} s`);
});
