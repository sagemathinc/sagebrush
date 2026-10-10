// The atlas's front page and About page (from data/stats.json).
import { RANGES } from "./model.ts";
import { esc, href, m, searchForm, LMFDB } from "./render.ts";

export interface Stats {
  commit: string;
  bound: number;
  built: string;
  orbits: number;
  spaces: number;
  lmfdb: { agree: number; differ: number };
  weights: Record<string, { maxLevel: number; spaces: number; orbits: number; dims: Record<string, number>; grid: number[] }>;
}

const EXAMPLES: [string, string, string][] = [
  ["11.2.a.a", "The first newform", "Level 11, attached to the elliptic curve 11a1: q − 2q² − q³ + 2q⁴ + …"],
  ["37.2.a.a", "Rank one", "The first elliptic curve of positive rank: sign −1."],
  ["389.2.a.a", "Rank two", "The smallest conductor of a curve of rank 2."],
  ["389.2.a.e", "Dimension 20", "The big orbit at level 389: a degree-20 coefficient field."],
  ["23.2.a.a", "The golden field", "Coefficients in ℚ(√5): the first orbit of dimension 2."],
  ["27.2.a.a", "Complex multiplication", "CM by ℚ(√−3): a_p = 0 at every inert prime."],
  ["1.12.a.a", "Ramanujan's Δ", "q∏(1 − qⁿ)²⁴ = q − 24q² + 252q³ − …"],
  ["1.24.a", "Weight 24, live", "Not stored: your browser computes it in seconds. Two conjugate newforms with coefficients in ℚ(√144169), as Maeda's conjecture predicts."],
];

export function homeBody(st: Stats): string {
  const ws = Object.keys(st.weights).map(Number).sort((a, b) => a - b);
  const grid = `<div class="scroll"><table><thead><tr><th>Weight</th>${RANGES.map(([a, b]) => `<th class="n">${a}–${b}</th>`).join("")}</tr></thead><tbody>${ws
    .map((k) => `<tr><th>${k}</th>${st.weights[k].grid.map((c, i) => (c ? `<td class="n"><a href="/atlas/mf/?weight=${k}&amp;level=${RANGES[i][0]}-${RANGES[i][1]}">${c}</a></td>` : `<td></td>`)).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
  const dims = st.weights[2].dims;
  const big = Object.keys(dims).map(Number).sort((a, b) => b - a)[0];
  return `<h1>Modular forms</h1>
<p class="lede">Every Galois orbit of newforms of weight 2 and level ${m(`N \\le ${st.weights[2].maxLevel}`)}, and of weight 4 to 12 with ${m("Nk^2 \\le 4000")} (trivial character):
${st.orbits.toLocaleString("en")} orbits in ${st.spaces.toLocaleString("en")} spaces, computed and <b>proven</b> by Sagebrush's Rust engines, with LMFDB's labels.
The ${st.lmfdb.agree.toLocaleString("en")} weight-2 orbits agree with the LMFDB${st.lmfdb.differ ? ` (${st.lmfdb.differ} differ)` : ", every one"}: label, dimension and ${m("\\operatorname{tr} a_p")} for every ${m("p < 1000")}.
A space that is not stored is computed in your browser, by the same engine compiled to WebAssembly, and any stored page can be recomputed there to check it.</p>
<h2>Examples</h2>
<div class="cards">${EXAMPLES.map(([l, t, d]) => `<a class="card" href="${href(l)}"><b>${l}</b> · ${esc(t)}<br><span class="small muted">${esc(d)}</span></a>`).join("")}</div>
<h2>Browse newform orbits by weight and level</h2>${grid}
<h2>Search</h2>${searchForm({})}
<h2>Compute a space</h2>
<form class="search" id="goform" action="/atlas/mf/"><label>Level<input name="level" required inputmode="numeric" placeholder="1009"></label><label>Weight<input name="weight" inputmode="numeric" placeholder="2"></label><input type="hidden" name="go" value="1"><button class="primary">Open</button></form>
<p class="small muted">Any level and even weight with the trivial character: stored spaces open at once; others are computed on the page, after the engine <a href="/atlas/about#cost">predicts how long that takes</a> (about a second at level 1000, seconds to a minute in the thousands).</p>
<h2>For agents</h2>
<p>Every page is also JSON: append <code>.json</code> (<a href="/atlas/mf/389.2.a.e.json">/atlas/mf/389.2.a.e.json</a>), or search with <code>format=json</code>.
The data is static files: <a href="/atlas/data/stats.json">stats.json</a>, <a href="/atlas/data/index.json">index.json</a> (one row per orbit) and <code>/atlas/data/mf/k/N.json</code> (a whole newspace, traces ${m(`a_1, \\dots, a_{${st.bound}}`)}).
<a href="/atlas/llms.txt">llms.txt</a> describes the formats; in a browser with WebMCP, this page offers the tools <code>atlas_lookup</code>, <code>atlas_search</code>, <code>atlas_estimate</code> and <code>atlas_compute</code>. The largest stored orbit has dimension ${big}.</p>`;
}

/** [predicted, actual, label, bound] per space, per set (fit-cost.py). */
export type CostModel = Record<string, [number, number, string, number][]>;

/** Predicted against measured seconds, log-log, with the x2 band. */
function costPlot(cm: CostModel): string {
  const W = 520, H = 360, pad = 40, lo = -1.3, hi = 2.2; // log10 seconds
  const x = (v: number) => pad + ((Math.log10(v) - lo) / (hi - lo)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((Math.log10(v) - lo) / (hi - lo)) * (H - 2 * pad);
  const colors: Record<string, string> = { stored: "var(--accent2)", bounds: "#2a6fb0", larger: "#2a6fb0", valid: "var(--err)" };
  let dots = "";
  for (const [name, rows] of Object.entries(cm))
    for (const [p, a, label, b] of rows)
      if (p >= 0.05 && a >= 0.05) dots += `<circle cx="${x(p).toFixed(1)}" cy="${y(a).toFixed(1)}" r="${name === "stored" ? 1.8 : 3}" fill="${colors[name] ?? "gray"}" opacity="${name === "stored" ? 0.5 : 0.85}"><title>${label} (B = ${b}): predicted ${p} s, took ${a} s</title></circle>`;
  const t0 = 10 ** lo, t1 = 10 ** hi;
  const line = (f: number, dash: string) => `<line x1="${x(t0)}" y1="${y(t0 * f)}" x2="${x(t1 / Math.max(f, 1))}" y2="${y((t1 / Math.max(f, 1)) * f)}" stroke="var(--muted)" stroke-dasharray="${dash}"/>`;
  const ticks = [0.1, 1, 10, 100].map((t) => `<text x="${x(t)}" y="${H - pad + 16}" text-anchor="middle">${t} s</text><text x="${pad - 6}" y="${y(t) + 4}" text-anchor="end">${t} s</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img" aria-label="Predicted against measured time">
<defs><clipPath id="costclip"><rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${H - 2 * pad}"/></clipPath></defs>
<rect x="${pad}" y="${pad}" width="${W - 2 * pad}" height="${H - 2 * pad}" fill="none" stroke="var(--line)"/><g clip-path="url(#costclip)">${line(1, "")}${line(2, "4 3")}${line(0.5, "4 3")}${dots}</g>${ticks}
<text x="${W / 2}" y="${H - 4}" text-anchor="middle">predicted</text><text x="12" y="${H / 2}" text-anchor="middle" transform="rotate(-90 12 ${H / 2})">measured</text></svg>`;
}

function accuracy(rows: [number, number, string, number][]): string {
  const r = rows.filter(([p, a]) => a >= 0.1 && p > 0).map(([p, a]) => Math.max(p / a, a / p));
  const pct = (f: number) => Math.round((100 * r.filter((x) => x <= f).length) / r.length);
  return `${r.length} spaces: ${pct(1.5)}% within a factor 1.5, ${pct(2)}% within 2`;
}

export function aboutBody(st: Stats, cm: CostModel | null = null): string {
  return `<h1>About the Sagebrush Atlas</h1>
<p class="lede">An agent-first companion to the <a href="${LMFDB}">LMFDB</a>: a cache of certified computations, with LMFDB's labels, served as static files and pages that are also JSON, and able to compute what it does not store.</p>
<h2>What is stored</h2>
<p>For each newspace ${m("S_k^{\\mathrm{new}}(\\Gamma_0(N))")} (weight 2 with ${m(`N \\le ${st.weights[2].maxLevel}`)}; weights 4–12 with ${m("Nk^2 \\le 4000")}): the dimensions of the new, old, cuspidal and Eisenstein subspaces; a Hecke operator ${m("T = \\sum c_q T_q")} whose characteristic polynomial is squarefree on the newspace; and for every Galois orbit of newforms its LMFDB label, dimension, the characteristic polynomial of ${m("T")} (irreducible, defining the coefficient field) and the traces ${m("\\operatorname{tr} a_n")} for ${m(`n \\le ${st.bound}`)}.
Atkin–Lehner signs, the sign of the functional equation and CM are derived from these on each page. Rational newforms of weight 2 are linked to John Cremona's elliptic curves, matched by ${m("a_p")} for ${m(`p < ${st.bound}`)} computed with Sagebrush's point-counting engine.</p>
<h2>How it is computed, and how sure it is</h2>
<p>Sagebrush's modular symbols engine (Rust) computes each newspace exactly. The dimensions are certified against the dimension formulas, the characteristic polynomial of ${m("T")} over ${m("\\mathbb{Z}")} is reconstructed by the Chinese remainder theorem past a rigorous bound on its coefficients, and it is factored over ${m("\\mathbb{Z}")} (Zassenhaus, checked against FLINT). The engine reports this as status <b>proven</b>, with the checks it made, on every page.
Independently, all ${st.lmfdb.agree.toLocaleString("en")} weight-2 orbits agree with the LMFDB in label, dimension and ${m("\\operatorname{tr} a_p")} for all ${m("p < 1000")}.</p>
<p>The same engine runs in your browser as WebAssembly: <b>Recompute in your browser</b> on any page reruns the computation and compares it with the stored data, and spaces that are not stored are computed on the spot.</p>
<h2>Data</h2>
<p>${st.producer?.commit ? `Computed with Sagebrush commit <a href="https://github.com/sagemathinc/sagebrush/commit/${esc(st.producer.commit)}"><code>${esc(st.producer.commit.slice(0, 10))}</code></a>${st.producer.dirty ? " (with local changes)" : ""}, packaged ${esc(st.built)}${st.builder ? ` by commit <code>${esc(st.builder.slice(0, 10))}</code>` : ""}${st.input_sha256 ? ` from input SHA-256 <code>${esc(st.input_sha256.slice(0, 16))}…</code>` : ""}` : `Built ${esc(st.built)} from Sagebrush commit <a href="https://github.com/sagemathinc/sagebrush/commit/${esc(st.commit)}"><code>${esc(st.commit.slice(0, 10))}</code></a> (the packaging revision: the producing revision was not recorded)`}, with</p>
<pre>cargo run --release -p sagebrush-web --example atlas -- 1-1000:2,1-250:4,1-111:6,1-62:8,1-40:10,1-27:12 ${st.bound} 16
node scripts/build-atlas.mjs spaces.jsonl</pre>
<p>(about 9 CPU-minutes). The format is described in <a href="/atlas/llms.txt">llms.txt</a>. The design: <a href="https://github.com/sagemathinc/sagebrush/blob/master/design/lmfdb-for-agents.md">an LMFDB for agents</a>.</p>
${cm ? `<h2 id="cost">How long will it take?</h2>
<p>Before computing a space, the engine predicts the time and memory it will need (<code>estimate_newforms</code>), from quantities it knows in advance:
the levels ${m("M \\mid N")} and their dimensions, the number of primes the Chinese remainder theorem will need for the characteristic polynomial and for the traces (from the same rigorous bounds the computation uses), and the number of Heilbronn matrices behind ${m("T_p")} for ${m("p \\le B")}.
Each stage of the computation contributes a term, with a constant fitted to measurements of the WebAssembly engine: every stored space, and ${(cm.larger ?? []).length + (cm.bounds ?? []).length} more (levels up to 5077, weights up to 36, bounds 100 to 3000). Another ${(cm.valid ?? []).length} spaces of that kind were kept out of the fit to check it.</p>
<p>Stored spaces: ${accuracy(cm.stored ?? [])}. Larger spaces and other bounds: ${accuracy([...(cm.larger ?? []), ...(cm.bounds ?? [])])}. <b>Kept out of the fit</b>: ${accuracy(cm.valid ?? [])}.
The hard part to predict is the search for the Hecke operator ${m("T")}: at highly composite levels many old forms make the first choices fail, and each try costs a pass over every level.
Memory is small: no stored space needs more than a few megabytes.</p>
${costPlot(cm)}
<p class="small muted">Each dot is a space (hover for its label): <span style="color:var(--accent2)">●</span> stored, <span style="color:#2a6fb0">●</span> larger or other bounds, <span style="color:var(--err)">●</span> kept out of the fit; the dashed lines are a factor 2.
Computing ${m("a_p")} for all ${m("p < X")} (Sato–Tate) is simpler and does not depend on the curve: ${m("0.008 + 3.2 \\cdot 10^{-8}\\, X \\log X")} seconds (0.44 s for ${m("X = 10^6")}, 5.3 s for ${m("10^7")}, within 3% from ${m("X = 10^5")} up) and about 12 bytes of memory per unit of ${m("X")}.</p>` : ""}`;
}
