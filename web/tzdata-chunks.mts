// The pinned zone data for the browser (tzdata/, scripts/tzdata-import.mjs),
// as engine files: each zone file by its content's SHA-256
// (lib/tzdata/<sha256>.tzif: zones whose files are the same share one), and an
// index, zone name -> that SHA-256 (lib/tzdata/index-<sha256>.json; under lib/, a
// published engine's are kept, as the library's chunks are: web/engines.ts). The worker's
// library manifest carries only the index's reference (web/lib-chunks.mts's
// LibManifest.tzdata); the browser's time module (lib/_pytime.py) fetches the
// index and its own zone's file the first time it is imported, each checked
// against its SHA-256 (web/lib-lazy.ts, as the library's chunks are).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ChunkRef } from "./lib-chunks.mts";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f), st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p}: a symbolic link`);
    if (st.isDirectory()) walk(p, base, out);
    else if (st.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

/** The engine files (name -> bytes) and the index's reference, for the
 * repository at root. */
export function tzdataChunks(root: string): { ref: ChunkRef & { version: string }; files: Map<string, Uint8Array> } {
  const source = JSON.parse(readFileSync(join(root, "tzdata", "source.json"), "utf8"));
  const zoneDir = join(root, "tzdata", "zoneinfo");
  const files = new Map<string, Uint8Array>();
  const zones: Record<string, string> = {};
  for (const name of walk(zoneDir)) {
    const bytes = readFileSync(join(zoneDir, name));
    const h = sha256(bytes);
    zones[name] = h;
    files.set(`lib/tzdata/${h}.tzif`, bytes);
  }
  if (Object.keys(zones).length !== source.zones) throw new Error(`tzdata/: ${Object.keys(zones).length} zone files, not the ${source.zones} of tzdata ${source.version} (node scripts/tzdata-import.mjs --check)`);
  const index = new TextEncoder().encode(JSON.stringify({ format: "sagebrush-tzdata", version: source.version, zones }));
  const ih = sha256(index);
  const file = `lib/tzdata/index-${ih}.json`;
  files.set(file, index);
  return { ref: { file, sha256: ih, size: index.length, version: source.version }, files };
}
