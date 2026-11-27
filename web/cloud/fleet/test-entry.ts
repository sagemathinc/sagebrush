// The Worker that web/cloud/fleet/test-fleet.mjs runs in Miniflare: the fleet routes on any host. A request may carry
// x-test-before-issue: the name of one change below, made after the handler's checks and immediately before the lease
// batch, so a test can move state between the handler's own reads and the batch's re-reads. The person's routes take
// their session from x-test-account / x-test-session, and its re-authentication time from x-test-reauth-ms (ms, or
// "null"; absent is null) (the deployed mount resolves the real one).
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
    // (the person's session, as the mounting Worker would resolve it: x-test-account names the account; x-test-session
    // may say "none", "unavailable" or "throw" instead)
    const person = {
      session: async (r: Request) => {
        const kind = r.headers.get("x-test-session");
        if (kind === "throw") throw new Error("the session store failed");
        if (kind === "unavailable") return { kind: "unavailable" as const };
        const account = r.headers.get("x-test-account");
        const rm = r.headers.get("x-test-reauth-ms");
        const reauthMs = rm === null || rm === "null" ? null : Number(rm);
        return kind === "none" || !account ? { kind: "none" as const } : { kind: "ok" as const, account, reauthMs };
      },
    };
    return (await handleFleet(req, env, change ? { beforeIssue: async (db) => { await change(db); } } : {}, person)) ?? new Response("not the fleet API", { status: 404 });
  },
};
