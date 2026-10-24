import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

// INTR[0] is a word of named bits (src/runtime/interrupt.ts): bit 0 Ctrl-C,
// bit 1 a CLI frame request, bit 2 a soft stop, bit 3 an armed grading
// allowance (persistent).  Producers set their bit with Atomics.or and
// consumers clear their own with Atomics.and, so no one erases another's
// (plan-prompt-worker r3 §6).
const DIST = __dirname + "/..";
const ROOT = join(__dirname, "..", "..");

// (a census: nothing in the sources stores to the interrupt word)
test("no source stores to INTR[0]: producers or, consumers and (the census)", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (!/^(dist|node_modules|vendor)$/.test(f)) walk(p); }
      else if (/\.(ts|mts|cjs|mjs|js|html)$/.test(f)) files.push(p);
    }
  };
  for (const d of ["src", "packages/sagebrush/bin", "web"]) walk(join(ROOT, d));
  const bad: string[] = [];
  const store = /\b(?:R\.)?(?:INTR|intr|s\.intr|flag)\[0\]\s*=(?!=)|Atomics\.store\(\s*(?:R\.)?(?:INTR|intr|s\.intr|flag)\s*,\s*0\s*,/;
  for (const f of new Set(files)) {
    if (/\/(dist|node_modules|vendor)\//.test(f) || /\/test-[^/]*$|\.test\.[^/]*$/.test(f)) continue; // (tests produce on purpose)
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (store.test(line) && !/^\s*\/\//.test(line)) bad.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

// (a worker running code with the word's other bits set first; Ctrl-C
// requested after `ms`, or never)
function run(code: string, preset: number, ms: number | null): Promise<{ done: string; word: number; seconds: number }> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      Atomics.or(c.R.INTR, 0, workerData.preset);
      parentPort.postMessage({ intr: c.R.INTR.buffer });
      const t0 = Date.now();
      let done;
      try {
        c.execModule(workerData.code, "<test>", "__main__");
        done = "finished";
      } catch (e) {
        done = c.R.formatException(e).trim().split("\\n").pop();
      }
      parentPort.postMessage({ done, word: Atomics.load(c.R.INTR, 0), seconds: (Date.now() - t0) / 1000 });
    });
    `,
    { eval: true, workerData: { dist: DIST, code, preset } },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (w.terminate(), resolve({ done: "hung", word: -1, seconds: -1 })), 60000);
    w.on("message", (m) => {
      if (m.intr && ms !== null) setTimeout(() => (Atomics.or(new Int32Array(m.intr), 0, 1), Atomics.notify(new Int32Array(m.intr), 0)), ms);
      if (m.done) (clearTimeout(timer), w.terminate(), resolve(m));
    });
    w.on("error", reject);
  });
}

for (const [name, bits] of [["a frame request (bit 1)", 2], ["a soft stop (bit 2)", 4], ["an armed allowance (bit 3)", 8], ["all three", 14]] as const) {
  test(`${name} set: loops, time.sleep and the engine run on, and a Ctrl-C consumes only bit 0`, async () => {
    // no Ctrl-C: nothing is interrupted, and the bits are left
    let r = await run("s = 0\nfor i in range(300000):\n    s += i\nimport time\ntime.sleep(0.3)\nfrom sage_all import *\nfactor(2**64 + 1)\n", bits, null);
    assert.equal(r.done, "finished", JSON.stringify(r));
    assert.equal(r.word, bits);
    assert.ok(r.seconds >= 0.3, JSON.stringify(r)); // (the sleep slept: no spin past it)
    // a Ctrl-C in a loop: KeyboardInterrupt, bit 0 consumed, the others left
    r = await run("while True:\n    pass\n", bits, 300);
    assert.equal(r.done, "KeyboardInterrupt");
    assert.equal(r.word, bits);
    // and in a sleep, at once
    r = await run("import time\ntime.sleep(30)\n", bits, 300);
    assert.equal(r.done, "KeyboardInterrupt");
    assert.equal(r.word, bits);
    assert.ok(r.seconds < 5, JSON.stringify(r));
  });
}
