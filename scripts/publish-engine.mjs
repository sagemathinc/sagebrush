#!/usr/bin/env node
// Publish the engine web/build.ts made (web/dist/engine/<id>/) to R2, where
// the site's Worker serves it at sagebrush.space/engine/<id>/ forever
// (web/engines.ts, design/engines.md).  An engine already there is left as
// it is (its files never change) if its manifest is this one; if it isn't
// (an id is its manifest's content, web/engine-id.mts, so it can't be),
// this fails loudly rather than leave the old one served (SEC-CAC-2).  The
// manifest goes last, so an engine is served only once all its files are in.  Run before deploying the site
// (whose /engine/latest.json then names this engine).
//
//   node scripts/publish-engine.mjs           what it would do
//   node scripts/publish-engine.mjs --apply   do it (the cf CLI, logged in)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const BUCKET = "sagebrush-releases";
// (as web/engines.ts's SHARED)
const SHARED = /^lib\/tzdata\/(?:index-)?[0-9a-f]{64}\.(?:tzif|json)$/;
const { id } = JSON.parse(readFileSync(join(root, "web/dist/engine/latest.json"), "utf8"));
const dir = join(root, "web/dist/engine", id);
const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const env = { ...process.env, NO_COLOR: "1", CF_SEND_TELEMETRY: "false" };
const cf = (...args) => execFileSync("cf", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });

// Which of the keys wanted are already in R2 (key -> size), a page of its
// listing of prefix at a time.  lib/ is never cleared, so its listing grows
// with every build's chunks: only the wanted keys are kept, the listing ends
// once all are found, and after LIST_PAGES pages or LIST_MS it stops: a key
// not seen by then is uploaded again, which is safe (a key is its content's
// hash), HARD-TZU-1.
const LIST_PAGES = 20, LIST_MS = 120_000;
function listed(prefix, wanted) {
  const have = new Map(), t0 = Date.now();
  for (let after = null, pages = 0; have.size < wanted.size && pages < LIST_PAGES && Date.now() - t0 < LIST_MS; pages++) {
    const page = JSON.parse(cf("r2", "objects", "list", "--bucket-name", BUCKET, "--prefix", prefix, "--per-page", "1000", ...(after ? ["--start-after", after] : [])));
    for (const o of page) if (wanted.has(o.key)) have.set(o.key, o.size);
    if (page.length < 1000) break;
    after = page[page.length - 1].key;
  }
  return have;
}

// (the Python library's chunks also at lib/<name>, one namespace by content
// that is never cleared, where the site's Worker finds a chunk a deploy took
// out of the site's own lib/ for a page opened before it: web/engines.ts
// handleLibChunk.  An existing one has these bytes: its name is its hash, so
// one there with this size is not uploaded again.  The pinned zone data's
// files (lib/tzdata/, web/tzdata-chunks.mts) are kept only here: the Worker
// serves an engine's from these, so each is uploaded once, not with every
// engine.  First, so an engine published before this was added gets them too.)
const have = listed("lib/", new Set(Object.keys(man.files).filter((f) => f.startsWith("lib/"))));
let kept = 0;
for (const f of Object.keys(man.files).filter((f) => f.startsWith("lib/"))) {
  if (have.get(f) === man.files[f].size) { kept++; continue; }
  console.log(`${apply ? "upload" : "would upload"} ${f}`);
  if (apply) cf("r2", "objects", "put", f, "--bucket-name", BUCKET, "--file", join(dir, f), "--content-type", man.files[f].headers["Content-Type"]);
}
console.log(`(${kept} of the library's files are there already)`);
// (absent only when R2 says so: any other failure stops here)
let published = null;
try {
  published = cf("r2", "objects", "get", `engine/${id}/manifest.json`, "--bucket-name", BUCKET);
} catch (e) {
  if (!/\[10007\]|specified key does not exist/.test(String(e?.stderr ?? ""))) {
    console.error(`could not tell whether engine ${id} is published:\n${String(e?.stderr ?? e).slice(-2000)}`);
    process.exit(1);
  }
}
if (published !== null) {
  let same = false;
  try { same = isDeepStrictEqual(JSON.parse(published), man); } catch {}
  if (!same) {
    console.error(`engine ${id} is published with ANOTHER manifest: not overwriting it.  Compare engine/${id}/manifest.json in ${BUCKET} with ${join(dir, "manifest.json")}.`);
    process.exit(1);
  }
  console.log(`engine ${id} is already published, with this manifest`);
  process.exit(0);
}
// (not the zone data: the Worker serves an engine's from lib/tzdata/)
const files = [...Object.keys(man.files).filter((f) => !SHARED.test(f)), "manifest.json"];
for (const f of files) {
  const type = f === "manifest.json" ? "application/json" : man.files[f].headers["Content-Type"];
  console.log(`${apply ? "upload" : "would upload"} engine/${id}/${f} (${type})`);
  if (apply) cf("r2", "objects", "put", `engine/${id}/${f}`, "--bucket-name", BUCKET, "--file", join(dir, f), "--content-type", type);
}
console.log(apply ? `engine ${id} published` : "(a dry run: --apply to upload)");
