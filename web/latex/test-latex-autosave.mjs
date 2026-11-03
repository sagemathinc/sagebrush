// The LaTeX editor's autosave (autosave.ts; plan U8 r5, astra's DATA PLAN CLEAR 089b329b), without a browser: a fake
// file (revisions, compare-and-swap, writes that can be held or made to fail), fake drafts (per fid and writer) and
// manual timers. Each case is one of the plan's: snapshots, echoes, conflicts and their choices, two writers, recovery,
// failures, a write that lands after the editor was closed.
//   bun web/latex/test-latex-autosave.mjs
import { AutoSaver, DEBOUNCE_MS } from "./autosave.ts";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const dec = (b) => new TextDecoder().decode(b);

// (one file, shared by every editor of a test: its text, revision and versions)
function fakeFile(text = "start") {
  const f = { text, rev: 1, versions: [], writes: 0, hold: null, holdAfter: null, failNext: null, keepHold: null, keepFail: null };
  f.io = () => ({
    async write(bytes, base) {
      if (f.hold) await f.hold;
      if (f.failNext) { const e = f.failNext; f.failNext = null; throw e; }
      if (base !== f.rev) throw Object.assign(new Error("changed elsewhere"), { code: "conflict" });
      f.versions.push(f.text); f.text = dec(bytes); f.rev++; f.writes++;
      if (f.onWrite) f.onWrite(f.rev);
      // (committed, its promise not yet resolved: an echo can come now)
      if (f.holdAfter) await f.holdAfter;
      return f.rev;
    },
    async current() { return { text: f.text, rev: f.rev }; },
    async keepVersion(text) { if (f.keepHold) await f.keepHold; if (f.keepFail) throw f.keepFail; f.versions.push(text); },
    encode: (t) => new TextEncoder().encode(t),
  });
  f.outside = (t) => { f.versions.push(f.text); f.text = t; f.rev++; };
  return f;
}
function fakeDrafts() {
  const m = new Map();
  return {
    m,
    put(d) { m.set(d.fid + "|" + d.writerId, { ...d }); return true; },
    async drop(fid, w, upTo) { const k = fid + "|" + w, d = m.get(k); if (d && d.gen <= upTo) m.delete(k); },
    async all(fid) { return [...m.values()].filter((d) => d.fid === fid); },
  };
}
function fakeTimers() {
  const t = { q: [] };
  t.set = (f, ms) => { const h = { f, ms }; t.q.push(h); return h; };
  t.clear = (h) => { t.q = t.q.filter((x) => x !== h); };
  t.fire = () => { const q = t.q; t.q = []; for (const h of q) h.f(); };
  return t;
}
let wid = 0;
function editor(file, drafts, timers, init) {
  const ed = { text: init?.text ?? file.text, ro: false, states: [], set: [] };
  const writerId = (++wid).toString(16).padStart(32, "0");
  ed.saver = new AutoSaver(file.io(), drafts, { fid: "F", writerId, path: () => "/a.tex" }, { text: ed.text, rev: init?.rev ?? file.rev }, {
    text: () => ed.text, setText: (t) => { ed.text = t; ed.set.push(t); }, readOnly: (on) => { ed.ro = on; }, state: (s) => ed.states.push(s),
  }, timers, () => 0);
  ed.type = (t) => { ed.text = t; ed.saver.edited(); };
  ed.writerId = writerId;
  return ed;
}

// ---- 1. an edit: its draft at once, the write after the debounce; acknowledged: Saved, the draft gone
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("one");
  check("edit-draft-now", d.m.get("F|" + e.writerId)?.text === "one" && d.m.get("F|" + e.writerId).gen === 1 && f.writes === 0 && t.q.length === 1 && t.q[0].ms === DEBOUNCE_MS, [...d.m.values()]);
  t.fire(); await settle();
  check("edit-written-then-saved", f.text === "one" && e.saver.state.k === "saved" && !d.m.has("F|" + e.writerId) && e.saver.ackGen === 1, { f: f.text, st: e.saver.state, d: [...d.m.keys()] });
}

// ---- 2. U8-SNAPSHOT-1: typing during a held write: its ack covers its snapshot only; the newer text the next write's
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  let release; f.hold = new Promise((r) => (release = r));
  e.type("first"); t.fire(); await tick();
  e.type("second");
  release(); f.hold = null; await settle();
  check("snapshot-ack-own-gen-only", f.text === "first" && e.saver.ackGen === 1 && e.saver.pending && e.saver.state.k !== "saved" && d.m.get("F|" + e.writerId)?.gen === 2, { f: f.text, st: e.saver.state, ack: e.saver.ackGen });
  t.fire(); await settle();
  check("snapshot-next-write-newer", f.text === "second" && e.saver.state.k === "saved" && !d.m.has("F|" + e.writerId), { f: f.text, st: e.saver.state });
}

// ---- 3. an echo of this editor's own write, delivered before the write resolves: no conflict, no reload
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  let release; f.holdAfter = new Promise((r) => (release = r));
  e.type("mine"); t.fire(); await tick();
  check("echo-file-committed", f.text === "mine" && f.rev === 2, f.rev);
  const ext = e.saver.external();
  await tick(); release(); f.holdAfter = null; await ext; await settle();
  check("echo-before-resolve", f.text === "mine" && !e.saver.conflict && e.set.length === 0 && e.saver.state.k === "saved", { st: e.saver.state, set: e.set });
}

// ---- 4. changed elsewhere with nothing pending: the editor takes the new text
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  f.outside("theirs"); await e.saver.external();
  check("outside-clean-reload", e.text === "theirs" && e.saver.rev === f.rev && !e.saver.conflict, { text: e.text });
}

// ---- 5. U8-CONFLICT-1: changed elsewhere with edits pending: nothing written; Keep mine on the exact revision shown;
// a third writer since: a new conflict, never an overwrite
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine"); f.outside("theirs"); await e.saver.external();
  check("conflict-opened", e.saver.conflict?.text === "theirs" && e.saver.state.k === "conflict" && f.text === "theirs" && t.q.length === 0, { st: e.saver.state });
  t.fire(); await e.saver.flush();
  check("conflict-nothing-written", f.text === "theirs" && d.m.get("F|" + e.writerId)?.text === "mine", f.text);
  f.outside("third");
  const ok1 = await e.saver.keepMine();
  check("keepmine-third-writer-new-conflict", !ok1 && f.text === "third" && e.saver.conflict?.text === "third", { f: f.text, c: e.saver.conflict });
  const ok2 = await e.saver.keepMine();
  check("keepmine-written", ok2 && f.text === "mine" && f.versions.includes("third") && !e.saver.conflict && e.saver.state.k === "saved" && !d.m.has("F|" + e.writerId), { f: f.text, st: e.saver.state });
}

// ---- 6. U8-CONFLICT-2: Use theirs keeps mine as a version first, read-only meanwhile; typing that got through anyway,
// or a failure keeping mine: nothing replaced, the conflict stays
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine"); f.outside("theirs"); await e.saver.external();
  let release; f.keepHold = new Promise((r) => (release = r));
  const p = e.saver.useTheirs(); await tick();
  check("usetheirs-readonly-meanwhile", e.ro === true && e.saver.state.k === "preserving", { ro: e.ro, st: e.saver.state });
  e.type("mine, newer");
  release(); f.keepHold = null; const ok = await p;
  check("usetheirs-typed-meanwhile-kept", !ok && e.text === "mine, newer" && e.saver.conflict && f.versions.includes("mine") && d.m.get("F|" + e.writerId)?.text === "mine, newer" && e.ro === false, { text: e.text, v: f.versions });
  f.keepFail = new Error("quota");
  const ok2 = await e.saver.useTheirs();
  check("usetheirs-keep-failed-nothing-replaced", !ok2 && e.text === "mine, newer" && e.saver.conflict && /couldn't be kept/.test(e.saver.state.why ?? ""), e.saver.state);
  f.keepFail = null;
  const ok3 = await e.saver.useTheirs();
  check("usetheirs-done", ok3 && e.text === "theirs" && f.versions.includes("mine, newer") && !e.saver.conflict && !d.m.has("F|" + e.writerId) && e.saver.state.k === "saved", { text: e.text, d: [...d.m.keys()] });
}

// ---- 7. U8-DURABLE-2: two editors (tabs) of one file: their own drafts, equal gens; an ack removes only its writer's
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), a = editor(f, d, t), b = editor(f, d, t);
  a.type("from a"); b.type("from b");
  check("two-writers-own-drafts", d.m.get("F|" + a.writerId)?.text === "from a" && d.m.get("F|" + b.writerId)?.text === "from b" && d.m.get("F|" + a.writerId).gen === d.m.get("F|" + b.writerId).gen, [...d.m.values()]);
  await a.saver.flush();
  check("two-writers-ack-own", !d.m.has("F|" + a.writerId) && d.m.get("F|" + b.writerId)?.text === "from b", [...d.m.keys()]);
  await b.saver.flush();
  check("two-writers-second-conflicts", b.saver.conflict?.text === "from a" && d.m.get("F|" + b.writerId)?.text === "from b", b.saver.state);
}

// ---- 8. recovery on open: one draft another (closed) tab left: in the editor and written; several: each kept as a
// version, none chosen; drafts equal to the file dropped
{
  const f = fakeFile("base"), d = fakeDrafts(), t = fakeTimers();
  d.put({ fid: "F", writerId: "a".repeat(32), gen: 3, path: "/a.tex", baseRev: f.rev, text: "lost edit", t: 0 });
  const e = editor(f, d, t);
  const r = await e.saver.recover();
  check("recover-one", r.recovered === 1 && e.text === "lost edit" && f.text === "lost edit" && !d.m.has("F|" + "a".repeat(32)), { r, f: f.text, d: [...d.m.keys()] });
  const f2 = fakeFile("base"), d2 = fakeDrafts(), t2 = fakeTimers();
  d2.put({ fid: "F", writerId: "b".repeat(32), gen: 2, path: "/a.tex", baseRev: 1, text: "tab b", t: 0 });
  d2.put({ fid: "F", writerId: "c".repeat(32), gen: 2, path: "/a.tex", baseRev: 1, text: "tab c", t: 0 });
  d2.put({ fid: "F", writerId: "d".repeat(32), gen: 9, path: "/a.tex", baseRev: 1, text: "base", t: 0 });
  const e2 = editor(f2, d2, t2);
  const r2 = await e2.saver.recover();
  check("recover-several-versioned-none-chosen", r2.kept === 2 && e2.text === "base" && f2.text === "base" && f2.versions.includes("tab b") && f2.versions.includes("tab c") && d2.m.size === 0, { r2, v: f2.versions, d: [...d2.m.keys()] });
  // (a draft made on an older revision: recovered into the editor, then a conflict, nothing overwritten)
  const f3 = fakeFile("base"), d3 = fakeDrafts(), t3 = fakeTimers();
  d3.put({ fid: "F", writerId: "e".repeat(32), gen: 1, path: "/a.tex", baseRev: 0, text: "old base edit", t: 0 });
  const e3 = editor(f3, d3, t3);
  await e3.saver.recover();
  check("recover-older-base-conflict", e3.text === "old base edit" && f3.text === "base" && e3.saver.conflict?.text === "base", { st: e3.saver.state });
}

// ---- 9. a failed write: the failed state (the one that may prompt on leaving), the edits kept; written on the next edit
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  f.failNext = new Error("QuotaExceededError");
  e.type("x"); await e.saver.flush();
  check("failed-state", e.saver.failed && /Quota/.test(e.saver.state.why) && d.m.get("F|" + e.writerId)?.text === "x" && f.text === "start", e.saver.state);
  e.type("xy"); await e.saver.flush();
  check("failed-then-written", !e.saver.failed && f.text === "xy" && e.saver.state.k === "saved", { st: e.saver.state, f: f.text });
  // (a draft store that refuses: also the failed state)
  const d2 = fakeDrafts(); d2.put = () => { throw new Error("storage full"); };
  const e2 = editor(fakeFile(), d2, fakeTimers());
  e2.type("y");
  check("draft-refused-failed", e2.saver.failed && /couldn't keep a copy/.test(e2.saver.state.why), e2.saver.state);
}

// ---- 10. closed with edits pending: written after, its own draft dropped; nothing of the UI touched after closing
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  let release; f.hold = new Promise((r) => (release = r));
  e.type("closing"); t.q = [];
  const p = e.saver.dispose(); const n = e.states.length;
  e.text = "the next file's text";
  release(); f.hold = null; const ok = await p;
  check("dispose-flushes-no-ui", ok && f.text === "closing" && !d.m.has("F|" + e.writerId) && e.states.length === n, { f: f.text, states: e.states.slice(n) });
}

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: the LaTeX editor's autosave, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
