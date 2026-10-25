// The page's side of the Share dialog's analysis (share-ux-plan r2 §3): it
// starts deps-worker.ts, feeds it one .py file at a time, passes on what it
// finds, and stops it, by terminate(), the hard stop that preempts even one
// long synchronous parse:
//   - when the dialog closes, Upload starts, or the dialog is reopened
//     (stop());
//   - or when a fail-safe fires: no message for silenceMs (a pathological
//     single parse), or more than sourceBytes of source fed.  A fail-safe
//     stops the analysis only: nothing is refused, every box still works.
// No fixed caps otherwise (@sagebrush's decision on python's flag).
import type { FileDepsInput, Reason, Unfollowed } from "./file-deps";

export const FAILSAFE = { silenceMs: 30_000, sourceBytes: 256 * 1024 * 1024 };

export interface WorkerLike {
  postMessage(m: unknown): void;
  terminate(): void;
  onmessage: ((ev: { data: any }) => void) | null;
}
export type DepsInput = Omit<FileDepsInput, "files" | "builtinModules" | "externalModules" | "packageModules" | "readFile" | "onDep" | "onUnfollowed" | "onProgress" | "signal"> & {
  files: [string, { size?: number }][];
  builtinModules: string[];
  externalModules: string[];
  packageModules: string[];
};
export interface DepsHandlers {
  onDep(path: string, reason: Reason): void;
  onUnfollowed(u: Unfollowed): void;
  onProgress(p: { parsed: number; queued: number }): void;
  /** the end: complete or not, and why it stopped early if it did */
  onDone(r: { complete: boolean; stopped?: "failsafe" | "failed" }): void;
}

export function startDeps(o: {
  gen: number;
  input: DepsInput;
  readText: (path: string) => Promise<string>;
  createWorker: () => WorkerLike;
  handlers: DepsHandlers;
  failsafe?: { silenceMs: number; sourceBytes: number };
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): { stop(): void; readonly running: boolean } {
  const fs = o.failsafe ?? FAILSAFE;
  const setT = o.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearT = o.clearTimer ?? ((t) => clearTimeout(t as any));
  const w = o.createWorker();
  let running = true, fed = 0, timer: unknown = null;
  const end = (r: { complete: boolean; stopped?: "failsafe" | "failed" }) => {
    if (!running) return;
    running = false;
    if (timer !== null) clearT(timer);
    w.onmessage = null;
    w.terminate();
    o.handlers.onDone(r);
  };
  const arm = () => {
    if (timer !== null) clearT(timer);
    timer = setT(() => end({ complete: false, stopped: "failsafe" }), fs.silenceMs);
  };
  w.onmessage = (ev) => {
    const m = ev.data;
    if (!running || m?.gen !== o.gen) return;
    arm();
    if (m.dep !== undefined) o.handlers.onDep(m.dep, m.reason);
    else if (m.unfollowed !== undefined) o.handlers.onUnfollowed(m.unfollowed);
    else if (m.progress !== undefined) o.handlers.onProgress(m.progress);
    else if (m.need !== undefined) {
      const path = String(m.need);
      o.readText(path).then(
        (text) => {
          if (!running) return;
          fed += text.length;
          if (fed > fs.sourceBytes) return end({ complete: false, stopped: "failsafe" });
          w.postMessage({ file: { path, text } });
        },
        () => running && w.postMessage({ file: { path, text: null } }),
      );
    } else if (m.done) end(m.failed ? { complete: false, stopped: "failed" } : { complete: !!m.complete });
  };
  arm();
  w.postMessage({ start: { gen: o.gen, ...o.input } });
  return {
    stop: () => {
      if (!running) return;
      running = false;
      if (timer !== null) clearT(timer);
      w.onmessage = null;
      w.terminate();
    },
    get running() {
      return running;
    },
  };
}
