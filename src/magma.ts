// Magma -> Python.  A lexer and recursive-descent parser for the Magma
// language, emitting Python source that runs on lib/_magma.py (Magma's
// values, printing and intrinsics, over the Sagebrush engines).  The Python
// is compiled by the usual pipeline, so Magma programs run wherever pyjs
// does: the CLI (--magma), the notebook, Node, browsers.
//
// Semantics carried over: 1-based sequences with value semantics (copied on
// assignment), sets, tuples, exact rationals, `~x` reference arguments
// (procedures return their reference arguments), multiple return values
// (first value in an expression; all printed by an expression statement),
// `:=` and `op:=`, if/for/while/repeat/case, function/procedure/func<>,
// $$ recursion, select, &op reductions, comprehensions [e : x in S | c],
// ranges [a..b by c], R<x> := ... generator names, print/printf/error/assert.

export class MagmaSyntaxError extends Error {
  constructor(msg: string, public line: number, public col: number) {
    super(msg);
  }
}

// ------------------------------------------------------------------ lexer

type Tok = { t: "num" | "real" | "id" | "str" | "op" | "kw" | "eof"; v: string; line: number; col: number };

const KEYWORDS = new Set(
  ("and or not xor eq ne lt le gt ge in notin subset notsubset cat div mod join meet diff sdiff is cmpeq cmpne " +
    "if then elif else end for to by do while repeat until break continue function procedure func proc return " +
    "case when print printf error assert true false select where forward local quit exit vprint require delete assigned " +
    "intrinsic time eval declare clear").split(" "),
);

// longest first
const OPS = [":->", "+:=", "-:=", "*:=", "/:=", "^:=", ":=", "..", "->", "{@", "@}", "{*", "*}", "$$", "<", ">", "(", ")", "[", "]", "{", "}",
  ",", ";", ":", "|", "#", "&", "~", "+", "-", "*", "/", "^", ".", "!", "`", "@", "=", "\\"];

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 1, col = 1;
  const n = src.length;
  const adv = (k: number) => {
    for (let j = 0; j < k; j++) {
      if (src[i] === "\n") { line++; col = 1; } else col++;
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { adv(1); continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") adv(1); continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      adv((e < 0 ? n : e + 2) - i);
      continue;
    }
    const L = line, C = col;
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9]/.test(src[j])) j++;
      let real = false;
      // 1.5 (but not 1..5) and 1e10
      if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
        real = true;
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      if ((src[j] === "e" || src[j] === "E") && /[0-9+-]/.test(src[j + 1] ?? "") && (real || /[0-9]/.test(src[j + 1]) || /[0-9]/.test(src[j + 2] ?? ""))) {
        real = true;
        j += 2;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      out.push({ t: real ? "real" : "num", v: src.slice(i, j), line: L, col: C });
      adv(j - i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      out.push({ t: KEYWORDS.has(w) ? "kw" : "id", v: w, line: L, col: C });
      adv(j - i);
      continue;
    }
    if (c === "'" ) {
      // 'name': an identifier quoted (Magma allows any characters)
      const e = src.indexOf("'", i + 1);
      out.push({ t: "id", v: src.slice(i + 1, e), line: L, col: C });
      adv(e + 1 - i);
      continue;
    }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          const d = src[j + 1];
          s += d === "n" ? "\n" : d === "t" ? "\t" : d;
          j += 2;
        } else s += src[j++];
      }
      out.push({ t: "str", v: s, line: L, col: C });
      adv(j + 1 - i);
      continue;
    }
    if (src.startsWith("cat:=", i)) { out.push({ t: "op", v: "cat:=", line: L, col: C }); adv(5); continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new MagmaSyntaxError(`unexpected character '${c}'`, L, C);
    out.push({ t: "op", v: op, line: L, col: C });
    adv(op.length);
  }
  out.push({ t: "eof", v: "", line, col });
  return out;
}

// ------------------------------------------------------------------ parser -> Python

const PYKW = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global " +
  "if import in is lambda nonlocal not or pass raise return try while with yield print exec match case type").split(" "));

/** A Magma identifier as a Python one. */
export const pyName = (s: string) => (PYKW.has(s) || s.startsWith("_m") || /^__/.test(s) ? s + "_" : s);

interface Fn {
  name: string; // the Python function's name ($$)
  refs: string[]; // reference (~) parameters, returned by a procedure
  procedure: boolean;
}

class Parser {
  private i = 0;
  private out: string[] = [];
  private ind = "";
  private tmp = 0;
  private fns: Fn[] = [];
  private hoisted: string[][] = []; // definitions to emit before the current statement

  constructor(private toks: Tok[], private filename: string, private src = "") {}

  // -------- tokens
  peek(k = 0) { return this.toks[this.i + k]; }
  at(v: string, k = 0) { const t = this.peek(k); return (t.t === "op" || t.t === "kw") && t.v === v; }
  next() { return this.toks[this.i++]; }
  eat(v: string) { if (this.at(v)) { this.i++; return true; } return false; }
  expect(v: string) {
    const t = this.peek();
    if (!this.at(v)) this.fail(`expected '${v}' but found ${t.t === "eof" ? "end of input" : `'${t.v}'`}`);
    this.i++;
    return t;
  }
  fail(msg: string, t = this.peek()): never { throw new MagmaSyntaxError(msg, t.line, t.col); }
  ident() {
    const t = this.next();
    if (t.t !== "id") this.fail(`expected an identifier but found '${t.v}'`, t);
    return t.v;
  }
  fresh(base = "_mt") { return `${base}${++this.tmp}`; }

  // -------- output
  emit(line: string) { this.out.push(this.ind + line); }
  block(f: () => void) {
    const saved = this.ind;
    this.ind += "    ";
    const n = this.out.length;
    f();
    if (this.out.length === n) this.emit("pass");
    this.ind = saved;
  }

  // -------- program
  program(): string {
    this.emit("from _magma import *");
    this.emit("import _magma as _m");
    this.emit(`_m._source(${JSON.stringify(this.filename)}, ${JSON.stringify(this.toks.length ? this.src : "")})`);
    while (this.peek().t !== "eof") {
      const t = this.peek();
      // each top-level statement on its own, as Magma runs them: an error
      // is reported and the next statement runs
      this.emit("try:");
      this.block(() => {
        this.emit(`_m._here(${t.line}, ${t.col})`);
        this.statement(true);
      });
      this.emit("except Exception as _e:");
      this.block(() => this.emit(`_m._report(_e, ${t.line}, ${t.col})`));
    }
    return this.out.join("\n") + "\n";
  }

  globals = new Set<string>();

  statements(ends: string[]) {
    while (!ends.some((e) => this.at(e))) {
      if (this.peek().t === "eof") this.fail(`expected '${ends[0]}'`);
      this.statement(false);
    }
  }

  // Top-level statements become functions: their assignments must reach the
  // module (global x), except inside function bodies.
  private top = false;

  statement(top: boolean) {
    const saved = this.top;
    this.top = top || (this.top && this.fns.length === 0);
    const mark = this.out.length;
    const ind = this.ind;
    this.hoisted.push([]);
    try {
      this.stmt();
    } finally {
      const h = this.hoisted.pop()!;
      if (h.length) this.out.splice(mark, 0, ...h.map((l) => ind + l));
      this.top = saved;
    }
  }

  declareGlobal(_name: string) {
    // top-level code is module code: nothing to declare
  }

  stmt() {
    const t = this.peek();
    if (this.eat(";")) return;
    if (t.t === "kw") {
      switch (t.v) {
        case "if": return this.ifStmt();
        case "for": return this.forStmt();
        case "while": return this.whileStmt();
        case "repeat": return this.repeatStmt();
        case "case": return this.caseStmt();
        case "break": this.next(); if (this.peek().t === "id") this.next(); this.expect(";"); this.emit("break"); return;
        case "continue": this.next(); if (this.peek().t === "id") this.next(); this.expect(";"); this.emit("continue"); return;
        case "return": return this.returnStmt();
        case "print": return this.printStmt();
        case "printf": return this.printfStmt();
        case "vprint": this.next(); this.ident(); if (this.eat(",")) { this.expr(); } this.expect(":"); return this.printList("vprint");
        case "error": return this.errorStmt();
        case "assert": { this.next(); const e = this.expr(); this.expect(";"); this.emit(`_m._assert(${e})`); return; }
        case "function": case "procedure": return this.namedFunction();
        case "forward": this.next(); do this.ident(); while (this.eat(",")); this.expect(";"); return;
        case "local": this.next(); do this.ident(); while (this.eat(",")); this.expect(";"); return;
        case "delete": { this.next(); const v = pyName(this.ident()); this.expect(";"); this.declareGlobal(v); this.emit(`del ${v}`); return; }
        case "quit": case "exit": this.next(); this.eat(";"); this.emit("_m._quit()"); return;
        case "time": { this.next(); this.emit("_m._time_start()"); this.stmt(); this.emit("_m._time_end()"); return; }
      }
    }
    // assignment, op-assignment, procedure call or expression
    const start = this.i;
    const lhs = this.tryLhsList();
    if (lhs) {
      if (this.at(":=")) {
        this.next();
        return this.assign(lhs);
      }
      const opa = ["+:=", "-:=", "*:=", "/:=", "^:=", "cat:="].find((o) => this.at(o));
      if (opa && lhs.length === 1) {
        this.next();
        const e = this.expr();
        this.expect(";");
        const op = opa.slice(0, -2);
        const target = lhs[0];
        if (target.kind === "name") this.declareGlobal(target.py);
        const cur = target.read;
        const val = op === "+" ? `(${cur} + ${e})` : op === "-" ? `(${cur} - ${e})` : op === "*" ? `(${cur} * ${e})` : op === "/" ? `_m._div(${cur}, ${e})` : op === "^" ? `_m._pow(${cur}, ${e})` : `_m._cat(${cur}, ${e})`;
        this.store(target, val);
        return;
      }
      this.i = start;
    } else this.i = start;
    // a call with reference arguments: f(~x, y)
    const e = this.exprStatement();
    if (this.at(",") && !e.refs.length) {
      // a, b; prints the values on one line, as print a, b; does
      const vals = [e.code];
      while (this.eat(",")) vals.push(this.expr());
      this.expect(";");
      this.emit(`_m._print_line(_m._flat([${vals.join(", ")}]))`);
      return;
    }
    this.expect(";");
    if (e.refs.length) {
      const names = e.refs;
      for (const r of names) if (r.kind === "name") this.declareGlobal(r.py);
      const tmp = this.fresh();
      this.emit(`${tmp} = ${e.code}`);
      if (names.length === 1) this.store(names[0], `_m._ref1(${tmp})`);
      else names.forEach((r, k) => this.store(r, `_m._refk(${tmp}, ${k})`));
    } else {
      this.emit(`_m._show_values(${e.code})`);
    }
  }

  // ---- assignment targets
  tryLhsList(): Target[] | null {
    const save = this.i;
    try {
      return this.lhsList(save);
    } catch (e) {
      // not an assignment after all (L[2..3]; is an expression)
      if (!(e instanceof MagmaSyntaxError)) throw e;
      this.i = save;
      return null;
    }
  }

  lhsList(save: number): Target[] | null {
    const out: Target[] = [];
    while (true) {
      const t = this.tryLhs();
      if (!t) { this.i = save; return null; }
      out.push(t);
      if (!this.eat(",")) break;
    }
    if (!this.at(":=") && !["+:=", "-:=", "*:=", "/:=", "^:=", "cat:="].some((o) => this.at(o))) { this.i = save; return null; }
    return out;
  }

  tryLhs(): Target | null {
    const t = this.peek();
    if (t.t !== "id") return null;
    this.next();
    const name = t.v;
    // R<x, y> := ...
    if (this.at("<")) {
      const save = this.i;
      this.next();
      const gens: string[] = [];
      while (this.peek().t === "id") {
        gens.push(this.next().v);
        if (!this.eat(",")) break;
      }
      if (this.eat(">") && this.at(":=")) return { kind: "gens", py: pyName(name), gens: gens.map(pyName), names: gens, read: pyName(name) };
      this.i = save;
      return null;
    }
    let target: Target = { kind: "name", py: name === "_" ? "_m_discard" : pyName(name), read: pyName(name) };
    const path: string[] = [];
    while (this.at("[") || this.at("`")) {
      if (this.eat("`")) {
        const a = this.ident();
        path.push(`attr:${a}`);
        continue;
      }
      this.next();
      const idx = [this.expr()];
      while (this.eat(",")) idx.push(this.expr());
      this.expect("]");
      path.push(idx.length === 1 ? idx[0] : `_m.MTuple([${idx.join(", ")}])`);
    }
    if (path.length) target = { kind: "path", py: target.py, path, read: this.readPath(target.py, path) };
    return target;
  }

  readPath(base: string, path: string[]) {
    return path.reduce((acc, p) => (p.startsWith("attr:") ? `_m._getattr(${acc}, ${JSON.stringify(p.slice(5))})` : `_m._index(${acc}, ${p})`), base);
  }

  store(t: Target, val: string) {
    if (t.kind === "name") {
      this.declareGlobal(t.py);
      this.emit(`${t.py} = _m._own(${val})`);
    } else if (t.kind === "path") {
      this.declareGlobal(t.py);
      // x[i][j] := v: rebuild along the path (sequences have value semantics)
      const path = t.path!;
      const enc = path.map((p) => (p.startsWith("attr:") ? `("attr", ${JSON.stringify(p.slice(5))})` : `("idx", ${p})`)).join(", ");
      this.emit(`${t.py} = _m._assign_path(${t.py}, [${enc}], ${val})`);
    }
  }

  assign(lhs: Target[]) {
    // R<x> := PolynomialRing(...)
    if (lhs.length === 1 && lhs[0].kind === "gens") {
      const g = lhs[0];
      const e = this.expr();
      this.expect(";");
      this.declareGlobal(g.py);
      this.emit(`${g.py} = _m._first(${e})`);
      this.emit(`_m.AssignNames(${g.py}, ${JSON.stringify(g.names)})`);
      g.gens!.forEach((x, k) => { this.declareGlobal(x); this.emit(`${x} = _m._gen(${g.py}, ${k + 1})`); });
      return;
    }
    const e = this.exprStatement();
    this.expect(";");
    if (lhs.length === 1) {
      this.store(lhs[0], `_m._first(${e.code})`);
      return;
    }
    const tmp = this.fresh();
    this.emit(`${tmp} = _m._values(${e.code}, ${lhs.length})`);
    lhs.forEach((t, k) => { if (t.py !== "_m_discard") this.store(t, `${tmp}[${k}]`); });
  }

  // ---- control
  ifStmt() {
    this.expect("if");
    let c = this.expr();
    this.expect("then");
    this.emit(`if _m._bool(${c}):`);
    this.block(() => this.statements(["elif", "else", "end"]));
    while (this.eat("elif")) {
      // conditions may need hoisted helpers: evaluate them inside else
      c = this.expr();
      this.expect("then");
      this.emit(`elif _m._bool(${c}):`);
      this.block(() => this.statements(["elif", "else", "end"]));
    }
    if (this.eat("else")) {
      this.emit("else:");
      this.block(() => this.statements(["end"]));
    }
    this.expect("end");
    this.expect("if");
    this.expect(";");
  }

  forStmt() {
    this.expect("for");
    const v = pyName(this.ident());
    this.declareGlobal(v);
    if (this.eat(":=")) {
      const a = this.expr();
      this.expect("to");
      const b = this.expr();
      const by = this.eat("by") ? this.expr() : "1";
      this.expect("do");
      this.emit(`for ${v} in _m._to(${a}, ${b}, ${by}):`);
    } else {
      this.expect("in");
      const s = this.expr();
      this.expect("do");
      this.emit(`for ${v} in _m._iter(${s}):`);
    }
    this.block(() => this.statements(["end"]));
    this.expect("end");
    this.expect("for");
    this.expect(";");
  }

  whileStmt() {
    this.expect("while");
    const c = this.expr();
    this.expect("do");
    this.emit(`while _m._bool(${c}):`);
    this.block(() => this.statements(["end"]));
    this.expect("end");
    this.expect("while");
    this.expect(";");
  }

  repeatStmt() {
    this.expect("repeat");
    this.emit("while True:");
    this.block(() => {
      this.statements(["until"]);
      this.expect("until");
      const c = this.expr();
      this.expect(";");
      this.emit(`if _m._bool(${c}):`);
      this.block(() => this.emit("break"));
    });
  }

  caseStmt() {
    this.expect("case");
    const v = this.fresh();
    const e = this.expr();
    this.expect(":");
    this.emit(`${v} = ${e}`);
    let first = true;
    while (this.eat("when")) {
      const vals = [this.expr()];
      while (this.eat(",")) vals.push(this.expr());
      this.expect(":");
      this.emit(`${first ? "if" : "elif"} ${vals.map((x) => `_m._eq(${v}, ${x})`).join(" or ")}:`);
      first = false;
      this.block(() => this.statements(["when", "else", "end"]));
    }
    if (this.eat("else")) {
      this.eat(":");
      this.emit(first ? "if True:" : "else:");
      this.block(() => this.statements(["end"]));
    }
    this.expect("end");
    this.expect("case");
    this.expect(";");
  }

  returnStmt() {
    this.expect("return");
    const fn = this.fns[this.fns.length - 1];
    if (!fn) this.fail("return outside a function");
    const vals: string[] = [];
    if (!this.at(";")) {
      vals.push(this.expr());
      while (this.eat(",")) vals.push(this.expr());
    }
    this.expect(";");
    if (fn.procedure) this.emit(`return ${this.procReturn(fn)}`);
    else if (vals.length === 1) this.emit(`return ${vals[0]}`);
    else this.emit(`return _m.Multi([${vals.join(", ")}])`);
  }

  procReturn(fn: Fn) {
    return fn.refs.length === 0 ? "None" : fn.refs.length === 1 ? `_m.Ref1(${fn.refs[0]})` : `_m.RefK([${fn.refs.join(", ")}])`;
  }

  printList(kind: "print" | "vprint") {
    const vals = [this.expr()];
    while (this.eat(",")) vals.push(this.expr());
    // print x: Magma level; print x: Maximal etc. are ignored
    if (this.eat(":")) this.ident();
    this.expect(";");
    this.emit(`_m._print_line([${vals.map((v) => `_m._first(${v})`).join(", ")}])`);
  }

  printStmt() {
    this.expect("print");
    this.printList("print");
  }

  printfStmt() {
    this.expect("printf");
    const args = [this.expr()];
    while (this.eat(",")) args.push(this.expr());
    this.expect(";");
    this.emit(`_m._printf(${args.join(", ")})`);
  }

  errorStmt() {
    this.expect("error");
    if (this.eat("if")) {
      const c = this.expr();
      this.expect(",");
      const args = [this.expr()];
      while (this.eat(",")) args.push(this.expr());
      this.expect(";");
      this.emit(`if _m._bool(${c}): _m._error([${args.join(", ")}])`);
      return;
    }
    const args = [this.expr()];
    while (this.eat(",")) args.push(this.expr());
    this.expect(";");
    this.emit(`_m._error([${args.join(", ")}])`);
  }

  // ---- functions
  params(close: string): { py: string[]; refs: string[]; opts: string[] } {
    const py: string[] = [], refs: string[] = [], opts: string[] = [];
    if (!this.at(close) && !this.at(":")) {
      do {
        const ref = this.eat("~");
        const name = pyName(this.ident());
        // typed parameters: x :: RngIntElt
        if (this.at(":") && this.at(":", 1)) { this.next(); this.next(); this.ident(); }
        py.push(name);
        if (ref) refs.push(name);
      } while (this.eat(","));
    }
    if (this.eat(":")) {
      do {
        const name = pyName(this.ident());
        this.expect(":=");
        opts.push(`${name}=${this.expr()}`);
      } while (this.eat(","));
    }
    return { py, refs, opts };
  }

  /** function/procedure ... end function; as a Python def named `name`. */
  functionBody(kind: "function" | "procedure", name: string, explicitName = false) {
    this.expect("(");
    const p = this.params(")");
    this.expect(")");
    const fn: Fn = { name, refs: p.refs, procedure: kind === "procedure" };
    const lines: string[] = [];
    const saveOut = this.out, saveInd = this.ind;
    this.out = lines;
    this.ind = "";
    this.emit(`def ${name}(${[...p.py, ...(p.opts.length ? ["*", ...p.opts] : [])].join(", ")}):`);
    this.fns.push(fn);
    this.block(() => {
      // value semantics: arguments are the callee's own copies
      for (const v of p.py) if (!p.refs.includes(v)) this.emit(`${v} = _m._own(${v})`);
      this.statements(["end"]);
      if (fn.procedure) this.emit(`return ${this.procReturn(fn)}`);
    });
    this.fns.pop();
    this.expect("end");
    this.expect(kind);
    this.out = saveOut;
    this.ind = saveInd;
    return lines;
  }

  namedFunction() {
    const kind = this.next().v as "function" | "procedure";
    const name = pyName(this.ident());
    const lines = this.functionBody(kind, name, true);
    this.expect(";");
    for (const l of lines) this.emit(l);
    this.declareGlobal(name);
    this.emit(`${name} = _m._named(${name}, ${JSON.stringify(name)})`);
  }

  // ---- expressions: Python source strings
  exprStatement(): { code: string; refs: Target[] } {
    const refs: Target[] = [];
    this.refSink = refs;
    try {
      return { code: this.expr(), refs };
    } finally {
      this.refSink = null;
    }
  }
  private refSink: Target[] | null = null;

  expr(): string {
    return this.selectExpr();
  }

  selectExpr(): string {
    const c = this.orExpr();
    if (this.eat("select")) {
      const a = this.selectExpr();
      this.expect("else");
      const b = this.selectExpr();
      return `(${a} if _m._bool(${c}) else ${b})`;
    }
    return c;
  }

  orExpr(): string {
    let l = this.andExpr();
    while (this.at("or") || this.at("xor")) {
      const op = this.next().v;
      const r = this.andExpr();
      l = op === "or" ? `(_m._bool(${l}) or _m._bool(${r}))` : `(_m._bool(${l}) != _m._bool(${r}))`;
    }
    return l;
  }

  andExpr(): string {
    let l = this.notExpr();
    while (this.eat("and")) l = `(_m._bool(${l}) and _m._bool(${this.notExpr()}))`;
    return l;
  }

  notExpr(): string {
    if (this.eat("not")) return `(not _m._bool(${this.notExpr()}))`;
    return this.cmpExpr();
  }

  cmpExpr(): string {
    const l = this.catExpr();
    const ops: Record<string, string> = { eq: "_eq", ne: "_ne", lt: "_lt", le: "_le", gt: "_gt", ge: "_ge", in: "_in", notin: "_notin", subset: "_subset", notsubset: "_notsubset", cmpeq: "_cmpeq", cmpne: "_cmpne" };
    const t = this.peek();
    if (t.t === "kw" && ops[t.v]) {
      this.next();
      const r = this.catExpr();
      return `_m.${ops[t.v]}(${l}, ${r})`;
    }
    if (this.at("is")) this.fail("'is' is not supported");
    return l;
  }

  catExpr(): string {
    let l = this.addExpr();
    while (this.eat("cat")) l = `_m._cat(${l}, ${this.addExpr()})`;
    return l;
  }

  addExpr(): string {
    let l = this.mulExpr();
    while (true) {
      if (this.eat("+")) l = `(${l} + ${this.mulExpr()})`;
      else if (this.eat("-")) l = `(${l} - ${this.mulExpr()})`;
      else if (this.eat("join")) l = `_m._join(${l}, ${this.mulExpr()})`;
      else if (this.eat("diff")) l = `_m._diff(${l}, ${this.mulExpr()})`;
      else if (this.eat("sdiff")) l = `_m._sdiff(${l}, ${this.mulExpr()})`;
      else return l;
    }
  }

  mulExpr(): string {
    let l = this.unary();
    while (true) {
      if (this.eat("*")) l = `(${l} * ${this.unary()})`;
      else if (this.eat("/")) l = `_m._div(${l}, ${this.unary()})`;
      else if (this.eat("div")) l = `_m._idiv(${l}, ${this.unary()})`;
      else if (this.eat("mod")) l = `_m._mod(${l}, ${this.unary()})`;
      else if (this.eat("meet")) l = `_m._meet(${l}, ${this.unary()})`;
      else return l;
    }
  }

  unary(): string {
    if (this.eat("-")) return `(-${this.unary()})`;
    if (this.eat("+")) return this.unary();
    if (this.eat("#")) return `_m._card(${this.unary()})`;
    return this.power();
  }

  power(): string {
    const b = this.postfix();
    if (this.eat("^")) return `_m._pow(${b}, ${this.unary()})`;
    return b;
  }

  args(close: string): { code: string; refs: Target[] } {
    const pos: string[] = [], opts: string[] = [], refs: Target[] = [];
    if (!this.at(close) && !this.at(":")) {
      do {
        if (this.eat("~")) {
          const t = this.tryLhs();
          if (!t) this.fail("expected a variable after '~'");
          refs.push(t);
          pos.push(t.read);
        } else pos.push(this.expr());
      } while (this.eat(","));
    }
    if (this.eat(":")) {
      do {
        const name = pyName(this.ident());
        if (this.eat(":=")) opts.push(`${name}=${this.expr()}`);
        else opts.push(`${name}=True`);
      } while (this.eat(","));
    }
    return { code: [...pos, ...opts].join(", "), refs };
  }

  postfix(): string {
    let e = this.primary();
    while (true) {
      if (this.at("(")) {
        this.next();
        const a = this.args(")");
        this.expect(")");
        if (a.refs.length) {
          if (!this.refSink) this.fail("reference arguments (~x) are only allowed in a procedure call statement");
          this.refSink.push(...a.refs);
        }
        e = `${e}(${a.code})`;
      } else if (this.at("[")) {
        this.next();
        const idx = [this.expr()];
        if (this.eat("..")) {
          // L[a..b]: a subsequence
          const b = this.expr();
          const by = this.eat("by") ? this.expr() : "1";
          this.expect("]");
          e = `_m._index(${e}, _m._range(${idx[0]}, ${b}, ${by}, "["))`;
          continue;
        }
        while (this.eat(",")) idx.push(this.expr());
        this.expect("]");
        e = idx.length === 1 ? `_m._index(${e}, ${idx[0]})` : `_m._index(${e}, _m.MTuple([${idx.join(", ")}]))`;
      } else if (this.at(".") && this.peek(1).t === "num") {
        this.next();
        e = `_m._gen(${e}, ${this.next().v})`;
      } else if (this.at("`")) {
        this.next();
        e = `_m._getattr(${e}, ${JSON.stringify(this.ident())})`;
      } else if (this.at("!")) {
        this.next();
        e = `_m._coerce(${e}, ${this.unary()})`;
      } else if (this.at("@")) {
        this.next();
        e = `_m._apply(${this.unary()}, ${e})`;
      } else return e;
    }
  }

  primary(): string {
    const t = this.peek();
    if (t.t === "num") { this.next(); return t.v; }
    if (t.t === "real") { this.next(); return `_m._real(${JSON.stringify(t.v)})`; }
    if (t.t === "str") { this.next(); return JSON.stringify(t.v); }
    if (t.t === "id") { this.next(); return pyName(t.v); }
    if (this.eat("true")) return "True";
    if (this.eat("false")) return "False";
    if (this.eat("$$")) {
      const fn = this.fns[this.fns.length - 1];
      if (!fn) this.fail("$$ outside a function");
      return fn.name;
    }
    if (this.eat("(")) {
      const e = this.expr();
      if (this.eat(",")) {
        // (a, b): Magma has no tuples in parentheses, but allow it as a tuple
        const rest = [e, this.expr()];
        while (this.eat(",")) rest.push(this.expr());
        this.expect(")");
        return `_m.MTuple([${rest.join(", ")}])`;
      }
      this.expect(")");
      return `(${e})`;
    }
    if (this.at("[")) return this.collection("[", "]", "_m._seq");
    if (this.at("{")) return this.collection("{", "}", "_m._set");
    if (this.at("{@")) return this.collection("{@", "@}", "_m._iset");
    if (this.at("{*")) return this.collection("{*", "*}", "_m._mset");
    if (this.eat("<")) {
      const parts: string[] = [];
      if (!this.at(">")) {
        do parts.push(this.tupleElem()); while (this.eat(","));
      }
      this.expect(">");
      return `_m.MTuple([${parts.join(", ")}])`;
    }
    if (this.eat("&")) {
      // &+ S, &* S, &cat S, &and S, &or S, &join S, &meet S
      const op = this.next();
      const s = this.unary();
      return `_m._reduce(${JSON.stringify(op.v)}, ${s})`;
    }
    if (this.at("func") || this.at("proc")) {
      const kind = this.next().v;
      this.expect("<");
      const p = this.params("|");
      this.expect("|");
      if (kind === "func") {
        const body = this.expr();
        this.expect(">");
        return `(lambda ${[...p.py, ...(p.opts.length ? ["*", ...p.opts] : [])].join(", ")}: ${body})`;
      }
      this.fail("proc<...> is not supported yet");
    }
    if (this.at("function") || this.at("procedure")) {
      const kind = this.next().v as "function" | "procedure";
      const name = this.fresh("_mf");
      const lines = this.functionBody(kind, name);
      this.hoisted[this.hoisted.length - 1].push(...lines);
      return name;
    }
    if (this.at("-")) return this.unary();
    this.fail(t.t === "eof" ? "unexpected end of input" : `unexpected '${t.v}'`);
  }

  /** A tuple element: an expression up to , or > (no comparisons with > in Magma). */
  tupleElem(): string {
    return this.selectExpr();
  }

  /** [ ... ], { ... }: elements, a range a..b [by c], or a comprehension. */
  collection(open: string, close: string, ctor: string): string {
    this.expect(open);
    if (this.eat(close)) return `${ctor}([])`;
    let universe = "None";
    let first = this.expr();
    // [ U | ... ]: a universe
    if (this.at("|") && !this.at(close, 1)) {
      this.next();
      universe = first;
      if (this.eat(close)) return `${ctor}([], universe=${universe})`;
      first = this.expr();
    } else if (this.at("|") && this.at(close, 1)) {
      this.next();
      this.next();
      return `${ctor}([], universe=${first})`;
    }
    if (this.eat("..")) {
      const b = this.expr();
      const by = this.eat("by") ? this.expr() : "1";
      this.expect(close);
      return `_m._range(${first}, ${b}, ${by}, ${JSON.stringify(open)})`;
    }
    if (this.eat(":")) {
      // [ e : x in S, y in T | cond ]
      const loops: [string, string][] = [];
      do {
        const vars = [pyName(this.ident())];
        while (this.eat(",")) vars.push(pyName(this.ident()));
        this.expect("in");
        loops.push([vars.length === 1 ? vars[0] : `(${vars.join(", ")})`, this.expr()]);
      } while (this.eat(","));
      const cond = this.eat("|") ? this.expr() : null;
      this.expect(close);
      // the first variable varies fastest: the last loop is the outermost
      const gen = `${first} ${loops.reverse().map(([v, s]) => `for ${v} in _m._iter(${s})`).join(" ")}${cond ? ` if _m._bool(${cond})` : ""}`;
      return `${ctor}([${gen}], universe=${universe})`;
    }
    const elems = [first];
    while (this.eat(",")) elems.push(this.expr());
    this.expect(close);
    return `${ctor}([${elems.join(", ")}], universe=${universe})`;
  }
}

interface Target {
  kind: "name" | "path" | "gens";
  py: string;
  read: string;
  path?: string[];
  gens?: string[];
  names?: string[];
}

/** Magma source -> Python source (for lib/_magma.py). */
export function magmaToPython(src: string, filename = "<magma>"): string {
  return new Parser(lex(src), filename, src).program();
}
