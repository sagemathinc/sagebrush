import test from "node:test";
import assert from "node:assert/strict";
import { encodeSegments, decodeSegments, outArgs, lineArgs, lineAnswer, linesCost, SEGS_MAX, PROMPT_MAX, FRAME, type Segment } from "../web/term-prompt-wire";

// A Terminal prompt's two channel operations (web/term-prompt-wire.ts): `out`'s framed segments and `line`'s header and
// answers, each checked whole, refused whole when it isn't the protocol's.

const segs: Segment[] = [
  { fd: 1, text: "0 1024\n" },
  { fd: 2, text: "Traceback …\n" },
  { fd: 1, text: "é😀\n" },
];

test("out: segments round-trip in order, UTF-8 intact; the header's counts and the statement's allowance bound them", () => {
  const body = encodeSegments(segs);
  assert.deepEqual(decodeSegments(body, 3), segs);
  const text = segs.reduce((n, s) => n + new TextEncoder().encode(s.text).length, 0);
  assert.equal(body.length, 3 * FRAME + text);
  assert.deepEqual(outArgs({ segs: 3, bytes: body.length }, body.length, text), { segs: 3, bytes: body.length });
  // (one byte over the allowance; a length that isn't the header's; counts out of range; an extra key)
  assert.equal(outArgs({ segs: 3, bytes: body.length }, body.length, text - 1), null);
  assert.equal(outArgs({ segs: 3, bytes: body.length }, body.length + 1, text), null);
  assert.equal(outArgs({ segs: 0, bytes: 0 }, 0, 100), null);
  assert.equal(outArgs({ segs: SEGS_MAX + 1, bytes: (SEGS_MAX + 1) * 6 }, (SEGS_MAX + 1) * 6, 1e9), null);
  assert.equal(outArgs({ segs: 3, bytes: body.length, x: 1 }, body.length, text), null);
  assert.equal(outArgs({ segs: 3, bytes: 3 * FRAME }, 3 * FRAME, 100), null);
});

test("out: a body that isn't the protocol's is refused whole", () => {
  const body = encodeSegments(segs);
  // (a count that isn't the header's, a truncated frame, trailing bytes)
  assert.equal(decodeSegments(body, 2), null);
  assert.equal(decodeSegments(body, 4), null);
  assert.equal(decodeSegments(body.subarray(0, body.length - 1), 3), null);
  const extra = new Uint8Array(body.length + 1);
  extra.set(body);
  assert.equal(decodeSegments(extra, 3), null);
  // (an fd other than 1 or 2, an empty segment, bytes that aren't UTF-8, two adjacent segments to one fd)
  const badFd = body.slice();
  badFd[0] = 3;
  assert.equal(decodeSegments(badFd, 3), null);
  const empty = new Uint8Array([1, 0, 0, 0, 0]);
  assert.equal(decodeSegments(empty, 1), null);
  const notUtf8 = new Uint8Array([1, 1, 0, 0, 0, 0xff]);
  assert.equal(decodeSegments(notUtf8, 1), null);
  assert.equal(decodeSegments(encodeSegments([{ fd: 1, text: "a" }, { fd: 1, text: "b" }]), 2), null);
});

test("line: a header with no body, its kind, cont, a prompt within PROMPT_MAX and what the input has left; the four answers, checked", () => {
  const p = (o: object) => ({ kind: "prompt", cont: false, prompt: ">>> ", bytes: 100, lines: 5, ...o });
  const B = { sourceBytes: 1000, lines: 10 };
  assert.deepEqual(lineArgs(p({}), undefined, B), { kind: "prompt", cont: false, prompt: ">>> ", bytes: 100, lines: 5 });
  assert.deepEqual(lineArgs(p({ kind: "input", prompt: "", lines: 1 }), undefined, B), { kind: "input", cont: false, prompt: "", bytes: 100, lines: 1 });
  assert.equal(lineArgs(p({}), 10, B), null);
  assert.equal(lineArgs(p({ kind: "other" }), undefined, B), null);
  assert.equal(lineArgs(p({ cont: "no" }), undefined, B), null);
  assert.equal(lineArgs(p({ prompt: "x".repeat(PROMPT_MAX + 1) }), undefined, B), null);
  assert.equal(lineArgs(p({ prompt: "é".repeat(PROMPT_MAX / 2 + 1) }), undefined, B), null);
  // (what is left: at least a newline's byte and one line, whole numbers; input() takes one line, its own)
  for (const bad of [{ bytes: 0 }, { lines: 0 }, { bytes: 1.5 }, { lines: -1 }, { bytes: "9" }, { bytes: 2 ** 53 }, { kind: "input", lines: 2 }]) assert.equal(lineArgs(p(bad), undefined, B), null, JSON.stringify(bad));
  assert.equal(lineArgs({ kind: "prompt", cont: false, prompt: ">>> " }, undefined, B), null);
  assert.equal(lineArgs({ ...p({}), extra: 1 }, undefined, B), null);
  assert.deepEqual(linesCost(["if True:", "  é"]), { bytes: 9 + 5, lines: 2 });
  // (never more than the prompt's bounds: a statement's sourceBytes and lines; input()'s one line, its newline counted)
  const b = { sourceBytes: 40, lines: 4 };
  assert.ok(lineArgs(p({ bytes: 40, lines: 4 }), undefined, b));
  assert.equal(lineArgs(p({ bytes: 41, lines: 4 }), undefined, b), null, "a prompt's sourceBytes + 1");
  assert.equal(lineArgs(p({ bytes: 40, lines: 5 }), undefined, b), null, "a prompt's lines + 1");
  assert.ok(lineArgs(p({ kind: "input", bytes: 41, lines: 1 }), undefined, b), "input()'s sourceBytes + 1 (its newline)");
  assert.equal(lineArgs(p({ kind: "input", bytes: 42, lines: 1 }), undefined, b), null, "input()'s sourceBytes + 2");
  assert.deepEqual(lineAnswer({ line: "x = 1" }, 5), { line: "x = 1" });
  assert.equal(lineAnswer({ line: "x = 12" }, 5), null);
  assert.equal(lineAnswer({ line: "a\nb" }, 100), null);
  assert.deepEqual(lineAnswer({ eof: true }, 0), { eof: true });
  assert.deepEqual(lineAnswer({ refused: "too-long" }, 0), { refused: "too-long" });
  assert.deepEqual(lineAnswer({ interrupt: true }, 0), { interrupt: true });
  assert.equal(lineAnswer({ interrupt: true, line: "" }, 10), null);
  assert.equal(lineAnswer({ eof: 1 }, 10), null);
  assert.equal(lineAnswer(null, 10), null);
});
