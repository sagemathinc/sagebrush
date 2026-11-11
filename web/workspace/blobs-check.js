// The blob stores' invariant checker and runtime guard (copy-on-write for workspace branches) — TEST
// ONLY, never imported by the app.  Loaded into a test page beside the workspace's build.
//
// check(db): the invariants, recomputed from scratch from the raw stores (never from versionBlobs alone):
//   - every entry naming a blob: its blob kept, its bytes of the entry's size and SHA-256 (every blob is hashed here),
//     its `blob` equal to its `sha256`, and the entry still `migrated`;
//   - the versions' owners, derived from the versions rows themselves, equal versionBlobs' keys exactly (a missing
//     row would let a blob a version names be freed: lost bytes; an obsolete or wrong row only leaks);
//   - every version naming a blob: its blob kept, of the version's size and SHA-256;
//   - every pin on "b:" storage: its blob kept;
//   - every blob named by something (a blob nothing names is a leak, and fails);
//   - meta's blobBytes equal to the blobs' sizes, each blob once.
// Its result: the violations, each a string naming the store, key and sha.
//
// installGuard(hook, db): every put, add, delete and clear on blobs or versionBlobs, and every cursor update or delete
// on them, made outside a blob helper (hook.depth) or a reset's page (hook.reset) is a violation; so is every write of
// a blob reference (an entry or a version naming a blob, a pin on "b:" storage, by put, add or cursor update) made
// outside a helper, or in a transaction without the helpers' whole scope. And by what changed, not only what was
// written: every watched readwrite transaction holding entries, versions or pins has the references in them read just
// before it (a readonly transaction made first, which IndexedDB runs first) and just after it commits; a reference
// added, removed or changed (by a put, a delete, a clear, a cursor's update or delete, or a put without a blob) must
// be one a helper wrote in that transaction, and the transaction must hold the whole scope. And after every
// committed readwrite transaction of `db` that held a reference store, check(db) runs, its violations recorded with
// the transaction's stores.  pause()/resume(): a case that corrupts the stores on purpose, to test the checker.
const REF_STORES = ["entries", "versions", "versionBlobs", "pins", "blobs"];
const SCOPE = [...REF_STORES, "meta"];
const isRef = (store, v) => v && typeof v === "object" && (((store === "entries" || store === "versions") && v.blob !== undefined) || (store === "pins" && typeof v.skey === "string" && v.skey.startsWith("b:")));
const BLOB_STORES = new Set(["blobs", "versionBlobs"]);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
// (everything read in ONE readonly transaction: a consistent snapshot, which no later commit can change part way)
const snapshot = (db) => new Promise((ok, no) => {
  const t = db.transaction([...REF_STORES, "meta"]), got = {};
  const ask = (k, r) => { r.onsuccess = () => { got[k] = r.result; }; };
  for (const s of ["entries", "versions", "pins"]) ask(s, t.objectStore(s).getAll());
  ask("mirror", t.objectStore("versionBlobs").getAllKeys());
  ask("blobKeys", t.objectStore("blobs").getAllKeys());
  ask("blobVals", t.objectStore("blobs").getAll());
  ask("total", t.objectStore("meta").get("blobBytes"));
  ask("resetting", t.objectStore("meta").get("resetting"));
  t.oncomplete = () => ok(got);
  t.onerror = () => no(t.error);
});

export async function check(db) {
  const out = [];
  const { entries, versions, mirror, pins, blobKeys, blobVals, total, resetting } = await snapshot(db);
  // (a reset under way empties the stores a page at a time, the blobs first: fenced by its `resetting` state, which
  // keeps every reader and writer out until it is done; judged once it is)
  if (resetting) return out;
  const blobs = new Map(blobKeys.map((k, i) => [k, blobVals[i]]));
  const sizes = new Map();
  for (const [k, b] of blobs) {
    if (!(b instanceof Uint8Array)) { out.push(`blobs ${k}: not bytes`); continue; }
    sizes.set(k, b.length);
    const h = hex(await crypto.subtle.digest("SHA-256", b));
    if (h !== k) out.push(`blobs ${k}: its bytes hash to ${h}`);
  }
  const named = new Set();
  for (const e of entries) {
    if (e.blob === undefined) continue;
    named.add(e.blob);
    if (e.blob !== e.sha256) out.push(`entries ${e.path}: blob ${e.blob} isn't its sha256 ${e.sha256}`);
    if (e.migrated !== true) out.push(`entries ${e.path}: names blob ${e.blob} but isn't migrated`);
    if (!blobs.has(e.blob)) out.push(`entries ${e.path}: blob ${e.blob} is missing`);
    else if (sizes.get(e.blob) !== e.size) out.push(`entries ${e.path}: blob ${e.blob} is ${sizes.get(e.blob)} bytes, the entry says ${e.size}`);
  }
  const owners = new Set();
  for (const v of versions) {
    if (v.blob === undefined) continue;
    named.add(v.blob);
    owners.add(JSON.stringify([v.blob, v.id]));
    if (v.blob !== v.sha256) out.push(`versions ${v.id}: blob ${v.blob} isn't its sha256 ${v.sha256}`);
    if (!blobs.has(v.blob)) out.push(`versions ${v.id}: blob ${v.blob} is missing`);
    else if (sizes.get(v.blob) !== v.size) out.push(`versions ${v.id}: blob ${v.blob} is ${sizes.get(v.blob)} bytes, the version says ${v.size}`);
  }
  const rows = new Set(mirror.map((k) => JSON.stringify(k)));
  for (const o of owners) if (!rows.has(o)) out.push(`versionBlobs ${o}: missing (version ${JSON.parse(o)[1]} names blob ${JSON.parse(o)[0]})`);
  for (const r of rows) if (!owners.has(r)) out.push(`versionBlobs ${r}: no version names it`);
  for (const p of pins) {
    if (typeof p.skey !== "string" || !p.skey.startsWith("b:")) continue;
    const sha = p.skey.slice(2);
    named.add(sha);
    if (!blobs.has(sha)) out.push(`pins ${JSON.stringify([p.id, p.seq])}: blob ${sha} is missing`);
  }
  for (const k of blobs.keys()) if (!named.has(k)) out.push(`blobs ${k}: nothing names it (a leak)`);
  const sum = [...sizes.values()].reduce((a, b) => a + b, 0);
  if ((total ?? 0) !== sum) out.push(`meta blobBytes ${total ?? 0}: the blobs are ${sum} bytes`);
  return out;
}

export function installGuard(hook) {
  const G = { violations: [], checks: 0, paused: 0, dbs: new Set(), queue: Promise.resolve() };
  const flag = (store, op) => { if (!G.paused && hook.depth === 0 && hook.reset === 0) G.violations.push(`${op} on ${store} outside a blob helper or a reset`); };
  const refWrite = (store, value, t, op) => {
    if (G.paused || !isRef(store, value)) return;
    if (hook.depth === 0) G.violations.push(`a blob reference written to ${store} (${op}) outside a blob helper`);
    const names = t?.objectStoreNames;
    if (names && (t.mode !== "readwrite" || !SCOPE.every((s) => names.contains(s)))) G.violations.push(`a blob reference written to ${store} (${op}) in a transaction without the helpers' whole scope`);
  };
  for (const op of ["put", "add", "delete", "clear"]) {
    const f = IDBObjectStore.prototype[op];
    IDBObjectStore.prototype[op] = function (...a) { if (BLOB_STORES.has(this.name)) flag(this.name, op); if (op === "put" || op === "add") refWrite(this.name, a[0], this.transaction, op); return f.apply(this, a); };
  }
  for (const op of ["update", "delete"]) {
    const f = IDBCursor.prototype[op];
    IDBCursor.prototype[op] = function (...a) { const st = this.source?.objectStore ?? this.source, s = st?.name; if (BLOB_STORES.has(s)) flag(s, "cursor." + op); if (op === "update") refWrite(s, a[0], st?.transaction, "cursor.update"); return f.apply(this, a); };
  }
  // (what a helper wrote, by transaction: "store:key", and "versions:new" for a version put without its id)
  const helped = new WeakMap();
  const m0 = (t) => { let m = helped.get(t); if (!m) helped.set(t, (m = new Set())); return m; };
  const mark = (t, store, key) => { if (!t || (hook.depth === 0 && hook.reset === 0)) return; if (hook.reset > 0) { m0(t).add(store + ":*reset*"); return; } let m = helped.get(t); if (!m) helped.set(t, (m = new Set())); m.add(store + ":" + key); };
  const keyOf = (store, v, k) => k !== undefined ? JSON.stringify(k) : store === "entries" ? JSON.stringify(v?.path) : store === "pins" ? JSON.stringify([v?.id, v?.seq]) : v?.id !== undefined ? JSON.stringify(v.id) : "new";
  for (const op of ["put", "add", "delete", "clear"]) {
    const f = IDBObjectStore.prototype[op];
    IDBObjectStore.prototype[op] = function (...a) {
      if (["entries", "versions", "pins"].includes(this.name)) mark(this.transaction, this.name, op === "clear" ? "*" : op === "delete" ? (a[0] instanceof IDBKeyRange ? "*" : JSON.stringify(a[0])) : keyOf(this.name, a[0], a[1]));
      return f.apply(this, a);
    };
  }
  for (const op of ["update", "delete"]) {
    const f = IDBCursor.prototype[op];
    IDBCursor.prototype[op] = function (...a) { const st = this.source?.objectStore ?? this.source; if (["entries", "versions", "pins"].includes(st?.name)) mark(st.transaction, st.name, JSON.stringify(this.primaryKey)); return f.apply(this, a); };
  }
  // (the references in entries, versions and pins, as a map "store:key" -> the blob named)
  const refsIn = (t, stores) => new Promise((ok, no) => {
    const out = new Map(), left = { n: stores.length };
    if (!stores.length) return ok(out);
    for (const s of stores) {
      const c = t.objectStore(s).openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) { if (--left.n === 0) ok(out); return; }
        const v = cur.value, ref = s === "pins" ? (typeof v?.skey === "string" && v.skey.startsWith("b:") ? v.skey : undefined) : v?.blob;
        if (ref !== undefined) out.set(s + ":" + JSON.stringify(cur.primaryKey), ref);
        cur.continue();
      };
      c.onerror = () => no(c.error);
    }
  });
  const tx = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    const names0 = [].concat(stores), watched = G.dbs.has(this) && mode === "readwrite" && !G.paused;
    const refStores = watched ? names0.filter((s) => ["entries", "versions", "pins"].includes(s)) : [];
    const before = refStores.length ? refsIn(tx.call(this, refStores, "readonly"), refStores) : null;
    const t = tx.call(this, stores, mode, ...rest);
    const names = names0;
    if (before) {
      const db = this;
      t.addEventListener("complete", () => {
        G.queue = G.queue.then(async () => {
          const was = await before, now = await refsIn(tx.call(db, refStores, "readonly"), refStores), m = helped.get(t) ?? new Set();
          const keys = new Set([...was.keys(), ...now.keys()]);
          for (const k of keys) {
            if (was.get(k) === now.get(k)) continue;
            const store = k.slice(0, k.indexOf(":"));
            // (a reset's page: its own fenced exception, neither a helper's nor in the helpers' scope)
            if (m.has(store + ":*reset*")) continue;
            const ok = m.has(k) || m.has(store + ":*") || (store === "versions" && !was.has(k) && m.has("versions:new"));
            if (!ok) G.violations.push(`a blob reference changed outside a blob helper: ${k} (${was.get(k) ?? "none"} -> ${now.get(k) ?? "none"})`);
            if (!SCOPE.every((x) => names.includes(x))) G.violations.push(`a blob reference changed in a transaction without the helpers' whole scope: ${k}`);
          }
        }).catch((e) => G.violations.push("the reference diff failed: " + e));
      });
    }
    if (G.dbs.has(this) && mode === "readwrite" && names.some((s) => REF_STORES.includes(s))) {
      const db = this;
      t.addEventListener("complete", () => {
        if (G.paused) return;
        G.queue = G.queue.then(async () => { G.checks++; for (const v of await check(db)) G.violations.push(`after a transaction of [${names.join(", ")}]: ${v}`); }).catch((e) => G.violations.push("the checker failed: " + e));
      });
    }
    return t;
  };
  return {
    watch: (db) => G.dbs.add(db),
    // (waits for the checks already queued first: none runs on a state planted while paused)
    pause: async () => { await G.queue; G.paused++; },
    resume: () => { G.paused--; },
    settled: () => G.queue,
    violations: () => G.violations,
    take: () => G.violations.splice(0),
    checks: () => G.checks,
  };
}
