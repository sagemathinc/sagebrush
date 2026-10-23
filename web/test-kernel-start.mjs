// The kernel's start barrier (web/notebook/worker-kernel.js; astra's
// CORR-PR68-3): nothing reaches a worker, no run, interact, question or check,
// until its onStart is done (the page's: the notebook's package set resolved
// and durably pinned, then sent); they go in the order asked.  A start that
// fails stops what waits, and the next run starts a new worker; nothing runs
// in the one whose start failed.  With a fake worker, no browser.
//   node web/test-kernel-start.mjs
import { readFileSync } from "node:fs";

// (an ES module in a CommonJS package: loaded from its text)
const source = readFileSync(new URL("./notebook/worker-kernel.js", import.meta.url), "utf8");
const { WorkerKernel } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const sink = (log, name) => ({ start() {}, out() {}, display() {}, interact() {}, clear() {}, done: () => log.push(`${name}:done`), stopped: (m) => log.push(`${name}:stopped:${m.trim()}`) });

// a held start: everything waits for it, then goes in order, after what onStart sent
{
  const sent = [], log = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const workers = [];
  const k = new WorkerKernel({
    createWorker: () => {
      const w = { n: workers.length, postMessage: (m) => sent.push({ w: w.n, ...m }), terminate() {} };
      workers.push(w);
      return w;
    },
    onStart: async (w) => {
      await gate;
      w.postMessage({ pkgset: "S" });
    },
  });
  k.on("execute", () => log.push("execute"));
  k.start();
  k.execute("a = 1", { mode: "python" }, sink(log, "a"));
  k.interact(7, { x: 1 }, sink(log, "i"));
  const asked = k.ask({ complete: "a" }, "python", "none");
  k.execute("b = 2", { mode: "python" }, sink(log, "b"));
  await tick();
  ok(sent.length === 0, `while the start is held nothing is sent to the worker (${JSON.stringify(sent)})`);
  release();
  await k.started;
  await tick();
  ok(JSON.stringify(sent.map((m) => (m.pkgset ? "pkgset" : m.interact ? "interact" : m.complete ? "ask" : m.code))) === JSON.stringify(["pkgset", "a = 1", "interact", "ask", "b = 2"]), `then the package set first, and the rest in the order asked (${JSON.stringify(sent)})`);
  ok(sent.every((m) => m.w === 0), "all to the one worker");
  void asked;
}

// a failed start: what waits is stopped; the next run starts a new worker
{
  const sent = [], log = [];
  let fail = true, made = 0;
  const k = new WorkerKernel({
    createWorker: () => {
      const n = made++;
      return { postMessage: (m) => sent.push({ w: n, ...m }), terminate: () => log.push(`terminate:${n}`) };
    },
    onStart: async (w) => {
      await tick();
      if (fail) throw new Error("its notebook was left before its package set was pinned");
      w.postMessage({ pkgset: "S" });
    },
  });
  const statuses = [];
  k.on("status", (s) => statuses.push(s));
  k.start();
  k.execute("a = 1", { mode: "python" }, sink(log, "a"));
  const checked = k.evaluate("answer == 1", 1, "python", 1000);
  await k.started;
  await tick();
  ok(sent.length === 0, `a start that fails sends nothing to its worker (${JSON.stringify(sent)})`);
  ok(log.some((l) => l.startsWith("a:stopped:The interpreter did not start: its notebook was left")), `the waiting run is stopped, saying why (${JSON.stringify(log)})`);
  ok((await checked).ok === false, "the waiting check is answered, not left waiting");
  ok(statuses.some((s) => s.includes("did not start")), "the status says so");
  fail = false;
  k.execute("b = 2", { mode: "python" }, sink(log, "b"));
  await k.started;
  await tick();
  ok(log.includes("terminate:0") && sent.length === 2 && sent.every((m) => m.w === 1) && sent[0].pkgset === "S" && sent[1].code === "b = 2", `the next run starts a new worker, its package set before its code (${JSON.stringify(sent)})`);
}

// a restart while a start is held: what was asked of the old worker never reaches either
{
  const sent = [], log = [];
  let release, made = 0;
  const k = new WorkerKernel({
    createWorker: () => {
      const n = made++;
      return { postMessage: (m) => sent.push({ w: n, ...m }), terminate() {} };
    },
    onStart: async (w) => {
      if (made === 1) await new Promise((r) => (release = r));
      w.postMessage({ pkgset: "S" });
    },
  });
  k.start();
  k.execute("old = 1", { mode: "python" }, sink(log, "old"));
  await tick();
  k.restart();
  release();
  await tick();
  await tick();
  ok(!sent.some((m) => m.code === "old = 1"), `a run asked of a worker restarted before its start was done never runs (${JSON.stringify(sent)})`);
  ok(log.some((l) => l.startsWith("old:stopped")), "it is told it stopped");
}
