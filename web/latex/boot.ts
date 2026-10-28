// The LaTeX editor's entry from the notebook page (index.html), built only when __SB_LATEX__ is true (plan sbspace
// r5 §2; web/build.ts, SAGEBRUSH_LATEX_PREVIEW). It is on only on an allowed host (dev.sagebrush.space exactly; the
// loopback hosts too in a "test" build), and then only with ?latex=1 or localStorage["sagebrush-latex-preview"] ===
// "1". Nothing else (a document, its metadata, another URL parameter) can turn it on. On, it installs the two hooks
// the file browser and the preview call (__sbLatexOpen, __sbLatexPreview) and, for /?tex=<fid>, mounts the page
// (dist/sagebrush-latex.js, fetched only then). Off with ?tex=: a one-line note, never a blank page.
import type { Workspace, Entry } from "../workspace/api";

declare const __SB_LATEX_HOSTS__: string[];
const HOSTS: readonly string[] = Object.freeze(typeof __SB_LATEX_HOSTS__ !== "undefined" ? __SB_LATEX_HOSTS__ : ["dev.sagebrush.space"]);
const KEY = "sagebrush-latex-preview";

/** Whether the editor is on here: the host exactly, then the URL flag or the stored one. */
export function latexOn(loc: { hostname: string; search: string }, read: () => string | null, hosts: readonly string[] = HOSTS): { on: boolean; byUrl: boolean } {
  if (!hosts.includes(loc.hostname)) return { on: false, byUrl: false };
  const byUrl = new URLSearchParams(loc.search).get("latex") === "1";
  let stored = false;
  try { stored = read() === "1"; } catch { /* no storage: off unless the URL says */ }
  return { on: byUrl || stored, byUrl };
}

const isTex = (p: string) => /\.tex$/i.test(p);
const note = (text: string) => {
  const d = document.createElement("div");
  d.setAttribute("role", "status");
  d.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:20;background:#fff4d6;border:1px solid #e3c96b;padding:6px 12px;font:14px system-ui,sans-serif;border-radius:4px";
  d.textContent = text;
  document.body.appendChild(d);
};

/** Called once by the notebook page with its workspace; true if the LaTeX page took the page over. */
export async function latexBoot(ws: Workspace | null): Promise<boolean> {
  const q = new URLSearchParams(location.search), tex = q.get("tex");
  const st = latexOn(location, () => localStorage.getItem(KEY));
  if (!st.on) {
    if (tex !== null) note("The LaTeX editor isn't enabled here.");
    return false;
  }
  const keep = st.byUrl ? "&latex=1" : "";
  const g = globalThis as any;
  // the file browser: a .tex row with a fid opens the editor (here, or in a tab); without one, its preview
  g.__sbLatexOpen = (e: Entry, how: "here" | "tab"): boolean => {
    if (!isTex(e.path) || !e.fid) return false;
    const url = "/?tex=" + encodeURIComponent(e.fid) + keep;
    if (how === "tab") window.open(url, "_blank", "noopener");
    else location.assign(url);
    return true;
  };
  // a .tex file's preview: the editor's button (disabled, saying why, for a file without a stable id)
  g.__sbLatexPreview = (e: Entry, box: HTMLElement): void => {
    if (!isTex(e.path)) return;
    const b = document.createElement("button");
    b.textContent = "Open in LaTeX editor";
    if (e.fid) b.onclick = () => g.__sbLatexOpen(e, "here");
    else {
      b.disabled = true;
      b.title = "This file can't open in the LaTeX editor yet: it hasn't been given a stable id.";
      const p = document.createElement("div"); p.textContent = b.title; box.appendChild(p);
    }
    box.appendChild(b);
  };
  if (tex === null) return false;
  if (!ws) { note("The LaTeX editor needs this browser's workspace, which isn't open."); return true; }
  const root = document.createElement("div");
  document.body.appendChild(root);
  const m = await import(/* the page module, fetched only now */ new URL("sagebrush-latex.js", location.href).href);
  await m.mount(root, { ws, fid: tex, back: () => location.assign("/" + (st.byUrl ? "?latex=1" : "")) });
  return true;
}
