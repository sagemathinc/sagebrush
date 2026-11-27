// The only place this page signs fleet objects (M4: browser F1, the r4 signing barrier, later F7 and agent messages;
// its SEC note r8). Everything signed here goes through one barrier (app pairing r4 §3):
//   1. a review: the exact objects to sign, frozen as their canonical bytes, plus the inputs they were reviewed against;
//   2. at the person's click, every input read again and compared, and every refusal checked again; any difference
//      and nothing is signed (the screen says "This changed since you looked. Review it again.");
//   3. one signature per review, of exactly the captured bytes: the device key is reached only through a grant this
//      module mints for those bytes (fleet-device.ts signingMinter, taken once, here, as the module loads).
// A review's public objects go to the journal before the key is touched, so a lost answer or a reload reads the
// receipt first and never signs a second object for the same review. Nothing here reads, keeps or logs a key, a
// recovery code or a seed beyond the F1 screen's own review (and the code only while that review is open).
import { fleetCore } from "./fleet/install";
import { deviceKey, ed25519Available, journalDelete, journalList, journalPut, makeDeviceKey, pin, resetDevice, signAsDevice, signingMinter, type JournalEntry, type SignGrant } from "./fleet-device";
import { syncChain, type FleetCtx } from "./fleet-verify";

// (taken now: if anything took the minter first, this module refuses to load, and so nothing can sign on this page)
const mint: (fleet: string, bytes: Uint8Array) => SignGrant = signingMinter();

/** The service this barrier talks to (the page's fetches, or a test's stand-in). */
export interface SignService {
  /** the audience this page's objects name (its own origin's: AUDIENCES) */
  readonly aud: string;
  /** GET /api/fleet/v1/session: null when there's no session (401) */
  session(): Promise<{ account: string; reauth_ms: number | null; now_ms: number; fresh_ms: number } | null>;
  /** GET /api/fleet/v1/fleet: the account's fleet, or null (no_fleet) */
  fleet(): Promise<{ fleet: string; aud: string } | null>;
  /** GET /api/fleet/v1/chain, every page: the entries' exact texts ([] with no fleet) */
  chain(): Promise<string[]>;
  /** POST /api/fleet/v1/chain: the entry's exact text; its seq, or the service's refusal code */
  append(entry: string): Promise<{ seq: number } | { refused: string }>;
}

/** Why nothing was signed: a code the screen says in its own words. */
export class SignRefused extends Error {
  constructor(readonly code: SignCode) { super(code); }
}
export type SignCode =
  | "unsupported" | "no_session" | "reauth_needed" | "has_fleet" | "journal_open" | "changed" | "closed" | "signed_already"
  | "not_confirmed" | "forked" | "not_enrolled" | "storage_failed" | "unavailable" | "submit_lost" | "refused";

/** The sign-in may be at most this old when a signature is made (the service allows 5 min: a click near the edge
 *  re-authenticates instead of signing something the service would refuse; note D4). */
export const SIGN_FRESH_MS = 270_000;
/** F1 starts only with at least this much of the sign-in's freshness left, so its recovery code never has to cross a
 *  re-auth redirect (note §6): with less, the person confirms first. */
export const F1_START_LEFT_MS = 180_000;

const enc = new TextEncoder(), dec = new TextDecoder();
/** A code's groups as showCode shows them: fours, the last one shorter. */
const groupsOf = (code: string) => code.match(/.{1,4}/g) ?? [];
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const newReviewId = () => fleetCore().newId();
/** The sign-in's age now, on this page's clock offset by the service's now_ms (read just now). */
const ageOf = (s: { reauth_ms: number | null; now_ms: number }, readAt: number) => (s.reauth_ms === null ? Infinity : s.now_ms + (Date.now() - readAt) - s.reauth_ms);
async function freshSession(svc: SignService, maxAge: number) {
  const readAt = Date.now();
  const s = await svc.session().catch(() => { throw new SignRefused("unavailable"); });
  if (!s) throw new SignRefused("no_session");
  if (s.reauth_ms === null || !Number.isSafeInteger(s.reauth_ms) || !(ageOf(s, readAt) <= maxAge)) throw new SignRefused("reauth_needed");
  return s;
}

// ---- a review's life: open until signed, cancelled or its screen closes (the generation token)

/** A review open on a screen. `alive` turns false for good on close(): every pending signOnce then stops, with no
 *  signature, at its next step. */
abstract class Review {
  readonly id = newReviewId();
  private open = true;
  private signedOnce = false;
  get alive() { return this.open; }
  close() { this.open = false; }
  protected check() { if (!this.open) throw new SignRefused("closed"); }
  /** Set before the first key use: a second signOnce throws, whatever the first's outcome. */
  protected claim() {
    if (this.signedOnce) throw new SignRefused("signed_already");
    this.signedOnce = true;
  }
}

// ---- F1: a new fleet, this browser its first device (r4 §3 F1; note §4)

export type GenesisResult = { fleet: string; seq: 0 };

/**
 * F1's review. `code` is the recovery code as shown (groups of four), for the screen's one display element only; the
 * screen calls close() when it closes by any route, which drops it. Nothing is signed until confirm() has passed and
 * the person clicks: signOnce().
 */
export class GenesisReview extends Review {
  #code: string | null;
  #confirmed = false;
  /** the two group positions (0-based) the person types back to confirm */
  readonly ask: readonly [number, number];
  constructor(
    readonly fleet: string,
    code: string,
    private readonly snap: Readonly<{ aud: string; reauth_ms: number; publicRaw: Uint8Array; text: string; captured: Uint8Array; signer: unknown; body: unknown }>,
  ) {
    super();
    this.#code = code;
    // (the groups as shown: showCode's, fours with a shorter last one)
    const groups = groupsOf(code).length;
    const a = Math.floor(Math.random() * groups);
    let b = Math.floor(Math.random() * (groups - 1));
    if (b >= a) b++;
    this.ask = a < b ? [a, b] : [b, a];
  }
  /** The code as shown, or "" once the review is closed. */
  get code(): string { return this.alive && this.#code ? fleetCore().showCode(this.#code) : ""; }
  override close() {
    super.close();
    this.#code = null;
  }
  /** The person's confirmation: the two asked groups, typed. A failed one keeps the code (r4's ruling) and signs
   *  nothing; true once both match. */
  confirm(typed: [string, string]): boolean {
    this.check();
    const groups = groupsOf(this.#code ?? "");
    const norm = (t: string) => String(t).replace(/[\s-]/g, "").toLowerCase();
    this.#confirmed = norm(typed[0]) === groups[this.ask[0]] && norm(typed[1]) === groups[this.ask[1]];
    return this.#confirmed;
  }
  /** Sign and submit the genesis: the bootstrap barrier (note §4), then exactly one signature. */
  async signOnce(svc: SignService): Promise<GenesisResult> {
    this.check();
    if (!this.#confirmed) throw new SignRefused("not_confirmed");
    this.claim();
    // (the barrier: every review input again, at the click)
    await freshSession(svc, SIGN_FRESH_MS).then((s) => { if (s.reauth_ms !== this.snap.reauth_ms) throw new SignRefused("changed"); });
    this.check();
    if ((await svc.fleet().catch(() => { throw new SignRefused("unavailable"); })) !== null) throw new SignRefused("has_fleet");
    this.check();
    const k = await deviceKey(this.fleet).catch(() => { throw new SignRefused("storage_failed"); });
    if (!k || !sameBytes(k.publicRaw, this.snap.publicRaw)) throw new SignRefused("changed");
    const p = await pin(this.fleet).catch(() => { throw new SignRefused("storage_failed"); });
    if (p) throw new SignRefused(p.forked ? "forked" : "changed");
    // (the bytes rebuilt from the snapshot's inputs: the frozen capture must be exactly them)
    const core = fleetCore();
    if (!sameBytes(core.signedBytes("sb.device-chain.v1", this.snap.signer, this.snap.body), this.snap.captured)) throw new SignRefused("changed");
    this.check();
    // (the journal first: a pending entry, before the key is touched)
    const entry: JournalEntry = { id: this.id, fleet: this.fleet, flow: "genesis", state: "pending", captured: [this.snap.text], envelopes: [], at: Date.now() };
    await journalPut(entry).catch(() => { throw new SignRefused("storage_failed"); });
    this.check();
    const grant = mint(this.fleet, this.snap.captured);
    const env = await core.seal("sb.device-chain.v1", this.snap.signer, this.snap.body, { sign: (b: Uint8Array) => signAsDevice(grant, this.fleet, b) });
    const text = dec.decode(env);
    await journalPut({ ...entry, state: "signed", envelopes: [text] }).catch(() => { throw new SignRefused("storage_failed"); });
    // (once signed, the screen closing doesn't stop the submit: the signed entry is sent, or found by its receipt)
    await journalPut({ ...entry, state: "submitted", envelopes: [text] }).catch(() => { throw new SignRefused("storage_failed"); });
    return submitGenesis(svc, entry.id, this.fleet, text);
  }
}

/** Submit a signed genesis, then read its receipt: the chain's entry 0 byte-equal to it. */
async function submitGenesis(svc: SignService, id: string, fleet: string, text: string): Promise<GenesisResult> {
  inFlight.add(id);
  let r: { seq: number } | { refused: string };
  try {
    r = await svc.append(text);
  } catch {
    inFlight.delete(id);
    // (the answer lost: the receipt first. Landed, it's adopted; not, the entry stays submitted, to be resubmitted as
    //  the same bytes by settleGenesis, never signed again)
    if (await genesisLanded(svc, fleet, text).catch(() => false)) {
      await journalDelete(id).catch(() => {});
      return { fleet, seq: 0 };
    }
    throw new SignRefused("submit_lost");
  }
  inFlight.delete(id);
  if ("refused" in r && r.refused !== "exists") {
    // (stale_auth and the rest: those bytes can never land; the entry is dropped once the receipt shows nothing did)
    if (!(await genesisLanded(svc, fleet, text))) {
      await journalDelete(id).catch(() => {});
      throw new SignRefused(r.refused === "stale_auth" ? "reauth_needed" : "refused");
    }
  }
  if (!(await genesisLanded(svc, fleet, text))) throw new SignRefused("submit_lost");
  await journalDelete(id).catch(() => {});
  return { fleet, seq: 0 };
}
/** Whether the account's fleet is `fleet` and its chain's entry 0 is exactly `text`; the pin moves by the normal
 *  verified sync when it is. */
async function genesisLanded(svc: SignService, fleet: string, text: string): Promise<boolean> {
  const f = await svc.fleet().catch(() => null);
  if (!f || f.fleet !== fleet) return false;
  const entries = await svc.chain().catch(() => [] as string[]);
  if (entries[0] !== text) return false;
  await syncChain({ aud: f.aud, fleet } satisfies FleetCtx, entries);
  return true;
}
// (submits on their way from this page: Start again waits for none to be outstanding)
const inFlight = new Set<string>();

/**
 * Begin F1: checks that nothing blocks it, then makes the device key and the recovery code, and returns the review.
 * Refused: no WebCrypto Ed25519 (unsupported), no session, a sign-in without enough freshness left (reauth_needed),
 * an account that has a fleet, or an earlier F1 not settled yet (journal_open: settleGenesis first).
 */
export async function beginGenesis(svc: SignService, deviceName: string): Promise<GenesisReview> {
  if (!(await ed25519Available())) throw new SignRefused("unsupported");
  const s = await freshSession(svc, 300_000 - F1_START_LEFT_MS);
  if ((await svc.fleet().catch(() => { throw new SignRefused("unavailable"); })) !== null) throw new SignRefused("has_fleet");
  if ((await journalList().catch(() => { throw new SignRefused("storage_failed"); })).some((e) => e.flow === "genesis")) throw new SignRefused("journal_open");
  const core = fleetCore();
  const fleet = core.newId(), deviceId = core.newId();
  const publicRaw = await makeDeviceKey(fleet).catch(() => { throw new SignRefused("storage_failed"); });
  const code = core.newRecoveryCode();
  // (the recovery key's public half only; the key object is dropped here, in this call)
  const recoveryPublic = (await core.recoveryKey(code, fleet)).raw;
  const device = { id: deviceId, alg: "ed25519", key: core.b64(publicRaw), name: deviceName, tier: "browser" };
  const body = { fleet, aud: svc.aud, seq: 0, prev: "", at_ms: Date.now(), auth_time_ms: s.reauth_ms!, op: "genesis", device, recovery_key: { alg: "ed25519", key: core.b64(recoveryPublic) } };
  core.bodyValidator("device-chain")(body);
  const signer = { kind: "device", id: deviceId, alg: "ed25519", key: await core.keyId("ed25519", publicRaw) };
  const captured = core.signedBytes("sb.device-chain.v1", signer, body);
  return new GenesisReview(fleet, code, Object.freeze({ aud: svc.aud, reauth_ms: s.reauth_ms!, publicRaw: new Uint8Array(publicRaw), text: dec.decode(captured), captured: new Uint8Array(captured), signer, body }));
}

/** What an earlier F1 left, settled receipt first (r4 §3): a landed genesis adopted; one submitted and not landed
 *  resubmitted once, the same bytes; one never sent dropped, with its unused key. */
export async function settleGenesis(svc: SignService): Promise<GenesisResult | null> {
  const open = (await journalList()).filter((e) => e.flow === "genesis");
  for (const e of open) {
    const text = e.envelopes[0];
    if (e.state === "submitted" && text) {
      if (await genesisLanded(svc, e.fleet, text)) { await journalDelete(e.id); return { fleet: e.fleet, seq: 0 }; }
      return submitGenesis(svc, e.id, e.fleet, text);
    }
    // (pending or signed, never sent: nothing was admitted; the review is redone)
    await journalDelete(e.id);
    if (!(await pin(e.fleet))) await resetDevice(e.fleet);
  }
  return null;
}

/** "Start again" (note D2): allowed only with no genesis submit outstanding from this page, no pin and no fork mark
 *  for `fleet`, and a receipt read just now showing no genesis landed; then the unused key is deleted. */
export async function startAgain(svc: SignService, fleet: string): Promise<void> {
  if (inFlight.size) throw new SignRefused("journal_open");
  const p = await pin(fleet);
  if (p) throw new SignRefused(p.forked ? "forked" : "has_fleet");
  if ((await journalList(fleet)).length) throw new SignRefused("journal_open");
  const f = await svc.fleet().catch(() => { throw new SignRefused("unavailable"); });
  if (f) throw new SignRefused("has_fleet");
  await resetDevice(fleet);
}

/** The bytes a page shows nothing of: only for tests (captured bytes are public, the snapshot's own copy). */
export const __test = { enc, sameBytes };
