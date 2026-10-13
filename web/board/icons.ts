// The toolbar's icons: one set of line drawings on a 24-unit grid, drawn in
// the text color at the button's size (Unicode glyphs such as ¶ ▨ ⤳ come out
// at different, small sizes, and some fonts lack them).  Built as SVG
// elements, never from markup.

type Shape = ["path", string] | ["rect", number, number, number, number, number?] | ["circle", number, number, number];

const ICONS: Record<string, Shape[]> = {
  select: [["path", "M6 3v15l4.2-4.2 2.8 6.4 2.6-1.1-2.8-6.3H18.5z"]],
  note: [["rect", 4, 4, 16, 16, 2], ["path", "M8 9.5h8M8 13h8M8 16.5h5"]],
  code: [["path", "M8.5 6.5 3.5 12l5 5.5M15.5 6.5l5 5.5-5 5.5"]],
  image: [["rect", 3, 5, 18, 14, 2], ["circle", 8.5, 10, 1.6], ["path", "m20.5 16.5-5-5L6 19"]],
  group: [["rect", 3, 3, 18, 18, 3], ["rect", 7, 7, 4.5, 4.5, 1], ["rect", 12.5, 12.5, 4.5, 4.5, 1]],
  connect: [["circle", 6, 18, 2.5], ["circle", 18, 6, 2.5], ["path", "M8 16 16 8M10.5 8H16v5.5"]],
  page: [["rect", 8, 3, 12, 15, 1.5], ["path", "M5 7v12.5A1.5 1.5 0 0 0 6.5 21H16"]],
  undo: [["path", "M9 14 4 9l5-5"], ["path", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"]],
  redo: [["path", "m15 14 5-5-5-5"], ["path", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"]],
};

const NS = "http://www.w3.org/2000/svg";

/** The icon for a tool, or null if it has none. */
export function icon(id: string): SVGSVGElement | null {
  const shapes = ICONS[id];
  if (!shapes) return null;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "tb-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.icon = id;
  for (const s of shapes) {
    const el = document.createElementNS(NS, s[0]);
    if (s[0] === "path") el.setAttribute("d", s[1]);
    else if (s[0] === "rect") {
      const [, x, y, w, h, r] = s;
      for (const [k, v] of [["x", x], ["y", y], ["width", w], ["height", h], ["rx", r ?? 0]] as const) el.setAttribute(k, String(v));
    } else {
      const [, cx, cy, r] = s;
      for (const [k, v] of [["cx", cx], ["cy", cy], ["r", r]] as const) el.setAttribute(k, String(v));
    }
    svg.append(el);
  }
  return svg;
}
