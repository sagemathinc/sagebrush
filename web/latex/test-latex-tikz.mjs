// ci: checks.3 order=107 runner=bun
// TikZ in the LaTeX preview (web/latex/engine/tikz.mjs: paths, styles, transforms, \foreach), without a
// browser: the picture's bounding box against TeX's own (pgf 3.1.11a, TeX Live 2025: each picture's `current bounding
// box` written by pdflatex, numbers recorded below, so a wrong formula here can't also be the expected answer); the
// geometry a box can't see (+ and ++, scope and style isolation); the output's safety (colours as rgb(), numbers ours,
// no raw option text); every bound, met by a hostile picture with a named problem and no partial picture; and the
// engine's use of it (drawn, or a placeholder naming what it doesn't draw, and check's problem).
//   bun web/latex/test-latex-tikz.mjs
import katex from "katex";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { renderTikz, TikzError, evalMath, colorRgb, TIKZ_LIMITS } from "./engine/tikz.mjs";
import { Engine } from "./engine/pipeline.mjs";
import { setKatex, tikzLabel, charWidthRenders } from "./engine/render.mjs";
setKatex(katex.renderToString, katex.__renderToHTMLTree);

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
// (a section that throws fails as a row of its own, named, rather than stopping the file: so a broken branch names its row)
const section = (name, fn) => { try { fn(); } catch (e) { check(name + " (crashed)", false, String(e?.stack ?? e).slice(0, 300)); } };
const R = () => ({ colors: {}, idn: 0 });
const label = (t, f) => tikzLabel(t, f);
const draw = (src, opts = { label }, r = R()) => renderTikz(src, opts, r);
const named = (src) => { try { draw(src); return null; } catch (e) { return e instanceof TikzError ? e.why : "NOT NAMED: " + e?.message; } };
// a hostile case in its own process (tikz-case.mjs), killed at a real deadline: {why, ms}, ms the child's own time
const CASE = new URL("./tikz-case.mjs", import.meta.url).pathname;
const guarded = (src, limits, label = false) => {
  const r = spawnSync(process.execPath, [CASE], { input: JSON.stringify({ src, limits, label }), timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1 << 20, encoding: "utf8" });
  if (r.error || r.signal) return { why: "KILLED at the deadline (" + (r.signal || r.error?.code) + ")", ms: 10000 };
  try { return JSON.parse(r.stdout); } catch { return { why: "NO RESULT: " + String(r.stderr).slice(-200), ms: 0 }; }
};
// (a string of exactly n UTF-8 bytes: ch as often as fits, then ASCII; measured by Buffer, not by the code under test)
const bytes = (s) => Buffer.byteLength(s, "utf8");
const fill = (n, ch) => { const k = Math.floor(n / bytes(ch)); return ch.repeat(k) + "a".repeat(n - k * bytes(ch)); };
const box = (h) => /data-box="([^"]+)"/.exec(h)[1].split(" ").map(Number);
// the path's points, canvas pt, y up (the SVG's d has them y down, from the box's top left)
const points = (h) => { const [x0, , , y1] = box(h); return [.../d="([^"]+)"/.exec(h)[1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1] + x0, y1 - +m[2]]); };
const CM = 72.27 / 2.54, near = (a, b, e = 0.02) => Math.abs(a - b) <= e;

// ---- the bounding box as TeX's: [name, source, TeX's x0 y0 x1 y1 in pt], within 0.05 pt (our numbers are to 0.01)
const TEX = [
  ["line", "\\draw (0,0) -- (2,1);", [-0.2, -0.2, 57.10548, 28.65274]],
  // (plot, Nov 27 2026: the bounding box as pgf's, its curves' control points in it; \x^2 at -1 is -1, as pgfmath
  //  reads -1^2; a stray ) as pgfmath reads it)
  ["plot-smooth-stray", "\\draw[smooth, samples=9, domain=-1.5:1.5] plot (\\x, {(\\x)^2)});", [-42.8791, -0.2, 42.8791, 64.21866]],
  ["plot-x-squared", "\\draw[domain=-1:1, samples=5] plot (\\x, \\x^2);", [-28.65274, -28.65274, 28.65274, 28.65274]],
  ["plot-coords-smooth", "\\draw[smooth] plot coordinates {(0,0) (1,1) (2,0) (3,1)};", [-0.2, -0.2, 85.55823, 28.65274]],
  ["plot-line-to", "\\draw (0,-1) -- plot[domain=0:1, samples=3] (\\x, {(\\x)^2});", [-0.2, -28.65274, 28.65274, 28.65274]],
  ["thickline", "\\draw[line width=4pt] (0,0) -- (2,0);", [-2.0, -2.0, 58.90549, 2.0]],
  ["arrow", "\\draw[->] (0,0) -- (2,0);", [-0.2, -2.59998, 57.10548, 2.59998]],
  ["stealth", "\\draw[-Stealth] (0,0) -- (2,0);", [-0.2, -1.79999, 57.10548, 1.79999]],
  ["circle", "\\draw (1,1) circle (1);", [-0.2, -0.2, 57.10548, 57.10548]],
  ["arc", "\\draw (1,0) arc (0:90:1);", [-0.2, -0.2, 28.65274, 28.65274]],
  ["arc2", "\\draw (1,0) arc (0:135:1);", [-20.31914, -0.2, 28.65274, 28.65274]],
  ["ellipse", "\\draw (0,0) ellipse (2 and 1);", [-57.10548, -28.65274, 57.10548, 28.65274]],
  ["scale-rotate", "\\draw[scale=2, rotate=30] (0,0) -- (1,0);", [-0.2, -0.2, 49.48172, 28.65274]],
  ["rotate-scale", "\\draw[rotate=30, scale=2] (0,0) -- (1,0);", [-0.2, -0.2, 49.48172, 28.65274]],
  ["shift-rotate", "\\draw[shift={(1,0)}, rotate=90] (1,0) -- (2,0);", [28.25275, 28.25275, 28.65274, 57.10548]],
  ["rotate-shift", "\\draw[rotate=90, shift={(1,0)}] (1,0) -- (2,0);", [-0.2, 56.70549, 0.2, 85.55823]],
  ["polar-xy", "\\draw[x=2cm,y=1cm] (0,0) -- (90:1);", [-0.2, -0.2, 0.2, 28.65274]],
  ["polar-xy30", "\\draw[x=2cm,y=1cm] (0,0) -- (30:1) -- (150:1);", [-49.48174, -0.2, 49.48174, 14.42636]],
  ["polar-units", "\\draw[x=2cm,y=1cm] (0,0) -- (90:1cm) -- (0:1cm);", [-0.2, -0.2, 28.65274, 28.65274]],
  ["round-half", "\\draw (0,0) -- (1,{round(-2.5)}) -- ({round(2.5)},0);", [-0.2, -85.55823, 85.55823, 0.2]],
  ["arc-offquarter", "\\draw[thick] (3,0) arc (-30:200:1);", [30.70416, -0.4, 93.61511, 47.1241]],
  ["arc-options", "\\draw (0,-2) arc [start angle=180, end angle=360, radius=1];", [-0.2, -85.55823, 57.10548, -56.70549]],
  ["scale-xshift", "\\draw[scale=2, xshift=1cm] (1,0) -- (1,1);", [113.61098, -0.2, 114.01097, 57.10548]],
  ["xshift-scale", "\\draw[xshift=1cm, scale=2] (1,0) -- (1,1);", [85.15823, -0.2, 85.55823, 57.10548]],
  ["xscale-yshift", "\\draw[xscale=3, yshift=1cm] (1,0) -- (2,1);", [85.15823, 28.25275, 170.91646, 57.10548]],
  ["yshift-yscale", "\\draw[yshift=1cm, yscale=3] (1,0) -- (2,1);", [28.25275, 28.25275, 57.10548, 114.01097]],
  ["xscale", "\\draw[xscale=2] (0,0) circle (1);", [-57.10548, -28.65274, 57.10548, 28.65274]],
  ["relplus", "\\draw (1,1) -- +(1,0) -- +(0,1);", [28.25275, 28.25275, 57.10548, 57.10548]],
  ["relplusplus", "\\draw (1,1) -- ++(1,0) -- ++(0,1);", [28.25275, 28.25275, 57.10548, 57.10548]],
  ["to", "\\draw (0,0) to[out=90,in=180] (2,1);", [-0.2, -0.2, 57.10548, 28.65274]],
  ["bend", "\\draw (0,0) to[bend left] (2,0);", [-0.2, -0.2, 57.10548, 11.2957]],
  ["controls", "\\draw (0,0) .. controls (1,2) and (2,2) .. (3,0);", [-0.2, -0.2, 85.55823, 57.10548]],
  ["grid", "\\draw[step=0.5] (0.2,0.2) grid (1.7,1.3);", [5.49046, 5.49046, 48.56956, 37.18864]],
  ["polar", "\\draw (0,0) -- (30:2);", [-0.2, -0.2, 49.48172, 28.65274]],
  ["units", "\\draw (0,0) -- (1cm,20pt);", [-0.2, -0.2, 28.65274, 20.2]],
  ["xunit", "\\draw[x=2cm] (0,0) -- (1,1);", [-0.2, -0.2, 57.1055, 28.65274]],
  ["foreach", "\\foreach \\x in {0,0.5,...,2} \\draw (\\x,0) -- (\\x,\\x);", [-0.2, -0.2, 57.10548, 57.10548]],
  ["rect", "\\draw (1,1) rectangle (3,2);", [28.25275, 28.25275, 85.55823, 57.10548]],
  ["cycle", "\\draw (0,0) -- (1,0) -- (1,1) -- cycle;", [-0.2, -0.2, 28.65274, 28.65274]],
  ["hv", "\\draw (0,0) |- (2,1) -| (3,0);", [-0.2, -0.2, 85.55823, 28.65274]],
  ["latex", "\\draw[-Latex] (0,0) -- (2,0);", [-0.2, -1.79999, 57.10548, 1.79999]],
  ["bar", "\\draw[|-|] (0,0) -- (2,0);", [-0.2, -2.29999, 57.10548, 2.29999]],
  ["dbl", "\\draw[->>] (0,0) -- (2,0);", [-0.2, -2.59998, 57.10548, 2.59998]],
  ["toThick", "\\draw[->, ultra thick] (0,0) -- (2,0);", [-0.8, -5.36774, 57.70549, 5.36774]],
  ["stealthThick", "\\draw[-Stealth, ultra thick] (0,0) -- (2,0);", [-0.8, -3.825, 57.70549, 3.825]],
  ["both", "\\draw[<->] (0,0) -- (2,0);", [-0.2, -2.59998, 57.10548, 2.59998]],
  ["diag", "\\draw[->] (0,0) -- (2,2);", [-0.2, -0.2, 57.27318, 57.27318]],
  ["fillnoline", "\\fill (0,0) rectangle (1,1);", [0.0, 0.0, 28.45274, 28.45274]],
  ["gridcorner", "\\draw[step=1] (0.2,0.2) grid (0.8,0.8);", [5.49046, 5.49046, 28.65274, 28.65274]],
];
section("tex-boxes", () => {
  const bad = [];
  for (const [name, src, t] of TEX) {
    let b; try { b = box(draw(src)); } catch (e) { bad.push([name, String(e.message)]); continue; }
    const d = Math.max(...b.map((v, q) => Math.abs(v - t[q])));
    if (!(d <= 0.05)) bad.push([name, b, t, +d.toFixed(3)]);
  }
  check("tex-bounding-boxes", bad.length === 0 && TEX.length === 49, bad);
  // (the transform order TeX applies: the last option first. shift then rotate is not rotate then shift)
  const tb = (n) => TEX.find((r) => r[0] === n)[2];
  check("transform-order-pinned", tb("shift-rotate")[1] > 28 && tb("rotate-shift")[1] > 56 && tb("scale-xshift")[0] > 113 && tb("xshift-scale")[0] < 86, null);
});

// ---- geometry the box doesn't show
{
  // + doesn't move the reference point, ++ does: (1,1) -- +(1,0) -- +(0,1) ends at (1,2); with ++ at (2,2)
  section("relative-plus", () => {
    const p1 = points(draw("\\draw (1,1) -- +(1,0) -- +(0,1);")), p2 = points(draw("\\draw (1,1) -- ++(1,0) -- ++(0,1);"));
    check("relative-plus", near(p1[2][0], CM) && near(p1[2][1], 2 * CM), p1);
    check("relative-plusplus", near(p2[2][0], 2 * CM) && near(p2[2][1], 2 * CM), p2);
  });
  // a scope's transform and styles stay in it; the path after it is as if it weren't there
  section("scope-isolation", () => {
    const sc = draw("\\begin{scope}[shift={(5,5)}, my/.style={red}] \\draw[my] (0,0) -- (1,0); \\end{scope} \\draw (0,0) -- (1,0);");
    const paths = [...sc.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)"/g)];
    check("scope-isolation", paths.length === 2 && paths[0][2] === "rgb(255,0,0)" && paths[1][2] === "rgb(0,0,0)" && named("\\begin{scope}[my/.style={red}] \\end{scope} \\draw[my] (0,0) -- (1,0);") === "an option the preview doesn't draw: my", paths.map((p) => p[2]));
  });
  // a named point used in another scope: where it was put on the canvas, whatever this scope's transform
  section("named-point-canvas", () => {
    const nm = points(draw("\\coordinate (A) at (1,0); \\begin{scope}[rotate=90, scale=3] \\draw (0,0) -- (A); \\end{scope}"));
    check("named-point-canvas", near(nm[1][0], CM) && near(nm[1][1], 0), nm);
  });
  // \foreach: lists, ranges with a step, pairs, nesting
  section("foreach-pairs-ranges-nesting", () => {
    const fe = draw("\\foreach \\x/\\y in {0/1, 2/3} \\draw (\\x,0) -- (\\x,\\y); \\foreach \\a in {0,0.5,...,1} \\foreach \\b in {0,1} \\draw (\\a,\\b) -- +(0.1,0);");
    const fp = points(draw("\\foreach \\x/\\y in {2/3} \\draw (\\x,0) -- (\\x,\\y);"));
    const fg = draw("\\foreach \\x in {0,2} \\foreach \\y in {0,2} { \\draw (\\x,\\y) -- +(1,0); \\draw (\\x,\\y) -- +(0,1); }");
    check("foreach-pairs-ranges-nesting", (fg.match(/<path /g) || []).length === 8 && (fe.match(/<path /g) || []).length === 2 + 3 * 2 && near(fp.at(-1)[0], 2 * CM) && near(fp.at(-1)[1], 3 * CM), [(fe.match(/<path /g) || []).length, fp]);
  });
  // x= and y= as vectors: (1,1) is x + y
  section("xy-vectors", () => {
    const xv = points(draw("\\draw[x={(1cm,0.5cm)}, y={(0cm,2cm)}] (0,0) -- (1,1);"));
    check("xy-vectors", near(xv[1][0], CM) && near(xv[1][1], 2.5 * CM), xv);
  });
  // a style, then appended to: both apply (red, and thick's 0.8 pt)
  section("append-style", () => {
    const ap = draw("\\draw[my/.style={red}, my/.append style={thick}, my] (0,0) -- (1,0);");
    check("append-style", /stroke="rgb\(255,0,0\)"/.test(ap) && /stroke-width="0.8"/.test(ap), ap.slice(0, 300));
  });
  // polar, calc's midpoint, units and x=
  section("polar-calc-units", () => {
    const pc = points(draw("\\coordinate (A) at (0,0); \\coordinate (B) at (2,2); \\draw (30:2) -- ($(A)!0.5!(B)$) -- (1cm,10pt);"));
    check("polar-calc-units", near(pc[0][0], 2 * CM * Math.cos(Math.PI / 6)) && near(pc[1][0], CM) && near(pc[1][1], CM) && near(pc[2][1], 10), pc);
  });
  // pgfmath: degrees, precedence, unary minus, functions
  section("pgfmath", () => {
    check("pgfmath", near(evalMath("2+3*4^2").v, 50) && near(evalMath("sin(30)").v, 0.5, 1e-9) && near(evalMath("-2^2").v, -4) && evalMath("round(-2.5)").v === -3 && evalMath("round(2.5)").v === 3 && near(evalMath("max(1,sqrt(16))").v, 4) && evalMath("2cm").units && near(evalMath("2cm").v, 2 * CM), null);
  });
  // colours: xcolor's names and mixes, the document's \definecolor, as rgb() only
  section("colours", () => {
    check("colours", colorRgb("blue!50") === "rgb(128,128,255)" && colorRgb("red!30!green") === "rgb(77,179,0)" && colorRgb("mine", { mine: "rgb(1,2,3)" }) === "rgb(1,2,3)" && colorRgb("nope") === null, null);
  });
}

// ---- output safety: every value is ours (numbers we formatted, colours as rgb(), fixed words)
section("safety", () => {
  const all = [
    "\\draw[->, red!20, line width=2pt, dashed, opacity=0.5] (0,0) to[bend left] (3,1);",
    "\\filldraw[fill=blue!10, draw=black, rounded corners] (0,0) rectangle (2,1);",
    "\\draw[-Stealth, thick] (0,0) .. controls (1,1) and (2,1) .. (3,0); \\draw[|-|] (0,-1) -- (3,-1);",
  ].map((s) => draw(s)).join("");
  const attrs = [...all.matchAll(/ (fill|stroke)="([^"]*)"/g)].map((m) => m[2]);
  check("safety-colours-rgb-only", attrs.length > 0 && attrs.every((v) => /^(none|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/.test(v)), [...new Set(attrs)]);
  check("safety-numbers", !/NaN|Infinity|undefined/.test(all) && [...all.matchAll(/ d="([^"]*)"/g)].every((m) => /^[MLCZ0-9., -]*$/.test(m[1])), null);
  check("safety-no-raw-option-text", named('\\draw[draw=red" onload="alert(1)] (0,0) -- (1,0);') !== null && named("\\draw[fill=url(#x)] (0,0) -- (1,0);") !== null && named("\\draw[line cap=<script>] (0,0) -- (1,0);") !== null, null);
});

// ---- bounds and malformed input: each a named problem (TikzError), never a partial picture, NaN, or unbounded work
// ---- nodes: their boxes as TeX's (pdflatex, pgf 3.1.11a, TeX Live 2025, as the paths'), their anchors and placement,
// their text, and what they don't do
const lastPoints = (h) => { const [x0, , , y1] = box(h), ds = [...h.matchAll(/ d="([^"]+)"/g)]; return [...ds[ds.length - 1][1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1] + x0, y1 - +m[2]]); };
const centre = (h, n) => new RegExp('data-name="' + n + '" data-c="([^"]+)"').exec(h)[1].split(" ").map(Number);
section("nodes", () => {
  // [name, source, TeX's x0 y0 x1 y1]: the text's box is KaTeX's metrics (its fonts are Computer Modern-based);
  // TeX kerns some letters and sets inline math with its own spacing, which KaTeX's widths don't: those four within 0.15
  const NODE_TEX = [
  ["n-empty", "\\node at (0,0) {};", [-3.33298, -3.33298, 3.33298, 3.33298]],
  ["n-x", "\\node at (0,0) {$x$};", [-6.19061, -5.48575, 6.19061, 5.48575]],
  ["n-A", "\\node at (0,0) {A};", [-7.08298, -6.74963, 7.08298, 6.74963]],
  ["n-drawA", "\\node[draw] at (0,0) {A};", [-7.28297, -6.94963, 7.28297, 6.94963]],
  ["n-circ", "\\node[draw,circle] at (0,0) {A};", [-9.94853, -9.94853, 9.94853, 9.94853]],
  ["n-isep0", "\\node[draw,inner sep=0pt] at (0,0) {A};", [-3.95, -3.61665, 3.95, 3.61665]],
  ["n-minw", "\\node[draw,minimum width=2cm] at (0,0) {A};", [-28.65274, -6.94963, 28.65274, 6.94963]],
  ["n-west", "\\node[anchor=west] at (1,0) {Ab};", [28.65274, -6.80519, 48.37427, 6.80519]],
  ["n-above", "\\draw (0,0) -- (2,0) node[above] {A};", [-0.2, -0.2, 63.98846, 13.69926]],
  ["n-mid", "\\draw (0,0) -- (2,0) node[midway,below] {$y$};", [-0.2, -13.11592, 57.10548, 0.2]],
  ["n-scale2", "\\node[scale=2] at (0,0) {A};", [-14.16595, -13.49927, 14.16595, 13.49927]],
  ["n-small", "\\node[font=\\small] at (0,0) {A};", [-6.801, -6.40796, 6.801, 6.40796]],
  ["n-unscaled", "\\draw[scale=3] (0,0) node[draw] {A} -- (1,0);", [-7.28297, -6.94963, 85.55823, 6.94963]],
  ["n-math", "\\node[draw] at (0,0) {$x^2+y^2=1$};", [-28.78522, -8.57521, 28.78522, 8.57521]],
  ["n-edge", "\\node[draw] (A) at (0,0) {A}; \\node[draw,circle] (B) at (3,1) {B}; \\draw[->] (A) -- (B);", [-7.28297, -6.94963, 95.17517, 38.26968]],
  ["n-text", "\\node at (0,0) {Hello world};", [-28.34691, -6.80519, 28.34691, 6.80519]],
  ["n-label", "\\node[draw,label=above:$x$] at (0,0) {A};", [-7.28297, -6.94963, 7.28297, 18.12112]],
  ["n-of", "\\node[draw] (A) at (0,0) {A}; \\node[draw,right=of A] (B) {B};", [-7.28297, -6.94963, 49.88501, 6.94963]],
  ["n-rightof", "\\node[draw] (A) at (0,0) {A}; \\node[draw,right of=A] (B) {B};", [-7.28297, -6.94963, 35.52739, 6.94963]],
  ["s-scalepos", "\\node[scale=2] at (1,0) {};", [21.78679, -6.66595, 35.1187, 6.66595]],
  ["s-xshift", "\\node[xshift=1cm] at (1,0) {};", [53.57251, -3.33298, 60.23846, 3.33298]],
  ["s-diag", "\\node[draw] (A) at (0,0) {A}; \\node[draw,above right=of A] (B) {B};", [-7.28297, -6.94963, 49.88501, 49.30164]],
  ["s-lines", "\\node[draw,align=center] at (0,0) {A\\\\Ab};", [-10.06076, -12.94963, 10.06076, 12.94963]],
  ["s-ellipse", "\\node[draw,ellipse] at (0,0) {A};", [-10.21684, -9.74542, 10.21684, 9.74542]],
  ["s-scopescale", "\\begin{scope}[scale=2] \\node[draw] at (1,0) {A}; \\end{scope}", [49.62251, -6.94963, 64.18846, 6.94963]],
  ["s-pathcolor", "\\draw[red] (0,0) -- (1,0) node[right] {A};", [-0.2, -6.74963, 42.8187, 6.74963]],
  ["s-pos", "\\draw (0,0) -- (2,2) node[pos=0.25,left] {A};", [-0.2, -0.2, 57.10548, 57.10548]],
  ["s-curve", "\\draw (0,0) .. controls (0,2) and (2,2) .. (2,0) node[midway,above] {A};", [-0.2, -0.2, 57.10548, 57.10548]],
  ["s-tobend", "\\node[draw,circle] (A) at (0,0) {A}; \\node[draw,circle] (B) at (3,0) {B}; \\draw (A) to[bend left] (B);", [-9.94853, -9.94853, 95.17517, 18.45808]],
  ["s-hello", "\\node[draw] at (0,0) {Hello, world!};", [-31.32469, -7.97742, 31.32469, 7.97742]],
  ["s-bf", "\\node[font=\\bfseries] at (0,0) {Ab};", [-10.8746, -6.80519, 10.8746, 6.80519]],
  ["m-x1", "\\node[inner sep=0pt] at (0,0) {$x_1$};", [-5.1007, -2.90276, 5.1007, 2.90276]],
  ["m-frac", "\\node[inner sep=0pt] at (0,0) {$\\frac{a}{b}$};", [-3.36882, -5.1998, 3.36882, 5.1998]],
  ["m-sqrt", "\\node[inner sep=0pt] at (0,0) {$\\sqrt{x}$};", [-7.0243, -5.19998, 7.0243, 5.19998]],
  ["q-bl", "\\node[below left] at (0,0) {$A$};", [-14.36595, -13.69926, -0.2, -0.2]],
  ["q-br", "\\node[below right] at (0,0) {$B$};", [0.2, -13.69926, 14.95274, -0.2]],
  ["q-C", "\\node at (0,0) {$C$};", [-7.26422, -6.74963, 7.26422, 6.74963]],
  ["q-v1", "\\node at (0,0) {$v_1$};", [-7.99965, -6.23573, 7.99965, 6.23573]],
  ["q-lab", "\\node[draw, circle, label=right:$v_3$] (c) at (0,0) {};", [-4.91386, -6.23573, 21.11316, 6.23573]],
  ["q-mid", "\\node (A) at (0,0) {$A$}; \\node (B) at (2,0) {$B$}; \\draw[->] (A) -- node[above] {$f$} (B);", [-7.08298, -6.74963, 64.28186, 15.75484]],
  ["q-midsz", "\\node[draw] (A) at (0,0) {Long text}; \\node[draw] (B) at (4,0) {$B$}; \\draw (A) -- node[above] {$f$} (B);", [-24.85246, -7.92184, 121.38734, 15.75484]],
  ];
  const LOOSE = new Set(["n-math", "n-text", "s-hello", "q-lab"]);
  const bad = [];
  for (const [name, src, t] of NODE_TEX) {
    let b; try { b = box(draw(src)); } catch (e) { bad.push([name, e.why ?? e.message]); continue; }
    const dd = Math.max(...b.map((v, q) => Math.abs(v - t[q])));
    if (!(dd <= (LOOSE.has(name) ? 0.15 : 0.05))) bad.push([name, b, t, +dd.toFixed(3)]);
  }
  check("node-tex-boxes", bad.length === 0 && NODE_TEX.length === 41, bad);
  // anchors as TeX puts them (pdflatex's \pgfpointanchor): a line from one to another, its ends read back
  const two = "\\node[draw] (A) at (0,0) {A}; \\node[draw,circle] (B) at (3,1) {B};";
  const ends = [["A.north", "A.east", [0, 6.94963], [7.28297, 0]], ["A.base", "B.north", [0, -3.41666], [85.35823, 38.26968]], ["B.north east", "B.west", [92.29985, 35.39436], [75.54129, 28.45274]]]
    .map(([a, b, pa, pb]) => { const lp = lastPoints(draw(two + "\\draw (" + a + ") -- (" + b + ");")); return [a, b, lp, near(lp[0][0], pa[0], 0.05) && near(lp[0][1], pa[1], 0.05) && near(lp[1][0], pb[0], 0.05) && near(lp[1][1], pb[1], 0.05)]; });
  check("node-anchors-as-tex", ends.every((e) => e[3]), ends.filter((e) => !e[3]));
  // placed as TeX places them: right=of A (positioning), right of=A (the old form), above right=of A
  const pl = [["\\node[draw] (A) at (0,0) {A}; \\node[draw,right=of A] (B) {B};", [42.81036, 0]], ["\\node[draw] (A) at (0,0) {A}; \\node[draw,right of=A] (B) {B};", [28.45274, 0]],
    ["\\node[draw] (A) at (0,0) {A}; \\node[draw,above right=of A] (B) {B};", [42.81036, 42.352]]].map(([src, c]) => [src, centre(draw(src), "B"), c]);
  check("node-positions-as-tex", pl.every(([, got, c]) => near(got[0], c[0], 0.05) && near(got[1], c[1], 0.05)), pl);
  // a node inside an operation, -- node (f) {...} (B): midway along the segment as cut at the nodes' borders (from TeX's
  // q-midsz box: A's east anchor at 24.85 pt, B's west at 106.23)
  const mid = centre(draw("\\node[draw] (A) at (0,0) {Long text}; \\node[draw] (B) at (4,0) {$B$}; \\draw (A) -- node[above] (f) {$f$} (B);"), "f");
  check("node-inside-an-operation", near(mid[0], (24.85246 + 106.2347) / 2, 0.15), mid);
  // nodes aren't scaled with their picture (TikZ's default): a scope's scale moves a node, its own scale= sizes it
  const us = draw("\\begin{scope}[scale=2] \\node[draw] (A) at (1,0) {A}; \\end{scope} \\node[scale=2] (B) at (0,2) {B};");
  const ub = (n) => new RegExp('data-name="' + n + '" data-c="[^"]+" data-box="([^"]+)"').exec(us)[1].split(" ").map(Number);
  check("nodes-unscaled-by-default", near(centre(us, "A")[0], 2 * CM) && near(ub("A")[2] - ub("A")[0], 2 * 7.08298, 0.05) && near(ub("B")[2] - ub("B")[0], 2 * 2 * (3.54167 + 3.333), 0.1), [centre(us, "A"), ub("A"), ub("B")]);
  // a line between nodes stops at their borders (outer sep included), toward the other's centre; data-edges names it
  const he = draw(two + "\\draw (A) -- (B);"), le = lastPoints(he), bc = [3 * CM, CM], u = Math.hypot(bc[0], bc[1]);
  check("edges-stop-at-borders", near(le[0][0], 7.28297, 0.05) && near(le[0][1], 7.28297 / 3, 0.05) && near(Math.hypot(le[1][0] - bc[0], le[1][1] - bc[1]), 9.817, 0.05) && near(le[1][0], bc[0] - (9.817 * bc[0]) / u, 0.05)
    && /data-name="A"[^>]*data-edges="2"/.test(he) && /data-name="B"[^>]*data-edges="2"/.test(he), [le, he.match(/data-edges="[^"]*"/g)]);
  // its text: a line where TeX's text box is, at the node's size, in its text colour as rgb(); KaTeX's line-height 0
  const ht = draw("\\node[text=red, font=\\small] at (0,0) {A};"), st = /<span style="position:absolute;left:([\d.]+)pt;top:([\d.]+)pt;width:([\d.]+)pt;[^"]*"><span class="katex" style="line-height:0;font-size:([\d.]+)pt">/.exec(ht);
  check("node-text-placed", /color:rgb\(255,0,0\)/.test(ht) && st && near(+st[1], 3.333, 0.02) && near(+st[2], 3.333, 0.02) && near(+st[3], 7.5 * 0.9 * 1.028, 0.02) && near(+st[4], 9, 0.02), st);
  // styles on every node, labels, and a node's text KaTeX can't typeset, named
  // a node's extent within the canvas's bounds, not only its centre; node text typeset within its total, each distinct
  // character's width once; labels of labels refused by construction (KaTeX's text in the child, under the deadline)
  const ext = ["\\node[minimum width=1e300pt] {A};", "\\node[minimum height=1e300pt] {A};", "\\node[scale=1e290] {A};", "\\node[inner sep=1e300pt] {A};"].map((src) => guarded(src, undefined, true));
  check("node-extent-bounded", ext.every((g) => /^a point farther than/.test(g.why ?? "") && g.ms <= 1500), ext);
  const nt = guarded("\\foreach \\i in {1,...,1999} {\\node at (0,\\i/100) {" + "word ".repeat(330) + "};}", undefined, true);
  // (20,000 distinct characters, in 30 nodes of 2,500 each, each typeset once for its width however often it is used)
  const cjkOf = (g) => Array.from({ length: 2500 }, (_, k) => String.fromCodePoint(0x4e00 + g * 2500 + k)).join("");
  const cj = guarded(Array.from({ length: 30 }, (_, k) => "\\node at (0," + k + ") {" + cjkOf(k % 8) + "};").join(" "), undefined, true);
  const lab = guarded("[every node/.style={label=x}] \\node {A};", undefined, true);
  // the node count exactly at its bound (drawn) and one past (named)
  const nn = (n) => guarded("\\foreach \\i in {1,...," + n + "} \\node at (0,0) {};");
  const n2 = [nn(TIKZ_LIMITS.NODES), nn(TIKZ_LIMITS.NODES + 1)];
  check("node-count-exact", n2[0].why === null && /^more than 2000 nodes in a picture$/.test(n2[1].why ?? ""), n2);
  // node text's HTML, UTF-8 bytes, metered before it is kept: exactly at the total and one byte past (the total lowered for
  // the row, the HTML a stub of 3-byte or 4-byte characters); a picture whose labels would make far more stops at the total,
  // the most HTML ever kept never past it; one line of text over 8 KiB refused before it is typeset
  const lh = [];
  for (const ch of ["中", "𝑥"]) for (const n of [3, 4]) {
    const g = guarded(Array.from({ length: n }, () => "\\node at (0,0) {x};").join(" "), { LABEL_HTML: 3000 }, { stub: fill(1000, ch) });
    lh.push([ch, n, g, n === 3 ? g.why === null : /^node text past/.test(g.why ?? "") && g.labelPeak <= 3000]);
  }
  const many = guarded("\\foreach \\i in {1,...,1999} \\node {$\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6}$};", undefined, true);
  const longLine = guarded("\\node {" + "word ".repeat(1700) + "};", undefined, true);
  check("label-html-bounded", lh.every((x) => x[3]) && /^node text past 1 MiB of HTML in a picture$/.test(many.why ?? "") && many.labelPeak <= TIKZ_LIMITS.LABEL_HTML && many.ms <= 1500
    && /^a line of a node's text over 8 KiB$/.test(longLine.why ?? "") && longLine.ms <= 1500, [lh.map((x) => [x[0], x[1], x[2].why, x[2].labelPeak]), many, longLine]);
  // each distinct character typeset once for its width, however often used: 6,000 new ones, three times each
  const fresh = Array.from({ length: 6000 }, (_, k) => String.fromCodePoint(0x6000 + k)).join(""), r0 = charWidthRenders.n;
  for (let k = 0; k < 3; k++) draw(Array.from({ length: 3 }, (_, q) => "\\node at (0," + q + ") {" + fresh.slice(q * 2000, q * 2000 + 2000) + "};").join(" "));
  check("char-widths-once", charWidthRenders.n - r0 === 6000, charWidthRenders.n - r0);
  // the picture's own size, UTF-8 bytes (node text a stub of 3-byte characters, so bytes aren't characters): exactly at
  // the cap drawn, a byte under it refused
  const stub = { stub: "中".repeat(2000) }, ss = "\\node at (0,0) {x}; \\node at (1,0) {y};";
  const B = bytes(draw(ss, { label: () => ({ html: stub.stub, w: 5, h: 5, d: 0 }) }));
  const sb = [guarded(ss, { SVG_BYTES: B }, stub), guarded(ss, { SVG_BYTES: B - 1 }, stub)];
  check("svg-cap-bytes-exact", sb[0].why === null && /^a picture over/.test(sb[1].why ?? ""), [B, sb]);
  check("node-text-bounded", /^node text past 256 KiB in a picture$/.test(nt.why ?? "") && nt.ms <= 1500 && cj.why === null && cj.ms <= 1500 && /^labels of labels/.test(lab.why ?? "") && lab.ms <= 1500, [nt, cj, lab]);
  // (the layout tree KaTeX exports privately, which the sizes are read from: here, and as the LaTeX build's math module exports it)
  check("katex-layout-tree-exported", typeof katex.__renderToHTMLTree === "function" && /export \{[^}]*__renderToHTMLTree[^}]*\} from "katex"/.test(readFileSync(new URL("./math-dev.ts", import.meta.url), "utf8")), null);
  check("every-node-style", near(box(draw("[every node/.style={draw}] \\node at (0,0) {A};"))[2], 7.28297, 0.02) && named("\\node {$\\notacommand x$};") === "a node's text KaTeX can't typeset: $\\notacommand x$", named("\\node {$\\notacommand x$};"));
});

section("bounds", () => {
  const t0 = Date.now();
  const cases = {
    "a style naming itself": "[a/.style={a}] \\draw[a] (0,0) -- (1,0);",
    "two styles naming each other": "[a/.style={b}, b/.style={a}] \\draw[a] (0,0) -- (1,0);",
    "\\foreach nested past its depth": "\\foreach \\a in {1} \\foreach \\b in {1} \\foreach \\c in {1} \\foreach \\d in {1} \\foreach \\e in {1} \\draw (0,0) -- (1,0);",
    "\\foreach bodies past their total": "\\foreach \\a in {1,...,101} \\foreach \\b in {1,...,101} \\draw (\\a,\\b) -- +(1,0);",
    "a \\foreach range past its total": "\\foreach \\a in {1,...,100000} \\draw (0,0) -- (1,0);",
    "\\foreach chained past its depth": Array.from({ length: 8000 }, (_, k) => "\\foreach \\v" + k.toString(26).replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 26))) + " in {1} ").join("") + "\\draw (0,0) -- (1,0);",
    "scopes nested past their depth": "\\begin{scope}".repeat(9000) + "\\draw (0,0) -- (1,0);" + "\\end{scope}".repeat(9000),
    "styles fanning out": "[a/.style={red}" + "bcdefgh".split("").map((c, k) => ", " + c + "/.style={" + Array(10).fill("abcdefg"[k]).join(",") + "}").join("") + "] \\draw[h] (0,0) -- (1,1);",
    "a \\foreach body grown past the source's size": "\\foreach \\x in {" + Array(5000).fill(111).join(",") + "} {" + "\\x".repeat(100000) + "}",
    // (a value naming a later variable: each replacement checked on the text as it is then, three reviewers' probes)
    "a later variable in a value (1)": "\\foreach \\x/\\y in {" + "\\y".repeat(1000) + "/" + "1".repeat(1000) + "} {" + "\\x".repeat(100) + "}",
    "a later variable in a value (2)": "\\foreach \\a/\\b in {" + "\\b".repeat(300) + "/" + "red ".repeat(300).trim() + "} {\\draw[\\a](0,0)--(1,1);}",
    "a later variable in a value (3)": "\\foreach \\a/\\b in {\\b/" + "Z".repeat(100) + "} {" + "\\a ".repeat(10000) + "}",
    "picture text read past its total": "\\foreach \\x in {1,...,9999} {%" + "c".repeat(200000) + "\n}",
    "a range that never ends": "\\foreach \\a in {1,0,...,5} \\draw (0,0) -- (1,0);",
    "a grid past its lines": "\\draw[step=0.001] (0,0) grid (10,10);",
    "a grid step of 0": "\\draw[step=0] (0,0) grid (1,1);",
    "a point too far": "\\draw (0,0) -- (1000000,0);",
    "an expression too long": "\\draw (0,0) -- ({" + "1+".repeat(300) + "1},0);",
    "an expression too deep": "\\draw (0,0) -- ({" + "(".repeat(60) + "1" + ")".repeat(60) + "},0);",
    "division by 0": "\\draw (0,0) -- ({1/0},0);",
    "sqrt of a negative": "\\draw (0,0) -- ({sqrt(-1)},0);",
    "tan(90)": "\\draw (0,0) -- ({tan(90)},0);",
    "ln(0)": "\\draw (0,0) -- ({ln(0)},0);",
    "overflow": "\\draw (0,0) -- ({10^400},0);",
    "a scale of 0 then a named point": "\\coordinate (A) at (1,1); \\draw[scale=0] (0,0) -- (A);",
    "a command without its ;": "\\draw (0,0) -- (1,0)",
    "an unbalanced (": "\\draw (0,0 -- (1,0);",
    "an unknown command": "\\frobnicate (0,0);",
    "an unknown option": "\\draw[wiggly] (0,0) -- (1,0);",
    "a node's text width": "\\node[text width=2cm] {};",
    "too many nodes": "\\foreach \\i in {1,...,2001} \\node at (0,0) {};",
    "an anchor unknown": "\\node (A) {}; \\draw (A.top) -- (1,0);",
    "a node not defined": "\\node[right=of Z] {};",
    "a font unknown": "\\node[font=\\Tiny] {};",
    "a turned node": "\\node[rotate=30] {};",
    "a node turned with its picture": "\\begin{scope}[rotate=30, transform shape] \\node {}; \\end{scope}",
    "\\clip": "\\clip (0,0) rectangle (1,1);",
    "an axis inside": "\\begin{axis} \\end{axis}",
    "a picture past its source size": "\\draw (0,0) -- (1,0);" + " ".repeat(TIKZ_LIMITS.SRC_MAX),
    "an empty picture": "",
  };
  // (each by its own name: a bound turned off must not pass because another one, or a later check, catches the case)
  const why = {
    "a style naming itself": /^styles naming styles more than 8 deep/, "two styles naming each other": /^styles naming styles more than 8 deep/,
    "\\foreach nested past its depth": /^\\foreach inside \\foreach more than 4 deep$/, "\\foreach chained past its depth": /^\\foreach inside \\foreach more than 4 deep$/, "\\foreach bodies past their total": /^\\foreach bodies expanded more than 10000 times$/,
    "a \\foreach range past its total": /^a \\foreach range of more than 10000 items$/, "a range that never ends": /^a \\foreach range that never ends$/,
    "scopes nested past their depth": /^scopes inside scopes more than 32 deep$/, "styles fanning out": /^options and styles past 1000000 bytes applied in all/,
    "a later variable in a value (1)": /^a \\foreach body over 256 KiB once its variables are replaced$/, "a later variable in a value (2)": /^a \\foreach body over 256 KiB once its variables are replaced$/,
    "a later variable in a value (3)": /^a \\foreach body over 256 KiB once its variables are replaced$/,
    "a \\foreach body grown past the source's size": /^a \\foreach body over 256 KiB once its variables are replaced$/, "picture text read past its total": /^more than 4 MiB of picture text read/,
    "a grid past its lines": /^a grid of more than 2000 lines$/, "a grid step of 0": /^a grid with a step of 0$/, "a point too far": /^a point farther than/,
    "an expression too long": /^an expression over 400 characters$/, "an expression too deep": /^an expression nested over 40 deep$/, "division by 0": /^division by 0$/,
    "sqrt of a negative": /^sqrt of a negative number/, "tan(90)": /^tan\(90\) is infinite$/, "ln(0)": /^ln of 0$/, "overflow": /^a value too large/,
    "a scale of 0 then a named point": /flattens the picture/, "a command without its ;": /without its ;$/, "an unbalanced (": /^an unbalanced \(/,
    "an unknown command": /^\\frobnicate isn't drawn/, "an unknown option": /: wiggly$/, "a node's text width": /^a node's text width isn't drawn by the preview yet$/,
    "too many nodes": /^more than 2000 nodes in a picture$/, "an anchor unknown": /^an anchor the preview doesn't know: top$/, "a node not defined": /^a node not defined before it is used: \(Z\)$/,
    "a font unknown": /^a font the preview doesn't set: \\Tiny$/, "a turned node": /^a turned or stretched node isn't drawn by the preview yet$/, "a node turned with its picture": /\(transform shape\)/,
    "\\clip": /^\\clip isn't drawn/, "an axis inside": /^the axis environment inside a picture/, "a picture past its source size": /^a picture over 256 KiB/, "an empty picture": /^an empty picture$/,
  };
  // (each in its own process, killed at 10 s; each must also finish its own work within 1.5 s)
  const slow = [];
  const unnamed = Object.entries(cases).map(([k, s]) => { const g = guarded(s); if (g.ms > 1500) slow.push([k, g.ms]); return [k, g.why]; }).filter(([k, w]) => w === null || !why[k]?.test(w));
  check("bounds-each-quick", slow.length === 0, slow);
  // the byte caps, in UTF-8, each exactly at its limit and one byte past, with a 3-byte (BMP) and a 4-byte (astral) character
  const byteRows = [];
  for (const ch of ["中", "𝑥"]) {
    // the source
    const pre = "\\draw (0,0) -- (1,0); %", srcOf = (n) => pre + fill(n - bytes(pre), ch);
    byteRows.push(["source " + ch, guarded(srcOf(TIKZ_LIMITS.SRC_MAX)), guarded(srcOf(TIKZ_LIMITS.SRC_MAX + 1)), /^a picture over 256 KiB of source$/]);
    // one expansion: its body with \x four times, each replaced by a 48,000-byte value
    const V = fill(48000, ch), head = "%" + "\\x".repeat(4), tail = "\n\\draw (0,0) -- (1,0);";
    const expOf = (n) => "\\foreach \\x in {" + V + "} {" + head + fill(n - 4 * (bytes(V) - 2) - bytes(head + tail), ch) + tail + "}";
    byteRows.push(["expansion " + ch, guarded(expOf(TIKZ_LIMITS.SRC_MAX)), guarded(expOf(TIKZ_LIMITS.SRC_MAX + 1)), /^a \\foreach body over 256 KiB once its variables are replaced$/]);
    // all text read: the source, then 20 expansions of a 99,000-byte body, each scanned for \x and then read
    const B = "%" + fill(99000 - 2, ch) + "\n", loop = "\\foreach \\x in {1,...,20} {" + B + "}";
    const allOf = (n) => { const left = n - 20 * 2 * bytes(B), p = "\\draw (0,0) -- (1,0); %"; return p + fill(left - bytes(p) - 1 - bytes(loop), ch) + "\n" + loop; };
    byteRows.push(["all text " + ch, guarded(allOf(TIKZ_LIMITS.LEX_TEXT)), guarded(allOf(TIKZ_LIMITS.LEX_TEXT + 1)), /^more than 4 MiB of picture text read/]);
  }
  // the total read is checked before each scan and before each replacement is made, not only when the expansion is read:
  // the most text read or about to be made at any point (the child's trace) never passes it. Many variables scanning a
  // large body (one variable named 1,000 times; another 25,000 times over a body of failed matches), and a body each
  // expansion makes again, near the total
  const scanned = [
    guarded("\\foreach " + Array(1000).fill("\\q").join("/") + " in {" + Array(1000).fill("1").join("/") + "} {%" + "x".repeat(150000) + "\n\\draw (0,0) -- (1,1);}"),
    guarded("\\foreach " + Array(25000).fill("\\a").join("/") + " in {" + Array(25000).fill("1").join("/") + "} {%" + "\\aa".repeat(43000) + "\n}"),
    guarded("\\draw (0,0) -- (1,0); \\foreach \\x in {1,...,30} {%" + "\\x".repeat(50000) + "\n}"),
  ];
  check("text-read-stops-at-total", scanned.every((g) => /^more than 4 MiB of picture text read/.test(g.why ?? "") && g.peak <= TIKZ_LIMITS.LEX_TEXT && g.ms <= 1500), scanned);
  check("byte-caps-exact", byteRows.every(([, at, past, re]) => at.why === null && re.test(past.why ?? "") && at.ms <= 1500 && past.ms <= 1500), byteRows.map(([k, a, b]) => [k, a, b]));
  // float loops that count their steps: a range at 2^53, where x + 1 is x, and an arc at 1e20 degrees, both drawn
  const fl = [guarded("\\foreach \\x in {9007199254740992,...,9007199254740994} {\\draw (0,0) -- (1,0);}"), guarded("\\draw (0,0) arc[start angle=1e20, delta angle=20000, radius=1];")];
  // an arc's angles brought near 0 first: one starting at 360 * 2^45 degrees is the one starting at 0
  const far = box(draw("\\draw (0,0) arc[start angle=12666373951979520, delta angle=90, radius=1];")), near0 = box(draw("\\draw (0,0) arc[start angle=0, delta angle=90, radius=1];"));
  check("arc-far-angles", far.every((v, q) => Math.abs(v - near0[q]) <= 0.05), [far, near0]);
  // the scope depth exactly (32 scopes drawn) and one past it (33, named), at once
  const nest = (n) => "\\begin{scope}".repeat(n) + "\\draw (0,0) -- (1,0);" + "\\end{scope}".repeat(n);
  const sd = [guarded(nest(TIKZ_LIMITS.SCOPE_DEPTH)), guarded(nest(TIKZ_LIMITS.SCOPE_DEPTH + 1))];
  check("scope-depth-exact", sd[0].why === null && /^scopes inside scopes more than 32 deep$/.test(sd[1].why) && sd.every((g) => g.ms <= 1500), sd);
  // the SVG's own cap, which the others keep a real picture under: met with the cap lowered for this row
  const sv = [guarded("\\foreach \\x in {1,...,10} \\draw (0,0) -- (\\x,1);", { SVG_BYTES: 2000 }), guarded("\\foreach \\x in {1,...,200} \\draw (0,0) -- (\\x,1);", { SVG_BYTES: 2000 })];
  check("svg-cap", sv[0].why === null && /^a picture over .* MiB of rendered output$/.test(sv[1].why), sv);
  check("float-loops-end", fl.every((g) => g.why === null && g.ms <= 1500), fl);
  // an item's $ is text, not a replacement pattern ($& would be the variable itself)
  check("foreach-item-literal", named("\\foreach \\c in {$&} {\\draw[\\c] (0,0) -- (1,0);}") === "an option the preview doesn't draw: $&", named("\\foreach \\c in {$&} {\\draw[\\c] (0,0) -- (1,0);}"));
  // any other error in a picture (here the renderer's colours throwing) is the picture's named problem
  let other; try { renderTikz("\\draw[mine] (0,0) -- (1,0);", {}, { get colors() { throw new RangeError("x"); }, idn: 0 }); } catch (e) { other = e; }
  check("other-errors-named", other instanceof TikzError && /couldn't draw \(too large\)/.test(other.why), String(other));
  check("bounds-and-malformed-named", unnamed.length === 0, unnamed);
  check("bounds-quick", Date.now() - t0 < 60000, Date.now() - t0);
  const segs = guarded("\\foreach \\a in {1,...,1000} \\foreach \\b in {1,...,9} \\draw (0,0) -- (1,0) -- (2,0) -- (3,0);");
  check("bound-segments", /path segments|expanded more than/.test(segs.why ?? "") && segs.ms <= 1500, segs);
});

// ---- in the engine: drawn, styles from \tikzset, a placeholder naming what it doesn't draw, check's problem; marker ids
section("engine", () => {
  const doc = (b, pre = "") => "\\documentclass{article}\n\\usepackage{tikz}\n" + pre + "\\begin{document}\n" + b + "\n\\end{document}\n";
  const r1 = new Engine().update(doc("\\begin{tikzpicture}[scale=2]\n\\draw[mine] (0,0) circle (1);\n\\end{tikzpicture}", "\\tikzset{mine/.style={blue, thick}}\n"));
  const h1 = r1.chunks.join("");
  check("engine-drawn-with-tikzset", /class="tikz"/.test(h1) && /stroke="rgb\(0,0,255\)"/.test(h1) && !(r1.problems || []).some((p) => /tikz/.test(p.name)), r1.problems);
  const r2 = new Engine().update(doc("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1) node[right, text width=2cm] {x};\n\\end{tikzpicture}"));
  const h2 = r2.chunks.join("");
  check("engine-placeholder-named", !/class="tikz"/.test(h2) && /\[tikzpicture: a node(?:'|&#39;)s text width isn(?:'|&#39;)t drawn by the preview yet\]/.test(h2) && (r2.problems || []).some((p) => p.kind === "not-rendered" && /text width/.test(p.name)), r2.problems);
  // a node through the engine: its text typeset by KaTeX (the renderer's own label), its data on the page
  const r5 = new Engine().update(doc("\\begin{tikzpicture}\\node[draw] (A) {$x^2$}; \\draw[->] (A) -- (2,0);\\end{tikzpicture}"));
  const h5 = r5.chunks.join("");
  check("engine-node-drawn", /class="tikz-n" data-name="A" data-c="[^"]+" data-box="[^"]+" data-edges="1"/.test(h5) && /class="katex" style="line-height:0;font-size:10pt"/.test(h5) && !(r5.problems || []).length, [h5.slice(0, 300), r5.problems]);
  // through the engine: an environment inside a picture is named (pgfplots' axis), and calc's $...$ reaches tikz.mjs
  const r3 = new Engine().update(doc("\\begin{tikzpicture}\\begin{axis}\\addplot {x^2};\\end{axis}\\end{tikzpicture}\n\n\\begin{tikzpicture}\\coordinate (A) at (0,0); \\coordinate (B) at (2,2); \\draw (A) -- ($(A)!0.5!(B)$);\\end{tikzpicture}"));
  const h3 = r3.chunks.join("");
  check("engine-environments-and-calc", /\[tikzpicture: the axis environment inside a picture/.test(h3) && (h3.match(/class="tikz"/g) || []).length === 1, [h3.match(/\[tikzpicture: [^\]]*\]/g), r3.problems]);
  // the document's \\tikzset, at most TIKZ_LIMITS.TIKZSET characters kept: past it, check's problem and the style not kept
  const ts = [];
  for (const ch of ["中", "𝑥"]) for (const n of [TIKZ_LIMITS.TIKZSET, TIKZ_LIMITS.TIKZSET + 1]) {
    const t = "pad/.style={" + fill(n - bytes("pad/.style={}"), ch) + "}";
    const r4 = new Engine().update(doc("\\tikzset{" + t + "}\n\\begin{tikzpicture}\\draw (0,0) -- (1,0);\\end{tikzpicture}"));
    ts.push([ch, n, (r4.problems || []).some((p) => p.kind === "not-rendered" && p.name === "\\tikzset past 64 KiB")]);
  }
  check("tikzset-cap", ts.every(([, n, refused]) => refused === (n > TIKZ_LIMITS.TIKZSET)), ts);
  // two pictures with arrows: each marker id once, every reference to one that exists; after an edit, still so
  const e = new Engine(), pic = "\\begin{tikzpicture}\\draw[->] (0,0) -- (1,0); \\draw[-Stealth, red] (0,1) -- (1,1);\\end{tikzpicture}\n";
  const ids = (h) => { const defs = [...h.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]), refs = [...h.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]); return { defs, refs, ok: defs.length === new Set(defs).size && refs.every((r) => defs.includes(r)) && defs.length >= 4 }; };
  const a = ids(e.update(doc(pic + pic)).chunks.join("")), b = ids(e.update(doc(pic + "Text.\n" + pic + pic)).chunks.join(""));
  check("marker-ids-unique-after-edits", a.ok && b.ok && b.defs.length >= 6, { a, b });
});

// ---- plot (Nov 27 2026): pgfmath's stray ) (TeX Live 2025's pgfmath: (2)^2) is 4.0, 1+2)*3 is 9.0, 2*3)+4 is 10.0),
//      pgf's curveto handler (pgflibraryplothandlers.code.tex: support points at 0.2775 x tension (0.5) of the neighbours'
//      difference; the first and last support points the ends themselves), the variable's samples, and what isn't drawn
section("plot", () => {
  check("plot-pgfmath-stray-paren", evalMath("(2)^2)").v === 4 && evalMath("1+2)*3").v === 9 && evalMath("2*3)+4").v === 10 && evalMath("(1+2))*3").v === 9 && evalMath("2)-4").v === -2, null);
  // (three points, smooth: M p0 C p0 (p1 - d) p1 C (p1 + d) p2 p2, d = 0.13875 (p2 - p0); in cm, y up)
  const pts = points(draw("\\draw[smooth] plot coordinates {(0,0) (1,1) (2,0)};")).map(([x, y]) => [x / CM, y / CM]);
  const T = 0.2775 * 0.5, want = [[0, 0], [0, 0], [1 - 2 * T, 1], [1, 1], [1 + 2 * T, 1], [2, 0], [2, 0]];
  check("plot-smooth-as-pgf", pts.length === 7 && pts.every((p, k) => near(p[0], want[k][0], 0.001) && near(p[1], want[k][1], 0.001)), pts);
  // (samples: 5 over -1:1 is -1, -0.5, 0, 0.5, 1; a sharp plot's points; samples at a list)
  const sp = points(draw("\\draw[domain=-1:1, samples=5] plot (\\x, {2*\\x});")).map(([x, y]) => [x / CM, y / CM]);
  check("plot-samples", sp.length === 5 && sp.every((p, k) => near(p[0], -1 + k / 2, 0.001) && near(p[1], 2 * (-1 + k / 2), 0.001)), sp);
  const sa = points(draw("\\draw[samples at={0,1,3}] plot (\\x, 0);")).map(([x]) => x / CM);
  check("plot-samples-at", sa.length === 3 && near(sa[0], 0, 0.001) && near(sa[1], 1, 0.001) && near(sa[2], 3, 0.001), sa);
  // (-- plot: a line to its first point; plot alone: a move)
  const dOf = (src) => /d="([^"]+)"/.exec(draw(src))[1];
  const lt = dOf("\\draw (0,-1) -- plot[domain=0:1, samples=2] (\\x, 0);"), mv = dOf("\\draw (0,-1) plot[domain=0:1, samples=2] (\\x, 0);");
  check("plot-line-to-and-move", (lt.match(/M/g) || []).length === 1 && (lt.match(/L/g) || []).length === 2 && (mv.match(/M/g) || []).length === 2 && (mv.match(/L/g) || []).length === 1, [lt, mv]);
  // (what the preview doesn't draw, named; a plot past the picture's segments bound, named)
  check("plot-file-function-named", /plot file/.test(named("\\draw plot file {data.txt};")) && /plot function/.test(named("\\draw plot function {x**2};")), [named("\\draw plot file {data.txt};"), named("\\draw plot function {x**2};")]);
  check("plot-bounded", /20000|segments|items/i.test(named("\\draw[samples=30000, domain=0:1] plot (\\x, \\x);") ?? ""), named("\\draw[samples=30000, domain=0:1] plot (\\x, \\x);"));
});

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: TikZ in the LaTeX preview, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
