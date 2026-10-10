// HTML for the atlas's pages, from the data model alone: the site's Worker
// renders stored spaces with it, and the browser renders the spaces it
// computes with the same functions.  No client JavaScript is needed to read
// a page; atlas.js adds recomputation, computing on demand and WebMCP.
import katex from "katex";
import { BOUND, type Orbit, type Space, derive, factorInt, fmtBytes, fmtSeconds, primesUpTo, quadraticField, sturmBound, spaceLabel } from "./model.ts";
import { apCost, normalizedAp, satoTateSvg } from "./plot.ts";

export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const M = "−"; // minus sign, in text
export const LMFDB = "https://www.lmfdb.org";
export const lmfdbForm = (label: string) => `${LMFDB}/ModularForm/GL2/Q/holomorphic/${label.split(".").join("/")}/`;
export const href = (label: string) => `/atlas/mf/${label}`;

// ---- math: TeX rendered by KaTeX (in the Worker for stored pages, so the
// page needs no script for it; memoized, since labels repeat)
const memo = new Map<string, string>();
/** Inline math from TeX. */
export function m(tex: string): string {
  let h = memo.get(tex);
  if (h === undefined) {
    h = katex.renderToString(tex, { throwOnError: false, output: "htmlAndMathml" });
    if (memo.size > 20000) memo.clear();
    memo.set(tex, h);
  }
  return h;
}
const sgn = (n: number) => m(n > 0 ? "+1" : "-1");
const bigTex = (s: string) => s; // decimal strings are TeX as they are

/** TeX for c[0] + c[1] x + ..., highest degree first. */
export function polyTex(c: string[], v = "x"): string {
  let s = "";
  for (let i = c.length - 1; i >= 0; i--) {
    const a = c[i];
    if (a === "0") continue;
    const neg = a.startsWith("-"), abs = neg ? a.slice(1) : a;
    const mono = i === 0 ? "" : i === 1 ? v : `${v}^{${i}}`;
    const coef = abs === "1" && i > 0 ? "" : abs;
    s += s === "" ? (neg ? "-" : "") + coef + mono : ` ${neg ? "-" : "+"} ` + coef + mono;
  }
  return s || "0";
}

/** TeX for sum a_n q^n + O(q^prec) from a_1, a_2, ... */
export function qexpTex(a: string[], prec: number): string {
  let s = "";
  for (let n = 1; n < prec && n <= a.length; n++) {
    const x = a[n - 1];
    if (x === "0") continue;
    const neg = x.startsWith("-"), abs = neg ? x.slice(1) : x;
    const t = (abs === "1" ? "" : abs) + (n === 1 ? "q" : `q^{${n}}`);
    s += s === "" ? (neg ? "-" : "") + t : ` ${neg ? "-" : "+"} ` + t;
  }
  return (s ? s + " + " : "") + `O(q^{${prec}})`;
}
export const polyHtml = (c: string[]) => m(polyTex(c));
export const qexpHtml = (a: string[], prec: number) => m(qexpTex(a, prec));

const factorTex = (n: number) => (n === 1 ? "1" : factorInt(n).map(([p, e]) => (e > 1 ? `${p}^{${e}}` : String(p))).join(" \\cdot "));
const levelHtml = (n: number) => (n === 1 ? "1" : factorInt(n).length === 1 && factorInt(n)[0][1] === 1 ? `${n} (prime)` : m(`${n} = ${factorTex(n)}`));
const SnewTex = (k: number, n: number | string, kind = "new") => `S_{${k}}^{\\mathrm{${kind}}}(\\Gamma_0(${n}))`;
const Snew = (k: number, n: number | string) => m(SnewTex(k, n));
const Ttex = (T: [number, number][]) => "T = " + T.map(([q, c], i) => `${i ? " + " : ""}${c === 1 ? "" : c}T_{${q}}`).join("");
const fieldTex = (D: bigint | number) => `\\mathbb{Q}(\\sqrt{${D}})`;
const QQ = () => m("\\mathbb{Q}");

/** The coefficient field: Q, Q(sqrt D), or its degree. */
export function fieldHtml(f: Orbit, long = false): string {
  if (f.dim === 1) return QQ();
  const D = f.dim === 2 ? quadraticField(f.charpoly) : null;
  if (D !== null) return m(fieldTex(D));
  return long ? `a number field of degree ${f.dim}` : `degree ${f.dim}`;
}

/** A link that opens the notebook at sagebrush.space with these Sage-mode cells. */
export function notebookLink(cells: (string | { md: string })[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cells));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return "/#m=sage&c=" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------------------------------------------ the page

export interface PageOpts {
  title: string;
  description: string;
  path: string; // canonical path
  crumbs: [string, string?][];
  body: string;
  json?: string; // the page's data as JSON
  noindex?: boolean;
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f2421;--muted:#5d645f;--line:#d4d4cb;--cell:#fff;--accent:#4a6b49;--accent2:#8aa37b;--on-accent:#fff;--err:#b3261e;--ok:#2e7d32;--code:#f3f2ec;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#161917;--fg:#e4e6e1;--muted:#a3aba4;--line:#39403a;--cell:#1d211e;--accent:#9cc28f;--accent2:#6f8f63;--on-accent:#10140f;--err:#ff8a80;--ok:#8fd3a6;--code:#222723;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}a:hover{text-decoration-thickness:2px}
.top{border-bottom:1px solid var(--line);background:var(--cell)}
.top .in{max-width:1060px;margin:0 auto;padding:10px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.brand{font-weight:650;font-size:18px;text-decoration:none;color:var(--fg)}.brand span{color:var(--accent)}
.top nav{display:flex;gap:14px;flex:1;flex-wrap:wrap}.top nav a{text-decoration:none;color:var(--muted)}.top nav a:hover{color:var(--accent)}
.top form{display:flex;gap:6px}
input,select,button{font:inherit;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;padding:5px 10px}
button{cursor:pointer;background:var(--cell)}button:hover{border-color:var(--accent2)}button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:1060px;margin:0 auto;padding:6px 20px 40px}
.crumbs{font-size:13px;color:var(--muted);margin:14px 0 4px}.crumbs a{color:var(--muted)}
h1{font-size:26px;margin:4px 0 12px;letter-spacing:-.01em;font-weight:650}h2{font-size:18px;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.lede{color:var(--muted);max-width:760px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:28px}@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}.props{order:-1}}
.props{background:var(--cell);border:1px solid var(--line);border-radius:8px;padding:10px 14px;align-self:start;font-size:14px}
.props h3{margin:2px 0 6px;font-size:14px;color:var(--muted);font-weight:600}
.props dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0}.props dt{color:var(--muted)}.props dd{margin:0;overflow-wrap:anywhere}
table{border-collapse:collapse;margin:6px 0;font-size:14px}th,td{padding:4px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.scroll{overflow-x:auto;max-width:100%}
.katex{font-size:1.08em}.math{overflow-wrap:anywhere}p.math .katex,td.math .katex{white-space:normal}
.badge{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 8px;margin-right:4px;white-space:nowrap}
.badge.ok{border-color:var(--ok);color:var(--ok)}.badge.bad{border-color:var(--err);color:var(--err)}
code,pre{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--code);border-radius:4px}code{padding:1px 4px}pre{padding:10px 12px;overflow-x:auto}
.box{background:var(--cell);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
.status{color:var(--muted);font-size:14px}.status.ok{color:var(--ok)}.status.bad{color:var(--err)}
.muted{color:var(--muted)}.small{font-size:13px}
details summary{cursor:pointer;color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;margin:10px 0}
.card{display:block;background:var(--cell);border:1px solid var(--line);border-radius:8px;padding:10px 14px;text-decoration:none;color:var(--fg)}.card:hover{border-color:var(--accent2)}
.card b{color:var(--accent)}
form.search{display:flex;gap:10px;flex-wrap:wrap;align-items:end}form.search label{display:flex;flex-direction:column;font-size:13px;color:var(--muted);gap:2px}
form.search input{width:9em}
footer{max-width:1060px;margin:0 auto;padding:18px 20px 30px;color:var(--muted);font-size:13px;border-top:1px solid var(--line)}
svg text{fill:var(--muted);font-size:11px}
`;

export function page(o: PageOpts): string {
  const crumbs = o.crumbs.map(([t, h]) => (h ? `<a href="${esc(h)}">${esc(t)}</a>` : esc(t))).join(" › ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)} · Sagebrush Atlas</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="https://sagebrush.space${esc(o.path)}">
${o.json ? `<link rel="alternate" type="application/json" href="${esc(o.json)}">` : ""}
<link rel="alternate" type="text/markdown" href="/atlas/llms.txt" title="llms.txt">
${o.noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E%F0%9F%8C%BF%3C/text%3E%3C/svg%3E">
<link rel="preload" href="/katex/fonts/KaTeX_Main-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/katex/fonts/KaTeX_Math-Italic.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/katex/katex.min.css">
<style>${CSS}</style>
<script type="module" src="/atlas/atlas.js"></script>
</head><body>
<div class="top"><div class="in">
<a class="brand" href="/atlas/">🌿 Sagebrush <span>Atlas</span></a>
<nav aria-label="Atlas"><a href="/atlas/">Modular forms</a><a href="/atlas/mf/">Search</a><a href="/atlas/about">About</a><a href="/atlas/llms.txt">For agents</a><a href="/">Notebook</a></nav>
<form action="/atlas/mf/" role="search"><input name="q" aria-label="Label or level" placeholder="389.2.a.e, 11a1, 1.24.a" size="16"><button>Go</button></form>
</div></div>
<main id="main">
<div class="crumbs">${crumbs}</div>
${o.body}
</main>
<footer>Sagebrush Atlas: newforms computed and proven by <a href="https://github.com/sagemathinc/sagebrush">Sagebrush</a>'s Rust engines, which also run in this page.
Labels are <a href="${LMFDB}">LMFDB</a>'s; elliptic curves are John Cremona's (<a href="https://github.com/JohnCremona/ecdata">ecdata</a>).
Every page is also JSON (<a href="${esc(o.json ?? "/atlas/data/stats.json")}">this one</a>). A project of <a href="https://sagemath.com">SageMath, Inc.</a></footer>
</body></html>`;
}

const prop = (rows: [string, string][]) => `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
const badgeStatus = (s: string) => `<span class="badge ok" title="certified by the engine: see Provenance">${esc(s)}</span>`;

// ------------------------------------------------------------------ newspace

export function spaceTitle(n: number, k: number) {
  return `Newspace ${spaceLabel(n, k)}`;
}

export function spaceCrumbs(n: number, k: number): [string, string?][] {
  return [["Atlas", "/atlas/"], ["Modular forms", "/atlas/mf/"], [`Weight ${k}`, `/atlas/mf/?weight=${k}`], [`Level ${n}`, `/atlas/mf/?weight=${k}&level=${n}`], [spaceLabel(n, k)]];
}

function orbitRow(sp: Space, f: Orbit): string {
  const d = derive(sp, f);
  const field = fieldHtml(f);
  // the signs w_p for p || N, in the order of p (the title names them)
  const known = d.al.filter(([, w]) => w !== null) as [number, number][];
  const al = known.length ? `<span title="${known.map(([p, w]) => `w_${p} = ${w > 0 ? "+1" : "−1"}`).join(", ")}">${known.map(([, w]) => (w > 0 ? "+" : M)).join(" ")}</span>` : "";
  return `<tr><td><a href="${href(f.label)}">${f.label}</a></td><td class="n">${f.dim}</td><td>${field}</td>
<td class="math">${qexpHtml(f.traces, 8)}</td><td>${al}</td><td>${d.sign === null ? "" : sgn(d.sign)}</td>
<td>${d.cm ? m(fieldTex(d.cm)) : ""}</td><td>${f.curve ? `<a href="${LMFDB}/EllipticCurve/Q/${f.curve.lmfdb.replace(".", "/")}/">${f.curve.cremona}</a> <span class="muted small">rank ${f.curve.rank}</span>` : ""}</td></tr>`;
}

export function spaceBody(sp: Space, stored = true): string {
  const n = sp.level, k = sp.weight, oldDim = sp.dims.cusp - sp.dims.new;
  const orbits = sp.newforms.length
    ? `<div class="scroll"><table><thead><tr><th>Label</th><th class="n">Dim</th><th>Coefficient field</th><th>Trace form</th><th title="Atkin-Lehner signs w_p for the primes p exactly dividing N">AL signs</th><th title="Sign of the functional equation">Sign</th><th>CM</th><th>Elliptic curve</th></tr></thead><tbody>${sp.newforms.map((f) => orbitRow(sp, f)).join("")}</tbody></table></div>`
    : `<p>There are no newforms: ${m(SnewTex(k, n) + " = 0")}.</p>`;
  const polys = sp.newforms.length
    ? `<h2>Hecke characteristic polynomials</h2><p>The eigenvalue of ${m(Ttex(sp.T))} generates each orbit's coefficient field; on the newspace its characteristic polynomial factors over ${QQ()} as one irreducible factor per orbit:</p>
<div class="scroll"><table><thead><tr><th>Orbit</th><th>Characteristic polynomial of ${m("T")}</th></tr></thead><tbody>${sp.newforms.map((f) => `<tr><td><a href="${href(f.label)}">${f.label}</a></td><td class="math">${polyHtml(f.charpoly)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const old = sp.old.length
    ? `<p class="math">${m(SnewTex(k, n, "old") + " =")} ${sp.old.map(([lv, , mult]) => `<a href="${href(spaceLabel(lv, k))}">${m(SnewTex(k, lv) + (mult > 1 ? `^{\\oplus ${mult}}` : ""))}</a>`).join(` ${m("\\oplus")} `)}</p>`
    : `<p>The old subspace is 0.</p>`;
  const props = prop([
    ["Level", levelHtml(n)],
    ["Weight", String(k)],
    ["Character", "trivial"],
    ["Dimension", String(sp.dims.new)],
    ["Newform orbits", String(sp.newforms.length)],
    ["Sturm bound", String(sturmBound(n, k))],
    ["Status", badgeStatus(sp.status)],
    ["Data", stored ? "stored in the atlas" : "computed in your browser"],
  ]);
  const nav = [n > 1 ? `<a href="${href(spaceLabel(n - 1, k))}">← ${spaceLabel(n - 1, k)}</a>` : "", `<a href="${href(spaceLabel(n + 1, k))}">${spaceLabel(n + 1, k)} →</a>`].filter(Boolean).join(" · ");
  return `<h1>${spaceTitle(n, k)}: ${Snew(k, n)}</h1>
<div class="grid"><div>
<h2>Newforms</h2>${orbits}
${polys}
<h2>Dimensions</h2>
<table><tbody><tr><th>Newforms ${Snew(k, n)}</th><td class="n">${sp.dims.new}</td></tr><tr><th>Old forms</th><td class="n">${oldDim}</td></tr>
<tr><th>Cusp forms ${m(`S_{${k}}(\\Gamma_0(${n}))`)}</th><td class="n">${sp.dims.cusp}</td></tr><tr><th>Eisenstein series ${m(`E_{${k}}(\\Gamma_0(${n}))`)}</th><td class="n">${sp.dims.eisenstein}</td></tr>
<tr><th>Modular forms ${m(`M_{${k}}(\\Gamma_0(${n}))`)}</th><td class="n">${sp.dims.cusp + sp.dims.eisenstein}</td></tr></tbody></table>
<h3>Decomposition of the old subspace</h3>${old}
${provenance(sp, null, stored)}
<p class="small">${nav}</p>
</div><aside class="props" aria-label="Properties"><h3>Properties</h3>${props}
<p class="small"><a href="${lmfdbForm(sp.label)}">This space in the LMFDB</a></p></aside></div>`;
}

// ------------------------------------------------------------------ newform orbit

export function orbitTitle(f: Orbit) {
  return `Newform orbit ${f.label}`;
}

export function orbitBody(sp: Space, f: Orbit, stored = true): string {
  const n = sp.level, k = sp.weight, d = derive(sp, f);
  const ps = primesUpTo(100);
  const field = fieldHtml(f, true);
  const props = prop([
    ["Label", f.label],
    ["Level", levelHtml(n)],
    ["Weight", String(k)],
    ["Character", "trivial"],
    ["Dimension", String(f.dim)],
    ["Coefficient field", fieldHtml(f)],
    ["CM", d.cm ? m(fieldTex(d.cm)) : "no"],
    ["Sign", d.sign === null ? "—" : sgn(d.sign)],
    ...(f.curve ? ([["Elliptic curve", `${f.curve.cremona} (rank ${f.curve.rank})`]] as [string, string][]) : []),
    ["Status", badgeStatus(sp.status) + (f.lmfdb === "agrees" ? `<span class="badge ok" title="Label, dimension and tr a_p for every p &lt; 1000 equal LMFDB's">LMFDB agrees</span>` : f.lmfdb ? `<span class="badge bad">differs from LMFDB</span>` : "")],
  ]);
  const qx = f.dim === 1
    ? `<h2>${m("q")}-expansion</h2><p class="math">${qexpHtml(f.traces, 25)}</p>`
    : `<h2>Trace form</h2><p>The ${f.dim} newforms in this orbit are conjugate over ${QQ()}; the sum of their ${m("q")}-expansions is</p><p class="math">${qexpHtml(f.traces, 25)}</p>`;
  const coef = `<h2>Coefficient field</h2><p>The coefficients ${m("a_n")} generate ${field}.${f.dim > 1 ? ` It is generated by the eigenvalue ${m("\\alpha")} of ${m(Ttex(sp.T))}, whose minimal polynomial is` : ` The eigenvalue of ${m(Ttex(sp.T))} is a root of`}</p><p class="math">${polyHtml(f.charpoly)}</p>`;
  const al = d.al.length
    ? `<h2>Atkin–Lehner signs</h2><table><thead><tr><th>${m("p")}</th><th>${m("w_p")}</th></tr></thead><tbody>${d.al.map(([p, w]) => `<tr><td>${p}</td><td>${w === null ? `<span class="muted">— (${m(`${p}^2 \\mid ${n}`)})</span>` : sgn(w)}</td></tr>`).join("")}</tbody></table>
<p class="small muted">For ${m("p \\parallel N")} every form in the orbit has ${m("a_p = -p^{k/2-1} w_p")}.${d.sign !== null ? ` The Fricke sign is ${m(`w_N = ${d.fricke! > 0 ? "+" : "-"}1`)}, so the sign of the functional equation is ${m(`(-1)^{k/2} w_N = ${d.sign > 0 ? "+" : "-"}1`)}: each L-function in the orbit has ${d.sign > 0 ? "even" : "odd"} analytic rank.` : ""}</p>`
    : "";
  const cm = d.cm ? `<p>Complex multiplication by ${m(fieldTex(d.cm))}: ${m("a_p = 0")} for every conjugate at the ${d.cmExact} primes ${m(`p \\le ${Math.floor(Math.sqrt(BOUND))}`)} inert in it (exactly, from ${m("\\operatorname{tr} a_{p^2} = -\\dim \\cdot p^{k-1}")}), and ${m("\\operatorname{tr} a_p = 0")} at all ${d.cmInert} inert primes ${m(`p < ${BOUND}`)}. This is evidence from the stored coefficients, not a proof.</p>` : "";
  const aps = `<h2>Traces of Hecke eigenvalues</h2><div class="scroll"><table><thead><tr><th>${m("p")}</th>${ps.map((p) => `<th class="n">${p}</th>`).join("")}</tr></thead><tbody><tr><th>${m("\\operatorname{tr} a_p")}</th>${ps.map((p) => `<td class="n">${f.traces[p - 1].replace(/^-/, M)}</td>`).join("")}</tr></tbody></table></div>
<p class="small muted">${m("\\operatorname{tr} a_n")} for every ${m(`n \\le ${f.traces.length}`)} is in the <a href="${href(f.label)}.json">JSON</a>.</p>`;
  const st = f.dim === 1
    ? `<h2>Sato–Tate</h2><p>${d.cm ? "With CM the" : "The"} normalized ${m(`a_p / 2p^{${k - 1}/2}`)} for the primes ${m(`p < ${BOUND}`)} not dividing ${n}, against the semicircle ${m("\\tfrac{2}{\\pi}\\sqrt{1 - x^2}")}${d.cm ? " (CM forms follow a different law)" : ""}:</p>
<div id="st">${satoTateSvg(normalizedAp(sp, f), "Sato-Tate histogram")}</div>${f.curve ? `<div class="actions"><button data-st="${esc(JSON.stringify(f.curve.ainvs))}" data-level="${n}">Use the primes up to 10⁶ (computed in your browser, ${fmtSeconds(apCost(1e6).seconds)})</button><span class="status" id="st-status"></span></div>` : ""}`
    : "";
  const curve = f.curve
    ? `<h2>Elliptic curve</h2><p>By modularity this newform is the one attached to the isogeny class <a href="${LMFDB}/EllipticCurve/Q/${f.curve.lmfdb.replace(".", "/")}/">${f.curve.lmfdb}</a> (Cremona's ${f.curve.cremona.replace(/\d+$/, "")}). Its optimal curve ${f.curve.cremona} is</p>
<p class="math">${m(weierstrass(f.curve.ainvs))}</p><p>of rank ${f.curve.rank} with torsion of order ${f.curve.torsion}. Its ${m("a_p")}, computed by Sagebrush's point-counting engine, equal the newform's for every prime ${m(`p < ${BOUND}`)}.</p>`
    : "";
  return `<h1>${orbitTitle(f)}</h1>
<div class="grid"><div>
${qx}${coef}${cm}${al}${curve}${aps}${st}
${provenance(sp, f, stored)}
</div><aside class="props" aria-label="Properties"><h3>Properties</h3>${props}
<p class="small"><a href="${href(sp.label)}">Newspace ${sp.label}</a><br><a href="${lmfdbForm(f.label)}">This orbit in the LMFDB</a></p></aside></div>`;
}

function weierstrass(a: number[]): string {
  const t = (c: number, mono: string) => (c === 0 ? "" : (c < 0 ? " - " : " + ") + (Math.abs(c) === 1 && mono ? "" : Math.abs(c)) + mono);
  return `y^2${t(a[0], "xy")}${t(a[2], "y")} = x^3${t(a[1], "x^2")}${t(a[3], "x")}${t(a[4], "")}`;
}

// ------------------------------------------------------------------ provenance and recipes

function provenance(sp: Space, f: Orbit | null, stored: boolean): string {
  const n = sp.level, k = sp.weight;
  const i = f ? sp.newforms.indexOf(f) : -1;
  const cells: (string | { md: string })[] = f
    ? [{ md: `## ${f.label}\nThe newform orbit [${f.label}](https://sagebrush.space${href(f.label)}) of the Sagebrush Atlas, recomputed by Sagebrush's engine in this notebook.` },
       `f = newform_orbits(${n}, ${k})[${i}]\nf, f.dimension(), f.charpoly()`, `f.charpoly().factor(), f.traces(30)`]
    : [{ md: `## ${sp.label}\nThe newspace [${sp.label}](https://sagebrush.space${href(sp.label)}) of the Sagebrush Atlas, recomputed in this notebook.` },
       `newform_orbits(${n}, ${k})`, `# T_2 on the modular symbols (sign +1), new and old\nModularSymbols(${n}, ${k}, sign=1).hecke_polynomial(2).factor()`];
  const checks = sp.checks.map((c) => `<li><code>${esc(c)}</code></li>`).join("");
  return `<h2>Provenance</h2>
<p>${stored ? `Stored in the atlas: computed by Sagebrush's modular symbols engine${sp.seconds !== undefined ? ` in ${sp.seconds} s` : ""} (one thread) and` : `Computed in your browser by Sagebrush's modular symbols engine (WebAssembly)${sp.seconds !== undefined ? ` in ${sp.seconds} s` : ""}${sp.estimate ? ` (the <a href="/atlas/about#cost">cost model</a> predicted ${fmtSeconds(sp.estimate.seconds)})` : ""}:`} <b>${esc(sp.status)}</b>: the dimensions are certified, and the characteristic polynomial of ${m("T")} over ${m("\\mathbb{Z}")} is reconstructed by CRT past a rigorous coefficient bound.
${f?.lmfdb === "agrees" ? ` The label, dimension and ${m("\\operatorname{tr} a_p")} for every ${m("p < 1000")} equal LMFDB's.` : ""}</p>
<details><summary>The engine's checks</summary><ul>${checks}</ul></details>
<div class="actions">
${stored ? `<button class="primary" data-verify="${n},${k}"${sp.estimate ? ` data-expect="${sp.estimate.seconds.toFixed(2)}" title="Predicted by the cost model: ${fmtSeconds(sp.estimate.seconds)}, ${fmtBytes(sp.estimate.bytes)} of memory"` : ""}>Recompute in your browser${sp.estimate ? ` (${fmtSeconds(sp.estimate.seconds)})` : ""}</button>` : ""}
<a href="${notebookLink(cells)}">Open in the notebook</a> ·
${stored ? `<a href="${href(f ? f.label : sp.label)}.json">JSON</a> · <a href="/atlas/data/mf/${k}/${n}.json">stored data</a>` : `<a href="#" data-download>Download JSON</a>`}
<span class="status" id="verify-status" role="status"></span></div>
<details><summary>Recompute it yourself</summary>
<p>In Sage mode at <a href="/">sagebrush.space</a> (or <code>npx sagebrush --sage</code>):</p><pre>newform_orbits(${n}, ${k})${f ? `[${i}]   # ${f.label}` : ""}</pre>
<p>With the Rust engine (<a href="https://github.com/sagemathinc/sagebrush">source</a>), in <code>engine/</code>:</p><pre>cargo run --release -p sagebrush-web --example atlas -- ${n}:${k} ${BOUND}</pre></details>`;
}

// ------------------------------------------------------------------ on demand

export function pendingBody(n: number, k: number, letter?: string): string {
  const label = spaceLabel(n, k) + (letter ? "." + letter : "");
  return `<h1>${letter ? "Newform orbit" : "Newspace"} ${esc(label)}</h1>
<div class="box" data-compute="${n},${k}"${letter ? ` data-letter="${esc(letter)}"` : ""}>
<p><b>Not stored in the atlas</b> (it stores weight 2 up to level 1000, and weights 4–12 with ${m("Nk^2 \\le 4000")}).
Your browser is computing it now with Sagebrush's engine, compiled to WebAssembly: the same proven computation as the stored spaces.</p>
<div class="actions"><span class="status" id="compute-status" role="status">Starting…</span><button id="compute-stop">Stop</button></div>
<p class="small muted" id="compute-estimate"></p>
<noscript><p>Computing needs JavaScript. Or run <code>newform_orbits(${n}, ${k})</code> in Sage mode at <a href="/">sagebrush.space</a>.</p></noscript>
</div>`;
}

// ------------------------------------------------------------------ search

export type IndexRow = [string, number, number, number, number, number, string[], [string, number, number] | 0, number];

export interface Query { weight?: string; level?: string; dim?: string; cm?: string; sign?: string; rank?: string; start?: number }

const range = (s: string | undefined): [number, number] | null => {
  if (!s) return null;
  const m = /^\s*(\d+)\s*(?:(?:-|–|\.\.)\s*(\d+))?\s*$/.exec(s);
  return m ? [+m[1], m[2] ? +m[2] : +m[1]] : null;
};

export function search(index: IndexRow[], q: Query): IndexRow[] {
  const lv = range(q.level), dm = range(q.dim), wt = range(q.weight), rk = range(q.rank);
  return index.filter((r) => {
    if (lv && (r[1] < lv[0] || r[1] > lv[1])) return false;
    if (wt && (r[2] < wt[0] || r[2] > wt[1])) return false;
    if (dm && (r[3] < dm[0] || r[3] > dm[1])) return false;
    if (q.cm === "yes" && !r[4]) return false;
    if (q.cm === "no" && r[4]) return false;
    if (q.sign === "1" && r[5] !== 1) return false;
    if (q.sign === "-1" && r[5] !== -1) return false;
    if (rk && (!r[7] || r[7][1] < rk[0] || r[7][1] > rk[1])) return false;
    return true;
  });
}

export function searchForm(q: Query): string {
  const v = (s?: string) => esc(s ?? "");
  const opt = (name: string, cur: string | undefined, opts: [string, string][]) => `<select name="${name}">${opts.map(([val, t]) => `<option value="${val}"${(cur ?? "") === val ? " selected" : ""}>${t}</option>`).join("")}</select>`;
  return `<form class="search" action="/atlas/mf/">
<label>Weight<input name="weight" value="${v(q.weight)}" placeholder="2 or 4-12"></label>
<label>Level<input name="level" value="${v(q.level)}" placeholder="389 or 1-100"></label>
<label>Dimension<input name="dim" value="${v(q.dim)}" placeholder="1 or 2-10"></label>
<label>CM${opt("cm", q.cm, [["", "any"], ["yes", "yes"], ["no", "no"]])}</label>
<label>Sign${opt("sign", q.sign, [["", "any"], ["1", "+1"], ["-1", "−1"]])}</label>
<label>Curve rank<input name="rank" value="${v(q.rank)}" placeholder="2 or 1-3"></label>
<button class="primary">Search</button></form>`;
}

export function searchBody(q: Query, rows: IndexRow[], total: number, start: number, pageSize: number): string {
  const qs = (o: Query) => new URLSearchParams(Object.entries(o).filter(([, x]) => x !== undefined && x !== "" && x !== 0).map(([a, b]) => [a, String(b)])).toString();
  const nav = [start > 0 ? `<a href="/atlas/mf/?${qs({ ...q, start: Math.max(0, start - pageSize) })}">← previous</a>` : "", start + pageSize < total ? `<a href="/atlas/mf/?${qs({ ...q, start: start + pageSize })}">next →</a>` : ""].filter(Boolean).join(" · ");
  const table = rows.length
    ? `<div class="scroll"><table><thead><tr><th>Label</th><th class="n">Dim</th><th>Trace form</th><th>Sign</th><th>CM</th><th>Curve</th></tr></thead><tbody>${rows.map((r) => `<tr><td><a href="${href(r[0])}">${r[0]}</a></td><td class="n">${r[3]}</td><td class="math">${qexpHtml(r[6], 8)}</td><td>${r[5] ? sgn(r[5]) : ""}</td><td>${r[4] ? m(fieldTex(r[4])) : ""}</td><td>${r[7] ? `${r[7][0]} <span class="muted small">rank ${r[7][1]}</span>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : "<p>No stored newform orbits match. Spaces that are not stored can still be computed: open a label such as <a href=\"/atlas/mf/1.24.a\">1.24.a</a>.</p>";
  return `<h1>Search newform orbits</h1>${searchForm(q)}
<p class="status">${total} orbit${total === 1 ? "" : "s"}${total ? `; showing ${start + 1}–${start + rows.length}` : ""} · <a href="/atlas/mf/?${qs({ ...q, start: undefined })}&amp;format=json">JSON</a></p>${table}<p>${nav}</p>`;
}
