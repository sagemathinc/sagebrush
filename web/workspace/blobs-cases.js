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
// (bytes admitted first, outside the transaction, as every caller must: hashing awaits WebCrypto, which no
// IndexedDB transaction may wait for; then the transaction, given the admitted bytes)
const txa = async (w, bytes, f, stores = scope, mode = "readwrite") => { const ab = await W.admitBytes(bytes); return tx(w, (t) => f(t, ab), stores, mode); };
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
    const err = await fails(txa(w, enc("scope"), (t, ab) => W.setEntryBlob(t, undefined, e, ab), scope.filter((s) => s !== missing)));
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
    const err = await fails(txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, x, ab)));
    ok(err?.code === "invalid", `refused at write: ${what} (${err?.message})`);
  }
  const v = await version(e.fid, b);
  ok((await fails(txa(w, b, (t, ab) => W.putVersionBlob(t, { ...v, sha256: "1".repeat(64) }, ab))))?.code === "invalid", "refused at write: a version whose blob isn't its sha256");
  ok((await fails(txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, { ...e, size: 4 }, ab))))?.code === "invalid", "refused: bytes that aren't the reference's size");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, e))))?.code === "missing", "refused: a new blob with no bytes");
  ok((await total(w)) === 0 && !(await w.stat("/c.txt")), "nothing was written by any of them");
  await clean("canonical");
}

async function lifecycle() {
  const w = await fresh(), b = enc("shared bytes"), sha = await H(b);
  const a = await entry("/a.txt", b), c = await entry("/c.txt", b);
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, a, ab));
  ok((await total(w)) === b.length && dec(await get(w.ws, "blobs", sha)) === "shared bytes", `a new file's blob is kept, and the total is its size (${await total(w)})`);
  await tx(w, (t) => W.setEntryBlob(t, undefined, c));
  ok((await total(w)) === b.length, "a second file with the same bytes adds nothing (no bytes given, none needed)");
  // (a third, given the same bytes, admitted: the blob already kept stays as it is, once)
  const c3 = { ...(await entry("/c3.txt", b)) };
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, c3, ab));
  ok((await total(w)) === b.length && dec(await get(w.ws, "blobs", sha)) === "shared bytes", "a third, given the same bytes: still one blob, the total unchanged");
  await tx(w, (t) => W.clearEntryBlob(t, c3));
  // (a same-sha write: no transition, nothing dropped, and nothing counted: no count request at all)
  const counts = { n: 0 }, ic = IDBIndex.prototype.count, sc = IDBObjectStore.prototype.count;
  IDBIndex.prototype.count = function (...x) { counts.n++; return ic.apply(this, x); };
  IDBObjectStore.prototype.count = function (...x) { counts.n++; return sc.apply(this, x); };
  const a2 = { ...a, rev: 2 };
  try { await tx(w, (t) => W.setEntryBlob(t, a, a2)); } finally { IDBIndex.prototype.count = ic; IDBObjectStore.prototype.count = sc; }
  ok(!!(await get(w.ws, "blobs", sha)) && counts.n === 0, `a write of the same bytes drops nothing, and counts nothing (${counts.n} count requests)`);
  // (the caller's row stale: refused, and nothing written)
  ok((await fails(tx(w, (t) => W.clearEntryBlob(t, a))))?.code === "changed" && (await w.stat("/a.txt"))?.rev === 2, "a row passed as it was before a write (stale) is refused: nothing removed");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, a, { ...a, rev: 3 }))))?.code === "changed" && (await w.stat("/a.txt"))?.rev === 2, "and written over from its stale form: refused");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, a2, { ...a2, path: "/c.txt", ref: "/c.txt" }))))?.code === "changed" && !!(await w.stat("/a.txt")), "a move onto another file's path is refused");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, { ...c, fid: "f" + "8".repeat(15) }))))?.code === "changed", "a new file at a path already taken is refused");
  await tx(w, (t) => W.clearEntryBlob(t, a2));
  ok(!!(await get(w.ws, "blobs", sha)) && (await total(w)) === b.length, "one of two files removed: the blob stays (the other names it)");
  const r = await tx(w, async (t) => { await W.clearEntryBlob(t, c); return (await W.req(t.objectStore("blobs").getKey(sha))) === undefined; });
  ok(r && !(await get(w.ws, "blobs", sha)) && (await total(w)) === 0, "the last one removed: the blob is deleted, and the total is 0");
  // (a write that changes the bytes: the old blob dropped once nothing names it)
  const b1 = enc("one"), b2 = enc("two"), f = await entry("/f.txt", b1);
  await txa(w, b1, (t, ab) => W.setEntryBlob(t, undefined, f, ab));
  const f2 = { ...f, rev: 2, sha256: await H(b2), blob: await H(b2), size: b2.length };
  await txa(w, b2, (t, ab) => W.setEntryBlob(t, f, f2, ab));
  ok(!(await get(w.ws, "blobs", f.blob)) && dec(await get(w.ws, "blobs", f2.blob)) === "two" && (await total(w)) === 3, "a write with new bytes: the new blob kept, the old one deleted");
  // (a move: the old path's row goes, the blob stays)
  await tx(w, (t) => W.setEntryBlob(t, f2, { ...f2, path: "/g.txt", ref: "/g.txt" }));
  ok(!(await w.stat("/f.txt")) && (await w.stat("/g.txt"))?.blob === f2.blob && !!(await get(w.ws, "blobs", f2.blob)), "a move keeps the blob, at the new path only");
  await clean("lifecycle");
}

async function versions() {
  const w = await fresh(), b = enc("live and kept"), e = await entry("/v.txt", b);
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  const v = await version(e.fid, b);
  const id = await tx(w, (t) => W.putVersionBlob(t, v));
  ok(Number.isSafeInteger(id) && (await total(w)) === b.length, "a version of the same bytes costs nothing");
  const rows = await new Promise((res) => { const r = w.ws.transaction("versionBlobs").objectStore("versionBlobs").getAllKeys(); r.onsuccess = () => res(r.result); });
  ok(J(rows) === J([[e.blob, id]]), `its mirror row is [sha, id] (${J(rows)})`);
  // (a version already kept is never put again: refused, nothing changed)
  const other = await version(e.fid, enc("other bytes"));
  const again = await fails(txa(w, enc("other bytes"), (t, ab) => W.putVersionBlob(t, { ...other, id }, ab)));
  const rows2 = await new Promise((res) => { const r = w.ws.transaction("versionBlobs").objectStore("versionBlobs").getAllKeys(); r.onsuccess = () => res(r.result); });
  ok(again?.code === "invalid" && J(rows2) === J([[e.blob, id]]) && !(await get(w.ws, "blobs", other.blob)), `putVersionBlob refuses an id already kept, and changes nothing (${again?.message})`);
  // (the live file changes; the version still names the old bytes; then the version goes)
  const b2 = enc("changed"), e2 = { ...e, rev: 2, size: b2.length, sha256: await H(b2), blob: await H(b2) };
  await txa(w, b2, (t, ab) => W.setEntryBlob(t, e, e2, ab));
  ok(dec(await get(w.ws, "blobs", e.blob)) === "live and kept", "the live file changed: the old bytes stay, the version names them");
  ok((await fails(tx(w, (t) => W.dropVersionBlob(t, { ...v, id, size: v.size + 1 }))))?.code === "changed", "a version passed not as it is kept is refused on drop");
  await tx(w, (t) => W.dropVersionBlob(t, { ...v, id }));
  ok(!(await get(w.ws, "blobs", e.blob)) && (await total(w)) === b2.length, "the version dropped: the old bytes are deleted, the total is the live file's");
  const left = await new Promise((res) => { const r = w.ws.transaction("versionBlobs").objectStore("versionBlobs").count(); r.onsuccess = () => res(r.result); });
  ok(left === 0, "and its mirror row is gone with it");
  await clean("versions");
}

async function pins() {
  const w = await fresh(), b = enc("pinned"), e = await entry("/p.txt", b);
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  // (a pin on "b:" storage, as the pin helpers that come with the blob writes will take one, written here raw)
  await guard.pause();
  await tx(w, async (t) => { t.objectStore("pins").put({ id: e.fid, seq: 1, path: e.path, sha256: e.blob, size: b.length, epoch: 1, storage: { blob: e.blob }, skey: W.blobSkey(e.blob) }); });
  guard.resume();
  await tx(w, (t) => W.clearEntryBlob(t, e));
  ok(!!(await get(w.ws, "blobs", e.blob)), "the file removed while a pin names its bytes: the blob stays");
  // (the stand-in pin released by hand too, then dropBlobRef, as the pin helpers will)
  await guard.pause();
  const r = await tx(w, async (t) => { t.objectStore("pins").delete([e.fid, 1]); return W.dropBlobRef(t, e.blob, b.length); });
  guard.resume();
  ok(r === "deleted" && !(await get(w.ws, "blobs", e.blob)), "the pin released, then dropBlobRef: deleted");
  await clean("pins");
}

async function integrity() {
  const w = await fresh(), b = enc("original"), e = await entry("/i.txt", b);
  const buf = enc("original");  // (kept as given: admitted, then changed after the write)
  await txa(w, buf, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  buf.set(enc("XXXXXXXX"));
  ok(dec(await get(w.ws, "blobs", e.blob)) === "original", "the caller's buffer changed after the write: the stored blob is unchanged");
  // (bytes not admitted for this reference: other bytes (another sha), or raw bytes never admitted, are refused)
  const forged = enc("forgery!"), c = { ...(await entry("/j.txt", b)) };
  ok((await fails(txa(w, forged, (t, ab) => W.setEntryBlob(t, undefined, c, ab))))?.code === "invalid", "bytes admitted under another sha are refused for this reference");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, c, enc("original")))))?.code === "invalid", "raw bytes, never admitted, are refused");
  ok(dec(await get(w.ws, "blobs", e.blob)) === "original" && (await total(w)) === b.length && !(await w.stat("/j.txt")), "the original stays, nothing else written");
  // (the caller's buffer changed synchronously the moment the helper starts, before its first await, and the
  // moment admission starts, before its hash: neither reaches what is kept, which is the admitted copy)
  const live = enc("snapshot"), e3 = await entry("/s3.txt", live), ab3 = await W.admitBytes(live);
  const going = tx(w, (t) => W.setEntryBlob(t, undefined, e3, ab3));
  live.set(enc("XXXXXXXX"));
  await going;
  ok(dec(await get(w.ws, "blobs", e3.blob)) === "snapshot", "the caller's buffer changed as the helper starts: the stored blob is the admitted bytes");
  const live2 = enc("snapsho2"), e4 = await entry("/s4.txt", live2), admitting = W.admitBytes(live2);
  live2.set(enc("YYYYYYYY"));
  const ab4 = await admitting;
  ok(ab4.sha === e4.blob, "the caller's buffer changed as admission starts: the sha is of the bytes given (the copy is made at once)");
  await tx(w, (t) => W.setEntryBlob(t, undefined, e4, ab4));
  ok(dec(await get(w.ws, "blobs", e4.blob)) === "snapsho2", "and what is kept is those bytes");
  // (an error after the helpers in the same transaction aborts it all, as a quota failure would)
  const d = await entry("/k.txt", enc("aborted")), before = await total(w);
  const err = await fails(txa(w, enc("aborted"), async (t, ab) => { await W.setEntryBlob(t, undefined, d, ab); throw new DOMException("the quota (a test's)", "QuotaExceededError"); }));
  ok(err?.name === "QuotaExceededError" && !(await get(w.ws, "blobs", d.blob)) && !(await w.stat("/k.txt")) && (await total(w)) === before, `an abort after the helpers: no blob, no entry, the total unchanged (${err?.name}: ${err?.message}; total ${await total(w)})`);
  // (a kept blob reused with the wrong size recorded: a second owner, a same-sha update, a version; each refused)
  const kb = enc("eight by"), k1 = await entry("/k1.txt", kb);
  await txa(w, kb, (t, ab) => W.setEntryBlob(t, undefined, k1, ab));
  const k2 = { ...(await entry("/k2.txt", kb)), size: 1 };
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, undefined, k2))))?.code === "invalid" && !(await w.stat("/k2.txt")), "a second owner recording the wrong size for a kept blob is refused");
  ok((await fails(tx(w, (t) => W.setEntryBlob(t, k1, { ...k1, rev: 2, size: 1 }))))?.code === "invalid" && (await w.stat("/k1.txt"))?.size === 8, "a same-sha update recording another size is refused");
  const kv = await version(k1.fid, kb);
  ok((await fails(tx(w, (t) => W.putVersionBlob(t, { ...kv, size: 1 }))))?.code === "invalid", "a version recording the wrong size for a kept blob is refused");
  await tx(w, (t) => W.clearEntryBlob(t, k1));
  // (a free that finds the blob not the size its reference recorded, or a total that would go below zero, aborts)
  const z = await entry("/z1.txt", enc("zz"));
  await txa(w, enc("zz"), (t, ab) => W.setEntryBlob(t, undefined, z, ab));
  await guard.pause();
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put({ ...z, size: 3 }); x.oncomplete = res; });
  const mis = await fails(tx(w, (t) => W.clearEntryBlob(t, { ...z, size: 3 })));
  ok(mis?.code === "invalid" && !!(await w.stat("/z1.txt")) && !!(await get(w.ws, "blobs", z.blob)), `a reference whose size isn't its blob's: the free aborts, nothing removed (${mis?.message})`);
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put(z); x.oncomplete = res; });
  const t0 = await total(w);
  await new Promise((res) => { const x = w.ws.transaction("meta", "readwrite"); x.objectStore("meta").put(1, W.BLOB_BYTES); x.oncomplete = res; });
  const neg = await fails(tx(w, (t) => W.clearEntryBlob(t, z)));
  ok(neg?.code === "invalid" && !!(await w.stat("/z1.txt")), `a total that would go below zero aborts (${neg?.message})`);
  await new Promise((res) => { const x = w.ws.transaction("meta", "readwrite"); x.objectStore("meta").put(t0, W.BLOB_BYTES); x.oncomplete = res; });
  guard.resume();
  await tx(w, (t) => W.clearEntryBlob(t, z));
  await clean("integrity");
}

async function readers() {
  const w = await fresh(), b = enc("read me"), e = await entry("/r.txt", b);
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  const st = await w.stat("/r.txt");
  ok(dec(await w.contents(st)) === "read me", "contents() reads a blob entry's bytes");
  ok((await w.present("/r.txt")) === true, "present() finds them by key");
  const files = await w.dataFiles();
  ok(files.some(([p, x]) => p === "/r.txt" && dec(x) === "read me"), "dataFiles() includes them");
  // (a missing blob: said as not here, never another file's bytes)
  const m = await entry("/m.txt", enc("never kept"));
  await guard.pause();
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
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  const r = { boards: 0, copies: 0, unreadable: [], notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await w.locked(() => W.reconcile(w, false, r));
  ok(!(await w.stat("/b.txt"))?.missing && r.missing === 0, `reconcile never marks a blob entry missing because fileBytes has no row for it (${J(r)})`);
  // (one whose blob is gone, beside one whose blob is kept: marked missing)
  const g = await entry("/gone.txt", enc("gone"));
  await guard.pause();
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
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  const v = await version(e.fid, b);
  await tx(w, (t) => W.putVersionBlob(t, v));
  await w.reset("new");
  const left = await Promise.all(["blobs", "versionBlobs"].map((s) => new Promise((res) => { const r = w.ws.transaction(s).objectStore(s).count(); r.onsuccess = () => res(r.result); })));
  ok(J(left) === "[0,0]" && (await total(w)) === 0, `a reset empties blobs and versionBlobs, and the total goes with them (${J(left)})`);
  await clean("reset (its blob deletes allowed, in its own pages)");
}

async function controls() {
  const w = await fresh(), b = enc("control"), e = await entry("/x.txt", b);
  await txa(w, b, (t, ab) => W.setEntryBlob(t, undefined, e, ab));
  await clean("controls' setup");
  // (the guard: a delete on blobs outside a helper and outside a reset is caught)
  await new Promise((res) => { const x = w.ws.transaction("blobs", "readwrite"); x.objectStore("blobs").delete("0".repeat(64)); x.oncomplete = res; });
  await guard.settled();
  ok(guard.take().some((v) => /delete on blobs outside a blob helper/.test(v)), "control: a raw delete on blobs is caught by the guard");
  await new Promise((res) => { const x = w.ws.transaction("versionBlobs", "readwrite"); const c = x.objectStore("versionBlobs").openCursor(); c.onsuccess = () => res(); x.objectStore("versionBlobs").clear(); x.oncomplete = res; });
  await guard.settled();
  ok(guard.take().some((v) => /clear on versionBlobs/.test(v)), "control: a clear on versionBlobs is caught");
  // (a correct reference written outside the helpers: in an entries-only transaction, and in the whole scope but by
  // hand; both caught, though the stored state they leave is valid)
  const e2 = { ...e, path: "/x2.txt", ref: "/x2.txt", fid: "f" + "9".repeat(15), ident: "f" + "9".repeat(15) };
  await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put(e2); x.oncomplete = res; });
  await guard.settled();
  let gv = guard.take();
  ok(gv.some((v) => /written to entries \(put\) outside a blob helper/.test(v)) && gv.some((v) => /written to entries \(put\) in a transaction without the helpers' whole scope/.test(v)) && gv.some((v) => /changed in a transaction without the helpers' whole scope/.test(v)), `control: a blob reference written in an entries-only transaction is caught, as written and as changed (${gv.length})`);
  await new Promise((res) => { const x = w.ws.transaction(scope, "readwrite"); x.objectStore("entries").put({ ...e2, rev: 2 }); x.oncomplete = res; });
  await guard.settled();
  gv = guard.take();
  ok(gv.some((v) => /outside a blob helper/.test(v)) && !gv.some((v) => /whole scope/.test(v)), "control: one written by hand in the whole scope is caught as outside a helper");
  await tx(w, (t) => W.clearEntryBlob(t, { ...e2, rev: 2 }));
  // (a reference removed or stripped by hand while another owner keeps the stores valid: caught by what changed, though
  // the state left is valid; each put back by the helpers after)
  const o2 = { ...e, path: "/x3.txt", ref: "/x3.txt", fid: "f" + "7".repeat(15), ident: "f" + "7".repeat(15) };
  await tx(w, (t) => W.setEntryBlob(t, undefined, o2));
  await clean("controls' second owner");
  const byHand = async (what, f, stores = ["entries"]) => {
    await new Promise((res) => { const x = w.ws.transaction(stores, "readwrite"); f(x); x.oncomplete = res; x.onerror = res; });
    await guard.settled();
    const v = guard.take();
    ok(v.some((x) => /a blob reference changed outside a blob helper: entries:"\/x3\.txt"/.test(x)), `control: ${what} is caught (${v.length})`);
    await guard.pause();
    await new Promise((res) => { const x = w.ws.transaction("entries", "readwrite"); x.objectStore("entries").put(o2); x.oncomplete = res; });
    guard.resume();
  };
  await byHand("an owner deleted by hand in an entries-only transaction", (x) => x.objectStore("entries").delete("/x3.txt"));
  await byHand("an owner's blob stripped by hand (a put without it)", (x) => { const { blob: _b, ...rest } = o2; x.objectStore("entries").put(rest); });
  await byHand("an owner deleted by a cursor", (x) => { const c = x.objectStore("entries").openCursor("/x3.txt"); c.onsuccess = () => c.result?.delete(); });
  await byHand("an owner deleted by hand in the whole scope", (x) => x.objectStore("entries").delete("/x3.txt"), scope);
  await tx(w, (t) => W.clearEntryBlob(t, o2));
  // (the checker, each kind of drift planted with the guard paused)
  const plant = async (f) => { await guard.pause(); await f(); guard.resume(); const v = await check(w.ws); return v; };
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
