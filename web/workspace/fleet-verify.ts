// What this browser verifies about an Autonomous fleet before it shows or acts on any of it (app pairing r4 §2, F7,
// F8): the device list (the chain) entry by entry, then against this browser's pin, which moves only after the whole
// chain verified; a host's certificate against that chain; and the current grant against both. All of it goes
// through the fleet core (fleet/install.ts); this module only connects it to the pin kept beside the device key
// (fleet-device.ts). It verifies and refuses, nothing else: nothing here signs, and it holds no key.
import { fleetCore } from "./fleet/install";
import { advancePin, pin as storedPin } from "./fleet-device";

/** The audience (the Sagebrush origin's id for the fleet's objects) and the fleet a page works in. */
export type FleetCtx = Readonly<{ aud: string; fleet: string }>;
/** A chain as the core verified it (opaque here; the core's own state). */
export type Chain = Awaited<ReturnType<ReturnType<typeof fleetCore>["replayChain"]>>;
/** A host certificate as the core verified it. */
export type HostCert = Awaited<ReturnType<ReturnType<typeof fleetCore>["verifyHostCert"]>>;
/** The grant a new one is checked against: its generation, its signed bytes and its body. */
export type CurrentGrant = Readonly<{ gen: number; bytes: Uint8Array; body: unknown }>;

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * The fleet's chain, verified: every entry against its predecessor's signer, then against this browser's pin. A chain
 * that doesn't contain the pinned entry (another history at the pinned seq, or a chain shorter than the pin) is a
 * fork: it is recorded, for good, and refused with chain_fork, as is every later sync of a fleet already forked here
 * (the only way out is Reset this device). Otherwise the pin moves to the chain's head and the chain is returned.
 * Bad entries refuse with the core's own reason, and the pin stays where it was.
 */
export async function syncChain(ctx: FleetCtx, entries: readonly string[]): Promise<Chain> {
  const core = fleetCore();
  const was = await storedPin(ctx.fleet);
  if (was?.forked) core.refuse("chain_fork", "this device was shown conflicting device lists");
  // (verified on its own first: a pin moves only for a chain whose every entry verified)
  const chain = await core.replayChain(entries.map(utf8), { aud: ctx.aud, fleet: ctx.fleet });
  const head = { seq: chain.seq, hash: chain.hashes[chain.seq] };
  if (was && (was.seq > chain.seq || chain.hashes[was.seq] !== was.hash)) {
    // (what fleet-device records as a fork: another hash at the pinned seq, or a head behind it)
    const seen = was.seq > chain.seq ? head : { seq: was.seq, hash: chain.hashes[was.seq] };
    await advancePin(ctx.fleet, seen).catch(() => undefined);
    core.refuse("chain_fork", was.seq > chain.seq ? "a device list behind this device's" : "a device list that conflicts with this device's");
  }
  try {
    await advancePin(ctx.fleet, head);
  } catch {
    // (another tab moved or forked the pin meanwhile: refuse rather than return a chain the pin no longer vouches for)
    core.refuse("chain_fork", "this device's pin changed while the list was checked");
  }
  return chain;
}

/** A host's certificate (sb.host-cert.v1, F7), verified against a chain from syncChain. */
export async function verifyHostCert(ctx: FleetCtx, chain: Chain, cert: string): Promise<HostCert> {
  return fleetCore().verifyHostCert(utf8(cert), { aud: ctx.aud, fleet: ctx.fleet, chain });
}

/**
 * A grant (F8), verified against the chain, the host's certificate and the grant it follows (`current`, or null for a
 * host's first): its signer, its generation, its lifetime at `now` (ms), and the device tier a widening needs.
 */
export async function verifyGrant(ctx: FleetCtx, chain: Chain, cert: HostCert, grant: string, current: CurrentGrant | null, now: number): Promise<unknown> {
  return fleetCore().verifyGrant(utf8(grant), { aud: ctx.aud, fleet: ctx.fleet, chain, cert, current: current ?? undefined, now });
}
