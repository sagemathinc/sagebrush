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
// (the highest level of any message, or of any compatible widening of one: host-levels.json's "fields")
export const SHELL_HOST_LEVEL: number = Math.max(...Object.values(HOST_LEVELS.names as Record<string, number>), ...Object.values(((HOST_LEVELS as any).fields ?? {}) as Record<string, number>));

/**
 * What one invocation came to (r3 §7.4, D8 point 5): a real shell exit, whose
 * status is the only thing that makes an exit status (an integer in 0..255),
 * or a rejection of the module's exec(), reported as a rejection and never
 * folded into a status.  `refusal`: the id of the mediator's refusal the
 * module says it rejected with (it reports one only if the rejected value is
 * the very object it threw for it), else null.  The module's word only:
 * web/shell/host.ts checks it against its own records.
 */
export type ShellOutcome =
  | { exit: { code: number; stdout: string; stderr: string }; output?: OutputCount }
  | { rejected: { message: string; refusal: string | null }; output?: OutputCount }
  | { limit: { key: ModuleLimitKey; value: number } };
/**
 * Step 3 (host level 3): the module's own count of a result (r8c E2, @sagebrush's output_bytes ruling C with astra5's
 * conditions): `producedBytes`, the whole result's UTF-8 size (stdout then stderr); `deliveredBytes`, the size of the
 * prefix it sent, within the invocation's allowance and the fixed backstop; `exceeded`, its flag that the result
 * passed the allowance; `truncated`, that it passed only the backstop (an ordinary result's prefix, never typed).
 * Checked here for shape and its own bounds (delivered <= produced; not exceeded means all of it delivered); the host
 * checks them against the allowance and the strings it got.
 */
export type OutputCount = { producedBytes: number; deliveredBytes: number; exceeded: boolean; truncated: boolean };
/** The limits the module enforces itself and reports as a typed limit (only bash.pipeline_width). */
export type ModuleLimitKey = "pipeline_width";

/** One file call of an invocation's (fs.request), for its mediator to answer: `ok` with a value, or an
 * error `{code, message, refusal?}` (an errno code; `refusal`, the mediator's id for it, when it is one). */
export type FsRequest = { req: number; op: string; args: unknown[] };
export type FsAnswer = { ok: unknown } | { err: { code: string; message: string; refusal?: string } };
export interface ExecOptions {
  stdin?: string;
  /** the run's id, which the module puts on each of its file calls (r3 §2.2 step 1) */
  run?: string;
  cwd?: string;
  /** the invocation's mediator: every file call it makes, answered (without one, each is refused EBADF) */
  onRequest?: (r: FsRequest) => Promise<FsAnswer>;
  /** Stop: aborts the invocation's signal in the module (it stops at the next statement boundary) */
  signal?: AbortSignal;
  /** step 3: the invocation's own just-bash limits (only maxExecutionTimeMs, the run's remaining script_ms) */
  limits?: { maxExecutionTimeMs?: number };
  /** step 3: the run's remaining output_bytes, which the module never sends more than */
  allowance?: number;
}
/** step 3's init (host level 3): just-bash's executionLimits and bash.pipeline_width (web/shell/limits.ts). */
export type ShellInit = { limits: Readonly<Record<string, number>>; pipelineWidth: number };

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
  /** the host level its package needs, as its verified index pins it (host_req: computed at publish, A1.4) */
  readonly hostReq: number;
  /** "closed" once terminated or failed; it doesn't reopen */
  readonly state: "open" | "closed";
  exec(script: string, opts?: string | ExecOptions): Promise<ShellOutcome>;
  /**
   * Step 3: the worker's one init (r3 §4.1), before any exec: resolves with the limits just-bash resolved, or
   * rejects with the module's refusal (a second init, or limits just-bash refuses).  Only a host level 3 module
   * answers it; the host refuses an older one before asking.
   */
  configure(init: ShellInit): Promise<Record<string, number>>;
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
// and two strings), rejected (a message) or limit (step 3: bash.pipeline_width
// and its value); exit and rejected with an optional output count (step 3),
// itself checked; anything else is null.
const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function outputOf(o: any): OutputCount | undefined | null {
  if (o === undefined) return undefined;
  if (!o || typeof o !== "object" || !count(o.producedBytes) || !count(o.deliveredBytes) || typeof o.exceeded !== "boolean" || typeof o.truncated !== "boolean") return null;
  if (o.deliveredBytes > o.producedBytes || (o.exceeded && o.truncated) || (!o.exceeded && !o.truncated && o.deliveredBytes !== o.producedBytes)) return null;
  return { producedBytes: o.producedBytes, deliveredBytes: o.deliveredBytes, exceeded: o.exceeded, truncated: o.truncated };
}
function outcome(p: any): ShellOutcome | null {
  if (!p || typeof p !== "object" || Number(Object.hasOwn(p, "exit")) + Number(Object.hasOwn(p, "rejected")) + Number(Object.hasOwn(p, "limit")) !== 1) return null;
  if ("limit" in p) {
    const { key, value } = p.limit ?? {};
    return key === "pipeline_width" && count(value) && !("output" in p) ? { limit: { key, value } } : null;
  }
  const output = outputOf(p.output);
  if (output === null) return null;
  if ("exit" in p) {
    const { code, stdout, stderr } = p.exit ?? {};
    if (!Number.isInteger(code) || code < 0 || code > 255 || typeof stdout !== "string" || typeof stderr !== "string") return null;
    return { exit: { code, stdout, stderr }, ...(output ? { output } : {}) };
  }
  const message = p.rejected?.message, refusal = p.rejected?.refusal ?? null;
  return typeof message === "string" && (refusal === null || typeof refusal === "string") ? { rejected: { message, refusal }, ...(output ? { output } : {}) } : null;
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
  const pending = new Map<number, { resolve: (o: ShellOutcome) => void; reject: (e: unknown) => void; run: string; onRequest?: ExecOptions["onRequest"] }>();
  let next = 1;
  let closed: ShellUnavailableError | null = null;
  let startup: { resolve: (version: string) => void; reject: (e: unknown) => void } | null = null;
  // (step 3: an init's answer, while it is awaited; a second init goes to the module, which refuses it)
  let configuring: { resolve: (l: Record<string, number>) => void; reject: (e: unknown) => void } | null = null;
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
    configuring?.reject(closed);
    configuring = null;
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
    else if (name === "fs.request" && !startup) {
      const { id, run, req, op, args } = payload ?? {};
      if (!Number.isSafeInteger(req) || typeof op !== "string" || !Array.isArray(args)) return close("it broke the shell protocol (a malformed fs.request)");
      const p = pending.get(id);
      const reply = (a: FsAnswer) => {
        if (closed) return;
        try {
          port1.postMessage({ fs: { id, req, ...a } });
        } catch (err) {
          close(`a file call's answer couldn't be posted to it: ${(err as Error)?.message ?? err}`);
        }
      };
      // (a call from an invocation that has ended, or for another run: refused, never executed (r3 §2.2 step 1))
      if (!p || run !== p.run || !p.onRequest) return reply({ err: { code: "EBADF", message: "this run has ended, or has no file access" } });
      p.onRequest({ req, op, args }).then(reply, (err) => reply({ err: { code: "EIO", message: String((err as Error)?.message ?? err) } }));
    }
    else if (name === "shell.configured" && !startup && configuring) {
      const c = configuring;
      const lim = payload?.limits;
      // (r2, astra5 B3-A5-1: the waiter is settled on every path; a malformed answer closes the shell, and close()
      // rejects the waiter, which is still set then, so neither configure() nor the host's start is left waiting)
      if (typeof payload?.error === "string") {
        configuring = null;
        c.reject(new Error(payload.error));
      } else if (lim && typeof lim === "object" && Object.values(lim).every((v) => typeof v === "number")) {
        configuring = null;
        c.resolve({ ...lim });
      } else close("it broke the shell protocol (a malformed shell.configured)");
    }
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
    hostReq: j.js.host_req,
    get state() {
      return closed ? "closed" : "open";
    },
    exec(script: string, opts: string | ExecOptions = {}) {
      if (closed) return Promise.reject(closed);
      const o: ExecOptions = typeof opts === "string" ? { stdin: opts } : opts;
      const { stdin, cwd = "/", run = "-", onRequest, signal, limits, allowance } = o;
      if (typeof script !== "string" || (stdin !== undefined && typeof stdin !== "string") || typeof cwd !== "string" || typeof run !== "string") return Promise.reject(new TypeError("exec(script, {stdin?, cwd?, run?}) takes strings"));
      const t = limits?.maxExecutionTimeMs;
      if ((t !== undefined && !(typeof t === "number" && t >= 0)) || (allowance !== undefined && !count(allowance))) return Promise.reject(new TypeError("exec's limits.maxExecutionTimeMs is a number >= 0 and its allowance a count of bytes"));
      const id = next++;
      return new Promise<ShellOutcome>((resolve, reject) => {
        const onAbort = () => {
          if (pending.has(id) && !closed) try { port1.postMessage({ abort: { id } }); } catch {}
        };
        const done = <T,>(f: (x: T) => void) => (x: T) => { signal?.removeEventListener("abort", onAbort); f(x); };
        pending.set(id, { resolve: done(resolve), reject: done(reject), run, onRequest });
        try {
          port1.postMessage({ exec: { id, run, script, cwd, ...(stdin === undefined ? {} : { stdin }), ...(t === undefined ? {} : { limits: { maxExecutionTimeMs: t } }), ...(allowance === undefined ? {} : { allowance }) } });
        } catch (err) {
          close(`an invocation couldn't be posted to it: ${(err as Error)?.message ?? err}`);
          return;
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    configure(init: ShellInit) {
      if (closed) return Promise.reject(closed);
      if (configuring) return Promise.reject(new Error("an init is already waiting for its answer"));
      return new Promise<Record<string, number>>((resolve, reject) => {
        configuring = { resolve, reject };
        try {
          port1.postMessage({ init: { limits: { ...init.limits }, pipelineWidth: init.pipelineWidth } });
        } catch (err) {
          close(`its init couldn't be posted to it: ${(err as Error)?.message ?? err}`);
        }
      });
    },
    terminate() {
      close("terminated");
    },
  };
  return { shell, notices };
}
