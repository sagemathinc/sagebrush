// The toolbar's icons: one set of line drawings on a 24-unit grid, drawn in
// the text color at the button's size (Unicode glyphs such as ¶ ▨ ⤳ come out
// at different, small sizes, and some fonts lack them).  Built as SVG
// elements, never from markup.

type Shape = ["path", string] | ["rect", number, number, number, number, number?] | ["circle", number, number, number];

const ICONS: Record<string, Shape[]> = {
  select: [["path", "M6 3v15l4.2-4.2 2.8 6.4 2.6-1.1-2.8-6.3H18.5z"]],
  note: [["rect", 4, 4, 16, 16, 2], ["path", "M8 9.5h8M8 13h8M8 16.5h5"]],
  code: [["path", "M8.5 6.5 3.5 12l5 5.5M15.5 6.5l5 5.5-5 5.5"]],
  sticker: [["circle", 12, 12, 9], ["path", "M8.5 14.5a4.6 4.6 0 0 0 7 0M9 9.5v.5M15 9.5v.5"]],
  image: [["rect", 3, 5, 18, 14, 2], ["circle", 8.5, 10, 1.6], ["path", "m20.5 16.5-5-5L6 19"]],
  group: [["rect", 3, 3, 18, 18, 3], ["rect", 7, 7, 4.5, 4.5, 1], ["rect", 12.5, 12.5, 4.5, 4.5, 1]],
  connect: [["circle", 6, 18, 2.5], ["circle", 18, 6, 2.5], ["path", "M8 16 16 8M10.5 8H16v5.5"]],
  draw: [["path", "M4 20l1.1-4.5L15.6 5a2.1 2.1 0 0 1 3 0l.4.4a2.1 2.1 0 0 1 0 3L8.5 18.9z"], ["path", "m13.6 7 3.4 3.4"]],
  erase: [["path", "M8.5 20H20"], ["path", "M4.7 15.3 14.2 5.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11.5 20H8.4z"], ["path", "m9.4 10.6 4 4"]],
  highlighter: [["path", "m9 11-5 5v4h4l5-5"], ["path", "m9 11 6.5-6.5a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L13 15z"]],
  page: [["rect", 8, 3, 12, 15, 1.5], ["path", "M5 7v12.5A1.5 1.5 0 0 0 6.5 21H16"]],
  undo: [["path", "M9 14 4 9l5-5"], ["path", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"]],
  redo: [["path", "m15 14 5-5-5-5"], ["path", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"]],
  // an item's own toolbar (inplace.ts)
  run: [["path", "M7 4.5v15L19 12z"]],
  detail: [["circle", 10.5, 10.5, 6.5], ["path", "m15.5 15.5 5 5M7.5 10.5h6M10.5 7.5v6"]],
  link: [["path", "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"], ["path", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"]],
  title: [["path", "M5 7.5V5h14v2.5M12 5v14M9 19h6"]],
  trash: [["path", "M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"]],
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
