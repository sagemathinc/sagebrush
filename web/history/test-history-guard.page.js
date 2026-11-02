// The cases of web/history/test-history-guard.mjs, run in the page with the guard installed (web/history/guard.js):
// a workspace scenario fully covered (no violation), and each control caught.  W is this build's workspace.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
const J = JSON.stringify;
const G = window.__historyGuard;
let n = 0;
const settle = () => new Promise((r) => setTimeout(r, 50));
const since = (k) => G.violations.slice(k);
// (a raw readwrite transaction of the app's databases, for the controls: `f(tx)` writes; resolves at commit)
const raw = (db, stores, f) => new Promise((ok, no) => { const tx = db.transaction(stores, "readwrite"); f(tx); tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
const tok = (ident, seq) => ({ seq, ident, rev: 1, kind: "file", chain: null, sz: 1 });

// ---- the scenario: every op through the workspace's own code, history active (the guard set hactive at open)
{
  const w = await W.Workspace.open({ name: `hgw-${++n}`, mainName: `hgm-${n}` });
  check(w.main.objectStoreNames.contains("htokens") && (await new Promise((ok) => { const r = w.ws.transaction("hmeta").objectStore("hmeta").get("hactive"); r.onsuccess = () => ok(r.result); })) === true, "the guard's opener: history's stores in the notebooks' database, hactive set in the workspace's");
  const v0 = G.violations.length, c0 = G.checked;
  await w.mkdir("/A");
  await w.mkdir("/A/B");
  await w.create("/A/B/f.txt", { content: "one" });
  await w.write("/A/B/f.txt", "two");
  await w.rename("/A/B", "/A/C");
  await w.rename("/A/C/f.txt", "/f.txt");
  await w.duplicate("/f.txt");
  const t = await w.remove("/f.txt");
  await w.restore(t.path);
  await w.remove("/f.txt");
  await w.emptyTrash();
  const bd = await w.create("/A/plan.board.json");
  await w.write("/A/plan.board.json", { title: "plan", nodes: [] });
  await w.rename("/A/plan.board.json", "/A/plan2.board.json");
  const nb = await w.create("/A/n.ipynb");
  await w.remove("/A/n.ipynb");
  await w.emptyTrash();
  await settle();
  check(since(v0).length === 0 && G.checked > c0, `the scenario: every changed identity had its token (${G.checked - c0} judged), violations: ${J(since(v0))}`);
  void bd; void nb;

  // ---- controls: each must be caught, exactly
  // (two entries changed in one transaction, one token)
  let k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => {
    tx.objectStore("entries").put({ path: "/c1.txt", kind: "file", fid: "cfid1", sha256: "x", size: 1 });
    tx.objectStore("entries").put({ path: "/c2.txt", kind: "file", fid: "cfid2", sha256: "x", size: 1 });
    tx.objectStore("htokens").add(tok("cfid1", 1e9));
  });
  await settle();
  check(J(since(k).map((x) => x.ident)) === J(["cfid2"]), `control: two entries changed, one token: the other caught: ${J(since(k))}`);
  // (two notebooks changed, one token)
  k = G.violations.length;
  await raw(w.main, ["notebooks", "htokens", "hmeta"], (tx) => {
    tx.objectStore("notebooks").put({ id: "cnb1", cells: [], rev: 1 });
    tx.objectStore("notebooks").put({ id: "cnb2", cells: [], rev: 1 });
    tx.objectStore("htokens").add(tok("cnb1", 1e9));
  });
  await settle();
  check(J(since(k).map((x) => x.ident)) === J(["cnb2"]), `control: two notebooks changed, one token: the other caught: ${J(since(k))}`);
  // (a change with no token and no exhausted state: caught; the same change once exhausted is committed: passes)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c3.txt", kind: "file", fid: "cfid3", sha256: "x", size: 1 }));
  await settle();
  check(J(since(k).map((x) => x.ident)) === J(["cfid3"]), `control: a change with no token (an exhausted save with its flag skipped): caught: ${J(since(k))}`);
  await raw(w.ws, ["hmeta"], (tx) => tx.objectStore("hmeta").put(true, "exhausted"));
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c4.txt", kind: "file", fid: "cfid4", sha256: "x", size: 1 }));
  await settle();
  check(since(k).length === 0, `the third witness (W): a change with no token on an EXHAUSTED source passes: ${J(since(k))}`);
  // (a metadata-only write passes: the same entry, its fetch note added)
  k = G.violations.length;
  await raw(w.ws, ["hmeta"], (tx) => tx.objectStore("hmeta").delete("exhausted"));
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c4.txt", kind: "file", fid: "cfid4", sha256: "x", size: 1, fetchFailed: { why: "x", at: 1 } }));
  await settle();
  check(since(k).length === 0, `a metadata-only write (a fetch's failure note) is not a change: ${J(since(k))}`);
  // (a cursor's update of a file's content: caught)
  k = G.violations.length;
  await new Promise((ok) => {
    const tx = w.ws.transaction(["entries", "htokens", "hmeta"], "readwrite"), c = tx.objectStore("entries").openCursor("/c4.txt");
    c.onsuccess = () => { if (c.result) c.result.update({ ...c.result.value, sha256: "y" }); };
    tx.oncomplete = () => ok();
  });
  await settle();
  check(J(since(k).map((x) => x.ident)) === J(["cfid4"]), `control (G1): a cursor update of an entry's content, no token: caught: ${J(since(k))}`);
  w.close?.();
}

// ---- control (GC): a notebooks database made by the app's own opener (no history stores) fails the guarded run
{
  const k = G.violations.length;
  const w = await W.Workspace.open({ name: `hgw-${++n}`, mainName: `noopener-${n}` });
  await w.create("/n.ipynb");
  await settle();
  check(!w.main.objectStoreNames.contains("htokens") && since(k).some((x) => x.db === `noopener-${n}` && /without history's stores/.test(x.why)), `control (GC): a notebook saved in a database the app's opener made, without history's stores: caught: ${J(since(k))}`);
  w.close?.();
}

export async function run() {
  return results;
}
