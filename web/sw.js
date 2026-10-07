// The service worker of sagebrush.space: the notebook works offline, and
// installs as an app.  web/build.ts fills in VERSION and SHELL.
//
// The app's own files (SHELL) are fetched network-first, so a deploy shows
// up at once, with the cached copy when offline; the engine, whose URL has a
// content hash, is cache-first.  A cached response keeps its headers, so the
// page stays cross-origin isolated offline (Stop keeps its variables).
// Everything else (the Atlas, demos, data a notebook fetches) is not cached.
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
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

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== scope.origin) return;
  // the page itself (with any ?open=... or #share link): the cached "./" when offline
  const page = req.mode === "navigate" && (url.pathname === scope.pathname || url.pathname === scope.pathname + "index.html");
  if (!page && !shellPaths.has(url.pathname)) return;
  if (url.pathname.endsWith(".wasm") && url.searchParams.has("h")) {
    ev.respondWith((async () => (await caches.match(req)) ?? fetchAndKeep(req))());
    return;
  }
  ev.respondWith((async () => {
    try {
      return await fetchAndKeep(req, page ? new Request(new URL("./", scope)) : undefined);
    } catch (e) {
      const hit = await caches.match(page ? new URL("./", scope).href : req, { ignoreSearch: page });
      if (hit) return hit;
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
