// The pyjs runtime in a Web Worker: the notebook session (src/notebook-session.ts,
// whose header documents the protocol) plus the browser's files.  Notebook
// and console share __main__.  A runaway program can only hang this worker;
// the page terminates it.
//
// Also in:  {files: [[path, bytes]]}   the page's saved files, as the worker starts
//           {fsPut: path, data}        a file uploaded (data) or deleted (null) in the page
// Also out: {fsChanged: path, data}   Python wrote (data) or deleted (null) a file
//           {ready, version, interrupt, seeded, startup}  started (interrupt: the
//                                       shared flag, if any; seeded, startup: web/replay-env.ts)
// The Worker's name carries TimeTravel replay's parameters (web/replay-env.ts).
// first: the clock and entropy, before anything reads them (TimeTravel replay)
import { replayEnv } from "./replay-env";
import "./shims/process";
// the engines are a separate file, loaded (synchronously) the first time Python calls them
// (with its content hash, set by web/build.ts, so a new engine is never stale in a cache)
declare const __SB_ENGINE_HASH__: string;
(globalThis as any).__SAGEBRUSH_ENGINE_URL__ = new URL("sagebrush-engine.wasm?h=" + __SB_ENGINE_HASH__, self.location.href).href;
import "../build/cli/lib.gen.js";
import { __hooks, load as loadFiles, put as putFile } from "./shims/fs";
import { R } from "../src/compile";
import { notebookSession } from "../src/notebook-session";

// The files each run reads and writes (the reactive notebook's file edges):
// sent with its `done` as {files: {reads, writes}}.  (The runtime's own
// library, under /$pyjs, is not a file of the notebook.)
let reads = new Set<string>(), writes = new Set<string>();
const mine = (p: string) => !p.startsWith("/$pyjs");
const session = notebookSession((m) => postMessage(m), {
  runs: {
    begin: (m) => {
      reads = new Set();
      writes = new Set();
      replayEnv.begin(m.clock);
    },
    end: () => ({ ...(replayEnv.end() as any), ...(reads.size || writes.size ? { files: { reads: [...reads], writes: [...writes] } } : {}) }),
  },
});
__hooks.write = (fd, text) => session.write(fd, text);
__hooks.changed = (path, data) => {
  if (mine(path)) writes.add(path);
  postMessage({ fsChanged: path, data });
};
__hooks.read = (path) => {
  if (mine(path)) reads.add(path);
};

// The library modules compiled when the site was built (src/compile.ts,
// precompiled; web/build.ts), fetched as the worker starts: a Sage run waits
// for them (Sage mode's start compiled 2 MB of Python, over a second), other
// code uses them once they are here.  Without them, modules compile as before.
const precompiled = fetch(new URL("sagebrush-precompiled.json?h=" + (globalThis as any).__SAGEBRUSH_BUILD_ID__, self.location.href))
  .then((r) => (r.ok ? r.json() : null))
  .then((p) => { if (p) (globalThis as any).__SAGEBRUSH_PRECOMPILED__ = p; })
  .catch(() => {});

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.files) return loadFiles(m.files);
  if (m.fsPut !== undefined) return putFile(m.fsPut, m.data);
  if (m.sage) await precompiled;
  await session.handle(m);
};
// The interrupt flag, shared with the page when it is cross-origin isolated
// (Stop then raises KeyboardInterrupt here instead of restarting the worker).
const interrupt = typeof SharedArrayBuffer === "function" && R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null;
// ready once the interpreter is: `startup` is the clock values read until
// then (recorded, or replayed), `seeded` whether the entropy is reproducible
session.ready.then(() =>
  postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__, interrupt, seeded: replayEnv.seeded, startup: replayEnv.endStartup() }),
);
