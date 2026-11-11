// The builtin __pyjs_compile_matlab__(src, filename, mode): MATLAB source as a
// Python code object, so that one Python driver can run MATLAB among other
// languages (the LaTeX editor's Run: \matlab{}, matlabblock, matlabsilent).
// It mirrors __pyjs_compile_magma__ (src/magma-builtin.ts) and lives where it
// does, so only the bundles that already carry the translator (src/matlab.ts)
// get it.
//
// The code object runs MATLAB as a notebook cell does (src/matlab.ts's cell
// mode, as src/kernel.ts runs a MATLAB cell): exec it in one dict kept for
// MATLAB, and the session's variables and functions carry from one item to the
// next.  How a run ends:
//   - an error MATLAB stops at: reported by lib/_matlab.py (on stderr, or kept
//     for _matlab.cell_error() after _matlab.host_shows_errors()), no
//     exception;
//   - a syntax error: no code object at all, but Python's SyntaxError whose
//     message is the text the kernel shows for it (matlabSyntaxMessage), with
//     `filename` naming the item;
//   - Stop (KeyboardInterrupt) and SystemExit pass through, as in a cell.
import { matlabToPython, MatlabSyntaxError, matlabSyntaxMessage } from "./matlab";
import { builtin, raise, raiseExc, T, tuple } from "./runtime/object";

function compileMatlab(R: any, src: any, filename: any, mode: any): any {
  if (typeof src !== "string") raise(T.TypeError, "__pyjs_compile_matlab__() arg 1 must be a string");
  if (mode !== "exec") raise(T.ValueError, "__pyjs_compile_matlab__() mode must be 'exec'");
  const name = String(filename);
  let py: string;
  try {
    py = matlabToPython(src, name, { cell: true });
  } catch (e) {
    if (!(e instanceof MatlabSyntaxError)) throw e;
    const text = src.split("\n")[e.line - 1] ?? "";
    throw raiseExc(T.SyntaxError(matlabSyntaxMessage(e, src, name).replace(/\n$/, ""), tuple([name, e.line, e.col, text, null, null])));
  }
  return R.callObj(R.builtins.compile, [py!, name, "exec"]);
}

/** Install __pyjs_compile_matlab__ in runtime `R`'s builtins. */
export function installMatlabCompile(R: any): void {
  R.builtins.__pyjs_compile_matlab__ = builtin((src: any, filename: any, mode: any) => compileMatlab(R, src, filename, mode), "__pyjs_compile_matlab__");
}
