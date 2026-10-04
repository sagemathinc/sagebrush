import { env } from "cloudflare:workers";

// Static assets are served before this runs; anything else is a 404 page.
export default {
  fetch(request) {
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler;
