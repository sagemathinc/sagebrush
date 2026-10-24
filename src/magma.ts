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

type Tok = { t: "num" | "real" | "id" | "str" | "op" | "kw" | "bad" | "eof"; v: string; line: number; col: number };

const KEYWORDS = new Set(
  ("and or not xor eq ne lt le gt ge in notin subset notsubset cat div mod join meet diff sdiff is cmpeq cmpne " +
    "if then elif else end for to by do while repeat until break continue function procedure func proc return " +
    "case when print printf error assert true false select where forward local quit exit vprint require delete assigned " +
    "intrinsic time eval declare clear").split(" "),
);

// longest first
const OPS = [":->", "@@", "+:=", "-:=", "*:=", "/:=", "^:=", ":=", "..", "->", "{@", "@}", "{*", "*}", "$$", "<", ">", "(", ")", "[", "]", "{", "}",
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
    if (!op) {
      // reported by the parser when it reaches it, so that the statements
      // before it still run (Magma parses one statement at a time)
      out.push({ t: "bad", v: c, line: L, col: C });
      adv(1);
      continue;
    }
    out.push({ t: "op", v: op, line: L, col: C });
    adv(op.length);
  }
  out.push({ t: "eof", v: "", line, col });
  return out;
}

// ------------------------------------------------------------------ parser -> Python

const PYKW = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global " +
  "if import in is lambda nonlocal not or pass raise return try while with yield print exec match case type").split(" "));

// Python's builtins (CPython 3.14's): a Magma name never reaches them.  An
// unassigned ord, len, sum or list is undeclared, as in Magma, not Python's
// function or class; lib/_magma.py's _PYBUILTINS is the same list.
export const PY_BUILTINS = new Set(("ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError " +
  "BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError " +
  "ConnectionError ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError Ellipsis " +
  "EncodingWarning EnvironmentError Exception ExceptionGroup False FileExistsError " +
  "FileNotFoundError FloatingPointError FutureWarning GeneratorExit IOError ImportError " +
  "ImportWarning IndentationError IndexError InterruptedError IsADirectoryError KeyError " +
  "KeyboardInterrupt LookupError MemoryError ModuleNotFoundError NameError None NotADirectoryError " +
  "NotImplemented NotImplementedError OSError OverflowError PendingDeprecationWarning " +
  "PermissionError ProcessLookupError PythonFinalizationError RecursionError ReferenceError " +
  "ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError " +
  "SyntaxWarning SystemError SystemExit TabError TimeoutError True TypeError UnboundLocalError " +
  "UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning " +
  "UserWarning ValueError Warning ZeroDivisionError abs aiter all anext any ascii bin bool " +
  "breakpoint bytearray bytes callable chr classmethod compile complex copyright credits delattr " +
  "dict dir divmod enumerate eval exec exit filter float format frozenset getattr globals hasattr " +
  "hash help hex id input int isinstance issubclass iter len license list locals map max memoryview " +
  "min next object oct open ord pow print property quit range repr reversed round set setattr slice " +
  "sorted staticmethod str sum super tuple type vars zip").split(" "));

/** A Magma identifier as a Python one. */
export const pyName = (s: string) => (PYKW.has(s) || PY_BUILTINS.has(s) || s.startsWith("_m") || /^__/.test(s) ? s + "_" : s);
/** The Magma name of a Python name made by pyName. */
const magmaName = (py: string) => (py.endsWith("_") && pyName(py.slice(0, -1)) === py ? py.slice(0, -1) : py);

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
  // a statement Magma rejects before running it ("User error: ..."): the
  // first such error of the current top-level statement
  private rejected: { line: number; col: number; msg: string } | null = null;

  reject(t: Tok, msg: string) {
    if (!this.rejected) this.rejected = { line: t.line, col: t.col, msg };
  }

  constructor(private toks: Tok[], private filename: string, private src = "", private recover: Recover | null = null) {
    // the names a witness of exists(t){ } or forall(t){ } may unassign
    // (Magma unassigns them when there is no witness): their reads check
    for (let k = 0; k + 2 < toks.length; k++) {
      if ((toks[k].v !== "exists" && toks[k].v !== "forall") || toks[k].t !== "id" || toks[k + 1].v !== "(") continue;
      let q = k + 2;
      const names: string[] = [];
      while (toks[q]?.t === "id" && (toks[q + 1]?.v === "," || toks[q + 1]?.v === ")")) {
        names.push(toks[q].v);
        q += 2;
        if (toks[q - 1].v === ")") break;
      }
      if (toks[q - 1]?.v === ")" && toks[q]?.v === "{") names.forEach((n) => this.witnesses.add(n));
    }
  }
  private witnesses = new Set<string>();
  // the witnesses a top-level statement assigns (with no witness, unassigns):
  // unbound when it ends, so that later cells, compiled on their own, don't
  // read the no-value marker (CORR-39D-1)
  private topWitnesses: string[] = [];

  // -------- tokens
  peek(k = 0) { return this.toks[this.i + k]; }
  at(v: string, k = 0) { const t = this.peek(k); return (t.t === "op" || t.t === "kw") && t.v === v; }
  next() { return this.toks[this.i++]; }
  eat(v: string) { if (this.at(v)) { this.i++; return true; } return false; }
  expect(v: string) {
    const t = this.peek();
    // A statement's ';' may be left off at the end of the input or of a line
    // (a notebook cell `a := 10`), as long as what follows cannot continue
    // the statement: the parse has already stopped before it.
    if (v === ";" && !this.at(v) && (t.t === "eof" || (this.i > 0 && t.line > this.toks[this.i - 1].line))) return t;
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

  /** A construct of Magma's that Sagebrush's parser doesn't have, among
   * the tokens of a statement up to its syntax error, and where: said
   * "not supported yet" rather than "bad syntax", which would say the code
   * is wrong (the coverage run's 254 Handbook programs). */
  unsupported(from: number, to: number): { name: string; tok: Tok } | null {
    const T = this.toks, end = Math.min(to + 1, T.length - 1);
    const next = (a: Tok, b: Tok) => b.line === a.line && b.col === a.col + a.v.length;
    for (let k = from; k <= end; k++) {
      const a = T[k], b = T[k + 1] ?? a, c = T[k + 2] ?? b;
      const found = (name: string) => ({ name, tok: a });
      // ($1 where an operand starts: 3 $ 4 is bad syntax, as Magma says)
      const operandBefore = k > from && (["num", "real", "id", "str"].includes(T[k - 1].t) || ")]}".includes(T[k - 1].v));
      if (a.v === "$" && b.t === "num" && !operandBefore) return found("$1 (the values printed last)");
      if (a.v === "$$" && T.slice(from, k).some((x) => x.v === "func")) return found("$$ in func< >");
      if (a.t === "id" && b.v === "<" && c.v === "[") return found(`${a.v}<[...]> (generator names in a sequence)`);
      if (a.t === "kw" && ["join", "meet", "cat", "diff", "sdiff", "div", "mod", "and", "or", "xor"].includes(a.v) && b.v === ":=") return found(`${a.v}:= (an assignment with ${a.v})`);
      if (a.v === "for" && b.t === "id" && c.v === ",") return found("for x, y in S (several loop variables)");
      if (a.v === "load" && a.t === "id" && k === from) return found("load (Magma's library files)");
      if (a.v === "for" && b.t === "id" && c.v === "in") {
        // for i in S, j in T do: several loops in one
        let depth = 0;
        for (let q = k + 3; q < T.length && T[q].v !== "do"; q++) {
          if ("([{<".includes(T[q].v)) depth++;
          else if (")]}>".includes(T[q].v)) depth--;
          else if (T[q].v === "," && depth === 0) return found("for i in S, j in T (several loops in one for)");
        }
      }
      if (a.t === "id" && b.v === "<" && k === from) {
        // S<y>, h := f(...): generator names, and other values
        let q = k + 2;
        while (q < T.length && T[q].v !== ">" && T[q].v !== ";") q++;
        if (T[q]?.v === ">" && T[q + 1]?.v === ",") return found(`${a.v}<...>, ... := (generator names with other values)`);
      }
      if (a.v === "." && (b.v === "-" || b.v === "<") && k > from && T[k - 1].t === "id") return found(b.v === "-" ? `${T[k - 1].v}.-1 (a generator's inverse by its index)` : `${T[k - 1].v}.<...> (an element by its indices)`);
      if (a.v === "=" && a.t === "op") return found("= (an equation, as in a relation)");
      if (a.v === "^" && b.v === "^" && next(a, b)) return found("a^^n (a multiplicity in a multiset)");
      if (a.v === ":" && b.t === "id" && ["Hex", "Magma", "Maximal", "Minimal", "Default"].includes(b.v)) return found(`x: ${b.v} (a printing level)`);
      if (a.v === "where" && a.t === "kw") return found("where x is ... (a definition after an expression)");
      if (a.v === "eval" && a.t === "kw") return found("eval");
      if (a.t === "id" && (a.v === "try" || a.v === "catch")) return found("try ... catch");
      if (a.v === ".." && b.v === "." && next(a, b)) return found("... (a function with a variable number of arguments)");
      if (a.v === "case" && b.v === "<") return found("case< ... >");
      if (a.v === "." && b.t === "id" && k > from && (T[k - 1].t === "id" || T[k - 1].v === ")" || T[k - 1].v === "]")) return found(`${T[k - 1].v}.${b.v} (a generator by a variable's index)`);
      if (a.v === "!" && b.v === "!" && next(a, b)) return found("!! (a coercion that may change the structure)");
      if (a.v === "\\") return found("\\ (a line continued)");
    }
    return null;
  }

  // The loops being parsed, innermost last (a function's body starts its
  // own): for `break x` / `continue x`, which leave or go on with the for
  // loop of x through the loops inside it.  Such a jump sets
  // _mlb = (target, 0 | 1) and breaks; after each loop it passes, the loop
  // around it breaks again, until the target's body, which takes it
  // (break, or continue).  `escapes`: the targets outside a loop that a jump
  // inside it is going to; `target`: whether a jump goes to this loop (it
  // then starts with _mlb = None).
  loops: { v: string | null; id: number; mark: number; ind: string; escapes: Set<number>; target: boolean }[] = [];
  loopIds = 0;
  loop(v: string | null, emitHead: () => void, body: () => void) {
    const L = { v, id: ++this.loopIds, mark: this.out.length, ind: this.ind, escapes: new Set<number>(), target: false };
    emitHead();
    this.loops.push(L);
    try {
      body();
    } finally {
      this.loops.pop();
    }
    if (L.escapes.size) {
      // (in the body of the loop around this one)
      const P = this.loops[this.loops.length - 1];
      for (const [k, word] of [[0, "break"], [1, "continue"]] as [number, string][]) {
        if (!L.escapes.has(P.id)) break;
        this.emit(`if _mlb == (${P.id}, ${k}):`);
        this.block(() => { this.emit("_mlb = None"); this.emit(word); });
      }
      const further = [...L.escapes].filter((t) => t !== P.id);
      if (further.length) {
        this.emit("if _mlb is not None:");
        this.block(() => this.emit("break"));
        for (const t of further) P.escapes.add(t);
      }
    }
    if (L.target) this.out.splice(L.mark, 0, L.ind + "_mlb = None");
  }
  /** break; continue; break x; continue x (x a for loop's variable). */
  jump(word: "break" | "continue") {
    const w = this.next();
    if (this.peek().t !== "id") {
      this.expect(";");
      this.emit(word);
      return;
    }
    const t = this.next();
    this.expect(";");
    const v = pyName(t.v);
    let j = this.loops.length - 1;
    while (j >= 0 && this.loops[j].v !== v) j--;
    if (j < 0) {
      this.reject(w, `Cannot do (${word} ${t.v}) since '${t.v}' is not a loop variable`);
      this.emit(word);
      return;
    }
    if (j === this.loops.length - 1) {
      this.emit(word);
      return;
    }
    const T = this.loops[j];
    T.target = true;
    this.loops[this.loops.length - 1].escapes.add(T.id);
    this.emit(`_mlb = (${T.id}, ${word === "break" ? 0 : 1})`);
    this.emit("break");
  }

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
    // (what a function captures for an intrinsic Sagebrush lacks: a read of it is an error, live())
    this.emit("from _magma import _UNDECLARED as _mU");
    // how errors behave at run time: stop (no recovery: notebook and kernel
    // cells, as before), "file" or "session" (lib/_magma.py _source)
    const mode = this.recover === null ? "" : `, ${JSON.stringify(this.recover)}`;
    this.emit(`_m._source(${JSON.stringify(this.filename)}, ${JSON.stringify(this.toks.length ? this.src : "")}${mode})`);
    while (this.peek().t !== "eof") {
      const t = this.peek();
      const i0 = this.i;
      const saved = { out: this.out, n: this.out.length, ind: this.ind, fns: this.fns.length };
      try {
        // each top-level statement on its own, as Magma runs them; what an
        // error does is up to _m._report (a file stops, a session goes on)
        this.rejected = null;
        this.topWitnesses = [];
        this.emit("try:");
        this.block(() => {
          this.emit(`_m._here(${t.line}, ${t.col})`);
          this.statement(true);
        });
        this.emit("except Exception as _e:");
        this.block(() => this.emit(`_m._report(_e, ${t.line}, ${t.col})`));
        if (this.rejected) {
          // Magma rejects the whole statement and goes on with the next one
          // (in a file too; a cell stops: lib/_magma.py _compile_error)
          const r = this.rejected as { line: number; col: number; msg: string };
          this.out.length = saved.n;
          this.emit(`_m._compile_error(${r.line}, ${r.col}, ${JSON.stringify(r.msg)})`);
        } else if (this.topWitnesses.length) {
          const names = [...new Set(this.topWitnesses)].map((n) => JSON.stringify(n)).join(", ");
          this.emit("finally:");
          this.block(() => this.emit(`_m._unset(globals(), [${names}])`));
        }
      } catch (e) {
        // (a construct Sagebrush doesn't have yet: said so, where it is)
        const u = e instanceof MagmaSyntaxError ? this.unsupported(i0, this.i) : null;
        // (the line the statement is dropped through, in a session: the error's)
        const errLine = e instanceof MagmaSyntaxError ? e.line : 0;
        if (u && e instanceof MagmaSyntaxError) {
          e.message = `${u.name} is not supported yet`;
          e.line = u.tok.line;
          e.col = u.tok.col;
        }
        if (!(e instanceof MagmaSyntaxError) || this.recover === null) throw e;
        // Magma's rule: the statements before a syntax error have run; the
        // error is reported; a file stops there, and a session drops the
        // statement and the rest of the line, and goes on with the next line
        this.out = saved.out;
        this.out.length = saved.n;
        this.ind = saved.ind;
        this.fns.length = saved.fns;
        const atEnd = this.peek().t === "eof" && e.line === this.peek().line && e.col === this.peek().col;
        this.emit(`_m._syntax_error(${atEnd ? 0 : e.line}, ${e.col}, ${JSON.stringify(e.message)}${u ? ", True" : ""})`);
        if (this.recover === "file" || atEnd) break;
        while (this.peek().t !== "eof" && this.peek().line <= Math.max(errLine, e.line)) this.i++;
      }
    }
    return this.out.join("\n") + "\n";
  }

  // The lexical scopes: 0 is the program, and each function body gets a
  // new id (a forward belongs to the scope it is declared in).
  private scopeCount = 0;
  private scopeIds: number[] = [0];
  private get scopeId() { return this.scopeIds[this.scopeIds.length - 1]; }

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
    if (!this.at("local")) this.localsOpen = false;
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

  declareGlobal(name: string, tok?: Tok, kind: "w" | "p" = "w") {
    // top-level code is module code: nothing to declare; inside a function
    // (or a rule) an assignment makes the name local, in the order the
    // reads and writes occur (see classify): "w" assigns the name, "p" an
    // element or field of it (x[i] := v), which needs x local already
    if (this.capturing) {
      this.assigned.push(name);
      this.uses.push({ name, bound: false, kind, tok: tok ?? this.peek() });
    }
  }

  // ---- free variables of map rules and functions
  // Magma's rule x :-> e, function, procedure and func< > take the values
  // their free variables have when they are made.  While one is parsed,
  // every variable read is recorded in `uses` and emitted as a placeholder,
  // and so is every assignment; each construct that binds names (a
  // comprehension, a nested rule, func< >, parameters) marks the reads in
  // its own scope as bound.  When it is done, its free names are taken in
  // the order they occur, as Magma does (checked against Magma 2.18):
  // - a name first read is imported: its value is captured when the rule
  //   or function is made (in a function an unassigned one is Magma's
  //   "Identifier 'a' has not been declared or assigned" there); a later
  //   `assigned name` or assignment to it is rejected ("Imported
  //   environment value 'a' cannot be used as a local");
  // - a name first assigned is a local: reads and `assigned` see it;
  // - a name first tested by `assigned`, never assigned, is a local with no
  //   value: `assigned` is false, a later read is "Variable 'a' has not
  //   been initialized", and a rule nested after it can't import it;
  // - a nested rule's or function's own reads don't count in the
  //   enclosing order, but its snapshot of a name imports it ("s").
  private capturing = 0;
  private ruleDepth = 0; // map rules being parsed (capturing counts functions too)
  private uses: { name: string; bound: boolean; kind: "r" | "a" | "s" | "w" | "p" | "l" | "d"; tok?: Tok; done?: boolean; res?: string; post?: string }[] = [];
  private assigned: string[] = [];

  /** A placeholder for a variable read inside a map rule or function
   * ("r"), for the test `assigned name` ("a", at token tok), or for a
   * nested rule's or function's snapshot of it ("s"), resolved by
   * resolveUses. */
  useVar(name: string, kind: "r" | "a" | "s" = "r", tok?: Tok): string {
    const k = this.uses.length;
    this.uses.push({ name, bound: false, kind, tok });
    return `\u0000${kind}${k}\u0000`;
  }

  /** Marks the reads uses[from, to) of the given names as bound. */
  bindUses(from: number, to: number, names: Iterable<string>) {
    const set = new Set(names);
    for (let k = from; k < to; k++) if (set.has(this.uses[k].name)) this.uses[k].bound = true;
  }

  /** The free variables (the snapshots to take) of a rule parsed by
   * `parse`, in the order of their first reads, besides the names in
   * `bound`; and its code with every placeholder resolved. */
  freeIn(parse: () => string, bound: string[]): { value: string; free: string[]; toks: Map<string, Tok> } {
    this.capturing++;
    this.ruleDepth++;
    const u0 = this.uses.length, a0 = this.assigned.length;
    let value: string;
    try {
      value = parse();
    } finally {
      this.capturing--;
      this.ruleDepth--;
    }
    const u1 = this.uses.length;
    const free = this.classify(u0, u1, bound, "rule");
    // where each free name is first read (for an undeclared one's error)
    const toks = new Map<string, Tok>();
    for (const n of free) {
      const t = this.uses.slice(u0, u1).find((u) => u.name === n && !u.bound && u.tok)?.tok;
      if (t) toks.set(n, t);
    }
    value = this.resolveUses(value, u0, u1);
    this.assigned.length = a0;
    if (!this.capturing) this.uses.length = 0;
    return { value, free, toks };
  }

  /** Resolves the uses[u0, u1) of one rule or function (its own: those of
   * nested ones are done already) in the order they occur, and returns
   * the names it imports.  In a rule a captured read checks for an
   * unassigned snapshot (_m._val); in a function the capture itself does,
   * so a read is the plain name. */
  classify(u0: number, u1: number, bound: string[], mode: "rule" | "fn"): string[] {
    this.bindUses(u0, u1, bound);
    const written = new Set<string>(), deleted = new Set<string>();
    for (let k = u0; k < u1; k++) {
      const u = this.uses[k];
      if (u.done || u.bound) continue;
      if (u.kind === "w" || u.kind === "p" || u.kind === "d") written.add(u.name);
      if (u.kind === "d") deleted.add(u.name);
    }
    const free: string[] = [];
    const state = new Map<string, "imported" | "local" | "unset">();
    const imported = (n: string, tok: Tok) => this.reject(tok, `Imported environment value '${magmaName(n)}' cannot be used as a local`);
    for (let k = u0; k < u1; k++) {
      const u = this.uses[k];
      if (u.done) continue; // a nested rule's or function's, resolved there
      u.done = true;
      const n = u.name, q = JSON.stringify(n), st = state.get(n);
      if (u.bound) {
        u.res = u.kind === "a" ? `_m._assigned_name(lambda: ${n})` : n;
        continue;
      }
      if (deleted.has(n)) {
        // deleted somewhere in the function: its local throughout (Magma's
        // `delete x` needs x seen first in the function)
        if (u.kind === "d" && st === undefined) this.reject(u.tok!, `Identifier '${magmaName(n)}' has not been declared or assigned`);
        state.set(n, "local");
        u.res = u.kind === "a" ? `_m._assigned_name(lambda: ${n})` : n;
        continue;
      }
      if (u.kind === "l") {
        // local x: the function's own; with no value unless it assigns it
        state.set(n, written.has(n) ? "local" : "unset");
        continue;
      }
      if (u.kind === "w" || u.kind === "p") {
        if (st === "imported") imported(n, u.tok!);
        else if (u.kind === "p" && st !== "local") this.reject(u.tok!, `Identifier '${magmaName(n)}' has not been declared or assigned`);
        state.set(n, "local");
        continue;
      }
      if (written.has(n) && st !== "imported") {
        // a local of this function (assigned in it): read as it is
        if (u.kind === "r" && st === undefined) {
          // read before any assignment: imported, and the assignment is
          // rejected when it comes
          state.set(n, "imported");
          if (!free.includes(n)) free.push(n);
          u.res = mode === "fn" ? this.live(n, u.tok) : this.ruleRead(n, u.tok);
          continue;
        }
        if (st === undefined) state.set(n, "local");
        u.res = u.kind === "a" ? `_m._assigned_name(lambda: ${n})` : n;
        continue;
      }
      if (u.kind === "a") {
        if (st === "imported") imported(n, u.tok!);
        else state.set(n, "unset");
        u.res = "False";
      } else if (st === "unset") {
        u.res = u.kind === "r" ? `_m._val(_m._UNSET, ${q})` : `_m._enclosing_unset(${q})`;
      } else {
        if (u.kind === "r") state.set(n, "imported");
        if (!free.includes(n)) free.push(n);
        u.res = u.kind === "r" ? (mode === "rule" ? this.ruleRead(n, u.tok) : this.live(n, u.tok)) : n;
      }
    }
    return free;
  }

  /** A function's read of a name it captures: the value, unless the
   * capture is an intrinsic Sagebrush lacks, whose read is the error, where
   * it is (lib/_magma.py _UNDECLARED; CORR-55A-1).  An identity test; the
   * error's arguments are built only when it is one. */
  live(n: string, tok?: Tok): string {
    return `(${n} if ${n} is not _mU else _m._missing(${JSON.stringify(n)}, ${tok ? `(${tok.line}, ${tok.col})` : "None"}))`;
  }

  /** A map rule's read of a name it captures (lib/_magma.py _val), with
   * where it is, for the error of an intrinsic Sagebrush lacks. */
  ruleRead(n: string, tok?: Tok): string {
    return `_m._val(${n}, ${JSON.stringify(n)}${tok ? `, (${tok.line}, ${tok.col})` : ""})`;
  }

  /** The placeholders of uses[u0, u1) in code, replaced by their
   * resolutions (freeIn). */
  resolveUses(code: string, u0: number, u1: number): string {
    return code.replace(/\u0000([ras])(\d+)\u0000/g, (m, _kind: string, ks: string) => {
      const k = Number(ks);
      return k < u0 || k >= u1 ? m : this.uses[k].res! + (this.uses[k].post ?? "");
    });
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
        case "break": return this.jump("break");
        case "continue": return this.jump("continue");
        case "return": return this.returnStmt();
        case "print": return this.printStmt();
        case "printf": return this.printfStmt();
        case "vprint": this.next(); this.ident(); if (this.eat(",")) { this.expr(); } this.expect(":"); return this.printList("vprint");
        case "error": return this.errorStmt();
        case "assert": { this.next(); const e = this.expr(); this.expect(";"); this.emit(`_m._assert(${e})`); return; }
        case "function": case "procedure": return this.namedFunction();
        case "forward": {
          // each execution binds the name to a fresh cell, an unresolved
          // forward (as in Magma, also when the name had a value); functions
          // made before the name's definition capture the cell, which the
          // next definition of the name in that scope fills (at the top
          // level also in a later input or notebook cell: _m._define_top)
          this.next();
          do {
            const t = this.peek();
            const n = pyName(this.ident());
            const cell = this.fresh("_mfw");
            this.emit(`${cell} = ${n} = _m._Cell(${JSON.stringify(n)})`);
            this.declareGlobal(cell, t);
            this.declareGlobal(n, t);
            this.forwards.set(n, { cell, scope: this.scopeId });
          } while (this.eat(","));
          this.expect(";");
          return;
        }
        case "local": {
          // local x, ...: only at the start of a function; x is the
          // function's own, with no value until assigned
          const lt = this.next();
          if (!this.fns.length || !this.localsOpen) throw new MagmaSyntaxError("'local' only at the start of a function", lt.line, lt.col);
          do {
            const t = this.peek();
            const n = pyName(this.ident());
            if (this.capturing) this.uses.push({ name: n, bound: false, kind: "l", tok: t });
          } while (this.eat(","));
          this.expect(";");
          return;
        }
        case "delete": {
          this.next();
          const target = this.tryLhs();
          if (!target || target.kind === "gens") this.fail("expected a variable or a record field after 'delete'");
          this.expect(";");
          const last = target.path?.[target.path.length - 1];
          if (last && last.kind === "idx") this.reject(last.tok, "Bad delete argument");
          // delete r`f: the field becomes unassigned (lib/_magma.py _DELETE)
          if (target.kind === "path") this.store(target, "_m._DELETE");
          else {
            // in a function the name is its local, for the whole function
            if (this.capturing) this.uses.push({ name: target.py, bound: false, kind: "d", tok: target.tok });
            this.emit(`del ${target.py}`);
          }
          return;
        }
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
        const ot = this.next();
        const e = this.expr();
        this.expect(";");
        const op = opa.slice(0, -2);
        const target = lhs[0];
        if (target.kind === "name") this.declareGlobal(target.py, target.tok);
        const cur = target.read;
        // an error points at the operator and is named after it ('+:=')
        const at = `(${ot.line}, ${ot.col}), ${JSON.stringify(opa)}`;
        const helper = { "+": "_add", "-": "_sub", "*": "_mul", "/": "_div", "^": "_pow" }[op];
        const val = helper ? `_m.${helper}(${cur}, ${e}, ${at})` : `_m._cat(${cur}, ${e})`;
        this.store(target, val);
        return;
      }
      this.i = start;
    } else this.i = start;
    // a call with reference arguments: f(~x, y)
    const e = this.exprStatement();
    if (this.at(",") && !e.refs.length) {
      // a, b; prints the values on one line, as print a, b; does
      const vals = [this.all(e.code)];
      while (this.eat(",")) vals.push(this.all(this.expr()));
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
      this.emit(`_m._show_values(${this.all(e.code)})`);
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
    let target: Target = { kind: "name", py: name === "_" ? "_m_discard" : pyName(name), read: pyName(name), name, tok: t };
    const path: PathEl[] = [];
    while (this.at("[") || this.at("`")) {
      if (this.at("`")) {
        path.push(this.field());
        continue;
      }
      const lb = this.next();
      const idx = [this.expr()];
      while (this.eat(",")) idx.push(this.expr());
      this.expect("]");
      // (A[i, j]: its indices together, never a tuple: A[<i, j>] is another
      // index, CORR-67F-1)
      path.push({ kind: "idx", code: idx.length === 1 ? idx[0] : `[${idx.join(", ")}]`, multi: idx.length > 1, tok: lb });
    }
    if (path.length) target = { kind: "path", py: target.py, path, read: this.readPath(target.py, path), tok: t };
    return target;
  }

  readPath(base: string, path: PathEl[]) {
    return path.reduce((acc, p) => (p.kind === "attr" ? `_m._getattr(${acc}, ${p.code}, (${p.line}, ${p.col}))` : p.multi ? `_m._index_multi(${acc}, ${p.code})` : `_m._index(${acc}, ${p.code})`), base);
  }

  /** `name or ``expr (the field name as a string), at the backtick. */
  field(): PathEl {
    const t = this.expect("`");
    // r``s: the field named by the string s
    const code = this.eat("`") ? this.primary() : JSON.stringify(this.ident());
    return { kind: "attr", code, line: t.line, col: t.col };
  }

  store(t: Target, val: string) {
    if (t.kind === "name") {
      this.declareGlobal(t.py, t.tok);
      // the name lets structures print as Magma does (2*C.1 = 0)
      this.emit(t.name ? `${t.py} = _m._own(${val}, ${JSON.stringify(t.name)})` : `${t.py} = _m._own(${val})`);
    } else if (t.kind === "path") {
      const p0 = t.path![0];
      this.declareGlobal(t.py, p0.kind === "idx" ? p0.tok : ({ line: p0.line, col: p0.col } as Tok), "p");
      // x[i][j] := v: rebuild along the path (sequences have value semantics)
      const path = t.path!;
      // (an index's "[": where an assignment Magma refuses is said, CORR-D689-1)
      const enc = path.map((p) => (p.kind === "attr" ? `("attr", ${p.code}, (${p.line}, ${p.col}))` : `("${p.multi ? "midx" : "idx"}", ${p.code}, (${p.tok.line}, ${p.tok.col}))`)).join(", ");
      this.emit(`${t.py} = _m._assign_path(${t.py}, [${enc}], ${val})`);
    }
  }

  assign(lhs: Target[]) {
    // (the := just read: where Magma puts a multiple assignment's error)
    const op = this.toks[this.i - 1];
    // R<x> := PolynomialRing(...)
    if (lhs.length === 1 && lhs[0].kind === "gens") {
      const g = lhs[0];
      const e = this.expr();
      this.expect(";");
      this.declareGlobal(g.py);
      this.emit(`${g.py} = _m._first(${e})`);
      this.emit(`_m._assign_gen_names(${g.py}, ${JSON.stringify(g.names)})`);
      g.gens!.forEach((x, k) => { this.declareGlobal(x); this.emit(`${x} = _m._gen(${g.py}, ${k + 1})`); });
      return;
    }
    const e = this.exprStatement();
    this.expect(";");
    if (lhs.length === 1) {
      this.store(lhs[0], `_m._first(${this.all(e.code)})`);
      return;
    }
    const tmp = this.fresh();
    this.emit(`${tmp} = _m._values(${this.all(e.code)}, ${lhs.length}, (${op.line}, ${op.col}))`);
    lhs.forEach((t, k) => {
      if (t.py === "_m_discard") return;
      if (t.kind !== "name") return this.store(t, `_m._present(${tmp}[${k}])`);
      // a missing return value (return x, _;) leaves the variable unassigned
      this.store(t, `${tmp}[${k}]`);
      this.emit(`if ${t.py} is _m._NOVAL: del ${t.py}`);
    });
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
      this.loop(v, () => this.emit(`for ${v} in _m._to(${a}, ${b}, ${by}):`), () => this.block(() => this.statements(["end"])));
    } else {
      this.expect("in");
      const s = this.expr();
      this.expect("do");
      this.loop(v, () => this.emit(`for ${v} in _m._iter(${s}):`), () => this.block(() => this.statements(["end"])));
    }
    this.expect("end");
    this.expect("for");
    this.expect(";");
  }

  whileStmt() {
    this.expect("while");
    const c = this.expr();
    this.expect("do");
    this.loop(null, () => this.emit(`while _m._bool(${c}):`), () => this.block(() => this.statements(["end"])));
    this.expect("end");
    this.expect("while");
    this.expect(";");
  }

  repeatStmt() {
    this.expect("repeat");
    this.loop(null, () => this.emit("while True:"), () => this.block(() => {
      this.statements(["until"]);
      this.expect("until");
      const c = this.expr();
      this.expect(";");
      this.emit(`if _m._bool(${c}):`);
      this.block(() => this.emit("break"));
    }));
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
    // _ is a missing value (lib/_magma.py _NOVAL), not a variable
    const val = () => {
      const t = this.peek();
      if (t.t === "id" && t.v === "_" && (this.at(",", 1) || this.at(";", 1))) {
        this.next();
        return "_m._NOVAL";
      }
      return this.expr();
    };
    if (!this.at(";")) {
      vals.push(val());
      while (this.eat(",")) vals.push(val());
    }
    this.expect(";");
    if (fn.procedure) this.emit(`return ${this.procReturn(fn)}`);
    else if (vals.length === 1) this.emit(`return ${this.all(vals[0])}`);
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
    // (each value's all, as for a, b; at a statement)
    this.emit(`_m._print_line(_m._flat([${vals.map((v) => this.all(v)).join(", ")}]))`);
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
  params(close: string): { py: string[]; refs: string[]; opts: string[]; optNames: string[] } {
    const py: string[] = [], refs: string[] = [], opts: string[] = [], optNames: string[] = [];
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
        optNames.push(name);
        opts.push(`${name}=${this.expr()}`);
      } while (this.eat(","));
    }
    return { py, refs, opts, optNames };
  }

  /** Names declared by `forward` and not defined yet: a function reads
   * them when it is called (the definition fills the cell, _m._FWD). */
  // forward f: name -> its cell's variable and the scope it was declared in
  private forwards = new Map<string, { cell: string; scope: number }>();
  private localsOpen = false; // a function's `local` declarations may still come

  /**
   * function/procedure ... end function; as a Python def named `name`.
   * Its free names are captured when the def runs (keyword-only default
   * arguments, copied): Magma's functions take their values when they are
   * made.  `own` is the function's Magma name, which its body reads as the
   * function itself (recursion).
   */
  functionBody(kind: "function" | "procedure", name: string, own?: string) {
    this.expect("(");
    const p = this.params(")");
    this.expect(")");
    const fn: Fn = { name, refs: p.refs, procedure: kind === "procedure" };
    let lines: string[] = [];
    const u0 = this.uses.length, a0 = this.assigned.length;
    const saveOut = this.out, saveInd = this.ind, saveLoops = this.loops;
    this.out = lines;
    this.ind = "";
    this.loops = [];
    this.emit("def"); // the signature, once the captures are known
    this.fns.push(fn);
    this.capturing++;
    this.scopeIds.push(++this.scopeCount);
    const saveForwards = new Map(this.forwards), saveLocals = this.localsOpen;
    this.localsOpen = true;
    try {
      this.block(() => {
        // value semantics: arguments are the callee's own copies
        for (const v of p.py) if (!p.refs.includes(v)) this.emit(`${v} = _m._own(${v})`);
        this.statements(["end"]);
        if (fn.procedure) this.emit(`return ${this.procReturn(fn)}`);
      });
    } finally {
      this.capturing--;
      this.fns.pop();
      this.scopeIds.pop();
      this.forwards = saveForwards;
      this.localsOpen = saveLocals;
      this.out = saveOut;
      this.ind = saveInd;
      this.loops = saveLoops;
    }
    this.expect("end");
    this.expect(kind);
    const u1 = this.uses.length;
    const locals = new Set<string>(); // the body's own variables (it assigns them)
    for (let k = u0; k < u1; k++) {
      const u = this.uses[k];
      if (!u.done && (u.kind === "w" || u.kind === "p" || u.kind === "l" || u.kind === "d")) locals.add(u.name);
    }
    for (let k = u0; k < u1; k++) {
      const u = this.uses[k];
      if (u.done || u.bound || locals.has(u.name) || (u.kind !== "r" && u.kind !== "s")) continue;
      // (a forward name is captured like a variable: it holds the cell)
      if (u.name === own) [u.res, u.done] = [name, true];
    }
    const free = this.classify(u0, u1, [...p.py, ...p.optNames], "fn");
    // the captures: a name not assigned when the function is made raises
    // here (Magma's compile-time error for the definition)
    const caps = free.map((n) => this.capture(n, u0, u1));
    const sig = [...p.py, ...(p.opts.length || caps.length ? ["*", ...p.opts, ...caps] : [])];
    lines[0] = `def ${name}(${sig.join(", ")}):`;
    lines = lines.map((l) => this.resolveUses(l, u0, u1));
    this.assigned.length = a0;
    if (!this.capturing) this.uses.length = 0;
    return lines;
  }

  /** A function's capture of the free name n (its uses are uses[u0, u1)):
   * a keyword-only default argument, taken when the function is made; a
   * name not assigned then is Magma's undeclared-identifier error at its
   * first read. */
  capture(n: string, u0: number, u1: number): string {
    const t = this.uses.slice(u0, u1).find((u) => u.name === n && !u.bound && u.tok)?.tok;
    const read = this.capturing ? this.useVar(n, "s") : n;
    return `${n}=_m._capture(lambda: ${read}, ${JSON.stringify(n)}${t ? `, (${t.line}, ${t.col})` : ", None"})`;
  }

  namedFunction() {
    const kind = this.next().v as "function" | "procedure";
    const t = this.peek();
    const name = pyName(this.ident());
    // a def name of its own, so that a later function of the same name
    // doesn't change what this one calls recursively
    const def = this.fresh("_mf");
    const lines = this.functionBody(kind, def, name);
    this.expect(";");
    lines.push(`_m._named(${def}, ${JSON.stringify(name)})`);
    // fills the cell of a forward of this name declared in the same scope;
    // at the top level, the unresolved forward the name holds (from a
    // forward in this input or an earlier one); a local definition never
    // fills an outer forward
    const fw = this.forwards.get(name);
    if (this.scopeId === 0) {
      this.forwards.delete(name);
      lines.push(`_m._define_top(globals(), ${JSON.stringify(name)}, ${def})`);
    } else if (fw && fw.scope === this.scopeId) {
      this.forwards.delete(name);
      lines.push(`${fw.cell}.set(${def})`);
    }
    for (const l of lines) this.emit(l);
    this.declareGlobal(name, t);
    this.emit(`${name} = ${def}`);
  }

  // ---- expressions: Python source strings
  // A call's several return values (return x, y;): in an expression, its
  // first (Magma's [ f(2) ], f(2) + 1, Abs(f(2))); all of them where the
  // call is all there is to a statement (f(2); and print f(2), 7;), to a
  // return, to func< >'s body, or to a multiple assignment's right side
  // (checked against Magma 2.18).  A call is emitted as _m._first(CALL),
  // and `calls` maps that text (and the text of it in parentheses) to the
  // bare call, for those contexts (all()).
  private calls = new Map<string, string>();
  all(code: string): string {
    return this.calls.get(code) ?? code;
  }

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
      // eq, ne, in and notin refuse values of different kinds, pointing at
      // the operator
      if (t.v !== "cmpeq" && t.v !== "cmpne") return `_m.${ops[t.v]}(${l}, ${r}, (${t.line}, ${t.col}))`;
      return `_m.${ops[t.v]}(${l}, ${r})`;
    }
    if (this.at("is")) this.fail("'is' is not supported");
    return l;
  }

  catExpr(): string {
    let l = this.addExpr();
    while (this.at("cat")) {
      const t = this.next();
      l = `_m._cat(${l}, ${this.addExpr()}, (${t.line}, ${t.col}))`;
    }
    return l;
  }

  // + - * / div mod ^ go through runtime helpers, which refuse what only
  // Python gives a meaning ("ab" * 3, [1] + [2], true + 1) with Magma's
  // error at the operator
  addExpr(): string {
    let l = this.mulExpr();
    while (true) {
      if (this.at("+") || this.at("-")) {
        const t = this.next();
        l = `_m.${t.v === "+" ? "_add" : "_sub"}(${l}, ${this.mulExpr()}, (${t.line}, ${t.col}))`;
      } else if (this.at("join") || this.at("diff") || this.at("sdiff")) {
        const t = this.next();
        l = `_m._${t.v}(${l}, ${this.mulExpr()}, (${t.line}, ${t.col}))`;
      }
      else return l;
    }
  }

  mulExpr(): string {
    let l = this.unary();
    while (true) {
      if (this.at("*") || this.at("/") || this.at("div") || this.at("mod")) {
        const t = this.next();
        const helper = { "*": "_mul", "/": "_div", div: "_idiv", mod: "_mod" }[t.v];
        l = `_m.${helper}(${l}, ${this.unary()}, (${t.line}, ${t.col}))`;
      } else if (this.at("meet")) {
        const t = this.next();
        l = `_m._meet(${l}, ${this.unary()}, (${t.line}, ${t.col}))`;
      }
      else return l;
    }
  }

  unary(): string {
    if (this.at("-")) {
      const t = this.next();
      const e = this.unary();
      return /^\d+$/.test(e) ? `(-${e})` : `_m._neg(${e}, (${t.line}, ${t.col}))`;
    }
    if (this.at("+")) {
      const t = this.next();
      const e = this.unary();
      return /^\d+$/.test(e) ? e : `_m._uplus(${e}, (${t.line}, ${t.col}))`;
    }
    if (this.eat("#")) return `_m._card(${this.unary()})`;
    return this.power();
  }

  power(): string {
    const b = this.postfix();
    if (this.at("^")) {
      const t = this.next();
      return `_m._pow(${b}, ${this.unary()}, (${t.line}, ${t.col}))`;
    }
    return b;
  }

  args(close: string): { code: string; refs: Target[]; refPos: number[] } {
    const pos: string[] = [], opts: string[] = [], refs: Target[] = [], refPos: number[] = [];
    if (!this.at(close) && !this.at(":")) {
      do {
        if (this.eat("~")) {
          const t = this.tryLhs();
          if (!t) this.fail("expected a variable after '~'");
          refs.push(t);
          refPos.push(pos.length);
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
    return { code: [...pos, ...opts].join(", "), refs, refPos };
  }

  postfix(): string {
    let e = this.primary();
    let chainAt = ""; // the first "[" of consecutive indexes
    let links = 0;
    while (true) {
      // a chain of calls and indexes nests its translation: past a limit it
      // is refused in words, before any host limit (HARD-A57-2)
      if ((this.at("(") || this.at("[")) && ++links > MAX_CHAIN) {
        this.reject(this.peek(), `a chain of more than ${MAX_CHAIN} calls or indexes is not supported yet`);
      }
      if (this.at("(")) {
        this.next();
        const a = this.args(")");
        this.expect(")");
        if (a.refs.length) {
          if (!this.refSink) this.fail("reference arguments (~x) are only allowed in a procedure call statement");
          this.refSink.push(...a.refs);
        }
        // a procedure statement's call: the callee is told which arguments
        // are references (_m._refcall), as AssignNames checks them
        if (a.refs.length) e = `_m._refcall(${e}, [${a.refPos.join(", ")}], ${a.code})`;
        else {
          const call = `${e}(${a.code})`;
          e = `_m._first(${call})`;
          this.calls.set(e, call);
        }
      } else if (this.at("[")) {
        // (its errors are said at the "[", as Magma does: in c[i][j], at
        // the first one)
        const lb = this.next();
        if (!(chainAt && this.toks[this.i - 2]?.v === "]")) chainAt = `(${lb.line}, ${lb.col})`;
        const at = chainAt;
        const idx = [this.expr()];
        if (this.at("..")) {
          // L[a..b]: a subsequence (a range of non-integers said at the ..)
          const dd = this.next();
          const b = this.expr();
          const by = this.eat("by") ? this.expr() : "1";
          this.expect("]");
          e = `_m._index(${e}, _m._range(${idx[0]}, ${b}, ${by}, "[", None, (${dd.line}, ${dd.col})), ${at})`;
          continue;
        }
        while (this.eat(",")) idx.push(this.expr());
        this.expect("]");
        // (S[i, j]: its own helper, as S[<i, j>], a tuple index, is refused)
        e = idx.length === 1 ? `_m._index(${e}, ${idx[0]}, ${at})` : `_m._index_multi(${e}, [${idx.join(", ")}], ${at})`;
      } else if (this.at(".") && this.peek(1).t === "num") {
        this.next();
        e = `_m._gen(${e}, ${this.next().v})`;
      } else if (this.at("`")) {
        const f = this.field() as { code: string; line: number; col: number };
        e = `_m._getattr(${e}, ${f.code}, (${f.line}, ${f.col}))`;
      } else if (this.at("!")) {
        const t = this.next();
        e = `_m._coerce(${e}, ${this.unary()}, (${t.line}, ${t.col}))`;
      } else if (this.at("@")) {
        this.next();
        e = `_m._apply(${this.unary()}, ${e})`;
      } else if (this.at("@@")) {
        // y @@ f: the preimage
        const op = this.next();
        e = `_m._preimage(${this.unary()}, ${e}, (${op.line}, ${op.col}))`;
      } else return e;
    }
  }

  primary(): string {
    const t = this.peek();
    if (t.t === "num") { this.next(); return t.v; }
    if (t.t === "real") { this.next(); return `_m._real(${JSON.stringify(t.v)})`; }
    if (t.t === "str") { this.next(); return JSON.stringify(t.v); }
    if (t.t === "id" && (t.v === "exists" || t.v === "forall") && this.quantifierAhead()) return this.quantifier();
    if (t.t === "id" && this.at("<", 1)) return this.ctorExpr();
    if (t.t === "id") {
      this.next();
      const n = pyName(t.v);
      const r = this.capturing ? this.useVar(n, "r", t) : n;
      // (a witness exists(t){ } may have unassigned: Magma's error, not its old value)
      return this.witnesses.has(t.v) ? `_m._wread(${r}, ${JSON.stringify(n)}, (${t.line}, ${t.col}), ${this.fns.length ? "True" : "False"})` : r;
    }
    if (this.at("assigned")) return this.assignedExpr(this.next());
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
      // ((f(2)); is all of f(2)'s values, as f(2); is)
      if (this.calls.has(e)) this.calls.set(`(${e})`, `(${this.calls.get(e)})`);
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
    if (this.at("&")) {
      // &+ S, &* S, &cat S, &and S, &or S, &join S, &meet S
      const amp = this.next();
      const op = this.next();
      const s = this.unary();
      return `_m._reduce(${JSON.stringify(op.v)}, ${s}, (${amp.line}, ${amp.col}))`;
    }
    if (this.at("func") || this.at("proc")) {
      const kind = this.next().v;
      this.expect("<");
      const p = this.params("|");
      this.expect("|");
      if (kind === "func") {
        // its free names are captured when it is made, as a function's
        this.capturing++;
        const b0 = this.uses.length;
        let body: string;
        try {
          body = this.expr();
        } finally {
          this.capturing--;
        }
        const b1 = this.uses.length;
        const free = this.classify(b0, b1, [...p.py, ...p.optNames], "fn");
        // (all of a call's values first: its text as the call was emitted)
        body = this.resolveUses(this.all(body), b0, b1);
        const caps = free.map((n) => this.capture(n, b0, b1));
        if (!this.capturing) this.uses.length = 0;
        this.expect(">");
        const sig = [...p.py, ...(p.opts.length || caps.length ? ["*", ...p.opts, ...caps] : [])];
        return `(lambda ${sig.join(", ")}: ${body})`;
      }
      this.fail("proc<...> is not supported yet");
    }
    if (this.at("function") || this.at("procedure")) {
      const ft = this.peek();
      const kind = this.next().v as "function" | "procedure";
      const name = this.fresh("_mf");
      const lines = this.functionBody(kind, name);
      if (this.ruleDepth) {
        // its definition would be hoisted out of the rule and read later
        // globals: refuse rather than capture wrongly
        return `_m._not_supported("a function expression inside a map rule", (${ft.line}, ${ft.col}))`;
      }
      this.hoisted[this.hoisted.length - 1].push(...lines);
      return name;
    }
    if (this.at("-")) return this.unary();
    this.fail(t.t === "eof" ? "unexpected end of input" : `unexpected '${t.v}'`);
  }

  /**
   * name< ... >: a constructor (Magma has no `<` operator, so an identifier
   * followed by `<` always starts one).  Records are implemented; the
   * others (sub, quo, ext, ideal, map, hom, Group, ...) are parsed and
   * raise a runtime error until Sagebrush has them.
   */
  ctorExpr(): string {
    const t = this.next();
    const lt = this.expect("<");
    const pos = `(${t.line}, ${t.col})`;
    if (t.v === "recformat") {
      // recformat< name, name : structure or category, ... > (also empty)
      const fields: string[] = [];
      const names = new Set<string>();
      if (!this.at(">")) {
        do {
          const nt = this.peek();
          const name = this.ident();
          if (names.has(name)) this.reject(nt, `Field '${name}' is repeated`);
          names.add(name);
          fields.push(`(${JSON.stringify(name)}, ${this.eat(":") ? this.expr() : "None"})`);
        } while (this.eat(","));
      }
      this.expect(">");
      return `_m._recformat([${fields.join(", ")}], ${pos})`;
    }
    if (t.v === "rec") {
      // rec< F | name := value, ... >
      const fmt = this.expr();
      this.expect("|");
      const assigns: string[] = [];
      if (!this.at(">")) {
        do {
          const name = this.ident();
          this.expect(":=");
          assigns.push(`(${JSON.stringify(name)}, ${this.expr()})`);
        } while (this.eat(","));
      }
      this.expect(">");
      return `_m._rec(${fmt}, [${assigns.join(", ")}], ${pos})`;
    }
    if (t.v === "map" || t.v === "pmap" || t.v === "hom") {
      // Magma points at the '<' of a map constructor (at the name of rec< >)
      const m = this.mapCtor(t.v, `(${lt.line}, ${lt.col})`);
      if (m !== null) return m;
    }
    if (t.v === "ext") {
      // ext< F | k, ... >: lib/_magma.py _ext checks the right-hand side
      // (Magma points at the '<')
      const start = this.i;
      const base = this.expr();
      if (this.eat("|")) {
        const args: string[] = [];
        do {
          args.push(this.expr());
        } while (this.eat(","));
        this.expect(">");
        return `_m._ext(${base}, [${args.join(", ")}], (${lt.line}, ${lt.col}))`;
      }
      this.i = start;
    }
    // not implemented yet: skip to the matching '>' (tuples and nested
    // constructors are the only other uses of < and >)
    let depth = 1;
    while (depth > 0) {
      const k = this.next();
      if (k.t === "eof") this.fail("unexpected end of input", k);
      if (k.t === "op" && k.v === "<") depth++;
      else if (k.t === "op" && k.v === ">") depth--;
    }
    return `_m._unsupported(${JSON.stringify(t.v)}, ${pos})`;
  }

  /**
   * map< A -> B | x :-> e(x) [, y :-> i(y)] >, map< A -> B | graph > (a
   * set or sequence of pairs) and map< A -> B | x -> y, ... >; the same for
   * pmap, and hom with a rule.  Null (with the position restored) for the
   * forms not implemented yet, such as hom< ... > by images of generators.
   */
  mapCtor(kind: string, pos: string): string | null {
    const start = this.i;
    const dom = this.expr();
    this.expect("->");
    const cod = this.expr();
    this.expect("|");
    if (this.peek().t === "id" && this.at(":->", 1)) {
      const rule = (): string => {
        const v = pyName(this.ident());
        this.expect(":->");
        // Magma's rule takes the values its free variables have when the
        // map is made (a later a := 10 doesn't change it): they are bound
        // as default arguments, copied (value semantics)
        const { value: body, free, toks } = this.freeIn(() => this.expr(), [v]);
        // the snapshot: the value (a name not assigned is Magma's
        // undeclared-identifier error where it is first read); in an
        // enclosing rule, the name read is that rule's own snapshot
        const snap = (n: string) => {
          const t = toks.get(n);
          return `${n}=_m._snap(lambda: ${this.capturing ? this.useVar(n, "s") : n}, ${JSON.stringify(n)}, ${t ? `(${t.line}, ${t.col})` : "None"})`;
        };
        return `lambda ${[v, ...free.map(snap)].join(", ")}: ${body}`;
      };
      const r = rule();
      const inv = this.eat(",") ? rule() : "None";
      this.expect(">");
      return `_m._map(${JSON.stringify(kind)}, ${dom}, ${cod}, rule=${r}, inv=${inv}, pos=${pos})`;
    }
    if (kind === "hom") {
      this.i = start;
      return null;
    }
    const first = this.expr();
    if (this.eat("->")) {
      const pairs = [`(${first}, ${this.expr()})`];
      while (this.eat(",")) {
        const a = this.expr();
        this.expect("->");
        pairs.push(`(${a}, ${this.expr()})`);
      }
      this.expect(">");
      return `_m._map(${JSON.stringify(kind)}, ${dom}, ${cod}, pairs=[${pairs.join(", ")}], pos=${pos})`;
    }
    this.expect(">");
    return `_m._map(${JSON.stringify(kind)}, ${dom}, ${cod}, graph=${first}, pos=${pos})`;
  }

  /** assigned x, assigned r`f, assigned s[i]. */
  assignedExpr(kw: Tok): string {
    // assigned r`f: the record r is read before anything in the path (a
    // computed field r``e), in the order free names are taken (classify)
    const id = this.peek();
    const baseUse = this.capturing && id.t === "id" && (this.at("`", 1) || this.at("[", 1)) ? this.useVar(pyName(id.v), "r", id) : null;
    const t = this.tryLhs();
    if (!t || t.kind === "gens") this.fail("expected a variable after 'assigned'");
    if (t.kind === "name") return this.capturing ? this.useVar(t.py, "a", kw) : `_m._assigned_name(lambda: ${t.read})`;
    const path = t.path!;
    const last = path[path.length - 1];
    const base = this.readPath(baseUse ?? (this.capturing ? this.useVar(t.py) : t.py), path.slice(0, -1));
    if (last.kind === "idx") {
      this.reject(kw, "Argument to 'assigned' should be identifier, record field, or attribute");
      return "None";
    }
    return `_m._assigned(${base}, ${last.code})`;
  }

  /** A tuple element: an expression up to , or > (no comparisons with > in Magma). */
  tupleElem(): string {
    return this.selectExpr();
  }

  /** A comprehension's clauses after its ":" (x in S, y, z in T | cond) up
   * to `close`: its loops as Python's (the last clause the outermost: the
   * first variable varies fastest), and its condition.  h0: where the
   * head's uses begin (its loop variables are bound there).  collect: it
   * builds a collection (not a quantifier's test), so that x, y in S
   * without a condition admits #S^2 elements before iterating
   * (HARD-FCC-1). */
  comprehension(h0: number, close: string, collect = false): { loops: string; cond: string | null } {
    const h1 = this.uses.length;
    const loops: ((cond: boolean) => string)[] = [];
    const bound: string[] = [];
    const sets: { vars: string[]; from: number; to: number }[] = [];
    do {
      const vars = [pyName(this.ident())];
      while (this.eat(",")) vars.push(pyName(this.ident()));
      bound.push(...vars);
      this.expect("in");
      const from = this.uses.length;
      const set = this.expr();
      // x, y in S: each over S (evaluated once), x the outer loop, as
      // Magma does ([ <a, b> : a, b in [1..2] ] is <1,1>, <1,2>, <2,1>, <2,2>)
      if (vars.length === 1) loops.push(() => `for ${vars[0]} in _m._iter(${set})`);
      else {
        const t = this.fresh();
        const k = vars.length;
        loops.push((cond) => [`for ${t} in (${collect && !cond ? `_m._admit_power(${set}, ${k})` : set},)`, ...vars.map((v) => `for ${v} in _m._iter(${t})`)].join(" "));
      }
      sets.push({ vars, from, to: this.uses.length });
    } while (this.eat(","));
    const c0 = this.uses.length;
    const cond = this.eat("|") ? this.expr() : null;
    // the loop variables are bound in the head and the condition; a set
    // sees the variables of the loops after it (they are the outer
    // loops), not its own or those before it
    this.bindUses(h0, h1, bound);
    this.bindUses(c0, this.uses.length, bound);
    sets.forEach((st, k) => this.bindUses(st.from, st.to, sets.slice(k + 1).flatMap((t) => t.vars)));
    this.expect(close);
    return { loops: loops.map((l) => l(cond !== null)).reverse().join(" "), cond };
  }

  /** exists{ ... } or forall{ ... }, or with witnesses, exists(t){ ... }
   * (not a call exists(t) of a function of that name). */
  quantifierAhead(): boolean {
    if (this.at("{", 1)) return true;
    if (!this.at("(", 1)) return false;
    let k = this.i + 2;
    while (this.toks[k]?.t === "id" && this.toks[k + 1]?.v === ",") k += 2;
    return this.toks[k]?.t === "id" && this.toks[k + 1]?.v === ")" && this.toks[k + 2]?.v === "{";
  }

  /** exists{ e : x in S | P }: whether some x satisfies P; forall{ ... }:
   * whether all do (true for none).  exists(t){ ... } also assigns the
   * first e that does to t, and forall(t){ ... } the first that doesn't;
   * exists(u, v){ <a, b> : ... } assigns the tuple's parts.  With none, the
   * witnesses aren't assigned.  As Magma 2.18 does. */
  quantifier(): string {
    const kw = this.next().v;
    const wit: Tok[] = [];
    if (this.eat("(")) {
      do {
        const w = this.peek();
        this.ident();
        wit.push(w);
      } while (this.eat(","));
      this.expect(")");
    }
    this.expect("{");
    const h0 = this.uses.length;
    const head = this.expr();
    this.expect(":");
    const { loops, cond } = this.comprehension(h0, "}");
    const test = cond ? `_m._bool(${cond})` : "True";
    if (!wit.length) return `${kw === "exists" ? "any" : "all"}(${test} ${loops})`;
    // the first witness (in a 1-tuple, so that any value is one), assigned
    // with := in the expression, only when there is one
    const t = this.fresh();
    const found = `(${t} := _m._witness(((${head},) ${loops} if ${kw === "exists" ? test : `not ${test}`})))`;
    const names = wit.map((w) => pyName(w.v));
    names.forEach((n, k) => this.declareGlobal(n, wit[k]));
    if (this.fns.length === 0) this.topWitnesses.push(...names);
    const assign = names.map((n, k) => `(${n} := ${names.length === 1 ? `${t}[0]` : `_m._index(${t}[0], ${k + 1})`})`).join(", ");
    // (no witness: they are unassigned, as in Magma, not left with old values)
    const unassign = names.map((n) => `(${n} := _m._NOVAL)`).join(", ");
    return kw === "exists"
      ? `((${found} is not None and (${assign}, True)[-1]) or (${unassign}, False)[-1])`
      : `((${found} is None and (${unassign}, True)[-1]) or (${assign}, False)[-1])`;
  }

  /** [ ... ], { ... }: elements, a range a..b [by c], or a comprehension. */
  collection(open: string, close: string, ctor: string): string {
    const ot = this.peek();
    this.expect(open);
    if (this.eat(close)) return `${ctor}([])`;
    let universe = "None";
    let h0 = this.uses.length;
    let first = this.expr();
    // [ U | ... ]: a universe
    if (this.at("|") && !this.at(close, 1)) {
      this.next();
      universe = first;
      if (this.eat(close)) return `${ctor}([], universe=${universe})`;
      h0 = this.uses.length;
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
      // ([ U | a..b ]: the universe too, which Magma checks)
      return `_m._range(${first}, ${b}, ${by}, ${JSON.stringify(open)}, ${universe}, (${ot.line}, ${ot.col}))`;
    }
    if (this.eat(":")) {
      // [ e : x in S, y in T | cond ]
      // (its elements through one bounded collector (HARD-FCC-1))
      const { loops, cond } = this.comprehension(h0, close, true);
      return `${ctor}(_m._collect((${first} ${loops}${cond ? ` if _m._bool(${cond})` : ""})), universe=${universe})`;
    }
    // x -> y: an arrow pair, as in a map's graph [ 1 -> 30, 2 -> 20 ]
    const arrow = (e: string) => (this.eat("->") ? `_m.MTuple([${e}, ${this.expr()}])` : e);
    const elems = [arrow(first)];
    while (this.eat(",")) elems.push(arrow(this.expr()));
    this.expect(close);
    return `${ctor}([${elems.join(", ")}], universe=${universe})`;
  }
}

/** The most calls and indexes one chain such as S[1][2](x) may have. */
const MAX_CHAIN = 64;

/** A step of an assignment target: x`f (code: the field name's Python) or x[i]. */
type PathEl = { kind: "attr"; code: string; line: number; col: number } | { kind: "idx"; code: string; tok: Tok; multi?: boolean };

interface Target {
  kind: "name" | "path" | "gens";
  py: string;
  read: string;
  tok?: Tok; // the name's token
  path?: PathEl[];
  gens?: string[];
  names?: string[];
  name?: string;
}

/**
 * How a syntax error is handled.  Without one, magmaToPython throws
 * MagmaSyntaxError and nothing runs.  With "file" (a program file) the
 * statements before the error run, then the error is reported and the
 * program stops; with "session" (input from stdin, like Magma's interactive
 * session) the statement and the rest of its line are dropped and the input
 * goes on, and a runtime error does not stop it either (lib/_magma.py).
 */
export type Recover = "file" | "session";

/** Magma source -> Python source (for lib/_magma.py). */
export function magmaToPython(src: string, filename = "<magma>", opts: { recover?: Recover } = {}): string {
  return new Parser(lex(src), filename, src, opts.recover ?? null).program();
}
