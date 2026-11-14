// One interpreter of the engine (app/engine/main.mjs): the page's own worker,
// web/worker.ts as web/build.ts builds it (sagebrush-worker.js), run unchanged
// in a Node worker thread.  This file gives it what a browser's Web Worker
// would: self, postMessage and onmessage, its location, crossOriginIsolated,
// and fetch, but only of its own files, under the engine's root folder; the
// interpreter's synchronous reads (the engines' modules, the library's
// chunks) use the same reader (__SAGEBRUSH_FETCH_SYNC__).  Then Node's own
// globals are removed, so the bundle runs as it does in a browser: its file
// system is web/shims/fs, never Node's (design/native-desktop.md §5: the
// engine enforces the page's permissions, with no OS sandbox).
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sep } from "node:path";
import { registerHooks } from "node:module";

const root = realpathSync(workerData.root);
const bundle = pathToFileURL(root + sep + "sagebrush-worker.js").href;
/** A URL the interpreter asks for, as a file under the root; anything else is refused. */
function local(u) {
  const url = new URL(String(u), bundle);
  if (url.protocol !== "file:") throw new Error(`the engine reads only its own files, not ${url.protocol} URLs`);
  url.search = "";
  url.hash = "";
  let p;
  try {
    p = realpathSync(fileURLToPath(url));
  } catch {
    throw new Error(`no such file in the engine: ${url.pathname.split("/").pop()}`);
  }
  if (!p.startsWith(root + sep)) throw new Error("the engine reads only its own files");
  return p;
}
const port = parentPort;
const g = globalThis;
g.self = g;
g.name = typeof workerData.name === "string" ? workerData.name : "";
g.location = new URL(bundle);
g.crossOriginIsolated = true;
g.__SAGEBRUSH_FETCH_SYNC__ = (u) => new Uint8Array(readFileSync(local(u)));
g.fetch = async (u) => {
  const p = local(typeof u === "string" || u instanceof URL ? u : u.url);
  return new Response(readFileSync(p), { status: 200 });
};
g.postMessage = (m) => port.postMessage(m);
port.on("message", (data) => g.onmessage?.({ data }));
// (the bundle is an ES module, as a browser loads it, whatever the package.json above it says: the repository's
// says commonjs)
registerHooks({ load: (url, context, next) => (url === bundle ? { ...next(url, context), format: "module" } : next(url, context)) });
// (Node's globals, which no browser worker has: the bundle's shims (web/shims/process.ts) stand in for process)
for (const k of ["process", "Buffer", "global", "setImmediate", "clearImmediate"]) delete g[k];
await import(bundle);
