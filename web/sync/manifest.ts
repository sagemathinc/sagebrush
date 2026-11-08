// Chunked files' manifests (design/tiered-files.md §4.1, §4.3): their form,
// their bounds, and their canonical JSON.  Behind the tiered-files switch
// (env.ts tieredOn), which is off unless bound, and bound only on DEV.

import { SyncError, isSha, fields } from "../sync-protocol/protocol.ts";

export const MiB = 1 << 20;
/** The chunker's name and parameters (§4.1): a new name for any change. */
export const CDC_NAMES: ReadonlySet<string> = new Set(["fastcdc-gear-v1/1M/4M/8M"]);
export const TIERED = {
  /** chunks per manifest: 200 MiB at the 1 MiB minimum, raised only with the file limit (§6) */
  chunks: 256,
  /** a manifest's encoded size, in UTF-8 bytes (§6) */
  manifestBytes: 32 << 10,
  chunkMin: 1 * MiB,
  chunkMax: 8 * MiB,
  /** the workspace's own file limit, LIMITS.maxFileBytes on the client (§4) */
  fileBytes: 200 * MiB,
  /** chunks one verify call streams (§4.1, step 5) */
  verifyChunks: 8,
  /** verification bytes a day per account when CoCalc sends none (§6, daybreak2's LIMIT-TF-8) */
  verifyBytesPerDay: 16 * 1024 * MiB,
  /** the least a verify call debits from the daily verification meter, whatever it streams: so the calls an account can
   * start a day are at most verify_bytes_per_day / this (256 at 16 GiB), each with at most 8 R2 gets (the coordinator's
   * final #880 ruling) */
  verifyDebitFloor: 64 * MiB,
  /** how long an unused registration is held (§4.3): renewed by registering again */
  holdMs: 86400_000,
  /** rows the alarm retires a step (§5.1) */
  retirePage: 16,
};

export interface Manifest { v: 1; cdc: string; sha256: string; size: number; chunks: [string, number][] }

/**
 * A manifest as sent, checked (§4.1): its form, its bounds, sizes that add
 * up, and every chunk within the chunker's bounds except the last, which may
 * be shorter.  Returns it with only its own fields, so its JSON is canonical.
 */
export function checkManifest(v: unknown, maxFileBytes: number): Manifest {
  const o = fields(v, ["v", "cdc", "sha256", "size", "chunks"], "manifest");
  if (o.v !== 1) throw new SyncError("invalid", "manifest: v");
  if (typeof o.cdc !== "string" || !CDC_NAMES.has(o.cdc)) throw new SyncError("invalid", "manifest: an unknown chunker", { cdc: typeof o.cdc === "string" ? o.cdc.slice(0, 64) : null });
  if (!isSha(o.sha256)) throw new SyncError("invalid", "manifest: sha256");
  if (!Number.isSafeInteger(o.size) || (o.size as number) <= TIERED.chunkMax) throw new SyncError("invalid", "manifest: a chunked file is larger than its largest chunk");
  const size = o.size as number;
  if (!Array.isArray(o.chunks) || o.chunks.length < 2) throw new SyncError("invalid", "manifest: chunks");
  if (o.chunks.length > TIERED.chunks) throw new SyncError("limit", "too many chunks", { limit: "chunks", max: TIERED.chunks });
  if (size > Math.min(maxFileBytes, TIERED.fileBytes)) throw new SyncError("limit", "this file is too large", { limit: "max_file_bytes", max: Math.min(maxFileBytes, TIERED.fileBytes) });
  const chunks: [string, number][] = [];
  let total = 0;
  o.chunks.forEach((c, i) => {
    if (!Array.isArray(c) || c.length !== 2 || !isSha(c[0]) || !Number.isSafeInteger(c[1])) throw new SyncError("invalid", "manifest: chunk " + i);
    const n = c[1] as number;
    const last = i === (o.chunks as unknown[]).length - 1;
    if (n > TIERED.chunkMax || n < 1 || (!last && n < TIERED.chunkMin)) throw new SyncError("invalid", "manifest: chunk " + i + " is outside the chunker's bounds");
    total += n;
    chunks.push([c[0], n]);
  });
  if (total !== size) throw new SyncError("invalid", "manifest: the chunks' sizes don't add up to size");
  const m: Manifest = { v: 1, cdc: o.cdc, sha256: o.sha256, size, chunks };
  if (new TextEncoder().encode(canonical(m)).length > TIERED.manifestBytes) throw new SyncError("limit", "this manifest is too large", { limit: "manifest_bytes", max: TIERED.manifestBytes });
  return m;
}

/** A checked manifest's canonical JSON: its fields in one order, no spaces. */
export function canonical(m: Manifest): string {
  return JSON.stringify({ v: m.v, cdc: m.cdc, sha256: m.sha256, size: m.size, chunks: m.chunks });
}

/** SHA-256 of a string's UTF-8 bytes, as hex. */
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
