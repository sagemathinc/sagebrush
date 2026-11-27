// Fleet protocol (r2.3 §7, §5.2): what is sealed to a host's X25519 key with HPKE (hpke.mjs). Two uses:
//   - sealed packages (sb.sealed-package.v1, signed by a device): a provider credential for one subscription and purpose,
//     info = "sagebrush.seal.v1\n" + canon(body without enc and ct), aad empty, so the header is bound into the
//     encryption as well as the signature;
//   - the capability mint's response { cap, not_after_ms, enc, ct }: the token sealed to the host, info =
//     "sagebrush.cap.v1\n" + canon({ fleet, aud, host, agent, cap, gen }).
// The host's encryption key is named by its key id with alg "x25519" (ruled): keyId("x25519", raw).
// Opening is pure: recording a package as opened, in the same durable step that installs its credential, is the broker's.

import { b64, enc, isId, refuse, unb64 } from "./bytes.mjs";
import { canonText, parseCanonical } from "./canonical.mjs";
import { keyId } from "./ed25519.mjs";
import { seal as sealEnvelope } from "./envelope.mjs";
import { open as hpkeOpen, seal as hpkeSeal } from "./hpke.mjs";
import { bodyValidator } from "./schemas.mjs";
import { openByDevice } from "./verify.mjs";

const PLAINTEXT_MAX = 16 * 1024;
const CAP_PLAINTEXT_MAX = 1024;
const SEVEN_DAYS = 7 * 24 * 3600_000;
// (no Claude purpose: a Claude login is never sealed or passed through the service; it is signed in on the host itself,
// through Claude Code's own flow, and a "claude-setup-token" package is refused like any purpose of another provider)
const PURPOSES = Object.freeze({ codex: ["codex-refresh-home", "codex-access-token"] });

/** The key id that names a host's X25519 encryption key (§7's enc_key). */
export const encKeyId = (raw) => keyId("x25519", raw);

const packageInfo = (header) => enc("sagebrush.seal.v1\n" + canonText(header));
const capInfo = ({ fleet, aud, host, agent, cap, gen }) => enc("sagebrush.cap.v1\n" + canonText({ fleet, aud, host, agent, cap, gen }));

function lifetime(b) {
  if (b.not_after_ms <= b.at_ms || b.not_after_ms - b.at_ms > SEVEN_DAYS) refuse("bad_form", "a package lives at most 7 days");
}

// (a purpose belongs to one provider: a codex purpose under a claude subscription is refused, on both sides)
function purposeOf(provider, purpose) {
  if (!PURPOSES[provider]?.includes(purpose)) refuse("bad_form", "a purpose of another provider");
}

/**
 * Seal a package (the native app). `header`: the body without enc and ct, its enc_key the id of `encRaw` (the host's
 * certified X25519 key). `plaintext`: { v: 1, provider, purpose, secret, issued_ms }. `signer` and `key` as for seal().
 * `ephemeral` is for the fixtures only (a pair from deriveKeyPair); otherwise a fresh one is generated.
 * Returns the envelope's bytes.
 */
export async function sealPackage(header, plaintext, encRaw, signer, key, { ephemeral = null } = {}) {
  if (header.enc_key !== (await encKeyId(encRaw))) refuse("bad_form", "enc_key isn't this X25519 key's id");
  if (Object.hasOwn(header, "enc") || Object.hasOwn(header, "ct")) refuse("bad_form", "the header has no enc or ct");
  lifetime(header);
  purposeOf(header.provider, header.purpose);
  bodyValidator("package_plaintext")(plaintext);
  if (plaintext.provider !== header.provider || plaintext.purpose !== header.purpose) refuse("bad_form", "the plaintext's provider or purpose isn't the header's");
  const pt = enc(canonText(plaintext, PLAINTEXT_MAX));
  const { enc: encapsulated, ct } = await hpkeSeal(encRaw, packageInfo(header), new Uint8Array(0), pt, ephemeral);
  pt.fill(0);
  const body = { ...header, enc: b64(encapsulated), ct: b64(ct) };
  bodyValidator("sealed-package")(body);
  return sealEnvelope("sb.sealed-package.v1", signer, body, key);
}

/**
 * The host's checks and the opening (§7), in the design's order. ctx: { aud, fleet, chain (the pinned chain state),
 * cert (this host's own verified certificate, verifyHostCert), hostRevoked(cert) -> bool (whether that certificate is
 * revoked), encKey (its X25519 pair, x25519FromPrivate), currentGen, grant (its current grant body), now,
 * revoked(package) -> bool, opened(package) -> bool }.
 * Returns { body, plaintext }; the caller records `body.package` as opened with the install, atomically.
 */
export async function verifyPackage(bytes, ctx) {
  const env = await openByDevice(bytes, ctx, "sb.sealed-package.v1", "sealed-package");
  const b = env.body;
  // its own: this host, its certified encryption key (and the key it holds is that key), its fingerprint
  if (b.host !== ctx.cert.body.host || b.fingerprint !== ctx.cert.body.fingerprint) refuse("not_granted", "a package for another host");
  if (b.enc_key !== (await encKeyId(ctx.cert.encRaw)) || b64(ctx.encKey.raw) !== b64(ctx.cert.encRaw)) refuse("not_granted", "a package for another key");
  if (ctx.hostRevoked(ctx.cert) !== false) refuse("host_revoked", "this host's certificate is revoked");
  lifetime(b);
  if (b.gen !== ctx.currentGen || ctx.now >= b.not_after_ms) refuse("package_stale", "another generation, or expired");
  if (ctx.revoked(b.package)) refuse("package_stale", "revoked");
  purposeOf(b.provider, b.purpose);
  const s = ctx.grant.host === b.host ? ctx.grant.subscriptions.find((x) => x.sub === b.sub) : undefined;
  if (!s || s.provider !== b.provider) refuse("not_granted", "the subscription isn't in the current grant");
  if (b.purpose === "codex-refresh-home" && s.home !== true) refuse("not_granted", "codex-refresh-home needs home: true");
  if (ctx.opened(b.package)) refuse("package_stale", "already opened");
  const { enc: encapsulated, ct, ...header } = b;
  const ctBytes = unb64(ct);
  if (ctBytes.length > PLAINTEXT_MAX + 16) refuse("limit", "a sealed plaintext over 16 KiB");
  const pt = await hpkeOpen(ctx.encKey, unb64(encapsulated, 32), packageInfo(header), new Uint8Array(0), ctBytes);
  try {
    const plaintext = parseCanonical(pt, PLAINTEXT_MAX);
    bodyValidator("package_plaintext")(plaintext);
    if (plaintext.provider !== b.provider || plaintext.purpose !== b.purpose) refuse("bad_form", "the plaintext's provider or purpose isn't the header's");
    return { body: b, plaintext };
  } finally {
    pt.fill(0);
  }
}

/**
 * The service's side of a mint (§5.2): the response { cap, not_after_ms, enc, ct } with the token sealed to the host.
 * `m`: { fleet, aud, host, agent, cap, gen, not_after_ms, token }; `encRaw`: the host's certified X25519 key.
 * `ephemeral`: the fixtures only, as for sealPackage.
 */
export async function sealCap(m, encRaw, { ephemeral = null } = {}) {
  const plaintext = { v: 1, token: m.token, cap: m.cap, agent: m.agent, gen: m.gen, not_after_ms: m.not_after_ms };
  bodyValidator("cap_plaintext")(plaintext);
  const pt = enc(canonText(plaintext, CAP_PLAINTEXT_MAX));
  const { enc: encapsulated, ct } = await hpkeSeal(encRaw, capInfo(m), new Uint8Array(0), pt, ephemeral);
  pt.fill(0);
  return { cap: m.cap, not_after_ms: m.not_after_ms, enc: b64(encapsulated), ct: b64(ct) };
}

/**
 * The host's side: open a mint response for `agent` at its current generation. ctx: { fleet, aud, host, agent, gen,
 * encKey, now }. Returns the plaintext { v, token, cap, agent, gen, not_after_ms }; anything else is refused.
 */
export async function openCap(response, ctx) {
  if (!response || typeof response !== "object" || !isId(response.cap) || !Number.isSafeInteger(response.not_after_ms)) refuse("bad_form", "not a mint response");
  const ctBytes = unb64(response.ct);
  if (ctBytes.length > CAP_PLAINTEXT_MAX + 16) refuse("limit", "a sealed capability over 1 KiB");
  const pt = await hpkeOpen(ctx.encKey, unb64(response.enc, 32), capInfo({ ...ctx, cap: response.cap }), new Uint8Array(0), ctBytes);
  try {
    const p = parseCanonical(pt, CAP_PLAINTEXT_MAX);
    bodyValidator("cap_plaintext")(p);
    if (p.cap !== response.cap || p.agent !== ctx.agent || p.gen !== ctx.gen || p.not_after_ms !== response.not_after_ms) refuse("bad_form", "the sealed capability isn't this response's");
    if (ctx.now >= p.not_after_ms) refuse("cap_invalid", "expired");
    return p;
  } finally {
    pt.fill(0);
  }
}
