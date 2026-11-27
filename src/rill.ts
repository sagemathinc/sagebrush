// Rill, Sagebrush's R mode (design/rill.md): the CLI's and the prompt's side.  `sagebrush --r` (or `--rill`) runs R:
// `-c` source, a .R file and R on stdin as Rscript runs a program, and the interactive prompt as R's console does.
import { R } from "./compile";
import { getattr } from "./runtime/object";

/** An R program as the Python that runs it: lib/_rill's run(), whose result is the exit status.  (A JSON string is a
 * valid Python string literal.) */
export function rillSource(src: string): string {
  return `import sys, _rill\nsys.exit(_rill.run(${JSON.stringify(src)}))\n`;
}

/** One input at the prompt (or a notebook cell) as the Python that runs it in the shared session: an error is reported
 * on stderr and the session goes on. */
export function rillCellSource(src: string): string {
  return `import _rill\n_rill.run_cell(${JSON.stringify(src)})\n`;
}

/** Whether the lines typed so far end inside an R statement (the prompt then reads another line, after "+ "). */
export function rillIsIncomplete(src: string): boolean {
  const v = R.callObj(getattr(R.importModule("_rill"), "is_incomplete"), [src]);
  return v === true || String(R.str(v)) === "True";
}

/** q() or quit() at the prompt: the session ends with its status (0 unless status = n is given), else null. */
export function rillQuit(src: string): number | null {
  const m = /^\s*(?:q|quit)\s*\(\s*(?:save\s*=\s*"(?:no|yes|ask|default)"\s*,?\s*)?(?:status\s*=\s*(\d+)\s*)?\)\s*;?\s*(?:#.*)?$/.exec(src);
  return m === null ? null : m[1] === undefined ? 0 : Number(m[1]);
}

/** Why `--r` can't run what the other arguments ask for, or null: -m (a Python module) and --emit (no Python is
 * compiled from R) are refused; -c, a file, stdin and the prompt are R's. */
export function rillRefusal(o: { mod: string | null; emit: boolean }): string | null {
  if (o.mod !== null) return "--r runs R: -m runs a Python module";
  if (o.emit) return "--r runs R: --emit has nothing to print (R isn't compiled to Python)";
  return null;
}

/** A .R file is R's. */
/** The R prompt's first lines: Sagebrush's version (without its Python language), and how to leave. */
export const rillBanner = (version: string) => `${version.replace(/ \(.*\)$/, "")} (R, a subset, on a JavaScript runtime: what is not implemented yet says so)\nType q() or Ctrl-D to leave.\n`;

export const isRFile = (f: string | null) => f !== null && /\.[Rr]$/.test(f);
