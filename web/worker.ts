// The pyjs runtime in a Web Worker: the notebook session (src/notebook-session.ts,
// whose header documents the protocol) plus the browser's files.  Notebook
// and console share __main__.  A runaway program can only hang this worker;
// the page terminates it.
//
// Also in:  {files: [[path, bytes]]}   the page's saved files, as the worker starts
//           {fsPut: path, data}        a file uploaded (data) or deleted (null) in the page
//           {mount: [[path, {url, sha256, size}]]}  a shared collection's files,
//                                       fetched when Python first reads them (web/shims/fs.ts)
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
// (in the runner, web/runner/index.html, the worker's URL is a blob: and its
// files are at __SB_BASE__)
const BASE: string = (globalThis as any).__SB_BASE__ ?? self.location.href;
// (in a downloaded file's runner, web/notebook/runner-worker.js's files mode,
// the files are blob: URLs: __SB_FILES__ maps their names to them)
const FILES: Record<string, string> | undefined = (globalThis as any).__SB_FILES__;
(globalThis as any).__SAGEBRUSH_ENGINE_URL__ = FILES?.["sagebrush-engine.wasm"] ?? new URL("sagebrush-engine.wasm?h=" + __SB_ENGINE_HASH__.slice(0, 16), BASE).href;
// (and its SHA-256, checked before it runs: src/runtime/engine.ts)
(globalThis as any).__SAGEBRUSH_ENGINE_SHA256__ = __SB_ENGINE_HASH__;
import "../build/cli/lib.gen.js";
import { __hooks, load as loadFiles, mount, put as putFile } from "./shims/fs";
import { R } from "../src/compile";
import { sha256Hex } from "../src/runtime/sha256";
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

// In the runner (web/runner/index.html) this worker has no network at all:
// its frame sends, as the first message, a broker (two SharedArrayBuffers),
// and a file it needs (the engine, a shared collection's file) is fetched by
// the page and copied through it, a chunk at a time, while this worker waits
// on Atomics.wait.  The page fetches only the interpreter's own files and the
// files it mounted.
const BROKERED = !!(globalThis as any).__SB_BROKERED__;
let brokerSet: () => void = () => {};
const brokered = new Promise<void>((r) => (brokerSet = r));
let ctrl: Int32Array | null = null, chunk: Uint8Array | null = null;
function fetchSync(url: string): Uint8Array {
  if (!ctrl || !chunk) throw new Error("no broker");
  const parts: Uint8Array[] = [];
  let off = 0, total = 0;
  do {
    Atomics.store(ctrl, 0, 0);
    postMessage({ brokerFetch: url, offset: off });
    Atomics.wait(ctrl, 0, 0);
    if (ctrl[1] !== 1) throw new Error("could not fetch " + url);
    const n = ctrl[2];
    total = ctrl[3];
    parts.push(chunk.slice(0, n));
    off += n;
    if (n === 0 && off < total) throw new Error("could not fetch " + url);
  } while (off < total);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}
function setBroker(b: { ctrl: SharedArrayBuffer; data: SharedArrayBuffer }) {
  ctrl = new Int32Array(b.ctrl);
  chunk = new Uint8Array(b.data);
  (globalThis as any).__SAGEBRUSH_FETCH_SYNC__ = fetchSync;
  brokerSet();
}

// The library modules compiled when the site was built (src/compile.ts,
// precompiled; web/build.ts), fetched as the worker starts: a Sage run waits
// for them (Sage mode's start compiled 2 MB of Python, over a second), other
// code uses them once they are here.  It is code, and a cached copy is the
// origin's storage, which any script of the origin can write: it is used only
// if its bytes have the SHA-256 this worker was built with (design/security.md,
// SEC-8D6-1).  Without them, modules compile as before.
declare const __SB_PRECOMPILED_HASH__: string;
const precompiled = (async () => {
  try {
    const url = FILES?.["sagebrush-precompiled.json"] ?? new URL("sagebrush-precompiled.json?h=" + __SB_PRECOMPILED_HASH__.slice(0, 16), BASE).href;
    let bytes: ArrayBuffer;
    if (BROKERED) {
      await brokered;
      bytes = fetchSync(url).slice().buffer;
    } else {
      const r = await fetch(url);
      if (!r.ok) return;
      bytes = await r.arrayBuffer();
    }
    // (the runner's worker is not a secure context, so no crypto.subtle: the synchronous SHA-256)
    if (sha256Hex(new Uint8Array(bytes)) !== __SB_PRECOMPILED_HASH__) return;
    (globalThis as any).__SAGEBRUSH_PRECOMPILED__ = JSON.parse(new TextDecoder().decode(bytes));
  } catch {}
})();

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.broker && BROKERED && !ctrl) return setBroker(m.broker);
  if (m.files) return loadFiles(m.files);
  if (m.fsPut !== undefined) return putFile(m.fsPut, m.data);
  if (m.mount) return mount(m.mount);
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
