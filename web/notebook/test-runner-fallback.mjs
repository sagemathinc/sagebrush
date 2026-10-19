// The runner's fallback (web/notebook/runner-worker.js) never runs by itself
// what was waiting for the runner (astra's CORR-CAP-4): a run or a question
// sent before the sandboxed runner was given up (it didn't answer in time,
// its frame failed, or its interpreter said nothing) is answered as not run,
// saying so, and never posted to the plain worker; what isn't code (files)
// is given to it; what is asked after that, as the person runs it again,
// runs there.  Through WorkerKernel too: the run's sink is told, nothing
// waits for good.
//   bun web/notebook/test-runner-fallback.mjs
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };

// (a page as RunnerWorker sees it: a frame that never loads, timers fired by hand)
let ch, timers = [];
globalThis.MessageChannel = class { constructor() { ch = this; this.port1 = { close() {}, postMessage: (m) => this.port1.sent.push(m), sent: [] }; this.port2 = {}; } };
globalThis.location = { href: "https://sagebrush.test/" };
globalThis.fetch = async () => ({ ok: true, text: async () => "" });
globalThis.document = { createElement: () => ({ setAttribute() {}, style: {}, addEventListener() {}, remove() {} }), body: { appendChild() {}, append() {} } };
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
globalThis.setTimeout = (f, ms) => { const t = { f, ms, on: true }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { if (t && typeof t === "object") t.on = false; };
const fire = (ms) => { for (const t of timers.splice(0)) if (t.on && (ms === undefined || t.ms === ms)) t.f(); else timers.push(t); };

const { RunnerWorker, NOT_RUN } = await import("./runner-worker.js");

/** A RunnerWorker with a fallback whose worker records what it is given. */
function make() {
  timers = [];
  const plain = [];
  let made = 0;
  const w = new RunnerWorker("runner/", { fallback: () => { made++; return { postMessage: (m) => plain.push(m), terminate() {} }; } });
  const said = [];
  w.onmessage = (e) => said.push(e.data);
  return { w, plain, said, port: ch.port1, made: () => made };
}
const run = (id, code = "print('RAN')") => ({ id, code, sage: false, magma: false, matlab: false });
const notRun = (said, id) => said.some((d) => d.id === id && d.stream === "stderr" && d.text === NOT_RUN) && said.some((d) => d.id === id && d.done && d.error);

// 1. the frame never answers (offline, say): given up after its timeout; the run queued before isn't run
{
  const t = make();
  t.w.postMessage({ files: [["/data.csv", "x"]] });
  t.w.postMessage(run(1));
  t.w.postMessage({ id: 2, complete: "pri" });
  fire(10000);
  check(t.made() === 1, "the frame not answering: a fallback made");
  check(!t.plain.some((m) => m.id !== undefined), "…no run or question queued before is posted to it");
  check(t.plain.some((m) => m.files), "…what isn't code (files) given to it");
  check(notRun(t.said, 1), "…the queued run answered as not run, saying why");
  check(t.said.some((d) => d.id === 2 && d.skipped), "…the queued question answered as skipped");
  t.w.postMessage(run(3));
  check(t.plain.some((m) => m.id === 3 && m.code), "…a run asked for after that, as the person runs it again, runs in it");
}

// 2. the frame says its interpreter failed (an error before it said anything), a run queued after it answered
{
  const t = make();
  t.port.onmessage({ data: { runnerReady: 1 } });
  t.w.postMessage(run(1));
  check(t.port.sent.some((m) => m.id === 1), "(the run sent to the runner, kept for a fallback until it answers)");
  t.port.onmessage({ data: { runnerError: "the worker could not start" } });
  check(t.made() === 1 && !t.plain.some((m) => m.id !== undefined), "an error from the runner after a run was queued: the fallback runs nothing by itself");
  check(notRun(t.said, 1), "…the run answered as not run");
}

// 3. the runner answered, but its interpreter says nothing once it has a run (WebKit): the watchdog gives it up
{
  const t = make();
  t.port.onmessage({ data: { runnerReady: 1 } });
  t.w.postMessage(run(1));
  fire(8000);
  check(t.made() === 1 && !t.plain.some((m) => m.id !== undefined), "the runner's interpreter silent after a run was queued: the fallback runs nothing by itself");
  check(notRun(t.said, 1), "…the run answered as not run");
}

// 4. the runner's interpreter answered: nothing is held for a fallback, and none is made
{
  const t = make();
  t.port.onmessage({ data: { runnerReady: 1 } });
  t.w.postMessage(run(1));
  t.port.onmessage({ data: { ready: true } });
  fire();
  check(t.made() === 0, "a runner that answered: never given up");
}

// 5. through WorkerKernel: the run's sink is told it wasn't run, and is done (nothing waits for good)
{
  const { WorkerKernel } = await import("./worker-kernel.js");
  let t;
  const k = new WorkerKernel({ createWorker: () => (t = make()).w });
  k.start?.();
  const out = [];
  let done = null;
  k.execute("print('RAN')", { mode: "python" }, { out: (s, err) => out.push([s, err]), display() {}, interact() {}, clear() {}, start() {}, done: (ms, r) => (done = r), stopped: (s) => (done = { stopped: s }) });
  fire(10000);
  await new Promise((r) => realSet(r, 0));
  check(t && !t.plain.some((m) => m.code), "WorkerKernel: the run queued before the runner was given up isn't posted to the fallback");
  check(out.some(([s, err]) => err && s === NOT_RUN), "…its output says it wasn't run, and why");
  check(done?.error === true, "…and it is done, as failed: " + JSON.stringify(done));
}

globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
if (fails.length) {
  console.error(`FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  "));
  process.exit(1);
}
console.log(`ok: the runner's fallback runs nothing by itself, ${checks} checks`);
