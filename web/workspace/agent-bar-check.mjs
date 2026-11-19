// The agent's bar never covers what the person types in or reads (decided Nov 19 2026): an expression for a page test's
// evaluate, true when the bar is in the page's own row for it ([data-sbag-slot]) and its box overlaps no input, button,
// editor or plot of the page; else what it overlaps, as a string. (The test pages: the notebook, code and LaTeX pages,
// the board and the Agents page. The board's canvas is under its whole top bar by design, so it isn't counted; the
// pictures on it are.)
export const BAR_CLEAR = `(() => {
  const b = document.querySelector(".sbag-bar");
  if (!b) return "no bar";
  if (!b.classList.contains("docked") || !b.parentElement?.matches("[data-sbag-slot]")) return "not docked: " + (b.parentElement?.tagName ?? "nowhere");
  const r = b.getBoundingClientRect();
  const sel = "input, textarea, select, button, [contenteditable], .ed, .cell, svg[aria-label^=Plot], img, #editor, .composer, .code-body, .tex-main, [data-sbb=canvas]";
  // (an element's box as it is seen: cut to every scrolling or clipping ancestor's, as a list scrolled under a row)
  const seen = (e) => {
    const q = e.getBoundingClientRect();
    let x0 = q.left, y0 = q.top, x1 = q.right, y1 = q.bottom;
    for (let a = e.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).overflow === "visible") continue;
      const c = a.getBoundingClientRect();
      x0 = Math.max(x0, c.left); y0 = Math.max(y0, c.top); x1 = Math.min(x1, c.right); y1 = Math.min(y1, c.bottom);
    }
    return { left: x0, top: y0, right: x1, bottom: y1, width: x1 - x0, height: y1 - y0 };
  };
  // (and only where the person would see it without the bar: the topmost thing at the overlap's middle, so a page under
  //  another (the notebook page under the code page) isn't counted)
  const under = (e, q) => {
    const x = (Math.max(r.left, q.left) + Math.min(r.right, q.right)) / 2, y = (Math.max(r.top, q.top) + Math.min(r.bottom, q.bottom)) / 2;
    b.style.visibility = "hidden";
    const top = document.elementFromPoint(x, y);
    b.style.visibility = "";
    return !!top && (e === top || e.contains(top));
  };
  const hit = [...document.querySelectorAll(sel)].filter((e) => !b.contains(e) && !e.contains(b) && e.offsetParent !== null).find((e) => {
    const q = seen(e);
    return q.width > 0 && q.height > 0 && r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom && under(e, q);
  });
  if (!hit) return true;
  const q = seen(hit), box = (x) => [x.left, x.top, x.width, x.height].map(Math.round).join(",");
  return "over " + (hit.id ? "#" + hit.id : hit.tagName.toLowerCase() + (hit.className && typeof hit.className === "string" ? "." + hit.className.split(" ")[0] : "")) + " (" + (hit.textContent ?? "").trim().slice(0, 30) + ") at " + box(q) + "; the bar at " + box(r);
})()`;
