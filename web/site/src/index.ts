import { env } from "cloudflare:workers";
import { handleAtlas } from "../../atlas/server.ts";

// Static assets are served before this runs.  The atlas's pages are
// rendered here from its static data (web/atlas); anything else is a 404 page.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/atlas" || url.pathname.startsWith("/atlas/")) {
      const r = await handleAtlas(request, (path) => env.ASSETS.fetch(new URL(path, url)));
      if (r) return r;
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler;
