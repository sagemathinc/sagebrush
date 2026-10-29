// The LaTeX editor's core, shared by the file page (page.ts, mount) and the embeddable component (component.ts,
// mountEditor): the source (a textarea, the highlighter's lines drawn behind it), the preview (the engine worker, the
// request gate, the patching of changed groups) and the two kept in sync (Follow, Show, a double-click). It knows no
// files: a host gives it the text, its own elements, a place for messages and, if it shows images, their resolver.
import { RenderGate, type Token } from "./gate";
import { Highlighter } from "./highlight";
import { mark } from "./marks";

declare const __SB_LATEX_TEST__: boolean | undefined;

export const PATCH_BUDGET = { items: 200, bytes: 512 * 1024, ms: 8 };
export const FOLLOW_KEY = "sagebrush-latex-follow";

type Item = { g: number; h: string; b?: number };

export type EditorOpts = {
  left: HTMLElement;              // the source's box
  right: HTMLElement;             // the preview's scrolling box
  preview: HTMLElement;           // the preview's page (the groups go in here)
  text: string;
  large?: boolean;                // a large file: the highlighter draws it plain
  readOnly?: boolean;
  workerUrl: URL;
  say(t: string): void;
  // the image names: the same object is sent with every request; a host that resolves them fills it and calls request()
  images?: Record<string, string | { why: string }>;
  onImageRefs?(refs: string[], tok: Token): void;
  onEdit?(): void;                // after each edit by the person (not setText), once the request for it is made
};

export type Editor = ReturnType<typeof createEditor>;

export function createEditor(o: EditorOpts) {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = ""): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const { right, preview, say } = o;
  const images = o.images ?? {};

  // ---- the editor (a textarea, with the highlighter's lines drawn behind it)
  const ed = el("div", "tex-ed");
  const hl = el("div", "tex-hl"); hl.setAttribute("aria-hidden", "true");
  const src = el("textarea", "tex-src"); src.spellcheck = false; src.setAttribute("aria-label", "LaTeX source");
  src.value = o.text;
  if (o.readOnly) src.readOnly = true;
  ed.append(hl, src); o.left.appendChild(ed);
  const highlighter = new Highlighter(hl, o.text, !!o.large);
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
  const fitObs = new ResizeObserver(fit); fitObs.observe(src);

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
  const rendered = new Set<() => void>();
  let destroyed = false;
  const startWorker = () => {
    worker?.terminate();
    worker = new Worker(o.workerUrl, { type: "module", name: "sagebrush-latex" });
    worker.onmessage = (m) => {
      // (the test build only: the page test can hold a reply here; elsewhere this folds away)
      const held = typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__ ? (globalThis as any).__sbTexReplyHold?.(m.data?.rev) : undefined;
      if (held) void held.then(() => onReply(m.data)); else onReply(m.data);
    };
    worker.onerror = () => say("the preview's engine stopped");
  };
  const request = () => {
    if (destroyed || !gate.canSend() || !worker) return;
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
    if (destroyed) return;
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
    if (ok.current) o.onImageRefs?.(r.imageRefs as string[], gate.token());
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
      if (seq !== patchSeq || destroyed) { for (const w of staged) w.remove(); return; }
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
      // (the host's listeners: the preview now shows the source as it is)
      if (posCurrent()) for (const f of [...rendered]) f();
    };
    step();
  };

  // ---- editing
  const edited = (byPerson: boolean) => {
    gate.edit(); mark("tex-input", { rev: gate.token().rev });
    highlighter.update(src.value);
    setWrap();
    request();
    if (byPerson) o.onEdit?.();
  };
  src.addEventListener("input", () => edited(true));
  // the host's own change of the text: drawn and rendered as an edit is, but not reported back to it (onEdit)
  const setText = (t: string) => { if (t === src.value) return; src.value = t; edited(false); };

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
  // a group's source range: from where it begins to where the next group (by offset) does, else the text's end
  const rangeOf = (k: number): { start: number; end: number } | null => {
    const start = groupPos[k];
    if (start === undefined || start < 0) return null;
    const nx = above(start);
    return { start, end: nx < posIndex.length ? posIndex[nx][0] : src.value.length };
  };
  // a word (or any text) from the preview, found in its group's source range; else the group's start
  const findIn = (k: number, text: string) => {
    const r = rangeOf(k);
    if (!r) return null;
    const t = text.trim();
    if (t) { const i = src.value.indexOf(t, r.start); if (i >= 0 && i < r.end) return { start: i, end: i + t.length }; }
    return { start: r.start, end: r.start };
  };
  // inverse: a double-click in the preview puts the cursor at that place in the source (the word clicked, searched
  // from where its group begins to where the next one does; else the group's start)
  preview.addEventListener("dblclick", (ev) => {
    const w = (ev.target as HTMLElement).closest(".ch") as HTMLElement | null;
    const k = w ? groups.indexOf(w) : -1;
    if (k < 0 || !rangeOf(k)) return;
    if (!posCurrent()) { say("the preview is behind the source: try again when it has caught up"); return; }
    const at = findIn(k, getSelection()?.toString() ?? "")!;
    revealSource(at.start, at.end);
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
  const setFollow = (on: boolean) => { follow = on; try { localStorage.setItem(FOLLOW_KEY, on ? "1" : "0"); } catch {} if (on) showCursor(false); };
  for (const e of ["keyup", "click"]) src.addEventListener(e, () => { if (follow) showCursor(false); });

  startWorker();
  request();

  return {
    src, hl, gate, preview, request, setText,
    getText: () => src.value,
    posCurrent, showCursor, setFollow, following: () => follow, revealSource,
    // each group with a known position, in order, with its source range [start, end) (UTF-16 offsets into the text)
    groups: () => { const out: { el: HTMLElement; start: number; end: number }[] = []; groups.forEach((g, k) => { const r = rangeOf(k); if (r) out.push({ el: g, ...r }); }); return out; },
    groupOf: (el: Node | null) => { const w = (el instanceof Element ? el : el?.parentElement)?.closest(".ch") as HTMLElement | null; return w ? groups.indexOf(w) : -1; },
    findIn, rangeOf,
    onRendered: (f: () => void) => { rendered.add(f); return () => { rendered.delete(f); }; },
    destroy: () => { destroyed = true; clearTimeout(watchdog); worker?.terminate(); worker = null; fitObs.disconnect(); rendered.clear(); },
  };
}
