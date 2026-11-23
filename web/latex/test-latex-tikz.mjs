// ci: checks.3 order=107 runner=bun
// TikZ in the LaTeX preview (web/latex/engine/tikz.mjs: paths, styles, transforms, \foreach), without a
// browser: the picture's bounding box against TeX's own (pgf 3.1.11a, TeX Live 2025: each picture's `current bounding
// box` written by pdflatex, numbers recorded below, so a wrong formula here can't also be the expected answer); the
// geometry a box can't see (+ and ++, scope and style isolation); the output's safety (colours as rgb(), numbers ours,
// no raw option text); every bound, met by a hostile picture with a named problem and no partial picture; and the
// engine's use of it (drawn, or a placeholder naming what it doesn't draw, and check's problem).
//   bun web/latex/test-latex-tikz.mjs
import katex from "katex";
import { renderTikz, TikzError, evalMath, colorRgb, TIKZ_LIMITS } from "./engine/tikz.mjs";
import { Engine } from "./engine/pipeline.mjs";
import { setKatex } from "./engine/render.mjs";
setKatex(katex.renderToString);

const results = [];
const check = (name, ok, detail) => { results.push([name, !!ok]); if (!ok) console.log("FAIL", name, JSON.stringify(detail)?.slice(0, 600)); };
// (a section that throws fails as a row of its own, named, rather than stopping the file: so a broken branch names its row)
const section = (name, fn) => { try { fn(); } catch (e) { check(name + " (crashed)", false, String(e?.stack ?? e).slice(0, 300)); } };
const R = () => ({ colors: {}, idn: 0 });
const draw = (src, opts = {}, r = R()) => renderTikz(src, opts, r);
const named = (src) => { try { draw(src); return null; } catch (e) { return e instanceof TikzError ? e.why : "NOT NAMED: " + e?.message; } };
const box = (h) => /data-box="([^"]+)"/.exec(h)[1].split(" ").map(Number);
// the path's points, canvas pt, y up (the SVG's d has them y down, from the box's top left)
const points = (h) => { const [x0, , , y1] = box(h); return [.../d="([^"]+)"/.exec(h)[1].matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1] + x0, y1 - +m[2]]); };
const CM = 72.27 / 2.54, near = (a, b, e = 0.02) => Math.abs(a - b) <= e;

// ---- the bounding box as TeX's: [name, source, TeX's x0 y0 x1 y1 in pt], within 0.05 pt (our numbers are to 0.01)
const TEX = [
  ["line", "\\draw (0,0) -- (2,1);", [-0.2, -0.2, 57.10548, 28.65274]],
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
  check("tex-bounding-boxes", bad.length === 0 && TEX.length === 45, bad);
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
    "a \\foreach body grown past the source's size": "\\foreach \\x in {" + Array(5000).fill(1).join(",") + "} {" + "\\x".repeat(100000) + "}",
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
    "a node": "\\node at (0,0) {A};",
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
    "scopes nested past their depth": /^scopes inside scopes more than 32 deep$/, "styles fanning out": /^options and styles past 1000000 characters applied in all/,
    "a \\foreach body grown past the source's size": /^a \\foreach body over 256 KiB once its variables are replaced$/, "picture text read past its total": /^more than 4 MiB of picture text read/,
    "a grid past its lines": /^a grid of more than 2000 lines$/, "a grid step of 0": /^a grid with a step of 0$/, "a point too far": /^a point farther than/,
    "an expression too long": /^an expression over 400 characters$/, "an expression too deep": /^an expression nested over 40 deep$/, "division by 0": /^division by 0$/,
    "sqrt of a negative": /^sqrt of a negative number/, "tan(90)": /^tan\(90\) is infinite$/, "ln(0)": /^ln of 0$/, "overflow": /^a value too large/,
    "a scale of 0 then a named point": /flattens the picture/, "a command without its ;": /without its ;$/, "an unbalanced (": /^an unbalanced \(/,
    "an unknown command": /^\\frobnicate isn't drawn/, "an unknown option": /: wiggly$/, "a node": /^\\node: nodes aren't drawn by the preview yet$/,
    "\\clip": /^\\clip isn't drawn/, "an axis inside": /^the axis environment inside a picture/, "a picture past its source size": /^a picture over 256 KiB/, "an empty picture": /^an empty picture$/,
  };
  const slow = [];
  const unnamed = Object.entries(cases).map(([k, s]) => { const t = Date.now(), w = named(s); if (Date.now() - t > 1500) slow.push([k, Date.now() - t]); return [k, w]; }).filter(([k, w]) => w === null || !why[k]?.test(w));
  check("bounds-each-quick", slow.length === 0, slow);
  // float loops that count their steps: a range at 2^53, where x + 1 is x, and an arc at 1e20 degrees, both drawn
  const t1 = Date.now(), fl = [named("\\foreach \\x in {9007199254740992,...,9007199254740994} {\\draw (0,0) -- (1,0);}"), named("\\draw (0,0) arc[start angle=1e20, delta angle=20000, radius=1];")];
  // an arc's angles brought near 0 first: one starting at 360 * 2^45 degrees is the one starting at 0
  const far = box(draw("\\draw (0,0) arc[start angle=12666373951979520, delta angle=90, radius=1];")), near0 = box(draw("\\draw (0,0) arc[start angle=0, delta angle=90, radius=1];"));
  check("arc-far-angles", far.every((v, q) => Math.abs(v - near0[q]) <= 0.05), [far, near0]);
  // the scope depth exactly (32 scopes drawn) and one past it (33, named), at once
  const nest = (n) => "\\begin{scope}".repeat(n) + "\\draw (0,0) -- (1,0);" + "\\end{scope}".repeat(n);
  const t2 = Date.now(), sd = [named(nest(TIKZ_LIMITS.SCOPE_DEPTH)), named(nest(TIKZ_LIMITS.SCOPE_DEPTH + 1))];
  check("scope-depth-exact", sd[0] === null && /^scopes inside scopes more than 32 deep$/.test(sd[1]) && Date.now() - t2 < 1500, sd);
  // the SVG's own cap, which the others keep a real picture under: met with the cap lowered for this row
  const svgCap = TIKZ_LIMITS.SVG_BYTES;
  let sv; try { TIKZ_LIMITS.SVG_BYTES = 2000; sv = [named("\\foreach \\x in {1,...,10} \\draw (0,0) -- (\\x,1);"), named("\\foreach \\x in {1,...,200} \\draw (0,0) -- (\\x,1);")]; } finally { TIKZ_LIMITS.SVG_BYTES = svgCap; }
  check("svg-cap", sv[0] === null && /^a picture over .* MiB of SVG$/.test(sv[1]), sv);
  check("float-loops-end", fl.every((w) => w === null) && Date.now() - t1 < 1500, [fl, Date.now() - t1]);
  // an item's $ is text, not a replacement pattern ($& would be the variable itself)
  check("foreach-item-literal", named("\\foreach \\c in {$&} {\\draw[\\c] (0,0) -- (1,0);}") === "an option the preview doesn't draw: $&", named("\\foreach \\c in {$&} {\\draw[\\c] (0,0) -- (1,0);}"));
  // any other error in a picture (here the renderer's colours throwing) is the picture's named problem
  let other; try { renderTikz("\\draw[mine] (0,0) -- (1,0);", {}, { get colors() { throw new RangeError("x"); }, idn: 0 }); } catch (e) { other = e; }
  check("other-errors-named", other instanceof TikzError && /couldn't draw \(too large\)/.test(other.why), String(other));
  check("bounds-and-malformed-named", unnamed.length === 0, unnamed);
  check("bounds-quick", Date.now() - t0 < 5000, Date.now() - t0);
  const segs = named("\\foreach \\a in {1,...,1000} \\foreach \\b in {1,...,9} \\draw (0,0) -- (1,0) -- (2,0) -- (3,0);");
  check("bound-segments", /path segments|expanded more than/.test(segs ?? ""), segs);
});

// ---- in the engine: drawn, styles from \tikzset, a placeholder naming what it doesn't draw, check's problem; marker ids
section("engine", () => {
  const doc = (b, pre = "") => "\\documentclass{article}\n\\usepackage{tikz}\n" + pre + "\\begin{document}\n" + b + "\n\\end{document}\n";
  const r1 = new Engine().update(doc("\\begin{tikzpicture}[scale=2]\n\\draw[mine] (0,0) circle (1);\n\\end{tikzpicture}", "\\tikzset{mine/.style={blue, thick}}\n"));
  const h1 = r1.chunks.join("");
  check("engine-drawn-with-tikzset", /class="tikz"/.test(h1) && /stroke="rgb\(0,0,255\)"/.test(h1) && !(r1.problems || []).some((p) => /tikz/.test(p.name)), r1.problems);
  const r2 = new Engine().update(doc("\\begin{tikzpicture}\n\\draw (0,0) -- (1,1) node[right] {x};\n\\end{tikzpicture}"));
  const h2 = r2.chunks.join("");
  check("engine-placeholder-named", !/class="tikz"/.test(h2) && /\[tikzpicture: a node on a path: nodes aren(?:'|&#39;)t drawn by the preview yet\]/.test(h2) && (r2.problems || []).some((p) => p.kind === "not-rendered" && /node/.test(p.name)), r2.problems);
  // through the engine: an environment inside a picture is named (pgfplots' axis), and calc's $...$ reaches tikz.mjs
  const r3 = new Engine().update(doc("\\begin{tikzpicture}\\begin{axis}\\addplot {x^2};\\end{axis}\\end{tikzpicture}\n\n\\begin{tikzpicture}\\coordinate (A) at (0,0); \\coordinate (B) at (2,2); \\draw (A) -- ($(A)!0.5!(B)$);\\end{tikzpicture}"));
  const h3 = r3.chunks.join("");
  check("engine-environments-and-calc", /\[tikzpicture: the axis environment inside a picture/.test(h3) && (h3.match(/class="tikz"/g) || []).length === 1, [h3.match(/\[tikzpicture: [^\]]*\]/g), r3.problems]);
  // the document's \\tikzset, at most TIKZ_LIMITS.TIKZSET characters kept: past it, check's problem and the style not kept
  const big = "\\tikzset{pad/.style={" + "thin,".repeat(TIKZ_LIMITS.TIKZSET / 5) + "thin}}\n\\tikzset{mine/.style={red}}\n";
  const r4 = new Engine().update(doc(big + "\\begin{tikzpicture}\\draw[mine] (0,0) -- (1,0);\\end{tikzpicture}"));
  check("tikzset-cap", (r4.problems || []).some((p) => p.kind === "not-rendered" && /^\\tikzset past 65536 characters$/.test(p.name)), r4.problems);
  // two pictures with arrows: each marker id once, every reference to one that exists; after an edit, still so
  const e = new Engine(), pic = "\\begin{tikzpicture}\\draw[->] (0,0) -- (1,0); \\draw[-Stealth, red] (0,1) -- (1,1);\\end{tikzpicture}\n";
  const ids = (h) => { const defs = [...h.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]), refs = [...h.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]); return { defs, refs, ok: defs.length === new Set(defs).size && refs.every((r) => defs.includes(r)) && defs.length >= 4 }; };
  const a = ids(e.update(doc(pic + pic)).chunks.join("")), b = ids(e.update(doc(pic + "Text.\n" + pic + pic)).chunks.join(""));
  check("marker-ids-unique-after-edits", a.ok && b.ok && b.defs.length >= 6, { a, b });
});

const failed = results.filter(([, ok]) => !ok).map(([n]) => n);
console.log(failed.length ? `FAIL: ${failed.length} of ${results.length}: ${failed.join(", ")}` : `ok: TikZ in the LaTeX preview, ${results.length} checks`);
process.exit(failed.length ? 1 : 0);
