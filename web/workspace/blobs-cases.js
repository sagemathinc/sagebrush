// The cases of web/workspace/test-workspace-blobs.mjs (copy-on-write for workspace branches, its first step): the schema
// (version 11 and its upgrade from 10), the blob helpers' contract (scope, canonical references, the free once nothing names a blob, the versions'
// mirror, the physical total), the readers, reconcile and the reset; with the runtime guard on throughout and the
// invariant checker after every committed transaction (blobs-check.js), and controls showing both can fail.
import * as W from "./ws.js";
import { check, installGuard } from "./check.js";

const results = [];
const ok = (c, what) => results.push([!!c, what]);
let n = 0;
const names = () => { n++; return { name: `ws-blob-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-blob-${n}` }; };
const guard = installGuard(W.BLOB_HOOK);
const fresh = async () => { localStorage.clear(); const w = await W.Workspace.open(names()); guard.watch(w.ws); return w; };
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => (b ? new TextDecoder().decode(b) : null);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const H = async (b) => hex(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc(b) : b));
const J = (x) => JSON.stringify(x);
const scope = [...W.BLOB_SCOPE];
const tx = (w, f, stores = scope, mode = "readwrite") => W.inTx(w.ws, stores, mode, f);
const fails = async (p) => { try { await p; return null; } catch (e) { return e; } };
const get = (db, store, k) => new Promise((res, no) => { const r = db.transaction(store).objectStore(store).get(k); r.onsuccess = () => res(r.result); r.onerror = () => no(r.error); });
const total = async (w) => (await get(w.ws, "meta", W.BLOB_BYTES)) ?? 0;
let fidN = 0;
const entry = async (path, bytes, extra = {}) => {
  const sha = await H(bytes), fid = "f" + String(++fidN).padStart(15, "0");
  return { path, kind: "file", ref: path, fid, ident: fid, migrated: true, rev: 1, size: bytes.length, sha256: sha, blob: sha, created: 1, updated: 1, ...extra };
};
const version = async (fid, bytes) => { const sha = await H(bytes); return { fid, t: Date.now(), size: bytes.length, sha256: sha, blob: sha, by: "test", device: "d" }; };
// (no violation from the guard or the checker since the last call: every case ends with it)
const clean = async (what) => { await guard.settled(); const v = guard.take(); ok(v.length === 0, `${what}: the guard and the checker after every commit found nothing${v.length ? ": " + v.slice(0, 3).join(" | ") : ""}`); };

async function schema() {
  const w = await fresh();
  const db = w.ws, t = db.transaction(["entries"]);
  ok(W.WS_VERSION === 11 && db.version === 11, `the workspace is version 11 (${db.version})`);
  ok(db.objectStoreNames.contains("blobs") && db.objectStoreNames.contains("versionBlobs"), "blobs and versionBlobs are made");
  ok(t.objectStore("entries").indexNames.contains("byBlob"), "entries have the index byBlob");
  const vb = db.transaction("versionBlobs").objectStore("versionBlobs");
  ok(J(vb.keyPath) === J(["sha", "id"]) && vb.indexNames.length === 0, `versionBlobs is keyed [sha, id], with no index (${J(vb.keyPath)})`);
  ok(!db.transaction("versions").objectStore("versions").indexNames.contains("byBlob"), "no index is made over the versions already kept");
  // (the upgrade from 10: a workspace made as version 10 was, with entries and versions, opened by this build)
  const nm = names();
  const old = await W.openWorkspaceDb(nm.name, () => {}, undefined, undefined, 10);
  ok(old.version === 10 && !old.objectStoreNames.contains("blobs"), "a version-10 workspace has no blob stores");
  await new Promise((res, no) => { const x = old.transaction(["entries", "versions"], "readwrite"); x.objectStore("entries").put({ path: "/old.txt", kind: "file", ref: "/old.txt", fid: "a".repeat(16), migrated: true, size: 1, created: 1, updated: 1 }); x.objectStore("versions").put({ fid: "a".repeat(16), t: 1, size: 1, sha256: "0".repeat(64), by: "x", device: "d" }); x.oncomplete = res; x.onerror = () => no(x.error); });
  old.close();
  localStorage.clear();
  const up = await W.Workspace.open(nm);
  guard.watch(up.ws);
  ok(up.ws.version === 11 && up.ws.objectStoreNames.contains("blobs"), "opened by this build, it is upgraded to 11");
  const e = await up.stat("/old.txt");
  ok(e?.fid === "a".repeat(16) && e.blob === undefined, "its entries are as they were, and none names a blob");
  ok((await check(up.ws)).length === 0, "the checker finds nothing in the upgraded workspace");
  await clean("schema");
}

async function scopes() {
  const w = await fresh(), e = await entry("/s.txt", enc("scope"));
  for (const missing of scope) {
    const err = await fails(tx(w, (t) => W.setEntryBlob(t, undefined, e, enc("scope")), scope.filter((s) => s !== missing)));
    ok(err?.name === "BlobError" && err.code === "scope", `a helper refuses a transaction without ${missing} (${err?.message})`);
  }
  const ro = await fails(tx(w, (t) => W.dropBlobRef(t, e.blob, 5), scope, "readonly"));
  ok(ro?.code === "scope", "dropBlobRef refuses a readonly transaction");
  ok((await total(w)) === 0 && !(await get(w.ws, "blobs", e.blob)), "nothing was written by any of them");
  await clean("scopes");
}

async function canonical() {
  const w = await fresh(), b = enc("canon"), e = await entry("/c.txt", b);
  const bad = [
    ["an uppercase sha", { ...e, blob: e.blob.toUpperCase(), sha256: e.blob.toUpperCase() }],
    ["a short sha", { ...e, blob: e.blob.slice(1), sha256: e.blob.slice(1) }],
    ["a blob that isn't its sha256", { ...e, sha256: "0".repeat(64) }],
    ["a folder naming a blob", { ...e, kind: "folder" }],
    ["no size", { ...e, size: undefined }],
  ];
  for (const [what, x] of bad) {
    const err = await fails(tx(w, (t) => W.setEntryBlob(t, undefined, x, b)));
    ok(err?.code === "invalid", `refused at write: ${what} (${err?.message})`);
  }
  const v = await version(e.fid, b);
  ok((await fails(tx(w, (t) => W.putVersionBlob(t, { ...v, sha256: "1".repeat(64) }, b))))?.code === "invalid", "refused at write: a version whose blob isn't its sha256");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, { ...e, size: 4 }, b))))?.code === "invalid", "refused: bytes that aren't the reference's size");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, e))))?.code === "missing", "refused: a new blob with no bytes");
  ok((await total(w)) === 0 && !(await w.stat("/c.txt")), "nothing was written by any of them");
  await clean("canonical");
}

async function lifecycle() {
  const w = await fresh(), b = enc("shared bytes"), sha = await H(b);
  const a = await entry("/a.txt", b), c = await entry("/c.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, a, b));
  ok((await total(w)) === b.length && dec(await get(w.ws, "blobs", sha)) === "shared bytes", `a new file's blob is kept, and the total is its size (${await total(w)})`);
  await tx(w, (t) => W.setEntryBlob(t, undefined, c));
  ok((await total(w)) === b.length, "a second file with the same bytes adds nothing (no bytes given, none needed)");
  // (a same-sha write: no transition, nothing dropped, and nothing counted: no count request at all)
  const counts = { n: 0 }, ic = IDBIndex.prototype.count, sc = IDBObjectStore.prototype.count;
  IDBIndex.prototype.count = function (...x) { counts.n++; return ic.apply(this, x); };
  IDBObjectStore.prototype.count = function (...x) { counts.n++; return sc.apply(this, x); };
  try { await tx(w, (t) => W.setEntryBlob(t, a, { ...a, rev: 2 })); } finally { IDBIndex.prototype.count = ic; IDBObjectStore.prototype.count = sc; }
  ok(!!(await get(w.ws, "blobs", sha)) && counts.n === 0, `a write of the same bytes drops nothing, and counts nothing (${counts.n} count requests)`);
  await tx(w, (t) => W.clearEntryBlob(t, a));
  ok(!!(await get(w.ws, "blobs", sha)) && (await total(w)) === b.length, "one of two files removed: the blob stays (the other names it)");
  const r = await tx(w, async (t) => { await W.clearEntryBlob(t, c); return (await W.req(t.objectStore("blobs").getKey(sha))) === undefined; });
  ok(r && !(await get(w.ws, "blobs", sha)) && (await total(w)) === 0, "the last one removed: the blob is deleted, and the total is 0");
  // (a write that changes the bytes: the old blob dropped once nothing names it)
  const b1 = enc("one"), b2 = enc("two"), f = await entry("/f.txt", b1);
  await tx(w, (t) => W.setEntryBlob(t, undefined, f, b1));
  const f2 = { ...f, rev: 2, sha256: await H(b2), blob: await H(b2), size: b2.length };
  await tx(w, (t) => W.setEntryBlob(t, f, f2, b2));
  ok(!(await get(w.ws, "blobs", f.blob)) && dec(await get(w.ws, "blobs", f2.blob)) === "two" && (await total(w)) === 3, "a write with new bytes: the new blob kept, the old one deleted");
  // (a move: the old path's row goes, the blob stays)
  await tx(w, (t) => W.setEntryBlob(t, f2, { ...f2, path: "/g.txt", ref: "/g.txt" }));
  ok(!(await w.stat("/f.txt")) && (await w.stat("/g.txt"))?.blob === f2.blob && !!(await get(w.ws, "blobs", f2.blob)), "a move keeps the blob, at the new path only");
  await clean("lifecycle");
}

async function versions() {
  const w = await fresh(), b = enc("live and kept"), e = await entry("/v.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  const v = await version(e.fid, b);
  const id = await tx(w, (t) => W.putVersionBlob(t, v));
  ok(Number.isSafeInteger(id) && (await total(w)) === b.length, "a version of the same bytes costs nothing");
  const rows = await new Promise((res) => { const r = w.ws.transaction("versionBlobs").objectStore("versionBlobs").getAllKeys(); r.onsuccess = () => res(r.result); });
  ok(J(rows) === J([[e.blob, id]]), `its mirror row is [sha, id] (${J(rows)})`);
  // (ENGINE's example: the live file changes; the version still names the old bytes; then the version goes)
  const b2 = enc("changed"), e2 = { ...e, rev: 2, size: b2.length, sha256: await H(b2), blob: await H(b2) };
  await tx(w, (t) => W.setEntryBlob(t, e, e2, b2));
  ok(dec(await get(w.ws, "blobs", e.blob)) === "live and kept", "the live file changed: the old bytes stay, the version names them");
  await tx(w, (t) => W.dropVersionBlob(t, { ...v, id }));
  ok(!(await get(w.ws, "blobs", e.blob)) && (await total(w)) === b2.length, "the version dropped: the old bytes are deleted, the total is the live file's");
  const left = await new Promise((res) => { const r = w.ws.transaction("versionBlobs").objectStore("versionBlobs").count(); r.onsuccess = () => res(r.result); });
  ok(left === 0, "and its mirror row is gone with it");
  await clean("versions");
}

async function pins() {
  const w = await fresh(), b = enc("pinned"), e = await entry("/p.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  // (a pin on "b:" storage, as the pin helpers that come with the blob writes will take one, written here raw)
  await tx(w, async (t) => { t.objectStore("pins").put({ id: e.fid, seq: 1, path: e.path, sha256: e.blob, size: b.length, epoch: 1, storage: { blob: e.blob }, skey: W.blobSkey(e.blob) }); });
  await tx(w, (t) => W.clearEntryBlob(t, e));
  ok(!!(await get(w.ws, "blobs", e.blob)), "the file removed while a pin names its bytes: the blob stays");
  const r = await tx(w, async (t) => { t.objectStore("pins").delete([e.fid, 1]); return W.dropBlobRef(t, e.blob, b.length); });
  ok(r === "deleted" && !(await get(w.ws, "blobs", e.blob)), "the pin released, then dropBlobRef: deleted");
  await clean("pins");
}

async function integrity() {
  const w = await fresh(), b = enc("original"), e = await entry("/i.txt", b);
  const buf = enc("original");
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, buf));
  buf.set(enc("XXXXXXXX"));
  ok(dec(await get(w.ws, "blobs", e.blob)) === "original", "the caller's buffer changed after the write: the stored blob is unchanged");
  // (a put of the same sha with other bytes keeps the original: a blob is never overwritten)
  const forged = enc("forgery!"), c = { ...(await entry("/j.txt", b)) };
  await tx(w, (t) => W.setEntryBlob(t, undefined, c, forged));
  ok(dec(await get(w.ws, "blobs", e.blob)) === "original" && (await total(w)) === b.length, "a same-sha put with other bytes keeps the original");
  // (an error after the helpers in the same transaction aborts it all, as a quota failure would)
  const d = await entry("/k.txt", enc("aborted"));
  const err = await fails(tx(w, async (t) => { await W.setEntryBlob(t, undefined, d, enc("aborted")); throw new DOMException("the quota (a test's)", "QuotaExceededError"); }));
  ok(err?.name === "QuotaExceededError" && !(await get(w.ws, "blobs", d.blob)) && !(await w.stat("/k.txt")) && (await total(w)) === b.length, "an abort after the helpers: no blob, no entry, the total unchanged");
  await clean("integrity");
}

async function readers() {
  const w = await fresh(), b = enc("read me"), e = await entry("/r.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  const st = await w.stat("/r.txt");
  ok(dec(await w.contents(st)) === "read me", "contents() reads a blob entry's bytes");
  ok((await w.present("/r.txt")) === true, "present() finds them by key");
  const files = await w.dataFiles();
  ok(files.some(([p, x]) => p === "/r.txt" && dec(x) === "read me"), "dataFiles() includes them");
  // (a missing blob: said as not here, never another file's bytes)
  const m = await entry("/m.txt", enc("never kept"));
  guard.pause();
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put(m); x.oncomplete = res; });
  const mst = await w.stat("/m.txt");
  ok((await w.contents(mst)) === undefined && (await w.present("/m.txt")) === false, "a blob entry whose blob is missing reads as not here");
  ok((await fails(tx(w, (t) => W.readBlob(t, m.blob), ["blobs"], "readonly")))?.code === "missing", "readBlob says missing, as a typed error");
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").delete("/m.txt"); x.oncomplete = res; });
  guard.resume();
  await clean("readers");
}

async function reconciling() {
  const w = await fresh(), b = enc("by blob"), e = await entry("/b.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  const r = { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await w.locked(() => W.reconcile(w, false, r));
  ok(!(await w.stat("/b.txt"))?.missing && r.missing === 0, `reconcile never marks a blob entry missing because fileBytes has no row for it (${J(r)})`);
  // (one whose blob is gone, beside one whose blob is kept: marked missing)
  const g = await entry("/gone.txt", enc("gone"));
  guard.pause();
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put(g); x.oncomplete = res; });
  const r2 = { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await w.locked(() => W.reconcile(w, false, r2));
  ok((await w.stat("/gone.txt"))?.missing === true && !(await w.stat("/b.txt"))?.missing, "one whose blob is gone is marked missing, the other not");
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").delete("/gone.txt"); x.oncomplete = res; });
  guard.resume();
  await clean("reconcile");
}

async function resetting() {
  const w = await fresh(), b = enc("reset me"), e = await entry("/z.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  const v = await version(e.fid, b);
  await tx(w, (t) => W.putVersionBlob(t, v));
  await w.reset("new");
  const left = await Promise.all(["blobs", "versionBlobs"].map((s) => new Promise((res) => { const r = w.ws.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); })));
  ok(J(left) === "[0,0]" && (await total(w)) === 0, `a reset empties blobs and versionBlobs, and the total goes with them (${J(left)})`);
  await clean("reset (its blob deletes allowed, in its own pages)");
}

async function controls() {
  const w = await fresh(), b = enc("control"), e = await entry("/x.txt", b);
  await tx(w, (t) => W.setEntryBlob(t, undefined, e, b));
  await clean("controls' setup");
  // (the guard: a delete on blobs outside a helper and outside a reset is caught)
  await new Promise((res) => { const x = w.ws.transaction("blobs", "readwrite"); x.objectStore("blobs").delete("0".repeat(64)); x.oncomplete = res; });
  await guard.settled();
  ok(guard.take().some((v) => /delete on blobs outside a blob helper/.test(v)), "control: a raw delete on blobs is caught by the guard");
  await new Promise((res) => { const x = w.ws.transaction("versionBlobs", "readwrite"); const c = x.objectStore("versionBlobs").openCursor(); c.onsuccess = () => res(); x.objectStore("versionBlobs").clear(); x.oncomplete = res; });
  await guard.settled();
  ok(guard.take().some((v) => /clear on versionBlobs/.test(v)), "control: a clear on versionBlobs is caught");
  // (the checker, each kind of drift planted with the guard paused)
  const plant = async (f) => { guard.pause(); await f(); guard.resume(); const v = await check(w.ws); return v; };
  const raw = (store, f) => new Promise((res) => { const x = w.ws.transaction(store, "readwrite"); f(x.objectStore(store)); x.oncomplete = res; });
  const v = await version(e.fid, b), vid = await tx(w, (t) => W.putVersionBlob(t, v));
  await clean("controls' version");
  let got = await plant(() => raw("versionBlobs", (s) => s.delete([e.blob, vid])));
  ok(got.some((x) => /versionBlobs .*: missing/.test(x)), `control V1: a missing mirror row is caught (${got[0]})`);
  await plant(() => raw("versionBlobs", (s) => s.put({ sha: e.blob, id: vid })));
  got = await plant(() => raw("versionBlobs", (s) => s.put({ sha: e.blob, id: vid + 1000 })));
  ok(got.some((x) => /no version names it/.test(x)), "control V2: an obsolete mirror row is caught");
  await plant(() => raw("versionBlobs", (s) => s.delete([e.blob, vid + 1000])));
  got = await plant(() => raw("versionBlobs", (s) => { s.delete([e.blob, vid]); s.put({ sha: "f".repeat(64), id: vid }); }));
  ok(got.some((x) => /missing/.test(x)) && got.some((x) => /no version names it/.test(x)), "control: a mirror row with the wrong sha is caught");
  await plant(() => raw("versionBlobs", (s) => { s.delete(["f".repeat(64), vid]); s.put({ sha: e.blob, id: vid + 1 }); }));
  got = await check(w.ws);
  ok(got.some((x) => /missing/.test(x)) && got.some((x) => /no version names it/.test(x)), "control: a mirror row with the wrong id is caught");
  await plant(() => raw("versionBlobs", (s) => { s.delete([e.blob, vid + 1]); s.put({ sha: e.blob, id: vid }); }));
  got = await plant(() => raw("blobs", (s) => s.put(enc("leak"), "1".repeat(64))));
  ok(got.some((x) => /nothing names it \(a leak\)/.test(x)) && got.some((x) => /hash to/.test(x)), "control: a leaked blob (and a wrong hash) is caught");
  await plant(() => raw("blobs", (s) => s.delete("1".repeat(64))));
  got = await plant(() => raw("blobs", (s) => s.put(enc("CONTROL"), e.blob)));
  ok(got.some((x) => /hash to/.test(x)), "control: a damaged blob (bytes not matching its sha) is caught");
  await plant(() => raw("blobs", (s) => s.put(b, e.blob)));
  got = await plant(() => raw("meta", (s) => s.put(1, W.BLOB_BYTES)));
  ok(got.some((x) => /blobBytes 1/.test(x)), "control: a wrong total is caught");
  await plant(() => raw("meta", (s) => s.put(b.length, W.BLOB_BYTES)));
  ok((await check(w.ws)).length === 0, "after the controls, the workspace checks clean again");
  guard.take();
}

export async function run() {
  for (const c of [schema, scopes, canonical, lifecycle, versions, pins, integrity, readers, reconciling, resetting, controls]) {
    try { await c(); } catch (e) { ok(false, `${c.name} threw: ${e?.stack ?? e}`); }
  }
  ok(guard.checks() > 10, `the checker ran after ${guard.checks()} commits`);
  return results;
}
