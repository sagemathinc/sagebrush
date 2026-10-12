// Differential test of web/board/mermaid.ts against Mermaid itself: every
// flowchart in a corpus is parsed by both (Mermaid's parser in headless
// Chromium, CHROME=...), and the nodes, edges (ends, labels, line style)
// and subgraphs (titles, members) are compared.
//   node web/board/test-mermaid.mjs MERMAID_DIR CORPUS...
// MERMAID_DIR holds node_modules/mermaid (npm i mermaid); each CORPUS is a
// .mmd file, a directory of them (recursively), or a Markdown file whose
// ```mermaid blocks are read.  VERBOSE=1 lists every difference.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [mermaidDir, ...inputs] = process.argv.slice(2);
if (!mermaidDir || !inputs.length) { console.error("usage: node web/board/test-mermaid.mjs MERMAID_DIR CORPUS..."); process.exit(2); }
const corpus = [];
const add = (p) => {
  if (statSync(p).isDirectory()) { for (const f of readdirSync(p)) add(join(p, f)); return; }
  const text = readFileSync(p, "utf8");
  if (extname(p) === ".mmd") { if (/^\s*(graph|flowchart)\b/m.test(text.replace(/^---[\s\S]*?\n---\n/, ""))) corpus.push({ name: p, text }); }
  else if (extname(p) === ".md") [...text.matchAll(/```mermaid(?:-example)?\n([\s\S]*?)\n```/g)].forEach((m, i) => /^\s*(graph|flowchart)\b/m.test(m[1]) && corpus.push({ name: `${p}#${i}`, text: m[1] }));
};
for (const p of inputs) add(p);

// the page: Mermaid, and ours bundled
const dir = mkdtempSync(join(tmpdir(), "sb-mermaid-"));
const b = spawnSync("bun", ["build", join(here, "mermaid.ts"), "--format", "esm", "--outfile", join(dir, "mine.js")], { encoding: "utf8" });
if (b.status) { console.error(b.stderr); process.exit(1); }
copyFileSync(join(mermaidDir, "node_modules/mermaid/dist/mermaid.min.js"), join(dir, "mermaid.min.js"));
writeFileSync(join(dir, "index.html"), `<!doctype html><script src="mermaid.min.js"></script><script type="module">import * as mine from "./mine.js"; window.mine = mine; mermaid.initialize({ startOnLoad: false }); window.ready = true;</script>`);
const server = createServer((req, res) => {
  let body;
  const f = join(dir, req.url.split("?")[0].replace(/^\/$/, "/index.html"));
  try { body = readFileSync(f); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" });
  res.end(body);
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const port = 9471, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "sb-mm-prof-"));
const chrome = spawn(process.env.CHROME ?? "chromium", ["--headless", "--no-sandbox", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let targets;
for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(100); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0; const waiting = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value; };
await send("Page.navigate", { url });
for (let i = 0; i < 100 && !(await ev("!!window.ready").catch(() => false)); i++) await sleep(100);

// in the page: both parses, normalized
const compare = async (text) => ev(`(async () => {
  const text = ${JSON.stringify(text)};
  // (labels compared as plain text)
  const ta = document.createElement("textarea");
  const decode = (s) => { ta.innerHTML = String(s ?? "").replace(/ﬂ°°(\\d+)¶ß/g, "&#$1;").replace(/ﬂ°(\\w+)¶ß/g, "&$1;").replace(/#(\\d+);/g, "&#$1;").replace(/#([a-z]+);/gi, "&$1;").replace(/</g, "&lt;"); return ta.value; };
  const norm = (s) => decode(String(s ?? "").replace(/<br\\s*\\/?>|\\\\n/gi, " ").replace(/<\\/?[a-z][^>]*>/gi, "")).replace(/\\\\([*_\`\\\\.#>+-])/g, "$1").replace(/[*_\`"]/g, "").replace(/\\bfa[bsrl]?:fa-[\\w-]+/g, "").replace(/\\s+/g, " ").trim();
  let theirs;
  try {
    const d = await mermaid.mermaidAPI.getDiagramFromText(text);
    if (!/flowchart/.test(d.type)) return { skip: d.type };
    const db = d.db, sgs = db.getSubGraphs(), sgIds = new Set(sgs.map((s) => s.id));
    const verts = [...db.getVertices().values()].filter((v) => !sgIds.has(v.id));
    theirs = {
      nodes: verts.map((v) => v.id + "=" + (norm(v.text) || norm(v.id))).sort(),
      edges: db.getEdges().map((e) => e.start + ">" + e.end + "|" + norm(e.text) + "|" + (e.stroke === "invisible" ? "hidden" : e.stroke === "normal" ? "" : e.stroke)).sort(),
      subs: sgs.map((s) => s.id + "=" + norm(s.title) + ":" + [...new Set(s.nodes)].sort().join(",")).sort(),
    };
  } catch (e) { return { theirError: String(e).slice(0, 200) }; }
  let ours;
  try {
    const d = mine.fromMermaid(text), notes = [], subs = [];
    const walk = (ns) => { for (const n of ns) { if (n.kind === "group") { subs.push(n.id + "=" + norm(n.title) + ":" + n.children.map((c) => c.id).sort().join(",")); walk(n.children); } else notes.push(n.id + "=" + norm(n.text)); } };
    walk(d.nodes);
    ours = { nodes: notes.sort(), edges: d.edges.map((e) => e.from + ">" + e.to + "|" + norm(e.label) + "|" + (e.hidden ? "hidden" : e.line ?? "")).sort(), subs: subs.sort() };
  } catch (e) { return { theirs, ourError: String(e).slice(0, 200) }; }
  const diff = {};
  for (const k of ["nodes", "edges", "subs"]) {
    const a = theirs[k].join("\\n"), b = ours[k].join("\\n");
    if (a !== b) diff[k] = { theirs: theirs[k].filter((x) => !ours[k].includes(x)).slice(0, 4), ours: ours[k].filter((x) => !theirs[k].includes(x)).slice(0, 4) };
  }
  return { diff, counts: [theirs.nodes.length, theirs.edges.length, theirs.subs.length] };
})()`);

const tally = { same: 0, differ: 0, ourError: 0, theirError: 0, skipped: 0 }, kinds = { nodes: 0, edges: 0, subs: 0 };
const shown = [];
try {
  for (const c of corpus) {
    const r = await compare(c.text);
    if (r.skip) { tally.skipped++; continue; }
    if (r.theirError) { tally.theirError++; continue; } // (not valid Mermaid: nothing to match)
    if (r.ourError) { tally.ourError++; shown.push(`${c.name}: ours failed: ${r.ourError}`); continue; }
    const ks = Object.keys(r.diff);
    if (!ks.length) { tally.same++; continue; }
    tally.differ++;
    for (const k of ks) kinds[k]++;
    shown.push(`${c.name}: ${ks.map((k) => `${k} theirs ${JSON.stringify(r.diff[k].theirs)} ours ${JSON.stringify(r.diff[k].ours)}`).join("; ")}`);
  }
} finally {
  ws.close(); chrome.kill(); server.close();
  try { rmSync(profile, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); } catch {}
}
for (const s of shown.slice(0, process.env.VERBOSE ? 1e9 : 25)) console.log(s.slice(0, 600));
console.log(JSON.stringify({ corpus: corpus.length, ...tally, differIn: kinds }));
const min = Number(process.env.MIN_SAME ?? 0);
if (tally.ourError || (min && tally.same / Math.max(1, tally.same + tally.differ) < min)) process.exit(1);
