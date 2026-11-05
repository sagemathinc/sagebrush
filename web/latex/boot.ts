// The LaTeX editor's entry from the notebook page (index.html), in a build with it (__SB_LATEX__, on by default:
// web/build.ts). Kept small: it is in the page's own script. On on the hosts that serve the editor's files (the build's
// list: sagebrush.space and dev.sagebrush.space; the loopback hosts too in a "test" build), for everyone: no flag (William,
// Nov 2: on by default). On, it installs the hooks the file browser and the preview call (__sbTex, __sbTexP) and, for
// /?tex=<fid>, fetches the page (dist/sagebrush-latex.js) and mounts it. Elsewhere (the CLI's page, the desktop app),
// with ?tex=: a one-line note offering the file's preview.
import type { Workspace, Entry } from "../workspace/api";
import { openPreview } from "../workspace/preview";

declare const __SB_LATEX_HOSTS__: string[];

/** Whether the editor is on here: the host exactly (hosts: the build's define, web/build.ts; the unit tests pass their own). */
export function latexOn(host: string, hosts: readonly string[] = __SB_LATEX_HOSTS__) {
  return hosts.includes(host);
}

/** Called once by the notebook page; true if the LaTeX page took the page over. `sandbox`: the page's own runner
 * and kernel classes where it runs code in the runner (index.html's RUNNER), for the editor's Run; null elsewhere. */
export async function latexBoot(ws: Workspace | null, sandbox: { WorkerKernel: unknown; RunnerWorker: unknown } | null = null) {
  const p = new URLSearchParams(location.search), tex = p.get("tex");
  const g: any = globalThis, el = (t: string, s = "") => { const e = document.createElement(t); e.textContent = s; return e; }, isTex = (e: Entry) => /\.tex$/i.test(e.path);
  if (!latexOn(location.hostname)) {
    if (tex === null) return false;
    // (r5 N2: the file's own preview, found by the same lookup; or why there is none)
    const d = el("p", "The LaTeX editor isn't enabled here."), at = ws && (await ws.pathOfFile(tex).catch(() => null));
    if (at && at.ok) { const b = el("button", "Preview it"); b.onclick = () => openPreview(ws!, at.entry, { say: (t: string) => (d.textContent = t), fail() {} }); d.append(" ", b); }
    else d.append(" This file isn't here any more.");
    document.body.prepend(d);
    return false;
  }
  // the file browser: a .tex row with a fid opens the editor; without one, its preview (which says why)
  g.__sbTex = (e: Entry, tab?: boolean) => {
    // (a fid is hex: nothing to encode)
    if (!isTex(e) || !e.fid) return false;
    const url = "/?tex=" + e.fid;
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
  // a new LaTeX document: an item in the file browser's New (+) menu, when it opens; in the File menu's New group; and on
  // the empty file list (on a phone, where the file panel's buttons may be out of reach) (this module is in a LaTeX
  // build only, so their own code is the same as without the editor); the work is the page module's newTex, loaded on
  // the click: /Untitled.tex (or "Untitled (2).tex", ...) with a short document, opened in the editor
  // (the page module, from the site's root, where this page is: a variable, so the bundler leaves it to the browser)
  const page = "/sagebrush-latex.js";
  // (all three are redrawn as they change: checked after each change. The file browser's + menu is the .sbfmenu with a
  //  "Folder" item: a folder's own menu has "New folder here")
  // (fn: the page module's function: newTex, a blank document, or texExamples, the examples' list)
  const qs = (s: string) => document.querySelector(s), t = "LaTeX document", e = "LaTeX example";
  const add = (m: Element | null | undefined, t: string, at?: Element | null, close?: number, fn = "newTex") => {
    if (!m || m.querySelector(`[data-tex="${fn}"]`)) return;
    const b = el("button", t);
    b.dataset.tex = fn; b.setAttribute("role", "menuitem");
    b.onclick = (ev) => { ev.stopPropagation(); close ? m.remove() : m.closest("[role=menu]")?.setAttribute("hidden", ""); import(page).then((x) => x[fn](ws!, g.__sbTex), (r) => alert(r)); };
    // (the click closes its menu: the + menu removed, the File menu hidden, so neither stays over the examples' list)
    // (an undefined `at` is null to the DOM: the end)
    m.insertBefore(b, at as Element | null);
  };
  if (ws) new MutationObserver(() => {
    const m = qs(".sbfmenu"), f = qs(".fmgroup[aria-label=New]"), x = qs(".sbfiles .fempty"), at = f?.querySelector("[data-item=newFolder]");
    const fo = [...(m?.querySelectorAll("button") ?? [])].find((b) => b.textContent == "Folder");
    if (fo) add(m, t, fo, 1);
    add(f, t, at); add(f, e, at, 0, "texExamples");
    if (x?.textContent!.startsWith("Nothing")) { add(x, "New " + t); add(x, e, null, 0, "texExamples"); }
}).observe(document.body, { childList: true, subtree: true });
  // a published document, read only (?tex-doc=/articles/<series>/<name>.tex; the page module's openDoc checks the path)
  const doc = p.get("tex-doc");
  if (doc !== null) { const root = el("div"); document.body.append(root); await (await import(page)).openDoc(root, doc, ws, g.__sbTex); return true; }
  if (tex === null || !ws) return false;
  const root = el("div");
  document.body.append(root);
  await (await import(page)).mount(root, { ws, fid: tex, back: () => location.assign("/"), sandbox });
  return true;
}
