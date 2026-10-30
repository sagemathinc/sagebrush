// web/notebook/start-all.js (sync-docs, #1 (a)): every notebook of this device whose synced history hasn't started is
// loaded as its writer and let go; the open one, one started meanwhile and one another tab writes are left; one the
// store refuses as too large is counted by name and the walk goes on; one refused for room ends the walk; any other
// refusal or failure is counted and the walk goes on; sync turned off, or the page leaving, ends it; every store loaded
// is let go.
//   bun web/notebook/test-start-all.mjs
import { startAll, startAllSummary, journalStartOf } from "./start-all.js";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;

// (a world of notebooks: ref -> { path, started, held, refuse: "tooLarge" | "room" | "other", throws, startThrows }; the
// fake store as the journal's does: a refused start leaves `startRefused`, as store.js load keeps it)
function world(spec, over = {}) {
  const nb = new Map(Object.entries(spec));
  const log = { loads: [], releases: [], progress: [] };
  const sync = { on: true };
  const s = {
    list: async () => [...nb].map(([ref, n]) => ({ ref, path: n.path })),
    startOf: async (ref) => { if (nb.get(ref).startThrows) throw new Error("unreadable"); return nb.get(ref).started ? { n: 1 } : null; },
    syncOn: () => sync.on,
    storeFor: async (ref) => {
      const n = nb.get(ref);
      return {
        journaled: n.journaled !== false, writer: false, synced: null, startRefused: null,
        async load() {
          log.loads.push(ref);
          if (n.throws) throw new Error("load failed");
          this.writer = !n.held;
          if (n.offBeforeStart) sync.on = false;
          if (!this.writer || !sync.on) return;
          if (n.refuse) this.startRefused = { message: n.refuse, tooLarge: n.refuse === "tooLarge", room: n.refuse === "room" };
          else { n.started = true; this.synced = { n: 1 }; }
          if (n.turnsOff) sync.on = false;
        },
        async release() { log.releases.push(ref); },
      };
    },
    current: () => null,
    idle: async () => {},
    stopped: () => false,
    progress: (d, t) => log.progress.push([d, t]),
    ...over,
  };
  return { s, nb, log, sync };
}

{
  // (the common case: three notebooks, none started: all three, each let go)
  const { s, nb, log } = world({ a: { path: "/a.ipynb" }, b: { path: "/b.ipynb" }, c: { path: "/c.ipynb" } });
  const r = await startAll(s);
  check(r.total === 3 && r.started === 3 && [...nb.values()].every((n) => n.started), "every notebook not yet started is started: " + J(r));
  check(J(log.loads) === J(["a", "b", "c"]) && J(log.releases) === J(["a", "b", "c"]), "each loaded once and let go: " + J(log));
  check(J(log.progress.at(-1)) === J([3, 3]), "progress ends at the total");
  check(startAllSummary(r) === null, "nothing to tell when all started");
  // (a second walk: nothing left, nothing loaded)
  const before = log.loads.length;
  const r2 = await startAll(s);
  check(r2.total === 0 && log.loads.length === before, "a second walk finds nothing to start and loads nothing: " + J(r2));
}
{
  // (the open one and one already started: left)
  const { s, log } = world({ open: { path: "/open.ipynb" }, done: { path: "/done.ipynb", started: true }, x: { path: "/x.ipynb" } }, { current: () => "open" });
  const r = await startAll(s);
  check(r.started === 1 && J(log.loads) === J(["x"]), "the open notebook and one started: left; only the other loaded: " + J({ r, loads: log.loads }));
}
{
  // (another tab writes it: loaded read-only, counted as held, not started, let go)
  const { s, nb, log } = world({ h: { path: "/h.ipynb", held: true }, y: { path: "/y.ipynb" } });
  const r = await startAll(s);
  check(r.held === 1 && r.started === 1 && !nb.get("h").started && log.releases.includes("h"), "one another tab writes: left (held), let go: " + J(r));
}
{
  // (the store refuses it as too large: counted by name, let go, the walk goes on, and said)
  const { s, log } = world({ big: { path: "/Big one.ipynb", refuse: "tooLarge" }, z: { path: "/z.ipynb" } });
  const r = await startAll(s);
  check(J(r.tooLarge) === J(["/Big one.ipynb"]) && r.started === 1 && log.releases.includes("big") && r.noRoom.length === 0, "the store refuses one as too large: counted, let go, the walk goes on: " + J(r));
  check(/1 notebook is too large to sync yet \(Big one\.ipynb\)/.test(startAllSummary(r) ?? ""), "…and said by name: " + startAllSummary(r));
}
{
  // (refused for room: the walk ends there; the rest untouched; said as storage full)
  const { s, nb, log } = world({ p: { path: "/p.ipynb" }, q: { path: "/q.ipynb", refuse: "room" }, r: { path: "/r.ipynb" } });
  const r = await startAll(s);
  check(r.started === 1 && J(r.noRoom) === J(["/q.ipynb"]) && !nb.get("r").started && !log.loads.includes("r") && log.releases.includes("q"), "a start refused for room ends the walk, the rest untouched, the refused one let go: " + J({ r, loads: log.loads }));
  check(/storage for sync is full/.test(startAllSummary(r) ?? ""), "…and said: " + startAllSummary(r));
}
{
  // (the grader's R-SA-1: a refusal that isn't for room: failed, the walk goes on, never said as storage full)
  const { s, log } = world({ o: { path: "/o.ipynb", refuse: "other" }, w: { path: "/w.ipynb" } });
  const r = await startAll(s);
  check(J(r.failed) === J(["/o.ipynb"]) && r.noRoom.length === 0 && r.started === 1 && log.loads.includes("w") && !/storage/.test(startAllSummary(r) ?? ""), "a refusal not for room: failed, the walk goes on, not said as storage full: " + J({ r, said: startAllSummary(r) }));
}
{
  // (sync turned off mid-walk: the walk ends, nothing counted against the notebook, nothing said)
  const { s, log } = world({ t: { path: "/t.ipynb", turnsOff: true }, u2: { path: "/u2.ipynb" } });
  const r = await startAll(s);
  check(r.stopped === true && r.started === 1 && !log.loads.includes("u2") && startAllSummary(r) === null, "sync turned off mid-walk: the walk ends, nothing said: " + J(r));
  // (and turned off during a load, before its start: the store doesn't start it, and that isn't a failure or a room refusal)
  const { s: s2, log: log2, nb: nb2 } = world({ v: { path: "/v.ipynb", offBeforeStart: true } });
  const r2 = await startAll(s2);
  check(r2.stopped === true && r2.failed.length === 0 && r2.noRoom.length === 0 && !nb2.get("v").started && log2.releases.includes("v"), "sync off before a load's start: not counted as failed or room, let go: " + J(r2));
}
{
  // (astra3's N-SA-1: a notebook whose start can't be read: failed, the walk goes on)
  const { s } = world({ bad: { path: "/bad.ipynb", startThrows: true }, ok: { path: "/ok.ipynb" } });
  const r = await startAll(s);
  check(J(r.failed) === J(["/bad.ipynb"]) && r.started === 1, "a notebook whose start can't be read: failed, the others go on: " + J(r));
}
{
  // (the page's own startOf seam, journalStartOf over a journal read (index.html): a read that fails is counted as
  // failed, never passed over, whether it fails at the list's check or at the recheck before the load; astra3's N-SA-1
  // on #353 r2)
  for (const failOn of [1, 2]) {
    const { s, nb, log } = world({ bad: { path: "/bad.ipynb" }, ok: { path: "/ok.ipynb" } });
    let reads = 0;
    s.startOf = journalStartOf(async (ref) => {
      if (ref === "bad" && ++reads === failOn) throw new Error("IndexedDB: unreadable");
      return { start: nb.get(ref).started ? { n: 1 } : null, slot: null };
    });
    const r = await startAll(s);
    check(J(r.failed) === J(["/bad.ipynb"]) && r.started === 1 && log.loads.includes("ok"), `journalStartOf: a journal read failing at read ${failOn}: failed, the others go on: ` + J(r));
  }
  check(await journalStartOf(async () => ({ start: null }))("x") === null && (await journalStartOf(async () => ({ start: { n: 1 } }))("x")).n === 1, "journalStartOf: the read's start, as it is");
}
{
  // (a load that fails: counted, let go, the walk goes on)
  const { s, log } = world({ f: { path: "/f.ipynb", throws: true }, g: { path: "/g.ipynb" } });
  const r = await startAll(s);
  check(J(r.failed) === J(["/f.ipynb"]) && r.started === 1 && log.releases.includes("f"), "a failed load: counted, let go, the walk goes on: " + J(r));
}
{
  // (started meanwhile by another tab, after the list was read: checked again, not loaded)
  const { s, nb, log } = world({ m: { path: "/m.ipynb" }, n: { path: "/n.ipynb" } });
  const list = s.list;
  s.list = async () => { const l = await list(); nb.get("n").started = true; return l; };
  const r = await startAll(s);
  check(r.started === 1 && !log.loads.includes("n"), "one started meanwhile: checked again before its load, not loaded: " + J({ r, loads: log.loads }));
}
{
  // (the page leaving: the walk ends where it is)
  let n = 0;
  const { s, log } = world({ a: { path: "/a.ipynb" }, b: { path: "/b.ipynb" }, c: { path: "/c.ipynb" } }, { stopped: () => n++ >= 1 });
  const r = await startAll(s);
  check(r.stopped === true && J(log.loads) === J(["a"]), "leaving the page ends the walk where it is: " + J({ r, loads: log.loads }));
}
{
  // (a store that isn't the journal's: nothing done with it)
  const { s, log } = world({ u: { path: "/u.ipynb", journaled: false } });
  const r = await startAll(s);
  check(r.started === 0 && log.loads.length === 0, "a store that isn't the journal's: not loaded: " + J(r));
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: starting every notebook's synced history, ${checks} checks`);
process.exit(fails.length ? 1 : 0);
