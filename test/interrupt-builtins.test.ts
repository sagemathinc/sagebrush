import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import * as zlib from "node:zlib";

// Stop (the shared interrupt flag, INTR[0]) reaches a builtin that consumes
// a long iterable: math.fsum(range(10**12)) and math.prod(...) stop with a
// KeyboardInterrupt (ops.forEach polls it), as the notebook's Stop needs.
const DIST = __dirname + "/..";

// (ms null: the request is there before the program starts)
function interruptAfter(code: string, ms: number | null, wait = 2000): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      // (lib on the path, as the CLI has it, for numpy)
      c.R.importModule("sys").path.push(c.libDir());
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      if (workerData.preset) Atomics.store(c.R.INTR, 0, 1);
      try {
        c.execModule(workerData.code, "<test>", "__main__");
        parentPort.postMessage({ done: "finished" });
      } catch (e) {
        parentPort.postMessage({ done: c.R.formatException(e).trim().split("\\n").pop() });
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code, preset: ms === null } },
  );
  return new Promise((resolve, reject) => {
    let stop: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => (w.terminate(), resolve("not interrupted")), (ms ?? 0) + wait);
    w.on("message", (m) => {
      if (m.intr && ms !== null) stop = setTimeout(() => Atomics.store(new Int32Array(m.intr), 0, 1), ms);
      if (m.done) (clearTimeout(timer), clearTimeout(stop), w.terminate(), resolve(m.done));
    });
    w.on("error", reject);
  });
}

test("Stop interrupts math.fsum and math.prod over a long range (HARD-2ED-1)", async () => {
  assert.equal(await interruptAfter("import math\nmath.fsum(range(10**12))", 300), "KeyboardInterrupt");
  assert.equal(await interruptAfter("import math\nmath.prod(range(1, 10**12))", 300), "KeyboardInterrupt");
});

test("an iterator stopped by Stop loses no item: every item taken was used (CORR-F45-2)", async () => {
  // (l += It() goes through ops.forEach, and It's __next__ has no loop of
  // its own to poll Stop; after the KeyboardInterrupt the list must hold
  // every item __next__ gave)
  const last = await interruptAfter(
    [
      "class It:",
      "    fetched = 0",
      "    def __iter__(self):",
      "        return self",
      "    def __next__(self):",
      "        It.fetched += 1",
      "        return It.fetched",
      "l = []",
      "try:",
      "    l += It()",
      "except KeyboardInterrupt:",
      "    raise ValueError('%d %d' % (len(l), It.fetched))",
    ].join("\n"),
    300,
  );
  const m = /^ValueError: (\d+) (\d+)$/.exec(last);
  assert.ok(m, last);
  assert.ok(Number(m![1]) > 1024, last);
  assert.equal(m![1], m![2]);
});

test("Stop interrupts a numpy ufunc over a large array, contiguous or strided (HARD-343-1)", async () => {
  // (huge arguments take the slow correctly rounded reduction: 10**7 of them
  // run for seconds without Stop polls)
  const big = "import numpy as np\nx = np.full(10**7, 1e300)\n";
  assert.equal(await interruptAfter(big + "np.sin(x)", 300), "KeyboardInterrupt");
  assert.equal(await interruptAfter(big + "np.sin(x[::2])", 300), "KeyboardInterrupt");
  assert.equal(await interruptAfter(big + "np.sin(x.reshape(1000, -1).T)", 300), "KeyboardInterrupt");
});

// The PNG module (src/runtime/raster.ts) runs its WebAssembly without a look
// at the flag, and nothing after it may poll before the program goes on: a
// Stop during a render must raise KeyboardInterrupt at the render's return,
// not at some later loop (matlab's interrupt pilot 4, E13g).
test("Stop during a PNG render raises KeyboardInterrupt from the render (E13g)", async () => {
  const polys = Array.from({ length: 80 }, (_, j) => `<polygon points="0,0 1000,${100 * (j % 10)} 1000,1000 ${143 * (j % 7)},1000" fill="blue" fill-opacity="0.02"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">${polys}</svg>`;
  const render = `import _sbraster\npng, missing = _sbraster.render(${JSON.stringify(svg)}, 1.0, 0, 0, "", 100.0, [])\nraise ValueError("the render returned")`;
  // (mid-render, in time)
  assert.equal(await interruptAfter(render, 300, 30000), "KeyboardInterrupt");
  // (a request already there when it starts: nothing polls before it, so
  // only the render's own return can raise)
  const tiny = `import _sbraster\n_sbraster.render('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', 1.0, 0, 0, "", 100.0, [])\nraise ValueError("the render returned")`;
  assert.equal(await interruptAfter(tiny, null), "KeyboardInterrupt");
  // (decode too: a 1 x 1 gray PNG, made here)
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 128]))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("hex");
  const decode = `import _sbraster\nw, h, ch, raw = _sbraster.decode(bytes.fromhex("${png}"))\nraise ValueError("the decode returned %d %d %d" % (w, h, ch))`;
  assert.equal(await interruptAfter(decode, 30000, 0), "ValueError: the decode returned 1 1 1");
  assert.equal(await interruptAfter(decode, null), "KeyboardInterrupt");
});
