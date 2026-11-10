import test from "node:test";
import assert from "node:assert/strict";
import { TermOutput, utf8Prefix } from "../src/term-output";

// A Terminal command's output sink (src/term-output.ts; PR 3a (b1) design r4 §2): bounded while it is received, the
// cap aggregate, stdout's prefix then stderr's in what is left, cut at scalar boundaries, never more than the cap
// retained.  The meanings of exceeded and truncated are the shell module's bounded()'s.
const enc = new TextEncoder();
const u8 = (s: string) => enc.encode(s).length;

test("under the cap: everything, in order, counted exactly", () => {
  const o = new TermOutput(100, 1000);
  o.write(2, "e1 ");
  o.write(1, "a");
  o.write(2, "e2");
  o.write(1, "é");
  const r = o.result();
  assert.equal(r.stdout, "aé");
  assert.equal(r.stderr, "e1 e2");
  assert.deepEqual(r.output, { producedBytes: 3 + 1 + 2 + 2, deliveredBytes: 8, exceeded: false, truncated: false });
});

test("a crossing fragment is cut before it is appended, at a scalar boundary (2-, 3- and 4-byte scalars)", () => {
  for (const [ch, w] of [["é", 2], ["€", 3], ["😀", 4]] as const) {
    const o = new TermOutput(5, 1000);
    o.write(1, "ab" + ch + ch);
    assert.ok(o.retained() <= 5);
    const r = o.result();
    assert.equal(r.stdout, "ab" + (2 + w <= 5 ? ch : ""), ch);
    assert.equal(r.output.producedBytes, 2 + 2 * w);
    assert.equal(r.output.deliveredBytes, u8(r.stdout));
    assert.equal(r.output.exceeded, true);
  }
});

test("the cap is aggregate: stderr first, then stdout to the high-water mark; stderr trimmed, never more than the cap kept", () => {
  const o = new TermOutput(10, 1000);
  o.write(2, "EEEEEEEE"); // 8 of stderr: kept, stdout has nothing yet
  assert.equal(o.retained(), 8);
  o.write(1, "oooooo"); // stdout 6: stderr trimmed to the 4 left
  assert.ok(o.retained() <= 10);
  o.write(1, "oooooo"); // stdout to 10 (the cap): stderr trimmed to nothing
  assert.ok(o.retained() <= 10);
  o.write(2, "F"); // no space left: only counted
  const r = o.result();
  assert.equal(r.stdout, "oooooooooo");
  assert.equal(r.stderr, "");
  assert.deepEqual(r.output, { producedBytes: 8 + 12 + 1, deliveredBytes: 10, exceeded: true, truncated: false });
  // (an independent cap per stream would have kept stderr's 8 too: 18 > 10)
});

test("interleaved streams: the result is stdout's prefix then stderr's in what is left, whatever the order", () => {
  const o = new TermOutput(9, 1000);
  o.write(1, "ab");
  o.write(2, "xyz");
  o.write(1, "cd");
  o.write(2, "uvw");
  o.write(1, "e");
  const r = o.result();
  assert.equal(r.stdout, "abcde");
  assert.equal(r.stderr, "xyzu");
  assert.equal(u8(r.stdout) + u8(r.stderr), 9);
});

test("the backstop reached first while allowance remains: truncated, not exceeded", () => {
  const o = new TermOutput(1000, 6);
  o.write(1, "0123456789");
  const r = o.result();
  assert.equal(r.stdout, "012345");
  assert.deepEqual(r.output, { producedBytes: 10, deliveredBytes: 6, exceeded: false, truncated: true });
});

test("past the allowance: exceeded; an allowance of 0 keeps nothing; a lone surrogate counts 3 bytes", () => {
  const z = new TermOutput(0, 1000);
  z.write(1, "x");
  assert.deepEqual(z.result(), { stdout: "", stderr: "", output: { producedBytes: 1, deliveredBytes: 0, exceeded: true, truncated: false } });
  assert.equal(utf8Prefix("\ud800", Infinity).bytes, 3);
  assert.equal(utf8Prefix("a😀", 2).end, 1);
});

test("never retained past the cap, through many small writes", () => {
  const o = new TermOutput(1000, 4096);
  for (let i = 0; i < 5000; i++) {
    o.write((i % 3 === 0 ? 2 : 1) as 1 | 2, "é€x");
    assert.ok(o.retained() <= 1000);
  }
  const r = o.result();
  assert.equal(r.output.producedBytes, 5000 * 6);
  assert.equal(u8(r.stdout) + u8(r.stderr), r.output.deliveredBytes);
  assert.ok(r.output.deliveredBytes <= 1000 && r.output.deliveredBytes >= 1000 - 3);
});
