// A data file's versions on the sync server (version-history note r1, PR 1's page side): what the server keeps of it,
// listed under the file preview's own "Earlier versions" (preview.ts), each with Download and Restore.
//   The list: GET /api/sync/v1/versions?fid= (cloud PR #89), read only.  A version's bytes: GET /api/sync/v1/blob/<sha256>
//   (the 303 to a signed URL, followed; debited from the day's read budget as every read), checked against its SHA-256 and
//   size before anything is done with them.  Restore writes them with the workspace's own write, only over the file
//   shown, as it was shown (its fid and revision: the device versions' rule, CORR-F85-2), so the bytes it replaces are
//   kept in turn: a restore can be undone.
import type { Entry, Workspace } from "./api";

export type ServerVersion = { sha256: string; size: number; t: number; by: string; seq: number; path: string };

/** The server's versions of `e` (a synced data file, by its fid), or null where the server can't say (sync off, a
 * page without sync, an error): a list never pretends. */
export async function serverVersions(e: Pick<Entry, "kind" | "fid">, fetchImpl: typeof fetch = fetch): Promise<ServerVersion[] | null> {
  if (e.kind !== "file" || !e.fid || !/^[0-9a-f]{16}$/.test(e.fid)) return null;
  try {
    const r = await fetchImpl(`/api/sync/v1/versions?fid=${e.fid}`, { credentials: "same-origin" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j?.versions)) return null;
    return (j.versions as ServerVersion[]).filter((v) => typeof v?.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256) && Number.isSafeInteger(v.size) && v.size >= 0);
  } catch { return null; }
}

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A version's bytes from the server, exactly: its size, and its SHA-256, or an Error saying why not. */
export async function serverVersionBytes(v: Pick<ServerVersion, "sha256" | "size">, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  let r: Response;
  try { r = await fetchImpl(`/api/sync/v1/blob/${v.sha256}`, { credentials: "same-origin", redirect: "follow" }); } catch { throw new Error("the server couldn't be reached"); }
  if (r.status === 429) throw new Error("today's download allowance is used up: try again tomorrow");
  if (!r.ok) throw new Error(`the server answered ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length !== v.size || (await hex(b)) !== v.sha256) throw new Error("the bytes that came aren't that version's");
  return b;
}

/** Restore `v` over the file shown (`e`, as it was shown): the server's bytes, checked, written by the workspace. */
export async function restoreServerVersion(w: Workspace, e: Entry, v: ServerVersion, fetchImpl: typeof fetch = fetch): Promise<Entry> {
  const bytes = await serverVersionBytes(v, fetchImpl);
  return (await w.write(e.path, bytes, { base: e.rev ?? 0, fid: e.fid })).entry;
}
