# Artifact demo: Sagebrush running inside a chat artifact

Round two of the smoke test. Paste the prompt below into **claude.ai** and
**ChatGPT** the same way as before, then copy the grey "SAGEBRUSH DEMO"
block back.

The page `import()`s two single-file modules from the npm package
`sagebrush-web` via `cdn.jsdelivr.net/npm/` (the only jsdelivr path Claude
allows), falling back to `cdn.jsdelivr.net/gh/sagemathinc/sagebrush@7dddf96…/cdn/`:

- `sagebrush-engine.mjs`: the Rust engines as wasm32, base64-inlined so that no `fetch()` is needed;
- `pyparse.mjs`: CPython 3.14's parser in TypeScript.

It then:

1. parses a Python cell and shows CPython's SyntaxError with carets;
2. computes the proven charpoly of $T_2$ on $M_2(\Gamma_0(389))^+$ (degree 33);
3. computes $a_p$ of 37a for $p \le 10^5$ and plots the Sato–Tate histogram with Plotly from cdnjs.

The inputs are live, so you can change them and press the buttons.

Headless Chromium here: load 81 ms, charpoly 9 ms, 9,591 $a_p$ in 153 ms;
see `artifact-demo-headless.png`.

## Prompt

````
Please create an HTML artifact containing exactly the following page, unchanged, so I can run it. Do not modify, shorten, or "improve" it; it is a compatibility test of loading WebAssembly from cdn.jsdelivr.net.

<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sagebrush in an artifact</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 16px; max-width: 900px; }
  h3 { margin: 18px 0 6px; }
  textarea, input { font-family: ui-monospace, monospace; font-size: 13px; }
  textarea { width: 100%; height: 90px; }
  input { width: 70px; }
  pre { background: #f4f4f4; padding: 8px; white-space: pre-wrap; font-size: 12px; }
  .err { color: #b00; } .ok { color: #070; }
  button { margin: 4px 0; }
  #plot { width: 100%; height: 380px; }
</style>
</head>
<body>
<h2>Sagebrush in an artifact</h2>
<div id="status">loading…</div>

<h3>1. Python, parsed with CPython 3.14's own grammar</h3>
<textarea id="code">def area(r):
    return 3.14 * r ** 2

x = [1, 2 3]
</textarea>
<button id="parse">Parse</button>
<pre id="parseout"></pre>

<h3>2. Modular symbols: proven characteristic polynomials</h3>
N <input id="N" value="389"> k <input id="k" value="2"> q <input id="q" value="2">
<button id="mf">Compute T<sub>q</sub> on M<sub>k</sub>(Γ<sub>0</sub>(N))<sup>+</sup></button>
<pre id="mfout"></pre>

<h3>3. Elliptic curves: a<sub>p</sub> and Sato–Tate</h3>
a-invariants <input id="ainv" value="[0,0,1,-1,0]" style="width:160px"> p ≤ <input id="pmax" value="100000" style="width:90px">
<button id="ap">Plot</button>
<pre id="apout"></pre>
<div id="plot"></div>

<p>Copy this block back into the chat:</p>
<pre id="report">running…</pre>

<script type="module">
// npm (the only jsdelivr path Claude's sandbox allows), then GitHub (works in ChatGPT and browsers).
const BASES = [
  "https://cdn.jsdelivr.net/npm/sagebrush-web@0.1.0/",
  "https://cdn.jsdelivr.net/gh/sagemathinc/sagebrush@7dddf961a37a27d4f93a04ad93cfee34b452d277/cdn/",
];
const log = [];
const note = (s) => { log.push(s); document.getElementById("report").textContent = "SAGEBRUSH DEMO\n" + log.join("\n"); };
const $ = (id) => document.getElementById(id);

let t = performance.now();
let sb, py, errors = [];
for (const base of BASES) {
  try {
    [sb, py] = await Promise.all([import(base + "sagebrush-engine.mjs"), import(base + "pyparse.mjs")]);
    note(`OK   load engine (${(sb.wasmBytes / 1024) | 0} KB wasm) + parser from ${base.split("/")[3]}: ${(performance.now() - t).toFixed(0)} ms`);
    break;
  } catch (e) {
    errors.push(`${base.split("/")[3]}: ${e.message || e}`);
  }
}
if (!sb) {
  note("FAIL load: " + errors.join(" | "));
  $("status").textContent = "failed to load: " + errors.join(" | ");
  throw new Error("load failed");
}
$("status").textContent = "ready";

function poly(coeffs) {
  // coeffs[j] are constant-term-first integers (strings) -> "x^3 - x^2 - 6*x"
  const terms = [];
  for (let j = coeffs.length - 1; j >= 0; j--) {
    const c = BigInt(coeffs[j]);
    if (c === 0n) continue;
    const a = c < 0n ? -c : c;
    const mon = j === 0 ? "" : j === 1 ? "x" : `x^${j}`;
    const body = j === 0 ? `${a}` : a === 1n ? mon : `${a}*${mon}`;
    terms.push((c < 0n ? "- " : terms.length ? "+ " : "") + body);
  }
  return terms.join(" ") || "0";
}

function doParse() {
  const src = $("code").value + "\n";
  const out = $("parseout");
  const t0 = performance.now();
  try {
    const tree = py.parse(src);
    const ms = performance.now() - t0;
    out.className = "ok";
    out.textContent = `OK in ${ms.toFixed(1)} ms: ` + tree.body.map((s) => s._type).join(", ");
    return `parsed OK`;
  } catch (e) {
    const i = e.info;
    if (!i) { out.textContent = String(e); return "crash " + e; }
    const line = (i.text || "").replace(/\n$/, "");
    const caret = " ".repeat(Math.max(0, i.offset - 1)) + "^".repeat(Math.max(1, (i.end_lineno === i.lineno ? i.end_offset : i.offset + 1) - i.offset));
    out.className = "err";
    out.textContent = `  File "<cell>", line ${i.lineno}\n    ${line}\n    ${caret}\n${i.type}: ${i.msg}`;
    return `${i.type}: ${i.msg} (line ${i.lineno}, col ${i.offset}-${i.end_offset})`;
  }
}

function doMF() {
  const n = +$("N").value, k = +$("k").value, q = +$("q").value;
  const t0 = performance.now();
  try {
    const d = sb.dims({ n, k });
    const r = k === 2 ? sb.weight2({ n, q }) : sb.charpoly({ n, k, q, sign: 1 });
    const coeffs = k === 2 ? r.coeffs : r.coeffs.map((c) => c[0]);
    const ms = performance.now() - t0;
    $("mfout").textContent = `dim S_${k}(${n}) = ${d.cusp}, dim E_${k} = ${d.eisenstein}; sign +1 space has dim ${r.dim}\n` +
      `charpoly of T_${q} (${r.status}, ${ms.toFixed(0)} ms):\n${poly(coeffs)}`;
    return `N=${n} k=${k} T_${q}: dim ${r.dim}, ${r.status}, ${ms.toFixed(0)} ms`;
  } catch (e) {
    $("mfout").textContent = String(e);
    return "error " + e;
  }
}

function doAP() {
  const a = JSON.parse($("ainv").value), n = +$("pmax").value;
  const t0 = performance.now();
  const aps = sb.aplist(a, n).filter(([, x]) => x !== null);
  const ms = performance.now() - t0;
  const xs = aps.map(([p, x]) => x / (2 * Math.sqrt(p)));
  $("apout").textContent = `${aps.length} primes in ${ms.toFixed(0)} ms; first: ${aps.slice(0, 10).map(([p, x]) => `a_${p}=${x}`).join(" ")}`;
  const grid = [...Array(201).keys()].map((i) => -1 + i / 100);
  if (window.Plotly) {
    Plotly.newPlot("plot", [
      { type: "histogram", x: xs, histnorm: "probability density", xbins: { start: -1, end: 1, size: 0.04 }, name: "a_p / 2√p" },
      { type: "scatter", x: grid, y: grid.map((x) => (2 / Math.PI) * Math.sqrt(1 - x * x)), name: "Sato–Tate (2/π)√(1−x²)" },
    ], { margin: { t: 20 }, legend: { x: 0, y: 1.15, orientation: "h" } });
  }
  return `a_p for p <= ${n}: ${aps.length} primes, ${ms.toFixed(0)} ms`;
}

const s = document.createElement("script");
s.src = "https://cdnjs.cloudflare.com/ajax/libs/plotly.js/4.1.2/plotly.min.js";
const plotlyReady = new Promise((res) => { s.onload = () => res(true); s.onerror = () => res(false); });
document.head.appendChild(s);

$("parse").onclick = doParse;
$("mf").onclick = doMF;
$("ap").onclick = doAP;
note("     parse: " + doParse());
note("     modsym: " + doMF());
note("     plotly: " + ((await plotlyReady) ? "loaded" : "FAILED"));
note("     curve 37a: " + doAP());
note("     ua: " + navigator.userAgent);
</script>
</body>
</html>
````
