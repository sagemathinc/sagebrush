import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { consumeCtrlC } from "../src/runtime/interrupt";

// INTR[0] is a word of named bits (src/runtime/interrupt.ts): bit 0 Ctrl-C,
// bit 1 a CLI frame request, bit 2 a soft stop, bit 3 an armed grading
// allowance (persistent).  Producers set their bit with Atomics.or and
// consumers clear their own with Atomics.and, so no one erases another's
// (plan-prompt-worker r3 §6).
const DIST = __dirname + "/..";
const ROOT = join(__dirname, "..", "..");

// (a census: nothing in the sources stores to the interrupt word)
test("no source stores to INTR[0]: producers or, consumers and (the census)", () => {
  // (the tracked sources only: a site build's copies, untracked, are not sources)
  const files = execFileSync("git", ["ls-files", "src", "packages/sagebrush/bin", "web"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|mts|cjs|mjs|js|html)$/.test(f) && !/(^|\/)test-[^/]*$|\.test\.[^/]*$/.test(f)); // (tests produce on purpose)
  assert.ok(files.length > 100, String(files.length));
  const text = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  // The word's names: the runtime's, and every alias an embedding binds to
  // the buffer it is handed (`x = new Int32Array(m.interrupt)`), found, not
  // listed, so a new alias cannot slip past.
  const names = new Set(["INTR", "R.INTR", "c.R.INTR"]);
  for (const t of text.values())
    for (const m of t.matchAll(/([\w$.]+)\s*=\s*[^;\n]*?new Int32Array\(\s*[\w$.]*\binterrupt\s*\)/g)) names.add(m[1]);
  for (const n of ["intr", "flag", "this.interruptFlag"]) assert.ok(names.has(n), `alias ${n} not found: ${[...names]}`);
  const esc = [...names].map((n) => n.replace(/[.$]/g, "\\$&")).join("|");
  const plain = new RegExp(`(?<![\\w$.])(?:${esc})\\[0\\]\\s*(?:=(?!=)|[-+*/%&|^]=|<<=|>>>?=)`);
  // Any atomic write of index 0 but or/and, whatever the receiver is called;
  // the other word-0 users are the fetch broker's channel, \`ctrl\`, and an
  // input() answer's state word, \`ctl\`, exactly these two receivers: ctl is a
  // view of the answer's own SharedArrayBuffer (web/worker.ts's stdin makes
  // one per question), never of the interrupt word, which an embedding binds
  // only through \`new Int32Array(...interrupt)\` (the aliases found above).
  const atomic = /Atomics\.(?:store|exchange|compareExchange|add|sub|xor)\(\s*([^,()]+?)\s*,\s*0\s*,/;
  const OTHER = new Set(["web/worker.ts ctrl", "web/runner/index.html ctrl", "web/notebook/worker-kernel.js ctl", "web/runner/index.html ctl"]);
  const bad: string[] = [];
  for (const [f, t] of text)
    t.split("\n").forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      const a = atomic.exec(line);
      if (plain.test(line) || (a && !OTHER.has(`${f} ${a[1]}`))) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  assert.deepEqual(bad, []);
});

// (the notebook page's producer, web/notebook/worker-kernel.js, for real: an
// ES module, copied to .mjs for node)
test("the notebook's Stop sets bit 0, keeps the others and word 1, and wakes a sleep", async () => {
  const copy = join(mkdtempSync(join(tmpdir(), "sb-intr-")), "worker-kernel.mjs");
  copyFileSync(join(ROOT, "web/notebook/worker-kernel.js"), copy);
  const { WorkerKernel } = await new Function("u", "return import(u)")(pathToFileURL(copy).href);
  const k = new WorkerKernel({ createWorker: () => null });
  const flag = new Int32Array(new SharedArrayBuffer(8));
  Atomics.store(flag, 0, 14);
  k.worker = { terminate() {}, postMessage() {} };
  k.interruptFlag = flag;
  k.pending.set(1, { stopped() {} });
  k.nextId = 2;
  // (a thread waiting on the word, as time.sleep does)
  const w = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    const f = new Int32Array(workerData);
    parentPort.postMessage("waiting");
    const t0 = Date.now();
    parentPort.postMessage({ r: Atomics.wait(f, 0, 14, 20000), ms: Date.now() - t0 });`,
    { eval: true, workerData: flag.buffer },
  );
  const woke: Promise<any> = new Promise((resolve) => w.on("message", (m) => m !== "waiting" && resolve(m)));
  await new Promise((r) => w.once("message", r));
  await new Promise((r) => setTimeout(r, 200));
  k.interrupt();
  k.pending.clear(); // (its run "stopped": the 2 s restart timer does nothing)
  assert.equal(Atomics.load(flag, 0), 15);
  assert.equal(Atomics.load(flag, 1), 1);
  const m = await woke;
  await w.terminate();
  assert.equal(m.r, "ok", JSON.stringify(m));
  assert.ok(m.ms < 5000, JSON.stringify(m));
  assert.equal(consumeCtrlC(flag), true);
  assert.equal(Atomics.load(flag, 0), 14);
});

// (an ordinary poll is one load: no read-modify-write while bit 0 is clear)
test("consumeCtrlC writes only when bit 0 is set", () => {
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const and = Atomics.and;
  let calls = 0;
  (Atomics as any).and = (...a: any[]) => (calls++, (and as any)(...a));
  try {
    Atomics.store(flag, 0, 14);
    assert.equal(consumeCtrlC(flag), false);
    assert.equal(consumeCtrlC(flag), false);
    assert.equal(calls, 0);
    assert.equal(Atomics.load(flag, 0), 14);
    Atomics.or(flag, 0, 1);
    assert.equal(consumeCtrlC(flag), true);
    assert.equal(calls, 1);
    assert.equal(Atomics.load(flag, 0), 14);
  } finally {
    (Atomics as any).and = and;
  }
});

// (a census: every producer of bit 0 wakes a time.sleep too.  A sleep waits
// on the word with Atomics.wait, which only a notify ends: a producer that
// or's bit 0 without one leaves the sleep to run out, PR #135.  So each
// Atomics.or of index 0 notifies the same word on its line or the next two,
// or goes through requestCtrlC, which does both)
test("every producer of Ctrl-C notifies the word (the census)", () => {
  const files = execFileSync("git", ["ls-files", "src", "packages/sagebrush/bin", "web"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(ts|mts|cjs|mjs|js|html)$/.test(f) && !/(^|\/)test-[^/]*$|\.test\.[^/]*$/.test(f));
  const producers: string[] = [], silent: string[] = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      const m = /Atomics\.or\(\s*([^,()]+?)\s*,\s*0\s*,/.exec(line);
      if (!m) return;
      const near = lines.slice(i, i + 3).join("\n");
      const who = m[1].replace(/[.$]/g, "\\$&");
      producers.push(`${f}:${i + 1}`);
      if (!new RegExp(`Atomics\\.notify\\(\\s*${who}\\s*,\\s*0\\s*[,)]`).test(near)) silent.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.ok(producers.length >= 3, producers.join(" "));
  assert.deepEqual(silent, []);
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
