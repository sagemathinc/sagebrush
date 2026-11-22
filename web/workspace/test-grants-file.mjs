// ci: web-runner order=292 runner=bun
// The desktop app's file permissions across launches (web/workspace/grants-file.ts, #1565): the record kept in
// grants.json by where each notebook is, and brought back at the next launch under the notebooks' new ids.
//   bun web/workspace/test-grants-file.mjs
import { restoreGrants, grantsToKeep, keepGrants, parseGrants, GRANTS_KEY } from "./grants-file.ts";

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
const k = keepGrants(w1, fk.invoke, (fn) => (changed = fn), sk);
changed();
sk.setItem(GRANTS_KEY, J({ ...rec1, docs: { r1: { write: ["/a", "/a2"], t: 10 } } }));
changed();
await k.save();
ok(fk.calls.filter((c) => c === "grants_write").length === 2 && J(parseGrants(fk.kept()).docs) === J({ "ws:/a/one.ipynb": { write: ["/a", "/a2"], t: 10 } }), "kept at each change: a change during a write makes one more, of the record as it is then: " + fk.kept());

console.log(fails ? `${fails} of ${checks} failed` : `test-grants-file: all ${checks} passed`);
process.exit(fails ? 1 : 0);
