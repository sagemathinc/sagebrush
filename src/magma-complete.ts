// Tab completion at a Magma prompt (the notebook, the kernel and the CLI):
// the identifier before the caret, completed from Magma's names only, never
// Python's.  The candidates are the intrinsics Sagebrush implements
// (lib/_magma.py's __all__, read at run time, so no list ships twice), the
// language's keywords, and the session's own variables.
import { R } from "./compile";
import { KEYWORDS, PYKW, PY_BUILTINS } from "./magma";

/** A Python name back in Magma's spelling: pyName (src/magma.ts) adds a "_" to a
 * Magma name that is a Python keyword or builtin (abs -> abs_). */
const magmaSpelling = (py: string) => (py.endsWith("_") && (PYKW.has(py.slice(0, -1)) || PY_BUILTINS.has(py.slice(0, -1))) ? py.slice(0, -1) : py);

/** The intrinsics Sagebrush implements, as Magma names (null when the library can't load). */
function intrinsics(): string[] {
  try {
    return (R.toArray(R.importModule("_magma").__all__) as string[]).map(magmaSpelling);
  } catch {
    return [];
  }
}

/** Completions of the Magma identifier ending `line`: [matches, the text they replace]. */
export function magmaCompletions(main: any, line: string): [string[], string] {
  const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
  if (!m) return [[], ""];
  const word = m[1];
  // (the session's variables: what its Magma code bound in __main__, without the runtime's own _ names)
  const vars = Object.keys(main).filter((k) => k[0] !== "$" && k[0] !== "_").map(magmaSpelling);
  const names = [...intrinsics(), ...KEYWORDS, ...vars];
  const hits = [...new Set(names.filter((n) => n.startsWith(word) && (word.startsWith("_") || !n.startsWith("_"))))].sort();
  return [hits, word];
}
