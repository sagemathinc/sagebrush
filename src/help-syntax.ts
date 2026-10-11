// IPython's help syntax in interactive input: a line `obj?` (or `?obj`)
// shows obj's signature and docstring, `obj??` also its source
// (lib/_pyjs_help.py).  Such a line is never valid Python; lines inside a
// triple-quoted string are left alone.
const HELP_LINE = /^(\s*)(\?{1,2})?([A-Za-z_][\w.]*(?:\[[^\]\n]*\])?(?:\(\))?)(\?{1,2})?\s*$/;
export function helpSyntax(src: string): string {
  if (!src.includes("?")) return src;
  let inString: string | null = null;
  return src
    .split("\n")
    .map((line) => {
      const before = inString;
      for (const m of line.matchAll(/'''|"""/g)) {
        if (inString === null) inString = m[0];
        else if (inString === m[0]) inString = null;
      }
      if (before !== null) return line;
      const m = HELP_LINE.exec(line);
      if (!m || !!m[2] === !!m[4]) return line;
      const level = (m[2] ?? m[4]).length;
      return `${m[1]}__pyjs_help__(${m[3]}, ${level}, ${JSON.stringify(m[3])})`;
    })
    .join("\n");
}
