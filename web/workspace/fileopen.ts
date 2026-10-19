// The File menu's Recent and Open… (design/workspace-files.md §3; the menu
// itself is filemenu.ts): the documents opened lately, both kinds, both
// pages; and the file browser as a dialog.
import type { Workspace, Entry } from "./api";
import { mountBrowser } from "./browser";
import { nameOf } from "./paths";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

// --------------------------------------------------------- recently opened
const RECENT_KEY = "sagebrush-recent-opened", RECENT_MAX = 8;
type Opened = { kind: "notebook" | "board"; ref: string };
/** A document opened here: first in Recent (both pages, both kinds; the last 8). */
export function recordOpened(o: Opened) {
  try {
    const l: Opened[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    const next = [o, ...(Array.isArray(l) ? l : []).filter((x) => x && !(x.kind === o.kind && x.ref === o.ref))].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}
/** The documents opened lately that are still in the workspace (not in Trash), newest first. */
export async function recentOpened(ws: Workspace, except?: Opened): Promise<Entry[]> {
  let l: Opened[] = [];
  try { l = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch {}
  const out: Entry[] = [];
  for (const o of Array.isArray(l) ? l.slice(0, RECENT_MAX) : []) {
    if (!o || (except && o.kind === except.kind && o.ref === except.ref)) continue;
    const p = await ws.pathOf(o.kind, o.ref).catch(() => undefined);
    const e = p ? await ws.stat(p).catch(() => undefined) : undefined;
    if (e && !e.trashed && !p!.startsWith("/Trash/")) out.push(e);
  }
  return out;
}
export const recentLabel = (e: Entry) => nameOf(e.path);

// ----------------------------------------------------------- Open… dialog
/** The file browser as a dialog (File ▸ Open…): choosing a document opens it (the page's `open`), and closes the dialog. */
export function openFilesDialog(ws: Workspace, open: (e: Entry, how: "here" | "tab") => void, current?: () => { kind: "notebook" | "board"; ref: string } | undefined) {
  document.querySelectorAll(".sbfopen").forEach((d) => (d as any).sbClose?.());
  const root = el("div");
  root.className = "sbfopen";
  root.style.cssText = "position:fixed;inset:0;z-index:900;background:rgba(20,24,21,.38);display:flex;align-items:center;justify-content:center";
  const box = el("div");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", "Open");
  box.style.cssText = "width:min(560px,calc(100vw - 24px));height:min(640px,calc(100vh - 48px));border-radius:10px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,.25);display:flex";
  root.append(box);
  let b: ReturnType<typeof mountBrowser> | null = null;
  const close = () => { if (!root.isConnected) return; b?.destroy(); root.remove(); removeEventListener("keydown", esc, true); };
  const esc = (ev: KeyboardEvent) => { if (ev.key === "Escape" && !document.querySelector(".sbfmenu, .sbfprev")) { ev.stopPropagation(); close(); } };
  (root as any).sbClose = close;
  root.onpointerdown = (ev) => { if (ev.target === root) close(); };
  addEventListener("keydown", esc, true);
  document.body.append(root);
  b = mountBrowser(box, { ws, current, open: (e, how) => { close(); open(e, how); }, close });
  b.el.style.flex = "1";
  (b.el.querySelector(".fsearch") as HTMLInputElement | null)?.focus();
  return { close };
}
