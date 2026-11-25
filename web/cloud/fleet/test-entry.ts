// The Worker that web/cloud/fleet/test-fleet.mjs runs in Miniflare: the fleet routes on any host.
import { handleFleet, type FleetEnv } from "./server.ts";

export default {
  async fetch(req: Request, env: FleetEnv) {
    return (await handleFleet(req, env)) ?? new Response("not the fleet API", { status: 404 });
  },
};
