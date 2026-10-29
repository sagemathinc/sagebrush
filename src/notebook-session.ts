// A notebook session: the pyjs runtime answering the notebook page's
// messages.  The browser runs it in a Web Worker (web/worker.ts); `sagebrush
// notebook` runs it in a Node worker thread behind a local server
// (src/notebook.ts).  The protocol:
//
// In:  {id, code, sage?, magma?, matlab?, repl?, clock?, forget?}  run code (`sage`: Sage
//                                 mode, with sage_all imported; `magma`: Magma,
//                                 translated to Python; `matlab`: MATLAB, the
//                                 same (src/matlab.ts); `repl`: display every
//                                 expression statement, as at a prompt, not just
//                                 the last; `forget`: global names to delete
//                                 first, the reactive notebook's invalidation;
//                                 `mangle`: the cell's id (alphanumeric): its `_`
//                                 names are its own, as in marimo, and are
//                                 deleted before it runs; `scoped`: {name: name
//                                 as written}, page-order scoping's names in
//                                 its code, shown as written in errors; `seed`: 64 hex digits,
//                                 the run's entropy (RunHooks), and Python's
//                                 random and numpy.random are reseeded from it)
//      {id, interact, values}     an @interact control changed: rerun it
//      {id, evaluate: {code, answer}, sage?, magma?, matlab?, seed?}  a board
//                                 question's check, or a computed hint
//                                 (lib/_sb_check.py): `code` run seeing the
//                                 board's names, with `answer` (JSON) bound;
//                                 `done` then has `evaluated`, its verdict as
//                                 JSON {ok, value | error}; the caller runs
//                                 the board's code again after it
//      {id, check, sage?, magma?, matlab?}  -> {id, more}: is this input incomplete?
//      {id, complete, sage?, magma?, matlab?}  -> {id, matches, prefix}: Tab completion
//      {id, warm, sage?, magma?, matlab?}  -> {id, warmed: mode | null, ms?}: load the
//                                 language's environment now (X1), exactly one message
// check, complete and warm each load their language's environment first (the
// one a first run would), and each answer is their one message: with
// {interrupted: true} if a Stop cancelled them (before or during that load), or
// {error} if the load failed.  Every answer and every run's `done` has `mode`
// and `modeReady`: whether that language's environment is loaded.
// Out: {id, start}, then any of
//      {id, target, stream: "stdout" | "stderr", text}
//      {id, target, display: {mime: data}}   rich output (Jupyter MIME bundle)
//      {id, target, interact: spec}           controls to draw
//      {id, target, clear: true}              clear_output()
//      then {id, done, ms, error?} (or {id, skipped} for a run queued before an
//      interrupt); `error`: the code raised (a traceback was written); `names`:
//      global names whose widgets changed (an interact update: the reactive
//      notebook reruns the cells reading them).
// With RunHooks (the browser worker, for TimeTravel replay): a run's `clock`
// is the clock values to replay, and `done` also has the run's clock record
// (web/replay-env.ts ClockRecord).
// `target` is null for the cell's own output, or the id of the @interact
// whose function is running, whose output area should receive it.
import { initParser, R, libDir, packageModuleNames, optionalModuleNames } from "./compile";
import { needsMore, complete, ipythonSyntax } from "./interactive";
import { MAGIC_PRE, MAGIC_POST, GET_IPYTHON, magicTransform } from "./magic-syntax";
import { magmaToPython, MagmaSyntaxError } from "./magma";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage, matlabHostOps, matlabIsIncomplete } from "./matlab";
import { mangleLocals, localPrefix } from "./dataflow";
import { restoreDefNames, RENAME_HELPER, takeInitLines } from "./rename";
import { unbox } from "./runtime/object";
import { DISPLAY_ENVELOPE, displayCost } from "./output-cost";
import { startLimits, type LimitsText } from "./limits";

export interface Session {
  // text Python wrote to a file descriptor (1 or 2), when the host captures it
  write(fd: number, text: string): void;
  handle(m: any): Promise<void>;
  // the interpreter is initialized
  ready: Promise<unknown>;
  // (tests) the language environments loaded so far, and the loads attempted
  stats(): { loaded: string[]; loads: number };
}

// Tests only: called between the admission's steps (1: after the first
// cutoff check, 2: after the stale bit's clear) and just before a language's
// load, so a test can land a Stop exactly there.
export interface SessionHooks {
  admit?(step: 1 | 2, id: number): void;
  beforeLoad?(mode: string, id: number): void;
}

// Around each run (TimeTravel replay, web/replay-env.ts): begin(m) as it
// starts, and end()'s fields are added to its {id, done} message.
export interface RunHooks {
  begin(m: any): void;
  end(): Record<string, unknown>;
}

/** A SystemExit's status as text (a cell exiting with a message): at most
 * STATUS_MAX characters, the rest said not written (HARD-8E4-1); a fixed
 * text if it can't be made text, its __str__ raising (CORR-8E4-2).  Also
 * the Jupyter kernel's (src/kernel.ts). */
export const STATUS_MAX = 4096;
export function exitText(code: unknown): string {
  let t: string;
  try {
    t = String(R.str(code));
  } catch {
    return "(an exit status that could not be written as text)";
  }
  return t.length > STATUS_MAX ? `${t.slice(0, STATUS_MAX)}… (${t.length - STATUS_MAX} more characters)` : t;
}

/** How a SystemExit's status ends a cell, by Python's rule (its type, not
 * how this runtime holds it, CORR-588-1): None, or an integer (bool and int
 * subclasses too, their integer as stored) that is 0, ends it well; another integer fails it, saying
 * nothing; anything else fails it, its text written (exitText). */
export function exitStatus(code: unknown): { ok: boolean; text: string | null } {
  if (code === null || code === undefined) return { ok: true, text: null };
  try {
    // (its integer as stored, as CPython reads it: an int subclass's __bool__ is not asked, CORR-AD9-1)
    if (R.typeOf(code).$mro.includes(R.T.int)) return { ok: BigInt(unbox(code)) === 0n, text: null };
  } catch {}
  return { ok: false, text: exitText(code) };
}

// post: sends a message to the page.  captureStreams: replace sys.stdout and
// sys.stderr's writers (the browser's fs shim captures them instead).
//
// limit (with captureStreams): at most item characters of streams and
// displays a run, run in all (a clear_output() gives its run's back), cut
// where they are written, so that no message is bigger; past either, the
// rest is dropped and {id, cut: "item" | "run" | "displays"} said once a run (board run's
// command line: a print of 40 MB is not copied to the main thread, HARD-BBE-1).
// A display costs its envelope too (output-cost.ts displayCost), and at most `displays` of
// them are posted a run: a million empty displays are not a million messages
// kept for free (HARD-58F-1).
// limits: the engine limits (src/limits.ts), or a promise of them (the
// browser worker's init message); the session's runtime is given them before
// anything else runs, and is never ready if they are invalid (ready rejects
// with a LimitsError).  None: the defaults.
export class LimitsError extends Error {}
export function notebookSession(post: (m: any) => void, opts: { captureStreams?: boolean; init?: (R: any) => void; runs?: RunHooks; limit?: { item: number; run: number; displays: number }; limits?: LimitsText | Promise<LimitsText>; hooks?: SessionHooks } = {}): Session {
  let current: number | null = null;
  let target: number | null = null;
  const write = (fd: number, text: string) => {
    if (current !== null && text) post({ id: current, target, stream: fd === 2 ? "stderr" : "stdout", text });
  };
  const used = { item: 0, run: 0, cut: false, displays: 0 };
  const room = () => (opts.limit ? Math.min(opts.limit.item - used.item, opts.limit.run - used.run) : Infinity);
  const cut = (why?: "displays") => {
    if (!used.cut && current !== null) post({ id: current, cut: why ?? (opts.limit!.item - used.item <= opts.limit!.run - used.run ? "item" : "run") });
    used.cut = true;
  };
  if (opts.captureStreams) {
    // at least every 100 ms during a run, as the Jupyter kernel does
    let last = 0;
    for (const [stream, fd] of [[R.stdout, 1], [R.stderr, 2]] as [any, number][]) {
      stream.write = function (s: string) {
        if (opts.limit && current !== null) {
          if (used.cut) return;
          const n = room();
          if (s.length > n) {
            if (n > 0) {
              this.buf.push(s.slice(0, n));
              used.item += n;
              used.run += n;
            }
            this.flush();
            cut();
            return;
          }
          used.item += s.length;
          used.run += s.length;
        }
        this.buf.push(s);
        this.size += s.length;
        const now = Date.now();
        if (this.size > 1 << 14 || now - last > 100) {
          last = now;
          this.flush();
        }
      };
      stream.flush = function () {
        if (this.buf.length) {
          const text = this.buf.join("");
          this.buf = [];
          this.size = 0;
          write(fd, text);
        }
      };
    }
  }
  const flush = () => {
    R.stdout.flush();
    R.stderr.flush();
  };
  let ipythonDisplay = true;
  R.host = {
    // (a Python cell's value shown as IPython shows it, src/runtime/index.ts
    // displayText; a Sage, Magma or MATLAB cell's keeps the repr, as
    // SageMath's shell shows <class 'int'>; set by each run)
    get ipython() {
      return ipythonDisplay;
    },
    // (MATLAB: a function file, name.m, found on the path, as Python)
    ...matlabHostOps(),
    display(bundle: Record<string, string>) {
      if (current === null) return false;
      flush();
      if (opts.limit) {
        if (used.cut) return true;
        const n = displayCost(bundle);
        if (n > room() || used.displays >= opts.limit.displays) {
          cut(n > room() ? undefined : "displays");
          return true;
        }
        used.item += n;
        used.run += n;
        used.displays++;
      }
      post({ id: current, target, display: bundle });
      return true;
    },
    interact(spec: string) {
      if (current === null) return false;
      flush();
      if (opts.limit) {
        if (used.cut) return true;
        const n = DISPLAY_ENVELOPE + spec.length;
        if (n > room() || used.displays >= opts.limit.displays) {
          cut(n > room() ? undefined : "displays");
          return true;
        }
        used.item += n;
        used.run += n;
        used.displays++;
      }
      post({ id: current, target, interact: JSON.parse(spec) });
      return true;
    },
    target(t: number | null) {
      flush();
      target = t ?? null;
    },
    clear_output() {
      flush();
      used.run -= used.item;
      used.item = 0;
      used.cut = false;
      used.displays = 0;
      if (current !== null) post({ id: current, target, clear: true });
    },
    // global names whose widgets changed (lib/ipywidgets: the reactive notebook)
    changed_names(spec: string) {
      if (current === null) return false;
      for (const n of JSON.parse(spec)) changedNames.add(String(n));
      return true;
    },
  };
  let changedNames = new Set<string>();
  let seededBefore = false;
  // page-order scoping's names in the running cell, and as written (xʹ2 -> x)
  let scopedNames: [string, string][] = [];
  let renameHelper = false;

  const ready = (async () => {
    await initParser();
    const sys = R.importModule("sys");
    sys.path.push(libDir());
    const bad = startLimits(R, (await opts.limits) ?? null);
    if (bad !== null) throw new LimitsError(bad);
    sys.argv.push("");
    opts.init?.(R);
    const main = R.newModule("__main__");
    main.__builtins__ = R.builtins;
    R.dictSet(R.sysModules, "__main__", main);
    // A namespace for the session's own Python (interact updates, figure flushing).
    const host = R.newModule("__sagebrush_host__");
    host.__builtins__ = R.builtins;
    // display(), a builtin in a notebook, as IPython makes it (display(widget)
    // without an import is common): IPython.display's, imported when first used
    R.loader.exec("import builtins as _b\ndef display(*objs, **kw):\n    from IPython.display import display as _d\n    return _d(*objs, **kw)\n_b.display = display\ndel _b, display\n", host, "exec", "<init>");
    // get_ipython(), also a builtin in a notebook (Jupyter's exports call
    // get_ipython().run_line_magic): lib/_pyjs_magic.py's shell
    R.loader.exec(GET_IPYTHON, host, "exec", "<init>");
    return { main, host };
  })();

  // A language's environment, loaded once (X1): Sage's names in __main__,
  // Magma's and MATLAB's runtime modules.  Recorded only when the load
  // succeeded: an interrupted or failed one is tried again by the next
  // request in that language.
  const loaded = new Set<string>();
  let loads = 0;
  const LOAD: Record<string, [string, "main" | "host"]> = {
    sage: ["from sage_all import *\n", "main"],
    magma: ["import _magma\n", "host"],
    matlab: ["import _matlab\n", "host"],
  };
  const modeOf = (m: any) => (m.sage ? "sage" : m.magma ? "magma" : m.matlab ? "matlab" : "python");
  /** The language's environment: "ready", "interrupted" (a Stop during the
   * load) or {error, text} (it raised; text its traceback).  Synchronous:
   * the interpreter runs one thing at a time, so loads never overlap. */
  function ensureMode(mode: string, main: any, host: any, id: number): "ready" | "interrupted" | { error: string; text: string } {
    const what = LOAD[mode];
    if (!what || loaded.has(mode)) return "ready";
    opts.hooks?.beforeLoad?.(mode, id);
    loads++;
    try {
      R.loader.exec(what[0], what[1] === "main" ? main : host, "exec", "<" + mode + ">");
    } catch (e) {
      const exc = R.toPyExc(e);
      if (R.typeOf(exc).$mro.includes(R.T.KeyboardInterrupt)) return "interrupted";
      const text = String(R.formatException(exc));
      const lines = text.trim().split("\n");
      return { error: `the ${mode} environment didn't load: ${lines[lines.length - 1] || "an exception"}`, text };
    }
    loaded.add(mode);
    return "ready";
  }
  /** Whether request `id` may run (X1-R2-STOP): not cancelled by a Stop
   * (the page writes the cutoff INTR[1], then sets bit 0).  The cutoff is
   * read, a stale Ctrl-C (bit 0, from a Stop for earlier requests) cleared,
   * and the cutoff read again; Python follows at once, with no await.  A
   * Stop landing between the reads cancels this request (the bit, kept or
   * cleared, could only have interrupted it: nothing runs at an admission;
   * a kept one is the next admitted request's to clear); one after them
   * interrupts the Python it then runs. */
  function admit(id: number): boolean {
    if (id <= Atomics.load(R.INTR, 1)) return false;
    opts.hooks?.admit?.(1, id);
    Atomics.and(R.INTR, 0, ~1);
    opts.hooks?.admit?.(2, id);
    return id > Atomics.load(R.INTR, 1);
  }
  const moduleNames = () => [
    ...R.builtinModuleNames(),
    ...Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k) => k.split("/")[0].replace(/\.py$/, "")),
    ...packageModuleNames(),
  ];

  // Run Python, reporting an exception as a traceback on stderr; false if it raised.
  function run(src: string, ns: any, mode: string, filename: string, o: { sage?: boolean; transform?: (tree: any) => void } = {}): boolean {
    try {
      R.loader.exec(src, ns, mode, filename, o);
      return true;
    } catch (e) {
      const exc = R.toPyExc(e);
      flush();
      target = null;
      // exit() can't leave a notebook: it just ends the cell.  An exit with
      // a failure's status is the cell failing: sys.exit(1), and Magma's
      // errors in a cell (lib/_magma.py raises SystemExit(1) once it has
      // said them); a message for a status is written, as Python does.
      if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) {
        const s = exitStatus(exc.code);
        if (s.ok) return true;
        if (s.text !== null) R.stderr.write(s.text + "\n");
        return false;
      }
      // A magic Sagebrush does not have, or used wrongly (lib/_pyjs_magic.py's
      // UsageError): its one line, as IPython prints a UsageError, without the
      // frames of the magic's machinery.
      const ty = R.typeOf(exc);
      if (ty.$qualname === "UsageError" && ty.$module === "_pyjs_magic") {
        const lines = String(R.formatException(exc)).trimEnd().split("\n");
        R.stderr.write(lines[lines.length - 1].replace(/^_pyjs_magic\.UsageError\b/, "UsageError") + "\n");
        return false;
      }
      // (a cell's renamed `_` names are shown as written)
      // (and page-order scoping's names, as written: the run's `scoped`)
      let text = R.formatException(exc).replace(/\b_cell_[A-Za-z0-9]+(?=_\w)/g, "");
      // A module Sagebrush does not include: the traceback, then why, in one sentence.
      if (ty.$mro.includes(R.T.ModuleNotFoundError) && typeof exc.name === "string" && exc.name !== "" && !moduleNames().includes(exc.name)) {
        text += `Sagebrush runs Python in this page, compiled to JavaScript: it includes numpy, parts of scipy, a subset of matplotlib.pyplot, ipywidgets and a subset of the standard library, and packages cannot be installed. '${exc.name}' is not included (yet).\n`;
      }
      // (whole names only: xʹ2 is not the start of xʹ20)
      for (const [n, w] of scopedNames) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\p{Mn}_])`, "gu"), w);
      R.stderr.write(text);
      return false;
    }
  }

  // Figures a cell made with matplotlib.pyplot and did not show: show them now, as Jupyter does.
  // And files the cell wrote without closing them: write them now.
  // (and %autoreload's record of the modules the cell imported)
  const FLUSH_FIGURES = "import sys as _s\n_p = _s.modules.get('matplotlib.pyplot')\nif _p is not None: _p._flush_figures()\n_o = _s.modules.get('_pyjs_open')\nif _o is not None: _o._flush_all()\n" + MAGIC_POST;

  // A board question's check, or a computed hint (lib/_sb_check.py): its
  // code, in the board's language, run in a copy of the board's names with
  // `answer` bound; its last expression's value kept (as `__sb_value__`):
  // the verdict, as JSON.  Python and Sage boards (Magma's and MATLAB's
  // come later: said so).
  function evaluate(m: any, host: any): string {
    const e = m.evaluate ?? {}, finish = (error: string | null) => {
      // (by expressions only: no name bound or deleted where the board's names are, a board's _j or _sb_check its own, astra's CORR-AE0-1)
      run(`__import__("_sb_check").finish(__import__("json").loads(${JSON.stringify(JSON.stringify(error))}))\n`, host, "exec", "<check>");
      return String(R.getattr(R.importModule("_sb_check"), "out"));
    };
    if (m.magma || m.matlab) return finish("a question's check runs in Python and Sage boards (Magma and MATLAB come later)");
    if (typeof e.code !== "string") return finish("no code");
    let answer: string;
    try { answer = JSON.stringify(e.answer ?? null); } catch { return finish("its answer is not JSON data"); }
    if (!run(`__import__("_sb_check").prepare(${JSON.stringify(answer)})\n`, host, "exec", "<check>")) return finish("its answer could not be given to it");
    // (the value of its last expression kept: an expression statement at its end assigned to __sb_value__)
    const keep = (t: any) => {
      const last = t.body?.[t.body.length - 1];
      if (last?._type !== "Expr") return;
      const pos = { lineno: last.lineno, col_offset: last.col_offset, end_lineno: last.end_lineno, end_col_offset: last.end_col_offset };
      t.body[t.body.length - 1] = { _type: "Assign", targets: [{ _type: "Name", id: "__sb_value__", ctx: { _type: "Store" }, ...pos }], value: last.value, type_comment: null, ...pos };
    };
    try {
      R.loader.exec(e.code + "\n", R.getattr(R.importModule("_sb_check"), "ns"), "exec", "<check>", { sage: !!m.sage, transform: keep });
    } catch (x) {
      const exc = R.toPyExc(x);
      const lines = String(R.formatException(exc)).trim().split("\n"), last = lines[lines.length - 1] || "an exception";
      return finish(/^KeyboardInterrupt\b/.test(last) ? "it was stopped (out of time)" : last);
    }
    return finish(null);
  }

  async function handle(m: any) {
    const { id } = m;
    const { main, host } = await ready;
    // (each asked question's one answer: cancelled, failed, or its own)
    const ask = m.check !== undefined ? "check" : m.complete !== undefined ? "complete" : m.warm !== undefined ? "warm" : null;
    if (ask !== null) {
      const mode = modeOf(m);
      const none = ask === "check" ? { more: false } : ask === "complete" ? { matches: [], prefix: "" } : { warmed: null };
      if (!admit(id)) return post({ id, ...none, interrupted: true, mode, modeReady: loaded.has(mode) || !LOAD[mode] });
      const t = performance.now();
      const r = ensureMode(mode, main, host, id);
      if (r === "interrupted") return post({ id, ...none, interrupted: true, mode, modeReady: false });
      if (typeof r === "object") return post({ id, ...none, error: r.error, mode, modeReady: false });
      if (ask === "warm") return post({ id, warmed: mode, ms: performance.now() - t, mode, modeReady: true });
      if (ask === "check") {
        // Magma's console runs each line as it is entered; MATLAB's waits for the end of an open block
        return post({ id, more: m.magma ? false : m.matlab ? matlabIsIncomplete(m.check) : needsMore(m.check, { sage: !!m.sage }), mode, modeReady: true });
      }
      const [matches, prefix] = complete(main, m.complete, () => [...new Set(moduleNames())]);
      return post({ id, matches, prefix, mode, modeReady: true });
    }
    if (m.importInfo !== undefined) {
      // Where imports resolve here, for the Share dialog's pre-selection
      // (web/share-client/file-deps.ts, share-ux-plan r2 §2.3): the cwd,
      // sys.path in order, the native modules (which always win: every one,
      // the runtime's own too, and the ones it seeds in sys.modules; never
      // the library's), the library's
      // top-level modules (found under its sys.path entry), and the packages'
      // (the registry's and the optional set's, found after sys.path).
      const sys = R.importModule("sys");
      const path = (R.toArray(sys.path) as unknown[]).filter((d): d is string => typeof d === "string");
      // (unknown is null, never a guess: the dialog then resolves no name in the code, CORR-172-ASTRA-1)
      let cwd: string | null = null;
      try {
        cwd = String(R.importModule("os").getcwd());
      } catch {}
      const lib = [...new Set(Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k) => k.split("/")[0].replace(/\.py$/, "")))];
      post({ id, cwd, path, builtins: R.resolvedModuleNames(), lib, packages: [...new Set([...packageModuleNames(), ...optionalModuleNames()])] });
      return;
    }
    // Interrupt (the page wrote INTR[1]): runs queued before it are skipped
    // (admit: the cutoff, a stale Ctrl-C cleared, the cutoff again)
    if ((m.code !== undefined || m.interact !== undefined) && !admit(id)) {
      post({ id, skipped: true });
      return;
    }
    if (m.code === undefined && m.interact === undefined) Atomics.and(R.INTR, 0, ~1); // (anything else: as before)
    current = id;
    target = null;
    used.item = 0;
    used.cut = false;
    used.displays = 0;
    post({ id, start: true });
    // (the run's time, for the reactive notebook's budget: from here, but not
    // counting Sage's one-time load below, which is the interpreter's, not the cell's)
    let t0 = performance.now();
    opts.runs?.begin(m);
    let ok = true, evaluated: string | null = null, modeReady: boolean | null = null;
    changedNames = new Set();
    scopedNames = m.scoped && typeof m.scoped === "object" ? Object.entries(m.scoped).filter((e): e is [string, string] => typeof e[1] === "string") : [];
    // A seeded run (the reactive notebook's per-cell seeds): Python's random
    // and numpy.random start from seeds derived from the cell's, whether they
    // are imported already or in the cell (lib/random.py, lib/numpy/random.py
    // read builtins.__pyjs_seed__ when they are), so the numbers do not depend
    // on what ran before.  os.urandom and secrets stay truly random.
    const seed = typeof m.seed === "string" && /^[0-9a-f]{64}$/i.test(m.seed) ? m.seed : null;
    if (seed || seededBefore) {
      const words = seed ? Array.from({ length: 8 }, (_, i) => parseInt(seed.slice(8 * i, 8 * i + 8), 16)) : [];
      run(seed
        ? `import builtins as _b, sys as _s\n_b.__pyjs_seed__ = (0x${seed}, ${JSON.stringify(words)}, [0])\n_g = _s.modules.get('random')\nif _g is not None: _g.seed(0x${seed})\n_g = _s.modules.get('numpy.random')\nif _g is not None: _g.seed(${JSON.stringify(words)})\ndel _b, _s, _g\n`
        : `import builtins as _b\n_b.__pyjs_seed__ = None\ndel _b\n`, host, "exec", "<seed>");
      seededBefore = !!seed;
    }
    if (Array.isArray(m.forget) && m.forget.length) {
      // (names of any script: α, and page-order scoping's xʹ2)
      const names = m.forget.filter((n: unknown) => typeof n === "string" && /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(n));
      // (comprehensions: no name is left bound, even when there is nothing to delete)
      run(`import __main__ as _m\n[_m.__dict__.pop(_k, None) for _k in ${JSON.stringify(names)}]\ndel _m\n`, host, "exec", "<forget>");
    }
    if (m.interact === undefined && (m.code !== undefined || m.evaluate !== undefined)) ipythonDisplay = !(m.sage || m.magma || m.matlab);
    if (m.interact !== undefined) {
      ok = run(`import _interact\n_interact._update(${Number(m.interact)}, ${JSON.stringify(JSON.stringify(m.values))})\n`, host, "exec", "<interact>");
    } else {
      // (the language's environment first: a failed or stopped load ends the
      // run there, its code not run, astra2's WARM-1; the load's time is the
      // interpreter's, not the cell's)
      const mode = modeOf(m), wasLoaded = loaded.has(mode) || !LOAD[mode];
      const r = ensureMode(mode, main, host, id);
      modeReady = r === "ready";
      if (!wasLoaded) t0 = performance.now();
      if (r !== "ready") {
        R.stderr.write(r === "interrupted" ? "KeyboardInterrupt\n" : r.text);
        ok = false;
      } else
      if (m.evaluate !== undefined) {
        evaluated = evaluate(m, host);
      } else
      if (m.magma) {
        // Magma: translated to Python (src/magma.ts); Magma prints its own values
        let py: string | null = null;
        try {
          py = magmaToPython(m.code, m.repl ? "<stdin>" : "<cell>");
        } catch (e) {
          if (!(e instanceof MagmaSyntaxError)) throw e;
          const line = m.code.split("\n")[e.line - 1] ?? "";
          R.stderr.write(`\n>> ${line}\n${" ".repeat(e.col + 2)}^\nUser error: bad syntax: ${e.message} (line ${e.line})\n`);
        }
        if (py !== null) ok = run(py, main, "exec", "<cell>");
        else ok = false;
      } else if (m.matlab) {
        // MATLAB: translated to Python (src/matlab.ts) in cell mode: variables and
        // functions stay for the next cells; MATLAB prints its own values, and an
        // error is MATLAB's message on stderr (lib/_matlab.py report_cell)
        let py: string | null = null;
        try {
          py = matlabToPython(m.code, m.repl ? "<stdin>" : "<cell>", { cell: true });
        } catch (e) {
          if (!(e instanceof MatlabSyntaxError)) throw e;
          R.stderr.write(matlabSyntaxMessage(e, m.code, "<cell>"));
        }
        if (py !== null) {
          ok = run(py, main, "exec", "<cell>");
          if (ok && R.callObj(R.getattr(R.importModule("_matlab"), "cell_failed"), []) === true) ok = false;
        } else ok = false;
      } else {
        // "cell" mode: the value of a final expression is displayed, as in Jupyter.
        const mangle = typeof m.mangle === "string" && /^[A-Za-z0-9]+$/.test(m.mangle) ? m.mangle : null;
        if (mangle) run(`import __main__ as _m\n[_m.__dict__.pop(_k, None) for _k in [k for k in _m.__dict__ if k.startswith(${JSON.stringify(localPrefix(mangle))})]]\ndel _m\n`, host, "exec", "<forget>");
        // (page-order scoping's renamed definitions get their names back: restoreDefNames)
        const scoped = Object.fromEntries(scopedNames);
        if (scopedNames.length && !renameHelper) { run(RENAME_HELPER, host, "exec", "<rename>"); renameHelper = true; }
        // (page-order scoping's initialization lines, `xʹ2 = x  # page-order
        // scoping`: taken out of the text and run as the first statements, on
        // the first statement's line, so the cell's line numbers are as written)
        const { code, inits } = takeInitLines(m.code);
        const initialize = (t: any) => {
          // (each before the first statement after the lines that came before
          // it, or, in a line split for it, from its column on)
          for (const [n, w, before, col] of [...inits].reverse()) {
            let i = t.body.findIndex((st: any) => (col === undefined ? st.lineno > before : st.lineno > before || (st.lineno === before && st.col_offset >= col)));
            if (i < 0) i = t.body.length;
            const ln = t.body[i]?.lineno ?? before + 1, pos = { lineno: ln, col_offset: 0, end_lineno: ln, end_col_offset: 0 };
            const nm = (id: string, store = false) => ({ _type: "Name", id, ctx: { _type: store ? "Store" : "Load" }, ...pos });
            const str = (v: string) => ({ _type: "Constant", value: v, kind: null, ...pos });
            const noArgs = { _type: "arguments", posonlyargs: [], args: [], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [] };
            const of = (attr: string) => ({ _type: "Attribute", value: { _type: "Lambda", args: noArgs, body: { _type: "Constant", value: 0, kind: null, ...pos }, ...pos }, attr, ctx: { _type: "Load" }, ...pos });
            // if 'x' in (lambda: 0).__globals__ or 'x' in (lambda: 0).__builtins__: xʹ2 = (lambda: x)()
            t.body.splice(i, 0, {
              _type: "If",
              test: { _type: "BoolOp", op: { _type: "Or" }, values: [
                { _type: "Compare", left: str(w), ops: [{ _type: "In" }], comparators: [of("__globals__")], ...pos },
                { _type: "Compare", left: str(w), ops: [{ _type: "In" }], comparators: [of("__builtins__")], ...pos },
              ], ...pos },
              body: [{ _type: "Assign", targets: [nm(n, true)], value: { _type: "Call", func: { _type: "Lambda", args: noArgs, body: nm(w), ...pos }, args: [], keywords: [], ...pos }, type_comment: null, ...pos }],
              orelse: [], ...pos,
            });
          }
        };
        // (the code of %time and %timeit in the cell's tree first, so the rest applies to it too)
        const magics = magicTransform(!!m.sage);
        const transform = (t: any) => { magics(t); if (inits.length) initialize(t); if (mangle) mangleLocals(t, mangle, { sage: !!m.sage }); if (scopedNames.length) restoreDefNames(t, scoped); };
        run(MAGIC_PRE, host, "exec", "<autoreload>");
        ok = run(ipythonSyntax(code) + "\n", main, m.repl ? "single" : "cell", m.repl ? "<stdin>" : "<cell>", { sage: !!m.sage, transform });
      }
      if (modeReady) run(FLUSH_FIGURES, host, "exec", "<figures>");
    }
    flush();
    target = null;
    const more = opts.runs?.end() ?? {};
    post({ id, done: true, ms: performance.now() - t0, ...(ok ? {} : { error: true }), ...(changedNames.size ? { names: [...changedNames] } : {}), ...(evaluated !== null ? { evaluated } : {}), ...(modeReady !== null ? { mode: modeOf(m), modeReady } : {}), ...more });
    current = null;
  }

  return { write, handle, ready, stats: () => ({ loaded: [...loaded], loads }) };
}
