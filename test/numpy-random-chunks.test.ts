// numpy.random's WebAssembly kernel fills an output a chunk at a time (numpy_random.ts inChunks), so its memory never
// holds a whole array of more than 4 GiB of draws. The chunks are one stream: with the chunk lowered to 1000 draws,
// the same seeds give the same bytes as one call, for uniforms, normals and bounded integers, MT19937 and PCG64,
// with lengths that end on a chunk and past one.
import test from "node:test";
import assert from "node:assert/strict";

test("a chunked fill is the same stream as one call (MT19937 and PCG64; uniform, normal, bounded)", async () => {
  const nr = require("../src/runtime/numpy_random");
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && m.stream).map((m) => m.text).join("");
  };
  const code = [
    "import numpy as np, hashlib",
    "out = []",
    "for n in (3000, 3500, 4999):",
    "    rs = np.random.RandomState(7)",
    "    out.append(hashlib.sha256(rs.rand(n).tobytes() + rs.standard_normal(n).tobytes() + rs.randint(0, 1000, n).tobytes()).hexdigest())",
    "    g = np.random.default_rng(7)",
    "    out.append(hashlib.sha256(g.random(n).tobytes() + g.standard_normal(n).tobytes() + g.integers(0, 1000, n).tobytes()).hexdigest())",
    "print(' '.join(out))",
  ].join("\n");
  const whole = await run(code);
  const was = nr.setRandomChunk(1000);
  let chunked = "";
  try {
    chunked = await run(code);
  } finally {
    nr.setRandomChunk(was);
  }
  assert.equal(whole.trim().split(" ").length, 6, whole);
  assert.equal(chunked, whole);
});

test("a chunk the kernel refuses after the first: the fill restarts in JavaScript from the generator as it was", async () => {
  // (the kernel made to refuse its second call: every chunk before it has advanced only a copy of the state)
  const nr = require("../src/runtime/numpy_random");
  const k = require("../src/runtime/kernels");
  const { notebookSession } = require("../src/notebook-session");
  const msgs: any[] = [];
  const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
  await s.ready;
  let id = 0;
  const run = async (code: string) => {
    const n = ++id;
    await s.handle({ id: n, code });
    return msgs.filter((m) => m.id === n && m.stream).map((m) => m.text).join("");
  };
  const code = "import numpy as np, hashlib\nrs = np.random.RandomState(11)\na = rs.rand(4999)\nb = rs.rand(10)\ng = np.random.default_rng(11)\nc = g.random(4999)\nd = g.random(10)\nprint(hashlib.sha256(a.tobytes() + b.tobytes() + c.tobytes() + d.tobytes()).hexdigest())";
  const whole = await run(code);
  const was = nr.setRandomChunk(1000), orig = k.wasmRandom;
  let calls = 0, failing = "";
  try {
    k.wasmRandom = (...a: any[]) => (++calls % 4 === 2 ? false : orig(...a));
    failing = await run(code);
  } finally {
    k.wasmRandom = orig;
    nr.setRandomChunk(was);
  }
  assert.ok(calls > 2, `the kernel was called ${calls} times`);
  assert.equal(failing, whole);
});
