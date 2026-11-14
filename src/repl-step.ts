// One input at an interactive prompt, the same for the CLI's REPL (src/cli.ts) and the Terminal's prompt (web/term-run.ts):
// the prompts, whether an input is complete, and how a complete one runs in the session's __main__ (Python and Sage
// through IPython's syntax, the magics and %autoreload's hooks; MATLAB and Magma translated as the kernel's cells are).
// The caller owns its streams and its exit-status rule: `guarded` and the writers are given, so this module pulls
// neither src/exit-status.ts nor src/cli.ts into the other's bundle.
import { R } from "./compile";
import { needsMore, ipythonSyntax } from "./interactive";
import { MAGIC_PRE, MAGIC_POST, GET_IPYTHON, magicTransform, QUITTERS, matlabQuit } from "./magic-syntax";
import { magmaToPython, magmaIsIncomplete, MagmaSyntaxError, magmaSyntaxMessage } from "./magma";
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage, matlabIsIncomplete } from "./matlab";
import { getattr } from "./runtime/object";
import type { ReplMode } from "./modes";

export interface PromptIO {
  /** Runs fn, reports an uncaught exception as the caller does, and gives SystemExit's status (else null, or 1). */
  guarded(fn: () => void): number | null;
  /** Magma's syntax error report goes to stdout, as Magma's does. */
  out(text: string): void;
  err(text: string): void;
  /** A Magma syntax error was reported (the CLI marks its exit status). */
  syntaxError?(): void;
  /** Files written but never closed, written out (lib/_pyjs_open.py). */
  flushFiles(): void;
}

/** What one complete input did: the session ends with `end`, or it goes on (`code`, the input's own status). */
export type StepResult = { end: number } | { code: number | null };

export class PromptSession {
  private host: any = null;
  constructor(
    readonly main: any,
    readonly mode: ReplMode,
    readonly sage: boolean,
    readonly io: PromptIO,
  ) {}

  /** Before the first prompt: the language's library, and get_ipython() as in a notebook. */
  start(): void {
    if (this.mode !== "python") this.io.guarded(() => R.importModule(this.mode === "magma" ? "_magma" : "_matlab"));
    // (the session's own Python around each input: %autoreload's hooks)
    this.host = R.newModule("__sagebrush_host__");
    this.host.__builtins__ = R.builtins;
    this.io.guarded(() => R.loader.exec(GET_IPYTHON, this.host, "exec", "<init>"));
    if (this.mode === "python") this.io.guarded(() => R.loader.exec(QUITTERS, this.host, "exec", "<init>"));
  }

  private opts() {
    return { sage: this.sage };
  }

  // (Magma's prompt and MATLAB's; neither shows one for a continued input)
  ps1(): string {
    if (this.mode === "magma") return "> ";
    if (this.mode === "matlab") return ">> ";
    const sys = R.importModule("sys");
    return typeof sys.ps1 === "string" ? sys.ps1 : this.sage ? "sage: " : ">>> ";
  }
  ps2(): string {
    if (this.mode !== "python") return "";
    const sys = R.importModule("sys");
    return typeof sys.ps2 === "string" ? sys.ps2 : this.sage ? "....: " : "... ";
  }

  /** Is `src` (the lines so far) an input that goes on? */
  incomplete(src: string): boolean {
    if (src.trim() === "") return false;
    return this.mode === "magma" ? magmaIsIncomplete(src) : this.mode === "matlab" ? matlabIsIncomplete(src) : needsMore(src, this.opts());
  }

  /** One complete, non-blank input. */
  run(src: string): StepResult {
    // (MATLAB's exit and quit, at the prompt: the session ends, with the status given; a comment may follow)
    const q = this.mode === "matlab" ? matlabQuit(src) : null;
    if (q !== null) return { end: q };
    // (a function definition at the prompt: refused with MATLAB's command-window error, not run line by line)
    if (this.mode === "matlab" && /^\s*function\b/.test(src)) {
      this.io.err("Function definitions are not supported in this context. Functions can only be created as local or nested functions in code files.\n");
      return { code: null };
    }
    let code: number | null;
    // (a SystemExit at a Python or Sage prompt leaves it, whatever its status, as CPython's: exit(1), sys.exit("bye")
    // (its text written by guarded, status 1), not only a status other than an error's)
    let left = false;
    if (this.mode !== "python") code = this.runTranslated(src);
    else {
      this.io.guarded(() => R.loader.exec(MAGIC_PRE, this.host, "exec", "<autoreload>"));
      code = this.io.guarded(() => {
        try {
          R.loader.exec(ipythonSyntax(src) + "\n", this.main, "single", "<stdin>", { ...this.opts(), transform: magicTransform(this.sage) });
        } catch (e) {
          if (R.typeOf(R.toPyExc(e)).$mro.includes(R.T.SystemExit)) left = true;
          throw e;
        }
      });
      this.io.guarded(() => R.loader.exec("import sys as _s\n" + MAGIC_POST, this.host, "exec", "<autoreload>"));
    }
    // (Python's file flushes are Python code too, and may not return: still busy)
    this.io.flushFiles();
    R.stdout.flush();
    R.stderr.flush();
    return left ? { end: code ?? 0 } : { code };
  }

  /**
   * One input typed at a Magma or MATLAB prompt, translated as the kernel's cells are (src/kernel.ts) and run in the
   * session's __main__: Magma as a session (an error is reported and the session goes on), MATLAB in cell mode (its
   * error message on stderr, and the session goes on).  The exit status of a quit, else null.
   */
  private runTranslated(src: string): number | null {
    if (this.mode === "magma") {
      let py: string;
      try {
        py = magmaToPython(src, "<stdin>", { recover: "session" });
      } catch (e) {
        if (!(e instanceof MagmaSyntaxError)) throw e;
        this.io.out(magmaSyntaxMessage(e, src, "<stdin>"));
        this.io.syntaxError?.();
        return null;
      }
      return this.io.guarded(() => R.loader.exec(py, this.main, "exec", "<stdin>", this.opts()));
    }
    let py: string;
    try {
      py = matlabToPython(src, "<stdin>", { cell: true });
    } catch (e) {
      if (!(e instanceof MatlabSyntaxError)) throw e;
      this.io.err(matlabSyntaxMessage(e, src, "<stdin>"));
      return null;
    }
    const code = this.io.guarded(() => R.loader.exec(py, this.main, "exec", "<stdin>", this.opts()));
    // (the error, if any, is on stderr already: forget that this input failed)
    this.io.guarded(() => R.callObj(getattr(R.importModule("_matlab"), "cell_failed"), []));
    return code;
  }
}
