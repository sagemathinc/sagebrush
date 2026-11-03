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
import { MAX_RESULT, WRAPPER_VERSION, utf8len, whyRejected } from "./engine/sagetex.mjs";

export const RESULTS_FORMAT = "sagebrush-latex-results";
export const RUN_LIMITS = { svg: 2 * 2 ** 20, msg: 4000 };   // (the CLI's SVG_MAX and MSG_MAX, src/latex-cli.ts)
/** what starts each result line the session prints (a record separator: never in an item's own printing, which is kept apart) */
export const MARK = "\u001eSBTX";

const b64 = (s) => {
  const u = new TextEncoder().encode(s);
  let t = "";
  for (let i = 0; i < u.length; i += 0x8000) t += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(t);
};

/** The session's script (run in Sage mode, so preparsed itself: it is written to mean the same after that): each item
 * preparsed, then exec'd (sagesilent, sageblock) or eval'd (\sage: its latex(); \sageplot: its SVG), in the session's
 * globals (Sage's var() defines its names there), put back first as they were before the first Run (a name from an
 * earlier Run is gone, a Sage name it redefined, x say, is Sage's again), in order; each result printed
 * as one line at once. `items`: [{mode, code}], the runnable ones. */
export function driver(items) {
  return `import json as _sbtx_json, io as _sbtx_io, sys as _sbtx_sys, traceback as _sbtx_tb, base64 as _sbtx_b64
from sagebrush.preparse import preparse as _sbtx_pp
_sbtx_g = globals()
try:
    _sbtx_base
except NameError:
    _sbtx_base = dict(_sbtx_g)
for _sbtx_k in [k for k in _sbtx_g if k not in _sbtx_base and not k.startswith("_sbtx_")]:
    del _sbtx_g[_sbtx_k]
_sbtx_g.update(_sbtx_base)
for _sbtx_it in _sbtx_json.loads(_sbtx_b64.b64decode("${b64(JSON.stringify(items))}").decode("utf-8")):
    _sbtx_buf = _sbtx_io.StringIO()
    _sbtx_old = _sbtx_sys.stdout
    _sbtx_sys.stdout = _sbtx_buf
    try:
        _sbtx_code = _sbtx_pp(_sbtx_it["code"])
        if _sbtx_it["mode"] == "sage":
            _sbtx_r = {"s": "ok", "latex": str(latex(eval(_sbtx_code, _sbtx_g)))}
        elif _sbtx_it["mode"] == "plot":
            _sbtx_v = eval(_sbtx_code, _sbtx_g)
            if not hasattr(_sbtx_v, "_repr_svg_"):
                raise TypeError("sageplot needs a graphics object (a plot), not " + type(_sbtx_v).__name__)
            _sbtx_r = {"s": "ok", "svg": _sbtx_v._repr_svg_()}
        else:
            exec(_sbtx_code, _sbtx_g)
            _sbtx_r = {"s": "ok"}
    except Exception:
        _sbtx_r = {"s": "error", "msg": _sbtx_tb.format_exc()}
    finally:
        _sbtx_sys.stdout = _sbtx_old
    print("\\x1eSBTX" + _sbtx_json.dumps(_sbtx_r))
`;
}

/** The items the session is given: each one the preview can read ({mode, code}), in order; refused ones aren't sent. */
export const runnable = (items) => items.filter((it) => !it.err && typeof it.code === "string").map((it) => ({ mode: it.mode, code: it.code }));

/** What the session printed, its result lines parsed (anything else on stdout is not a result: ignored). */
export function parseOutput(out) {
  const got = [];
  for (const line of String(out).split("\n")) {
    if (!line.startsWith(MARK)) continue;
    try { const r = JSON.parse(line.slice(MARK.length)); if (r && typeof r === "object") got.push(r); else got.push({ s: "error", msg: "an unreadable result" }); }
    catch { got.push({ s: "error", msg: "an unreadable result" }); }
  }
  return got;
}

// (a traceback without the session script's own frames, those whose line is the script's (its names: _sbtx_); the
// item's code is the "<string>" one)
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
export function statesOf(items, got, stopped) {
  const states = [];
  let j = 0;
  for (const it of items) {
    const key = it.key;
    if (it.err || typeof it.code !== "string") { states.push({ key, s: "error", msg: whyRejected(it) }); continue; }
    const g = got[j++];
    if (!g) { states.push({ key, s: "error", msg: "not run: " + (stopped || "the session ended before this item") }); continue; }
    if (g.s !== "ok") { states.push({ key, s: "error", msg: msgOf(g.msg) || "error" }); continue; }
    if (it.mode === "sage") {
      const l = String(g.latex ?? "");
      if (utf8len(l) > MAX_RESULT) states.push({ key, s: "error", msg: `the result's LaTeX is over ${MAX_RESULT} bytes` });
      else states.push({ key, s: "ok", latex: l });
    } else if (it.mode === "plot") {
      const svg = String(g.svg ?? "");
      if (utf8len(svg) > RUN_LIMITS.svg) states.push({ key, s: "error", msg: `the plot's SVG is over ${RUN_LIMITS.svg} bytes` });
      else if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) states.push({ key, s: "error", msg: "the plot isn't an SVG" });
      else states.push({ key, s: "ok", src: "data:image/svg+xml;base64," + b64(svg) });
    } else states.push({ key, s: "ok" });
  }
  return states;
}

/** The results file's text. */
export const resultsText = (states) => JSON.stringify({ format: RESULTS_FORMAT, version: 1, wrapper: WRAPPER_VERSION, generator: "sagebrush editor", items: states }) + "\n";
