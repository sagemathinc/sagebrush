// The page's side of the Share dialog's analysis (web/share-client/deps-client.ts,
// share-ux-plan r2 §3): progressive results, stop, the fail-safes, generations.
// A fake worker runs the worker's protocol in-process (the real fileDeps).
//   bun web/share-client/test-deps-client.mjs
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
  const w = { terminated: false, onmessage: null, posted: [] };
  const waiting = new Map();
  const send = (m) => queueMicrotask(() => !w.terminated && w.onmessage?.({ data: m }));
  w.terminate = () => (w.terminated = true);
  w.postMessage = (m) => {
    w.posted.push(m);
    if (silent) return;
    if (m.file) {
      const p = waiting.get(m.file.path);
      waiting.delete(m.file.path);
      if (typeof m.file.text === "string") p.ok(m.file.text);
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
  startDeps({ gen: 1, input: input(), readText: async (p) => (reads.push(p), ws[p]), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(JSON.stringify(c.deps.map((d) => d[0])) === '["/a.py","/b.py","/d.csv"]', "results arrive progressively, in order");
  ok(c.done?.complete === true && w.terminated, "the end: complete, and the worker terminated");
  ok(JSON.stringify(reads) === '["/a.py","/b.py"]', "only the .py files asked for are read, each once");
}
{
  const c = collect(), w = fakeWorker();
  const run = startDeps({ gen: 2, input: input(), readText: (p) => new Promise((r) => setTimeout(() => r(ws[p]), 30)), createWorker: () => w, handlers: c.handlers });
  await tick();
  run.stop();
  await new Promise((r) => setTimeout(r, 80));
  ok(w.terminated && c.done === null && !run.running, "stop() terminates at once, and nothing is reported after");
}
{
  const c = collect(), w = fakeWorker({ silent: true });
  startDeps({ gen: 3, input: input(), readText: async (p) => ws[p], createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 40, sourceBytes: 1e9 } });
  await new Promise((r) => setTimeout(r, 100));
  ok(c.done?.stopped === "failsafe" && c.done.complete === false && w.terminated, "the silence fail-safe terminates a worker stuck in one parse");
}
{
  const c = collect(), w = fakeWorker();
  startDeps({ gen: 4, input: input(), readText: async (p) => ws[p], createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 1000, sourceBytes: 5 } });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(c.done?.stopped === "failsafe" && w.terminated, "the source-bytes fail-safe stops the analysis");
}
{
  const c = collect(), w = fakeWorker({ genOverride: 99 });
  startDeps({ gen: 5, input: input(), readText: async (p) => ws[p], createWorker: () => w, handlers: c.handlers, failsafe: { silenceMs: 60, sourceBytes: 1e9 } });
  await new Promise((r) => setTimeout(r, 120));
  ok(c.deps.length === 0, "messages of another generation are ignored");
}
{
  const c = collect(), w = fakeWorker();
  startDeps({ gen: 6, input: input(), readText: async (p) => (p === "/a.py" ? Promise.reject(new Error("gone")) : ws[p]), createWorker: () => w, handlers: c.handlers });
  for (let i = 0; i < 50 && !c.done; i++) await tick();
  ok(c.done && c.done.complete === false && c.deps.map((d) => d[0]).join() === "/a.py", "an unreadable file: still imported, not followed, incomplete");
}

console.log(`${checks - fails.length}/${checks} passed`);
process.exit(fails.length ? 1 : 0);
