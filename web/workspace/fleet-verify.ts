// What this browser verifies about an Autonomous fleet before it shows or acts on any of it (app pairing r4 §2, F7,
// F8): the device list (the chain) entry by entry, then against this browser's pin, which moves only after the whole
// chain verified; a host's certificate against that chain; and the current grant against both. All of it goes
// through the fleet core (fleet/install.ts); this module only connects it to the pin kept beside the device key
// (fleet-device.ts). It verifies and refuses, nothing else: nothing here signs, and it holds no key.
import { fleetCore } from "./fleet/install";
import { advancePin, advancePinOnChain, pin as storedPin } from "./fleet-device";

/** The audience (the Sagebrush origin's id for the fleet's objects) and the fleet a page works in. */
export type FleetCtx = Readonly<{ aud: string; fleet: string }>;
/** A chain as the core verified it (opaque here; the core's own state). */
export type Chain = Awaited<ReturnType<ReturnType<typeof fleetCore>["replayChain"]>>;
/** A host certificate as the core verified it. */
export type HostCert = Awaited<ReturnType<ReturnType<typeof fleetCore>["verifyHostCert"]>>;
/** The grant a new one is checked against: its generation, its signed bytes and its body. */
export type CurrentGrant = Readonly<{ gen: number; bytes: Uint8Array; body: unknown }>;

const utf8 = (s: string) => new TextEncoder().encode(s);
// (advancePin's own refusal of a fork; it throws it only after its fork mark is committed)
const isFork = (e: unknown) => e instanceof Error && e.message === "chain_fork";
/** This browser couldn't record what it saw (IndexedDB refused or lost the write): never reported as a fork. */
export class StorageFailed extends Error {
  readonly code = "storage_failed";
  constructor(cause?: unknown) { super("storage_failed", { cause }); }
}

/** Another tab pinned a later entry while this chain was checked: fetch the chain again and sync that (not a fork). */
export class PinMoved extends Error {
  readonly code = "pin_moved";
  constructor() { super("pin_moved"); }
}

/** A fork is claimed only once it is durable: the stored pin, read back, says forked. */
async function forkRecorded(fleet: string, cause?: unknown): Promise<void> {
  if (!(await storedPin(fleet))?.forked) throw new StorageFailed(cause);
}

/**
 * The fleet's chain, verified: every entry against its predecessor's signer, then against this browser's pin. A chain
 * that doesn't contain the pinned entry (another history at the pinned seq, or a chain shorter than the pin) is a
 * fork: it is recorded, for good, and refused with chain_fork, as is every later sync of a fleet already forked here
 * (the only way out is Reset this device). Otherwise the pin moves to the chain's head, by a compare-and-set that
 * requires the stored pin to still be one of this chain's entries, and the chain is returned. If another tab pinned
 * another branch meanwhile, that is a fork too; if it pinned a later entry, the sync fails with PinMoved (pin_moved):
 * fetch the chain again.
 * Bad entries refuse with the core's own reason, and the pin stays where it was. When this browser can't store the
 * pin or the fork mark, the sync fails with StorageFailed (storage_failed), never with a fork it didn't record.
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
    let cause: unknown;
    // (the conflicting entry's exact text recorded with the fork, beside the pinned one: r4 §2's evidence)
    try { await advancePin(ctx.fleet, seen, entries[seen.seq] ?? null); } catch (e) { if (!isFork(e)) throw new StorageFailed(e); cause = e; }
    await forkRecorded(ctx.fleet, cause);
    core.refuse("chain_fork", was.seq > chain.seq ? "a device list behind this device's" : "a device list that conflicts with this device's");
  }
  // (a compare-and-set in the pin's own transaction: the pin moves only from one of this chain's entries, so another
  //  tab that pinned another branch meanwhile is a fork, and one that pinned further is a sync to redo, never a reason
  //  to return this shorter chain)
  let moved: "moved" | "same" | "behind";
  try {
    moved = await advancePinOnChain(ctx.fleet, chain.hashes, head, entries);
  } catch (e) {
    if (!isFork(e)) throw new StorageFailed(e);
    await forkRecorded(ctx.fleet, e);
    core.refuse("chain_fork", "this device's pin changed while the list was checked");
  }
  if (moved === "behind") throw new PinMoved();
  // (and the chain is returned only once its head is durably pinned: read back, at the head or past it, since another
  //  tab may since have moved it further, through its own compare-and-set from this head)
  const now = await storedPin(ctx.fleet);
  if (now?.forked) core.refuse("chain_fork", "this device's pin changed while the list was checked");
  if (!now || now.seq < head.seq || (now.seq === head.seq && now.hash !== head.hash)) throw new StorageFailed();
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

/**
 * A host's acknowledgement of a grant (sb.grant-ack.v1, §3.3), verified against the host's certificate: signed by that
 * host, about that host, and not ahead of `currentGen`, the generation of the grant this page holds for it.
 */
export async function verifyGrantAck(ctx: FleetCtx, cert: HostCert, ack: string, currentGen: number): Promise<unknown> {
  return fleetCore().verifyGrantAck(utf8(ack), { aud: ctx.aud, fleet: ctx.fleet, cert, currentGen });
}

/**
 * What a person compares for a host (§3.1): the first 100 bits of its fingerprint, recomputed from the verified
 * certificate's keys (never taken from the object), as 20 base32 characters in groups of 4.
 */
export async function hostFingerprintShown(cert: HostCert): Promise<string> {
  const core = fleetCore();
  return core.showFingerprint(await core.hostFingerprint(cert.body.host, cert.signRaw, cert.encRaw));
}

/**
 * A host's revocation (sb.revocation.v1, §2.3), verified against the chain: signed by a device of the fleet (one since
 * removed still counts: obeying a revocation only narrows), and about this very host. The verified body, or a refusal.
 */
export async function verifyHostRevocation(ctx: FleetCtx, chain: Chain, host: string, revocation: string): Promise<unknown> {
  const core = fleetCore();
  const b = (await core.verifyRevocation(utf8(revocation), { aud: ctx.aud, fleet: ctx.fleet, chain })) as { what?: unknown; id?: unknown };
  if (b.what !== "host" || b.id !== host) core.refuse("bad_form", "a revocation of something else");
  return b;
}

/**
 * One page of the device chain as the service serves it ({ entries, head }, canonical, bounded), read by the core's own
 * reader for a request with `after` (-1: from genesis): each entry's text, the head, and the `after` of the next page.
 * The entries are still unverified: syncChain verifies them, all together, against this browser's pin.
 */
export function readChainPage(bytes: Uint8Array, after: number): { entries: string[]; head: number; next: number } {
  const p = fleetCore().parseChainPage(bytes, after);
  const dec = new TextDecoder("utf-8", { fatal: true });
  return { entries: p.entries.map((e: Uint8Array) => dec.decode(e)), head: p.head, next: p.next };
}

/**
 * What the person types into a host being paired (`sagebrush-agent host pair --fleet`, F7): this fleet's fingerprint,
 * from this device's OWN verified chain, never from the service. `genesis` is the chain's seq-0 entry as synced; it is
 * replayed on its own and must give the very entry the verified chain starts with, or it is refused. The core's one
 * definition (fleetFingerprint over the entry's exact bytes), shown as 20 base32 characters in groups of 4.
 */
export async function fleetFingerprintShown(ctx: FleetCtx, chain: Chain, genesis: string): Promise<string> {
  const core = fleetCore();
  const g = utf8(genesis);
  const alone = await core.replayChain([g], { aud: ctx.aud, fleet: ctx.fleet });
  if (alone.hashes[0] !== chain.hashes[0]) core.refuse("bad_form", "not this chain's genesis");
  return core.showFingerprint(await core.fleetFingerprint(ctx.fleet, g));
}
