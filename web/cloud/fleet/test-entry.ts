// The Worker that web/cloud/fleet/test-fleet.mjs runs in Miniflare: the fleet routes on any host. A request may carry
// x-test-before-issue: the name of one change below, made after the handler's checks and immediately before the lease
// batch, so a test can move state between the handler's own reads and the batch's re-reads. The person's routes take
// their session from x-test-account / x-test-session (the deployed mount resolves the real one).
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
        return kind === "none" || !account ? { kind: "none" as const } : { kind: "ok" as const, account };
      },
    };
    // (the pairing routes' seams: x-test-now moves the Worker's clock; x-test-pairing-total lowers the live total;
    // x-test-pairing names a holder that dies after its claim or after pairing, or waits before claiming)
    const clock = r(req, "x-test-now"), total = r(req, "x-test-pairing-total"), seam = req.headers.get("x-test-pairing");
    // (x-test-advance-before-claim: <ms> moves this request's clock forward between an approve's checks and its claim)
    const advance = r(req, "x-test-advance-before-claim");
    let at = clock;
    const die = () => { throw new Error("the holder died (test seam)"); };
    const pairing = {
      ...(clock !== null ? { now: () => at! } : {}),
      ...(total !== null ? { liveTotal: total } : {}),
      ...(seam === "die-after-claim" ? { afterClaim: async () => die() } : {}),
      ...(seam === "die-after-pair" ? { afterPair: async () => die() } : {}),
      ...(seam?.startsWith("wait-before-claim:") ? { beforeClaim: () => new Promise<void>((res) => setTimeout(res, Number(seam.slice(18)))) } : {}),
      ...(advance !== null && clock !== null ? { beforeClaim: async () => { at = clock + advance; } } : {}),
      ...(seam?.startsWith("wait-after-claim:") ? { afterClaim: () => new Promise<void>((res) => setTimeout(res, Number(seam.slice(17)))) } : {}),
    };
    return (await handleFleet(req, env, { ...(change ? { beforeIssue: async (db) => { await change(db); } } : {}), pairing }, person)) ?? new Response("not the fleet API", { status: 404 });
  },
};

/** A header's safe integer, or null. */
function r(req: Request, name: string): number | null {
  const v = req.headers.get(name);
  return v !== null && /^[0-9]{1,16}$/.test(v) ? Number(v) : null;
}
