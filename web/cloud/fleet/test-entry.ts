// The Worker that web/cloud/fleet/test-fleet.mjs runs in Miniflare: the fleet routes on any host. A request may carry
// x-test-before-issue: the name of one change below, made after the handler's checks and immediately before the lease
// batch, so a test can move state between the handler's own reads and the batch's re-reads.
import { handleFleet, type FleetEnv } from "./server.ts";
import type { D1 } from "./store.ts";

const CHANGES: Record<string, (db: D1) => Promise<unknown>> = {
  "host-fleet": (db) => db.prepare("UPDATE fleet_hosts SET fleet = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'").run(),
  "host-revoked": (db) => db.prepare("UPDATE fleet_hosts SET revoked = 1").run(),
  "host-repaired": (db) => db.prepare("UPDATE fleet_hosts SET fingerprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'").run(),
  "agent-gone": (db) => db.prepare("DELETE FROM fleet_agents").run(),
  "agent-moved": (db) => db.prepare("UPDATE fleet_agents SET host = 'bbbbbbbbbbbbbbbbbbbbbbbbbe'").run(),
};

export default {
  async fetch(req: Request, env: FleetEnv) {
    const name = req.headers.get("x-test-before-issue");
    const change = name ? CHANGES[name] : undefined;
    if (name && !change) return new Response("no such change", { status: 400 });
    return (await handleFleet(req, env, change ? { beforeIssue: async (db) => { await change(db); } } : {})) ?? new Response("not the fleet API", { status: 404 });
  },
};
