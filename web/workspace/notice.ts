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
