// A minimal S3 client for R2 (AWS Signature Version 4), for the engine publisher only (scripts/engine-publish.mjs):
// HEAD, GET and PUT of one object, path-style.  No dependency: node's crypto.  (The hosted service's deploy scripts'
// client, byte for byte apart from this header.)
//   const s3 = makeS3({ endpoint, bucket, accessKeyId, secretAccessKey, region: "auto", fetch })
//   await s3.head(key) -> { status, size }; await s3.get(key) -> { status, body }; await s3.put(key, bytes, type) -> { status }
// The secret is used only to derive the signing key; nothing here prints a header, a key or a signature.
import { createHash, createHmac } from "node:crypto";

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, s) => createHmac("sha256", k).update(s).digest();
// (RFC 3986 unreserved stay; every other byte %XX; "/" kept in the path)
const enc = (s, keepSlash) => Array.from(Buffer.from(s, "utf8")).map((c) => {
  const ch = String.fromCharCode(c);
  return /[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === "/") ? ch : "%" + c.toString(16).toUpperCase().padStart(2, "0");
}).join("");

// The Authorization header for one request (exported for the AWS test vector)
export function sign({ method, host, path, query = {}, headers = {}, payloadHash, accessKeyId, secretAccessKey, region, service = "s3", amzDate }) {
  const date = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(h).sort();
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(String(query[k]))}`).join("&");
  const canonical = [method, enc(path, true), canonicalQuery, names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${signature}`, headers: h };
}

export const KEY = /^(?:lib|engine)\/[A-Za-z0-9._\/-]+$/;

export function makeS3({ endpoint, bucket, accessKeyId, secretAccessKey, region = "auto", fetch = globalThis.fetch, now = () => new Date() }) {
  const u = new URL(endpoint);
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search) throw new Error("the S3 endpoint must be https://host/ only");
  if (!/^[a-z0-9-]+$/.test(bucket)) throw new Error("bad bucket name");
  async function call(method, key, body = null, extra = {}) {
    if (!KEY.test(key) || key.split("/").some((p) => p === "" || p === "." || p === "..")) throw new Error(`refused object key ${JSON.stringify(key)}`);
    const path = `/${bucket}/${key}`;
    const payloadHash = sha256hex(body ?? "");
    const amzDate = now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const { authorization, headers } = sign({ method, host: u.host, path, headers: extra, payloadHash, accessKeyId, secretAccessKey, region, amzDate });
    const { host, ...send } = headers;
    return fetch(`https://${u.host}${enc(path, true)}`, { method, headers: { ...send, authorization }, body: body ?? undefined });
  }
  return {
    async head(key) {
      const r = await call("HEAD", key);
      return { status: r.status, size: r.headers.get("content-length") === null ? null : Number(r.headers.get("content-length")) };
    },
    async get(key) {
      const r = await call("GET", key);
      return { status: r.status, body: r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null };
    },
    async put(key, bytes, contentType) {
      const r = await call("PUT", key, bytes, { "content-type": contentType });
      return { status: r.status };
    },
  };
}
