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

// ---- the session: in the runner, the opaque-origin sandbox, only (astra's LATEX-RUN-2)
// The board's siteEngine gives the runner a fallback, a plain worker of the page's own origin, for a frame that
// doesn't start; this path has none: document code never runs in the page's origin. A runner that fails says so (its
// status, "error: ..."), or doesn't start in startMs: the start fails with SANDBOX_FAILED, the kernel is stopped, and
// the next Run starts a new runner (the sandbox again, never anything else).
export const SANDBOX_FAILED = "Sage couldn't start in the sandbox; reload and try again";
export const SANDBOX_START_MS = 60_000;
/** The engine's parts for Run: the notebook module beside the page and its runner, with no fallback. */
export function sandboxEngine(base) {
  return {
    module: () => import(new URL("sagebrush-notebook.js", base).href),
    worker: (mod) => new mod.RunnerWorker(new URL("runner/", base).href, {}),
  };
}
/** A Sage session, started once on the first call and kept; a start that fails is forgotten (the next call starts
 * again). `eng`: sandboxEngine(base) (a test's fake). Resolves to the kernel, ready; rejects with SANDBOX_FAILED. */
export function sessionOf(eng, startMs = SANDBOX_START_MS) {
  let start = null;
  const get = () => (start ??= (async () => {
    const mod = await eng.module();
    const k = new mod.WorkerKernel({ createWorker: () => eng.worker(mod) });
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
  return get;
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
 * check items), session (sessionOf), exec (runIn), ws, fid (the .tex's), current () => boolean, signal, max, now } */
export async function runAndSave(o) {
  const stale = () => !o.current() || !!o.signal?.aborted;
  const t0 = o.now();
  const k = await o.session();
  if (stale()) return { stale: true };
  const { out, stopped } = await o.exec(k, driver(runnable(o.items)), o.max);
  if (stale()) return { stale: true };
  const states = statesOf(o.items, parseOutput(out), stopped);
  const bytes = new TextEncoder().encode(resultsText(states));
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
  const changed = { msg: "Not saved: the results file changed meanwhile (another tab or Run): press Run again" };
  try {
    if (e && e.trashed) return { msg: "Not saved: the results file is in the Trash: restore or delete it, then press Run" };
    if (e) await o.ws.write(rp, bytes, { fid: e.fid, base: e.rev ?? 0, admit });
    else await o.ws.createByPerson(rp, { content: bytes, signal: o.signal });
  } catch (err) {
    if (err?.code === STALE || stale()) return { stale: true };
    if (err?.code === "conflict" || err?.code === "exists") return changed;
    throw err;
  }
  return { ok: true, states, ms: o.now() - t0 };
}
