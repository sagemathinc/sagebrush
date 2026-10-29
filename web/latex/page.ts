// The LaTeX editor page (DEV only, behind the flag: plan sbspace r5 + r6b). The page index.html hands itself to
// mount() for /?tex=<fid>. It binds to the file's fid (Workspace.pathOfFile), reads the whole file (at most 4 MiB),
// shows the source on the left and the live preview on the right, and saves only when asked (Ctrl/Cmd+S or Save),
// last write wins (r6b E5), with the kept minimums of save.ts. The preview comes from a module Worker
// (dist/sagebrush-latex-worker.js), whose replies are taken only for the request's own document/revision (gate.ts),
// patched under a per-frame budget, a split chunk's pieces replaced as one unit (staged hidden, then swapped).
// SECURITY: file names, paths and messages reach the page through textContent; preview HTML is the renderer's (its
// own escaping, KaTeX trust:false); images only as <img> from blob: URLs made of bytes checked by images.ts.
import type { Workspace, Entry } from "../workspace/api";
import { nameOf, parentOf } from "../workspace/paths";
import { openBytes, encodeText, EDIT_MAX } from "./save";
import { imageCandidates, sniffImage, admitImageBytes, IMAGE_BOUNDS } from "./images";
import { type Token } from "./gate";
import { createEditor } from "./editor";
import { PAGE_CSS } from "./style";
import { mark } from "./marks";
import { EXAMPLES, type Example } from "./examples";
export { EXAMPLES };
// (the embeddable editor, for the questions site: component.ts)
export { mountEditor, type LatexEditor } from "./component";
// (comments on the preview, cut 1: the frozen text, for grading: comments.ts)
export { attachComments, makeAnchor, locate, type Thread } from "./comments";

export { PATCH_BUDGET, FOLLOW_KEY } from "./editor";
// the source's font size (px) and the preview's zoom (%): their ranges, defaults and keys in localStorage
export const FONT = { key: "sagebrush-latex-font", min: 9, max: 28, def: 13 };
export const ZOOM = { key: "sagebrush-latex-zoom", min: 50, max: 200, def: 100, step: 10 };
const BANNER = "LaTeX editor: an early prototype. Save (Ctrl/Cmd+S) overwrites the file. If the file changed elsewhere since you opened it (another tab, Python, a collaborator), Save replaces those changes; the file's versions keep the bytes it replaced. Nothing is saved automatically. It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";
const BANNER_NO_SAVE = (why: string) => "LaTeX editor: an early prototype. This file can't be saved here: " + why + ". It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";

type Host = { ws: Workspace; fid: string; back(): void };
// (true only in a SAGEBRUSH_LATEX_PREVIEW=test build, web/build.ts: the page test's hold on image reads)
declare const __SB_LATEX_TEST__: boolean | undefined;
// (a reply's piece: its group, its HTML and, from the worker, its UTF-8 size)
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const enc = new TextEncoder();

/** "From an example" (boot.ts adds the item and loads this module on its click): a list of the examples
 * (examples.ts), as large buttons that fit a phone; the one chosen is made as a folder of its own,
 * "/LaTeX examples/<title>" (or "<title> (2)", ...: the first name not taken), with its files, and its main .tex
 * opened in the editor by boot.ts's hook (`open`). Escape, or the backdrop, closes it with nothing made. */
export async function texExamples(ws: Workspace, open: (e: Entry) => unknown): Promise<void> {
  const d = document.createElement("dialog");
  d.className = "sb-tex-examples";
  d.setAttribute("aria-label", "LaTeX examples");
  d.style.cssText = "max-width:min(560px,calc(100vw - 16px));width:100%;max-height:calc(100dvh - 32px);padding:0;border:1px solid #c8ccc9;border-radius:10px;box-sizing:border-box";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #e3e6e4;position:sticky;top:0;background:inherit";
  const h = document.createElement("b"); h.textContent = "LaTeX examples";
  const x = document.createElement("button"); x.textContent = "✕"; x.setAttribute("aria-label", "Close"); x.style.cssText = "min-width:44px;min-height:44px"; x.onclick = () => d.close();
  head.append(h, x);
  const list = document.createElement("div"); list.style.cssText = "display:grid;gap:8px;padding:12px";
  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.dataset.example = ex.id;
    b.style.cssText = "display:block;width:100%;text-align:left;padding:10px 12px;min-height:44px;border:1px solid #d5d9d6;border-radius:8px;background:transparent;cursor:pointer";
    const t = document.createElement("b"); t.textContent = ex.title;
    const a = document.createElement("div"); a.textContent = ex.about; a.style.cssText = "font-size:13px;opacity:.75;margin-top:2px";
    b.append(t, a);
    b.onclick = async () => {
      d.close();
      try { open(await makeExample(ws, ex)); }
      catch (err) { alert("The example couldn't be made: " + String((err as Error)?.message ?? err)); }
    };
    list.append(b);
  }
  d.append(head, list);
  d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); });
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
}

/** An example's folder and files; its main .tex (the first file) returned. */
export async function makeExample(ws: Workspace, ex: Example): Promise<Entry> {
  for (let i = 1; i <= 1000; i++) {
    const dir = "/LaTeX examples/" + ex.title + (i > 1 ? " (" + i + ")" : "");
    if (await ws.stat(dir)) continue;
    await ws.mkdir(dir);
    let main: Entry | undefined;
    for (const [name, text, b64] of ex.files) {
      const content = b64 ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0)) : new TextEncoder().encode(text);
      const e = await ws.createByPerson(dir + "/" + name, { content });
      main ??= e;
    }
    return main!;
  }
  throw new Error("no free folder name");
}

/** The file browser's New, "LaTeX file" (boot.ts adds the item and loads this module on its click): /Untitled.tex, or
 * "Untitled (2).tex", ... (the first name not taken), made by the person here with a short document, then opened in
 * the editor by boot.ts's own hook (`open`). */
export async function newTex(ws: Workspace, open: (e: Entry) => unknown): Promise<void> {
  try {
    for (let i = 1; i <= 1000; i++) {
      const p = "/Untitled" + (i > 1 ? " (" + i + ")" : "") + ".tex";
      if (await ws.stat(p)) continue;
      open(await ws.createByPerson(p, { content: new TextEncoder().encode("\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n") }));
      return;
    }
    alert("No free name for a new LaTeX file");
  } catch (err) { alert("The LaTeX file couldn't be made: " + String((err as Error)?.message ?? err)); }
}

export async function mount(root: HTMLElement, host: Host): Promise<void> {
  mark("tex-mount", {});
  const style = el("style"); style.textContent = PAGE_CSS; document.head.appendChild(style);
  if (!document.getElementById("sb-katex")) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = new URL("katex/katex.min.css", location.href).href; document.head.appendChild(link);
  }
  root.textContent = "";
  const page = el("div", "tex-page"); root.appendChild(page);
  const banner = el("div", "tex-banner"); banner.setAttribute("role", "note");
  const head = el("div", "tex-head");
  // Files: the notebook page's own Files button (index.html's #wsfilesbtn) clicked, so the files show and hide beside
  // this page as they do beside a notebook, the document staying open; pressed while they are shown (body.wsfiles)
  const back = el("button", "tex-back", "Files"); back.setAttribute("aria-controls", "wssidebar");
  back.onclick = () => { const b = document.getElementById("wsfilesbtn"); if (b) b.click(); else host.back(); };
  const pressed = () => back.setAttribute("aria-pressed", String(document.body.classList.contains("wsfiles")));
  new MutationObserver(pressed).observe(document.body, { attributes: true, attributeFilter: ["class"] }); pressed();
  const title = el("span", "tex-title");
  const dirty = el("span", "tex-dirty", "Unsaved changes"); dirty.hidden = true;
  const save = el("button", "tex-save", "Save"); save.disabled = true;
  const toggle = el("button", "tex-toggle", "Preview");
  const status = el("span", "tex-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  // the source's font size and the preview's zoom, each remembered in this browser
  const tools = el("span", "tex-tools");
  const btn = (text: string, label: string) => { const b = el("button", "", text); b.title = label; b.setAttribute("aria-label", label); return b; };
  const fsDown = btn("A−", "Smaller source text"), fsUp = btn("A+", "Larger source text");
  const zOut = btn("−", "Zoom the preview out"), zIn = btn("+", "Zoom the preview in"), zShow = el("span", "tex-zoomv");
  // keeping the two sides in sync: Follow (the preview follows the cursor; remembered, on by default) and Show (the
  // cursor's place in the preview now); a double-click in the preview puts the cursor at that place in the source
  const followBtn = btn("Follow", "The preview follows the cursor"), showBtn = btn("Show", "Show the cursor's place in the preview");
  tools.append(el("span", "tex-tl", "Source"), fsDown, fsUp, el("span", "tex-tl", "Preview"), zOut, zShow, zIn, followBtn, showBtn);
  head.append(back, title, dirty, save, toggle, status, tools);
  const main = el("div", "tex-main");
  const left = el("div", "tex-left"), right = el("div", "tex-right");
  const preview = el("div", "page tex-preview");
  right.appendChild(preview);
  main.append(left, right);
  page.append(banner, head, main);
  banner.textContent = BANNER;
  const say = (t: string) => { status.textContent = t; };
  const pref = (k: string, lo: number, hi: number, d: number) => { let v = d; try { v = Number(localStorage.getItem(k) ?? d); } catch {} return Number.isInteger(v) && v >= lo && v <= hi ? v : d; };
  const keep = (k: string, v: number) => { try { localStorage.setItem(k, String(v)); } catch {} };
  let fontPx = pref(FONT.key, FONT.min, FONT.max, FONT.def), zoomPct = pref(ZOOM.key, ZOOM.min, ZOOM.max, ZOOM.def);
  const applyView = () => {
    page.style.setProperty("--tex-src-fs", fontPx + "px");
    // (at 100% no zoom is set at all: the default view is the preview as it was)
    if (zoomPct === ZOOM.def) preview.style.removeProperty("zoom"); else preview.style.setProperty("zoom", String(zoomPct / 100));
    zShow.textContent = zoomPct + "%";
    fsDown.disabled = fontPx <= FONT.min; fsUp.disabled = fontPx >= FONT.max; zOut.disabled = zoomPct <= ZOOM.min; zIn.disabled = zoomPct >= ZOOM.max;
  };
  const font = (d: number) => { fontPx = Math.min(FONT.max, Math.max(FONT.min, fontPx + d)); keep(FONT.key, fontPx); applyView(); };
  const zoom = (d: number) => { zoomPct = Math.min(ZOOM.max, Math.max(ZOOM.min, zoomPct + d)); keep(ZOOM.key, zoomPct); applyView(); };
  fsDown.onclick = () => font(-1); fsUp.onclick = () => font(1); zOut.onclick = () => zoom(-ZOOM.step); zIn.onclick = () => zoom(ZOOM.step);
  applyView();

  // ---- a notebook opened while this page is up (from the files beside it, a row's menu, Open as a notebook, an
  // upload): the notebook page's openId() asks here first (index.html, in a LaTeX build only) and its page is opened
  // by URL instead, as a board's is; without this it would be loaded unseen under the editor
  (globalThis as any).__sbTexOpen = (id: string) => { location.assign("/?nb=" + encodeURIComponent(id)); return true; };
  const gone = (t: string) => { main.textContent = ""; const m = el("div", "tex-gone", t); main.appendChild(m); save.hidden = true; toggle.hidden = true; tools.hidden = true; };

  // ---- binding and reading (r5 §1a, §4)
  const where = await host.ws.pathOfFile(host.fid);
  if (!where.ok) { gone(where.why === "trashed" ? "This file isn't here any more (it's in the Trash)." : "This file isn't here any more."); return; }
  const e0: Entry = where.entry;
  title.textContent = nameOf(where.path); title.title = where.path;
  document.title = nameOf(where.path) + " — Sagebrush";
  if ((e0.size ?? 0) > EDIT_MAX) {
    gone("This file is too large for the LaTeX editor (over 4 MiB): download it from the file's preview.");
    return;
  }
  let read: { entry: Entry; content: Uint8Array };
  try { read = await host.ws.readUpTo(where.path, EDIT_MAX); } catch (err) { gone("This file can't be read here: " + String((err as Error)?.message ?? err)); return; }
  if (read.entry.fid !== host.fid) { gone("This file isn't here any more."); return; }
  mark("tex-read-done", { bytes: read.content.length });
  const opened = openBytes(read.content);
  if (opened.kind === "binary") { gone("This file can't be opened in the LaTeX editor: " + opened.why + "."); banner.textContent = BANNER_NO_SAVE(opened.why); return; }
  // (the whole file only: the bytes read are the file's size, else no Save)
  let saveable: boolean = opened.saveable && read.content.length === (read.entry.size ?? -1) && !e0.remote;
  const whyNot = !opened.saveable ? opened.why : e0.remote ? "it is in the cloud: open it on the device that made it" : read.content.length !== (read.entry.size ?? -1) ? "the whole file couldn't be read" : "";
  if (!saveable) { banner.textContent = BANNER_NO_SAVE(whyNot); save.hidden = true; }
  const eol = opened.eol;
  let savedText = opened.text;

  // ---- the editor and its preview (editor.ts); the images, the saving and the controls are this page's
  const images: Record<string, string | { why: string }> = {};
  const blobs = new Set<string>();
  let imageBytes = 0;
  const E = createEditor({
    left, right, preview, text: opened.text, large: read.content.length > 2 ** 20, say, images,
    workerUrl: new URL("sagebrush-latex-worker.js", location.href),
    onImageRefs: (refs, tok) => void resolveImages(refs, tok),
    // (an edit makes the last message ("Saved", "No changes to save", …) stale; a save under way keeps its own)
    onEdit: () => { showDirty(); if (!saving) say(""); },
  });
  const { src, gate, request } = E;

  // ---- images (r5 §3): resolved inside the file's folder, read by identity, checked, shown from blob: URLs
  // One resolver at a time (i1c01 A3-1): a reply's names join the queue, and only the running loop reads, counts and
  // keeps images, so no two resolutions are admitted against the same count or bytes, and a name is read once.
  const wanted = new Set<string>();
  let resolving = false;
  const resolveImages = async (refs: string[], tok: Token) => {
    for (const name of refs) if (!Object.hasOwn(images, name)) wanted.add(name);
    if (resolving) return;
    resolving = true;
    let changed = false;
    try {
      // (a Set visits names added while it is iterated: those from replies that came during an await)
      for (const name of wanted) {
        wanted.delete(name);
        if (Object.hasOwn(images, name)) continue;
        if (Object.keys(images).length >= IMAGE_BOUNDS.perDocument) { images[name] = { why: "too many images" }; changed = true; continue; }
        const c = imageCandidates(name, where.path);
        if (!c.ok) { images[name] = { why: c.why }; changed = true; continue; }
        let found: Entry | undefined;
        for (const p of c.paths) { const e = await host.ws.stat(p).catch(() => undefined); if (e && e.kind === "file" && !e.trashed) { found = e; break; } }
        if (!gate.sameDoc(tok)) { wanted.clear(); return; }
        if (!found) { images[name] = { why: "not found" }; changed = true; continue; }
        if ((found.size ?? 0) > IMAGE_BOUNDS.perImage || imageBytes + (found.size ?? 0) > IMAGE_BOUNDS.total) { images[name] = { why: "too large" }; changed = true; continue; }
        let r: { entry: Entry; content: Uint8Array };
        // (the test build only: the page test can hold an image read here; elsewhere this folds away)
        if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await (globalThis as any).__sbTexImageRead?.(found.path);
        try { r = await host.ws.readUpTo(found.path, IMAGE_BOUNDS.perImage); } catch { if (gate.sameDoc(tok)) { images[name] = { why: "not readable" }; changed = true; } continue; }
        // (the same file, by identity, when the read completes; else dropped)
        const now = await host.ws.stat(found.path).catch(() => undefined);
        if (!gate.sameDoc(tok)) { wanted.clear(); return; }
        if (!now || now.fid !== found.fid || r.entry.fid !== found.fid || now.updated !== found.updated) { images[name] = { why: "changed while it was read" }; changed = true; continue; }
        // (the bytes actually read, against the size admitted and what is kept, before any blob is made)
        const why = admitImageBytes(r.content.length, found.size, imageBytes);
        if (why) { images[name] = { why }; changed = true; continue; }
        const sn = sniffImage(r.content);
        if (!sn.ok) { images[name] = { why: sn.why }; changed = true; continue; }
        if (sn.pixels !== null && sn.pixels > IMAGE_BOUNDS.megapixels * 1e6) { images[name] = { why: "too large" }; changed = true; continue; }
        imageBytes += r.content.length;
        const url = URL.createObjectURL(new Blob([r.content as BlobPart], { type: sn.mime }));
        blobs.add(url); images[name] = url; changed = true;
      }
    } finally { resolving = false; }
    if (changed && gate.sameDoc(tok)) request();
  };
  const dropImages = () => { for (const u of blobs) URL.revokeObjectURL(u); blobs.clear(); };

  // ---- editing
  const isDirty = () => src.value !== savedText;
  function showDirty() { const d = isDirty(); dirty.hidden = !d; save.disabled = !d || !saveable || saving; }
  src.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "s") { ev.preventDefault(); void doSave(); }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.target !== src && (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === "s") { ev.preventDefault(); void doSave(); }
  });
  save.onclick = () => void doSave();
  toggle.onclick = () => { const p = page.classList.toggle("show-preview"); toggle.textContent = p ? "Source" : "Preview"; };
  window.addEventListener("beforeunload", (ev) => { if (isDirty()) { ev.preventDefault(); ev.returnValue = ""; } });
  window.addEventListener("pagehide", dropImages);

  // ---- saving (r6b E5): the opened file only, last write wins
  let saving = false;
  async function doSave() {
    if (!saveable) { say("This file can't be saved here: " + whyNot + "."); return; }
    if (saving) { say("saving…"); return; }
    if (!isDirty()) { say("No changes to save"); return; }
    const text = src.value;
    const bytes = encodeText(text, eol);
    if (bytes.length > EDIT_MAX) { say("Not saved: over the prototype's 4 MiB limit"); return; }
    saving = true; showDirty(); say("saving…");
    try {
      const at = await host.ws.pathOfFile(host.fid);
      if (!at.ok) { say("Not saved: this file isn't here any more"); return; }
      if (at.entry.remote) { say("Not saved: this file is in the cloud"); return; }
      await host.ws.write(at.path, bytes, { fid: host.fid });
      savedText = text;
      if (at.path !== where.path) { title.textContent = nameOf(at.path); title.title = at.path; }
      say("Saved");
    } catch (err) {
      // (the workspace's own refusal, by its code: this module doesn't bundle the workspace's classes)
      say((err as any)?.code === "conflict" ? "Not saved: another file is at this path now" : "Not saved: " + String((err as Error)?.message ?? err).slice(0, 200));
    } finally { saving = false; showDirty(); }
  }

  // ---- source and preview in sync (editor.ts): Follow (remembered, on by default) and Show
  const showFollow = () => followBtn.setAttribute("aria-pressed", String(E.following()));
  followBtn.onclick = () => { E.setFollow(!E.following()); showFollow(); };
  showBtn.onclick = () => E.showCursor(true);
  showFollow();

  void parentOf; void enc;
}
