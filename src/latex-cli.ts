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
import { readFileSync, writeFileSync, existsSync, statSync, realpathSync, mkdirSync, mkdtempSync, rmSync, openSync, readSync, closeSync, readdirSync } from "fs";
import { basename, dirname, join, resolve, relative, delimiter, sep, posix } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { pathToFileURL } from "url";
import katex from "katex";
import { Engine, installPythontex } from "../web/latex/engine/pipeline.mjs";
import { setKatex, installBeamer } from "../web/latex/engine/render.mjs";
import * as beamerCode from "../web/latex/engine/beamer.mjs";
import * as pythontexCode from "../web/latex/engine/pythontex.mjs";
import { itemKey, MAX_RESULT, WRAPPER_VERSION, depsOf, safeRel, DEPS_MAX, DEPS_BYTES, staleOfSync, readComplete } from "../web/latex/engine/sagetex.mjs";
import { PAGE_CSS } from "../web/latex/style";
import { imageCandidates, graphicsPathOf, notFoundWhy, sniffImage, admitImageBytes, IMAGE_EXTS } from "../web/latex/images";
import { engineInputs, admitInput, INPUT_BOUNDS, type Known } from "../web/latex/inputs";
import { checkResult, checkText, type CheckResult, type ImageReport } from "../web/latex/check";
import { applyStep } from "../web/latex/overlay";
import { splitChunk, tooLargeProblem } from "../web/latex/split";

setKatex(katex.renderToString);
// (beamer's code: in the browser a chunk the worker fetches when a document needs it; here, always)
installBeamer(beamerCode);
installPythontex(pythontexCode);

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
      PythonTeX's \\py{}, pycode and pyblock run too, as plain Python, in a session of their own.

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
  // (a first pass finds the images the document names; the second has them, read as the editor reads them from the
  //  workspace and as TeX would: the file's folder, then \graphicspath's, imageCandidates. The workspace is the folder
  //  the command runs in (its real path): its top is "/", so no name, relative, \graphicspath's or with a leading "/",
  //  reaches outside it, and a file that is a link (or in a linked folder) is read only if its real path is inside
  //  too (astra L2-BOUND-1, -2); a .tex outside that folder has no images)
  const images: Record<string, string | { why: string }> = {};
  const imgReport: ImageReport[] = [];
  const root = realpathSync(process.cwd());
  const inRoot = (p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  let docReal: string | null = null;
  try { docReal = realpathSync(resolve(file)); } catch {}
  const toWs = (p: string) => "/" + relative(root, p).split(sep).join("/"), toDisk = (w: string) => join(root, ...w.slice(1).split("/"));
  const doc = docReal && inRoot(docReal) ? toWs(docReal) : null, dirs = graphicsPathOf(text);
  // (\input and \include, inputs.ts: the files the document asks for, read from the same folder by the same rules (inside
  //  it by their real paths), until it asks for no new one; a .tex outside the folder reads none)
  const known = new Map<string, Known>();
  let inputBytes = 0;
  const inputsNow = () => { const ei = engineInputs(doc ?? "/", known, true); return { ei, opt: { files: ei.files, resolve: doc ? ei.resolve : () => ({ why: "the .tex is outside the folder the command runs in" }), version: known.size } }; };
  let first: any;
  for (let round = 0; ; round++) {
    const { ei, opt } = inputsNow();
    first = new Engine({}).update(text, { cold: true, inputs: opt });
    const want = doc && round < 64 ? ei.wanted(first.inputRefs as string[]) : [];
    if (!want.length) break;
    for (const w of want) {
      const disk = toDisk(w);
      let real = "";
      try { real = realpathSync(disk); } catch {}
      let k: Known;
      if (!real) k = { absent: true };
      else if (!inRoot(real)) k = { why: "a link to outside the folder the command runs in" };
      else if (!statSync(real).isFile()) k = { absent: true };
      else if (statSync(real).size > INPUT_BOUNDS.perFile) k = { why: "too large" };
      else { const b = readFileSync(real); k = admitInput(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), inputBytes, [...known.values()].filter((x) => "text" in x).length); if ("text" in k) inputBytes += b.length; }
      known.set(w, k);
    }
  }
  let kept = 0;
  for (const name of first.imageRefs as string[]) {
    const c = doc ? imageCandidates(name, doc, dirs) : { ok: false as const, why: "the .tex is outside the folder the command runs in: run it from a folder that holds it" };
    if (!c.ok) { images[name] = { why: c.why }; imgReport.push({ name, found: false, why: c.why }); continue; }
    let got: { path: string; url: string } | { why: string } | null = null;
    for (const local of c.paths.map(toDisk)) {
      if (!existsSync(local)) continue;
      let real: string;
      try { real = realpathSync(local); } catch { continue; }
      if (!inRoot(real)) { got = { why: "a link to outside the folder the command runs in" }; break; }
      if (!statSync(real).isFile()) continue;
      const size = statSync(real).size;
      const why = admitImageBytes(size, size, kept);
      if (why) { got = { why }; break; }
      const b = readFileSync(real);
      if (b.length !== size) { got = { why: "changed while it was read" }; break; }
      const s = sniffImage(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
      if (!s.ok) { got = { why: s.why }; break; }
      kept += size;
      got = { path: relative(dirname(resolve(file)), local).split(sep).join("/"), url: `data:${s.mime};base64,${b.toString("base64")}` };
      break;
    }
    // (not found: a file of that name in a folder above, up to the top, named from this one)
    if (!got) {
      const leaf = basename(name), up: string[] = [];
      for (let d = posix.dirname(posix.dirname(doc!)); up.length === 0; d = posix.dirname(d)) {
        for (const x of /\.[A-Za-z0-9]+$/.test(leaf) ? [leaf] : IMAGE_EXTS.map((e) => leaf + e)) {
          const w = (d === "/" ? "" : d) + "/" + x, disk = toDisk(w);
          let real = "";
          try { real = realpathSync(disk); } catch {}
          if (real && inRoot(real) && statSync(real).isFile()) { up.push(w); break; }
        }
        if (d === "/") break;
      }
      got = { why: notFoundWhy(doc!, c.searched, up, true, name) };
    }
    if ("url" in got) { images[name] = got.url; imgReport.push({ name, found: true, path: got.path }); }
    else { images[name] = got; imgReport.push({ name, found: false, why: got.why }); }
  }
  // (the code items' results, from `sagebrush latex run`'s file beside it, for the items still as they were run)
  const saved = readResults(file);
  const r = new Engine({ images, sage: { saved: saved.states } }).update(text, { cold: true, inputs: inputsNow().opt });
  const states = r.sageStates as State[];
  // (the page as the editor's preview shows it, split once as its worker splits it, web/latex/split.ts: a placeholder
  //  where the preview has one, and check's warning for it)
  const tooLarge: { kind: string; name: string; at: number }[] = [];
  const pieces = (r.chunks as string[]).map((c, g) => splitChunk(c, (why, size) => tooLarge.push(tooLargeProblem(why, size, r.chunkPos?.[g]))).join(""));
  // (results not used, a helper they imported having changed since: said, the items shown as not run)
  const stale = saved.stale === null ? [] : [{ kind: "stale", name: saved.stale, at: -1 }];
  const result = checkResult(file, text, { outcome: String(r.stats.outcome), beamer: !!r.beamer, problems: r.problems.concat(tooLarge, stale), frames: r.frames,
    sage: (r.sageItems as any[]).map((it, k) => ({ mode: String(it.mode), err: it.err ?? null, at: typeof it.at === "number" ? it.at : -1, ...(states[k] ? { s: states[k].s, msg: states[k].msg } : {}) })) }, imgReport);
  return { result, html: pageHtml(basename(file), pieces.join("\n"), !!r.beamer) };
}

// ---- running the code: `sagebrush latex run`

/** The results file of a .tex: beside it, FILE.tex.results.json. */
export const resultsPath = (file: string) => join(dirname(file), basename(file) + ".results.json");
export const RESULTS_FORMAT = "sagebrush-latex-results";
const RESULTS_MAX = 32 * 2 ** 20, SVG_MAX = 2 * 2 ** 20, MSG_MAX = 4000;
type State = { key: string; s: "ok" | "error" | "blocked"; latex?: string; src?: string; msg?: string };

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** The .tex's folder's reader of recorded files (astra's DEP-READ-1, the editor's rule too: sagetex.mjs staleOf):
 * `rel` resolved, links followed, to a regular file inside the folder's own real path, read at most `left` bytes:
 * its bytes; null if it isn't one (gone, a directory, a link out of the folder); "over" if larger than `left`. */
function folderReader(dir: string): (rel: string, left: number) => Uint8Array | null | "over" {
  let root: string;
  try { root = realpathSync(dir); } catch { return () => null; }
  return (rel, left) => {
    let fd = -1;
    try {
      const real = realpathSync(join(dir, ...rel.split("/")));
      if (!real.startsWith(root + sep)) return null;
      const st = statSync(real);
      if (!st.isFile()) return null;
      if (st.size > left) return "over";
      // (read to the end, at most one byte past its size: a file that grew or shrank since its stat (a short read, a
      //  prefix) is not read as it is, so not used (astra's DEP-READ-1 r2))
      fd = openSync(real, "r");
      return readComplete((buf, at) => readSync(fd, buf, 0, buf.length, at), st.size);
    } catch { return null; } finally { if (fd >= 0) try { closeSync(fd); } catch {} }
  };
}
/** The .py files of the .tex's folder, hashed before a run (DEP-SNAPSHOT-1): relative path -> SHA-256, breadth
 * first (the files beside the .tex first), not into a hidden folder, node_modules or __pycache__, at most DEPS_MAX
 * files and DEPS_BYTES in all; a file past either isn't hashed (a run that imports it records "incomplete"). */
function preHashes(dir: string): Map<string, string> {
  const read = folderReader(dir), out = new Map<string, string>();
  let left = DEPS_BYTES;
  const queue = [""];
  while (queue.length && out.size < DEPS_MAX) {
    const sub = queue.shift()!;
    let names: { name: string; dir: boolean }[] = [];
    try { names = readdirSync(join(dir, ...sub.split("/").filter(Boolean)), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() })).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { continue; }
    for (const d of names) {
      const rel = sub ? sub + "/" + d.name : d.name;
      if (d.dir) { if (!d.name.startsWith(".") && d.name !== "node_modules" && d.name !== "__pycache__") queue.push(rel); continue; }
      if (!d.name.endsWith(".py") || out.size >= DEPS_MAX) continue;
      const b = read(rel, left);
      if (b && b !== "over") { out.set(rel, sha256(b)); left -= b.length; }
    }
  }
  return out;
}
/** The results file's states, or [] if there is none or it isn't one (never trusted beyond its shape); and, if it
 * records what its run imported (deps) and one of those files changed or is gone, none of its states and the reason
 * (`stale`): an edited helper's old results are never used (Codex W01). A file without deps: used as before. */
function readResults(file: string): { states: State[]; stale: string | null } {
  const p = resultsPath(file), none = { states: [], stale: null };
  try {
    if (!existsSync(p) || statSync(p).size > RESULTS_MAX) return none;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j?.format !== RESULTS_FORMAT || j.version !== 1 || j.wrapper !== WRAPPER_VERSION || !Array.isArray(j.items)) return none;
    const deps = depsOf(j);
    if (deps === "invalid" || deps === "incomplete") return { states: [], stale: deps };
    const stale = deps ? staleOfSync(deps, folderReader(dirname(file)), sha256) : null;
    if (stale) return { states: [], stale };
    return { stale: null, states: j.items.filter((x: any) => x && typeof x.key === "string" && ["ok", "error", "blocked"].includes(x.s)).map((x: any) => ({
      key: x.key, s: x.s, ...(typeof x.latex === "string" ? { latex: x.latex } : {}), ...(typeof x.src === "string" ? { src: x.src } : {}), ...(typeof x.msg === "string" ? { msg: x.msg.slice(0, MSG_MAX) } : {}),
    })) };
  } catch { return none; }
}

// the session's script (Sage mode): each item preparsed, then exec'd (sagesilent, sageblock) or eval'd (\sage: its
// latex(); \sageplot: its SVG), in one namespace, in order, until one fails; each result written at once, so a
// session stopped by the timeout keeps what ran before it. The items' own printing is kept apart from the results.
const DRIVER = `import json, io, os, sys, traceback
from sagebrush.preparse import preparse as _sbtx_pp
# (each item compiled as Sage source by the runtime itself, so its code object keeps Sage's semantics when it
#  runs: 1/3 exact, as in a .sage file; plain exec of preparsed text is Python's, 1/3 a float (#706). Given the
#  raw item: that compile preparses it, and preparsing twice would make ^^ a power. CPython: preparsed, exec'd)
try:
    _sbtx_cs = __pyjs_compile_sage__
except NameError:
    _sbtx_cs = None
# (the document's folder on sys.path, last, as real SageTeX has it: \`sage doc.sagetex.sage\`, run in the document's
#  folder, imports a helper.py beside the .tex, and its sys.path ends with that folder, so a statistics.py there
#  doesn't replace the standard library's (Sage 10.9's sage command, checked Nov 5). This session runs there too,
#  but its script is in a temporary folder. After the script's own imports: a sagebrush.py beside the .tex is the
#  items' to import, never the script's)
sys.path.append(os.getcwd())
_sbtx_in, _sbtx_outp, _sbtx_depp = sys.argv[1], sys.argv[2], sys.argv[3]
# (the modules imported from the document's folder, after each item: the results file records them, with their
#  hashes, so a later check or render knows when a helper changed (Codex W01))
_sbtx_root = os.path.realpath(os.getcwd())
def _sbtx_deps():
    got = set()
    for m in list(sys.modules.values()):
        f = getattr(m, "__file__", None)
        if isinstance(f, str):
            f = os.path.realpath(f)
            if f.startswith(_sbtx_root + os.sep):
                got.add(os.path.relpath(f, _sbtx_root).replace(os.sep, "/"))
    return sorted(got)
with open(_sbtx_in) as _sbtx_f:
    _sbtx_items = json.load(_sbtx_f)
_sbtx_g = dict(globals())
# (PythonTeX's items: plain Python, not preparsed, in a namespace of their own, as PythonTeX's own session)
_sbtx_pg = {}
_sbtx_out = []
_sbtx_failed = False
for _sbtx_it in _sbtx_items:
    if _sbtx_failed:
        _sbtx_out.append({"s": "blocked"})
        continue
    _sbtx_buf = io.StringIO()
    _sbtx_old = sys.stdout
    sys.stdout = _sbtx_buf
    try:
        _sbtx_m = _sbtx_it["mode"]
        _sbtx_py = _sbtx_m[:2] == "py"
        _sbtx_ev = "eval" if _sbtx_m in ("sage", "plot", "py") else "exec"
        _sbtx_s = _sbtx_it["code"].strip() if _sbtx_ev == "eval" else _sbtx_it["code"]
        _sbtx_code = compile(_sbtx_s, "<pythontex>", _sbtx_ev) if _sbtx_py else _sbtx_cs(_sbtx_s, "<sagetex>", _sbtx_ev) if _sbtx_cs else _sbtx_pp(_sbtx_it["code"])
        if _sbtx_m == "sage":
            _sbtx_r = {"s": "ok", "latex": str(latex(eval(_sbtx_code, _sbtx_g)))}
        elif _sbtx_m == "py":
            _sbtx_r = {"s": "ok", "latex": str(eval(_sbtx_code, _sbtx_pg))}
        elif _sbtx_m == "plot":
            _sbtx_v = eval(_sbtx_code, _sbtx_g)
            if not hasattr(_sbtx_v, "_repr_svg_"):
                raise TypeError("sageplot needs a graphics object (a plot), not " + type(_sbtx_v).__name__)
            _sbtx_r = {"s": "ok", "svg": _sbtx_v._repr_svg_()}
        else:
            exec(_sbtx_code, _sbtx_pg if _sbtx_py else _sbtx_g)
            _sbtx_r = {"s": "ok", "latex": _sbtx_buf.getvalue()} if _sbtx_py else {"s": "ok"}
    except BaseException:
        _sbtx_r = {"s": "error", "msg": traceback.format_exc()}
        _sbtx_failed = True
    finally:
        sys.stdout = _sbtx_old
    _sbtx_r["out"] = _sbtx_buf.getvalue()[-${MSG_MAX}:]
    _sbtx_out.append(_sbtx_r)
    with open(_sbtx_depp, "w") as _sbtx_f:
        json.dump(_sbtx_deps(), _sbtx_f)
    with open(_sbtx_outp, "w") as _sbtx_f:
        json.dump(_sbtx_out, _sbtx_f)
`;

/** The session's own last words: its stderr's last lines, without the runtime's version line. */
const sessionError = (err: string) => err.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() && !/^(Node\.js|Bun) v[0-9.]+/.test(l.trim())).slice(-4).join("\n");
/** The command line of this sagebrush in Sage mode, to run the session in (the bundle that loaded this file). */
function sageCommand(cli: string | undefined): string[] | null {
  if (!cli || !existsSync(cli)) return null;
  return [process.execPath, cli, "--sage"];
}

async function runCommand(file: string, text: string, timeout: number, json: boolean, cli: string | undefined): Promise<number> {
  const items = new Engine({}).update(text, { cold: true }).sageItems as any[];
  const report = (o: any, code: number) => { if (json) process.stdout.write(JSON.stringify(o, null, 2) + "\n"); return code; };
  if (!items.length) {
    if (!json) process.stdout.write(`${file}: no SageTeX or PythonTeX code to run\n`);
    return report({ file, items: [], results: null }, 0);
  }
  const cmd = sageCommand(cli);
  if (!cmd) return fail("can't find this sagebrush's own bundle to run the code in");
  const tmp = mkdtempSync(join(tmpdir(), "sb-latex-run-"));
  const runnable = items.map((it) => (it.err ? null : { mode: it.mode, code: it.code }));
  // (only the items up to the first refused one are run: a refused item fails, and stops the rest, as in the page)
  const firstBad = runnable.findIndex((x) => x === null);
  const toRun = (firstBad < 0 ? runnable : runnable.slice(0, firstBad)) as { mode: string; code: string }[];
  writeFileSync(join(tmp, "items.json"), JSON.stringify(toRun));
  writeFileSync(join(tmp, "driver.sage"), DRIVER);
  const outp = join(tmp, "out.json"), depp = join(tmp, "deps.json");
  // (the folder's .py files hashed before the run: what it imports is recorded only if unchanged by the end)
  const before = preHashes(dirname(resolve(file)));
  const t0 = Date.now();
  const done = await new Promise<{ code: number | null; timedOut: boolean; err: string }>((res) => {
    const p = spawn(cmd[0], [...cmd.slice(1), join(tmp, "driver.sage"), join(tmp, "items.json"), outp, depp], { cwd: dirname(resolve(file)), stdio: ["ignore", "ignore", "pipe"] });
    let err = "", timedOut = false;
    p.stderr!.on("data", (d) => { if (err.length < 16384) err += d; });
    const t = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, timeout * 1000);
    p.on("close", (code) => { clearTimeout(t); res({ code, timedOut, err }); });
    p.on("error", (e) => { clearTimeout(t); res({ code: -1, timedOut, err: e.message }); });
  });
  let got: any[] = [];
  try { got = existsSync(outp) ? JSON.parse(readFileSync(outp, "utf8")) : []; } catch {}
  // (what it imported from the .tex's folder: each file hashed again, and recorded only if it is as it was before the
  //  run (DEP-SNAPSHOT-1); one changed, new, not hashed before, unreadable, unsafe or past the bounds, and the record is
  //  "incomplete", so none of these results is used later: never a record left out, as an older file's is)
  let deps: [string, string][] | "incomplete" = [];
  try {
    const rels = existsSync(depp) ? JSON.parse(readFileSync(depp, "utf8")) : got.length ? null : [];
    if (!Array.isArray(rels) || rels.length > DEPS_MAX || !rels.every(safeRel)) deps = "incomplete";
    else {
      const read = folderReader(dirname(resolve(file)));
      let left = DEPS_BYTES;
      const out: [string, string][] = [];
      for (const rel of rels as string[]) {
        const b = read(rel, left), h = b && b !== "over" ? sha256(b) : null;
        if (!h || before.get(rel) !== h) { deps = "incomplete"; break; }
        out.push([rel, h]); left -= (b as Uint8Array).length;
      }
      if (deps !== "incomplete") deps = out;
    }
  } catch { deps = "incomplete"; }
  removeTemp(tmp);
  const states: State[] = [];
  let failed = false;
  // (a traceback without the session script's own frames: the item's code is the "<sagetex>" one)
  const msgOf = (x: any) => {
    const lines = String(x?.msg ?? "").split("\n"), out: string[] = [];
    for (let i = 0; i < lines.length; i++) { if (/^\s*File ".*driver\.sage", line \d+/.test(lines[i])) { if (/^\s{4,}\S/.test(lines[i + 1] ?? "") && !/^\s*File /.test(lines[i + 1])) i++; continue; } out.push(lines[i]); }
    return out.join("\n").slice(-MSG_MAX);
  };
  for (let k = 0; k < items.length; k++) {
    const it = items[k], key = itemKey(it), g = got[k];
    if (failed) { states.push({ key, s: "blocked", msg: "not run: an earlier item failed" }); continue; }
    if (it.err) { states.push({ key, s: "error", msg: "this item can't be run (" + it.err + ")" }); failed = true; continue; }
    if (!g) { states.push({ key, s: "error", msg: done.timedOut ? `not finished: the run stopped at the ${timeout} s timeout` : "not run: the session ended before it (" + (sessionError(done.err) || "exit " + done.code) + ")" }); failed = true; continue; }
    if (g.s === "error") { states.push({ key, s: "error", msg: msgOf(g) }); failed = true; continue; }
    if (g.s === "blocked") { states.push({ key, s: "blocked", msg: "not run: an earlier item failed" }); failed = true; continue; }
    if (it.mode === "sage" || /^py/.test(it.mode)) {
      const l = String(g.latex ?? "");
      if (Buffer.byteLength(l) > MAX_RESULT) { states.push({ key, s: "error", msg: `${it.mode === "sage" ? "the result's LaTeX" : it.mode === "py" ? "the result" : "the printed output"} is over ${MAX_RESULT / 1024} KiB` }); failed = true; continue; }
      states.push({ key, s: "ok", latex: l });
    } else if (it.mode === "plot") {
      const svg = String(g.svg ?? "");
      if (Buffer.byteLength(svg) > SVG_MAX || !/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) { states.push({ key, s: "error", msg: Buffer.byteLength(svg) > SVG_MAX ? `the plot's SVG is over ${SVG_MAX / 2 ** 20} MiB` : "the plot isn't an SVG" }); failed = true; continue; }
      states.push({ key, s: "ok", src: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") });
    } else states.push({ key, s: "ok" });
  }
  const rp = resultsPath(file);
  writeFileSync(rp, JSON.stringify({ format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, generator: "sagebrush latex run", items: states, ...(deps === "incomplete" || deps.length ? { deps } : {}) }) + "\n");
  const lines = items.map((it, k) => ({ n: k + 1, mode: String(it.mode), line: typeof it.at === "number" && it.at >= 0 ? text.slice(0, it.at).split("\n").length : null, state: states[k].s, ...(states[k].s === "error" ? { message: states[k].msg } : {}) }));
  const ms = Date.now() - t0, bad = states.some((x) => x.s === "error");
  if (!json) {
    // (with any PythonTeX item, "code item": board's rule, as the preview's banner)
    const what = items.some((it) => /^py/.test(it.mode)) ? "code item" : "SageTeX item";
    process.stdout.write(`${file}: ran ${states.filter((x) => x.s === "ok").length} of ${items.length} ${what}${items.length === 1 ? "" : "s"} in ${(ms / 1000).toFixed(1)} s; results in ${rp}\n`);
    for (const l of lines) if (l.state !== "ok") process.stdout.write(`${file}:${l.line ?? "-"}: ${l.state === "error" ? "error" : "warning"}: ${what} ${l.n} (${l.mode}) ${l.state === "error" ? "failed:\n" + String(l.message).trimEnd().split("\n").slice(-6).map((x) => "    " + x).join("\n") : "wasn't run: an earlier item failed"}\n`);
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
      removeTemp(profile); profile = "";
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
    if (profile) removeTemp(profile);
  }
}

/** A temporary folder removed, retried a while (Node's maxRetries: ENOTEMPTY, EBUSY, EPERM, ...), and never an error:
 * the browser's helper processes can still be writing into its profile just after it exits, and a render that worked
 * must not become a failure because its scratch folder lingered (a CI flake, #672's checks: png_error ENOTEMPTY). */
export function removeTemp(dir: string, rm: typeof rmSync = rmSync): boolean {
  try { rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); return true; } catch { return false; }
}

/** The browser started headless with its DevTools on a port of its choosing, or why it didn't start. */
async function launch(browser: string, profile: string, extra: string[]): Promise<{ proc: ChildProcess; port: number } | { why: string }> {
  const proc = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions", ...extra, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  // (the browser's own last words, its stderr's last 2 KB, kept for every "why" below: a start that fails in CI
  //  then says what the browser said, not only that it failed; read for its whole life, so it never blocks on a full pipe)
  let said = "";
  proc.stderr?.on("data", (d) => { said = (said + d).slice(-2048); });
  const tail = () => (said.trim() ? `; it said: ${said.trim().slice(-2048)}` : "");
  let exited: string | null = null;
  proc.on("exit", (c, s) => { exited = `the browser (${browser}) exited (${s ?? c}) before it could take the pictures`; });
  proc.on("error", (e) => { exited = `the browser (${browser}) didn't start: ${e.message}`; });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 300; i++) {
    if (exited) { await sleep(100); return { why: exited + tail() }; }
    if (existsSync(portFile)) { const port = parseInt(readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; if (port) return { proc, port }; }
    await sleep(100);
  }
  proc.kill();
  return { why: `the browser (${browser}) didn't open its DevTools port in 30 s` + tail() };
}
