// bench/latex/run.mjs: real LaTeX (latexmk) against Sagebrush's LaTeX preview, on the same documents (corpus.json).
// For each document and run:
//   - oracle: latexmk in a fresh folder, cold (no .aux), then again after a one-character edit;
//   - cli: `sagebrush latex render FILE.tex` (the preview as one HTML file, node's start included);
//   - browser: the editor page from web/dist in a fresh headless Chrome (new profile, HTTP cache off): from the
//     navigation to the first tex-paint (the whole preview shown), then one typed character's tex-input to the
//     tex-paint of its revision (web/latex/editor.ts's marks).
// Each run waits until the 1-minute load is under --max-load first. Writes results.json (every run), table.md, and,
// from the first run of each document, its PDF, the preview's text and the check report, for fidelity.mjs.
//   node bench/latex/run.mjs [--docs C0,C2] [--runs 5] [--parts oracle,cli,browser] [--out DIR]
//   (README.md: the builds it needs, and CHROME, CLI and WEB_DIST)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { devtoolsPort } from "../../web/test-port.mjs";
import { fidelity } from "./fidelity.mjs";

const here = new URL(".", import.meta.url).pathname, root = join(here, "..", "..");
const arg = (name, dflt) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : dflt; };
const corpus = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8")).docs;
const want = arg("docs", null)?.split(",");
const docs = want ? want.map((id) => corpus.find((d) => d.id === id) ?? fail(`no document ${id} in corpus.json`)) : corpus;
const RUNS = Number(arg("runs", "5")), PARTS = arg("parts", "oracle,cli,browser").split(","), MAX_LOAD = Number(arg("max-load", "1"));
const CACHE = arg("corpus", join(here, "corpus-cache"));
const OUT = arg("out", join(here, "results", new Date().toISOString().slice(0, 10)));
const CLI = process.env.CLI ?? join(root, "build", "cli", "pyjs.cjs");
const DIST = process.env.WEB_DIST ?? join(root, "web", "dist");
const CHROME = process.env.CHROME ?? "google-chrome";
const PAINT_MS = Number(process.env.BENCH_PAINT_MS ?? 300_000);
if (!arg("report", null)) { mkdirSync(CACHE, { recursive: true }); mkdirSync(OUT, { recursive: true }); }
const step = (what) => { if (process.env.BENCH_VERBOSE) console.error(`  ${new Date().toISOString().slice(11, 23)} ${what}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fail(why) { console.error("run.mjs: " + why); process.exit(2); }
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---- the documents: each a folder in the cache, fetched once and checked, or generated; `main` is its .tex
const GEN = {
  // web/latex/test-latex-page.mjs's CJK fixture (1500 lines of 100 words), in ctexart: TeX needs CJK fonts to set it
  cjk: () => "\\documentclass{ctexart}\n\\begin{document}\n" + Array.from({ length: 1500 }, () => "中文字体 ".repeat(100).trimEnd()).join("\n") + "\n\\end{document}\n",
  // the same lines as 1500 paragraphs (TeX holds a whole paragraph in memory: the one-paragraph form exceeds it)
  "cjk-paragraphs": () => "\\documentclass{ctexart}\n\\begin{document}\n" + Array.from({ length: 1500 }, () => "中文字体 ".repeat(100).trimEnd()).join("\n\n") + "\n\\end{document}\n",
};
async function pinned(id, url, want) {
  const r = await fetch(url);
  if (!r.ok) fail(`${id}: ${url}: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (sha256(b) !== want) fail(`${id}: ${url}: sha256 ${sha256(b)}, not the pinned ${want}`);
  return b;
}
// The document's folder and its main file. Forms (corpus.json): url (one file), files (several, each pinned), archive
// (a .tar.gz, pinned; arXiv's sources), example (one of web/latex/examples.ts's), gen; and `write`, files written into
// the folder (a wrapper). transcode "latin1": the main file as UTF-8, its inputenc option too, for every part alike
// (the editor opens only UTF-8).
async function source(d) {
  const dir = join(CACHE, d.id), orig = join(CACHE, "orig", d.id);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); mkdirSync(orig, { recursive: true });
  const put = (rel, b) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), b); };
  const cached = async (rel, url, want) => {
    const o = join(orig, rel);
    if (!existsSync(o) || sha256(readFileSync(o)) !== want) { const b = await pinned(d.id, url, want); mkdirSync(dirname(o), { recursive: true }); writeFileSync(o, b); }
    return readFileSync(o);
  };
  let main = d.main ?? d.file;
  if (d.gen) put(main, GEN[d.gen]());
  if (d.url) put(main, await cached(main, d.url, d.sha256));
  for (const f of d.files ?? []) put(f.path, await cached(f.path, f.url, f.sha256));
  if (d.archive) {
    const b = await cached("source.tar.gz", d.archive.url, d.archive.sha256);
    writeFileSync(join(orig, "source.tar.gz"), b);
    const x = spawnSync("tar", ["xzf", join(orig, "source.tar.gz"), "-C", dir], { encoding: "utf8" });
    if (x.status !== 0) fail(`${d.id}: tar: ${x.stderr}`);
  }
  if (d.example) {
    // (as a .mts copy: node strips its types, and loads it as an ES module whatever the nearest package.json says)
    const mts = join(CACHE, "examples.mts");
    copyFileSync(join(root, "web", "latex", "examples.ts"), mts);
    const { EXAMPLES } = await import(mts);
    const ex = EXAMPLES.find((e) => e.id === d.example) ?? fail(`${d.id}: no example ${d.example}`);
    for (const [name, text, b64] of ex.files) put(name, b64 ? Buffer.from(text, "base64") : text);
    main = ex.files[0][0];
  }
  for (const [rel, text] of Object.entries(d.write ?? {})) put(rel, text);
  // (wrap: a main file made from another's preamble, up to its \begin{document} line, and some lines of our own)
  if (d.wrap) {
    const lines = readFileSync(join(dir, d.wrap.from), "utf8").split("\n"), k = lines.findIndex((l) => l.startsWith(d.wrap.until));
    if (k < 0) fail(`${d.id}: no ${d.wrap.until} in ${d.wrap.from}`);
    put(d.wrap.path, (d.wrap.prepend ?? "") + lines.slice(0, k + 1).join("\n") + "\n" + (d.wrap.append ?? ""));
  }
  if (d.transcode === "latin1") { const p = join(dir, main), b = readFileSync(p); writeFileSync(p, Buffer.from(b.toString("latin1").replace("\\usepackage[latin1]{inputenc}", "\\usepackage[utf8]{inputenc}"), "utf8")); }
  // (prepare: commands run once in the folder, untimed: sagetex.sty made from its .ins, as Sage's install makes it)
  for (const cmd of d.prepare ?? []) { const r = spawnSync(cmd[0], cmd.slice(1), { cwd: dir, encoding: "utf8" }); if (r.status !== 0) fail(`${d.id}: ${cmd.join(" ")}: ${(r.stdout + r.stderr).slice(-400)}`); }
  if (!existsSync(join(dir, main))) fail(`${d.id}: no main file ${main}`);
  return { dir, main };
}
/** Every file under a folder, as paths relative to it. */
const filesUnder = (dir, rel = "") => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesUnder(dir, join(rel, e.name)) : [join(rel, e.name)]);
const editAt = (text, d) => { const i = text.indexOf(d.edit.after); if (i < 0) fail(`${d.id}: the edit's anchor is not in the file`); return i + d.edit.after.length; };

// ---- each run starts on a quiet machine
async function quiet() {
  const t = Date.now();
  while (loadavg()[0] >= MAX_LOAD) { if (Date.now() - t > 600_000) fail(`load ${loadavg()[0]} still not under ${MAX_LOAD} after 10 minutes`); await sleep(5000); }
  return loadavg()[0];
}
const timed = (cmd, args, cwd, env) => { const t = process.hrtime.bigint(); const r = spawnSync(cmd, args, { cwd, env: env ? { ...process.env, ...env } : undefined, encoding: "utf8", maxBuffer: 64 << 20 }); return { ms: Number(process.hrtime.bigint() - t) / 1e6, rc: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }; };
const pdfPages = (pdf) => Number(/Pages:\s+(\d+)/.exec(spawnSync("pdfinfo", [pdf], { encoding: "utf8" }).stdout ?? "")?.[1] ?? NaN);
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;

// ---- the oracle: latexmk, cold, then after the edit (latexmk reruns what the edit needs). oracle.args: more latexmk
// options (-shell-escape); oracle.env: its environment (TEXINPUTS); oracle.cycle: the code step between latexmk runs
// (pythontex, or sage on FILE.sagetex.sage), then latexmk again, all of it timed as one compile, as a person runs it
function oracle(d, src, i) {
  const tmp = mkdtempSync(join(tmpdir(), "sb-latex-bench-"));
  try {
    cpSync(src.dir, tmp, { recursive: true });
    const o = d.oracle ?? {}, cwd = join(tmp, dirname(src.main)), file = basename(src.main), base = file.replace(/\.tex$/, "");
    const outdir = o.outdir ? join(tmp, o.outdir) : cwd;
    const rule = { pdf: "-pdf", xelatex: "-xelatex", lualatex: "-lualatex" }[d.engine];
    const env = o.env ? Object.fromEntries(Object.entries(o.env).map(([k, v]) => [k, v.replaceAll("$DIR", tmp)])) : undefined;
    const latexmk = () => timed("latexmk", [rule, "-interaction=nonstopmode", ...(o.args ?? []), ...(o.outdir ? [`-outdir=${outdir}`] : []), file], cwd, env);
    const step2 = o.cycle === "pythontex" ? () => timed("pythontex", [base], cwd, env)
      : o.cycle === "sagetex" && has("sage") ? () => timed("sage", [`${base}.sagetex.sage`], cwd, env) : null;
    const compile = () => {
      const a = latexmk();
      if (!step2) return a;
      const b = step2(), c = latexmk();
      return { ms: a.ms + b.ms + c.ms, rc: a.rc || b.rc || c.rc, out: a.out + b.out + c.out, cycle_rc: b.rc };
    };
    const cold = compile(), passes = (cold.out.match(/Run number \d+ of rule/g) ?? []).length;
    const pdf = join(outdir, base + ".pdf"), pages = pdfPages(pdf);
    const note = o.cycle === "sagetex" && !step2 ? "no sage here: TeX only, the \\sage results are ??" : undefined;
    if (i === 0 && existsSync(pdf)) copyFileSync(pdf, join(OUT, `${d.id}.pdf`));
    const errs = (s) => { try { return [...new Set(readFileSync(join(outdir, base + ".log"), "latin1").replace(/\r/g, "").match(/^! .*$/gm) ?? [])].filter((l) => !/ Warning: /.test(l)).slice(0, 3); } catch { return []; } };
    if (!existsSync(pdf)) return { cold_ms: cold.ms, cold_rc: cold.rc, passes, error: errs()[0] ?? "no PDF", note };
    const tex_errors = errs();
    const p = d.edit.file ? join(tmp, d.edit.file) : join(cwd, file), text = readFileSync(p, "utf8"), at = editAt(text, d);
    writeFileSync(p, text.slice(0, at) + "x" + text.slice(at));
    const edit = compile(), editPasses = (edit.out.match(/Run number \d+ of rule/g) ?? []).length;
    return { cold_ms: cold.ms, cold_rc: cold.rc, passes, pages, edit_ms: edit.ms, edit_rc: edit.rc, edit_passes: editPasses, ...(cold.cycle_rc !== undefined ? { cycle_rc: cold.cycle_rc } : {}), ...(tex_errors.length ? { tex_errors } : {}), ...(note ? { note } : {}) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- ours, the CLI: the preview as HTML (and check's report, kept from the first run)
function cli(d, src, i) {
  const tmp = mkdtempSync(join(tmpdir(), "sb-latex-bench-"));
  try {
    cpSync(src.dir, tmp, { recursive: true });
    const cwd = join(tmp, dirname(src.main)), file = basename(src.main);
    const r = timed(process.execPath, [CLI, "latex", "render", file, "-o", "sb-bench-out.html"], cwd);
    const c = timed(process.execPath, [CLI, "latex", "check", "--json", file], cwd);
    if (i === 0) { writeFileSync(join(OUT, `${d.id}.check.json`), c.out); if (existsSync(join(cwd, "sb-bench-out.html"))) copyFileSync(join(cwd, "sb-bench-out.html"), join(OUT, `${d.id}.html`)); }
    return { render_ms: r.ms, render_rc: r.rc, check_ms: c.ms, check_rc: c.rc };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ---- ours, the browser: the editor page, a fresh Chrome per run
let serveBase = null;
async function serve() {
  if (serveBase) return serveBase;
  if (!existsSync(join(DIST, "sagebrush-latex.js"))) fail(`no ${DIST}/sagebrush-latex.js: build web/dist first (README.md)`);
  const server = spawn("python3", [join(root, "web", "serve.py"), "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env } });
  process.on("exit", () => server.kill());
  const port = await new Promise((res, rej) => { let acc = ""; server.stdout.on("data", (b) => { acc += b; const m = /(\d{2,5})/.exec(acc); if (m) res(+m[1]); }); setTimeout(() => rej(new Error("no server port")), 15000); });
  return (serveBase = `http://127.0.0.1:${port}/`);
}
async function browser(d, src, i) {
  const base = await serve();
  const profile = mkdtempSync(join(tmpdir(), "sb-latex-bench-chrome-"));
  const chrome = spawn(CHROME, ["--headless", "--no-sandbox", "--remote-debugging-port=0", "--window-size=1400,900", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const port = await devtoolsPort(profile, 60_000, { child: chrome });
    let targets;
    for (let k = 0; k < 300 && !targets; k++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(100); } }
    const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let n = 0; const waiting = new Map(), errors = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result ?? m.error); waiting.delete(m.id); } if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params.exceptionDetails?.exception?.description ?? "").slice(0, 300)); };
    // (Chrome can drop the socket before it answers, Browser.close's above all: what is waiting then gets an error)
    let closed = false;
    ws.onclose = () => { closed = true; for (const r of waiting.values()) r({ code: -1, message: "the DevTools socket closed" }); waiting.clear(); };
    const send = (method, params = {}) => new Promise((r) => { if (closed) return r({ code: -1, message: "the DevTools socket closed" }); const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result?.value; };
    const until = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(50); } return false; };
    for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
    await send("Network.setCacheDisabled", { cacheDisabled: true });
    // the file, made in this profile's workspace from the site's own page
    step("site"); await send("Page.navigate", { url: base });
    if (!(await until(`!!window.sagebrush?.workspace`, 60000))) throw new Error("no workspace");
    // (every file of the folder, its bytes as they are; the main one opened)
    step("create"); let fid = null;
    // (upload "main-dir": only the main file's folder, where the editor looks for its inputs and images)
    const top = d.upload === "main-dir" ? dirname(src.main) : "";
    for (const rel of filesUnder(src.dir, top)) {
      const f = await ev(`window.sagebrush.workspace.create(${JSON.stringify(`/bench/${d.id}/${rel}`)}, { content: Uint8Array.from(atob(${JSON.stringify(readFileSync(join(src.dir, rel)).toString("base64"))}), (c) => c.charCodeAt(0)) }).then((e) => e.fid)`);
      if (rel === src.main) fid = f;
    }
    const text = readFileSync(join(src.dir, src.main), "utf8");
    // the first preview: navigation start (the new document's time origin) to its first tex-paint
    step("open " + fid); await send("Page.navigate", { url: base + "?tex=" + encodeURIComponent(fid) + "&latex=1" });
    if (!(await until(`location.search.includes("tex=") && !!document.querySelector(".tex-page")`, 30000))) return { error: "the editor did not open", page: String(await ev(`document.body.innerText`).catch(() => "")).replace(/\s+/g, " ").slice(0, 400), errors };
    const painted = await until(`location.search.includes("tex=") && performance.getEntriesByName("tex-paint").length > 0`, PAINT_MS);
    if (!painted) return { error: `no tex-paint in ${PAINT_MS / 1000} s`, page: String(await ev(`document.body.innerText`).catch(() => "")).replace(/\s+/g, " ").slice(0, 400), errors };
    // (a document with \input is shown first with each included file "not read yet", then again once the page has read
    //  them: the first preview is that later paint, with no file left to read; the earlier one is kept as
    //  partial_ms. They can be read before this looks, so it doesn't ask whether the preview was partial: it waits until
    //  none is unread and takes the paint then, the latest)
    //  (textContent, not innerText: the preview's pieces off screen aren't laid out, and innerText leaves them out)
    if (!(await until(`!/not read yet/.test(document.querySelector(".tex-preview")?.textContent ?? "")`, PAINT_MS))) return { error: `included files still not read after ${PAINT_MS / 1000} s`, errors };
    const first = await ev(`(() => { const g = (n) => performance.getEntriesByName(n)[0]?.startTime ?? null; const ps = performance.getEntriesByName("tex-paint"); return { paint: ps[ps.length - 1].startTime, partial: ps.length > 1 ? ps[0].startTime : null, mount: g("tex-mount"), read: g("tex-read-done"), parse: g("tex-parse-done") }; })()`);
    // (the preview's text, kept from the first run: every piece laid out, as the page's print does, and KaTeX's
    //  MathML copy of each formula left out; then the page as it was)
    step("painted"); if (i === 0) writeFileSync(join(OUT, `${d.id}.preview.txt`), await ev(`(() => { const s = document.createElement("style");
      s.textContent = ".tex-preview .pc, .tex-preview .ch { content-visibility: visible !important; contain-intrinsic-size: none !important; } .tex-preview .katex-mathml { display: none !important; }";
      document.head.appendChild(s); const t = document.querySelector(".tex-preview")?.innerText ?? ""; s.remove(); return t; })()`));
    // the edit: one character typed at the anchor, its input to the paint of its revision (not when the oracle's edit is
    // in another file than the one the editor shows)
    if (d.edit.file && d.edit.file !== src.main) { step("close"); await send("Browser.close").catch(() => {}); return { first_ms: first.paint, ...(first.partial !== null ? { partial_ms: first.partial } : {}), mount_to_paint_ms: first.paint - first.mount, read_ms: first.read, edit_ms: null, note: `the edit is in ${d.edit.file}, not the file the editor shows`, errors }; }
    await sleep(1000);
    const at = editAt(text, d);
    await ev(`(() => { const t = document.querySelector(".tex-src"); t.focus(); t.setSelectionRange(${at}, ${at}); return true; })()`);
    const before = await ev(`performance.getEntriesByName("tex-input").length`);
    step("type"); await send("Input.insertText", { text: "x" });
    const ok = await until(`(() => { const inp = performance.getEntriesByName("tex-input")[${before}]; return !!inp && performance.getEntriesByName("tex-paint").some((p) => p.detail.rev === inp.detail.rev && p.startTime >= inp.startTime); })()`, 300_000);
    const edit = ok ? await ev(`(() => { const inp = performance.getEntriesByName("tex-input")[${before}]; const p = performance.getEntriesByName("tex-paint").find((p) => p.detail.rev === inp.detail.rev && p.startTime >= inp.startTime); return p.startTime - inp.startTime; })()`) : null;
    // (run: the SageTeX code run by the page's Run, from the click to its "Ran N SageTeX items" status)
    let run_ms = null, run_status = null;
    if (d.run && ok) {
      await sleep(500);
      if (await until(`!!document.querySelector(".tex-run") && !document.querySelector(".tex-run").hidden`, 10000)) {
        const t0 = Date.now();
        await ev(`document.querySelector(".tex-run").click(), true`);
        const ran = await until(`/^Ran \\d+/.test(document.querySelector(".tex-status")?.textContent ?? "")`, 300_000);
        run_ms = ran ? Date.now() - t0 : null;
        run_status = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
      } else run_status = "no Run button";
    }
    const status = await ev(`document.querySelector(".tex-status")?.textContent ?? ""`);
    step("close"); await send("Browser.close").catch(() => {});
    return { first_ms: first.paint, ...(first.partial !== null ? { partial_ms: first.partial } : {}), mount_to_paint_ms: first.paint - first.mount, read_ms: first.read, edit_ms: edit, ...(d.run ? { run_ms, run_status } : {}), status: status.slice(0, 200), errors };
  } finally {
    chrome.kill();
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---- --report DIR: the tables again, from DIR/results.json
if (arg("report", null)) {
  const dir = arg("report"), R = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  const ids = [...new Set(R.runs.map((r) => r.doc))];
  docs.splice(0, docs.length, ...ids.map((id) => corpus.find((d) => d.id === id)));
  writeFileSync(join(dir, "table.md"), table(R) + "\n" + fidelity(dir, docs));
  console.log(readFileSync(join(dir, "table.md"), "utf8"));
  process.exit(0);
}
// ---- the runs
const results = { runs_per_part: RUNS, started: new Date().toISOString(), host: { cpus: cpus().length, cpu: cpus()[0]?.model, node: process.version }, versions: {}, runs: [] };
results.versions.latexmk = spawnSync("latexmk", ["--version"], { encoding: "utf8" }).stdout?.trim().split("\n").pop();
for (const e of ["pdflatex", "xelatex", "lualatex"]) results.versions[e] = spawnSync(e, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0];
results.versions.chrome = spawnSync(CHROME, ["--version"], { encoding: "utf8" }).stdout?.trim();
// (SAGEBRUSH_REV: the commit built, when the builds were copied to a machine without the repository)
results.versions.sagebrush = process.env.SAGEBRUSH_REV ?? spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim();
const parts = { oracle, cli, browser };
for (const d of docs) {
  const src = await source(d);
  for (const part of PARTS) for (let i = 0; i < (part === "oracle" ? Math.min(RUNS, d.oracle_runs ?? RUNS) : RUNS); i++) {
    const load = await quiet();
    const r = await parts[part](d, src, i);
    results.runs.push({ doc: d.id, part, i, load, ...r });
    console.error(`${d.id} ${part} #${i + 1} (load ${load.toFixed(2)}): ${JSON.stringify(r).slice(0, 300)}`);
    writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  }
}
results.finished = new Date().toISOString();
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
writeFileSync(join(OUT, "table.md"), table(results) + "\n" + fidelity(OUT, docs));
console.log(readFileSync(join(OUT, "table.md"), "utf8"));
process.exit(0);

// the table: min and median of each time, per document
function table(R) {
  const stat = (doc, part, key) => {
    const v = R.runs.filter((r) => r.doc === doc && r.part === part && Number.isFinite(r[key])).map((r) => r[key]).sort((a, b) => a - b), h = v.length >> 1;
    return v.length ? { min: v[0], med: v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2, n: v.length } : null;
  };
  const s = (x) => (x ? `${fmt(x.min)} / ${fmt(x.med)}` : "–");
  const fmt = (ms) => (ms >= 10_000 ? (ms / 1000).toFixed(0) + " s" : ms >= 1000 ? (ms / 1000).toFixed(2) + " s" : ms.toFixed(0) + " ms");
  const ratio = (a, b) => (a && b ? (a.med / b.med >= 10 ? (a.med / b.med).toFixed(0) : (a.med / b.med).toFixed(1)) + "×" : "–");
  const rows = docs.map((d) => {
    const oc = stat(d.id, "oracle", "cold_ms"), oe = stat(d.id, "oracle", "edit_ms"), cr = stat(d.id, "cli", "render_ms"), bf = stat(d.id, "browser", "first_ms"), be = stat(d.id, "browser", "edit_ms");
    const o = R.runs.find((r) => r.doc === d.id && r.part === "oracle");
    const ofail = R.runs.find((r) => r.doc === d.id && r.part === "oracle" && r.error);
    return `| ${d.id} ${d.name} | ${ofail ? `fails after ${fmt(ofail.cold_ms)}: ${ofail.error.replace(/\|/g, "\\|")}` : s(oc)} | ${s(oe)} | ${o ? `${o.passes} / ${o.edit_passes ?? "–"}` : "–"} | ${s(cr)} | ${s(bf)} | ${s(be)} | ${ofail ? "–" : ratio(oc, bf)} | ${ratio(oe, be)} |`;
  });
  return [
    `Times: min / median of ${R.runs_per_part ?? RUNS} runs (one run of the oracle where corpus.json says so). TeX passes: latexmk's runs of the engine, cold / after the edit.`,
    "",
    "| document | latexmk cold | latexmk edit | TeX passes | CLI render | browser first preview | browser edit | cold: latexmk ÷ browser | edit: latexmk ÷ browser |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    // (Run: the editor's SageTeX Run, click to "Ran N SageTeX items", in the browser; and each oracle's note)
    ...docs.filter((d) => d.run).map((d) => { const r = stat(d.id, "browser", "run_ms"), last = R.runs.filter((x) => x.doc === d.id && x.part === "browser").at(-1); return `- ${d.id}: the editor's Run ${s(r)}: "${last?.run_status ?? ""}"`; }),
    ...docs.map((d) => [d, R.runs.find((x) => x.doc === d.id && x.part === "oracle" && (x.note || x.tex_errors))]).filter(([, o]) => o).map(([d, o]) => `- ${d.id}, latexmk: ${[o.note, o.tex_errors && `TeX errors: ${o.tex_errors.join("; ")}`].filter(Boolean).join("; ").replace(/\|/g, "\\|")}`),
    "",
  ].join("\n");
}
