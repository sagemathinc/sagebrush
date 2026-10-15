// A board as an SVG file without a browser (svg.ts, `sagebrush board render
// --svg`): every example board's pages render, the same bytes each time
// (their hashes below: a change meant to change the look updates them);
// no measured note's text overflows its box; and test-xss's hostile boards
// (markup, scripts, javascript: links and CSS in every text, color, size
// and id) give well-formed XML of only the expected elements and
// attributes, every value a number, a color or a path, the hostile text
// shown as text.
//   bun web/board/test-svg.mjs        (UPDATE=1: print the hashes)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanDoc, pageCount } from "./doc.ts";
import { boardSvg } from "./svg.ts";

const fails = [];
let checks = 0;
const check = (ok, what) => { checks++; if (!ok) fails.push(what); };
const here = new URL(".", import.meta.url).pathname;

// ---- XML: well formed, and only what the renderer writes --------------------
const ELEMENTS = new Set(["svg", "title", "defs", "clipPath", "rect", "g", "text", "tspan", "path", "polygon"]);
const NUM = /^-?(\d+(\.\d+)?|\.\d+)$/;
const COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i;
const ATTRS = {
  xmlns: (v) => v === "http://www.w3.org/2000/svg", width: NUM, height: NUM, x: NUM, y: NUM, rx: NUM, ry: NUM, "font-size": NUM,
  viewBox: /^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/, "font-family": /^[A-Za-z ,-]+$/, fill: COLOR, stroke: COLOR, "stroke-opacity": NUM, "fill-opacity": NUM, "stroke-width": NUM,
  "stroke-dasharray": /^[\d. ]+$/, d: /^[MLQAVHZ0-9 .,-]+$/, points: /^[0-9 .,-]+$/, id: /^c\d+$/, "clip-path": /^url\(#c\d+\)$/, "font-weight": /^(bold|600)$/,
  "font-style": /^italic$/, "text-anchor": /^middle$/, "dominant-baseline": /^middle$/, "xml:space": /^preserve$/,
};
function inspect(svg) {
  const bad = [], texts = [], stack = [];
  const s = svg.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, "");
  const entityOk = (t) => !/&(?!(amp|lt|gt|quot|apos);)/.test(t);
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[6]) { bad.push("a < that opens nothing at " + m.index); break; }
    if (m[5] !== undefined) {
      if (/^\s*$/.test(m[5]) && !stack.length) continue;
      if (!entityOk(m[5])) bad.push("a bare & in text");
      if (/[>]/.test(m[5])) bad.push("a > in text");
      texts.push(m[5].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
      continue;
    }
    const [, close, name, attrs, self] = m;
    if (!ELEMENTS.has(name)) bad.push("element " + name);
    if (close) { if (stack.pop() !== name) bad.push("unbalanced </" + name + ">"); continue; }
    for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      const rule = ATTRS[a[1]];
      if (!rule) bad.push(`attribute ${a[1]} on ${name}`);
      else if (!(typeof rule === "function" ? rule(a[2]) : rule.test(a[2]))) bad.push(`${a[1]}="${a[2].slice(0, 60)}" on ${name}`);
      if (!entityOk(a[2])) bad.push("a bare & in an attribute");
    }
    if (!self) stack.push(name);
  }
  if (stack.length) bad.push("unclosed " + stack.join(","));
  return { bad, texts };
}

// ---- the example boards: every page; the same each time; nothing overflows --
const HASHES = {
  "sagebrush-0": "d52b0abf831946d0", "live-0": "ad4092bfdcbd68b2", "primes-0": "a50e6755a7c6348b", "primes-1": "bed8b854ba59fee4", "primes-2": "3df9c7d962b85d2a", "polynomials-0": "ec66434ad33df5a0", "museum-tour-0": "999888d248719e81",
};
const got = {};
for (const f of ["sagebrush", "live", "primes", "polynomials", "museum-tour"]) {
  const d = JSON.parse(readFileSync(here + "examples/" + f + ".json", "utf8"));
  for (let p = 0; p < pageCount(cleanDoc(d)); p++) {
    const a = boardSvg(d, { page: p }), b = boardSvg(d, { page: p });
    const h = createHash("sha256").update(a.svg).digest("hex").slice(0, 16);
    got[`${f}-${p}`] = h;
    const { bad } = inspect(a.svg);
    check(a.svg === b.svg, `${f} page ${p}: the same bytes each time`);
    check(!bad.length, `${f} page ${p}: only what the renderer writes: ${bad.slice(0, 5).join("; ")}`);
    check(!a.overflow.length, `${f} page ${p}: no note's text overflows its box: ${a.overflow.join(", ")}`);
    if (HASHES[`${f}-${p}`] !== undefined && !process.env.UPDATE) check(HASHES[`${f}-${p}`] === h, `${f} page ${p}: the look as it was (hash ${h}; UPDATE=1 for all)`);
  }
}
if (process.env.UPDATE) console.log(JSON.stringify(got));

// ---- text that is hard to fit: long words, wide scripts, lists, code, tables -
{
  const long = "x".repeat(200), doc = { layout: "graph", nodes: [
    { id: "a", title: "A title that is long enough to wrap onto more than one line, surely", text: `${long}\n\n- one\n- two **bold** and *it*\n\n1. first\n2. second\n\n\`\`\`\ncode ${long}\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted $x^2 + y^2$` },
    { id: "b", text: "漢字とかなの文章がここに続きます。漢字とかなの文章がここに続きます。🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂", w: 160 },
    { id: "c", title: "fit", text: "A short one", fit: true, shape: "diamond" },
    { id: "d", code: "print('hello')\n" + "y = " + "1 + ".repeat(60) + "1", ref: "https://example.org/" + "deep/".repeat(30) },
  ], edges: [{ from: "a", to: "b", label: "wraps" }] };
  const r = boardSvg(doc);
  check(!r.overflow.length && !inspect(r.svg).bad.length, "long words, wide scripts, lists, code, tables, a link: nothing overflows, only what the renderer writes: " + JSON.stringify({ overflow: r.overflow, bad: inspect(r.svg).bad.slice(0, 3) }));
  check(r.left.includes("math (shown as its TeX)") && r.left.includes("code's outputs"), "what is shown only in part, said: " + r.left.join(", "));
  // (code keeps its indentation and its spaces)
  const code = boardSvg({ nodes: [{ id: "k", code: "def f(x):\n    if x:\n\treturn  x" }] }).svg;
  check(code.includes(">    if x:<") && code.includes(">    return  x<") && code.includes('xml:space="preserve"'), "code keeps its indentation, tabs as four spaces, and its spaces: " + (code.match(/<tspan[^>]*>[^<]*if x[^<]*</) ?? [""])[0]);
}

// ---- test-xss's hostile boards ------------------------------------------------
{
  const X = (k) => `<img src=x onerror="window.__xss.push('${k}')"><script>window.__xss.push('${k}s')</script><svg onload="window.__xss.push('${k}v')">`;
  const hostile = {
    title: X("title"), intro: X("intro") + " [l](javascript:window.__xss.push('introlink'))", refBase: "javascript:window.__xss.push('refbase')//",
    nodes: [
      { id: "a", title: X("a-title"), text: X("a-text") + " <a href='javascript:window.__xss.push(1)'>x</a> [l](javascript:alert(1)) ![i](javascript:alert(2))", detail: X("a-detail"), ref: "javascript:window.__xss.push('ref')", color: "red;background:url(javascript:window.__xss.push('css'))", shape: "rect\" onmouseover=\"window.__xss.push('shape')", x: "1\"><img src=x onerror=\"window.__xss.push('x')\">", y: 0 },
      { id: "g", kind: "group", title: X("g"), text: X("g-text"), color: "url(javascript:1)", x: "0\"/><image href=x onerror=\"window.__xss.push('gx')\"/><rect x=\"0", y: 300, children: [{ id: "b", text: "**fine** <span style=\"color:green\">green</span>", w: "300\"><img src=x onerror=\"window.__xss.push('w')\">" }] },
      { id: "c", kind: "code", code: "print('<img src=x onerror=1>')\ndisplay(HTML('<b>bold</b><script>window.__xss.push(\\'htmls\\')</script>'))" },
      { id: "\"><script>alert('id')</script>", title: "an id", text: "]]><!-- --><![CDATA[ x ]]> & &amp; &#0; \u0000\u0008 \ud800 lone" },
    ],
    edges: [{ from: "a", to: "b", label: X("edge") }, { from: "b", to: "c", label: "</text><script>window.__xss.push('svg')</script>" }],
    steps: [{ focus: "a", say: X("step") }],
  };
  const deck = { title: X("deck"), pages: [
    { title: X("page-title"), slide: { x: 0, y: 0, w: "1280\"><img src=x onerror=\"window.__xss.push('slide')\">", h: 720 }, background: { color: "red;background:url(javascript:window.__xss.push('bg'))" }, nodes: [{ id: "p", title: X("p") },
      { id: "s1", kind: "sticker", emoji: X("emoji"), x: 300, y: 0 }, { id: "s2", kind: "sticker", icon: X("icon"), x: 400, y: 0 },
      { id: "s3", kind: "sticker", emoji: "⭐", color: "red;background:url(javascript:window.__xss.push('sticker'))", x: 500, y: 0 },
      { id: "s4", kind: "sticker", icon: "star", color: "#0f0\"><img src=x onerror=\"window.__xss.push('scolor')\">", x: 600, y: 0 }] },
    { title: X("page-two"), nodes: [{ id: "q", title: "Q" }] },
  ] };
  for (const [name, doc, page] of [["hostile", hostile, 0], ["deck", deck, 0], ["deck page 2", deck, 1]]) {
    const { svg } = boardSvg(doc, { page }), { bad, texts } = inspect(svg);
    check(!bad.length, `${name}: well-formed, only the renderer's elements and attributes, every value a number, color or path: ${bad.slice(0, 6).join("; ")}`);
    // (in markup: the text's are escaped; attributes are inspect()'s, each allowed by name and value)
    check(!/<script|<foreignObject|<image|<a[\s>]|<!\[CDATA\[|<!--/i.test(svg), `${name}: no script, foreignObject, image, link, CDATA or comment: ` + (svg.match(/<script|<foreignObject|<image|<a[\s>]|<!\[CDATA\[|<!--/i) ?? [""])[0]);
    if (name === "hostile") {
      // (wrapped at spaces, and a word longer than a line at a character: compared without spaces)
      const all = texts.join("").replace(/\s+/g, "");
      const shown = ["onerror=\"window.__xss.push('a-title')\"><script>window.__xss.push('a-titles')</script><svg", "javascript:window.__xss.push('ref')", "</text><script>window.__xss.push('svg')</script>", "\"><script>alert('id')</script>"];
      check(shown.slice(0, 3).every((t) => all.includes(t.replace(/\s+/g, ""))), "the hostile title, link and edge label shown as text: " + shown.slice(0, 3).filter((t) => !all.includes(t)).join(" | "));
      check(!/[\u0000-\u0008]/.test(svg) && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(svg), "no character XML does not allow");
    }
  }
}

// SEC-270-1: an edge's label (the print view's writer) with a NUL and a lone surrogate: still XML
{
  const { svg } = boardSvg({ layout: "graph", nodes: [{ id: "a", title: "A" }, { id: "b", title: "B" }], edges: [{ from: "a", to: "b", label: "pre\u0000mid\ud800post" }] });
  const { bad, texts } = inspect(svg);
  check(!bad.length && !/[\u0000-\u0008]/.test(svg) && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(svg) && texts.join("").includes("premid\ufffdpost"), "an edge's label with a NUL and a lone surrogate: well-formed, the NUL dropped, the surrogate replaced: " + bad.join("; "));
}
// HARD-270-2: places and sizes at the edge of what a number is, sizes below zero: every number written finite, sizes positive; said
{
  const cases = [
    { nodes: [{ id: "a", text: "x", x: 1e308, y: 0, w: 1e308, h: 100 }] },
    { nodes: [{ id: "a", text: "x", x: -1.7e308, y: 1.7e308, w: 200 }, { id: "b", text: "y", x: 0, y: 0 }], edges: [{ from: "a", to: "b", label: "far" }] },
    { nodes: [{ id: "a", text: "x", x: 10, y: 10, w: -50, h: -10 }, { id: "s", kind: "sticker", emoji: "⭐", x: 1e300, y: -1e300, w: 1e300 }] },
  ];
  cases.forEach((doc, k) => {
    const r = boardSvg(doc), { bad } = inspect(r.svg);
    const dims = [...r.svg.matchAll(/\s(width|height)="([^"]*)"/g)].map((m) => Number(m[2]));
    check(!bad.length && !/Infinity|NaN|\de[+-]?\d/.test(r.svg) && dims.every((v) => Number.isFinite(v) && v > 0) && r.left.includes("places or sizes out of range (brought within it)"), `geometry case ${k}: every number finite, every size positive, and said: ` + JSON.stringify({ bad: bad.slice(0, 3), left: r.left, dims: dims.filter((v) => !(v > 0)).slice(0, 3) }));
  });
}
// CORR-270-3: a slide's card and the page's background: drawn (the picture said)
{
  const r = boardSvg({ slide: { x: 0, y: 0, w: 800, h: 450 }, background: { color: "#ff0000", image: "bg" }, images: { bg: { w: 640, h: 480 } }, nodes: [{ id: "a", x: 20, y: 20, w: 100, h: 80, text: "A" }] });
  const vb = /viewBox="([^"]*)"/.exec(r.svg)[1].split(" ").map(Number);
  check(r.svg.includes('fill="#ff0000"') && /<rect x="0" y="0" width="800" height="450" fill="#fff"/.test(r.svg) && vb[0] <= 0 && vb[1] <= 0 && vb[0] + vb[2] >= 800 && vb[1] + vb[3] >= 450 && r.left.includes("the page's background picture") && !inspect(r.svg).bad.length, "a slide's card and the page's background color, drawn, the whole slide shown, the picture said: " + JSON.stringify({ vb, left: r.left }));
  const plain = boardSvg({ background: { color: "#123456" }, nodes: [{ id: "a", x: 0, y: 0, text: "A" }] });
  check(/^<\?xml[^\n]*\n<svg[^>]*>(<title>[^<]*<\/title>)?<defs>.*?<\/defs><rect [^>]*fill="#123456"\/>/.test(plain.svg), "without a slide, the background's color behind the whole board");
}

// friction 10: a group's title one line, cut with "…" to its width (the
// layout keeps one line's band for it), not wrapped over its members
{
  const long = "Workbench, browser and tools, and a great deal more besides (8)";
  const r = boardSvg({ nodes: [{ id: "g", kind: "group", title: long, x: 0, y: 0, children: [{ id: "a", x: 0, y: 0, w: 200, title: "A" }] }] });
  const t = [...r.svg.matchAll(/<text[^>]*>([^<]*(?:<tspan[^>]*>[^<]*<\/tspan>[^<]*)*)<\/text>/g)].map((m) => m[1].replace(/<[^>]*>/g, "")).filter((x) => x.startsWith("Workbench"));
  check(t.length === 1 && t[0].endsWith("…") && long.startsWith(t[0].slice(0, -1)), "a long group title, one line cut with …: " + JSON.stringify(t));
  check(r.svg.includes(`<g><title>${long}</title>`), "...its whole title kept, as the group's <title> (UI-0CC-2)");
}

console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log("FAIL", f.slice(0, 600));
process.exit(fails.length ? 1 : 0);
