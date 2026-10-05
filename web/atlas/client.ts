// atlas.js: what the atlas's pages do in the browser.  Pages are complete
// without it; it adds the engine (a Web Worker running the notebook's
// WebAssembly build): computing spaces that are not stored, recomputing
// stored ones against their data, Sato-Tate with more primes, and WebMCP
// tools for agents.
import { BOUND, type Space, divisors, parseLabel, sameMath, spaceFromEngine, spaceLabel } from "./model.ts";
import { href, normalizedAp, orbitBody, satoTateSvg, spaceBody } from "./render.ts";

const $ = (s: string) => document.querySelector(s) as HTMLElement | null;

// ---- the engine
let worker: Worker | null = null, seq = 0;
const waiting = new Map<number, [(v: any) => void, (e: Error) => void]>();
function engineWorker(): Worker {
  if (worker) return worker;
  worker = new Worker("/atlas/atlas-engine.js", { type: "module" });
  worker.onmessage = (ev) => {
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    if (ev.data.reply.error) w[1](new Error(ev.data.reply.error));
    else w[0](ev.data.reply.ok);
  };
  return worker;
}
function call(req: object): Promise<any> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, [resolve, reject]);
    engineWorker().postMessage({ id, req });
  });
}
function stop() {
  worker?.terminate();
  worker = null;
  for (const [, [, reject]] of waiting) reject(new Error("stopped"));
  waiting.clear();
}

/** The newspace N.k.a, computed here exactly as the atlas computes it. */
async function computeSpace(n: number, k: number): Promise<Space> {
  const t = performance.now();
  const dims = await call({ fn: "dims", n, k });
  const newDim = new Map<number, number>();
  for (const m of divisors(n)) if (m < n) newDim.set(m, (await call({ fn: "dims", n: m, k })).new);
  const nf = await call({ fn: "newforms", n, k, bound: BOUND });
  const sp = spaceFromEngine(n, k, dims, nf, (m) => newDim.get(m) ?? 0, (performance.now() - t) / 1000);
  sp.computed = "browser";
  return sp;
}

function ticker(el: HTMLElement | null, text: string) {
  const t0 = performance.now();
  const tick = () => { if (el) el.textContent = `${text} ${((performance.now() - t0) / 1000).toFixed(0)} s`; };
  tick();
  const h = setInterval(tick, 1000);
  return () => clearInterval(h);
}

function download(name: string, data: unknown) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = name;
  a.click();
}

// ---- a space that is not stored: compute it on the page
async function computePage(box: HTMLElement) {
  const [n, k] = box.dataset.compute!.split(",").map(Number);
  const letter = box.dataset.letter;
  const status = $("#compute-status");
  const done = ticker(status, `Computing ${spaceLabel(n, k)} in your browser…`);
  $("#compute-stop")?.addEventListener("click", () => { stop(); done(); if (status) status.textContent = "Stopped."; });
  try {
    // a space computed earlier in this tab (its orbits link here) is reused
    let sp: Space | null = null;
    try { sp = JSON.parse(sessionStorage.getItem("atlas:" + spaceLabel(n, k)) ?? "null"); } catch {}
    sp ??= await computeSpace(n, k);
    done();
    (window as any).__atlasSpace = sp;
    const f = letter ? sp.newforms.find((o) => o.letter === letter) : null;
    const main = $("#main")!, crumbs = main.querySelector(".crumbs")!.outerHTML;
    if (letter && !f) {
      main.innerHTML = `${crumbs}<h1>Not found</h1><p>The newspace <a href="${href(sp.label)}">${sp.label}</a> has ${sp.newforms.length} newform orbit${sp.newforms.length === 1 ? "" : "s"}; there is no ${spaceLabel(n, k)}.${letter}.</p>`;
      return;
    }
    main.innerHTML = crumbs + (f ? orbitBody(sp, f, false) : spaceBody(sp, false));
    try { sessionStorage.setItem("atlas:" + sp.label, JSON.stringify(sp)); } catch {}
    wire();
  } catch (e) {
    done();
    if (status) { status.textContent = `Could not compute it: ${(e as Error).message}`; status.className = "status bad"; }
  }
}

// ---- a stored space: recompute it and compare
async function verify(btn: HTMLButtonElement) {
  const [n, k] = btn.dataset.verify!.split(",").map(Number);
  const status = $("#verify-status")!;
  btn.disabled = true;
  status.className = "status";
  const done = ticker(status, "Recomputing in your browser…");
  try {
    const [stored, sp] = await Promise.all([fetch(`/atlas/data/mf/${k}/${n}.json`).then((r) => r.json()), computeSpace(n, k)]);
    done();
    const diff = sameMath(sp, stored);
    status.className = diff ? "status bad" : "status ok";
    status.textContent = diff
      ? `Differs from the stored data: ${diff}.`
      : `✓ Identical to the stored data: ${sp.newforms.length} orbit${sp.newforms.length === 1 ? "" : "s"}, their characteristic polynomials and tr a_1 … a_${BOUND}, recomputed in ${sp.seconds} s.`;
  } catch (e) {
    done();
    status.className = "status bad";
    status.textContent = `Could not recompute: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- Sato-Tate with the primes up to 10^6
async function satoTate(btn: HTMLButtonElement) {
  const a = JSON.parse(btn.dataset.st!), n = +btn.dataset.level!;
  const status = $("#st-status")!;
  btn.disabled = true;
  const t = performance.now();
  status.textContent = "Counting points…";
  try {
    const ap: [number, number][] = await call({ fn: "aplist", a, n: 1_000_000 });
    const xs = ap.filter(([p]) => n % p !== 0).map(([p, x]) => x / (2 * Math.sqrt(p)));
    $("#st")!.innerHTML = satoTateSvg(xs, "Sato-Tate histogram, p < 10^6");
    status.textContent = `${xs.length.toLocaleString("en")} primes p < 10⁶, a_p computed in your browser in ${((performance.now() - t) / 1000).toFixed(1)} s.`;
  } catch (e) {
    status.textContent = `Could not compute: ${(e as Error).message}`;
    btn.disabled = false;
  }
}

function wire() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-verify]")) b.onclick = () => verify(b);
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-st]")) b.onclick = () => satoTate(b);
  for (const b of document.querySelectorAll<HTMLElement>("[data-download]"))
    b.onclick = (ev) => { ev.preventDefault(); const sp = (window as any).__atlasSpace; if (sp) download(`${sp.label}.json`, sp); };
}

// ---- WebMCP: the atlas as tools for an agent in this browser
const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
const tools = [
  {
    name: "atlas_lookup",
    description: "Look up a newspace (label N.k.a, e.g. 389.2.a) or a Galois orbit of newforms (N.k.a.x, e.g. 389.2.a.e; LMFDB labels, trivial character) in the Sagebrush Atlas. Returns JSON: dimension, characteristic polynomial of the Hecke operator T on the orbit (coefficients from x^0 up), traces tr a_1..a_1000 (decimal strings), Atkin-Lehner signs, sign, CM, the elliptic curve for rational weight-2 forms, provenance. Spaces that are not stored are computed in this browser (seconds at level ~1000).",
    inputSchema: { type: "object", properties: { label: { type: "string", description: "N.k.a or N.k.a.x" } }, required: ["label"] },
    async execute({ label }: { label: string }) {
      const L = parseLabel(label);
      if (!L) return text(`"${label}" is not a label N.k.a or N.k.a.x (trivial character).`);
      const r = await fetch(href(label) + ".json");
      if (r.ok) return text(await r.json());
      if (L.weight % 2) return text(`${label}: the space is 0 (odd weight, trivial character).`);
      const sp = await computeSpace(L.level, L.weight);
      const f = L.letter ? sp.newforms.find((o) => o.letter === L.letter) : null;
      if (L.letter && !f) return text(`${spaceLabel(L.level, L.weight)} has ${sp.newforms.length} orbits; no ${label}.`);
      return text(f ? { ...f, space: sp.label, T: sp.T, status: sp.status, computed: "browser" } : sp);
    },
  },
  {
    name: "atlas_search",
    description: "Search the stored newform orbits (weight 2, level <= 1000; weights 4-12 with N k^2 <= 4000). Ranges are like \"1-100\". Returns at most `limit` rows {label, level, weight, dim, cm, sign, traces tr a_1..a_10, curve {cremona, rank, torsion}} and the total.",
    inputSchema: {
      type: "object",
      properties: {
        weight: { type: "string" }, level: { type: "string" }, dim: { type: "string" },
        cm: { type: "string", enum: ["yes", "no"] }, sign: { type: "string", enum: ["1", "-1"] },
        rank: { type: "string", description: "rank of the elliptic curve (rational weight-2 forms)" },
        limit: { type: "number" }, start: { type: "number" },
      },
    },
    async execute(q: Record<string, unknown>) {
      const p = new URLSearchParams({ format: "json" });
      for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== "") p.set(k, String(v));
      return text(await (await fetch("/atlas/mf/?" + p)).json());
    },
  },
  {
    name: "atlas_compute",
    description: "Compute the newspace S_k^new(Gamma_0(N)) in this browser with Sagebrush's engine (proven: certified dimensions, exact characteristic polynomials by CRT), whether or not the atlas stores it. Returns the orbits with LMFDB labels, dimensions, characteristic polynomials and tr a_1..a_1000.",
    inputSchema: { type: "object", properties: { level: { type: "number" }, weight: { type: "number" } }, required: ["level"] },
    async execute({ level, weight = 2 }: { level: number; weight?: number }) {
      return text(await computeSpace(level, weight));
    },
  },
];

wire();
const box = $("[data-compute]");
if (box) computePage(box);
try {
  const mc = (navigator as any).modelContext;
  if (mc?.registerTool) for (const t of tools) mc.registerTool(t);
  else if (mc?.provideContext) mc.provideContext({ tools });
} catch (e) {
  console.warn("WebMCP:", e);
}
(window as any).atlas = { computeSpace, call };
