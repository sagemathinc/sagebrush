// Page-order scoping's renaming for MATLAB cells (design/reactive-notebook.md,
// "Page-order scoping for redefinitions"): src/rename.ts renameInCell's
// MATLAB branch.  A MATLAB notebook reuses names from cell to cell (`x =
// linspace(...)` in one example, again in the next), and fills an array an
// earlier cell made (`M(r, c) = iter`); each later definition gets its own
// name, xʹ2 (U+02B9, which the MATLAB lexer accepts only as such a suffix and
// the runtime shows as x), and a cell reads the nearest definition above it.
//
// Occurrences are found in the MATLAB lexer's tokens (src/matlab.ts lex):
// names, not field names (s.x), strings, comments or command-syntax words.  A
// function defined in the cell has its own workspace: its names are not the
// notebook's, and are kept.  Refused (null), so the notebook asks for a rename
// by hand as before: a name used as a command (`x on`), named by an anonymous
// function's parameter, or declared global or persistent; and a cell using
// eval, evalin, evalc, assignin, exist, clear, clearvars, save, load, who,
// whos, inputname or isvarname where a string or a command's word names it
// (they reach the workspace by name, which renaming the code does not change).
import { lex, matlabToPython } from "./matlab";

type Tok = ReturnType<typeof lex>[number];

const DYNAMIC = new Set(["eval", "evalin", "evalc", "assignin", "exist", "clear", "clearvars", "save", "load", "who", "whos", "inputname", "isvarname"]);
const OPENERS = new Set(["if", "for", "parfor", "while", "switch", "try"]);

interface Occ {
  tok: number; // its index in the tokens
  store: boolean;
  // a store that reads the previous value (`M(r, c) = v`, `s.a = v`, `c{2} = v`)
  // or may not run (in an if, a loop, a try; a for loop's or a catch's variable)
  partial: boolean;
  stmt: [number, number]; // the token indexes of its statement, first and last
}

const word = (name: string) => new RegExp(`(?<![A-Za-z0-9_\u02b9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_\u02b9])`);

/**
 * The occurrences of global `name` in a MATLAB cell's tokens, outside the
 * cell's functions; null if the cell is refused (see above).
 */
function occurrences(toks: Tok[], name: string): Occ[] | null {
  const named = word(name);
  if (toks.some((t) => t.t === "cmd" && (t.v === name || (DYNAMIC.has(t.v) && t.args?.some((a) => named.test(a)))))) return null;
  const dynamic = toks.some((t) => (t.t === "id" || t.t === "cmd") && DYNAMIC.has(t.v));
  if (dynamic && toks.some((t) => (t.t === "str" || t.t === "dqstr") && named.test(t.v))) return null;
  const out: Occ[] = [];
  const isOp = (t: Tok | undefined, v: string) => !!t && t.t === "op" && t.v === v;
  // (a statement's end: a newline, or a ; or , outside brackets; a newline in [ ] or { } separates rows, and the
  // lexer makes ( )'s newlines and a continuation's (...) space, the REACT review of 14073a7a)
  const stmtEnd = (from: number): number => {
    let depth = 0;
    for (let k = from; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === "eof" || (t.t === "nl" && depth <= 0)) return k - 1;
      if (t.t === "op") {
        if ("([{".includes(t.v)) depth++;
        else if (")]}".includes(t.v)) depth--;
        else if (depth <= 0 && (t.v === ";" || t.v === ",")) return k - 1;
      }
    }
    return toks.length - 1;
  };
  // (the matching close of the bracket at k)
  const close = (k: number): number => {
    let depth = 0;
    for (let j = k; j < toks.length; j++) {
      const t = toks[j];
      if (t.t !== "op") continue;
      if ("([{".includes(t.v)) depth++;
      else if (")]}".includes(t.v) && --depth === 0) return j;
    }
    return toks.length - 1;
  };
  // (an index's or a field's chain from k to an `=` of the statement, outside brackets: an indexed store)
  const indexedStore = (k: number, end: number): boolean => {
    let j = k;
    while (j <= end) {
      const t = toks[j];
      if (isOp(t, "(") || isOp(t, "{")) j = close(j) + 1;
      else if (isOp(t, ".") && toks[j + 1]?.t === "id") j += 2;
      else if (isOp(t, ".") && isOp(toks[j + 1], "(")) j = close(j + 1) + 1; // s.(f)
      else break;
    }
    return j > k && isOp(toks[j], "=");
  };
  const blocks: string[] = []; // the open blocks: their keywords
  let depth = 0; // brackets
  let atStmt = true;
  let fnBlock = -1; // the block index of the function being skipped, or -1
  let lhsEnd = -1; // in `[a, b] = ...`: the index of the `]`
  let stmt: [number, number] = [0, stmtEnd(0)];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k], prev = toks[k - 1];
    const startsStmt = atStmt;
    if (startsStmt) stmt = [k, stmtEnd(k)];
    atStmt = false;
    if (t.t === "nl") { if (depth <= 0) atStmt = true; continue; }
    if (t.t === "op") {
      if ("([{".includes(t.v)) depth++;
      else if (")]}".includes(t.v)) depth--;
      else if (depth === 0 && (t.v === ";" || t.v === ",")) atStmt = true;
      if (fnBlock < 0 && t.v === "[" && startsStmt) {
        const c = close(k);
        if (isOp(toks[c + 1], "=")) lhsEnd = c;
      }
      // (an anonymous function's parameters are its own)
      if (fnBlock < 0 && t.v === "@" && isOp(toks[k + 1], "(")) {
        const c = close(k + 1);
        if (toks.slice(k + 2, c).some((p) => p.t === "id" && p.v === name)) return null;
      }
      if (k === lhsEnd) lhsEnd = -1;
      continue;
    }
    if (t.t === "kw") {
      if (depth > 0) continue; // (end in an index)
      if (t.v === "function") {
        blocks.push("function");
        if (fnBlock < 0) fnBlock = blocks.length - 1;
      } else if (OPENERS.has(t.v)) blocks.push(t.v);
      else if (t.v === "end") {
        blocks.pop();
        if (fnBlock >= blocks.length) fnBlock = -1;
      }
      if (fnBlock < 0 && (t.v === "global" || t.v === "persistent")) {
        for (let j = k + 1; j < toks.length && toks[j].t !== "nl" && !isOp(toks[j], ";") && !isOp(toks[j], ","); j++) if (toks[j].t === "id" && toks[j].v === name) return null;
      }
      if (["else", "try", "otherwise", "end", "break", "continue", "return"].includes(t.v)) atStmt = true;
      continue;
    }
    if (t.t !== "id" || t.v !== name || fnBlock >= 0) continue;
    // (a field, s.x; a function handle, @x, names a function)
    if (isOp(prev, ".") || isOp(prev, "@")) continue;
    const inBlock = blocks.length > 0;
    const forVar = (prev?.t === "kw" && (prev.v === "for" || prev.v === "parfor")) || (isOp(prev, "(") && toks[k - 2]?.t === "kw" && (toks[k - 2].v === "for" || toks[k - 2].v === "parfor"));
    const catchVar = prev?.t === "kw" && prev.v === "catch";
    if (forVar || catchVar) { out.push({ tok: k, store: true, partial: true, stmt }); continue; }
    if (startsStmt && isOp(toks[k + 1], "=")) { out.push({ tok: k, store: true, partial: inBlock, stmt }); continue; }
    if (startsStmt && indexedStore(k + 1, stmt[1])) { out.push({ tok: k, store: true, partial: true, stmt }); continue; }
    // ([a, x] = ... and [a, x(2)] = ...: one of the outputs, at the bracket's own level)
    if (lhsEnd > k && depth === 1 && (isOp(prev, "[") || isOp(prev, ",") || prev?.t === "id" || isOp(prev, ")") || isOp(prev, "}") || isOp(prev, "~"))) {
      const indexed = isOp(toks[k + 1], "(") || isOp(toks[k + 1], "{") || isOp(toks[k + 1], ".");
      out.push({ tok: k, store: true, partial: indexed || inBlock, stmt });
      continue;
    }
    out.push({ tok: k, store: false, partial: false, stmt });
  }
  return out;
}

/**
 * renameInCell for MATLAB: `from` "all" renames every occurrence of `name`
 * (a cell reading the renamed definition); "definition" (a cell redefining
 * it) keeps the occurrences before the statement that first stores it, and
 * the reads in that statement (`x = x + 1` -> `xʹ2 = x + 1`), as the previous
 * name, `before` if given.  A first store that reads the previous value or
 * may not run instead starts the new name from the previous value, on the
 * cell's first line, and renames every occurrence: `if exist('M', 'var'),
 * Mʹ2 = M; end; ` (the previous name unbound leaves the new one unbound, as
 * MATLAB's M would be).
 */
export function renameMatlabCell(source: string, name: string, to: string, opts: { from?: "all" | "definition"; before?: string } = {}): string | null {
  let toks: Tok[];
  try {
    toks = lex(source);
  } catch {
    return null;
  }
  const occ = occurrences(toks, name);
  if (occ === null) return null;
  const old = opts.before ?? name;
  const target = new Map<Occ, string>();
  let prefix = "";
  if (opts.from === "definition") {
    const first = occ.find((o) => o.store);
    // (the analysis says the cell defines it: a store this cannot find is refused)
    if (!first) return null;
    if (first.partial) {
      // (a block comment must start its line: nothing can go before it)
      if (/^[ \t]*[%#]\{[ \t]*\r?$/.test(source.split("\n")[0])) return null;
      prefix = `if exist('${old}', 'var'), ${to} = ${old}; end; `;
      for (const o of occ) target.set(o, to);
    } else {
      for (const o of occ) {
        const before = o.tok < first.stmt[0] || (o.tok <= first.stmt[1] && !o.store);
        target.set(o, before ? old : to);
      }
    }
  } else for (const o of occ) target.set(o, to);
  const lines = source.split("\n");
  const reps = occ.filter((o) => target.get(o) !== name).map((o) => ({ line: toks[o.tok].line, col: toks[o.tok].col - 1, len: name.length, text: target.get(o)! }));
  reps.sort((a, b) => b.line - a.line || b.col - a.col);
  for (const r of reps) {
    const l = lines[r.line - 1];
    if (l === undefined || l.slice(r.col, r.col + r.len) !== name) return null;
    lines[r.line - 1] = l.slice(0, r.col) + r.text + l.slice(r.col + r.len);
  }
  if (prefix) lines[0] = prefix + lines[0];
  const result = lines.join("\n");
  // (and still MATLAB the translator takes: a rewrite that is not is refused, never returned broken)
  try {
    matlabToPython(result, "<cell>", { cell: true });
  } catch {
    return null;
  }
  return result;
}
