// The cases of web/workspace/test-workspace-sync-ops.mjs (sync client step 2a, design/sync-client.md §3,
// §3a), run in the page: every op carries its identity (fid or ref, a data file's sha256 and size, a write's
// base, the folder it puts something in, what it left); a data file's SHA-256 kept on its entry; the
// version 4 upgrade, which only adds stores and indexes (a version 3 workspace's data the same after it but
// for the migration's dropped state), an upgrade cut short leaving version 3 as it was, and the migrator,
// which gives older entries their identity key and older files their hash, idempotently.
import * as W from "./ws.js";

const results = [];
const check = (ok, what) => results.push([!!ok, what]);
let n = 0;
const fresh = async () => {
  n++;
  localStorage.clear();
  return W.Workspace.open({ name: `ws-ops-${n}-${Math.random().toString(36).slice(2, 8)}`, mainName: `main-ops-${n}` });
};
const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dec = (b) => new TextDecoder().decode(b);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const H = async (b) => hex(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc(b) : b));
const all = (db, store, index, key) => new Promise((ok, no) => { const st = db.transaction(store).objectStore(store), r = (index ? st.index(index) : st).getAll(key); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const ops = (w) => all(w.ws, "ops");
// (the ops since `seq`)
const since = async (w, seq) => (await ops(w)).filter((o) => o.seq > seq);
const lastSeq = async (w) => (await ops(w)).reduce((m, o) => Math.max(m, o.seq), 0);
const J = (x) => JSON.stringify(x);
const same = (a, b) => J(a) === J(b);
const HEX16 = /^[0-9a-f]{16}$/;

async function createAndWrite() {
  const w = await fresh();
  const s0 = await lastSeq(w);
  const f = await w.create("/d/x.txt", { content: "abc" });
  const d = await w.stat("/d");
  const [mk, cr] = await since(w, s0);
  const h1 = await H("abc");
  check(mk?.op === "mkdir" && mk.fid === d.fid && HEX16.test(d.fid) && mk.parent === undefined && same(mk.after, { id: d.fid, parent: null, name: "d", kind: "folder", trashed: false }), "mkdir (made for a file): the folder's fid, what it left (in the root: no parent): " + J(mk));
  check(cr?.op === "create" && cr.fid === f.fid && cr.ref === undefined && cr.sha256 === h1 && cr.size === 3 && cr.parent === d.fid && same(cr.after, { id: f.fid, parent: d.fid, name: "x.txt", kind: "file", sha256: h1, size: 3, trashed: false }), "create of a data file: its fid, sha256 and size, the folder it is put in, what it left: " + J(cr));
  check(f.sha256 === h1 && f.ident === f.fid && d.ident === d.fid, "the entries keep their SHA-256 and their identity key: " + J({ sha: f.sha256, ident: f.ident, dident: d.ident }));
  const byId = await all(w.ws, "entries", "byIdent", f.fid);
  check(byId.length === 1 && byId[0].path === "/d/x.txt", "the index byIdent finds an entry by its identity");
  const s1 = await lastSeq(w);
  const r = await w.write("/d/x.txt", "abcd");
  const h2 = await H("abcd");
  const [wr] = await since(w, s1);
  check(wr?.op === "write" && wr.fid === f.fid && wr.sha256 === h2 && wr.size === 4 && wr.base === h1 && wr.parent === d.fid && wr.after?.sha256 === h2 && wr.after?.size === 4, "a write: its new sha256 and size, and the base it replaced: " + J(wr));
  check(r.entry.sha256 === h2 && (await w.stat("/d/x.txt")).sha256 === h2, "…and the entry keeps the new SHA-256 (a write no longer drops it)");
  const s2 = await lastSeq(w);
  await w.write("/d/x.txt", "abcd");
  const [again] = await since(w, s2);
  check(again?.base === h2 && again.sha256 === h2, "the same bytes again: based on, and naming, the same hash: " + J({ base: again?.base, sha: again?.sha256 }));
  const s3 = await lastSeq(w);
  await w.write("/d/x.txt", "", { keepEmpty: false });
  const [emptied] = await since(w, s3);
  check(emptied?.base === h2 && emptied.sha256 === (await H("")) && emptied.size === 0, "emptied (no version kept): still based on the hash it replaced");
  w.close();
}

// the caller's bytes copied by the engine, at the call: no method or getter of a subclass of Uint8Array runs,
// so the bytes kept are the ones given then, and their hash theirs (astra's CORR-9C2-1, residual)
async function copies() {
  const w = await fresh();
  const evil = {
    slice: class extends Uint8Array { slice(a = 0, b = this.length) { return this.subarray(a, b); } },
    set: class extends Uint8Array { set() { this.fill(7); } },
    subarray: class extends Uint8Array { subarray() { return new Uint8Array([7, 7]); } },
    buffer: class extends Uint8Array { get buffer() { return new Uint8Array([7, 7]).buffer; } get byteOffset() { return 0; } get length() { return 0; } get byteLength() { return 0; } },
    species: class extends Uint8Array { static get [Symbol.species]() { return class extends Uint8Array { constructor(n) { super(n); this.fill(7); } }; } },
  };
  const h12 = await H(new Uint8Array([1, 2]));
  for (const [name, C] of Object.entries(evil)) {
    const input = new C([1, 2]);
    const e = await w.create(`/${name}.bin`, { content: input });
    input.fill(9);
    const r = await w.read(e.path);
    const s0 = await lastSeq(w), input2 = new C([1, 2]);
    const p = w.write(e.path, input2);
    input2.fill(9);
    await p;
    const r2 = await w.read(e.path), [wo] = await since(w, s0);
    check(J([...r.content]) === "[1,2]" && r.entry.sha256 === h12 && J([...r2.content]) === "[1,2]" && r2.entry.sha256 === h12 && wo?.sha256 === h12, `a subclass of Uint8Array overriding ${name}: the bytes given at the call kept, with their hash: ` + J({ made: [...r.content], written: [...r2.content] }));
  }
  const dv = new DataView(new Uint8Array([1, 2]).buffer);
  let refused = false;
  try { await w.create("/dv.bin", { content: dv }); } catch (e) { refused = e instanceof W.WorkspaceError && e.code === "invalid"; }
  let refused16 = false;
  try { await w.create("/i16.bin", { content: new Int16Array([1, 2]) }); } catch (e) { refused16 = e instanceof W.WorkspaceError && e.code === "invalid"; }
  check(refused && !(await w.stat("/dv.bin")) && refused16 && !(await w.stat("/i16.bin")), "a DataView or an Int16Array isn't bytes here: refused, nothing made");
  w.close();
}

async function documents() {
  const w = await fresh();
  const s0 = await lastSeq(w);
  const nb = await w.create("/n.ipynb");
  const [cn] = await since(w, s0);
  check(cn?.op === "create" && cn.ref === nb.ref && cn.fid === undefined && cn.sha256 === undefined && cn.parent === undefined && same(cn.after, { id: nb.ref, parent: null, name: "n.ipynb", kind: "notebook", trashed: false }) && nb.ident === nb.ref, "a notebook made: its ref, no hash, what it left: " + J(cn));
  const s1 = await lastSeq(w);
  const bd = await w.create("/g/b.board.json");
  const g = await w.stat("/g");
  const cb = (await since(w, s1)).find((o) => o.op === "create");
  check(cb?.ref === bd.ref && cb.parent === g.fid && cb.after?.parent === g.fid && cb.after?.kind === "board", "a board made in a folder: its ref and the folder's fid: " + J(cb));
  const s2 = await lastSeq(w);
  await w.write("/g/b.board.json", { title: "b", nodes: [{ id: "a", text: "x" }] });
  const [wb] = await since(w, s2);
  check(wb?.op === "write" && wb.ref === bd.ref && wb.base === undefined && wb.sha256 === undefined && wb.after?.id === bd.ref, "a board written: its ref and what it left (a document's contents aren't synced in this slice: no hash): " + J(wb));
  const s3 = await lastSeq(w);
  await w.forget("/n.ipynb");
  const [fg] = await since(w, s3);
  check(fg?.op === "forget" && fg.ref === nb.ref && fg.after === null, "an entry forgotten: its ref, and after null (its identity gone): " + J(fg));
  const s4 = await lastSeq(w);
  const ad = await w.locked(() => w.adopt("/", "kept", ".ipynb", { kind: "notebook", ref: "0123456789ab" }));
  const [ao] = await since(w, s4);
  check(ao?.op === "adopt" && ao.ref === "0123456789ab" && ad.ident === "0123456789ab" && ao.after?.id === "0123456789ab" && ao.after?.name === "kept.ipynb", "an entry adopted: its identity, what it left: " + J(ao));
  w.close();
}

async function moves() {
  const w = await fresh();
  const f = await w.create("/d/x.txt", { content: "abc" });
  await w.create("/d/sub/y.txt", { content: "y" });
  const d = await w.stat("/d");
  const s0 = await lastSeq(w);
  await w.rename("/d/x.txt", "/e/z.txt");
  const e = await w.stat("/e");
  const [mk, rn] = await since(w, s0);
  check(mk?.op === "mkdir" && mk.fid === e.fid && rn?.op === "rename" && rn.fid === f.fid && rn.parent === e.fid && rn.after?.name === "z.txt" && rn.after?.parent === e.fid && rn.after?.sha256 === f.sha256, "a file moved to a new folder: the folder made, then the rename, with the folder it is put in: " + J(rn));
  const s1 = await lastSeq(w);
  await w.rename("/d", "/f");
  const fo = await since(w, s1);
  check(fo.length === 1 && fo[0].op === "rename" && fo[0].fid === d.fid && fo[0].parent === undefined && same(fo[0].after, { id: d.fid, parent: null, name: "f", kind: "folder", trashed: false }), "a folder renamed: one op, its own; what is in it follows it (by its parent's identity): " + J(fo));
  const s2 = await lastSeq(w);
  const tr = await w.remove("/f");
  const made = await since(w, s2), rm = made.find((o) => o.op === "remove"), mt = made.find((o) => o.path === W.TRASH);
  check(!mt || (mt.fid === undefined && !("after" in mt)), "Trash's own folder, made for it: the workspace's, no identity (as the root has none): " + J(mt));
  check(rm?.op === "remove" && rm.fid === d.fid && rm.parent === undefined && rm.after?.trashed === true && rm.after?.parent === null && rm.after?.name === W.nameOf(tr.path), "a folder put in Trash: its fid, what it left (in Trash: trashed, no parent folder), no parent on the op: " + J(rm));
  const s4 = await lastSeq(w);
  await w.restore(tr.path);
  const [rs] = await since(w, s4);
  check(rs?.op === "restore" && rs.fid === d.fid && rs.after?.trashed === false && rs.after?.parent === null && rs.parent === undefined, "restored to the root: what it left, out of Trash: " + J(rs));
  const s5 = await lastSeq(w);
  const t2 = await w.remove("/e/z.txt");
  await w.restore(t2.path);
  const rz = (await since(w, s5)).find((o) => o.op === "restore");
  check(rz?.parent === e.fid && rz.after?.parent === e.fid, "a file restored into its folder: that folder's fid: " + J(rz));
  w.close();
}

async function emptying() {
  const w = await fresh();
  const a = await w.create("/a/one.txt", { content: "1" });
  await w.create("/a/two.txt", { content: "2" });
  const b = await w.create("/b.txt", { content: "b" });
  const c = await w.create("/c.txt", { content: "c" });
  const fa = await w.stat("/a");
  const ta = await w.remove("/a"), tb = await w.remove("/b.txt"), tc = await w.remove("/c.txt");
  const s0 = await lastSeq(w);
  await w.emptyTrash([tc.path]);
  const one = await since(w, s0);
  check(one.length === 1 && one[0].op === "emptyTrash" && one[0].fid === c.fid && one[0].after === null, "one entry removed from Trash for good: one op, its identity, after null: " + J(one));
  const s1 = await lastSeq(w);
  await w.emptyTrash();
  const rest = await since(w, s1);
  const ids = rest.map((o) => o.fid).sort();
  check(rest.length === 2 && rest.every((o) => o.op === "emptyTrash" && o.after === null) && same(ids, [fa.fid, b.fid].sort()) && !ids.includes(a.fid), "Trash emptied: one op for each thing in it (a folder's contents go with it): " + J(rest.map((o) => [o.path, o.fid])));
  check(ta && tb, "(put in Trash first)");
  w.close();
}

async function others() {
  const w = await fresh();
  await w.create("/v.txt", { content: "1" });
  await w.write("/v.txt", "2");
  const s0 = await lastSeq(w);
  await w.dropVersions("/v.txt");
  const [dv] = await since(w, s0);
  check(dv?.op === "dropVersions" && !("after" in dv) && dv.fid === undefined, "dropVersions changes no entry: no identity, nothing left: " + J(dv));
  // (a data file whose hash wasn't kept, as one written before: its write based on the hash of its old bytes)
  const e = await w.stat("/v.txt");
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"), st = tx.objectStore("entries"); const { sha256: _s, ...rest } = e; st.put(rest); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const s1 = await lastSeq(w);
  await w.write("/v.txt", "3");
  const [wv] = await since(w, s1);
  check(wv?.base === (await H("2")) && wv.sha256 === (await H("3")), "a file whose hash wasn't kept: its write based on its old bytes' hash: " + J({ base: wv?.base }));
  // (a data file whose hash isn't kept and whose size says less than its bytes, as a record changed by other
  // means: the migrator's reservation trusts the size, but it hashes the bytes all the same, once, and sets
  // the size from them (daybreak2))
  const big = new Uint8Array(2 ** 20).map((_, i) => i & 255);
  await w.create("/big.bin", { content: big });
  const eb = await w.stat("/big.bin");
  await new Promise((ok, no) => { const tx = w.ws.transaction(["entries", "meta"], "readwrite"); const { sha256: _s, ...rest } = eb; tx.objectStore("entries").put({ ...rest, size: 1 }); tx.objectStore("meta").delete("migration"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await W.startMigrator(w);
  const fixed = await w.stat("/big.bin");
  check(fixed.sha256 === (await H(big)) && fixed.size === big.byteLength && (await W.migrationState(w)).done, "a file whose size says less than its bytes: hashed all the same, its size set from them, the migration done: " + J({ size: fixed.size }));
  // (old-way bytes adopted: read and hashed first (reserved before the lock), never a data file's op without
  // its hash (astra's CORR-9C2-2))
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); tx.objectStore("files").put(enc("leg"), "/leg.bin"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  // (adopted directly, its hash not given: read and hashed by adopt, under a reservation it takes without
  // waiting; when that can't be had now (the page's whole reservation held), refused, nothing made)
  const all256 = await W.reserve(W.RESERVE_BYTES);
  let refused = false;
  try { await w.locked(() => w.adopt("/", "leg", ".bin", { kind: "file", ref: "/leg.bin", size: 3, rev: 0 })); } catch (e) { refused = e instanceof W.WorkspaceError && e.code === "storage"; } finally { all256(); }
  check(refused && !(await w.stat("/leg.bin")) && W.reserved().held === 0, "a data file adopted while its bytes can't be read (the reservation held): refused, nothing made, nothing left reserved");
  const s2b = await lastSeq(w);
  const direct = await w.locked(() => w.adopt("/", "leg", ".bin", { kind: "file", ref: "/leg.bin", size: 3, rev: 0 }));
  const [dg] = await since(w, s2b);
  const oldLeft = await new Promise((ok, no) => { const r = w.main.transaction("files").objectStore("files").get("/leg.bin"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const kept = await new Promise((ok, no) => { const r = w.ws.transaction("fileBytes").objectStore("fileBytes").get(direct.fid); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  check(direct.sha256 === (await H("leg")) && dg?.sha256 === direct.sha256 && dg.after?.sha256 === direct.sha256 && W.reserved().held === 0, "…and once it can: adopt reads and hashes the bytes itself, its op carrying the hash: " + J(dg));
  check(direct.migrated === true && kept && (await H(kept)) === direct.sha256 && oldLeft === undefined, "…and moves them as it adopts them: the bytes hashed kept beside the index, the old copy gone (astra's CORR-12E-1): " + J({ migrated: direct.migrated, oldLeft: !!oldLeft }));
  // (an older tab writing at the old key between the adopt's move and the old copy's deletion: those bytes
  // kept as a file of their own, adopted (and moved) in turn with their own hash; the adopted file's the ones
  // it hashed)
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); tx.objectStore("files").put(enc("first"), "/raced.bin"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  w.beforeStaleDelete = () => new Promise((ok, no) => { w.beforeStaleDelete = null; const tx = w.main.transaction("files", "readwrite"); tx.objectStore("files").put(enc("older tab"), "/raced.bin"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const s2c = await lastSeq(w);
  const raced = await w.locked(() => w.adopt("/", "raced", ".bin", { kind: "file", ref: "/raced.bin", rev: 0 }));
  const copy = await w.stat("/raced (from an older tab).bin"), rops = (await since(w, s2c)).filter((o) => o.op === "adopt");
  check(dec((await w.read(raced.path)).content) === "first" && raced.sha256 === (await H("first")) && copy && dec((await w.read(copy.path)).content) === "older tab" && copy.sha256 === (await H("older tab")) && rops.length === 2 && rops.every((o) => o.sha256 && o.after?.sha256 === o.sha256), "an older tab's write landing during the adopt: kept as a file of its own with its own hash, the adopted file the bytes it hashed: " + J(rops.map((o) => [o.path, o.sha256?.slice(0, 8)])));
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); tx.objectStore("files").put(enc("leg2"), "/leg2.bin"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const s3 = await lastSeq(w);
  const lr = { notebooks: 0, files: 0, recovered: 0, missing: 0 };
  await W.adoptOld(w, await w.locked(() => W.reconcile(w, false, lr)), lr);
  const lg = (await since(w, s3)).find((o) => o.op === "adopt" && o.path === "/leg2.bin");
  check(lg && lg.sha256 === (await H("leg2")) && lg.after?.sha256 === lg.sha256 && lg.size === 4 && lr.files === 1 && (await w.stat("/leg2.bin"))?.migrated === true, "old-way bytes with no entry, adopted by reconcile: read and hashed first, so the adopt's op carries the hash and what it left: " + J(lg));
  // (a moved data file whose hash isn't kept: hashed first, its bytes read inside the page's reservation,
  // taken before the lock (daybreak2's rule, as a migration's))
  await w.create("/r.bin", { content: big });
  const er = await w.stat("/r.bin");
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"); const { sha256: _s, ...rest } = er; tx.objectStore("entries").put(rest); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const digest = crypto.subtle.digest, seen = [];
  crypto.subtle.digest = function (a, d) { seen.push(W.reserved().held); return digest.call(crypto.subtle, a, d); };
  try { await w.rename("/r.bin", "/r2.bin"); } finally { crypto.subtle.digest = digest; }
  const s4 = (await ops(w)).at(-1);
  check(s4?.op === "rename" && s4.sha256 === (await H(big)) && s4.after?.sha256 === s4.sha256 && seen.length >= 1 && seen.every((r) => r >= big.byteLength * W.COPIES), "a moved file whose hash wasn't kept: hashed first, inside a reservation of its size × COPIES, and its op carries the hash: " + J({ seen }));
  // (a folder from before folders had ids: what is made in it has no `after`, its folder not yet nameable,
  // never one saying it is in the root)
  await new Promise((ok, no) => { const tx = w.ws.transaction("entries", "readwrite"); tx.objectStore("entries").put({ path: "/old", kind: "folder", ref: null, created: 1, updated: 1, nkey: "/\u0000old" }); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const s2 = await lastSeq(w);
  const inOld = await w.create("/old/x.txt", { content: "x" });
  const [co] = await since(w, s2);
  check(co?.op === "create" && co.fid === inOld.fid && !("after" in co) && co.parent === undefined, "made in a folder without an id yet: its identity, but no `after` and no parent (never taken for the root): " + J(co));
  w.close();
}

// bytes read whole only inside the page's reservation (daybreak2's LIMIT-6B7-1), and old copies' marks cleaned
// up, a bounded number of rounds at a time (astra's CORR-6B7-1 and limits note)
async function reservations() {
  const w = await fresh();
  const tput = (k, b) => new Promise((ok, no) => { const tx = w.ws.transaction("trash", "readwrite"); tx.objectStore("trash").put(b, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const fput = (k, b) => new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); tx.objectStore("files").put(b, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  // (bytes in Trash with no entry, recovered: hashed with LEGACY_MAX × COPIES held, before the lock)
  await tput("/Trash/lost.bin", enc("lost bytes"));
  const digest = crypto.subtle.digest, seen = [];
  crypto.subtle.digest = function (a, d) { seen.push(W.reserved().held); return digest.call(crypto.subtle, a, d); };
  try { await W.migrate(w, localStorage); } finally { crypto.subtle.digest = digest; }
  const rec = (await w.list("/Recovered")).find((e) => e.path.endsWith("lost.bin"));
  check(rec && rec.migrated && rec.sha256 === (await H("lost bytes")) && seen.length >= 1 && seen.every((h) => h >= W.LEGACY_MAX * W.COPIES), "Trash's bytes with no entry: recovered after reconcile's lock, read and hashed inside a reservation of LEGACY_MAX × COPIES, moved with their hash: " + J({ seen: seen.map((h) => h / 2 ** 20) }));
  // (while the page's reservation is held, the recovery waits for it, nothing made; then it goes ahead)
  await tput("/Trash/later.bin", enc("later"));
  const hold = await W.reserve(W.RESERVE_BYTES);
  let finished = false;
  const run = W.migrate(w, localStorage).then(() => { finished = true; });
  await sleep(300);
  const during = { finished, listed: (await w.list("/Recovered")).some((e) => e.path.endsWith("later.bin")) };
  hold();
  await run;
  check(!during.finished && !during.listed && (await w.list("/Recovered")).some((e) => e.path.endsWith("later.bin")), "…with the reservation busy: it waits, nothing made meanwhile, then recovers them: " + J(during));
  // (adopt given bytes without the reservation they were read in: refused loudly, nothing made, even while an
  // unrelated holder has the page's whole reservation (whose it is, not the page's total: daybreak2))
  const unrelated = await W.reserve(W.LEGACY_MAX * W.COPIES);
  let loud = false;
  try { await w.locked(() => w.adopt("/", "x", ".bin", { kind: "file", ref: "/x.bin", rev: 0 }, { bytes: { bytes: enc("x") } })); } catch (e) { loud = !(e instanceof W.WorkspaceError) && /reservation/.test(String(e)); } finally { unrelated(); }
  let dead = false;
  const gone = await W.reserve(W.LEGACY_MAX * W.COPIES);
  gone();
  try { await w.locked(() => w.adopt("/", "x", ".bin", { kind: "file", ref: "/x.bin", rev: 0 }, { bytes: { bytes: enc("x") }, token: gone })); } catch (e) { dead = !(e instanceof W.WorkspaceError) && /reservation/.test(String(e)); }
  let deadDrop = false;
  try { await w.locked(() => w.dropStale("files", "/nothing.bin", undefined, gone)); } catch (e) { deadDrop = !(e instanceof W.WorkspaceError) && /reservation/.test(String(e)); }
  check(deadDrop, "an old copy looked at in the name of a released reservation: an error, nothing read");
  check(loud && dead && !(await w.stat("/x.bin")) && W.reserved().held === 0, "adopt given bytes without their reservation (an unrelated one held), or with one released: an error, nothing made");
  // (a pending Trash recovery's destination checked with the Trash bytes let go: at most two copies at once,
  // the reservation's (daybreak2's LIMIT-AC1-1): the order of its reads and hashes, and, never failed on, whether
  // the first copy is collected by then)
  if (typeof globalThis.gc === "function") {
    const tb = enc("recover me, once"), tsha = await H(tb);
    await new Promise((ok, no) => { const tx = w.ws.transaction(["trash", "meta"], "readwrite"); tx.objectStore("trash").put(tb, "/Trash/gc.bin"); tx.objectStore("meta").put({ dest: "/Recovered/gc.bin", sha: tsha }, "recovering:/Trash/gc.bin"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    await fput("/Recovered/gc.bin", tb);
    // (the gate is the order, seen from outside recoverTrash: every IndexedDB get and every SHA-256, with when
    // each hash resolved.  The Trash copy is read and hashed before the destination's bytes are read; the
    // destination's are hashed before the Trash copy is read again: two copies at most, as the reservation
    // allows.  Whether the first copy is collected by then is the collector's business, not this code's order: it
    // is printed as an OBS line, never failed on)
    const log = [], getOf = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (k) { log.push(["get", this.name, k]); return getOf.call(this, k); };
    let calls = 0, ref = null, aliveAtDest = null;
    crypto.subtle.digest = function (a, d) {
      const k = ++calls;
      log.push(["hash", k]);
      if (k === 1) ref = new WeakRef(d);
      const p = k === 2 ? (async () => { globalThis.gc(); await sleep(0); globalThis.gc(); aliveAtDest = ref?.deref() !== undefined; return digest.call(crypto.subtle, a, d); })() : digest.call(crypto.subtle, a, d);
      p.then(() => log.push(["hashed", k]), () => {});
      return p;
    };
    try { await W.migrate(w, localStorage); } finally { crypto.subtle.digest = digest; IDBObjectStore.prototype.get = getOf; }
    const at = (f, from = 0) => { const x = log.findIndex((e, i) => i >= from && f(e)); return x < 0 ? Infinity : x; };
    const isTrash = (e) => e[0] === "get" && e[1] === "trash" && e[2] === "/Trash/gc.bin";
    const t1 = at(isTrash), dg = at((e) => e[0] === "get" && e[1] === "files" && e[2] === "/Recovered/gc.bin", t1 + 1), t2 = at(isTrash, t1 + 1);
    const hashes = (from, to) => log.slice(from, to).filter((e) => e[0] === "hash").map((e) => e[1]);
    const done = (k, before) => log.slice(0, before).some((e) => e[0] === "hashed" && e[1] === k);
    const [h1] = hashes(t1, dg), [h2] = hashes(dg, t2);
    const ordered = t1 < dg && dg < t2 && t2 < Infinity && hashes(t1, dg).length === 1 && done(h1, dg) && hashes(dg, t2).length === 1 && done(h2, t2);
    const gcRec = await w.stat("/Recovered/gc.bin");
    check(ordered && gcRec?.sha256 === tsha && dec((await w.read(gcRec.path)).content) === "recover me, once", "Trash recovery: its copy read and hashed before the destination's bytes are read, the destination's hashed before the copy is read again (two copies at most), then recovered: " + J({ t1, dg, t2, calls, log: log.length }));
    results.push([true, "OBS Trash recovery, the first copy collected by the destination's hash (gc, a macrotask, gc; never failed on): " + J({ aliveAtDest })]);
  } else check(false, "(the test browser runs without --expose-gc)");
  // (an older tab writing at the old key ten times while it is cleaned up: each version kept, a bounded number of
  // rounds per cleanup, the rest by the next start)
  await fput("/many.bin", enc("w0"));
  let i = 0;
  w.beforeStaleDelete = async () => { if (i < 10) await fput("/many.bin", enc("w" + ++i)); else w.beforeStaleDelete = null; };
  await w.locked(() => w.adopt("/", "many", ".bin", { kind: "file", ref: "/many.bin", rev: 0 }));
  const afterAdopt = (await w.staleCopies(10)).length;
  await W.startMigrator(w);
  const kept = [];
  for (const e of (await w.list("/")).filter((x) => x.path.startsWith("/many"))) kept.push(dec((await w.read(e.path)).content));
  check(afterAdopt === 1 && kept.sort().join() === "w0,w1,w10,w2,w3,w4,w5,w6,w7,w8,w9" && (await w.staleCopies(10)).length === 0, "an old copy written ten times while it is cleaned up: at most a bounded number of rounds per call (its mark left for the next), every version kept as a file of its own: " + J({ afterAdopt, kept: kept.length }));
  w.close();
}

// old copies that can't go, more than a batch of them: the migrator still ends, its work bounded, and the index's
// migration goes on (daybreak2's LIMIT-1F3-1: old copies are the start's cleanup alone, never a batch's work)
async function stuckMarks() {
  const w = await fresh();
  const raw = (db, store, f) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); f(tx.objectStore(store)); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const one = enc("x"), sha = await H(one);
  for (let i = 0; i < W.MIGRATE.files + 8; i++) {
    const k = "/stuck" + String(i).padStart(3, "0") + ".bin";
    await raw(w.main, "files", (st) => st.put(one, k));
    await raw(w.ws, "meta", (st) => st.put({ fid: "f" + String(i).padStart(15, "0"), size: 1, sha256: sha }, "stale:files:" + k));
  }
  // (a file still kept the old way, for the migration to move)
  await raw(w.main, "files", (st) => st.put(enc("old"), "/legacy.txt"));
  await raw(w.ws, "entries", (st) => st.put({ path: "/legacy.txt", kind: "file", ref: "/legacy.txt", size: 3, rev: 0, created: 1, updated: 1, nkey: "/\u0000legacy.txt" }));
  await raw(w.ws, "meta", (st) => st.delete("migration"));
  let tries = 0;
  w.beforeStaleDelete = () => { tries++; throw new Error("this old copy can't go"); };
  const ended = await Promise.race([W.startMigrator(w).then(() => "ended"), sleep(30000).then(() => "still running")]);
  w.beforeStaleDelete = null;
  const legacy = await w.stat("/legacy.txt"), marks = (await w.staleCopies(100)).length;
  check(ended === "ended" && legacy?.migrated === true && legacy.sha256 === (await H("old")) && marks === W.MIGRATE.files + 9 && tries <= W.MIGRATE.files + 9 && (await W.migrationState(w)).done, "more old copies that can't go than a batch: the migrator ends, each tried once (and the moved file's own old copy, which can't go either, once), the file kept the old way moved, the marks left for the next start: " + J({ ended, tries, marks, migrated: legacy?.migrated }));
  w.close();
}

// ---- old copies that cleanups keep leaving: counted, said, closed

const rawPut = (db, store, v, k) => new Promise((ok, no) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(v, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
const markOf = async (w, key) => new Promise((ok) => { const r = w.ws.transaction("meta").objectStore("meta").get("stale:files:" + key); r.onsuccess = () => ok(r.result); });
const pick = (o) => o && { fails: o.fails, why: o.why, folder: o.folder };

async function staleFolderFull() {
  // (old copies written since their file was moved, in a full folder: each start's cleanup leaves them, counted once
  // a start, with why and the folder; from the third start, said (staleStuck, the notice, naming the folder); room
  // made: they go, their counts with them, and so does the notice)
  localStorage.clear();
  const r = Math.random().toString(36).slice(2, 8), nm = { name: "ws-stale-" + r, mainName: "main-stale-" + r };
  let w = await W.Workspace.open({ ...nm, limits: { ...W.LIMITS, maxFolderEntries: 6 } });
  await W.startMigrator(w);
  w.beforeStaleDelete = () => { throw new Error("leave the mark"); };
  for (let i = 1; i <= 6; i++) {
    const key = `/f0${i}.bin`;
    await rawPut(w.main, "files", enc("original"), key);
    await w.locked(() => w.adopt("/", `f0${i}`, ".bin", { kind: "file", ref: key, rev: 0 }));
  }
  w.beforeStaleDelete = null;
  for (let i = 1; i <= 5; i++) await rawPut(w.main, "files", enc("changed"), `/f0${i}.bin`);
  const seen = [];
  for (let start = 1; start <= 3; start++) {
    await W.startMigrator(w);
    seen.push({ start, mark: pick(await markOf(w, "/f01.bin")), stuck: await w.staleStuck(), gone6: (await markOf(w, "/f06.bin")) === undefined });
  }
  const box = await W.showStaleNotice(w);
  const text = box?.textContent ?? "";
  const s3 = seen[2].stuck;
  check(J(seen.map((x) => x.mark)) === J([1, 2, 3].map((n) => ({ fails: n, why: "folder-full", folder: "/" }))) && seen[0].stuck === undefined && seen[1].stuck === undefined && s3?.count === 5 && J(s3.reasons) === J({ "folder-full": 5 }) && s3.paths.length === 5 && s3.paths.every((p) => p.why === "folder-full" && p.folder === "/") && seen.every((x) => x.gone6), "old copies in a full folder: counted once a start, with why and the folder; said from the third start (5 of them); the copy that could go, gone: " + J(seen));
  check(/your top folder is full/.test(text) && /nothing has been deleted/i.test(text) && /5 files/.test(text), "…the notice says so, naming the folder, and that nothing has been deleted: " + J(text));
  // (room made: they go, and their counts, and the notice)
  w.close();
  w = await W.Workspace.open({ ...nm, limits: { ...W.LIMITS, maxFolderEntries: 100 } });
  await W.startMigrator(w);
  const left = (await w.staleCopies(100)).length, again = await W.showStaleNotice(w);
  check(left === 0 && (await w.staleStuck()) === undefined && again === null && !document.getElementById("sagebrush-stale-notice") && (await w.list("/")).filter((e) => / \(from an older tab\)/.test(e.path)).length === 5, "room made: the copies kept as files of their own, their marks and counts gone, the notice gone: " + J({ left }));
  w.close();
}

async function staleCounts() {
  // (a mark of the old shape counts from 0; a count saturates at its cap; a count that can't be written doesn't stop
  // the lap; a lap cut short (fewer pages than marks) keeps what the last full lap found)
  localStorage.clear();
  const r = Math.random().toString(36).slice(2, 8), nm = { name: "ws-stalec-" + r, mainName: "main-stalec-" + r };
  const w = await W.Workspace.open(nm);
  await W.startMigrator(w);
  const one = enc("x"), sha = await H(one);
  const mark = async (key, extra = {}) => { await rawPut(w.main, "files", one, key); await rawPut(w.ws, "meta", { fid: "f" + key.replace(/\W/g, "").padStart(15, "0").slice(-15), size: 1, sha256: sha, ...extra }, "stale:files:" + key); };
  await mark("/old-shape.bin");
  await mark("/capped.bin", { fails: W.STALE_FAILS_CAP, why: "storage" });
  w.beforeStaleDelete = () => { throw new Error("storage refused"); };
  await W.startMigrator(w);
  const a = pick(await markOf(w, "/old-shape.bin")), b = pick(await markOf(w, "/capped.bin"));
  check(J(a) === J({ fails: 1, why: "storage" }) && J(b) === J({ fails: W.STALE_FAILS_CAP, why: "storage" }), "a mark of the old shape counts from 0; one at the cap stays there: " + J({ a, b }));
  // (the count's write refused: said, passed over, the lap goes on: a mark after it that can go, gone)
  await rawPut(w.ws, "meta", { fid: "f00000000000gone", size: 1, sha256: sha }, "stale:files:/zz-gone.bin");
  const realNote = w.noteStaleFailure;
  w.noteStaleFailure = async () => { throw new Error("the count refused"); };
  const ended = await Promise.race([W.startMigrator(w).then(() => "ended"), sleep(30000).then(() => "stuck")]);
  w.noteStaleFailure = realNote;
  const a2 = pick(await markOf(w, "/old-shape.bin")), gone = (await markOf(w, "/zz-gone.bin")) === undefined;
  check(ended === "ended" && gone && a2.fails === 1, "the count's write refused: the lap goes on (a later mark that could go, gone) and ends: " + J({ ended, gone, a2 }));
  // (a lap cut short keeps the last full lap's figure)
  await w.setStaleStuck({ count: 7, paths: [], reasons: { storage: 7 } });
  for (let i = 0; i < 6; i++) await mark(`/p${i}.bin`);
  const was = { files: W.MIGRATE.files, pages: W.MIGRATE.stalePages };
  W.MIGRATE.files = 2;
  W.MIGRATE.stalePages = 1;
  try { await W.startMigrator(w); } finally { W.MIGRATE.files = was.files; W.MIGRATE.stalePages = was.pages; }
  const kept = await w.staleStuck();
  check(kept?.count === 7 && J(kept.reasons) === J({ storage: 7 }), "a lap cut short (one page of two marks): the last full lap's figure kept, never lowered: " + J(kept));
  // (a full lap again: the figure from what it found, paths cut to STUCK_CHARS)
  const long = "/" + "n".repeat(400) + ".bin";
  await mark(long, { fails: 5, why: "storage" });
  // (a lap spans starts (daybreak2): one already under way when the mark was made may have passed its place, so
  // the next whole lap is the one sure to count it)
  await W.startMigrator(w);
  await W.startMigrator(w);
  const full = await w.staleStuck();
  check(full && full.count >= 2 && full.paths.every((p) => p.path.length <= W.STUCK_CHARS) && full.paths.length <= W.STUCK_PATHS && J(Object.keys(full.reasons)) === J(["storage"]), "a full lap: the count, at most STUCK_PATHS paths each cut to STUCK_CHARS, a count per reason: " + J({ count: full?.count, longest: Math.max(...(full?.paths ?? []).map((p) => p.path.length)) }));
  w.beforeStaleDelete = null;
  w.close();
}

async function staleRounds() {
  // (an old copy that keeps changing while the cleanup compares it (a tab from before an update still writing to
  // it): no error, its rounds run out, the mark left; counted as "rounds")
  localStorage.clear();
  const r = Math.random().toString(36).slice(2, 8), w = await W.Workspace.open({ name: "ws-staler-" + r, mainName: "main-staler-" + r });
  await W.startMigrator(w);
  const one = enc("x");
  await rawPut(w.main, "files", one, "/rounds.bin");
  await rawPut(w.ws, "meta", { fid: "f00000000rounds1", size: 1, sha256: await H(one) }, "stale:files:/rounds.bin");
  let n = 0;
  w.beforeStaleDelete = async () => { await rawPut(w.main, "files", enc("changed " + ++n), "/rounds.bin"); };
  await W.startMigrator(w);
  w.beforeStaleDelete = null;
  const m = pick(await markOf(w, "/rounds.bin"));
  check(m?.fails === 1 && m.why === "rounds" && n >= 2, "an old copy that keeps changing while it is compared: no error, the mark left, counted as \"rounds\": " + J({ m, n }));
  w.close();
}

async function staleLapSpans() {
  // (daybreak2: more failing marks (1,100) than a start looks at (MIGRATE.stalePages × MIGRATE.files, 1,024): the lap
  // spans starts, kept in meta; said once it is whole; a partial lap never lowers what is shown; a lap with every
  // mark gone clears it)
  localStorage.clear();
  const r = Math.random().toString(36).slice(2, 8), w = await W.Workspace.open({ name: "ws-stalel-" + r, mainName: "main-stalel-" + r });
  await W.startMigrator(w);
  const one = enc("x"), sha = await H(one), n = 1100;
  const keys = Array.from({ length: n }, (_, i) => "/l" + String(i).padStart(5, "0") + ".bin");
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); for (const k of keys) tx.objectStore("files").put(one, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); keys.forEach((k, i) => tx.objectStore("meta").put({ fid: "f" + String(i).padStart(15, "0"), size: 1, sha256: sha, fails: 5, why: "storage" }, "stale:files:" + k)); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  w.beforeStaleDelete = () => { throw new Error("storage refused"); };
  const seen = [];
  await W.startMigrator(w);
  seen.push((await w.staleStuck())?.count ?? 0);
  await W.startMigrator(w);
  seen.push((await w.staleStuck())?.count ?? 0);
  // (400 of them gone (their old copies removed): what is shown stays until a lap is whole again)
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); for (const k of keys.slice(0, 400)) tx.objectStore("files").delete(k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const after = [];
  for (let k = 0; k < 4; k++) { await W.startMigrator(w); after.push((await w.staleStuck())?.count ?? 0); }
  // (every one gone: a whole lap clears it)
  await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); for (const k of keys) tx.objectStore("files").delete(k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  const clear = [];
  for (let k = 0; k < 2; k++) { await W.startMigrator(w); clear.push((await w.staleStuck())?.count ?? 0); }
  w.beforeStaleDelete = null;
  const firstWhole = after.findIndex((c) => c === n - 400);
  check(seen[0] === 0 && seen[1] === n && after.every((c) => c === n || c === n - 400 || (c >= n - 400 && c <= n)) && after.at(-1) === n - 400 && after.slice(0, firstWhole).every((c) => c === n) && clear.at(-1) === 0, `more failing marks than a start looks at (${n}): the lap spans starts, said once whole; a partial lap never lowers it; every mark gone, cleared: ` + J({ seen, after, clear }));
  w.close();
}

async function staleLapReload() {
  // (daybreak2, astra: the tab gone (its database closed under it, no write after) at a mark, then a reload: the
  // lap goes on from the last mark the cursor is past, so the next whole lap counts every mark, none passed over
  // uncounted and none counted twice.  Cut: in the middle of a page; right after the wrap to the first mark; right
  // after a whole lap was said and the next begun)
  const n = 100, files = "files:";
  const keys = Array.from({ length: n }, (_, i) => "/r" + String(i).padStart(5, "0") + ".bin");
  const cut = async ({ cursor, pages, at = Infinity, starts, after = 2, failPut = 0 }) => {
    localStorage.clear();
    const r = Math.random().toString(36).slice(2, 8), nm = { name: "ws-stalerl-" + r, mainName: "main-stalerl-" + r };
    let w = await W.Workspace.open(nm);
    await W.startMigrator(w);
    const one = enc("x"), sha = await H(one);
    await new Promise((ok, no) => { const tx = w.main.transaction("files", "readwrite"); for (const k of keys) tx.objectStore("files").put(one, k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); keys.forEach((k, i) => tx.objectStore("meta").put({ fid: "f" + String(i).padStart(15, "0"), size: 1, sha256: sha, fails: 5, why: "storage" }, "stale:files:" + k)); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
    if (cursor !== undefined) await rawPut(w.ws, "meta", files + keys[cursor], "staleCursor");
    let tries = 0;
    w.beforeStaleDelete = () => { if (++tries === at) w.ws.close(); throw new Error("storage refused"); };
    const was = { files: W.MIGRATE.files, pages: W.MIGRATE.stalePages };
    W.MIGRATE.files = 32;
    W.MIGRATE.stalePages = pages;
    const seen = [];
    // (the failPut-th write of the cursor refused, once, the database still writable)
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    if (failPut) IDBObjectStore.prototype.put = function (v, k) { if (k === "staleCursor" && ++puts === failPut) throw new Error("refused once"); return realPut.call(this, v, k); };
    try {
      try { for (let k = 0; k < starts && tries < at; k++) await W.startMigrator(w).catch(() => {}); } finally { IDBObjectStore.prototype.put = realPut; }
      try { w.close(); } catch {}
      w = await W.Workspace.open(nm);
      w.beforeStaleDelete = () => { throw new Error("storage refused"); };
      for (let k = 0; k < after; k++) { await W.startMigrator(w); seen.push((await w.staleStuck())?.count ?? 0); }
    } finally { W.MIGRATE.files = was.files; W.MIGRATE.stalePages = was.pages; }
    w.beforeStaleDelete = null;
    w.close();
    return { tries, puts, seen };
  };
  // (in the middle of a page: the 43rd mark, the 11th of the second page; the lap last whole at the first page's end)
  const mid = await cut({ pages: 32, at: 32 + 11, starts: 1 });
  check(mid.tries === 43 && J(mid.seen) === J([n, n]), `cut in the middle of a page: the next whole lap counts all ${n} marks: ` + J(mid));
  // (right after the wrap: a lap begun at the 51st mark, gone round the end (the cursor back to the first mark), cut
  // at the first mark after it)
  const wrap = await cut({ cursor: 49, pages: 32, at: 51, starts: 1 });
  check(wrap.tries === 51 && J(wrap.seen) === J([n, n]), `cut right after the wrap to the first mark: the lap whole at its origin with all ${n}, none twice: ` + J(wrap));
  // (right after a whole lap is said: two pages a start (64 marks), so the lap is whole in the third start at the
  // first mark, said, and the next lap begun there; cut at that mark's attempt; then the next lap whole again)
  const said = await cut({ pages: 2, at: n + 1, starts: 3, after: 3 });
  check(said.tries === n + 1 && said.seen.length === 3 && said.seen.every((c) => c === n), `cut right after a whole lap is said and the next begun: said again whole, ${n}, never fewer: ` + J(said));
  // (the cursor's write refused once after the 43rd mark, the database still writable (daybreak2): that mark tried
  // again by the next start, and counted once)
  const refused = await cut({ pages: 32, starts: 1, failPut: 43 });
  check(refused.puts >= 43 && refused.tries >= 43 && J(refused.seen) === J([n, n]), `the cursor's write refused once, the database writable: the mark tried again, counted once, all ${n}: ` + J(refused));
}

async function staleNotice() {
  // (the notice closed: it stays closed while the count and reasons stay; it comes back if the count rises or a
  // reason is new; none left, it goes, and what it was closed at with it.  And each reason's words: true of it,
  // the folder named only when full)
  localStorage.clear();
  let s;
  const w = { staleStuck: async () => s };
  const shown = () => !!document.getElementById("sagebrush-stale-notice");
  const close = () => document.querySelector('[data-sbb="stale-close"]')?.click();
  const steps = [];
  s = { count: 2, paths: [{ path: "/a.bin", why: "storage" }], reasons: { storage: 2 } };
  await W.showStaleNotice(w); steps.push(shown());
  close(); steps.push(shown());
  await W.showStaleNotice(w); steps.push(shown());
  s = { ...s, count: 3, reasons: { storage: 3 } };
  await W.showStaleNotice(w); steps.push(shown());
  close();
  s = { ...s, count: 3, reasons: { storage: 2, rounds: 1 } };
  await W.showStaleNotice(w); steps.push(shown());
  close();
  s = { ...s, count: 2, reasons: { storage: 2 } };
  await W.showStaleNotice(w); steps.push(shown());
  s = { count: 0, paths: [], reasons: {} };
  await W.showStaleNotice(w); steps.push(shown(), localStorage.getItem(W.STALE_DISMISSED));
  s = { count: 1, paths: [{ path: "/b.bin", why: "storage" }], reasons: { storage: 1 } };
  await W.showStaleNotice(w); steps.push(shown());
  close();
  check(J(steps) === J([true, false, false, true, true, false, false, null, true]), "the notice: closed, it stays closed; back when the count rises or a reason is new; gone when none are left, and what it was closed at forgotten: " + J(steps));
  const text = (why, extra = {}) => W.staleText({ count: 1, paths: [{ path: "/d/x.bin", why, folder: "/d", ...extra }], reasons: { [why]: 1 } });
  const t = { full: text("folder-full"), limit: text("limit"), storage: text("storage"), rounds: text("rounds") };
  check(Object.values(t).every((x) => /nothing has been deleted/i.test(x) && !/lost/i.test(x)) && /\/d is full/.test(t.full) && ["limit", "storage", "rounds"].every((k) => !t[k].includes("/d")) && /1 file\b/.test(t.storage), "each reason's words: nothing deleted (never \"lost\"); the folder named only when it is full: " + J(t));
}

// ---- the version 4 upgrade

// (a database's every store, its keys and values, bytes as their SHA-256: for comparing whole states)
async function dump(db) {
  const out = {};
  for (const name of [...db.objectStoreNames].sort()) {
    const tx = db.transaction(name), st = tx.objectStore(name);
    const keys = await new Promise((ok, no) => { const r = st.getAllKeys(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const vals = await new Promise((ok, no) => { const r = st.getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const norm = async (v) => {
      if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return { bytes: await H(v instanceof ArrayBuffer ? v : new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), n: v.byteLength };
      if (Array.isArray(v)) return Promise.all(v.map(norm));
      if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = await norm(v[k]); return o; }
      return v;
    };
    out[name] = await Promise.all(keys.map(async (k, i) => [k, await norm(vals[i])]));
  }
  return out;
}
const indexes = (db) => { const out = {}; for (const name of db.objectStoreNames) { const st = db.transaction(name).objectStore(name); out[name] = [...st.indexNames].sort(); } return out; };
const rawOpen = (name, version, upgrade) => new Promise((ok, no) => { const r = indexedDB.open(name, version); if (upgrade) r.onupgradeneeded = (ev) => upgrade(r.result, r.transaction, ev); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); r.onblocked = () => no(new Error("blocked")); });
const BIG = 3 * 2 ** 20;
const bigBytes = (k) => { const b = new Uint8Array(BIG); for (let j = 0; j < b.length; j++) b[j] = (k * 31 + j * 7) & 255; return b; };

// a workspace as version 3 left it: its migration done, data files written since 1a (no sha256, no ident; one
// in Trash),
// a folder with its id (no ident), a notebook, a board, a version, a grant, Trash bytes, ops, meta
async function makeV3(name) {
  const db = await rawOpen(name, 3, (db) => {
    const e = db.createObjectStore("entries", { keyPath: "path" });
    e.createIndex("byRef", ["kind", "ref"]);
    e.createIndex("byNfc", "nkey");
    db.createObjectStore("boards", { keyPath: "id" });
    db.createObjectStore("trash");
    db.createObjectStore("ops", { keyPath: "seq", autoIncrement: true });
    const v = db.createObjectStore("versions", { keyPath: "id", autoIncrement: true });
    v.createIndex("byFile", ["fid", "t"]);
    v.createIndex("byTime", "t");
    db.createObjectStore("versionBytes");
    db.createObjectStore("meta");
    db.createObjectStore("fileBytes");
    const g = db.createObjectStore("grants", { keyPath: ["doc", "scope"] });
    g.createIndex("byDoc", "doc");
    g.createIndex("lastUsed", "lastUsed");
  });
  await new Promise((ok, no) => {
    const tx = db.transaction(["entries", "boards", "trash", "ops", "versions", "versionBytes", "meta", "fileBytes", "grants"], "readwrite");
    const st = tx.objectStore("entries");
    st.put({ path: "/d", kind: "folder", ref: null, created: 1, updated: 1, fid: "d000000000000001", nkey: "/\u0000d" });
    for (let i = 0; i < 3; i++) {
      const fid = "f00000000000000" + i;
      st.put({ path: `/d/f${i}.bin`, kind: "file", ref: `/d/f${i}.bin`, size: BIG, rev: 2, fid, migrated: true, created: 1, updated: 2, nkey: `/d\u0000f${i}.bin` });
      tx.objectStore("fileBytes").put(bigBytes(i), fid);
    }
    st.put({ path: "/n.ipynb", kind: "notebook", ref: "0123456789ab", created: 1, updated: 1, nkey: "/\u0000n.ipynb" });
    st.put({ path: "/b.board.json", kind: "board", ref: "ba0000000001", created: 1, updated: 1, nkey: "/\u0000b.board.json" });
    st.put({ path: "/Trash/t.bin", kind: "file", ref: "/Trash/t.bin", size: 4, rev: 0, fid: "t000000000000001", migrated: true, created: 1, updated: 1, trashed: { from: "/t.bin", at: 1, id: "x1" }, nkey: "/Trash\u0000t.bin" });
    tx.objectStore("fileBytes").put(enc("trsh"), "t000000000000001");
    tx.objectStore("boards").put({ id: "ba0000000001", doc: { title: "b", nodes: [] }, rev: 3, updated: 1 });
    tx.objectStore("ops").add({ t: 1, device: "0123456789abcdef", by: "person", op: "create", path: "/d/f0.bin", kind: "file" });
    tx.objectStore("ops").add({ t: 2, device: "0123456789abcdef", by: "person", op: "write", path: "/d/f0.bin", kind: "file" });
    tx.objectStore("versions").add({ fid: "f000000000000000", t: 1, size: 5, sha256: "a".repeat(64), by: "person", device: "0123456789abcdef" });
    tx.objectStore("versionBytes").put(enc("older"), 1);
    tx.objectStore("meta").put("0123456789abcdef", "device");
    tx.objectStore("meta").put({ done: true }, "migration");
    tx.objectStore("meta").put(5, "versionBytes");
    tx.objectStore("grants").put({ doc: "0123456789ab", scope: "d000000000000001", lastUsed: 1 });
    tx.oncomplete = ok;
    tx.onerror = () => no(tx.error);
  });
  return db;
}

async function upgrade() {
  const name = `ws-ops-v3-${Math.random().toString(36).slice(2, 8)}`;
  const v3 = await makeV3(name);
  const before = await dump(v3);
  v3.close();
  // an upgrade cut short (the tab killed in it, or anything thrown in it): IndexedDB aborts the versionchange
  // transaction whole, and the database is version 3 as it was
  const cut = await new Promise((ok) => {
    const r = indexedDB.open(name, 4);
    r.onupgradeneeded = () => { r.result.createObjectStore("outbox"); r.transaction.abort(); };
    r.onsuccess = () => { r.result.close(); ok("opened"); };
    r.onerror = () => ok("aborted");
  });
  const after3 = await rawOpen(name, undefined);
  const cutState = { version: after3.version, same: same(await dump(after3), before) };
  after3.close();
  check(cut === "aborted" && cutState.version === 3 && cutState.same, "an upgrade cut short: version 3, every store as it was: " + J({ cut, ...cutState }));
  // the upgrade itself: only stores and indexes added, and the migration's state dropped
  const db = await W.openWorkspaceDb(name);
  const up = await dump(db), ix = indexes(db);
  const { meta: m0, ...rest0 } = before, { meta: m1, outbox, syncIndex, adoptJournal, pins, pending, prunable, syncLedger, ...rest1 } = up;
  check(db.version === W.WS_VERSION && same(rest0, rest1) && same(prunable, []) && same(syncLedger, []) && same(ix.syncLedger, ["byDecided"]), "the current version (4 added these stores, 5 the pins' index and the empty store prunable, 6 syncIndex's indexes and entries' byFetch, 7 the empty store syncLedger with its index byDecided): entries, boards, trash, ops, versions, versionBytes, fileBytes and grants the same, byte for byte");
  check(same(m1.filter(([k]) => k !== "versions:backfill" && k !== "journal"), m0.filter(([k]) => k !== "migration")) && same(m1.find(([k]) => k === "versions:backfill")?.[1], { after: 0 }) && ((j) => j?.v === 1 && j.active === false && Object.keys(j).length === 2)(m1.find(([k]) => k === "journal")?.[1]), "…meta the same but for the migration's state, dropped (so the migrator gives older entries their identity), the versions' backfill marker, set, and the journal's record (version 8), not active: " + J(m1.map(([k]) => k)));
  check([outbox, syncIndex, adoptJournal, pins, pending].every((s) => Array.isArray(s) && s.length === 0) && same(ix.entries, ["byFetch", "byIdent", "byNfc", "byRef"]) && same(ix.outbox, ["byIdent"]) && same(ix.adoptJournal, ["byParent"]) && same(ix.syncIndex ?? ["byKey", "byParent"], ["byKey", "byParent"]), "…the new stores there and empty, and the new indexes: " + J(ix));
  db.close();
  // then the workspace, its migrator: identities and hashes given, nothing else of the entries changed, no op
  const w = await W.Workspace.open({ name, mainName: name + "-main" });
  const opsBefore = J((await dump(w.ws)).ops);
  await W.startMigrator(w);
  const es = await w.list("/", { recursive: true }), trashed = await w.list("/Trash", { recursive: true });
  const byPath = Object.fromEntries([...es, ...trashed].map((e) => [e.path, e]));
  let hashes = true;
  for (let i = 0; i < 3; i++) hashes &&= byPath[`/d/f${i}.bin`]?.sha256 === (await H(bigBytes(i))) && byPath[`/d/f${i}.bin`].ident === "f00000000000000" + i;
  check(hashes, "the migrator: each data file's SHA-256, of its bytes, and its identity key");
  check(byPath["/d"]?.ident === "d000000000000001" && byPath["/n.ipynb"]?.ident === "0123456789ab" && byPath["/b.board.json"]?.ident === "ba0000000001" && byPath["/Trash/t.bin"]?.ident === "t000000000000001" && byPath["/Trash/t.bin"].sha256 === (await H("trsh")), "…a folder's, a notebook's and a board's identity key, and a file's in Trash, with its hash");
  const strip = (e) => { const { ident: _i, sha256: _s, ...r } = e; return r; };
  const beforeEntries = Object.fromEntries(before.entries.map(([k, v]) => [k, strip(v)]));
  const nowEntries = Object.fromEntries((await dump(w.ws)).entries.map(([k, v]) => [k, strip(v)]));
  check(same(beforeEntries, nowEntries), "…and nothing else of any entry changed");
  const afterDump = await dump(w.ws);
  check(J(afterDump.ops) === opsBefore && same(afterDump.fileBytes, before.fileBytes) && same(afterDump.versionBytes, before.versionBytes) && same(afterDump.boards, before.boards), "…no op recorded for it, and the bytes, versions and boards the same");
  check((await W.migrationState(w)).done === true, "…then done");
  // again (its state dropped, as by another upgrade, or a tab killed before it wrote done): nothing changes
  const first = await dump(w.ws);
  await new Promise((ok, no) => { const tx = w.ws.transaction("meta", "readwrite"); tx.objectStore("meta").delete("migration"); tx.oncomplete = ok; tx.onerror = () => no(tx.error); });
  await W.startMigrator(w);
  const second = await dump(w.ws);
  check(same(first.entries, second.entries) && same(first.ops, second.ops) && (await W.migrationState(w)).done === true, "the migrator again over a workspace it finished: idempotent, nothing changed");
  // stopped part way (a batch at a time, the state written after each: a tab killed after any batch resumes
  // from it): the same end state
  w.close();
}

async function resumable() {
  const name = `ws-ops-v3r-${Math.random().toString(36).slice(2, 8)}`;
  (await makeV3(name)).close();
  const was = W.MIGRATE.files;
  W.MIGRATE.files = 1;
  let batches = 0;
  // (each batch's state written, then the run stopped: as a tab closed or killed after it)
  W.MIGRATE.afterBatch = () => { batches++; throw new Error("stopped"); };
  try {
    for (let i = 0; i < 20; i++) {
      const w = await W.Workspace.open({ name, mainName: name + "-main" });
      await W.startMigrator(w);
      const st = await W.migrationState(w);
      w.close();
      if (st.done) break;
    }
  } finally { W.MIGRATE.files = was; W.MIGRATE.afterBatch = null; }
  const w = await W.Workspace.open({ name, mainName: name + "-main" });
  const es = await w.list("/d");
  let ok = (await W.migrationState(w)).done === true;
  for (const e of es) ok &&= e.sha256 === (await H(bigBytes(Number(e.path.slice(4, -4))))) && e.ident === e.fid;
  check(ok && batches >= 3, "the migrator stopped after every batch and started again each time: it resumes from its state, and ends with every hash and identity: " + J({ batches, done: (await W.migrationState(w)).done }));
  w.close();
}

export async function run() {
  for (const f of [createAndWrite, copies, reservations, stuckMarks, staleFolderFull, staleCounts, staleRounds, staleLapSpans, staleLapReload, staleNotice, documents, moves, emptying, others, upgrade, resumable]) {
    try { await f(); } catch (e) { check(false, `${f.name} threw: ${e?.stack ?? e}`); }
  }
  return results;
}
