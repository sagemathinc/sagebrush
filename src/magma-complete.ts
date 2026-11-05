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

// (the library's exports, which of them are classes, and the names Magma's Handbook documents
// (lib/_magma_names.py); worked out once)
const INTRINSICS_PY = `import _magma, _magma_names
_all = list(_magma.__all__)
_cls = [n for n in _all if isinstance(getattr(_magma, n), type)]
_hb = _magma_names.NAMES.split()
`;
let cached: string[] | null = null;
// (every name the library exports: in a session's __main__ by its `from _magma import *`, so no variable)
let exported = new Set<string>();

/** The intrinsics Sagebrush implements, as Magma names (none when the library can't load). */
function intrinsics(): string[] {
  if (cached !== null) return cached;
  try {
    const ns = R.newModule("__magma_complete__");
    ns.__builtins__ = R.builtins;
    R.loader.exec(INTRINSICS_PY, ns, "exec", "<magma-complete>");
    const all = R.toArray(ns._all) as string[];
    const classes = new Set(R.toArray(ns._cls) as string[]);
    const handbook = new Set(R.toArray(ns._hb) as string[]);
    // (a Magma name: a function, or a class whose Magma spelling, exactly, is a Handbook name, as RealField's is;
    // not the library's own classes, MagmaError, MSeq or RealField_, whose spelling keeps its "_")
    cached = all.map(magmaSpelling).filter((s, i) => !classes.has(all[i]) || handbook.has(s));
    exported = new Set(all);
    return cached;
  } catch {
    return [];
  }
}

/** Completions of the Magma identifier ending `line`: [matches, the text they replace]. */
export function magmaCompletions(main: any, line: string): [string[], string] {
  const m = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(line);
  if (!m) return [[], ""];
  const word = m[1];
  const lib = intrinsics();
  // (the session's variables: what its Magma code bound in __main__, without the runtime's own _ names and
  // the library's exports)
  const vars = Object.keys(main).filter((k) => k[0] !== "$" && k[0] !== "_" && !exported.has(k)).map(magmaSpelling);
  const names = [...lib, ...KEYWORDS, ...vars];
  const hits = [...new Set(names.filter((n) => n.startsWith(word) && (word.startsWith("_") || !n.startsWith("_"))))].sort();
  return [hits, word];
}
