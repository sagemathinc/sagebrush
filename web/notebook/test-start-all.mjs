// web/notebook/start-all.js (sync-docs, #1 (a)): every notebook of this device whose synced history hasn't started is
// loaded as its writer and let go; the open one, one started meanwhile, one with no record and one another tab writes
// are left; one too large to send is counted, never started; a start refused for room ends the walk; a failure is
// counted and the walk goes on; leaving the page ends it; every store loaded is let go.
//   bun web/notebook/test-start-all.mjs
import { startAll, startAllSummary } from "./start-all.js";

let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const J = JSON.stringify;

// (a world of notebooks: ref -> { path, started, size, held, noRoom, throws }; the fake store as the journal's does)
function world(spec, over = {}) {
  const nb = new Map(Object.entries(spec));
  const log = { loads: [], releases: [], progress: [] };
  const s = {
    list: async () => [...nb].map(([ref, n]) => ({ ref, path: n.path })),
    startOf: async (ref) => (nb.get(ref).started ? { n: 1 } : null),
    sizeOf: async (ref) => (nb.get(ref).size === undefined ? 100 : nb.get(ref).size),
    maxBytes: 1000,
    storeFor: async (ref) => {
      const n = nb.get(ref);
      return {
        journaled: n.journaled !== false, writer: false, synced: null,
        async load() {
          log.loads.push(ref);
          if (n.throws) throw new Error("load failed");
          this.writer = !n.held;
          if (this.writer && !n.noRoom) { n.started = true; this.synced = { n: 1 }; }
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
  return { s, nb, log };
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
  // (the open one, one already started, one with no record: left)
  const { s, log } = world({ open: { path: "/open.ipynb" }, done: { path: "/done.ipynb", started: true }, gone: { path: "/gone.ipynb", size: null }, x: { path: "/x.ipynb" } }, { current: () => "open" });
  const r = await startAll(s);
  check(r.started === 1 && J(log.loads) === J(["x"]), "the open notebook, one started, one with no record: left; only the other loaded: " + J({ r, loads: log.loads }));
}
{
  // (another tab writes it: loaded read-only, counted as held, not started, let go)
  const { s, nb, log } = world({ h: { path: "/h.ipynb", held: true }, y: { path: "/y.ipynb" } });
  const r = await startAll(s);
  check(r.held === 1 && r.started === 1 && !nb.get("h").started && log.releases.includes("h"), "one another tab writes: left (held), let go: " + J(r));
}
{
  // (too large: counted by name, never loaded, and said)
  const { s, log } = world({ big: { path: "/Big one.ipynb", size: 5000 }, z: { path: "/z.ipynb" } });
  const r = await startAll(s);
  check(J(r.tooLarge) === J(["/Big one.ipynb"]) && !log.loads.includes("big") && r.started === 1, "one too large to send: counted, never loaded: " + J(r));
  check(/1 notebook is too large to sync yet \(Big one\.ipynb\)/.test(startAllSummary(r) ?? ""), "…and said by name: " + startAllSummary(r));
}
{
  // (a start refused for room: the walk ends there; the rest untouched)
  const { s, nb, log } = world({ p: { path: "/p.ipynb" }, q: { path: "/q.ipynb", noRoom: true }, r: { path: "/r.ipynb" } });
  const r = await startAll(s);
  check(r.started === 1 && J(r.noRoom) === J(["/q.ipynb"]) && !nb.get("r").started && !log.loads.includes("r") && log.releases.includes("q"), "a start refused for room ends the walk, the rest untouched, the refused one let go: " + J({ r, loads: log.loads }));
  check(/storage for sync is full/.test(startAllSummary(r) ?? ""), "…and said: " + startAllSummary(r));
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
