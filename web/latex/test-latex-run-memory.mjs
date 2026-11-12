// ci: checks.3 order=114 runner=bun
// A shared talk's Run on the share page (run-core's runInMemory, and sessionOf's mount and dispose), without a browser:
//   - the session tells each worker it may change no file, then gives it the shared files (mount), in that order;
//   - dispose() ends the session: a kernel still starting is stopped when it is ready and never returned, a kernel
//     already started is stopped, and a call after it starts nothing;
//   - runInMemory runs the talk's script with its working folder, keeps an item it didn't reach from the results shown
//     before it, and reads nothing of the workspace and writes nothing (a spy that records any use);
//   - a Run gone stale (its view replaced) or stopped while it waited gives no results; the editor's Run is admitted
//     again after its folder is put in, just before its script.
//   bun web/latex/test-latex-run-memory.mjs
import { sessionOf, runInMemory, runAndSave, MARK, SANDBOX_FAILED, statesOf } from "./run-core.mjs";
import { itemKey } from "./engine/sagetex.mjs";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 900)); };
const item = (mode, code) => { const it = { mode, code, opts: [] }; return { mode, err: null, key: itemKey(it), code }; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// a kernel of the test's own: its worker records what it is sent; it is ready when the test says so
const made = [];
class FakeKernel {
  constructor(o) { this.onStart = o.onStart; this.ready = false; this.ls = {}; this.generation = 0; made.push(this); }
  start() { this.worker = { posts: [], terminated: false, postMessage(m) { this.posts.push(m); }, terminate() { this.terminated = true; } }; this.onStart(this.worker); }
  on(ev, f) { (this.ls[ev] ??= []).push(f); return () => {}; }
  becomeReady() { this.ready = true; for (const f of this.ls.ready ?? []) f(); }
  interrupt() { this.interrupted = true; }
}
const eng = { module: async () => ({ WorkerKernel: FakeKernel }), worker: () => null };
const MOUNT = [["talks/st.tex", { url: "https://files.example/c/1/aa", sha256: "aa", size: 10 }], ["talks/helper.py", { url: "https://files.example/c/1/bb", sha256: "bb", size: 20 }]];

// ---- the session's first messages: no right to change files, then the shared files
{
  const s = sessionOf(eng, 1000, MOUNT);
  const p = s();
  await tick();
  const k = made.at(-1);
  k.becomeReady();
  await p;
  check("mount: the worker is first told it may change no file, then given the shared files", JSON.stringify(k.worker.posts) === JSON.stringify([{ fsWritable: false }, { mount: MOUNT }]), k.worker.posts);
  const plain = sessionOf(eng, 1000);
  const q = plain(); await tick(); made.at(-1).becomeReady(); await q;
  check("mount: a session without one gives none (the editor's)", JSON.stringify(made.at(-1).worker.posts) === JSON.stringify([{ fsWritable: false }]), made.at(-1).worker.posts);
  s.dispose(); plain.dispose();
}

// ---- dispose wins over a start under way, stops a started kernel, and nothing starts after it
{
  const s = sessionOf(eng, 1000, MOUNT);
  const p = s().then(() => "returned", (e) => e.message);
  await tick();
  const k = made.at(-1);
  s.dispose();
  k.becomeReady();
  const r = await p;
  check("dispose: a kernel still starting is stopped when ready and never returned", r === SANDBOX_FAILED && k.worker === null && s.kernel === null, { r, kernel: s.kernel });
  const n = made.length;
  const again = await s().then(() => "returned", (e) => e.message);
  check("dispose: a call after it starts nothing", again === SANDBOX_FAILED && made.length === n, { again, made: made.length - n });
  const t = sessionOf(eng, 1000, MOUNT);
  const tp = t(); await tick(); const tk = made.at(-1); const w = tk.worker; tk.becomeReady(); await tp;
  t.dispose();
  check("dispose: a started kernel's worker is stopped", w.terminated === true && tk.worker === null && t.kernel === null, { terminated: w.terminated });
  // (daybreak3's E1 A: ready, then disposed: a later call rejects, never the ended kernel, and makes none)
  const m1 = made.length;
  const after = await t().then((k) => (k === tk ? "the ended kernel" : "a kernel"), (e) => e.message);
  check("dispose: after a ready kernel is disposed, a call rejects and returns no kernel", after === SANDBOX_FAILED && made.length === m1, { after, made: made.length - m1 });
  // (E1 B: disposed while the engine loads: no kernel made when it has loaded)
  let loaded;
  const slow = sessionOf({ module: () => new Promise((r) => { loaded = () => r({ WorkerKernel: FakeKernel }); }), worker: () => null }, 1000, MOUNT);
  const m2 = made.length;
  const sp = slow().then(() => "returned", (e) => e.message);
  await tick();
  slow.dispose();
  loaded();
  const sr = await sp;
  check("dispose: while the engine loads, no kernel is made when it has loaded", sr === SANDBOX_FAILED && made.length === m2, { sr, made: made.length - m2 });
  // (astra: disposed while the kernel waits to be ready: its worker ended at once, the start settled long before its deadline)
  const waitS = sessionOf(eng, 60_000, MOUNT);
  const t0 = Date.now(), wp = waitS().then(() => "returned", (e) => e.message);
  await tick();
  const wk = made.at(-1), ww = wk.worker;
  waitS.dispose();
  const wr = await wp;
  check("dispose: while the kernel waits to be ready, its worker is ended at once and the start settles", wr === SANDBOX_FAILED && ww.terminated === true && Date.now() - t0 < 1000, { wr, terminated: ww.terminated, ms: Date.now() - t0 });
}

// ---- runInMemory: the script with its folder, kept values, and no workspace at all
{
  const used = [];
  const spy = new Proxy({}, { get: (_t, k) => { used.push(String(k)); return () => { used.push("call " + String(k)); }; } });
  const items = [item("silent", "x = 2"), item("sage", "x"), item("sage", "x + 1")];
  const prev = [{ key: items[0].key, s: "ok" }, { key: items[1].key, s: "ok", latex: "1" }, { key: items[2].key, s: "ok", latex: "2" }];
  const k = { generation: 0, interrupt() {} };
  let code = "";
  const r = await runInMemory({
    items, prev, dir: "/talks", current: () => true, max: 1 << 20, now: () => 0, ws: spy, store: spy, fid: "x",
    session: async () => k,
    // (the session stopped after the second item: the third not reached)
    exec: async (_k, c) => { code = c; return { out: MARK + JSON.stringify({ s: "ok" }) + "\n" + MARK + JSON.stringify({ s: "ok", latex: "2" }) + "\n", stopped: "the run was stopped" }; },
  });
  const d = JSON.parse(Buffer.from(code.match(/_sx_d = _sx_json\.loads\(_sx_b64\.b64decode\("([^"]*)"\)/)?.[1] ?? "", "base64").toString());
  check("runInMemory: the script runs in the talk's folder", JSON.stringify(d).includes('"/talks"'), d);
  check("runInMemory: its results, in the page only", r.ok === true && r.states[1].s === "ok" && r.states[1].latex === "2", r);
  check("runInMemory: an item it didn't reach keeps the value shown before, saying the run was stopped", r.states[2].s === "stale" && r.states[2].latex === "2" && r.states[2].why === "stopped", r.states[2]);
  check("runInMemory: nothing of the workspace read or written (the spy saw no use)", used.length === 0, used);
  check("runInMemory: the same states statesOf gives, with keepLast", JSON.stringify(r.states.slice(0, 2)) === JSON.stringify(statesOf(items, [{ s: "ok" }, { s: "ok", latex: "2" }], "the run was stopped").slice(0, 2)), r.states);
}

// ---- stale and stopped Runs give no results
{
  const items = [item("sage", "1")];
  const k = { generation: 0, interrupt() {} };
  let live = true, ran = 0;
  const base = { items, max: 1 << 20, now: () => 0, session: async () => k, exec: async () => { ran++; live = false; return { out: MARK + JSON.stringify({ s: "ok", latex: "1" }) + "\n", stopped: "" }; } };
  const gone = await runInMemory({ ...base, current: () => live });
  check("runInMemory: a Run whose view was replaced while it ran gives no results (its output dropped)", gone.stale === true && !gone.states && ran === 1, gone);
  const stop = new AbortController(); stop.abort();
  const before = await runInMemory({ ...base, current: () => true, stop: stop.signal });
  check("runInMemory: a Run stopped while it waited runs nothing", before.msg === "Stopped before it ran" && ran === 1, before);
  let late = true;
  const notYet = await runInMemory({ ...base, current: () => true, session: async () => { late = false; return k; }, signal: { aborted: false, addEventListener() {}, removeEventListener() {} } });
  check("runInMemory: a Run whose session started runs", notYet.ok === true && !late && ran === 2, notYet);
  // (replaced while the interact chunk loads, after the script ran: still no results)
  let on = true;
  const ia = await runInMemory({ ...base, current: () => on, interacts: async () => { on = false; return { interactsOf: () => [] }; },
    exec: async () => ({ out: MARK + JSON.stringify({ s: "ok", interacts: [{ spec: { id: 1, name: "f", controls: [] }, out: "", shows: [] }] }) + "\n", stopped: "" }) });
  check("runInMemory: a Run whose view was replaced while its interacts were checked gives no results", ia.stale === true && !ia.states, ia);
}

// ---- the editor's Run admitted again after its folder is put in, just before its script (astra's S2-RUN-ADMIT-1): a Run
// replaced or stopped in that last wait runs nothing
{
  const items = [item("sage", "1")];
  let ran = 0, live = true;
  const stopper = new AbortController();
  let onPost = () => {};
  const k = { generation: 0, interrupt() {}, post() { onPost(); } };
  const ws = { pathOfFile: async () => ({ ok: true, path: "/A/doc.tex" }), stat: async () => undefined, createByPerson: async () => ({}), write: async () => ({}) };
  const base = { items, ws, fid: "a", max: 1 << 20, now: () => 0, session: async () => k, store: { sent: new Set(), snapshot: [] }, folder: async () => ({ dir: "/A", files: [["/A/h.py", new Uint8Array([1])]] }), exec: async () => { ran++; return { out: MARK + JSON.stringify({ s: "ok", latex: "1" }) + "\n", stopped: "" }; } };
  onPost = () => { live = false; };
  const gone = await runAndSave({ ...base, current: () => live });
  check("admitted again: a Run replaced while its folder was put in runs nothing", gone.stale === true && ran === 0, { gone, ran });
  live = true;
  onPost = () => stopper.abort();
  const stopped = await runAndSave({ ...base, current: () => live, stop: stopper.signal });
  check("admitted again: a Run stopped while its folder was put in runs nothing", stopped.msg === "Stopped before it ran" && ran === 0, { stopped, ran });
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}` : `ok: a shared talk's Run, in memory, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
