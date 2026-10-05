// The pyjs runtime in a Web Worker.  Messages in: {id, code, sage?, repl?};
// out: {id, start} when the code begins, {id, stream: "stdout"|"stderr",
// text} while it runs, then {id, done, ms}.  `sage` compiles in Sage mode
// (2^3 == 8, 2/3 is a Rational) with sage_all imported; `repl` displays
// every expression statement, as at an interactive prompt (a notebook cell
// displays only its last).  The console also sends {id, check, sage}
// -> {id, more} (is the input incomplete?) and {id, complete} -> {id,
// matches, prefix} (tab completion).  Notebook and console share __main__.
// A runaway program can only hang this worker; the page terminates it.
import "./shims/process";
import "../build/cli/lib.gen.js";
import { __hooks } from "./shims/fs";
import { initParser, R, libDir } from "../src/compile";
import { needsMore, complete } from "../src/interactive";

let current: number | null = null;
__hooks.write = (fd, text) => {
  if (current !== null && text) postMessage({ id: current, stream: fd === 2 ? "stderr" : "stdout", text });
};

const ready = (async () => {
  await initParser();
  const sys = R.importModule("sys");
  sys.path.push(libDir());
  sys.argv.push("");
  const main = R.newModule("__main__");
  main.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, "__main__", main);
  return main;
})();

let sageLoaded = false;
const moduleNames = () => [
  ...R.builtinModuleNames(),
  ...Object.keys((globalThis as any).__PYJS_LIB__ ?? {}).map((k) => k.split("/")[0].replace(/\.py$/, "")),
];

self.onmessage = async (ev: MessageEvent) => {
  const { id, code, sage, repl } = ev.data;
  const main = await ready;
  if (ev.data.check !== undefined) {
    postMessage({ id, more: needsMore(ev.data.check, { sage: !!sage }) });
    return;
  }
  if (ev.data.complete !== undefined) {
    const [matches, prefix] = complete(main, ev.data.complete, () => [...new Set(moduleNames())]);
    postMessage({ id, matches, prefix });
    return;
  }
  current = id;
  postMessage({ id, start: true });
  const t0 = performance.now();
  try {
    if (sage && !sageLoaded) {
      R.loader.exec("from sage_all import *\n", main, "exec", "<sage>");
      sageLoaded = true;
    }
    // "cell" mode: the value of a final expression is displayed, as in Jupyter.
    R.loader.exec(code + "\n", main, repl ? "single" : "cell", repl ? "<stdin>" : "<cell>", { sage: !!sage });
  } catch (e) {
    const exc = R.toPyExc(e);
    R.stdout.flush();
    // exit() can't leave a page: it just ends the cell.
    if (!R.typeOf(exc).$mro.includes(R.T.SystemExit)) R.stderr.write(R.formatException(exc));
  }
  R.stdout.flush();
  R.stderr.flush();
  postMessage({ id, done: true, ms: performance.now() - t0 });
  current = null;
};
postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__ });
