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
  const code = src
    .replace(/^[ \t]*%\{[ \t]*$[\s\S]*?^[ \t]*%\}[ \t]*$/gm, " ") // MATLAB block comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // Magma block comments
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""') // strings of both languages
    .replace(/(^|[^\w)\]}.'])'(?:[^'\n]|'')*'/g, "$1''") // MATLAB character vectors (not transposes)
    .replace(/(\/\/|%|#).*$/gm, ""); // line comments of both
  return /:=/.test(code);
}
