// `sagebrush latex check|render`: the LaTeX editor's own preview engine (web/latex/engine) on a .tex file, so that an
// agent can verify what it wrote and see it.
//   - check lists what the preview can't show or found wrong, each with its line, as text or JSON (--json).
//   - render writes the preview as one self-contained HTML file. With --png DIR it also writes one PNG per beamer
//     frame (or per page of any other document), and reports each frame whose content overflows its slide.
// The PNGs are taken by a Chromium-family browser already on this computer (Chrome, Chromium, Edge or Brave, or the
// one $CHROME names), run headless and driven over its DevTools protocol. Nothing is installed; without a browser,
// render says so and still writes the HTML.
// Built as its own file, sagebrush-latex.cjs, beside the CLI's bundle (scripts/build-cli.mjs). src/cli.ts loads it
// only for `latex`, so other commands don't carry the engine, KaTeX and its fonts.
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { basename, dirname, join, resolve, delimiter } from "path";
import { tmpdir } from "os";
import { spawn, type ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import katex from "katex";
import { Engine } from "../web/latex/engine/pipeline.mjs";
import { setKatex } from "../web/latex/engine/render.mjs";
import { itemKey, MAX_RESULT, WRAPPER_VERSION, LANG } from "../web/latex/engine/sagetex.mjs";
import { matlabToPython } from "./matlab";
import { PAGE_CSS } from "../web/latex/style";
import { imageCandidates, sniffImage, admitImageBytes } from "../web/latex/images";
import { checkResult, checkText, type CheckResult, type ImageReport } from "../web/latex/check";
import { applyStep } from "../web/latex/overlay";

setKatex(katex.renderToString);

/** The largest .tex read (the editor's own bound on a document is far below it). */
const TEX_MAX = 4 * 2 ** 20;
/** The most PNG pages written for a document that isn't beamer's. */
const PAGES_MAX = 60;
/** The most PNGs one render writes (--steps: every step of every frame). */
const SHOTS_MOST = 400;
/** A beamer slide's width in the HTML and the PNGs, in CSS pixels (its height follows the aspect ratio). */
const SLIDE_W = 1024;

const HELP = `sagebrush latex: check, run and see a .tex file as Sagebrush's LaTeX editor shows it

  sagebrush latex run FILE.tex [--timeout SECONDS] [--json]
      Run the document's SageTeX code (sagesilent, sageblock, \\sage{}, \\sageplot{}) in order, in one Sage
      session here, and keep the results beside it in FILE.tex.results.json: check and render show them
      (a result counts while its item and every item before it are unchanged). The code runs in the file's
      folder, so it can read and write files there. An item that fails stops the rest. Exits 1 if one failed.

  sagebrush latex check FILE.tex [--json]
      What the preview can't show or found wrong, each with its line number: unsupported commands and
      environments, math KaTeX can't typeset, missing images, code not run, expansion stopped. Exits 1 if
      there is an error (a warning alone exits 0).

  sagebrush latex render FILE.tex [-o OUT.html] [--png DIR [--steps]] [--pdf OUT.pdf] [--json]
      The preview as one self-contained HTML file (default: FILE.html beside FILE.tex). With --png DIR, one
      PNG per beamer frame (frame-01.png, ...) or per page of another document, and a report of each frame
      whose content overflows its slide. PNGs need Chrome, Chromium, Edge or Brave on this computer (or
      CHROME=/path/to/browser); nothing is installed. --steps: each frame at each of its overlay steps
      (\\pause, <2->, \\only, \\uncover), frame-02-1.png, frame-02-2.png, ..., as the editor's Present shows them.
      --pdf: the preview printed to a PDF by the same browser (a beamer document one page per frame).

Look at the PNGs after every change: they are what the reader sees.
`;

/** `sagebrush latex ...`: the exit code. */
export async function latexCommand(argv: string[], opts: { cli?: string } = {}): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") { process.stdout.write(HELP); return cmd === undefined ? 2 : 0; }
  if (cmd !== "check" && cmd !== "render" && cmd !== "run") { process.stderr.write(`sagebrush latex: no command ${JSON.stringify(cmd)} (check, run or render)\n\n${HELP}`); return 2; }
  const args = argv.slice(1);
  let file: string | null = null, out: string | null = null, png: string | null = null, pdf: string | null = null, json = false, timeout = 120, steps = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if ((a === "-o" || a === "--out") && cmd === "render") { out = args[++i] ?? null; if (out === null) return usage(`${a} needs a file name`); }
    else if (a === "--timeout" && cmd === "run") { timeout = Number(args[++i]); if (!(timeout > 0 && timeout <= 3600)) return usage("--timeout needs a number of seconds, at most 3600"); }
    else if (a === "--steps" && cmd === "render") steps = true;
    else if (a === "--pdf" && cmd === "render") { pdf = args[++i] ?? null; if (pdf === null) return usage("--pdf needs a file name"); }
    else if (a === "--png" && cmd === "render") { png = args[++i] ?? null; if (png === null) return usage("--png needs a folder"); }
    else if (a.startsWith("-")) return usage(`unknown option ${a}`);
    else if (file === null) file = a;
    else return usage(`one file only (${JSON.stringify(a)} is a second)`);
  }
  if (file === null) return usage("which .tex file?");
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return fail(`${file}: not a file`);
    if (st.size > TEX_MAX) return fail(`${file}: ${st.size} bytes, over the ${TEX_MAX} this reads`);
    text = readFileSync(file, "utf8");
  } catch (e: any) { return fail(`${file}: ${e?.code === "ENOENT" ? "no such file" : e?.message ?? e}`); }
  if (cmd === "run") return runCommand(file, text, timeout, json, opts.cli);
  const { result, html } = renderTex(file, text);
  if (cmd === "check") {
    if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else process.stdout.write(checkText(result));
    return result.ok ? 0 : 1;
  }
  const htmlPath = out ?? join(dirname(file), basename(file).replace(/\.tex$/i, "") + ".html");
  writeFileSync(htmlPath, html);
  const report: any = { html: htmlPath, check: result };
  let code = 0;
  if (png !== null || pdf !== null) {
    try { const b = await screenshots(htmlPath, png, result, steps, pdf); if (png !== null) report.png = b; if (pdf !== null) report.pdf = b.pdf; }
    catch (e: any) { report[png !== null ? "png_error" : "pdf_error"] = String(e?.message ?? e); code = 1; }
  }
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write(`wrote ${htmlPath}\n`);
    if (report.png) for (const p of report.png.pages) process.stdout.write(`wrote ${p.file}${p.title ? `  (frame ${p.frame}: ${p.title})` : ""}${p.overflow_px ? `  OVERFLOWS its slide by ${p.overflow_px}px` : ""}\n`);
    if (report.pdf) process.stdout.write(`wrote ${report.pdf.file} (${report.pdf.pages} page${report.pdf.pages === 1 ? "" : "s"})\n`);
    if (report.png_error) process.stderr.write(`sagebrush latex: no PNGs: ${report.png_error}\n`);
    if (report.pdf_error) process.stderr.write(`sagebrush latex: no PDF: ${report.pdf_error}\n`);
    const n = result.problems.length;
    if (n) process.stdout.write(`${n} problem${n === 1 ? "" : "s"} (sagebrush latex check ${file} lists them)\n`);
  }
  return code;
}

function usage(why: string): number { process.stderr.write(`sagebrush latex: ${why}\n\n${HELP}`); return 2; }
function fail(why: string): number { process.stderr.write(`sagebrush latex: ${why}\n`); return 2; }

/** The preview of a .tex file: what check reports, and the self-contained HTML page. */
export function renderTex(file: string, text: string): { result: CheckResult; html: string } {
  // (a first pass finds the images the document names; the second has them, read from the file's own folder
  //  as the editor reads them from the workspace: imageCandidates, never outside it)
  const first = new Engine({}).update(text, { cold: true });
  const images: Record<string, string | { why: string }> = {};
  const imgReport: ImageReport[] = [];
  let kept = 0;
  for (const name of first.imageRefs as string[]) {
    const c = imageCandidates(name, "/" + basename(file));
    if (!c.ok) { images[name] = { why: c.why }; imgReport.push({ name, found: false, why: c.why }); continue; }
    let got: { path: string; url: string } | { why: string } = { why: "no such file in this folder" };
    for (const p of c.paths) {
      const local = join(dirname(file), p.slice(1));
      if (!existsSync(local) || !statSync(local).isFile()) continue;
      const size = statSync(local).size;
      const why = admitImageBytes(size, size, kept);
      if (why) { got = { why }; break; }
      const b = readFileSync(local);
      const s = sniffImage(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      if (!s.ok) { got = { why: s.why }; break; }
      kept += size;
      got = { path: p.slice(1), url: `data:${s.mime};base64,${b.toString("base64")}` };
      break;
    }
    if ("url" in got) { images[name] = got.url; imgReport.push({ name, found: true, path: got.path }); }
    else { images[name] = got; imgReport.push({ name, found: false, why: got.why }); }
  }
  // (the code items' results, from `sagebrush latex run`'s file beside it, for the items still as they were run)
  const r = new Engine({ images, sage: { saved: readResults(file) } }).update(text, { cold: true });
  const states = r.sageStates as State[];
  const result = checkResult(file, text, { outcome: String(r.stats.outcome), beamer: !!r.beamer, problems: r.problems, frames: r.frames,
    sage: (r.sageItems as any[]).map((it, k) => ({ mode: String(it.mode), err: it.err ?? null, at: typeof it.at === "number" ? it.at : -1, ...(states[k] ? { s: states[k].s, msg: states[k].msg } : {}) })) }, imgReport);
  return { result, html: pageHtml(basename(file), r.chunks.join("\n"), !!r.beamer) };
}

// ---- running the code: `sagebrush latex run`

/** The results file of a .tex: beside it, FILE.tex.results.json. */
export const resultsPath = (file: string) => join(dirname(file), basename(file) + ".results.json");
export const RESULTS_FORMAT = "sagebrush-latex-results";
const RESULTS_MAX = 32 * 2 ** 20, SVG_MAX = 2 * 2 ** 20, MSG_MAX = 4000;
type State = { key: string; s: "ok" | "error" | "blocked"; latex?: string; src?: string; msg?: string; text?: string; out?: string };

/** The results file's states, or [] if there is none or it isn't one (never trusted beyond its shape). */
function readResults(file: string): State[] {
  const p = resultsPath(file);
  try {
    if (!existsSync(p) || statSync(p).size > RESULTS_MAX) return [];
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j?.format !== RESULTS_FORMAT || j.version !== 1 || j.wrapper !== WRAPPER_VERSION || !Array.isArray(j.items)) return [];
    return j.items.filter((x: any) => x && typeof x.key === "string" && ["ok", "error", "blocked"].includes(x.s)).map((x: any) => ({
      key: x.key, s: x.s, ...(typeof x.latex === "string" ? { latex: x.latex } : {}), ...(typeof x.src === "string" ? { src: x.src } : {}), ...(typeof x.msg === "string" ? { msg: x.msg.slice(0, MSG_MAX) } : {}),
      ...(typeof x.text === "string" ? { text: x.text } : {}), ...(typeof x.out === "string" ? { out: x.out.slice(0, MSG_MAX * 16) } : {}),
    }));
  } catch { return []; }
}

// the sessions' script, one per language (Sage, Python, MATLAB), in one namespace, the language's items in order
// until one fails, each result written at once (a session stopped by the timeout keeps what ran before it); the
// items' printing is captured as their output, kept apart from their values:
//   Sage: preparsed, then exec'd (sagesilent, sageblock) or eval'd (\sage: its latex(); \sageplot: its SVG);
//   Python: exec'd (pycode, pyblock, \pyc) or eval'd (\py: its str());
//   MATLAB: translated to Python by the CLI (matlabToPython, cell by cell, as the notebook runs MATLAB), then exec'd
//   with _matlab's errors kept for the result (\matlab{e}: num2str(e), as text)
const DRIVER = `import json, io, sys, traceback
_sbtx_in, _sbtx_outp, _sbtx_lang = sys.argv[1], sys.argv[2], sys.argv[3]
if _sbtx_lang == "sage":
    from sagebrush.preparse import preparse as _sbtx_pp
if _sbtx_lang == "matlab":
    import _matlab as _sbtx_m
    _sbtx_m.host_shows_errors()
with open(_sbtx_in) as _sbtx_f:
    _sbtx_items = json.load(_sbtx_f)
_sbtx_g = dict(globals())
_sbtx_out = []
_sbtx_failed = False
for _sbtx_it in _sbtx_items:
    if _sbtx_failed:
        _sbtx_out.append({"s": "blocked"})
        continue
    _sbtx_buf = io.StringIO()
    _sbtx_old = sys.stdout
    sys.stdout = _sbtx_buf
    _sbtx_mode = _sbtx_it["mode"]
    try:
        _sbtx_code = _sbtx_pp(_sbtx_it["code"]) if _sbtx_lang == "sage" else _sbtx_it["code"]
        if _sbtx_mode == "sage":
            _sbtx_r = {"s": "ok", "latex": str(latex(eval(_sbtx_code, _sbtx_g)))}
        elif _sbtx_mode == "plot":
            _sbtx_v = eval(_sbtx_code, _sbtx_g)
            if not hasattr(_sbtx_v, "_repr_svg_"):
                raise TypeError("sageplot needs a graphics object (a plot), not " + type(_sbtx_v).__name__)
            _sbtx_r = {"s": "ok", "svg": _sbtx_v._repr_svg_()}
        elif _sbtx_mode == "py":
            _sbtx_r = {"s": "ok", "text": str(eval(_sbtx_code, _sbtx_g))}
        else:
            exec(_sbtx_code, _sbtx_g)
            _sbtx_r = {"s": "ok"}
            if _sbtx_lang == "matlab":
                if _sbtx_m.cell_failed():
                    _sbtx_r = {"s": "error", "msg": str(_sbtx_m.cell_error() or "the MATLAB code stopped on an error")}
                elif _sbtx_mode == "matlab":
                    _sbtx_v = _sbtx_g.get("sbtxval")
                    _sbtx_r["text"] = "\\n".join(_sbtx_v.rows()) if hasattr(_sbtx_v, "rows") else str(_sbtx_v)
    except BaseException:
        _sbtx_r = {"s": "error", "msg": traceback.format_exc()}
    finally:
        sys.stdout = _sbtx_old
    if _sbtx_r["s"] == "error":
        _sbtx_failed = True
    _sbtx_r["out"] = _sbtx_buf.getvalue()[-${MSG_MAX * 16}:]
    _sbtx_out.append(_sbtx_r)
    with open(_sbtx_outp, "w") as _sbtx_f:
        json.dump(_sbtx_out, _sbtx_f)
`;

/** The session's own last words: its stderr's last lines, without the runtime's version line. */
const sessionError = (err: string) => err.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !/^(Node\.js|Bun) v[0-9.]+/.test(l.trim())).slice(-4).join("\n");
const LANG_NAME: Record<string, string> = { sage: "SageTeX", python: "Python", matlab: "MATLAB" };

/** One language's items run in a session of this sagebrush (the bundle that loaded this file): each one's result, in
 * order, as far as the session got, and how the session ended. */
async function runSession(cli: string, lang: string, run: { mode: string; code: string }[], cwd: string, timeout: number) {
  const tmp = mkdtempSync(join(tmpdir(), "sb-latex-run-"));
  const driver = join(tmp, lang === "sage" ? "driver.sage" : "driver.py"), outp = join(tmp, "out.json");
  writeFileSync(join(tmp, "items.json"), JSON.stringify(run));
  writeFileSync(driver, DRIVER);
  const args = [cli, ...(lang === "sage" ? ["--sage"] : []), driver, join(tmp, "items.json"), outp, lang];
  const done = await new Promise<{ code: number | null; timedOut: boolean; err: string }>((res) => {
    const p = spawn(process.execPath, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "", timedOut = false;
    p.stderr!.on("data", (d) => { if (err.length < 16384) err += d; });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeout * 1000);
    p.on("close", (code) => { clearTimeout(t); res({ code, timedOut, err }); });
    p.on("error", (e) => { clearTimeout(t); res({ code: -1, timedOut, err: e.message }); });
  });
  let got: any[] = [];
  try { got = existsSync(outp) ? JSON.parse(readFileSync(outp, "utf8")) : []; } catch {}
  rmSync(tmp, { recursive: true, force: true });
  return { got, ...done };
}

/** A MATLAB item as the Python its session runs (\matlab{e}: its value, num2str(e), into sbtxval), or why it can't be. */
function matlabCode(it: any, n: number): { code: string } | { why: string } {
  const src = it.mode === "matlab" ? `sbtxval = num2str(${it.code});\n` : String(it.code);
  try { return { code: matlabToPython(src, `MATLAB item ${n}`, { cell: true }) }; }
  catch (e: any) { return { why: String(e?.message ?? e).split("\n")[0] }; }
}

async function runCommand(file: string, text: string, timeout: number, json: boolean, cli: string | undefined): Promise<number> {
  const items = new Engine({}).update(text, { cold: true }).sageItems as any[];
  const report = (o: any, code: number) => { if (json) process.stdout.write(JSON.stringify(o, null, 2) + "\n"); return code; };
  if (!items.length) {
    if (!json) process.stdout.write(`${file}: no code to run (SageTeX, PythonTeX or MATLAB)\n`);
    return report({ file, items: [], results: null }, 0);
  }
  if (!cli || !existsSync(cli)) return fail("can't find this sagebrush's own bundle to run the code in");
  const t0 = Date.now();
  // (each language in a session of its own, in document order within it; a failure stops the rest of its language:
  //  a refused item, or a MATLAB item that doesn't translate, is a failure before its session starts)
  const states: (State | undefined)[] = items.map(() => undefined);
  const msgOf = (x: any) => {
    // (a traceback without the session script's own frames: the item's code is the "<string>" one)
    const lines = String(x?.msg ?? "").split("\n"), out: string[] = [];
    for (let i = 0; i < lines.length; i++) { if (/^\s*File ".*driver\.(sage|py)", line \d+/.test(lines[i])) { if (/^\s{4,}\S/.test(lines[i + 1] ?? "") && !/^\s*File /.test(lines[i + 1])) i++; continue; } out.push(lines[i]); }
    return out.join("\n").slice(-MSG_MAX);
  };
  for (const lang of ["sage", "python", "matlab"]) {
    const idx = items.map((it, k) => (LANG[it.mode] === lang ? k : -1)).filter((k) => k >= 0);
    if (!idx.length) continue;
    const run: { mode: string; code: string }[] = [];
    let stop: { k: number; msg: string } | null = null;
    for (const k of idx) {
      const it = items[k];
      if (it.err) { stop = { k, msg: "this item can't be run (" + it.err + ")" }; break; }
      if (lang === "matlab") { const m = matlabCode(it, k + 1); if ("why" in m) { stop = { k, msg: "MATLAB syntax: " + m.why }; break; } run.push({ mode: it.mode, code: m.code }); }
      else run.push({ mode: it.mode, code: it.code });
    }
    const done = run.length ? await runSession(cli, lang, run, dirname(resolve(file)), timeout) : { got: [], timedOut: false, err: "", code: 0 };
    let failed = false;
    for (let q = 0; q < idx.length; q++) {
      const k = idx[q], it = items[k], key = itemKey(it), g = done.got[q];
      const out = typeof g?.out === "string" && g.out ? { out: g.out.slice(-MSG_MAX * 16) } : {};
      if (failed) { states[k] = { key, s: "blocked", msg: "not run: an earlier " + LANG_NAME[lang] + " item failed" }; continue; }
      if (stop && stop.k === k) { states[k] = { key, s: "error", msg: stop.msg }; failed = true; continue; }
      if (!g) { states[k] = { key, s: "error", msg: done.timedOut ? `not finished: the run stopped at the ${timeout} s timeout` : "not run: the session ended before it (" + (sessionError(done.err) || "exit " + done.code) + ")" }; failed = true; continue; }
      if (g.s !== "ok") { states[k] = { key, s: "error", msg: g.s === "error" ? msgOf(g) : "not run: an earlier item failed", ...out }; failed = true; continue; }
      if (it.mode === "sage") {
        const l = String(g.latex ?? "");
        if (Buffer.byteLength(l) > MAX_RESULT) { states[k] = { key, s: "error", msg: `the result's LaTeX is over ${MAX_RESULT} bytes` }; failed = true; continue; }
        states[k] = { key, s: "ok", latex: l, ...out };
      } else if (it.mode === "plot") {
        const svg = String(g.svg ?? "");
        if (Buffer.byteLength(svg) > SVG_MAX || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) { states[k] = { key, s: "error", msg: Buffer.byteLength(svg) > SVG_MAX ? `the plot's SVG is over ${SVG_MAX} bytes` : "the plot isn't an SVG" }; failed = true; continue; }
        states[k] = { key, s: "ok", src: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"), ...out };
      } else if (it.mode === "py" || it.mode === "matlab") {
        const v = String(g.text ?? "");
        if (Buffer.byteLength(v) > MAX_RESULT) { states[k] = { key, s: "error", msg: `the value is over ${MAX_RESULT} bytes` }; failed = true; continue; }
        states[k] = { key, s: "ok", text: v, ...out };
      } else states[k] = { key, s: "ok", ...out };
    }
  }
  const all = states as State[];
  const rp = resultsPath(file);
  writeFileSync(rp, JSON.stringify({ format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, generator: "sagebrush latex run", items: all }) + "\n");
  const lines = items.map((it, k) => ({ n: k + 1, mode: String(it.mode), lang: LANG_NAME[LANG[it.mode]] ?? "SageTeX", line: typeof it.at === "number" && it.at >= 0 ? text.slice(0, it.at).split("\n").length : null, state: all[k].s, ...(all[k].s === "error" ? { message: all[k].msg } : {}) }));
  const ms = Date.now() - t0, bad = all.some((x) => x.s === "error");
  if (!json) {
    process.stdout.write(`${file}: ran ${all.filter((x) => x.s === "ok").length} of ${items.length} code item${items.length === 1 ? "" : "s"} in ${(ms / 1000).toFixed(1)} s; results in ${rp}\n`);
    for (const l of lines) if (l.state !== "ok") process.stdout.write(`${file}:${l.line ?? "-"}: ${l.state === "error" ? "error" : "warning"}: ${l.lang} item ${l.n} (${l.mode}) ${l.state === "error" ? "failed:\n" + String(l.message).trimEnd().split("\n").slice(-6).map((x) => "    " + x).join("\n") : "wasn't run: an earlier item of its language failed"}\n`);
  }
  return report({ file, results: rp, ms, items: lines }, bad ? 1 : 0);
}

// ---- the page

/** KaTeX's stylesheet with its WOFF2 fonts inlined (the CLI's build gives them; from a checkout, node_modules). */
function katexCss(): string {
  const g = (globalThis as any).__SAGEBRUSH_LATEX_ASSETS__ as { css: string; fonts: Record<string, string> } | undefined;
  let css: string, font: (name: string) => string | null;
  if (g) { css = g.css; font = (n) => g.fonts[n] ?? null; }
  else {
    // (a path built at run time: a bundler would take a literal one for an import of the stylesheet)
    const dir = join(dirname(require.resolve(["katex", "package.json"].join("/"))), "dist");
    css = readFileSync(join(dir, "katex.min.css"), "utf8");
    font = (n) => { const p = join(dir, "fonts", n); return existsSync(p) ? readFileSync(p).toString("base64") : null; };
  }
  // (each @font-face's WOFF2 as a data: URL; its WOFF and TTF fallbacks dropped: every browser that renders this reads WOFF2)
  return css.replace(/url\(fonts\/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\)(,url\(fonts\/[^)]+\) format\("[a-z]+"\))*/g, (all, n) => {
    const b = font(n);
    return b ? `url(data:font/woff2;base64,${b}) format("woff2")` : all;
  });
}

const STANDALONE_CSS = `
body { margin: 0; background: #eef0f2; }
.tex-page.sb-standalone { position: static; display: block; min-height: 100vh; }
.sb-standalone .page.beamer { max-width: none; width: ${SLIDE_W}px; margin: 0 auto; padding: 16px; background: transparent; box-shadow: none; box-sizing: content-box; }
.sb-standalone .page.beamer > .slide { margin: 0 0 16px; }
@media print {
  body { background: #fff; }
  .sb-standalone .page.beamer { padding: 0; }
  .sb-standalone .page.beamer > .slide { margin: 0; border: none; box-shadow: none; break-after: page; break-inside: avoid; }
  .sb-standalone .page:not(.beamer) { box-shadow: none; margin: 0 auto; }
}
`;

function pageHtml(name: string, body: string, beamer: boolean): string {
  const title = name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title>\n` +
    // (no script runs in it and it loads nothing: its fonts and images are data: URLs, so the file is safe to open, send
    //  or publish, and safe for render's browser to draw, even without that browser's own sandbox)
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:">\n` +
    `<meta name="generator" content="sagebrush latex render">\n` +
    `<style>${katexCss()}</style>\n<style>${PAGE_CSS}</style>\n<style>${STANDALONE_CSS}</style>\n</head>\n` +
    `<body><div class="tex-page sb-standalone"><div class="page tex-preview${beamer ? " beamer" : ""}">\n${body}\n</div></div></body></html>\n`;
}

// ---- the pictures: a Chromium-family browser, headless, over its DevTools protocol

/** The browser to use: $CHROME (or $SAGEBRUSH_CHROME), else the usual places, else null. */
export function findBrowser(env = process.env, platform = process.platform): string | null {
  // (CHROME=/path/to/it, or a command's name looked up on PATH as a shell would: CI sets CHROME=google-chrome)
  for (const k of ["SAGEBRUSH_CHROME", "CHROME"]) if (env[k]) {
    const v = env[k]!;
    if (/[\\/]/.test(v)) return existsSync(v) ? v : null;
    const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
    const names = platform === "win32" && !/\.exe$/i.test(v) ? [v + ".exe", v] : [v];
    return dirs.flatMap((d) => names.map((n) => join(d, n))).find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
  }
  const cands: string[] = [];
  if (platform === "darwin") {
    for (const app of ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser", "Google Chrome Canary"]) {
      cands.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      if (env.HOME) cands.push(join(env.HOME, `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (platform === "win32") {
    for (const base of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]) if (base) {
      cands.push(join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
        join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(base, "Chromium", "Application", "chrome.exe"));
    }
  } else {
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir) for (const b of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"]) cands.push(join(dir, b));
  }
  return cands.find((p) => existsSync(p)) ?? null;
}

class Cdp {
  private n = 0; private waiting = new Map<number, (m: any) => void>(); private events: ((m: any) => void)[] = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev: any) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && this.waiting.has(m.id)) { this.waiting.get(m.id)!(m); this.waiting.delete(m.id); }
      else if (m.method) for (const f of this.events) f(m);
    };
  }
  send(method: string, params: object = {}): Promise<any> {
    return new Promise((ok, no) => {
      const id = ++this.n;
      this.waiting.set(id, (m) => (m.error ? no(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method: string, ms: number): Promise<void> {
    return new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error(`the browser sent no ${method} in ${ms / 1000} s`)), ms);
      const f = (m: any) => { if (m.method === method) { clearTimeout(t); this.events = this.events.filter((g) => g !== f); ok(); } };
      this.events.push(f);
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("in the page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function screenshots(htmlPath: string, dir: string | null, check: CheckResult, steps = false, pdf: string | null = null) {
  const browser = findBrowser();
  if (!browser) throw new Error("no Chrome, Chromium, Edge or Brave found (set CHROME=/path/to/it); the HTML is written: open it in a browser");
  if (typeof (globalThis as any).WebSocket !== "function") throw new Error(`this JavaScript runtime has no WebSocket (Node 22 or newer has it)`);
  if (dir !== null) mkdirSync(dir, { recursive: true });
  let proc: ChildProcess | null = null, ws: WebSocket | null = null, profile = "";
  try {
    // (where the browser's own sandbox can't start, as in many containers, once more without it: the page it draws
    //  runs no script and loads nothing, its Content-Security-Policy above)
    let port = 0, noSandbox = false;
    for (const extra of [[], ["--no-sandbox"]]) {
      profile = mkdtempSync(join(tmpdir(), "sb-latex-"));
      const r = await launch(browser, profile, extra);
      if ("port" in r) { proc = r.proc; port = r.port; noSandbox = extra.length > 0; break; }
      rmSync(profile, { recursive: true, force: true }); profile = "";
      if (extra.length) throw new Error(r.why);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("the browser has no page to draw in");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws!.onopen = ok; ws!.onerror = () => no(new Error("couldn't connect to the browser's DevTools")); });
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    const beamer = check.class === "beamer";
    const width = beamer ? SLIDE_W + 32 : 900;
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    const loaded = cdp.once("Page.loadEventFired", 30000);
    await cdp.send("Page.navigate", { url: pathToFileURL(resolve(htmlPath)).href });
    await loaded;
    await cdp.eval("document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => 1)");
    const boxes: { x: number; y: number; w: number; h: number; over: number }[] = await cdp.eval(beamer
      ? `[...document.querySelectorAll("section.slide")].map((s) => { const r = s.getBoundingClientRect(), b = s.querySelector(".slide-body");
          const over = b ? Math.max(0, Math.ceil(b.scrollHeight - b.clientHeight), Math.ceil(b.scrollWidth - b.clientWidth)) : 0;
          return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, over }; })`
      : `(() => { const r = document.querySelector(".page").getBoundingClientRect(), H = Math.round(r.width * 1.294), out = [];
          for (let y = 0; y < r.height && out.length < ${PAGES_MAX}; y += H) out.push({ x: r.left + scrollX, y: r.top + scrollY + y, w: r.width, h: Math.min(H, r.height - y), over: 0 });
          return out; })()`);
    // (--pdf: the page printed by the browser, a beamer document one page per frame of the slide's size, others on
    //  Letter paper; the print rules are STANDALONE_CSS's)
    let pdfOut: { file: string; pages: number } | undefined;
    if (pdf !== null) {
      const sz = beamer && boxes.length ? { paperWidth: boxes[0].w / 96, paperHeight: boxes[0].h / 96, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 } : { paperWidth: 8.5, paperHeight: 11, marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 };
      const r = await cdp.send("Page.printToPDF", { printBackground: true, ...sz });
      const bytes = Buffer.from(r.data, "base64");
      writeFileSync(pdf, bytes);
      pdfOut = { file: pdf, pages: (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length };
    }
    const pages: { file: string; frame?: number; step?: number; title?: string; overflow_px?: number }[] = [];
    // (--steps: each frame at each overlay step, as the presenter shows them: overlay.ts's applyStep, its source sent to
    //  the page; the frame measured again at each step)
    const stepFn = applyStep.toString();
    for (let k = 0; k < (dir === null ? 0 : boxes.length); k++) {
      const fr = beamer ? check.frames[k] : undefined, n = steps && fr ? fr.steps : 1;
      for (let s = 1; s <= n && pages.length < SHOTS_MOST; s++) {
        let b = boxes[k];
        if (steps && fr) b = await cdp.eval(`(() => { const sl = document.querySelectorAll("section.slide")[${k}]; (${stepFn})(sl, ${s}); const r = sl.getBoundingClientRect(), bd = sl.querySelector(".slide-body");
          return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, over: bd ? Math.max(0, Math.ceil(bd.scrollHeight - bd.clientHeight), Math.ceil(bd.scrollWidth - bd.clientWidth)) : 0 }; })()`);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1 } });
        const f = join(dir!, `${beamer ? "frame" : "page"}-${String(k + 1).padStart(2, "0")}${steps && fr ? "-" + s : ""}.png`);
        writeFileSync(f, Buffer.from(shot.data, "base64"));
        pages.push({ file: f, ...(fr ? { frame: fr.n, ...(steps ? { step: s } : {}), title: fr.title } : {}), ...(b.over ? { overflow_px: b.over } : {}) });
      }
    }
    return { browser, ...(noSandbox ? { browser_sandbox: false } : {}), pages, ...(pdfOut ? { pdf: pdfOut } : {}) };
  } finally {
    try { ws?.close(); } catch {}
    if (proc && proc.exitCode === null) { proc.kill(); await new Promise((r) => { proc!.once("exit", r); setTimeout(r, 3000); }); }
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}

/** The browser started headless with its DevTools on a port of its choosing, or why it didn't start. */
async function launch(browser: string, profile: string, extra: string[]): Promise<{ proc: ChildProcess; port: number } | { why: string }> {
  const proc = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", ...extra, "about:blank"], { stdio: "ignore" });
  let exited: string | null = null;
  proc.on("exit", (c, s) => { exited = `the browser (${browser}) exited (${s ?? c}) before it could take the pictures`; });
  proc.on("error", (e) => { exited = `the browser (${browser}) didn't start: ${e.message}`; });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300; i++) {
    if (exited) return { why: exited };
    if (existsSync(portFile)) { const port = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; if (port) return { proc, port }; }
    await sleep(100);
  }
  proc.kill();
  return { why: `the browser (${browser}) didn't open its DevTools port in 30 s` };
}
