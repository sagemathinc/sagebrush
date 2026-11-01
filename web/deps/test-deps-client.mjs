// The page's side of the Share dialog's analysis (web/deps/deps-client.ts,
// share-ux-plan r2 §3): progressive results, stop, the fail-safes, generations.
// A fake worker runs the worker's protocol in-process (the real fileDeps).
//   bun web/deps/test-deps-client.mjs
import { startDeps } from "./deps-client.ts";
import { fileDeps } from "./file-deps.ts";

let checks = 0;
const fails = [];
const ok = (cond, what) => {
  checks++;
  if (!cond) {
    fails.push(what);
    console.log("FAIL " + what);
  }
};
const tick = () => new Promise((r) => setTimeout(r, 5));

// In-process stand-in for deps-worker.ts: the same messages.
function fakeWorker({ silent = false, genOverride } = {}) {
  const w = { terminated: false, onmessage: null, posted: [], transfers: [] };
  const waiting = new Map();
  const send = (m) => queueMicrotask(() => !w.terminated && w.onmessage?.({ data: m }));
  w.terminate = () => (w.terminated = true);
  w.postMessage = (m, transfer) => {
    w.posted.push(m);
    w.transfers.push(transfer ?? []);
    if (silent) return;
    if (m.file) {
      const p = waiting.get(m.file.path);
      waiting.delete(m.file.path);
      if (m.file.bytes instanceof ArrayBuffer) p.ok(new TextDecoder().decode(m.file.bytes));
      else p.no(new Error("unreadable"));
      return;
    }
    if (m.start) {
      const s = m.start, gen = genOverride ?? s.gen;
      fileDeps({
        ...s,
        files: new Map(s.files),
        builtinModules: new Set(s.builtinModules),
        externalModules: new Set(s.externalModules),
        packageModules: new Set(s.packageModules),
        readFile: (path) => new Promise((ok, no) => (waiting.set(path, { ok, no }), send({ gen, need: path }))),
        onDep: (path, reason) => send({ gen, dep: path, reason }),
        onUnfollowed: (u) => send({ gen, unfollowed: u }),
        onProgress: (p) => send({ gen, progress: p }),
        signal: new AbortController().signal,
      }).then((r) => send({ gen, done: true, complete: r.complete }));
    }
  };
  return w;
}
const enc = (t) => new TextEncoder().encode(t);
const ws = { "/a.py": "import b\n", "/b.py": 'open("d.csv")\n', "/d.csv": "x" };
const input = (cells = ["import a\n"]) => ({
  cells: cells.map((source, index) => ({ index, kind: "python", source })),
  files: Object.keys(ws).map((p) => [p, { size: ws[p].length }]),
  cwd: "/",
  importPath: [{ dir: "/", workspace: true }],
  builtinModules: [],
  externalModules: [],
  packageModules: [],
});
function collect() {
  const c = { deps: [], done: null, progress: 0, unf: [] };
  c.handlers = {
    onDep: (p, r) => c.deps.push([p, r]),
    onUnfollowed: (u) => c.unf.push(u),
    onProgress: () => c.progress++,
    onDone: (r) => (c.done = r),
  };
  return c;
}

{
  const c = collect(), w = fakeWorker(), reads = [];
  startDeps({ gen: 1, input: input(), readBytes: async (p) => (reads.push(p), enc(ws[p])), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(JSON.stringify(c.deps.map((d) => d[0])) === '["/a.py","/b.py","/d.csv"]', "results arrive progressively, in order");
  ok(c.done?.complete === true && w.terminated, "the end: complete, and the worker terminated");
  ok(JSON.stringify(reads) === '["/a.py","/b.py"]', "only the .py files asked for are read, each once");
}
{
  const c = collect(), w = fakeWorker();
  const run = startDeps({ gen: 2, input: input(), readBytes: (p) => new Promise((r) => setTimeout(() => r(enc(ws[p])), 30)), createWorker: () => w, handlers: c.handlers });
  await tick();
  run.stop();
  await new Promise((r) => setTimeout(r, 80));
  ok(w.terminated && c.done === null && !run.running, "stop() terminates at once, and nothing is reported after");
}
{
  const c = collect(), w = fakeWorker({ silent: true });
  startDeps({ gen: 3, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 40, sourceBytes: 1e9 } });
  await new Promise((r) => setTimeout(r, 100));
  ok(c.done?.stopped === "failsafe" && c.done.complete === false && w.terminated, "the silence fail-safe terminates a worker stuck in one parse");
}
{
  const c = collect(), w = fakeWorker();
  startDeps({ gen: 4, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 1000, sourceBytes: 5 } });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(c.done?.stopped === "failsafe" && w.terminated, "the source-bytes fail-safe stops the analysis");
}
{
  const c = collect(), w = fakeWorker({ genOverride: 99 });
  startDeps({ gen: 5, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 60, sourceBytes: 1e9 } });
  await new Promise((r) => setTimeout(r, 120));
  ok(c.deps.length === 0, "messages of another generation are ignored");
}
{
  const c = collect(), w = fakeWorker();
  startDeps({ gen: 6, input: input(), readBytes: async (p) => (p === "/a.py" ? Promise.reject(new Error("gone")) : enc(ws[p])), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(c.done && c.done.complete === false && c.deps.map((d) => d[0]).join() === "/a.py", "an unreadable file: still imported, not followed, incomplete");
}

// ---- #172 r2's review: daybreak3's LIMIT-SHAREB-2 and CORR-SHAREB-3
{
  // the source goes to the worker as bytes, transferred: never a cloned string
  const c = collect(), w = fakeWorker();
  startDeps({ gen: 7, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  const sent = w.posted.map((m, i) => [m, w.transfers[i]]).filter(([m]) => m.file);
  ok(sent.length === 2 && sent.every(([m, t]) => m.file.bytes instanceof ArrayBuffer && t.length === 1 && t[0] === m.file.bytes && m.file.text === undefined), "each .py goes as an ArrayBuffer in the transfer list, no string");
}
{
  // the fail-safe counts bytes, not UTF-16 code units: 6 "é" are 6 units but 12 bytes
  const c = collect(), w = fakeWorker();
  const nonAscii = { ...ws, "/a.py": "é".repeat(6) };
  startDeps({ gen: 8, input: input(), readBytes: async (p) => enc(nonAscii[p]), createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 1000, sourceBytes: 10 } });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(c.done?.stopped === "failsafe", `sourceBytes counts bytes: 12 UTF-8 bytes over a 10-byte fail-safe stop it (${JSON.stringify(c.done)})`);
  const c2 = collect(), w2 = fakeWorker();
  startDeps({ gen: 9, input: input(), readBytes: async (p) => enc(nonAscii[p]), createWorker: () => w2, handlers: c2.handlers, failsafe: { silenceMs: 1000, sourceBytes: 12 } });
  for (let i = 0; i < 50 && !c2.done; i++) await tick();
  ok(c2.done && c2.done.stopped === undefined, "...and exactly at the limit, it doesn't (control)");
}
{
  // a real worker: the transferred buffers are detached in the page (moved, not copied)
  const c = collect(), detached = [];
  const real = new Worker(new URL("./deps-worker.ts", import.meta.url).href);
  const w = {
    onmessage: null,
    postMessage: (m, t) => {
      real.postMessage(m, t ?? []);
      for (const b of t ?? []) detached.push(b.byteLength);
    },
    terminate: () => real.terminate(),
  };
  real.onmessage = (e) => w.onmessage?.(e);
  startDeps({ gen: 10, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 400 && !c.done; i++) await tick();
  ok(c.done?.complete === true && JSON.stringify(c.deps.map((d) => d[0])) === '["/a.py","/b.py","/d.csv"]', `a real deps-worker decodes the transferred bytes: ${JSON.stringify(c.deps.map((d) => d[0]))}`);
  ok(detached.length === 2 && detached.every((n) => n === 0), `...and each buffer sent is detached in the page after postMessage: ${JSON.stringify(detached)}`);
}
{
  // a worker that can't be constructed: the run ends as failed, nothing thrown
  const c = collect();
  let threw = false, run;
  try {
    run = startDeps({ gen: 11, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => { throw new Error("blocked by CSP"); }, handlers: c.handlers });
  } catch {
    threw = true;
  }
  await tick();
  ok(!threw && c.done?.complete === false && c.done.stopped === "failed" && run.running === false, `createWorker throwing: no throw, onDone failed (${JSON.stringify(c.done)})`);
  const c2 = collect();
  const run2 = startDeps({ gen: 12, input: input(), readBytes: async (p) => enc(ws[p]), createWorker: () => { throw new Error("x"); }, handlers: c2.handlers });
  run2.stop();
  await tick();
  ok(c2.done === null, "...and stopped before it reports: nothing reported");
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
