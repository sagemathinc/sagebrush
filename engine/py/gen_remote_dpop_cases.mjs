// Writes test_remote_dpop_cases.json: DPoP proofs made by WebCrypto, as the page makes them
// (web/notebook/remote-client.js), one per case of the local gateway's proof checks (test/local-gateway.test.ts
// L1-L10, cases v3 §2), each with the refusal the runner's check (python/sagebrush/remote/dpop.py) must give.
// Every case is signed again with its own claims, so each checks one rule.  Run with Node >= 20:
//   node gen_remote_dpop_cases.mjs
import { writeFileSync } from "node:fs";
import { webcrypto, createHash, randomBytes } from "node:crypto";
const { subtle } = webcrypto;

const SYNTHETIC_BASE = "https://local.sagebrush.invalid/api/compute/v1";
const NOW_MS = 1_793_977_200_000; // a fixed clock: the cases don't depend on when they're run
const NOW = Math.floor(NOW_MS / 1000);
const TOKEN = randomBytes(32).toString("base64url");
const NONCE = randomBytes(16).toString("base64url");
const b64u = (b) => Buffer.from(b).toString("base64url");
const enc = (v) => b64u(Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));

async function key() {
  const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = await subtle.exportKey("jwk", k.publicKey);
  return { privateKey: k.privateKey, jwk: { kty, crv, x, y } };
}
const thumb = (jwk) => b64u(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
async function sign(priv, input) {
  return b64u(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, Buffer.from(input, "ascii")));
}

const page = await key();
const other = await key();
const JKT = thumb(page.jwk);
let n = 0;
const jti = () => `jti-${String(n++).padStart(4, "0")}-${randomBytes(12).toString("base64url")}`;

/** A proof for (method, path); `header`/`claims` override members (undefined deletes one); `rawHeader`/`rawClaims`
 * replace a segment's JSON text; `signer` signs with another key. */
async function proof(method, path, o = {}) {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: page.jwk, ...(o.header ?? {}) };
  const claims = { jti: jti(), htm: method, htu: SYNTHETIC_BASE + path, iat: NOW, ath: b64u(createHash("sha256").update(TOKEN).digest()), nonce: NONCE, ...(o.claims ?? {}) };
  for (const obj of [header, claims]) for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  const input = `${enc(o.rawHeader ?? header)}.${enc(o.rawClaims ?? claims)}`;
  return `${input}.${await sign(o.signer ?? page.privateKey, input)}`;
}

const cases = [];
/** A case: the request (method, path), the proof, and what check() must return: null, or [status, error, reason]. */
async function add(name, expect, o = {}) {
  const method = o.method ?? "POST", path = o.path ?? "/bindings";
  const dpop = o.dpop ?? (await proof(o.proofMethod ?? method, o.proofPath ?? path, o));
  cases.push({ name, method, htu: SYNTHETIC_BASE + path, auth: o.auth ?? `DPoP ${TOKEN}`, dpop, jtis: o.jtis ?? {}, jtisFill: o.jtisFill ?? 0, expect });
}
const R = (reason, error = "invalid_dpop_proof", status = 401) => [status, error, reason];

await add("L1 a good g.bind proof", null);
await add("L1 a good g.events proof (GET)", null, { method: "GET", path: "/bindings/b1/runs/r1/events" });
await add("L2 another token", R("token", "invalid_token"), { auth: `DPoP ${b64u(randomBytes(32))}` });
await add("L2 Bearer, not DPoP", R("token", "invalid_token"), { auth: `Bearer ${TOKEN}` });
await add("L3a typ missing", R("typ-missing"), { header: { typ: undefined } });
await add("L3b typ jwt", R("typ"), { header: { typ: "jwt" } });
await add("L3c alg none", R("alg"), { header: { alg: "none" } });
await add("L3c alg RS256", R("alg"), { header: { alg: "RS256" } });
await add("L3d no jwk", R("jwk-members"), { header: { jwk: undefined } });
await add("L3e a private d in the jwk", R("jwk-private"), { header: { jwk: { ...page.jwk, d: b64u(randomBytes(32)) } } });
await add("L3f an extra kid", R("jwk-extra"), { header: { jwk: { ...page.jwk, kid: "k1" } } });
{ const { y, ...noY } = page.jwk; await add("L3g no y", R("jwk-members"), { header: { jwk: noY } }); }
await add("L3h kty RSA", R("kty"), { header: { jwk: { ...page.jwk, kty: "RSA" } } });
await add("L3i crv P-384", R("crv"), { header: { jwk: { ...page.jwk, crv: "P-384" } } });
{ const x = Buffer.from(page.jwk.x, "base64url"); x[31] ^= 1; await add("L3j a point off the curve", R("curve"), { header: { jwk: { ...page.jwk, x: b64u(x) } } }); }
await add("L3k a 31-byte x", R("coords"), { header: { jwk: { ...page.jwk, x: b64u(randomBytes(31)) } } });
await add("L3l another key (its thumbprint isn't the socket's)", R("thumbprint"), { header: { jwk: other.jwk }, signer: other.privateKey });
await add("L3m the right header, signed by another key", R("signature"), { signer: other.privateKey });
{
  const p = (await proof("POST", "/bindings")).split(".");
  const sig = Buffer.from(p[2], "base64url"); sig[5] ^= 1;
  await add("L4a a flipped signature bit", R("signature"), { dpop: `${p[0]}.${p[1]}.${b64u(sig)}` });
  await add("L4b a 63-byte signature", R("sig-length"), { dpop: `${p[0]}.${p[1]}.${b64u(randomBytes(63))}` });
  await add("L4c two segments", R("parse"), { dpop: `${p[0]}.${p[1]}` });
  await add("L4c four segments", R("parse"), { dpop: `${p.join(".")}.${p[2]}` });
  await add("L4c not base64url", R("parse"), { dpop: `${p[0]}.${p[1]}+.${p[2]}` });
  await add("L4c a header that isn't JSON", R("parse"), { dpop: `${enc("{nope")}.${p[1]}.${p[2]}` });
  await add("L4c claims that are an array", R("parse"), { dpop: `${p[0]}.${enc([1, 2])}.${p[2]}` });
}
await add("L4d a proof over 4096 bytes", R("proof-size"), { dpop: "a".repeat(4097) });
await add("L4e claims over 1024 bytes", R("segment-size"), { claims: { pad: "x".repeat(1100) } });
await add("L5 htm GET for a POST", R("htm"), { proofMethod: "GET" });
await add("L6 htu another path", R("htu"), { proofPath: "/somewhere/else" });
await add("L6 htu with a query", R("htu"), { proofPath: "/bindings?x=1" });
await add("L7 ath of another token", R("ath"), { claims: { ath: b64u(randomBytes(32)) } });
await add("L7 claim types: htm a number", R("claim-types"), { claims: { htm: 5 } });
await add("L7 claim types: nonce null", R("claim-types"), { claims: { nonce: null } });
await add("L8a iat 61 s old", R("iat-past"), { claims: { iat: NOW - 61 } });
await add("L8a+ iat exactly 60 s old passes", null, { claims: { iat: NOW - 60 } });
await add("L8b iat 6 s ahead", R("iat-future"), { claims: { iat: NOW + 6 } });
await add("L8b+ iat exactly 5 s ahead passes", null, { claims: { iat: NOW + 5 } });
for (const [label, v] of [["missing", undefined], ["a string", String(NOW)], ["null", null], ["true", true], ["1.5", 1.5], ["2^53", 2 ** 53]]) {
  await add(`L8c iat ${label}`, R("iat-type"), { claims: { iat: v } });
}
{
  // 1e999 has no JSON.stringify form: the claims' text is written by hand
  const c = `{"jti":"${jti()}","htm":"POST","htu":"${SYNTHETIC_BASE}/bindings","iat":1e999,"ath":"${b64u(createHash("sha256").update(TOKEN).digest())}","nonce":"${NONCE}"}`;
  await add("L8c iat 1e999", R("iat-type"), { rawClaims: c });
}
{
  const j = "reused-" + randomBytes(16).toString("base64url");
  await add("L9a a jti seen 120 s ago (exactly)", R("jti-reused"), { claims: { jti: j }, jtis: { [j]: NOW_MS - 120_000 } });
  await add("L9a+ the same jti seen 120.001 s ago passes", null, { claims: { jti: j }, jtis: { [j]: NOW_MS - 120_001 } });
}
await add("L9b jti 21 characters", R("jti-min"), { claims: { jti: "a".repeat(21) } });
await add("L9b+ jti 22 characters passes", null, { claims: { jti: "b".repeat(22) } });
await add("L9c jti 65 characters", R("jti-max"), { claims: { jti: "c".repeat(65) } });
await add("L9c+ jti 64 characters passes", null, { claims: { jti: "d".repeat(64) } });
await add("L9c jti charset", R("jti-charset"), { claims: { jti: "e".repeat(21) + "+" } });
for (const [label, v] of [["missing", undefined], ["123", 123], ["null", null], ["an array", ["a".repeat(22)]]]) {
  await add(`L9d jti ${label}`, R("jti-type"), { claims: { jti: v } });
}
await add("L10a a stale nonce", [401, "use_dpop_nonce", "nonce"], { claims: { nonce: b64u(randomBytes(16)) } });
await add("L10a no nonce", [401, "use_dpop_nonce", "nonce"], { claims: { nonce: undefined } });
await add("the jti store full (4096)", [503, "limit", "jti-store"], { jtisFill: 4096 });
await add("the jti store at 4095 passes", null, { jtisFill: 4095 });

writeFileSync(new URL("./test_remote_dpop_cases.json", import.meta.url),
  JSON.stringify({ generator: "gen_remote_dpop_cases.mjs", node: process.version, now_ms: NOW_MS, token: TOKEN, jkt: JKT, nonce: NONCE, cases }, null, 1) + "\n");
console.log(cases.length, "cases;", cases.filter((c) => c.expect === null).length, "pass");
