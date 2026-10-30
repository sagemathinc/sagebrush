import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// input()'s answers name their question: a run's request key (web/worker.ts's
// stdin), which the page's kernel (web/notebook/worker-kernel.js) sends back
// and the runner's frame (web/runner/index.html) checks.  An answer to a
// question that is over (its run asked another, a Stop came, the run ended)
// writes nothing, nor does one naming a question never asked.
const ROOT = join(__dirname, "..", "..");

// ---- the page's kernel, for real (an ES module, copied to .mjs for node)
async function kernel() {
  const copy = join(mkdtempSync(join(tmpdir(), "sb-input-")), "worker-kernel.mjs");
  copyFileSync(join(ROOT, "web/notebook/worker-kernel.js"), copy);
  const { WorkerKernel } = await new Function("u", "return import(u)")(pathToFileURL(copy).href);
  const sent: any[] = [];
  const worker: any = { postMessage: (m: any) => sent.push(m), terminate() {} };
  const k = new WorkerKernel({ createWorker: () => worker });
  k.start();
  const asked: { prompt: string; reply: any; retired: boolean }[] = [];
  const sink = {
    out() {}, display() {}, interact() {}, clear() {}, done() {}, stopped() {},
    input(prompt: string, reply: any) {
      const q = { prompt, reply, retired: false };
      reply.onretire = () => (q.retired = true);
      asked.push(q);
    },
  };
  k.pending.set(1, sink);
  // (the worker's messages; buffer null: the runner's frame keeps it)
  const ask = (key: string, prompt = key, id = 1) => worker.onmessage({ data: { id, input: { prompt, max: 1 << 16, key }, buffer: null } });
  const answers = () => sent.filter((m) => "runnerInput" in m);
  return { k, worker, asked, ask, answers };
}

test("kernel: a run's second question retires the first; the first's reply sends nothing, the second's names its key", async () => {
  const { asked, ask, answers } = await kernel();
  ask("t.1", "first: ");
  ask("t.2", "second: ");
  assert.equal(asked.length, 2);
  assert.equal(asked[0].retired, true, "the first field is removed");
  assert.equal(asked[1].retired, false);
  asked[0].reply("stale answer");
  assert.deepEqual(answers(), []);
  asked[1].reply("Ada");
  asked[1].reply("again");
  assert.deepEqual(answers(), [{ runnerInput: 1, key: "t.2", text: "Ada" }]);
});

test("kernel: a Stop retires the open question; after a caught KeyboardInterrupt the old reply can't answer the new one", async () => {
  const { k, asked, ask, answers } = await kernel();
  const flag = new Int32Array(new SharedArrayBuffer(8));
  k.interruptFlag = flag;
  ask("t.1", "first: ");
  k.interrupt();
  assert.equal(Atomics.load(flag, 0) & 1, 1);
  assert.equal(asked[0].retired, true, "Stop removes the field at once");
  ask("t.2", "second: ");
  asked[0].reply("typed into the old field");
  assert.deepEqual(answers(), []);
  asked[1].reply(null);
  assert.deepEqual(answers(), [{ runnerInput: 1, key: "t.2", text: null }]);
});

test("kernel: a run's end and a restart retire its open questions; another run's question stays", async () => {
  const { k, worker, asked, ask, answers } = await kernel();
  k.pending.set(2, k.pending.get(1));
  ask("t.1", "a", 1);
  ask("t.2", "b", 2);
  worker.onmessage({ data: { id: 1, done: true, ms: 1 } });
  assert.deepEqual(asked.map((q) => q.retired), [true, false]);
  asked[0].reply("x");
  assert.deepEqual(answers(), []);
  k.restart();
  assert.equal(asked[1].retired, true);
  asked[1].reply("y");
  assert.deepEqual(answers(), []);
});

// ---- the runner's frame: its script, run with stand-ins for the window,
// the page's port and the worker
function runner() {
  const html = readFileSync(join(ROOT, "web/runner/index.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  let onWindow: any;
  const parent = {};
  const toPage: any[] = [];
  const port: any = { postMessage: (m: any) => toPage.push(m), onmessage: null };
  let worker: any;
  class FakeWorker {
    onmessage: any = null;
    onerror: any = null;
    sent: any[] = [];
    constructor() { worker = this; }
    postMessage(m: any) { this.sent.push(m); }
  }
  const URLs = { createObjectURL: () => "blob:x" };
  new Function("addEventListener", "parent", "URL", "Blob", "Worker", script)((t: string, f: any) => t === "message" && (onWindow = f), parent, URLs, class {}, FakeWorker);
  onWindow({ source: parent, data: { sagebrushRunner: 1, script: "", base: "/" }, ports: [port] });
  assert.ok(worker, "the runner started its worker");
  const buffer = () => new SharedArrayBuffer(8 + 64);
  const state = (b: SharedArrayBuffer) => Atomics.load(new Int32Array(b, 0, 2), 0);
  const text = (b: SharedArrayBuffer) => new TextDecoder().decode(new Uint8Array(b, 8, Atomics.load(new Int32Array(b, 0, 2), 1)).slice());
  const ask = (id: number, key: string, b: SharedArrayBuffer) => worker.onmessage({ data: { id, input: { prompt: "?", max: 64, key }, buffer: b } });
  const page = (d: any) => port.onmessage({ data: d });
  return { worker, toPage, buffer, state, text, ask, page };
}

test("runner: the answer is written to the request it names, once; a duplicate first answer after a second question writes nothing", () => {
  const r = runner();
  const a = r.buffer(), b = r.buffer();
  r.ask(7, "w1.1", a);
  assert.equal(r.toPage.at(-1).buffer, null, "the buffer stays in the frame");
  assert.equal(r.toPage.at(-1).input.key, "w1.1");
  r.ask(7, "w1.2", b);
  r.page({ runnerInput: 7, key: "w1.1", text: "duplicate" });
  assert.equal(r.state(a), 0);
  assert.equal(r.state(b), 0, "the second question is still unanswered");
  r.page({ runnerInput: 7, key: "w1.2", text: "Ada" });
  assert.equal(r.state(b), 1);
  assert.equal(r.text(b), "Ada");
  r.page({ runnerInput: 7, key: "w1.2", text: "again" });
  assert.equal(r.text(b), "Ada");
});

test("runner: after a Stop the old question's answer can't fill the next one; wrong run, unknown, missing or old-worker keys write nothing", () => {
  const r = runner();
  const a = r.buffer(), b = r.buffer();
  r.ask(3, "w1.1", a);
  r.page({ runnerInterrupt: 3 });
  r.ask(3, "w1.2", b);
  r.page({ runnerInput: 3, key: "w1.1", text: "typed before the Stop" });
  assert.equal(r.state(a), 0);
  assert.equal(r.state(b), 0);
  r.page({ runnerInput: 4, key: "w1.2", text: "another run" });
  r.page({ runnerInput: 3, key: "w0.2", text: "a previous worker's" });
  r.page({ runnerInput: 3, text: "no key" });
  r.page({ runnerInput: 3, key: "w1.9", text: "never asked" });
  assert.equal(r.state(b), 0);
  r.page({ runnerInput: 3, key: "w1.2", text: null });
  assert.equal(r.state(b), 2, "end of input");
});

test("runner: a run's end lets its question go: a late answer writes nothing", () => {
  const r = runner();
  const a = r.buffer();
  r.ask(5, "w1.1", a);
  r.worker.onmessage({ data: { id: 5, done: true } });
  r.page({ runnerInput: 5, key: "w1.1", text: "late" });
  assert.equal(r.state(a), 0);
});
