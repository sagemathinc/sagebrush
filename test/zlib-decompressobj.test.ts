import test from "node:test";
import assert from "node:assert/strict";

// zlib.decompressobj where it is Sagebrush's own (note-zlib-decompressobj
// r3.1; numpy-tests/test_zlib_stream.py compares the rest with CPython):
//   - max_length is a stop, never an error: N+1 bytes read with max_length N
//     give exactly N, eof False, and the last byte next call;
//   - only max_length=0 (and zlib.decompress) raise, past the array limit: a
//     stream of exactly N bytes is accepted at a limit of N and refused at
//     N-1, the refused call allocating no buffer past the limit and its window
//     (a spy counts every typed buffer made);
//   - unconsumed_tail at a stop holds the whole unread bytes, which leave the
//     object (resubmitting them never duplicates one); it may be one byte
//     longer than CPython's, whose zlib holds the byte in progress;
//   - zdict and copy() are refused.
const counter = { bytes: 0, largest: 0 };
// (CPython's zlib.compress(b"\\0" * 3_000_000, 9): 2,929 bytes; Sagebrush's compress writes stored blocks only)
const BOMB = "eNrtwQEBAAAAgiD/r25IQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC8GyWMAAQ==";
for (const name of ["Uint8Array", "Int32Array", "Float64Array"]) {
  const Base = (globalThis as any)[name];
  const Counted = class extends Base {
    constructor(...args: any[]) {
      super(...args);
      const a = args[0];
      if (!(a instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer)) {
        counter.bytes += (this as any).byteLength;
        counter.largest = Math.max(counter.largest, (this as any).byteLength);
      }
    }
  };
  Object.defineProperty(Counted, "name", { value: name });
  (globalThis as any)[name] = Counted;
}

async function session() {
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  return async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && m.stream).map((m) => m.text).join("");
  };
}

test("zlib.decompressobj: max_length stops, the array limit refuses, the tail is the caller's", async () => {
  const run = await session();
  const np = require("../src/runtime/numpy");
  // a stream of N bytes: stored blocks (Sagebrush's compress), so N is exact
  const N = 100_000;
  assert.equal(await run(`import zlib\nX = bytes(range(256)) * ${Math.ceil(N / 256)}\nX = X[:${N}]\nZ = zlib.compress(X)\nprint(len(X), len(Z) > len(X))`), `${N} True\n`);

  // max_length N-1: exactly N-1, not the end, then the last byte; never an error
  assert.equal(
    await run(`d = zlib.decompressobj()\na = d.decompress(Z, ${N - 1})\nprint(len(a), d.eof, len(d.unconsumed_tail) > 0)\nb = d.decompress(d.unconsumed_tail, ${N - 1})\nprint(len(b), d.eof, a + b == X)`),
    `${N - 1} False True\n1 True True\n`,
  );

  // the array limit, max_length 0: a bomb of exactly M bytes accepted at M, refused at M-1, no buffer past it
  const M = 3_000_000;
  await run(`import base64\nB = base64.b64decode("${BOMB}")`);
  const saved = { ...np.ARRAY_LIMITS };
  try {
    np.ARRAY_LIMITS.bytes = M;
    assert.equal(await run(`d = zlib.decompressobj()\nprint(len(d.decompress(B)), d.eof)\nprint(len(zlib.decompress(B)))`), `${M} True\n${M}\n`);
    np.ARRAY_LIMITS.bytes = M - 1;
    counter.largest = 0;
    const refused = await run(`d = zlib.decompressobj()\ntry:\n    d.decompress(B)\nexcept zlib.error as e:\n    print(e)`);
    assert.equal(refused, `Error -5 while decompressing data: output exceeds Sagebrush's limit of ${M - 1} bytes\n`);
    assert.ok(counter.largest <= M - 1, `the refused call made a buffer of ${counter.largest} bytes, past the limit`);
  } finally {
    Object.assign(np.ARRAY_LIMITS, saved);
  }

  // a bomb read in 1 MiB stops: each call exactly 1 MiB, the window the only memory kept between them
  assert.equal(
    await run(`d = zlib.decompressobj()\nsizes = []\nbuf = B\nwhile not d.eof:\n    sizes.append(len(d.decompress(buf, 1 << 20)))\n    buf = d.unconsumed_tail\nprint(sizes)`),
    "[1048576, 1048576, 902848]\n",
  );

  // the tail leaves the object: resubmitting it never duplicates a byte, at every max_length
  assert.equal(
    await run(`ok = True\nfor n in (1, 3, 1000, 65535, 65536):\n    d = zlib.decompressobj()\n    out, buf = b"", Z\n    while not d.eof:\n        out += d.decompress(buf, n)\n        buf = d.unconsumed_tail\n    ok = ok and out == X and d.unused_data == b""\nprint(ok)`),
    "True\n",
  );

  // refused: zdict, copy()
  assert.equal(
    await run(`for f in (lambda: zlib.decompressobj(zdict=b"ab"), lambda: zlib.decompressobj().copy()):\n    try:\n        f()\n    except NotImplementedError as e:\n        print(e)`),
    "zlib: decompressobj(zdict=) is not in Sagebrush's zlib\nzlib: Decompress.copy() is not in Sagebrush's zlib\n",
  );
});
