// MATLAB -> Python.  A lexer and parser for the MATLAB language, building a
// syntax tree, and an emitter producing Python that runs on lib/_matlab.py
// (MATLAB's values, operators, printing and built-in functions, over
// Sagebrush's numpy).  The Python is compiled by the usual pipeline, so MATLAB
// programs run wherever pyjs does: the CLI (--matlab), the notebook, browsers.
//
// The emitted code never contains text from the program except as Python
// string literals (JSON) and identifiers checked to be MATLAB names, so it is
// only Python: it reaches JavaScript no more than any Python does.
//
// Every operator is a call into the runtime (`a + b` is `_m.plus(a, b)`),
// because MATLAB's operators are defined on its own values (matrices, char
// arrays, cells), not Python's.  What is static is name resolution: in a
// function, a name assigned before (in the text, or anywhere in an enclosing
// loop) is a variable, any other name a function; at the top level (a
// script, a notebook cell), a name not assigned yet may still be a variable
// of the workspace, so it is looked up when it runs.  See design/matlab.md.

import { inBlockComment } from "./m-file";

export class MatlabSyntaxError extends Error {
  /** atEnd: the input ended where more was needed (an open block, bracket or continuation) */
  constructor(msg: string, public line: number, public col: number, public atEnd = false) {
    super(msg);
  }
}

// ------------------------------------------------------------------ lexer

type TokT = "num" | "str" | "dqstr" | "id" | "kw" | "op" | "nl" | "cmd" | "eof";
interface Tok {
  t: TokT;
  v: string;
  line: number;
  col: number;
  sp: boolean; // whitespace (or a continuation) right before it
  args?: string[]; // a command's words (format long)
  cont?: boolean; // (the end of input) the input ended in a continuation, `...`
}

const KEYWORDS = new Set(
  ("if elseif else end for parfor while switch case otherwise try catch break continue return function " +
    "global persistent endif endfor endwhile endfunction endswitch end_try_catch endparfor").split(" "),
);
const OCTAVE_ENDS = new Set(["endif", "endfor", "endwhile", "endfunction", "endswitch", "end_try_catch", "endparfor"]);

// longest first
const OPS = ["==", "~=", "!=", "<=", ">=", "&&", "||", ".*", "./", ".\\", ".^", ".'", "+", "-", "*", "/", "\\", "^", "<", ">",
  "&", "|", "~", "!", "=", "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "@"];

// Commands written without parentheses whose first argument starts with '-'
// (save f -ascii); for any other name `x -1` is an expression.
const DASH_COMMANDS = new Set(["save", "load", "format", "warning", "pkg", "close", "clear", "clearvars", "hold", "print", "graphics_toolkit"]);

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  const n = src.length;
  let i = 0, line = 1, lineStart = 0;
  let sp = false;
  const stack: string[] = []; // open brackets
  let stmtStart = true;
  let argBlock = false; // inside an arguments block (no command syntax: `a double`)
  let cont = false; // a continuation since the last token
  const col = () => i - lineStart + 1;
  const push = (t: TokT, v: string, L: number, C: number, extra: Partial<Tok> = {}) => {
    out.push({ t, v, line: L, col: C, sp, ...extra });
    sp = false;
    stmtStart = false;
    cont = false;
  };
  const prevValue = () => {
    const p = out[out.length - 1];
    if (!p) return false;
    if (p.t === "num" || p.t === "str" || p.t === "dqstr" || p.t === "id") return true;
    if (p.t === "kw") return p.v === "end";
    if (p.t === "op") return p.v === ")" || p.v === "]" || p.v === "}" || p.v === "'" || p.v === ".'";
    return false;
  };
  const top = () => stack[stack.length - 1];
  const inMatrix = () => top() === "[" || top() === "{";
  const lineOnly = (s: string, at: number) => {
    // `%{` or `%}` alone on its line (block comments)
    let a = at;
    while (a > 0 && (src[a - 1] === " " || src[a - 1] === "\t")) a--;
    if (a > 0 && src[a - 1] !== "\n") return false;
    let b = at + s.length;
    while (b < n && (src[b] === " " || src[b] === "\t" || src[b] === "\r")) b++;
    return b >= n || src[b] === "\n";
  };
  const newline = () => {
    i++;
    line++;
    lineStart = i;
  };
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\f") { i++; sp = true; continue; }
    if (c === "." && src.startsWith("...", i)) {
      // continuation: the rest of the line is a comment, the newline is space
      while (i < n && src[i] !== "\n") i++;
      if (i < n) newline();
      sp = true;
      cont = true;
      continue;
    }
    if ((c === "%" || c === "#") && (src[i + 1] === "{") && lineOnly(c + "{", i)) {
      // block comment, nested
      let depth = 0;
      while (i < n) {
        const e = src.indexOf("\n", i);
        const ln = src.slice(i, e < 0 ? n : e).trim();
        if (ln === "%{" || ln === "#{") depth++;
        else if (ln === "%}" || ln === "#}") depth--;
        i = e < 0 ? n : e;
        if (depth === 0) break;
        if (i < n) newline();
      }
      continue;
    }
    if (c === "%" || c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    const L = line, C = col();
    if (c === "\n") {
      if (top() === "(") { newline(); sp = true; continue; }
      const p = out[out.length - 1];
      if (!(p && p.t === "nl")) push("nl", "\n", L, C);
      newline();
      if (!stack.length) stmtStart = true;
      sp = true;
      continue;
    }
    if (c === "'") {
      const transpose = prevValue() && (!sp || !inMatrix());
      if (transpose) { push("op", "'", L, C); i++; continue; }
      let j = i + 1, s = "";
      while (true) {
        if (j >= n || src[j] === "\n") throw new MatlabSyntaxError("unterminated character vector", L, C);
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      i = j + 1;
      push("str", s, L, C);
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = "";
      while (true) {
        if (j >= n || src[j] === "\n") throw new MatlabSyntaxError("unterminated string", L, C);
        if (src[j] === '"') {
          if (src[j + 1] === '"') { s += '"'; j += 2; continue; }
          break;
        }
        s += src[j++];
      }
      i = j + 1;
      push("dqstr", s, L, C);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      // 0x87, 0b1011, with a type suffix (0x87u32, 0b1s8): integers (R2019b)
      const radix = c === "0" ? ({ x: 16, X: 16, b: 2, B: 2 } as Record<string, number>)[src[i + 1]] : undefined;
      if (radix && (radix === 16 ? /[0-9a-fA-F]/ : /[01]/).test(src[i + 2] ?? "")) {
        j = i + 2;
        while (j < n && (radix === 16 ? /[0-9a-fA-F]/ : /[01]/).test(src[j])) j++;
        const digits = src.slice(i + 2, j);
        const m = /^(u8|u16|u32|u64|s8|s16|s32|s64)(?![A-Za-z0-9_])/.exec(src.slice(j));
        const suffix = m ? m[1] : "";
        if (m) j += suffix.length;
        push("num", `int:${radix}:${digits}:${suffix}`, L, C);
        i = j;
        continue;
      }
      while (j < n && /[0-9]/.test(src[j])) j++;
      // 1.5, 1. (but 1.* 1./ 1.^ 1.' 1... are the number 1 and an operator)
      if (src[j] === "." && !/[*/\\^'.]/.test(src[j + 1] ?? "")) {
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if (/[eEdD]/.test(src[j] ?? "") && (/[0-9]/.test(src[j + 1] ?? "") || (/[+-]/.test(src[j + 1] ?? "") && /[0-9]/.test(src[j + 2] ?? "")))) {
        j += 2;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      let v = src.slice(i, j).replace(/[dD]/, "e");
      if (/[ij]/.test(src[j] ?? "") && !/[A-Za-z0-9_]/.test(src[j + 1] ?? "")) {
        v += "i";
        j++;
      }
      push("num", v, L, C);
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      if (KEYWORDS.has(w)) {
        if (w === "end" && argBlock && stmtStart) argBlock = false;
        push("kw", OCTAVE_ENDS.has(w) ? "end" : w, L, C);
        i = j;
        continue;
      }
      if (w === "arguments" && stmtStart && /^[ \t]*(\(|\r?\n|%|$)/.test(src.slice(j, j + 200))) {
        argBlock = true;
        push("id", w, L, C);
        i = j;
        continue;
      }
      // command syntax: `format long`, `hold on`, `disp hello`, `save f -ascii`
      if (stmtStart && !argBlock && !stack.length && (src[j] === " " || src[j] === "\t")) {
        let k = j;
        while (src[k] === " " || src[k] === "\t") k++;
        const d = src[k] ?? "";
        // (`x abc`, `x 1` and `x 'abc'` cannot be expressions)
        const isCmd = /[A-Za-z0-9']/.test(d) || (d === "-" && /[A-Za-z]/.test(src[k + 1] ?? "") && DASH_COMMANDS.has(w));
        if (isCmd) {
          const args: string[] = [];
          let a = k;
          let depth = 0; // (unquoted brackets open in the words)
          while (a < n && src[a] !== "\n" && src[a] !== ";" && src[a] !== "," && src[a] !== "%") {
            if (src[a] === " " || src[a] === "\t" || src[a] === "\r") { a++; continue; }
            let word = "";
            while (a < n && !/[\s;,%]/.test(src[a])) {
              if ("([{".includes(src[a])) depth++;
              else if (")]}".includes(src[a]) && depth > 0) depth--;
              if (src[a] === "'") {
                a++;
                while (a < n && src[a] !== "\n") {
                  if (src[a] === "'") {
                    if (src[a + 1] === "'") { word += "'"; a += 2; continue; }
                    break;
                  }
                  word += src[a++];
                }
                a++;
              } else word += src[a++];
            }
            args.push(word);
          }
          // (a comma or semicolon inside a word's brackets, `clear -regexp a{0,31}`: whether it
          // ends the command is not settled here, so refused rather than split)
          if (depth > 0 && (src[a] === "," || src[a] === ";"))
            throw new MatlabSyntaxError(`a '${src[a]}' inside brackets in command syntax (${w} ...) is not supported; use function syntax, e.g. ${w}('...')`, L, C);
          push("cmd", w, L, C, { args });
          i = a;
          continue;
        }
      }
      push("id", w, L, C);
      i = j;
      continue;
    }
    let op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new MatlabSyntaxError(`invalid character '${c}'`, L, C);
    if (op === "!=") op = "~=";
    else if (op === "!") op = "~";
    if (op === "(" || op === "[" || op === "{") stack.push(op);
    else if (op === ")" || op === "]" || op === "}") stack.pop();
    const startOfStmt = (op === ";" || op === ",") && !stack.length;
    push("op", op, L, C);
    if (startOfStmt) stmtStart = true;
    i += op === "~=" && src[i] === "!" ? 2 : op === "~" && src[i] === "!" ? 1 : op.length;
  }
  out.push({ t: "eof", v: "", line, col: col(), sp, ...(cont ? { cont: true } : {}) });
  return out;
}

// ------------------------------------------------------------------ syntax tree

interface Frame { code: string; n: number; cur: number } // what `end` in an index refers to (cur: the argument being parsed)

type Expr =
  | { k: "num"; v: string }
  | { k: "str"; v: string; dq: boolean }
  | { k: "id"; name: string; line: number; col: number }
  | { k: "end"; frame: Frame; pos: number }
  | { k: "colon" } // a bare `:` index
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "un"; op: string; e: Expr }
  | { k: "post"; op: string; e: Expr } // ' and .'
  | { k: "range"; a: Expr; step: Expr | null; b: Expr }
  | { k: "index"; e: Expr; brace: boolean; args: Expr[]; frame: Frame }
  | { k: "field"; e: Expr; name: string }
  | { k: "dynfield"; e: Expr; name: Expr }
  | { k: "matrix"; rows: Expr[][]; cell: boolean }
  | { k: "anon"; params: string[]; body: Expr }
  | { k: "handle"; name: string };

interface LValue { name: string; path: Expr[]; line: number; col: number } // path: index/field nodes, outermost last; e chains through them
type Stmt = { line: number; col: number } & (
  | { k: "expr"; e: Expr; print: boolean }
  | { k: "assign"; lhs: (LValue | null)[]; rhs: Expr; print: boolean; multi: boolean }
  | { k: "if"; clauses: [Expr, Stmt[]][]; els: Stmt[] | null }
  | { k: "for"; v: string; e: Expr; body: Stmt[] }
  | { k: "while"; cond: Expr; body: Stmt[] }
  | { k: "switch"; e: Expr; cases: [Expr, Stmt[]][]; otherwise: Stmt[] | null }
  | { k: "try"; body: Stmt[]; id: string | null; handler: Stmt[] }
  | { k: "break" } | { k: "continue" } | { k: "return" }
  | { k: "global"; names: string[] }
  | { k: "persistent"; names: string[] }
  | { k: "cmd"; name: string; args: string[]; print: boolean }
);

interface FuncDef { name: string; params: string[]; outs: string[]; body: Stmt[]; line: number; args: ArgEntry[] }

/** an entry of an `arguments` block: x (1,:) double {mustBeNumeric} = 0, or opts.Name ... */
interface ArgEntry { name: string; field: string | null; dims: (number | null)[] | null; cls: string | null; validators: Expr[]; dflt: Expr | null; line: number }

// ------------------------------------------------------------------ parser

class Parser {
  private i = 0;
  private mat: boolean[] = []; // innermost bracket: true for [ ] and { } (whitespace separates elements)
  private frames: Frame[] = []; // enclosing indexes (`end`)
  functions: FuncDef[] = [];

  constructor(private toks: Tok[]) {}

  peek(k = 0) { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  at(v: string, k = 0) { const t = this.peek(k); return (t.t === "op" || t.t === "kw") && t.v === v; }
  next() { return this.toks[this.i++]; }
  eat(v: string) { if (this.at(v)) { this.i++; return true; } return false; }
  expect(v: string) {
    if (!this.at(v)) { const t = this.peek(); this.fail(`expected '${v}' but found ${desc(t)}`); }
    return this.next();
  }
  fail(msg: string, t = this.peek()): never { throw new MatlabSyntaxError(msg, t.line, t.col, t.t === "eof"); }
  ident() {
    const t = this.next();
    if (t.t !== "id") this.fail(`expected a name but found ${desc(t)}`, t);
    return t.v;
  }
  inMatrix() { return this.mat.length > 0 && this.mat[this.mat.length - 1]; }
  sep() { return this.at(",") || this.at(";") || this.peek().t === "nl"; }
  skipSeps() { while (this.sep()) this.next(); }

  // -------- statements
  program(): Stmt[] {
    const stmts: Stmt[] = [];
    while (true) {
      this.skipSeps();
      const t = this.peek();
      if (t.t === "eof") return stmts;
      if (this.at("function")) { this.functions.push(this.funcDef()); continue; }
      stmts.push(...this.statementAndSep());
    }
  }

  /** statements until one of `ends` (keywords), not consuming it */
  block(ends: string[]): Stmt[] {
    const out: Stmt[] = [];
    while (true) {
      this.skipSeps();
      const t = this.peek();
      if (t.t === "eof") this.fail(`expected '${ends.includes("end") ? "end" : ends[0]}' but found end of input`);
      if (t.t === "kw" && ends.includes(t.v)) return out;
      if (this.at("function")) this.fail("a function cannot be defined here");
      out.push(...this.statementAndSep());
    }
  }

  statementAndSep(): Stmt[] {
    const s = this.statement();
    // the separator: ';' suppresses printing
    if (this.at(";")) {
      this.next();
      if ("print" in s) (s as any).print = false;
    } else if (this.at(",") || this.peek().t === "nl") this.next();
    else if (this.peek().t !== "eof" && !this.endsBlock()) this.fail(`unexpected ${desc(this.peek())}`);
    return [s];
  }

  endsBlock() {
    const t = this.peek();
    return t.t === "kw" && ["end", "else", "elseif", "case", "otherwise", "catch", "function"].includes(t.v);
  }

  statement(): Stmt {
    const t = this.peek();
    const pos = { line: t.line, col: t.col };
    if (t.t === "cmd") { this.next(); return { ...pos, k: "cmd", name: t.v, args: t.args!, print: true }; }
    if (t.t === "kw") {
      switch (t.v) {
        case "if": return { ...pos, ...this.ifStmt() };
        case "for": case "parfor": return { ...pos, ...this.forStmt() };
        case "while": {
          this.next();
          const cond = this.expr();
          const body = this.block(["end"]);
          this.expect("end");
          return { ...pos, k: "while", cond, body };
        }
        case "switch": return { ...pos, ...this.switchStmt() };
        case "try": {
          this.next();
          if (this.at(",")) this.next();
          const body = this.block(["catch", "end"]);
          let id: string | null = null, handler: Stmt[] = [];
          if (this.eat("catch")) {
            // `catch err` names the exception (on the catch line)
            const c = this.peek();
            if (c.t === "id" && c.line === this.toks[this.i - 1].line) {
              const after = this.peek(1);
              if (after.t === "nl" || after.t === "eof" || (after.t === "op" && (after.v === ";" || after.v === ","))) { id = c.v; this.next(); }
            }
            handler = this.block(["end"]);
          }
          this.expect("end");
          return { ...pos, k: "try", body, id, handler };
        }
        case "break": this.next(); return { ...pos, k: "break" };
        case "continue": this.next(); return { ...pos, k: "continue" };
        case "return": this.next(); return { ...pos, k: "return" };
        case "global": case "persistent": {
          this.next();
          const names: string[] = [];
          while (this.peek().t === "id") names.push(this.next().v);
          return { ...pos, k: t.v as "global", names };
        }
      }
      this.fail(`unexpected '${t.v}'`);
    }
    // [a, b] = f(...)
    if (this.at("[")) {
      const save = this.i;
      const lhs = this.tryMultiLhs();
      if (lhs) {
        const rhs = this.expr();
        return { ...pos, k: "assign", lhs, rhs, print: true, multi: true };
      }
      this.i = save;
    }
    const e = this.expr();
    if (this.at("=")) {
      this.next();
      const lv = this.lvalue(e);
      const rhs = this.expr();
      return { ...pos, k: "assign", lhs: [lv], rhs, print: true, multi: false };
    }
    return { ...pos, k: "expr", e, print: true };
  }

  tryMultiLhs(): (LValue | null)[] | null {
    // find the matching ']' and an '=' (not '==') after it
    let depth = 0, j = this.i;
    for (; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === "eof") return null;
      if (t.t === "op" && (t.v === "[" || t.v === "(" || t.v === "{")) depth++;
      if (t.t === "op" && (t.v === "]" || t.v === ")" || t.v === "}")) { depth--; if (depth === 0) break; }
      if (t.t === "nl" && depth <= 1) return null;
    }
    const after = this.toks[j + 1];
    if (!after || !(after.t === "op" && after.v === "=")) return null;
    this.next(); // [
    this.mat.push(true);
    const out: (LValue | null)[] = [];
    try {
      while (!this.at("]")) {
        if (this.eat(",")) continue;
        if (this.at("~") && (this.at(",", 1) || this.at("]", 1) || this.peek(1).sp)) { this.next(); out.push(null); continue; }
        const e = this.postfixExpr();
        out.push(this.lvalue(e));
      }
    } finally {
      this.mat.pop();
    }
    this.expect("]");
    this.expect("=");
    return out;
  }

  lvalue(e: Expr): LValue {
    const path: Expr[] = [];
    let cur = e;
    while (cur.k === "index" || cur.k === "field" || cur.k === "dynfield") {
      path.unshift(cur);
      cur = cur.e;
    }
    if (cur.k !== "id") this.fail("invalid assignment target");
    return { name: cur.name, path, line: cur.line, col: cur.col };
  }

  ifStmt(): Stmt {
    this.expect("if");
    const clauses: [Expr, Stmt[]][] = [];
    let cond = this.expr();
    clauses.push([cond, this.block(["elseif", "else", "end"])]);
    let els: Stmt[] | null = null;
    while (true) {
      if (this.eat("elseif")) {
        cond = this.expr();
        clauses.push([cond, this.block(["elseif", "else", "end"])]);
      } else if (this.eat("else")) {
        els = this.block(["end"]);
      } else break;
    }
    this.expect("end");
    return { k: "if", clauses, els } as any;
  }

  forStmt(): Stmt {
    const par = this.next().v === "parfor";
    const paren = this.eat("(");
    if (paren) this.mat.push(false);
    const v = this.ident();
    this.expect("=");
    const e = this.expr();
    if (par && paren && this.eat(",")) this.expr(); // parfor (i = 1:n, M)
    if (paren) { this.mat.pop(); this.expect(")"); }
    const body = this.block(["end"]);
    this.expect("end");
    return { k: "for", v, e, body } as any;
  }

  switchStmt(): Stmt {
    this.expect("switch");
    const e = this.expr();
    this.skipSeps();
    const cases: [Expr, Stmt[]][] = [];
    let otherwise: Stmt[] | null = null;
    while (true) {
      if (this.eat("case")) {
        const v = this.expr();
        cases.push([v, this.block(["case", "otherwise", "end"])]);
      } else if (this.eat("otherwise")) {
        otherwise = this.block(["case", "otherwise", "end"]);
      } else break;
    }
    this.expect("end");
    return { k: "switch", e, cases, otherwise } as any;
  }

  funcDef(): FuncDef {
    const ft = this.expect("function");
    let outs: string[] = [];
    let name: string;
    if (this.at("[")) {
      this.next();
      while (!this.at("]")) {
        if (this.eat(",")) continue;
        outs.push(this.ident());
      }
      this.next();
      this.expect("=");
      name = this.ident();
    } else {
      name = this.ident();
      if (this.eat("=")) {
        outs = [name];
        name = this.ident();
      }
    }
    // (a property accessor's name: get.x)
    while (this.at(".") && this.peek(1).t === "id") { this.next(); name += "_" + this.next().v; }
    const params: string[] = [];
    if (this.eat("(")) {
      while (!this.at(")")) {
        if (this.eat(",")) continue;
        if (this.eat("~")) { params.push("~"); continue; }
        params.push(this.ident());
      }
      this.next();
    }
    const body: Stmt[] = [];
    const args: ArgEntry[] = [];
    while (true) {
      this.skipSeps();
      const t = this.peek();
      if (t.t === "eof") break;
      if (this.at("function")) break; // the next function (files without `end`)
      if (this.at("end")) { this.next(); break; }
      if (!body.length && this.atArgumentsBlock()) { this.argumentsBlock(args); continue; }
      body.push(...this.statementAndSep());
    }
    return { name, params, outs, body, line: ft.line, args };
  }

  /** `arguments` (or `arguments (Input)`) starting a line: a validation block */
  atArgumentsBlock() {
    const t = this.peek(), u = this.peek(1);
    return t.t === "id" && t.v === "arguments" && (u.t === "nl" || (u.t === "op" && u.v === "(" && u.line === t.line) || (u.t === "op" && u.v === ";"));
  }

  /** an arguments block's entries (Output blocks are skipped; Repeating is not supported) */
  argumentsBlock(out: ArgEntry[]) {
    const kw = this.next();
    const attrs: string[] = [];
    if (this.eat("(")) {
      while (!this.at(")")) {
        const a = this.next();
        if (a.t === "eof") this.fail("expected ')'");
        if (a.t === "id") attrs.push(a.v);
      }
      this.next();
    }
    if (attrs.includes("Repeating")) this.fail("Repeating arguments blocks are not supported yet", kw);
    const output = attrs.includes("Output");
    while (true) {
      this.skipSeps();
      if (this.at("end")) { this.next(); return; }
      const t = this.peek();
      if (t.t === "eof") this.fail("expected 'end' to close the arguments block");
      const name = this.ident();
      let field: string | null = null;
      if (this.at(".") && this.peek(1).t === "id") { this.next(); field = this.next().v; }
      let dims: (number | null)[] | null = null;
      if (this.at("(") && this.peek().line === t.line) {
        this.next();
        dims = [];
        while (!this.at(")")) {
          if (this.eat(",")) continue;
          const d = this.next();
          if (d.t === "num") dims.push(Number(d.v));
          else if (d.t === "op" && d.v === ":") dims.push(null);
          else this.fail("expected a size", d);
        }
        this.next();
      }
      let cls: string | null = null;
      if (this.peek().t === "id" && this.peek().line === t.line) {
        cls = this.next().v;
        while (this.at(".") && this.peek(1).t === "id") { this.next(); cls += "." + this.next().v; }
      }
      const validators: Expr[] = [];
      if (this.at("{") && this.peek().line === t.line) {
        this.next();
        this.mat.push(false);
        try {
          while (!this.at("}")) {
            if (this.eat(",")) continue;
            validators.push(this.postfixExpr());
          }
        } finally {
          this.mat.pop();
        }
        this.next();
      }
      let dflt: Expr | null = null;
      if (this.eat("=")) dflt = this.expr();
      if (!output) out.push({ name, field, dims, cls, validators, dflt, line: t.line });
    }
  }

  // -------- expressions
  expr(): Expr { return this.oror(); }

  oror(): Expr {
    let l = this.andand();
    while (this.at("||")) { this.next(); l = { k: "bin", op: "||", l, r: this.andand() }; }
    return l;
  }
  andand(): Expr {
    let l = this.or();
    while (this.at("&&")) { this.next(); l = { k: "bin", op: "&&", l, r: this.or() }; }
    return l;
  }
  or(): Expr {
    let l = this.and();
    while (this.at("|")) { this.next(); l = { k: "bin", op: "|", l, r: this.and() }; }
    return l;
  }
  and(): Expr {
    let l = this.cmp();
    while (this.at("&")) { this.next(); l = { k: "bin", op: "&", l, r: this.cmp() }; }
    return l;
  }
  cmp(): Expr {
    let l = this.range();
    while (["==", "~=", "<", "<=", ">", ">="].some((o) => this.at(o))) {
      const op = this.next().v;
      l = { k: "bin", op, l, r: this.range() };
    }
    return l;
  }
  range(): Expr {
    const a = this.additive();
    if (!this.at(":") || this.colonEnds(1)) return a;
    this.next();
    const b = this.additive();
    if (this.at(":") && !this.colonEnds(1)) {
      this.next();
      const c = this.additive();
      return { k: "range", a, step: b, b: c };
    }
    return { k: "range", a, step: null, b };
  }
  /** a ':' at offset k that cannot start an operand (end of an index) */
  colonEnds(k: number) {
    const t = this.peek(k);
    return t.t === "eof" || t.t === "nl" || (t.t === "op" && [")", "]", "}", ",", ";"].includes(t.v));
  }
  /** in [ ] and { }: `a -b` and `a (1)` are two elements */
  splits() {
    const t = this.peek();
    if (!this.inMatrix() || !t.sp) return false;
    if (t.t === "op" && (t.v === "+" || t.v === "-")) return !this.peek(1).sp;
    return t.t === "op" && (t.v === "(" || t.v === "{");
  }
  additive(): Expr {
    let l = this.mult();
    while ((this.at("+") || this.at("-")) && !this.splits()) {
      const op = this.next().v;
      l = { k: "bin", op, l, r: this.mult() };
    }
    return l;
  }
  mult(): Expr {
    let l = this.unary();
    while (["*", "/", "\\", ".*", "./", ".\\"].some((o) => this.at(o))) {
      const op = this.next().v;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Expr {
    if (this.at("-") || this.at("+") || this.at("~")) {
      const op = this.next().v;
      return { k: "un", op, e: this.unary() };
    }
    return this.power();
  }
  power(): Expr {
    let e = this.postfixExpr();
    while (true) {
      if (this.at("'") || this.at(".'")) {
        e = { k: "post", op: this.next().v, e };
      } else if ((this.at("^") || this.at(".^"))) {
        const op = this.next().v;
        e = { k: "bin", op, l: e, r: this.powerOperand() };
      } else return e;
    }
  }
  /** the exponent of a ^: unary signs, then an operand with its indexes (2^-x(1)) */
  powerOperand(): Expr {
    if (this.at("-") || this.at("+") || this.at("~")) {
      const op = this.next().v;
      return { k: "un", op, e: this.powerOperand() };
    }
    let e = this.postfixExpr();
    while (this.at("'") || this.at(".'")) e = { k: "post", op: this.next().v, e };
    return e;
  }

  postfixExpr(): Expr {
    let e = this.primary();
    while (true) {
      if ((this.at("(") || this.at("{")) && !this.splits()) {
        const brace = this.next().v === "{";
        const frame: Frame = { code: "", n: 0, cur: 0 };
        const args = this.args(brace ? "}" : ")", frame);
        e = { k: "index", e, brace, args, frame };
      } else if (this.at(".") && this.peek(1).t === "id" && !this.peek(1).sp) {
        this.next();
        e = { k: "field", e, name: this.next().v };
      } else if (this.at(".") && this.at("(", 1)) {
        this.next();
        this.next();
        this.mat.push(false);
        const saved = this.frames;
        this.frames = [];
        const name = this.expr();
        this.frames = saved;
        this.mat.pop();
        this.expect(")");
        e = { k: "dynfield", e, name };
      } else return e;
    }
  }

  args(close: string, frame: Frame): Expr[] {
    this.mat.push(false);
    this.frames.push(frame);
    const args: Expr[] = [];
    try {
      while (this.peek().t === "nl") this.next();
      if (!this.at(close)) {
        do {
          while (this.peek().t === "nl") this.next();
          frame.cur = args.length;
          if (this.at(":") && this.colonEnds(1)) { this.next(); args.push({ k: "colon" }); }
          else if (close === ")" && this.peek().t === "id" && this.at("=", 1)) {
            // name=value (R2021a): the same as "name", value
            args.push({ k: "str", v: this.next().v, dq: true });
            this.next();
            frame.cur = args.length;
            args.push(this.expr());
          } else args.push(this.expr());
          while (this.peek().t === "nl") this.next();
        } while (this.eat(","));
      }
    } finally {
      this.frames.pop();
      this.mat.pop();
    }
    this.expect(close);
    frame.n = args.length;
    return args;
  }

  primary(): Expr {
    const t = this.peek();
    if (t.t === "num") { this.next(); return { k: "num", v: t.v }; }
    if (t.t === "str") { this.next(); return { k: "str", v: t.v, dq: false }; }
    if (t.t === "dqstr") { this.next(); return { k: "str", v: t.v, dq: true }; }
    if (t.t === "id") { this.next(); return { k: "id", name: t.v, line: t.line, col: t.col }; }
    if (t.t === "kw" && t.v === "end" && this.frames.length) {
      this.next();
      const frame = this.frames[this.frames.length - 1];
      return { k: "end", frame, pos: frame.cur };
    }
    if (this.at("(")) {
      this.next();
      this.mat.push(false);
      const saved = this.frames;
      // (inside parentheses, `end` still refers to the enclosing index)
      try {
        const e = this.expr();
        this.frames = saved;
        this.expect(")");
        return e;
      } finally {
        this.mat.pop();
      }
    }
    if (this.at("[") || this.at("{")) return this.matrix();
    if (this.at("@")) {
      this.next();
      if (this.at("(")) {
        this.next();
        const params: string[] = [];
        while (!this.at(")")) {
          if (this.eat(",")) continue;
          if (this.eat("~")) { params.push("~"); continue; }
          params.push(this.ident());
        }
        this.next();
        this.mat.push(false);
        const saved = this.frames;
        this.frames = [];
        try {
          const body = this.expr();
          return { k: "anon", params, body };
        } finally {
          this.frames = saved;
          this.mat.pop();
        }
      }
      let name = this.ident();
      while (this.at(".") && this.peek(1).t === "id") { this.next(); name += "." + this.next().v; }
      return { k: "handle", name };
    }
    this.fail(t.t === "eof" ? "unexpected end of input" : `unexpected ${desc(t)}`);
  }


  matrix(): Expr {
    const cell = this.next().v === "{";
    const close = cell ? "}" : "]";
    this.mat.push(true);
    const rows: Expr[][] = [];
    let row: Expr[] = [];
    try {
      while (true) {
        const t = this.peek();
        if (this.at(close)) break;
        if (t.t === "eof") this.fail(`expected '${close}'`);
        if (t.t === "nl" || this.at(";")) {
          this.next();
          if (row.length) rows.push(row);
          row = [];
          continue;
        }
        if (this.eat(",")) continue;
        row.push(this.expr());
        // the next element must be separated (`[1 2]`, `[a, b]`)
        const u = this.peek();
        if (!(this.at(close) || this.at(",") || this.at(";") || u.t === "nl" || u.sp)) this.fail(`unexpected ${desc(u)}`);
      }
    } finally {
      this.mat.pop();
    }
    this.next();
    if (row.length) rows.push(row);
    return { k: "matrix", rows, cell };
  }
}

const desc = (t: Tok) => (t.t === "eof" ? "end of input" : t.t === "nl" ? "end of line" : t.t === "str" ? `'${t.v}'` : `'${t.v}'`);

// ------------------------------------------------------------------ names

const PYKW = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global " +
  "if import in is lambda nonlocal not or pass raise return try while with yield match case type globals locals print exec").split(" "));

/** a MATLAB name as a Python one (MATLAB names never start with _) */
export const pyName = (s: string) => (PYKW.has(s) ? "_k_" + s : s);

// ------------------------------------------------------------------ emitter

interface Scope {
  fn: FuncDef | null; // null: the top level (a script, a cell)
  vars: Set<string>; // names known to be variables here
  globals: Set<string>;
  persistents: Set<string>;
  caps?: Set<string>; // in an anonymous function: captured names that may be functions (_m.NOVAR)
  anon?: boolean; // an anonymous function's body: its parameters and captures are Python locals
}

/** the names a statement list assigns (for loops' bodies and functions) */
function assigned(stmts: Stmt[], out = new Set<string>()): Set<string> {
  for (const s of stmts) {
    switch (s.k) {
      case "assign": for (const l of s.lhs) if (l) out.add(l.name); break;
      case "for": out.add(s.v); assigned(s.body, out); break;
      case "while": assigned(s.body, out); break;
      case "if": for (const [, b] of s.clauses) assigned(b, out); if (s.els) assigned(s.els, out); break;
      case "switch": for (const [, b] of s.cases) assigned(b, out); if (s.otherwise) assigned(s.otherwise, out); break;
      case "try": assigned(s.body, out); if (s.id) out.add(s.id); assigned(s.handler, out); break;
      case "global": case "persistent": for (const n of s.names) out.add(n); break;
      case "expr": case "cmd": break;
    }
    // `ans` is assigned by expression statements
    if (s.k === "expr" || s.k === "cmd") out.add("ans");
  }
  return out;
}

/** the names a statement list assigns into (x(i) = v, x.f = v, x{i} = v) */
function indexAssigned(stmts: Stmt[], out = new Set<string>()): Set<string> {
  for (const s of stmts) {
    switch (s.k) {
      case "assign": for (const l of s.lhs) if (l && l.path.length) out.add(l.name); break;
      case "for": case "while": indexAssigned(s.body, out); break;
      case "if": for (const [, b] of s.clauses) indexAssigned(b, out); if (s.els) indexAssigned(s.els, out); break;
      case "switch": for (const [, b] of s.cases) indexAssigned(b, out); if (s.otherwise) indexAssigned(s.otherwise, out); break;
      case "try": indexAssigned(s.body, out); indexAssigned(s.handler, out); break;
    }
  }
  return out;
}

const OP_FN: Record<string, string> = {
  "+": "plus", "-": "minus", ".*": "times", "*": "mtimes", "./": "rdivide", "/": "mrdivide", ".\\": "ldivide", "\\": "mldivide",
  ".^": "power", "^": "mpower", "==": "eq", "~=": "ne", "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "&": "and_", "|": "or_",
};

// functions given the workspace (they read or write variables by name)
// clear's ItemType words, and those of them that clear the variables in scope
const CLEAR_ITEMTYPES = new Set(["all", "classes", "functions", "global", "import", "java", "mex", "variables"]);
const CLEAR_VARIABLE_ITEMTYPES = new Set(["all", "classes", "java", "variables"]);
const WORKSPACE_FNS = new Set(["clear", "clearvars", "exist", "who", "whos", "load", "save", "isvarname_ws"]);

class Emitter {
  out: string[] = [];
  ind = "";
  tmp = 0;
  fnNames = new Set<string>();
  // (whether the program can clear a variable as it runs: only then do top-level reads
  // check that the variable still exists, so other programs' reads stay plain names)
  mayClear = false;

  constructor(private funcs: FuncDef[], private filename: string, private cell = false) {
    for (const f of funcs) this.fnNames.add(f.name);
  }

  emit(line: string) { this.out.push(this.ind + line); }
  indent(f: () => void) {
    const saved = this.ind;
    this.ind += "    ";
    const n = this.out.length;
    f();
    if (this.out.length === n) this.emit("pass");
    this.ind = saved;
  }
  fresh(base = "_t") { return `${base}${++this.tmp}`; }

  /** a file of functions found on the path: its definitions only */
  functionFile(): string {
    this.emit("import _matlab as _m");
    for (const f of this.funcs) this.funcDef(f);
    return this.out.join("\n") + "\n";
  }

  program(stmts: Stmt[], src: string): string {
    this.mayClear = /\b(clear\w*|eval\w*|feval|run)\b/.test(src);
    this.emit("import _matlab as _m");
    this.emit(`_m.begin(${JSON.stringify(this.filename)}, ${JSON.stringify(src)})`);
    this.emit("_L = 0");
    this.emit("try:");
    this.indent(() => {
      for (const f of this.funcs) this.funcDef(f);
      const scope: Scope = { fn: null, vars: new Set(), globals: new Set(), persistents: new Set() };
      this.stmts(stmts, scope);
      // (the figures the program drew)
      this.emit("_m.end_program()");
    });
    this.emit("except BaseException as _e:");
    // (a notebook cell's error is reported without ending the session: lib/_matlab.py's report_cell)
    this.indent(() => this.emit(this.cell ? "_m.report_cell(_e, _L)" : "_m.report(_e, _L)"));
    return this.out.join("\n") + "\n";
  }

  // -------- functions
  funcDef(f: FuncDef) {
    const py = pyName(f.name);
    const varargin = f.params[f.params.length - 1] === "varargin";
    let params = varargin ? f.params.slice(0, -1) : f.params;
    const varargout = f.outs[f.outs.length - 1] === "varargout";
    const scope: Scope = { fn: f, vars: new Set(), globals: new Set(), persistents: new Set() };
    this.emit(`def ${py}(_nargout, *_a):`);
    this.indent(() => {
      // name-value arguments (opts.Name in an arguments block): the trailing pairs
      const nvParams = [...new Set(f.args.filter((a) => a.field).map((a) => a.name))];
      if (nvParams.length) {
        const names = f.args.filter((a) => a.field).map((a) => a.field!);
        const npos = params.length - nvParams.length;
        this.emit(`_a, _nv = _m.split_nv(_a, ${npos}, ${JSON.stringify(names)})`);
        params = params.filter((p) => !nvParams.includes(p));
      }
      const ps = params.map((p, k) => (p === "~" ? `_unused${k}` : pyName(p)));
      const names = JSON.stringify(params);
      if (params.length) this.emit(`${ps.join(", ")}${ps.length === 1 ? "," : ""} = _m.inargs(_a, ${names}, ${varargin ? "True" : "False"}, ${JSON.stringify(f.name)})`);
      else if (!varargin) this.emit(`_m.inargs(_a, [], False, ${JSON.stringify(f.name)})`);
      for (const p of params) if (p !== "~") scope.vars.add(p);
      if (varargin) {
        this.emit(`varargin = _m.varargin_(_a, ${params.length})`);
        scope.vars.add("varargin");
      }
      // arguments the function changes in place are its own copies (value semantics)
      const changed = indexAssigned(f.body);
      for (const p of f.params) if (p !== "~" && changed.has(p)) this.emit(`${pyName(p)} = _m.cp(${pyName(p)})`);
      // every other local starts undefined
      const locals = [...new Set([...f.outs, ...assigned(f.body)])].filter((n) => !f.params.includes(n));
      for (const n of locals) this.emit(`${pyName(n)} = _m.Undef(${JSON.stringify(n)})`);
      for (const o of f.outs) scope.vars.add(o);
      this.emit(`_L = ${f.line}`);
      this.emit("try:");
      this.indent(() => {
        this.argumentChecks(f, scope);
        this.stmts(f.body, scope);
      });
      this.emit("except BaseException as _e:");
      this.indent(() => this.emit(`raise _m.trace(_e, ${JSON.stringify(f.name)}, _L)`));
      this.emit(`return ${this.retExpr(f)}`);
    });
    this.emit(`${py} = _m.Function(${py}, ${JSON.stringify(f.name)}, ${f.params.length}, ${f.outs.length}, ${varargin ? "True" : "False"}, ${varargout ? "True" : "False"})`);
  }

  /** an arguments block's defaults, conversions and validations, in order */
  argumentChecks(f: FuncDef, scope: Scope) {
    const nv = new Map<string, ArgEntry[]>();
    let pos = 0;
    for (const a of f.args) {
      if (a.field) {
        if (!nv.has(a.name)) nv.set(a.name, []);
        nv.get(a.name)!.push(a);
        continue;
      }
      pos = f.params.indexOf(a.name) + 1;
      const v = pyName(a.name);
      this.emit(`_L = ${a.line}`);
      if (a.dflt) this.emit(`if isinstance(${v}, _m.Undef): ${v} = ${this.valueExpr(a.dflt, scope)}`);
      this.emitArgCheck(v, a, `${pos}`, scope);
    }
    for (const [name, entries] of nv) {
      const v = pyName(name);
      scope.vars.add(name);
      // defaults first, then the caller's values (each converted and validated)
      this.emit(`${v} = _m.Struct([{}], (1, 1), [])`);
      for (const a of entries) {
        this.emit(`_L = ${a.line}`);
        const fld = JSON.stringify(a.field);
        this.emit(`if _m.nv_has(_nv, ${fld}):`);
        this.indent(() => this.emit(`${v} = _m.assign(${v}, [("f", ${fld})], _m.nv_get(_nv, ${fld}))`));
        if (a.dflt) {
          this.emit("else:");
          this.indent(() => this.emit(`${v} = _m.assign(${v}, [("f", ${fld})], ${this.valueExpr(a.dflt!, scope)})`));
        }
        this.emit(`if ${fld} in ${v}.fields:`);
        this.indent(() => {
          this.emit(`_t = _m.field(${v}, ${fld})`);
          this.emitArgCheck("_t", a, JSON.stringify(a.field), scope);
          this.emit(`${v} = _m.assign(${v}, [("f", ${fld})], _t)`);
        });
      }
    }
  }

  emitArgCheck(v: string, a: ArgEntry, pos: string, scope: Scope) {
    if (a.dims || a.cls) {
      const dims = a.dims ? `[${a.dims.map((d) => (d === null ? "None" : `${d}`)).join(", ")}]` : "None";
      this.emit(`if not isinstance(${v}, _m.Undef): ${v} = _m.arg_check(${v}, ${dims}, ${a.cls ? JSON.stringify(a.cls) : "None"}, ${pos})`);
    }
    for (const val of a.validators) {
      // a validator named alone gets the value; a call names its arguments
      let call: string;
      if (val.k === "id") call = `_m.call(${this.lookup(val.name, scope)}, [${v}], 0)`;
      else if (val.k === "index" && !val.brace && val.e.k === "id") {
        const ve = { ...val } as any;
        call = this.indexExpr(ve, scope, "0");
      } else call = this.expr(val, scope);
      this.emit(`if not isinstance(${v}, _m.Undef): _m.validate(lambda: ${call}, ${pos})`);
    }
  }

  retExpr(f: FuncDef) {
    const varargout = f.outs[f.outs.length - 1] === "varargout";
    return `_m.ret(_nargout, [${f.outs.map(pyName).join(", ")}], ${JSON.stringify(f.name)}, ${varargout ? "True" : "False"})`;
  }

  // -------- statements
  stmts(list: Stmt[], scope: Scope) {
    for (const s of list) this.stmt(s, scope);
  }

  stmt(s: Stmt, scope: Scope) {
    this.emit(`_L = ${s.line}`);
    switch (s.k) {
      case "expr": return this.exprStmt(s.e, s.print, scope);
      case "cmd": {
        const call: Expr = { k: "index", e: { k: "id", name: s.name, line: s.line, col: s.col }, brace: false, args: s.args.map((a) => ({ k: "str", v: a, dq: false })), frame: { code: "", n: s.args.length, cur: 0 } };
        return this.exprStmt(call, s.print, scope);
      }
      case "assign": return this.assign(s, scope);
      case "if": {
        s.clauses.forEach(([c, body], k) => {
          this.emit(`${k === 0 ? "if" : "elif"} ${this.cond(c, scope)}:`);
          this.indent(() => this.stmts(body, scope));
        });
        if (s.els) {
          this.emit("else:");
          this.indent(() => this.stmts(s.els!, scope));
        }
        return;
      }
      case "for": {
        const v = s.v;
        const it = this.iterable(s.e, scope);
        for (const n of assigned(s.body)) scope.vars.add(n);
        scope.vars.add(v);
        this.emit(`for ${pyName(v)} in ${it}:`);
        this.indent(() => {
          this.afterAssign(v, scope);
          this.stmts(s.body, scope);
        });
        return;
      }
      case "while": {
        for (const n of assigned(s.body)) scope.vars.add(n);
        this.emit(`while ${this.cond(s.cond, scope)}:`);
        this.indent(() => this.stmts(s.body, scope));
        return;
      }
      case "switch": {
        const v = this.fresh();
        this.emit(`${v} = ${this.expr(s.e, scope)}`);
        if (!s.cases.length) {
          if (s.otherwise) this.stmts(s.otherwise, scope);
          return;
        }
        s.cases.forEach(([c, body], k) => {
          this.emit(`${k === 0 ? "if" : "elif"} _m.case_match(${v}, ${this.expr(c, scope)}):`);
          this.indent(() => this.stmts(body, scope));
        });
        if (s.otherwise) {
          this.emit("else:");
          this.indent(() => this.stmts(s.otherwise!, scope));
        }
        return;
      }
      case "try": {
        this.emit("try:");
        this.indent(() => this.stmts(s.body, scope));
        this.emit("except _m.Catchable as _e:");
        this.indent(() => {
          if (s.id) {
            scope.vars.add(s.id);
            this.emit(`${pyName(s.id)} = _m.caught(_e)`);
            this.afterAssign(s.id, scope);
          } else this.emit("_m.caught(_e)");
          this.stmts(s.handler, scope);
        });
        return;
      }
      case "break": this.emit("break"); return;
      case "continue": this.emit("continue"); return;
      case "return":
        if (scope.fn) this.emit(`return ${this.retExpr(scope.fn)}`);
        else this.emit("raise _m.ScriptReturn()");
        return;
      case "global":
        for (const n of s.names) {
          scope.vars.add(n);
          scope.globals.add(n);
          this.emit(`${pyName(n)} = _m.global_get(${JSON.stringify(n)})`);
        }
        return;
      case "persistent":
        for (const n of s.names) {
          scope.vars.add(n);
          scope.persistents.add(n);
          this.emit(`${pyName(n)} = _m.persistent_get(${JSON.stringify(scope.fn?.name ?? "")}, ${JSON.stringify(n)})`);
        }
        return;
    }
  }

  /** after a variable changes: globals and persistents are written back */
  afterAssign(name: string, scope: Scope) {
    if (scope.globals.has(name)) this.emit(`_m.global_set(${JSON.stringify(name)}, ${pyName(name)})`);
    if (scope.persistents.has(name)) this.emit(`_m.persistent_set(${JSON.stringify(scope.fn?.name ?? "")}, ${JSON.stringify(name)}, ${pyName(name)})`);
  }

  cond(e: Expr, scope: Scope): string {
    if (e.k === "bin" && (e.op === "&&" || e.op === "||")) return this.expr(e, scope);
    return `_m.cond(${this.expr(e, scope)})`;
  }

  iterable(e: Expr, scope: Scope): string {
    if (e.k === "range") {
      return e.step ? `_m.frange3(${this.expr(e.a, scope)}, ${this.expr(e.step, scope)}, ${this.expr(e.b, scope)})` : `_m.frange(${this.expr(e.a, scope)}, ${this.expr(e.b, scope)})`;
    }
    return `_m.columns(${this.expr(e, scope)})`;
  }

  exprStmt(e: Expr, print: boolean, scope: Scope) {
    // a variable alone: displayed by its name
    if (e.k === "id" && this.isVar(e.name, scope)) {
      const v = this.varRead(e.name, scope);
      if (print) this.emit(`_m.display(${JSON.stringify(e.name)}, ${v})`);
      else this.emit(v);
      return;
    }
    if (e.k === "id" && WORKSPACE_FNS.has(e.name) && !this.fnNames.has(e.name)) {
      // (whos, clear, ... alone: they see the workspace)
      e = { k: "index", e, brace: false, args: [], frame: { code: "", n: 0, cur: 0 } };
    }
    const t = this.fresh();
    if ((e.k === "index" && e.brace) || e.k === "field" || e.k === "dynfield") {
      // a comma-separated list, c{:} or s.a of a struct array: each value becomes ans in turn and
      // is displayed, as MATLAB shows idx{:} (none for an empty list)
      this.emit(`for ${t} in ${this.csList(e, scope)}:`);
      this.indent(() => {
        this.emit(`if ${t} is not _m.NOVAL:`);
        this.indent(() => {
          scope.vars.add("ans");
          this.emit(`ans = ${t}`);
          if (print) this.emit(`_m.display("ans", ans)`);
        });
      });
      return;
    }
    if (e.k === "id" && !this.fnNames.has(e.name) && !scope.fn) {
      // a variable of the workspace, or a function called with no arguments
      this.emit(`${t} = _m.bare(${this.lookup(e.name, scope)}, ${JSON.stringify(e.name)}, ${print ? "True" : "False"})`);
    } else if (e.k === "id") {
      this.emit(`${t} = _m.call(${this.lookup(e.name, scope)}, [], 0)`);
    } else if (e.k === "index" && !e.brace) {
      this.emit(`${t} = ${this.indexExpr(e, scope, "0")}`);
    } else {
      this.emit(`${t} = ${this.expr(e, scope)}`);
    }
    this.emit(`if ${t} is not _m.NOVAL:`);
    this.indent(() => {
      scope.vars.add("ans");
      this.emit(`ans = ${t}`);
      if (print) this.emit(`_m.display("ans", ans)`);
    });
  }

  assign(s: Extract<Stmt, { k: "assign" }>, scope: Scope) {
    if (!s.multi) {
      const lv = s.lhs[0]!;
      const rhs = this.valueExpr(s.rhs, scope);
      this.store(lv, rhs, scope);
      if (s.print) this.emit(`_m.display(${JSON.stringify(lv.name)}, ${pyName(lv.name)})`);
      return;
    }
    // [S.a] = ...: a field of a struct array, a variable already defined, takes one output per
    // element (MATLAB's comma-separated list on the left, as [S.a] = deal(A1,A2,A3) fills S(1..3).a)
    // ([S(i).a] = ... too: the elements S(i) selects)
    const csIdx = (lv: LValue) => lv.path.length === 2 && lv.path[0]!.k === "index" && !(lv.path[0] as Extract<Expr, { k: "index" }>).brace && lv.path[1]!.k === "field";
    // ([C{i}] = ... and [C{:}] = ...: the cells of a cell array the braces select, one output each)
    const csBrace = (lv: LValue) => lv.path.length === 1 && lv.path[0]!.k === "index" && (lv.path[0] as Extract<Expr, { k: "index" }>).brace;
    const csField = (lv: LValue | null): lv is LValue =>
      !!lv && this.isVar(lv.name, scope) && ((lv.path.length === 1 && lv.path[0]!.k === "field") || csIdx(lv) || csBrace(lv));
    const subs: string[] = [];
    const poss: string[] = [];
    const counts: string[] = s.lhs.map((lv, k) => {
      subs[k] = "None";
      poss[k] = "None";
      if (!csField(lv)) return "1";
      const c = this.fresh();
      if (csIdx(lv) || csBrace(lv)) {
        const p0 = lv.path[0] as Extract<Expr, { k: "index" }>;
        p0.frame.code = this.varRead(lv.name, scope);
        subs[k] = this.fresh();
        this.emit(`${subs[k]} = ${this.argList(p0.args, scope)}`);
      }
      // (the positions once, their count admitted before they are built, reused by the assignment)
      poss[k] = this.fresh();
      this.emit(`${poss[k]} = _m.${csBrace(lv) ? "cs_brace_positions" : "cs_positions"}(${this.varRead(lv.name, scope)}, ${subs[k]})`);
      this.emit(`${c} = _m.cs_count(${poss[k]})`);
      return c;
    });
    const n = counts.every((c) => c === "1") ? String(s.lhs.length) : `(${counts.join(" + ")})`;
    const t = this.fresh();
    const r = s.rhs;
    let code: string;
    if (r.k === "index" && !r.brace) code = this.indexExpr(r, scope, n);
    else if (r.k === "id" && !this.isVar(r.name, scope)) code = `_m.call(${this.lookup(r.name, scope)}, [], ${n})`;
    else if ((r.k === "index" && r.brace) || r.k === "field" || r.k === "dynfield") code = this.csList(r, scope);
    else code = this.expr(r, scope);
    this.emit(`${t} = _m.nout(${code}, ${n})`);
    let off = "0";
    s.lhs.forEach((lv, k) => {
      if (lv && csField(lv) && csBrace(lv)) {
        this.emit(`${pyName(lv.name)} = _m.set_brace_cs(${this.varRead(lv.name, scope)}, ${t}[${off}:${off} + ${counts[k]}], ${subs[k]}, ${poss[k]})`);
      } else if (lv && csField(lv)) {
        const f = (lv.path[lv.path.length - 1] as Extract<Expr, { k: "field" }>).name;
        this.emit(`${pyName(lv.name)} = _m.set_field_cs(${this.varRead(lv.name, scope)}, ${JSON.stringify(f)}, ${t}[${off}:${off} + ${counts[k]}], ${subs[k]}, ${poss[k]})`);
      } else if (lv) this.store(lv, `${t}[${off}]`, scope);
      off = counts[k] === "1" ? (off === "0" ? "1" : `${off} + 1`) : `${off} + ${counts[k]}`;
    });
    if (s.print) for (const lv of s.lhs) if (lv) this.emit(`_m.display(${JSON.stringify(lv.name)}, ${pyName(lv.name)})`);
  }

  /** an assignment's right side: a fresh value (a variable's is copied) */
  valueExpr(e: Expr, scope: Scope): string {
    const code = this.expr(e, scope);
    return this.aliases(e) ? `_m.cp(${code})` : code;
  }
  aliases(e: Expr) {
    return (e.k === "id") || e.k === "field" || e.k === "dynfield" || (e.k === "index" && e.brace);
  }

  store(lv: LValue, value: string, scope: Scope) {
    const name = pyName(lv.name);
    if (!lv.path.length) {
      this.emit(`${name} = ${value}`);
      scope.vars.add(lv.name);
      this.afterAssign(lv.name, scope);
      return;
    }
    const base = scope.globals.has(lv.name) ? this.varRead(lv.name, scope)
      : scope.fn || scope.persistents.has(lv.name) ? name : `(${name} if ${JSON.stringify(name)} in globals() else None)`;
    // x(i) = v and x(i, j) = v: the common cases, without the path
    const p0 = lv.path[0];
    if (lv.path.length === 1 && p0.k === "index" && !p0.brace && (p0.args.length === 1 || p0.args.length === 2) &&
        p0.args.every((a) => a.k !== "colon" && !(a.k === "index" && a.brace) && a.k !== "field" && a.k !== "dynfield")) {
      p0.frame.code = base;
      const subs = p0.args.map((a) => this.expr(a, scope));
      if (scope.globals.has(lv.name)) {
        // (a global: the index and the value first, which may call functions
        // that change it, then the registry's value at that point as the base)
        const t = this.fresh();
        this.emit(`${t} = [${subs.join(", ")}, ${value}]`);
        this.emit(`${name} = _m.set${subs.length}(${base}, *${t})`);
        scope.vars.add(lv.name);
        this.afterAssign(lv.name, scope);
        return;
      }
      this.emit(`${name} = _m.set${subs.length}(${base}, ${subs.join(", ")}, ${value})`);
      scope.vars.add(lv.name);
      this.afterAssign(lv.name, scope);
      return;
    }
    // the path, outermost first; `end` in an index refers to the part so far
    const parts: string[] = [];
    for (const p of lv.path) {
      if (p.k === "field") parts.push(`("f", ${JSON.stringify(p.name)})`);
      else if (p.k === "dynfield") parts.push(`("f", _m.fieldname(${this.expr(p.name, scope)}))`);
      else if (p.k === "index") {
        p.frame.code = `_m.peek(${base}, [${parts.join(", ")}])`;
        parts.push(`(${p.brace ? '"b"' : '"p"'}, ${this.argList(p.args, scope)})`);
      }
    }
    if (scope.globals.has(lv.name)) {
      // (a global: the path and the value first, then the registry's value)
      const tp = this.fresh(), tv = this.fresh();
      this.emit(`${tp} = [${parts.join(", ")}]`);
      this.emit(`${tv} = ${value}`);
      this.emit(`${name} = _m.assign(${base}, ${tp}, ${tv})`);
    } else {
      this.emit(`${name} = _m.assign(${base}, [${parts.join(", ")}], ${value})`);
    }
    scope.vars.add(lv.name);
    this.afterAssign(lv.name, scope);
  }

  isVar(name: string, scope: Scope) {
    return scope.vars.has(name);
  }

  /** a variable's value where it is read: a global's from the shared
   * registry at that point, since any call (even earlier in the same
   * expression) may have changed it, as MATLAB's global page says */
  varRead(name: string, scope: Scope): string {
    return scope.globals.has(name) ? `_m.global_get(${JSON.stringify(name)})` : pyName(name);
  }

  /** a name that is not a known variable: the value it names when the code runs */
  lookup(name: string, scope: Scope): string {
    if (this.fnNames.has(name)) return pyName(name);
    if (scope.fn) return `_m.fn(${JSON.stringify(name)})`;
    const py = pyName(name);
    return `(${py} if ${JSON.stringify(py)} in globals() else _m.fn(${JSON.stringify(name)}))`;
  }

  // -------- expressions
  expr(e: Expr, scope: Scope): string {
    switch (e.k) {
      case "num": return numLit(e.v);
      case "str": return e.dq ? `_m.Str(${JSON.stringify(e.v)})` : `_m.Char(${JSON.stringify(e.v)})`;
      case "id": {
        if (scope.caps?.has(e.name)) return `_m.val(_m.capf(${pyName(e.name)}, ${JSON.stringify(e.name)}))`;
        if (this.isVar(e.name, scope)) {
          // (at the top level, a variable that clear removed: the function of that name
          // again, as MATLAB's, so upper = 7; clear; upper('abc') works)
          if (this.mayClear && !scope.fn && !scope.anon && !scope.globals.has(e.name) && !this.fnNames.has(e.name)) {
            const py = pyName(e.name);
            return `(${py} if ${JSON.stringify(py)} in globals() else _m.val(_m.fn(${JSON.stringify(e.name)})))`;
          }
          return this.varRead(e.name, scope);
        }
        if (e.name === "nargin" && scope.fn) return "_m.nargs(_a)";
        if (e.name === "nargout" && scope.fn) return "_m.nargs(_nargout)";
        if (WORKSPACE_FNS.has(e.name) && !this.fnNames.has(e.name)) return `_m.ws_call(${JSON.stringify(e.name)}, ${scope.fn ? "locals()" : "globals()"}, [], 1)`;
        return `_m.val(${this.lookup(e.name, scope)})`;
      }
      case "end": return `_m.end(${e.frame.code}, ${e.pos}, ${e.frame.n})`;
      case "colon": return "_m.COLON";
      case "bin": {
        if (e.op === "&&") return `(_m.sc(${this.expr(e.l, scope)}) and _m.sc(${this.expr(e.r, scope)}))`;
        if (e.op === "||") return `(_m.sc(${this.expr(e.l, scope)}) or _m.sc(${this.expr(e.r, scope)}))`;
        return `_m.${OP_FN[e.op]}(${this.expr(e.l, scope)}, ${this.expr(e.r, scope)})`;
      }
      case "un": {
        const a = this.expr(e.e, scope);
        if (e.op === "-") return e.e.k === "num" ? `(-${a})` : `_m.uminus(${a})`;
        if (e.op === "+") return `_m.uplus(${a})`;
        return `_m.not_(${a})`;
      }
      case "post": return e.op === "'" ? `_m.ctranspose(${this.expr(e.e, scope)})` : `_m.transpose(${this.expr(e.e, scope)})`;
      case "range": return e.step ? `_m.colon(${this.expr(e.a, scope)}, ${this.expr(e.step, scope)}, ${this.expr(e.b, scope)})` : `_m.colon(${this.expr(e.a, scope)}, ${this.expr(e.b, scope)})`;
      case "index":
        if (e.brace) {
          const base = this.expr(e.e, scope);
          e.frame.code = base;
          return `_m.brace(${base}, ${this.argList(e.args, scope)})`;
        }
        return this.indexExpr(e, scope, "1");
      case "field": {
        const f = `_m.field(${this.fieldBase(e.e, scope)}, ${JSON.stringify(e.name)})`;
        // (a class's static method named alone is called: uint8.empty)
        return e.e.k === "id" && !this.isVar(e.e.name, scope) ? `_m.val(${f})` : f;
      }
      case "dynfield": return `_m.field(${this.fieldBase(e.e, scope)}, _m.fieldname(${this.expr(e.name, scope)}))`;
      case "matrix": {
        const rows = e.rows.map((r) => this.argList(r, scope));
        if (e.cell) return `_m.cell_lit([${rows.join(", ")}])`;
        if (rows.length === 0) return "_m.hcat([])";
        if (rows.length === 1) return `_m.hcat(${rows[0]})`;
        return `_m.vcat([${rows.map((r) => `_m.hcat(${r})`).join(", ")}])`;
      }
      case "anon": return this.anon(e, scope);
      case "handle": {
        if (this.fnNames.has(e.name)) return `_m.Handle(${pyName(e.name)}, ${JSON.stringify(e.name)})`;
        return `_m.handle(${JSON.stringify(e.name)})`;
      }
    }
  }

  /** what `.name` applies to: a name that is not a variable is the function
   * itself (uint8.empty, a class's static method; or f.x, f called first) */
  fieldBase(e: Expr, scope: Scope): string {
    if (e.k === "id" && !this.isVar(e.name, scope) && !(scope.caps?.has(e.name)) && !(scope.fn && (e.name === "nargin" || e.name === "nargout"))) return this.lookup(e.name, scope);
    return this.expr(e, scope);
  }

  /** x(args): indexing a variable, or calling a function, with nargout */
  indexExpr(e: Extract<Expr, { k: "index" }>, scope: Scope, nargout: string): string {
    let base: string;
    const f = e.e;
    if (f.k === "id" && !this.isVar(f.name, scope)) {
      // a function call (or a workspace variable, at the top level)
      if (WORKSPACE_FNS.has(f.name) && !this.fnNames.has(f.name)) {
        // (clear inside a function: a function's variables are Python locals, which
        // locals() cannot delete, so the names chosen become undefined again here: the
        // names given literally at compile time, the rest at run time)
        if (scope.fn && (f.name === "clear" || f.name === "clearvars")) {
          const lit = e.args.every((a) => a.k === "str" && /^[A-Za-z]\w*$/.test(a.v));
          const words = e.args.map((a) => (a as Extract<Expr, { k: "str" }>).v);
          const own = (ns: string[]) => ns.filter((n) => scope.vars.has(n) && !scope.globals.has(n) && !scope.persistents.has(n));
          const undef = (ns: string[]) => `[${ns.map((n) => `(${pyName(n)} := _m.Undef(${JSON.stringify(n)}))`).join(", ")}]`;
          // (clear's ItemType words, which clearvars doesn't have: its arguments are names)
          const kw = f.name === "clear" && lit ? words.filter((w) => CLEAR_ITEMTYPES.has(w)) : [];
          // (the function's globals and persistents, which these lowerings can't unlink)
          const prot = [...new Set([...scope.globals, ...scope.persistents])];
          const touchesProt = prot.length > 0 && (!words.length || kw.length > 0 || words.some((w) => prot.includes(w)));
          if (lit && !touchesProt && !(kw.length && (words.length > 1 || kw[0] === "global"))) {
            const everything = own([...scope.vars]);
            e.frame.code = "_m.UNDEF";
            if (!words.length) return everything.length ? `(${undef(everything)} and _m.NOVAL)` : "_m.NOVAL";
            if (kw.length) {
              // (clear WORD alone: the keyword, unless a variable of that name exists,
              // which is then the one cleared, as MATLAB's clear page says; whether it
              // exists is known only at run time)
              const w = kw[0];
              const asKeyword = CLEAR_VARIABLE_ITEMTYPES.has(w) && everything.length ? `(${undef(everything)} and _m.NOVAL)` : "_m.NOVAL";
              if (!own([w]).length) return asKeyword;
              return `(${undef([w])} and _m.NOVAL if not isinstance(${pyName(w)}, _m.Undef) else ${asKeyword})`;
            }
            const named = own(words);
            return named.length ? `(${undef(named)} and _m.NOVAL)` : "_m.NOVAL";
          }
          // (anything else, patterns, computed names, -except, -regexp: chosen at run
          // time from the function's variables that hold a value, by the same rules as at
          // the top level (_m.clear_select), and those made undefined; a global or
          // persistent chosen is refused there)
          const cands = own([...scope.vars]);
          const cs = this.fresh("_cs");
          const pairs = cands.map((n) => `(${JSON.stringify(n)}, ${pyName(n)})`).join(", ");
          const defd = cands.length ? `[_n for _n, _v in (${pairs}${cands.length === 1 ? "," : ""}) if not isinstance(_v, _m.Undef)]` : "[]";
          const sel = `_m.clear_select(${JSON.stringify(f.name)}, ${this.argList(e.args, scope)}, ${defd}, ${JSON.stringify(prot)})`;
          e.frame.code = "_m.UNDEF";
          const each = cands.map((n) => `((${pyName(n)} := _m.Undef(${JSON.stringify(n)})) if ${JSON.stringify(n)} in ${cs} else None)`);
          return `(${cs} := ${sel}, ${each.length ? each.join(", ") + ", " : ""}_m.NOVAL)[-1]`;
        }
        const ns = scope.fn ? "locals()" : "globals()";
        e.frame.code = "_m.UNDEF";
        return `_m.ws_call(${JSON.stringify(f.name)}, ${ns}, ${this.argList(e.args, scope)}, ${nargout})`;
      }
      base = this.lookup(f.name, scope);
    } else if (f.k === "id" && scope.caps?.has(f.name)) base = `_m.capf(${pyName(f.name)}, ${JSON.stringify(f.name)})`;
    // (at the top level, x(args) after clear x is the function x again)
    else if (f.k === "id" && this.mayClear && !scope.fn && !scope.anon && !scope.globals.has(f.name) && !this.fnNames.has(f.name)) base = this.lookup(f.name, scope);
    else if (f.k === "field" && f.e.k === "id" && !this.isVar(f.e.name, scope)) base = `_m.field(${this.fieldBase(f.e, scope)}, ${JSON.stringify(f.name)})`;
    else base = this.expr(f, scope);
    e.frame.code = base;
    return `_m.paren(${base}, ${this.argList(e.args, scope)}, ${nargout})`;
  }

  /** arguments (or elements): c{:} and s.f expand to their values */
  argList(args: Expr[], scope: Scope): string {
    const parts = args.map((a) => {
      if ((a.k === "index" && a.brace) || a.k === "field" || a.k === "dynfield") return `*${this.csList(a, scope)}`;
      return this.expr(a, scope);
    });
    return `[${parts.join(", ")}]`;
  }

  /** the values of c{...} or s.f as a list (a comma-separated list) */
  csList(a: Expr, scope: Scope): string {
    if (a.k === "index" && a.brace) {
      const base = this.expr(a.e, scope);
      a.frame.code = base;
      return `_m.brace_cs(${base}, ${this.argList(a.args, scope)})`;
    }
    if (a.k === "field") return `_m.field_cs(${this.fieldBase(a.e, scope)}, ${JSON.stringify(a.name)})`;
    if (a.k === "dynfield") return `_m.field_cs(${this.fieldBase(a.e, scope)}, _m.fieldname(${this.expr(a.name, scope)}))`;
    return `[${this.expr(a, scope)}]`;
  }

  anon(e: Extract<Expr, { k: "anon" }>, scope: Scope): string {
    // the body sees its parameters, and the values variables have now
    const inner: Scope = { fn: scope.fn, vars: new Set(e.params.filter((p) => p !== "~")), globals: new Set(), persistents: new Set(), caps: new Set(), anon: true };
    const captured: string[] = [];
    const free = new Set<string>();
    freeNames(e.body, free);
    for (const n of free) {
      if (inner.vars.has(n)) continue;
      if (this.isVar(n, scope)) {
        // (a global's value now, from the registry: the anonymous function
        // keeps a snapshot, its own scope having no globals)
        captured.push(`${pyName(n)}=_m.cp(${this.varRead(n, scope)})`);
        inner.vars.add(n);
      } else if (!scope.fn && !this.fnNames.has(n)) {
        // (at the top level: a workspace variable now, else a function)
        captured.push(`${pyName(n)}=(_m.cp(${pyName(n)}) if ${JSON.stringify(pyName(n))} in globals() else _m.NOVAR)`);
        inner.vars.add(n);
        inner.caps!.add(n);
      }
    }
    // (a call in the body gets the handle's nargout: [a, b] = f())
    const body = e.body.k === "index" && !e.body.brace ? this.indexExpr(e.body, inner, "_n") : this.expr(e.body, inner);
    const params = e.params.map((p, k) => (p === "~" ? `_u${k}=_m.UNDEF` : `${pyName(p)}=_m.UNDEF`));
    const sig = ["_n", ...params, ...(captured.length ? ["*", ...captured] : [])].join(", ");
    return `_m.Anon(lambda ${sig}: ${body}, ${JSON.stringify(unparse(e))}, ${e.params.length})`;
  }
}

function freeNames(e: Expr, out: Set<string>) {
  switch (e.k) {
    case "id": out.add(e.name); break;
    case "bin": freeNames(e.l, out); freeNames(e.r, out); break;
    case "un": case "post": freeNames(e.e, out); break;
    case "range": freeNames(e.a, out); if (e.step) freeNames(e.step, out); freeNames(e.b, out); break;
    case "index": freeNames(e.e, out); e.args.forEach((a) => freeNames(a, out)); break;
    case "field": freeNames(e.e, out); break;
    case "dynfield": freeNames(e.e, out); freeNames(e.name, out); break;
    case "matrix": e.rows.forEach((r) => r.forEach((a) => freeNames(a, out))); break;
    case "anon": {
      const inner = new Set<string>();
      freeNames(e.body, inner);
      for (const n of inner) if (!e.params.includes(n)) out.add(n);
      break;
    }
  }
}

function numLit(v: string): string {
  if (v.startsWith("int:")) {
    // (a hex or binary literal: the smallest unsigned type that holds it, or its suffix's type)
    const [, radix, digits, suffix] = v.split(":");
    const cls = suffix ? (suffix[0] === "u" ? "uint" : "int") + suffix.slice(1) : "";
    return `_m.intlit(${JSON.stringify(digits)}, ${radix}, ${JSON.stringify(cls)})`;
  }
  let imag = false;
  if (v.endsWith("i")) { imag = true; v = v.slice(0, -1); }
  if (v.startsWith(".")) v = "0" + v;
  if (v.endsWith(".")) v += "0";
  if (!/[.eE]/.test(v)) v += ".0";
  return imag ? `${v}j` : v;
}

// ------------------------------------------------------------------ unparsing (function handles' text)

const PREC: Record<string, number> = { "||": 1, "&&": 2, "|": 3, "&": 4, "==": 5, "~=": 5, "<": 5, "<=": 5, ">": 5, ">=": 5, ":": 6, "+": 7, "-": 7, "*": 8, "/": 8, "\\": 8, ".*": 8, "./": 8, ".\\": 8, "^": 10, ".^": 10 };

/** an expression as MATLAB writes it back (func2str: no spaces) */
export function unparse(e: Expr, prec = 0): string {
  const wrap = (s: string, p: number) => (p < prec ? `(${s})` : s);
  switch (e.k) {
    case "num": return e.v;
    case "str": return e.dq ? `"${e.v.replace(/"/g, '""')}"` : `'${e.v.replace(/'/g, "''")}'`;
    case "id": return e.name;
    case "end": return "end";
    case "colon": return ":";
    case "bin": {
      const p = PREC[e.op];
      // (left-associative: a right operand of the same precedence keeps its parentheses)
      return wrap(`${unparse(e.l, p)}${e.op}${unparse(e.r, p + 1)}`, p);
    }
    case "un": return wrap(`${e.op}${unparse(e.e, 9)}`, 9);
    case "post": return `${unparse(e.e, 11)}${e.op}`;
    case "range": return wrap(`${unparse(e.a, 7)}:${e.step ? unparse(e.step, 7) + ":" : ""}${unparse(e.b, 7)}`, 6);
    case "index": return `${unparse(e.e, 11)}${e.brace ? "{" : "("}${e.args.map((a) => unparse(a)).join(",")}${e.brace ? "}" : ")"}`;
    case "field": return `${unparse(e.e, 11)}.${e.name}`;
    case "dynfield": return `${unparse(e.e, 11)}.(${unparse(e.name)})`;
    case "matrix": return `${e.cell ? "{" : "["}${e.rows.map((r) => r.map((a) => unparse(a)).join(",")).join(";")}${e.cell ? "}" : "]"}`;
    case "anon": return `@(${e.params.join(",")})${unparse(e.body)}`;
    case "handle": return `@${e.name}`;
  }
}

// ------------------------------------------------------------------ entry points

/** MATLAB source -> Python source (for lib/_matlab.py). */
/**
 * A MATLAB program as Python on lib/_matlab.py.  With `cell`, a notebook cell:
 * its variables and functions stay in the session's globals for the next
 * cells, and an error is reported (MATLAB's message on stderr) without ending
 * the session; `_matlab.cell_failed()` then says the cell failed.
 */
export function matlabToPython(src: string, filename = "<matlab>", opts: { cell?: boolean } = {}): string {
  const p = new Parser(lex(src));
  const stmts = p.program();
  return new Emitter(p.functions, filename, !!opts.cell).program(stmts, src);
}

/** A function file (found on the path) as Python defining its functions. */
export function matlabFunctionFileToPython(src: string): string {
  const p = new Parser(lex(src));
  const stmts = p.program();
  if (stmts.length) throw new MatlabSyntaxError("a function file has statements outside its functions", stmts[0].line, stmts[0].col);
  return new Emitter(p.functions, "").functionFile();
}

/** The functions a MATLAB file defines (its first is the file's own). */
export function matlabFunctions(src: string): string[] {
  const p = new Parser(lex(src));
  p.program();
  return p.functions.map((f) => f.name);
}

// (.m files are Magma's and MATLAB's: src/m-file.ts tells them apart)
export { looksLikeMagma } from "./m-file";

/**
 * Whether MATLAB text is incomplete, so that a console (Jupyter's
 * is_complete, the page's console) waits for more lines: it ends inside a
 * block (`if` without `end`), a bracket, a `...` continuation or a block
 * comment.  Text with a real syntax error is complete: running it reports
 * the error.
 */
export function matlabIsIncomplete(src: string): boolean {
  if (inBlockComment(src)) return true;
  try {
    const toks = lex(src);
    // (x = 1 ... parses, but its continuation says more follows)
    if (toks[toks.length - 1].cont) return true;
    new Parser(toks).program();
    return false;
  } catch (e) {
    return e instanceof MatlabSyntaxError && e.atEnd;
  }
}

/** A syntax error as MATLAB reports it (for stderr). */
export function matlabSyntaxMessage(e: MatlabSyntaxError, src: string, file: string): string {
  const line = src.split("\n")[e.line - 1] ?? "";
  const where = file.startsWith("<") ? `line ${e.line}` : `File: ${file} Line: ${e.line} Column: ${e.col}`;
  return `${where}\n${e.message}\n\n${line}\n${" ".repeat(Math.max(0, e.col - 1))}^\n`;
}

/**
 * The host operation the runtime uses to load a function file found on the
 * path (lib/_matlab_files.py): MATLAB text to Python text.  A syntax error
 * becomes Python that raises it, with its location.
 */
export function matlabHostOps(): Record<string, (...args: any[]) => any> {
  return {
    matlab_function_file(src: unknown, file: unknown) {
      const s = String(src), f = String(file);
      try {
        return matlabFunctionFileToPython(s);
      } catch (e) {
        if (!(e instanceof MatlabSyntaxError)) throw e;
        return `import _matlab as _m\nraise _m.MatlabError(${JSON.stringify(matlabSyntaxMessage(e, s, f).trimEnd())}, "MATLAB:syntax")\n`;
      }
    },
  };
}
