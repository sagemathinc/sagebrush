// TikZ in the preview: a tikzpicture's paths drawn as SVG. One entry point, renderTikz(src, opts, R):
// `src` the picture's source (its [options] first), as the renderer's str() gives it; R the renderer, of which only
// problem() and the document's colours (R.colors) and id counter (R.idn) are used. The subset: \draw, \fill,
// \filldraw, \path, \coordinate, \foreach, scope, \tikzset and .style; coordinates (x,y) with or without units, polar
// (a:r), named, + and ++, the calc library's ($(A)!t!(B)$) and ($(A)+(B)$); --, |-, -|, rectangle, circle, ellipse,
// arc, to[out,in] and bend, .. controls .., cycle, grid; colours (xcolor's names and mixes), line widths, dash
// patterns, opacity, rounded corners, arrows; scale, shift, rotate, applied as TikZ applies them. Anything else (nodes
// among them, for now) is a placeholder naming what stopped it, never a partial picture.
// Everything is bounded (TIKZ_LIMITS): the expansion of \foreach bodies and styles, path segments, grid lines, the
// math evaluator's depth and length, coordinates' size and the SVG's bytes.
// Geometry: the picture's user space is TeX points (1 cm = 72.27/2.54 pt), y up; a path is lines and cubic Béziers in
// user space, mapped by the current affine transform at the end (an affine map takes a Bézier to a Bézier exactly).

export const TIKZ_LIMITS = {
  ITEMS: 20000,            // path segments in one picture
  EXPAND: 10000,           // \foreach body expansions in one picture, all loops together
  FOREACH_DEPTH: 4,        // \foreach inside \foreach
  LEX_TEXT: 4 * 2 ** 20,   // UTF-8 bytes read in one picture, all together: its source, and each \foreach body as it is
                           // scanned for each variable and then read
  SCOPE_DEPTH: 32,         // a scope inside a scope
  OPTION_TEXT: 1000000,    // options and styles applied in one picture, all together: their UTF-8 bytes, and 32 for
                           // each list (a style naming styles many times over is work that grows with each level, not
                           // only with the depth)
  STYLE_DEPTH: 8,          // a .style naming another style, naming another...
  GRID_LINES: 2000,        // lines one grid draws
  EXPR_LEN: 400,           // characters of one math expression
  EXPR_DEPTH: 40,          // nesting of one math expression
  COORD_MAX: 2845275.6,    // |x|, |y| in pt (1000 m): past it, a named problem, not an SVG of that size
  SVG_BYTES: 2 * 2 ** 20,  // the picture's SVG
  SRC_MAX: 256 * 1024,     // a picture's source, and one \foreach body once its variables are replaced: UTF-8 bytes
  TIKZSET: 64 * 1024,      // the document's \tikzset styles, all together (kept by render.mjs): UTF-8 bytes
};

const PT_PER_CM = 72.27 / 2.54;
const UNITS = { pt: 1, cm: PT_PER_CM, mm: PT_PER_CM / 10, in: 72.27, bp: 72.27 / 72, pc: 12, sp: 1 / 65536, ex: 4.3, em: 10 };
const WIDTHS = { "ultra thin": 0.1, "very thin": 0.2, thin: 0.4, semithick: 0.6, thick: 0.8, "very thick": 1.2, "ultra thick": 1.6 };
// (xcolor's base colours, as its own definitions: names a document uses without \definecolor)
const BASE = {
  red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], cyan: [0, 1, 1], magenta: [1, 0, 1], yellow: [1, 1, 0], black: [0, 0, 0],
  white: [1, 1, 1], gray: [0.5, 0.5, 0.5], darkgray: [0.25, 0.25, 0.25], lightgray: [0.75, 0.75, 0.75], brown: [0.75, 0.5, 0.25],
  lime: [0.75, 1, 0], olive: [0.5, 0.5, 0], orange: [1, 0.5, 0], pink: [1, 0.75, 0.75], purple: [0.75, 0, 0.25], teal: [0, 0.5, 0.5], violet: [0.5, 0, 0.5],
};

/** A named failure: what the picture uses that the preview doesn't draw (or can't), shown in its placeholder. */
export class TikzError extends Error { constructor(why) { super(why); this.why = why; } }
const fail = (why) => { throw new TikzError(why); };

// ------------------------------------------------------------------ the lexer: the source as tokens
// tokens: {t: "cs", v: name} (a control sequence), {t: "g", v: text} (a {group}, its text), {t: "o", v: text} (an
// [option list]), {t: "c", v: text} (a (coordinate), its text), {t: "ch", v: char}
function lex(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const balanced = (open, close) => {
    let d = 0, j = i;
    for (; j < n; j++) {
      const c = src[j];
      if (c === "\\" && j + 1 < n) { j++; continue; }
      if (c === open) d++;
      else if (c === close && --d === 0) break;
      else if (open !== "{" && c === "{") { const k = skipGroup(src, j); if (k < 0) fail("an unbalanced { in the picture"); j = k; }
    }
    if (j >= n) fail("an unbalanced " + open + " in the picture");
    const text = src.slice(i + 1, j);
    i = j + 1;
    return text;
  };
  while (i < n) {
    const c = src[i];
    if (c === "%") { while (i < n && src[i] !== "\n") i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "\\") {
      const m = /^\\([A-Za-z@]+|.)/.exec(src.slice(i, i + 64));
      if (!m) fail("a stray \\ in the picture");
      out.push({ t: "cs", v: m[1] }); i += m[0].length; continue;
    }
    if (c === "{") { out.push({ t: "g", v: balanced("{", "}") }); continue; }
    if (c === "[") { out.push({ t: "o", v: balanced("[", "]") }); continue; }
    if (c === "(") { out.push({ t: "c", v: balanced("(", ")") }); continue; }
    out.push({ t: "ch", v: c }); i++;
  }
  return out;
}
/** A string's length in UTF-8 bytes, counted (never encoded): an unpaired surrogate as U+FFFD's 3. */
export function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
const MORE_TEXT = () => "more than " + TIKZ_LIMITS.LEX_TEXT / 2 ** 20 + " MiB of picture text read, \\foreach bodies expanded included";
// (the end of the {group} starting at j, or -1)
function skipGroup(s, j) {
  let d = 0;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") { j++; continue; }
    if (c === "{") d++;
    else if (c === "}" && --d === 0) return j;
  }
  return -1;
}

// ------------------------------------------------------------------ math (pgfmath's common part): a parser, no eval
// numbers (with an optional unit: its value in pt), + - * / ^, unary minus, parentheses, functions in degrees as
// pgfmath's: sin cos tan, sqrt abs exp ln, min max, deg rad, pi, e. A non-finite result is a named problem.
const FUNCS = {
  sin: (x) => Math.sin((x * Math.PI) / 180), cos: (x) => Math.cos((x * Math.PI) / 180),
  tan: (x) => { const r = ((x % 180) + 180) % 180; if (Math.abs(r - 90) < 1e-9) fail("tan(" + fmtNum(x) + ") is infinite"); return Math.tan((x * Math.PI) / 180); },
  sqrt: (x) => { if (x < 0) fail("sqrt of a negative number (" + fmtNum(x) + ")"); return Math.sqrt(x); },
  abs: Math.abs, exp: (x) => Math.exp(x), ln: (x) => { if (x <= 0) fail("ln of " + fmtNum(x)); return Math.log(x); },
  deg: (x) => (x * 180) / Math.PI, rad: (x) => (x * Math.PI) / 180, round: (x) => Math.sign(x) * Math.round(Math.abs(x)), floor: Math.floor, ceil: Math.ceil,
  asin: (x) => { if (x < -1 || x > 1) fail("asin of " + fmtNum(x)); return (Math.asin(x) * 180) / Math.PI; },
  acos: (x) => { if (x < -1 || x > 1) fail("acos of " + fmtNum(x)); return (Math.acos(x) * 180) / Math.PI; },
  atan: (x) => (Math.atan(x) * 180) / Math.PI,
};
const FUNCS2 = { min: Math.min, max: Math.max, atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI, mod: (a, b) => { if (b === 0) fail("mod by 0"); return a % b; }, pow: (a, b) => a ** b };

/** The value of a pgfmath expression (macros already replaced); `units`: whether it gave a unit (a dimension, in pt). */
export function evalMath(text) {
  const s = String(text).trim();
  if (s.length > TIKZ_LIMITS.EXPR_LEN) fail("an expression over " + TIKZ_LIMITS.EXPR_LEN + " characters");
  let i = 0, depth = 0, units = false;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const expr = () => { let v = term(); for (;;) { ws(); const c = s[i]; if (c === "+" || c === "-") { i++; const r = term(); v = c === "+" ? v + r : v - r; } else return v; } };
  const term = () => { let v = unary(); for (;;) { ws(); const c = s[i]; if (c === "*") { i++; v *= unary(); } else if (c === "/") { i++; const r = unary(); if (r === 0) fail("division by 0"); v /= r; } else return v; } };
  // (^ binds tighter than a sign, as pgfmath's: -2^2 is -4; its exponent may have a sign: 2^-1)
  const unary = () => { ws(); if (s[i] === "-") { i++; return -unary(); } if (s[i] === "+") { i++; return unary(); } return power(); };
  const power = () => { const b = atom(); ws(); if (s[i] === "^") { i++; return b ** unary(); } return b; };
  const atom = () => {
    ws();
    if (++depth > TIKZ_LIMITS.EXPR_DEPTH) fail("an expression nested over " + TIKZ_LIMITS.EXPR_DEPTH + " deep");
    try {
      if (s[i] === "(") { i++; const v = expr(); ws(); if (s[i] !== ")") fail("a ( without its ) in " + JSON.stringify(s)); i++; return v; }
      let m = /^(\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(s.slice(i));
      if (m) {
        i += m[0].length; let v = parseFloat(m[0]);
        ws();
        const u = /^(pt|cm|mm|in|bp|pc|sp|em|ex)(?![A-Za-z])/.exec(s.slice(i));
        if (u) { i += u[0].length; v *= UNITS[u[1]]; units = true; }
        return v;
      }
      m = /^[A-Za-z]+/.exec(s.slice(i));
      if (m) {
        const name = m[0]; i += name.length;
        if (name === "pi") return Math.PI;
        if (name === "e") return Math.E;
        ws();
        if (s[i] !== "(") fail("a name pgfmath doesn't know here: " + name);
        i++;
        const a = expr(); ws();
        if (s[i] === ",") {
          i++; const b = expr(); ws(); if (s[i] !== ")") fail("a function's ) missing in " + JSON.stringify(s)); i++;
          if (!Object.hasOwn(FUNCS2, name)) fail("a function the preview doesn't evaluate: " + name);
          return FUNCS2[name](a, b);
        }
        if (s[i] !== ")") fail("a function's ) missing in " + JSON.stringify(s)); i++;
        if (!Object.hasOwn(FUNCS, name)) fail("a function the preview doesn't evaluate: " + name);
        return FUNCS[name](a);
      }
      fail("an expression the preview can't read: " + JSON.stringify(s));
    } finally { depth--; }
  };
  const v = expr(); ws();
  if (i < s.length) fail("an expression the preview can't read: " + JSON.stringify(s));
  if (!Number.isFinite(v)) fail("a value too large in " + JSON.stringify(s));
  return { v, units };
}

// ------------------------------------------------------------------ options: key=value lists, styles, colours
/** Split an option list at top-level commas (none inside {}, (), $...$). */
export function splitOptions(text) {
  const out = []; let d = 0, cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { cur += c + text[++i]; continue; }
    if (c === "{" || c === "(") d++;
    else if (c === "}" || c === ")") d--;
    if (c === "," && d === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const unbrace = (v) => { v = v.trim(); return v.startsWith("{") && v.endsWith("}") && skipGroup(v, 0) === v.length - 1 ? v.slice(1, -1).trim() : v; };

/** A colour expression (xcolor's: name, name!pct, name!pct!name, ...) as "rgb(r,g,b)", or null. */
export function colorRgb(spec, docColors = {}) {
  const parts = String(spec).trim().split("!").map((x) => x.trim());
  const base = (name) => {
    if (Object.hasOwn(BASE, name)) return BASE[name];
    if (Object.hasOwn(docColors, name)) return parseCss(docColors[name]);
    return null;
  };
  let c = base(parts[0]);
  if (!c) return null;
  for (let k = 1; k < parts.length; k += 2) {
    const pct = Number(parts[k]);
    if (!(pct >= 0 && pct <= 100) || !/^\d+(\.\d+)?$/.test(parts[k])) return null;
    const other = k + 1 < parts.length ? base(parts[k + 1]) : BASE.white;
    if (!other) return null;
    c = c.map((x, q) => (x * pct) / 100 + other[q] * (1 - pct / 100));
  }
  return "rgb(" + c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255)).join(",") + ")";
}
// (a document colour as the renderer keeps it, "rgb(r,g,b)" or "#rrggbb", as [0..1] components)
function parseCss(css) {
  let m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(css);
  if (m) return [m[1], m[2], m[3]].map((x) => +x / 255);
  m = /^#([0-9a-fA-F]{6})$/.exec(css);
  if (m) return [0, 2, 4].map((k) => parseInt(m[1].slice(k, k + 2), 16) / 255);
  return null;
}

// arrow tips TikZ names: ">" (to), "<", "|", ">>", "Stealth", "Latex", "to", "latex", "stealth"
const TIPS = { ">": "to", "<": "to", to: "to", "|": "bar", ">>": "to2", "<<": "to2", Stealth: "stealth", stealth: "stealth", Latex: "latex", latex: "latex", Triangle: "latex" };
function arrowSpec(o) {
  const m = /^([^-]*?)-([^-]*)$/.exec(o.replace(/\{([A-Za-z]+)(\[[^\]]*\])?\}/g, "$1"));
  if (!m) return null;
  const tip = (t, end) => (t === "" ? null : Object.hasOwn(TIPS, t) ? TIPS[t] : fail("an arrow tip the preview doesn't draw: " + t));
  if (!(m[1] === "" || Object.hasOwn(TIPS, m[1])) || !(m[2] === "" || Object.hasOwn(TIPS, m[2]))) return null;
  return { start: tip(m[1], 0), end: tip(m[2], 1) };
}

// ------------------------------------------------------------------ affine transforms [a b c d e f]: (x,y) -> (ax+cy+e, bx+dy+f)
const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const inverse = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) fail("a transformation that flattens the picture (a scale of 0)");
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const rot = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };

// ------------------------------------------------------------------ the picture
class Picture {
  constructor(R, opts) {
    this.R = R; this.opts = opts || {};
    this.styles = new Map();          // name -> option text (.style)
    this.named = new Map();           // coordinate name -> canvas point
    this.paths = [];                  // drawn paths: {d: [[cmd, pts...]], st}
    this.items = 0; this.expansions = 0; this.lexed = 0; this.optionText = 0;
    this.box = null;                  // the bounding box in canvas pt
    this.markers = new Map();
  }
  // (every text read, the source's and each expansion's, counted in UTF-8 bytes: a body read again for each item is work
  //  again. foreach checks an expansion's size before it is made; this check is the backstop)
  lex(text) {
    const n = utf8Len(text);
    if (this.lexed + n > TIKZ_LIMITS.LEX_TEXT) fail(MORE_TEXT());
    this.lexed += n;
    return lex(text);
  }
  count(n = 1) { if ((this.items += n) > TIKZ_LIMITS.ITEMS) fail("more than " + TIKZ_LIMITS.ITEMS + " path segments"); }

  // ---- state: a scope's transform and style
  base() {
    return { m: ID.slice(), x: [PT_PER_CM, 0], y: [0, PT_PER_CM], draw: null, fill: null, color: "rgb(0,0,0)", lw: 0.4, dash: null,
      op: 1, dop: null, fop: null, arrows: { start: null, end: null }, defaultTip: "to", rounded: 0, cap: null, join: null, step: [PT_PER_CM, PT_PER_CM], doDraw: false, doFill: false };
  }
  // the options of a scope or path, applied left to right to a copy of `st`
  options(text, st, depth = 0) {
    if (depth > TIKZ_LIMITS.STYLE_DEPTH) fail("styles naming styles more than " + TIKZ_LIMITS.STYLE_DEPTH + " deep (a style that names itself?)");
    if ((this.optionText += utf8Len(text) + 32) > TIKZ_LIMITS.OPTION_TEXT) fail("options and styles past " + TIKZ_LIMITS.OPTION_TEXT + " bytes applied in all (styles naming styles many times over?)");
    for (const o of splitOptions(text)) this.option(o, st, depth);
    return st;
  }
  option(o, st, depth) {
    const eq = o.indexOf("=");
    const key = (eq < 0 ? o : o.slice(0, eq)).trim(), val = eq < 0 ? null : unbrace(o.slice(eq + 1));
    // a style's definition
    let m = /^([A-Za-z][\w ]*?)\/\.(style|append style)$/.exec(key);
    if (m) {
      if (val === null) fail("a .style without its definition");
      const name = m[1].trim();
      this.styles.set(name, m[2] === "append style" && this.styles.has(name) ? this.styles.get(name) + "," + val : val);
      return;
    }
    if (val === null && this.styles.has(key)) { this.options(this.styles.get(key), st, depth + 1); return; }
    if (val === null) {
      if (Object.hasOwn(WIDTHS, key)) { st.lw = WIDTHS[key]; return; }
      const dash = { solid: null, dashed: [3, 3], "densely dashed": [3, 2], "loosely dashed": [3, 6], dotted: ["lw", 2], "densely dotted": ["lw", 1], "loosely dotted": ["lw", 4], "dash dot": [3, 2, "lw", 2] };
      if (Object.hasOwn(dash, key)) { st.dash = dash[key]; return; }
      if (key === "draw") { st.doDraw = true; return; }
      if (key === "fill") { st.doFill = true; return; }
      if (key === "rounded corners") { st.rounded = 4; return; }
      if (key === "sharp corners") { st.rounded = 0; return; }
      if (key === "help lines") { st.draw = colorRgb("gray!50"); st.lw = 0.2; st.doDraw = true; return; }
      if (key === "transform shape" || key === "every picture" || key === "baseline") return;
      const a = arrowSpec(key);
      if (a) { st.arrows = { start: a.start && (a.start === "to" ? st.defaultTip : a.start), end: a.end && (a.end === "to" ? st.defaultTip : a.end) }; return; }
      const c = colorRgb(key, this.R.colors);
      if (c) { st.color = c; return; }
      fail("an option the preview doesn't draw: " + key);
    }
    const num = () => evalMath(val).v;
    const dim = (unitless = 1) => { const r = evalMath(val); return r.units ? r.v : r.v * unitless; };
    switch (key) {
      case "color": { const c = colorRgb(val, this.R.colors); if (!c) fail("a colour the preview doesn't know: " + val); st.color = c; return; }
      case "draw": { if (val === "none") { st.doDraw = false; return; } const c = colorRgb(val, this.R.colors); if (!c) fail("a colour the preview doesn't know: " + val); st.draw = c; st.doDraw = true; return; }
      case "fill": { if (val === "none") { st.doFill = false; return; } const c = colorRgb(val, this.R.colors); if (!c) fail("a colour the preview doesn't know: " + val); st.fill = c; st.doFill = true; return; }
      case "line width": st.lw = Math.max(0, Math.min(100, dim(1))); return;
      case "opacity": st.op = clamp01(num()); return;
      case "draw opacity": st.dop = clamp01(num()); return;
      case "fill opacity": st.fop = clamp01(num()); return;
      case "rounded corners": st.rounded = Math.max(0, Math.min(1000, dim(1))); return;
      case "line cap": if (!/^(butt|round|rect)$/.test(val)) fail("a line cap the preview doesn't draw: " + val); st.cap = val === "rect" ? "square" : val; return;
      case "line join": if (!/^(miter|round|bevel)$/.test(val)) fail("a line join the preview doesn't draw: " + val); st.join = val; return;
      case "dash pattern": {
        const p = []; const re = /(on|off)\s+([^ ]+(?:\s*(?:pt|cm|mm|in|bp))?)/g; let q;
        while ((q = re.exec(val))) p.push(Math.max(0, evalMath(q[2]).v));
        if (!p.length) fail("a dash pattern the preview can't read: " + val);
        st.dash = p; return;
      }
      case "scale": { const s = num(); st.m = mul(st.m, [s, 0, 0, s, 0, 0]); return; }
      case "xscale": st.m = mul(st.m, [num(), 0, 0, 1, 0, 0]); return;
      case "yscale": st.m = mul(st.m, [1, 0, 0, num(), 0, 0]); return;
      case "rotate": st.m = mul(st.m, rot(num())); return;
      case "xshift": st.m = mul(st.m, [1, 0, 0, 1, dim(1), 0]); return;
      case "yshift": st.m = mul(st.m, [1, 0, 0, 1, 0, dim(1)]); return;
      case "shift": { const p = this.pointOf(unbrace(val).replace(/^\((.*)\)$/s, "$1"), st, { rel: true }); st.m = mul(st.m, [1, 0, 0, 1, p[0], p[1]]); return; }
      case "rotate around": {
        const mm = /^\s*([^:]+):\s*\((.*)\)\s*$/s.exec(val); if (!mm) fail("rotate around the preview can't read: " + val);
        const p = this.pointOf(mm[2], st, { rel: true }), a = evalMath(mm[1]).v;
        st.m = mul(mul(mul(st.m, [1, 0, 0, 1, p[0], p[1]]), rot(a)), [1, 0, 0, 1, -p[0], -p[1]]); return;
      }
      // (a length, or a vector: x={(1cm,0.3cm)})
      case "x": st.x = /^\(/.test(val) ? this.pointOf(val.slice(1, -1), st, { rel: true }) : [dim(PT_PER_CM), 0]; return;
      case "y": st.y = /^\(/.test(val) ? this.pointOf(val.slice(1, -1), st, { rel: true }) : [0, dim(PT_PER_CM)]; return;
      case "step": { if (/^\(/.test(val)) { const p = this.pointOf(val.slice(1, -1), st, { rel: true }); st.step = [Math.abs(p[0]), Math.abs(p[1])]; } else { const v = Math.abs(dim(PT_PER_CM)); st.step = [v, v]; } return; }
      case ">": { const t = val.replace(/^\{|\}$/g, "").replace(/\[.*$/, ""); if (!Object.hasOwn(TIPS, t)) fail("an arrow tip the preview doesn't draw: " + t); st.defaultTip = TIPS[t]; return; }
      case "arrows": { const a = arrowSpec(val); if (!a) fail("arrows the preview can't read: " + val); st.arrows = a; return; }
      default:
        fail("an option the preview doesn't draw: " + key);
    }
  }

  // ---- coordinates: the text inside (...), as a user-space point in pt before the transform
  // rel: a vector (shift=, +/++): no named points
  pointOf(text, st, { rel = false } = {}) {
    const t = text.trim();
    let m;
    if (/^\$.*\$$/s.test(t)) return this.calc(t.slice(1, -1), st);
    if ((m = /^([A-Za-z][\w ]*?)(?:\.(\w[\w ]*))?$/.exec(t)) && !/^\d/.test(t) && !t.includes(",") && !t.includes(":")) {
      if (rel) fail("a named point where a vector is needed: " + t);
      if (m[2] !== undefined) fail("a node's anchor (" + t + "): nodes aren't drawn by the preview yet");
      if (!this.named.has(m[1].trim())) fail("a point not defined before it is used: (" + t + ")");
      return apply(inverse(st.m), this.named.get(m[1].trim()));
    }
    // polar: angle:radius
    let d = 0, k = -1;
    for (let i = 0; i < t.length; i++) { const c = t[i]; if (c === "{" || c === "(") d++; else if (c === "}" || c === ")") d--; else if (d === 0 && c === ":" && k < 0) k = i; }
    if (k >= 0) {
      const a = evalMath(unbrace(t.slice(0, k))).v, rr = evalMath(unbrace(t.slice(k + 1)));
      const c = rr.v * Math.cos((a * Math.PI) / 180), sn = rr.v * Math.sin((a * Math.PI) / 180);
      // (with a unit, in the canvas's own pt; without, along the x and y vectors, as pgf's \pgfpointpolarxy)
      return checkPt(rr.units ? [c, sn] : [c * st.x[0] + sn * st.y[0], c * st.x[1] + sn * st.y[1]]);
    }
    const parts = splitOptions(t);
    if (parts.length !== 2) fail("a coordinate the preview can't read: (" + t + ")");
    const xs = evalMath(unbrace(parts[0])), ys = evalMath(unbrace(parts[1]));
    const x = xs.units ? [xs.v, 0] : [xs.v * st.x[0], xs.v * st.x[1]];
    const y = ys.units ? [0, ys.v] : [ys.v * st.y[0], ys.v * st.y[1]];
    return checkPt([x[0] + y[0], x[1] + y[1]]);
  }
  // the calc library's two forms: (A)!t!(B) and (A)+(B) / (A)-(B)
  calc(t, st) {
    const parts = [];
    const re = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g; let m, last = 0;
    const ops = [];
    while ((m = re.exec(t))) { ops.push(t.slice(last, m.index).trim()); parts.push(m[1]); last = re.lastIndex; }
    const tail = t.slice(last).trim();
    if (parts.length === 2 && /^!(.+)!$/.test(ops[1]) && !ops[0] && !tail) {
      const a = this.pointOf(parts[0], st), b = this.pointOf(parts[1], st), f = evalMath(ops[1].slice(1, -1)).v;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }
    if (parts.length >= 1 && !ops[0] && !tail && ops.slice(1).every((o) => o === "+" || o === "-")) {
      let p = this.pointOf(parts[0], st);
      for (let q = 1; q < parts.length; q++) { const v = this.pointOf(parts[q], st, { rel: /^[\d.+-]/.test(parts[q].trim()) || parts[q].includes(",") }); p = ops[q] === "+" ? [p[0] + v[0], p[1] + v[1]] : [p[0] - v[0], p[1] - v[1]]; }
      return p;
    }
    fail("a calc expression the preview doesn't draw: ($" + t + "$)");
  }

  // ---- the commands, from the token list: toks[lo..hi) (a scope's own range, not a copy); depth: \foreach's nesting,
  // sdepth: the scopes'
  run(toks, st, depth = 0, lo = 0, hi = toks.length, sdepth = 0) {
    let i = lo;
    while (i < hi) {
      const tk = toks[i];
      if (tk.t === "ch" && tk.v === ";") { i++; continue; }
      if (tk.t !== "cs") fail(tk.t === "ch" ? "text the preview can't read in a picture: " + tk.v : "a group the preview can't read in a picture");
      const name = tk.v;
      i++;
      if (name === "draw" || name === "fill" || name === "filldraw" || name === "path" || name === "clip" || name === "shade" || name === "shadedraw" || name === "pattern") {
        if (name === "clip" || name === "shade" || name === "shadedraw" || name === "pattern") fail("\\" + name + " isn't drawn by the preview yet");
        const end = toEnd(toks, i, hi);
        this.path(name, toks.slice(i, end), st);
        i = end + 1;
      } else if (name === "coordinate") {
        const end = toEnd(toks, i, hi);
        this.coordinate(toks.slice(i, end), st);
        i = end + 1;
      } else if (name === "node" || name === "matrix" || name === "pic" || name === "graph") {
        fail("\\" + name + (name === "node" ? ": nodes aren't drawn by the preview yet" : " isn't drawn by the preview yet"));
      } else if (name === "foreach") {
        i = this.foreach(toks, i, st, depth, hi, sdepth);
      } else if (name === "begin") {
        const env = toks[i]?.t === "g" ? toks[i].v.trim() : "";
        if (env !== "scope") fail(env ? "the " + env + " environment inside a picture isn't drawn by the preview yet" : "\\begin without its name");
        if (sdepth >= TIKZ_LIMITS.SCOPE_DEPTH) fail("scopes inside scopes more than " + TIKZ_LIMITS.SCOPE_DEPTH + " deep");
        // (the scope's styles and transform stay in it: the style table as it was, back after it)
        const saved = new Map(this.styles);
        let j = i + 1, inner = { ...st, arrows: { ...st.arrows } };
        if (toks[j]?.t === "o") { inner = this.options(toks[j].v, inner); j++; }
        // (the matching \end{scope})
        let d = 1, k = j;
        for (; k < hi; k++) {
          if (toks[k].t === "cs" && toks[k].v === "begin" && toks[k + 1]?.t === "g" && toks[k + 1].v.trim() === "scope") d++;
          if (toks[k].t === "cs" && toks[k].v === "end" && toks[k + 1]?.t === "g" && toks[k + 1].v.trim() === "scope" && --d === 0) break;
        }
        if (k >= hi) fail("a scope without its \\end{scope}");
        try { this.run(toks, inner, depth, j, k, sdepth + 1); } finally { this.styles = saved; }
        i = k + 2;
      } else if (name === "tikzset") {
        if (toks[i]?.t !== "g") fail("\\tikzset without its {...}");
        this.options(toks[i].v, st); i++;
      } else if (name === "pgfmathsetmacro") {
        fail("\\pgfmathsetmacro outside \\foreach isn't drawn by the preview yet");
      } else fail("\\" + name + " isn't drawn by the preview yet");
    }
  }

  coordinate(toks, st) {
    let i = 0, inner = st;
    if (toks[i]?.t === "o") { inner = this.options(toks[i].v, { ...st }); i++; }
    if (toks[i]?.t !== "c") fail("\\coordinate without its (name)");
    const name = toks[i].v.trim(); i++;
    if (!/^[A-Za-z][\w ]*$/.test(name)) fail("a coordinate name the preview can't use: " + name);
    if (!(toks[i]?.t === "ch" && toks[i].v === "a" && toks[i + 1]?.v === "t")) fail("\\coordinate (" + name + ") without at (...)");
    i += 2;
    if (toks[i]?.t !== "c") fail("\\coordinate (" + name + ") at without its (...)");
    this.named.set(name, apply(inner.m, this.pointOf(toks[i].v, inner)));
  }

  // \foreach \x in {list} body, or \foreach \x/\y in {a/b, ...}; the body a {group} or one command up to its ;
  foreach(toks, i, st, depth, hi, sdepth) {
    if (depth >= TIKZ_LIMITS.FOREACH_DEPTH) fail("\\foreach inside \\foreach more than " + TIKZ_LIMITS.FOREACH_DEPTH + " deep");
    const vars = [];
    while (toks[i]?.t === "cs") { vars.push(toks[i].v); i++; if (toks[i]?.t === "ch" && toks[i].v === "/") i++; else break; }
    if (!vars.length) fail("\\foreach without its \\variable");
    if (toks[i]?.t === "o") fail("\\foreach's options (evaluate, count, ...) aren't drawn by the preview yet");
    if (!(toks[i]?.t === "ch" && toks[i].v === "i" && toks[i + 1]?.v === "n")) fail("\\foreach without in");
    i += 2;
    if (toks[i]?.t !== "g") fail("\\foreach without its {list}");
    const list = expandList(toks[i].v);
    i++;
    let body, next;
    if (toks[i]?.t === "g") { body = toks[i].v; next = i + 1; }
    else { const end = bodyEnd(toks, i, hi); body = srcOf(toks.slice(i, end + 1)); next = end + 1; }
    const res = vars.map((v) => new RegExp("\\\\" + v.replace(/[^A-Za-z@]/g, (c) => "\\" + c) + "(?![A-Za-z@])", "g"));
    const varBytes = vars.map((v) => utf8Len("\\" + v));
    for (const item of list) {
      if (++this.expansions > TIKZ_LIMITS.EXPAND) fail("\\foreach bodies expanded more than " + TIKZ_LIMITS.EXPAND + " times");
      const vals = splitSlash(item, vars.length);
      // (each variable replaced in turn, as TeX would: a value naming a later variable is expanded too. Before each
      //  replacement, its result's size, from the text as it is now, in UTF-8 bytes: so no text over SRC_MAX is ever
      //  made. Each text scanned counts as read; lex() checks the total before the expansion is read)
      let text = body, size = utf8Len(body);
      for (let q = 0; q < res.length; q++) {
        this.lexed += size;
        const uses = (text.match(res[q]) || []).length;
        if (!uses) continue;
        const next = size + uses * (utf8Len(vals[q]) - varBytes[q]);
        if (next > TIKZ_LIMITS.SRC_MAX) fail("a \\foreach body over " + TIKZ_LIMITS.SRC_MAX / 1024 + " KiB once its variables are replaced");
        text = text.replace(res[q], () => vals[q]); size = next;
      }
      this.run(this.lex(text), st, depth + 1, 0, undefined, sdepth);
    }
    return next;
  }

  // ---- a path: its options, then its operations
  path(cmd, toks, st0) {
    let st = { ...st0, arrows: { ...st0.arrows } };
    st.doDraw = cmd === "draw" || cmd === "filldraw";
    st.doFill = cmd === "fill" || cmd === "filldraw";
    let i = 0;
    while (toks[i]?.t === "o") { st = this.options(toks[i].v, st); i++; }
    const segs = [];         // [["M", p], ["L", p], ["C", c1, c2, p], ["Z"]] in user space
    let cur = null, ref = null, start = null;
    const move = (p) => { segs.push(["M", p]); cur = ref = start = p; this.count(); };
    const line = (p) => { if (!cur) fail("a path that draws before it starts"); segs.push(["L", p]); cur = p; this.count(); };
    const curve = (c1, c2, p) => { segs.push(["C", c1, c2, p]); cur = p; this.count(); };
    // a coordinate token at k: [point, next index]; + and ++ relative to the reference point
    const coordAt = (k) => {
      let mode = 0;
      if (toks[k]?.t === "ch" && toks[k].v === "+") { mode = 1; k++; if (toks[k]?.t === "ch" && toks[k].v === "+") { mode = 2; k++; } }
      if (toks[k]?.t !== "c") return null;
      let p;
      if (mode) { if (!ref) fail("a relative point with nothing before it"); const v = this.pointOf(toks[k].v, st, { rel: true }); p = [ref[0] + v[0], ref[1] + v[1]]; }
      else p = this.pointOf(toks[k].v, st);
      return [checkPt(p), k + 1, mode];
    };
    const settle = (p, mode) => { if (mode !== 1) ref = p; };
    while (i < toks.length) {
      const tk = toks[i];
      const c = coordAt(i);
      if (c) { move(c[0]); settle(c[0], c[2]); i = c[1]; continue; }
      if (tk.t === "ch" && tk.v === "-" && toks[i + 1]?.t === "ch" && toks[i + 1].v === "-") {
        i += 2;
        if (isWord(toks, i, "cycle")) { segs.push(["Z"]); cur = ref = start; i += 5; this.count(); continue; }
        const q = coordAt(i); if (!q) fail("-- without the point after it");
        line(q[0]); settle(q[0], q[2]); i = q[1]; continue;
      }
      if (tk.t === "ch" && (tk.v === "|" || tk.v === "-") && toks[i + 1]?.t === "ch" && (toks[i + 1].v === "-" || toks[i + 1].v === "|") && tk.v !== toks[i + 1].v) {
        const vfirst = tk.v === "|"; i += 2;
        const q = coordAt(i); if (!q) fail((vfirst ? "|-" : "-|") + " without the point after it");
        const mid = vfirst ? [cur[0], q[0][1]] : [q[0][0], cur[1]];
        line(mid); line(q[0]); settle(q[0], q[2]); i = q[1]; continue;
      }
      if (tk.t === "ch" && tk.v === "." && toks[i + 1]?.v === ".") {
        i += 2;
        if (!isWord(toks, i, "controls")) fail(".. without controls");
        i += 8;
        const a = coordAt(i); if (!a) fail(".. controls without its point");
        let c1 = a[0], c2 = a[0]; i = a[1];
        // (in "+(...)" form the first control is relative to the start, the second to the end: resolved below)
        let second = null;
        if (isWord(toks, i, "and")) { i += 3; second = i; const b = coordAt(i); if (!b) fail("controls ... and without its point"); c2 = b[0]; i = b[1]; }
        if (!(toks[i]?.v === "." && toks[i + 1]?.v === ".")) fail(".. controls without its closing ..");
        i += 2;
        const e = coordAt(i); if (!e) fail(".. controls .. without its end point");
        if (second !== null && toks[second]?.v === "+") { const v = this.pointOf(toks[second + (toks[second + 1]?.v === "+" ? 2 : 1)].v, st, { rel: true }); c2 = [e[0][0] + v[0], e[0][1] + v[1]]; }
        curve(c1, c2, e[0]); settle(e[0], e[2]); i = e[1]; continue;
      }
      if (isWord(toks, i, "rectangle")) {
        i += 9; const q = coordAt(i); if (!q) fail("rectangle without its corner");
        const a = cur, b = q[0];
        if (!a) fail("rectangle with nothing before it");
        move(a); line([b[0], a[1]]); line(b); line([a[0], b[1]]); segs.push(["Z"]);
        cur = b; settle(b, q[2]); i = q[1]; continue;
      }
      if (isWord(toks, i, "circle") || isWord(toks, i, "ellipse")) {
        const isC = isWord(toks, i, "circle"); i += isC ? 6 : 7;
        let rx, ry;
        if (toks[i]?.t === "o") {
          const o = Object.fromEntries(splitOptions(toks[i].v).map((x) => { const e = x.indexOf("="); return [x.slice(0, e).trim(), unbrace(x.slice(e + 1))]; }));
          const r = (v, axis) => { const z = evalMath(v); return z.units ? z.v : z.v * Math.hypot(...(axis ? st.y : st.x)); };
          if (o.radius !== undefined) rx = ry = r(o.radius, 0);
          if (o["x radius"] !== undefined) rx = r(o["x radius"], 0);
          if (o["y radius"] !== undefined) ry = r(o["y radius"], 1);
          if (rx === undefined || ry === undefined) fail("a circle's options the preview can't read: " + toks[i].v);
          i++;
        } else if (toks[i]?.t === "c") {
          const v = toks[i].v, parts = v.split(/\s+and\s+/);
          const r = (w, axis) => { const z = evalMath(unbrace(w)); return z.units ? z.v : z.v * Math.hypot(...(axis ? st.y : st.x)); };
          if (parts.length === 2) { rx = r(parts[0], 0); ry = r(parts[1], 1); } else { rx = r(v, 0); ry = isC ? r(v, 1) : rx; }
          i++;
        } else fail((isC ? "circle" : "ellipse") + " without its radius");
        if (!cur) fail("a circle with nothing before it");
        const ctr = cur;
        ellipseArc(ctr, rx, ry, 0, 360).forEach((s, k) => (k === 0 ? move(s[0]) : curve(s[0], s[1], s[2])));
        segs.push(["Z"]); cur = ref = ctr; start = ctr;
        continue;
      }
      if (isWord(toks, i, "arc")) {
        i += 3;
        let a0, a1, rx, ry;
        if (toks[i]?.t === "o") {
          const o = Object.fromEntries(splitOptions(toks[i].v).map((x) => { const e = x.indexOf("="); return [x.slice(0, e).trim(), unbrace(x.slice(e + 1))]; }));
          const r = (v, axis) => { const z = evalMath(v); return z.units ? z.v : z.v * Math.hypot(...(axis ? st.y : st.x)); };
          if (o["start angle"] !== undefined) a0 = evalMath(o["start angle"]).v;
          if (o["end angle"] !== undefined) a1 = evalMath(o["end angle"]).v;
          if (o["delta angle"] !== undefined) a1 = a0 + evalMath(o["delta angle"]).v;
          if (o.radius !== undefined) rx = ry = r(o.radius, 0);
          if (o["x radius"] !== undefined) rx = r(o["x radius"], 0);
          if (o["y radius"] !== undefined) ry = r(o["y radius"], 1);
          i++;
        } else if (toks[i]?.t === "c") {
          const parts = toks[i].v.split(":");
          if (parts.length !== 3) fail("an arc the preview can't read: (" + toks[i].v + ")");
          a0 = evalMath(unbrace(parts[0])).v; a1 = evalMath(unbrace(parts[1])).v;
          const rr = parts[2].split(/\s+and\s+/);
          const r = (w, axis) => { const z = evalMath(unbrace(w)); return z.units ? z.v : z.v * Math.hypot(...(axis ? st.y : st.x)); };
          rx = r(rr[0], 0); ry = rr.length === 2 ? r(rr[1], 1) : r(rr[0], 1);
          i++;
        } else fail("arc without its angles and radius");
        if ([a0, a1, rx, ry].some((x) => x === undefined)) fail("an arc without its start, end or radius");
        if (!cur) fail("an arc with nothing before it");
        // (the angles brought near 0, by whole turns: cos and sin keep their precision)
        { const turn = a0 - (((a0 % 360) + 360) % 360); a0 -= turn; a1 -= turn; }
        const ctr = [cur[0] - rx * Math.cos((a0 * Math.PI) / 180), cur[1] - ry * Math.sin((a0 * Math.PI) / 180)];
        const bs = ellipseArc(ctr, rx, ry, a0, a1);
        bs.slice(1).forEach((s) => curve(s[0], s[1], s[2]));
        ref = cur; continue;
      }
      if (isWord(toks, i, "to")) {
        i += 2;
        let out = null, inn = null, bend = null, loose = 1;
        if (toks[i]?.t === "o") {
          for (const o of splitOptions(toks[i].v)) {
            const e = o.indexOf("="), k = (e < 0 ? o : o.slice(0, e)).trim(), v = e < 0 ? null : unbrace(o.slice(e + 1));
            if (k === "out") out = evalMath(v).v;
            else if (k === "in") inn = evalMath(v).v;
            else if (k === "bend left" || k === "bend right") bend = (k === "bend left" ? 1 : -1) * (v === null ? 30 : evalMath(v).v);
            else if (k === "looseness") loose = evalMath(v).v;
            else fail("a to option the preview doesn't draw: " + k);
          }
          i++;
        }
        const q = coordAt(i); if (!q) fail("to without its point");
        const p = q[0];
        if (!cur) fail("to with nothing before it");
        if (out === null && inn === null && bend === null) line(p);
        else {
          const dir = (Math.atan2(p[1] - cur[1], p[0] - cur[0]) * 180) / Math.PI, back = dir + 180;
          if (bend !== null) { out = dir + bend; inn = back - bend; }
          if (out === null || inn === null) fail("to with out= but not in= (or in= but not out=)");
          const dist = 0.39 * loose * Math.hypot(p[0] - cur[0], p[1] - cur[1]);
          const c1 = [cur[0] + dist * Math.cos((out * Math.PI) / 180), cur[1] + dist * Math.sin((out * Math.PI) / 180)];
          const c2 = [p[0] + dist * Math.cos((inn * Math.PI) / 180), p[1] + dist * Math.sin((inn * Math.PI) / 180)];
          curve(c1, c2, p);
        }
        settle(p, q[2]); i = q[1]; continue;
      }
      if (isWord(toks, i, "grid")) {
        i += 4;
        let gst = st;
        if (toks[i]?.t === "o") { gst = this.options(toks[i].v, { ...st }); i++; }
        const q = coordAt(i); if (!q) fail("grid without its corner");
        if (!cur) fail("grid with nothing before it");
        const [sx, sy] = gst.step;
        if (!(sx > 0) || !(sy > 0)) fail("a grid with a step of 0");
        const x0 = Math.min(cur[0], q[0][0]), x1 = Math.max(cur[0], q[0][0]), y0 = Math.min(cur[1], q[0][1]), y1 = Math.max(cur[1], q[0][1]);
        const nx = Math.floor(x1 / sx + 1e-9) - Math.ceil(x0 / sx - 1e-9) + 1, ny = Math.floor(y1 / sy + 1e-9) - Math.ceil(y0 / sy - 1e-9) + 1;
        if (nx + ny > TIKZ_LIMITS.GRID_LINES) fail("a grid of more than " + TIKZ_LIMITS.GRID_LINES + " lines");
        move([x0, y0]); move([x1, y1]);
        // (as TikZ: its first line at the first multiple of the step from the near corner, drawn even past the far one;
        //  then each multiple up to the far corner)
        let x = Math.ceil(x0 / sx - 1e-9) * sx; do { move([x, y0]); line([x, y1]); x += sx; } while (x <= x1 + 1e-9);
        let y = Math.ceil(y0 / sy - 1e-9) * sy; do { move([x0, y]); line([x1, y]); y += sy; } while (y <= y1 + 1e-9);
        cur = q[0]; settle(q[0], q[2]); i = q[1]; continue;
      }
      if (isWord(toks, i, "node") || isWord(toks, i, "coordinate") || isWord(toks, i, "pic") || isWord(toks, i, "edge") || isWord(toks, i, "plot") || isWord(toks, i, "sin") || isWord(toks, i, "cos") || isWord(toks, i, "parabola")) {
        const w = ["node", "coordinate", "pic", "edge", "plot", "sin", "cos", "parabola"].find((x) => isWord(toks, i, x));
        fail(w === "node" || w === "coordinate" ? "a " + w + " on a path: nodes aren't drawn by the preview yet" : "the path operation " + w + " isn't drawn by the preview yet");
      }
      fail("a path the preview can't read at " + JSON.stringify(srcOf(toks.slice(i, i + 4))));
    }
    if (!segs.length) return;
    if (!st.doDraw && !st.doFill) return;
    this.emit(segs, st);
  }

  // ---- one path into SVG, its points mapped to the canvas
  emit(segs, st) {
    const m = st.m;
    // (this path's own extent, padded by half its line width and its arrow tips, then merged into the picture's)
    let bx = null;
    const P = (p) => { checkPt(p = apply(m, p)); bx = bx ? [Math.min(bx[0], p[0]), Math.min(bx[1], p[1]), Math.max(bx[2], p[0]), Math.max(bx[3], p[1])] : [p[0], p[1], p[0], p[1]]; return p; };
    let d = "";
    const rounded = st.rounded > 0 ? roundCorners(segs, st.rounded / Math.max(1e-9, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])))) : segs;
    for (const s of rounded) {
      if (s[0] === "M") d += "M" + xy(P(s[1]));
      else if (s[0] === "L") d += "L" + xy(P(s[1]));
      else if (s[0] === "C") d += "C" + xy(P(s[1])) + " " + xy(P(s[2])) + " " + xy(P(s[3]));
      else if (s[0] === "Z") d += "Z";
    }
    const pad = st.doDraw ? st.lw / 2 : 0;
    bx = [bx[0] - pad, bx[1] - pad, bx[2] + pad, bx[3] + pad];
    if (st.doDraw) for (const [tip, at] of [[st.arrows.end, endTangent(segs, false)], [st.arrows.start, endTangent(segs, true)]]) {
      if (!tip || !at) continue;
      const E = apply(m, at[0]), B = apply(m, at[1]), dx = E[0] - B[0], dy = E[1] - B[1], len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;
      const ux = dx / len, uy = dy / len, { hw, back } = tipSize(tip, st.lw);
      for (const sgn of [1, -1]) { const q = [E[0] - ux * back - sgn * uy * (hw + st.lw / 2), E[1] - uy * back + sgn * ux * (hw + st.lw / 2)]; bx = [Math.min(bx[0], q[0]), Math.min(bx[1], q[1]), Math.max(bx[2], q[0]), Math.max(bx[3], q[1])]; }
    }
    this.box = this.box ? [Math.min(this.box[0], bx[0]), Math.min(this.box[1], bx[1]), Math.max(this.box[2], bx[2]), Math.max(this.box[3], bx[3])] : bx;
    this.paths.push({ d, st });
  }
  marker(tip, color, lw) {
    const key = tip + "|" + color + "|" + fmtNum(lw);
    if (!this.markers.has(key)) this.markers.set(key, "tk" + ++this.R.idn);
    return this.markers.get(key);
  }

  svg() {
    if (!this.paths.length || !this.box) return null;
    // (each path's own pad, half its line width and its tips, already in the box as it was drawn: the box again, padded)
    const [x0, y0, x1, y1] = this.box;
    const W = Math.max(1, x1 - x0), H = Math.max(1, y1 - y0);
    const X = (x) => fmtNum(x - x0), Y = (y) => fmtNum(y1 - y);
    let body = "", defs = "";
    for (const p of this.paths) {
      const st = p.st;
      const stroke = st.doDraw ? st.draw ?? st.color : "none", fill = st.doFill ? st.fill ?? st.color : "none";
      const d = p.d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, a, b) => X(+a) + "," + Y(+b));
      let a = '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '"';
      if (st.doDraw) {
        a += ' stroke-width="' + fmtNum(st.lw) + '"';
        if (st.dash) a += ' stroke-dasharray="' + st.dash.map((v) => fmtNum(v === "lw" ? Math.max(st.lw, 0.01) : v)).join(" ") + '"';
        if (st.cap) a += ' stroke-linecap="' + st.cap + '"';
        if (st.join) a += ' stroke-linejoin="' + st.join + '"';
        if (st.arrows.end) a += ' marker-end="url(#' + this.marker(st.arrows.end, stroke, st.lw) + ')"';
        if (st.arrows.start) a += ' marker-start="url(#' + this.marker(st.arrows.start, stroke, st.lw) + ')"';
      }
      const dop = st.dop ?? st.op, fop = st.fop ?? st.op;
      if (dop < 1 && st.doDraw) a += ' stroke-opacity="' + fmtNum(dop) + '"';
      if (fop < 1 && st.doFill) a += ' fill-opacity="' + fmtNum(fop) + '"';
      body += a + "/>";
    }
    for (const [key, id] of this.markers) {
      const [tip, color, lw] = key.split("|");
      defs += markerSvg(id, tip, color, +lw);
    }
    // (its own inline styles, no stylesheet: the picture's box as TeX's, on the baseline; strokes past it shown. data-box:
    //  that box in TeX's coordinates, pt, x0 y0 x1 y1, for the tests and a later on-page correction)
    const out = '<span class="tikz" data-box="' + [x0, y0, x1, y1].map(fmtNum).join(" ") + '" style="display:inline-block;position:relative;vertical-align:baseline;width:' + fmtNum(W) + "pt;height:" + fmtNum(H) + 'pt"><svg width="' + fmtNum(W) + 'pt" height="' + fmtNum(H) + 'pt" viewBox="0 0 ' + fmtNum(W) + " " + fmtNum(H) + '" style="display:block;overflow:visible">' +
      (defs ? "<defs>" + defs + "</defs>" : "") + body + "</svg></span>";
    if (out.length > TIKZ_LIMITS.SVG_BYTES) fail("a picture over " + TIKZ_LIMITS.SVG_BYTES / 2 ** 20 + " MiB of SVG");
    return out;
  }
}

// ------------------------------------------------------------------ helpers
// an arrow tip's half width (across the line) and how far its wide end is set back from the point, in pt, for a line
// width: TeX's own sizes, measured (pdflatex, TikZ 3.1: at 0.4 pt and 1.6 pt; linear in the line width between)
function tipSize(tip, lw) {
  const t = { to: [1.677, 1.806, 2.08], to2: [1.677, 1.806, 2.08], stealth: [1.125, 1.1875, 3.6], latex: [1.125, 1.1875, 3.6], bar: [1.5, 1.5, 0] }[tip] || [1.677, 1.806, 2.08];
  return { hw: t[0] + t[1] * lw, back: t[2] * (lw / 0.4) ** 0.5 };
}
// the path's end (or start) point and the point it comes from, in user space: [end, from], or null
function endTangent(segs, start) {
  const pts = [];
  for (const sg of segs) { if (sg[0] === "M" || sg[0] === "L") pts.push(sg[1]); else if (sg[0] === "C") pts.push(sg[1], sg[2], sg[3]); }
  const list = start ? pts : pts.slice().reverse();
  const e = list[0];
  if (!e) return null;
  const from = list.find((q) => Math.hypot(q[0] - e[0], q[1] - e[1]) > 1e-9);
  return from ? [e, from] : null;
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const fmtNum = (x) => { if (!Number.isFinite(x)) fail("a value that isn't finite"); const r = Math.round(x * 100) / 100; return Object.is(r, -0) ? "0" : String(r); };
const xy = (p) => fmtNum(p[0]) + "," + fmtNum(p[1]);
function checkPt(p) {
  if (!p.every(Number.isFinite)) fail("a point that isn't finite");
  if (Math.abs(p[0]) > TIKZ_LIMITS.COORD_MAX || Math.abs(p[1]) > TIKZ_LIMITS.COORD_MAX) fail("a point farther than " + Math.round(TIKZ_LIMITS.COORD_MAX / PT_PER_CM / 100) + " m");
  return p;
}
const isWord = (toks, i, w) => { for (let k = 0; k < w.length; k++) if (!(toks[i + k]?.t === "ch" && toks[i + k].v === w[k])) return false; const after = toks[i + w.length]; return !(after?.t === "ch" && /[A-Za-z]/.test(after.v)); };
// (the index of the ; ending the command that starts at i, at the top level)
// (a \foreach's body when not a {group}: one command up to its ;, or a \foreach, ending where its own body ends)
function bodyEnd(toks, i, hi = toks.length) {
  while (toks[i]?.t === "cs" && toks[i].v === "foreach") {
    let k = i + 1;
    while (k < hi && toks[k].t !== "g") k++;
    if (k + 1 < hi && toks[k + 1]?.t === "g") return k + 1;
    i = k + 1;
  }
  return toEnd(toks, i, hi);
}
function toEnd(toks, i, hi = toks.length) { for (let k = i; k < hi; k++) if (toks[k].t === "ch" && toks[k].v === ";") return k; fail("a command without its ;"); }
function srcOf(toks) { return toks.map((t) => (t.t === "cs" ? "\\" + t.v + " " : t.t === "g" ? "{" + t.v + "}" : t.t === "o" ? "[" + t.v + "]" : t.t === "c" ? "(" + t.v + ")" : t.v)).join(""); }
// \foreach's list: items, with "a,...,b" and "a,b,...,c" ranges
function expandList(text) {
  const items = splitOptions(text).map(unbrace);
  const out = [];
  for (let k = 0; k < items.length; k++) {
    if (items[k] === "..." || items[k] === "\\ldots") {
      if (k === 0 || k + 1 >= items.length) fail("a \\foreach range without its ends");
      const a = evalMath(items[k - 1]).v, z = evalMath(items[k + 1]).v;
      const step = k >= 2 && /^[-\d.]+$/.test(items[k - 2]) ? a - evalMath(items[k - 2]).v : z >= a ? 1 : -1;
      if (step === 0 || Math.sign(step) !== Math.sign(z - a || step)) fail("a \\foreach range that never ends");
      if (Math.abs((z - a) / step) > TIKZ_LIMITS.EXPAND) fail("a \\foreach range of more than " + TIKZ_LIMITS.EXPAND + " items");
      // (the number of steps first: a + step can round back to a, so a loop on the value might never end)
      const n = Math.floor(Math.abs((z - a) / step) + 1e-9);
      for (let j = 1; j <= n; j++) { out.push(fmtNum(a + j * step)); if (out.length > TIKZ_LIMITS.EXPAND) fail("a \\foreach list of more than " + TIKZ_LIMITS.EXPAND + " items"); }
      k++;
      // (the end item itself was pushed by the loop; skip pushing it again)
      continue;
    }
    out.push(items[k]);
    if (out.length > TIKZ_LIMITS.EXPAND) fail("a \\foreach list of more than " + TIKZ_LIMITS.EXPAND + " items");
  }
  return out;
}
function splitSlash(item, n) {
  if (n === 1) return [item];
  const p = item.split("/").map((x) => x.trim());
  if (p.length !== n) fail("a \\foreach item that doesn't have " + n + " parts: " + item);
  return p;
}
// an ellipse's arc from a0 to a1 degrees as cubic Béziers: [[start], [c1, c2, end], ...], split where pgf splits it,
// each quarter turn from a0 (TeX's bounding box holds the control points, so the split shows in it)
function ellipseArc(c, rx, ry, a0, a1) {
  const dir = a1 >= a0 ? 1 : -1, cuts = [a0];
  if (Math.abs(a1 - a0) > 36000) fail("an arc of more than 100 turns");
  const n = Math.ceil(Math.abs(a1 - a0) / 90 - 1e-9);
  for (let j = 1; j < n; j++) cuts.push(a0 + 90 * dir * j);
  cuts.push(a1);
  const pt = (a) => [c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)];
  const out = [[pt((a0 * Math.PI) / 180)]];
  for (let q = 0; q + 1 < cuts.length; q++) {
    const s = (cuts[q] * Math.PI) / 180, e = (cuts[q + 1] * Math.PI) / 180, k = (4 / 3) * Math.tan((e - s) / 4);
    out.push([[c[0] + rx * (Math.cos(s) - k * Math.sin(s)), c[1] + ry * (Math.sin(s) + k * Math.cos(s))], [c[0] + rx * (Math.cos(e) + k * Math.sin(e)), c[1] + ry * (Math.sin(e) - k * Math.cos(e))], pt(e)]);
  }
  return out;
}
// rounded corners: each corner between two straight segments cut back by r (at most half of either) and joined by a curve
function roundCorners(segs, r) {
  const out = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], next = segs[k + 1];
    if (s[0] === "L" && next && next[0] === "L") {
      const prev = out[out.length - 1], a = prev[0] === "C" ? prev[3] : prev[1], b = s[1], c = next[1];
      const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const q = Math.min(r, l1 / 2, l2 / 2);
      if (q > 0 && l1 > 0 && l2 > 0) {
        const p1 = [b[0] + ((a[0] - b[0]) * q) / l1, b[1] + ((a[1] - b[1]) * q) / l1], p2 = [b[0] + ((c[0] - b[0]) * q) / l2, b[1] + ((c[1] - b[1]) * q) / l2];
        out.push(["L", p1], ["C", [(p1[0] + 2 * b[0]) / 3, (p1[1] + 2 * b[1]) / 3], [(p2[0] + 2 * b[0]) / 3, (p2[1] + 2 * b[1]) / 3], p2]);
        continue;
      }
    }
    out.push(s);
  }
  return out;
}
// an arrow tip as an SVG marker, its size following the line width (markerUnits strokeWidth), its colour the stroke's
// (in the picture's units, pt, not the stroke's: TeX's tips grow as a + b·lw, not in proportion to the line, so each is
//  drawn from tipSize, the numbers the box uses: half width hw, the wide end `back` behind the end point)
function markerSvg(id, tip, color, lw) {
  const { hw, back } = tipSize(tip, lw), f = fmtNum, line = ' fill="none" stroke="' + color + '" stroke-width="' + f(lw) + '" stroke-linecap="round" stroke-linejoin="round"/>';
  // (`to`: two arms curving into the end point, as the legacy tip; ->> a second one behind it)
  const arms = (dx) => "M" + f(dx - back) + " " + f(-hw) + "C" + f(dx - back * 0.73) + " " + f(-hw * 0.39) + " " + f(dx - back * 0.3) + " " + f(-hw * 0.11) + " " + f(dx) + " 0C" + f(dx - back * 0.3) + " " + f(hw * 0.11) + " " + f(dx - back * 0.73) + " " + f(hw * 0.39) + " " + f(dx - back) + " " + f(hw);
  const H = hw + lw / 2, B = back + lw / 2;
  const shapes = {
    to: '<path d="' + arms(0) + '"' + line,
    to2: '<path d="' + arms(0) + arms(-back - 2 * lw) + '"' + line,
    stealth: '<path d="M' + f(-B) + " " + f(-H) + "L" + f(lw / 2) + " 0L" + f(-B) + " " + f(H) + "L" + f(-B * 0.72) + ' 0Z" fill="' + color + '"/>',
    latex: '<path d="M' + f(-B) + " " + f(-H) + "C" + f(-B * 0.55) + " " + f(-H * 0.62) + " " + f(-B * 0.15) + " " + f(-H * 0.2) + " " + f(lw / 2) + " 0C" + f(-B * 0.15) + " " + f(H * 0.2) + " " + f(-B * 0.55) + " " + f(H * 0.62) + " " + f(-B) + " " + f(H) + 'Z" fill="' + color + '"/>',
    bar: '<path d="M0 ' + f(-hw) + "L0 " + f(hw) + '" stroke="' + color + '" stroke-width="' + f(lw) + '" stroke-linecap="square"/>',
  };
  return '<marker id="' + id + '" markerUnits="userSpaceOnUse" refX="0" refY="0" orient="auto-start-reverse" overflow="visible">' + shapes[tip] + "</marker>";
}

/** The picture's SVG (in a span.tikz), or throws TikzError naming what the preview doesn't draw. `styles`: the
 * document's \tikzset text so far. */
export function renderTikz(src, opts, R) {
  if (utf8Len(src) > TIKZ_LIMITS.SRC_MAX) throw new TikzError("a picture over " + TIKZ_LIMITS.SRC_MAX / 1024 + " KiB of source");
  const P = new Picture(R, opts);
  let html;
  try {
    let st = P.base();
    if (opts?.styles) P.options(opts.styles, st);
    const toks = P.lex(src);
    let i = 0;
    if (toks[0]?.t === "o") { st = P.options(toks[0].v, st); i = 1; }
    P.run(toks, st, 0, i);
    html = P.svg();
  } catch (e) {
    // (anything else, a RangeError of a string or the stack among them: this picture's placeholder, not the document's end)
    if (e instanceof TikzError) throw e;
    throw new TikzError("a picture the preview couldn't draw (" + (e instanceof RangeError ? "too large" : "an internal error") + ")");
  }
  if (html === null) throw new TikzError("an empty picture");
  return html;
}
