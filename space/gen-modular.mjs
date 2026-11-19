// "Lay out in 3D the Rust code related to modular forms in Sagebrush, so I can browse it, with sample code I can
// run": the crates (modsym, hmf, ap, lfun: each file, linked by mod / use crate:: / use super:: and by other crates'
// names), the Python layers that call them (Sage mode's modular forms and Hilbert modular forms, and the engine's
// Python API), a note per crate from its own docs, and Sage samples with their real output.  Writes
// public/modular-forms.space.json.     node gen-modular.mjs [REPO]   (then: node layout-cli.mjs public/modular-forms.space.json)
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(process.argv[2] ?? join(here, ".."));
const CRATES = { modsym: "Modular symbols over Gamma0(N): Hecke operators, characteristic polynomials, newforms",
  hmf: "Hilbert modular forms over Q(sqrt 5)", ap: "a_p of elliptic curves, by point counting", lfun: "L-functions" };
const PY = ["lib/_sage_modular.py", "lib/_sage_hmf.py", "lib/sagebrush/mf.py", "lib/sagebrush/modsym.py", "lib/sagebrush/ap.py", "lib/sagebrush/_engine.py"];
// (which crate each Python file calls into, through the engine's call table: sagebrush._engine.call)
const BRIDGE = { "lib/sagebrush/mf.py": "modsym", "lib/sagebrush/modsym.py": "modsym", "lib/sagebrush/ap.py": "ap", "lib/_sage_hmf.py": "hmf" };

const nodes = [], edges = [], ids = new Map(), seen = new Set();
const idOf = (rel) => ids.get(rel);
const link = (a, b, label) => {
  if (!a || !b || a === b) return;
  const k = a + ">" + b;
  if (!seen.has(k)) (seen.add(k), edges.push({ from: a, to: b, ...(label ? { label } : {}) }));
};

// ---- the Rust files
const rust = [];
for (const crate of Object.keys(CRATES)) {
  const src = join(repo, "engine", crate, "src");
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".rs")) rust.push({ crate, rel: relative(repo, p), src });
    }
  })(src);
}
for (const f of [...rust, ...PY.filter((p) => existsSync(join(repo, p))).map((rel) => ({ rel }))]) {
  const text = readFileSync(join(repo, f.rel), "utf8"), lines = text.split("\n");
  const id = "f" + nodes.length;
  ids.set(f.rel, id);
  const sub = f.crate ? relative(f.src, dirname(join(repo, f.rel))) : "";
  nodes.push({
    id, kind: "file", title: f.rel, lang: f.rel.endsWith(".rs") ? "rust" : "python", lines: lines.length,
    group: f.crate ? "engine/" + f.crate + (sub ? "/" + sub.split("/")[0] : "") : f.rel.startsWith("lib/sagebrush/") ? "Python: the engine's API" : "Python: Sage mode",
    text: lines.slice(0, 60).join("\n"), _src: text, _f: f,
  });
}
// a Rust file's module path, and the file of a module path (src/a.rs or src/a/mod.rs)
const modPath = (f) => {
  const r = relative(f.src, join(repo, f.rel)).replace(/\.rs$/, "").split("/");
  if (["lib", "main"].includes(r.at(-1)) && r.length === 1) return [];
  if (r.at(-1) === "mod") r.pop();
  return r;
};
const fileOf = (f, path) => {
  for (let n = path.length; n >= 0; n--) {
    const base = join(f.src, ...path.slice(0, n));
    for (const c of n ? [base + ".rs", join(base, "mod.rs")] : [join(f.src, "lib.rs")]) {
      const rel = relative(repo, c);
      if (ids.has(rel)) return rel;
    }
  }
  return null;
};
for (const nd of nodes) {
  const f = nd._f, text = nd._src;
  if (f.crate) {
    const me = modPath(f);
    for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) link(nd.id, idOf(fileOf(f, [...me, m[1]])), "mod");
    for (const m of text.matchAll(/\bcrate::((?:\w+::)*\w+)/g)) link(nd.id, idOf(fileOf(f, m[1].split("::"))));
    for (const m of text.matchAll(/\bsuper::((?:\w+::)*\w+)/g)) link(nd.id, idOf(fileOf(f, [...me.slice(0, -1), ...m[1].split("::")])));
    for (const m of text.matchAll(/\bsagebrush_(\w+)::/g)) if (CRATES[m[1]] && m[1] !== f.crate) link(nd.id, idOf(`engine/${m[1]}/src/lib.rs`), "uses the crate");
  } else {
    if (/from sagebrush import ([\w ,]+)/.test(text)) for (const n of /from sagebrush import ([\w ,]+)/.exec(text)[1].split(",")) link(nd.id, idOf(`lib/sagebrush/${n.trim().split(" ")[0]}.py`));
    if (/from sagebrush\._engine import|from \._engine import|from \. import _engine/.test(text)) link(nd.id, idOf("lib/sagebrush/_engine.py"));
    for (const m of text.matchAll(/^\s*(?:import|from)\s+(_sage_\w+)/gm)) link(nd.id, idOf(`lib/${m[1]}.py`));
    if (BRIDGE[nd.title]) link(nd.id, idOf(`engine/${BRIDGE[nd.title]}/src/lib.rs`), "calls the engine");
  }
}
for (const nd of nodes) (delete nd._src, delete nd._f);

// ---- a note per crate, from its own documentation (lib.rs's //! lines), beside its lib.rs
for (const [crate, what] of Object.entries(CRATES)) {
  const lib = join(repo, "engine", crate, "src", "lib.rs");
  const doc = readFileSync(lib, "utf8").split("\n").filter((l) => l.startsWith("//!")).map((l) => l.replace(/^\/\/! ?/, "")).join("\n").trim();
  const id = "note-" + crate;
  nodes.push({ id, kind: "note", title: `The ${crate} crate`, group: "engine/" + crate, near: idOf(`engine/${crate}/src/lib.rs`),
    text: `# ${crate}: ${what}\n\n${doc || "(no crate documentation)"}\n\n*From engine/${crate}/src/lib.rs.*` });
  link(id, idOf(`engine/${crate}/src/lib.rs`));
}
nodes.push({ id: "overview", kind: "note", title: "Modular forms in Sagebrush", group: "notes",
  text: "# Modular forms in Sagebrush\n\nThree layers, all Sagebrush's own code:\n\n1. **Sage mode** (`lib/_sage_modular.py`, `lib/_sage_hmf.py`): `ModularSymbols`, `Gamma0`, `newform_orbits`, `HilbertModularForms`, ... with Sage's names and printing.\n2. **The engine's Python API** (`lib/sagebrush/mf.py`, `modsym.py`, `ap.py`): plain functions that call the engine through `_engine.call`.\n3. **The Rust engine** (`engine/modsym`, `engine/hmf`, `engine/ap`, `engine/lfun`): every loop over mathematical data.\n\nThe code samples around this space are **runnable**: click one, change it, and press Shift+Enter." });

// ---- Sage samples, with the output they give (run with sagebrush 0.10.2, Nov 19 2026)
const samples = [
  ["s-hecke23", "Hecke polynomial T_2 on level 23", "ModularSymbols(23).hecke_polynomial(2).factor()", "(x - 3) * (x^2 + x - 1)^2", "engine/modsym/src/lib.rs"],
  ["s-hecke389", "Level 389: T_2's characteristic polynomial", "ModularSymbols(389).hecke_polynomial(2).factor()", "(x - 3) * (x + 2)^2 * (x^2 - 2)^2 * (x^3 - 4*x - 2)^2 * (x^6 + 3*x^5 - ...)^2 * (x^20 - 3*x^19 - ...)^2", "engine/modsym/src/lib.rs"],
  ["s-orbits37", "Newforms of level 37", "newform_orbits(37, 2)", "[37.2.a.a (dimension 1): q - 2*q^2 - 3*q^3 + 2*q^4 - 2*q^5 + O(q^6),\n 37.2.a.b (dimension 1): q + q^3 - 2*q^4 + O(q^6)]", "lib/_sage_modular.py"],
  ["s-dims", "dim S_2(Gamma0(N)), N = 1..30", "[Gamma0(N).dimension_cusp_forms(2) for N in range(1, 31)]", "[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 2, 2, 1, 0, 2, 1, 2, 2, 3]", "lib/_sage_modular.py"],
  ["s-ap11", "a_p of the curve 11a1", "E = EllipticCurve('11a1')\n[E.ap(p) for p in primes(50)]", "[-2, -1, 1, -2, 1, 4, -2, 0, -1, 0, 7, 3, -8, -6, 8]", "engine/ap/src/lib.rs"],
  ["s-hmf31", "Hilbert modular forms of level 31", "from _sage_hmf import HilbertModularForms\nH = HilbertModularForms(31)\nH, H.dimension()", "(Hilbert modular forms of dimension 20, level 31 (of norm 961=31^2) over QQ(sqrt(5)), 20)", "engine/hmf/src/lib.rs"],
];
for (const [id, title, text, output, near] of samples) {
  nodes.push({ id, kind: "code", title, lang: "sage", text, output, group: "samples", near: idOf(near) });
  link("overview", id);
  link(id, idOf(near));
}
// ---- a 3D plot: dim S_k(Gamma0(N)) over N and k (computed by Sagebrush: dims.json)
const dims = JSON.parse(readFileSync(join(here, "dims.json"), "utf8"));
nodes.push({ id: "p-dims", kind: "plot3d", title: "dim S_k(Gamma0(N)): N = 1..40, k = 2..24", lang: "sage", group: "samples", near: "s-dims",
  text: "pts = [(N, k, Gamma0(N).dimension_cusp_forms(k) / 3)\n       for N in range(1, 41) for k in range(2, 26, 2)]\npoint3d(pts, size=8, color='purple')",
  surface: { x: dims.N, y: dims.k, z: dims.dim } });
link("s-dims", "p-dims");
link("overview", "p-dims");

const space = { format: "sagebrush-space", version: 1, title: "Modular forms in Sagebrush: the Rust engine, the Python layers, and samples to run", nodes, edges };
const out = join(here, "public", "modular-forms.space.json");
writeFileSync(out, JSON.stringify(space) + "\n");
console.log(out, nodes.length, "nodes,", edges.length, "links");
