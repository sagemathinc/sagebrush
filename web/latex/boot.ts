// The LaTeX editor's entry from the notebook page (index.html), in a build with it only (__SB_LATEX__; web/build.ts,
// SAGEBRUSH_LATEX_PREVIEW). Kept small: it is in the page's own script (plan sbspace r5 §5: the DEV bootstrap delta).
// On only on an allowed host (dev.sagebrush.space exactly; the loopback hosts too in a "test" build), and then only
// with ?latex=1 or localStorage["sagebrush-latex-preview"] === "1"; nothing else can turn it on. On, it installs the
// hooks the file browser and the preview call (__sbLatexOpen, __sbLatexPreview) and, for /?tex=<fid>, fetches the page
// (dist/sagebrush-latex.js) and mounts it. Off with ?tex=: a one-line note offering the file's preview.
import type { Workspace, Entry } from "../workspace/api";
import { openPreview } from "../workspace/preview";

declare const __SB_LATEX_HOSTS__: string[];

/** Whether the editor is on here: the host exactly, then the URL flag or the stored one. */
export function latexOn(loc: { hostname: string; search: string }, read: () => string | null, hosts: readonly string[] = typeof __SB_LATEX_HOSTS__ !== "undefined" ? __SB_LATEX_HOSTS__ : ["dev.sagebrush.space"]) {
  const byUrl = new URLSearchParams(loc.search).get("latex") == "1";
  let stored = false;
  try { stored = read() == "1"; } catch {}
  return { on: hosts.includes(loc.hostname) && (byUrl || stored), byUrl };
}

/** Called once by the notebook page; true if the LaTeX page took the page over. */
export async function latexBoot(ws: Workspace | null) {
  const tex = new URLSearchParams(location.search).get("tex"), st = latexOn(location, () => localStorage.getItem("sagebrush-latex-preview"));
  const g: any = globalThis, el = (t: string, s = "") => { const e = document.createElement(t); e.textContent = s; return e; };
  if (!st.on) {
    if (tex === null) return false;
    // (r5 N2: the file's own preview, found by the same lookup; or why there is none)
    const d = el("p", "The LaTeX editor isn't enabled here."), at = ws && (await ws.pathOfFile(tex).catch(() => null));
    if (at && at.ok) { const b = el("button", "Preview it"); b.onclick = () => openPreview(ws!, at.entry, { say: (t: string) => (d.textContent = t), fail() {} }); d.append(" ", b); }
    else d.append(" This file isn't here any more.");
    document.body.prepend(d);
    return false;
  }
  const q = st.byUrl ? "?latex=1" : "";
  // the file browser: a .tex row with a fid opens the editor; without one, its preview (which says why)
  g.__sbLatexOpen = (e: Entry, how: string) => {
    if (!/\.tex$/i.test(e.path) || !e.fid) return false;
    const url = "/?tex=" + encodeURIComponent(e.fid) + q.replace("?", "&");
    how == "tab" ? open(url, "_blank", "noopener") : location.assign(url);
    return true;
  };
  // a .tex file's preview: the editor's button; disabled, saying why, for a file without a stable id
  g.__sbLatexPreview = (e: Entry, box: HTMLElement) => {
    if (!/\.tex$/i.test(e.path)) return;
    const b = el("button", "Open in LaTeX editor") as HTMLButtonElement;
    if (e.fid) b.onclick = () => g.__sbLatexOpen(e);
    else box.append(el("div", (b.disabled = true, b.title = "This file can't open in the LaTeX editor yet: it hasn't been given a stable id.")));
    box.append(b);
  };
  if (tex === null || !ws) return false;
  const root = el("div");
  document.body.append(root);
  await (await import(new URL("sagebrush-latex.js", location.href).href)).mount(root, { ws, fid: tex, back: () => location.assign("/" + q) });
  return true;
}
