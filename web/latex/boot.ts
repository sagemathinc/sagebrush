// The LaTeX editor's entry from the notebook page (index.html), in a build with it (__SB_LATEX__, on by default:
// web/build.ts). Kept small: it is in the page's own script. On on the hosts that serve the editor's files (the build's
// list: sagebrush.space and dev.sagebrush.space; the loopback hosts too in a "test" build), for everyone: no flag (William,
// Nov 2: on by default). On, it installs the hooks the file browser and the preview call (__sbTex, __sbTexP) and, for
// /?tex=<fid>, fetches the page (dist/sagebrush-latex.js) and mounts it. Elsewhere (the CLI's page, the desktop app),
// with ?tex=: a one-line note offering the file's preview.
import type { Workspace, Entry } from "../workspace/api";
import { openPreview } from "../workspace/preview";
import { renderFileMenu, fileMenuKey } from "../workspace/filemenu";
import { openFilesDialog, recentLabel, recentOpened } from "../workspace/fileopen";
import { freePath, safeName } from "../workspace/paths";
import { openGallery } from "../examples/open";
import { render as markdown } from "../markdown";

declare const __SB_LATEX_HOSTS__: string[];

/** Whether the editor is on here: the host exactly (hosts: the build's define, web/build.ts; the unit tests pass their own). */
export function latexOn(host: string, hosts: readonly string[] = __SB_LATEX_HOSTS__) {
  return hosts.includes(host);
}

// (the page module, from the site's root, where this page is: a variable, so the bundler leaves it to the browser)
const PAGE = "/sagebrush-latex.js";
const g: any = globalThis;
const isTex = (e: Entry) => /\.tex$/i.test(e.path);
/** New ▸ LaTeX document in `folder`: "Untitled.tex" (or "Untitled (2).tex", ...) there, opened in the editor. */
export const texNew = (ws: Workspace, folder = "/") => import(PAGE).then((x) => x.newTex(ws, g.__sbTex, folder), (r) => alert(r));
/** The LaTeX examples' list (the editor's "From an example…"; examples.ts). */
export const texExamplesOpen = (ws: Workspace) => import(PAGE).then((x) => x.texExamples(ws, g.__sbTex), (r) => alert(r));
/** The editor's File menu, drawn by the one File menu (filemenu.ts, as on the notebook and board pages: the same items
 * in the same order, U0) from this page's script, so the editor's chunk carries no copy of it: handed to the editor
 * at mount (its host's `fileMenu`). `print`: the editor's own Print or save as PDF; `close`: the menu closed. */
function texFileMenu(ws: Workspace, menu: HTMLElement, o: { print(): void; close(): void; fid: string }) {
  const go = (e: Entry, how: "here" | "tab" = "here") => {
    const url = e.kind === "board" ? "/board/?doc=local:" + e.ref : e.kind === "notebook" ? "/?nb=" + encodeURIComponent(e.ref!) : isTex(e) && e.fid ? "/?tex=" + e.fid : null;
    if (url) how === "tab" ? open(url, "_blank", "noopener") : location.assign(url);
  };
  const top = async (base: string, ext: string) => { const at = new Set((await ws.list("/")).map((e) => e.path)); const p = freePath("/", base, ext, (x) => at.has(x)); if (!p) throw new Error("no free name"); return p; };
  const act: Record<string, () => unknown> = {
    texnb: async () => go(await ws.createByPerson(await top("Untitled", ".ipynb"), { mode: "python" })),
    texboard: () => location.assign("/board/?new=python"),
    texnew: () => texNew(ws),
    texfolder: async () => { const n = prompt("A new folder, at the top of your files: its name", "New folder"); if (n?.trim()) await ws.mkdir("/" + safeName(n.trim())); },
    // (the examples gallery, LaTeX first, as the notebook and board pages have it (web/examples/open.ts); where the site
    // has none, the LaTeX examples' own list)
    texexamples: async () => { if (!(await openGallery(ws, go, "latex"))) await texExamplesOpen(ws); },
    texopen: () => openFilesDialog(ws, go),
    texprint: () => o.print(),
  };
  renderFileMenu(menu, {
    attr: "data-f", latex: true, downloads: [], chosen: o.close,
    keys: { newNotebook: "texnb", newBoard: "texboard", newLatex: "texnew", newFolder: "texfolder", fromExample: "texexamples", open: "texopen", print: "texprint" },
    recent: async () => (await recentOpened(ws)).filter((e) => e.fid !== o.fid).map((e) => ({ label: recentLabel(e), title: e.path, open: () => go(e) })),
  });
  menu.addEventListener("click", (ev) => {
    const k = (ev.target as HTMLElement).closest("[data-f]")?.getAttribute("data-f");
    if (k && act[k]) Promise.resolve().then(act[k]).catch((err) => alert(String((err as Error)?.message ?? err)));
  });
  return (e: KeyboardEvent) => { const it = fileMenuKey(e); if (it) { e.preventDefault(); menu.querySelector<HTMLElement>(`[data-item="${it}"]:not([disabled])`)?.click(); } };
}

// (a comment's text as Markdown with math, as the notebook's text cells draw it (markdown.ts, already in this page's
//  script); KaTeX, the site's sagebrush-math.js, fetched the first time a comment has math. Another site's picture
//  only on a click: a comment may come from an agent)
const MATH = "/sagebrush-math.js";
let mathModule: Promise<{ typeset(el: Element): void }> | null = null;
const commentMarkdown = (box: HTMLElement, text: string) => {
  box.innerHTML = markdown(text, { remote: "click" });
  if (box.querySelector(".math")) (mathModule ??= import(MATH)).then((m) => m.typeset(box)).catch(() => {});
};

/** Called once by the notebook page; true if the LaTeX page took the page over. `sandbox`: the page's own runner
 * and kernel classes where it runs code in the runner (index.html's RUNNER), for the editor's Run; null elsewhere. */
export async function latexBoot(ws: Workspace | null, sandbox: { WorkerKernel: unknown; RunnerWorker: unknown } | null = null) {
  const p = new URLSearchParams(location.search), tex = p.get("tex");
  const el = (t: string, s = "") => { const e = document.createElement(t); e.textContent = s; return e; };
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
  // (a new LaTeX document and the LaTeX examples: texNew and texExamplesOpen above, which the page's File ▸ New, file
  // panel and folder menus call (filemenu.ts NEW_ITEMS, browser.ts: U0); never a URL that makes a file)
  // a published document, read only (?tex-doc=/articles/<series>/<name>.tex; the page module's openDoc checks the path)
  const doc = p.get("tex-doc");
  if (doc !== null) { const root = el("div"); document.body.append(root); await (await import(PAGE)).openDoc(root, doc, ws, g.__sbTex); return true; }
  if (tex === null || !ws) return false;
  const root = el("div");
  document.body.append(root);
  await (await import(PAGE)).mount(root, { ws, fid: tex, back: () => location.assign("/"), sandbox, fileMenu: (menu: HTMLElement, o: { print(): void; close(): void }) => texFileMenu(ws, menu, { ...o, fid: tex }), markdown: commentMarkdown });
  return true;
}
