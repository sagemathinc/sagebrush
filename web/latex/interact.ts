// The LaTeX editor's @interact (a Sagebrush extension, William Nov 8: "@interact inside sagesilent/sageblock as a
// documented Sagebrush extension"; upstream SageTeX and Sage 10.10 raise NameError on it): a chunk of its own,
// /sagebrush-latex-interact.js, fetched only once a preview has an interact (sagetex.mjs interactsAt's placeholder, its
// interacts as escaped JSON). Each is drawn with its controls at their defaults, not live here, what its function
// printed and showed at those values, and a line saying it is interactive in Sagebrush (William's Q2: the PDF shows it
// so). Everything from the results file reaches the HTML through esc(); a shown plot only as a base64 SVG data URL
// (DATA_SVG), as \sageplot's.
import { DATA_SVG, STALE_TITLE, utf8len } from "./engine/sagetex.mjs";

// ---- an item's @interacts, as the Run's session printed them (run-core's driver), checked before the results file
// holds them, as a result is (this chunk's, so Run's own carries only the driver: daybreak2's SIZE design, Beamer plan PR
// 3): at most INTERACT_LIMITS.n an item, each with its controls (only the fields drawn, by kind), what its function
// printed at the defaults (bounded) and what it showed (a plot only as an SVG, as \sageplot's; text bounded)
export const INTERACT_LIMITS = { n: 8, controls: 20, shows: 4, text: 4000, options: 50, label: 200, svg: 2 * 2 ** 20 };   // (svg: Run's RUN_LIMITS.svg)
const CONTROL_KINDS = new Set(["slider", "range", "selector", "checkbox", "input", "color", "text", "button"]);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
const b64 = (s: string) => {
  const u = new TextEncoder().encode(s);
  let t = "";
  for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(t);
};
function controlOf(c: any): Record<string, unknown> | null {
  if (!c || typeof c !== "object" || !CONTROL_KINDS.has(c.kind)) return null;
  const L = INTERACT_LIMITS.label;
  const o: Record<string, unknown> = { kind: c.kind, name: str(c.name, L) ?? "", label: str(c.label, L) ?? str(c.name, L) ?? "" };
  for (const k of ["min", "max", "step"]) if (num(c[k])) o[k] = c[k];
  const v = c.value;
  if (typeof v === "boolean" || num(v)) o.value = v;
  else if (typeof v === "string") o.value = v.slice(0, L);
  else if (Array.isArray(v) && v.length === 2 && v.every(num)) o.value = [v[0], v[1]];
  for (const k of ["labels", "options"]) if (Array.isArray(c[k])) o[k] = c[k].slice(0, INTERACT_LIMITS.options).map((x: unknown) => String(x).slice(0, L));
  if (typeof c.text === "string") o.text = c.text.slice(0, L);
  return o;
}
export function interactsOf(list: unknown) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, INTERACT_LIMITS.n).filter((x: any) => x && typeof x === "object" && x.spec && typeof x.spec === "object").map((x: any) => ({
    id: Number.isInteger(x.spec.id) ? x.spec.id : 0,
    name: str(x.spec.name, INTERACT_LIMITS.label) ?? "",
    controls: (Array.isArray(x.spec.controls) ? x.spec.controls : []).slice(0, INTERACT_LIMITS.controls).map(controlOf).filter(Boolean),
    out: str(x.out, INTERACT_LIMITS.text) ?? "",
    shows: (Array.isArray(x.shows) ? x.shows : []).slice(0, INTERACT_LIMITS.shows).map((sh: any) => {
      const svg = typeof sh?.svg === "string" ? sh.svg : null;
      if (svg !== null) return utf8len(svg) <= INTERACT_LIMITS.svg && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg) ? { src: "data:image/svg+xml;base64," + b64(svg) } : { text: "(a plot that can't be shown)" };
      return { text: str(sh?.text, INTERACT_LIMITS.text) ?? "" };
    }),
  }));
}

const NOTE = "Interactive in Sagebrush";
const CSS_ID = "sb-tex-interact-style";
const CSS = `
.tex-page .sageinteract { border: 1px solid #c8c8d0; border-radius: 4px; padding: .3em .6em; margin: .4em 0; }
.tex-page .sageinteract .si-c { display: inline-flex; align-items: center; gap: .3em; margin-right: 1.2em; }
.tex-page .sageinteract .si-out { margin: .3em 0; }
.tex-page .si-note { font-size: .7em; color: #777; }
`;
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const attrNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

function controlHtml(c: any): string {
  if (!c || typeof c !== "object") return "";
  // (a "text" control, text_control's or fixed's, is a line of text, as the notebook draws it: no label, no box)
  if (c.kind === "text") return c.value ? '<div class="si-t">' + esc(String(c.value)) + "</div>" : "";
  const label = '<span class="si-l">' + esc(String(c.label ?? c.name ?? "").slice(0, 200)) + "</span>";
  const v = c.value;
  let w: string;
  if (c.kind === "slider" || c.kind === "range") {
    const one = Array.isArray(v) ? v[0] : v;
    const shown = Array.isArray(c.labels) && typeof v === "number" && c.labels[v] !== undefined ? c.labels[v] : Array.isArray(v) ? v.join(" to ") : v;
    w = '<input type="range" disabled min="' + attrNum(c.min) + '" max="' + attrNum(c.max) + '" step="' + attrNum(c.step) + '" value="' + attrNum(one) + '"><span class="si-v">' + esc(String(shown ?? "")) + "</span>";
  } else if (c.kind === "selector") {
    const opts = Array.isArray(c.options) ? c.options : [];
    w = "<select disabled>" + opts.map((o: unknown, i: number) => "<option" + (i === v ? " selected" : "") + ">" + esc(String(o)) + "</option>").join("") + "</select>";
  } else if (c.kind === "checkbox") w = '<input type="checkbox" disabled' + (v === true ? " checked" : "") + ">";
  else if (c.kind === "button") w = "<button disabled>" + esc(String(c.text ?? c.label ?? "")) + "</button>";
  else if (c.kind === "color" && typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) w = '<input type="color" disabled value="' + esc(v) + '">';
  else w = '<input type="text" disabled value="' + esc(String(v ?? "")) + '">';
  return '<label class="si-c">' + label + " " + w + "</label>";
}

/** An item's interacts (run-core interactsOf's shape) as HTML: each drawn, not live. */
export function interactsHtml(list: unknown, stale = false): string {
  if (!Array.isArray(list)) return "";
  return list.slice(0, 8).map((x: any) => {
    if (!x || typeof x !== "object") return "";
    const controls = (Array.isArray(x.controls) ? x.controls : []).slice(0, 20).map(controlHtml).join("");
    const out = typeof x.out === "string" && x.out ? '<pre class="si-out">' + esc(x.out.slice(0, 4000)) + "</pre>" : "";
    const shows = (Array.isArray(x.shows) ? x.shows : []).slice(0, 4).map((sh: any) =>
      typeof sh?.src === "string" && DATA_SVG.test(sh.src) ? '<img class="sageplot" alt="a plot" src="' + sh.src + '">'
        : typeof sh?.text === "string" && sh.text ? '<pre class="si-out">' + esc(sh.text.slice(0, 4000)) + "</pre>" : "").join("");
    return '<div class="sageinteract' + (stale ? ' sagestale" title="' + esc(STALE_TITLE) : "") + '" data-iid="' + (Number.isInteger(x.id) ? x.id : 0) + '"><div class="si-controls">' + controls + "</div>" + out + shows + '<div class="si-note">' + NOTE + "</div></div>";
  }).join("");
}

/** Draws every placeholder under `root` not drawn yet (its interacts, from its data); how many it drew. */
export function draw(root: ParentNode): number {
  let n = 0;
  for (const at of Array.from(root.querySelectorAll<HTMLElement>(".sageinteract-at:not([data-drawn])"))) {
    let list: unknown = [];
    try { list = JSON.parse(at.dataset.ia ?? "[]"); } catch {}
    at.innerHTML = interactsHtml(list, at.dataset.stale === "1");
    at.dataset.drawn = "1";
    n++;
  }
  if (n && !document.getElementById(CSS_ID)) { const st = document.createElement("style"); st.id = CSS_ID; st.textContent = CSS; document.head.appendChild(st); }
  return n;
}
