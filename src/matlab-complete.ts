// Tab completion at a MATLAB prompt or in a MATLAB cell (src/interactive.ts completeIn): the identifier before
// the caret, completed from the functions Sagebrush implements (lib/_matlab.py's table of built-ins, _B, read
// when asked: the lazily loaded ones included), MATLAB's keywords and the workspace's variables (and functions
// defined at the prompt or in a cell). Never Python's names: the language is MATLAB's. A name after a dot (a
// struct's field) isn't completed.
import { R } from "./compile";

const KEYWORDS = ["break", "case", "catch", "classdef", "continue", "else", "elseif", "end", "for", "function", "global", "if", "otherwise", "parfor", "persistent", "return", "spmd", "switch", "try", "while"];

// a MATLAB identifier: a letter, then letters, digits and underscores
const IDENT = /^[A-Za-z]\w*$/;

/** The built-ins' names (lib/_matlab.py _B), [] if the MATLAB library isn't loaded or can't be read. */
function builtins(): string[] {
  try {
    const B = R.getattr(R.importModule("_matlab"), "_B");
    return R.toArray(R.builtins.list(B)).filter((n: any) => typeof n === "string" && IDENT.test(n));
  } catch {
    return [];
  }
}

/** The workspace's names: main's, a Python keyword's mangled name (src/matlab.ts pyName, "_k_" + the name) as
 * MATLAB spells it; no private or runtime names (those start with "_" or "$"). */
function workspace(main: any): string[] {
  return Object.keys(main)
    .map((k) => (k.startsWith("_k_") ? k.slice(3) : k))
    .filter((k) => IDENT.test(k));
}

/** [matches, the identifier they replace] for `line`, the text before the caret. */
export function matlabCompletions(main: any, line: string): [string[], string] {
  const m = /[A-Za-z]\w*$/.exec(line);
  if (!m) return [[], ""];
  const word = m[0], before = line.slice(0, m.index);
  // (a field after "s.", or the middle of a longer token such as "3e" or "x_1": nothing to offer)
  if (/[.\w]$/.test(before)) return [[], word];
  // (inside a character vector or string: no names)
  if (inString(before)) return [[], word];
  const hits = new Set<string>();
  for (const n of [...workspace(main), ...builtins(), ...KEYWORDS]) if (n.startsWith(word)) hits.add(n);
  return [[...hits].sort(), word];
}

// Whether the end of `s` is inside a '...' or "..." literal: a quote opens one where a value can't end before it
// (after an identifier, a number, a closing bracket or a transpose, ' is the transpose); doubled quotes stay in.
function inString(s: string): boolean {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) {
        if (s[i + 1] === q) i++;
        else q = null;
      }
    } else if (c === '"' || (c === "'" && !/[\w)\]}.'"]/.test(s[i - 1] ?? " "))) q = c;
    else if (c === "%") return false;
  }
  return q !== null;
}
