import test from "node:test";
import assert from "node:assert/strict";
import { PromptOutput, type PromptSegment } from "../src/term-output";

// A Terminal prompt's output (src/term-output.ts PromptOutput): one statement at a time, in the order written; stdout
// kept while out + err < IN - RES, stderr while out + err < IN; the omitted count closes the statement; a flush frees
// storage only and refills nothing; at most perFlush segments are ever held.

const sink = (inBytes: number, reserve: number, perFlush = 4096) => {
  const flushes: PromptSegment[][] = [];
  const o = new PromptOutput(inBytes, reserve, perFlush, (s) => flushes.push(s));
  return { o, flushes, all: () => flushes.flat() };
};

test("in the order written: adjacent writes to one stream merge, a change of stream starts a segment", () => {
  const { o, flushes } = sink(1000, 100);
  o.begin();
  o.write(1, "a");
  o.write(1, "b");
  o.write(2, "E");
  o.write(1, "c");
  o.end();
  assert.deepEqual(flushes, [[{ fd: 1, text: "ab" }, { fd: 2, text: "E" }, { fd: 1, text: "c" }]]);
});

test("a stdout flood can't take stderr's reserve: the traceback after it is still shown, and the omitted count closes the output", () => {
  const { o, all } = sink(100, 30);
  o.begin();
  o.write(1, "x".repeat(500));
  o.write(2, "Traceback: boom\n");
  o.end();
  const out = all();
  assert.equal(out[0].fd, 1);
  assert.equal(out[0].text.length, 70);
  assert.equal(out[1].fd, 2);
  assert.ok(out[1].text.startsWith("Traceback: boom\n"));
  assert.match(out[1].text, /… 430 bytes of output omitted\n$/);
  // (stderr past IN as a whole is cut and counted too)
  const b = sink(10, 4);
  b.o.begin();
  b.o.write(2, "0123456789AB");
  b.o.end();
  assert.deepEqual(b.all(), [{ fd: 2, text: "0123456789… 2 bytes of output omitted\n" }]);
});

test("cuts fall at scalar boundaries: a 4-byte character that doesn't fit isn't split", () => {
  const { o, all } = sink(8, 0);
  o.begin();
  o.write(1, "abcdefg😀");
  o.end();
  assert.equal(all()[0].text, "abcdefg");
  assert.match(all()[1].text, /… 4 bytes of output omitted/);
});

test("a flush (as at input()) frees storage only: the statement's counters go on, nothing is shown twice, the quota isn't refilled", () => {
  const { o, flushes } = sink(10, 0);
  o.begin();
  o.write(1, "123456");
  o.flush();
  o.write(1, "789012");
  o.end();
  assert.deepEqual(flushes[0], [{ fd: 1, text: "123456" }]);
  assert.equal(flushes[1][0].text, "7890");
  assert.match(flushes[1][1].text, /… 2 bytes of output omitted/);
  // (delivered is UTF-8 bytes: the omitted line's "…" is three)
  assert.equal(o.delivered, 10 + new TextEncoder().encode(flushes[1][1].text).length);
  // (the next statement starts afresh)
  o.begin();
  o.write(1, "abc");
  o.end();
  assert.deepEqual(flushes[2], [{ fd: 1, text: "abc" }]);
});

test("alternating one-byte writes: at most perFlush segments held, a forced flush before one more, all of it in order", () => {
  const max = 4096;
  const { o, flushes } = sink(1 << 20, 65536, max);
  o.begin();
  let peak = 0;
  for (let i = 0; i < 10000; i++) {
    o.write(i % 2 ? 2 : 1, String(i % 10));
    peak = Math.max(peak, o.held());
  }
  o.end();
  assert.ok(peak <= max, `held ${peak}`);
  assert.equal(flushes.length, Math.ceil(10000 / max));
  assert.ok(flushes.every((f) => f.length <= max));
  const text = flushes.flat().map((s) => s.text).join("");
  assert.equal(text, Array.from({ length: 10000 }, (_, i) => String(i % 10)).join(""));
  const fds = flushes.flat().map((s) => s.fd);
  assert.ok(fds.every((fd, i) => i === 0 || fd !== fds[i - 1] || flushes.some((f) => f[0] === flushes.flat()[i])), "no two adjacent segments to one fd inside a flush");
});
