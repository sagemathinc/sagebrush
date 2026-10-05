// The atlas's front page and About page (from data/stats.json).
import { RANGES } from "./model.ts";
import { esc, href, searchForm, LMFDB } from "./render.ts";

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
<p class="lede">Every Galois orbit of newforms of weight 2 and level <i>N</i> ≤ ${st.weights[2].maxLevel}, and of weight 4 to 12 with <i>Nk</i>² ≤ 4000 (trivial character):
${st.orbits.toLocaleString("en")} orbits in ${st.spaces.toLocaleString("en")} spaces, computed and <b>proven</b> by Sagebrush's Rust engines, with LMFDB's labels.
The ${st.lmfdb.agree.toLocaleString("en")} weight-2 orbits agree with the LMFDB${st.lmfdb.differ ? ` (${st.lmfdb.differ} differ)` : ", every one"}: label, dimension and tr <i>a<sub>p</sub></i> for every <i>p</i> &lt; 1000.
A space that is not stored is computed in your browser, by the same engine compiled to WebAssembly, and any stored page can be recomputed there to check it.</p>
<h2>Examples</h2>
<div class="cards">${EXAMPLES.map(([l, t, d]) => `<a class="card" href="${href(l)}"><b>${l}</b> · ${esc(t)}<br><span class="small muted">${esc(d)}</span></a>`).join("")}</div>
<h2>Browse newform orbits by weight and level</h2>${grid}
<h2>Search</h2>${searchForm({})}
<h2>Compute a space</h2>
<form class="search" id="goform" action="/atlas/mf/"><label>Level<input name="level" required inputmode="numeric" placeholder="1009"></label><label>Weight<input name="weight" inputmode="numeric" placeholder="2"></label><input type="hidden" name="go" value="1"><button class="primary">Open</button></form>
<p class="small muted">Any level and even weight with the trivial character: stored spaces open at once; others are computed on the page (a few seconds at level ~1000, minutes in the thousands).</p>
<h2>For agents</h2>
<p>Every page is also JSON: append <code>.json</code> (<a href="/atlas/mf/389.2.a.e.json">/atlas/mf/389.2.a.e.json</a>), or search with <code>format=json</code>.
The data is static files: <a href="/atlas/data/stats.json">stats.json</a>, <a href="/atlas/data/index.json">index.json</a> (one row per orbit) and <code>/atlas/data/mf/<i>k</i>/<i>N</i>.json</code> (a whole newspace, traces <i>a</i><sub>1</sub>…<i>a</i><sub>${st.bound}</sub>).
<a href="/atlas/llms.txt">llms.txt</a> describes the formats; in a browser with WebMCP, this page offers the tools <code>atlas_lookup</code>, <code>atlas_search</code> and <code>atlas_compute</code>. The largest stored orbit has dimension ${big}.</p>`;
}

export function aboutBody(st: Stats): string {
  return `<h1>About the Sagebrush Atlas</h1>
<p class="lede">An agent-first companion to the <a href="${LMFDB}">LMFDB</a>: a cache of certified computations, with LMFDB's labels, served as static files and pages that are also JSON, and able to compute what it does not store.</p>
<h2>What is stored</h2>
<p>For each newspace <i>S<sub>k</sub></i><sup>new</sup>(Γ<sub>0</sub>(<i>N</i>)) (weight 2 with <i>N</i> ≤ ${st.weights[2].maxLevel}; weights 4–12 with <i>Nk</i>² ≤ 4000): the dimensions of the new, old, cuspidal and Eisenstein subspaces; a Hecke operator <i>T</i> = Σ <i>c<sub>q</sub>T<sub>q</sub></i> whose characteristic polynomial is squarefree on the newspace; and for every Galois orbit of newforms its LMFDB label, dimension, the characteristic polynomial of <i>T</i> (irreducible, defining the coefficient field) and the traces tr <i>a<sub>n</sub></i> for <i>n</i> ≤ ${st.bound}.
Atkin–Lehner signs, the sign of the functional equation and CM are derived from these on each page. Rational newforms of weight 2 are linked to John Cremona's elliptic curves, matched by <i>a<sub>p</sub></i> for <i>p</i> &lt; ${st.bound} computed with Sagebrush's point-counting engine.</p>
<h2>How it is computed, and how sure it is</h2>
<p>Sagebrush's modular symbols engine (Rust) computes each newspace exactly. The dimensions are certified against the dimension formulas, the characteristic polynomial of <i>T</i> over ℤ is reconstructed by the Chinese remainder theorem past a rigorous bound on its coefficients, and it is factored over ℤ (Zassenhaus, checked against FLINT). The engine reports this as status <b>proven</b>, with the checks it made, on every page.
Independently, all ${st.lmfdb.agree.toLocaleString("en")} weight-2 orbits agree with the LMFDB in label, dimension and tr <i>a<sub>p</sub></i> for all <i>p</i> &lt; 1000.</p>
<p>The same engine runs in your browser as WebAssembly: <b>Recompute in your browser</b> on any page reruns the computation and compares it with the stored data, and spaces that are not stored are computed on the spot.</p>
<h2>Data</h2>
<p>Built ${esc(st.built)} from Sagebrush commit <a href="https://github.com/sagemathinc/sagebrush/commit/${esc(st.commit)}"><code>${esc(st.commit.slice(0, 10))}</code></a> with</p>
<pre>cargo run --release -p sagebrush-web --example atlas -- 1-1000:2,1-250:4,1-111:6,1-62:8,1-40:10,1-27:12 ${st.bound} 16
node scripts/build-atlas.mjs spaces.jsonl</pre>
<p>(about 47 CPU-minutes). The format is described in <a href="/atlas/llms.txt">llms.txt</a>. The design: <a href="https://github.com/sagemathinc/sagebrush/blob/master/design/lmfdb-for-agents.md">an LMFDB for agents</a>.</p>`;
}
