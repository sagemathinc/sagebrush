// Generated example boards (web/board/examples/index.json lists them with
// the hand-written ones), written by web/build.ts into dist/board/examples:
//
//   integers.json  the integers to 10,000: each a note with its factorization
//                  and arithmetic functions in LaTeX, by hundreds and thousands
//                  (10,000 notes: how a large board feels)
//   source.json    Sagebrush's source, file by file: each file's opening
//                  comment, linked to GitHub; directories as groups, imports
//                  as edges (within a directory) or counted (between them)
//
//   node scripts/board-examples.mjs OUTDIR
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname, basename, extname } from "node:path";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const out = process.argv[2] ?? join(root, "web", "dist", "board", "examples");

// ---------------------------------------------------------------- integers

function factor(n) {
  const f = [];
  for (let p = 2; p * p <= n; p++) {
    let e = 0;
    while (n % p === 0) { n /= p; e++; }
    if (e) f.push([p, e]);
  }
  if (n > 1) f.push([n, 1]);
  return f;
}

function integers(N = 10000) {
  const PALETTE = ["#ffffff", "#d9ecd0", "#e3edf8", "#f6ead0", "#f3dede", "#e8def3", "#efefef"];
  const thousands = [];
  for (let t = 0; t < N / 1000; t++) {
    const hundreds = [];
    for (let h = 0; h < 10; h++) {
      const notes = [];
      for (let i = 1; i <= 100; i++) {
        const n = t * 1000 + h * 100 + i;
        const f = factor(n);
        const omega = f.reduce((s, [, e]) => s + e, 0);
        const tex = n === 1 ? "1" : f.map(([p, e]) => (e > 1 ? `${p}^{${e}}` : `${p}`)).join(" \\cdot ");
        const tau = f.reduce((s, [, e]) => s * (e + 1), 1);
        const sigma = f.reduce((s, [p, e]) => s * ((p ** (e + 1) - 1) / (p - 1)), 1);
        const phi = f.reduce((s, [p, e]) => s * (p - 1) * p ** (e - 1), 1);
        const mu = f.some(([, e]) => e > 1) ? 0 : f.length % 2 ? -1 : 1;
        const prime = f.length === 1 && f[0][1] === 1;
        notes.push({
          id: `n${n}`,
          title: prime ? `${n} · prime` : String(n),
          text: n === 1 ? "the unit" : prime ? `$p = ${n}$` : `$${n} = ${tex}$`,
          detail: `$\\tau = ${tau}$, $\\sigma = ${sigma}$, $\\varphi = ${phi}$, $\\mu = ${mu}$` + (sigma === 2 * n ? " — **perfect**" : ""),
          color: prime ? "#cfe8c4" : PALETTE[Math.min(omega, PALETTE.length - 1)],
          w: 220, h: 124,
        });
      }
      hundreds.push({ id: `h${t}${h}`, kind: "group", title: `${t * 1000 + h * 100 + 1}–${t * 1000 + h * 100 + 100}`, layout: "grid", columns: 10, children: notes });
    }
    thousands.push({ id: `t${t}`, kind: "group", title: `${t * 1000 + 1} to ${(t + 1) * 1000}`, layout: "grid", columns: 5, color: t % 2 ? "#eef2ea" : "#f1eee6", children: hundreds });
  }
  return {
    title: `The integers to ${N.toLocaleString("en")}`,
    intro: `**${N.toLocaleString("en")} notes**, each an integer with its factorization; zoom in for $\\tau$, $\\sigma$, $\\varphi$ and $\\mu$. Primes are green, and the more prime factors, the warmer the color. Zoom out until the thousands are labels, then fly in anywhere.`,
    layout: "grid",
    columns: 2,
    nodes: thousands,
    steps: [
      { focus: "t0", say: "The first thousand: **168 primes**, green." },
      { focus: ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11", "n12"], say: "Close up, each note shows its factorization, and its detail: the number of divisors $\\tau$, their sum $\\sigma$, Euler's $\\varphi$ and Möbius' $\\mu$." },
      { focus: ["n6", "n28", "n496", "n8128"], say: "The four perfect numbers below $10^4$, where $\\sigma(n) = 2n$: $6$, $28$, $496$ and $8128$." },
      { focus: "n1729", say: "$1729 = 7 \\cdot 13 \\cdot 19$, Ramanujan's taxicab number: $1729 = 1^3 + 12^3 = 9^3 + 10^3$." },
      { focus: `t${N / 1000 - 1}`, say: `The last thousand, to ${N.toLocaleString("en")}.` },
    ],
  };
}

// ---------------------------------------------------------------- source map

const SKIP = /(_data\.ts|kernels_wasm\.ts|\.min\.js|\.d\.ts)$/;
function files(dir, exts, depth = 4) {
  const r = [];
  if (!existsSync(dir)) return r;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || ["node_modules", "dist", "target", "__pycache__", "tests", "benches", "examples"].includes(name)) continue;
    const p = join(dir, name), s = statSync(p);
    if (s.isDirectory()) { if (depth > 0) r.push(...files(p, exts, depth - 1)); }
    else if (exts.includes(extname(name)) && !SKIP.test(name)) r.push(p);
  }
  return r;
}

// a file's opening comment, as one or two sentences
function summary(text, ext) {
  const lines = text.split("\n");
  let body = [];
  if (ext === ".py") {
    const m = /^(?:#.*\n)*\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text);
    if (m) body = m[1].split("\n");
    else for (const l of lines) { if (/^#/.test(l)) body.push(l.replace(/^#!?\s?/, "")); else if (body.length || l.trim()) break; }
  } else {
    for (const l of lines) {
      const m = /^\s*(\/\/[!/]?|\*|\/\*\*?)\s?(.*)$/.exec(l);
      if (m && !/^\s*\*\//.test(l)) body.push(m[2].replace(/\*\/\s*$/, ""));
      else if (body.length || l.trim()) break;
    }
  }
  const s = body.join(" ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // (sentences end at . ! ? followed by a space or the end, not inside "notebook.js")
  const sentences = s.match(/.+?[.!?](?=\s|$)/g)?.map((x) => x + " ") ?? [s];
  let t = "";
  for (const x of sentences) { if ((t + x).length > 260 && t) break; t += x; }
  return (t || s).trim().slice(0, 300);
}

function sourceMap() {
  const sets = [
    ["src", "The compiler and the notebook's engine (TypeScript)", files(join(root, "src"), [".ts"], 0)],
    ["src/runtime", "The runtime (TypeScript)", files(join(root, "src", "runtime"), [".ts"], 0)],
    ["lib", "Python and Sage library", files(join(root, "lib"), [".py"], 2)],
    ["web", "The web page", files(join(root, "web"), [".ts"], 0)],
    ["web/notebook", "The notebook component", files(join(root, "web", "notebook"), [".js", ".ts"], 0)],
    ["web/board", "Boards", files(join(root, "web", "board"), [".ts"], 0)],
    ["scripts", "Build scripts", files(join(root, "scripts"), [".mjs", ".ts", ".sh"], 0)],
  ];
  for (const crate of readdirSync(join(root, "engine")).sort()) {
    const src = join(root, "engine", crate, "src");
    if (existsSync(src)) sets.push([`engine/${crate}`, `Rust crate sagebrush-${crate}`, files(src, [".rs"], 3)]);
  }
  const idOf = (p) => "f:" + relative(root, p);
  const groupOf = new Map(); // file id -> group id
  const all = new Map(); // file id -> {path, text}
  const groups = [];
  for (const [dir, title, fs] of sets) {
    if (!fs.length) continue;
    const gid = "g:" + dir;
    const children = [];
    for (const p of fs) {
      const text = readFileSync(p, "utf8"), ext = extname(p), id = idOf(p);
      const lines = text.split("\n").length;
      all.set(id, { path: p, text, ext });
      groupOf.set(id, gid);
      children.push({
        id, title: relative(join(root, dir), p), text: summary(text, ext) || "*(no opening comment)*",
        detail: `${lines.toLocaleString("en")} lines`, ref: relative(root, p),
        color: { ".ts": "#e3edf8", ".py": "#f6ead0", ".rs": "#f3dede", ".js": "#e8f1e1", ".mjs": "#eeeeee", ".sh": "#eeeeee" }[ext],
        w: 250,
      });
    }
    groups.push({ id: gid, kind: "group", title: `${dir}/ — ${title}`, layout: children.length > 24 ? "grid" : "graph", direction: "LR", children });
  }
  // imports
  const edges = [], between = new Map();
  const byPath = new Map([...all].map(([id, f]) => [f.path, id]));
  const libMods = new Map([...all].filter(([, f]) => f.ext === ".py").map(([id, f]) => [relative(join(root, "lib"), f.path).replace(/(\/__init__)?\.py$/, "").replace(/\//g, "."), id]));
  const crateLib = new Map(sets.filter(([d]) => d.startsWith("engine/")).map(([d]) => [d.slice(7), idOf(join(root, d, "src", "lib.rs"))]));
  for (const [id, f] of all) {
    const targets = new Set();
    if (f.ext === ".ts" || f.ext === ".js" || f.ext === ".mjs") {
      for (const m of f.text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const base = join(dirname(f.path), m[1]);
        for (const c of [base, base + ".ts", base + ".js", base + ".mjs", join(base, "index.ts")]) if (byPath.has(c)) { targets.add(byPath.get(c)); break; }
      }
    } else if (f.ext === ".py") {
      for (const m of f.text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const mod = (m[1] ?? m[2]).replace(/^\./, "");
        for (let k = mod; k; k = k.includes(".") ? k.slice(0, k.lastIndexOf(".")) : "") if (libMods.has(k)) { targets.add(libMods.get(k)); break; }
      }
    } else if (f.ext === ".rs") {
      for (const m of f.text.matchAll(/\bsagebrush_(\w+)::/g)) if (crateLib.has(m[1])) targets.add(crateLib.get(m[1]));
      for (const m of f.text.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) {
        const d = dirname(f.path);
        for (const c of [join(d, m[1] + ".rs"), join(d, m[1], "mod.rs"), join(d, basename(f.path, ".rs"), m[1] + ".rs")]) if (byPath.has(c)) { targets.add(byPath.get(c)); break; }
      }
    }
    targets.delete(id);
    for (const t of targets) {
      const a = groupOf.get(id), b = groupOf.get(t);
      if (a === b) edges.push({ from: id, to: t });
      else between.set(a + "\0" + b, (between.get(a + "\0" + b) ?? 0) + 1);
    }
  }
  for (const [k, n] of between) {
    const [a, b] = k.split("\0");
    edges.push({ from: a, to: b, label: `${n} import${n > 1 ? "s" : ""}` });
  }
  const nfiles = all.size;
  return {
    title: "Sagebrush's source, file by file",
    intro: `**${nfiles} source files**, each with its opening comment and a link to it on GitHub; directories are groups, imports are edges (counted between directories). Zoom in for line counts. Generated from the repository by scripts/board-examples.mjs.`,
    refBase: "https://github.com/sagemathinc/sagebrush/blob/master/",
    layout: "graph",
    nodes: groups,
    edges,
  };
}

// ---------------------------------------------------------------- write

for (const [name, doc] of [["integers.json", integers()], ["source.json", sourceMap()]]) {
  const json = JSON.stringify(doc);
  writeFileSync(join(out, name), json);
  console.log(`${name}: ${(json.length / 1e6).toFixed(2)} MB`);
}
