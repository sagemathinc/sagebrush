// The service worker of sagebrush.space: the notebook works offline, and
// installs as an app.  web/build.ts fills in VERSION and SHELL.
//
// The app's own files (SHELL) are fetched network-first, so a deploy shows
// up at once, with the cached copy when offline; the engine and the
// precompiled library, whose URLs have a content hash, are cache-first.  A cached response keeps its headers, so the
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
const shellPaths = new Set(SHELL.map((p) => new URL(p, scope).pathname));
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
  return new Response(bytes, { status: 200, headers: want.headers });
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
  // the page itself (with any ?open=... or #share link): the cached "./" when offline
  const page = req.mode === "navigate" && (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
  if (!page && !shellPaths.has(url.pathname)) return;
  if (url.searchParams.has("h")) {
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

async function fetchAndKeep(req, key) {
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(key ?? req, res.clone());
  }
  return res;
}
