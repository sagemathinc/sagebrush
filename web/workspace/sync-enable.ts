// Sync turned on from a page that asks its own consent first (the account copy's assignment page): the Sync panel's
// own enable, without its confirm and words, which that page's consent screen replaces; and the two reads that screen
// needs.  Each step is the panel's: the lifecycle read first and applied only if it is still the one (compare-and-set),
// old sync state refused, the account bound to the session's, the lease taken, every tab told.
import type { Workspace } from "./api";
import type { SyncOwner } from "./sync-owner";
import { switchToIf } from "./sync-outbox";
import { readLife } from "./sync-pins";
import { askStatus } from "./sync-panel";
import { OldSyncError } from "./sync-old";

export type EnableResult = { ok: true } | { ok: false; why: "refused" | "unavailable" | "network" | "signedout" | "old" | "changed"; message?: string };

/** Turns sync on in this browser for the signed-in account, as the Sync panel's Turn on does once its confirm is
 * answered: only after the person has agreed, on the caller's own screen. */
export async function enableSync(w: Workspace, owner: SyncOwner, o: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<EnableResult> {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const mark = await readLife(w);
  if ((await owner.checkOld()).old) return { ok: false, why: "old", message: "this browser synced with an older version of Sagebrush" };
  const st = await askStatus(f, o.signal ?? new AbortController().signal);
  if (!st.ok) return { ok: false, why: st.why === "network" ? "network" : st.why === "http" && st.code === 401 ? "signedout" : "unavailable" };
  if (!st.status.available) return { ok: false, why: "unavailable", message: st.status.reason };
  if (!st.account) return { ok: false, why: "signedout" };
  let r: Response;
  try {
    r = await f("/api/sync/v1/enable", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: st.account }), signal: o.signal });
  } catch {
    return { ok: false, why: "network" };
  }
  const body = (await r.json().catch(() => ({}))) as { generation?: number; error?: string; message?: string };
  if (r.status === 401) return { ok: false, why: "signedout" };
  if (r.status === 409 && body.error === "account_mismatch") return { ok: false, why: "changed", message: "signed in as another account meanwhile" };
  if (!r.ok || !Number.isSafeInteger(body.generation)) return { ok: false, why: "refused", message: body.message ?? body.error ?? String(r.status) };
  let lease;
  try {
    lease = await switchToIf(w, `${st.account}:${body.generation}:${w.device}`, mark);
  } catch (e) {
    if (!(e instanceof OldSyncError)) throw e;
    void owner.checkOld();
    return { ok: false, why: "old", message: "this browser synced with an older version of Sagebrush" };
  }
  if (!lease) return { ok: false, why: "changed", message: "this browser's sync changed meanwhile (another tab)" };
  owner.nudge("on");
  return { ok: true };
}

/** This browser's workspace: its data files, as the Sync panel's confirm counts them (what turning sync on uploads). */
export async function localUsage(w: Workspace): Promise<{ files: { count: number; bytes: number } }> {
  const u = await w.usage();
  return { files: { count: u.files.count, bytes: u.files.bytes } };
}

/** Whether sync is on in this browser for the signed-in account: the owner's lifecycle, reconciled first. */
export async function syncOnHere(owner: SyncOwner): Promise<boolean> {
  try {
    await owner.reconcile();
    return !!owner.lifecycle() && !!(await owner.durable());
  } catch {
    return false;
  }
}
