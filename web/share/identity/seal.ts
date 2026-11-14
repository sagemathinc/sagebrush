// A WorkOS refresh token at rest: sealed with AES-GCM under a Worker secret, never sent to the browser.
//
// The keys are one secret, REFRESH_KEYS: "<version>:<32 bytes, base64>" entries separated by commas, the first being
// the current key (every new seal uses it) and any others old keys kept only for opening.  Each seal has a fresh
// 96-bit nonce, and its associated data binds it to the environment, the identity, the session (its token's hash)
// and the key version, so a sealed token copied to another row, session or environment doesn't open.  Rotating:
// put a new key first and keep the old one after it; sessions move to the new key at their next refresh.  A session
// whose key is removed can't be refreshed, so it ends at its next check.

export interface SealKeys { current: string; keys: Map<string, CryptoKey> }

const VERSION = /^[A-Za-z0-9_-]{1,16}$/;
const enc = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const cache = new Map<string, Promise<SealKeys | null>>();

/** The parsed keys, or null when the secret is missing or malformed (a refresh then can't be sealed or opened). */
export function sealKeys(secret: string | undefined): Promise<SealKeys | null> {
  if (!secret) return Promise.resolve(null);
  let p = cache.get(secret);
  if (!p) {
    p = parse(secret);
    cache.set(secret, p);
  }
  return p;
}

async function parse(secret: string): Promise<SealKeys | null> {
  const keys = new Map<string, CryptoKey>();
  let current: string | null = null;
  for (const part of secret.split(",")) {
    const i = part.indexOf(":");
    if (i < 1) return null;
    const v = part.slice(0, i).trim();
    let raw: Uint8Array<ArrayBuffer>;
    try {
      raw = unb64(part.slice(i + 1).trim());
    } catch {
      return null;
    }
    if (!VERSION.test(v) || raw.length !== 32 || keys.has(v)) return null;
    keys.set(v, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    current ??= v;
  }
  return current ? { current, keys } : null;
}

export interface SealContext { env: string; identity: string; session: string }
const aad = (c: SealContext, version: string) => enc.encode(`sagebrush-refresh\n${c.env}\n${c.identity}\n${c.session}\n${version}`);

/** `plain` sealed under the current key: its version and base64(nonce || ciphertext). */
export async function seal(k: SealKeys, c: SealContext, plain: string): Promise<{ version: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(c, k.current) }, k.keys.get(k.current)!, enc.encode(plain)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return { version: k.current, ct: b64(out) };
}

/** The sealed value, or null if its key is gone or it doesn't open in this context (wrong row, session or env). */
export async function unseal(k: SealKeys, c: SealContext, version: string | null, ct: string | null): Promise<string | null> {
  if (!version || !ct) return null;
  const key = k.keys.get(version);
  if (!key) return null;
  try {
    const all = unb64(ct);
    if (all.length < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12), additionalData: aad(c, version) }, key, all.slice(12));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
