// The pyjs runtime in a Web Worker: the notebook session (src/notebook-session.ts,
// whose header documents the protocol) plus the browser's files.  Notebook
// and console share __main__.  A runaway program can only hang this worker;
// the page terminates it.
//
// Also in:  {files: [[path, bytes]]}   the page's saved files, as the worker starts
//           {fsPut: path, data, tok?}  a file uploaded (data) or deleted (null) in the page (tok: its version's, the journal's)
//           {fsWritable: boolean}  whether this document may change files (the page's `files` permission)
//           {mount: [[path, {url, sha256, size}]]}  a shared collection's files,
//                                       fetched when Python first reads them (web/shims/fs.ts)
//           {init: {limits}}          the engine's limits (src/limits.ts), the
//                                       deployment's or course's JSON text or null
//                                       (the defaults): required before any run, and
//                                       accepted once; never from a document, a URL
//                                       or user code (plan-ff-limits r3)
// Also out: {fsChanged: path, data}   Python wrote (data) or deleted (null) a file
//           {fsRefused: path, what}  a change refused, the files permission off (ready's `writable`: its shared word)
//           {id, target, input: {prompt, max, key}, buffer}  input() waits for a line
//                                       (stdin below: the page answers in `buffer`)
//           {id, target, liveData: {op, params, key}, buffer}  live data asked for
//                                       (liveData below: the page answers in `buffer`)
//           {initFailed: message}      the limits are invalid: this worker is done
//                                       (each run then answers with the message)
//           {ready, version, interrupt, progress, seeded, startup}  started (interrupt: the
//                                       shared flag, if any; progress: the shared progress
//                                       slots, src/runtime/progress.ts, if any; seeded,
//                                       startup: web/replay-env.ts)
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
// the PNG module likewise, the first time a PNG is written or read
// (src/runtime/raster.ts); it is not one of the files a downloaded file's
// runner carries (files mode), where writing or reading a PNG is then an
// error saying so
declare const __SB_RASTER_HASH__: string;
(globalThis as any).__SAGEBRUSH_RASTER_URL__ = FILES ? FILES["sagebrush-raster.wasm"] : new URL("sagebrush-raster.wasm?h=" + __SB_RASTER_HASH__.slice(0, 16), BASE).href;
(globalThis as any).__SAGEBRUSH_RASTER_SHA256__ = __SB_RASTER_HASH__;
// engine/nd's numerics module likewise, the first time np.linalg.cholesky runs
// (src/runtime/nd.ts; the runner's broker may fetch it, web/runner-fetch.mts);
// not one of the files a downloaded file's runner carries (files mode), where
// the TypeScript code then runs for the session
declare const __SB_ND_HASH__: string;
(globalThis as any).__SAGEBRUSH_ND_URL__ = FILES ? FILES["sagebrush-nd.wasm"] : new URL("sagebrush-nd.wasm?h=" + __SB_ND_HASH__.slice(0, 16), BASE).href;
(globalThis as any).__SAGEBRUSH_ND_SHA256__ = __SB_ND_HASH__;
// the multiprecision core likewise, the first time mpmath calls into it
// (src/runtime/mpcore.ts; the runner's broker may fetch it, web/runner-fetch.mts)
declare const __SB_MP_HASH__: string;
(globalThis as any).__SAGEBRUSH_MP_URL__ = FILES ? FILES["sagebrush-mp.wasm"] : new URL("sagebrush-mp.wasm?h=" + __SB_MP_HASH__.slice(0, 16), BASE).href;
(globalThis as any).__SAGEBRUSH_MP_SHA256__ = __SB_MP_HASH__;
// (the build's id, version and notices; the library itself is fetched in
// chunks, web/lib-lazy.ts, which must come before src/compile)
import "../build/cli/lib-meta.gen.js";
import { onChunkInstalled, onOfflineMissing, prefetchMode } from "./lib-lazy";
import { fetchMoving } from "./stall-fetch.js";
import { __hooks, load as loadFiles, mount, put as putFile, setWritable, startIn } from "./shims/fs";
import { startDirOf } from "./start-dir";
import { ndWarm, ndWarmAsked } from "../src/runtime/nd";
import { R, onOptionalUse } from "../src/compile";
import { notebookSession } from "../src/notebook-session";
import { waitForLine } from "../src/stdin-wait";
import { LIVE_DEADLINE_MS, LIVE_MAX_BYTES, waitForAnswer, type LiveAnswer } from "../src/live-data";
import type { LiveRequest } from "../src/notebook-session";
import { LIMITS_MAX_BYTES, utf8Bytes, type LimitsText } from "../src/limits";
import { modeOfFlags } from "../src/modes";
import { useSet, prefetchFor, onPkgUse, SetUnfetched } from "./pkgset-browser";

// The files each run reads and writes (the reactive notebook's file edges):
// sent with its `done` as {files: {reads, writes}}.  (The runtime's own
// library, under /$pyjs, is not a file of the notebook.)
let reads = new Set<string>(), writes = new Set<string>(), sources = new Set<string>();
const mine = (p: string) => !p.startsWith("/$pyjs");
// The init gate: awaiting-init -> validating -> ready | failed.  The session's
// runtime waits for the init message's limits, and runs nothing before it is
// given them (src/notebook-session.ts); runs that come earlier wait; failed
// is final, and every run is then answered with its message.
let gate: "awaiting-init" | "validating" | "ready" | "failed" = "awaiting-init";
let failure = "";
let giveLimits: (l: LimitsText) => void = () => {}, refuseLimits: (e: Error) => void = () => {};
const limits = new Promise<LimitsText>((ok, no) => ((giveLimits = ok), (refuseLimits = no)));
// input(): a line typed in the page.  This run posts {input, buffer} and waits
// on the buffer, which the page fills: Int32 [0] the state (0 waiting, 1 a
// line, 2 end of input), [1] the line's length in bytes, then its UTF-8 bytes.
// It waits in slices, so a Stop (the shared interrupt flag) still ends it.
// Only in a cross-origin isolated page, where memory can be shared; elsewhere
// input() reads end of input.  Each request has its own key (this worker's
// tag and a count), which the answer names: an answer to an earlier question
// of the same run, one asked before a Stop say, can't fill a later one
// (web/runner/index.html, web/notebook/worker-kernel.js).
const INPUT_MAX = 1 << 16;
const INPUT_TAG = Math.random().toString(36).slice(2, 10);
let inputCount = 0;
function stdin(req: { id: number; target: number | null; prompt: string }) {
  if (typeof SharedArrayBuffer !== "function" || !(R.INTR.buffer instanceof SharedArrayBuffer)) return null;
  const buffer = new SharedArrayBuffer(8 + INPUT_MAX);
  const key = `${INPUT_TAG}.${++inputCount}`;
  postMessage({ id: req.id, target: req.target, input: { prompt: req.prompt.slice(0, 4096), max: INPUT_MAX, key }, buffer });
  // (a Stop wins over an answer, even one landing during the same wait: src/stdin-wait.ts)
  return waitForLine(buffer, R.INTR);
}
// Live data (src/live-data.ts): lib/_sbdata_live.py's one closed operation,
// asked of the page as input() asks for a line: {id, target, liveData: {op,
// params, key}, buffer}, the run waiting on its own buffer (a Stop wins; past
// LIVE_DEADLINE_MS it is a timeout).  The key correlates the answer, nothing
// more; the page checks the message again (web/notebook/live-data.js), and the
// reader's FRED key never comes here.  No shared memory: unavailable.
const LIVE_TAG = Math.random().toString(36).slice(2, 10);
let liveCount = 0;
function liveData(req: LiveRequest): LiveAnswer | null {
  if (typeof SharedArrayBuffer !== "function" || !(R.INTR.buffer instanceof SharedArrayBuffer) || !(globalThis as any).crossOriginIsolated) return null;
  const buffer = new SharedArrayBuffer(8 + LIVE_MAX_BYTES);
  const key = `${LIVE_TAG}.${++liveCount}`;
  postMessage({ id: req.id, target: req.target, liveData: { op: req.op, params: req.params, key }, buffer });
  return waitForAnswer(buffer, R.INTR, LIVE_DEADLINE_MS);
}
const session = notebookSession((m) => postMessage(m), {
  stdin,
  liveData,
  limits,
  runs: {
    begin: (m) => {
      reads = new Set();
      writes = new Set();
      sources = new Set();
      replayEnv.begin(m.clock);
    },
    end: () => ({ ...(replayEnv.end() as any), ...(reads.size || writes.size || sources.size ? { files: { reads: [...reads], writes: [...writes], ...(sources.size ? { sources: [...sources] } : {}) } } : {}) }),
  },
});
__hooks.write = (fd, text) => session.write(fd, text);
__hooks.changed = (path, data) => {
  if (mine(path)) writes.add(path);
  postMessage({ fsChanged: path, data });
};
// (a change refused, its files permission off: the page shows "This notebook wants to change files")
__hooks.refused = (path, what) => postMessage({ fsRefused: path, what });
// Whether this document may change files (the page's `files` permission): one word shared with whoever holds this
// worker (the page, or the runner's frame), as the interrupt flag is, so a change of it reaches a run in flight at
// its next write; else (no SharedArrayBuffer: files mode) the {fsWritable} message, between runs. The page sends it
// before anything runs; writable until then (a board's interpreter, which the page keeps no files of)
const writableWord = typeof SharedArrayBuffer === "function" && (globalThis as any).crossOriginIsolated ? new Int32Array(new SharedArrayBuffer(4)) : null;
if (writableWord) Atomics.store(writableWord, 0, 1);
let writableNow = true;
setWritable(() => (writableWord ? Atomics.load(writableWord, 0) === 1 : writableNow));
__hooks.read = (path, origin) => {
  if (mine(path)) reads.add(path);
  // (the versions of the page's files whose own bytes the run read: the replay bundle carries only these, web/notebook/bundle-blobs.mjs)
  if (origin !== undefined) sources.add(origin);
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

// A mode's library (web/lib-lazy.ts), fetched the first time it runs (a run
// waits for it; the page says "loading Sage…" if that takes a while), or
// when it is checked (without waiting).
const fetchBytes = async (url: string): Promise<ArrayBuffer | Uint8Array> => {
  if (BROKERED) {
    await brokered;
    return fetchSync(url).slice();
  }
  // (bounded between pieces of data: a request that stops never holds a run, web/stall-fetch.js)
  return fetchMoving(url);
};
const libLoading = (what: string | null) => postMessage({ libLoading: what });
onChunkInstalled((file) => postMessage({ libChunk: file }));
onOfflineMissing((m) => postMessage({ offlineMissing: m }));

// This interpreter's optional package set (web/pkgset-browser.ts): its index
// is fetched when the page sends {pkgset: S}, and runs wait for it; a set that
// can't be used is said once, and imports from it then fail saying why.  An
// index that couldn't be fetched (offline, its first visit's copy not kept) is
// not one that can't be used: it is asked for again at the next run, quietly.
let pkgsetReady: Promise<void> = Promise.resolve();
let pkgsetUnfetched: string | null = null;
const loadSet = (S: string) => {
  pkgsetUnfetched = null;
  pkgsetReady = useSet(S, fetchBytes).catch((e) => {
    if (e instanceof SetUnfetched) pkgsetUnfetched = S;
    else postMessage({ pkgsetError: String(e?.message ?? e).slice(0, 1024) });
  });
};
onPkgUse((digests) => postMessage({ pkgUsed: digests }));
// (the set's first use by an import: the page pins it in the notebook then, web/index.html)
onOptionalUse((S) => postMessage({ pkgsetUsed: S }));

/** The init message's limits, or the reason they are refused before any
 * parsing (the validator, lib/_limits.py, checks the rest). */
// Only {limits: null} means the defaults: an envelope that isn't
// {limits: text | null}, or limits that aren't text, are settings supplied
// wrongly, and refused like invalid ones, never taken as the defaults
// (astra CORR-FF93-1).
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);
function initLimits(init: any): LimitsText | string {
  if (init === null || typeof init !== "object" || Array.isArray(init)) return `limits: the init message must be {limits: a JSON text or null}, not ${kind(init)}`;
  if (!Object.prototype.hasOwnProperty.call(init, "limits") || init.limits === undefined) return "limits: the init message has no limits (a JSON text, or null for the defaults)";
  const l = init.limits;
  if (l === null) return null;
  if (typeof l !== "string") return `limits: the limits must be a JSON text, not ${kind(l)}`;
  if (utf8Bytes(l) > LIMITS_MAX_BYTES) return `limits: the limits are larger than ${LIMITS_MAX_BYTES} bytes`;
  return { text: l, name: null };
}
const failed = (message: string) => {
  gate = "failed";
  failure = message;
  postMessage({ initFailed: message });
};

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  if (m.broker && BROKERED && !ctrl) return setBroker(m.broker);
  if (m.init !== undefined) {
    // (once: a second init, or any later reconfiguration, is refused)
    if (gate !== "awaiting-init") return postMessage({ initRefused: "this engine's limits are set already" });
    gate = "validating";
    const l = initLimits(m.init);
    if (typeof l === "string") {
      // (the session's runtime then never starts: runs waiting for it are refused)
      failed(l);
      refuseLimits(new Error(l));
      return;
    }
    giveLimits(l);
    return;
  }
  if (gate === "failed") {
    if (m.id !== undefined) {
      postMessage({ id: m.id, stream: "stderr", target: null, text: `This engine's settings are invalid: ${failure}; ask the site's administrator.\n` });
      postMessage({ id: m.id, done: true, ms: 0, error: true });
    }
    return;
  }
  if (m.pkgset !== undefined) {
    loadSet(String(m.pkgset));
    return;
  }
  if (typeof m.fsWritable === "boolean") {
    writableNow = m.fsWritable;
    if (writableWord) Atomics.store(writableWord, 0, m.fsWritable ? 1 : 0);
    return;
  }
  if (m.startDir !== undefined) {
    // (the notebook's own folder: the working folder and sys.path[0], as Jupyter runs a notebook (Nov 4 ruling), so it
    // opens and imports what is beside it; set as it arrives: the page sends it in onStart, which every run and
    // question waits for (web/notebook/worker-kernel.js), and it holds even sent before the init)
    const d = startDirOf(m.startDir);
    if (d === null) return;
    startIn(d);
    const sys = R.importModule("sys");
    if (sys.path[0] !== d) sys.path.unshift(d);
    return;
  }
  if (m.files) return loadFiles(m.files);
  if (m.fsPut !== undefined) return putFile(m.fsPut, m.data, typeof m.tok === "string" ? m.tok : undefined);
  if (m.mount) return mount(m.mount);
  const mode = modeOfFlags(m);
  if (mode) {
    const p = prefetchMode(mode, fetchBytes, libLoading);
    // (a run, and the questions that load the language first: Tab, check, a
    // warm-up, X1; the session's admission comes after this await)
    if (m.code !== undefined || m.complete !== undefined || m.check !== undefined || m.warm !== undefined) {
      try {
        await p;
      } catch (e: any) {
        // (its library didn't load, a chunk's fetch having stalled: a run says so and ends, a question is answered
        // as not asked; nothing waits for good)
        if (m.id === undefined) return;
        if (m.code === undefined) return postMessage({ id: m.id, skipped: true });
        postMessage({ id: m.id, stream: "stderr", target: null, text: `${String(e?.message ?? e)}\n` });
        return postMessage({ id: m.id, done: true, ms: 0, error: true });
      }
    } else p.catch(() => {});
  }
  if (m.code !== undefined) {
    if (pkgsetUnfetched !== null) loadSet(pkgsetUnfetched);
    await pkgsetReady;
    await prefetchFor(m.code, fetchBytes);
  }
  try {
    await session.handle(m);
    // (a run that imported numpy: engine/nd's module is compiled now, while the worker is idle, so linear algebra's
    // first call only instantiates it; the same bits as without, src/runtime/nd.ts)
    if (m.code !== undefined && ndWarmAsked()) setTimeout(() => void ndWarm(fetchBytes), 0);
  } catch (e) {
    // (the session never became ready: its limits are invalid)
    if (gate !== "failed") throw e;
    if (m.id !== undefined) {
      postMessage({ id: m.id, stream: "stderr", target: null, text: `This engine's settings are invalid: ${failure}; ask the site's administrator.\n` });
      postMessage({ id: m.id, done: true, ms: 0, error: true });
    }
  }
};
// The interrupt flag, shared with the page when it is cross-origin isolated
// (Stop then raises KeyboardInterrupt here instead of restarting the worker).
const interrupt = typeof SharedArrayBuffer === "function" && R.INTR.buffer instanceof SharedArrayBuffer ? R.INTR.buffer : null;
// and the progress slots, which the page can read while a run holds this
// thread (R.progress.snapshot()'s layout, src/runtime/progress.ts)
const progressSlots = interrupt && R.progress.buffer.buffer instanceof SharedArrayBuffer ? R.progress.buffer.buffer : null;
// ready once the interpreter is: `startup` is the clock values read until
// then (recorded, or replayed), `seeded` whether the entropy is reproducible
session.ready.then(
  () => {
    if (gate === "failed") return;
    gate = "ready";
    // (context: what this worker itself sees, for the app's self-test report)
    postMessage({ ready: true, version: (globalThis as any).__SAGEBRUSH_VERSION__, interrupt, progress: progressSlots, writable: writableWord?.buffer ?? null, seeded: replayEnv.seeded, startup: replayEnv.endStartup(), context: { isolated: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer } });
  },
  (e) => gate !== "failed" && failed(String(e?.message ?? e).slice(0, 1024)),
);
