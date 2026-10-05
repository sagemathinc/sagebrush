// What an interactive prompt needs, shared by the CLI and the browser
// console: whether input is complete, and tab completion.
import { R } from "./compile";
import { parse, PySyntaxError } from "./parse";

// Is `src` an incomplete statement (more lines needed)?  The codeop rule:
// a syntax error that goes away or moves when more text could follow.
export function needsMore(src: string, opts: { sage?: boolean } = {}): boolean {
  const lines = src.split("\n");
  const last = lines[lines.length - 1];
  // A compound statement (or decorated definition) ends with a blank line.
  if (/:\s*(#.*)?$/.test(lines[0]) || /^\s*@/.test(lines[0])) return last.trim() !== "";
  if (/\\$/.test(last)) return true;
  try {
    parse(src + "\n", "<stdin>", "exec", opts);
    return false;
  } catch (e: any) {
    return e instanceof PySyntaxError && /was never closed|unexpected EOF|unterminated triple-quoted|expected an indented block|incomplete input/.test(e.msg);
  }
}

// Completions of the identifier (or dotted name, or module after import)
// ending `line`: [matches, the text they replace].
export function complete(main: any, line: string, moduleNames: () => string[]): [string[], string] {
  const im = /^\s*(?:import|from)\s+([\w.]*)$/.exec(line);
  if (im) {
    const hits = moduleNames().filter((n) => n.startsWith(im[1]) && !n.startsWith("_")).sort();
    return [hits, im[1]];
  }
  const m = /([A-Za-z_][\w.]*)$/.exec(line);
  if (!m) return [[], line];
  const word = m[1];
  const dot = word.lastIndexOf(".");
  let names: string[] = [];
  try {
    if (dot < 0) {
      names = [...Object.keys(main).filter((k) => k[0] !== "$"), ...Object.keys(R.builtins), "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"];
    } else {
      const objExpr = word.slice(0, dot);
      if (!/^[A-Za-z_][\w.]*$/.test(objExpr)) return [[], line];
      const obj = R.loader.exec(objExpr, main, "eval", "<completion>");
      names = R.toArray(R.builtins.dir(obj)).map((n: string) => objExpr + "." + n);
    }
  } catch {
    return [[], line];
  }
  const hits = [...new Set(names.filter((n) => n.startsWith(word) && !(n.slice(word.length).startsWith("_") && !word.endsWith("_") && n.lastIndexOf("._") > dot - 1 && !word.slice(dot + 1).startsWith("_"))))].sort();
  return [hits, word];
}
