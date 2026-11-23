#!/usr/bin/env node
// Publish one built engine (web/dist/engine/<id>/: manifest.json and its files) to R2's sagebrush-releases, where the
// site's Worker serves it at /engine/<id>/ (web/engines.ts, design/engines.md).  Run by .github/workflows/
// engine-publish.yml's publish job only, on the build job's artifact, in the wasm-publish environment.
//   1. every manifest entry is validated before any request: a safe relative key, a regular file of exactly the
//      manifest's size and sha256, a content type;
//   2. the published engine/<id>/manifest.json is read FIRST: another manifest there refuses before any write; this
//      one there means the engine is published (only missing lib/ objects are put);
//   3. lib/ objects (content-named, shared by every engine): one there with this size is kept; one there with
//      ANOTHER size refuses, never overwritten;
//   4. the engine's own files, then its manifest LAST, so an engine is served only once all of it is in;
//   5. the manifest is read back and must be this one, byte for byte.
// Prints keys and counts, never a credential.
//   publishEngine({ dir, s3, log }) -> { id, uploaded, kept }
//   node scripts/engine-publish.mjs <engine-dir>   (env R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: the
//                                                   wasm-publish environment's, as scripts/wasm-publish.mjs reads them)
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { makeS3 } from "./engine-s3.mjs";

export const BUCKET = "sagebrush-releases";
// (as web/engines.ts's SHARED: the zone data's files are kept only at lib/tzdata/, never under engine/<id>/)
export const SHARED = /^lib\/tzdata\/(?:index-)?[0-9a-f]{64}\.(?:tzif|json)$/;
const FILE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ID = /^[0-9a-f]{20}$/;
const sha = (b) => createHash("sha256").update(b).digest("hex");

export function validate(dir) {
  const manBytes = readFileSync(join(dir, "manifest.json"));
  const man = JSON.parse(manBytes.toString("utf8"));
  if (!ID.test(man?.id ?? "")) throw new Error(`the manifest's id isn't 20 hex digits: ${JSON.stringify(man?.id)}`);
  const files = man.files;
  if (!files || typeof files !== "object" || Array.isArray(files) || !Object.keys(files).length) throw new Error("the manifest lists no files");
  const bytes = new Map();
  for (const [f, m] of Object.entries(files)) {
    if (!FILE.test(f) || f.split("/").some((p) => p === "." || p === "..") || f === "manifest.json") throw new Error(`unsafe manifest entry ${JSON.stringify(f)}`);
    if (!Number.isSafeInteger(m?.size) || !/^[0-9a-f]{64}$/.test(m?.sha256 ?? "") || typeof m?.headers?.["Content-Type"] !== "string") throw new Error(`manifest entry ${f} lacks size, sha256 or Content-Type`);
    const st = lstatSync(join(dir, f));
    if (!st.isFile()) throw new Error(`${f} isn't a regular file`);
    const b = readFileSync(join(dir, f));
    if (b.length !== m.size || sha(b) !== m.sha256) throw new Error(`${f} doesn't match its manifest entry`);
    bytes.set(f, b);
  }
  return { id: man.id, man, manBytes, bytes };
}

export async function publishEngine({ dir, s3, log = console.log }) {
  const { id, man, manBytes, bytes } = validate(dir);
  const got = await s3.get(`engine/${id}/manifest.json`);
  let published = false;
  if (got.status === 200) {
    let same = false;
    try { same = isDeepStrictEqual(JSON.parse(got.body.toString("utf8")), man); } catch {}
    if (!same) throw new Error(`engine ${id} is published with ANOTHER manifest: refusing to write anything`);
    published = true;
  } else if (got.status !== 404) throw new Error(`couldn't tell whether engine ${id} is published (GET ${got.status})`);
  const lib = Object.keys(man.files).filter((f) => f.startsWith("lib/"));
  const want = [];
  for (const f of lib) {
    const h = await s3.head(f);
    if (h.status === 200) {
      if (h.size !== man.files[f].size) throw new Error(`${f} is in the bucket with ANOTHER size (${h.size}, not ${man.files[f].size}): refusing to overwrite it`);
    } else if (h.status === 404) want.push(f);
    else throw new Error(`HEAD ${f}: ${h.status}`);
  }
  let uploaded = 0;
  const put = async (key, b, type) => {
    const r = await s3.put(key, b, type);
    if (r.status !== 200) throw new Error(`PUT ${key}: ${r.status}`);
    uploaded++;
  };
  for (const f of want) await put(f, bytes.get(f), man.files[f].headers["Content-Type"]);
  if (published) {
    log(`engine ${id} is already published with this manifest (${want.length} missing lib objects put)`);
    return { id, uploaded, kept: lib.length - want.length };
  }
  for (const f of Object.keys(man.files).filter((f) => !SHARED.test(f))) await put(`engine/${id}/${f}`, bytes.get(f), man.files[f].headers["Content-Type"]);
  await put(`engine/${id}/manifest.json`, manBytes, "application/json");
  // (read back: what is served now is this manifest, byte for byte)
  const back = await s3.get(`engine/${id}/manifest.json`);
  if (back.status !== 200 || !Buffer.from(back.body ?? []).equals(manBytes)) throw new Error(`engine ${id}'s manifest didn't read back as written (GET ${back.status})`);
  log(`engine ${id} published: ${uploaded} objects put, ${lib.length - want.length} lib objects already there; its manifest read back`);
  return { id, uploaded, kept: lib.length - want.length };
}

export function s3FromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  for (const k of ["R2_ACCOUNT_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) if (!env[k]) throw new Error(`${k} isn't set`);
  if (!/^[0-9a-f]{32}$/.test(env.R2_ACCOUNT_ID)) throw new Error("R2_ACCOUNT_ID isn't an account id");
  return makeS3({ endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/`, bucket: BUCKET, accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, fetch: fetchImpl });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir] = process.argv.slice(2);
  try {
    if (!dir) throw new Error("usage: node scripts/engine-publish.mjs <engine-dir>");
    await publishEngine({ dir, s3: s3FromEnv() });
  } catch (err) {
    console.error(`FAILED: ${err.message}`);
    process.exit(1);
  }
}
