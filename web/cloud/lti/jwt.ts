// JWT parsing and RSA signature checks for LTI messages (plan-lti-r5 §3.2).

import { b64urlDecode, b64urlEncode, LtiError, utf8 } from "./util.ts";

export const ALGS = { RS256: "SHA-256", RS384: "SHA-384", RS512: "SHA-512" } as const;
export type Alg = keyof typeof ALGS;

export interface ParsedJwt {
  header: { alg: string; kid?: string; typ?: string; [k: string]: unknown };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

/** Parse without trusting anything: ≤ 32 KiB, three parts, JSON objects. */
export function parseJwt(jwt: string): ParsedJwt {
  if (typeof jwt !== "string" || jwt.length > 32 * 1024) throw new LtiError(400, "jwt_too_large");
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new LtiError(400, "bad_jwt");
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (!header || typeof header !== "object" || Array.isArray(header) || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return { header, payload, signingInput: parts[0] + "." + parts[1], signature: b64urlDecode(parts[2]) };
  } catch {
    throw new LtiError(400, "bad_jwt");
  }
}

export interface Jwk { kty: string; kid?: string; n?: string; e?: string; alg?: string; use?: string; [k: string]: unknown }

/** RSA modulus length in bits, from the JWK's `n`. */
export function modulusBits(k: Jwk): number {
  if (typeof k.n !== "string") return 0;
  const n = b64urlDecode(k.n);
  let i = 0;
  while (i < n.length && n[i] === 0) i++;
  if (i === n.length) return 0;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]));
}

/** Verify an RS* signature against one JWK.  RSA keys must be ≥ 2048 bits. */
export async function verifyRsa(p: ParsedJwt, jwk: Jwk): Promise<boolean> {
  const alg = p.header.alg as Alg;
  if (!(alg in ALGS)) return false;
  if (jwk.kty !== "RSA" || modulusBits(jwk) < 2048) return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (jwk.use !== undefined && jwk.use !== "sig") return false;
  const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: ALGS[alg] }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, p.signature, utf8(p.signingInput));
}

/** Sign a JWT with an RSA private JWK, RS256 (r5 §4.4: the deep-link response; later the client assertion). */
export async function signRs256(payload: Record<string, unknown>, privateJwk: Jwk & { kid: string }, typ = "JWT"): Promise<string> {
  const enc = (o: unknown) => b64urlEncode(JSON.stringify(o));
  const input = enc({ alg: "RS256", kid: privateJwk.kid, typ }) + "." + enc(payload);
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(input)));
  return input + "." + b64urlEncode(sig);
}
