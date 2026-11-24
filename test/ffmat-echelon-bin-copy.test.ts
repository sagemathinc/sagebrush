import test from "node:test";
import assert from "node:assert/strict";
import { binPiecesTest, BinRequestRefused, BIN_FRAME_CAP, BIN_MAX_PIECES } from "../src/runtime/engine";
import { INTR, INTR_CTRL_C, consumeCtrlC } from "../src/runtime/interrupt";

// pyjs's binary call in pieces (src/runtime/engine.ts binCallPieces) at the
// frame cap, on a fake engine (its memory, alloc, free, call and reply
// length): a pending Ctrl-C stops the request's copy into the engine after
// one run of 1 MiB, and the reply's copy out after one, the request's
// buffer freed and the next call working; each copy's single-run version
// (the omission mutant: no check until the whole buffer is copied) copies
// all of it; and a request past the frame cap, or in too many pieces, is
// refused before anything is allocated.

const MIB = 1 << 20;
const RUN = binPiecesTest.BIN_CHUNK;

/** A fake engine of `bytes` of memory: the request at 0, the reply (of
 *  replyLen bytes) at `replyAt`; `onCall` runs inside its call. */
function fake(bytes: number, replyAt = 0, replyLen = 16, onCall: () => void = () => {}) {
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) });
  const f = {
    memory,
    allocs: 0,
    frees: 0,
    calls: 0,
    sb_alloc(_len: number) {
      f.allocs++;
      return 0;
    },
    sb_free(_p: number, _len: number) {
      f.frees++;
    },
    sb_bin_call(_p: number, _len: number) {
      f.calls++;
      onCall();
      return replyAt;
    },
    sb_reply_len() {
      return replyLen;
    },
  };
  return f;
}

/** The bytes written into, and copied out of, a fake engine's memory during f. */
function copied(mem: WebAssembly.Memory, f: () => void): { into: number; out: number; error: any } {
  const set = Uint8Array.prototype.set, slice = Uint8Array.prototype.slice;
  let into = 0, out = 0, error: any = null;
  Uint8Array.prototype.set = function (this: Uint8Array, a: any, off?: number) {
    if (this.buffer === mem.buffer) into += a.length;
    return set.call(this, a, off);
  };
  Uint8Array.prototype.slice = function (this: Uint8Array, s?: number, e?: number) {
    const r = slice.call(this, s, e);
    if (this.buffer === mem.buffer) out += r.length;
    return r;
  } as any;
  try {
    f();
  } catch (err) {
    error = err;
  } finally {
    Uint8Array.prototype.set = set;
    Uint8Array.prototype.slice = slice;
    consumeCtrlC();
  }
  return { into, out, error };
}

const ctrlC = () => Atomics.or(INTR, 0, INTR_CTRL_C);

test("pyjs pieces call: Ctrl-C stops the request's copy in after one run, at the frame cap", () => {
  const e = fake(BIN_FRAME_CAP + 65536, BIN_FRAME_CAP);
  const one = new Uint8Array(MIB);
  const pieces = Array(BIN_FRAME_CAP / MIB).fill(one); // (exactly the cap, one array repeated)
  ctrlC();
  const r = copied(e.memory, () => binPiecesTest.run(e, pieces));
  assert.match(String(r.error?.message), /interrupted while copying the request/);
  assert.equal(r.into, RUN, "one run copied in");
  assert.deepEqual([e.allocs, e.frees, e.calls], [1, 1, 0], "the request's buffer freed, the engine not called");
  // the omission mutant: one run of the whole buffer copies all of it first
  ctrlC();
  const m = copied(e.memory, () => binPiecesTest.run(e, pieces, BIN_FRAME_CAP));
  assert.match(String(m.error?.message), /interrupted while copying the request/);
  assert.equal(m.into, BIN_FRAME_CAP, "the single-run copy sees the Ctrl-C only after the whole frame");
  // and the next call works
  const ok = copied(e.memory, () => binPiecesTest.run(e, [new Uint8Array(32)]));
  assert.equal(ok.error, null);
  assert.equal(e.calls, 1);
});

test("pyjs pieces call: Ctrl-C stops the reply's copy out after one run, at the frame cap", () => {
  const e = fake(BIN_FRAME_CAP + 65536, 65536, BIN_FRAME_CAP, ctrlC);
  const r = copied(e.memory, () => binPiecesTest.run(e, [new Uint8Array(64)]));
  assert.match(String(r.error?.message), /interrupted while copying the reply/);
  assert.equal(r.out, RUN, "one run copied out");
  assert.deepEqual([e.allocs, e.frees, e.calls], [1, 1, 1], "the request's buffer freed before the reply");
  // the omission mutant
  const m = copied(e.memory, () => binPiecesTest.run(e, [new Uint8Array(64)], BIN_FRAME_CAP));
  assert.match(String(m.error?.message), /interrupted while copying the reply/);
  assert.equal(m.out, BIN_FRAME_CAP, "the single-run copy sees the Ctrl-C only after the whole reply");
  // and the next call works (a short reply, no Ctrl-C)
  const f = fake(1 << 20, 4096, 100);
  const ok = copied(f.memory, () => binPiecesTest.run(f, [new Uint8Array(64)]));
  assert.equal(ok.error, null);
  assert.equal(ok.out, 100);
});

test("pyjs pieces call: past the frame cap or in too many pieces, refused before any allocation", () => {
  const e = fake(65536);
  const one = new Uint8Array(MIB);
  const pages = e.memory.buffer.byteLength;
  for (const pieces of [
    Array(BIN_FRAME_CAP / MIB + 1).fill(one), // (257 references to the same 1 MiB)
    [...Array(BIN_FRAME_CAP / MIB).fill(one), new Uint8Array(1)], // (the cap + 1)
    Array(BIN_MAX_PIECES + 1).fill(new Uint8Array(0)),
  ]) {
    const r = copied(e.memory, () => binPiecesTest.run(e, pieces));
    assert.ok(r.error instanceof BinRequestRefused, String(r.error));
    assert.deepEqual([e.allocs, e.calls, r.into], [0, 0, 0], "nothing allocated, copied or called");
  }
  assert.equal(e.memory.buffer.byteLength, pages);
});

test("pyjs pieces call: the builtin's list admitted before a view of any piece is made", () => {
  // (the builtin's piece: a size, and a view made only by viewOf)
  type Piece = { n: number };
  let looked = 0, views = 0;
  const sizeOf = (x: Piece) => x.n;
  const viewOf = (x: Piece) => (views++, new Uint8Array(x.n));
  // too many pieces: refused on the count alone, no piece looked at
  const many = new Proxy(Array(BIN_MAX_PIECES + 1).fill({ n: 0 }), {
    get(t, k, r) {
      if (typeof k === "string" && /^\d+$/.test(k)) looked++;
      return Reflect.get(t, k, r);
    },
  });
  assert.throws(() => binPiecesTest.views(many, sizeOf, viewOf), BinRequestRefused);
  assert.deepEqual([looked, views], [0, 0], "no piece looked at, no view made");
  // one piece's size repeated past the cap (no real frame): refused, no view
  const big = { n: MIB };
  for (const pieces of [Array(BIN_FRAME_CAP / MIB + 1).fill(big), [...Array(BIN_FRAME_CAP / MIB).fill(big), { n: 1 }]]) {
    assert.throws(() => binPiecesTest.views(pieces, sizeOf, viewOf), BinRequestRefused);
    assert.equal(views, 0, "no view made");
  }
  // a piece of the wrong kind: its error, before any view
  const wrong = (x: Piece) => {
    if (x.n < 0) throw new TypeError("not bytes");
    return x.n;
  };
  assert.throws(() => binPiecesTest.views([{ n: 1 }, { n: -1 }], wrong, viewOf), TypeError);
  assert.equal(views, 0);
  // the most pieces, and exactly the cap, admitted: a view each
  assert.equal(binPiecesTest.views(Array(BIN_MAX_PIECES).fill({ n: 0 }), sizeOf, viewOf).length, BIN_MAX_PIECES);
  views = 0;
  const cap = [{ n: BIN_FRAME_CAP - 1 }, { n: 1 }];
  const sized = (x: Piece) => x.n;
  assert.equal(binPiecesTest.views(cap, sized, (x) => (views++, new Uint8Array(0))).length, 2);
  assert.equal(views, 2);
});
