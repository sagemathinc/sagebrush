// The fleet Worker (fleet Worker design r1.6): it mounts the fleet core's pure handlers over FLEET_DB:
//
//   POST /api/fleet/v1/host/lease    a host's lease request; 200: the execution lease (core lease-service.mjs)
//   GET  /api/fleet/v1/host/chain    a host's signed read of its fleet's device chain (core chain-service.mjs; the
//                                    chain-read note r1.2)
//   /api/fleet/v1/{fleet,chain,hosts,hosts/<id>/grants}   the person's own fleet (person.ts; the reads scope r4)
//   POST /api/fleet/v1/host/pair[/result], /api/fleet/v1/pairings/{lookup,approve}   host pairing (pairing.ts; the
//                                    pairing service note d3)
//
// The handler holds every rule; this file supplies its ctx: the Worker's clock, the body read with a cap and a
// deadline, the scheme and the source address, the D1 store (store.ts) and the lease key. It logs nothing.
import { fleetCore } from "../../workspace/fleet/install.ts";
import { bucket, chainEntries, chainPage, hostGen, hostRow, issueLease, spendRequestNonce, type D1 } from "./store.ts";
import { handlePerson, type PersonDeps } from "./person.ts";
import { handlePairing, type PairingHooks } from "./pairing.ts";
import type { ShareEnv } from "../share/server.ts";

/** ShareEnv: the person's routes read the site's own session (SHARE_DB, AUTH_PROVIDER, ...; person.ts shareSession). */
export interface FleetEnv extends ShareEnv {
  FLEET_DB?: D1;
  /** the audience: "https://sagebrush.space" or "https://dev.sagebrush.space" */
  FLEET_AUD?: string;
  /** the lease key's id and its 32-byte Ed25519 seed (base64url): a secret, never in argv, logs or a repository */
  LEASE_KEY_ID?: string;
  LEASE_KEY_SEED?: string;
}

const LEASE_ROUTE = "/api/fleet/v1/host/lease";
const CHAIN_ROUTE = "/api/fleet/v1/host/chain";

/** The body, at most `max` + 1 bytes and within `ms`: null past either bound (the handler then refuses it). */
async function readBody(req: Request, max: number, ms: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), deadline]);
      if (r === null) { void reader.cancel(); return null; }
      if (r.done) break;
      n += r.value.length;
      // (one byte past the cap is enough for the handler's limit refusal; nothing more is read)
      if (n > max) { void reader.cancel(); return new Uint8Array(max + 1); }
      chunks.push(r.value);
    }
  } finally { clearTimeout(timer); }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const bare = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Test seams (test-entry.ts only; the deployed entry passes none). */
export interface FleetHooks {
  /** runs after the handler's checks and its issue-time sample, immediately before the lease batch */
  beforeIssue?: (db: D1) => Promise<void>;
  /** the pairing routes' seams (pairing.ts) */
  pairing?: PairingHooks;
}

/**
 * The fleet routes, or null for any other path. `person` is the mounting Worker's session resolver for the person's own
 * routes (person.ts); without it they answer 503.
 */
export async function handleFleet(req: Request, env: FleetEnv, hooks: FleetHooks = {}, person?: PersonDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const mine = await handlePerson(req, url, env, fleetCore, person);
  if (mine) return mine;
  const pairing = await handlePairing(req, url, env, fleetCore, person, hooks.pairing);
  if (pairing) return pairing;
  if (url.pathname === CHAIN_ROUTE) return chainRead(req, url, env);
  if (url.pathname !== LEASE_ROUTE) return null;
  const db = env.FLEET_DB;
  if (!db || !env.FLEET_AUD || !env.LEASE_KEY_ID || !env.LEASE_KEY_SEED) return bare(503);
  const core = fleetCore();
  const body = await readBody(req, core.LEASE_BODY_MAX, 10_000);
  if (body === null) return bare(408);
  let leaseKey;
  try {
    const k = await core.keyFromSeed(core.unb64(env.LEASE_KEY_SEED, 32));
    leaseKey = { id: env.LEASE_KEY_ID, raw: k.raw, sign: (b: Uint8Array) => k.sign(b) };
  } catch { return bare(503); }
  const ctx = {
    aud: env.FLEET_AUD,
    // (the Worker's own clock, read by the handler exactly twice; never the request's at_ms)
    get now() { return Date.now(); },
    host: async (h: string) => {
      const r = await hostRow(db, h);
      return r && { fleet: r.fleet, sign_key: core.unb64(r.sign_key, 32), fingerprint: r.fingerprint, revoked: r.revoked === 1 };
    },
    chain: async (fleet: string) => {
      const entries = await chainEntries(db, fleet);
      if (entries.length === 0) return null;
      return core.replayChain(entries.map((e) => core.enc(e)), { aud: env.FLEET_AUD, fleet });
    },
    leaseKey,
    bucket: (key: string, limit: number, windowMs: number) => bucket(db, key, limit, windowMs, Date.now(), core.newId()),
    leases: {
      issue: async (d: Parameters<typeof issueLease>[1]) => {
        if (hooks.beforeIssue) await hooks.beforeIssue(db);
        return issueLease(db, d);
      },
    },
  };
  const r = await core.handleLease({
    method: req.method,
    target: url.pathname + url.search,
    scheme: url.protocol === "https:" ? "https" : url.protocol.replace(/:$/, ""),
    source: req.headers.get("cf-connecting-ip") ?? "unknown",
    body,
  }, ctx);
  return new Response(r.body.length ? r.body : null, { status: r.status, headers: r.headers });
}

/** GET /api/fleet/v1/host/chain: the core's handler over FLEET_DB, with a body cap of 0 (any body is refused). */
async function chainRead(req: Request, url: URL, env: FleetEnv): Promise<Response> {
  const db = env.FLEET_DB;
  if (!db || !env.FLEET_AUD) return bare(503);
  const core = fleetCore();
  const body = await readBody(req, 0, core.CHAIN_READ_MS);
  if (body === null) return bare(408);
  const ctx = {
    aud: env.FLEET_AUD,
    // (the Worker's own clock, read by the handler once)
    get now() { return Date.now(); },
    host: async (h: string) => {
      const r = await hostRow(db, h);
      return r && { fleet: r.fleet, sign_key: core.unb64(r.sign_key, 32), revoked: r.revoked === 1 };
    },
    currentGen: (fleet: string, host: string) => hostGen(db, fleet, host),
    bucket: (key: string, limit: number, windowMs: number) => bucket(db, key, limit, windowMs, Date.now(), core.newId()),
    nonces: { spend: (d: { fleet: string; host: string; nonce: string; now: number }) => spendRequestNonce(db, d, core.CHAIN_NONCE_KEEP_MS) },
    chain: { page: (fleet: string, after: number, max: number) => chainPage(db, fleet, after, max) },
  };
  const r = await core.handleChainRead({
    method: req.method,
    target: url.pathname + url.search,
    scheme: url.protocol === "https:" ? "https" : url.protocol.replace(/:$/, ""),
    source: req.headers.get("cf-connecting-ip") ?? "unknown",
    header: req.headers.get("sagebrush-sig"),
    body,
  }, ctx);
  return new Response(r.body.length ? r.body : null, { status: r.status, headers: r.headers });
}
