// Boards: the colors the canvas draws with (plan-board-dark r2 §2).
//
// board.css defines them as custom properties on the board (:where(.sbb,
// .sbb-layer)); the canvas reads them from its element's computed style once
// (readPalette), never per frame.  LIGHT holds the same values: what a board
// draws with where its stylesheet is not (a test, an element on its own), so
// a missing property never changes a pixel.  A document's own colors (a
// note's, a stroke's) are not here: they are drawn as stored.

/** Ink's color, unless a stroke says: a document's default, stored (edit.ts, print.ts), not a theme's. */
export const INK = "#1d241a";

export interface Palette {
  /** ink and stickers without a color of their own */
  ink: string;
  /** a group's fill, without a color of its own; its border; an empty group's hint */
  group: string;
  groupBorder: string;
  emptyHint: string;
  /** a note still waiting for its element, without a color of its own */
  noteBg: string;
  /** a slide's card and its shadow */
  slide: string;
  slideShadow: string;
  /** edges and arrowheads; the selected one; their labels and the labels' plate */
  edge: string;
  edgeSelected: string;
  edgeLabel: string;
  edgeLabelBg: string;
  /** far out: a box without a color of its own; titles; groups' titles, their halo and the plate of a revealed one */
  farFill: string;
  farTitle: string;
  groupTitle: string;
  halo: string;
  plate: string;
  /** the accent: a drop target, handles, the grip and add-another control's outline and marks; their fill */
  accent: string;
  handleBg: string;
  /** a selected stroke's outline; a stroke of points without a color */
  inkSelected: string;
  lineInk: string;
  /** the selection rectangle being drawn */
  marquee: string;
  marqueeFill: string;
  /** a drag's alignment guides */
  guide: string;
}

/** Each color's custom property (board.css). */
export const PALETTE_VARS: Record<keyof Palette, string> = {
  ink: "--board-ink",
  group: "--board-group-bg",
  groupBorder: "--board-group-border",
  emptyHint: "--board-placeholder",
  noteBg: "--board-note-bg",
  slide: "--board-slide-bg",
  slideShadow: "--board-slide-shadow",
  edge: "--board-edge",
  edgeSelected: "--board-edge-selected",
  edgeLabel: "--board-edge-label",
  edgeLabelBg: "--board-edge-label-bg",
  farFill: "--board-far-fill",
  farTitle: "--board-far-title",
  groupTitle: "--board-ink",
  halo: "--board-halo",
  plate: "--board-plate",
  accent: "--board-accent",
  handleBg: "--board-handle-bg",
  inkSelected: "--board-ink-selected",
  lineInk: "--board-line-ink",
  marquee: "--board-marquee",
  marqueeFill: "--board-marquee-fill",
  guide: "--board-guide",
};

/** Today's colors (board.css's values). */
export const LIGHT: Readonly<Palette> = Object.freeze({
  ink: INK,
  group: "#eef2ea",
  groupBorder: "rgba(0,0,0,.18)",
  emptyHint: "#8a8f99",
  noteBg: "#fff",
  slide: "#fff",
  slideShadow: "rgba(0, 0, 0, .18)",
  edge: "#5f7457",
  edgeSelected: "#1f7a2a",
  edgeLabel: "#3d4a37",
  edgeLabelBg: "rgba(250,250,247,.92)",
  farFill: "#9cc28f",
  farTitle: "#10140f",
  groupTitle: "#1d241a",
  halo: "rgba(250,250,247,.9)",
  plate: "rgba(250, 250, 247, .96)",
  accent: "#2a6f2f",
  handleBg: "#fff",
  inkSelected: "rgba(42, 111, 47, .9)",
  lineInk: "#2a6f2f",
  marquee: "rgba(42, 111, 47, .7)",
  marqueeFill: "rgba(42, 111, 47, .08)",
  guide: "#d6336c",
});

/** The palette `el` is styled with: each property's value, else LIGHT's. */
export function readPalette(el: Element): Palette {
  const style = getComputedStyle(el), p = { ...LIGHT } as Palette;
  for (const k of Object.keys(PALETTE_VARS) as (keyof Palette)[]) {
    const v = style.getPropertyValue(PALETTE_VARS[k]).trim();
    if (v) p[k] = v;
  }
  return p;
}
