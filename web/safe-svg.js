// The SVG checker, moved here from web/notebook/notebook.js (OUT-ISO phase 1) so
// that the isolated output renderer (web/output-shell/shell.js) re-checks an SVG
// with the same code the host uses, without bundling the notebook.
import { PixelBudget, imageSize, pictureKey } from "./image-size.ts";

// SVG from Python code is put in the page only after removing anything
// active (scripts, event handlers) and every address off the picture itself,
// with its ids made unique so that several plots' clip paths cannot collide.
// Elements and attributes are judged by namespace and local name, never by
// the prefix the text chose (x:href is an XLink href).  An attribute value
// (or style declaration) may name the picture's own ids, url(#id), and
// otherwise contains no backslash (CSS escapes), slash or colon: so nothing in
// it can load from anywhere else (design/security.md); and the only CSS
// functions are transforms, colors and arithmetic.  Only aria-* and data-*
// attributes, which are text, may hold anything.
export const SVG_NS = "http://www.w3.org/2000/svg", XLINK_NS = "http://www.w3.org/1999/xlink", XML_NS = "http://www.w3.org/XML/1998/namespace";
const SVG_TAGS = new Set("svg g path line polyline polygon circle ellipse rect text tspan title desc defs clipPath linearGradient radialGradient stop use marker symbol mask pattern image".split(" "));
// (an <image>'s only allowed source: an inline raster picture, e.g. contourf's bands)
export const RASTER_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/;
const LOCAL_URL = /url\(\s*(['"]?)#([\w.-]+)\1\s*\)/gi;
// (the CSS functions a value may use: transforms, colors, arithmetic; never
// one that loads, as image-set(), image(), cross-fade(), even from this site)
const SVG_FUNCS = new Set("matrix translate translatex translatey rotate scale scalex scaley skewx skewy rgb rgba hsl hsla var calc min max clamp".split(" "));
// (and no property that takes an image or other content, as a style or an attribute)
const SVG_NO_PROPS = /^(background|cursor|list-style|content|border-image|mask-image|shape-outside|-webkit-)/i;
function svgValue(v, pre) {
  const rest = v.replace(LOCAL_URL, "");
  if (/[\\/:\u0000]|url\(|@import|expression\(/i.test(rest)) return null;
  for (const m of rest.matchAll(/([\w-]*)\s*\(/g)) if (!SVG_FUNCS.has(m[1].toLowerCase())) return null;
  return v.replace(LOCAL_URL, (_, q, id) => `url(#${pre}${id})`);
}
// (the properties a style may set: how the picture's own shapes and text are painted, never where the picture
// sits on the page, how big it is or what it stacks over (position, inset, z-index, width, margin, ...), so a
// picture stays within its place in the output)
const SVG_STYLE_PROPS = new Set(("fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset " +
  "stroke-linecap stroke-linejoin stroke-miterlimit opacity color font font-family font-size font-style font-weight " +
  "font-variant font-stretch text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing " +
  "text-decoration writing-mode transform transform-origin transform-box visibility clip-path clip-rule mask marker " +
  "marker-start marker-mid marker-end stop-color stop-opacity flood-color flood-opacity lighting-color vector-effect " +
  "shape-rendering text-rendering image-rendering color-interpolation paint-order animation-delay").split(" "));
// (and no viewport unit in a value: a length relative to the page, not the picture)
const VIEWPORT_UNIT = /\d(vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh)\b/i;
function svgStyle(v, pre) {
  const out = [];
  for (const decl of v.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const p = decl.slice(0, i).trim().toLowerCase(), val = svgValue(decl.slice(i + 1), pre);
    if (SVG_STYLE_PROPS.has(p) && val !== null && !VIEWPORT_UNIT.test(val)) out.push(`${p}:${val.trim()}`);
  }
  return out.join(";");
}
let svgCount = 0;
export function safeSvg(text, pixels = new PixelBudget(Infinity)) {
  const root = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg") return null;
  const pre = `s${++svgCount}-`;
  const isHref = (a) => a.localName === "href" && (a.namespaceURI === null || a.namespaceURI === XLINK_NS);
  const clean = (el) => {
    for (const child of [...el.children]) {
      if (child.namespaceURI === SVG_NS && SVG_TAGS.has(child.localName)) clean(child); else child.remove();
    }
    for (const a of [...el.attributes]) {
      const { localName: n, value } = a;
      let keep = null;
      if (isHref(a)) {
        // (an inline raster within the bounds its header gives, counted in the document's pixels: image-size.ts, SEC-89C-3)
        if (el.localName === "image") { const m = RASTER_URL.exec(value); keep = m && pixels.take(imageSize("image/" + m[1], value.slice(value.indexOf(",") + 1)), "image/" + m[1] + "\n" + pictureKey(value)) === null ? value : null; }
        else keep = /^#[\w.-]+$/.test(value) ? "#" + pre + value.slice(1) : null;
      } else if (a.namespaceURI === XML_NS) keep = n === "space" || n === "lang" ? svgValue(value, pre) : null;
      else if (a.namespaceURI === null && /^[a-z_][\w.-]*$/i.test(n) && !/^on/i.test(n) && !SVG_NO_PROPS.test(n)) {
        // (text for people and the page's script, never read as CSS or an address)
        if (/^(aria|data)-/i.test(n)) keep = value;
        else keep = n === "style" ? svgStyle(value, pre) : svgValue(value, pre);
        if (keep !== null && n === "id") keep = pre + keep;
        if (keep !== null && !/^(aria|data)-/i.test(n) && VIEWPORT_UNIT.test(keep)) keep = null;
      }
      if (keep === null) el.removeAttributeNode(a);
      else if (keep !== value) a.value = keep;
    }
    if (el.localName === "image" && ![...el.attributes].some(isHref)) el.remove();
  };
  clean(root);
  return document.importNode(root, true);
}
