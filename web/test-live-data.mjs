// ci: web-browser/notebook order=185
// Live data's page side (design-data-access r3.1, grader's bridge controls B1-B8): WorkerKernel's admission
// (web/notebook/worker-kernel.js) with LiveCalls (web/notebook/live-data.js) and a synthetic adapter that holds a
// canary reader key, against fake workers posting {liveData} messages as a compromised interpreter could; and the
// runner frame's forwarding (web/runner/index.html's script, run against a fake Worker and port).  No browser, no
// network.
//   node web/test-live-data.mjs
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./notebook/worker-kernel.js", import.meta.url), "utf8");
const { WorkerKernel } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
// (both ES modules in a CommonJS package, loaded from their text: src/live-data.ts with its types stripped)
const { stripTypeScriptTypes } = await import("node:module");
const dataUrl = (text) => "data:text/javascript;base64," + Buffer.from(text).toString("base64");
const shared = dataUrl(stripTypeScriptTypes(readFileSync(new URL("../src/live-data.ts", import.meta.url), "utf8")));
const calls = readFileSync(new URL("./notebook/live-data.js", import.meta.url), "utf8");
if (!calls.includes('from "../../src/live-data.ts"')) throw new Error("live-data.js's import of src/live-data.ts not found");
const { LiveCalls } = await import(dataUrl(calls.replace('from "../../src/live-data.ts"', `from "${shared}"`)));

const ok = (c, msg) => {
  console.log((c ? "ok   " : "FAIL ") + msg);
  if (!c) process.exitCode = 1;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const sink = () => ({ start() {}, out() {}, display() {}, interact() {}, clear() {}, done() {}, stopped() {} });
const KEY = "reader-canary-" + Math.random().toString(36).slice(2);
const BYTES = 8 + (8 << 20);
const answerOf = (buffer) => {
  const ctl = new Int32Array(buffer, 0, 2);
  if (Atomics.load(ctl, 0) === 0) return null;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, Atomics.load(ctl, 1)).slice()));
};

// The synthetic adapter: holds the key, records each fetch with what it sent upstream and whether it was aborted
function adapter(mode = { kind: "ok" }) {
  const a = { calls: [], mode };
  a.fetch = async (op, params, signal) => {
    const call = { op, params, upstream: { ...params, api_key: KEY }, aborted: false, pulled: 0 };
    signal.addEventListener("abort", () => (call.aborted = true));
    a.calls.push(call);
    const m = a.mode;
    if (m.kind === "error") throw { code: m.code };
    if (m.kind === "hang") await new Promise((r) => signal.addEventListener("abort", r));
    if (m.kind === "late") await m.gate;
    return (async function* () {
      if (m.kind === "huge") {
        for (let i = 0; i < 1000; i++) {
          call.pulled++;
          yield new Uint8Array(1000).fill(32);
        }
        return;
      }
      if (m.kind === "pieces") {
        for (const c of m.chunks()) {
          call.pulled++;
          yield c;
        }
        return;
      }
      const body = m.body ?? JSON.stringify({ dates: ["2020-01-01"], values: [1.5] });
      call.pulled++;
      yield new TextEncoder().encode(body);
    })();
  };
  return a;
}

// A kernel with fake workers; deliver(m) is a message from the current worker
function kernel(ad, opts = {}) {
  const workers = [];
  const k = new WorkerKernel({
    createWorker: () => {
      const w = { n: workers.length, sent: [], postMessage: (m) => w.sent.push(m), terminate() {} };
      workers.push(w);
      return w;
    },
    live: new LiveCalls(ad, opts),
  });
  k.start();
  const run = () => {
    k.execute("x", { mode: "python" }, sink());
    return k.nextId - 1;
  };
  const deliver = (m, w = k.worker) => w.onmessage({ data: m });
  return { k, workers, run, deliver };
}
const ask = (id, key, extra = {}) => ({ id, target: null, liveData: { op: "fred.series_observations", params: { series_id: "SYN_A" }, key, ...extra }, buffer: new SharedArrayBuffer(BYTES) });

// an answered call: checked, from the adapter, to the buffer it came with
{
  const ad = adapter();
  const { run, deliver } = kernel(ad);
  const id = run();
  await tick();
  const m = ask(id, "abc.1");
  deliver(m);
  await tick(10);
  const a = answerOf(m.buffer);
  ok(JSON.stringify(a) === JSON.stringify({ ok: { dates: ["2020-01-01"], values: [1.5] } }), `the answer, checked (${JSON.stringify(a)})`);
  ok(ad.calls.length === 1 && JSON.stringify(ad.calls[0].params) === '{"series_id":"SYN_A"}', "one fetch, with exactly the checked parameters");
}

// B1: the raw message is checked again: a malformed one never reaches the adapter
{
  const ad = adapter();
  const { run, deliver } = kernel(ad);
  const id = run();
  await tick();
  const bad = [
    { ...ask(id, "abc.1"), liveData: { op: "fred.series_observations", params: { series_id: "SYN_A" }, key: "abc.1", url: "https://example.com" } },
    { ...ask(id, "abc.2"), liveData: { op: "fred.series", params: { series_id: "SYN_A" }, key: "abc.2" } },
    { ...ask(id, "abc.3"), liveData: { op: "fred.series_observations", params: { series_id: "SYN_A", api_key: "x" }, key: "abc.3" } },
    { ...ask(id, "abc.4"), liveData: { op: "fred.series_observations", params: { series_id: "A".repeat(65) }, key: "abc.4" } },
    { ...ask(id, "abc.5"), liveData: { op: "fred.series_observations", params: { series_id: "SYN_A", observation_start: "2020-02-30" }, key: "abc.5" } },
    { ...ask(id, "abc.6"), liveData: { op: "fred.series_observations", params: { series_id: "SYN_A", realtime_start: "2020-01-01" }, key: "abc.6" } },
    { ...ask(id, "abc.7"), liveData: { op: "fred.series_observations", params: "series_id=SYN_A", key: "abc.7" } },
    { ...ask(id, "abc.8"), liveData: { op: "fred.series_observations", params: { series_id: "SYN_A" }, key: "../x" } },
    { ...ask(id, "abc.9"), liveData: ["fred.series_observations"] },
    { ...ask(id, "abc.10"), id: "1" },
  ];
  for (const m of bad) deliver(m);
  await tick(10);
  ok(ad.calls.length === 0, `no malformed message reaches the adapter (${ad.calls.length})`);
  ok(bad.slice(0, 9).every((m) => answerOf(m.buffer)?.error === "unavailable"), "each is answered unavailable");
  // (a buffer of the wrong size, or something else where a plain worker's buffer goes: not written, nothing fetched)
  const odd = { ...ask(id, "abc.11"), buffer: new SharedArrayBuffer(64) };
  deliver(odd);
  deliver({ ...ask(id, "abc.12"), buffer: new ArrayBuffer(BYTES) });
  await tick(10);
  ok(ad.calls.length === 0 && Atomics.load(new Int32Array(odd.buffer), 0) === 0, "a buffer of another size: nothing written, nothing fetched");
}

// B2: bound to the worker, its generation and the run: a run not in flight, an old worker's message, nothing asked
{
  const ad = adapter();
  const { k, workers, run, deliver } = kernel(ad);
  const id = run();
  await tick();
  const notRunning = ask(id + 5, "abc.1");
  deliver(notRunning);
  k.restart();
  await tick();
  const old = ask(id, "abc.2");
  deliver(old, workers[0]);
  await tick(10);
  ok(ad.calls.length === 0, "a run not in flight, or a replaced worker's message: nothing fetched");
  ok(answerOf(notRunning.buffer) === null && answerOf(old.buffer) === null, "and nothing written");
}

// B3: the key correlates, it authorizes nothing: a key used again gets nothing, never the earlier answer
{
  const ad = adapter();
  const { run, deliver } = kernel(ad);
  const id = run();
  await tick();
  const first = ask(id, "abc.1");
  deliver(first);
  await tick(10);
  const again = ask(id, "abc.1");
  deliver(again);
  await tick(10);
  ok(answerOf(first.buffer)?.ok && answerOf(again.buffer) === null && ad.calls.length === 1, "a replayed key: no fetch, no answer");
}

// B4: an answer over the bound is cut as it streams: reading stops, the call is aborted, the run gets unavailable
{
  const ad = adapter({ kind: "huge" });
  const { run, deliver } = kernel(ad, { maxBytes: 10_000 });
  const id = run();
  await tick();
  const m = ask(id, "abc.1");
  deliver(m);
  await tick(20);
  ok(answerOf(m.buffer)?.error === "unavailable", "over the bound: unavailable");
  ok(ad.calls[0].pulled <= 11 && ad.calls[0].aborted, `cut at the bound: ${ad.calls[0].pulled} chunks of 1000 read, the fetch aborted`);
  // (and a body that isn't the closed form, or not UTF-8 JSON: unavailable, never its text)
  for (const body of [JSON.stringify({ dates: ["2020-01-01"], values: [1], note: KEY }), "not json " + KEY, JSON.stringify({ dates: [KEY], values: [1] })]) {
    const ad2 = adapter({ kind: "ok", body });
    const t = kernel(ad2);
    const i = t.run();
    await tick();
    const q = ask(i, "abc.1");
    t.deliver(q);
    await tick(10);
    ok(JSON.stringify(answerOf(q.buffer)) === '{"error":"unavailable"}', "a body outside the closed form: unavailable");
  }
  // the adapter's own codes pass; anything else it throws is unavailable
  for (const [code, want] of [["no_key", "no_key"], ["rate_limited", "rate_limited"], ["not_in_catalog", "not_in_catalog"], [KEY, "unavailable"]]) {
    const t = kernel(adapter({ kind: "error", code }));
    const i = t.run();
    await tick();
    const q = ask(i, "abc.1");
    t.deliver(q);
    await tick(10);
    ok(answerOf(q.buffer)?.error === want, `the adapter's ${code === KEY ? "unknown code" : code}: ${want}`);
  }
}

// astra's LIVE691-PARTS-1: the pieces a stream gives are bounded too, empty ones counted: a stream of empty or tiny
// pieces is cut, its fetch aborted, as one over the bytes is; the same answer in at most maxPieces pieces passes
{
  const dates = Array.from({ length: 12 }, (_, m) => `2020-${String(m + 1).padStart(2, "0")}-01`);
  const body = new TextEncoder().encode(JSON.stringify({ dates, values: dates.map((_, m) => (m % 3 ? m / 4 : null)) }));
  // (exactly n pieces, none empty while n <= the body's length)
  const split = (n) => function* () {
    for (let k = 0; k < n; k++) yield body.subarray(Math.floor((k * body.length) / n), Math.floor(((k + 1) * body.length) / n));
  };
  const cases = [
    ["100,000 empty pieces, then the answer", function* () { for (let i = 0; i < 100_000; i++) yield new Uint8Array(0); yield body; }, "unavailable"],
    ["the answer in 1-byte pieces, more than the bound", split(body.length), "unavailable"],
    ["the answer in exactly the bound's pieces", split(64), "ok"],
  ];
  ok([...split(64)()].length === 64 && [...split(64)()].every((c) => c.length) && body.length > 65, `the control's split is exactly 64 pieces of a ${body.length}-byte answer`);
  for (const [name, chunks, want] of cases) {
    const ad = adapter({ kind: "pieces", chunks });
    const t = kernel(ad, { maxPieces: 64 });
    const i = t.run();
    await tick();
    const q = ask(i, "abc.1");
    t.deliver(q);
    await tick(20);
    const a = answerOf(q.buffer);
    ok(want === "ok" ? a?.ok?.dates?.length === 12 : a?.error === want && ad.calls[0].aborted && ad.calls[0].pulled <= 65, `${name}: ${want} (${ad.calls[0].pulled} pieces read)`);
  }
}

// astra's LIVE691-SEEN-1: a worker's replay state is its tag and highest count, a fixed size however many keys it
// sends (refused ones, with no adapter, too); past them, an old count or another tag is refused, a higher count asked
{
  const t = kernel(null);
  const i = t.run();
  await tick();
  // (a runner's requests, with no buffer: ask()'s 8 MiB buffer each would be 800 GB)
  const req = (key, op = "fred.series_observations") => ({ id: i, target: null, liveData: { op, params: { series_id: "SYN_A" }, key }, buffer: null });
  for (let n = 1; n <= 100_000; n++) t.deliver(req("abc." + n, n % 2 ? "fred.series" : "fred.series_observations"));
  const st = t.k.live.seen.get(t.k.worker);
  ok(st && Object.keys(st).sort().join() === "high,tag" && st.high === 100_000 && st.tag === "abc", `100,000 keys: one {tag, high} (${JSON.stringify(st)})`);
  const before = t.k.worker.sent.length;
  for (const key of ["abc.5", "abc.100000", "xyz.100001"]) t.deliver(req(key));
  ok(t.k.worker.sent.length === before, "an old count, the highest again, or another tag: nothing answered");
  t.deliver(req("abc.100001"));
  const last = t.k.worker.sent.at(-1);
  ok(t.k.worker.sent.length === before + 1 && last.key === "abc.100001" && last.answer?.error === "unavailable", "the next count: asked (unavailable, with no adapter)");
}

// B5 and B6: Stop, the deadline, Forget, a restart and close each abort the fetch; an aborted call is never answered
for (const [name, act] of [["Stop", (t) => t.k.interrupt()], ["Forget", (t) => t.k.forgetLiveData()], ["restart", (t) => t.k.restart()], ["close", (t) => t.k.close()], ["the run's end", (t, id) => t.deliver({ id, done: true, ms: 1 })]]) {
  let release;
  const gate = new Promise((r) => (release = r));
  const ad = adapter({ kind: "late", gate });
  const t = kernel(ad);
  t.k.interruptFlag = new Int32Array(new SharedArrayBuffer(8));
  const id = t.run();
  await tick();
  const m = ask(id, "abc.1");
  t.deliver(m);
  await tick();
  act(t, id);
  release();
  await tick(10);
  ok(ad.calls[0].aborted && answerOf(m.buffer) === null, `${name}: the fetch aborted, and its late answer written nowhere`);
}
{
  const ad = adapter({ kind: "hang" });
  const t = kernel(ad, { deadlineMs: 50 });
  const id = t.run();
  await tick();
  const m = ask(id, "abc.1");
  t.deliver(m);
  await tick(120);
  ok(ad.calls[0].aborted && answerOf(m.buffer)?.error === "timeout", "the deadline: the fetch aborted, the run told timeout");
}

// B7: a runner's worker (its frame keeps the buffer): the same admission, the answer sent to the frame by key and run
{
  const ad = adapter();
  const { k, run, deliver } = kernel(ad);
  const id = run();
  await tick();
  deliver({ ...ask(id, "abc.1"), buffer: null });
  await tick(10);
  const to = k.worker.sent.find((m) => m.runnerLive !== undefined);
  ok(ad.calls.length === 1 && to && to.runnerLive === id && to.key === "abc.1" && to.answer?.ok, "a runner's request: admitted the same way, its answer to the frame");
}
// the frame (web/runner/index.html): forwards the operation without its buffer, writes only the answer its key and
// run name, once, and none after a Stop
{
  const html = readFileSync(new URL("./runner/index.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  let listener, worker;
  const port = { sent: [], postMessage(m) { port.sent.push(m); } };
  const env = {
    addEventListener: (_, f) => (listener = f),
    parent: {},
    URL: { createObjectURL: () => "blob:x" },
    Blob: class {},
    Worker: class {
      constructor() { worker = this; this.sent = []; }
      postMessage(m) { this.sent.push(m); }
    },
    SharedArrayBuffer, Int32Array, Uint8Array, TextEncoder, Atomics, JSON, Math, Map, String, Number,
  };
  new Function(...Object.keys(env), script)(...Object.values(env));
  listener({ source: env.parent, data: { sagebrushRunner: 1, script: "", base: "x" }, ports: [port] });
  const m = ask(4, "abc.1");
  worker.onmessage({ data: m });
  const fwd = port.sent.find((d) => d.liveData);
  ok(fwd && fwd.buffer === null && fwd.liveData.key === "abc.1", "the frame forwards the operation, keeping the buffer");
  port.onmessage({ data: { runnerLive: 5, key: "abc.1", answer: { error: "no_key" } } });
  port.onmessage({ data: { runnerLive: 4, key: "abc.2", answer: { error: "no_key" } } });
  ok(answerOf(m.buffer) === null, "an answer naming another run or key: not written");
  port.onmessage({ data: { runnerLive: 4, key: "abc.1", answer: { error: "no_key" } } });
  port.onmessage({ data: { runnerLive: 4, key: "abc.1", answer: { error: "rate_limited" } } });
  ok(answerOf(m.buffer)?.error === "no_key", "its own answer: written once");
  const m2 = ask(4, "abc.3");
  worker.onmessage({ data: m2 });
  port.onmessage({ data: { runnerInterrupt: 4 } });
  port.onmessage({ data: { runnerLive: 4, key: "abc.3", answer: { error: "no_key" } } });
  ok(answerOf(m2.buffer) === null, "after a Stop: none written");
}

// astra's LIVE691-REPLAY-1: a request whose key is already open in the frame changes nothing there and isn't
// forwarded, so the first request's answer, late, still goes to the first buffer and never to the duplicate's; a
// new key of the same run is forwarded (and replaces the run's earlier one), and the run's end retires it
{
  const html = readFileSync(new URL("./runner/index.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  let listener, worker;
  const port = { sent: [], postMessage(m) { port.sent.push(m); } };
  const env = {
    addEventListener: (_, f) => (listener = f),
    parent: {},
    URL: { createObjectURL: () => "blob:x" },
    Blob: class {},
    Worker: class {
      constructor() { worker = this; this.sent = []; }
      postMessage(m) { this.sent.push(m); }
    },
    SharedArrayBuffer, Int32Array, Uint8Array, TextEncoder, Atomics, JSON, Math, Map, String, Number,
  };
  new Function(...Object.keys(env), script)(...Object.values(env));
  listener({ source: env.parent, data: { sagebrushRunner: 1, script: "", base: "x" }, ports: [port] });
  const A = ask(4, "abc.1"), B = ask(4, "abc.1");
  worker.onmessage({ data: A });
  worker.onmessage({ data: B });
  ok(port.sent.filter((d) => d.liveData).length === 1, "the duplicate is not forwarded");
  port.onmessage({ data: { runnerLive: 4, key: "abc.1", answer: { ok: { dates: ["2020-01-01"], values: [123] } } } });
  ok(answerOf(A.buffer)?.ok?.values[0] === 123 && answerOf(B.buffer) === null, "the first answer, late: in the first buffer, the duplicate's untouched");
  const C = ask(4, "abc.2");
  worker.onmessage({ data: C });
  ok(port.sent.filter((d) => d.liveData).length === 2, "a new key of the run: forwarded");
  worker.onmessage({ data: { id: 4, done: true, ms: 1 } });
  port.onmessage({ data: { runnerLive: 4, key: "abc.2", answer: { error: "no_key" } } });
  ok(answerOf(C.buffer) === null, "after the run's end: none written");
}

// B8: the reader's key, which only the adapter holds, reaches no worker: not in anything posted, nor in any buffer
{
  const ad = adapter();
  const { k, run, deliver } = kernel(ad);
  const id = run();
  await tick();
  const m = ask(id, "abc.1");
  deliver(m);
  deliver({ ...ask(id, "abc.2"), buffer: null });
  await tick(10);
  const seen = JSON.stringify(k.worker.sent) + new TextDecoder().decode(new Uint8Array(m.buffer, 0, 4096).slice());
  ok(ad.calls.length === 2 && ad.calls.every((c) => c.upstream.api_key === KEY), "the adapter attached the key on the way out");
  ok(seen.length > 100 && !seen.includes(KEY), "the key is in nothing the worker gets");
  ok((seen + KEY).includes(KEY), "the scan finds a planted key");
}

// no admission given (until the key broker exists): unavailable, nothing fetched
{
  const workers = [];
  const k = new WorkerKernel({ createWorker: () => { const w = { sent: [], postMessage: (m) => w.sent.push(m), terminate() {} }; workers.push(w); return w; } });
  k.start();
  k.execute("x", { mode: "python" }, sink());
  await tick();
  const m = ask(k.nextId - 1, "abc.1");
  k.worker.onmessage({ data: m });
  ok(answerOf(m.buffer)?.error === "unavailable", "no adapter: unavailable");
}
