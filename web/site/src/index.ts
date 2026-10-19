import { env } from "cloudflare:workers";
import { handleAtlas } from "../../atlas/server.ts";
import { handleShare, scheduled, type ShareEnv } from "../../share/server.ts";
import { handleEngines, handleLibChunk, type EnginesEnv } from "../../engines.ts";
import { syncScheduled, type Env as SyncSiteEnv } from "../../sync/server.ts";
import { BUILD } from "./build-id.ts";

// Static assets are served before this runs.  The atlas's pages are
// rendered here from its static data (web/atlas), and kept in the edge
// cache for as long as their Cache-Control allows (KaTeX makes a large
// page cost tens of milliseconds to render), under a key with the build's
// id (web/build.ts writes it), so that a deploy is seen at once.  The share
// API (/auth/, /api/share/, /api/admin/) is web/share/server.ts, on where
// its bindings are (the dev site for now).  Anything else is a 404 page.
export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const shared = await handleShare(request, env as ShareEnv, ctx);
    if (shared) return shared;
    // engines by their content, from R2 (web/engines.ts)
    const engine = await handleEngines(request, env as EnginesEnv, ctx);
    if (engine) return engine;
    // a library chunk of an earlier build, which a deploy took out of lib/,
    // from R2 (web/engines.ts)
    const chunk = await handleLibChunk(request, env as EnginesEnv, ctx);
    if (chunk) return chunk;
    // a shared collection's page (web/share/view.html, at /s/)
    if (/^\/s\/[a-z2-7]{12}(@[0-9a-f]{8,64})?\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL("/s/", url), request));
    if (url.pathname === "/atlas" || url.pathname.startsWith("/atlas/")) {
      const cache = caches.default;
      // JSON and HTML differ by Accept for the same URL
      const k = new URL(url);
      k.searchParams.set("__build", BUILD);
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
  // The daily jobs: sharing's, then sync's inventory and receipt prune (design/sync-server.md §9),
  // each on its own, so one failing never stops the other.  Sync's returns at once where its
  // bindings aren't (the flag, §11), so this changes nothing until sync is bound.
  async scheduled() {
    const jobs = await Promise.allSettled([scheduled(env as ShareEnv), syncScheduled(env as unknown as SyncSiteEnv)]);
    // (a failure still fails the run, as Cloudflare's cron status should show, once both have run)
    const failed = jobs.filter((j): j is PromiseRejectedResult => j.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map((j) => j.reason), "a scheduled job failed");
  },
} satisfies ExportedHandler;
