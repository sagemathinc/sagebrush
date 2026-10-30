// Comments on a LaTeX document, in the editor's preview (one module for the editor and for grading; the plan:
// latex-comments r1, agreed with @sagebrush-sage). Cut 1: the frozen text (a grader's annotations on a submitted
// proof): threads anchored to source offsets plus the quoted text, highlighted in the preview (CSS Custom
// Highlight API: no element is added to the preview, so its patching is undisturbed), with bubbles in a right margin
// (badges and a bottom sheet in a narrow box), a composer, and a view-only mode. Mapping anchors through edits,
// re-finding, orphans, replies and resolving come in later cuts.
// Offsets are JS string indices (UTF-16) into the editor's text, as mountEditor's.
import type { LatexEditor } from "./component";
import { QUOTE, CONTEXT, MARGIN_MIN, ensureStyle, regs, paint, uid, rangeIn } from "./comments-ui";

export type Anchor = { start: number; end: number; at: number; quote: string; prefix: string; suffix: string; shown?: string };
export type Message = { id: string; author: string; time: number; text: string };
export type Thread = { id: string; anchor: Anchor; messages: Message[]; resolved: null | { by: string; time: number } | false };

/** An anchor for [start, end) of the text: the offsets, the quoted text and its context (and what was selected in the
 * preview, `shown`, when that differs from the source: rendered math). */
export function makeAnchor(text: string, start: number, end: number, shown?: string): Anchor {
  const a: Anchor = { start, end, at: 0, quote: text.slice(start, Math.min(end, start + QUOTE)), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) };
  const s = (shown ?? "").trim().slice(0, QUOTE);
  if (s && s !== a.quote) a.shown = s;
  return a;
}

/** Where an anchor is in the text now: its offsets when they still hold its quote (the frozen case: always); else the
 * occurrence of the quote nearest them; else null (cut 1 draws nothing for it; later cuts list it as orphaned). */
export function locate(a: Anchor, text: string): { start: number; end: number } | null {
  const q = a.quote;
  if (text.slice(a.start, a.start + q.length) === q && a.end <= text.length) return { start: a.start, end: a.end };
  if (!q) return null;
  let best = -1;
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) if (best < 0 || Math.abs(i - a.start) < Math.abs(best - a.start)) best = i;
  return best < 0 ? null : { start: best, end: best + (a.end - a.start) };
}

type Opts = { load(): Thread[]; save(threads: Thread[]): void; mode: "comment" | "view"; author: string; single?: boolean };

/** Comments on `ed`'s preview: `load()` gives the threads, `save()` is called on each change (with all of them). */
export function attachComments(ed: LatexEditor, opts: Opts) {
  ensureStyle();
  const preview = ed.previewRoot(), right = preview.parentElement as HTMLElement;
  const box = preview.closest(".tex-page") as HTMLElement | null;
  const readOnly = () => !!(box?.querySelector(".tex-src") as HTMLTextAreaElement | null)?.readOnly;
  let threads: Thread[] = (opts.load() ?? []).map((t) => ({ ...t, messages: t.messages.slice() }));
  let active: string | null = null;
  // (bubbles and badges in one layer, redrawn; the popover, the composer and the Comment button in another, kept)
  const layer = document.createElement("div"); layer.className = "sb-cm-layer";
  const over = document.createElement("div"); over.className = "sb-cm-layer";
  const pos0 = right.style.position; right.style.position = "relative";
  right.append(layer, over);
  const me = {};
  const save = () => opts.save(threads.map((t) => ({ ...t, messages: t.messages.slice() })));
  let pop: HTMLElement | null = null, go: HTMLElement | null = null, sheet: HTMLElement | null = null;
  const closeAll = () => { pop?.remove(); pop = null; go?.remove(); go = null; sheet?.remove(); sheet = null; };
  const el = (tag: string, cls = "", text = "") => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  // a thread's DOM ranges in the preview: its shown (or quoted) text found in the groups its source range meets; else
  // the first such group's whole content (lightly: still visible)
  const placeOf = (t: Thread): { ranges: Range[]; top: number } | null => {
    const at = locate(t.anchor, ed.getText());
    if (!at) return null;
    const groups = ed.previewRangesOf(at.start, Math.max(at.end, at.start));
    if (!groups.length) return null;
    const want = t.anchor.shown ?? t.anchor.quote;
    let r: Range | null = null;
    for (const g of groups) if ((r = rangeIn(g, want))) break;
    if (!r) { r = document.createRange(); r.selectNodeContents(groups[0]); }
    const rr = r.getBoundingClientRect(), base = right.getBoundingClientRect();
    return { ranges: [r], top: rr.top - base.top + right.scrollTop };
  };

  const draw = () => {
    layer.replaceChildren();
    const wide = right.getBoundingClientRect().width >= MARGIN_MIN;
    right.classList.toggle("sb-cm-margin", wide && threads.length > 0);
    right.classList.toggle("sb-cm-narrow", !wide);
    const all: Range[] = [], act: Range[] = [];
    const placed = threads.map((t, i) => ({ t, i, p: placeOf(t) })).filter((x) => x.p).sort((a, b) => a.p!.top - b.p!.top);
    let below = 0;
    for (const { t, i, p } of placed) {
      all.push(...p!.ranges); if (t.id === active) act.push(...p!.ranges);
      if (wide) {
        const b = el("div", "sb-cm-bubble" + (t.id === active ? " active" : ""));
        b.dataset.thread = t.id;
        const m = t.messages[t.messages.length - 1];
        b.append(el("div", "sb-cm-who", m?.author ?? ""), el("div", "sb-cm-text", m?.text ?? ""));
        const top = Math.max(p!.top, below);
        b.style.top = top + "px";
        b.onclick = (ev) => { ev.stopPropagation(); open(t.id, b); };
        layer.appendChild(b);
        below = top + b.offsetHeight + 6;
      } else {
        const r = p!.ranges[0].getClientRects()[0] ?? p!.ranges[0].getBoundingClientRect(), base = right.getBoundingClientRect();
        const g = el("button", "sb-cm-badge", String(i + 1)) as HTMLButtonElement;
        g.dataset.thread = t.id; g.setAttribute("aria-label", "Comment " + (i + 1));
        // (at the span's end, raised as a superscript: over the end of its own line, not the line above)
        g.style.top = (r.top - base.top + right.scrollTop - 11) + "px";
        g.style.left = Math.max(0, Math.min(right.clientWidth - 30, r.right - base.left + 1)) + "px";
        g.style.right = "auto";
        g.onclick = (ev) => { ev.stopPropagation(); open(t.id, null); };
        layer.appendChild(g);
      }
    }
    regs.set(me, { all, act }); paint();
  };

  // a thread opened: in the margin, a popover by its bubble (edit and delete when commenting); in a narrow box, a sheet
  const open = (id: string, at: HTMLElement | null) => {
    closeAll(); active = id; draw();
    const t = threads.find((x) => x.id === id); if (!t) return;
    const m = t.messages[t.messages.length - 1];
    const panel = at ? el("div", "sb-cm-pop") : el("div", "sb-cm-sheet");
    panel.dataset.thread = id;
    panel.append(el("div", "sb-cm-who", m?.author ?? ""), el("div", "sb-cm-text", m?.text ?? ""));
    const row = el("div", "sb-cm-row");
    if (opts.mode === "comment") {
      const edit = el("button", "", "Edit"), del = el("button", "", "Delete");
      edit.onclick = () => compose(t.anchor, t);
      del.onclick = () => { threads = threads.filter((x) => x.id !== id); active = null; closeAll(); save(); draw(); };
      row.append(edit, del);
    }
    const close = el("button", "", "Close"); close.onclick = () => { active = null; closeAll(); draw(); };
    row.append(close); panel.append(row);
    if (at) { panel.style.top = at.offsetTop + at.offsetHeight + 4 + "px"; panel.style.right = "8px"; over.appendChild(panel); }
    else document.body.appendChild(panel);
    pop = at ? panel : null; sheet = at ? null : panel;
  };

  // the composer: a new comment on an anchor (or an edit of a thread's comment, `t`)
  const compose = (a: Anchor, t?: Thread) => {
    closeAll();
    const p = el("div", right.classList.contains("sb-cm-narrow") ? "sb-cm-sheet" : "sb-cm-pop");
    p.classList.add("sb-cm-compose");
    const ta = document.createElement("textarea"); ta.placeholder = "Comment"; ta.setAttribute("aria-label", "Comment");
    if (t) ta.value = t.messages[t.messages.length - 1]?.text ?? "";
    const ok = el("button", "", t ? "Save" : "Comment"), no = el("button", "", "Cancel");
    const post = () => {
      const text = ta.value.trim(); if (!text) return;
      if (t) { const m = t.messages[t.messages.length - 1]; t.messages[t.messages.length - 1] = { ...m, text, time: Date.now() }; }
      else { const id = uid(); threads.push({ id, anchor: a, messages: [{ id: uid(), author: opts.author, time: Date.now(), text }], resolved: false }); active = id; }
      closeAll(); save(); draw();
    };
    ok.onclick = post; no.onclick = () => { closeAll(); draw(); };
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); post(); } if (ev.key === "Escape") { closeAll(); draw(); } });
    const row = el("div", "sb-cm-row"); row.append(no, ok);
    p.append(ta, row);
    if (p.classList.contains("sb-cm-sheet")) document.body.appendChild(p);
    else {
      const loc = locate(a, ed.getText()), g = loc ? ed.previewRangesOf(loc.start, Math.max(loc.end, loc.start))[0] : null;
      const base = right.getBoundingClientRect(), gr = g?.getBoundingClientRect();
      p.style.top = (gr ? gr.top - base.top + right.scrollTop : right.scrollTop + 8) + "px"; p.style.right = "8px";
      over.appendChild(p);
    }
    if (p.classList.contains("sb-cm-sheet")) sheet = p; else pop = p;
    ta.focus();
  };

  // the current preview selection as an anchor: its source range (narrowed to the selected text when found there); when
  // the selection isn't in the source as typed (rendered math), its group's whole range, with what was shown
  const selected = (): Anchor | null => {
    const s = getSelection(); if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    const r = s.getRangeAt(0); if (!preview.contains(r.commonAncestorContainer)) return null;
    const src = ed.sourceRangeOf(r); if (!src) return null;
    const text = ed.getText(), shown = r.toString();
    if (src.end > src.start) return makeAnchor(text, src.start, src.end, shown);
    const g = ed.groups().find((x) => x.start === src.start);
    return makeAnchor(text, src.start, g ? g.end : src.start, shown);
  };
  const offerFor = () => {
    go?.remove(); go = null;
    if (opts.mode !== "comment") return;
    const s = getSelection(); if (!s || s.rangeCount === 0 || s.isCollapsed) return;
    const r = s.getRangeAt(0); if (!preview.contains(r.commonAncestorContainer)) return;
    const rr = r.getBoundingClientRect(), base = right.getBoundingClientRect();
    const b = el("button", "sb-cm-go", "Comment"); b.setAttribute("aria-label", "Comment on the selection");
    b.style.top = rr.bottom - base.top + right.scrollTop + 4 + "px";
    b.style.left = Math.max(0, Math.min(right.clientWidth - 90, rr.left - base.left)) + "px";
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = (ev) => { ev.stopPropagation(); const a = selected(); if (a) compose(a); };
    over.appendChild(b); go = b;
  };
  const onUp = () => setTimeout(offerFor, 0);
  preview.addEventListener("mouseup", onUp); preview.addEventListener("touchend", onUp);
  // c: a comment on the selection, when the editor is read only (in the editable source, c is typing)
  const onKey = (ev: KeyboardEvent) => {
    if (opts.mode !== "comment" || ev.key !== "c" || ev.ctrlKey || ev.metaKey || ev.altKey || !readOnly()) return;
    const tg = ev.target as HTMLElement | null; if (tg && (tg.tagName === "TEXTAREA" && !(tg as HTMLTextAreaElement).readOnly || tg.tagName === "INPUT" || tg.isContentEditable)) return;
    const a = selected(); if (!a) return;
    ev.preventDefault(); compose(a);
  };
  document.addEventListener("keydown", onKey);
  const off = ed.on("rendered", () => draw());
  const ro = new ResizeObserver(() => draw()); ro.observe(right);
  draw();

  return {
    refresh: () => draw(),
    count: () => threads.length,
    destroy: () => {
      off(); ro.disconnect(); closeAll(); layer.remove(); over.remove(); right.style.position = pos0;
      preview.removeEventListener("mouseup", onUp); preview.removeEventListener("touchend", onUp); document.removeEventListener("keydown", onKey);
      right.classList.remove("sb-cm-margin", "sb-cm-narrow");
      regs.delete(me); paint();
    },
  };
}
