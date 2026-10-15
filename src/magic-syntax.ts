// IPython's magic syntax in notebook cells and interactive input:
//   %name args       a line magic, any statement line (indented too)
//   %%name args      a cell magic, the cell's first line: the rest is its body
//   !command         a shell command (Sagebrush has no shell: an error)
// become calls of the builtins __pyjs_magic__(name, args) and
// __pyjs_cell_magic__(name, args, body) (lib/_pyjs_magic.py), as IPython
// turns them into get_ipython().run_line_magic(...).  Such lines are never
// valid Python.  A line inside a string, inside brackets or after a
// backslash continuation is left alone.  In Sage mode the code %time and
// %timeit run is Sage's (a third argument, True: lib/_pyjs_magic.py compiles
// it with Sage's syntax).  For the reactive notebook's analysis (src/dataflow.ts),
// `analysis` gives that code itself instead, so its names are seen.
const LINE_MAGIC = /^(\s*)%([A-Za-z_][\w.]*)(.*)$/;
const CELL_MAGIC = /^%%([A-Za-z_][\w.]*)(.*)$/;
const SHELL = /^(\s*)!(.*)$/;
// The session's Python around cells: %autoreload (lib/_pyjs_magic.py), before and after a Python cell, once its extension is loaded
export const MAGIC_PRE = "import sys as _s\n_a = _s.modules.get('_pyjs_magic')\nif _a is not None: _a.pre_run_cell()\n";
// (after FLUSH_FIGURES-like code that imported sys as _s)
export const MAGIC_POST = "_a = _s.modules.get('_pyjs_magic')\nif _a is not None: _a.post_run_cell()\n";
export const GET_IPYTHON = "import builtins as _b\ndef get_ipython():\n    from _pyjs_magic import get_ipython as _g\n    return _g()\n_b.get_ipython = get_ipython\ndel _b, get_ipython\n";

// magics whose argument is code to run
const CODE_MAGICS = new Set(["time", "timeit"]);

// Python string literals as JSON gives them, which Python reads the same
// (\uXXXX escapes, no \/)
const lit = (s: string) => JSON.stringify(s);

// For each line, whether it starts a statement: not in a string or brackets,
// not continuing the line before.
function statementStarts(lines: string[]): boolean[] {
  const starts: boolean[] = [];
  let triple: string | null = null;
  let depth = 0;
  let continued = false;
  for (const line of lines) {
    starts.push(triple === null && depth === 0 && !continued);
    continued = false;
    let i = 0;
    while (i < line.length) {
      if (triple !== null) {
        const j = line.indexOf(triple, i);
        if (j < 0) { i = line.length; break; }
        // (an escaped quote does not close it)
        let k = j - 1, bs = 0;
        while (k >= i && line[k] === "\\") { bs++; k--; }
        i = j + 3;
        if (bs % 2 === 0) triple = null;
        continue;
      }
      const c = line[i];
      if (c === "#") break;
      if (c === "'" || c === '"') {
        if (line.startsWith(c.repeat(3), i)) {
          triple = c.repeat(3);
          i += 3;
          continue;
        }
        // a one-line string: to its closing quote (or the line's end)
        i++;
        while (i < line.length && line[i] !== c) i += line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
      else if (c === "\\" && i === line.length - 1) continued = true;
      i++;
    }
  }
  return starts;
}

// %timeit's options (-n 10 -r 3 -q ...) before its statement
const TIMEIT_OPTIONS = /^(?:\s*-(?:[nrp]\s*\S+|[qo])(?=\s|$))*\s*/;

export function magicSyntax(src: string, opts: { sage?: boolean; analysis?: boolean } = {}): string {
  if (!src.includes("%") && !src.includes("!")) return src;
  const sage = opts.sage ? ", True" : "";
  const bare = (name: string, args: string) => (name === "timeit" ? args.replace(TIMEIT_OPTIONS, "") : args);
  const lines = src.split("\n");
  // a cell magic: the first non-blank line; the cell's other lines are its body
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first >= 0) {
    const m = CELL_MAGIC.exec(lines[first]);
    if (m) {
      const name = m[1], args = m[2].trim();
      if (opts.analysis && CODE_MAGICS.has(name)) {
        // (%%timeit's line is setup code, run first)
        const setup = bare(name, args);
        return lines.slice(0, first).join("\n") + (first ? "\n" : "") + (setup ? setup : "pass") + "\n" + lines.slice(first + 1).join("\n");
      }
      // (the body as code keeps its line numbers in the cell: blank lines before it)
      const body = (CODE_MAGICS.has(name) ? "\n".repeat(first + 1) : "") + lines.slice(first + 1).join("\n");
      return lines.slice(0, first).join("\n") + (first ? "\n" : "") +
        `__pyjs_cell_magic__(${lit(name)}, ${lit(args)}, ${lit(body)}${CODE_MAGICS.has(name) ? sage : ""})`;
    }
  }
  const starts = statementStarts(lines);
  return lines
    .map((line, i) => {
      if (!starts[i]) return line;
      let m = LINE_MAGIC.exec(line);
      if (m) {
        const name = m[2], args = m[3].trim();
        if (opts.analysis && CODE_MAGICS.has(name)) return `${m[1]}${bare(name, args) || "pass"}`;
        return `${m[1]}__pyjs_magic__(${lit(name)}, ${lit(args)}${CODE_MAGICS.has(name) ? sage : ""})`;
      }
      m = SHELL.exec(line);
      if (m && !m[2].startsWith("=")) return `${m[1]}__pyjs_magic__("system", ${lit(m[2].trim())})`;
      return line;
    })
    .join("\n");
}
