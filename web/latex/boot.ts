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
import { loadRemotePicture } from "../safe-html";

declare const __SB_LATEX_HOSTS__: string[];
declare const __SB_LATEX_TEST__: boolean | undefined;

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
function texFileMenu(ws: Workspace, menu: HTMLElement, o: { print(): void; close(): void; fid: string; text?(): string | null; save?(): Promise<void>; share?: TexShare | null }) {
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
    // (Share…: the page's Share dialog for this .tex (latexBoot's `share`), its path as it is now; the dialog saves it
    //  before it reads the saved file (save: rejects unless the editor's text is written), and checks that against its
    //  text then (data). Nothing before the editor has the document's text)
    texshare: async () => {
      if (!o.share || !o.save || o.text?.() == null) return;
      const at = await ws.pathOfFile(o.fid);
      if (!at.ok) throw new Error("This file isn't here any more.");
      const share = o.share, text = o.text;
      share({ fid: o.fid, path: at.path, data: () => new TextEncoder().encode(text() ?? ""), save: o.save });
    },
  };
  renderFileMenu(menu, {
    attr: "data-f", latex: true, downloads: [], chosen: o.close,
    keys: { newNotebook: "texnb", newBoard: "texboard", newLatex: "texnew", newFolder: "texfolder", fromExample: "texexamples", open: "texopen", print: "texprint", ...(o.share ? { share: "texshare" } : {}) },
    // (no sharing on this page at all (index.html's LOCAL: the CLI's page, where a build turns the editor on there): why,
    //  as board wrote it; a page that hasn't said (share undefined) shows it disabled with no title, as before)
    ...(o.share === null ? { why: { share: TEX_SHARE_WHY } } : {}),
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
//  only on a click: a comment may come from an agent. That click is taken here, in the capture phase, so it loads the
//  picture and goes no further: not to the comment's list item or bubble, which would open the thread instead)
const MATH = "/sagebrush-math.js";
let mathModule: Promise<{ typeset(el: Element): void }> | null = null;
const commentMarkdown = (box: HTMLElement, text: string) => {
  box.innerHTML = markdown(text, { remote: "click" });
  box.addEventListener("click", loadRemotePicture, true);
  if (box.querySelector(".math")) (mathModule ??= import(MATH)).then((m) => m.typeset(box)).catch(() => {});
};

/** The page's Share dialog for a .tex (the share client's: the .tex in a notebook's place, its results file beside it):
 * its id, its workspace path now, its text when the dialog publishes, and a save of it now (rejects unless written). */
export type TexShare = (doc: { fid: string; path: string; data: () => Uint8Array; save: () => Promise<void> }) => void;
/** Why the editor's Share… is disabled on a page without sharing (board's words). */
export const TEX_SHARE_WHY = "Sharing isn't available here: upload this file, and the files it uses, to sagebrush.space and share it there";
/** Called once by the notebook page; true if the LaTeX page took the page over. `sandbox`: the page's own runner
 * and kernel classes where it runs code in the runner (index.html's RUNNER), for the editor's Run; null elsewhere.
 * `opts.share`: the page's Share dialog for a .tex (File ▸ Share…); null where the page has no sharing at all; left
 * out, the item is disabled, as before. */
export async function latexBoot(ws: Workspace | null, sandbox: { WorkerKernel: unknown; RunnerWorker: unknown } | null = null, opts: { share?: TexShare | null } = {}) {
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
  // (the test build only: the page test gives its own Share (a spy, or null), set before this page's script runs; it
  //  wins over the page's, so the editor's own test stays the editor's)
  const share = typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__ && "__sbTexShare" in g ? g.__sbTexShare : opts.share;
  await (await import(PAGE)).mount(root, { ws, fid: tex, back: () => location.assign("/"), sandbox, fileMenu: (menu: HTMLElement, o: { print(): void; close(): void; text(): string | null; save(): Promise<void> }) => texFileMenu(ws, menu, { ...o, fid: tex, share }), markdown: commentMarkdown });
  return true;
}
