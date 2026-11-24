// A change a run waits on (web/worker.ts fsAsk) reaches the page only as a request of the run in flight in the current
// worker (WorkerKernel.takeAsk, the write-wait design's SEC review of #1584): the kernel, with a stand-in worker,
// shown each request it must answer no at once without the page seeing it (no run, a run stopped before the request
// arrived, a run over, a wrong or old worker, a duplicate key, a bad field), and one it admits retired, answered no and
// its prompt told, at a Stop, the run's end or a new interpreter; an answer after that writes nothing.
//   bun web/test-ask-binding.mjs
// ci: web-runner order=374 runner=bun
import { WorkerKernel } from "./notebook/worker-kernel.js";

let failures = 0, count = 0;
const ok = (c, msg) => { count++; console.log((c ? "ok   " : "FAIL ") + msg); if (!c) failures++; };
const workers = [];
const seen = [];
const retired = [];
const k = new WorkerKernel({
  createWorker: () => {
    const w = { posted: [], postMessage(m) { this.posted.push(m); }, terminate() { this.dead = true; } };
    workers.push(w);
    return w;
  },
  onMessage: (m) => { if (m.fsAsk !== undefined) { seen.push(m.fsAsk.key); return true; } return false; },
});
k.on("ask-retired", (key) => retired.push(key));
k.start();
k.epochWord = new Int32Array(new SharedArrayBuffer(4));
k.interruptFlag = new Int32Array(new SharedArrayBuffer(8));
const tick = () => new Promise((r) => setTimeout(r, 0));
const deliver = (w, data) => w.onmessage({ data });
let n = 0;
const ask = (id, extra = {}) => {
  const buffer = new SharedArrayBuffer(8 + 1024);
  return { data: { fsAsk: { key: `t.${++n}`, id, path: "/a/x.txt", what: "write", epoch: 1, ...extra }, buffer }, buffer };
};
const state = (b) => Atomics.load(new Int32Array(b, 0, 2), 0); // 0 waiting, 1 an answer, 2 no
const text = (b) => new TextDecoder().decode(new Uint8Array(b, 8, Atomics.load(new Int32Array(b, 0, 2), 1)).slice());
const run = () => { const sink = { out() {}, display() {}, interact() {}, clear() {}, done() {}, stopped() {}, start() {} }; k.execute("pass", { mode: "python" }, sink); return k.nextId - 1; };
const policy = { epoch: 2, state: "scoped", trees: ["/a"] };

// 1. nothing running: answered no, the page never sees it
{
  const a = ask(1);
  deliver(workers[0], a.data);
  ok(state(a.buffer) === 2 && !seen.includes(a.data.fsAsk.key), "1. no run in flight: answered no at once, the page not asked");
}
// 2. a run in flight, but a field wrong: answered no, unseen
{
  const id = run();
  const bad = [{ epoch: undefined }, { epoch: 0 }, { epoch: -1 }, { epoch: "1" }, { epoch: 2 ** 31 }, { id: undefined }, { id: "1" }, { key: 7 }, { key: "x".repeat(65) }, { path: 3 }, { what: {} }];
  const res = bad.map((x) => { const a = ask(id, x); deliver(workers[0], a.data); return state(a.buffer) === 2 && !seen.includes(a.data.fsAsk.key); });
  ok(res.every(Boolean), "2. an ask of the run in flight with a missing, 0, -1, string or too large epoch, a bad id, key, path or operation: each answered no, unseen: " + JSON.stringify(res));
  // 3. a run that isn't in flight (another id): no
  const w = ask(id + 50);
  deliver(workers[0], w.data);
  ok(state(w.buffer) === 2 && !seen.includes(w.data.fsAsk.key), "3. an ask naming a run that isn't in flight: answered no, unseen");
  // 4. the run's own: admitted; live; its answer written once, with the policy
  const a = ask(id);
  deliver(workers[0], a.data);
  ok(seen.includes(a.data.fsAsk.key) && state(a.buffer) === 0 && k.askLive(a.data), "4. the run's own ask: the page asked, it waits, and it is live");
  // 5. a second while that one is open: no
  const b = ask(id);
  deliver(workers[0], b.data);
  ok(state(b.buffer) === 2 && !seen.includes(b.data.fsAsk.key), "5. a second ask while one is open: answered no, unseen");
  k.answerAsk(a.data, workers[0], policy);
  ok(state(a.buffer) === 1 && JSON.parse(text(a.buffer)).policy.epoch === 2 && Atomics.load(k.epochWord, 0) === 2 && !k.askLive(a.data), "...answered with the policy, its epoch stored first; no longer live");
  // 6. the same key again: no (answered once)
  const again = { data: { ...a.data, buffer: new SharedArrayBuffer(1032) } };
  again.buffer = again.data.buffer;
  deliver(workers[0], again.data);
  ok(state(again.buffer) === 2, "6. the same key asked again: answered no");
  // 7. the run's end retires an open ask: answered no, its prompt told, a later Allow writes nothing
  const c = ask(id);
  deliver(workers[0], c.data);
  deliver(workers[0], { id, done: true, ms: 1 });
  ok(state(c.buffer) === 2 && retired.includes(c.data.fsAsk.key) && !k.askLive(c.data), "7. the run ends while its ask is open: retired, answered no, its prompt told");
  k.answerAsk(c.data, workers[0], { ...policy, epoch: 3 });
  ok(state(c.buffer) === 2 && Atomics.load(k.epochWord, 0) === 2, "...an Allow after that writes nothing, stores no epoch");
}
// 8. a Stop while an ask is open: retired, no; the answer after it writes nothing
{
  const id = run();
  const a = ask(id);
  deliver(workers[0], a.data);
  k.interrupt();
  ok(state(a.buffer) === 2 && retired.includes(a.data.fsAsk.key) && !k.askLive(a.data), "8. a Stop while the ask is open: retired, answered no");
  k.answerAsk(a.data, workers[0], { ...policy, epoch: 4 });
  ok(state(a.buffer) === 2 && Atomics.load(k.epochWord, 0) === 2, "...an Allow after the Stop writes nothing");
  // (the same run, after its KeyboardInterrupt is caught, asking again: no)
  const b = ask(id);
  deliver(workers[0], b.data);
  ok(state(b.buffer) === 2 && !seen.includes(b.data.fsAsk.key), "...the stopped run asking again: answered no, unseen");
  deliver(workers[0], { id, done: true, ms: 1, error: "KeyboardInterrupt" });
}
// 9. held delivery: the ask posted, held behind a hold (holdMessages), a Stop, then the hold lets go: no
{
  const id = run();
  let release;
  k.holdMessages(new Promise((r) => (release = r)));
  const a = ask(id);
  deliver(workers[0], a.data);
  await tick();
  k.interrupt();
  release();
  await tick(); await tick(); await tick();
  ok(state(a.buffer) === 2 && !seen.includes(a.data.fsAsk.key), "9. an ask held in delivery, a Stop before it arrives: answered no, the page never asked");
  deliver(workers[0], { id, done: true, ms: 1 });
  await tick(); await tick();
}
// 10. a new run, held delivery of its ask, the run over before it arrives: no
{
  const id = run();
  let release;
  k.holdMessages(new Promise((r) => (release = r)));
  deliver(workers[0], { id, done: true, ms: 1 });
  const a = ask(id);
  deliver(workers[0], a.data);
  release();
  await tick(); await tick(); await tick();
  ok(state(a.buffer) === 2 && !seen.includes(a.data.fsAsk.key), "10. an ask arriving after its run is over: answered no, unseen");
}
// 11. a new interpreter retires the open ask; the old worker's later ask: no
{
  const id = run();
  const a = ask(id);
  deliver(workers[0], a.data);
  const old = workers[0];
  k.restart();
  ok(state(a.buffer) === 2 && retired.includes(a.data.fsAsk.key) && !k.askLive(a.data), "11. a new interpreter: the open ask retired, answered no");
  const id2 = run();
  const b = ask(id2);
  deliver(old, b.data);
  ok(state(b.buffer) === 2 && !seen.includes(b.data.fsAsk.key), "...the old worker's ask, naming the new run: answered no, unseen");
  const c = ask(id2);
  deliver(workers[1], c.data);
  ok(seen.includes(c.data.fsAsk.key) && k.askLive(c.data), "...the new worker's own, for its run: admitted");
  k.answerAsk(c.data, old, policy);
  ok(state(c.buffer) === 0 && k.askLive(c.data), "...an answer naming the old worker writes nothing; still live");
}
console.log(`${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
