// Resizable panels (William, Nov 8: "make every single panel resizable. Right now even the file panel on the left is
// not resizable."): an edge to drag, arrow keys for the same, a double-click to put the default back, and the size
// remembered on this device (localStorage).  Two uses here:
//  - the files (#wssidebar) on the notebook page, the LaTeX and code editors over it, and the board: their width is
//    the CSS variable --sbfw, which every view's left edge follows while they are shown (desktop widths only: on a
//    phone they cover the window, as before);
//  - the LaTeX editor's source and preview: the source's share of the width, --tex-split.
// The Agents page's columns and the Terminal's height have their own edges (agents/layout.ts, shell/panel.ts).

export const FILES_W = { key: "sagebrush-files-width", def: 272, min: 200, max: 640 };
export const TEX_SPLIT = { key: "sagebrush-tex-split", def: 50, min: 20, max: 80 };

// (the style, in parts: the edge's own, and each use's, so the LaTeX editor's bundle carries only its part)
const EDGE_CSS = `.sb-edge{position:absolute;top:0;bottom:0;width:9px;cursor:col-resize;touch-action:none;z-index:6}.sb-edge:hover,.sb-edge:focus-visible,.sb-edge.sb-dragging{background:linear-gradient(90deg,transparent 3px,#6f8f63 3px 6px,transparent 6px);outline:0}body.sb-resizing,body.sb-resizing *{cursor:col-resize!important;user-select:none!important}@media print{.sb-edge{display:none!important}}`;
const FILES_CSS = `#wssidebar>.sb-edge{right:-5px}@media (min-width:641px){body.sbfw #wssidebar{width:var(--sbfw)!important}body.sbfw.wsfiles{padding-left:var(--sbfw)}body.sbfw.wsfiles .code-page{left:var(--sbfw)}body.sbfw.wsfiles .tex-page:not(.tex-embed){left:var(--sbfw)}}@media (max-width:640px){#wssidebar>.sb-edge{display:none}}`;
const SPLIT_CSS = `@media (min-width:641px){.tex-page .tex-main.sb-split>.tex-left{flex:0 0 var(--tex-split,50%)}.tex-page .tex-main.sb-split>.tex-right{flex:1 1 0}}@media (max-width:640px){.tex-main>.sb-edge{display:none}}`;

function style(id: string, css: string) {
  for (const [i, c] of [["sb-edge-css", EDGE_CSS], [id, css]]) {
    if (document.getElementById(i)) continue;
    const st = document.createElement("style");
    st.id = i;
    st.textContent = c;
    document.head.append(st);
  }
}

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, v: string | null) => { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch {} };

type Spec = { key: string; def: number; min: number; max: number };

/** A vertical edge: `measure` turns the pointer's x into a size, `apply` shows a size; arrows step by `step`, a
 * double-click restores the default (and forgets the remembered size).  The size the person chose (`pref`, the one
 * kept) is separate from the one drawn: a narrower window draws less, and a wider one gives the chosen size back
 * (daybreak3's E2).  `signal`: the edge's lifetime (its window listener ends with it). */
function edge(el: HTMLElement, spec: Spec, o: { label: string; unit: string; step: number; max?: () => number; measure: (x: number) => number; apply: (v: number) => void; signal?: AbortSignal }) {
  el.classList.add("sb-edge");
  el.setAttribute("role", "separator");
  el.setAttribute("aria-orientation", "vertical");
  el.setAttribute("aria-label", o.label);
  el.tabIndex = 0;
  el.title = "Drag to resize; double-click to reset";
  const hi = () => Math.max(spec.min, Math.min(spec.max, o.max?.() ?? spec.max));
  const clamp = (v: number) => Math.round(Math.max(spec.min, Math.min(hi(), v)));
  let pref = spec.def, cur = spec.def;
  // (the drawn size, from the chosen one and this window)
  const show = () => {
    cur = clamp(pref);
    el.setAttribute("aria-valuemin", String(spec.min));
    el.setAttribute("aria-valuemax", String(hi()));
    el.setAttribute("aria-valuenow", String(cur));
    el.setAttribute("aria-valuetext", `${cur}${o.unit}`);
    o.apply(cur);
  };
  // (a size chosen here: by a drag, a key or a double-click; kept when `keep`)
  const set = (v: number, keep: boolean) => {
    pref = clamp(v);
    show();
    if (keep) write(spec.key, String(pref));
  };
  // (a drag under way: ended by the pointer, or by the edge's lifetime, which leaves no page-wide drag state behind)
  let endDrag: ((keep: boolean) => void) | null = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || endDrag) return;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("sb-dragging");
    document.body.classList.add("sb-resizing");
    const move = (m: PointerEvent) => set(o.measure(m.clientX), false);
    const up = () => endDrag?.(true);
    endDrag = (keep) => {
      endDrag = null;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.classList.remove("sb-dragging");
      document.body.classList.remove("sb-resizing");
      if (keep) set(pref, true);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  o.signal?.addEventListener("abort", () => endDrag?.(false), { once: true });
  el.addEventListener("dblclick", (e) => { e.preventDefault(); set(spec.def, false); write(spec.key, null); });
  el.addEventListener("keydown", (e) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (e.key === "Home" || e.key === "End") { e.preventDefault(); set(e.key === "Home" ? spec.min : hi(), true); return; }
    if (!d) return;
    e.preventDefault();
    set(cur + d * o.step * (e.shiftKey ? 4 : 1), true);
  });
  pref = Math.round(Math.max(spec.min, Math.min(spec.max, Number(read(spec.key)) || spec.def)));
  show();
  addEventListener("resize", show, o.signal ? { signal: o.signal } : undefined);
  return set;
}

/** The files' width: an edge at the right of `side` (#wssidebar); `changed` after each change (the board redraws). */
export function filesResize(side: HTMLElement, changed?: () => void) {
  style("sb-files-w-css", FILES_CSS);
  document.body.classList.add("sbfw");
  const handle = document.createElement("div");
  side.append(handle);
  // (only a change is passed on: the board redraws on "resize", which the edge also listens to)
  let last = 0;
  edge(handle, FILES_W, {
    label: "Resize the files panel", unit: " px", step: 16,
    // (the page keeps at least 320 px beside them)
    max: () => innerWidth - 320,
    measure: (x) => x - side.getBoundingClientRect().left,
    apply: (v) => { if (v === last) return; last = v; document.documentElement.style.setProperty("--sbfw", `${v}px`); changed?.(); },
  });
}

/** The LaTeX editor's split: an edge between `left` (the source) and the preview, in `main` (.tex-main); `signal`: the
 * editor's mount (another file opened in place mounts again: this one's listeners end with it). */
export function texSplit(main: HTMLElement, left: HTMLElement, signal?: AbortSignal) {
  style("sb-tex-split-css", SPLIT_CSS);
  main.classList.add("sb-split");
  main.style.position = "relative";
  const handle = document.createElement("div");
  left.after(handle);
  const place = () => { handle.style.left = `${left.offsetLeft + left.offsetWidth - 5}px`; };
  // (one frame queued at most, and none left once the editor is gone)
  let frame = 0;
  const later = () => { if (!frame && !signal?.aborted) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
  edge(handle, TEX_SPLIT, {
    label: "Resize the source and the preview", unit: "%", step: 2,
    measure: (x) => { const r = main.getBoundingClientRect(); return ((x - r.left) / Math.max(1, r.width)) * 100; },
    apply: (v) => { main.style.setProperty("--tex-split", `${v}%`); later(); },
    signal,
  });
  const ro = new ResizeObserver(place);
  ro.observe(main);
  signal?.addEventListener("abort", () => { ro.disconnect(); cancelAnimationFrame(frame); frame = 0; }, { once: true });
}
