import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Dicts and sets past the JavaScript engine's limit on a Map (2**24 entries
// in V8): a dict's Maps go on in segments, so a dict or set holds as many
// entries as memory allows. The cases run with the segment lowered to 4
// entries, so every dict and set in them spans several; their output is
// CPython 3.14's, recorded.
const TEST = __dirname + "/../../test/";
const DIST = join(__dirname, "..");

// (the cases' output, and the most segments any Map reached)
const cases = (segment: number | null): [string, number] => {
  const js = [
    `const O = require(${JSON.stringify(DIST + "/src/runtime/object.js")});`,
    segment === null ? "" : `O.setMapSegment(${segment});`,
    "let most = 1;",
    "const set = O.SegMap.prototype.set;",
    "O.SegMap.prototype.set = function (k, v) { const r = set.call(this, k, v); most = Math.max(most, this.segs.length); return r; };",
    `const c = require(${JSON.stringify(DIST + "/src/compile.js")});`,
    "Promise.resolve(c.initParser && c.initParser()).then(() => {",
    `  c.execModule(require("fs").readFileSync(${JSON.stringify(TEST + "dict_segmented_cases.py")}, "utf8"), "<cases>", "__main__");`,
    "  process.stdout.write('segments ' + most + '\\n');",
    "});",
  ].join("\n");
  const out = execFileSync(process.execPath, ["-e", js], { encoding: "utf8" });
  const m = /segments (\d+)\n$/.exec(out)!;
  return [out.slice(0, m.index), Number(m[1])];
};

test("dicts and sets across segments: CPython's order, lookups, methods and set algebra", () => {
  const want = readFileSync(TEST + "dict_segmented_cases.expected", "utf8");
  const [out, most] = cases(4);
  assert.equal(out, want, "segments of 4");
  assert.ok(most >= 3, `the cases reached ${most} segments`);
  // (and at the real segment size, one plain Map each)
  assert.deepEqual(cases(null), [want, 1]);
});

// (the real limit: a dict and a set of 2**24 + 5 entries, about 2 GB and 25 s)
test("a dict and a set past 2**24 entries", { skip: !process.env.SAGEBRUSH_SLOW_TESTS }, () => {
  const out = execFileSync(process.execPath, [DIST + "/src/cli.js", "-c", `
n = 2**24 + 5
d = dict.fromkeys(range(n))
s = set(range(n))
print(len(d), len(s), n - 1 in d, n - 1 in s, n in s, list(d)[-2:])
`], { encoding: "utf8", timeout: 600000 });
  assert.equal(out, `${2 ** 24 + 5} ${2 ** 24 + 5} True True False [${2 ** 24 + 3}, ${2 ** 24 + 4}]\n`);
});
