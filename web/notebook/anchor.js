// Keeping your place in a notebook while it re-renders (TimeTravel going in
// and out, moving between versions, a journal replay): the cell nearest the
// middle of the window, and keeping it where it was while the page settles.
// web/notebook/test-anchor.mjs tests it in Chromium.

// The cell nearest the middle of the window, and where it is on the screen.
export function anchorOf(notebook) {
  if (!notebook) return null;
  const mid = innerHeight / 2;
  let best = null;
  notebook.cells().forEach((c, index) => {
    const r = c.el.getBoundingClientRect();
    if (!r.height || r.bottom < 0 || r.top > innerHeight) return;
    const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
    if (!best || d < best.d) best = { id: c.id, index, top: r.top, d };
  });
  return best;
}

// Scroll so that the anchor's cell (or the one at its place) is where it was,
// and keep it there while the page settles (math is typeset after a paint,
// pictures load), for up to 2 s, unless you scroll: with the wheel, a touch, a
// key, a click, or any other way (a scrollbar drag fires none of those events,
// and neither does a script's scrollTo).  Someone else's scroll is told apart
// by where it leaves the page: not where this anchor's own last correction
// left it.  (Not by where the cell is: while the page is still too short to
// put a late cell back, the anchor's own correction is clamped and leaves the
// cell short of its place, and that must not let go.  The browser's own
// scroll anchoring adjusts during layout, before the correction that follows
// it sets the position, so it doesn't let go either.)
let unanchor = null;
export function restoreAnchor(notebook, at) {
  unanchor?.();
  if (!at) return;
  const cell = () => { const cs = notebook.cells(); return cs.find((x) => x.id === at.id) ?? cs[Math.min(at.index, cs.length - 1)]; };
  let mine = scrollY;
  const fix = () => {
    const c = cell();
    if (c) scrollBy(0, c.el.getBoundingClientRect().top - at.top);
    mine = scrollY;
  };
  fix();
  if (typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver(fix);
  ro.observe(notebook.root);
  const moved = () => { if (Math.abs(scrollY - mine) > 1) stop(); };
  const stop = () => { ro.disconnect(); clearTimeout(timer); for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) removeEventListener(e, stop, true); removeEventListener("scroll", moved); if (unanchor === stop) unanchor = null; };
  const timer = setTimeout(stop, 2000);
  for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(e, stop, true);
  addEventListener("scroll", moved, { passive: true });
  unanchor = stop;
}
