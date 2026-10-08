// Sage's preparser (sage/repl/preparse.py), for what Python's grammar cannot
// express; `^`, `^^` and exact division are handled by the grammar and the
// runtime instead.  It rewrites source text, line by line where possible so
// that line numbers stay (column offsets may shift), and never inside string
// literals or comments:
//
//   [a..b], [a,b..c], (a..b)   ellipsis_range(a,Ellipsis,b), ellipsis_iter(...)
//   100r, 1.5r                 raw Python literals: 100, 1.5
//   1.5, 2e3                   RealNumber('1.5'), RealNumber('2e3')
//   12.factor()                (12).factor()
//   R.0                        R.gen(0)
//   R.<x,y> = ...              R = ...; (x, y,) = R._first_ngens(2)
//   f(x, y) = expr             __tmp__=var("x,y"); f = symbolic_expression(expr).function(x,y)

/** Replace string literals and comments by placeholders \0N\0; returns the
 *  code and the literals (restored by `restore`). */
export function stripLiterals(code: string): [string, string[]] {
  const lits: string[] = [];
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === "#") {
      const j = code.indexOf("\n", i);
      const e = j < 0 ? n : j;
      lits.push(code.slice(i, e));
      out += `\0${lits.length - 1}\0`;
      i = e;
      continue;
    }
    if (c === "'" || c === '"') {
      // a string prefix (r, b, f, u, rb, ...) stays in the code
      const triple = code.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let raw = false;
      for (let k = out.length - 1; k >= 0 && /[rRbBuUfF]/.test(out[k]); k--) if (/[rR]/.test(out[k])) raw = true;
      let j = i + q.length;
      while (j < n) {
        if (!raw && code[j] === "\\") { j += 2; continue; }
        if (raw && code[j] === "\\") { j += 2; continue; } // r"\"" is still a quote inside
        if (code.startsWith(q, j)) { j += q.length; break; }
        if (!triple && code[j] === "\n") break; // unterminated: leave it to the parser
        j++;
      }
      lits.push(code.slice(i, j));
      out += `\0${lits.length - 1}\0`;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return [out, lits];
}

export const restore = (code: string, lits: string[]) => code.replace(/\0(\d+)\0/g, (_, k) => lits[+k]);

/** An f-string's replacement fields, preparsed (not their format specs). */
function preparseFString(lit: string, f: (code: string) => string): string {
  let out = "", i = 0;
  while (i < lit.length) {
    const c = lit[i];
    if ((c === "{" || c === "}") && lit[i + 1] === c) {
      out += c + c;
      i += 2;
      continue;
    }
    if (c !== "{") {
      out += c;
      i++;
      continue;
    }
    // the expression runs to a top-level !, : or }
    let depth = 0, j = i + 1;
    for (; j < lit.length; j++) {
      const d = lit[j];
      if ("([{".includes(d)) depth++;
      else if (")]".includes(d)) depth--;
      else if (d === "}" && depth === 0) break;
      else if (d === "}") depth--;
      else if ((d === ":" || d === "!") && depth === 0 && lit[j + 1] !== "=") break;
    }
    out += "{" + f(lit.slice(i + 1, j));
    i = j;
  }
  return out;
}

const OPEN = "([{", CLOSE = ")]}";

/** The innermost ( or [ around index i, and its matching close (exclusive). */
function containingBlock(code: string, i: number): [number, number] | null {
  let depth = 0, s = i;
  for (; s >= 0; s--) {
    const ch = code[s];
    if (CLOSE.includes(ch)) depth++;
    else if (OPEN.includes(ch)) {
      if (depth === 0) break;
      depth--;
    }
  }
  if (s < 0 || code[s] === "{") return null;
  depth = 0;
  let e = i;
  for (; e < code.length; e++) {
    const ch = code[e];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) {
      if (depth === 0) break;
      depth--;
    }
  }
  if (e >= code.length) return null;
  return [s, e + 1];
}

/** [a..b] -> (ellipsis_range(a,Ellipsis,b)), (a..b) -> (ellipsis_iter(...)). */
export function parseEllipsis(code: string): string {
  let ix = code.indexOf("..");
  while (ix !== -1) {
    if (code[ix + 2] === "." || code[ix - 1] === ".") {
      // `...` is Python's Ellipsis
      ix = code.indexOf("..", ix + 3);
      continue;
    }
    const b = containingBlock(code, ix);
    if (!b) {
      ix = code.indexOf("..", ix + 2);
      continue;
    }
    const [s, e] = b;
    let args = code.slice(s + 1, e - 1).replace(/\.\./g, ",Ellipsis,").replace(/,\s*,/g, ",").replace(/,\s*$/, "");
    args = args.replace(/;\s*/, ", step=");
    // a trailing step=... keeps working: [1..3, step=0.5]
    const kind = code[s] === "[" ? "range" : "iter";
    code = `${code.slice(0, s)}(ellipsis_${kind}(${args}))${code.slice(e)}`;
    ix = code.indexOf("..");
  }
  return code;
}

// A number not preceded by an identifier character or a dot.
const NUM = /(?<![\w.\0])((?:\d[\d_]*\.(?:\d[\d_]*)?|\.\d[\d_]*|\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)([rRjJ]?)(?![\w])/g;

/** Numeric literals: raw suffixes, reals as RealNumber, 12.factor(). */
export function preparseNumbers(code: string): string {
  // 12.factor() -> (12).factor(), but not 1.e5 or 1.5
  code = code.replace(/(?<![\w.\0])(\d[\d_]*)\.(?=[A-Za-z_])(?![eE][+-]?\d)/g, "($1).");
  return code.replace(NUM, (all, num: string, suffix: string) => {
    if (suffix === "r" || suffix === "R") return num; // a raw Python literal
    if (suffix) return all; // complex: Python's
    if (/^0[xXoObB]/.test(num)) return all;
    if (/[.eE]/.test(num)) return `RealNumber('${num.replace(/_/g, "")}')`;
    return num;
  });
}

const GENS = /^(\s*)([A-Za-z_]\w*)\.<\s*([A-Za-z_][\w\s,]*)>\s*=\s*(.+?)\s*$/;
function generators(line: string): string {
  const m = GENS.exec(line);
  if (!m) return line;
  const [, indent, name, gens, all] = m;
  const names = gens.split(",").map((g) => g.trim()).filter(Boolean);
  const tuple = `(${names.map((n) => `'${n}'`).join(", ")},)`;
  const cut = topLevelSemicolon(all);
  // (and the following statements: R.<x> = QQ[]; S.<y> = QQ[])
  const rest = cut < 0 ? "" : "; " + generators(all.slice(cut + 1).trimStart());
  let rhs = (cut < 0 ? all : all.slice(0, cut)).trimEnd();
  if (rhs.endsWith("[[]]")) rhs = rhs.slice(0, -4) + `[[${names.map((n) => `'${n}'`).join(", ")}]]`;
  else if (rhs.endsWith("[]")) rhs = rhs.slice(0, -2) + `[${tuple}]`;
  else if (rhs.endsWith("()")) rhs = rhs.slice(0, -1) + `names=${tuple})`;
  else if (rhs.endsWith(")")) rhs = rhs.slice(0, -1) + `, names=${tuple})`;
  return `${indent}${name} = ${rhs}; (${names.join(", ")},) = ${name}._first_ngens(${names.length})${rest}`;
}

/** The index of the first ';' outside brackets and strings, or -1. */
function topLevelSemicolon(s: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return i;
    else if (c === "#") return -1;
  }
  return -1;
}

// f(x,y) = expr at the start of a statement (Sage's preparse_calculus).
const CALC = /^(\s*)([A-Za-z_]\w*)\s*\(([^()=]+)\)\s*=(?!=)\s*(.+)$/;
function calculus(line: string): string {
  const m = CALC.exec(line);
  if (!m) return line;
  const [, indent, f, args, rhs] = m;
  const vars = args.split(",").map((v) => v.trim());
  if (!vars.every((v) => /^[A-Za-z_]\w*$/.test(v))) return line;
  // f(x) = x^2; f: the definition ends at a top-level ';'
  const semi = topLevelSemicolon(rhs);
  const expr = semi < 0 ? rhs : rhs.slice(0, semi);
  const rest = semi < 0 ? "" : rhs.slice(semi);
  return `${indent}__tmp__=var("${vars.join(",")}"); ${f} = symbolic_expression(${expr.trim()}).function(${vars.join(",")})${rest}`;
}

function expression(code: string): string {
  let L = parseEllipsis(code);
  // R.0 -> R.gen(0), QQ['x'].0, C.0.ideal(); before the numbers, which
  // would read .0 as a float
  L = L.replace(/(\b[A-Za-z_]\w*|[)\]])\.(\d+)\b(?![ \t]*[(\w])/g, "$1.gen($2)");
  return preparseNumbers(L);
}

/** The whole preparser, on a module's source. */
export function preparse(source: string): string {
  // (nothing to do without digits, .., R.<x> or f(x) = ...)
  if (!/\.\.|\d|\.<|\)\s*=(?!=)/.test(source)) return source;
  const [code, lits] = stripLiterals(source);
  let L = expression(code);
  L = L.split("\n").map((line) => calculus(generators(line))).join("\n");
  // f-strings: their fields are code (prefix letters stay before the placeholder)
  return L.replace(/([rRbBuUfF]*)\0(\d+)\0/g, (_, prefix: string, k: string) =>
    prefix + (/[fF]/.test(prefix) ? preparseFString(lits[+k], (c) => expression(stripLiterals(c)[0]) === c ? c : restore(expression(stripLiterals(c)[0]), stripLiterals(c)[1])) : lits[+k]));
}
