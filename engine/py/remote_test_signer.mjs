// The page's key for test_remote_pair.py: a WebCrypto P-256 key, made and used as the page makes and uses its
// DPoP key (web/notebook/remote-client.js), so the runner is tested against real ES256 proofs.  One JSON line in,
// one out: first it writes {jwk, jkt}; then for each {id, input} (the JWS signing input) it writes {id, sig}
// (base64url, 64-byte r || s).  Node >= 20.
import { webcrypto, createHash } from "node:crypto";
import { createInterface } from "node:readline";
const { subtle } = webcrypto;
const b64u = (b) => Buffer.from(b).toString("base64url");
const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const { kty, crv, x, y } = await subtle.exportKey("jwk", k.publicKey);
const jwk = { kty, crv, x, y };
const jkt = b64u(createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest());
process.stdout.write(JSON.stringify({ jwk, jkt }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, input } = JSON.parse(line);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, Buffer.from(input, "ascii"));
  process.stdout.write(JSON.stringify({ id, sig: b64u(sig) }) + "\n");
}
