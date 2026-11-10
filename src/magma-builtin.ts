// The builtin __pyjs_compile_magma__(src, filename, mode): Magma source as a
// Python code object, so that one Python driver can run Magma among other
// languages (the LaTeX editor's Run: \magma{}, magmablock, magmasilent).  It
// mirrors __pyjs_compile_sage__ (src/runtime/index.ts), but lives here, so
// only the bundles that already carry the translator (src/magma.ts) get it.
//
// The code object runs Magma as a file does (src/magma.ts Recover "file";
// lib/_magma.py _source): exec it in one dict kept for Magma, and the
// session's state carries from one item to the next.  How a run ends, as
// Magma 2.18-5 does in a file (magma-tests/):
//   - an error Magma stops at (bad syntax, a runtime error, error "..."):
//     Magma's text on stdout, then SystemExit(1);
//   - an undeclared identifier, or a statement Magma rejects before running
//     it: reported on stdout, and the run goes on (no exception);
//   - quit; or exit;: SystemExit(0).
// A caller reads the exceptions, never the printed text: the errors that go
// on print "User error" too.
import { magmaToPython, MagmaSyntaxError } from "./magma";
import { builtin, raise, raiseExc, T, tuple } from "./runtime/object";

function compileMagma(R: any, src: any, filename: any, mode: any): any {
  if (typeof src !== "string") raise(T.TypeError, "__pyjs_compile_magma__() arg 1 must be a string");
  if (mode !== "exec") raise(T.ValueError, "__pyjs_compile_magma__() mode must be 'exec'");
  const name = String(filename);
  let py: string;
  try {
    py = magmaToPython(src, name, { recover: "file" });
  } catch (e) {
    // (with recovery the translator reports syntax errors at run time, in
    // Magma's words; a MagmaSyntaxError escaping it anyway is still Python's
    // SyntaxError, never a crash of the host)
    if (!(e instanceof MagmaSyntaxError)) throw e;
    const text = src.split("\n")[e.line - 1] ?? "";
    raiseExc(T.SyntaxError(`bad syntax: ${e.message}`, tuple([name, e.line, e.col, text, null, null])));
  }
  return R.callObj(R.builtins.compile, [py!, name, "exec"]);
}

/** Install __pyjs_compile_magma__ in runtime `R`'s builtins. */
export function installMagmaCompile(R: any): void {
  R.builtins.__pyjs_compile_magma__ = builtin((src: any, filename: any, mode: any) => compileMagma(R, src, filename, mode), "__pyjs_compile_magma__");
}
