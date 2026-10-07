// A notebook session: the pyjs runtime answering the notebook page's
// messages.  The browser runs it in a Web Worker (web/worker.ts); `sagebrush
// notebook` runs it in a Node worker thread behind a local server
// (src/notebook.ts).  The protocol:
//
// In:  {id, code, sage?, magma?, repl?}  run code (`sage`: Sage mode, with
//                                 sage_all imported; `magma`: Magma, translated
//                                 to Python; `repl`: display every expression
//                                 statement, as at a prompt, not just the last)
//      {id, interact, values}     an @interact control changed: rerun it
//      {id, check, sage?}         -> {id, more}: is this input incomplete?
//      {id, complete}             -> {id, matches, prefix}: Tab completion
// Out: {id, start}, then any of
//      {id, target, stream: "stdout" | "stderr", text}
//      {id, target, display: {mime: data}}   rich output (Jupyter MIME bundle)
//      {id, target, interact: spec}           controls to draw
//      {id, target, clear: true}              clear_output()
//      then {id, done, ms} (or {id, skipped} for a run queued before an interrupt).
// `target` is null for the cell's own output, or the id of the @interact
// whose function is running, whose output area should receive it.
import { initParser, R, libDir } from "./compile";
import { needsMore, complete } from "./interactive";
import { magmaToPython, MagmaSyntaxError } from "./magma";

export interface Session {
  // text Python wrote to a file descriptor (1 or 2), when the host captures it
  write(fd: number, text: string): void;
  handle(m: any): Promise<void>;
}

// post: sends a message to the page.  captureStreams: replace sys.stdout and
// sys.stderr's writers (the browser's fs shim captures them instead).
export function notebookSession(post: (m: any) => void, opts: { captureStreams?: boolean; init?: (R: any) => void } = {}): Session {
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
  };

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

  // Run Python, reporting an exception as a traceback on stderr.
  function run(src: string, ns: any, mode: string, filename: string, o: { sage?: boolean } = {}) {
    try {
      R.loader.exec(src, ns, mode, filename, o);
    } catch (e) {
      const exc = R.toPyExc(e);
      flush();
      target = null;
      // exit() can't leave a notebook: it just ends the cell.
      if (!R.typeOf(exc).$mro.includes(R.T.SystemExit)) R.stderr.write(R.formatException(exc));
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
    if (m.interact !== undefined) {
      run(`import _interact\n_interact._update(${Number(m.interact)}, ${JSON.stringify(JSON.stringify(m.values))})\n`, host, "exec", "<interact>");
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
        if (py !== null) run(py, main, "exec", "<cell>");
      } else {
        // "cell" mode: the value of a final expression is displayed, as in Jupyter.
        run(m.code + "\n", main, m.repl ? "single" : "cell", m.repl ? "<stdin>" : "<cell>", { sage: !!m.sage });
      }
      run(FLUSH_FIGURES, host, "exec", "<figures>");
    }
    flush();
    target = null;
    post({ id, done: true, ms: performance.now() - t0 });
    current = null;
  }

  return { write, handle };
}
