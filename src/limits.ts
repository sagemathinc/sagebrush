// The engine's limits (plan-ff-limits r3) as the Node hosts take them: one
// JSON text of at most LIMITS_MAX_BYTES bytes, from `--limits FILE` among the
// interpreter's own options, else SAGEBRUSH_LIMITS=FILE, validated and locked
// by lib/_limits.py in every runtime before its first user statement.
//
// The launcher (packages/sagebrush/bin/sagebrush.cjs) does the same scan and
// read itself (it never loads the bundle on its own thread), and hands the
// text on: to a program's worker in workerData.sagebrushCli.limits, to the
// bundle it loads in-process in globalThis.__SAGEBRUSH_LIMITS__ (never an
// environment value, which a child process would inherit).  The bundle hands
// the same text to each worker it starts (notebook, kernel, board run) in
// workerData.sagebrushLimits.  A file that can't be read, or limits that are
// invalid, end the command with status 2 before any user code; never a
// fallback to the other source or to the defaults.  (Reading a file is
// src/limits-file.ts's, which only the Node hosts load: this file is the
// browser worker's too.)
import { dictGet, getattr } from "./runtime/object";

export const LIMITS_MAX_BYTES = 4096;

/** A limits text and the file it came from (for messages), or null: none. */
export type LimitsText = { text: string; name: string | null } | null;

/** `--limits FILE`, taken out of argv (changed in place) if it is among the
 * interpreter's own options: before -c, -m, -, a script, a subcommand or
 * `--`, the values of --figures and --pkgset skipped.  The file, or null, or
 * {error}. */
export function takeLimitsOption(argv: string[]): string | null | { error: string } {
  let file: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--limits") {
      if (i + 1 >= argv.length) return { error: "--limits takes a file" };
      if (file !== null) return { error: "--limits is given more than once" };
      file = argv[i + 1];
      argv.splice(i, 2);
      i--;
      continue;
    }
    if (x === "--figures" || x === "--pkgset") {
      i++;
      continue;
    }
    if (x === "--" || x === "-c" || x === "-m" || x === "-" || !x.startsWith("-")) break;
  }
  return file;
}

/** The launcher's decision, when it loaded this bundle in-process. */
export function launcherLimits(): LimitsText | undefined {
  const g = globalThis as any;
  return "__SAGEBRUSH_LIMITS__" in g ? g.__SAGEBRUSH_LIMITS__ : undefined;
}

/**
 * Give a runtime its limits, before any user code: lib/_limits.py's
 * validate and propose (if there are limits), then finalize unless `lock` is
 * false.  libDir() must be on sys.path.  The message of invalid limits
 * ("limits: ..."), or null.
 */
export function startLimits(R: any, lim: LimitsText, lock = true): string | null {
  // (no limits and _limits not imported yet: a lazy lock; an imported one,
  // pending snapshot or not, is finalized below as it always was)
  if (lim === null && dictGet(R.sysModules, "_limits") === undefined) {
    if (lock) lockDefaults(R);
    return null;
  }
  const L = R.importModule("_limits");
  try {
    if (lim !== null) {
      const snap = R.callObj(getattr(L, "validate"), lim.name === null ? [lim.text] : [lim.text, lim.name]);
      R.callObj(getattr(L, "propose"), [snap]);
    }
    if (lock) R.callObj(getattr(L, "finalize"), []);
    return null;
  } catch (e) {
    const exc = R.toPyExc(e);
    if (!R.typeOf(exc).$mro.includes(R.T.ValueError)) throw e;
    return String(R.str(exc));
  }
}

/**
 * No limits given: lock the defaults without importing lib/_limits.py at
 * startup.  A fresh per-user compile cache (a new install, a new HOME)
 * would compile it on every first run, ~90 ms of CPU, for a session that
 * may never read a limit.  sys._sagebrush_limits_lock tells _limits to
 * finalize as it is first imported (by the finite-field core, the engine or
 * user code: propose then raises, as when it was locked here), and
 * sys._sagebrush_limits is there from the start as before: reading it
 * imports _limits and replaces this accessor with the snapshot itself;
 * assigning or deleting it is a plain attribute's, and stays (_limits leaves
 * it alone).  (An accessor, not a module __getattr__: sys gets no
 * __getattr__, which CPython's lacks, and a missing name costs what it did.)
 */
function lockDefaults(R: any): void {
  const sys = R.importModule("sys");
  sys._sagebrush_limits_lock = true;
  const plain = (v: any) => Object.defineProperty(sys, "_sagebrush_limits", { value: v, writable: true, enumerable: true, configurable: true });
  Object.defineProperty(sys, "_sagebrush_limits", {
    get: () => {
      const v = R.callObj(getattr(R.importModule("_limits"), "finalize"), []);
      plain(v);
      return v;
    },
    set: plain,
    enumerable: true,
    configurable: true,
  });
}

/** The UTF-8 length of s (a lone surrogate counted as 3 bytes, as Python's
 * surrogatepass), or max + 1 once past max: no copy of s is made. */
export function utf8Bytes(s: string, max = LIMITS_MAX_BYTES): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= max; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return Math.min(n, max + 1);
}

// This process's limits, as main() selected them: what the servers it starts
// hand each of their workers (workerData.sagebrushLimits).
let session: LimitsText = null;
export const setSessionLimits = (l: LimitsText) => void (session = l);
export const sessionLimits = (): LimitsText => session;
