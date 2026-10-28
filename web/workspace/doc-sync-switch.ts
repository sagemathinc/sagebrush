// The DEV switch for notebooks' contents (sync 2c-3's DocSync on the account connection, web/workspace/doc-sync.ts).
// It fails closed: on only if ALL of these hold, checked in this order on every page load and never cached:
//   1. this page's origin is exactly one of DOC_SYNC_ORIGINS (DEV's own; PROD's, sagebrush.space, is not, and nothing
//      at all is asked or started on any other origin);
//   2. the server says this account may sync: GET /api/sync/v1/status answers 200 with `available: true` (the
//      allowlist; PROD's site has no such route);
//   3. this page's sync client runs (signed in, sync on for this account).
// Only then does the notebook page (index.html) turn the journal on (durable for this browser's workspace: the Sync
// panel's note, DOC_SYNC_NOTE, says so), set DOC_SYNC.on and hand a DocSync to the sync owner.  The allowed origins are a
// frozen constant; tests pass their own list to these functions as an argument, so no page, URL or storage can widen it.

/** The origins notebooks' contents sync on: DEV's only. */
export const DOC_SYNC_ORIGINS: readonly string[] = Object.freeze(["https://dev.sagebrush.space"]);

/** Condition 1: `origin` is one of `allowed` exactly (by default DOC_SYNC_ORIGINS). */
export function docSyncOrigin(origin: string, allowed: readonly string[] = DOC_SYNC_ORIGINS): boolean {
  return typeof origin === "string" && allowed.includes(origin);
}

/** Condition 2: the server lets this account sync (status 200, `available: true`); anything else, false. */
export async function docSyncAvailable(origin: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const r = await fetchFn(origin + "/api/sync/v1/status", { credentials: "same-origin" });
    if (r.status !== 200) return false;
    const j = (await r.json()) as { available?: unknown } | null;
    return !!j && j.available === true;
  } catch {
    return false;
  }
}

/** The gate: conditions 1, 2 and 3 in order; false at the first that fails (and nothing after it asked). */
export async function docSyncAllowed(
  o: { origin: string; fetch: typeof fetch; clientRunning: () => Promise<boolean> },
  allowed: readonly string[] = DOC_SYNC_ORIGINS,
): Promise<boolean> {
  if (!docSyncOrigin(o.origin, allowed)) return false;
  if (!(await docSyncAvailable(o.origin, o.fetch))) return false;
  try {
    return (await o.clientRunning()) === true;
  } catch {
    return false;
  }
}

/** What the Sync panel says of notebooks while the switch is on (DEV, until 2c-4 and the PROD gate). */
export const DOC_SYNC_NOTE = [
  "Notebooks sync between your devices here (DEV only). Outputs are never synced.",
  "If the same cell is changed on two devices before they sync, the later change is kept; the other is in TimeTravel.",
  "TimeTravel shows a notebook's versions since it started syncing on this device.",
  "Clearing TimeTravel isn't available for a synced notebook.",
  "A notebook stops syncing on a device if the server restarts its history (a snapshot or a cleared history) or refuses its changes for good; its changes stay on that device.",
  "Boards don't sync yet: they save in this browser as before.",
  "Turning this on is lasting for this browser: it keeps saving notebooks through sync's journal even if notebook sync is later turned off, and an older copy of this site open in another tab can't save notebooks until it's reloaded. sagebrush.space (not DEV) is a separate site with its own storage, and isn't affected.",
] as const;
