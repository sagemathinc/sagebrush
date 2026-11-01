// TimeTravel replay on the full page (index.html): the execution journal,
// and replaying it to resume a session (design/timetravel-replay.md).
//
// The journal: each interpreter session (a kernel generation) gets an id and
// a seed for its entropy (web/replay-env.ts).  What it does goes into the
// history (web/notebook/history.js) of the notebook that did it: a
// "session" record at that notebook's first run, then its runs, and the
// file changes since.  The kernel is shared by the notebooks opened in a tab,
// so each notebook's journal also has, in order, the runs the session made
// for the other notebooks ("foreign" runs, with their code inline): a replay
// reruns them too, and the session is recreated from one notebook alone.
import { putBlob, getBlob } from "./notebook/stores.js";

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const newSid = () => hex(crypto.getRandomValues(new Uint8Array(8)));

/**
 * @param o.kernel the WorkerKernel
 * @param o.nb the notebook
 * @param o.history () => the current notebook's NotebookHistory, or null
 * @param o.notebookId () => the current notebook's id
 * @param o.textHash the history module's textHash, once loaded: () => fn | null
 * @param o.blobs () => Promise of the blob database (or null)
 * @param o.reproducible () => whether the notebook wants seeded entropy
 * @param o.local whether the kernel runs outside the browser
 */
export function createJournal(o) {
  const sessions = new Map(); // kernel generation -> session
  let next = null; // the session the next worker continues (a replay), or null
  let replayHandler = null; // while replaying: gets each finished run
  const pending = []; // [notebook id, records]: waiting for that notebook's history

  // ---------------------------------------------------------- sessions
  /** The Worker's name for a starting interpreter (web/replay-env.ts). */
  function workerName() {
    const gen = o.kernel.generation;
    let s;
    if (next) {
      s = next;
      next = null;
    } else {
      const seed = !o.local && o.reproducible() ? hex(crypto.getRandomValues(new Uint8Array(32))) : undefined;
      // events: the session's runs and file changes, in order ({nb, rec}): each
      // notebook is journaled up to journaled.get(nb) of them
      s = { id: newSid(), seed, files: [], events: [], n: 0, journaled: new Map(), t: Date.now(), startup: [], ms: 0, version: "" };
    }
    sessions.set(gen, s);
    for (const g of sessions.keys()) if (g < gen - 1) sessions.delete(g);
    return JSON.stringify(s.replay ? { seed: s.seed, startup: s.startup } : { seed: s.seed });
  }
  const current = () => sessions.get(o.kernel.generation) ?? null;
  /** The files sent to a starting worker: their hashes are the session's, their bytes kept. */
  async function filesSent(pairs) {
    const s = current();
    const db = await o.blobs();
    const files = [];
    for (const [path, data] of pairs) files.push([path, await putBlob(db, data)]);
    if (s && !s.replay) s.files = files;
  }
  /** The package set sent to a starting worker (null: none), before any of its code: the session's, so a replay uses it, never what is latest then. */
  function pkgsetSent(S) {
    const s = current();
    if (s && !s.replay) s.pkgset = S ?? null;
  }
  /** A replayed session's package set (null: none), or undefined when this one isn't a replay. */
  function replayPkgset() {
    const s = current();
    return s?.replay ? (s.pkgset ?? null) : undefined;
  }
  o.kernel.on("ready", () => {
    const s = current(), info = o.kernel.readyInfo;
    if (!s || !info || s.replay) return;
    s.startup = info.startup ?? [];
    s.ms = Math.round(info.ms);
    s.version = info.version;
    s.seeded = info.seeded;
  });
  const sessionRecord = (s, incomplete) => ({
    type: "session", id: s.id, t: s.t, ...(s.seed && s.seeded !== false ? { seed: s.seed } : {}), startup: s.startup, files: s.files,
    ms: s.ms, kernel: o.local ? "local" : "browser", version: s.version, ...(s.pkgset ? { pkgset: s.pkgset } : {}), ...(incomplete ? { incomplete: true } : {}),
  });

  // ---------------------------------------------------------- writing
  function write(nbId, records) {
    const h = o.history(), th = o.textHash();
    if (!h || !th || o.notebookId() !== nbId) { pending.push([nbId, records]); return; }
    for (const r of records) {
      if (r._code !== undefined) {
        r.src = th(r._code);
        if (!r.cell) r.code = r._code;
        delete r._code;
      }
    }
    h.journal(records);
  }
  /** The history of a notebook is ready: write what waited for it. */
  function flushPending(nbId) {
    const mine = pending.filter(([id]) => id === nbId);
    for (const p of mine) pending.splice(pending.indexOf(p), 1);
    const recs = mine.flatMap(([, r]) => r);
    if (recs.length) write(nbId, recs);
  }
  // Bring a notebook's journal up to date: the session's record (once), then
  // every event since its last update; another notebook's runs as foreign
  // runs (their code inline, no cell).  (Copies: the history freezes what it
  // is given, and write() completes them.)
  function journalFor(nbId, s) {
    let j = s.journaled.get(nbId);
    const recs = [];
    if (j === undefined) {
      recs.push(sessionRecord(s, false));
      j = 0;
    }
    for (const { nb, rec } of s.events.slice(j)) {
      if (rec.type !== "run" || nb === nbId) recs.push({ ...rec });
      else {
        const { cell: _c, at: _a, ...r } = rec;
        recs.push({ ...r, at: null, foreign: true });
      }
    }
    s.journaled.set(nbId, s.events.length);
    write(nbId, recs); // (write() puts a foreign run's _code inline: it has no cell)
  }

  // ---------------------------------------------------------- runs
  o.kernel.on("execute", (r) => {
    if (replayHandler) return;
    r.nb = o.notebookId();
    if (r.cell) {
      o.nb.flush(); // the version that has this code
      r.at = o.history()?.head() ?? null;
    }
  });
  o.kernel.on("run", (rec) => {
    if (replayHandler) return replayHandler(rec);
    const s = sessions.get(rec.gen);
    if (!s || !rec.nb) return;
    const n = ++s.n;
    const r = {
      type: "run", id: `${s.id}:${n}`, sid: s.id, n, kind: rec.kind, at: rec.at ?? null, t: rec.t, ms: Math.round(rec.ms * 10) / 10, out: rec.out,
      ...(rec.kind === "code"
        ? { mode: rec.mode, _code: rec.code, ...(rec.cell && rec.at ? { cell: rec.cell } : {}), ...(rec.repl ? { repl: true } : {}) }
        : { iid: rec.iid, values: rec.values }),
      ...(rec.clock ? { clock: rec.clock } : {}),
      ...(rec.overflow ? { overflow: true } : {}),
      ...(rec.status ? { status: rec.status } : {}),
      // (the page's files whose bytes it read: a bundle carries only those, web/notebook/bundle-blobs.mjs)
      ...(rec.sources?.length ? { reads: rec.sources } : {}),
    };
    s.events.push({ nb: rec.nb, rec: r });
    journalFor(rec.nb, s);
  });

  /** A file was put (data) or deleted (null) in the running interpreter. */
  async function fileEvent(path, data) {
    const s = current();
    if (!s) return;
    const hash = data === null ? null : await putBlob(await o.blobs(), data);
    const f = { type: "file", id: `${s.id}:${++s.n}`, sid: s.id, n: s.n, t: Date.now(), path, hash };
    const nbId = o.notebookId();
    s.events.push({ nb: nbId, rec: f });
    if (s.journaled.has(nbId)) journalFor(nbId, s); // (else with that notebook's first run)
  }
  /** The history was cleared: the running session cannot be replayed from it any more. */
  function historyCleared(nbId) {
    const s = current();
    if (!s) return;
    s.journaled.set(nbId, s.events.length);
    write(nbId, [sessionRecord(s, true)]);
  }

  // ---------------------------------------------------------- replay
  /** The next interpreter continues a journaled session (a replay plan's). */
  function continueSession(plan, nbId) {
    const ps = plan.session;
    // the replayed events, as this session's (another notebook opened in this
    // tab later gets them as foreign runs); the fork's journal has them already
    const events = plan.events.map((e) => (e.file ? { nb: nbId, rec: e.file } : { nb: nbId, rec: { ...e.run, ...(e.code !== undefined ? { _code: e.code } : {}) } }));
    next = {
      id: ps.id, seed: ps.seed, startup: ps.startup ?? [], files: ps.files ?? [], events, replay: true,
      n: plan.events.reduce((m, e) => Math.max(m, (e.run ?? e.file).n), 0),
      journaled: new Map([[nbId, events.length]]),
      t: ps.t, ms: ps.ms, version: ps.version, seeded: !!ps.seed,
      pkgset: typeof ps.pkgset === "string" && /^[0-9a-f]{64}$/.test(ps.pkgset) ? ps.pkgset : null,
    };
  }
  /** The bytes of the files a replayed session started with ([path, bytes]). */
  async function replayFiles() {
    const s = current();
    if (!s?.replay) return null;
    const db = await o.blobs();
    const out = [], missing = [];
    for (const [path, hash] of s.files) {
      const data = await getBlob(db, hash);
      if (data) out.push([path, data]);
      else missing.push(path);
    }
    s.missing = missing;
    return out;
  }
  /** Replay a plan's events in the (started) kernel; outputs go to the notebook's cells. */
  async function replay(plan, onProgress = () => {}) {
    const s = current(), report = { runs: 0, diverged: [], ms: 0 };
    for (const p of s?.missing ?? []) report.diverged.push({ n: 0, reason: `the file ${p} is not in this browser` });
    const db = await o.blobs();
    const total = plan.events.filter((e) => e.run).length;
    let recorded = 0, actual = 0, k = 0, last = null;
    const remaining = () => plan.events.filter((e) => e.run).slice(report.runs).reduce((a, e) => a + (e.run.ms ?? 0), 0);
    replayHandler = (rec) => (last = rec);
    try {
      for (const e of plan.events) {
        if (e.file) {
          const data = e.file.hash === null ? null : await getBlob(db, e.file.hash);
          if (e.file.hash !== null && !data) report.diverged.push({ n: e.file.n, reason: `the file ${e.file.path} is not in this browser` });
          o.kernel.post({ fsPut: e.file.path, data: data ?? null });
          continue;
        }
        const r = e.run;
        onProgress({ done: report.runs, total, left: remaining() * (recorded ? actual / recorded : 1) });
        const t0 = performance.now();
        last = null;
        if (r.kind === "code") {
          const cell = r.cell ? o.nb.cells().find((c) => c.id === r.cell) : null;
          const box = cell?.out ?? document.createElement("div");
          if (cell) { o.nb.output.forget(box); box.replaceChildren(); cell.n.textContent = "[*]"; }
          await new Promise((resolve) => o.kernel.execute(e.code, { mode: r.mode, repl: r.repl, cell: r.cell, clock: r.clock ?? [], forget: r.forget, mangle: !!r.mangle, seed: r.seed }, {
            start() {},
            ...o.nb.output.sink(box),
            done() { k++; if (cell) cell.n.textContent = `[${k}]`; resolve(); },
            stopped() { resolve(); },
            skipped() { resolve(); },
          }));
        } else {
          // its controls set to the values, its output replaced (as the notebook does)
          const it = o.nb.interacts.get(`${o.kernel.uid ?? 0}.${o.kernel.generation}:${r.iid}`); // (notebook.js's key)
          if (it) {
            for (const [name, v] of Object.entries(r.values ?? {})) it.setters[name]?.(v);
            it.out.replaceChildren();
          }
          const quiet = { start() {}, out() {}, display() {}, interact() {}, clear() {} };
          await new Promise((resolve) => o.kernel.interact(r.iid, r.values, { ...quiet, done: resolve, stopped: resolve, skipped: resolve }, { clock: r.clock ?? [] }));
        }
        recorded += r.ms ?? 0;
        actual += performance.now() - t0;
        report.runs++;
        if (!last) report.diverged.push({ n: r.n, reason: "it did not finish" });
        else if (last.out !== r.out) report.diverged.push({ n: r.n, reason: "its output differs" });
        else if (last.extra) report.diverged.push({ n: r.n, reason: "it read the clock more often" });
        else if (last.unused) report.diverged.push({ n: r.n, reason: "it read the clock less often" });
      }
    } finally {
      replayHandler = null;
    }
    report.ms = actual;
    o.nb.setExecCount(k);
    onProgress({ done: report.runs, total, left: 0 });
    return report;
  }

  return { workerName, filesSent, pkgsetSent, replayPkgset, fileEvent, flushPending, historyCleared, continueSession, replayFiles, replay, get session() { return current(); } };
}

/** "about 8 s" */
export function fmtEstimate(ms) {
  if (ms < 1000) return "under a second";
  if (ms < 60000) return `about ${Math.round(ms / 1000)} s`;
  return `about ${Math.round(ms / 60000)} min`;
}
