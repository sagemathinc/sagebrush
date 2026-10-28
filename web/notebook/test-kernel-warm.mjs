// X1 (design r3): WorkerKernel's per-language state, with a fake worker
// that answers when told.  One warm-up per language and interpreter while
// it is pending or ready, whatever the number of triggers; the next trigger
// tries again after an interrupted, failed or lost one, never on its own;
// an old interpreter's late answer changes nothing; a run's start isn't
// readiness; a warm-up is never a run (no journal events).
//   bun web/notebook/test-kernel-warm.mjs
import { WorkerKernel } from "./worker-kernel.js";

let fails = 0;
const check = (ok, what) => { console.log((ok ? "ok   " : "FAIL ") + what); if (!ok) fails++; };

const workers = [];
const make = () => {
  const w = { sent: [], postMessage(m) { this.sent.push(m); }, terminate() { this.dead = true; }, onmessage: null, onerror: null };
  workers.push(w);
  return w;
};
const answer = (w, m) => w.onmessage({ data: m });
const warms = (w) => w.sent.filter((m) => m.warm);

const k = new WorkerKernel({ createWorker: make });
const events = [];
k.on("execute", (r) => events.push(["execute", r]));
k.on("run", (r) => events.push(["run", r]));
k.start();
let w = workers.at(-1);

// 1. a storm of triggers while the first warm-up is pending: one warm-up
const first = k.warm("sage");
for (let i = 0; i < 50; i++) k.warm("sage");
check(warms(w).length === 1, `50 triggers while pending: one warm-up sent (${warms(w).length})`);
check(k.warm("python") instanceof Promise && warms(w).length === 1, "Python: nothing sent");
const wid = warms(w)[0].id;
answer(w, { id: wid, warmed: "sage", ms: 5, mode: "sage", modeReady: true });
check((await first)?.warmed === "sage", "its answer resolves the warm-up");
check(k.modeState.get("sage")?.state === "ready", "ready after a warmed answer");
k.warm("sage");
check(warms(w).length === 1, "ready: no more warm-ups");
check(events.length === 0, "no journal events for a warm-up: " + JSON.stringify(events));

// 2. an interrupted, a failed and a lost (restart) warm-up: the next trigger tries once, nothing tries by itself
for (const [what, mode, reply] of [["interrupted", "magma", { warmed: null, interrupted: true, modeReady: false }], ["failed", "matlab", { warmed: null, error: "the matlab environment didn't load: x", modeReady: false }]]) {
  const before = warms(w).length;
  const p = k.warm(mode);
  const id = warms(w).at(-1).id;
  answer(w, { id, mode, ...reply });
  await p;
  check(!k.modeState.has(mode), `${what}: the entry is gone`);
  await new Promise((r) => setTimeout(r, 20));
  check(warms(w).length === before + 1, `${what}: nothing sent by itself`);
  k.warm(mode);
  k.warm(mode);
  check(warms(w).length === before + 2, `${what}: the next trigger sends exactly one`);
  answer(w, { id: warms(w).at(-1).id, warmed: mode, mode, modeReady: true });
  check(k.modeState.get(mode)?.state === "ready", `${what}: ready after its retry`);
}

// 3. an old interpreter's late answer can't touch the new one's entry
k.restart();
w = workers.at(-1);
const pOld = k.warm("matlab");
const oldW = w, oldId = warms(oldW).at(-1).id;
k.restart();
w = workers.at(-1);
check(k.modeState.size === 0, "a new interpreter starts with no entries");
check((await pOld)?.warmed === null, "the old interpreter's pending warm-up answered null");
k.warm("matlab");
check(warms(w).length === 1, "the new interpreter's trigger sends its own warm-up");
const newEntry = k.modeState.get("matlab");
answer(oldW, { id: oldId, warmed: "matlab", mode: "matlab", modeReady: true }); // (late, from the old worker: not even routed)
check(k.modeState.get("matlab") === newEntry && newEntry.state === "pending", "the old interpreter's late answer changes nothing");
answer(w, { id: warms(w)[0].id, warmed: "matlab", mode: "matlab", modeReady: true });
check(newEntry.state === "ready", "the new interpreter's own answer settles it");

// 4. runs: the start isn't readiness; done settles the run's own entry, and never a newer one
const sink = () => ({ start() {}, out() {}, display() {}, interact() {}, clear() {}, done() {}, stopped() {}, skipped() {} });
k.warm("sage");
answer(w, { id: warms(w).at(-1).id, warmed: "sage", mode: "sage", modeReady: true });
k.execute("1", { mode: "sage" }, sink()); // (sage is ready: no new entry)
check(k.modeState.get("sage").state === "ready", "a run in a ready language leaves it ready");
k.restart();
w = workers.at(-1);
k.execute("1", { mode: "sage" }, sink());
const run = w.sent.find((m) => m.code === "1");
check(k.modeState.get("sage")?.state === "pending", "a run makes its language pending");
answer(w, { id: run.id, start: true });
check(k.modeState.get("sage").state === "pending", "its start isn't readiness");
answer(w, { id: run.id, done: true, ms: 1, error: true, mode: "sage", modeReady: true });
check(k.modeState.get("sage").state === "ready", "a run whose code failed after its load succeeded: ready (modeReady)");
k.restart();
w = workers.at(-1);
k.execute("2", { mode: "sage" }, sink());
const run2 = w.sent.find((m) => m.code === "2");
answer(w, { id: run2.id, skipped: true });
check(!k.modeState.has("sage"), "a skipped run clears its own pending entry");
k.warm("sage");
const e2 = k.modeState.get("sage");
check(e2?.state === "pending" && warms(w).length === 1, "the next trigger makes a new entry");

// 5. a complete with no entry makes one; a complete during a pending warm-up shares it
k.restart();
w = workers.at(-1);
const pc = k.ask({ complete: "graphs." }, "sage", {});
check(k.modeState.get("sage")?.state === "pending", "Tab in Sage with no entry: pending");
k.warm("sage");
check(warms(w).length === 0, "a warm-up while Tab's load is pending: none sent");
const comp = w.sent.find((m) => m.complete !== undefined);
answer(w, { id: comp.id, matches: ["graphs.PetersenGraph"], prefix: "graphs.", mode: "sage", modeReady: true });
check((await pc).matches.length === 1 && k.modeState.get("sage").state === "ready", "Tab's answer: ready");
check(events.filter(([e]) => e === "execute").length === 3, "the journal saw only the three runs");

k.close?.();
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
