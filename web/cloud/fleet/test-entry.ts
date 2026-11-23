// The Worker that web/cloud/fleet/test-fleet.mjs runs in Miniflare: the shared entry (src/index.ts) with a fake
// FleetFacts the test sets, in place of the fleet service that doesn't exist yet.  Tests only:
// - POST /__test/facts: the fleet the fake answers for ({ fleet, account, genesis: the device chain's genesis entry,
//   base64url; hosts: [{ id, signKey, gen, revoked }]; agent: { id, host, browser, revoked, notAfterMs } | null;
//   sessions: { <cookie>: { account, session, expiresMs } } }), or null for none;
// - POST /__test/facts-mode?m=flip|throw|odd|ok: flip answers another owner on every second read, throw fails each
//   read, odd raises a fleet error that no refusal names;
// - POST /__test/clock?offset=<ms>: the Worker's clock, moved;
// - POST /__test/bump?kind=&id=: a recorded change (store.ts's bump, as the fleet service will call it);
// - POST /__test/clean?offset=<ms>: the cron's cleanup, at the clock moved by offset;
// - /__test/logs: this isolate's log lines since the last call (Miniflare doesn't hand console output over).
import { fleetWorker } from "./src/index.ts";
import type { FleetEnv, FleetFacts, HostFacts, Snapshot } from "./fleet.ts";
import { bump, clean, type Kind } from "./store.ts";
import { apply as applyChainEntry } from "./vendor/fleet-core/core/chain.mjs";
import { FleetError, unb64 } from "./vendor/fleet-core/core/bytes.mjs";

const lines: string[] = [];
const original = console.log.bind(console);
console.log = (...args: unknown[]) => {
  lines.push(args.map(String).join(" "));
  original(...args);
};

interface Given {
  fleet: string;
  account: string;
  aud: string;
  genesis: string;
  hosts: { id: string; signKey: string; gen: number; revoked: boolean }[];
  agent: { id: string; host: string; browser: boolean; revoked: boolean; notAfterMs: number | null } | null;
  sessions: Record<string, { account: string; session: string; expiresMs: number }>;
}
let given: Given | null = null;
let mode = "ok";
let reads = 0;
let offset = 0;

const facts: FleetFacts = {
  async snapshot(q, _now): Promise<Snapshot | null> {
    reads++;
    if (mode === "throw") throw new Error("the fleet state is unavailable");
    // (a fleet error no admit refusal names: never a signed answer)
    if (mode === "odd") throw new FleetError("idem_mismatch");
    if (!given || q.fleet !== given.fleet) return null;
    const chain = (await applyChainEntry(null, unb64(given.genesis), { aud: given.aud, fleet: given.fleet })).state;
    const hosts = new Map<string, HostFacts>(given.hosts.map((h) => [h.id, { signKey: unb64(h.signKey), gen: h.gen, revoked: h.revoked }]));
    return {
      account: mode === "flip" && reads % 2 === 0 ? `${given.account}-other` : given.account,
      chain,
      hosts,
      agent: given.agent && given.agent.id === q.agent ? { host: given.agent.host, browser: given.agent.browser, revoked: given.agent.revoked, notAfterMs: given.agent.notAfterMs } : null,
      session: q.cookie !== undefined && Object.hasOwn(given.sessions, q.cookie) ? given.sessions[q.cookie] : null,
    };
  },
};

const worker = fleetWorker({ facts, now: () => Date.now() + offset });

export default {
  async fetch(request: Request, env: FleetEnv) {
    const url = new URL(request.url);
    const p = url.searchParams;
    switch (url.pathname) {
      case "/__test/logs":
        return Response.json(lines.splice(0));
      case "/__test/facts":
        given = (await request.json()) as Given | null;
        reads = 0;
        return Response.json({ ok: true });
      case "/__test/facts-mode":
        mode = p.get("m") ?? "ok";
        reads = 0;
        return Response.json({ ok: true });
      case "/__test/clock":
        offset = Number(p.get("offset"));
        return Response.json({ ok: true });
      case "/__test/bump":
        return Response.json({ epoch: await bump(env.FLEET_RELAY_DB, p.get("kind") as Kind, p.get("id")!, Date.now() + offset) });
      case "/__test/clean":
        await clean(env.FLEET_RELAY_DB, Date.now() + Number(p.get("offset")));
        return Response.json({ ok: true });
    }
    return worker.fetch(request, env);
  },
  scheduled(controller: unknown, env: FleetEnv) {
    return worker.scheduled(controller, env);
  },
};
