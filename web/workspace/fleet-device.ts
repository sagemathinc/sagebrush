// This browser's device key and chain pin for an Autonomous fleet (design: agent-autonomous-app-pairing r4 §1-§2;
// schemas r2.3 §1.4, §2.4). Storage only: no signing, no verifying and no protocol here. Those come from the fleet
// package's own modules once they are mirrored into the page, and nothing signs until they are cleared.
//
// - The key: Ed25519, made by WebCrypto with `extractable: false`, kept as its CryptoKey pair in this origin's
//   IndexedDB (PROD and DEV are separate origins, so separate keys). Its private half never leaves WebCrypto: this
//   module only gives out the public key's 32 raw bytes, and has no way to read the private half. One key per fleet
//   per install.
// - A browser without WebCrypto Ed25519 gets no key and no fallback (no JavaScript-library key): ed25519Available()
//   says so, and makeDeviceKey refuses.
// - The pin: (seq, hash) of the newest chain entry this device has verified. It only moves forward. An equal seq with
//   another hash is a fork, and a lower one a rollback: either marks the fleet forked, permanently. A forked device
//   signs nothing, and nothing here clears the mark or the pin but resetDevice, which deletes the key too (§2: the
//   device then becomes a new device, enrolled again).

const DB = "sagebrush-fleet-v1";
/** A fleet id (schemas r2.3 §1.1): 26 lowercase base32 characters, 128 random bits and 2 zero bits. */
export const FLEET_ID = /^[a-z2-7]{25}[aeimquy4]$/;
/** A pin's hash: the base64url SHA-256 of a chain entry's signed bytes (43 characters, schemas r2.3 §1.2, §2.1). */
const HASH = /^[A-Za-z0-9_-]{43}$/;

export type Pin = { seq: number; hash: string };
type KeyRecord = { keys: CryptoKeyPair; publicRaw: Uint8Array; created: number };
type PinRecord = Pin & { forked?: { at: number; seen: Pin } };

const req = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); tx.onabort = () => no(tx.error ?? new Error("aborted")); });
let db: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (db ??= new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { for (const s of ["keys", "pins"]) r.result.createObjectStore(s); };
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
export async function advancePin(fleet: string, next: Pin): Promise<"moved" | "same"> {
  fleetOk(fleet);
  if (!Number.isSafeInteger(next.seq) || next.seq < 0 || typeof next.hash !== "string" || !HASH.test(next.hash)) throw new Error("not a chain position");
  const tx = (await open()).transaction("pins", "readwrite");
  const s = tx.objectStore("pins");
  const cur = (await req(s.get(fleet))) as PinRecord | undefined;
  let out: "moved" | "same" | "fork";
  if (cur?.forked) out = "fork";
  else if (!cur || next.seq > cur.seq) { s.put({ seq: next.seq, hash: next.hash } satisfies PinRecord, fleet); out = "moved"; }
  else if (next.seq === cur.seq && next.hash === cur.hash) out = "same";
  else { s.put({ ...cur, forked: { at: Date.now(), seen: { seq: next.seq, hash: next.hash } } } satisfies PinRecord, fleet); out = "fork"; }
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
