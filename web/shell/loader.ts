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

/**
 * What one invocation came to (r3 §7.4, D8 point 5): a real shell exit, whose
 * status is the only thing that makes an exit status (an integer in 0..255),
 * or a rejection of the module's exec(), reported as a rejection and never
 * folded into a status.  (Step 2 adds the refusal's id, by identity.)
 */
export type ShellOutcome =
  | { exit: { code: number; stdout: string; stderr: string } }
  | { rejected: { message: string; refusal: null } };

/**
 * The shell is gone (terminated, its worker failed, or its protocol broke):
 * every pending exec() settles with this, and every later one fails at once
 * (r3 §7.1: none hangs).  Step 6 raises it to the user as ShellUnavailableError.
 */
export class ShellUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`the shell is unavailable: ${reason}`);
    this.name = "ShellUnavailableError";
  }
}

export interface Shell {
  /** the package set this worker runs (one S per shell worker: A1.5) */
  readonly S: string;
  readonly version: string;
  /** "closed" once terminated or failed; it doesn't reopen */
  readonly state: "open" | "closed";
  exec(script: string, stdin?: string): Promise<ShellOutcome>;
  /** idempotent: ends the worker and its channel, and fails what is pending */
  terminate(): void;
}

/**
 * The body of `url`, of at most `max` bytes (`exact`: exactly `max`), into one
 * destination allocated before the first byte (A1.2: one response copy, never
 * a list of the stream's chunks then a second full copy).  Each chunk is
 * copied in as it arrives and not kept; past the bound the stream is
 * cancelled and refused.  Without an exact size the destination is the
 * declared Content-Length when there is one and no Content-Encoding (and the
 * body must match it), else `max` (the index's is 256 KiB).
 */
export async function boundedFetch(url: string, max: number, { exact = false, signal }: { exact?: boolean; signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: "error", credentials: "same-origin", signal });
  if (r.status !== 200) throw new PkgsetError(`${url}: HTTP ${r.status}`);
  // (a Content-Length counts the encoded body: with a Content-Encoding it says nothing of the bytes read here)
  const encoded = (r.headers.get("content-encoding") ?? "identity").toLowerCase() !== "identity";
  const header = encoded ? null : r.headers.get("content-length");
  const declared = header === null ? null : Number(header);
  if (declared !== null && !(Number.isSafeInteger(declared) && declared >= 0)) throw new PkgsetError(`${url}: a bad Content-Length`);
  if (declared !== null && declared > max) {
    await r.body?.cancel();
    throw new PkgsetError(`${url}: over ${max} bytes`);
  }
  const size = exact ? max : (declared ?? max);
  const out = new Uint8Array(size);
  const reader = r.body!.getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) {
      await reader.cancel();
      throw new PkgsetError(`${url}: over ${size} bytes`);
    }
    out.set(value, n);
    n += value.length;
  }
  if ((exact || declared !== null) && n !== size) throw new PkgsetError(`${url}: ${n} bytes, not the ${size} declared`);
  return n === size ? out : out.subarray(0, n);
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

// A shell.result's payload, checked: exactly one of exit (a code in 0..255
// and two strings) or rejected (a message); anything else is null.
function outcome(p: any): ShellOutcome | null {
  if (!p || typeof p !== "object" || ("exit" in p) === ("rejected" in p)) return null;
  if ("exit" in p) {
    const { code, stdout, stderr } = p.exit ?? {};
    if (!Number.isInteger(code) || code < 0 || code > 255 || typeof stdout !== "string" || typeof stderr !== "string") return null;
    return { exit: { code, stdout, stderr } };
  }
  const message = p.rejected?.message;
  return typeof message === "string" ? { rejected: { message, refusal: null } } : null;
}

/**
 * Start the shell of set `S`, from the site at `base` (its pkgset/<S>.json,
 * pkg/<sha256>.json and shell/worker-boot.js).  Resolves once the module says
 * shell.ready, with the shell and its chunk's verified notices (the license
 * texts of what the module bundles, A1.1a).  The notices are the caller's:
 * this module keeps no reference to them, and the worker never receives them
 * (r4 addendum A1 r3; the panel's About view re-reads them, step 4).
 *
 * The shell's worker and channel have one way out, close(), for every end:
 * a boot failure, a worker error or an undecodable message at any time, a
 * closed channel, a broken protocol, a failed post, an abort of `signal`
 * before ready, and terminate().  It ends the worker and the channel, fails
 * every pending exec() with ShellUnavailableError, and makes later ones fail
 * at once.  A start that fails leaves nothing running.  There is no deadline
 * of its own: a module that never says ready runs until the caller aborts
 * `signal`.
 */
export async function startShell(S: string, at: string | URL = "./", { signal }: { signal?: AbortSignal } = {}): Promise<{ shell: Shell; notices: string }> {
  if (!/^[0-9a-f]{64}$/.test(S)) throw new PkgsetError("a package set id is 64 lowercase hex digits");
  signal?.throwIfAborted();
  const base = new URL(at, document.baseURI);
  const index = await boundedFetch(new URL(`pkgset/${S}.json`, base).href, PKGSET_LIMITS.indexBytes, { signal });
  // (the Python side of the set is the engine's to admit, with the core's own
  // reserved names: here only its pins and its js packages are used)
  const plan = admitIndex(S, index, "0".repeat(16), { isCoreModule: () => false, bundledDirs: new Set() });
  const j = shellPackage(plan);
  // (the stages of A1.2: the declared size against the caps before the fetch (admitIndex), the body against
  // it while streaming, then the pin, the parse and the decoded module and notices before anything is kept)
  const bytes = await boundedFetch(new URL(`pkg/${j.js.sha256}.json`, base).href, j.js.size, { exact: true, signal });
  const { text, notices } = checkJsChunk(plan, j.id, bytes);
  signal?.throwIfAborted();
  const worker = new Worker(new URL("shell/worker-boot.js", base), { type: "module", name: "sagebrush-shell" });
  const { port1, port2 } = new MessageChannel();
  const pending = new Map<number, { resolve: (o: ShellOutcome) => void; reject: (e: unknown) => void }>();
  let next = 1;
  let closed: ShellUnavailableError | null = null;
  let startup: { resolve: (version: string) => void; reject: (e: unknown) => void } | null = null;
  const ready = new Promise<string>((resolve, reject) => (startup = { resolve, reject }));
  const onAbort = () => close("aborted before it was ready", signal!.reason);
  function close(reason: string, startError: unknown = new PkgsetError(`the shell didn't start: ${reason}`)) {
    if (closed) return;
    closed = new ShellUnavailableError(reason);
    signal?.removeEventListener("abort", onAbort);
    port1.onmessage = port1.onmessageerror = null;
    worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    port1.close();
    for (const p of pending.values()) p.reject(closed);
    pending.clear();
    startup?.reject(startError);
    startup = null;
  }
  port1.onmessage = (e) => {
    const { name, payload } = e.data ?? {};
    if (name === "shell.ready" && startup) {
      signal?.removeEventListener("abort", onAbort);
      startup.resolve(String(payload?.version ?? ""));
      startup = null;
    } else if (name === "boot.failed" && startup) close(String(payload?.message));
    else if (name === "shell.result" && !startup) {
      const o = outcome(payload);
      const p = pending.get(payload?.id);
      if (!o || !p) return close("it broke the shell protocol (a malformed or unexpected shell.result)");
      pending.delete(payload.id);
      p.resolve(o);
    } else close(`it broke the shell protocol (an unexpected ${JSON.stringify(String(name)).slice(0, 40)})`);
  };
  port1.onmessageerror = () => close("a message from it couldn't be decoded");
  // (where browsers have it: the other end of the channel went away)
  port1.addEventListener("close", () => close("its channel closed"));
  worker.onerror = (e) => close(`its worker failed: ${e.message}`);
  worker.onmessageerror = () => close("a message from its worker couldn't be decoded");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    worker.postMessage({ text, port: port2 }, [port2]);
  } catch (err) {
    close(`the module couldn't be posted to its worker: ${(err as Error)?.message ?? err}`);
  }
  const version = await ready;
  const shell: Shell = {
    S,
    version,
    get state() {
      return closed ? "closed" : "open";
    },
    exec(script: string, stdin?: string) {
      if (closed) return Promise.reject(closed);
      if (typeof script !== "string" || (stdin !== undefined && typeof stdin !== "string")) return Promise.reject(new TypeError("exec(script, stdin?) takes strings"));
      const id = next++;
      return new Promise<ShellOutcome>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          port1.postMessage({ exec: { id, script, ...(stdin === undefined ? {} : { stdin }) } });
        } catch (err) {
          close(`an invocation couldn't be posted to it: ${(err as Error)?.message ?? err}`);
        }
      });
    },
    terminate() {
      close("terminated");
    },
  };
  return { shell, notices };
}
