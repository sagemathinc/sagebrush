import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { waitForLine } from "../src/stdin-wait";

// input()'s wait (src/stdin-wait.ts, used by web/worker.ts): a Stop wins over
// an answer, after every wake and just before the answer is taken
// (daybreak3's INPUT-DB3-1).

const MAX = 64;
const answer = (buffer: SharedArrayBuffer, text: string | null) => {
  const ctl = new Int32Array(buffer, 0, 2);
  if (text === null) Atomics.store(ctl, 0, 2);
  else {
    const b = new TextEncoder().encode(text);
    new Uint8Array(buffer, 8, b.length).set(b);
    Atomics.store(ctl, 1, b.length);
    Atomics.store(ctl, 0, 1);
  }
  Atomics.notify(ctl, 0);
};
const stop = (intr: Int32Array) => {
  Atomics.or(intr, 0, 1);
  Atomics.notify(intr, 0);
};
const fresh = () => ({ buffer: new SharedArrayBuffer(8 + MAX), intr: new Int32Array(new SharedArrayBuffer(8)) });

test("an answer: the line, or end of input", () => {
  let { buffer, intr } = fresh();
  answer(buffer, "héllo");
  assert.equal(waitForLine(buffer, intr, 5), "héllo");
  ({ buffer, intr } = fresh());
  answer(buffer, "");
  assert.equal(waitForLine(buffer, intr, 5), "");
  ({ buffer, intr } = fresh());
  answer(buffer, null);
  assert.equal(waitForLine(buffer, intr, 5), null);
});

test("a Stop with no answer ends the wait: interrupted", () => {
  const { buffer, intr } = fresh();
  stop(intr);
  assert.deepEqual(waitForLine(buffer, intr, 5), { interrupted: true });
});

test("Stop written first, the answer second, then the wait resumes: interrupted, never the line", () => {
  // (both landed during the wait: the state word says 'a line', and the loop's own check is past)
  for (const late of ["the line", null]) {
    const { buffer, intr } = fresh();
    stop(intr);
    answer(buffer, late);
    assert.deepEqual(waitForLine(buffer, intr, 5), { interrupted: true }, String(late));
  }
});

test("the same ordering across threads: a waiting worker woken by Stop then a late answer is interrupted", async () => {
  const { buffer, intr } = fresh();
  const ready = new Int32Array(new SharedArrayBuffer(4));
  // (the worker waits with a long slice, so it is asleep when both writes land, and wakes on the answer's notify)
  const w = new Worker(
    `const { workerData, parentPort } = require("node:worker_threads");
     const { waitForLine } = require(${JSON.stringify(require.resolve("../src/stdin-wait"))});
     Atomics.store(workerData.ready, 0, 1); Atomics.notify(workerData.ready, 0);
     parentPort.postMessage(waitForLine(workerData.buffer, workerData.intr, 60000));`,
    { eval: true, workerData: { buffer, intr, ready } },
  );
  const result = new Promise((r) => w.once("message", r));
  while (Atomics.load(ready, 0) === 0) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 50));
  // (Stop only sets the word, as the runner's frame does with no notify on ctl; then the late answer notifies ctl)
  Atomics.or(intr, 0, 1);
  answer(buffer, "the line");
  assert.deepEqual(await result, { interrupted: true });
  await w.terminate();
});
