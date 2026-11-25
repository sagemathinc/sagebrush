// Fleet protocol (r2.3 §5.1): the request signature a host's broker or supervisor puts on every request to the
// service, in the `Sagebrush-Sig` header, in the pure core: the header's form and the signed bytes (one source for
// both faces), and an async verifier for a page or a Worker. ../request.mjs is Node's synchronous face over the same
// form; it also signs, and consumes the nonce itself.
//
//   Sagebrush-Sig: v1 host=<id>; agent=<id or ->; cap=<id or ->; gen=<n>; ts=<ms>; nonce=<22>; idem=<22 or ->; op=<ms or ->; sig=<86>
//   signed bytes: "sagebrush.req.v1\n" aud "\n" METHOD "\n" target "\n" sha256b64(body) "\n" host "\n" agent "\n" cap "\n"
//                 gen "\n" ts "\n" nonce "\n" idem "\n" op
//
// verifyRequest checks, in §5.1's order: the form, aud, ts within 5 minutes, the host (paired, not revoked, gen
// current: the caller's), the signature. It doesn't consume the nonce: it returns it, and whoever owns the nonce
// store consumes it once the whole request is accepted (the live relay, agent-autonomous-browser-relay.md r2.1).

import { enc, isId, refuse, sha256b64, unb64 } from "./bytes.mjs";
import { verifyStrict } from "./ed25519.mjs";
import { AUDIENCES } from "./envelope.mjs";

export const SIG_KEYS = Object.freeze(["host", "agent", "cap", "gen", "ts", "nonce", "idem", "op", "sig"]);
export const SKEW_MS = 5 * 60_000;
const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const B22 = /^[A-Za-z0-9_-]{21}[AQgw]$/;

/** The signed bytes, given the body's digest (sha256b64 of the body). */
export const requestBytes = (aud, method, target, bodyDigest, f) =>
  enc(["sagebrush.req.v1", aud, method, target, bodyDigest, f.host, f.agent, f.cap, f.gen, f.ts, f.nonce, f.idem, f.op].join("\n"));

/** The header's fields, each in its fixed form, or a bad_form refusal. */
export function parseSig(header) {
  if (typeof header !== "string" || header.length > 1024 || !header.startsWith("v1 ")) refuse("bad_form", "not a Sagebrush-Sig v1 header");
  const parts = header.slice(3).split("; ");
  if (parts.length !== SIG_KEYS.length) refuse("bad_form", "a Sagebrush-Sig header has exactly its nine fields");
  const f = {};
  parts.forEach((p, i) => {
    const eq = p.indexOf("=");
    if (eq < 1 || p.slice(0, eq) !== SIG_KEYS[i]) refuse("bad_form", "a Sagebrush-Sig field out of place");
    f[SIG_KEYS[i]] = p.slice(eq + 1);
  });
  const idOrDash = (v) => v === "-" || isId(v);
  const num = (v) => COUNT.test(v) && Number.isSafeInteger(Number(v));
  if (!isId(f.host) || !idOrDash(f.agent) || !idOrDash(f.cap) || !num(f.gen) || f.gen === "0" || !num(f.ts) || !B22.test(f.nonce)
    || !(f.idem === "-" || B22.test(f.idem)) || !(f.op === "-" || num(f.op)) || (f.idem === "-") !== (f.op === "-")) refuse("bad_form", "a Sagebrush-Sig field's form");
  unb64(f.sig, 64);
  return f;
}

/**
 * Verify a request's signature, everything but the nonce. ctx: { aud, now, hostKey(host) -> 32-byte raw public key
 * (refusing unknown_host or host_revoked itself), currentGen(host) -> n }. Returns the parsed fields; the caller
 * consumes f.nonce. The target is compared as raw bytes: what is checked is what was signed.
 */
export async function verifyRequest({ header, method, target, body = new Uint8Array(0) }, ctx) {
  const f = parseSig(header);
  if (!AUDIENCES.includes(ctx.aud)) refuse("bad_audience");
  if (Math.abs(Number(f.ts) - ctx.now) > SKEW_MS) refuse("clock_skew");
  const raw = ctx.hostKey(f.host);
  if (Number(f.gen) !== ctx.currentGen(f.host)) refuse("stale_generation");
  if (!(await verifyStrict(raw, requestBytes(ctx.aud, method, target, await sha256b64(body), f), unb64(f.sig, 64)))) refuse("bad_signature");
  return f;
}
