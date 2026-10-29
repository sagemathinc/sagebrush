// The LaTeX editor's entry from the notebook page (index.html), in a build with it only (__SB_LATEX__; web/build.ts,
// SAGEBRUSH_LATEX_PREVIEW). Kept small: it is in the page's own script (plan sbspace r5 §5: the DEV bootstrap delta).
// On only on an allowed host (dev.sagebrush.space exactly; the loopback hosts too in a "test" build), and then only
// with ?latex=1 or localStorage["sagebrush-latex-preview"] === "1"; nothing else can turn it on. On, it installs the
// hooks the file browser and the preview call (__sbTex, __sbTexP) and, for /?tex=<fid>, fetches the page
// (dist/sagebrush-latex.js) and mounts it. Off with ?tex=: a one-line note offering the file's preview.
import type { Workspace, Entry } from "../workspace/api";
import { openPreview } from "../workspace/preview";

declare const __SB_LATEX_HOSTS__: string[];

/** Whether the editor is on here: the host exactly, then the URL flag (byUrl: ?latex=1) or the stored one.
 * (hosts: the build's define, web/build.ts; the unit tests pass their own) */
export function latexOn(host: string, byUrl: boolean, read: () => string | null, hosts: readonly string[] = __SB_LATEX_HOSTS__) {
  let stored = false;
  try { stored = read() == "1"; } catch {}
  return hosts.includes(host) && (byUrl || stored);
}

/** Called once by the notebook page; true if the LaTeX page took the page over. */
export async function latexBoot(ws: Workspace | null) {
  const p = new URLSearchParams(location.search), tex = p.get("tex"), byUrl = p.get("latex") == "1";
  const g: any = globalThis, el = (t: string, s = "") => { const e = document.createElement(t); e.textContent = s; return e; }, isTex = (e: Entry) => /\.tex$/i.test(e.path);
  if (!latexOn(location.hostname, byUrl, () => localStorage.getItem("sagebrush-latex-preview"))) {
    if (tex === null) return false;
    // (r5 N2: the file's own preview, found by the same lookup; or why there is none)
    const d = el("p", "The LaTeX editor isn't enabled here."), at = ws && (await ws.pathOfFile(tex).catch(() => null));
    if (at && at.ok) { const b = el("button", "Preview it"); b.onclick = () => openPreview(ws!, at.entry, { say: (t: string) => (d.textContent = t), fail() {} }); d.append(" ", b); }
    else d.append(" This file isn't here any more.");
    document.body.prepend(d);
    return false;
  }
  const q = byUrl ? "?latex=1" : "";
  // the file browser: a .tex row with a fid opens the editor; without one, its preview (which says why)
  g.__sbTex = (e: Entry, tab?: boolean) => {
    // (a fid is hex: nothing to encode)
    if (!isTex(e) || !e.fid) return false;
    const url = "/?tex=" + e.fid + q.replace("?", "&");
    tab ? open(url, "_blank", "noopener") : location.assign(url);
    return true;
  };
  // a .tex file's preview: the editor's button; disabled, saying why, for a file without a stable id
  g.__sbTexP = (e: Entry, box: HTMLElement) => {
    if (!isTex(e)) return;
    const b = el("button", "Open in LaTeX editor") as HTMLButtonElement;
    if (e.fid) b.onclick = () => g.__sbTex(e);
    else { b.disabled = true; box.append(el("div", "This file can't open in the LaTeX editor yet: it hasn't been given a stable id.")); }
    box.append(b);
  };
  // the file browser's New (+): "LaTeX file" too, added to its menu when it opens (this module is in a LaTeX build only,
  // so the file browser's own code is the same as without the editor); the work is the page module's newTex, loaded on
  // the click: /Untitled.tex (or "Untitled (2).tex", ...) with a short document, opened in the editor
  // (the page module, from the site's root, where this page is: a variable, so the bundler leaves it to the browser)
  const page = "/sagebrush-latex.js";
  if (ws) document.addEventListener("click", (ev) => {
    const m = (ev.target as Element | null)?.closest?.('.sbfiles .fh button[aria-label="New"]') && document.querySelector(".sbfmenu");
    if (!m || m.querySelector(".sb-tex-new")) return;
    const b = el("button", "LaTeX file");
    b.className = "sb-tex-new"; b.setAttribute("role", "menuitem");
    b.onclick = (e) => { e.stopPropagation(); m.remove(); import(page).then((x) => x.newTex(ws, g.__sbTex), (err) => alert(String(err))); };
    m.insertBefore(b, [...m.querySelectorAll("button")].find((x) => x.textContent === "Folder") ?? null);
  });
  if (tex === null || !ws) return false;
  const root = el("div");
  document.body.append(root);
  await (await import(page)).mount(root, { ws, fid: tex, back: () => location.assign("/" + q) });
  return true;
}
