// How a program's end becomes an exit status, by CPython's rules: the command line's (src/cli.ts) and the
// Terminal's commands' (web/term-run.ts) alike.
import { R } from "./compile";
import { unbox } from "./runtime/object";

// A SystemExit's status as the process's exit code, by CPython's rule
// (Python/pythonrun.c), from its Python type, not how this runtime holds it:
// None is 0; an integer (bool and int subclasses too) is its value, its low
// byte as the system keeps it, or -1 (255) if it does not fit a long long;
// anything else is written to stderr, and is 1.
export function exitCode(c: any): number {
  if (c === null || c === undefined) return 0;
  let int = false;
  try {
    int = R.typeOf(c).$mro.includes(R.T.int);
  } catch {}
  if (int) {
    try {
      // (its integer as stored, as CPython reads it: an int subclass's __index__ is not asked, CORR-0BE-1)
      const v = BigInt(unbox(c));
      return v >= -(2n ** 63n) && v < 2n ** 63n ? Number(BigInt.asUintN(8, v)) : 255;
    } catch {}
  }
  R.stdout.flush();
  let text: string;
  try {
    text = String(R.str(c));
  } catch {
    text = "(an exit status that could not be written as text)";
  }
  R.stderr.write(text + "\n");
  return 1;
}

// Run fn, reporting an uncaught exception as CPython does; returns the exit code.
// (an uncaught KeyboardInterrupt: after its traceback the process ends by
// SIGINT, as CPython's does, so a shell sees 130: endByInterrupt)
export function guarded(fn: () => void, onInterrupt?: () => void): number | null {
  try {
    fn();
    return null;
  } catch (e: any) {
    const exc = R.toPyExc(e);
    if (R.typeOf(exc).$mro.includes(R.T.SystemExit)) return exitCode(exc.code);
    R.stdout.flush();
    R.stderr.write(R.formatException(exc));
    if (R.typeOf(exc).$mro.includes(R.T.KeyboardInterrupt)) {
      onInterrupt?.();
      return 130;
    }
    return 1;
  }
}
