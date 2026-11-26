// Highlighting Magma, for the notebook's editor, the board and the code page
// (the classes of highlight.js: hc comment, hs string, hn number, hk keyword).
// A small scanner, no dependency.  Magma's comments are // to the end of the
// line and /* ... */; # is the cardinality operator (#G, #[1, 2]), never a
// comment, as it is in Python.
import { esc } from "./highlight.js";

export const MAGMA_KW = new Set(("and assert by case catch cat declare default delete diff do elif else end error eval exists exit " +
  "false for forall forward fprintf freeze function if import in intrinsic is join load local meet mod not notadj notin " +
  "notsubset or print printf procedure quit random read readi repeat require requirege requirerange restore return save " +
  "sdiff select subset then time to true try until vprint vprintf when where while xor").split(" "));

const TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;

export function highlightMagma(src) {
  let out = "", last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out += esc(src.slice(last, m.index));
    last = m.index + m[0].length;
    const cls = m[1] ? "hc" : m[2] ? "hs" : m[3] ? "hn" : m[4] && MAGMA_KW.has(m[4]) ? "hk" : "";
    out += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
  }
  return out + esc(src.slice(last)) + "\n"; // a final newline keeps the last line's height
}
