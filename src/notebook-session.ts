// A notebook session: the pyjs runtime answering the notebook page's
// messages.  The browser runs it in a Web Worker (web/worker.ts); `sagebrush
// notebook` runs it in a Node worker thread behind a local server
// (src/notebook.ts).  The protocol:
//
// In:  {id, code, sage?, magma?, repl?, clock?, forget?}  run code (`sage`: Sage
//                                 mode, with sage_all imported; `magma`: Magma,
//                                 translated to Python; `repl`: display every
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
//      {id, check, sage?}         -> {id, more}: is this input incomplete?
//      {id, complete}             -> {id, matches, prefix}: Tab completion
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
import { initParser, R, libDir } from "./compile";
import { needsMore, complete, helpSyntax } from "./interactive";
import { magmaToPython, MagmaSyntaxError } from "./magma";
import { mangleLocals, localPrefix } from "./dataflow";

export interface Session {
  // text Python wrote to a file descriptor (1 or 2), when the host captures it
  write(fd: number, text: string): void;
  handle(m: any): Promise<void>;
  // the interpreter is initialized
  ready: Promise<unknown>;
}

// Around each run (TimeTravel replay, web/replay-env.ts): begin(m) as it
// starts, and end()'s fields are added to its {id, done} message.
export interface RunHooks {
  begin(m: any): void;
  end(): Record<string, unknown>;
}

// post: sends a message to the page.  captureStreams: replace sys.stdout and
// sys.stderr's writers (the browser's fs shim captures them instead).
export function notebookSession(post: (m: any) => void, opts: { captureStreams?: boolean; init?: (R: any) => void; runs?: RunHooks } = {}): Session {
  let current: number | null = null;
  let target: number | null = null;
  const write = (fd: number, text: string) => {
    if (current !== null && text) post({ id: current, target, stream: fd === 2 ? "stderr" : "stdout", text });
  };
  if (opts.captureStreams) {
    // at least every 100 ms during a run, as the Jupyter kernel does
    let last = 0;
    for (const [stream, fd] of [[R.stdout, 1], [R.stderr, 2]] as [any, number][]) {
      stream.write = function (s: string) {
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
  R.host = {
    display(bundle: Record<string, string>) {
      if (current === null) return false;
      flush();
      post({ id: current, target, display: bundle });
      return true;
    },
    interact(spec: string) {
      if (current === null) return false;
      flush();
      post({ id: current, target, interact: JSON.parse(spec) });
      return true;
    },
    target(t: number | null) {
      flush();
      target = t ?? null;
    },
    clear_output() {
      flush();
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

  const ready = (async () => {
    await initParser();
    const sys = R.importModule("sys");
    sys.path.push(libDir());
    sys.argv.push("");
    opts.init?.(R);
    const main = R.newModule("__main__");
    main.__builtins__ = R.builtins;
    R.dictSet(R.sysModules, "__main__", main);
    // A namespace for the session's own Python (interact updates, figure flushing).
    const host = R.newModule("__sagebrush_host__");
    host.__builtins__ = R.builtins;
    return { main, host };
  })();

  let sageLoaded = false;
  const moduleNames = () => [
    ...R.builtinModuleNames(),
    ...Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k) => k.split("/")[0].replace(/\.py$/, "")),
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
      // exit() can't leave a notebook: it just ends the cell.
      if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) return true;
      // (a cell's renamed `_` names are shown as written)
      // (and page-order scoping's names, as written: the run's `scoped`)
      let text = R.formatException(exc).replace(/\b_cell_[A-Za-z0-9]+(?=_\w)/g, "");
      // (whole names only: xʹ2 is not the start of xʹ20)
      for (const [n, w] of scopedNames) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}\\p{Mn}_])`, "gu"), w);
      R.stderr.write(text);
      return false;
    }
  }

  // Figures a cell made with matplotlib.pyplot and did not show: show them now, as Jupyter does.
  // And files the cell wrote without closing them: write them now.
  const FLUSH_FIGURES = "import sys as _s\n_p = _s.modules.get('matplotlib.pyplot')\nif _p is not None: _p._flush_figures()\n_o = _s.modules.get('_pyjs_open')\nif _o is not None: _o._flush_all()\n";

  async function handle(m: any) {
    const { id } = m;
    const { main, host } = await ready;
    if (m.check !== undefined) {
      // Magma's console runs each line as it is entered
      post({ id, more: m.magma ? false : needsMore(m.check, { sage: !!m.sage }) });
      return;
    }
    if (m.complete !== undefined) {
      const [matches, prefix] = complete(main, m.complete, () => [...new Set(moduleNames())]);
      post({ id, matches, prefix });
      return;
    }
    // Interrupt (the page wrote INTR[1]): runs queued before it are skipped
    if (id <= R.INTR[1] && (m.code !== undefined || m.interact !== undefined)) {
      post({ id, skipped: true });
      return;
    }
    R.INTR[0] = 0; // a request that came after the previous run had finished
    current = id;
    target = null;
    post({ id, start: true });
    const t0 = performance.now();
    opts.runs?.begin(m);
    let ok = true;
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
    if (m.interact !== undefined) {
      ok = run(`import _interact\n_interact._update(${Number(m.interact)}, ${JSON.stringify(JSON.stringify(m.values))})\n`, host, "exec", "<interact>");
    } else {
      if (m.sage && !sageLoaded) {
        run("from sage_all import *\n", main, "exec", "<sage>");
        sageLoaded = true;
      }
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
      } else {
        // "cell" mode: the value of a final expression is displayed, as in Jupyter.
        const mangle = typeof m.mangle === "string" && /^[A-Za-z0-9]+$/.test(m.mangle) ? m.mangle : null;
        if (mangle) run(`import __main__ as _m\n[_m.__dict__.pop(_k, None) for _k in [k for k in _m.__dict__ if k.startswith(${JSON.stringify(localPrefix(mangle))})]]\ndel _m\n`, host, "exec", "<forget>");
        ok = run(helpSyntax(m.code) + "\n", main, m.repl ? "single" : "cell", m.repl ? "<stdin>" : "<cell>", { sage: !!m.sage, ...(mangle ? { transform: (t: any) => mangleLocals(t, mangle) } : {}) });
      }
      run(FLUSH_FIGURES, host, "exec", "<figures>");
    }
    flush();
    target = null;
    const more = opts.runs?.end() ?? {};
    post({ id, done: true, ms: performance.now() - t0, ...(ok ? {} : { error: true }), ...(changedNames.size ? { names: [...changedNames] } : {}), ...more });
    current = null;
  }

  return { write, handle, ready };
}
