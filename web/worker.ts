// The pyjs runtime in a Web Worker.  Notebook and console share __main__.
// A runaway program can only hang this worker; the page terminates it.
//
// In:  {id, code, sage?, repl?}   run code (`sage`: Sage mode, with sage_all
//                                 imported; `repl`: display every expression
//                                 statement, as at a prompt, not just the last)
//      {id, interact, values}     an @interact control changed: rerun it
//      {id, check, sage?}         -> {id, more}: is this input incomplete?
//      {id, complete}             -> {id, matches, prefix}: Tab completion
// Out: {id, start}, then any of
//      {id, target, stream: "stdout" | "stderr", text}
//      {id, target, display: {mime: data}}   rich output (Jupyter MIME bundle)
//      {id, target, interact: spec}           controls to draw
//      {id, target, clear: true}              clear_output()
//      then {id, done, ms}.
// `target` is null for the cell's own output, or the id of the @interact
// whose function is running, whose output area should receive it.
import "./shims/process";
// the engines are a separate file, loaded (synchronously) the first time Python calls them
(globalThis as any).__SAGEBRUSH_ENGINE_URL__ = new URL("sagebrush-engine.wasm", self.location.href).href;
import "../build/cli/lib.gen.js";
import { __hooks } from "./shims/fs";
import { initParser, R, libDir } from "../src/compile";
import { needsMore, complete } from "../src/interactive";

let current: number | null = null;
let target: number | null = null;
__hooks.write = (fd, text) => {
  if (current !== null && text) postMessage({ id: current, target, stream: fd === 2 ? "stderr" : "stdout", text });
};
const flush = () => {
  R.stdout.flush();
  R.stderr.flush();
};
R.host = {
  display(bundle: Record<string, string>) {
    if (current === null) return false;
    postMessage({ id: current, target, display: bundle });
    return true;
  },
  interact(spec: string) {
    if (current === null) return false;
    postMessage({ id: current, target, interact: JSON.parse(spec) });
    return true;
  },
  target(t: number | null) {
    flush();
    target = t ?? null;
  },
  clear_output() {
    flush();
    if (current !== null) postMessage({ id: current, target, clear: true });
  },
};

const ready = (async () => {
  await initParser();
  const sys = R.importModule("sys");
  sys.path.push(libDir());
  sys.argv.push("");
  const main = R.newModule("__main__");
  main.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, "__main__", main);
  // A namespace for the worker's own Python (interact updates, figure flushing).
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
function run(src: string, ns: any, mode: string, filename: string, opts: { sage?: boolean } = {}) {
  try {
    R.loader.exec(src, ns, mode, filename, opts);
  } catch (e) {
    const exc = R.toPyExc(e);
    flush();
    target = null;
    // exit() can't leave a page: it just ends the cell.
    if (!R.typeOf(exc).$mro.includes(R.T.SystemExit)) R.stderr.write(R.formatException(exc));
  }
}

// Figures a cell made with matplotlib.pyplot and did not show: show them now, as Jupyter does.
const FLUSH_FIGURES = "import sys as _s\n_p = _s.modules.get('matplotlib.pyplot')\nif _p is not None: _p._flush_figures()\n";

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  const { id } = m;
  const { main, host } = await ready;
  if (m.check !== undefined) {
    postMessage({ id, more: needsMore(m.check, { sage: !!m.sage }) });
    return;
  }
  if (m.complete !== undefined) {
    const [matches, prefix] = complete(main, m.complete, () => [...new Set(moduleNames())]);
    postMessage({ id, matches, prefix });
    return;
  }
  current = id;
  target = null;
  postMessage({ id, start: true });
  const t0 = performance.now();
  if (m.interact !== undefined) {
    run(`import _interact\n_interact._update(${Number(m.interact)}, ${JSON.stringify(JSON.stringify(m.values))})\n`, host, "exec", "<interact>");
  } else {
    if (m.sage && !sageLoaded) {
      run("from sage_all import *\n", main, "exec", "<sage>");
      sageLoaded = true;
    }
    // "cell" mode: the value of a final expression is displayed, as in Jupyter.
    run(m.code + "\n", main, m.repl ? "single" : "cell", m.repl ? "<stdin>" : "<cell>", { sage: !!m.sage });
    run(FLUSH_FIGURES, host, "exec", "<figures>");
  }
  flush();
  target = null;
  postMessage({ id, done: true, ms: performance.now() - t0 });
  current = null;
};
postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__ });
