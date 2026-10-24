// The shell's loader, in the page (plan-bash-shell r3 §1.4, §1.6, §6; r4
// addendum A1): from a package set S, the bash shell's js package, checked
// against S's pins (src/pkgset.ts) and against this page's host protocol
// level, then run in its own worker (web/shell/worker-boot.js, its own CSP).
// The page's realm never evaluates the module: it fetches and checks bytes,
// and posts the text.  A refusal says why, and nothing has started.
//
// The protocol's messages and the levels that introduced them are
// web/shell/host-levels.json; SHELL_HOST_LEVEL is the highest.  A package
// built for a higher level is refused: "this package set needs a newer
// Sagebrush".
import { admitIndex, checkJsChunk, PKGSET_LIMITS, PkgsetError, type SetPlan } from "../../src/pkgset";
import HOST_LEVELS from "./host-levels.json";

export const SHELL_PACKAGE = "@sagebrush/bash";
export const SHELL_HOST_LEVEL: number = Math.max(...Object.values(HOST_LEVELS.names as Record<string, number>));

export type ShellResult = { exitCode: number; stdout: string; stderr: string };
export interface Shell {
  /** the package set this worker runs (one S per shell worker: A1.5) */
  readonly S: string;
  readonly version: string;
  exec(script: string, stdin?: string): Promise<ShellResult>;
  terminate(): void;
}

// (at most `max` bytes, refused as they arrive past it)
async function boundedFetch(url: string, max: number): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: "error", credentials: "same-origin" });
  if (r.status !== 200) throw new PkgsetError(`${url}: HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new PkgsetError(`${url}: over ${max} bytes`);
  const reader = r.body!.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      await reader.cancel();
      throw new PkgsetError(`${url}: over ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

/** The shell package of plan, with the level check (A1.4); throws a PkgsetError. */
export function shellPackage(plan: SetPlan, level = SHELL_HOST_LEVEL) {
  const ids = [...plan.js.keys()].filter((id) => id.startsWith(SHELL_PACKAGE + "@"));
  // (N5: a set without the shell is refused; never another set instead)
  if (!ids.length) throw new PkgsetError(`this document's package set (${plan.S.slice(0, 12)}) has no shell; update the set`);
  const j = plan.js.get(ids[0])!;
  if (j.js.host_req > level) throw new PkgsetError(`this package set needs a newer Sagebrush (its shell needs host level ${j.js.host_req}; this page has ${level})`);
  return j;
}

/**
 * Start the shell of set `S`, from the site at `base` (its pkgset/<S>.json,
 * pkg/<sha256>.json and shell/worker-boot.js).  Resolves once the module says
 * shell.ready, with the shell and its chunk's verified notices (the license
 * texts of what the module bundles, A1.1a).  The notices are the caller's:
 * this module keeps no reference to them, and the worker never receives them
 * (r4 addendum A1 r3; the panel's About view re-reads them, step 4).
 */
export async function startShell(S: string, at: string | URL = "./"): Promise<{ shell: Shell; notices: string }> {
  if (!/^[0-9a-f]{64}$/.test(S)) throw new PkgsetError("a package set id is 64 lowercase hex digits");
  const base = new URL(at, document.baseURI);
  const index = await boundedFetch(new URL(`pkgset/${S}.json`, base).href, PKGSET_LIMITS.indexBytes);
  // (the Python side of the set is the engine's to admit, with the core's own
  // reserved names: here only its pins and its js packages are used)
  const plan = admitIndex(S, index, "0".repeat(16), { isCoreModule: () => false, bundledDirs: new Set() });
  const j = shellPackage(plan);
  // (the stages of A1.2: the declared size against the caps before the fetch (admitIndex), the body against
  // it while streaming, then the pin, the parse and the decoded module and notices before anything is kept)
  const bytes = await boundedFetch(new URL(`pkg/${j.js.sha256}.json`, base).href, j.js.size);
  const { text, notices } = checkJsChunk(plan, j.id, bytes);
  const worker = new Worker(new URL("shell/worker-boot.js", base), { type: "module", name: "sagebrush-shell" });
  const { port1, port2 } = new MessageChannel();
  const pending = new Map<number, (r: ShellResult) => void>();
  let next = 1;
  const ready = new Promise<string>((resolve, reject) => {
    port1.onmessage = (e) => {
      const { name, payload } = e.data ?? {};
      if (name === "shell.ready") resolve(String(payload?.version ?? ""));
      else if (name === "boot.failed") reject(new PkgsetError(`the shell didn't start: ${payload?.message}`));
      else if (name === "shell.result") {
        const done = pending.get(payload?.id);
        pending.delete(payload?.id);
        done?.({ exitCode: payload.exitCode, stdout: payload.stdout, stderr: payload.stderr });
      }
    };
    worker.onerror = (e) => reject(new PkgsetError(`the shell's worker failed: ${e.message}`));
  });
  worker.postMessage({ text, port: port2 }, [port2]);
  const version = await ready;
  const shell: Shell = {
    S,
    version,
    exec(script: string, stdin?: string) {
      const id = next++;
      return new Promise<ShellResult>((resolve) => {
        pending.set(id, resolve);
        port1.postMessage({ exec: { id, script, ...(stdin === undefined ? {} : { stdin }) } });
      });
    },
    terminate() {
      worker.terminate();
      port1.close();
    },
  };
  return { shell, notices };
}
