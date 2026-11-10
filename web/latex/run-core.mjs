// The editor's Run (page.ts, William's "sagetex exists tomorrow"): a document's SageTeX items run, in page order, in
// one Sage session of the site's own engine (the board's siteEngine, in the opaque-origin runner), on the person's
// click only; their states written as `sagebrush latex run`'s results file (results v1, FILE.tex.results.json), which
// the page then reads and shows as it shows the CLI's. This file is the part without a page: the session's script,
// and how what it printed becomes the results.
// Unlike the CLI, an item that fails doesn't stop the rest: each one after it runs, and one that reads a name the
// failed one didn't define shows Sage's own NameError.
// SECURITY: the items' code reaches the session only as base64 inside the script (never spliced into it as text); what
// the session prints is parsed, never evaluated, and each result is checked here as the CLI checks it (the LaTeX's
// size, the plot's SVG), and again where it is shown (sagetex.mjs).
import { MAX_RESULT, WRAPPER_VERSION, utf8len, whyRejected, safeRel, sha256hex, DEPS_MAX, isPy } from "./engine/sagetex.mjs";

export const RESULTS_FORMAT = "sagebrush-latex-results";
export const RUN_LIMITS = { svg: 2 * 2 ** 20, msg: 4000 };   // (the CLI's SVG_MAX and MSG_MAX, src/latex-cli.ts)
/** The .tex's folder a Run is given (its files, and their bytes): past either, Run says so and runs nothing. */
export const FOLDER_LIMITS = { files: 500, bytes: 64 * 2 ** 20 };
/** what starts each result line the session prints (a record separator: never in an item's own printing, which is kept apart) */
export const MARK = "\u001eSBTX";
/** what starts the line the session prints last: the modules its Run imported from the .tex's folder (Codex W01) */
export const DEPS_MARK = MARK + "D";

const b64 = (s) => {
  const u = new TextEncoder().encode(s);
  let t = "";
  for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(t);
};

// The driver's notes (Python comments once, kept here so the chunk doesn't carry them):
// (each item compiled as Sage source by the runtime itself, so its code object keeps Sage's semantics when it
//  runs: 1/3 exact, as in a .sage file; plain exec of preparsed text is Python's, 1/3 a float (#706). Given the
//  raw item: that compile preparses it, and preparsing twice would make ^^ a power. CPython: preparsed, exec'd)
// (_sbtx_prev: the previous Run's folder, whose modules go too; _sbtx_added: the sys.path entry a Run appended, the only
//  one taken off: "/" and the runtime's own entries, there before, stay where they are)
// (the modules imported from the .tex's folder so far: printed with each item, before its result (daybreak3's
//  ENGINE-DEPS-PARTIAL-1: a Run stopped later still records what its earlier results used; astra's DEP-PARTIAL-COMMIT-1:
//  a result printed is always after a line naming what it used), the last line counting; the results file records
//  them with their hashes, so an edited helper's old results are never used (Codex W01))
/** The session's script (run in Sage mode, so preparsed itself: it is written to mean the same after that): each item
 * preparsed, then exec'd (sagesilent, sageblock) or eval'd (\sage: its latex(); \sageplot: its SVG), in the session's
 * globals (Sage's var() defines its names there), put back first as they were before the first Run (a name from an
 * earlier Run is gone, a Sage name it redefined, x say, is Sage's again), in order; each result printed
 * as one line at once. `items`: [{mode, code}], the runnable ones. `dir`: the .tex's folder (its files given to the
 * session by putFolder), the working folder and on sys.path last, as real SageTeX has it: `sage doc.sagetex.sage`,
 * run in the document's folder, imports a helper.py beside the .tex, and its sys.path ends with that folder, so a
 * statistics.py there doesn't hide the standard one (the CLI's own, src/latex-cli.ts). The previous Run's folder is
 * taken off, and the modules imported from either dropped: a helper is imported afresh each Run, its edits seen, as by
 * a fresh sage process; and a document in another folder imports its own.
 * @interact in a Run, a Sagebrush extension (William, Nov 8: "@interact inside sagesilent/sageblock as a documented
 * Sagebrush extension"; upstream SageTeX and Sage 10.10 raise NameError on it): each interact an item makes is kept with
 * that item's result (its "interacts"), its controls (the spec _interact gives a host that draws them) and what its
 * function shows at the defaults, its printing and what it show()s (a plot as its SVG, anything else as text), bounded.
 * The script is that host only while it runs: the runtime's own host and display are put back after it, a Stop
 * included (the loop's finally). */
export function driver(items, dir = null) {
  return `import json as _sbtx_json, io as _sbtx_io, sys as _sbtx_sys, traceback as _sbtx_tb, base64 as _sbtx_b64
from sagebrush.preparse import preparse as _sbtx_pp
try:
    _sbtx_cs = __pyjs_compile_sage__
except NameError:
    _sbtx_cs = None
_sbtx_g = globals()
try:
    _sbtx_base
except NameError:
    _sbtx_base = dict(_sbtx_g)
for _sbtx_k in [k for k in _sbtx_g if k not in _sbtx_base and not k.startswith("_sbtx_")]:
    del _sbtx_g[_sbtx_k]
_sbtx_g.update(_sbtx_base)
_sbtx_os = __import__("os")
_sbtx_il = __import__("importlib")
_sbtx_d = _sbtx_json.loads(_sbtx_b64.b64decode("${b64(JSON.stringify(dir))}").decode("utf-8"))
try:
    _sbtx_prev
except NameError:
    _sbtx_prev = None
    _sbtx_added = None
def _sbtx_under(f, d):
    if not isinstance(f, str) or f.startswith("/$"):
        return False
    d = _sbtx_os.path.normpath(d)
    f = _sbtx_os.path.normpath(f)
    return f == d or f.startswith(d + "/") if d != "/" else f.startswith("/")
for _sbtx_p in [p for p in (_sbtx_prev, _sbtx_d) if p is not None]:
    for _sbtx_n in [n for n, m in list(_sbtx_sys.modules.items()) if _sbtx_under(getattr(m, "__file__", None), _sbtx_p) or any(_sbtx_under(q, _sbtx_p) for q in list(getattr(m, "__path__", None) or []))]:
        del _sbtx_sys.modules[_sbtx_n]
    _sbtx_pic = getattr(_sbtx_sys, "path_importer_cache", {})
    for _sbtx_q in [q for q in list(_sbtx_pic) if _sbtx_under(q, _sbtx_p)]:
        del _sbtx_pic[_sbtx_q]
if _sbtx_added is not None and _sbtx_added in _sbtx_sys.path:
    _sbtx_sys.path.remove(_sbtx_added)
_sbtx_prev = _sbtx_d
_sbtx_added = None
if _sbtx_d is not None:
    _sbtx_os.chdir(_sbtx_d)
    if _sbtx_d not in _sbtx_sys.path:
        _sbtx_sys.path.append(_sbtx_d)
        _sbtx_added = _sbtx_d
_sbtx_il.invalidate_caches()
def _sbtx_deps_line():
    if _sbtx_d is None:
        return
    _sbtx_dl = set()
    for _sbtx_m in list(_sbtx_sys.modules.values()):
        _sbtx_f = getattr(_sbtx_m, "__file__", None)
        if _sbtx_under(_sbtx_f, _sbtx_d):
            _sbtx_dl.add(_sbtx_os.path.normpath(_sbtx_f)[len(_sbtx_d.rstrip("/")) + 1:])
    print("\\x1eSBTXD" + _sbtx_json.dumps(sorted(_sbtx_dl)))
import builtins as _sbtx_bi
try:
    _sbtx_h0
except NameError:
    _sbtx_h0 = getattr(_sbtx_bi, "__pyjs_host__", None)
    _sbtx_d0 = getattr(_sbtx_bi, "__pyjs_display__", None)
_sbtx_ia = []
_sbtx_cur = None
def _sbtx_host(op, *a):
    global _sbtx_cur
    if op == "interact":
        if len(_sbtx_ia) >= 8:
            return False
        _sbtx_ia.append({"spec": _sbtx_json.loads(a[0]), "out": "", "shows": []})
        return True
    if op == "target":
        if a and a[0] is not None:
            _sbtx_cur = next((x for x in reversed(_sbtx_ia) if x["spec"].get("id") == a[0]), None)
            if _sbtx_cur is not None:
                _sbtx_cur["was"] = _sbtx_sys.stdout
                _sbtx_cur["buf"] = _sbtx_sys.stdout = _sbtx_io.StringIO()
        elif _sbtx_cur is not None:
            _sbtx_sys.stdout = _sbtx_cur.pop("was")
            _sbtx_cur["out"] = _sbtx_cur.pop("buf").getvalue()[:4000]
            _sbtx_cur = None
        return None
    return _sbtx_h0(op, *a) if _sbtx_h0 is not None else None
def _sbtx_disp(v):
    if _sbtx_cur is None:
        return _sbtx_d0(v) if _sbtx_d0 is not None else False
    if len(_sbtx_cur["shows"]) < 4:
        try:
            _sbtx_cur["shows"].append({"svg": v._repr_svg_()} if hasattr(v, "_repr_svg_") else {"text": repr(v)[:4000]})
        except Exception:
            _sbtx_cur["shows"].append({"text": _sbtx_tb.format_exc(limit=1)[-400:]})
    return True
_sbtx_bi.__pyjs_host__ = _sbtx_host
_sbtx_bi.__pyjs_display__ = _sbtx_disp
_sbtx_pg = {}
try:
    for _sbtx_it in _sbtx_json.loads(_sbtx_b64.b64decode("${b64(JSON.stringify(items))}").decode("utf-8")):
        _sbtx_ia = []
        _sbtx_buf = _sbtx_io.StringIO()
        _sbtx_old = _sbtx_sys.stdout
        _sbtx_sys.stdout = _sbtx_buf
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
        except Exception:
            _sbtx_r = {"s": "error", "msg": _sbtx_tb.format_exc()}
        finally:
            _sbtx_sys.stdout = _sbtx_old
        if _sbtx_ia:
            _sbtx_r["interacts"] = [{"spec": x["spec"], "out": x["out"], "shows": x["shows"]} for x in _sbtx_ia]
        _sbtx_deps_line()
        print("\\x1eSBTX" + _sbtx_json.dumps(_sbtx_r))
finally:
    _sbtx_bi.__pyjs_host__ = _sbtx_h0
    _sbtx_bi.__pyjs_display__ = _sbtx_d0
`;
}

/** The items the session is given: each one the preview can read ({mode, code}), in order; refused ones aren't sent. */
export const runnable = (items) => items.filter((it) => !it.err && typeof it.code === "string").map((it) => ({ mode: it.mode, code: it.code }));

/** What the session printed, its result lines parsed (anything else on stdout is not a result: ignored). */
export function parseOutput(out) {
  const got = [];
  for (const line of String(out).split("\n")) {
    if (!line.startsWith(MARK) || line.startsWith(DEPS_MARK)) continue;
    try { const r = JSON.parse(line.slice(MARK.length)); if (r && typeof r === "object") got.push(r); else got.push({ s: "error", msg: "an unreadable result" }); }
    catch { got.push({ s: "error", msg: "an unreadable result" }); }
  }
  return got;
}

// (a traceback without the session script's own frames, those whose line is the script's (its names: _sbtx_); the
// item's code is the "<sagetex>" one)
export function msgOf(msg) {
  const lines = String(msg ?? "").split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*File ".*", line \d+/.test(lines[i]) && /^\s{4,}\S/.test(lines[i + 1] ?? "") && /_sbtx_/.test(lines[i + 1])) { i++; continue; }
    out.push(lines[i]);
  }
  return out.join("\n").trimEnd().slice(-RUN_LIMITS.msg);
}

/** The results file's states for `items` (the worker's check items: {key, mode, code?, err?}), from the session's
 * results `got` (one per runnable item, in order) and why it ended early, if it did (`stopped`: its message). */
export function statesOf(items, got, stopped, interactsOf = null) {
  const states = [];
  let j = 0;
  for (const it of items) {
    const key = it.key;
    if (it.err || typeof it.code !== "string") { states.push({ key, s: "error", msg: whyRejected(it) }); continue; }
    const g = got[j++];
    if (!g) { states.push({ key, s: "error", msg: "not run: " + (stopped || "the session ended before this item") }); continue; }
    if (g.s !== "ok") { states.push({ key, s: "error", msg: msgOf(g.msg) || "error" }); continue; }
    if (it.mode === "sage" || isPy(it)) {
      const l = String(g.latex ?? "");
      if (utf8len(l) > MAX_RESULT) states.push({ key, s: "error", msg: `${it.mode === "sage" ? "the result's LaTeX" : it.mode === "py" ? "the result" : "the printed output"} is over ${MAX_RESULT / 1024} KiB` });
      else states.push({ key, s: "ok", latex: l });
    } else if (it.mode === "plot") {
      const svg = String(g.svg ?? "");
      if (utf8len(svg) > RUN_LIMITS.svg) states.push({ key, s: "error", msg: `the plot's SVG is over ${RUN_LIMITS.svg / 2 ** 20} MiB` });
      else if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) states.push({ key, s: "error", msg: "the plot isn't an SVG" });
      else states.push({ key, s: "ok", src: "data:image/svg+xml;base64," + b64(svg) });
    } else states.push({ key, s: "ok" });
    const ia = interactsOf && Array.isArray(g.interacts) ? interactsOf(g.interacts) : [];
    if (ia.length && states[states.length - 1].s === "ok") states[states.length - 1].interacts = ia;
  }
  return states;
}

// (the results file checked against the files its Run imported: results-check.mjs, a module of its own so the page
//  reads results without fetching Run's chunk (#824); re-exported for Run's callers)
export { wsReader, seenOf, checkedResults } from "./results-check.mjs";

/** The results file's text. */
export const resultsText = (states, deps = []) => JSON.stringify({ format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, generator: "sagebrush editor", items: states, ...(deps === "incomplete" || deps.length ? { deps } : {}) }) + "\n";
/** The modules the session's Run imported from the .tex's folder (its last line's), paths relative to the folder:
 * only safe relative ones, at most DEPS_MAX; [] if it printed none. */
export function parseDeps(out) {
  // (the last line counts; none at all, one not of the shape (a path not safe, too many), or a result with no line of
  //  its own before it (astra's DEP-PARTIAL-COMMIT-1: what it used not named): null, the record incomplete: never read
  //  as an older results file's no record)
  let got = null, fresh = false;
  for (const line of String(out).split("\n")) {
    if (line.startsWith(DEPS_MARK)) { try { const a = JSON.parse(line.slice(DEPS_MARK.length)); got = Array.isArray(a) ? a : "bad"; } catch { got = "bad"; } fresh = true; }
    else if (line.startsWith(MARK)) { if (!fresh) return null; fresh = false; }
  }
  if (!Array.isArray(got) || got.length > DEPS_MAX || !got.every(safeRel)) return null;
  return got;
}
/** Those modules with their hashes, from the bytes the session was given (`files`, the folder's snapshot, `dir` its
 * folder: the exact input of the Run): [[rel, sha256]], the results file's `deps`; "incomplete" if `rels` is null or
 * one of them wasn't in the snapshot (a file the session had otherwise: not trusted). */
export async function depsWith(rels, files, dir) {
  if (!rels) return "incomplete";
  const byPath = new Map(files), base = dir === "/" ? "" : dir, out = [];
  for (const rel of rels) { const b = byPath.get(base + "/" + rel); if (!b) return "incomplete"; out.push([rel, await sha256hex(b)]); }
  return out;
}

// ---- the session: in the runner, the opaque-origin sandbox, only (astra's LATEX-RUN-2)
// The board's siteEngine gives the runner a fallback, a plain worker of the page's own origin, for a frame that
// doesn't start; this path has none: document code never runs in the page's origin. A runner that fails says so (its
// status, "error: ..."), or doesn't start in startMs: the start fails with SANDBOX_FAILED, the kernel is stopped, and
// the next Run starts a new runner (the sandbox again, never anything else).
export const SANDBOX_FAILED = "Sage couldn't start in the sandbox; reload and try again";
export const SANDBOX_START_MS = 60_000;
/** The engine's parts for Run: the hosting page's own kernel and runner classes (index.html's, where it runs code in
 * the runner: `classes` {WorkerKernel, RunnerWorker}), the runner page beside it at `base`, with no fallback. */
export function sandboxEngine(classes, base) {
  return {
    module: async () => classes,
    worker: (mod) => new mod.RunnerWorker(new URL("runner/", base).href, {}),
  };
}
/** Why Run can't run here: a page without the runner (the desktop app; a browser the site doesn't run the runner in). */
export const NO_SANDBOX = "Run needs the sandbox Sagebrush runs code in, which this browser doesn't have here: open the file in Chrome or Edge on sagebrush.space";
/** A Sage session, started once on the first call and kept; a start that fails is forgotten (the next call starts
 * again). `eng`: sandboxEngine(classes, base). Resolves to the kernel, ready; rejects with SANDBOX_FAILED. */
export function sessionOf(eng, startMs = SANDBOX_START_MS) {
  let start = null;
  const get = () => (start ??= (async () => {
    const mod = await eng.module();
    // (first, before anything runs: the document's code changes no file (astra's LATEX-RUN-2), the page writing the
    //  results file itself; and a new worker has none of the folder's files yet)
    // (a worker started again (after a stop, say): given the last admitted folder again, so a Run admitted against it
    //  never runs on an empty one)
    const onStart = (w) => {
      w.postMessage({ fsWritable: false });
      get.sent.clear();
      for (const [p, data] of get.snapshot) { w.postMessage({ fsPut: p, data }); get.sent.add(p); }
    };
    const k = new mod.WorkerKernel({ createWorker: () => eng.worker(mod), onStart });
    k.start();
    const ok = await new Promise((res) => {
      if (k.ready) return res(true);
      const offs = [];
      const done = (v) => { clearTimeout(t); for (const f of offs) f(); res(v); };
      const t = setTimeout(() => done(false), startMs);
      offs.push(k.on("ready", () => done(true)), k.on("status", (s) => { if (/^error/.test(String(s))) done(false); }));
    });
    if (!ok) { try { k.worker?.terminate?.(); } catch {} k.worker = null; throw new Error(SANDBOX_FAILED); }
    get.kernel = k;
    return k;
  })().catch((e) => { start = null; throw e; }));
  get.kernel = null;
  // (the folder's paths this session's worker was given, and the last folder admitted: putFolder)
  get.sent = new Set();
  get.snapshot = [];
  // (one Run at a time in the session: its folder put in, its script run, then the next; a Run of another document,
  //  or one started while another still runs, never changes the files or the folder under it (astra))
  let turn = Promise.resolve();
  get.serial = (fn) => { const r = turn.then(fn, fn); turn = r.catch(() => {}); return r; };
  return get;
}

// (what code names: the modules it imports, by their first name, at a statement's start (a line's, or after ";" or a
//  one-line suite's ":", daybreak3's #975 ENGINE; a match that isn't one only gives a named file there), and its quoted
//  strings, each maybe a path)
const namesIn = (code) => [...code.matchAll(/(?:^|[;:])[ \t]*(?:from[ \t]+(\w+)|import[ \t]+([\w., \t]+))|(["'])((?:(?!\3)[^\\\n])+)\3/gm)].flatMap((m) => m[4] ? [m[4].replace(/^\.\//, "")] : (m[1] ?? m[2]).split(",").map((x) => x.trim().split(/[ .]/)[0]));
/** The files of the .tex's folder (`texPath`'s, recursively) that the document's `codes` name, and those its named .py
 * and .sage files name in turn (William's H2: a folder of many files, the code using none of them, runs): each module
 * imported (m.py, or a package m/ and its .py files) and each quoted string that is the path of a file there; with
 * their bytes, for the session: {dir, files: [path, bytes][]}, or {msg} past FOLDER_LIMITS, counted on those files
 * only. Only the document's own folder: nothing else of the workspace reaches the session, nothing it doesn't name. */
export async function folderFiles(ws, texPath, codes = [], lim = FOLDER_LIMITS) {
  const dir = texPath.slice(0, texPath.lastIndexOf("/")) || "/", base = dir === "/" ? "" : dir;
  const listed = (await ws.list(dir, { recursive: true })).filter((e) => e.kind === "file" && !e.trashed && !e.path.startsWith("/Trash/") && e.path.startsWith(base + "/"));
  const rel = (e) => e.path.slice(base.length + 1), want = new Set(), files = [];
  let bytes = 0, remote = 0, todo = ["", ...codes];   // (one round always: the .tex given even with no code)
  // (board's words: by count, the files named so far in the order first named, at most 5; by bytes,
  //  the largest of those seen first, with their sizes as the file browser shows them (its MB, the site's limits' unit),
  //  at most 5. The count's list always ends "and more" (past 500 it is always cut); the bytes' list only when it is cut
  //  (more than 5 seen): one not cut is complete for what was seen (board's #975 R1))
  const sizes = new Map(), fmt = (n) => (n < 1024 ? `${n} B` : n < 2 ** 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
  const tooMany = () => ({ msg: `Not run: the code uses over ${lim.files} files, and Sage here can be given at most ${lim.files}: ` + [...want].slice(0, 5).join(", ") + " and more." });
  const tooBig = () => ({ msg: `Not run: the code uses over ${lim.bytes / 2 ** 20} MB of files, and Sage here can be given at most ${lim.bytes / 2 ** 20} MB: ` + [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, n]) => `${r} (${fmt(n)})`).join(", ") + (sizes.size > 5 ? " and more." : ".") });
  while (todo.length) {
    const names = new Set(todo.flatMap(namesIn));
    todo = [];
    for (const e of listed) {
      const r = rel(e);
      // (the .tex itself always: the folder the code runs in, as real SageTeX's, exists even when it names no file)
      if (want.has(r) || !(e.path === texPath || names.has(r) || names.has(r.replace(/(\/__init__)?\.py$/, "")) || (/\.py$/.test(r) && names.has(r.split("/")[0])))) continue;
      want.add(r);
      // (files only in the cloud aren't given to Sage: counted, so the Run can say so (board's COPY advisory))
      if (e.remote) { remote++; continue; }
      if (want.size > lim.files) return tooMany();
      // (one listed past what is left: refused unread (grader's Z7); each read bounded by what is left (daybreak3): a file
      //  grown since it was listed is refused, never read whole)
      let over = bytes + e.size > lim.bytes;   // (a size not listed: read, bounded)
      const got = over ? null : await ws.readUpTo(e.path, lim.bytes - bytes).catch((err) => { over = err?.code === "limit"; return null; });
      sizes.set(r, got?.content.length ?? e.size);
      if (over || (bytes += got?.content.length ?? 0) > lim.bytes) return tooBig();
      if (!got) return { msg: `Not run: ${e.path} couldn't be read` };
      files.push([e.path, got.content]);
      if (/\.(py|sage)$/.test(r)) todo.push(new TextDecoder().decode(got.content));
    }
  }
  return { dir, files, remote };
}
/** The folder's files put in kernel `k`'s worker as they are now, all at once (no wait between them); every path it
 * was given before and not in this folder now, another folder's included, deleted there. `s`: the session (sessionOf's
 * get: its sent paths and snapshot, which a restarted worker is given again). */
export function putFolder(k, files, s) {
  const now = new Set(files.map(([p]) => p));
  for (const p of s.sent) if (!now.has(p)) k.post({ fsPut: p, data: null });
  for (const [p, data] of files) k.post({ fsPut: p, data });
  s.sent.clear();
  for (const p of now) s.sent.add(p);
  s.snapshot = files;
}
/** The session's script run in kernel `k`: what it printed (bounded by `max`) and why it ended early, if it did. */
export const runIn = (k, code, max) => new Promise((resolve) => {
  let out = "";
  k.execute(code, { mode: "sage" }, {
    start() {}, display() {}, interact() {}, clear() {}, input(_p, reply) { reply(null); },
    out(t, isErr) { if (!isErr && out.length < max) out += t; },
    done(_ms, o) { resolve({ out, stopped: o?.interrupted ? "the run was stopped" : out.length >= max ? "the results are too large" : o?.error ? "the session stopped with an error" : "" }); },
    stopped(m) { resolve({ out, stopped: String(m || "the session stopped").trim().slice(0, 300) }); },
    skipped() { resolve({ out, stopped: "the session didn't run it" }); },
  });
});

// ---- a Run, start to results file (astra's LATEX-RUN-1)
// A Run whose page was closed or replaced, or that a newer Run has superseded (`current()` false), writes nothing:
// checked after every wait, and once more inside the workspace's lock (write's admit) before the bytes are written.
// The results file is pinned: an existing one is written only if it is still that file (its fid) at the revision just
// read (base), and a new one only created, never written over (a create that finds one made meanwhile writes
// nothing): a newer Run's results, another tab's, or a file put at that path, are never replaced by this one's.
/** -> { ok: true, states, ms } | { stale: true } | { msg } (why nothing was written). `o`: { items (the worker's
 * check items), session (sessionOf), exec (runIn), ws, fid (the .tex's), current () => boolean, signal, max, now,
 * folder? () => folderFiles(...), store?, serial? (the session: sessionOf's get, and its get.serial), stop? (this Run's
 * own Stop: waiting, it runs nothing; running, its script is interrupted and what ran is written) } */
export async function runAndSave(o) {
  const stale = () => !o.current() || !!o.signal?.aborted;
  const t0 = o.now();
  // (the .tex's folder, read first: one too large says so before Sage starts)
  const f = o.folder ? await o.folder(runnable(o.items).map((it) => it.code)) : null;
  if (stale()) return { stale: true };
  if (f?.msg) return { msg: f.msg };
  const k = await o.session();
  if (stale()) return { stale: true };
  const stopAsked = () => !!o.stop?.aborted;
  const go = async () => {
    // (the test build only: the page test can hold a Run here, its turn in the session taken, to queue another behind
    //  it; elsewhere this folds away)
    if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await globalThis.__sbTexRunHold?.();
    if (stale()) return null;
    // (this Run stopped (its own Stop) while it waited: nothing runs (astra's LATEX-QUEUE-STOP-1))
    if (stopAsked()) return { stoppedBefore: true };
    // (the .tex still in the folder that was read: moved meanwhile, nothing runs)
    if (f) {
      const at = await o.ws.pathOfFile(o.fid);
      if (stale()) return null;
      if (stopAsked()) return { stoppedBefore: true };
      if (!at.ok || (at.path.slice(0, at.path.lastIndexOf("/")) || "/") !== f.dir) return { moved: true };
      putFolder(k, f.files, o.store);
    }
    // (this Run cancelled (its page gone) or stopped (its Stop) while its script runs: that script interrupted, only
    //  it: the next Run's hasn't started. Stopped, what ran is still written, as before)
    const cancel = () => k.interrupt?.();
    o.signal?.addEventListener("abort", cancel);
    o.stop?.addEventListener("abort", cancel);
    // (the interpreter the script ran in: its generation then, or -1 if it was started again while the script ran, its
    //  interacts gone; a Run's live interacts are that generation's (interact.ts))
    try { const g = k.generation, r = await o.exec(k, driver(runnable(o.items), f ? f.dir : null), o.max); return r && { ...r, gen: k.generation === g ? g : -1 }; }
    finally { o.signal?.removeEventListener("abort", cancel); o.stop?.removeEventListener("abort", cancel); }
  };
  const ran = await (o.serial ? o.serial(go) : go());
  if (!ran || stale()) return { stale: true };
  if (ran.moved) return { msg: "Not run: the .tex was moved meanwhile; press Run again" };
  // (a distinct mark: runIn's own `stopped` is why a Run that ran ended early, its results still written (astra))
  if (ran.stoppedBefore === true) return { msg: "Stopped before it ran" };
  const { out, stopped } = ran;
  // (an item's @interacts, checked by the interact chunk's interactsOf: fetched only when the session returned one, so a
  //  document without any never fetches it (daybreak2's SIZE design for the Beamer plan's PR 3); not there, none kept)
  const got = parseOutput(out);
  let ia = null;
  if (o.interacts && got.some((g) => Array.isArray(g.interacts) && g.interacts.length)) { try { ia = (await o.interacts()).interactsOf; } catch {} }
  if (stale()) return { stale: true };
  const states = statesOf(o.items, got, stopped, ia);
  // (no results printed at all: nothing ran, nothing to record)
  const deps = !f ? [] : parseOutput(out).length ? await depsWith(parseDeps(out), f.files, f.dir) : [];
  if (stale()) return { stale: true };
  const bytes = new TextEncoder().encode(resultsText(states, deps));
  if (bytes.length > o.max) return { msg: "Not saved: the results are too large" };
  // (the .tex where it is now, by its id, as Save finds it)
  const at = await o.ws.pathOfFile(o.fid);
  if (stale()) return { stale: true };
  if (!at.ok) return { msg: "Not saved: this file isn't here any more" };
  const rp = at.path + ".results.json";
  const e = await o.ws.stat(rp).catch(() => undefined);
  if (stale()) return { stale: true };
  const STALE = "stale run";
  const admit = () => { if (stale()) throw Object.assign(new Error(STALE), { code: STALE }); };
  const changed = { msg: "Not saved: the results file changed meanwhile (another tab or Run); press Run again" };
  try {
    if (e && e.trashed) return { msg: "Not saved: the results file is in the Trash; restore or delete it, then press Run" };
    if (e) await o.ws.write(rp, bytes, { fid: e.fid, base: e.rev ?? 0, admit });
    else await o.ws.createByPerson(rp, { content: bytes, signal: o.signal });
  } catch (err) {
    if (err?.code === STALE || stale()) return { stale: true };
    if (err?.code === "conflict" || err?.code === "exists") return changed;
    throw err;
  }
  // (the interacts this Run made, by id: live in the page while its session lasts (interact.ts live))
  return { ok: true, states, ms: o.now() - t0, remote: f?.remote ?? 0, interactIds: Object.assign(new Set(states.flatMap((x) => (x.interacts ?? []).map((i) => i.id))), { gen: ran.gen }) };
}
