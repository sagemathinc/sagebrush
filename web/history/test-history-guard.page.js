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
// (the controls' tokens are fixtures, at no particular rev: what they judge is the token's presence, so the exact-rev rule's
// verdicts on them are set aside here; the exact rev has its own rows below)
const sinceC = (k) => since(k).filter((v) => !/token: rev /.test(v.why));
// (a raw readwrite transaction of the app's databases, for the controls: `f(tx)` writes; resolves at commit)
// (a failing fixture names itself: a request's error, then the transaction's abort, never a bare null)
const raw = (db, stores, f) => new Promise((ok, no) => { const tx = db.transaction(stores, "readwrite"); f(tx); tx.oncomplete = () => ok(); tx.onerror = (e) => no(new Error(`fixture ${J(stores)}: ${e.target?.error?.name ?? "error"} ${e.target?.error?.message ?? ""}`)); tx.onabort = () => no(new Error(`fixture ${J(stores)} aborted: ${tx.error?.name ?? "no error"}`)); });
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
  check(J(sinceC(k).map((x) => x.ident)) === J(["cfid2"]), `control: two entries changed, one token: the other caught: ${J(sinceC(k))}`);
  // (two notebooks changed, one token)
  k = G.violations.length;
  await raw(w.main, ["notebooks", "htokens", "hmeta"], (tx) => {
    tx.objectStore("notebooks").put({ id: "cnb1", cells: [], rev: 1 });
    tx.objectStore("notebooks").put({ id: "cnb2", cells: [], rev: 1 });
    tx.objectStore("htokens").add(tok("cnb1", 1e9));
  });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["cnb2"]), `control: two notebooks changed, one token: the other caught: ${J(sinceC(k))}`);
  // (a change with no token and no exhausted state: caught; the same change once exhausted is committed: passes)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c3.txt", kind: "file", fid: "cfid3", sha256: "x", size: 1 }));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["cfid3"]), `control: a change with no token (an exhausted save with its flag skipped): caught: ${J(sinceC(k))}`);
  await raw(w.ws, ["hmeta"], (tx) => tx.objectStore("hmeta").put(true, "exhausted"));
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c4.txt", kind: "file", fid: "cfid4", sha256: "x", size: 1 }));
  await settle();
  check(sinceC(k).length === 0, `the third witness (W): a change with no token on an EXHAUSTED source passes: ${J(sinceC(k))}`);
  // (a metadata-only write passes: the same entry, its fetch note added)
  // (G3: history's state removed outside a reset (the exhausted flag deleted): caught, history switched off silently otherwise)
  k = G.violations.length;
  await raw(w.ws, ["hmeta"], (tx) => tx.objectStore("hmeta").delete("exhausted"));
  await settle();
  check(J(sinceC(k).map((x) => x.why)) === J(["history state removed outside a reset"]), `control (G3): an hmeta key deleted outside a reset: caught: ${J(sinceC(k))}`);
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/c4.txt", kind: "file", fid: "cfid4", sha256: "x", size: 1, fetchFailed: { why: "x", at: 1 } }));
  await settle();
  check(sinceC(k).length === 0, `a metadata-only write (a fetch's failure note) is not a change: ${J(sinceC(k))}`);
  // (a cursor's update of a file's content: caught)
  k = G.violations.length;
  await new Promise((ok) => {
    const tx = w.ws.transaction(["entries", "htokens", "hmeta"], "readwrite"), c = tx.objectStore("entries").openCursor("/c4.txt");
    c.onsuccess = () => { if (c.result) c.result.update({ ...c.result.value, sha256: "y" }); };
    tx.oncomplete = () => ok();
  });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["cfid4"]), `control (G1): a cursor update of an entry's content, no token: caught: ${J(sinceC(k))}`);
  // (an identity GIVEN (the migrator's fillIdentity): the entry named by its path, then the same kind and document
  // under an fid, no token: passes; given with its kind changed: a new identity, caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/g1", kind: "folder", ref: null }); tx.objectStore("entries").put({ path: "/g2", kind: "folder", ref: null }); tx.objectStore("htokens").add(tok("path:/g1", 1e9 + 10)); tx.objectStore("htokens").add(tok("path:/g2", 1e9 + 11)); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/g1", kind: "folder", ref: null, fid: "gfid1", ident: "gfid1" }));
  await settle();
  check(sinceC(k).length === 0, `an identity given (the same folder, now named by its fid), no token: passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/g2", kind: "file", ref: null, fid: "gfid2", sha256: "x", size: 1 }));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["gfid2"]), `control: an "identity given" that changes the kind is a new identity: caught: ${J(sinceC(k))}`);
  // (a hash recorded where none was (fillHash): passes; a recorded hash changed, no token: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/h1.txt", kind: "file", ref: null, fid: "hfid1", migrated: true, size: 3 }); tx.objectStore("htokens").add(tok("hfid1", 1e9 + 12)); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/h1.txt", kind: "file", ref: null, fid: "hfid1", migrated: true, size: 3, sha256: "s" }));
  await settle();
  check(sinceC(k).length === 0, `a hash recorded where none was (the migrator's fillHash), no token: passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").put({ path: "/h1.txt", kind: "file", ref: null, fid: "hfid1", migrated: true, size: 3, sha256: "t" }));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["hfid1"]), `control: a recorded hash changed, no token: caught: ${J(sinceC(k))}`);
  // (a legacy file's bytes moved in under the fid it is given, marked migrated, in one transaction (migrateOne): passes;
  // its bytes changed afterwards, no token: caught)
  k = G.violations.length;
  await raw(w.main, ["files"], (tx) => { tx.objectStore("files").put(new Uint8Array([1, 2]), "/m1.txt"); tx.objectStore("files").put(new Uint8Array([1, 2]), "/m2.txt"); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { for (const p of ["/m1.txt", "/m2.txt", "/m3.txt"]) { tx.objectStore("entries").put({ path: p, kind: "file", ref: p, size: 2 }); tx.objectStore("htokens").add(tok("path:" + p, 1e9 + 13 + p.charCodeAt(2))); } });
  await raw(w.ws, ["entries", "fileBytes", "htokens", "hmeta"], (tx) => { tx.objectStore("fileBytes").put(new Uint8Array([1, 2]), "mfid1"); tx.objectStore("entries").put({ path: "/m1.txt", kind: "file", ref: "/m1.txt", fid: "mfid1", ident: "mfid1", migrated: true, size: 2, sha256: "m" }); });
  await settle();
  check(sinceC(k).length === 0, `a legacy file's bytes moved in under its given fid, migrated in the same transaction: passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["fileBytes", "htokens", "hmeta"], (tx) => tx.objectStore("fileBytes").put(new Uint8Array([9, 9]), "mfid1"));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["mfid1"]), `control: a migrated file's bytes changed later, no token: caught: ${J(sinceC(k))}`);
  // (G1: migrateOne's shape with bytes that are NOT the legacy copy's: caught; with no legacy copy at all: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "fileBytes", "htokens", "hmeta"], (tx) => { tx.objectStore("fileBytes").put(new Uint8Array([7, 7]), "mfid2"); tx.objectStore("entries").put({ path: "/m2.txt", kind: "file", ref: "/m2.txt", fid: "mfid2", ident: "mfid2", migrated: true, size: 2, sha256: "m" }); });
  await settle();
  check(J(sinceC(k).map((x) => [x.ident, x.why])) === J([["mfid2", "migrated bytes differ from the legacy copy"]]), `control (G1): a migration whose bytes differ from the legacy copy: caught: ${J(sinceC(k))}`);
  k = G.violations.length;
  await raw(w.ws, ["entries", "fileBytes", "htokens", "hmeta"], (tx) => { tx.objectStore("fileBytes").put(new Uint8Array([1, 2]), "mfid3"); tx.objectStore("entries").put({ path: "/m3.txt", kind: "file", ref: "/m3.txt", fid: "mfid3", ident: "mfid3", migrated: true, size: 2, sha256: "m" }); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["mfid3"]) && /no legacy copy/.test(sinceC(k)[0]?.why ?? ""), `control (G1): a migration with no legacy copy to compare: caught: ${J(sinceC(k))}`);
  // (Trash's own folder (the workspace's, no identity, no token by log()): passes; any other new folder with no token: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/Trash", kind: "folder", ref: null, fid: "trashfid" }); tx.objectStore("entries").put({ path: "/notrash", kind: "folder", ref: null, fid: "ntfid" }); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["ntfid"]), `Trash's own folder passes; another new folder with no token is caught: ${J(sinceC(k))}`);
  // (a data file's ref following its path (a move): not content, passes; a notebook's ref changed is a new identity: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/rf.txt", kind: "file", ref: "/rf.txt", fid: "rffid", migrated: true, sha256: "r", size: 1 }); tx.objectStore("entries").put({ path: "/rn.ipynb", kind: "notebook", ref: "rnref1" }); tx.objectStore("htokens").add(tok("rffid", 1e9 + 20)); tx.objectStore("htokens").add(tok("rnref1", 1e9 + 21)); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/rf.txt", kind: "file", ref: "/elsewhere.txt", fid: "rffid", migrated: true, sha256: "r", size: 1 }); tx.objectStore("entries").put({ path: "/rn.ipynb", kind: "notebook", ref: "rnref2" }); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["rnref2"]), `a data file's ref changed (its legacy key, following a move) passes; a notebook's ref changed (a new identity) is caught: ${J(sinceC(k))}`);
  // (a subtree removed with its top, the top's token only: passes; a child removed under a folder that stays, with that
  // folder's token: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { for (const [p, f, q] of [["/S", "sfid", 31], ["/S/x.txt", "sxfid", 32], ["/K", "kfid", 33], ["/K/y.txt", "kyfid", 34]]) { tx.objectStore("entries").put({ path: p, kind: p.endsWith(".txt") ? "file" : "folder", ref: null, fid: f, ...(p.endsWith(".txt") ? { migrated: true, sha256: "s", size: 1 } : {}) }); tx.objectStore("htokens").add(tok(f, 1e9 + q)); } });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("/S"); tx.objectStore("entries").delete("/S/x.txt"); tx.objectStore("htokens").add(tok("sfid", 1e9 + 40)); });
  await settle();
  check(sinceC(k).length === 0, `a folder removed with its subtree, the folder's token alone: passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("/K/y.txt"); tx.objectStore("htokens").add(tok("kfid", 1e9 + 41)); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["kyfid"]), `control: a child removed under a folder that stays (the folder's token only): caught: ${J(sinceC(k))}`);
  // (an entry with no identity yet (named by its path) moved: its old path-name removed, a new one of the same kind
  // added with its token: passes; a path-named entry removed with nothing added: caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/pm", kind: "folder", ref: null }); tx.objectStore("entries").put({ path: "/pn", kind: "folder", ref: null }); tx.objectStore("htokens").add(tok("path:/pm", 1e9 + 50)); tx.objectStore("htokens").add(tok("path:/pn", 1e9 + 51)); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("/pm"); tx.objectStore("entries").put({ path: "/pm2", kind: "folder", ref: null }); tx.objectStore("htokens").add(tok("path:/pm2", 1e9 + 52)); });
  await settle();
  check(sinceC(k).length === 0, `an unidentified entry moved (its path-name removed, a new one of its kind added with its token): passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").delete("/pn"));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["path:/pn"]), `control: a path-named entry removed with nothing added: caught: ${J(sinceC(k))}`);
  // (a large move's mapping rows (keys that aren't paths) carry a kind: not source entries, pass; the same row at a path:
  // caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "\u0001m/test/00000", kind: "folder", fid: "mapfid" }); tx.objectStore("entries").put({ path: "/notmap", kind: "folder", fid: "notmapfid" }); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["notmapfid"]), `a large move's mapping row (not a path) is no source entry; the same row at a path is caught: ${J(sinceC(k))}`);
  // (an identity parked by a large move: its row deleted and a staged copy (not a path) carrying the same identity
  // written in one transaction, landing at a path later: passes; a deletion whose staged copy carries ANOTHER identity:
  // caught)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").put({ path: "/pk", kind: "folder", ref: null, fid: "pkfid" }); tx.objectStore("entries").put({ path: "/pk3", kind: "folder", ref: null, fid: "pk3fid" }); tx.objectStore("htokens").add(tok("pkfid", 1e9 + 60)); tx.objectStore("htokens").add(tok("pk3fid", 1e9 + 61)); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("/pk"); tx.objectStore("entries").put({ path: "\u0001s/test/00000", kind: "folder", fid: "pkfid" }); });
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("\u0001s/test/00000"); tx.objectStore("entries").put({ path: "/pk2", kind: "folder", ref: null, fid: "pkfid" }); });
  await settle();
  check(sinceC(k).length === 0, `an identity parked by a large move (deleted, staged under a non-path key, landing at a path later): passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => { tx.objectStore("entries").delete("/pk3"); tx.objectStore("entries").put({ path: "\u0001s/test/00001", kind: "folder", fid: "otherfid" }); });
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["pk3fid"]), `control: a deletion whose staged copy carries another identity: caught: ${J(sinceC(k))}`);
  // (a removal with no token: caught; the same during a reset to a new workspace (meta "resetting"): passes)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").delete("/c1.txt"));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["cfid1"]), `control: a removal with no token, no reset under way: caught: ${J(sinceC(k))}`);
  k = G.violations.length;
  await raw(w.ws, ["meta"], (tx) => tx.objectStore("meta").put({ to: "test", seq: 0 }, "resetting"));
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").delete("/c2.txt"));
  await raw(w.ws, ["meta"], (tx) => tx.objectStore("meta").delete("resetting"));
  await settle();
  check(sinceC(k).length === 0, `a removal during a reset to a new workspace (a new lineage, its history emptied with it): passes: ${J(sinceC(k))}`);
  // (G2a: the reset over ("resetting" deleted): a removal with no token is caught again)
  k = G.violations.length;
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").delete("/c3.txt"));
  await settle();
  check(J(sinceC(k).map((x) => x.ident)) === J(["cfid3"]), `control (G2a): after the reset ends, a removal with no token: caught: ${J(sinceC(k))}`);
  // (G2c, documented behaviour: a reset that stopped part way leaves "resetting" set, and removals stay exempt until
  // it is cleared: the app's next open resumes that reset, which finishes emptying the stores and deletes the flag)
  k = G.violations.length;
  await raw(w.ws, ["meta"], (tx) => tx.objectStore("meta").put({ to: "test", seq: 0 }, "resetting"));
  await raw(w.ws, ["entries", "htokens", "hmeta"], (tx) => tx.objectStore("entries").delete("/c4.txt"));
  await settle();
  check(sinceC(k).length === 0, `G2c (documented): a stale "resetting" (a reset stopped part way) still exempts a removal until cleared: ${J(sinceC(k))}`);
  // (G3 inside a reset: history's state removed then passes)
  k = G.violations.length;
  await raw(w.ws, ["hmeta"], (tx) => tx.objectStore("hmeta").delete("probe"));  // (a key history doesn't use: its token counters stay)
  await settle();
  check(sinceC(k).length === 0, `G3: an hmeta key deleted during a reset: passes: ${J(sinceC(k))}`);
  await raw(w.ws, ["meta"], (tx) => tx.objectStore("meta").delete("resetting"));
  // ---- the exact rev (A5, A1-T15, T17, T18): by writer, at the write point
  const opsTx = (stores, f) => new Promise((ok) => { const tx = w.ws.transaction([...stores, "ops", "meta", "htokens", "hmeta"], "readwrite"); f(tx); tx.oncomplete = () => ok(); tx.onabort = () => ok(); });
  const genNow = async () => new Promise((ok) => { const tx = w.ws.transaction(["ops", "meta"]), c = tx.objectStore("ops").openKeyCursor(null, "prev"), f = tx.objectStore("meta").get("opsFloor"); let l = 0; c.onsuccess = () => { l = c.result?.key ?? 0; }; tx.oncomplete = () => ok(Math.max(l, f.result ?? 0)); });
  const waitGuard = () => new Promise((r) => { const f = () => (G.pending === 0 ? r() : setTimeout(f, 20)); f(); });
  // (three ops in ONE transaction, each with its token at its own seq: none; all at the last seq: exactly two)
  for (const [label, stamp, want] of [["each at its own op's seq", "own", 0], ["all at the transaction-end seq", "end", 2]]) {
    const g0 = await genNow(), ids = ["x1", "x2", "x3"].map((x) => x + Math.random().toString(36).slice(2, 6));
    k = G.violations.length;
    await opsTx([], (tx) => {
      ids.forEach((id, i) => {
        tx.objectStore("ops").add({ op: "mkdir", path: "/" + id, kind: "folder", fid: id, t: 1, device: "d", by: "x" });
        tx.objectStore("htokens").add({ seq: 1e9 + Math.random() * 1e6, ident: id, rev: stamp === "own" ? g0 + i + 1 : g0 + 3, kind: "folder", chain: [], sz: 1 });
      });
    });
    await waitGuard();
    check(since(k).filter((v) => /rev/.test(v.why)).length === want, `A1-T17: three ops in one transaction, tokens ${label}: ${want} rev violations (${J(since(k).map((v) => v.why))})`);
  }
  // (a no-op token: at the generation the transaction began with, none; one below it, exactly one)
  for (const [label, d, want] of [["at the begin generation", 0, 0], ["at begin - 1", -1, 1]]) {
    const g0 = await genNow();
    k = G.violations.length;
    await opsTx(["entries"], (tx) => { tx.objectStore("entries").put({ path: "/np" + d + Math.random(), kind: "file", fid: "np" + label.length + d, sha256: "x", size: 1 }); tx.objectStore("htokens").add({ seq: 2e9 + Math.random() * 1e6, ident: "np" + label.length + d, rev: g0 + d, kind: "file", chain: [], sz: 1 }); });
    await waitGuard();
    check(since(k).filter((v) => /rev/.test(v.why)).length === want, `A1-T17: a no-op token ${label}: ${want} rev violation (${J(since(k).map((v) => v.why))})`);
  }
  // (a no-op token after an op of its own transaction, at s - 5: exactly one)
  {
    const g0 = await genNow();
    k = G.violations.length;
    await opsTx(["entries"], (tx) => {
      tx.objectStore("ops").add({ op: "mkdir", path: "/q5", kind: "folder", fid: "q5f", t: 1, device: "d", by: "x" });
      tx.objectStore("htokens").add({ seq: 3e9, ident: "q5f", rev: g0 + 1, kind: "folder", chain: [], sz: 1 });
      tx.objectStore("entries").put({ path: "/q5x", kind: "file", fid: "q5x", sha256: "x", size: 1 });
      tx.objectStore("htokens").add({ seq: 3e9 + 1, ident: "q5x", rev: g0 + 1 - 5, kind: "file", chain: [], sz: 1 });
    });
    await waitGuard();
    check(J(since(k).filter((v) => /rev/.test(v.why)).map((v) => v.ident)) === J(["q5x"]), `A1-T17: a no-op token after an op, at s - 5: exactly one violation (${J(since(k).map((v) => [v.ident, v.why]))})`);
  }
  // (T18: a board's content token right after an UNRELATED file op is judged by its writer: the row's rev, no violation)
  {
    const g0 = await genNow();
    k = G.violations.length;
    await opsTx(["boards"], (tx) => {
      tx.objectStore("ops").add({ op: "write", path: "/u.txt", kind: "file", fid: "ufid", t: 1, device: "d", by: "x" });
      tx.objectStore("htokens").add({ seq: 4e9, ident: "ufid", rev: g0 + 1, kind: "file", chain: [], sz: 1 });
      tx.objectStore("boards").put({ id: "bd18", doc: { title: "t", nodes: [] }, rev: 7, updated: 1 });
      tx.objectStore("htokens").add({ seq: 4e9 + 1, ident: "bd18", rev: 7, kind: "board", chain: null, sz: 1 });
    });
    await waitGuard();
    check(since(k).filter((v) => /rev/.test(v.why)).length === 0, `A1-T18: a board content token after an unrelated op: judged by its writer (the row's rev), no violation (${J(since(k))})`);
  }
  w.close?.();
}

// ---- G2b: "purgeMain" exempts removals only in the notebooks database of the workspace that set it
{
  const a = await W.Workspace.open({ name: `hgw-${++n}`, mainName: `hgm-${n}` });
  const b = await W.Workspace.open({ name: `hgw-${++n}`, mainName: `hgm-${n}` });
  for (const x of [a, b]) await raw(x.main, ["notebooks", "htokens", "hmeta"], (tx) => { tx.objectStore("notebooks").put({ id: "pnb", cells: [], rev: 1 }); tx.objectStore("htokens").add(tok("pnb", 5e9)); });
  await raw(a.ws, ["meta"], (tx) => tx.objectStore("meta").put(true, "purgeMain"));
  let k = G.violations.length;
  await raw(b.main, ["notebooks", "htokens", "hmeta"], (tx) => tx.objectStore("notebooks").delete("pnb"));
  await settle();
  check(J(sinceC(k).map((x) => [x.db, x.ident])) === J([[b.main.name, "pnb"]]), `control (G2b): workspace A's purgeMain, a removal in workspace B's notebooks database: caught: ${J(sinceC(k))}`);
  k = G.violations.length;
  await raw(a.main, ["notebooks", "htokens", "hmeta"], (tx) => tx.objectStore("notebooks").delete("pnb"));
  await settle();
  check(sinceC(k).length === 0, `G2b: the same removal in workspace A's own notebooks database, during its purge: passes: ${J(sinceC(k))}`);
  await raw(a.ws, ["meta"], (tx) => tx.objectStore("meta").delete("purgeMain"));
  a.close?.(); b.close?.();
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
