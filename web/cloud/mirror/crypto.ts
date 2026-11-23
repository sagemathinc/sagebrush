// The log mirror's cryptography (plan r7, design B, SEC pins S3 and S5; amendment A1).  Pure functions on WebCrypto:
// no storage, no network, no logging.  Key material never leaves these functions except as a non-extractable
// CryptoKey, and is never put in an error message.
//
// - The account's data key (DEK, AES-256-GCM) is wrapped by a key-encryption key (KEK), a versioned Worker secret
//   (MIRROR_KEK_V<n>, base64url of 32 random bytes; MIRROR_KEK_CURRENT names the version new wraps use), with
//   AES-256-GCM: a random 96-bit nonce of its own for each wrap, and associated data binding the account id, the
//   key_id and the KEK version.  So a wrapped DEK moved to another account or key_id doesn't unwrap.
// - A segment is sealed with the DEK under a nonce the account's object hands out from one monotonic counter
//   (nonceOf), never twice: an abandoned value is burned.  The associated data is the segment's header, in canonical
//   JSON, stored in the object as is: version, algorithm, schema, the immutable account id, the conversation's locator,
//   log_instance, the segment id, both ranges (positions and the agent's numbers), the previous segment's digest,
//   key_id, the nonce and the plaintext's length.  A reader checks the header against the account's own record and the
//   path before decrypting, and GCM authenticates the whole segment before any plaintext exists.
//
// An object is: "SBM1", the header's length (4 bytes, big-endian), the header, then the ciphertext with its tag.
import { canonical } from "../../workspace/agent-chat/mirror-format.ts";

export const ENVELOPE = 1;
export const ALG = "A256GCM";
const MAGIC = [0x53, 0x42, 0x4d, 0x31]; // "SBM1"
export const HEADER_MAX = 2048;
/** What a sealed object adds to its plaintext, at most: magic, length, header, tag. */
export const OVERHEAD = 4 + 4 + HEADER_MAX + 16;
/** The nonce counter's last value: past it, sealing is refused, never wrapped around. */
export const NONCE_MAX = Number.MAX_SAFE_INTEGER;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function unhex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error("not hex");
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}
export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
export async function sha256Hex(b: Uint8Array | string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc.encode(b) : b)));
}
export const ZERO_DIGEST = "0".repeat(64);

// ---- the conversation's locator (S1): server-random, never derived from the conversation id

/** A locator from 16 random bytes: their hex, so it depends on those bytes only (test mechanic 5's encoder row). */
export function locatorOf(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("a locator is 16 bytes");
  return hex(bytes);
}
export const LOCATOR = /^[0-9a-f]{32}$/;

// ---- nonces (S3): from the account's counter

/** The 96-bit nonce for counter value `c` (1 up to NONCE_MAX): 4 zero bytes, then c as 8 bytes, big-endian. */
export function nonceOf(c: number): Uint8Array {
  if (!Number.isSafeInteger(c) || c < 1 || c > NONCE_MAX) throw new Error("nonce out of range");
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(c));
  return n;
}

// ---- the KEK and the DEK (S3, S5)

export type KekEnv = { MIRROR_KEK_CURRENT?: string };
const KEK_VERSION = /^[1-9][0-9]{0,5}$/;
/** The current KEK version, if it is named and its secret is a well-formed 32-byte key; else null (the mirror is off). */
export function currentKek(env: KekEnv): string | null {
  const v = env.MIRROR_KEK_CURRENT;
  if (typeof v !== "string" || !KEK_VERSION.test(v)) return null;
  const raw = kekBytes(env, v);
  if (!raw) return null;
  raw.fill(0);
  return v;
}
function kekBytes(env: KekEnv, v: string): Uint8Array | null {
  if (!KEK_VERSION.test(v)) return null;
  const s = (env as Record<string, unknown>)[`MIRROR_KEK_V${v}`];
  if (typeof s !== "string") return null;
  try {
    const b = unb64url(s);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}
async function kek(env: KekEnv, v: string): Promise<CryptoKey | null> {
  const raw = kekBytes(env, v);
  if (!raw) return null;
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}
const wrapAad = (account: string, key_id: string, kek: string) => enc.encode(canonical({ purpose: "sagebrush-mirror-dek", v: ENVELOPE, account, key_id, kek }));

export interface Wrapped {
  key_id: string;
  kek: string;
  /** the wrap's nonce, then the wrapped key and its tag: hex */
  wrapped: string;
}
export const KEY_ID = /^[0-9a-f]{32}$/;
export const WRAPPED = /^[0-9a-f]{120}$/;

/** A new DEK, wrapped under the current KEK for (account, a new key_id); the plaintext key is dropped here. */
export async function newWrappedDek(env: KekEnv, account: string): Promise<Wrapped> {
  const v = currentKek(env);
  if (!v) throw new Error("no current KEK");
  const key_id = hex(crypto.getRandomValues(new Uint8Array(16)));
  const dek = crypto.getRandomValues(new Uint8Array(32));
  try {
    return await wrap(env, v, account, key_id, dek);
  } finally {
    dek.fill(0);
  }
}
async function wrap(env: KekEnv, v: string, account: string, key_id: string, dek: Uint8Array): Promise<Wrapped> {
  const k = await kek(env, v);
  if (!k) throw new Error("no such KEK");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: wrapAad(account, key_id, v) }, k, dek));
  return { key_id, kek: v, wrapped: hex(iv) + hex(ct) };
}
/** The raw DEK of a wrap, or null if it doesn't unwrap (another account, key_id or KEK, or a KEK that is gone). */
async function unwrapRaw(env: KekEnv, account: string, w: Wrapped): Promise<Uint8Array | null> {
  const k = await kek(env, w.kek);
  if (!k || !WRAPPED.test(w.wrapped)) return null;
  const b = unhex(w.wrapped);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: wrapAad(account, w.key_id, w.kek) }, k, b.subarray(12)));
  } catch {
    return null;
  }
}

/**
 * The DEK for (account, key_id) as a non-extractable key, from whichever of its wraps a present KEK opens (the current
 * version first), and, when the one that opened isn't under the current KEK, a rewrap under it (controlled rotation:
 * the account's object stores it and drops the older wraps).  Null if no wrap opens.
 */
export async function openDek(env: KekEnv, account: string, wraps: Wrapped[]): Promise<{ key: CryptoKey; key_id: string; rewrap?: Wrapped } | null> {
  const cur = currentKek(env);
  const order = [...wraps].sort((a, b) => (a.kek === cur ? -1 : b.kek === cur ? 1 : 0));
  for (const w of order) {
    const raw = await unwrapRaw(env, account, w);
    if (!raw) continue;
    try {
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      const rewrap = cur && w.kek !== cur ? await wrap(env, cur, account, w.key_id, raw) : undefined;
      return { key, key_id: w.key_id, ...(rewrap ? { rewrap } : {}) };
    } finally {
      raw.fill(0);
    }
  }
  return null;
}

// ---- segments

export interface Header {
  v: number;
  alg: string;
  schema: number;
  account: string;
  locator: string;
  log_instance: string;
  segment: number;
  first_n: number;
  last_n: number;
  first_seq: number;
  last_seq: number;
  prev: string;
  key_id: string;
  nonce: string;
  len: number;
}
const HEADER_KEYS = "account,alg,first_n,first_seq,key_id,last_n,last_seq,len,locator,log_instance,nonce,prev,schema,segment,v";

/** The sealed object for a plaintext under `h` (its len and nonce must be the plaintext's and the reservation's). */
export async function seal(key: CryptoKey, h: Header, plaintext: Uint8Array): Promise<Uint8Array> {
  if (h.len !== plaintext.length) throw new Error("header length");
  const head = enc.encode(canonical(h));
  if (head.length > HEADER_MAX) throw new Error("header too long");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: unhex(h.nonce), additionalData: head }, key, plaintext));
  const out = new Uint8Array(8 + head.length + ct.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, head.length);
  out.set(head, 8);
  out.set(ct, 8 + head.length);
  return out;
}

/** An object's header, if it is well-formed and in canonical form (the exact bytes that were authenticated); else null. */
export function headerOf(obj: Uint8Array): Header | null {
  if (obj.length < 8 || MAGIC.some((m, i) => obj[i] !== m)) return null;
  const n = new DataView(obj.buffer, obj.byteOffset, obj.byteLength).getUint32(4);
  if (n > HEADER_MAX || 8 + n + 16 > obj.length) return null;
  let text: string, h: Header;
  try {
    text = dec.decode(obj.subarray(8, 8 + n));
    h = JSON.parse(text);
    if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).sort().join(",") !== HEADER_KEYS) return null;
    if (canonical(h) !== text) return null;
  } catch {
    return null;
  }
  return h;
}

/**
 * The plaintext of an object, only if its header is exactly `want` (the account's record, the path's account and
 * locator) and the whole ciphertext authenticates under it; else null.  Nothing is released before both hold.
 */
export async function open(key: CryptoKey, obj: Uint8Array, want: Header): Promise<Uint8Array | null> {
  const h = headerOf(obj);
  if (!h || canonical(h) !== canonical(want)) return null;
  const n = new DataView(obj.buffer, obj.byteOffset, obj.byteLength).getUint32(4);
  if (obj.length - 8 - n !== h.len + 16) return null;
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(h.nonce), additionalData: obj.subarray(8, 8 + n) }, key, obj.subarray(8 + n)));
    return pt.length === h.len ? pt : null;
  } catch {
    return null;
  }
}
