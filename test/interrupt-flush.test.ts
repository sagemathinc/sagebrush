import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

// The page's flush request (bit 4 of the shared interrupt word, INTR_FLUSH):
// a compiled loop that sees it sends what was printed so far and goes on; a
// Ctrl-C (bit 0) is still a KeyboardInterrupt.  The program prints, then
// computes without printing; the request comes while it computes.
const DIST = __dirname + "/..";

type Run = { done: string; writes: { text: string; at: number }[]; ms: number; word: number };

// (bits: set in the interrupt word every `every` ms during the run, as the page does, or once before it starts if null)
function run(code: string, bits: number, every: number | null): Promise<Run> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const writes = [];
    let t0 = 0;
    // (what the runtime writes to fd 1, and when)
    const write = fs.writeSync;
    fs.writeSync = (fd, data, ...rest) => {
      if (fd === 1) { writes.push({ text: Buffer.isBuffer(data) || data instanceof Uint8Array ? Buffer.from(data).toString("utf8") : String(data), at: Date.now() - t0 }); return typeof data === "string" ? Buffer.byteLength(data) : data.length; }
      return write(fd, data, ...rest);
    };
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      // (lib on the path, as the CLI has it, for time)
      c.R.importModule("sys").path.push(c.libDir());
      if (workerData.every === null) Atomics.or(c.R.INTR, 0, workerData.bits);
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      t0 = Date.now();
      let done = "finished";
      try {
        c.execModule(workerData.code, "<test>", "__main__");
      } catch (e) {
        done = c.R.formatException(e).trim().split("\\n").pop();
      }
      const ms = Date.now() - t0;
      const word = Atomics.load(c.R.INTR, 0);
      Atomics.and(c.R.INTR, 0, 0);
      parentPort.postMessage({ done, writes, ms, word });
    });
    `,
    { eval: true, workerData: { dist: DIST, code, bits, every } },
  );
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setInterval> | undefined;
    w.on("message", (m) => {
      if (m.intr && every !== null) timer = setInterval(() => Atomics.or(new Int32Array(m.intr), 0, bits), every);
      if (m.done) (clearInterval(timer), w.terminate(), resolve(m));
    });
    w.on("error", reject);
  });
}

// ('start' goes out at once, the first write in a while; 'begin', right after it, waits in the buffer; then a
// silent loop, with nothing imported or called before it, so its first iteration is the first poll after 'begin')
const BUSY = "print('start')\nprint('begin')\ni = 0\nwhile i < 300000000:\n    i += 1\nprint('end')\n";
const written = (r: Run, s: string) => r.writes.find((w) => w.text.includes(s));

test("a flush request pending when a silent loop starts sends what was printed before it, and the loop goes on", async () => {
  const r = await run(BUSY, 16, null);
  assert.equal(r.done, "finished");
  const begin = written(r, "begin"), end = written(r, "end");
  assert.ok(begin && end && begin !== end && end.at - begin.at >= 100, "begin written before the loop's end: " + JSON.stringify(r.writes) + " in " + r.ms + " ms");
  assert.equal(r.word & 16, 0, "the request was consumed");
});

test("without a flush request, the loop's output waits (the control)", async () => {
  const r = await run(BUSY, 0, null);
  assert.equal(r.done, "finished");
  const begin = written(r, "begin"), end = written(r, "end");
  assert.ok(begin && begin === end, "begin written with end, after the loop: " + JSON.stringify(r.writes));
});

test("Ctrl-C with a flush request is still a KeyboardInterrupt", async () => {
  const r = await run(BUSY, 17, null);
  assert.equal(r.done, "KeyboardInterrupt");
  assert.equal(r.word & 17, 0, "both bits consumed");
});

// (the engine's long calls poll the same word through its interrupted() import, src/runtime/engine.ts; the call
// takes seconds, the request comes every 200 ms as the page sends it, and nothing between 'begin' and the call polls)
const ENGINE = "import json, _sbengine\ns = json.dumps({'fn': 'progress_selftest', 'depth': 1, 'steps': 40000000})\nprint('start')\nprint('begin')\n_sbengine.call(s)\nprint('end')\n";

test("a flush request during a long engine call sends what was printed before it", async () => {
  const r = await run(ENGINE, 16, 200);
  assert.equal(r.done, "finished");
  // (what the run prints after the call, within 100 ms of the call's last flush, waits for the program's end: not this test's)
  const begin = written(r, "begin");
  assert.ok(begin && !begin.text.includes("end") && r.ms - begin.at >= 500, "begin written while the call ran: " + JSON.stringify(r.writes) + " in " + r.ms + " ms");
});
