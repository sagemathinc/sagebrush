// The pyjs runtime in a Web Worker: the notebook session (src/notebook-session.ts,
// whose header documents the protocol) plus the browser's files.  Notebook
// and console share __main__.  A runaway program can only hang this worker;
// the page terminates it.
//
// Also in:  {files: [[path, bytes]]}   the page's saved files, as the worker starts
//           {fsPut: path, data}        a file uploaded (data) or deleted (null) in the page
// Also out: {fsChanged: path, data}   Python wrote (data) or deleted (null) a file
//           {ready, version, interrupt}  started (interrupt: the shared flag, if any)
import "./shims/process";
// the engines are a separate file, loaded (synchronously) the first time Python calls them
// (with its content hash, set by web/build.ts, so a new engine is never stale in a cache)
declare const __SB_ENGINE_HASH__: string;
(globalThis as any).__SAGEBRUSH_ENGINE_URL__ = new URL("sagebrush-engine.wasm?h=" + __SB_ENGINE_HASH__, self.location.href).href;
import "../build/cli/lib.gen.js";
import { __hooks, load as loadFiles, put as putFile } from "./shims/fs";
import { R } from "../src/compile";
import { notebookSession } from "../src/notebook-session";

const session = notebookSession((m) => postMessage(m));
__hooks.write = (fd, text) => session.write(fd, text);
__hooks.changed = (path, data) => postMessage({ fsChanged: path, data });

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.files) return loadFiles(m.files);
  if (m.fsPut !== undefined) return putFile(m.fsPut, m.data);
  await session.handle(m);
};
// The interrupt flag, shared with the page when it is cross-origin isolated
// (Stop then raises KeyboardInterrupt here instead of restarting the worker).
const interrupt = typeof SharedArrayBuffer === "function" && R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null;
postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__, interrupt });
