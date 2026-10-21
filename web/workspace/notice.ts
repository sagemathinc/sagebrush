// A notice across the top of the page that this page can no longer use the
// person's files, with a Reload button: shown when a newer Sagebrush page
// upgraded the workspace's database, which closes it in older pages
// (web/workspace/db.ts).  Shown once; nothing else on the page changes, so
// what is on screen can still be read and copied.

const ID = "sagebrush-reload-notice";

export const RELOAD_TEXT = "Sagebrush was updated in another tab, so this page can't read or save your files any more. Reload it to go on; what you see here stays until you do.";

/** The notice (once per page): `text`, and Reload. */
export function showReloadNotice(text = RELOAD_TEXT): HTMLElement | null {
  const doc = (globalThis as any).document as Document | undefined;
  if (!doc?.body) return null;
  const had = doc.getElementById(ID);
  if (had) return had;
  const box = doc.createElement("div");
  box.id = ID;
  box.setAttribute("role", "alert");
  box.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 14px;background:#7a2e0e;color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)";
  const msg = doc.createElement("span");
  msg.textContent = text;
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = "Reload";
  btn.style.cssText = "font:inherit;padding:4px 14px;border-radius:4px;border:0;background:#fff;color:#7a2e0e;cursor:pointer";
  btn.onclick = () => location.reload();
  box.append(msg, btn);
  doc.body.append(box);
  return box;
}

const BUSY_ID = "sagebrush-busy-notice";
/** The closable notice gone, if it is there. */
export function hideBusyNotice() {
  (globalThis as any).document?.getElementById(BUSY_ID)?.remove();
}
/** A notice that can be closed: `text` (one at a time, replaced). */
export function showBusyNotice(text: string): HTMLElement | null {
  const doc = (globalThis as any).document as Document | undefined;
  if (!doc?.body) return null;
  doc.getElementById(BUSY_ID)?.remove();
  const box = doc.createElement("div");
  box.id = BUSY_ID;
  box.setAttribute("role", "status");
  box.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;gap:12px;align-items:center;padding:8px 14px;background:#5b4a0e;color:#fff;font:14px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.3)";
  const msg = doc.createElement("span");
  msg.textContent = text;
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = "Close";
  btn.style.cssText = "font:inherit;padding:2px 10px;border-radius:4px;border:0;background:#fff;color:#5b4a0e;cursor:pointer";
  btn.onclick = () => box.remove();
  box.append(msg, btn);
  doc.body.append(box);
  return box;
}

const LOSS_ID = "sagebrush-loss-notice";

/** The notice that this browser's copy of the workspace was lost or is missing changes (design/workspace-
 * durability.md A.2, A.3): what the record outside IndexedDB says it had, and the person's choices.  The
 * workspace stays quarantined, every change refused, until one is chosen; the page reloads after.  Also, as a
 * notice that can be closed, when a loss couldn't be detected here (storage unreadable, a witness that can't
 * be written).  Shown again, replaced, when what the page knows changes (Workspace's onDurability). */
export function showLossNotice(w: { durability: any; witnessDown?: { local?: string; opfs?: string }; resetRemoved?: number; reset?: (kind: "new" | "keep") => Promise<unknown> }): HTMLElement | null {
  const doc = (globalThis as any).document as Document | undefined;
  const d = w.durability;
  if (!doc?.body || !d) return null;
  const down = Object.values(w.witnessDown ?? {}).filter(Boolean).join("; ");
  const loss = d.state === "confirmed" || d.state === "suspected";
  // (a loss that can't be detected here: from the open, or a witness that couldn't be written since, a first save's included)
  const info = d.state === "unknown" ? d.why : d.state === "resetting" || d.state === "purging" ? d.state : d.unavailable || down || "";
  doc.getElementById(LOSS_ID)?.remove();
  if (!loss && !info) return null;
  const box = doc.createElement("div");
  box.id = LOSS_ID;
  box.setAttribute("role", "alert");
  box.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483000;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:center;padding:10px 14px;background:${loss ? "#7a2e0e" : "#5b4a12"};color:#fff;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.3)`;
  const msg = doc.createElement("span");
  const wit = d.witness;
  const when = wit ? new Date(wit.sampled).toLocaleString() : "";
  msg.textContent =
    d.state === "confirmed" ? `This browser's copy of your workspace was lost (${d.why}).${wit ? ` It had ${wit.entries} entries when last recorded, ${when}.` : ""} Nothing can be changed until you choose.`
    : d.state === "suspected" ? `Some recent changes to your workspace are missing from this browser (${d.why}).${wit ? ` Last recorded ${when}.` : ""} Nothing can be changed until you choose.`
    : d.state === "resetting" || d.state === "purging" ? `This browser's workspace is being reset: ${w.resetRemoved ?? 0} records removed so far. Nothing can be changed until it is done.`
    : `A lost workspace can't be detected in this browser (${info}).`;
  box.append(msg);
  const button = (text: string, onClick: () => unknown, sbb: string) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.dataset.sbb = sbb;
    b.style.cssText = "font:inherit;padding:4px 14px;border-radius:4px;border:0;background:#fff;color:#5b2a0e;cursor:pointer";
    b.onclick = () => onClick();
    box.append(b);
    return b;
  };
  const choice = (text: string, kind: "new" | "keep", confirmText: string) => {
    const b = button(text, async () => {
      if (!(globalThis as any).confirm?.(confirmText)) return;
      b.disabled = true;
      try { await w.reset!(kind); location.reload(); } catch (e) { msg.textContent = `Not done: ${String((e as Error)?.message ?? e)}`; b.disabled = false; }
    }, "loss-" + kind);
  };
  if (loss && w.reset) {
    if (d.state === "suspected") choice("Keep what this browser has", "keep", "Go on with what this browser has now? The missing changes stay missing.");
    choice("Start a new workspace here", "new", "Start a new, empty workspace in this browser? What it has now is deleted.");
  }
  if (!loss && d.state !== "resetting" && d.state !== "purging") button("✕", () => box.remove(), "loss-close").setAttribute("aria-label", "Close");
  doc.body.append(box);
  return box;
}

const STALE_ID = "sagebrush-stale-notice";
/** localStorage: the count and reasons the old copies' notice was closed at (it comes back if either grows). */
export const STALE_DISMISSED = "sagebrush-stale-dismissed";
type Why = "folder-full" | "limit" | "storage" | "rounds";
type Stuck = { count: number; paths: { path: string; why: Why; folder?: string }[]; reasons: Partial<Record<Why, number>> };

const files = (n: number) => (n === 1 ? "1 file" : `${n} files`);
const folderName = (f: string) => (f === "/" ? "your top folder" : f);
/** What the notice says, one sentence a reason, each true of what that reason means (migrator.ts, api.ts dropStale):
 * an old copy is deleted only after a move of exactly its bytes, so one still there was never deleted; one that
 * couldn't be kept as a file of its own holds what an older tab wrote there since the file was moved; only a
 * full folder is named. */
export function staleText(s: Stuck): string {
  const out: string[] = [];
  const n = (w: Why) => s.reasons[w] ?? 0;
  if (n("folder-full")) {
    const folders = [...new Set(s.paths.filter((p) => p.why === "folder-full" && p.folder !== undefined).map((p) => folderName(p.folder!)))];
    const where = folders.length ? folders.join(", ") : "a folder";
    out.push(`Changes a Sagebrush tab from before an update saved to ${files(n("folder-full"))} couldn't be added as files of their own, because ${where} ${folders.length > 1 ? "are" : "is"} full. They're kept in this browser, and nothing has been deleted; make room and they'll be added the next time Sagebrush starts.`);
  }
  if (n("limit")) out.push(`Changes a Sagebrush tab from before an update saved to ${files(n("limit"))} couldn't be added as files of their own: your workspace has reached one of its limits. They're kept in this browser, and nothing has been deleted.`);
  if (n("storage")) out.push(`The old copy of ${files(n("storage"))} couldn't be tidied up: an error stopped it each time. Nothing has been deleted; it's tried again each time Sagebrush starts.`);
  if (n("rounds")) out.push(`The old copy of ${files(n("rounds"))} kept changing while it was being tidied up, most likely because a Sagebrush tab from before an update is still open. Nothing has been deleted; close other Sagebrush tabs and it'll be tidied the next time Sagebrush starts.`);
  return out.join(" ");
}

/** The notice of old copies that cleanups keep leaving (Workspace.staleStuck), closable: closed, it stays closed
 * until their count rises or a new reason appears; none left, it goes, and so does what it was closed at. */
export async function showStaleNotice(w: { staleStuck(): Promise<Stuck | undefined> }, store: Storage | undefined = (globalThis as any).localStorage): Promise<HTMLElement | null> {
  const doc = (globalThis as any).document as Document | undefined;
  const s = await w.staleStuck().catch(() => undefined);
  doc?.getElementById(STALE_ID)?.remove();
  if (!s || !s.count) {
    try { store?.removeItem(STALE_DISMISSED); } catch {}
    return null;
  }
  let was: { count?: number; reasons?: Partial<Record<Why, number>> } | null = null;
  try { was = JSON.parse(store?.getItem(STALE_DISMISSED) ?? "null"); } catch {}
  const newReason = (Object.keys(s.reasons) as Why[]).some((r) => (s.reasons[r] ?? 0) > 0 && !((was?.reasons?.[r] ?? 0) > 0));
  if (was && typeof was.count === "number" && s.count <= was.count && !newReason) return null;
  if (!doc?.body) return null;
  const box = doc.createElement("div");
  box.id = STALE_ID;
  box.setAttribute("role", "status");
  box.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;gap:12px;align-items:center;max-width:min(720px,94vw);padding:8px 14px;background:#5b4a0e;color:#fff;font:14px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.3)";
  const msg = doc.createElement("span");
  msg.textContent = staleText(s);
  msg.title = s.paths.map((p) => p.path).join("\n");
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.textContent = "Close";
  btn.dataset.sbb = "stale-close";
  btn.style.cssText = "font:inherit;padding:2px 10px;border-radius:4px;border:0;background:#fff;color:#5b4a0e;cursor:pointer";
  btn.onclick = () => {
    try { store?.setItem(STALE_DISMISSED, JSON.stringify({ count: s.count, reasons: s.reasons })); } catch {}
    box.remove();
  };
  box.append(msg, btn);
  doc.body.append(box);
  return box;
}
