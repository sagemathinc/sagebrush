// The editor's Run (page.ts, William's "sagetex exists tomorrow"): a document's SageTeX items run, in page order, in
// one Sage session of the site's own engine (the board's siteEngine, in the opaque-origin runner), on the person's
// click only; their states written as `sagebrush latex run`'s results file (results v1, FILE.tex.results.json), which
// the page then reads and shows as it shows the CLI's. This file is the part without a page: the session's script,
// and how what it printed becomes the results.
// An item that fails stops the rest, as in the CLI (@sagebrush's ruling, Nov 10, for every language): the script ends
// there, a refused item isn't sent nor anything after it, and each later item says so (BLOCKED, board's M4).
// SECURITY: the items' code reaches the session only as base64 inside the script (never spliced into it as text); what
// the session prints is parsed, never evaluated, and each result is checked here as the CLI checks it (the LaTeX's
// size, the plot's SVG), and again where it is shown (sagetex.mjs).
import { MAX_RESULT, WRAPPER_VERSION, utf8len, whyRejected, safeRel, sha256hex, DEPS_MAX, isPy, isNonSage, BLOCKED } from "./engine/sagetex.mjs";

export const RESULTS_FORMAT = "sagebrush-latex-results";
export const RUN_LIMITS = { svg: 2 * 2 ** 20, msg: 4000 };   // (the CLI's SVG_MAX and MSG_MAX, src/latex-cli.ts)
/** The .tex's folder a Run is given (its files, and their bytes): past either, Run says so and runs nothing. */
export const FOLDER_LIMITS = { files: 500, bytes: 64 * 2 ** 20 };
/** what starts each result line the session prints (a record separator: never in an item's own printing, which is kept apart) */
// (what a plot's SVG starts with: checked here and, the same pattern, in the session's script)
const SVG_HEAD = /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/;
export const MARK = "\u001eSBTX";
/** what starts the line the session prints last: the modules its Run imported from the .tex's folder (Codex W01) */
export const DEPS_MARK = MARK + "D";

const b64 = (s) => {
  const u = new TextEncoder().encode(s);
  let t = "";
  for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(t);
};

// The driver's notes (Python comments once, kept here so the chunk doesn't carry them; its Python indented by 2, also
//  for the chunk's size):
// (each item compiled as Sage source by the runtime itself, so its code object keeps Sage's semantics when it
//  runs: 1/3 exact, as in a .sage file; plain exec of preparsed text is Python's, 1/3 a float (#706). Given the
//  raw item: that compile preparses it, and preparsing twice would make ^^ a power. CPython: preparsed, exec'd)
// (_sx_prev: the previous Run's folder, whose modules go too; _sx_added: the sys.path entry a Run appended, the only
//  one taken off: "/" and the runtime's own entries, there before, stay where they are)
// (a result over its cap, or a plot that isn't an SVG (SVG_HEAD), fails in the script too, before the next item runs
//  (daybreak3's STOP-RESULT-1 on #985): statesOf's own check says so, the same tests)
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
  return `import json as _sx_json, io as _sx_io, sys as _sx_sys, traceback as _sx_tb, base64 as _sx_b64
from sagebrush.preparse import preparse as _sx_pp
try:
  _sx_cs = __pyjs_compile_sage__
except NameError:
  _sx_cs = None
_sx_g = globals()
try:
  _sx_base
except NameError:
  _sx_base = dict(_sx_g)
for _sx_k in [k for k in _sx_g if k not in _sx_base and not k.startswith("_sx_")]:
  del _sx_g[_sx_k]
_sx_g.update(_sx_base)
_sx_os = __import__("os")
_sx_il = __import__("importlib")
_sx_rx = __import__("re")
_sx_d = _sx_json.loads(_sx_b64.b64decode("${b64(JSON.stringify(dir))}").decode("utf-8"))
try:
  _sx_prev
except NameError:
  _sx_prev = None
  _sx_added = None
def _sx_under(f, d):
  if not isinstance(f, str) or f.startswith("/$"):
    return False
  d = _sx_os.path.normpath(d)
  f = _sx_os.path.normpath(f)
  return f == d or f.startswith(d + "/") if d != "/" else f.startswith("/")
for _sx_p in [p for p in (_sx_prev, _sx_d) if p is not None]:
  for _sx_n in [n for n, m in list(_sx_sys.modules.items()) if _sx_under(getattr(m, "__file__", None), _sx_p) or any(_sx_under(q, _sx_p) for q in list(getattr(m, "__path__", None) or []))]:
    del _sx_sys.modules[_sx_n]
  _sx_pic = getattr(_sx_sys, "path_importer_cache", {})
  for _sx_q in [q for q in list(_sx_pic) if _sx_under(q, _sx_p)]:
    del _sx_pic[_sx_q]
if _sx_added is not None and _sx_added in _sx_sys.path:
  _sx_sys.path.remove(_sx_added)
_sx_prev = _sx_d
_sx_added = None
if _sx_d is not None:
  _sx_os.chdir(_sx_d)
  if _sx_d not in _sx_sys.path:
    _sx_sys.path.append(_sx_d)
    _sx_added = _sx_d
_sx_il.invalidate_caches()
def _sx_deps_line():
  if _sx_d is None:
    return
  _sx_dl = set()
  for _sx_m in list(_sx_sys.modules.values()):
    _sx_f = getattr(_sx_m, "__file__", None)
    if _sx_under(_sx_f, _sx_d):
      _sx_dl.add(_sx_os.path.normpath(_sx_f)[len(_sx_d.rstrip("/")) + 1:])
  print("\\x1eSBTXD" + _sx_json.dumps(sorted(_sx_dl)))
import builtins as _sx_bi
try:
  _sx_h0
except NameError:
  _sx_h0 = getattr(_sx_bi, "__pyjs_host__", None)
  _sx_d0 = getattr(_sx_bi, "__pyjs_display__", None)
_sx_ia = []
_sx_cur = None
def _sx_host(op, *a):
  global _sx_cur
  if op == "interact":
    if len(_sx_ia) >= 8:
      return False
    _sx_ia.append({"spec": _sx_json.loads(a[0]), "out": "", "shows": []})
    return True
  if op == "target":
    if a and a[0] is not None:
      _sx_cur = next((x for x in reversed(_sx_ia) if x["spec"].get("id") == a[0]), None)
      if _sx_cur is not None:
        _sx_cur["was"] = _sx_sys.stdout
        _sx_cur["buf"] = _sx_sys.stdout = _sx_io.StringIO()
    elif _sx_cur is not None:
      _sx_sys.stdout = _sx_cur.pop("was")
      _sx_cur["out"] = _sx_cur.pop("buf").getvalue()[:4000]
      _sx_cur = None
    return None
  return _sx_h0(op, *a) if _sx_h0 is not None else None
def _sx_disp(v):
  if _sx_cur is None:
    return _sx_d0(v) if _sx_d0 is not None else False
  if len(_sx_cur["shows"]) < 4:
    try:
      _sx_cur["shows"].append({"svg": v._repr_svg_()} if hasattr(v, "_repr_svg_") else {"text": repr(v)[:4000]})
    except Exception:
      _sx_cur["shows"].append({"text": _sx_tb.format_exc(limit=1)[-400:]})
  return True
_sx_bi.__pyjs_host__ = _sx_host
_sx_bi.__pyjs_display__ = _sx_disp
_sx_pg = {}
_sx_mg = {}
_sx_x = 0
try:
  for _sx_it in _sx_json.loads(_sx_b64.b64decode("${b64(JSON.stringify(items))}").decode("utf-8")):
    _sx_ia = []
    _sx_buf = _sx_io.StringIO()
    _sx_old = _sx_sys.stdout
    _sx_sys.stdout = _sx_buf
    try:
      _sx_m = _sx_it["mode"]
      _sx_mm = _sx_m[:5] == "magma"
      _sx_py = _sx_m[:2] == "py"
      _sx_ev = "eval" if _sx_m in ("sage", "plot", "py") else "exec"
      _sx_s = _sx_it["code"].strip() if _sx_ev == "eval" else _sx_it["code"]
      _sx_code = __pyjs_compile_magma__("print " + _sx_s.strip() + ";" if _sx_m == "magma" else _sx_s, "<magma>", "exec") if _sx_mm else compile(_sx_s, "<pythontex>", _sx_ev) if _sx_py else _sx_cs(_sx_s, "<sagetex>", _sx_ev) if _sx_cs else _sx_pp(_sx_it["code"])
      if _sx_m == "sage":
        _sx_r = {"s": "ok", "latex": str(latex(eval(_sx_code, _sx_g)))}
      elif _sx_m == "py":
        _sx_r = {"s": "ok", "latex": str(eval(_sx_code, _sx_pg))}
      elif _sx_m == "plot":
        _sx_v = eval(_sx_code, _sx_g)
        if not hasattr(_sx_v, "_repr_svg_"):
          raise TypeError("sageplot needs a graphics object (a plot), not " + type(_sx_v).__name__)
        _sx_r = {"s": "ok", "svg": _sx_v._repr_svg_()}
      elif _sx_mm:
        exec(_sx_code, _sx_mg)
        _sx_r = {"s": "ok", "latex": _sx_buf.getvalue()}
      else:
        exec(_sx_code, _sx_pg if _sx_py else _sx_g)
        _sx_r = {"s": "ok", "latex": _sx_buf.getvalue()} if _sx_py else {"s": "ok"}
    except SystemExit as _sx_e:
      _sx_r = {"s": "ok", "latex": _sx_buf.getvalue()} if _sx_mm and _sx_e.code in (0, None) else {"s": "error", "msg": _sx_buf.getvalue() if _sx_mm else _sx_tb.format_exc()}
      if _sx_r["s"] == "error":
        _sx_x = 1
    except Exception:
      _sx_r = {"s": "error", "msg": _sx_tb.format_exc()}
      _sx_x = 1
    finally:
      _sx_sys.stdout = _sx_old
    _sx_v = _sx_r.get("svg", _sx_r.get("latex", ""))
    if len(_sx_v.encode("utf-8", "surrogatepass")) > (${RUN_LIMITS.svg} if "svg" in _sx_r else ${MAX_RESULT}) or "svg" in _sx_r and not _sx_rx.match(${JSON.stringify(SVG_HEAD.source)}, _sx_v):
      _sx_x = 1
    if _sx_ia:
      _sx_r["interacts"] = [{"spec": x["spec"], "out": x["out"], "shows": x["shows"]} for x in _sx_ia]
    _sx_deps_line()
    print("\\x1eSBTX" + _sx_json.dumps(_sx_r))
    if _sx_x:
      break
finally:
  _sx_bi.__pyjs_host__ = _sx_h0
  _sx_bi.__pyjs_display__ = _sx_d0
`;
}

/** The items the session is given: each one the preview can read ({mode, code}), in order, up to the first refused one
 * (which fails, so nothing after it runs). */
export const runnable = (items) => { const k = items.findIndex((it) => it.err || typeof it.code !== "string"); return (k < 0 ? items : items.slice(0, k)).map((it) => ({ mode: it.mode, code: it.code })); };
export { BLOCKED };

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

// (a traceback without the session script's own frames, those whose line is the script's (its names: _sx_); the
// item's code is the "<sagetex>" one)
export function msgOf(msg) {
  const lines = String(msg ?? "").split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*File ".*", line \d+/.test(lines[i]) && /^\s{4,}\S/.test(lines[i + 1] ?? "") && /_sx_/.test(lines[i + 1])) { i++; continue; }
    out.push(lines[i]);
  }
  return out.join("\n").trimEnd().slice(-RUN_LIMITS.msg);
}

/** The results file's states for `items` (the worker's check items: {key, mode, code?, err?}), from the session's
 * results `got` (one per runnable item, in order) and why it ended early, if it did (`stopped`: its message). */
export function statesOf(items, got, stopped, interactsOf = null) {
  const states = [];
  let j = 0, failed = false;
  for (const it of items) {
    const key = it.key;
    // (after a failed item, none runs: each says so; a session that ended keeps its own words)
    if (failed) { states.push({ key, s: "blocked", msg: BLOCKED }); continue; }
    // (ran: false: an item that never ran, refused or after the session ended (tally; not written to the file))
    if (it.err || typeof it.code !== "string") { states.push({ key, s: "error", msg: whyRejected(it), ran: false }); failed = true; continue; }
    const g = got[j++];
    if (!g) { states.push({ key, s: "error", msg: "not run: " + (stopped || "the session ended before this item"), ran: false }); continue; }
    if (g.s !== "ok") { states.push({ key, s: "error", msg: msgOf(g.msg) || "error" }); failed = true; continue; }
    if (it.mode === "sage" || isNonSage(it)) {
      const l = String(g.latex ?? "");
      if (utf8len(l) > MAX_RESULT) { states.push({ key, s: "error", msg: `${it.mode === "sage" ? "the result's LaTeX" : it.mode === "py" ? "the result" : "the printed output"} is over ${MAX_RESULT / 1024} KiB` }); failed = true; }
      else states.push({ key, s: "ok", latex: l });
    } else if (it.mode === "plot") {
      const svg = String(g.svg ?? "");
      if (utf8len(svg) > RUN_LIMITS.svg) { states.push({ key, s: "error", msg: `the plot's SVG is over ${RUN_LIMITS.svg / 2 ** 20} MiB` }); failed = true; }
      else if (!SVG_HEAD.test(svg)) { states.push({ key, s: "error", msg: "the plot isn't an SVG" }); failed = true; }
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

/** A Run's count for its status line: the items that ran (ok, raised or over a cap), and of those, how many failed;
 * a refused item, one after the session ended and one after a failure (blocked) never ran (board, #985). */
export const tally = (states) => { const r = states.filter((x) => x.s !== "blocked" && x.ran !== false); return { ran: r.length, failed: r.filter((x) => x.s === "error").length }; };
/** A Run's states, each item it didn't reach keeping its value from an earlier run (@sagebrush's ruling, Nov 12): one
 *  after a failed item (blocked), or one the Run never got to (stopped, or the session ended), takes the earlier value
 *  of the same occurrence of its code (its key: the n-th item with a key takes the n-th earlier result with it), if
 *  that one was ok or kept already: stale, with why ("failed", "stopped" or "ended": the
 *  renderer's sagetex.mjs KEPT words it). One with no such value keeps its state. `prev`: the results the page had
 *  before this Run. A Run that reached every item gets `states` back as is, `prev` not read. */
export function keepLast(states, items, prev, stopped) {
  let old = null, seen = null, out = states;
  const bump = (k) => { const n = seen.get(k) ?? 0; seen.set(k, n + 1); return n; };
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const why = st.s === "blocked" ? "failed" : st.ran === false && !items[i]?.err && /^not run: /.test(st.msg) ? (stopped === "the run was stopped" ? "stopped" : "ended") : null;
    if (!why) { if (seen) bump(st.key); continue; }
    // (the first item not reached: the earlier results by key, in order, and the occurrences before this one counted)
    if (!old) {
      old = new Map(); seen = new Map();
      for (const x of prev ?? []) if (x && typeof x.key === "string") { if (!old.has(x.key)) old.set(x.key, []); old.get(x.key).push(x); }
      for (let j = 0; j < i; j++) bump(states[j].key);
    }
    const x = old.get(st.key)?.[bump(st.key)];
    if (!x || (x.s !== "ok" && x.s !== "stale")) continue;
    // (ran: false: tally doesn't count it as run; the results file keeps the value, stale, with why, but not this mark)
    const k = { key: st.key, s: "stale", why, ran: false };
    for (const f of ["latex", "src", "interacts"]) if (x[f] !== undefined) k[f] = x[f];
    if (out === states) out = states.slice();
    out[i] = k;
  }
  return out;
}
/** The results file's text. */
export const resultsText = (states, deps = []) => JSON.stringify({ format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, generator: "sagebrush editor", items: states.map(({ ran, ...x }) => x), ...(deps === "incomplete" || deps.length ? { deps } : {}) }) + "\n";
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
 * again). `eng`: sandboxEngine(classes, base). Resolves to the kernel, ready; rejects with SANDBOX_FAILED.
 * `mount` (a share page's: [path, {url, sha256, size}][], the shared files its code may read): given to each worker
 * this session starts, after it is told it may change no file. get.dispose() ends the session for good (astra, daybreak3:
 * dispose wins over a start at every step): a kernel started is stopped, one starting is stopped at once and never
 * returned, an engine still loading makes none, and every call after it rejects, never returning a kernel. */
export function sessionOf(eng, startMs = SANDBOX_START_MS, mount = null) {
  let start = null, starting = null, stopWait = null;
  const get = () => (get.disposed ? Promise.reject(new Error(SANDBOX_FAILED)) : (start ??= (async () => {
    const mod = await eng.module();
    // (ended while the engine loaded: nothing made)
    if (get.disposed) throw new Error(SANDBOX_FAILED);
    // (first, before anything runs: the document's code changes no file (astra's LATEX-RUN-2), the page writing the
    //  results file itself; and a new worker has none of the folder's files yet)
    // (a worker started again (after a stop, say): given the last admitted folder again, so a Run admitted against it
    //  never runs on an empty one)
    const onStart = (w) => {
      w.postMessage({ fsWritable: false });
      if (mount) w.postMessage({ mount });
      get.sent.clear();
      for (const [p, data] of get.snapshot) { w.postMessage({ fsPut: p, data }); get.sent.add(p); }
    };
    const k = new mod.WorkerKernel({ createWorker: () => eng.worker(mod), onStart });
    starting = k;
    k.start();
    const ok = await new Promise((res) => {
      if (k.ready) return res(true);
      const offs = [];
      const done = (v) => { clearTimeout(t); for (const f of offs) f(); stopWait = null; res(v); };
      const t = setTimeout(() => done(false), startMs);
      // (dispose() settles the wait at once: the kernel ended then, not at the deadline)
      stopWait = () => done(false);
      offs.push(k.on("ready", () => done(true)), k.on("status", (s) => { if (/^error/.test(String(s))) done(false); }));
    });
    starting = null;
    if (!ok || get.disposed) { end(k); throw new Error(SANDBOX_FAILED); }
    get.kernel = k;
    return k;
  })().catch((e) => { start = null; throw e; })));
  const end = (k) => { try { k.worker?.terminate?.(); } catch {} k.worker = null; };
  get.disposed = false;
  get.dispose = () => {
    get.disposed = true;
    for (const k of [get.kernel, starting]) if (k) end(k);
    get.kernel = null; starting = null;
    stopWait?.();
  };
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
  // (the .tex still in the folder that was read: moved meanwhile, nothing runs)
  const ran = await scriptRun(o, k, f ? f.dir : null, f && (async () => {
    const at = await o.ws.pathOfFile(o.fid);
    if (stale()) return null;
    if (o.stop?.aborted) return { stoppedBefore: true };
    if (!at.ok || (at.path.slice(0, at.path.lastIndexOf("/")) || "/") !== f.dir) return { moved: true };
    putFolder(k, f.files, o.store);
  }));
  if (!ran || stale()) return { stale: true };
  if (ran.moved) return { msg: "Not run: the .tex was moved meanwhile; press Run again" };
  // (a distinct mark: runIn's own `stopped` is why a Run that ran ended early, its results still written (astra))
  if (ran.stoppedBefore === true) return { msg: "Stopped before it ran" };
  const states = await statesAfter(o, ran);
  if (!states) return { stale: true };
  const { out } = ran;
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
  return { ok: true, states, ms: o.now() - t0, remote: f?.remote ?? 0, interactIds: idsOf(states, ran) };
}
// (the interacts a Run made, by id: live in the page while its session lasts (interact.ts live))
const idsOf = (states, ran) => Object.assign(new Set(states.flatMap((x) => (x.interacts ?? []).map((i) => i.id))), { gen: ran.gen });
/** A Run whose results stay in the page (a shared talk's, on the share page): runAndSave's run, with no folder read,
 * no workspace and nothing written. -> { ok: true, states, ms, interactIds } | { stale: true } | { msg }. `o`: items,
 * session, exec, current, signal, stop?, serial?, max, now, prev? (the results shown before it), dir? (the code's
 * working folder: the .tex's, where the session mounted the shared files), interacts? */
export async function runInMemory(o) {
  const stale = () => !o.current() || !!o.signal?.aborted;
  const t0 = o.now();
  const k = await o.session();
  if (stale()) return { stale: true };
  const ran = await scriptRun(o, k, o.dir ?? null, null);
  if (!ran || stale()) return { stale: true };
  if (ran.stoppedBefore === true) return { msg: "Stopped before it ran" };
  const states = await statesAfter(o, ran);
  if (!states) return { stale: true };
  return { ok: true, states, ms: o.now() - t0, interactIds: idsOf(states, ran) };
}
/** A Run's script, in its turn in the session: nothing if the Run went stale or was stopped while it waited; `before`
 * (runAndSave's: the .tex still where its folder was read, the folder put in) may end it first. -> the script's
 * {out, stopped, gen} | {stoppedBefore} | {moved} | null (stale). */
function scriptRun(o, k, dir, before) {
  const stale = () => !o.current() || !!o.signal?.aborted;
  const go = async () => {
    // (the test build only: the page test can hold a Run here, its turn in the session taken, to queue another behind
    //  it; elsewhere this folds away)
    if (typeof __SB_LATEX_TEST__ !== "undefined" && __SB_LATEX_TEST__) await globalThis.__sbTexRunHold?.();
    if (stale()) return null;
    // (this Run stopped (its own Stop) while it waited: nothing runs (astra's LATEX-QUEUE-STOP-1))
    if (o.stop?.aborted) return { stoppedBefore: true };
    if (before) {
      const b = await before();
      if (b !== undefined) return b;
      // (admitted again after that wait, just before the script runs: a Run replaced or stopped meanwhile runs nothing (astra))
      if (stale()) return null;
      if (o.stop?.aborted) return { stoppedBefore: true };
    }
    // (this Run cancelled (its page gone) or stopped (its Stop) while its script runs: that script interrupted, only
    //  it: the next Run's hasn't started. Stopped, what ran is still written, as before)
    const cancel = () => k.interrupt?.();
    o.signal?.addEventListener("abort", cancel);
    o.stop?.addEventListener("abort", cancel);
    // (the interpreter the script ran in: its generation then, or -1 if it was started again while the script ran, its
    //  interacts gone; a Run's live interacts are that generation's (interact.ts))
    try { const g = k.generation, r = await o.exec(k, driver(runnable(o.items), dir), o.max); return r && { ...r, gen: k.generation === g ? g : -1 }; }
    finally { o.signal?.removeEventListener("abort", cancel); o.stop?.removeEventListener("abort", cancel); }
  };
  return o.serial ? o.serial(go) : go();
}
/** A Run's states from what its script printed, an item it didn't reach keeping its value (keepLast); null if the Run
 * went stale meanwhile. An item's @interacts are checked by the interact chunk's interactsOf: fetched only when the
 * session returned one, so a document without any never fetches it (daybreak2's SIZE design for the Beamer plan's
 * PR 3); not there, none kept. */
async function statesAfter(o, ran) {
  const got = parseOutput(ran.out);
  let ia = null;
  if (o.interacts && got.some((g) => Array.isArray(g.interacts) && g.interacts.length)) { try { ia = (await o.interacts()).interactsOf; } catch {} }
  if (!o.current() || o.signal?.aborted) return null;
  return keepLast(statesOf(o.items, got, ran.stopped, ia), o.items, o.prev, ran.stopped);
}
