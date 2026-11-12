// The service worker of sagebrush.space: the notebook works offline, and
// installs as an app.  web/build.ts fills in VERSION, SHELL, LAZY and DIGESTS.
//
// The app's own files (SHELL, kept when this script installs; LAZY, kept the
// first time they are fetched online through it or by "download all": the
// engine, the documentation indexes and the Python library's chunks, which
// not every visit needs) are fetched network-first, so a deploy shows up at
// once, with the kept copy when offline; those whose URLs have a content hash
// (?h=, or a library chunk's name: lib/<group>.<kind>.<hash>.json) are
// cache-first.  Everything else (the Atlas, demos, data a notebook fetches) is
// not cached.
//
// The cache is the origin's storage, which any script of the origin can
// write.  So a kept copy is used only if it is under this build's exact
// request key, exactly the size and with the SHA-256 the build gave it
// (DIGESTS), and is then served as a response made here with the build's
// status and headers, never the kept one's; else it is dropped and fetched
// again, or, offline, not served (design/security.md, SEC-8D6-1, SEC-522-1;
// plan-b8-offline §14 S1).  Every body this script buffers is counted in one
// 64 MiB budget (§12 SIZE-8, §14 S3), and every body it puts into the build's
// cache is read with its own 1 MiB buffer and refused past its size (§13,
// §16).  This script itself cannot be changed that way: the browser fetches it.
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const LAZY = __LAZY__;
const DIGESTS = __DIGESTS__;
const CACHE = "sagebrush-" + VERSION;
// (web/stall-fetch.js's bound, given by the build: a client's chunk fetch is given up after this long without data)
const STALL_LIMIT_MS = __STALL_LIMIT_MS__;
// A kept copy's read is given up after half that without data, so the copy's request falls through to the network
// well before its client gives up: a cache-hit body that never settled held a Sage run for good (the grader's
// plain-worker investigation; VM1, Nov 3: the reservation taken, the read never answered, nobody waiting)
const READ_STALL_MS = STALL_LIMIT_MS / 2;

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

const scope = new URL(self.registration.scope);
const shellPaths = new Set([...SHELL, ...LAZY].map((p) => new URL(p, scope).pathname));
const wanted = new Map(Object.entries(DIGESTS).map(([p, d]) => [new URL(p, scope).pathname, d]));
const MiB = 1 << 20;
// (timers are N * timeScale; the test build's hook alone may change it, or the estimate it reads)
let timeScale = 1, estimateFn = () => navigator.storage?.estimate?.();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// the budget: one semaphore for every buffered body, serving ahead of background work, at most 64 waiting; a fetch job
// runs at most 8 files at once, each holding at most one waiting place (reviewed policy, daybreak2/daybreak3)
const MAX_BODY_WAITERS = 64, MAX_JOB_FILES = 8;
let budgetUsed = 0, budgetPeak = 0;
const waiters = [];
function pump() {
  for (;;) {
    const w = waiters.find((x) => x.serve) ?? waiters[0];
    if (!w || budgetUsed + w.n > 64 * MiB) return;
    waiters.splice(waiters.indexOf(w), 1);
    budgetUsed += w.n;
    budgetPeak = Math.max(budgetPeak, budgetUsed);
    let done = false;
    w.ok(() => { if (!done) (done = true, (budgetUsed -= w.n), pump()); });
  }
}
function reserve(n, serve) {
  if (n > 64 * MiB || waiters.length >= MAX_BODY_WAITERS) return Promise.reject(new Error("budget"));
  return new Promise((ok) => (waiters.push({ n, serve, ok }), pump()));
}

// exactly `size` bytes of a body in one buffer, or null (shorter or longer); with this script's own buffer (BYOB),
// or, for serving only, chunk by chunk up to the first byte too many (§16); STALLED thrown when a read gives no data
// for READ_STALL_MS (the reader then cancelled)
const STALLED = new Error("stalled");
async function readExact(body, size, serving) {
  let r = null, ab = new ArrayBuffer(size), off = 0;
  if (!body) return size ? null : ab;
  try { r = body.getReader({ mode: "byob" }); } catch { if (!serving) return null; }
  const d = r ?? body.getReader();
  try {
    for (;;) {
      let timer;
      const stalled = new Promise((_, no) => (timer = setTimeout(() => no(STALLED), READ_STALL_MS * timeScale)));
      const { value, done } = await Promise.race([r ? d.read(new Uint8Array(off < size ? ab : new ArrayBuffer(1), off < size ? off : 0, off < size ? Math.min(size - off, MiB) : 1)) : d.read(), stalled]).finally(() => clearTimeout(timer));
      if (done) return off === size ? ab : null;
      if (off + value.byteLength > size) return null;
      if (r) ab = value.buffer;
      else new Uint8Array(ab).set(value, off);
      off += value.byteLength;
    }
  } finally {
    d.cancel().catch(() => {});
  }
}

// an ingested body as chunks of at most 1 MiB from this script's own buffer, erroring past `size` or short at its end
// (so Cache.put stores nothing, §13 R3-1); null when it isn't a byte stream (then it isn't ingested, §16)
function limited(body, size, onBytes) {
  let r, buf = new ArrayBuffer(MiB), n = 0;
  try { r = body.getReader({ mode: "byob" }); } catch { return null; }
  return new ReadableStream({
    async pull(c) {
      const { value, done } = await r.read(new Uint8Array(buf, 0, MiB));
      if (done) return n === size ? c.close() : c.error(new Error("size"));
      if ((n += value.byteLength) > size) return (r.cancel().catch(() => {}), c.error(new Error("size")));
      c.enqueue(value.slice());
      buf = value.buffer;
      onBytes?.(value.byteLength);
    },
    cancel: (why) => r.cancel(why),
  }, { highWaterMark: 1 });
}
// (a stream's reservation: its buffer and one queued chunk, §15)
const INGEST = 2 * MiB;
// the response stored for `p`: constructed, its metadata never served (§14 S1)
function stored(p, body, onBytes) {
  const w = wanted.get(p), s = limited(body, w.size, onBytes);
  return s && new Response(s, { status: 200, headers: { "Content-Type": w.headers["Content-Type"] } });
}

// the bytes of the cache's entry under `key` if it is this build's file `p`, with the budget's release (kept while
// they are served, §14 S3); a wrong entry (length, bytes, a redirect) is deleted; a read that stalled (READ_STALL_MS
// without data) is not an answer: null, the entry left, so the request goes to the network, and that key's kept copy
// isn't read again until a new copy is put (fetchAndKeep) or STALL_SKIP_MS pass, so requests waiting their turn
// behind a stalled read don't each stall on the same entry (sync-docs' APP-565-1).  The digest after the read is CPU
// work and isn't bounded.  One check of a key at a time: a page's request and the keep it then asks for
// (offlineKeep's entryVerified) read the same entry, and a stalled read was seen with that overlap (VM1, Nov 3)
let stallSaid = false;
const checking = new Map();
const STALL_SKIP_MS = 6 * READ_STALL_MS;
const skipRead = new Map(); // key -> until when its kept copy isn't read (a read of it stalled)
function check(cache, key, p, serve, opts) {
  const k = String(key?.url ?? key), prev = checking.get(k) ?? Promise.resolve();
  const run = prev.then(() => checkNow(cache, key, p, serve, opts));
  const tail = run.catch(() => {});
  checking.set(k, tail);
  tail.then(() => checking.get(k) === tail && checking.delete(k));
  return run;
}
async function checkNow(cache, key, p, serve, opts) {
  for (const [x, t] of skipRead) t > Date.now() || skipRead.delete(x);
  const k = String(key?.url ?? key), skip = skipRead.get(k);
  if (skip !== undefined && Date.now() < skip) return null;
  skipRead.delete(k);
  const w = wanted.get(p), hit = w && (await cache.match(key, opts));
  if (!hit) return null;
  let release = null, bytes = null, stalled = false;
  if (hit.status === 200 && !hit.redirected) {
    try { release = await reserve(2 * w.size, serve); } catch { return null; }
    try {
      bytes = await readExact(hit.body, w.size, serve);
      if (bytes && hex(await crypto.subtle.digest("SHA-256", bytes)) !== w.sha256) bytes = null;
    } catch (e) { (stalled = e === STALLED), (bytes = null); }
  }
  if (bytes) return { bytes, release };
  release?.();
  if (stalled) {
    skipRead.set(k, Date.now() + STALL_SKIP_MS * timeScale);
    if (!stallSaid) (stallSaid = true), console.warn(`sagebrush: a kept copy of ${p} gave no data for ${READ_STALL_MS / 1000} s; fetched from the network instead`);
    return null;
  }
  await cache.delete(key, opts);
  return null;
}
async function entryVerified(cache, key, p, opts) {
  const c = await check(cache, key, p, false, opts);
  c?.release();
  return !!c;
}

// a kept copy as the build made it, or null; the reservation is held until its body is read, cancelled or 120 s pass
async function servedFrom(cache, req, p, opts) {
  const c = await check(cache, req, p, true, opts);
  if (!c) return null;
  const view = new Uint8Array(c.bytes);
  let at = 0;
  const done = () => (clearTimeout(timer), c.release());
  const body = new ReadableStream({
    pull(s) {
      if (at >= view.length) return (s.close(), done());
      s.enqueue(view.slice(at, (at += MiB)));
    },
    cancel: done,
  });
  const timer = setTimeout(() => (body.cancel().catch(() => {}), done()), 120000 * timeScale);
  // (security audit G-3b: a kept copy's replay says nosniff as the network's response does (web/_headers' /*))
  return new Response(body, { status: 200, headers: { ...wanted.get(p).headers, "X-Content-Type-Options": "nosniff" } });
}

// this version's kept copy of a request, verified; while a migration is pending (§7), an older build's copy too,
// checked against this build's DIGESTS and served as this build's
async function kept(req, p, opts) {
  for (const name of [CACHE, ...(await offlineSources())]) {
    const ok = await servedFrom(await caches.open(name), req, p, opts);
    if (ok) return ok;
  }
  return null;
}

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return;
  // an optional package set's index or chunk (SEC-PKG-1, below)
  const pm = PKG_PATH.exec(url.pathname);
  if (pm) {
    // (only the exact grammar; a Range request, the worker's synchronous
    // fallback, goes to the network and is never kept)
    if (url.search || url.hash || req.headers.has("range")) return;
    ev.respondWith(pkgResponse(url, pm[1], ev));
    return;
  }
  if (req.headers.has("x-sb-preload")) return; // (preload.ts)
  // the page itself (with any ?open=... or #share link): the cached "./" when offline
  const page = req.mode === "navigate" && (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
  if (!page && !shellPaths.has(url.pathname)) return;
  const key = page ? new Request(new URL("./", scope)) : req, p = page ? scope.pathname : url.pathname;
  if (url.searchParams.has("h") || /\/lib\/[\w.-]+\.[0-9a-f]{16}\.json$/.test(url.pathname)) {
    ev.respondWith((async () => (await kept(req, p)) ?? fetchAndKeep(req, key, p, ev))());
    return;
  }
  ev.respondWith((async () => {
    try {
      return await fetchAndKeep(req, key, p, ev);
    } catch (e) {
      const ok = await kept(key, p, { ignoreSearch: page });
      if (ok) return ok;
      throw e;
    }
  })());
});

// The library's chunks a page fetched before this script controlled it (a
// first visit: they went past it), told by the page (web/notebook/
// worker-kernel.js): kept now, so they are there offline.  Only a name of a
// chunk of this build (content-addressed, in LAZY, with a digest), at most as
// many as there are, each downloaded as "download all" does, in its queue.
// Anything else, and any failure, is ignored: this only fills the cache.
const CHUNK_PATH = new RegExp("^" + scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "lib/[a-z0-9][a-z0-9-]*\\.(?:src|pre)\\.[0-9a-f]{16}\\.json$");
const lazyChunks = new Set(LAZY.map((p) => new URL(p, scope).pathname).filter((p) => CHUNK_PATH.test(p) && wanted.has(p)));
self.addEventListener("message", (ev) => {
  const files = ev.data?.keep;
  if (ev.origin !== scope.origin || !Array.isArray(files) || files.length > lazyChunks.size) return;
  const paths = new Set();
  for (const f of files) {
    if (typeof f !== "string" || f.length > 200) return;
    let u;
    try { u = new URL(f, scope); } catch { return; }
    if (u.origin !== scope.origin || u.search || u.hash || !lazyChunks.has(u.pathname)) return;
    paths.add(u.pathname);
  }
  ev.waitUntil(offlineSerial(async () => {
    for (const p of paths) await offlineKeep(p, null).catch(() => {});
  }).catch(() => {}));
});

// fetched online for the page; a copy kept through the bounded reader when its body is a byte stream, and reported
// verified only after its read-back (§12)
async function fetchAndKeep(req, key, p, ev) {
  const res = await fetch(req);
  const copy = res.ok && res.type === "basic" && !res.redirected && wanted.has(p) && stored(p, res.clone().body);
  if (copy) {
    ev.waitUntil((async () => {
      const cache = await caches.open(CACHE), release = await reserve(INGEST, false);
      try { await cache.put(key, copy); skipRead.delete(String(key?.url ?? key)); } finally { release(); }
      await offlineSerial(async () => (await entryVerified(cache, key, p)) && offlineVerified.add(p));
    })().catch(() => {}));
  }
  return res;
}

// Optional package sets (plan-modular-packages-r4 §4.3, §4.6; design/
// security.md SEC-PKG-1).  /pkgset/<sha256>.json and /pkg/<sha256>.json are
// content-addressed: a response is used only if its bytes have the SHA-256 in
// its own path, both when it comes from the network and when it comes from
// the cache, and is always served as a response made here (status 200, JSON,
// no other headers), never the network's or the cache's own.  They are kept
// in a cache of their own (never the build's), bounded by a ledger: at most
// PKG_MAX_ENTRIES entries and PKG_MAX_BYTES bytes (or 10% of the origin's
// quota, if smaller), never leaving less than the documents' reserve free,
// least recently used evicted first, except entries a live notebook's
// interpreter pinned in the last 10 minutes.  The worker checks every byte
// against its set's pins again (src/pkgset.ts), so the cache is only a cache.
//
// The ledger and the cache are kept consistent (daybreak3's LIMIT-PR68-3):
// every change to either runs in one queue, in this order, so a physical
// entry always has a ledger row and the caps hold for the physical cache at
// every moment, even if this worker is stopped in between:
//   reconcile (rows without an entry, entries without a row: both removed;
//   a "pending" row whose entry is there becomes "kept"; "deleting" rows'
//   entries deleted, then the rows) -> choose evictions -> mark them
//   "deleting" and record the new row "pending" -> delete their entries ->
//   drop their rows -> put the entry -> mark it "kept".
// And the keep is part of the fetch's lifetime (event.waitUntil).
const PKG_PATH = new RegExp("^" + scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:pkg|pkgset)/([0-9a-f]{64})\\.json$");
const PKG_CACHE = "sb-pkg-v1"; // (not "sagebrush-…": a new version's activate doesn't drop it)
const PKG_MAX_ENTRIES = 64, PKG_MAX_BYTES = 256 * 1024 * 1024, PKG_MAX_BODY = 8 * 1024 * 1024;
const PKG_PIN_MS = 10 * 60 * 1000;
const pkgMade = (bytes) => new Response(bytes, { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const digestOf = (u) => /\/([0-9a-f]{64})\.json$/.exec(new URL(u).pathname)?.[1] ?? null;

// the ledger: IndexedDB sb-pkg-ledger, {digest, bytes, used, pin, state: pending|kept|deleting}
function ledgerDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("sb-pkg-ledger", 2);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("e")) r.result.createObjectStore("e", { keyPath: "digest" }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
// one transaction: f gets the store and the rows, and returns what to do
async function ledgerTx(f) {
  const db = await ledgerDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction("e", "readwrite"), s = t.objectStore("e");
      let out;
      s.getAll().onsuccess = (e) => { out = f(s, e.target.result); };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// the queue: one package-cache operation at a time
let pkgChain = Promise.resolve();
function pkgSerial(f) {
  const p = pkgChain.then(f, f);
  pkgChain = p.catch(() => {});
  return p;
}

// (bounded: at most 4 x PKG_MAX_ENTRIES entries looked at a time; a cache
// can't hold more than that except by a crash, which each pass reduces)
async function pkgReconcile(cache) {
  const keys = (await cache.keys()).slice(0, 4 * PKG_MAX_ENTRIES);
  const present = new Map(keys.map((k) => [digestOf(k.url), k]));
  const del = await ledgerTx((s, rows) => {
    const known = new Set();
    const out = [];
    for (const r of rows) {
      known.add(r.digest);
      if (r.state === "deleting") out.push(r.digest);
      else if (!present.has(r.digest)) s.delete(r.digest);
      else if (r.state === "pending") s.put({ ...r, state: "kept" });
    }
    for (const d of present.keys()) if (d === null || !known.has(d)) out.push(d);
    return out;
  });
  for (const d of del) {
    const k = present.get(d);
    if (k) await cache.delete(k);
  }
  if (del.length) await ledgerTx((s, rows) => { for (const r of rows) if (r.state === "deleting") s.delete(r.digest); });
}

async function pkgFetch(url, r) {
  const res = await fetch(url.href, { redirect: "error", credentials: r.credentials, referrerPolicy: r.referrerPolicy, cache: "no-store" });
  if (res.status !== 200 || res.type !== "basic") throw new Error("HTTP " + res.status);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > PKG_MAX_BODY) throw new Error("too large");
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > PKG_MAX_BODY) {
      await reader.cancel();
      throw new Error("too large");
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out.buffer;
}

async function pkgResponse(url, digest, ev) {
  const cache = await caches.open(PKG_CACHE);
  const key = new Request(url.href);
  const hit = await cache.match(key);
  if (hit) {
    const b = await hit.arrayBuffer();
    if (hex(await crypto.subtle.digest("SHA-256", b)) === digest) {
      ev.waitUntil(pkgSerial(() => ledgerTx((s, rows) => {
        const r = rows.find((x) => x.digest === digest);
        if (r && r.state === "kept") s.put({ ...r, used: Date.now() });
      })).catch(() => {}));
      return pkgMade(b);
    }
    ev.waitUntil(pkgSerial(() => pkgReconcile(cache)).catch(() => {}));
  }
  let b;
  try {
    b = await pkgFetch(url, ev.request);
  } catch {
    // (offline, or not there: no stand-in is ever served)
    return new Response(null, { status: 504 });
  }
  if (hex(await crypto.subtle.digest("SHA-256", b)) !== digest) return new Response(null, { status: 502 });
  ev.waitUntil(pkgSerial(() => keepPkg(cache, key, digest, b)).catch(() => {}));
  return pkgMade(b);
}

// keep it, if the caps and the documents' reserve allow (in the queue)
async function keepPkg(cache, key, digest, bytes) {
  await pkgReconcile(cache);
  if (await cache.match(key)) return;
  const est = (await navigator.storage?.estimate?.()) ?? {};
  const quota = est.quota ?? 0, usage = est.usage ?? 0;
  const capBytes = quota ? Math.min(PKG_MAX_BYTES, Math.floor(quota / 10)) : PKG_MAX_BYTES;
  const reserve = Math.max(512 * 1024 * 1024, Math.floor(quota / 5));
  if (bytes.byteLength > capBytes) return;
  // (and never into the documents' reserve: then it is used once, not kept)
  if (quota && quota - usage - bytes.byteLength < reserve) return;
  const now = Date.now();
  const evict = await ledgerTx((s, rows) => {
    rows = rows.filter((r) => r.state !== "deleting").sort((a, b) => a.used - b.used);
    let total = rows.reduce((t, r) => t + r.bytes, 0), count = rows.length;
    const out = [];
    for (const r of rows) {
      if (total + bytes.byteLength <= capBytes && count + 1 <= PKG_MAX_ENTRIES) break;
      if (r.pin > now) continue;
      out.push(r.digest);
      total -= r.bytes;
      count--;
    }
    if (total + bytes.byteLength > capBytes || count + 1 > PKG_MAX_ENTRIES) return null;
    for (const d of out) s.put({ ...rows.find((r) => r.digest === d), state: "deleting" });
    s.put({ digest, bytes: bytes.byteLength, used: now, pin: 0, state: "pending" });
    return out;
  });
  if (evict === null) return;
  const keys = await cache.keys();
  for (const d of evict) for (const k of keys) if (digestOf(k.url) === d) await cache.delete(k);
  await ledgerTx((s, rows) => { for (const r of rows) if (r.state === "deleting") s.delete(r.digest); });
  await cache.put(key, pkgMade(bytes));
  await ledgerTx((s, rows) => {
    const r = rows.find((x) => x.digest === digest);
    if (r) s.put({ ...r, state: "kept" });
  });
}

self.addEventListener("activate", (ev) => ev.waitUntil(caches.open(PKG_CACHE).then((c) => pkgSerial(() => pkgReconcile(c))).catch(() => {})));

// Heartbeat pins: a page sends {pkgPin: [digest...]} for the chunks its live
// interpreters use (web/notebook/worker-kernel.js), every 2 minutes; they are
// not evicted for 10 minutes after.  Never permanent: an evicted set of an old
// notebook is fetched again when it is next opened.
self.addEventListener("message", (ev) => {
  const pins = ev.data?.pkgPin;
  if (ev.origin !== scope.origin || !Array.isArray(pins) || pins.length > PKG_MAX_ENTRIES) return;
  if (!pins.every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d))) return;
  const until = Date.now() + PKG_PIN_MS;
  ev.waitUntil(pkgSerial(() => ledgerTx((s, rows) => {
    for (const r of rows) if (pins.includes(r.digest) && r.state === "kept") s.put({ ...r, pin: until });
  })).catch(() => {}));
});


// ==== Offline (plan-b8-offline r3.4): what is downloaded, "download all", keeping it across deploys ====
// The page asks over a MessagePort and is answered on it only (§9).  Every change to the build's caches runs in one
// queue (§5), apart from the package cache's.  The state is the caches and a few IndexedDB records (sb-offline),
// never a claim that a file is good: only a check against this build's DIGESTS makes one.
function rec(k, v, write) {
  return new Promise((resolve, reject) => {
    const o = indexedDB.open("sb-offline", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onerror = () => reject(o.error);
    o.onsuccess = () => {
      const db = o.result, t = db.transaction("kv", write ? "readwrite" : "readonly"), s = t.objectStore("kv");
      let out;
      if (!write) s.get(k).onsuccess = (e) => (out = e.target.result);
      else if (v === undefined) s.delete(k);
      else s.put(v, k);
      t.oncomplete = () => (db.close(), resolve(out));
      t.onerror = t.onabort = () => (db.close(), reject(t.error));
    };
  });
}
const recGet = (k) => rec(k);
const recPut = (k, v) => rec(k, v, true);

let offlineChain = Promise.resolve();
function offlineSerial(f) {
  const p = offlineChain.then(f, f);
  offlineChain = p.catch(() => {});
  return p;
}
// files checked in this worker's lifetime (in memory, never stored, §4)
const offlineVerified = new Set();

// the catalog, its caps checked again here (§3)
const lazyKey = new Map(LAZY.map((p) => [new URL(p, scope).pathname, new URL(p, scope).href]));
const lazyPaths = [...lazyKey.keys()];
const catalogOk = lazyPaths.length <= 600 && lazyPaths.every((p) => wanted.get(p)?.size <= 16 * MiB) && lazyPaths.reduce((t, p) => t + wanted.get(p).size, 0) <= 64 * MiB;

// the probe (§16): a cached same-origin body read with this script's own buffer, once, before any ingestion
let probed;
const byob = () => (probed ??= caches.open(CACHE).then((c) => c.match(new URL("manifest.webmanifest", scope).href)).then((r) => r.body.getReader({ mode: "byob" }).cancel().then(() => true)).catch(() => false));

// the inventory (offline-inventory.json, in SHELL, checked as every kept file) and an item's paths, from LAZY only
// (a missing or bad kept copy is fetched again, kept through the bounded reader, and used only once it verifies)
let invP;
const invReq = () => new Request(new URL("offline-inventory.json", scope)), invPath = scope.pathname + "offline-inventory.json";
async function invGet() {
  let w;
  return (await kept(invReq(), invPath)) ?? ((await fetchAndKeep(invReq(), invReq(), invPath, { waitUntil: (x) => (w = x) })).body?.cancel(), await w, kept(invReq(), invPath));
}
const inventory = () => (invP ??= invGet().then((r) => r.json()).then((inv) => {
  if (inv?.format !== "sagebrush-offline-1" || !Array.isArray(inv.items)) throw 0;
  // (an item the page can't use yet is dropped here, the one place the inventory is read: not listed, never in
  // "download all" or a "new item", never fetched; the build's controls still count it, web/offline-inventory.mts)
  inv.items = inv.items.filter((it) => it.hidden !== true);
  return inv;
}).catch((e) => { invP = null; throw new Error("inventory"); }));
function itemPaths(it) {
  const b = scope.pathname;
  const gs = new Set(it.groups ?? []);
  return lazyPaths.filter((p) => it.rule === "engine" ? p === b + "sagebrush-engine.wasm" : it.rule === "myst" ? p === b + "sagebrush-myst.js" : it.rule === "docs" ? /^docs-(index(-[a-z]+)?|upstream-[a-z]+)\.json$/.test(p.slice(b.length)) : it.rule === "tzdata" ? p.startsWith(b + "lib/tzdata/") : gs.has(/\/lib\/([a-z0-9-]+)\.(?:src|pre)\.[0-9a-f]{16}\.json$/.exec(p)?.[1]));
}
const itemsDone = async (ids) => (await inventory()).items.filter((it) => ids.includes(it.id) && itemPaths(it).every((p) => offlineVerified.has(p))).map((it) => it.id);

// quota (§6): beside the documents' reserve, max(512 MiB, 20% of the quota)
async function free() {
  const { quota = 0, usage = 0 } = (await estimateFn()) ?? {};
  return quota ? quota - usage - Math.max(512 * MiB, quota / 5) : Infinity;
}

// one file: downloaded through the bounded reader, put, read back and checked (§12-§14); true if it was already there
class Failed extends Error {}
async function offlineKeep(p, job) {
  const cache = await caches.open(CACHE), key = lazyKey.get(p), w = wanted.get(p);
  if (await entryVerified(cache, key, p)) return (offlineVerified.add(p), true);
  if (!(await byob())) throw new Failed("unsupported");
  for (let attempt = 0; ; attempt++) {
    if ((await free()) < w.size) throw new Failed("quota");
    // (astra: the remove-exclusion checked again before every put)
    if (job && (await job.excluded(p))) throw new Failed("removed");
    const ctl = new AbortController(), stop = () => ctl.abort();
    let read = 0, stall = setTimeout(stop, 60000 * timeScale), why = null;
    job?.signal.addEventListener("abort", stop);
    const release = await reserve(INGEST, false);
    try {
      const res = await fetch(key, { signal: ctl.signal, redirect: "error", credentials: "same-origin" });
      if (res.status !== 200 || res.type !== "basic") throw new Failed("http " + res.status);
      const body = stored(p, res.body, (n) => {
        read += n;
        job?.progress(n);
        clearTimeout(stall);
        stall = setTimeout(stop, 60000 * timeScale);
      });
      if (!body) throw new Failed("unsupported");
      await cache.put(key, body).catch((e) => { throw new Failed(e?.name === "QuotaExceededError" ? "quota" : ctl.signal.aborted ? "stalled" : "size"); });
    } catch (e) {
      job?.progress(-read);
      why = job?.signal.aborted ? "cancelled" : e instanceof Failed ? e.message : ctl.signal.aborted ? "stalled" : "network";
    } finally {
      clearTimeout(stall);
      job?.signal.removeEventListener("abort", stop);
      release();
    }
    // (60 s without a byte or a server error: retried once)
    if (why && attempt === 0 && (why === "stalled" || why.startsWith("http 5"))) continue;
    if (why) throw new Failed(why);
    if (await entryVerified(cache, key, p)) return (offlineVerified.add(p), false);
    throw new Failed("digest");
  }
}

// the fetch job (§5): one at a time; a later request joins it or is merged into it
let job = null, jobs = 0, inflightPeak = 0, keysLooked = 0;
const post = (port, m) => { try { port.postMessage(m); } catch {} };
function newJob(ids, paths, background) {
  const ctl = new AbortController();
  const j = {
    id: VERSION.slice(0, 6) + "-" + ++jobs, items: new Set(ids), queue: [], all: new Set(), background,
    filesTotal: 0, bytesTotal: 0, filesDone: 0, bytesDone: 0, failed: [], ports: new Set(), last: 0,
    signal: ctl.signal, abort: () => ctl.abort(), cancelled: false,
    add(ps) {
      for (const p of ps) if (!j.all.has(p)) (j.all.add(p), j.queue.push(p), j.filesTotal++, (j.bytesTotal += wanted.get(p).size));
    },
    tell(m) { for (const port of j.ports) post(port, m); },
    // (at most 4 updates a second; bytesDone counts in-flight files' bytes read so far)
    progress(n) {
      j.bytesDone += n;
      if (Date.now() - j.last >= 250) (j.last = Date.now(), j.tell({ job: j.id, filesDone: j.filesDone, bytesDone: j.bytesDone }));
    },
    async excluded(p) {
      const removed = j.background ? (await recGet("keep"))?.removed ?? [] : [];
      return (await inventory()).items.some((it) => removed.includes(it.id) && itemPaths(it).includes(p));
    },
  };
  j.add(paths);
  return j;
}
function join(j, port) {
  if (port && j.ports.size < 8) j.ports.add(port);
  j.tell({ job: j.id, filesTotal: j.filesTotal, bytesTotal: j.bytesTotal });
}
// files at once while their expected sizes sum to at most 24 MiB (at least one), and at most MAX_JOB_FILES; a 30 min
// deadline
async function runJob(j) {
  const deadline = setTimeout(j.abort, 30 * 60000 * timeScale), running = new Set();
  let bytes = 0;
  while ((j.queue.length || running.size) && !j.signal.aborted) {
    while (j.queue.length && !j.signal.aborted && running.size < MAX_JOB_FILES && (!running.size || bytes + wanted.get(j.queue[0]).size <= 24 * MiB)) {
      const p = j.queue.shift(), sz = wanted.get(p).size;
      bytes += sz;
      inflightPeak = Math.max(inflightPeak, bytes);
      const t = offlineKeep(p, j).then((had) => had && (j.bytesDone += sz), (e) => {
        j.failed.push({ path: p.slice(scope.pathname.length), reason: e?.message ?? "error" });
        if (e?.message === "quota") j.abort();
      }).finally(() => (j.filesDone++, (bytes -= sz), running.delete(t)));
      running.add(t);
    }
    if (running.size) await Promise.race(running);
  }
  await Promise.allSettled(running);
  clearTimeout(deadline);
  const items = await itemsDone([...j.items]).catch(() => []);
  const quota = j.failed.some((f) => f.reason === "quota");
  j.tell({ job: j.id, items, failed: j.failed, filesDone: j.filesDone, bytesDone: j.bytesDone, ...(j.cancelled ? { cancelled: true } : quota ? { error: "quota" } : j.failed.length || j.signal.aborted ? {} : { done: true }) });
}
// (admission in turn, so two requests never both start a job, §5)
let admitting;
const startFetch = (...a) => (admitting = Promise.resolve(admitting).catch(() => {}).then(() => admit(...a)));
async function admit(ids, port, background) {
  if (!catalogOk) return { error: "catalog-cap" };
  if (!(await byob())) return { error: "unsupported" };
  const paths = [...new Set((await inventory()).items.filter((it) => ids.includes(it.id)).flatMap(itemPaths))];
  if (job) {
    if (new Set([...job.all, ...paths]).size > 600) return { error: "catalog-cap" };
    job.add(paths);
    ids.forEach((id) => job.items.add(id));
    if (!background) job.background = false;
    join(job, port);
    return null;
  }
  // admission (§6): the missing bytes and two in-flight windows, plus the package cache's pending writes
  const have = new Set((await present()).map((p) => scope.pathname + p));
  let need = 48 * MiB + paths.filter((p) => !have.has(p)).reduce((t, p) => t + wanted.get(p).size, 0);
  need += await ledgerTx((s, rows) => rows.filter((r) => r.state === "pending").reduce((t, r) => t + r.bytes, 0)).catch(() => 0);
  const f = await free();
  if (f < need) return { error: "quota", need, free: Math.max(0, f) };
  const j = (job = newJob(ids, paths, background));
  join(j, port);
  offlineSerial(() => runJob(j).finally(() => (job = null))).catch(() => {});
  return null;
}

// the carry-over (§7, §12 SIZE-7, §13 R3-2, §14 S2, §15): older build caches give this build's what it lacks, one
// entry at a time, and are deleted only when they hold nothing it needs
let sources;
async function offlineSources() {
  try {
    const have = new Set(await caches.keys());
    return (sources ??= ((await recGet("sources")) ?? []).filter((n) => n !== CACHE && have.has(n)));
  } catch {
    return [];
  }
}
const setSources = (names) => recPut("sources", (sources = names.filter((n) => n !== CACHE)));
// a stopped move settled first: the named destination re-verified, the source deleted only after a verified copy (§15)
async function reconcileMove() {
  const m = await recGet("moving");
  if (!m) return;
  const ok = (await caches.has(m.to)) && (await entryVerified(await caches.open(m.to), m.key, m.path));
  if (m.to !== CACHE) {
    // (a deploy mid-move: `to` is an old cache now, and its verified copy one more source for the sweep)
    if (ok && !(await offlineSources()).includes(m.to)) await setSources([m.to, ...(await offlineSources())]);
  } else if (ok) {
    await (await caches.open(m.from)).delete(m.key);
  }
  await recPut("moving", undefined);
}
async function carryOver() {
  const olds = [];
  if (!catalogOk || !(await byob())) {
    // (unsupported, or over the caps: no consolidation, and older caches deleted as before)
    for (const k of await caches.keys()) if (k.startsWith("sagebrush-") && k !== CACHE) await caches.delete(k);
    await setSources([]);
    return recPut("migration", { error: catalogOk ? "unsupported" : "catalog-cap" });
  }
  await reconcileMove();
  const cur = await caches.open(CACHE);
  for (const name of await offlineSources()) {
    const cache = await caches.open(name), keys = new Map();
    // (enumeration bounded, astra; an entry not of this build's LAZY is useless to it, and deleted)
    for (const k of (await cache.keys()).slice(0, 1200)) {
      keysLooked++;
      const p = new URL(k.url).pathname;
      if (lazyKey.get(p) === k.url) keys.set(p, k);
      else await cache.delete(k);
    }
    olds.push({ name, cache, keys });
  }
  // the dedupe sweep (§13 R3-2): one verified copy per path, the current cache's, else the newest old one's
  for (const p of lazyPaths) {
    let has = (await cur.match(lazyKey.get(p))) && (await entryVerified(cur, lazyKey.get(p), p));
    for (const o of olds) {
      if (!o.keys.has(p)) continue;
      if (!has && (await entryVerified(o.cache, lazyKey.get(p), p))) has = true;
      else (await o.cache.delete(lazyKey.get(p)), o.keys.delete(p));
    }
  }
  // each move (§14 S2): intent, put through the limiter, read back and check, commit, delete the source, clear
  let carried = 0;
  for (const o of olds) for (const [p, k] of o.keys) {
    const key = lazyKey.get(p), m = { path: p, key, from: o.name, to: CACHE, build: VERSION, state: "copying" };
    if ((await free()) < wanted.get(p).size) return recPut("migration", { carried, paused: "quota" });
    // (a newer build activated: its pass takes over, from the intent this one leaves)
    if ((await recGet("active")) !== VERSION) return;
    await recPut("moving", m);
    const hit = await o.cache.match(k), release = await reserve(INGEST, false);
    const body = hit?.status === 200 && !hit.redirected && stored(p, hit.body);
    const put = body && (await cur.put(key, body).then(() => true, () => false));
    release();
    if (put && (await entryVerified(cur, key, p))) {
      await recPut("moving", { ...m, state: "committed" });
      await o.cache.delete(k);
      offlineVerified.add(p);
      carried++;
    } else {
      // (the destination deleted, the source kept, unless it is itself bad)
      await cur.delete(key);
      await entryVerified(o.cache, key, p);
    }
    await recPut("moving", undefined);
  }
  const left = [];
  for (const o of olds) (await o.cache.keys()).length ? left.push(o.name) : await caches.delete(o.name);
  await setSources(left);
  await recPut("migration", { carried, missing: lazyPaths.filter((p) => !offlineVerified.has(p)).length });
}

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    // (no copying here, §7: the older build caches become sources, newest first; the walk is queued)
    const older = (await caches.keys()).filter((k) => k.startsWith("sagebrush-") && k !== CACHE).reverse();
    const prev = await offlineSources();
    await setSources([...older.filter((k) => !prev.includes(k)), ...prev]).catch(() => {});
    await recPut("active", VERSION).catch(() => {});
    await self.clients.claim();
    offlineSerial(() => carryOver().then(keepUp)).catch(() => {});
  })());
});
// (a restart of the activated build, §14 S2: the stopped move reconciled first, then the pass resumed; never while
// a newer build only installs)
offlineSerial(async () => {
  if ((await recGet("active")) === VERSION && ((await recGet("moving")) || (await offlineSources()).length)) await carryOver();
}).catch(() => {});

// "keep everything downloaded" (§8, SIZE-9): the ids consented, never a new one, within 1.25x the consented totals
async function keepUp() {
  const keep = await recGet("keep");
  if (!keep || !navigator.onLine || navigator.connection?.saveData) return;
  const items = (await inventory()).items.filter((it) => keep.items.includes(it.id) && !keep.removed.includes(it.id));
  const need = { stored: 0, transfer: 0 };
  for (const it of items) (need.stored += it.stored), (need.transfer += it.transfer);
  const over = need.stored > 1.25 * keep.consent.stored || need.transfer > 1.25 * keep.consent.transfer;
  await recPut("keep", { ...keep, paused: over ? "consent" : undefined, need: over ? need : undefined });
  if (!over) await startFetch(items.map((it) => it.id), null, true);
}

// the API (§4, §9): a closed grammar, this build only, from a same-origin window client, answered on its port
const FIELDS = { status: [], fetch: ["items"], cancel: ["job"], remove: ["items"], pkgClear: [], keep: ["mode", "items"] };
async function ids(items, all) {
  const inv = await inventory(), known = new Set(inv.items.map((it) => it.id));
  if (items === "all" && all) return [...known];
  if (!Array.isArray(items) || items.length > 64 || !items.every((id) => known.has(id))) throw new Failed("refused");
  return [...new Set(items)];
}
// this build's LAZY files in its cache, by exact key (§14 S1), at most 1,200 keys looked at
const present = async () => (await (await caches.open(CACHE)).keys()).slice(0, 1200).map((k) => k.url).filter((u) => lazyKey.get(new URL(u).pathname) === u).map((u) => new URL(u).pathname.slice(scope.pathname.length));
async function status() {
  const keep = await recGet("keep"), inv = await inventory().catch(() => null), est = (await navigator.storage?.estimate?.()) ?? {};
  const now = Date.now(), rel = (p) => p.slice(scope.pathname.length);
  return {
    build: VERSION, supported: await byob(), present: await present(), verified: [...offlineVerified].map(rel),
    ...(catalogOk ? {} : { error: "catalog-cap" }),
    ...(job && { job: { id: job.id, items: [...job.items], filesTotal: job.filesTotal, filesDone: job.filesDone, bytesTotal: job.bytesTotal, bytesDone: job.bytesDone, failed: job.failed } }),
    ...((await recGet("migration")) && { migration: await recGet("migration") }),
    ...(keep && { keep: { mode: keep.mode, removed: keep.removed, paused: keep.paused, need: keep.need, new: inv?.items.map((it) => it.id).filter((id) => !keep.items.includes(id)) ?? [] } }),
    quota: { usage: est.usage ?? null, quota: est.quota ?? null }, persisted: (await navigator.storage?.persisted?.()) ?? false,
    pkg: await ledgerTx((s, rows) => ({ entries: rows.length, bytes: rows.reduce((t, r) => t + r.bytes, 0), pinned: rows.filter((r) => r.pin > now).length })).catch(() => null),
  };
}
const handlers = {
  status,
  async fetch(m, port) {
    const list = await ids(m.items, true), keep = await recGet("keep");
    // (a user's own download takes the items out of `removed`, §8)
    if (keep) await recPut("keep", { ...keep, removed: keep.removed.filter((id) => !list.includes(id)) });
    return startFetch(list, port, false);
  },
  async cancel(m) {
    if (!job || job.id !== m.job) return { error: "no-job" };
    // (files in flight are aborted before their put completes: none is half-kept)
    Object.assign(job, { cancelled: true, queue: [] }).abort();
    return { cancelled: true, kept: await itemsDone([...job.items]) };
  },
  async remove(m) {
    const list = await ids(m.items, false), inv = await inventory();
    const paths = new Set(inv.items.filter((it) => list.includes(it.id)).flatMap(itemPaths));
    // (a running job drops files it hasn't reached; one in flight finishes, then is removed here, in the queue)
    if (job) (job.queue = job.queue.filter((p) => !paths.has(p))), list.forEach((id) => job.items.delete(id));
    return offlineSerial(async () => {
      const cache = await caches.open(CACHE);
      for (const p of paths) (await cache.delete(lazyKey.get(p)), offlineVerified.delete(p));
      const keep = await recGet("keep");
      if (keep) await recPut("keep", { ...keep, removed: [...new Set([...keep.removed, ...list])] });
      return { done: true, removed: list };
    });
  },
  // (astra B8-S4: every unpinned optional package entry, through the package cache's own queue and states)
  pkgClear: () => pkgSerial(async () => {
    const cache = await caches.open(PKG_CACHE), now = Date.now();
    await pkgReconcile(cache);
    const drop = await ledgerTx((s, rows) => rows.filter((r) => r.state === "kept" && !(r.pin > now)).map((r) => (s.put({ ...r, state: "deleting" }), r)));
    await pkgReconcile(cache);
    return { removed: { entries: drop.length, bytes: drop.reduce((t, r) => t + r.bytes, 0) }, keptPinned: await ledgerTx((s, rows) => rows.length) };
  }),
  async keep(m) {
    if (m.mode === "off") return (await recPut("keep", undefined), { ok: true });
    if (m.mode !== "all" && m.mode !== "items") throw new Failed("refused");
    // (SIZE-9: the item ids at opt-in, "all" resolved now, and their totals)
    const list = await ids(m.mode === "all" ? "all" : m.items, true), items = (await inventory()).items.filter((it) => list.includes(it.id));
    await recPut("keep", { mode: m.mode, items: list, removed: [], consent: { build: VERSION, stored: items.reduce((t, it) => t + it.stored, 0), transfer: items.reduce((t, it) => t + it.transfer, 0) } });
    return { ok: true };
  },
};
self.addEventListener("message", (ev) => {
  const m = ev.data, port = ev.ports?.[0], extra = FIELDS[m?.offline];
  if (typeof m?.offline !== "string" || !port) return;
  let ok = false;
  try { ok = ev.origin === scope.origin && ev.source?.type === "window" && new URL(ev.source.url).origin === scope.origin; } catch {}
  const keys = Object.keys(m), allowed = ["offline", "build", ...(extra ?? [])];
  ok &&= !!extra && keys.every((k) => allowed.includes(k)) && allowed.every((k) => k in m || (m.offline === "keep" && k === "items"));
  if (!ok) return post(port, { error: "refused" });
  if (m.build !== VERSION) return post(port, { error: "stale-build", build: VERSION });
  ev.waitUntil(handlers[m.offline](m, port).then((r) => r && post(port, r), (e) => post(port, { error: e instanceof Failed ? e.message : "failed" })));
});
// <offline-test>
// (the test build only, cut out of the shipped file by web/build.ts: the counters, the time scale, a stubbed estimate,
// the probe forced false, the order reservations are granted in, and a stop point: the first cache put or delete of
// a matching key (in a named cache) waits, before or after it, until resumed, so the test can stop the worker right there)
let stopAt = null, resume = null;
const instance = Math.random().toString(36).slice(2, 8), started = Date.now(), saw = [];
for (const e of ["install", "activate"]) self.addEventListener(e, () => saw.push(e + "@" + Date.now()));
// (skipping: the keys whose mark hasn't run out; sw.js drops a mark only when the key is next read, so an expired one
// can stay in the map: CI run 41627015378, a three-at-once phase's read-back marked the key with nobody reading it after)
let putting = 0, serialBusy = 0;
// (the offline queue's pending tasks, e.g. a put's read-back (fetchAndKeep, offlineKeep): wrapped here, counted)
const offlineSerial0 = offlineSerial;
offlineSerial = (f) => {
  serialBusy++;
  const p = offlineSerial0(f);
  p.finally(() => serialBusy--).catch(() => {});
  return p;
};
const holds = [], grants = [], deletes = [], reserve0 = reserve, cacheNames = new WeakMap(), open = caches.open.bind(caches);
reserve = (n, serve) => reserve0(n, serve).then((release) => (grants.push(serve ? "serve" : "bg"), release));
caches.open = async (name) => { const c = await open(name); cacheNames.set(c, name); return c; };
for (const op of ["put", "delete"]) {
  const f = Cache.prototype[op];
  Cache.prototype[op] = async function (k, ...a) {
    // (a stop with "walk" matches only the carry-over's own move: the key its intent record names)
    const s = stopAt, hit = s?.op === op && String(k?.url ?? k).includes(s.url) && (!s.cache || s.cache === cacheNames.get(this)) && (!s.walk || (await recGet("moving"))?.key === String(k?.url ?? k));
    const halt = () => ((stopAt = null), new BroadcastChannel("sb-offline-test").postMessage({ stopped: s, key: String(k?.url ?? k), instance }), new Promise((r) => (resume = r)));
    if (hit && s.when === "before") await halt();
    putting += op === "put" ? 1 : 0;
    const r = await f.call(this, k, ...a).finally(() => (putting -= op === "put" ? 1 : 0));
    if (op === "delete" && deletes.length < 200) deletes.push(String(k?.url ?? k));
    if (hit && s.when !== "before") await halt();
    return r;
  };
}
// (a held read: the next cache hit whose URL includes `holdRead` gets a body that never gives data, once: the stall
// a kept copy's read was seen in, VM1 Nov 3)
let holdRead = null, holdKeep = false, heldReads = 0;
const match0 = Cache.prototype.match;
Cache.prototype.match = async function (k, ...a) {
  const r = await match0.call(this, k, ...a), h = holdRead;
  if (!r || !h || !String(k?.url ?? k).includes(h)) return r;
  if (!holdKeep) holdRead = null;
  heldReads++;
  return new Response(new ReadableStream({ type: "bytes", pull: () => new Promise(() => {}) }), { status: 200, headers: r.headers });
};
// (a deploy's settings, one shot, set by the test page for this build before it installs: read before install ends)
const set = (t) => {
  if (typeof t.scale === "number" && t.scale > 0) timeScale = t.scale;
  if (t.quota === null) estimateFn = () => navigator.storage?.estimate?.();
  else if (t.quota) estimateFn = async () => ({ quota: t.quota.quota, usage: t.quota.usage });
  if (t.probe === false) probed = Promise.resolve(false);
  if ("stop" in t) stopAt = t.stop;
  if ("holdRead" in t) (holdRead = t.holdRead), (holdKeep = !!t.holdKeep);
};
const boot = new Promise((done) => {
  const o = indexedDB.open("sb-offline-test", 1);
  o.onupgradeneeded = () => o.result.createObjectStore("kv");
  o.onerror = () => done();
  o.onsuccess = () => {
    const t = o.result.transaction("kv", "readwrite"), s = t.objectStore("kv");
    s.get("boot").onsuccess = (e) => e.target.result?.build === VERSION && (set(e.target.result), s.delete("boot"));
    t.oncomplete = t.onerror = () => (o.result.close(), done());
  };
});
self.addEventListener("install", (ev) => ev.waitUntil(boot));
self.addEventListener("message", (ev) => {
  const t = ev.data?.offlineTest, port = ev.ports?.[0];
  if (!t || !port || ev.origin !== scope.origin) return;
  set(t);
  if (t.resume) resume?.();
  // (budget held and released by the test itself, outside the grant log)
  if (t.hold) reserve0(t.hold, true).then((r) => holds.push(r), () => {});
  if (t.release) holds.splice(0).forEach((r) => r());
  port.postMessage({ budgetPeak, budgetUsed, inflightPeak, keysLooked, waiting: waiters.length, grants, version: VERSION, sources: sources ?? null, instance, started, saw, paused: !!resume, stopArmed: !!stopAt, heldReads, checking: checking.size, marks: skipRead.size, skipping: [...skipRead.values()].filter((t) => Date.now() < t).length, putting, serialBusy, deletes });
  if (t.reset) (budgetPeak = budgetUsed), (inflightPeak = 0), (keysLooked = 0), (grants.length = 0);
});
// </offline-test>
