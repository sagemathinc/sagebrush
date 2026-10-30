// Comments on a LaTeX document in the editor (plan latex-comments r4.2 §4): the threads of paper.tex live beside it in
// paper.tex.comments.json (web/latex/comments-core.mjs: the format, merge, anchors), read and written through the
// workspace with compare-and-swap, so a person here and an agent (the CLI, the MCP tools) lose nothing to each other.
// Shown in the preview (highlights, bubbles in a wide box, badges and a sheet in a narrow one) and as marks in the
// source; each thread opened with its messages, a reply, resolve or reopen, and delete; the Comments list with the open
// ones, those that need a place (ambiguous: their candidates), those on text that was removed, and the resolved.
// Anchors are mapped through the person's edits here, and written again (offsets and the text's hash) when the .tex is
// saved. Messages from an agent ("agent:<name>") are labelled so.
import type { LatexEditor } from "./component";
import * as C from "./comments-core.mjs";
import { MARGIN_MIN, ensureStyle, regs, paint, el, rangeIn } from "./comments-ui";
import { mark } from "./marks";

type View = Omit<LatexEditor, "setText" | "destroy">;
type Io = { read(o: { signal?: AbortSignal }): Promise<{ content: string | null; base: unknown }>; write(content: string, base: unknown, o: { signal?: AbortSignal }): Promise<unknown> };
export type DocCommentsOpts = {
  io: Io;                       // the comments file (the page's: the workspace's read and write with base)
  file: { fid: string | null; path: string };
  author: string;               // "person:..." here
  src: HTMLTextAreaElement;     // the source
  hl: HTMLElement;              // the source's highlighter layer (its lines, behind the textarea)
  button: HTMLButtonElement;    // the page's Comments button (its count shown here)
};
type Place = { op: string; status: string; s: number; e: number; candidates?: { start: number; end: number }[] };

/** Ctrl/Cmd+Alt+M: a comment on the source's selection (the page asks before this module is loaded). */
export const isCommentKey = (ev: KeyboardEvent) => (ev.ctrlKey || ev.metaKey) && ev.altKey && (ev.key.toLowerCase() === "m" || ev.code === "KeyM");
const who = (a: string, me: string) => (a === me ? "You" : a.replace(/^(person|agent):/, "") || a);
const isAgent = (a: string) => a.startsWith("agent:");
const when = (t: string) => { const d = new Date(t); return isNaN(+d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const STATUS_NOTE: Record<string, string> = { changed: "the commented text was rewritten", moved: "", exact: "", ambiguous: "the commented text occurs more than once: choose its place", orphaned: "the commented text was removed", unresolved: "not placed (too much to search)" };

/** The live comments of a document in the page's editor; `ready` once the comments file was read. */
export function attachDocComments(ed: View, o: DocCommentsOpts) {
  ensureStyle();
  const preview = ed.previewRoot(), right = preview.parentElement as HTMLElement;
  const me = {}, life = new AbortController(), on = { signal: life.signal };
  let doc: any = C.emptyDoc(o.file), loaded = false, error = "";
  let active: string | null = null;
  const places = new Map<string, Place>();
  // (bubbles and badges in one layer, redrawn; the open panel, the composer and the Comment button in another)
  const layer = el("div", "sb-cm-layer"), over = el("div", "sb-cm-layer");
  const pos0 = right.style.position; right.style.position = "relative";
  right.append(layer, over);
  let panel: HTMLElement | null = null, go: HTMLElement | null = null, list: HTMLElement | null = null;
  const closeAll = () => { panel?.remove(); panel = null; go?.remove(); go = null; };

  // ---- the threads and their places in the text now
  const live = () => doc.threads.filter((t: any) => !t.deleted.value);
  const msgs = (t: any) => t.messages.filter((m: any) => !m.deleted.value);
  // (a thread is placed once per anchor write: later, its offsets are mapped through the edits made here). The work
  // runs in slices of at most SLICE_MS, a frame given back between them (r3 §7.6): the text hashed in pieces (once
  // per text: kept for new anchors), then the threads resolved a few at a time; an edit meanwhile starts it again
  // (a slice ends at the first pause past SLICE_MS: a step after it is at most a window of the text, about a
  // millisecond, so slices stay within 8 ms)
  const SLICE_MS = 5, HASH_PIECE = 1 << 14;
  let placing = 0, shaFor = { text: null as string | null, sha: "" };
  // comments are for a .tex of at most 2 Mi UTF-16 units (the core's LIMITS.sourceUnits): above, the person is told so,
  // nothing is placed or written, and the comments file is left as it is
  let refused = "";
  const sizeOk = (text: string) => { refused = text.length > C.LIMITS.sourceUnits ? "Comments are available for documents up to 2 MiB (this one is " + (text.length / (1 << 20)).toFixed(1) + " MiB)" : ""; return !refused; };
  const frame = () => new Promise<void>((r) => setTimeout(r, 0));
  const placeAll = async () => {
    const gen = ++placing, text = ed.getText(), stale = () => gen !== placing || life.signal.aborted;
    if (!sizeOk(text)) { places.clear(); queueDraw(); showList(); return; }
    const seen = new Set(live().map((t: any) => t.id));
    for (const id of [...places.keys()]) if (!seen.has(id)) places.delete(id);
    const todo = live().filter((t: any) => places.get(t.id)?.op !== t.anchor.op);
    if (todo.length) {
      let t0 = performance.now(), slices = 1, maxSlice = 0, phase = "hash", maxPhase = "";
      const pause = async () => { const d = performance.now() - t0; if (d < SLICE_MS) return false; if (d > maxSlice) { maxSlice = d; maxPhase = phase; } slices++; await frame(); t0 = performance.now(); return stale(); };
      if ((await hashOf(text, pause)) === null) return;
      phase = "resolve";
      if (await pause()) return;
      const R = C.resolver(text, undefined, { textSha: shaFor.sha });
      for (const t of todo) {
        // (each anchor's search, a step at a time: a window of the text searched, or a piece of a long span hashed)
        const g = R.steps(t.anchor.value);
        let r: any;
        for (;;) { const x = g.next(); if (x.done) { r = x.value; break; } if (await pause()) return; }
        if (await pause()) return;
        places.set(t.id, { op: t.anchor.op, status: r.status, s: r.start ?? -1, e: r.end ?? -1, candidates: r.candidates });
      }
      if (performance.now() - t0 > maxSlice) { maxSlice = performance.now() - t0; maxPhase = phase; }
      const statuses: Record<string, number> = {}; for (const t of todo) { const st = places.get(t.id)!.status; statuses[st] = (statuses[st] ?? 0) + 1; }
      mark("tex-comments-placed", { threads: todo.length, slices, maxSliceMs: Math.round(maxSlice * 10) / 10, maxSlicePhase: maxPhase, work: R.work(), units: text.length, statuses });
    }
    if (!stale()) { queueDraw(); showList(); }
  };
  // the text's hash, in pieces, `pause` between them (true: stop, null returned); kept for the text it was taken of
  async function hashOf(text: string, pause: () => Promise<boolean>): Promise<string | null> {
    if (shaFor.text === text) return shaFor.sha;
    const h = C.sha256Hasher();
    for (let i = 0; i < text.length;) { const j = C.sliceAt(text, i + HASH_PIECE); h.update(text.slice(i, j)); i = j; if (await pause()) return null; }
    shaFor = { text, sha: h.digest() };
    return shaFor.sha;
  }
  // (an anchor for a span of the text now: its hash reused when it was taken for this text)
  const anchorAt = (s: number, e: number, shown?: string) => { const text = ed.getText(); return C.makeAnchor(text, s, e, shown, shaFor.text === text ? shaFor.sha : undefined); };
  const placed = (p?: Place) => !!p && p.s >= 0 && (p.status === "exact" || p.status === "moved" || p.status === "changed");

  // ---- reading and writing the comments file (each write: the file re-read, the operation applied to it, merged by
  // the core's rules, compare-and-swap; conflicts retried; a refusal keeps the draft)
  let base: unknown = undefined;
  const reload = async () => {
    try {
      const r = await o.io.read(on);
      if (life.signal.aborted) return;
      if (loaded && r.base === base) return;
      doc = C.parse(r.content, o.file); base = r.base; loaded = true; error = "";
    } catch (e: any) { if (life.signal.aborted) return; error = "The comments file can't be read: " + String(e?.message ?? e); loaded = true; }
    await placeAll();
  };
  const write = async (op: (d: any) => { doc: any; id?: string }, draft = ""): Promise<string | undefined> => {
    if (!sizeOk(ed.getText())) { error = refused; queueDraw(); showList(); return undefined; }
    try {
      const res = await C.update(o.io, op, { file: o.file, draft });
      if (life.signal.aborted) return;
      // (the next reload reads the file again: its base after this write isn't known here)
      doc = res.doc; base = undefined; error = "";
      await placeAll();
      return res.id ?? "";
    } catch (e: any) {
      if (life.signal.aborted) return;
      error = e?.code === "busy" ? "Not saved: the comments file kept changing. Your text is kept: try again." : "Not saved: " + String(e?.message ?? e);
      queueDraw(); showList();
      return undefined;
    }
  };

  // ---- the person's edits: every placed anchor mapped (the start sticks right, the end sticks left), from the edit's
  // first and last differing units
  let prev = ed.getText(), version = 0;
  const onInput = () => {
    const next = o.src.value;
    if (next === prev) return;
    let a = 0; const n = Math.min(prev.length, next.length);
    while (a < n && prev.charCodeAt(a) === next.charCodeAt(a)) a++;
    let z = 0; while (z < n - a && prev.charCodeAt(prev.length - 1 - z) === next.charCodeAt(next.length - 1 - z)) z++;
    const oldEnd = prev.length - z, delta = next.length - prev.length;
    const map = (x: number, right: boolean) => (x < a || (x === a && !right) ? x : x >= oldEnd ? x + delta : right ? a + (next.length - z - a) : a);
    for (const p of places.values()) if (placed(p)) { p.s = map(p.s, true); p.e = Math.max(p.s, map(p.e, false)); }
    prev = next; version++;
    if ((next.length > C.LIMITS.sourceUnits) !== !!refused || live().some((t: any) => places.get(t.id)?.op !== t.anchor.op)) void placeAll();
    scheduleMarks();
  };
  o.src.addEventListener("input", onInput, on);

  // ---- the source's marks: the placed ranges over the highlighter's lines (redrawn after its rescans settle)
  let srcRanges: Range[] = [], marksTimer: any = null;
  const scheduleMarks = () => { clearTimeout(marksTimer); marksTimer = setTimeout(() => { srcRanges = sourceRanges(); setRegs(); }, 120); };
  let lineCache: { v: number; L: ReturnType<typeof C.lineIndex> } | null = null;
  // (the marks of the lines in and next to the source's view only: found by their boxes, a binary search)
  const sourceRanges = () => {
    const out: Range[] = [], lines = o.hl.children;
    if (!lines.length || refused) return out;
    const text = ed.getText();
    if (lineCache?.v !== version) lineCache = { v: version, L: C.lineIndex(text) };
    const L = lineCache.L, sr = o.src.getBoundingClientRect(), lo = sr.top - sr.height, hi = sr.bottom + sr.height;
    const firstAt = (y: number) => { let a = 0, b = lines.length; while (a < b) { const m = (a + b) >> 1; if ((lines[m] as HTMLElement).getBoundingClientRect().bottom < y) a = m + 1; else b = m; } return a + 1; };
    const l0 = firstAt(lo), l1 = firstAt(hi);
    const point = (off: number): [Node, number] | null => {
      const { line, col } = L.at(off), lineEl = lines[line - 1] as HTMLElement | undefined;
      if (!lineEl) return null;
      let left = col - 1;
      const tw = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let t = tw.nextNode() as Text | null; t; t = tw.nextNode() as Text | null) { if (left <= t.data.length) return [t, left]; left -= t.data.length; last = t; }
      return last ? [last, last.data.length] : null;
    };
    for (const t of live()) {
      const p = places.get(t.id); if (!placed(p) || t.resolved.value || p!.e <= p!.s) continue;
      if (L.at(p!.e).line < l0 || L.at(p!.s).line > l1) continue;
      const a = point(p!.s), b = point(p!.e); if (!a || !b) continue;
      try { const r = document.createRange(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); out.push(r); } catch {}
    }
    return out;
  };
  let pvAll: Range[] = [], pvAct: Range[] = [];
  const setRegs = () => { regs.set(me, { all: [...pvAll, ...srcRanges], act: pvAct }); paint(); };

  // ---- the preview: highlights, and bubbles (wide) or badges (narrow), for the open placed threads
  const rangeFor = (t: any, p: Place): { r: Range; top: number } | null => {
    const groups = ed.previewRangesOf(p.s, Math.max(p.e, p.s));
    if (!groups.length) return null;
    const a = t.anchor.value, text = ed.getText(), want = p.status === "changed" ? text.slice(p.s, Math.min(p.e, p.s + 300)) : a.shown ?? a.quote;
    let r: Range | null = null;
    for (const g of groups) if ((r = rangeIn(g, want))) break;
    if (!r) { r = document.createRange(); r.selectNodeContents(groups[0]); }
    const rr = r.getBoundingClientRect(), b0 = right.getBoundingClientRect();
    return { r, top: rr.top - b0.top + right.scrollTop };
  };
  // Drawn for the threads near the preview's view only (a screen above and below), so the work is bounded by what
  // can be seen, not by the number of threads; redrawn on scroll. All the reads (boxes) come before the writes, and the
  // bubbles' heights are read once, after they are all in: two layouts, whatever the count.
  let drawQueued = false;
  // (after the frame is painted: the preview laid out already, so the boxes read are cheap, not a layout of a freshly
  // patched preview charged to the comments)
  const queueDraw = () => { if (drawQueued) return; drawQueued = true; requestAnimationFrame(() => setTimeout(() => { drawQueued = false; if (!life.signal.aborted) draw(); }, 0)); };
  const draw = () => {
    const t0 = performance.now();
    const open = live().filter((t: any) => !t.resolved.value);
    o.button.textContent = refused ? "Comments: over 2 MiB" : "Comments" + (open.length ? " (" + open.length + ")" : "");
    o.button.title = refused;
    o.button.classList.toggle("has", !refused && open.length > 0);
    const wide = right.getBoundingClientRect().width >= MARGIN_MIN;
    // (the open placed threads in source order: their numbers; the preview's groups, once, by start)
    const items = refused ? [] : open.map((t: any) => ({ t, p: places.get(t.id)! })).filter((x: any) => placed(x.p)).sort((x: any, y: any) => x.p.s - y.p.s || (x.t.id < y.t.id ? -1 : 1));
    const groups = items.length ? ed.groups() : [];
    const groupAt = (off: number) => { let a = 0, b = groups.length - 1, k = -1; while (a <= b) { const m = (a + b) >> 1; if (groups[m].start <= off) { k = m; a = m + 1; } else b = m - 1; } return k >= 0 && off < groups[k].end ? groups[k] : groups.find((g) => g.start >= off) ?? null; };
    // reads
    const b0 = right.getBoundingClientRect(), H = right.clientHeight;
    const near: any[] = [];
    items.forEach((x: any, i: number) => {
      const g = groupAt(x.p.s); if (!g) return;
      const gr = g.el.getBoundingClientRect();
      if (gr.bottom < b0.top - H || gr.top > b0.bottom + H) return;
      const at = rangeFor(x.t, x.p); if (!at) return;
      near.push({ ...x, n: i + 1, at, rect: wide ? null : at.r.getClientRects()[0] ?? at.r.getBoundingClientRect() });
    });
    near.sort((x, y) => x.at.top - y.at.top);
    // writes
    layer.replaceChildren();
    right.classList.toggle("sb-cm-margin", wide && items.length > 0);
    right.classList.toggle("sb-cm-narrow", !wide);
    pvAll = near.map((x) => x.at.r); pvAct = near.filter((x) => x.t.id === active).map((x) => x.at.r);
    const made: HTMLElement[] = [], frag = document.createDocumentFragment();
    for (const { t, n, rect } of near) {
      const ms = msgs(t), last = ms[ms.length - 1], agent = ms.some((m: any) => isAgent(m.author));
      if (wide) {
        const b = el("div", "sb-cm-bubble" + (t.id === active ? " active" : "") + (agent ? " agent" : ""));
        b.dataset.thread = t.id;
        const w = el("div", "sb-cm-who", who(last?.author ?? "", o.author)); if (last && isAgent(last.author)) w.append(el("span", "sb-cm-agent", "agent"));
        b.append(w, el("div", "sb-cm-text", last?.text.value ?? ""));
        if (ms.length > 1) b.append(el("div", "sb-cm-who", ms.length + " messages"));
        b.onclick = (ev) => { ev.stopPropagation(); openThread(t.id, b); };
        made.push(b); frag.appendChild(b);
      } else {
        const g = el("button", "sb-cm-badge", String(n)) as HTMLButtonElement;
        g.dataset.thread = t.id; g.setAttribute("aria-label", "Comment " + n);
        g.style.top = (rect.top - b0.top + right.scrollTop - 11) + "px";
        g.style.left = Math.max(0, Math.min(right.clientWidth - 30, rect.right - b0.left + 1)) + "px";
        g.onclick = (ev) => { ev.stopPropagation(); openThread(t.id, null); };
        frag.appendChild(g);
      }
    }
    layer.appendChild(frag);
    if (made.length) {
      const hs = made.map((b) => b.offsetHeight);
      let below = -Infinity;
      made.forEach((b, i) => { const top = Math.max(near[i].at.top, below); b.style.top = top + "px"; below = top + hs[i] + 6; });
    }
    setRegs(); scheduleMarks();
    mark("tex-comments-drawn", { ms: Math.round((performance.now() - t0) * 10) / 10, threads: open.length, placed: items.length, drawn: near.length, groups: groups.length, wide });
  };
  right.addEventListener("scroll", queueDraw, { passive: true, signal: life.signal });
  o.src.addEventListener("scroll", scheduleMarks, { passive: true, signal: life.signal });

  // ---- a thread: its quote, status, messages, a reply, resolve or reopen, delete
  const box = (at: HTMLElement | null, cls: string) => {
    closeAll();
    const p = el("div", (at || !right.classList.contains("sb-cm-narrow") ? "sb-cm-pop " : "sb-cm-sheet ") + cls);
    if (p.classList.contains("sb-cm-sheet")) document.body.appendChild(p);
    else { p.style.top = (at ? at.offsetTop + at.offsetHeight + 4 : right.scrollTop + 8) + "px"; p.style.right = "8px"; over.appendChild(p); }
    panel = p; return p;
  };
  const composerIn = (p: HTMLElement, label: string, send: (text: string) => Promise<boolean>, draft = "") => {
    const ta = document.createElement("textarea"); ta.placeholder = label; ta.setAttribute("aria-label", label); ta.value = draft;
    const ok = el("button", "sb-cm-send", label === "Reply" ? "Reply" : "Comment");
    const post = async () => { const text = ta.value.trim(); if (!text) return; ok.setAttribute("disabled", ""); const done = await send(text); ok.removeAttribute("disabled"); if (!done) { const e = p.querySelector(".sb-cm-err") ?? p.appendChild(el("div", "sb-cm-err")); e.textContent = error; } };
    ok.onclick = () => void post();
    ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); void post(); } if (ev.key === "Escape") { closeAll(); active = null; draw(); } });
    const row = el("div", "sb-cm-row"); row.append(ok);
    p.append(ta, row);
    return { ta, ok, row };
  };
  const openThread = (id: string, at: HTMLElement | null) => {
    active = id; draw();
    const t = live().find((x: any) => x.id === id); if (!t) return;
    const pl = places.get(id), a = t.anchor.value;
    const p = box(at, "sb-cm-thread"); p.dataset.thread = id;
    p.append(el("div", "sb-cm-quote", a.tail === undefined ? a.quote : a.quote + "…"));
    const note = STATUS_NOTE[pl?.status ?? ""] ?? ""; if (note) p.append(el("div", "sb-cm-note", note));
    if (t.resolved.value) p.append(el("div", "sb-cm-note", "Resolved by " + who(t.resolved.by, o.author)));
    for (const m of msgs(t)) {
      const d = el("div", "sb-cm-msg" + (isAgent(m.author) ? " agent" : ""));
      const w = el("div", "sb-cm-who", who(m.author, o.author) + " · " + when(m.time)); if (isAgent(m.author)) w.append(el("span", "sb-cm-agent", "agent"));
      d.append(w, el("div", "sb-cm-text", m.text.value)); p.append(d);
    }
    const { ta } = composerIn(p, "Reply", async (text) => (await write((d) => C.reply(d, id, { text, author: o.author }), text)) !== undefined ? (openThread(id, null), true) : false);
    const row = el("div", "sb-cm-row");
    const rs = el("button", "sb-cm-resolve", t.resolved.value ? "Reopen" : "Resolve");
    rs.onclick = async () => { if ((await write((d) => C.setResolved(d, id, !t.resolved.value, { author: o.author }))) !== undefined) { active = null; closeAll(); draw(); } };
    const del = el("button", "sb-cm-delete", "Delete");
    del.onclick = async () => { if (!confirm("Delete this comment thread?")) return; if ((await write((d) => C.deleteThread(d, id, { author: o.author }))) !== undefined) { active = null; closeAll(); draw(); } };
    if (!placed(pl)) { const ra = el("button", "sb-cm-attach", "Attach to selection"); ra.title = "Select text in the source first"; ra.onclick = () => void attachToSelection(id); row.append(ra); }
    const x = el("button", "", "Close"); x.onclick = () => { active = null; closeAll(); draw(); };
    row.append(rs, del, x); p.append(row);
    if (error) p.append(el("div", "sb-cm-err", error));
    ta.focus({ preventScroll: true });
  };

  // ---- new threads: on the preview's selection (the Comment button) or the source's (Ctrl/Cmd+Alt+M)
  const compose = (s: number, e: number, shown?: string) => {
    if (!sizeOk(ed.getText())) { if (!list) openList(); return; }
    const anchor = anchorAt(s, e, shown);
    const g = ed.previewRangesOf(s, Math.max(s, e))[0];
    const p = box(null, "sb-cm-compose");
    if (g && p.classList.contains("sb-cm-pop")) { const b0 = right.getBoundingClientRect(); p.style.top = g.getBoundingClientRect().top - b0.top + right.scrollTop + "px"; }
    p.append(el("div", "sb-cm-quote", anchor.quote));
    const { ta, row } = composerIn(p, "Comment", async (body) => {
      const id = await write((d) => C.addThread(d, { anchor, text: body, author: o.author }), body);
      if (id === undefined) return false;
      closeAll(); active = id; draw(); return true;
    });
    const no = el("button", "", "Cancel"); no.onclick = () => { closeAll(); draw(); };
    row.prepend(no);
    ta.focus({ preventScroll: true });
  };
  const fromPreview = (): { s: number; e: number; shown: string } | null => {
    const sel = getSelection(); if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0); if (!preview.contains(r.commonAncestorContainer)) return null;
    const src = ed.sourceRangeOf(r); if (!src) return null;
    if (src.end > src.start) return { s: src.start, e: src.end, shown: r.toString() };
    const g = ed.groups().find((x) => x.start === src.start);
    return { s: src.start, e: g ? g.end : src.start, shown: r.toString() };
  };
  const offer = () => {
    go?.remove(); go = null;
    const sel = getSelection(); if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const r = sel.getRangeAt(0); if (!preview.contains(r.commonAncestorContainer)) return;
    const rr = r.getBoundingClientRect(), b0 = right.getBoundingClientRect();
    const b = el("button", "sb-cm-go", "Comment"); b.setAttribute("aria-label", "Comment on the selection");
    b.style.top = rr.bottom - b0.top + right.scrollTop + 4 + "px";
    b.style.left = Math.max(0, Math.min(right.clientWidth - 90, rr.left - b0.left)) + "px";
    b.onmousedown = (ev) => ev.preventDefault();
    b.onclick = (ev) => { ev.stopPropagation(); const a = fromPreview(); if (a) compose(a.s, a.e, a.shown); };
    over.appendChild(b); go = b;
  };
  const onUp = () => setTimeout(offer, 0);
  preview.addEventListener("mouseup", onUp, on); preview.addEventListener("touchend", onUp, on);
  const fromSource = () => { const s = o.src.selectionStart, e = o.src.selectionEnd; return e > s ? { s, e } : null; };
  const commentSelection = () => { const a = fromSource(); if (a) compose(a.s, a.e); };
  o.src.addEventListener("keydown", (ev) => { if (isCommentKey(ev)) { ev.preventDefault(); commentSelection(); } }, on);
  const attachToSelection = async (id: string) => {
    const a = fromSource() ?? (() => { const p = fromPreview(); return p ? { s: p.s, e: p.e } : null; })();
    if (!a) { error = "Select the text to attach it to first (in the source or the preview)."; openThread(id, null); return; }
    const anchor = anchorAt(a.s, a.e);
    if ((await write((d) => C.reattach(d, id, anchor, { author: o.author }))) !== undefined) openThread(id, null);
  };

  // ---- the Comments list: open, needing a place (with their candidates), on removed text, resolved
  const showList = () => {
    if (!list) return;
    list.replaceChildren();
    const head = el("div", "sb-cm-row"), x = el("button", "", "Close"); x.onclick = () => { list?.remove(); list = null; };
    head.append(x); list.append(head);
    if (error) list.append(el("div", "sb-cm-err", error));
    const t0 = performance.now(); let shown = 0;
    if (refused) list.append(el("div", "sb-cm-note sb-cm-refused", refused));
    // (each section shows its first PER_SECTION, then "Show all": a document's 2,000 threads aren't all drawn at once)
    const ts = live(), sec = (title: string, items: any[], extra?: (t: any, d: HTMLElement) => void) => {
      if (!items.length) return;
      list!.append(el("h3", "", title + " (" + items.length + ")"));
      const cut = showAll.has(title) ? items : items.slice(0, PER_SECTION);
      shown += cut.length;
      if (cut.length < items.length) queueMicrotask(() => { const more = el("button", "sb-cm-more", "Show all " + items.length); more.onclick = () => { showAll.add(title); showList(); }; list?.querySelector(`h3[data-sec="${title}"]`)?.after(more); });
      (list!.lastChild as HTMLElement).dataset.sec = title;
      for (const t of cut) {
        const ms = msgs(t), last = ms[ms.length - 1], a = t.anchor.value;
        const d = el("div", "sb-cm-item" + (ms.some((m: any) => isAgent(m.author)) ? " agent" : "")); d.dataset.thread = t.id;
        d.append(el("div", "sb-cm-quote", a.quote));
        const w = el("div", "sb-cm-who", who(last?.author ?? "", o.author) + (ms.length > 1 ? " · " + ms.length + " messages" : "")); if (last && isAgent(last.author)) w.append(el("span", "sb-cm-agent", "agent"));
        d.append(w, el("div", "sb-cm-text", last?.text.value ?? ""));
        const n = STATUS_NOTE[places.get(t.id)?.status ?? ""]; if (n) d.append(el("div", "sb-cm-note", n));
        extra?.(t, d);
        // (in a narrow box the thread's sheet replaces the list; in a wide one, both are shown)
        d.onclick = () => { const p = places.get(t.id); if (placed(p)) { o.src.focus({ preventScroll: true }); o.src.setSelectionRange(p!.s, p!.e); } if (right.classList.contains("sb-cm-narrow")) { list?.remove(); list = null; } openThread(t.id, null); };
        list!.append(d);
      }
    };
    const st = (t: any) => places.get(t.id)?.status ?? "";
    const open = ts.filter((t: any) => !t.resolved.value);
    sec("Open", open.filter((t: any) => placed(places.get(t.id))));
    sec("Needs a place", open.filter((t: any) => st(t) === "ambiguous"), (t, d) => {
      const cs = places.get(t.id)?.candidates ?? [], L = C.lineIndex(ed.getText());
      if (!cs.length) d.append(el("div", "sb-cm-note", "too many places: select the text and use Attach to selection"));
      cs.forEach((c, k) => {
        const b = el("button", "sb-cm-cand", "Place " + (k + 1) + ": line " + L.at(c.start).line);
        b.onclick = async (ev) => { ev.stopPropagation(); const anchor = anchorAt(c.start, c.end); await write((x) => C.reattach(x, t.id, anchor, { author: o.author })); };
        d.append(b);
      });
    });
    sec("Comments on text that was removed", open.filter((t: any) => st(t) === "orphaned" || st(t) === "unresolved"));
    sec("Resolved", ts.filter((t: any) => t.resolved.value));
    mark("tex-comments-list", { ms: Math.round((performance.now() - t0) * 10) / 10, threads: ts.length, shown });
    if (!ts.length) list.append(el("div", "sb-cm-note", loaded ? "No comments yet. Select text in the preview or the source (Ctrl/Cmd+Alt+M) to comment." : "Loading…"));
  };
  const PER_SECTION = 100, showAll = new Set<string>();
  const openList = () => {
    if (list) { list.remove(); list = null; return; }
    list = el("div", "sb-cm-list"); list.setAttribute("role", "dialog"); list.setAttribute("aria-label", "Comments");
    document.body.appendChild(list); showList(); void reload();
  };
  o.button.onclick = () => openList();
  // (an agent may have written meanwhile: read again when the page is looked at again)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void reload(); }, on);
  window.addEventListener("focus", () => void reload(), on);

  const offRendered = ed.on("rendered", () => queueDraw());
  const ro = new ResizeObserver(() => queueDraw()); ro.observe(right);
  const ready = reload();

  return {
    ready,
    reload,
    openList,
    commentSelection,
    /** The anchors as they are now, with the text they are offsets in: taken when the .tex save starts, before
     * anything waits, so the offsets and the text are of one moment (an edit during the save can't mix them). */
    snapshot: () => ({ text: ed.getText(), at: new Map(live().filter((t: any) => placed(places.get(t.id))).map((t: any) => { const p = places.get(t.id)!; return [t.id as string, { s: p.s, e: p.e, op: p.op }]; })) }),
    /** The .tex was saved as `snap.text`: its placed anchors written again for it (their offsets and its hash). A thread
     * whose anchor was written since the snapshot (an agent reattached it) is left as it is, checked against the file
     * as each attempt re-reads it. */
    saved: async (snap: { text: string; at: Map<string, { s: number; e: number; op: string }> } | null | undefined) => {
      if (!snap || snap.text.length > C.LIMITS.sourceUnits) return;
      let t0 = performance.now();
      const sha = await hashOf(snap.text, async () => { if (performance.now() - t0 < SLICE_MS) return false; await frame(); t0 = performance.now(); return life.signal.aborted; });
      if (sha === null) return;
      const todo = [...snap.at].filter(([id, p]) => { const a = live().find((t: any) => t.id === id)?.anchor.value; return a && (a.textSha !== sha || a.start !== p.s || a.end !== p.e); });
      if (!todo.length) return;
      await write((d) => {
        let x = d;
        for (const [id, p] of todo) {
          const t = x.threads.find((y: any) => y.id === id);
          if (!t || t.deleted.value || t.anchor.op !== p.op) continue;
          x = C.reattach(x, id, C.makeAnchor(snap.text, p.s, p.e, t.anchor.value.shown, sha), { author: o.author }).doc;
        }
        return { doc: x };
      });
    },
    count: () => live().filter((t: any) => !t.resolved.value).length,
    destroy: () => {
      life.abort(); offRendered(); ro.disconnect(); clearTimeout(marksTimer); closeAll(); list?.remove(); list = null;
      layer.remove(); over.remove(); right.style.position = pos0; right.classList.remove("sb-cm-margin", "sb-cm-narrow");
      regs.delete(me); paint();
    },
  };
}
