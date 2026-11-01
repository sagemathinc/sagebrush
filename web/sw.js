// The service worker of sagebrush.space: the notebook works offline, and
// installs as an app.  web/build.ts fills in VERSION and SHELL.
//
// The app's own files (SHELL, kept when this script installs; LAZY, kept the
// first time they are fetched online through it: the engine, the
// documentation indexes and the Python library's chunks, which not every
// visit needs) are fetched network-first, so a deploy shows up at once, with
// the kept copy when offline; those whose URLs have a content hash (?h=, or
// a library chunk's name: lib/<group>.<kind>.<hash>.json) are cache-first.  A cached response keeps its headers, so the
// page stays cross-origin isolated offline (Stop keeps its variables).
// Everything else (the Atlas, demos, data a notebook fetches) is not cached.
//
// The cache is the origin's storage, which any script of the origin can
// write: it could put there the right bytes as a different response (a
// redirect, a page without its security headers).  So a kept copy is used
// only if it is a response this script kept (same-origin, 200, not
// redirected, from its own address) whose bytes still have the SHA-256 the
// build gave them, and it is then served as a response made here, with the
// build's status and headers (DIGESTS, from web/build.ts), never the kept
// one; else it is dropped and fetched again, or, offline, not served
// (design/security.md, SEC-8D6-1, SEC-522-1).  This script itself cannot be
// changed that way: the browser fetches it.
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const LAZY = __LAZY__;
const DIGESTS = __DIGESTS__;
const CACHE = "sagebrush-" + VERSION;

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("sagebrush-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const scope = new URL(self.registration.scope);
const shellPaths = new Set([...SHELL, ...LAZY].map((p) => new URL(p, scope).pathname));
const wanted = new Map(Object.entries(DIGESTS).map(([p, d]) => [new URL(p, scope).pathname, d]));

// a kept response as the build made it, or null
async function verified(res, pathname) {
  if (!res) return null;
  const want = wanted.get(pathname);
  if (!want || res.type !== "basic" || res.status !== 200 || res.redirected) return null;
  let u;
  try { u = new URL(res.url); } catch { return null; }
  const page = pathname === scope.pathname;
  if (u.origin !== scope.origin || !(u.pathname === pathname || (page && u.pathname === scope.pathname + "index.html"))) return null;
  const bytes = await res.clone().arrayBuffer();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if ([...h].map((b) => b.toString(16).padStart(2, "0")).join("") !== want.sha256) return null;
  // (security audit G-3b: a kept copy's replay, offline or cache-first, says nosniff as the network's response does
  // (web/_headers' /*): added here, the one place a kept response is rebuilt, not stored in every DIGESTS entry)
  return new Response(bytes, { status: 200, headers: { ...want.headers, "X-Content-Type-Options": "nosniff" } });
}

// this version's kept copy of a request, verified; a bad one is dropped
async function kept(req, pathname, opts) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, opts);
  const ok = await verified(hit, pathname);
  if (hit && !ok) await cache.delete(req, opts);
  return ok;
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
  // the page itself (with any ?open=... or #share link): the cached "./" when offline
  const page = req.mode === "navigate" && (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
  if (!page && !shellPaths.has(url.pathname)) return;
  if (url.searchParams.has("h") || /\/lib\/[\w.-]+\.[0-9a-f]{16}\.json$/.test(url.pathname)) {
    ev.respondWith((async () => (await kept(req, url.pathname)) ?? fetchAndKeep(req))());
    return;
  }
  ev.respondWith((async () => {
    try {
      return await fetchAndKeep(req, page ? new Request(new URL("./", scope)) : undefined);
    } catch (e) {
      const ok = await kept(page ? new Request(new URL("./", scope)) : req, page ? scope.pathname : url.pathname, { ignoreSearch: page });
      if (ok) return ok;
      throw e;
    }
  })());
});

// The library's chunks a page fetched before this script controlled it (a
// first visit: they went past it), told by the page (web/notebook/
// worker-kernel.js): kept now, so they are there offline.  Only a name of a
// chunk of this build (content-addressed, lib/<group>.<kind>.<hash>.json, in
// LAZY, with a digest), at most as many as there are; each fetched again (an
// HTTP cache hit, usually: a chunk never changes) and kept only if its bytes
// are the build's.  Anything else, and any failure, is ignored: this only
// fills the cache, and a chunk not kept is fetched as before when needed.
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
  ev.waitUntil((async () => {
    for (const p of paths) {
      try {
        const req = new Request(new URL(p, scope));
        if (await kept(req, p)) continue;
        const res = await fetch(req);
        if (await verified(res, p)) await (await caches.open(CACHE)).put(req, res);
      } catch {}
    }
  })());
});

async function fetchAndKeep(req, key) {
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(key ?? req, res.clone());
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
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function pkgFetch(url) {
  const res = await fetch(url.href, { redirect: "error", credentials: "same-origin", cache: "no-store" });
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
    b = await pkgFetch(url);
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
