// The fleet Worker's shared entry: the relay's two control-plane calls (../fleet.ts), and nothing else; src/dev.ts
// wraps it.  The cron cleans the consumed call ids and the feed's old changes (../store.ts).
import { handleFleet, type FleetEnv, type FleetOptions } from "../fleet.ts";
import { clean } from "../store.ts";

export function fleetWorker(opts: FleetOptions) {
  return {
    async fetch(request: Request, env: FleetEnv): Promise<Response> {
      return (await handleFleet(request, env, opts)) ?? new Response("not found", { status: 404 });
    },
    async scheduled(_controller: unknown, env: FleetEnv): Promise<void> {
      await clean(env.FLEET_RELAY_DB, Date.now());
    },
  };
}
