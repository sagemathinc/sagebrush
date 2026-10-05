import { env } from "cloudflare:workers";
import { handleAtlas } from "../../atlas/server.ts";

// Static assets are served before this runs.  The atlas's pages are
// rendered here from its static data (web/atlas), and kept in the edge
// cache for as long as their Cache-Control allows (KaTeX makes a large
// page cost tens of milliseconds to render); anything else is a 404 page.
export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/atlas" || url.pathname.startsWith("/atlas/")) {
      const cache = caches.default;
      // JSON and HTML differ by Accept for the same URL
      const k = new URL(url);
      if (/application\/json/.test(request.headers.get("accept") ?? "")) k.searchParams.set("__accept", "json");
      const key = new Request(k.toString(), { method: "GET" });
      if (request.method === "GET") {
        const hit = await cache.match(key);
        if (hit) return hit;
      }
      const r = await handleAtlas(request, (path) => env.ASSETS.fetch(new URL(path, url)));
      if (r) {
        if (request.method === "GET" && r.status === 200 && /public/.test(r.headers.get("cache-control") ?? "")) ctx.waitUntil(cache.put(key, r.clone()));
        return r;
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler;
