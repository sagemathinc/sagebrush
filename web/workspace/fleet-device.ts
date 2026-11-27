// This browser's device key and chain pin for an Autonomous fleet (design: agent-autonomous-app-pairing r4 §1-§2;
// schemas r2.3 §1.4, §2.4). Storage, and the key's one signing call: no verifying and no protocol here.
// - Signing (M4, its SEC note r8 §2): signAsDevice signs exactly the bytes a grant was minted for, once. Grants come
//   only from the minter, which this module hands out exactly once (signingMinter): fleet-sign.ts takes it as it loads,
//   so no other module can mint one (a census pins that it is the only caller), and the bytes signed are always the
//   bytes its barrier reviewed. No grant, a used one, or other bytes: refused before the key is touched.
//
// - The key: Ed25519, made by WebCrypto with `extractable: false`, kept as its CryptoKey pair in this origin's
//   IndexedDB (PROD and DEV are separate origins, so separate keys). Its private half never leaves WebCrypto: this
//   module only gives out the public key's 32 raw bytes, and has no way to read the private half. One key per fleet
//   per install.
// - A browser without WebCrypto Ed25519 gets no key and no fallback (no JavaScript-library key): ed25519Available()
//   says so, and makeDeviceKey refuses.
// - The pin: (seq, hash) of the newest chain entry this device has verified, with that entry's exact text when the
//   caller gave it. It only moves forward. An equal seq with another hash is a fork, and a lower one a rollback: either
//   marks the fleet forked, permanently, with both conflicting entries' texts kept as evidence (r4 §2) when they are
//   known. A forked device signs nothing, and nothing here clears the mark or the pin but resetDevice, which deletes
//   the key too (§2: the device then becomes a new device, enrolled again).
// - The journal (M4 note §3.5): the public signed objects of a review, kept until their receipt is read. Never a key,
//   a recovery code or a seed.

const DB = "sagebrush-fleet-v1";
/** A fleet id (schemas r2.3 §1.1): 26 lowercase base32 characters, 128 random bits and 2 zero bits. */
export const FLEET_ID = /^[a-z2-7]{25}[aeimquy4]$/;
/** A pin's hash: the base64url SHA-256 of a chain entry's signed bytes, canonical (schemas r2.3 §1.2, §2.1): 43
 * characters (256 bits: 42 full characters and 4 bits), the last carrying those 4 bits and 2 zero pad bits, so it is one of
 * A E I M Q U Y c g k o s w 0 4 8. */
const HASH = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

export type Pin = { seq: number; hash: string };
type KeyRecord = { keys: CryptoKeyPair; publicRaw: Uint8Array; created: number };
/** A fork's evidence: the entry this device had pinned and the conflicting one it was shown, as their exact texts (null
 *  for one this device never had: a pin from before texts were kept, or a head behind the pin). */
export type ForkEvidence = { at: number; seen: Pin; pinned: string | null; conflicting: string | null };
type PinRecord = Pin & { entry?: string; forked?: ForkEvidence };
/** The most a kept chain entry may be (an entry's signed bytes are bounded by the core's SIGNED_MAX; this is a cap on
 *  what is stored, refusing rather than truncating). */
const ENTRY_MAX = 64 * 1024;
const entryOk = (t: unknown): t is string => typeof t === "string" && t.length > 0 && t.length <= ENTRY_MAX;

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error ?? new Error("aborted")); });
let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((ok, no) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { for (const s of ["keys", "pins", "journal"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  }));
}
const fleetOk = (fleet: string) => { if (typeof fleet !== "string" || !FLEET_ID.test(fleet)) throw new Error("not a fleet id"); };

/** Whether this browser's WebCrypto makes non-extractable Ed25519 keys (no fallback when it doesn't). */
export async function ed25519Available(): Promise<boolean> {
  try {
    const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return k.privateKey.extractable === false && k.privateKey.algorithm.name === "Ed25519";
  } catch { return false; }
}

/** This install's device key for `fleet`: its public key's raw 32 bytes and when it was made, or null if none. */
export async function deviceKey(fleet: string): Promise<{ publicRaw: Uint8Array; created: number } | null> {
  fleetOk(fleet);
  const tx = (await open()).transaction("keys", "readonly");
  const k = (await req(tx.objectStore("keys").get(fleet))) as KeyRecord | undefined;
  return k ? { publicRaw: new Uint8Array(k.publicRaw), created: k.created } : null;
}

/** Make this install's device key for `fleet`: Ed25519, its private half non-extractable. Refused if one exists (one
 * per fleet per install; resetDevice first), or if this browser has no WebCrypto Ed25519. Its public key's raw bytes. */
export async function makeDeviceKey(fleet: string): Promise<Uint8Array> {
  fleetOk(fleet);
  let keys: CryptoKeyPair;
  try { keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair; } catch { throw new Error("this browser can't hold a Sagebrush device key"); }
  if (keys.privateKey.extractable !== false) throw new Error("this browser can't hold a Sagebrush device key");
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  if (publicRaw.length !== 32) throw new Error("not an Ed25519 public key");
  const tx = (await open()).transaction("keys", "readwrite");
  const s = tx.objectStore("keys");
  // (in the same transaction as the write: two tabs making a key at once can't both keep one)
  if ((await req(s.getKey(fleet))) !== undefined) { tx.abort(); throw new Error("this install already has a device key for the fleet"); }
  s.add({ keys, publicRaw, created: Date.now() } satisfies KeyRecord, fleet);
  await done(tx);
  return new Uint8Array(publicRaw);
}

/** The pin for `fleet`: the newest verified chain entry, and whether the fleet is forked here; null if none. */
export async function pin(fleet: string): Promise<{ seq: number; hash: string; forked: boolean } | null> {
  fleetOk(fleet);
  const tx = (await open()).transaction("pins", "readonly");
  const p = (await req(tx.objectStore("pins").get(fleet))) as PinRecord | undefined;
  return p ? { seq: p.seq, hash: p.hash, forked: !!p.forked } : null;
}

/** Move the pin to `next`, a chain entry the caller has verified from the current pin. Forward only: a higher seq
 * moves it; the same seq with the same hash changes nothing; the same seq with another hash (a fork) or a lower seq (a
 * rollback) marks the fleet forked, for good, and is refused. A forked fleet's pin never moves again. */
export async function advancePin(fleet: string, next: Pin, entry?: string | null): Promise<"moved" | "same"> {
  fleetOk(fleet);
  if (!Number.isSafeInteger(next.seq) || next.seq < 0 || typeof next.hash !== "string" || !HASH.test(next.hash)) throw new Error("not a chain position");
  const text = entryOk(entry) ? entry : null;
  const tx = (await open()).transaction("pins", "readwrite");
  const s = tx.objectStore("pins");
  const cur = (await req(s.get(fleet))) as PinRecord | undefined;
  let out: "moved" | "same" | "fork";
  if (cur?.forked) out = "fork";
  else if (!cur || next.seq > cur.seq) { s.put({ seq: next.seq, hash: next.hash, ...(text ? { entry: text } : {}) } satisfies PinRecord, fleet); out = "moved"; }
  else if (next.seq === cur.seq && next.hash === cur.hash) out = "same";
  else { s.put({ ...cur, forked: { at: Date.now(), seen: { seq: next.seq, hash: next.hash }, pinned: cur.entry ?? null, conflicting: text } } satisfies PinRecord, fleet); out = "fork"; }
  await done(tx);
  if (out === "fork") throw new Error("chain_fork");
  return out;
}

/** Move the pin to `head`, the head of a chain the caller verified, whose entry hashes by seq are `hashes`, in one
 * transaction (a compare-and-set, so tabs can't interleave): only if the stored pin is one of that chain's entries.
 * A stored pin at another hash than the chain's at its seq (another tab pinned another branch) marks the fleet forked,
 * for good, and is refused (chain_fork), as is a forked fleet. A stored pin past the head (another tab pinned further)
 * proves nothing about that chain: nothing is written and "behind" says to sync again. */
export async function advancePinOnChain(fleet: string, hashes: readonly string[], head: Pin, entries?: readonly string[]): Promise<"moved" | "same" | "behind"> {
  fleetOk(fleet);
  if (!Number.isSafeInteger(head.seq) || head.seq < 0 || typeof head.hash !== "string" || !HASH.test(head.hash) || hashes[head.seq] !== head.hash) throw new Error("not a chain position");
  const tx = (await open()).transaction("pins", "readwrite");
  const s = tx.objectStore("pins");
  const cur = (await req(s.get(fleet))) as PinRecord | undefined;
  // (each entry's exact text when the caller gave it: the pin keeps its own, and a fork both sides', as evidence)
  const at = (n: number) => (entryOk(entries?.[n]) ? entries![n] : null);
  const headText = at(head.seq);
  let out: "moved" | "same" | "behind" | "fork";
  if (cur?.forked) out = "fork";
  else if (!cur) { s.put({ seq: head.seq, hash: head.hash, ...(headText ? { entry: headText } : {}) } satisfies PinRecord, fleet); out = "moved"; }
  else if (cur.seq > head.seq) out = "behind";
  else if (hashes[cur.seq] !== cur.hash) { s.put({ ...cur, forked: { at: Date.now(), seen: { seq: cur.seq, hash: String(hashes[cur.seq]) }, pinned: cur.entry ?? null, conflicting: at(cur.seq) } } satisfies PinRecord, fleet); out = "fork"; }
  else if (cur.seq === head.seq) { if (!cur.entry && headText) s.put({ ...cur, entry: headText } satisfies PinRecord, fleet); out = "same"; }
  else { s.put({ seq: head.seq, hash: head.hash, ...(headText ? { entry: headText } : {}) } satisfies PinRecord, fleet); out = "moved"; }
  await done(tx);
  if (out === "fork") throw new Error("chain_fork");
  return out;
}

/** "Reset this device" (§2): this install's key and pin for `fleet` deleted, the fork mark with them. The install is
 * then a new device, enrolled again from another device or with the recovery code. */
export async function resetDevice(fleet: string): Promise<void> {
  fleetOk(fleet);
  const tx = (await open()).transaction(["keys", "pins"], "readwrite");
  tx.objectStore("keys").delete(fleet);
  tx.objectStore("pins").delete(fleet);
  await done(tx);
}

/** A forked fleet's evidence (r4 §2): when it was recorded, what was seen, and both conflicting entries' exact texts
 * (each null if this device never had it). Null if the fleet isn't forked here. For the device view's Export evidence. */
export async function forkEvidence(fleet: string): Promise<ForkEvidence | null> {
  fleetOk(fleet);
  const tx = (await open()).transaction("pins", "readonly");
  const p = (await req(tx.objectStore("pins").get(fleet))) as PinRecord | undefined;
  return p?.forked ? { at: p.forked.at, seen: { ...p.forked.seen }, pinned: p.forked.pinned ?? null, conflicting: p.forked.conflicting ?? null } : null;
}

// ---- signing (M4 note §2, §3.4)

/** A permission to sign exactly `bytes`, once: made only by the minter. */
export type SignGrant = { readonly fleet: string };
// (the grants minted and not yet used, each with its own copy of the bytes it permits: a grant is an opaque object,
//  so nothing outside this module can make one, nor change the bytes it is for)
const live = new WeakMap<SignGrant, { fleet: string; bytes: Uint8Array }>();
let minterTaken = false;
/** The minter of signing grants, handed out exactly ONCE per page: fleet-sign.ts takes it as it loads. Any later call
 * throws, so a page in which something else took it first has no working barrier (fleet-sign refuses to start). */
export function signingMinter(): (fleet: string, bytes: Uint8Array) => SignGrant {
  if (minterTaken) throw new Error("the signing minter was already taken");
  minterTaken = true;
  return (fleet, bytes) => {
    fleetOk(fleet);
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error("nothing to sign");
    const g: SignGrant = Object.freeze({ fleet });
    live.set(g, { fleet, bytes: new Uint8Array(bytes) });
    return g;
  };
}

// (tests only: every call that reaches the key, counted (M4 note §9 the key-invocation count))
let invocations = 0;
/** How many times this page has signed with a device key (tests read it; it never decides anything). */
export const keyInvocations = () => invocations;

/** Sign `bytes` with this install's device key for `fleet`: only with a grant minted for exactly these bytes and this
 * fleet, used once; refused for a forked fleet or with no key. The 64-byte Ed25519 signature. */
export async function signAsDevice(grant: SignGrant, fleet: string, bytes: Uint8Array): Promise<Uint8Array> {
  const g = live.get(grant);
  // (spent at once, whatever follows: a grant never signs twice)
  live.delete(grant);
  if (!g || g.fleet !== fleet || !(bytes instanceof Uint8Array) || g.bytes.length !== bytes.length || !g.bytes.every((b, i) => b === bytes[i])) throw new Error("not_granted");
  fleetOk(fleet);
  const tx = (await open()).transaction(["keys", "pins"], "readonly");
  const k = (await req(tx.objectStore("keys").get(fleet))) as KeyRecord | undefined;
  const p = (await req(tx.objectStore("pins").get(fleet))) as PinRecord | undefined;
  if (p?.forked) throw new Error("chain_fork");
  if (!k) throw new Error("not_enrolled");
  invocations++;
  return new Uint8Array(await crypto.subtle.sign("Ed25519", k.keys.privateKey, g.bytes as Uint8Array<ArrayBuffer>));
}

// ---- the journal (M4 note §3.5): a review's public signed objects, until their receipt is read

export type JournalEntry = {
  /** the review's own id: the object's idempotency identity (S§5.3) */
  id: string;
  fleet: string;
  flow: "genesis" | "host-pair";
  state: "pending" | "signed" | "submitted";
  /** the captured canonical bytes to be signed, then the signed envelopes as they are made */
  captured: string[];
  envelopes: string[];
  at: number;
};
const JOURNAL_MAX = 256 * 1024;
const journalOk = (e: JournalEntry) => !!e && typeof e.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(e.id) && FLEET_ID.test(e.fleet)
  && ["genesis", "host-pair"].includes(e.flow) && ["pending", "signed", "submitted"].includes(e.state)
  && Array.isArray(e.captured) && Array.isArray(e.envelopes) && [...e.captured, ...e.envelopes].every((t) => typeof t === "string")
  && JSON.stringify(e).length <= JOURNAL_MAX;
/** Write (or replace) a journal entry. */
export async function journalPut(e: JournalEntry): Promise<void> {
  if (!journalOk(e)) throw new Error("not a journal entry");
  const tx = (await open()).transaction("journal", "readwrite");
  tx.objectStore("journal").put({ ...e, captured: [...e.captured], envelopes: [...e.envelopes] }, e.id);
  await done(tx);
}
/** The journal entries for `fleet` (or all, for a fleet id not known yet: F1 before its genesis lands). */
export async function journalList(fleet?: string): Promise<JournalEntry[]> {
  const tx = (await open()).transaction("journal", "readonly");
  const all = ((await req(tx.objectStore("journal").getAll())) as JournalEntry[]).filter(journalOk);
  return fleet === undefined ? all : all.filter((e) => e.fleet === fleet);
}
export async function journalDelete(id: string): Promise<void> {
  const tx = (await open()).transaction("journal", "readwrite");
  tx.objectStore("journal").delete(id);
  await done(tx);
}
