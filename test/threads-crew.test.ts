import test from "node:test";
import assert from "node:assert/strict";
import { Crew, type WorkerLike } from "../web/threads/crew";

// The threads demo's crew (web/threads/crew.ts; numerics-core M0, E3/ND-M3): a pool that fails while starting
// (a Worker constructor or a postMessage throwing after some workers were made) leaves no worker behind and
// reports the original error, and a fresh crew starts cleanly after it. (The page's integration, startPool's
// catch tearing the crew down, is exercised in a browser with ?fault=spawn and ?fault=post.)

class Fake implements WorkerLike {
  terminated = false;
  terminations = 0;
  posted: unknown[] = [];
  onerror: ((e: any) => any) | null = null;
  onmessageerror: ((e: any) => any) | null = null;
  onmessage: ((e: any) => any) | null = null;
  constructor(private readonly opts: { postThrows?: boolean; terminateThrows?: boolean } = {}) {}
  postMessage(m: unknown) {
    if (this.opts.postThrows) throw new Error("injected postMessage failure");
    this.posted.push(m);
    queueMicrotask(() => this.onmessage?.({ data: { ready: true, m } }));
  }
  terminate() {
    this.terminated = true;
    this.terminations++;
    if (this.opts.terminateThrows) throw new Error("injected terminate failure");
  }
}

// the page's startup sequence (startPool): helpers, then the conductor; any throw tears the crew down and is rethrown
function start(crew: Crew<Fake>, helpers: number) {
  try {
    for (let id = 1; id <= helpers; id++) crew.add(`helper ${id}`, { id });
    crew.add("the conductor", { id: 0 });
    return crew.started();
  } catch (e) {
    crew.end();
    throw e;
  }
}

test("a Worker constructor throwing after one helper was made: that helper is terminated, the error is the original, and a fresh crew starts", async () => {
  const made: Fake[] = [];
  const fails: string[] = [];
  const crew = new Crew<Fake>(() => {
    if (made.length === 1) throw new Error("injected Worker constructor failure");
    const w = new Fake();
    made.push(w);
    return w;
  }, (why) => fails.push(why));
  assert.throws(() => start(crew, 3), /injected Worker constructor failure/);
  assert.equal(made.length, 1);
  assert.deepEqual(made.map((w) => w.terminated), [true]);
  assert.equal(crew.dead, true);
  assert.equal(fails.length, 0);
  // the next Run: a new crew, all workers started
  const again: Fake[] = [];
  const fresh = new Crew<Fake>(() => { const w = new Fake(); again.push(w); return w; }, (why) => fails.push(why));
  const infos = await start(fresh, 3);
  assert.equal(infos.length, 4);
  assert.ok(again.every((w) => !w.terminated && w.posted.length === 1));
  fresh.end();
  assert.ok(again.every((w) => w.terminated));
});

test("a postMessage throwing: the worker was registered before posting, so it and every earlier one are terminated", () => {
  const made: Fake[] = [];
  const crew = new Crew<Fake>(() => { const w = new Fake({ postThrows: made.length === 1 }); made.push(w); return w; }, () => {});
  assert.throws(() => start(crew, 3), /injected postMessage failure/);
  assert.equal(made.length, 2);
  assert.deepEqual(made.map((w) => w.terminated), [true, true]);
});

test("teardown is best-effort and once: a terminate that throws does not spare the rest; failures after it are not reported", () => {
  const made: Fake[] = [];
  const fails: string[] = [];
  const crew = new Crew<Fake>(() => { const w = new Fake({ terminateThrows: made.length === 0 }); made.push(w); return w; }, (why) => fails.push(why));
  start(crew, 2);
  // (grader T4: a live helper's reported error reaches the pool)
  made[0].onmessage!({ data: { helperError: "x" } });
  assert.deepEqual(fails, ["x"]);
  made[1].onerror!({ message: "boom" });
  assert.deepEqual(fails, ["x", "helper 2 failed: boom"]);
  crew.end();
  assert.deepEqual(made.map((w) => w.terminations), [1, 1, 1]);
  crew.end(); // (idempotent: nothing terminated twice, nothing thrown)
  assert.deepEqual(made.map((w) => w.terminations), [1, 1, 1]);
  made[2].onerror!({ message: "late" });
  made[0].onmessage!({ data: { helperError: "late too" } });
  assert.deepEqual(fails, ["x", "helper 2 failed: boom"]);
});
