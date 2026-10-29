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
import { RenderGate, type Token } from "./gate";
import { Highlighter } from "./highlight";
import { PAGE_CSS } from "./style";
import { mark } from "./marks";

export const PATCH_BUDGET = { items: 200, bytes: 512 * 1024, ms: 8 };
// the source's font size (px) and the preview's zoom (%): their ranges, defaults and keys in localStorage
export const FONT = { key: "sagebrush-latex-font", min: 9, max: 28, def: 13 };
export const ZOOM = { key: "sagebrush-latex-zoom", min: 50, max: 200, def: 100, step: 10 };
export const FOLLOW_KEY = "sagebrush-latex-follow";
const BANNER = "LaTeX editor: an early prototype. Save (Ctrl/Cmd+S) overwrites the file. If the file changed elsewhere since you opened it (another tab, Python, a collaborator), Save replaces those changes; the file's versions keep the bytes it replaced. Nothing is saved automatically. It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";
const BANNER_NO_SAVE = (why: string) => "LaTeX editor: an early prototype. This file can't be saved here: " + why + ". It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";

type Host = { ws: Workspace; fid: string; back(): void };
// (true only in a SAGEBRUSH_LATEX_PREVIEW=test build, web/build.ts: the page test's hold on image reads)
declare const __SB_LATEX_TEST__: boolean | undefined;
// (a reply's piece: its group, its HTML and, from the worker, its UTF-8 size)
type Item = { g: number; h: string; b?: number };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const enc = new TextEncoder();

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

  // ---- the editor (a textarea, with the highlighter's lines drawn behind it)
  const ed = el("div", "tex-ed");
  const hl = el("div", "tex-hl"); hl.setAttribute("aria-hidden", "true");
  const src = el("textarea", "tex-src"); src.spellcheck = false; src.setAttribute("aria-label", "LaTeX source");
  src.value = opened.text;
  ed.append(hl, src); left.appendChild(ed);
  const highlighter = new Highlighter(hl, opened.text, (read.content.length > 2 ** 20));
  src.addEventListener("scroll", () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; });
  // long lines wrap (the textarea and the lines behind it alike), unless a line is over the highlighter's LONG_LINE
  // (16 KiB): then neither wraps, as before (a wrapped line of a MiB is laid out again on every keystroke)
  let wrapped: boolean | null = null;
  const setWrap = () => {
    const w = highlighter.longLines === 0;
    if (w === wrapped) return;
    wrapped = w; src.wrap = w ? "soft" : "off"; ed.classList.toggle("nowrap", !w);
  };
  setWrap();
  // (the lines behind are as wide and tall as the textarea's text, inside its scrollbars, so they wrap at the same width)
  const fit = () => { hl.style.right = src.offsetWidth - src.clientWidth + "px"; hl.style.bottom = src.offsetHeight - src.clientHeight + "px"; };
  new ResizeObserver(fit).observe(src);

  // ---- the preview: engine worker, gate, patching
  const gate = new RenderGate();
  gate.load(); gate.loaded(gate.token());
  let worker: Worker | null = null, inflight: Token | null = null, queued = false, watchdog: any = null, restartedAt = -1;
  let groups: HTMLElement[] = [], groupHtml: string[] = [];
  let groupPos: number[] = [];   // per group, the source offset where it begins (-1: unknown), from the shown reply
  // (the shown reply's positions sorted, as [offset, group] pairs, ties by group: built once per installed reply)
  let posIndex: [number, number][] = [];
  // the document and revision the shown reply was made for: positions hold only while the source is still that
  // revision (ux2 r2 #1; every edit moves the gate's revision, so the check is O(1), never a comparison of the text)
  let posTok: Token | null = null;
  const images: Record<string, string | { why: string }> = {};
  const blobs = new Set<string>();
  let imageBytes = 0;
  const startWorker = () => {
    worker?.terminate();
    worker = new Worker(new URL("sagebrush-latex-worker.js", location.href), { type: "module", name: "sagebrush-latex" });
    worker.onmessage = (m) => {
      // (the test build only: the page test can hold a reply here; elsewhere this folds away)
      const held = typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__ ? (globalThis as any).__sbTexReplyHold?.(m.data?.rev) : undefined;
      if (held) void held.then(() => onReply(m.data)); else onReply(m.data);
    };
    worker.onerror = () => say("the preview's engine stopped");
  };
  const request = () => {
    if (!gate.canSend() || !worker) return;
    if (inflight) { queued = true; return; }
    const t = gate.token();
    inflight = t; queued = false;
    clearTimeout(watchdog);
    // (the watchdog: 15 s, then the worker is replaced; once per source revision, then it stays stopped)
    watchdog = setTimeout(() => {
      inflight = null;
      if (restartedAt === t.rev) { say("stopped: this document takes too long"); return; }
      restartedAt = t.rev; startWorker(); request();
    }, 15000);
    mark("tex-request", { rev: t.rev });
    worker.postMessage({ doc: t.doc, rev: t.rev, text: src.value, images });
  };
  const onReply = (r: any) => {
    const tReply = performance.now();
    mark("tex-parse-done", { rev: r.rev });
    clearTimeout(watchdog);
    inflight = null;
    if (queued) request();
    const ok = gate.accept(r);
    if (!ok.patch) return;
    if (!r.ok) { say("the preview failed: " + String(r.error).slice(0, 200)); return; }
    schedulePatch(r.items as Item[], r.groups as number, r.rev as number, Array.isArray(r.pos) ? (r.pos as number[]) : [], { doc: r.doc as number, rev: r.rev as number });
    preview.dataset.replyMs = String(Math.round(performance.now() - tReply));
    if (ok.current) resolveImages(r.imageRefs as string[], gate.token());
  };

  // patching: one wrapper per chunk (group); changed groups are built hidden across frames under the budget, then
  // swapped in one step (old removed, new shown): never two versions of a group at once
  // (the patch loop's own longest step and swap, and the most UTF-8 bytes parsed in one step: preview.dataset)
  let patchSeq = 0, stepMax = 0, swapMs = 0, stepBytesMax = 0;
  const stops = { items: 0, bytes: 0, ms: 0 };   // (which stop ended each step, all patches: preview.dataset.stops)
  const schedulePatch = (items: Item[], ng: number, rev: number, pos: number[], tok: Token) => {
    const seq = ++patchSeq;
    const html: string[][] = Array.from({ length: ng }, () => []), sizes: number[][] = Array.from({ length: ng }, () => []);
    // (a piece's UTF-8 size from the worker; without one, 3 bytes per UTF-16 unit, UTF-8's most)
    for (const it of items) { html[it.g]?.push(it.h); sizes[it.g]?.push(Number.isFinite(it.b) ? it.b! : 3 * it.h.length); }
    const next = html.map((a) => a.join("\u0000"));
    let p = 0; const n = Math.min(groupHtml.length, next.length);
    while (p < n && groupHtml[p] === next[p]) p++;
    let s = 0;
    while (s < n - p && groupHtml[groupHtml.length - 1 - s] === next[next.length - 1 - s]) s++;
    const staged: HTMLElement[] = [];
    let g = p, k = 0;
    const step = () => {
      if (seq !== patchSeq) { for (const w of staged) w.remove(); return; }
      const t0 = performance.now(); let count = 0, bytesIn = 0;
      const yieldNow = () => { stepMax = Math.max(stepMax, performance.now() - t0); stepBytesMax = Math.max(stepBytesMax, bytesIn); requestAnimationFrame(step); };
      while (g < next.length - s) {
        if (k === 0) { const w = el("div", "ch"); w.hidden = true; staged.push(w); preview.appendChild(w); }
        const pieces = html[g], w = staged[staged.length - 1];
        while (k < pieces.length) {
          const h = pieces[k], b = sizes[g][k];
          const stop = count >= PATCH_BUDGET.items ? "items" : bytesIn + b > PATCH_BUDGET.bytes && count > 0 ? "bytes" : performance.now() - t0 > PATCH_BUDGET.ms ? "ms" : "";
          if (stop) { stops[stop]++; return yieldNow(); }
          const piece = document.createElement("div"); piece.className = "pc"; piece.innerHTML = h; w.appendChild(piece);
          count++; bytesIn += b; k++;
        }
        k = 0; g++;
      }
      // all new groups ready: swap them in, in one step (old ones hidden, new ones moved and shown: no parsing);
      // the old ones are removed afterwards, one per frame, while hidden, so they are never shown with the new
      stepBytesMax = Math.max(stepBytesMax, bytesIn);
      const tSwap = performance.now();
      const kids = groups;
      const before = kids[groupHtml.length - s] ?? null;
      const old = kids.slice(p, groupHtml.length - s);
      for (const w of old) w.hidden = true;
      for (const w of staged) { preview.insertBefore(w, before); w.hidden = false; }
      groups = kids.slice(0, p).concat(staged, kids.slice(groupHtml.length - s));
      groupHtml = next;
      groupPos = pos; posTok = tok;
      posIndex = [];
      pos.forEach((q, i) => { if (q >= 0) posIndex.push([q, i]); });
      posIndex.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      swapMs = Math.max(swapMs, performance.now() - tSwap);
      // (a piece at a time: a large group's whole subtree is never torn down in one task)
      const drop = () => {
        const w = old[old.length - 1];
        if (!w) return;
        const t1 = performance.now();
        while (w.lastChild && performance.now() - t1 < PATCH_BUDGET.ms) w.lastChild.remove();
        if (!w.lastChild) { w.remove(); old.pop(); }
        requestAnimationFrame(drop);
      };
      requestAnimationFrame(drop);
      preview.dataset.patchMaxMs = String(Math.round(stepMax)); preview.dataset.swapMaxMs = String(Math.round(swapMs)); preview.dataset.stepBytesMax = String(stepBytesMax); preview.dataset.stops = JSON.stringify(stops);
      // (§6: the patch of this revision done, then the frame after it: the preview's paint)
      mark("tex-patch-done", { rev });
      requestAnimationFrame(() => mark("tex-paint", { rev }));
      // (a Follow put off while the preview was behind: done now, if this reply is of the source as it is)
      if (followPending && follow && posCurrent()) { followPending = false; showCursor(false); }
    };
    step();
  };

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
  let editTimer: any = null;
  const isDirty = () => src.value !== savedText;
  const showDirty = () => { const d = isDirty(); dirty.hidden = !d; save.disabled = !d || !saveable || saving; };
  src.addEventListener("input", () => {
    gate.edit(); mark("tex-input", { rev: gate.token().rev }); showDirty();
    // (an edit makes the last message ("Saved", "No changes to save", …) stale; a save under way keeps its own)
    if (!saving) say("");
    highlighter.update(src.value);
    setWrap();
    clearTimeout(editTimer);
    request();
  });
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

  // ---- source and preview in sync
  // the source line of an offset; the textarea scrolled so that line is a third of the way down (the highlighter's
  // line elements give the wrapped lines' real heights)
  const lineOf = (off: number) => { let n = 0; const t = src.value; for (let i = t.indexOf("\n"); i >= 0 && i < off; i = t.indexOf("\n", i + 1)) n++; return n; };
  const revealSource = (a: number, b: number) => {
    src.focus(); src.setSelectionRange(a, b);
    const line = hl.children[lineOf(a)] as HTMLElement | undefined;
    if (line) src.scrollTop = Math.max(0, line.offsetTop - src.clientHeight / 3);
  };
  // the positions are of the shown reply's revision: after an edit since (its reply still to come, or one that
  // failed), no sync either way (ux2 r2 #1)
  const posCurrent = () => gate.current(posTok);
  let followPending = false;
  // the index of the first entry whose offset is above off (a binary search; preview.dataset.syncVisits: its probes)
  const above = (off: number) => {
    let lo = 0, hi = posIndex.length, visits = 0;
    while (lo < hi) { const m = (lo + hi) >> 1; visits++; if (posIndex[m][0] <= off) lo = m + 1; else hi = m; }
    preview.dataset.syncVisits = String(visits);
    return lo;
  };
  // the group whose source starts last at or before an offset (of groups starting at the same offset, the last)
  const groupAt = (off: number) => { const i = above(off) - 1; return i >= 0 ? posIndex[i][1] : -1; };
  // inverse: a double-click in the preview puts the cursor at that place in the source (the word clicked, searched
  // from where its group begins to where the next one does; else the group's start)
  preview.addEventListener("dblclick", (ev) => {
    const w = (ev.target as HTMLElement).closest(".ch") as HTMLElement | null;
    const k = w ? groups.indexOf(w) : -1;
    const start = k >= 0 ? groupPos[k] : -1;
    if (start === undefined || start < 0) return;
    if (!posCurrent()) { say("the preview is behind the source: try again when it has caught up"); return; }
    const nx = above(start), end = nx < posIndex.length ? posIndex[nx][0] : src.value.length;
    const word = (getSelection()?.toString() ?? "").trim();
    let at = start, to = start;
    if (word) { const i = src.value.indexOf(word, start); if (i >= 0 && i < end) { at = i; to = i + word.length; } }
    revealSource(at, to);
  });
  // forward: the cursor's group shown in the preview (Follow: only when it is out of view; Show: always, and flashed)
  const showCursor = (force: boolean) => {
    if (!posCurrent()) { if (force) say("the preview is behind the source: try again when it has caught up"); else followPending = true; return; }
    const k = groupAt(src.selectionStart);
    const g = k >= 0 ? groups[k] : undefined;
    if (!g) return;
    const r = g.getBoundingClientRect(), v = right.getBoundingClientRect();
    if (!force && r.top >= v.top && r.top < v.bottom - 24) return;
    g.scrollIntoView({ block: "center" });
    if (force) { g.classList.add("sync-flash"); setTimeout(() => g.classList.remove("sync-flash"), 900); }
  };
  let follow = (() => { try { return localStorage.getItem(FOLLOW_KEY) !== "0"; } catch { return true; } })();
  const showFollow = () => followBtn.setAttribute("aria-pressed", String(follow));
  followBtn.onclick = () => { follow = !follow; try { localStorage.setItem(FOLLOW_KEY, follow ? "1" : "0"); } catch {} showFollow(); if (follow) showCursor(false); };
  showBtn.onclick = () => showCursor(true);
  showFollow();
  for (const e of ["keyup", "click"]) src.addEventListener(e, () => { if (follow) showCursor(false); });

  void parentOf; void enc;
  startWorker();
  request();
}
