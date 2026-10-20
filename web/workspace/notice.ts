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

const LOSS_ID = "sagebrush-loss-notice";

/** The notice that this browser's copy of the workspace was lost or is missing changes (design/workspace-
 * durability.md A.2, A.3): what the record outside IndexedDB says it had, and the person's choices.  The
 * workspace stays quarantined, every change refused, until one is chosen; the page reloads after.  Also, as a
 * notice that can be closed, when a loss couldn't be detected here (storage unreadable, a witness that can't
 * be written).  Shown again, replaced, when what the page knows changes (Workspace's onDurability). */
export function showLossNotice(w: { durability: any; witnessDown?: { local?: string; opfs?: string }; reset?: (kind: "new" | "keep") => Promise<unknown> }): HTMLElement | null {
  const doc = (globalThis as any).document as Document | undefined;
  const d = w.durability;
  if (!doc?.body || !d) return null;
  const down = Object.values(w.witnessDown ?? {}).filter(Boolean).join("; ");
  const loss = d.state === "confirmed" || d.state === "suspected";
  // (a loss that can't be detected here: from the open, or a witness that couldn't be written since, a first save's included)
  const info = d.state === "unknown" ? d.why : d.state === "resetting" ? "" : d.unavailable || down || "";
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
  if (!loss) button("✕", () => box.remove(), "loss-close").setAttribute("aria-label", "Close");
  doc.body.append(box);
  return box;
}
