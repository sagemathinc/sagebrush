// ci: web-runner order=292 runner=bun
// The desktop app's file permissions across launches (web/workspace/grants-file.ts, #1565): the record kept in
// grants.json by where each notebook is, and brought back at the next launch under the notebooks' new ids.
//   bun web/workspace/test-grants-file.mjs
import { restoreGrants, grantsToKeep, keepGrants, adoptGrants, parseGrants, GRANTS_KEY } from "./grants-file.ts";

let fails = 0, checks = 0;
const ok = (c, what) => { checks++; console.log((c ? "ok   " : "FAIL ") + what); if (!c) fails++; };
const J = JSON.stringify;
const store = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
// (a workspace: path -> entry, with each notebook's id (ref) as this launch made it)
const workspace = (entries) => ({
  stat: async (p) => entries[p],
  pathOf: async (kind, ref) => Object.entries(entries).find(([, e]) => e.kind === kind && e.ref === ref)?.[0],
});
const files = () => { let kept = ""; const calls = []; return { invoke: async (c, a) => { calls.push(c); if (c === "grants_read") return kept; if (c === "grants_write") { kept = a.json; return null; } throw new Error(c); }, kept: () => kept, set: (t) => (kept = t), calls }; };

// launch 1: two workspace notebooks and a notebook file allowed; one more id that's no notebook now
const w1 = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "r1" }, "/b/two.ipynb": { kind: "notebook", ref: "r2" }, "/data.csv": { kind: "file", ref: null } });
const rec1 = { v: 1, seq: 9, migrated: 1, docs: { r1: { write: ["/a"], t: 3 }, r2: { write: ["/b/out"], denied: [["write", "/b", 4]], t: 5 }, "file:/Users/x/n.ipynb": { write: ["/"], t: 6 }, gone: { write: ["/z"], t: 7 } } };
const s1 = store({ [GRANTS_KEY]: J(rec1) });
const kept1 = await grantsToKeep(w1, s1);
ok(J(kept1) === J({ v: 1, seq: 9, migrated: 1, docs: { "ws:/a/one.ipynb": rec1.docs.r1, "ws:/b/two.ipynb": rec1.docs.r2, "file:/Users/x/n.ipynb": rec1.docs["file:/Users/x/n.ipynb"] } }), "kept by where each notebook is; a notebook file by its own id; one no longer in the workspace left out: " + J(kept1));

// launch 2: the same notebooks under new ids, one renamed away, one path now a data file
const f = files();
f.set(J({ ...kept1, docs: { ...kept1.docs, "ws:/c/now-a-file.ipynb": { write: ["/c"], t: 8 } } }));
const w2 = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "n1" }, "/b/two.ipynb": { kind: "notebook", ref: "n2" }, "/c/now-a-file.ipynb": { kind: "file", ref: null } });
const s2 = store();
const back = await restoreGrants(w2, f.invoke, s2);
const rec2 = parseGrants(s2.getItem(GRANTS_KEY));
ok(back === 3 && J(Object.keys(rec2.docs).sort()) === J(["file:/Users/x/n.ipynb", "n1", "n2"]) && J(rec2.docs.n1) === J(rec1.docs.r1) && J(rec2.docs.n2) === J(rec1.docs.r2), "brought back under the notebooks' new ids, denials too; a path that isn't a notebook now gives nothing: " + J(rec2));
ok(rec2.seq === 9 && rec2.migrated === 1, "...the record's counter and migration mark kept (no old switch read twice)");

// what this launch already holds wins
const s3 = store({ [GRANTS_KEY]: J({ v: 1, seq: 20, docs: { n1: { write: ["/elsewhere"], t: 20 } } }) });
await restoreGrants(w2, f.invoke, s3);
const rec3 = parseGrants(s3.getItem(GRANTS_KEY));
ok(J(rec3.docs.n1) === J({ write: ["/elsewhere"], t: 20 }) && rec3.seq === 20 && !!rec3.docs.n2, "what this page already holds for a notebook wins over what was kept: " + J(rec3));

// not the page's record: nothing comes back
for (const [bad, why] of [["", "none kept"], ["not json", "not JSON"], [J({ v: 2, docs: {} }), "another version"], [J({ v: 1, docs: [] }), "docs not an object"]]) {
  const fb = files(); fb.set(bad);
  const sb = store();
  ok((await restoreGrants(w2, fb.invoke, sb)) === 0 && sb.getItem(GRANTS_KEY) === null, `nothing comes back from ${why}`);
}

// kept at each change, one write at a time, the last one winning
const fk = files(), sk = store({ [GRANTS_KEY]: J(rec1) });
let changed = null;
const k = keepGrants(w1, fk.invoke, (fn) => (changed = fn), sk, 50);
changed();
sk.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/a", "/a2"], t: 10 } } }));
changed();
await k.flush();
// (two changes in a row: written as one or two writes, the last of them the record as it is after both; a change during
// a write held unfinished making one more is the held-write case below)
const nWrites = fk.calls.filter((c) => c === "grants_write").length;
ok(nWrites >= 1 && nWrites <= 2 && J(parseGrants(fk.kept()).docs) === J({ "ws:/a/one.ipynb": { write: ["/a", "/a2"], t: 10 } }), "kept at each change: the record as it is after the last change is what grants.json holds (" + nWrites + " writes): " + fk.kept());

// the latest change, never lost: a write held unfinished keeps flush() waiting; a write that fails keeps it unwritten,
// flush() rejecting with why, until a write succeeds (tried again by itself, and at the next flush)
{
  let release, mode = "hold", writes = 0, kept = "";
  const invoke = async (c, a) => {
    if (c !== "grants_write") return "";
    writes++;
    if (mode === "hold") await new Promise((r) => (release = r));
    if (mode === "fail") throw new Error("disk full");
    kept = a.json;
  };
  const sh = store({ [GRANTS_KEY]: J(rec1) });
  let changed;
  const g = keepGrants(w1, invoke, (fn) => (changed = fn), sh, 50);
  changed();
  let flushed = false;
  const f1 = g.flush().then(() => (flushed = true));
  await new Promise((r) => setTimeout(r, 100));
  ok(!flushed && g.unwritten, "a write held unfinished: flush() still waits, the change still unwritten");
  // (a denial made while that write is held: the record as it is then is written after it)
  sh.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { denied: [["write", "/a", 11]], t: 11 } } }));
  changed();
  mode = "ok"; release();
  await f1;
  ok(flushed && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { denied: [["write", "/a", 11]], t: 11 } }), "...released: flush() resolves only once the latest change (the denial made meanwhile) is in grants.json");
  mode = "fail";
  sh.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/again"], t: 12 } } }));
  changed();
  const why = await g.flush().then(() => "resolved", (e) => String(e.message));
  ok(why === "grants.json: disk full" && g.unwritten, "a write that fails: flush() rejects, saying why, and the change stays unwritten: " + why);
  const before = writes;
  mode = "ok";
  await new Promise((r) => setTimeout(r, 200));
  ok(writes > before && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { write: ["/again"], t: 12 } }), "...tried again by itself: written once the disk takes it");
  await g.flush();
  ok(!g.unwritten, "...and flush() then resolves");
}

// liveness: a flush with nothing to write, then a change, writes it; and a retry that fires after a successful flush
// (nothing left to write) leaves the next change written too (astra2's two sequences on 5ef00da2)
{
  let writes = 0, fail = false, kept = "";
  const invoke = async (c, a) => { if (c !== "grants_write") return ""; writes++; if (fail) throw new Error("disk full"); kept = a.json; };
  const sl = store({ [GRANTS_KEY]: J(rec1) });
  let changed;
  const g = keepGrants(w1, invoke, (fn) => (changed = fn), sl, 50);
  await g.flush();
  changed();
  await new Promise((r) => setTimeout(r, 30));
  ok(writes === 1 && !g.unwritten, "a clean flush, then a change: the change is written (" + writes + " write)");
  // (a write fails, arming the retry; a flush succeeds before the retry fires; the retry then finds nothing to write)
  fail = true;
  changed();
  await new Promise((r) => setTimeout(r, 10));
  fail = false;
  await g.flush();
  await new Promise((r) => setTimeout(r, 120));
  const before = writes;
  sl.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/late"], t: 30 } } }));
  changed();
  const done = await Promise.race([g.flush().then(() => "flushed"), new Promise((r) => setTimeout(() => r("stuck"), 1000))]);
  ok(done === "flushed" && writes === before + 1 && !g.unwritten && J(parseGrants(kept).docs) === J({ "ws:/a/one.ipynb": { write: ["/late"], t: 30 } }), "a retry firing after a successful flush: the next change is still written, and flush() resolves: " + J({ done, writes: writes - before }));
}

// two windows of the app (#1541): each its own ids for the same notebooks; what one allows or takes back, and writes,
// is the other's once it adopts grants.json, so the other's next write carries it instead of undoing it
{
  const f = files();
  const wa = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "a1" }, "/b/two.ipynb": { kind: "notebook", ref: "a2" } });
  const wb = workspace({ "/a/one.ipynb": { kind: "notebook", ref: "b1" }, "/b/two.ipynb": { kind: "notebook", ref: "b2" } });
  const sa = store({ [GRANTS_KEY]: J({ v: 1, seq: 4, docs: { a1: { write: ["/a"], t: 1 }, a2: { write: ["/b"], t: 2 } } }) });
  f.set(J(await grantsToKeep(wa, sa)));
  const sb = store();
  await restoreGrants(wb, f.invoke, sb);
  // (the first window takes back two.ipynb's permission and writes the record; the second, meanwhile, has its own
  // unsaved-to-disk ephemeral grant for a document grants.json can't name)
  sa.setItem(GRANTS_KEY, J({ v: 1, seq: 5, docs: { a1: { write: ["/a"], t: 1 } } }));
  f.set(J(await grantsToKeep(wa, sa)));
  const rb = JSON.parse(sb.getItem(GRANTS_KEY));
  rb.docs.scratch = { write: ["/s"], t: 9 };
  sb.setItem(GRANTS_KEY, J(rb));
  const changed = await adoptGrants(wb, f.invoke, sb);
  const after = parseGrants(sb.getItem(GRANTS_KEY));
  ok(changed && J(after.docs) === J({ scratch: { write: ["/s"], t: 9 }, b1: { write: ["/a"], t: 1 } }) && after.seq === 5, "two windows: a permission taken back in one is gone in the other once adopted (by its own ids), what grants.json can't name kept: " + J(after));
  ok(J((await grantsToKeep(wb, sb)).docs) === J({ "ws:/a/one.ipynb": { write: ["/a"], t: 1 } }), "two windows: and the other's next write doesn't bring it back");
  ok((await adoptGrants(wb, f.invoke, sb)) === false, "two windows: adopting the same record again changes nothing");
  f.set("not json");
  ok((await adoptGrants(wb, f.invoke, sb)) === false && J(parseGrants(sb.getItem(GRANTS_KEY)).docs) === J(after.docs), "two windows: a grants.json that can't be read changes nothing");
}

console.log(fails ? `${fails} of ${checks} failed` : `test-grants-file: all ${checks} passed`);
process.exit(fails ? 1 : 0);
