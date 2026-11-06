// Writes test_remote_es256_vectors.json: ES256 signatures made by WebCrypto (as the page makes its DPoP proofs),
// and WebCrypto's own verdict on each case, so the runner's verifier (engine/py/src/remote.rs) is checked against
// the browser's, not against itself.  Run with Node >= 20:  node gen_remote_es256_vectors.mjs
import { writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
const { subtle } = webcrypto;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const hex = (b) => Buffer.from(b).toString("hex");
const b64u = (s) => Buffer.from(s, "base64url");
const big = (b) => BigInt("0x" + hex(b));
const be32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");
const enc = new TextEncoder();

async function key() {
  const k = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", k.publicKey);
  return { k, x: b64u(jwk.x), y: b64u(jwk.y) };
}
async function webVerify(x, y, msg, sig) {
  try {
    const pub = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, msg);
  } catch {
    return false;
  }
}

const cases = [];
const a = await key();
const b = await key();
const messages = ["", "eyJhbGciOiJFUzI1NiJ9.eyJodG0iOiJQT1NUIn0", "x".repeat(4096)];
for (const m of messages) {
  const msg = Buffer.from(enc.encode(m));
  for (let i = 0; i < 3; i++) {
    const sig = Buffer.from(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.k.privateKey, msg));
    cases.push({ name: `webcrypto sign len ${msg.length} #${i}`, x: a.x, y: a.y, msg, sig });
    if (i === 0) {
      const r = big(sig.subarray(0, 32)), s = big(sig.subarray(32));
      cases.push({ name: `high/low S twin len ${msg.length}`, x: a.x, y: a.y, msg, sig: Buffer.concat([be32(r), be32(N - s)]) });
      cases.push({ name: `wrong key len ${msg.length}`, x: b.x, y: b.y, msg, sig });
      cases.push({ name: `wrong message len ${msg.length}`, x: a.x, y: a.y, msg: Buffer.concat([msg, Buffer.from("!")]), sig });
    }
  }
}
const out = [];
for (const c of cases) out.push({ name: c.name, x: hex(c.x), y: hex(c.y), msg: hex(c.msg), sig: hex(c.sig), webcrypto: await webVerify(c.x, c.y, c.msg, c.sig) });
writeFileSync(new URL("./test_remote_es256_vectors.json", import.meta.url), JSON.stringify({ generator: "gen_remote_es256_vectors.mjs", node: process.version, cases: out }, null, 1) + "\n");
console.log(out.length, "cases;", out.filter((c) => c.webcrypto).length, "valid per WebCrypto");
