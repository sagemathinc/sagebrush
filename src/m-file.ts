// Magma or MATLAB?  Both use the .m extension.  This module has no imports,
// so that the notebook (web/notebook/ipynb.js) can tell them apart without
// the MATLAB translator (src/matlab.ts re-exports it, for the CLI).

/**
 * Whether a .m file is Magma rather than MATLAB.  Both use the extension.
 * Magma assigns with `:=`, which is never MATLAB syntax, so a file with
 * `:=` outside comments and string literals (of either language) is Magma.
 * A MATLAB file that has `:=` only in a comment or a string is MATLAB.
 */
export function looksLikeMagma(src: string): boolean {
  const code = withoutBlockComments(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ") // Magma block comments
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // strings of both languages
    .replace(/(^|[^\w)\]}.'])'(?:[^'\n]|'')*'/g, "$1''") // MATLAB character vectors (not transposes)
    .replace(/(\/\/|%|#).*$/gm, ""); // line comments of both
  return /:=/.test(code);
}

/**
 * The text without MATLAB's block comments: from a line that is `%{` alone
 * (or Octave's `#{`) to its matching `%}`, nested as the translator's lexer
 * nests them; an unclosed one runs to the end.  Lines are kept (empty), so
 * line numbers stay.
 */
export function withoutBlockComments(src: string): string {
  let depth = 0;
  return src.split("\n").map((line) => {
    const t = line.trim();
    if (t === "%{" || t === "#{") { depth++; return ""; }
    if (depth > 0) {
      if (t === "%}" || t === "#}") depth--;
      return "";
    }
    return line;
  }).join("\n");
}

/** Whether MATLAB text ends inside a block comment (a console waits for more). */
export function inBlockComment(src: string): boolean {
  let depth = 0;
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (t === "%{" || t === "#{") depth++;
    else if (depth > 0 && (t === "%}" || t === "#}")) depth--;
  }
  return depth > 0;
}
