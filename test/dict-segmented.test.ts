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

// (Python run with the segment lowered, to 4 unless said)
const py4 = (code: string, segment: number | null = 4): string => {
  const js = [
    segment === null ? "" : `require(${JSON.stringify(DIST + "/src/runtime/object.js")}).setMapSegment(${segment});`,
    `const c = require(${JSON.stringify(DIST + "/src/compile.js")});`,
    `Promise.resolve(c.initParser && c.initParser()).then(() => c.execModule(${JSON.stringify(code + "\nimport sys\nsys.stdout.flush()\n")}, "<t>", "__main__"));`,
  ].join("\n");
  return execFileSync(process.execPath, ["-e", js], { encoding: "utf8" });
};

test("dicts and sets across segments: CPython's order, lookups, methods and set algebra", () => {
  const want = readFileSync(TEST + "dict_segmented_cases.expected", "utf8");
  const [out, most] = cases(4);
  assert.equal(out, want, "segments of 4");
  assert.ok(most >= 3, `the cases reached ${most} segments`);
  // (and at the real segment size, one plain Map each)
  assert.deepEqual(cases(null), [want, 1]);
});

// (insert and delete over and over, in several patterns, against a model:
// the order is the insertion order of the live keys, every lookup right,
// and at each growth check, an insert while the last segment is full, the
// segments are at most twice what the live entries need, and one)
test("churn: packing keeps the order and the segments to what the live entries need", () => {
  const js = [
    `const O = require(${JSON.stringify(DIST + "/src/runtime/object.js")});`,
    "O.setMapSegment(4);",
    "const out = [];",
    "for (const [ins, del] of [[4, 4], [4, 3], [5, 4], [9, 8], [3, 1]]) {",
    "  const s = new O.SegMap(new Map());",
    "  const model = [];",
    "  let k = 0, checks = 0, worst = 0;",
    "  for (; k < 8; k++) { s.set(k, k * 3); model.push(k); }",
    "  for (let round = 0; round < 60; round++) {",
    "    for (let j = 0; j < ins; j++, k++) {",
    "      const full = s.segs[s.segs.length - 1].size >= 4;",
    "      s.set(k, k * 3);",
    "      model.push(k);",
    "      if (full) {",
    "        checks++;",
    "        const over = s.segs.length - (2 * Math.ceil(s.size / 4) + 1);",
    "        worst = Math.max(worst, over);",
    "      }",
    "    }",
    "    // (the oldest live keys but one in each round, and so sparse segments)",
    "    for (let j = 0; j < del; j++) { const x = model.splice(j % model.length, 1)[0]; s.delete(x); }",
    "  }",
    "  const keys = [...s.keys()];",
    "  out.push({ ins, del, same: JSON.stringify(keys) === JSON.stringify(model), size: s.size === model.length,",
    "    gets: model.every((x) => s.get(x) === x * 3) && s.get(-1) === undefined, checks, worst, packs: s.packs });",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  for (const r of JSON.parse(execFileSync(process.execPath, ["-e", js], { encoding: "utf8" }))) {
    const what = JSON.stringify(r);
    assert.ok(r.same && r.size && r.gets, what);
    // (the sparse patterns pack several times; 3 in, 1 out stays more than
    // half full and never does)
    assert.ok(r.checks > 0 && (r.del === 1 ? r.packs === 0 : r.packs >= 3), what);
    assert.ok(r.worst <= 0, what);
  }
});

// (a clear() at every place an iterator can be, the end of a segment
// included: on in the new entries only, as a plain Map's iterator, the set's
// at full size; CPython goes on from its hash table's slot instead, which
// this doesn't copy, as master's sets didn't)
test("a set's iterator across clear() at every position: only the new entries", () => {
  const code = `
out = []
for k in range(1, 10):
    s = set(range(10))
    it = iter(s)
    for _ in range(k):
        next(it)
    s.clear()
    s.update(range(100, 110))
    out.append(list(it))
print(out)
`;
  const seg = py4(code);
  assert.equal(seg, py4(code, null));
  assert.ok(!/\b[0-9]\b/.test(seg.replace(/\b1\d\d\b/g, "")), seg);
});

// (an iterator that goes on after its dict was packed, a deletion having put
// the size back: its place is gone, so a RuntimeError, never a skipped or
// repeated entry)
test("an iterator that goes on after a packing raises", () => {
  const out = py4(`
def run(kind):
    c = set(range(8)) if kind == "set" else dict.fromkeys(range(8))
    # (segments 0-3 and 4-7; the first emptied: half full, the last full)
    for x in range(4):
        c.remove(x) if kind == "set" else c.pop(x)
    it = iter(c)
    got = [next(it)]
    c.add(100) if kind == "set" else c.__setitem__(100, None)
    c.remove(7) if kind == "set" else c.pop(7)
    try:
        got += list(it)
        return got
    except RuntimeError as e:
        return got, str(e)
# (the same for an iterator still on the plain Map the dict had before it
# became segmented)
def run_plain(kind):
    c = set(range(4)) if kind == "set" else dict.fromkeys(range(4))
    it = iter(c)
    got = [next(it)]
    add = c.add if kind == "set" else (lambda x: c.__setitem__(x, None))
    drop = c.remove if kind == "set" else c.pop
    add(4)
    for x in range(4):
        drop(x)
    for x in (5, 6, 7, 8):
        add(x)
    drop(8)
    try:
        got += list(it)
        return got
    except RuntimeError as e:
        return got, str(e)
# (and one whose plain Map still held keys it hadn't reached when the
# packing came; one of them is deleted after: it must not come back)
def run_stale(kind):
    c = set(range(4)) if kind == "set" else dict.fromkeys(range(4))
    it = iter(c)
    got = [next(it)]
    add = c.add if kind == "set" else (lambda x: c.__setitem__(x, None))
    drop = c.remove if kind == "set" else c.pop
    for x in range(4, 16):
        add(x)
    for x in [0] + list(range(4, 12)):
        drop(x)
    add(16)
    for x in (1, 12, 13, 16):
        drop(x)
    try:
        # (a step at a time: what it gives before it raises is seen)
        for x in it:
            got.append(x)
        return got
    except RuntimeError as e:
        return got, str(e)
print(run("dict"))
print(run("set"))
print(run_plain("dict"))
print(run_plain("set"))
print(run_stale("dict"))
print(run_stale("set"))
`);
  const dict = "'dictionary keys changed during iteration'", set = "'Set changed during iteration'";
  assert.equal(out, [`([4], ${dict})`, `([4], ${set})`, `([0], ${dict})`, `([0], ${set})`, `([0], ${dict})`, `([0], ${set})`, ""].join("\n"));
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
