// For test_remote_enroll.py: Node's own answers about the runner's native ES256 (engine/py/src/remote.rs), so the
// runner's keys and signatures are checked against an independent implementation.  stdin: one JSON array of cases,
// {d?, jwk, msg (hex), sig (base64url, r || s)}; stdout: one JSON array of {pub (Node's public point for d, hex x || y,
// when d is given), ok (WebCrypto's verdict on sig)}.  Node >= 20.
import { webcrypto, createECDH } from "node:crypto";
const { subtle } = webcrypto;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const out = [];
for (const c of JSON.parse(input)) {
  const r = {};
  if (c.d) {
    const e = createECDH("prime256v1");
    e.setPrivateKey(Buffer.from(c.d, "hex"));
    r.pub = e.getPublicKey("hex", "uncompressed").slice(2);
  }
  const k = await subtle.importKey("jwk", c.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  r.ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, Buffer.from(c.sig, "base64url"), Buffer.from(c.msg, "hex"));
  out.push(r);
}
process.stdout.write(JSON.stringify(out) + "\n");
