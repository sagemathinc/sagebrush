// The pyjs runtime in a Web Worker.  Messages in: {id, code}; out:
// {id, stream: "stdout"|"stderr", text} while running, then {id, done, ms}.
// A runaway program can only hang this worker; the page terminates it.
import "./shims/process";
import "../build/cli/lib.gen.js";
import { __hooks } from "./shims/fs";
import { initParser, R, libDir } from "../src/compile";

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

self.onmessage = async (ev: MessageEvent) => {
  const { id, code } = ev.data;
  const main = await ready;
  current = id;
  const t0 = performance.now();
  try {
    // "cell" mode: the value of a final expression is displayed, as in Jupyter.
    R.loader.exec(code + "\n", main, "cell", "<cell>");
  } catch (e) {
    const exc = R.toPyExc(e);
    R.stdout.flush();
    R.stderr.write(R.formatException(exc));
  }
  R.stdout.flush();
  R.stderr.flush();
  postMessage({ id, done: true, ms: performance.now() - t0 });
  current = null;
};
postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__ });
