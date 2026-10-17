// The app's web page: the notebook's files from web/dist (bun web/build.ts),
// without the Atlas, the demos or the service worker (the app's files are
// local already).
//
// Its worker fetches the Python library in chunks (web/lib-chunks.mts,
// web/lib-lazy.ts): lib/<group>.<kind>.<hash>.json, each checked against the
// SHA-256 the worker was built with.  They are copied with it, and checked
// here: every chunk the worker names must be in app/dist with that SHA-256,
// and app/dist/lib must hold nothing else, or this fails.  Without lib/, the
// app served something else for a chunk and every Sage cell failed ("not
// the chunk this worker was built with", the app workflow from 5ba5afdd on).
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const src = join(here, "..", "web", "dist");
const out = join(here, "dist");
if (!existsSync(join(src, "index.html"))) throw new Error("no web/dist: run `bun web/build.ts` first");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["index.html", "sagebrush-worker.js", "sagebrush-engine.wasm", "sagebrush-raster.wasm", "sagebrush-console.js", "sagebrush-math.js", "sagebrush-viewer3d.js", "sagebrush-history.js", "sagebrush-analyze.js", "docs-index.json", "THIRD-PARTY-NOTICES.txt", "katex", "icons", "lib"])
  cpSync(join(src, f), join(out, f), { recursive: true });
// (the other modes' documentation indexes, for the notebook's search box, where built)
for (const f of ["docs-index-python.json", "docs-index-matlab.json", "docs-index-magma.json"]) if (existsSync(join(src, f))) cpSync(join(src, f), join(out, f));
// the app's native code's notices (scripts/third-party-notices.mjs), beside the page's
cpSync(join(here, "THIRD-PARTY-NOTICES-native.txt"), join(out, "THIRD-PARTY-NOTICES-native.txt"));

// The worker's chunks, as its manifest names them ({file: "lib/...", sha256: "..."}
// in the bundle), each in app/dist with exactly that SHA-256
const worker = readFileSync(join(out, "sagebrush-worker.js"), "utf8");
const named = new Map([...worker.matchAll(/file:\s*"(lib\/[a-z0-9-]+\.(?:src|pre)\.[0-9a-f]{16}\.json)",\s*sha256:\s*"([0-9a-f]{64})"/g)].map((m) => [m[1], m[2]]));
const mentioned = new Set(worker.match(/lib\/[a-z0-9-]+\.(?:src|pre)\.[0-9a-f]{16}\.json/g) ?? []);
const bad = [];
if (named.size === 0) bad.push("the worker names no library chunk with its SHA-256 (has web/lib-lazy.ts's manifest changed shape?)");
for (const f of mentioned) if (!named.has(f)) bad.push(`${f}: the worker names it without its SHA-256`);
for (const [f, want] of named) {
  const p = join(out, f);
  if (!existsSync(p)) bad.push(`${f}: missing from app/dist`);
  else if (createHash("sha256").update(readFileSync(p)).digest("hex") !== want) bad.push(`${f}: not the bytes the worker was built with`);
}
for (const f of readdirSync(join(out, "lib"))) if (!named.has("lib/" + f)) bad.push(`lib/${f}: in app/dist but not the worker's`);
if (bad.length) {
  console.error("app/dist: the worker and its library chunks do not match:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`app/dist: the notebook page for the app (the worker's ${named.size} library chunks checked)`);
