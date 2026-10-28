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
import { imageCandidates, sniffImage, IMAGE_BOUNDS } from "./images";
import { RenderGate, type Token } from "./gate";
import { Highlighter } from "./highlight";
import { PAGE_CSS } from "./style";

export const PATCH_BUDGET = { items: 200, bytes: 512 * 1024, ms: 8 };
const BANNER = "LaTeX editor: an early prototype. Save (Ctrl/Cmd+S) overwrites the file. If the file changed elsewhere since you opened it (another tab, Python, a collaborator), those changes are lost. Nothing is saved automatically. It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";
const BANNER_NO_SAVE = (why: string) => "LaTeX editor: an early prototype. This file can't be saved here: " + why + ". It renders a subset of LaTeX as a web page (not a PDF); unsupported commands appear as gray tags.";

type Host = { ws: Workspace; fid: string; back(): void };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
};
const enc = new TextEncoder();

export async function mount(root: HTMLElement, host: Host): Promise<void> {
  const style = el("style"); style.textContent = PAGE_CSS; document.head.appendChild(style);
  if (!document.getElementById("sb-katex")) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = new URL("katex/katex.min.css", location.href).href; document.head.appendChild(link);
  }
  root.textContent = "";
  const page = el("div", "tex-page"); root.appendChild(page);
  const banner = el("div", "tex-banner"); banner.setAttribute("role", "note");
  const head = el("div", "tex-head");
  const back = el("button", "tex-back", "← Files"); back.onclick = () => host.back();
  const title = el("span", "tex-title");
  const dirty = el("span", "tex-dirty", "Unsaved changes"); dirty.hidden = true;
  const save = el("button", "tex-save", "Save"); save.disabled = true;
  const toggle = el("button", "tex-toggle", "Preview");
  const status = el("span", "tex-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  head.append(back, title, dirty, save, toggle, status);
  const main = el("div", "tex-main");
  const left = el("div", "tex-left"), right = el("div", "tex-right");
  const preview = el("div", "page tex-preview");
  right.appendChild(preview);
  main.append(left, right);
  page.append(banner, head, main);
  banner.textContent = BANNER;
  const say = (t: string) => { status.textContent = t; };
  const gone = (t: string) => { main.textContent = ""; const m = el("div", "tex-gone", t); main.appendChild(m); save.hidden = true; toggle.hidden = true; };

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
  const src = el("textarea", "tex-src"); src.spellcheck = false; src.wrap = "off"; src.setAttribute("aria-label", "LaTeX source");
  src.value = opened.text;
  ed.append(hl, src); left.appendChild(ed);
  const highlighter = new Highlighter(hl, opened.text, (read.content.length > 2 ** 20));
  src.addEventListener("scroll", () => { hl.scrollTop = src.scrollTop; hl.scrollLeft = src.scrollLeft; });

  // ---- the preview: engine worker, gate, patching
  const gate = new RenderGate();
  gate.load(); gate.loaded(gate.token());
  let worker: Worker | null = null, inflight: Token | null = null, queued = false, watchdog: any = null, restartedAt = -1;
  let groups: HTMLElement[] = [], groupHtml: string[] = [];
  const images: Record<string, string | { why: string }> = {};
  const blobs = new Set<string>();
  let imageBytes = 0;
  const startWorker = () => {
    worker?.terminate();
    worker = new Worker(new URL("sagebrush-latex-worker.js", location.href), { type: "module", name: "sagebrush-latex" });
    worker.onmessage = (m) => onReply(m.data);
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
    worker.postMessage({ doc: t.doc, rev: t.rev, text: src.value, images });
  };
  const onReply = (r: any) => {
    const tReply = performance.now();
    clearTimeout(watchdog);
    inflight = null;
    if (queued) request();
    const ok = gate.accept(r);
    if (!ok.patch) return;
    if (!r.ok) { say("the preview failed: " + String(r.error).slice(0, 200)); return; }
    schedulePatch(r.items as { g: number; h: string }[], r.groups as number);
    preview.dataset.replyMs = String(Math.round(performance.now() - tReply));
    if (ok.current) resolveImages(r.imageRefs as string[], gate.token());
  };

  // patching: one wrapper per chunk (group); changed groups are built hidden across frames under the budget, then
  // swapped in one step (old removed, new shown): never two versions of a group at once
  let patchSeq = 0, stepMax = 0, swapMs = 0;   // (the patch loop's own longest step and swap: preview.dataset)
  const schedulePatch = (items: { g: number; h: string }[], ng: number) => {
    const seq = ++patchSeq;
    const html: string[][] = Array.from({ length: ng }, () => []);
    for (const it of items) html[it.g]?.push(it.h);
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
      const yieldNow = () => { stepMax = Math.max(stepMax, performance.now() - t0); requestAnimationFrame(step); };
      while (g < next.length - s) {
        if (k === 0) { const w = el("div", "ch"); w.hidden = true; staged.push(w); preview.appendChild(w); }
        const pieces = html[g], w = staged[staged.length - 1];
        while (k < pieces.length) {
          const h = pieces[k];
          if (count >= PATCH_BUDGET.items || bytesIn + h.length > PATCH_BUDGET.bytes && count > 0 || performance.now() - t0 > PATCH_BUDGET.ms) return yieldNow();
          const piece = document.createElement("div"); piece.className = "pc"; piece.innerHTML = h; w.appendChild(piece);
          count++; bytesIn += h.length; k++;
        }
        k = 0; g++;
      }
      // all new groups ready: swap them in, in one step (old ones hidden, new ones moved and shown: no parsing);
      // the old ones are removed afterwards, one per frame, while hidden, so they are never shown with the new
      const tSwap = performance.now();
      const kids = groups;
      const before = kids[groupHtml.length - s] ?? null;
      const old = kids.slice(p, groupHtml.length - s);
      for (const w of old) w.hidden = true;
      for (const w of staged) { preview.insertBefore(w, before); w.hidden = false; }
      groups = kids.slice(0, p).concat(staged, kids.slice(groupHtml.length - s));
      groupHtml = next;
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
      preview.dataset.patchMaxMs = String(Math.round(stepMax)); preview.dataset.swapMaxMs = String(Math.round(swapMs));
    };
    step();
  };

  // ---- images (r5 §3): resolved inside the file's folder, read by identity, checked, shown from blob: URLs
  const resolveImages = async (refs: string[], tok: Token) => {
    let changed = false;
    for (const name of refs) {
      if (Object.hasOwn(images, name)) continue;
      if (Object.keys(images).length >= IMAGE_BOUNDS.perDocument) { images[name] = { why: "too many images" }; changed = true; continue; }
      const c = imageCandidates(name, where.path);
      if (!c.ok) { images[name] = { why: c.why }; changed = true; continue; }
      let found: Entry | undefined;
      for (const p of c.paths) { const e = await host.ws.stat(p).catch(() => undefined); if (e && e.kind === "file" && !e.trashed) { found = e; break; } }
      if (!gate.sameDoc(tok)) return;
      if (!found) { images[name] = { why: "not found" }; changed = true; continue; }
      if ((found.size ?? 0) > IMAGE_BOUNDS.perImage || imageBytes + (found.size ?? 0) > IMAGE_BOUNDS.total) { images[name] = { why: "too large" }; changed = true; continue; }
      let r: { entry: Entry; content: Uint8Array };
      try { r = await host.ws.readUpTo(found.path, IMAGE_BOUNDS.perImage); } catch { if (gate.sameDoc(tok)) { images[name] = { why: "not readable" }; changed = true; } continue; }
      // (the same file, by identity, when the read completes; else dropped)
      const now = await host.ws.stat(found.path).catch(() => undefined);
      if (!gate.sameDoc(tok)) return;
      if (!now || now.fid !== found.fid || r.entry.fid !== found.fid || now.updated !== found.updated) { images[name] = { why: "changed while it was read" }; changed = true; continue; }
      const sn = sniffImage(r.content);
      if (!sn.ok) { images[name] = { why: sn.why }; changed = true; continue; }
      if (sn.pixels !== null && sn.pixels > IMAGE_BOUNDS.megapixels * 1e6) { images[name] = { why: "too large" }; changed = true; continue; }
      imageBytes += r.content.length;
      const url = URL.createObjectURL(new Blob([r.content as BlobPart], { type: sn.mime }));
      blobs.add(url); images[name] = url; changed = true;
    }
    if (changed && gate.sameDoc(tok)) request();
  };
  const dropImages = () => { for (const u of blobs) URL.revokeObjectURL(u); blobs.clear(); };

  // ---- editing
  let editTimer: any = null;
  const isDirty = () => src.value !== savedText;
  const showDirty = () => { const d = isDirty(); dirty.hidden = !d; save.disabled = !d || !saveable || saving; };
  src.addEventListener("input", () => {
    gate.edit(); showDirty();
    highlighter.update(src.value);
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

  void parentOf; void enc;
  startWorker();
  request();
}
