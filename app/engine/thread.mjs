// One interpreter of the engine (app/engine/main.mjs): the page's own worker,
// web/worker.ts as web/build.ts builds it (sagebrush-worker.js), run unchanged
// in a Node worker thread.  This file gives it what a browser's Web Worker
// would: self, postMessage and onmessage, its location, crossOriginIsolated,
// and fetch, but only of its own files, under the engine's root folder; the
// interpreter's synchronous reads (the engines' modules, the library's
// chunks) use the same reader (__SAGEBRUSH_FETCH_SYNC__).  Then Node's own
// globals are removed, so the bundle runs as it does in a browser: its file
// system is web/shims/fs, never Node's (design/native-desktop.md §5: the
// engine enforces the page's permissions, with no OS sandbox).  No network:
// WebSocket, EventSource and Node's storage are removed too, and no import()
// reaches anything but the engine's own files (no Node module).
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { engineRoot, localFile } from "./files.mjs";

const where = engineRoot(workerData.root);
const bundle = where.base;
const local = (u) => localFile(where, u);
const port = parentPort;
const g = globalThis;
g.self = g;
g.name = typeof workerData.name === "string" ? workerData.name : "";
g.location = new URL(bundle);
g.crossOriginIsolated = true;
// (the memory this interpreter's heap may grow to, in bytes: all of the computer's memory, or the tests' --memory
// (serve.mjs); read by its heap guards (src/runtime/heap.ts hostMemory), which can't ask Node once its globals are gone
// below, and telling it that it runs on the person's own computer: no array cap (numpy.ts ARRAY_LIMITS))
if (Number.isFinite(workerData.memory) && workerData.memory > 0) g.__SAGEBRUSH_MEMORY__ = workerData.memory * 2 ** 20;
g.__SAGEBRUSH_FETCH_SYNC__ = (u) => new Uint8Array(readFileSync(local(u)));
g.fetch = async (u) => {
  const p = local(typeof u === "string" || u instanceof URL ? u : u.url);
  return new Response(readFileSync(p), { status: 200 });
};
g.postMessage = (m) => port.postMessage(m);
// (messages that come while the bundle loads wait for it, in order: the page sends its init and files at once)
let early = [];
port.on("message", (data) => (early ? early.push(data) : g.onmessage?.({ data })));
// (the bundle is an ES module, as a browser loads it, whatever the package.json above it says: the repository's
// says commonjs)
// (and from here on, nothing is loaded but the engine's own files: an import() of a Node module ("node:…", or a bare
// name), of another scheme, or of a file outside the root is refused as it resolves. This file's own imports were
// resolved before it ran. The engine's guard is the interpreter, with no OS sandbox (#1562): a bug in it must not
// reach Node's modules this way)
registerHooks({
  resolve: (specifier, context, next) => {
    const r = next(specifier, context);
    let own = false;
    try { own = r.url === bundle || (r.url.startsWith("file:") && !!local(r.url)); } catch {}
    if (!own) throw new Error(`the engine loads only its own files, not ${String(specifier).slice(0, 200)}`);
    return r;
  },
  load: (url, context, next) => (url === bundle ? { ...next(url, context), format: "module" } : next(url, context)),
});
// (Node's globals, which no browser worker has: the bundle's shims (web/shims/process.ts) stand in for process)
for (const k of ["process", "Buffer", "global", "setImmediate", "clearImmediate"]) delete g[k];
// (and the network a browser worker would have: the interpreter's own fetch above reads only the engine's files; Node's
// WebSocket, EventSource and storage are gone, so nothing in the interpreter can reach a host)
for (const k of ["WebSocket", "WebSocketStream", "EventSource", "localStorage", "sessionStorage"]) delete g[k];
await import(bundle);
for (const data of early) g.onmessage?.({ data });
early = null;
