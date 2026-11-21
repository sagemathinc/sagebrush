// numpy.fft's table cache keeps at most its bound (4 GiB; lowered here so it is cheap): a table that alone passes it
// is used and not kept, the transform still made and right; and as tables are made the oldest give way, so what stays
// cached never passes the bound, however the transforms nest their tables (numpy_fft.ts cached, cacheRoom).
import test from "node:test";
import assert from "node:assert/strict";

test("an oversize table: the transform is made and right, and nothing past the bound stays cached", async () => {
  const fft = require("../src/runtime/numpy_fft");
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
  await run("import numpy as np");
  const BOUND = 4096;
  const was = fft.setFftCacheBytes(BOUND);
  try {
    // (4096 points: its tables, 12 n and 16 n bytes, each past the bound alone; a 1000-point Bluestein transform's chirp too)
    for (const n of [4096, 1000, 64, 4096, 50, 33]) {
      const out = await run(`x = np.arange(${n}, dtype=float)\ny = np.fft.ifft(np.fft.fft(x)).real\nprint(bool(np.allclose(y, x)), float(np.fft.fft(x)[0].real) == float(x.sum()))`);
      assert.equal(out.trim(), "True True", `n = ${n}`);
      const [bytes] = fft.fftCacheBytes();
      assert.ok(bytes <= BOUND, `after n = ${n}: ${bytes} bytes cached, past the bound ${BOUND}`);
    }
    // (small tables are still kept)
    await run("np.fft.fft(np.ones(16))");
    assert.ok(fft.fftCacheBytes()[1] > 0, "a small transform's tables are cached");
    // (one transform that makes several tables, each within the bound and together past it: Bluestein's for 1009
    //  points, a prime, its chirp 48,912 bytes and the 2048-point twiddles 32,768; the oldest give way as each is made,
    //  so what stays cached is within the bound after it)
    fft.setFftCacheBytes(60000);
    const out = await run("x = np.arange(1009, dtype=float)\nprint(bool(np.allclose(np.fft.ifft(np.fft.fft(x)).real, x)))");
    assert.equal(out.trim(), "True");
    const [bytes, entries] = fft.fftCacheBytes();
    assert.ok(bytes <= 60000 && entries > 0, `a transform's own tables: ${bytes} bytes in ${entries} entries cached, past the bound 60000`);
  } finally {
    fft.setFftCacheBytes(was);
  }
});
