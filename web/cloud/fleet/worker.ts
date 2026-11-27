// The fleet Worker's entry (the fleet Worker note r1.6; the reads scope r4 §2): every fleet route, with the person's
// session resolved by the site's own resolver (person.ts shareSession: the cookie, then a read of the SHARE_DB primary),
// the account it names carried into FLEET_DB by the person's routes. Nothing deploys it yet: no configuration names it,
// and no FLEET_DB is created until its gate clears.
import { handleFleet, type FleetEnv } from "./server.ts";
import { shareSession } from "./person.ts";
import type { Ctx } from "../share/server.ts";

export default {
  async fetch(req: Request, env: FleetEnv, ctx: Ctx): Promise<Response> {
    return (await handleFleet(req, env, {}, shareSession(env, ctx))) ?? new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  },
};
