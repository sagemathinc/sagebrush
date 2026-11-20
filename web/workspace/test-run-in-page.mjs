// ci: web-runner order=187 runner=bun
// An agent's run_notebook of the notebook open on its page (run-verbs.ts runInPage), against a page of the test's own:
// when the page's run is chosen and when today's is, never both; once chosen, every end (busy, a failure, Stop, the
// deadline, the grant narrowed or replaced, another notebook shown) without today's run after it, no later cell started
// and nothing the run said returned; and the result from the notebook as shown, within the run's bounds.
//   bun web/workspace/test-run-in-page.mjs
import { run, stop, RUN_LIMITS, RUN_TEXT, inputHash, notebookInputs } from "./run-verbs.ts";
import { createHash } from "node:crypto";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };
const until = async (f) => { for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 2)); };

const DOC = { mode: "python", cells: [{ id: "m", type: "markdown", code: "# x" }, { id: "a", type: "code", code: "1" }, { id: "b", type: "code", code: "2" }] };
// (a page of the test's own: its notebook, each cell's answer when the test says, what was asked of it)
function setup(o = {}) {
  const log = { fallback: 0, asked: 0, started: [], stops: 0, saves: 0, closed: 0 };
  let grant = { id: "g1", run: true, write: false, folders: o.folders ?? ["/"] };
  const changes = new Set();
  const ctx = {
    agent: "agent", actor: "agent:x", grant,
    live: () => grant !== null && grant.id === "g1" && grant.run && JSON.stringify(grant.folders) === JSON.stringify(ctx.grant.folders),
    why: () => "the grant was revoked",
    grantNow: () => grant,
    onChange: (cb) => (changes.add(cb), () => changes.delete(cb)),
  };
  const setGrant = (g) => { grant = g; for (const cb of [...changes]) cb(); };
  const holder = { current: null, shown: 0, hides: [], show() { this.shown++; }, hide() { this.hides.push(performance.now()); } };
  const waits = new Map();
  let shown = true, gone = null;
  const page = {
    doc: structuredClone(o.doc ?? DOC),
    // (a cell's run: answered at once, or held until the test answers it)
    answer: o.answer ?? ((id, out) => { out.add(`out ${id}\n`); return { status: "ok", images: { count: 0, bytes: 0 } }; }),
  };
  const ws = {
    stat: async (p) => ({ kind: "notebook", ref: "r1", path: p }),
    branchAt: async () => ({ no: null, root: { path: "/Branches/b", fid: "f", name: "b" } }),
    list: async () => { log.fallback++; if (o.todayDelay) await new Promise((r) => setTimeout(r, o.todayDelay)); throw new Error("today's run"); },
  };
  const host = {
    ws: { runHost: () => ws }, WorkerKernel: class { constructor() { log.fallback++; throw new Error("today's run"); } }, RunnerWorker: class {}, runnerSrc: "runner/", sandbox: "ok",
    docTrees: () => [],
    inPage: (ref, path, g) => {
      log.asked++;
      if (!o.open || ref !== "r1") return null;
      gone = g;
      return {
        inputs: async () => (o.inputs ? o.inputs() : o.inputsGone ? null : structuredClone(page.doc)),
        current: () => shown,
        cell: async (id, out) => {
          log.started.push(id);
          if (o.hold?.includes(id)) await new Promise((r) => waits.set(id, r));
          return page.answer(id, out);
        },
        save: async () => { log.saves++; if (o.holdSave) await new Promise((r) => waits.set("save", r)); if (o.saveFails) throw new Error("late save failure"); return shown; },
        stop: () => { log.stops++; },
        close: () => { log.closed++; },
      };
    },
  };
  return { ctx, host, holder, log, page, setGrant, waits, show: (v) => { shown = v; if (!v) gone?.(); } };
}
const call = (s, path = "/labs/n.ipynb", params = {}) => run("workspace.run_notebook", { path, ...params }, s.ctx, s.host, s.holder).then((r) => ({ r }), (e) => ({ e }));

// ---- which run: the page's only for this notebook open, Everything and May run code, outside a branch
{
  const s = setup({ open: false });
  const { e } = await call(s);
  check(s.log.asked === 1 && s.log.fallback === 1 && e?.message === "today's run", "not open here: the page asked, nothing started, today's run");
}
{
  const s = setup({ open: true, folders: ["/labs"] });
  await call(s);
  check(s.log.asked === 0 && s.log.fallback === 1, "a narrower grant: the page never asked, today's run");
}
{
  const s = setup({ open: true });
  await call(s, "/Branches/b/n.ipynb");
  check(s.log.asked === 0 && s.log.fallback === 1, "in a branch: the page never asked, today's run");
}
{
  const s = setup({ open: true });
  s.ctx.grant = { ...s.ctx.grant, run: false };
  const { e } = await call(s);
  check(s.log.asked === 0 && s.log.fallback === 0 && e?.code === "not_allowed", `without May run code: refused, neither run (${e?.code})`);
}

// ---- the page's run, to its end: each code cell in order, saved, the result as today's, the inputs as shown
{
  const s = setup({ open: true });
  s.page.doc.cells[1].code = "1 + 0"; // (edited on the page, not yet saved: what runs is what is shown)
  const { r, e } = await call(s);
  const want = await inputHash([{ view: "/labs/n.ipynb", kind: "notebook", sha256: createHash("sha256").update(notebookInputs(s.page.doc)).digest("hex") }]);
  check(!e && r.ok === true && r.ended === "done" && r.saved === "saved", `done and saved: ${JSON.stringify(r ?? e?.message)}`);
  check(JSON.stringify(r?.cells) === JSON.stringify([{ index: 1, status: "ok", out: "out a\n", images: { count: 0, bytes: 0 } }, { index: 2, status: "ok", out: "out b\n", images: { count: 0, bytes: 0 } }]), "each code cell, by its index, with its output");
  check(r?.inputHash === want, "inputHash from the notebook as shown, not as stored");
  check(JSON.stringify(r?.refused) === JSON.stringify({ paths: [] }), "refused: none");
  check(s.log.fallback === 0 && s.holder.current === null && s.log.closed === 1 && s.holder.shown === 1, "today's run never started; the run's line shown, then let go");
}
{
  const s = setup({ open: true, answer: (id, out) => (id === "a" ? (out.add("Traceback\nZeroDivisionError\n"), { status: "error", images: { count: 0, bytes: 0 } }) : { status: "ok", images: { count: 0, bytes: 0 } }) });
  const { r } = await call(s);
  check(r?.ok === false && r.ended === "error" && r.cells[0].status === "error" && r.cells[1].status === "skipped" && !("out" in r.cells[1]) && JSON.stringify(s.log.started) === '["a"]', "an error: the cells after it skipped, never started");
}
{
  const big = "x".repeat(RUN_LIMITS.cellHead + RUN_LIMITS.cellTail + 5000);
  const s = setup({ open: true, answer: (id, out) => (out.add(big), { status: "ok", images: { count: 1, bytes: 10 } }) });
  const { r } = await call(s);
  check(r?.cells.every((c) => c.out.length < RUN_LIMITS.cellHead + RUN_LIMITS.cellTail + 100 && c.out.includes(RUN_TEXT.cut(5000).slice(0, 4))), "a cell's output past its bounds: cut as today's, before it is handed back");
  check(new TextEncoder().encode(JSON.stringify(r)).length <= RUN_LIMITS.result, "the result within 256 KiB");
}

// ---- the page took it, then couldn't (inputs() answers "fallback", before any cell): today's run instead, under the
// same deadline, nothing started on the page and nothing of its hold left; an end that came first stands
{
  // (as a pane that couldn't bind its notebook answers: not current either)
  const s = setup({ open: true, inputs: async () => "fallback" });
  const inPage = s.host.inPage;
  s.host.inPage = (...a) => { const pr = inPage(...a); return pr && { ...pr, current: () => false }; };
  const { e } = await call(s);
  check(e?.message === "today's run" && s.log.asked === 1 && s.log.fallback === 1 && s.log.started.length === 0 && s.log.stops === 0 && s.log.saves === 0 && s.log.closed === 1,
    `"fallback": today's run, no cell started or stopped on the page, nothing saved there, the page's run closed (${e?.message})`);
  check(s.holder.current === null, "\"fallback\": nothing held after (the run's holder as before the call)");
}
{
  let go;
  const s = setup({ open: true, inputs: () => new Promise((r) => (go = r)) });
  const p = call(s);
  await until(() => !!go);
  stop(s.ctx, s.holder);
  go("fallback");
  const { r, e } = await p;
  check(!e && r?.ended === "stopped" && s.log.fallback === 0 && s.holder.current === null, `Stop before the page's "fallback": stopped, no today's run after (${JSON.stringify(r ?? e?.message)})`);
}
{
  // (the deadline it was asked with carries over: 1 s asked, the page's "fallback" at 0.6 s, today's run (its snapshot
  //  slow here, 2 s) ended by that same deadline at about 1 s, its line let go then, not a fresh second after the fallback)
  const s = setup({ open: true, todayDelay: 2000, inputs: () => new Promise((r) => setTimeout(() => r("fallback"), 600)) });
  const t0 = performance.now();
  const { r, e } = await call(s, "/labs/n.ipynb", { timeout_s: 1 });
  const ends = s.holder.hides.map((t) => Math.round(t - t0));
  const last = ends[ends.length - 1] ?? -1;
  check(s.log.fallback === 1 && last >= 900 && last < 1400 && (r?.ended === "timeout" || !!e), `"fallback": today's run under the same deadline (its end at ${last} ms of 1000; ${JSON.stringify(r ?? e?.message)})`);
}
// ---- busy: refused, never the other run
{
  const s = setup({ open: true });
  s.holder.current = { owner: "g2", view: "/x", stop() {} };
  const { e } = await call(s);
  check(e?.code === "busy" && s.log.asked === 0 && s.log.fallback === 0, `another run on the page: busy, neither run (${e?.code})`);
}
{
  const s = setup({ open: true, hold: ["a"] });
  const first = call(s);
  await until(() => s.waits.has("a"));
  const { e } = await call(s);
  check(e?.code === "busy" && s.log.asked === 1 && s.log.fallback === 0, `the page's run going: a second call busy, no fallback (${e?.code}: ${e?.message})`);
  s.waits.get("a")();
  await first;
}

// ---- a failure once chosen: thrown, today's run never after
{
  const s = setup({ open: true, answer: () => { throw new Error("page failed"); } });
  const { e } = await call(s);
  check(e?.message === "page failed" && s.log.fallback === 0 && s.holder.current === null && s.log.closed === 1, "a cell's failure: the error, no fallback, the run let go");
}
{
  const many = { mode: "python", cells: Array.from({ length: RUN_LIMITS.cells + 1 }, (_, i) => ({ id: "c" + i, type: "code", code: "" })) };
  const s = setup({ open: true, doc: many });
  const { e } = await call(s);
  check(e?.code === "too_large" && s.log.started.length === 0 && s.log.fallback === 0, `too many cells as shown: refused, nothing run, no fallback (${e?.code})`);
}
{
  const s = setup({ open: true });
  s.host.inPage = () => { throw new Error("page broke"); };
  const { e } = await call(s);
  check(e?.message === "page broke" && s.log.fallback === 0, "the page's own failure choosing: the error, no fallback");
}

// ---- ended while a cell runs: no later cell, nothing it said returned (its late answer included), no fallback
const during = async (what, act, want) => {
  const s = setup({ open: true, hold: ["a"], answer: (id, out) => (out.add("LATE " + id), { status: "ok", images: { count: 3, bytes: 9 } }) });
  const p = call(s, "/labs/n.ipynb", what === "timeout" ? { timeout_s: 1 } : {});
  await until(() => s.waits.has("a"));
  await act(s);
  // (answered without waiting for the cell: the interpreter didn't stop, and its answer comes after the end)
  const { r, e } = await Promise.race([p, new Promise((go) => setTimeout(() => go({ e: new Error("waited for the cell") }), 1500))]);
  s.waits.get("a")();
  await p;
  await new Promise((go) => setTimeout(go, 20));
  const text = JSON.stringify(r ?? {});
  check(!e && r.ok === false && r.ended === want && !text.includes("LATE") && !("cells" in r) && JSON.stringify(s.log.started) === '["a"]' && s.log.stops >= 1 && s.log.fallback === 0 && s.holder.current === null,
    `${what}: ended ${want}, interrupted, no later cell, no late output, no fallback: ${text} ${e?.message ?? ""}`);
  return { r, s };
};
await during("Stop", (s) => s.holder.current.stop(), "stopped");
await during("run_stop", (s) => stop(s.ctx, s.holder), "stopped");
await during("timeout", () => new Promise((r) => setTimeout(r, 1200)), "timeout");
await during("pagehide", () => dispatchEvent(new Event("pagehide")), "stopped");
await during("another notebook shown", (s) => s.show(false), "stopped");
{
  const { r } = await during("the grant's write narrowed (the same id and folders)", (s) => s.setGrant({ ...s.ctx.grantNow(), write: false, folders: ["/"] }), "revoked");
  check(r?.reason === RUN_TEXT.grantChanged, `its reason: ${r?.reason}`);
}
await during("the grant replaced (another id)", (s) => s.setGrant({ ...s.ctx.grantNow(), id: "g9" }), "revoked");
await during("May run code turned off", (s) => s.setGrant({ ...s.ctx.grantNow(), run: false }), "revoked");
await during("the grant narrowed to a folder", (s) => s.setGrant({ ...s.ctx.grantNow(), folders: ["/labs"] }), "revoked");
await during("the grant revoked", (s) => s.setGrant(null), "revoked");
{
  const s = setup({ open: true, inputsGone: true });
  const { r, e } = await call(s);
  check(!e && r?.ended === "stopped" && s.log.started.length === 0 && s.log.fallback === 0, `the generation gone before the inputs: stopped, nothing run, no fallback: ${JSON.stringify(r ?? e?.message)}`);
}

// ---- ended while the save is held (a storage lock that doesn't answer): answered at once, let go, nothing returned
const duringSave = async (what, act, want) => {
  const s = setup({ open: true, holdSave: true, saveFails: what.includes("fails") });
  const p = call(s, "/labs/n.ipynb", what.includes("timeout") ? { timeout_s: 1 } : {});
  await until(() => s.waits.has("save"));
  await act(s);
  const { r, e } = await Promise.race([p, new Promise((go) => setTimeout(() => go({ e: new Error("waited for the save") }), 1500))]);
  const free = s.holder.current === null;
  const again = s.holder.current === null ? await call(setup({ open: true }), "/labs/n.ipynb") : null;
  s.waits.get("save")();
  await new Promise((go) => setTimeout(go, 20));
  check(!e && r.ok === false && r.ended === want && !("cells" in r) && !("saved" in r) && free && again?.r?.ok === true && s.log.fallback === 0,
    `a held save, then ${what}: ended ${want} at once, the run let go, nothing returned: ${JSON.stringify(r ?? e?.message)}`);
};
await duringSave("Stop", (s) => s.holder.current.stop(), "stopped");
await duringSave("the deadline (timeout)", () => new Promise((go) => setTimeout(go, 1200)), "timeout");
await duringSave("the grant revoked", (s) => s.setGrant(null), "revoked");
await duringSave("another notebook shown", (s) => s.show(false), "stopped");
await duringSave("pagehide", () => dispatchEvent(new Event("pagehide")), "stopped");
await duringSave("the grant's write narrowed", (s) => s.setGrant({ ...s.ctx.grantNow(), write: false }), "revoked");
await duringSave("the grant replaced", (s) => s.setGrant({ ...s.ctx.grantNow(), id: "g9" }), "revoked");
await duringSave("Stop, the save then fails late", (s) => s.holder.current.stop(), "stopped");
{
  // (the page's save not proving the outputs kept: not "saved")
  const s = setup({ open: true });
  const inPage = s.host.inPage;
  s.host.inPage = (...a) => { const pr = inPage(...a); return pr && { ...pr, save: async () => false }; };
  const { r } = await call(s);
  check(r?.ok === true && r.saved === "conflict" && r.cells?.length === 2, `the save not proved: done, its cells, saved "conflict": ${JSON.stringify(r)}`);
}

// ---- found rather than told: the generation checked at each cell's end and at delivery
{
  let shownNow = true;
  const s = setup({ open: true, answer: (id, out) => { out.add("LATE"); if (id === "a") shownNow = false; return { status: "ok", images: { count: 0, bytes: 0 } }; } });
  const inPage = s.host.inPage;
  s.host.inPage = (...a) => { const pr = inPage(...a); return pr && { ...pr, current: () => shownNow }; };
  const { r } = await call(s);
  check(r?.ended === "stopped" && !JSON.stringify(r).includes("LATE") && JSON.stringify(s.log.started) === '["a"]' && s.log.saves === 0, `another generation found after a cell: stopped, nothing returned, not saved here: ${JSON.stringify(r)}`);
}
{
  let shownNow = true;
  const s = setup({ open: true });
  const inPage = s.host.inPage;
  s.host.inPage = (...a) => { const pr = inPage(...a); return pr && { ...pr, current: () => shownNow, save: async () => { shownNow = false; return false; } }; };
  const { r } = await call(s);
  check(r?.ended === "stopped" && !("cells" in r), `another generation found at the save: stopped, no cells: ${JSON.stringify(r)}`);
}

console.log(`${checks - fails.length}/${checks} checks`);
if (fails.length) { console.log("FAILED:\n" + fails.join("\n")); process.exit(1); }
