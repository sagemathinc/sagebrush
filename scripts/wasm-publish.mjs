#!/usr/bin/env node
// Publish this run's four modules to the release bucket (design/wasm-artifacts.md section 5).  Run only by CI's
// wasm-publish job, on a master push or a dispatch on master, in the wasm-publish environment.
//
//   node scripts/wasm-publish.mjs <artifact dir>
//
// The artifact must be this run's and match wasm/pins.json exactly.  For each module, a bounded GET of its key:
//   - present: its length and sha256 must match the pin; a key that doesn't fails the job and is never overwritten;
//   - absent (404): upload it with a conditional write (only if the key doesn't exist), then read it back from the
//     public domain (past any cached 404) and check it.
// It succeeds only when every key has been read back and matches.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES, ROOT, loadPins } from "./wasm-modules.mjs";
import { DEFAULT_BASE, LIMITS, download } from "./wasm-fetch.mjs";
import { policy, readArtifact } from "./wasm-artifact.mjs";

export const BUCKET = "sagebrush-releases";
export const keyOf = (sha) => `wasm/sha256/${sha}.wasm`;

// The conditional write, with the aws CLI against R2.  Returns "written" or "exists" (the key appeared meanwhile:
// the read-back decides); throws on anything else.  (spawn: spawnSync, or the self-test's stand-in)
export function awsPut(key, bytes, env = process.env, spawn = spawnSync) {
  for (const v of ["R2_ACCOUNT_ID", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) if (!env[v]) throw new Error(`wasm-publish: ${v} is not set`);
  const dir = mkdtempSync(join(tmpdir(), "wasm-put-"));
  try {
    const body = join(dir, "body.wasm");
    writeFileSync(body, bytes);
    const r = spawn("aws", ["s3api", "put-object", "--bucket", BUCKET, "--key", key, "--body", body,
      "--content-type", "application/wasm", "--cache-control", "public, max-age=31536000, immutable", "--if-none-match", "*",
      "--endpoint-url", `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, "--region", "auto", "--output", "json"],
      { encoding: "utf8", env: { ...env, AWS_DEFAULT_REGION: "auto" }, timeout: 120_000 });
    if (r.status === 0) return "written";
    if (/PreconditionFailed|412/.test(r.stderr)) return "exists";
    throw new Error(`aws s3api put-object ${key}: exit ${r.status ?? r.signal}: ${r.stderr.trim().slice(0, 500)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function publish(dir, { root = ROOT, base = DEFAULT_BASE, put = awsPut, limits = LIMITS, env = process.env, log = (s) => console.log(s) } = {}) {
  const { manifest, bytes } = readArtifact(dir, { env });
  policy(manifest.modules, { root, env }); // all four must equal the pins: no fresh build is ever published
  const pins = loadPins(root);
  const never = new AbortController().signal;
  const results = [];
  for (const name of MODULES) {
    const pin = pins[name], url = base + `${pin.sha256}.wasm`;
    let state;
    try {
      await download(url, pin, limits, never, log);
      state = "already published";
    } catch (e) {
      if (!/^404/.test(e.message ?? "")) throw new Error(`${name}: ${url}: ${e.message}${/match|more than/.test(e.message) ? " (the key holds other bytes: it is never overwritten; investigate)" : ""}`);
      const how = put(keyOf(pin.sha256), bytes[name], env);
      // the read-back: a query string the CDN hasn't seen, so a cached 404 can't answer it
      const back = `${url}?published=${env.GITHUB_RUN_ID ?? "local"}-${Date.now()}`;
      try {
        await download(back, pin, limits, never, log);
      } catch (e2) {
        throw new Error(`${name}: uploaded (${how}), but the read-back of ${back} failed: ${e2.message}`);
      }
      state = how === "written" ? "uploaded and read back" : "written meanwhile by another run; read back";
    }
    log(`${name}: ${state} (${pin.bytes} bytes, sha256 ${pin.sha256})`);
    results.push({ name, state });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/wasm-publish.mjs <artifact dir>");
    process.exit(2);
  }
  try {
    await publish(dir);
    console.log("wasm-publish: all four modules are published and read back");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
