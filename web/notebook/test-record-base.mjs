// ci: web-runner order=401 runner=bun
// A device records only what was typed on it (William's reverted edit, Nov 13): a version is the three-way merge of
// the page's own base, the history's head and the page's document, never the page's document diffed against the
// head.  Two NotebookHistory sessions on one store, as two devices on one synced history: A types, B's page lags one
// patch behind (its document and its base the value before A's patch), and B records.
//   1. B's document unchanged from its base (a run: outputs only, which aren't versioned): nothing recorded, and A's
//      text stays the head's (the revert, before the fix: B's stale text recorded over A's).
//   2. B typed in another cell: exactly that cell recorded; A's cell stays A's.
//   3. B typed in the same cell, another line: both lines kept.
//   4. A non-text field (a cell's type) that A changed, B's base exact (B never saw the change): A's type kept
//      (B's own earlier value never written over A's).
//   5. The execution journal's records (a run's) as they were: the three-way touches versioned records only.
//   6. No base: refused (thrown), nothing recorded.
//   7. Equal positions: the cells in one order on every device (position, then id).
//   bun web/notebook/test-record-base.mjs
import { MemoryPatchStore } from "patchflow";
import { NO_VERSIONS, NotebookHistory, exactRecords3, fromRecords, toRecords } from "./history.js";

const J = JSON.stringify;
let checks = 0;
const fails = [];
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const tick = () => new Promise((r) => setTimeout(r, 0));

async function devices() {
  const store = new MemoryPatchStore();
  const a = await new NotebookHistory(store).init(), b = await new NotebookHistory(store).init();
  return { store, a, b };
}
const nb = (cells, mode = "matlab") => ({ mode, cells: cells.map(([id, code, type]) => ({ id, code, ...(type ? { type } : {}) })) });
const cellsOf = (h) => fromRecords(h.committed()).cells.map((c) => [c.id, c.code, c.type ?? "code"]);
const patchesBy = (store, h) => store.patches.filter((p) => p.time.endsWith("_" + h.clientId));

const B0 = nb([["c1", "A = [8 -2; 1 1]"], ["c2", "eig(A)"]]);
const A1 = nb([["c1", "A = [9 2; 3 4]"], ["c2", "eig(A)"]]);

// (A's root and A's edit, B's page still showing the root; B's session has both, as a synced device's does)
async function lagging() {
  const d = await devices();
  d.a.record(B0, NO_VERSIONS);
  await tick();
  d.a.record(A1, B0);
  await tick();
  return d;
}

// 0. (a guard) the same change in both head and local, from an older base, comes out once, plus one
// typed character: text (the same insertion), a cell added, deleted or moved, the kernel
{
  const recs = (doc) => [...toRecords(doc).get({ type: "settings" }), ...toRecords(doc).get({ type: "cell" })];
  const docOf = (rs) => fromRecords(rs.reduce((d, r) => d.set(r), toRecords(nb([]))));
  const old = nb([["c1", "x = 1"], ["c2", "y"], ["c3", "z"]], "python");
  const cases = [
    ["text", nb([["c1", "x = 1\nw = 2"], ["c2", "y"], ["c3", "z"]], "python"), nb([["c1", "x = 1\nw = 2!"], ["c2", "y"], ["c3", "z"]], "python")],
    ["added", nb([["c1", "x = 1"], ["c2", "y"], ["c3", "z"], ["c4", "new"]], "python"), nb([["c1", "x = 1"], ["c2", "y"], ["c3", "z"], ["c4", "new!"]], "python")],
    ["deleted", nb([["c1", "x = 1"], ["c3", "z"]], "python"), nb([["c1", "x = 1!"], ["c3", "z"]], "python")],
    ["moved", nb([["c2", "y"], ["c1", "x = 1"], ["c3", "z"]], "python"), nb([["c2", "y"], ["c1", "x = 1!"], ["c3", "z"]], "python")],
    ["kernel", nb([["c1", "x = 1"], ["c2", "y"], ["c3", "z"]], "sage"), nb([["c1", "x = 1!"], ["c2", "y"], ["c3", "z"]], "sage")],
  ];
  for (const [kind, head, local] of cases) {
    const got = docOf(exactRecords3(recs(old), recs(head), recs(local)));
    // (text: the same line from an older base comes out twice, mergeStrings3's union of two insertions at one place:
    // why the base must be exact; from the exact base (the head itself), once)
    if (kind === "text") {
      check(J(got.cells[0].code) === J("x = 1\nw = 2\nw = 2!"), `0. text, an older base: the line twice, as mergeStrings3 makes it (${J(got.cells[0].code)})`);
      const exact = docOf(exactRecords3(recs(head), recs(head), recs(local)));
      check(J(exact) === J(fromRecords(toRecords(local))), `0. text, the exact base: once, plus the typed character (${J(exact)})`);
      continue;
    }
    check(J(got) === J(fromRecords(toRecords(local))), `0. ${kind}: once, plus the typed character (${J(got)})`);
  }
}
{
  const { store, a, b } = await lagging();
  check(J(cellsOf(b)) === J(cellsOf(a)) && cellsOf(b)[0][1] === "A = [9 2; 3 4]", `B's session holds A's edit (${J(cellsOf(b))})`);
  check(fromRecords(b.committed()).mode === "matlab", `the first version's kernel kept (${fromRecords(b.committed()).mode})`);
  const before = patchesBy(store, b).length;
  // (a run: the page's document as its base, outputs aside)
  const out = b.record({ ...B0, cells: B0.cells.map((c) => ({ ...c, outputs: [{ text: "ran" }] })) }, B0);
  await tick();
  check(out === null && patchesBy(store, b).length === before, `1. a run records nothing (${J(out?.patch ?? out)})`);
  check(cellsOf(a)[0][1] === "A = [9 2; 3 4]" && cellsOf(b)[0][1] === "A = [9 2; 3 4]", `1. A's text stays the head's (A ${J(cellsOf(a)[0])}, B ${J(cellsOf(b)[0])})`);
}
{
  const { a, b } = await lagging();
  b.record(nb([["c1", "A = [8 -2; 1 1]"], ["c2", "eig(A)'"]]), B0);
  await tick();
  check(J(cellsOf(a)) === J([["c1", "A = [9 2; 3 4]", "code"], ["c2", "eig(A)'", "code"]]), `2. B's typing recorded, A's cell kept (${J(cellsOf(a))})`);
}
{
  const d = await devices();
  const base = nb([["c1", "x = 1\ny = 2"]]);
  d.a.record(base, NO_VERSIONS);
  await tick();
  d.a.record(nb([["c1", "x = 10\ny = 2"]]), base);
  await tick();
  d.b.record(nb([["c1", "x = 1\ny = 20"]]), base);
  await tick();
  check(cellsOf(d.a)[0][1] === "x = 10\ny = 20", `3. both lines kept (${J(cellsOf(d.a)[0][1])})`);
}
{
  const d = await devices();
  const base = nb([["c1", "# t"], ["c2", "1 + 1"]]);
  d.a.record(base, NO_VERSIONS);
  await tick();
  d.a.record(nb([["c1", "# t", "markdown"], ["c2", "1 + 1"]]), base);
  await tick();
  d.b.record(nb([["c1", "# t"], ["c2", "1 + 2"]]), base);
  await tick();
  check(J(cellsOf(d.a)) === J([["c1", "# t", "markdown"], ["c2", "1 + 2", "code"]]), `4. A's cell type kept, B's typing recorded (${J(cellsOf(d.a))})`);
}
{
  const { a, b } = await lagging();
  b.journal([{ type: "run", id: "r1", cell: "c1", code: "A = [9 2; 3 4]" }]);
  await tick();
  const runs = () => J(b.committed().get({ type: "run" }));
  const was = runs();
  b.record(nb([["c1", "A = [8 -2; 1 1]"], ["c2", "eig(A) + 1"]]), B0);
  await tick();
  check(runs() === was && was !== "[]", `5. the run's records as they were (${runs()})`);
  check(cellsOf(a)[0][1] === "A = [9 2; 3 4]", "5. A's text kept");
}
{
  const { store, b } = await lagging();
  const before = store.patches.length;
  let threw = false;
  try { b.record(B0); } catch { threw = true; }
  check(threw && store.patches.length === before, "6. no base: refused, nothing recorded");
}
{
  let d = toRecords(nb([]));
  d = d.set({ type: "cell", id: "zz", pos: 1, input: "z", cell_type: "code" }).set({ type: "cell", id: "aa", pos: 1, input: "a", cell_type: "code" });
  let e = toRecords(nb([]));
  e = e.set({ type: "cell", id: "aa", pos: 1, input: "a", cell_type: "code" }).set({ type: "cell", id: "zz", pos: 1, input: "z", cell_type: "code" });
  check(J(fromRecords(d).cells.map((c) => c.id)) === J(fromRecords(e).cells.map((c) => c.id)), `7. equal positions in one order (${J(fromRecords(d).cells.map((c) => c.id))} vs ${J(fromRecords(e).cells.map((c) => c.id))})`);
}

// 9. (ids never before what they follow) a device whose clock is an hour behind, its history paused (a version
// refused), commits by itself (patch-history.js commitDetached): its new id is later than the other device's patch it
// had received, whatever its clock says (the mutant: no bump from received ids)
{
  const { decodePatchId } = await import("./history.js");
  const shared = new MemoryPatchStore();
  const a = await new NotebookHistory(shared).init();
  // (B's store: the shared one, but refusing B's next append when asked, as a full history refuses)
  let refuse = false;
  const bStore = { loadInitial: (o) => shared.loadInitial(o), subscribe: (f) => shared.subscribe(f), append: (env) => (refuse ? ((refuse = false), false) : shared.append(env)) };
  const b = await new NotebookHistory(bStore).init();
  a.record(B0, NO_VERSIONS);
  await tick();
  a.record(A1, B0);
  await tick();
  const aLast = shared.patches.at(-1).time;
  const real = Date.now;
  Date.now = () => real() - 3_600_000;
  try {
    refuse = true;
    b.record(nb([["c1", "A = [9 2; 3 4]"], ["c2", "eig(A)!"]]), A1);
    await b.rebuilding;
    const env = b.record(nb([["c1", "A = [9 2; 3 4]"], ["c2", "eig(A)!!"]]), nb([["c1", "A = [9 2; 3 4]"], ["c2", "eig(A)!"]]));
    check(!!env?.time && b.paused === false && env.time > aLast && decodePatchId(env.time).timeMs > decodePatchId(aLast).timeMs, `9. a paused device's own commit, its clock an hour behind, is later than what it received (${env?.time} vs ${aLast})`);
  } finally { Date.now = real; }
}

// 10. (the fuzz) two devices on one history, each page lagging its history's head until it applies it: seeded random
// steps of typing (a cell's text), applying the head to the page (merged with what was typed, the page's base then the
// head's), and saving (record from the page's base, then the page shows what was kept: its base that).  After every
// save: the version changed only cells that device typed since its base (never another's change undone).  FUZZ_SEEDS
// seeds (CI's default below), each printed on a failure
{
  const { exactRecords3, recordsOf, docOfRecords } = await import("./history.js");
  const seeds = Number(process.env.FUZZ_SEEDS ?? 120), first = Number(process.env.FUZZ_FIRST ?? 1);
  const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ids = ["c1", "c2", "c3"], WORDS = ["x = 1", "y = 2", "A = [1 2; 3 4]", "eig(A)", "z", "# note"];
  const input = (d, id) => d.cells.find((c) => c.id === id)?.code;
  const headDoc = (h) => fromRecords(h.committed());
  let bad = null, steps = 0;
  for (let seed = first; seed < first + seeds && !bad; seed++) {
    const r = rng(seed), pick = (xs) => xs[Math.floor(r() * xs.length)];
    const store = new MemoryPatchStore();
    const start = nb(ids.map((id) => [id, "start " + id]), "python");
    const devs = [];
    for (let i = 0; i < 2; i++) devs.push({ h: await new NotebookHistory(store).init(), page: start, base: start, name: "XY"[i] });
    devs[0].h.record(start, NO_VERSIONS);
    await tick();
    for (let step = 0; step < 40 && !bad; step++, steps++) {
      const dev = pick(devs), k = r();
      if (k < 0.4) {
        const id = pick(ids);
        dev.page = { ...dev.page, cells: dev.page.cells.map((c) => (c.id === id ? { ...c, code: pick(WORDS) + " " + dev.name + step } : c)) };
      } else if (k < 0.65) {
        // (the head applied to the page: the page's typing merged in, the base the head's)
        const head = headDoc(dev.h);
        dev.page = docOfRecords(exactRecords3(recordsOf(dev.base), recordsOf(head), recordsOf(dev.page)));
        dev.base = head;
      } else {
        const before = headDoc(dev.h), typed = new Set(ids.filter((id) => input(dev.page, id) !== input(dev.base, id)));
        dev.h.record(dev.page, dev.base);
        await tick();
        const after = headDoc(dev.h), changed = ids.filter((id) => input(after, id) !== input(before, id));
        const undone = changed.filter((id) => !typed.has(id));
        if (undone.length) bad = { seed, step, device: dev.name, undone, typed: [...typed], before: before.cells.map((c) => c.code), after: after.cells.map((c) => c.code) };
        // (what was kept shown: the page and its base the head)
        dev.page = dev.base = after;
      }
    }
  }
  check(!bad, `10. the fuzz: no save changes a cell its device didn't type (${seeds} seeds from ${first}, ${steps} steps)` + (bad ? ": " + J(bad) : ""));
}

// 8. (the census) every version recorded in the sources names its base: each history `record(` call has two arguments
// and each `recordInto(` three, so a new caller can't record a document over the head unseen
{
  const { readFileSync } = await import("node:fs");
  const web = new URL("..", import.meta.url).pathname;
  const files = ["index.html", "page/session.ts", "journal/store.js", "notebook/history.js", "board/history.ts", "board/journal.ts", "board/mount.ts", "board/page.ts"];
  const args = (s, i) => {
    let depth = 1, n = 1, k = i, blank = true;
    for (; depth; k++) {
      const c = s[k];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      else if (c === "," && depth === 1) n++;
      if (depth && !/\s/.test(c)) blank = false;
    }
    return blank ? 0 : n;
  };
  const bad = [];
  let seen = 0;
  for (const f of files) {
    const s = readFileSync(web + f, "utf8");
    for (const m of s.matchAll(/\b(record|recordInto)\(/g)) {
      const before = s.slice(Math.max(0, m.index - 12), m.index);
      // (definitions and the page's other records (perms.record: a permission's)
      if (/(function |perms\.|^\s*)$/.test(before) || /\n\s*$/.test(before) || /\b(record|recordInto)\([a-z]+[,:)]/.test(s.slice(m.index, m.index + 40)) && /(\{|=>)\s*$/.test(s.slice(m.index, s.indexOf("\n", m.index)))) continue;
      seen++;
      const n = args(s, m.index + m[0].length), want = m[1] === "record" ? 2 : 3;
      if (n < want) bad.push(`${f}: ${s.slice(m.index, m.index + 60).split("\n")[0]}`);
    }
  }
  check(seen >= 8 && !bad.length, `8. every recorded version names its base (${seen} calls): ${JSON.stringify(bad)}`);
}

console.log(fails.length ? `FAIL: ${fails.length} of ${checks} checks\n  ` + fails.join("\n  ") : `ok: ${checks} checks`);
process.exit(fails.length ? 1 : 0);
