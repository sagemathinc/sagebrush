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

// ... and once adopted, the old equal string is not kept alive: the cache
// holds one body of a huge string, not two (HARD-3F4-1). Two 20-million-unit
// strings with a pair (the cache's big entry), the first dropped once the
// second is indexed: the heap keeps about one of them.
// The same after a scan of another string that Stop interrupts
// (PERF-DA5-1): the interrupted ask leaves no last string behind.
for (const interrupted of [false, true])
test(`adopting an equal string keeps one body of it alive, not two${interrupted ? ", after an interrupted scan" : ""}`, () => {
  const code = [
    `const { INTR } = require(${JSON.stringify(__dirname + "/../src/runtime/interrupt.js")});`,
    `const rt = require(${JSON.stringify(__dirname + "/../src/runtime/index.js")});`,
    `const sp = require(${JSON.stringify(__dirname + "/../src/runtime/strpos.js")});`,
    "const collect = globalThis.gc, heap = () => (collect(), collect(), process.memoryUsage().heapUsed);",
    "const N = 20_000_000;",
    "const base = heap();",
    "let a = 'x'.repeat(N) + '\\u{1F600}';",
    "sp.pairs(a);",
    ...(interrupted ? [
      "INTR[0] = 1;",
      "let stopped = false;",
      "try { sp.pairs('\\u{1F600}' + 'z'.repeat(2_000_000)); } catch (e) { stopped = rt.formatException(e).includes('KeyboardInterrupt'); }",
      "if (!stopped) throw new Error('not interrupted');",
    ] : []),
    "let b = ('y' + 'x'.repeat(N - 1)).replace('y', 'x') + '\\u{1F600}';",  // (equal to a, another object)
    "if (a !== b) throw new Error('not equal');",
    "sp.pairs(b); sp.pairs(b);",
    // (V8 keeps the last regular expression's subject, RegExp.input: scan's
    // search of a; another match lets go of it, as any later re call does)
    "/x/.test('x');",
    "a = null;",
    "const one = heap() - base;",
    "console.log(JSON.stringify({ one, body: 2 * N }));",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "-e", code], { encoding: "utf8", timeout: 120000 }).trim());
  // (one body is 2N bytes, two-byte for the pair; two would be 4N)
  assert.ok(r.one < 1.5 * r.body, `kept ${r.one} bytes for a ${r.body}-byte string`);
});

// ... and compared in full at most twice: where the string was found says
// which references hold it, so they are assigned, not compared again
// (HARD-3F4-2). Each new equal object, found as the string last indexed, as
// the big entry or in the cache, is compared once; found after another
// string as long, differing only at its end (A, B, a new A), twice: the
// failed comparison with B, then the one that finds A (HARD-3F4-3). And,
// timed, indexing a new equal 20-million-unit string costs about one
// comparison of two of them.
test("a new equal string is compared in full at most twice, wherever it is found", () => {
  const code = [
    `const sp = require(${JSON.stringify(__dirname + "/../src/runtime/strpos.js")});`,
    // (a new flat object equal to the last one made of length N)
    "const make = (N, end = 'x') => ('y' + 'x'.repeat(N - 2) + end + '\\u{1F600}').replace('y', 'x');",
    "const other = 'z'.repeat(1000) + '\\u{1F600}';",
    "const counts = {};",
    "const count = (k, s) => { const n = sp.compares.n; sp.pairs(s); (counts[k] ??= []).push(sp.compares.n - n); };",
    "for (const [k, N] of [['big', 2_000_000], ['cached', 300_000]]) {",
    "  count(k + ' new', make(N));",
    "  for (let i = 0; i < 3; i++) count(k + ' last', make(N));",
    "  for (let i = 0; i < 3; i++) { sp.pairs(other); count(k + ' found', make(N)); count(k + ' last', make(N)); }",
    "  for (let i = 0; i < 3; i++) { sp.pairs(make(N, 'a')); sp.pairs(make(N, 'b')); count(k + ' after B', make(N, 'a')); }",
    "}",
    "const N = 20_000_000, t = [], u = [];",
    "for (let i = 0; i < 7; i++) {",
    "  const a = make(N), b = make(N);",
    "  let t0 = process.hrtime.bigint(); if (a !== b) throw new Error('not equal'); t.push(Number(process.hrtime.bigint() - t0));",
    "  sp.pairs(a);",
    "  t0 = process.hrtime.bigint(); sp.pairs(b); u.push(Number(process.hrtime.bigint() - t0));",
    "}",
    "console.log(JSON.stringify({ counts, compare: Math.min(...t), pairs: Math.min(...u.slice(1)) }));",
  ].join("\n");
  const r = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 120000 }).trim());
  assert.deepEqual(r.counts, {
    "big new": [0], "big last": [1, 1, 1, 1, 1, 1], "big found": [1, 1, 1], "big after B": [1, 1, 1],
    "cached new": [0], "cached last": [1, 1, 1, 1, 1, 1], "cached found": [1, 1, 1], "cached after B": [2, 2, 2],
  });
  assert.ok(r.pairs < 2 * r.compare, `indexing a new equal string took ${r.pairs} ns, one comparison ${r.compare} ns`);
});
