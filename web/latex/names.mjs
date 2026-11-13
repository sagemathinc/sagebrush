// What code names (the LaTeX editor's Run, run-core.mjs folderFiles, and a document's Share, share-client/tex-uses.ts):
// the modules it imports, by their first name, at a statement's start (a line's, or after ";" or a one-line suite's
// ":"; a match that isn't one only gives a named file there), and its quoted strings, each maybe a path.
export const namesIn = (code) => [...code.matchAll(/(?:^|[;:])[ \t]*(?:from[ \t]+(\w+)|import[ \t]+([\w., \t]+))|(["'])((?:(?!\3)[^\\\n])+)\3/gm)].flatMap((m) => m[4] ? [m[4].replace(/^\.\//, "")] : (m[1] ?? m[2]).split(",").map((x) => x.trim().split(/[ .]/)[0]));
