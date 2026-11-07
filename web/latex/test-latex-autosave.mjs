// ci: checks.3 order=108 runner=bun
// (no browser, about 1 s: autosave.ts alone, with fakes; in CI through the registry, as test-latex-run and -units are)
// The LaTeX editor's autosave (autosave.ts; plan U8 r6, on top of #599), without a browser: a fake file (revisions,
// writes that can be held or made to fail), a fake page modelling page.ts's writeText (#599: compare-and-swap on the
// revision its saved text came from; a change made elsewhere opens its bar, and nothing is written while it asks),
// fake drafts (per fid and writer) and manual timers. Each case is one of the plan's: snapshots, one write at a time,
// the bar, settling, failures, two writers, recovery, closing.
//   bun web/latex/test-latex-autosave.mjs
import { AutoSaver, DEBOUNCE_MS } from "./autosave.ts";
import { leaver } from "./leave.ts";

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// (one file, shared by every editor of a test: its text, revision and versions)
function fakeFile(text = "start") {
  const f = { text, rev: 1, versions: [], writes: 0, hold: null, failNext: null, keepFail: null, inFlight: 0, maxInFlight: 0 };
  f.outside = (t) => { f.versions.push(f.text); f.text = t; f.rev++; };
  return f;
}
// (the page's side, as page.ts: its baseline (savedText, docRev), its bar (conflict) and a choice under way (acting))
function fakePage(f) {
  const p = { savedText: f.text, docRev: f.rev, conflict: false, acting: false, readonly: false, bars: 0 };
  p.io = {
    async write(text) {
      if (p.readonly) return "readonly";
      if (p.conflict || p.acting) return "blocked";
      const base = p.docRev;
      f.inFlight++; f.maxInFlight = Math.max(f.maxInFlight, f.inFlight);
      try {
        if (f.hold) await f.hold;
        if (f.failNext) { const e = f.failNext; f.failNext = null; throw e; }
        if (base !== f.rev) { p.conflict = true; p.bars++; return "blocked"; }
        f.versions.push(f.text); f.text = text; f.rev++; f.writes++;
        p.savedText = text; p.docRev = f.rev;
        return "saved";
      } finally { f.inFlight--; }
    },
    async keepVersion(text) { if (f.keepFail) throw f.keepFail; f.versions.push(text); },
  };
  return p;
}
function fakeDrafts() {
  const m = new Map();
  const d = {
    m, putFail: null, putAsync: null,
    put(x) {
      if (d.putFail) throw d.putFail;
      if (d.putAsync) { const p = d.putAsync; return p.then(() => { m.set(x.fid + "|" + x.writerId, { ...x }); }); }
      m.set(x.fid + "|" + x.writerId, { ...x }); return true;
    },
    async drop(fid, w, upTo) { const k = fid + "|" + w, r = m.get(k); if (r && r.gen <= upTo) m.delete(k); },
    async all(fid) { if (d.allHold) await d.allHold; return [...m.values()].filter((r) => r.fid === fid); },
  };
  return d;
}
function fakeTimers() {
  const t = { q: [] };
  t.set = (f, ms) => { const h = { f, ms }; t.q.push(h); return h; };
  t.clear = (h) => { t.q = t.q.filter((x) => x !== h); };
  t.fire = () => { const q = t.q; t.q = []; for (const h of q) h.f(); };
  return t;
}
let wid = 0;
function editor(f, drafts, timers, page = fakePage(f)) {
  const ed = { text: page.savedText, ro: [], states: [], adopted: [], stale: 0, page };
  const writerId = (++wid).toString(16).padStart(32, "0");
  ed.saver = new AutoSaver(page.io, drafts, { fid: "F", writerId, path: () => "/a.tex" }, {
    text: () => ed.text, dirty: () => ed.text !== page.savedText, rev: () => page.docRev,
    blocked: () => page.conflict || page.acting,
    adopt: (t) => { ed.text = t; ed.adopted.push(t); }, stale: () => { ed.stale++; page.conflict = true; },
    readOnly: (on) => ed.ro.push(on), state: (s) => ed.states.push(s),
  }, timers, () => 0);
  ed.type = (t) => { ed.text = t; ed.saver.edited(); };
  ed.writerId = writerId;
  ed.draft = () => drafts.m.get("F|" + writerId);
  return ed;
}

// ---- 1. an edit: its draft at once, the write after the debounce; acknowledged: Saved ✓, the draft gone
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("one");
  check("edit-draft-now", e.draft()?.text === "one" && e.draft().gen === 1 && e.draft().baseRev === 1 && f.writes === 0 && t.q.length === 1 && t.q[0].ms === DEBOUNCE_MS && e.saver.state.k === "edited", { d: [...d.m.values()], st: e.saver.state });
  t.fire(); await settle();
  check("edit-written-then-saved", f.text === "one" && e.saver.state.k === "saved" && !e.draft() && e.states.some((s) => s.k === "saving"), { f: f.text, st: e.saver.state });
}

// ---- 2. U8-SNAPSHOT-1: typing during a held write: its ack removes its own gen's draft only; the newer text gets the
// next write, scheduled as after any edit
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  let release; f.hold = new Promise((r) => (release = r));
  e.type("first"); t.fire(); await tick();
  e.type("second");
  release(); f.hold = null; await settle();
  check("snapshot-ack-own-gen-only", f.text === "first" && e.draft()?.gen === 2 && e.draft().text === "second" && e.saver.state.k !== "saved" && t.q.length === 1, { f: f.text, st: e.saver.state, d: e.draft() });
  t.fire(); await settle();
  check("snapshot-next-write", f.text === "second" && !e.draft() && e.saver.state.k === "saved", { f: f.text, st: e.saver.state });
}

// ---- 3. Ctrl/Cmd+S (flush): written at once, the debounce cancelled; nothing pending: Saved ✓, nothing written
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("now");
  const ok = await e.saver.flush();
  check("flush-at-once", ok && f.text === "now" && f.writes === 1 && t.q.length === 0 && e.saver.state.k === "saved", { ok, f: f.text, q: t.q.length });
  const ok2 = await e.saver.flush();
  check("flush-nothing-pending", ok2 && f.writes === 1 && e.saver.state.k === "saved", { ok2, w: f.writes });
}

// ---- 4. one write at a time: flushes asked for during a held write wait for it, then write the newest text once
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  let release; f.hold = new Promise((r) => (release = r));
  e.type("a"); const p1 = e.saver.flush(); await tick();
  e.type("ab"); const p2 = e.saver.flush(), p3 = e.saver.flush();
  release(); f.hold = null;
  const r = await Promise.all([p1, p2, p3]); await settle();
  check("one-write-at-a-time", f.maxInFlight === 1 && f.text === "ab" && f.writes === 2 && r.every(Boolean) && !e.draft(), { max: f.maxInFlight, f: f.text, w: f.writes, r });
}

// ---- 5. #599's bar: the file changed elsewhere before the write: nothing written, "blocked"; edits made while it
// asks are durable in the draft, and nothing is scheduled
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine");
  f.outside("theirs");
  t.fire(); await settle();
  check("changed-elsewhere-blocked", f.text === "theirs" && f.writes === 0 && e.saver.state.k === "blocked" && e.page.bars === 1 && e.draft()?.text === "mine", { f: f.text, st: e.saver.state });
  e.type("mine 2");
  check("blocked-edit-draft-only", e.draft()?.text === "mine 2" && t.q.length === 0 && e.saver.state.k === "blocked", { q: t.q.length, st: e.saver.state });
  const ok = await e.saver.flush();
  check("blocked-flush-writes-nothing", !ok && f.text === "theirs" && f.writes === 0, { ok, f: f.text });
}

// ---- 6. held(): the bar shown by a check (not a write): the scheduled write cancelled, "blocked"
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("x");
  e.page.conflict = true; e.saver.held();
  check("held-cancels-write", t.q.length === 0 && e.saver.state.k === "blocked", { q: t.q.length });
  // (a choice under way (acting) blocks a write as the bar does)
  e.page.conflict = false; e.page.acting = true;
  const ok = await e.saver.flush();
  check("acting-blocks-write", !ok && f.writes === 0 && e.saver.state.k === "blocked", { ok, w: f.writes });
}

// ---- 7. settled(): Keep mine written by the page at gen g, typed since: drafts up to g removed, the newer pending
// text scheduled and written; Use theirs taken: drafts removed, Saved ✓
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine"); f.outside("theirs"); t.fire(); await settle();
  // (Keep mine: the page writes the text at gen 1 over the bar's revision)
  const g = e.saver.gen; e.page.acting = true;
  f.versions.push(f.text); f.text = e.text; f.rev++; e.page.savedText = e.text; e.page.docRev = f.rev;
  e.type("mine+");
  e.page.acting = false; e.page.conflict = false;
  e.saver.settled(g);
  await settle();
  check("settled-keep-mine-newer-pending", e.draft()?.gen === 2 && t.q.length === 1 && e.saver.state.k === "edited", { d: e.draft(), q: t.q.length, st: e.saver.state });
  t.fire(); await settle();
  check("settled-then-written", f.text === "mine+" && !e.draft() && e.saver.state.k === "saved", { f: f.text });
}
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine"); f.outside("theirs"); t.fire(); await settle();
  // (Use theirs: the page installs their text as its baseline)
  e.text = f.text; e.page.savedText = f.text; e.page.docRev = f.rev; e.page.conflict = false;
  e.saver.settled(); await settle();
  check("settled-use-theirs", !e.draft() && e.saver.state.k === "saved" && t.q.length === 0 && f.text === "theirs", { d: e.draft(), st: e.saver.state });
}

// ---- 8. a failed write: Not saved with its reason, kept (failed: the one state that keeps the leave prompt), the
// draft kept; the next edit writes again; written, Saved ✓
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  f.failNext = new Error("storage is full");
  e.type("lost?"); t.fire(); await settle();
  check("failed-shown-and-kept", e.saver.failed && e.saver.state.why === "storage is full" && e.draft()?.text === "lost?" && f.text === "start", { st: e.saver.state });
  e.type("lost? no");
  check("failed-stays-until-written", e.saver.failed && t.q.length === 1, { st: e.saver.state });
  t.fire(); await settle();
  check("failed-then-saved", !e.saver.failed && e.saver.state.k === "saved" && f.text === "lost? no" && !e.draft(), { st: e.saver.state, f: f.text });
}

// ---- 9. the draft can't be kept: Not saved, said (a draft store that throws; a large draft's write that fails)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  d.putFail = new Error("QuotaExceededError");
  e.type("x");
  check("draft-put-throws-failed", e.saver.failed && /couldn't keep a copy of your edits \(QuotaExceededError\)/.test(e.saver.state.why), e.saver.state);
}
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  d.putAsync = Promise.reject(new Error("idb aborted")); d.putAsync.catch(() => {});
  e.type("big"); await settle();
  check("draft-large-put-fails-failed", e.saver.failed && /idb aborted/.test(e.saver.state.why), e.saver.state);
}

// ---- 9b. a file that can't be saved here (the page's write says "readonly", grader #551 A2): nothing written, not
// Saved, the draft kept (the edits aren't lost), and no failed state (no leave prompt)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.page.readonly = true;
  e.type("mixed endings edit");
  const ok = await e.saver.flush();
  check("readonly-write-keeps-draft", !ok && e.saver.state.k === "readonly" && !e.saver.failed && e.draft()?.text === "mixed endings edit" && f.writes === 0, { ok, st: e.saver.state, d: e.draft() });
}

// ---- 10. two editors of one file (two tabs): each its own draft, never replacing the other's
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), a = editor(f, d, t), b = editor(f, d, t);
  a.type("from a"); b.type("from b");
  check("two-writers-two-drafts", a.draft()?.text === "from a" && b.draft()?.text === "from b" && d.m.size === 2, [...d.m.keys()]);
}

// ---- 11. recovery on open (the editors that left drafts are gone: their timers cleared): one draft another editor left, made on this revision: put in the editor (read-only
// meanwhile), written, the old draft removed
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const old = editor(f, d, t); old.type("unsaved before close"); t.q = [];
  const e = editor(f, d, t);
  const r = await e.saver.recover(e.page.savedText);
  check("recover-one-adopted", r.recovered === 1 && e.text === "unsaved before close" && e.ro[0] === true && e.ro.at(-1) === false && !old.draft() && e.draft()?.text === "unsaved before close" && e.stale === 0, { r, ro: e.ro, d: [...d.m.values()] });
  t.fire(); await settle();
  check("recover-one-written", f.text === "unsaved before close" && !e.draft(), { f: f.text });
}
// (made on an older revision: the page's bar first, nothing written)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const old = editor(f, d, t); old.type("old edits"); t.q = [];
  f.outside("changed since");
  const e = editor(f, d, t);
  const r = await e.saver.recover(e.page.savedText);
  t.fire(); await settle();
  check("recover-stale-bar-first", r.recovered === 1 && e.stale === 1 && e.text === "old edits" && f.text === "changed since" && f.writes === 0 && e.draft()?.text === "old edits" && e.saver.state.k === "blocked", { r, st: e.saver.state, f: f.text });
}
// (one writer's two records, as while a draft moves between drafts.ts's two stores: its newest gen is the one
//  recovered, never the older text; grader #551 A5)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const W = "f".repeat(32), rec = (gen, text) => ({ fid: "F", writerId: W, gen, path: "/a.tex", baseRev: 1, text, t: 0 });
  d.all = async () => [rec(2, "new"), rec(1, "old")];
  const e = editor(f, d, t);
  const r = await e.saver.recover(e.page.savedText);
  d.all = async () => [rec(1, "old"), rec(2, "new")];
  const e2 = editor(f, d, t);
  const r2 = await e2.saver.recover(e2.page.savedText);
  check("recover-newest-gen-of-a-writer", r.recovered === 1 && e.text === "new" && r2.recovered === 1 && e2.text === "new", { r, t: e.text, r2, t2: e2.text });
}
// (several: each kept as a version, none chosen; equal to the file: dropped)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const a = editor(f, d, t), b = editor(f, d, t), c = editor(f, d, t);
  a.type("draft a"); b.type("draft b"); c.type("start"); t.q = [];
  const e = editor(f, d, t);
  const r = await e.saver.recover(e.page.savedText);
  check("recover-several-kept-as-versions", r.recovered === 0 && r.kept === 2 && f.versions.includes("draft a") && f.versions.includes("draft b") && e.text === "start" && d.m.size === 0 && f.writes === 0, { r, v: f.versions, n: d.m.size });
}
// (an edit made while the drafts were read: the draft never replaces it; kept as a version)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const old = editor(f, d, t); old.type("left behind"); t.q = [];
  const e = editor(f, d, t);
  let release; d.allHold = new Promise((r) => (release = r));
  const p = e.saver.recover(e.page.savedText);
  e.type("typed now"); d.allHold = null; release();
  const r = await p;
  check("recover-never-replaces-typing", r.recovered === 0 && r.kept === 1 && e.text === "typed now" && f.versions.includes("left behind"), { r, t: e.text });
}
// (the adopted draft's own record not durable (a large one whose write failed): the old writer's draft kept)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const old = editor(f, d, t); old.type("only copy"); t.q = [];
  const e = editor(f, d, t);
  d.putAsync = Promise.reject(new Error("idb aborted")); d.putAsync.catch(() => {});
  await e.saver.recover(e.page.savedText);
  check("recover-old-draft-kept-until-durable", old.draft()?.text === "only copy", [...d.m.values()]);
}
// (keeping a version fails: the draft stays, for the next open)
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers();
  const a = editor(f, d, t), b = editor(f, d, t); a.type("A"); b.type("B"); t.q = [];
  f.keepFail = new Error("no space");
  const e = editor(f, d, t);
  const r = await e.saver.recover(e.page.savedText);
  check("recover-keep-fails-draft-stays", r.kept === 0 && a.draft()?.text === "A" && b.draft()?.text === "B", { r });
}

// ---- 12. closing (a switch to another file, the page going away): what is pending written first; after it, no UI
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("closing");
  const ok = await e.saver.dispose();
  const n = e.states.length;
  e.type("after"); e.saver.settled(); e.saver.held();
  check("dispose-flushes", ok && f.text === "closing" && !e.draft(), { ok, f: f.text });
  check("dispose-then-no-ui", e.states.length === n && t.q.length === 0, { n, now: e.states.length });
}
{
  const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
  e.type("mine"); f.outside("theirs"); t.fire(); await settle();
  const ok = await e.saver.dispose();
  // (settled: nothing written over theirs, and the edit durable in its draft, so the close is released)
  check("dispose-blocked-writes-nothing-draft-kept", ok && f.text === "theirs" && e.draft()?.text === "mine", { ok, f: f.text });
}

// ---- 13. a controlled close waits until the latest edit is written or durable (astra U8-DURABLE-CLOSE-1): with the
// write not done (blocked, refused, read-only) and the draft a large one whose put is held, dispose resolves only
// when that put lands (true), or false when it fails; an edit made while it waits is waited for too
{
  const setups = {
    blocked: (e) => { e.page.conflict = true; },
    failed: (e, f) => { f.failNext = new Error("workspace unavailable"); },
    readonly: (e) => { e.page.readonly = true; },
  };
  for (const [kind, setup] of Object.entries(setups)) {
    for (const outcome of ["lands", "fails"]) {
      const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
      setup(e, f);
      let land, fail; d.putAsync = new Promise((res, rej) => { land = res; fail = rej; }); d.putAsync.catch(() => {});
      e.type("LATEST");
      let closed = null; const p = e.saver.dispose().then((v) => (closed = v));
      await settle();
      const waited = closed === null;
      if (outcome === "lands") land(); else fail(new Error("idb aborted"));
      await p; await settle();
      check(`close-waits-durable-${kind}-${outcome}`, waited && closed === (outcome === "lands") && f.writes === 0, { waited, closed, st: e.saver.state });
    }
  }
  // (a newer edit while the close waits: its own put waited for, the older one's landing isn't enough)
  {
    const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
    e.page.readonly = true;
    let land1; d.putAsync = new Promise((res) => (land1 = res));
    e.type("one");
    let closed = null; const p = e.saver.settle().then((v) => (closed = v));
    await settle();
    let land2; d.putAsync = new Promise((res) => (land2 = res));
    e.type("one two");
    land1(); await settle();
    const stillWaiting = closed === null;
    land2(); await p;
    check("close-waits-for-a-newer-edit", stillWaiting && closed === true, { stillWaiting, closed });
  }
  // (nothing pending, or written: settled at once)
  {
    const f = fakeFile(), d = fakeDrafts(), t = fakeTimers(), e = editor(f, d, t);
    const clean = await e.saver.settle();
    e.type("written"); const wrote = await e.saver.settle();
    check("settle-clean-or-written", clean && wrote && f.text === "written", { clean, wrote, f: f.text });
  }
}

// ---- leaving (leave.ts, page.ts's leaveOk): the editor shown settled, held, and only the newest intent going on.
// Fake editors: settle() resolved by the test, dirty() set by it, every hold recorded in one log (grader H10b, R2, R3)
{
  const log = [];
  const ed = (name, { dirty = false } = {}) => { const e = { name, dirtyNow: dirty, settles: 0, res: null };
    e.settle = () => { e.settles++; return new Promise((r) => (e.res = r)); };
    e.dirty = () => e.dirtyNow;
    e.hold = (on) => log.push(name + (on ? "+" : "-"));
    return e; };
  const run = (cur, asks, answer = true) => leaver(() => cur.v, (lost) => { asks.push(lost); return answer; });
  // (1) the editor shown replaced under the wait, no newer intent (the mount's placeholder by its file's editor): the
  //     new one held and settled, the old one let go first, and the answer the new one's (H10b, R1, R2)
  {
    log.length = 0; const P = ed("P"), E = ed("E"), cur = { v: P }, asks = [];
    const { leaveOk } = run(cur, asks);
    const r = leaveOk(); await tick();
    cur.v = E; P.res(true); await settle();
    const settledE = E.settles; E.res?.(true); const out = await r;
    check("leave: the editor shown replaced under the wait: the new one held and settled, the request kept (H10b, R1)",
      out === true && settledE === 1 && log.includes("E+") && asks.length === 0, { out, settledE, log: [...log], asks });
    check("leave: the replaced editor let go before the new one is held (R2)",
      log.indexOf("P-") !== -1 && log.indexOf("P-") < log.indexOf("E+"), { log: [...log] });
  }
  // (1b) the same, the new editor's write failed and its draft not kept: asked (LEAVE_LOST); declined, let go
  {
    log.length = 0; const P = ed("P"), E = ed("E", { dirty: true }), cur = { v: P }, asks = [];
    const { leaveOk } = run(cur, asks, false);
    const r = leaveOk(); await tick();
    cur.v = E; P.res(true); await settle(); E.res?.(false); const out = await r;
    check("leave: the new editor's edit in neither the file nor a draft: asked as lost, declined, the new editor let go",
      out === false && asks.length === 1 && asks[0] === true && log[log.length - 1] === "E-", { out, asks, log: [...log] });
  }
  // (2) a newer intent and the editor replaced, both under the wait: the leave does nothing, and the new editor is never
  //     held by it (the newer intent comes first: R3)
  {
    log.length = 0; const P = ed("P"), E = ed("E"), cur = { v: P }, asks = [];
    const { leaveOk, intent } = run(cur, asks);
    const r = leaveOk(); await tick();
    cur.v = E; intent(); P.res(true); await settle();
    if (E.res) E.res(true);
    const out = await r;
    check("leave: a newer intent and the editor replaced: nothing done, the new editor never held by it (R3)",
      out === null && !log.includes("E+") && E.settles === 0 && log.includes("P-") && asks.length === 0, { out, log: [...log], settlesE: E.settles, asks });
  }
  // (3) two leaves on the same editor: the older, superseded, lets go of nothing the newer holds; the newer asks once
  {
    log.length = 0; const A = ed("A", { dirty: true }), cur = { v: A }, asks = [];
    const { leaveOk } = run(cur, asks, false);
    const settles = [];
    const r1 = leaveOk(); await tick(); settles.push(A.res);
    const r2 = leaveOk(); await tick(); settles.push(A.res);
    settles[0](true); await settle();
    const midLog = [...log];
    settles[1](true); const [o1, o2] = await Promise.all([r1, r2]);
    check("leave: two leaves: the older superseded lets go of nothing; the newer asks once and, declined, lets go (H4)",
      o1 === null && o2 === false && !midLog.includes("A-") && asks.length === 1 && log[log.length - 1] === "A-", { o1, o2, midLog, log: [...log], asks });
  }
}

const failed = results.filter(([, ok]) => !ok);
console.log(`${results.length - failed.length}/${results.length} autosave checks passed`);
if (failed.length) process.exit(1);
