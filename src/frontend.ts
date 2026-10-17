// Front end: Python source -> the compiler's AST (src/ast.ts), via pyparse,
// which is CPython 3.14's own grammar generated in TypeScript.  Syntax
// errors therefore match CPython exactly (message, line, offset, end).

import { preparse } from "./sagepre";
import * as A from "./ast";
import { parse as pyparse, PegenError } from "../pyparse/src/index";
import { PySingleton } from "../pyparse/src/helpers";
import { PyComplex } from "../pyparse/src/pegen";
import { unparse, UnparseUnsupported } from "./unparse";

export class PySyntaxError extends Error {
  constructor(
    public msg: string,
    public filename: string,
    public lineno: number,
    public text: string,
    public offset: number | null = null,
    public end_lineno: number | null = null,
    public end_offset: number | null = null,
    public type: string = "SyntaxError"
  ) {
    super(msg);
  }
}

const BIN: Record<string, string> = {
  Add: "+", Sub: "-", Mult: "*", MatMult: "@", Div: "/", Mod: "%", Pow: "**", LShift: "<<",
  RShift: ">>", BitOr: "|", BitXor: "^", BitAnd: "&", FloorDiv: "//",
};
const UNARY: Record<string, string> = { Invert: "~", Not: "not", UAdd: "+", USub: "-" };
const CMP: Record<string, string> = {
  Eq: "==", NotEq: "!=", Lt: "<", LtE: "<=", Gt: ">", GtE: ">=", Is: "is", IsNot: "is not", In: "in", NotIn: "not in",
};

/** Parse `source` (mode "exec" or "eval") into the compiler's Module. */
/** opts.sage: Sage syntax (`^` is `**`, `^^` is xor, int/int is a Rational). */
/** opts.transform: changes pyparse's tree (CPython's AST) before it is lowered (the reactive notebook's renaming of a cell's `_` names). */
export function parse(source: string, filename: string, mode: "exec" | "eval" = "exec", opts: { sage?: boolean; transform?: (tree: any) => void } = {}): A.Module {
  if (opts.sage) source = preparse(source);
  const lines = source.split("\n");
  let tree: any;
  try {
    tree = pyparse(source, mode, { sage: opts.sage });
  } catch (e) {
    if (e instanceof PegenError) {
      const i = e.info;
      throw new PySyntaxError(i.msg, filename, i.lineno, (i.text ?? lines[i.lineno - 1] ?? ""), i.offset, i.end_lineno, i.end_offset, i.type);
    }
    throw e;
  }
  opts.transform?.(tree);
  const c = new Convert(filename, lines, !!opts.sage);
  if (mode === "eval") return { body: [{ k: "Expr", line: tree.body.lineno, value: c.expr(tree.body) }], lines };
  return { body: c.stmts(tree.body), lines };
}

// Sage's preparser: src/sagepre.ts
export { preparse as preparseSage } from "./sagepre";

// what a value pattern or mapping key may be (the grammar has made sure of
// the rest: a signed number, a complex literal)
const LITERALISH = new Set(["Constant", "Attribute", "UnaryOp", "BinOp"]);
interface MatchCtx {
  n: number;
  temps: Map<string, string>; // captured name -> its temp
  bound: Set<string>; // names this pattern (or this alternative) binds so far
  outer: Set<string>[]; // the enclosing patterns' names, around or-alternatives
  ors: any[]; // the or-patterns those are around (an error's location)
  order: string[]; // the captured names, in first-capture order
}
// A literal mapping key folded to its value (a signed number or a complex
// literal too: the grammar allows nothing else), for the duplicate check;
// undefined for an attribute lookup.
type Lit = { t: "overflow" } | { t: "num"; re: bigint | number; im: number | null } | { t: "str"; v: string } | { t: "bytes"; v: number[] } | { t: "none" } | { t: "bool"; v: boolean };
function foldLiteral(k: any): Lit | undefined {
  switch (k._type) {
    case "Constant": {
      const v = k.value;
      if (v === null || v === undefined || v instanceof PySingleton) return { t: "none" };
      if (typeof v === "boolean") return { t: "bool", v };
      if (typeof v === "bigint" || typeof v === "number") return { t: "num", re: v, im: null };
      if (v instanceof PyComplex) return { t: "num", re: 0, im: v.imag };
      if (typeof v === "string") return { t: "str", v };
      if (v instanceof Uint8Array) return { t: "bytes", v: Array.from(v) };
      return undefined;
    }
    case "UnaryOp": {
      const o = foldLiteral(k.operand);
      if (o === undefined || o.t !== "num" || k.op._type !== "USub") return undefined;
      return { t: "num", re: typeof o.re === "bigint" ? -o.re : -o.re, im: o.im === null ? null : -o.im };
    }
    case "BinOp": {
      const l = foldLiteral(k.left), r = foldLiteral(k.right);
      if (l === undefined || r === undefined || l.t !== "num" || r.t !== "num" || r.im === null) return undefined;
      const sign = k.op._type === "Sub" ? -1 : 1;
      // (a complex number's parts are floats: its real part converted; an
      // int too big for a float overflows there, and CPython's folding
      // leaves no literal)
      const re = typeof l.re === "bigint" ? Number(l.re) : l.re;
      if (typeof l.re === "bigint" && !Number.isFinite(re)) return { t: "overflow" };
      return { t: "num", re, im: (l.im ?? 0) + sign * r.im };
    }
  }
  return undefined;
}
// a key as Python's set sees it: equal numbers (1, 1.0, True, 1+0j; -0.0
// and 0) one key; a NaN equal to nothing
function literalKey(v: Exclude<Lit, { t: "overflow" }>): string | null {
  const real = (x: bigint | number): string | null => {
    if (typeof x === "bigint") return "n:" + x;
    if (x !== x) return null;
    if (Number.isInteger(x)) return "n:" + BigInt(x);
    return "f:" + x;
  };
  switch (v.t) {
    case "none": return "None";
    case "bool": return "n:" + (v.v ? 1 : 0);
    case "str": return "s:" + v.v;
    case "bytes": return "b:" + v.v.join(",");
    case "num": {
      const re = real(v.re);
      if (v.im === null || v.im === 0) return re;
      const im = real(v.im);
      return re === null || im === null ? null : `c:${re}:${im}`;
    }
  }
}
function floatRepr(x: number): string {
  if (x !== x) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Object.is(x, -0)) return "-0.0";
  const s = String(x);
  if (/e/.test(s)) return s.replace(/e([+-])(\d)$/, "e$10$2");
  return Number.isInteger(x) && Math.abs(x) < 1e16 ? s + ".0" : s;
}
function strRepr(v: string): string {
  const q = v.includes("'") && !v.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === q) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + q;
}
function literalRepr(v: Exclude<Lit, { t: "overflow" }>): string {
  switch (v.t) {
    case "none": return "None";
    case "bool": return v.v ? "True" : "False";
    case "str": return strRepr(v.v);
    case "bytes": {
      const q = v.v.includes(39) && !v.v.includes(34) ? '"' : "'";
      let out = "b" + q;
      for (const c of v.v) {
        if (c === 92 || c === q.charCodeAt(0)) out += "\\" + String.fromCharCode(c);
        else if (c === 10) out += "\\n";
        else if (c === 13) out += "\\r";
        else if (c === 9) out += "\\t";
        else if (c < 0x20 || c >= 0x7f) out += "\\x" + c.toString(16).padStart(2, "0");
        else out += String.fromCharCode(c);
      }
      return out + q;
    }
    case "num": {
      const r = (x: bigint | number) => (typeof x === "bigint" ? String(x) : floatRepr(x));
      if (v.im === null) return r(v.re);
      const im = (x: number) => {
        const s = floatRepr(x);
        return s.endsWith(".0") ? s.slice(0, -2) : s;
      };
      const re = typeof v.re === "bigint" ? Number(v.re) : v.re;
      if (re === 0 && !Object.is(re, -0)) return im(v.im) + "j";
      return `(${im(re)}${v.im < 0 || Object.is(v.im, -0) ? "-" : "+"}${im(Math.abs(v.im))}j)`;
    }
  }
}

class Convert {
  constructor(private filename: string, private lines: string[], private sage = false) {}

  binop(t: string): string {
    if (this.sage && t === "Div") return "sage/";
    if (this.sage && t === "Pow") return "sage**";
    return BIN[t];
  }

  unsupported(n: any, what: string): never {
    const l = n.lineno ?? 1;
    throw new PySyntaxError(`${what} is not supported yet`, this.filename, l, this.lines[l - 1] ?? "", (n.col_offset ?? 0) + 1);
  }

  // `from __future__ import annotations`: an annotation is then the str of
  // its source, as CPython's ast_unparse writes it, never evaluated
  futureAnnotations = false;
  annot(n: any): A.Expr {
    if (!this.futureAnnotations) return this.expr(n);
    this.checkStringized(n, strScope("annot", null));
    let v: string;
    try {
      v = unparse(n);
    } catch (e) {
      if (!(e instanceof UnparseUnsupported)) throw e;
      return this.unsupported(n, `an annotation with ${e.message} under from __future__ import annotations`);
    }
    return { k: "Const", line: n.lineno ?? 1, value: { t: "str", v } };
  }
  // A stringized annotation is still checked as CPython's symtable checks it,
  // in an annotation block that binds nothing. The scope an expression is
  // in: the annotation's own ("annot"), a lambda's, or a comprehension's
  // (its kind, the iteration variables bound so far and its walrus targets,
  // CPython's DEF_COMP_ITER and named-expression marks); each scope's count
  // of comprehension iterables being visited (ste_comp_iter_expr)
  private checkStringized(n: any, sc: StrScope) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => this.checkStringized(x, sc));
    const err = (msg: string): never => {
      const l = n.lineno ?? 1;
      throw new PySyntaxError(msg, this.filename, l, this.lines[l - 1] ?? "", (n.col_offset ?? 0) + 1);
    };
    const COMP: Record<string, string> = { ListComp: "list comprehension", SetComp: "set comprehension", DictComp: "dict comprehension", GeneratorExp: "generator expression" };
    const t = n._type;
    if (t === "NamedExpr") {
      if (sc.kind === "annot") err("named expression cannot be used within an annotation");
      if (sc.iter > 0) err("assignment expression cannot be used in a comprehension iterable expression");
      const id = n.target.id;
      for (let c: StrScope | null = sc; c !== null && c.kind in COMP; c = c.parent) {
        if (c.iterVars.has(id)) err(`assignment expression cannot rebind comprehension iteration variable '${id}'`);
        c.walrus.add(id);
      }
    }
    if (t === "Yield" || t === "YieldFrom") {
      if (sc.kind === "annot") err("yield expression cannot be used within an annotation");
      if (sc.kind !== "lambda") err(`'yield' inside ${COMP[sc.kind]}`);
    }
    if (t === "Await") {
      if (sc.kind === "annot") err("await expression cannot be used within an annotation");
      if (sc.kind === "lambda") err("'await' outside async function");
      if (sc.kind !== "GeneratorExp") err("asynchronous comprehension outside of an asynchronous function");
    }
    if (t === "Lambda") {
      this.checkStringized(n.args, sc);
      return this.checkStringized(n.body, strScope("lambda", null, sc.iter));
    }
    if (t in COMP) {
      // (the first iterable is visited in the enclosing scope, then each
      // generator's target, iterable and conditions in the comprehension's,
      // its element last)
      const iterIn = (x: any, s: StrScope) => {
        s.iter++;
        this.checkStringized(x, s);
        s.iter--;
      };
      iterIn(n.generators[0].iter, sc);
      if (t !== "GeneratorExp" && n.generators.some((g: any) => g.is_async)) err("asynchronous comprehension outside of an asynchronous function");
      const cs = strScope(t, sc, sc.iter);
      n.generators.forEach((g: any, i: number) => {
        for (const id of strTargetNames(g.target)) {
          if (cs.walrus.has(id)) err(`comprehension inner loop cannot rebind assignment expression target '${id}'`);
          cs.iterVars.add(id);
        }
        this.checkStringized(g.target, cs);
        if (i) iterIn(g.iter, cs);
        this.checkStringized(g.ifs, cs);
      });
      // (a dict comprehension's value before its key, as CPython's)
      return this.checkStringized(t === "DictComp" ? [n.value, n.key] : n.elt, cs);
    }
    for (const k in n) if (k !== "_type") this.checkStringized(n[k], sc);
  }

  // Whether the innermost function is an `async def` (await, async for and
  // async with are only allowed there), and a counter for desugaring temps.
  private inAsync = false;
  private tmp = 0;
  asyncFn<R>(isAsync: boolean, f: () => R): R {
    const saved = this.inAsync;
    this.inAsync = isAsync;
    try {
      return f();
    } finally {
      this.inAsync = saved;
    }
  }
  name(id: string, line: number): A.Expr {
    return { k: "Name", line, id };
  }
  call(fn: string, args: A.Expr[], line: number): A.Expr {
    return { k: "Call", line, func: this.name(fn, line), args, keywords: [] };
  }
  // a runtime operation (R.$i), not a name a user binding could replace
  intrinsic(name: string, args: A.Expr[] | null, line: number): A.Expr {
    return { k: "Intrinsic", line, name, args };
  }
  await(e: A.Expr, line: number): A.Expr {
    return { k: "Await", line, value: e };
  }

  // async for t in it: body else: orelse
  //   $ai = aiter(it); $done = False   (aiter, anext...: intrinsics, R.$i)
  //   while True:
  //     try: $v = await anext($ai)
  //     except StopAsyncIteration: $done = True; break
  //     t = $v; body
  //   if $done: orelse
  asyncFor(s: any): A.Stmt {
    const line = s.lineno;
    if (!this.inAsync) throw new PySyntaxError("'async for' outside async function", this.filename, line, this.lines[line - 1] ?? "", (s.col_offset ?? 0) + 1);
    const n = this.tmp++;
    const ai = `$ai${n}`, done = `$done${n}`, v = `$v${n}`;
    const T = (b: boolean): A.Expr => ({ k: "Const", line, value: { t: "bool", v: b } });
    const body: A.Stmt[] = [
      {
        k: "Try", line,
        body: [{ k: "Assign", line, targets: [this.name(v, line)], value: this.await(this.intrinsic("anext", [this.name(ai, line)], line), line) }],
        handlers: [{ line, type: this.intrinsic("StopAsyncIteration", null, line), name: null, body: [{ k: "Assign", line, targets: [this.name(done, line)], value: T(true) }, { k: "Break", line }] }],
        orelse: [], finalbody: [],
      },
      { k: "Assign", line, targets: [this.expr(s.target)], value: this.name(v, line) },
      ...this.stmts(s.body),
    ];
    const out: A.Stmt[] = [
      { k: "Assign", line, targets: [this.name(ai, line)], value: this.intrinsic("aiter", [this.expr(s.iter)], line) },
      { k: "Assign", line, targets: [this.name(done, line)], value: T(false) },
      { k: "While", line, test: T(true), body, orelse: [] },
    ];
    const orelse = this.stmts(s.orelse);
    if (orelse.length) out.push({ k: "If", line, test: this.name(done, line), body: orelse, orelse: [] });
    return { k: "If", line, test: T(true), body: out, orelse: [] };
  }

  // async with m as t: body   (one item; several items nest)
  //   $m = m; $x = aexit($m); t = await aenter($m); $ok = True   (intrinsics)
  //   try:
  //     try: body
  //     except BaseException as $e:
  //       $ok = False
  //       if not await $x(type($e), $e, $e.__traceback__): raise
  //   finally:
  //     if $ok: await $x(None, None, None)
  asyncWith(s: any, items: any[]): A.Stmt[] {
    const line = s.lineno;
    if (!this.inAsync) throw new PySyntaxError("'async with' outside async function", this.filename, line, this.lines[line - 1] ?? "", (s.col_offset ?? 0) + 1);
    const [item, ...rest] = items;
    const n = this.tmp++;
    const m = `$m${n}`, x = `$x${n}`, ok = `$ok${n}`, e = `$e${n}`;
    const T = (b: boolean): A.Expr => ({ k: "Const", line, value: { t: "bool", v: b } });
    const none: A.Expr = { k: "Const", line, value: { t: "None" } };
    const enter = this.await(this.intrinsic("aenter", [this.name(m, line)], line), line);
    const inner = rest.length ? this.asyncWith(s, rest) : this.stmts(s.body);
    const exitCall = (args: A.Expr[]): A.Expr => this.await({ k: "Call", line, func: this.name(x, line), args, keywords: [] }, line);
    return [
      { k: "Assign", line, targets: [this.name(m, line)], value: this.expr(item.context_expr) },
      { k: "Assign", line, targets: [this.name(x, line)], value: this.intrinsic("aexit", [this.name(m, line)], line) },
      item.optional_vars ? { k: "Assign", line, targets: [this.expr(item.optional_vars)], value: enter } : { k: "Expr", line, value: enter },
      { k: "Assign", line, targets: [this.name(ok, line)], value: T(true) },
      {
        k: "Try", line,
        body: [{
          k: "Try", line, body: inner,
          handlers: [{
            line, type: this.intrinsic("BaseException", null, line), name: e,
            body: [
              { k: "Assign", line, targets: [this.name(ok, line)], value: T(false) },
              {
                k: "If", line,
                test: { k: "UnaryOp", line, op: "not", operand: exitCall([this.intrinsic("type", [this.name(e, line)], line), this.name(e, line), { k: "Attribute", line, value: this.name(e, line), attr: "__traceback__" }]) },
                body: [{ k: "Raise", line, exc: null, cause: null }], orelse: [],
              },
            ],
          }],
          orelse: [], finalbody: [],
        }],
        handlers: [], orelse: [],
        finalbody: [{ k: "If", line, test: this.name(ok, line), body: [{ k: "Expr", line, value: exitCall([none, none, none]) }], orelse: [] }],
      },
    ];
  }

  // Private name mangling: inside a class body, `__x` becomes `_Class__x`.
  private klass: string | null = null;
  m(name: string): string {
    if (this.klass === null || !name.startsWith("__") || name.endsWith("__") || name.includes(".")) return name;
    return `_${this.klass}${name}`;
  }
  withClass<R>(name: string | null, f: () => R): R {
    const saved = this.klass;
    this.klass = name === null ? null : name.replace(/^_+/, "") || null;
    try {
      return f();
    } finally {
      this.klass = saved;
    }
  }

  stmts(list: any[]): A.Stmt[] {
    const out: A.Stmt[] = [];
    for (const s of list) {
      const r = this.stmt(s);
      if (r !== null) out.push(r);
    }
    return out;
  }

  stmt(s: any): A.Stmt | null {
    const line = s.lineno;
    switch (s._type) {
      case "Expr":
        return { k: "Expr", line, value: this.expr(s.value) };
      case "Assign":
        return { k: "Assign", line, targets: s.targets.map((t: any) => this.expr(t)), value: this.expr(s.value) };
      case "AugAssign":
        return { k: "AugAssign", line, target: this.expr(s.target), op: this.binop(s.op._type), value: this.expr(s.value) };
      case "AnnAssign":
        return { k: "AnnAssign", line, target: this.expr(s.target), value: s.value ? this.expr(s.value) : null, simple: !!s.simple, annotation: this.annot(s.annotation), stringized: this.futureAnnotations };
      case "Return":
        return { k: "Return", line, value: s.value ? this.expr(s.value) : null };
      case "If":
        return { k: "If", line, test: this.expr(s.test), body: this.stmts(s.body), orelse: this.stmts(s.orelse) };
      case "While":
        return { k: "While", line, test: this.expr(s.test), body: this.stmts(s.body), orelse: this.stmts(s.orelse) };
      case "For":
        return { k: "For", line, target: this.expr(s.target), iter: this.expr(s.iter), body: this.stmts(s.body), orelse: this.stmts(s.orelse) };
      case "Break":
        return { k: "Break", line };
      case "Continue":
        return { k: "Continue", line };
      case "Pass":
        return { k: "Pass", line };
      case "FunctionDef":
        if (s.type_params.length) this.unsupported(s, "type parameters");
        return { k: "FunctionDef", line, name: this.m(s.name), args: this.params(s.args), body: this.asyncFn(false, () => this.stmts(s.body)), decorators: s.decorator_list.map((d: any) => this.expr(d)), annotations: this.annotations(s) };
      case "ClassDef": {
        if (s.type_params.length) this.unsupported(s, "type parameters");
        return {
          k: "ClassDef", line, name: this.m(s.name), bases: s.bases.map((b: any) => this.expr(b)), keywords: s.keywords.map((k: any) => this.keyword(k)),
          body: this.withClass(s.name, () => this.stmts(s.body)), decorators: s.decorator_list.map((d: any) => this.expr(d)),
        };
      }
      case "Import":
        return { k: "Import", line, names: s.names.map((a: any) => ({ name: a.name, asname: a.asname ? this.m(a.asname) : this.m(a.name) !== a.name ? this.m(a.name) : null })) };
      case "ImportFrom":
        // (a future import changes the compiler: annotations is honoured,
        // as strings; the others are Python 3's behaviour already)
        if (s.module === "__future__") {
          if (s.names.some((a: any) => a.name === "annotations")) this.futureAnnotations = true;
          return null;
        }
        return { k: "ImportFrom", line, module: s.module ?? "", level: s.level ?? 0, names: s.names.map((a: any) => ({ name: a.name, asname: a.asname ? this.m(a.asname) : this.m(a.name) !== a.name ? this.m(a.name) : null })) };
      case "Global":
        return { k: "Global", line, names: s.names.map((n: string) => this.m(n)) };
      case "Nonlocal":
        return { k: "Nonlocal", line, names: s.names.map((n: string) => this.m(n)) };
      case "Raise":
        return { k: "Raise", line, exc: s.exc ? this.expr(s.exc) : null, cause: s.cause ? this.expr(s.cause) : null };
      case "Try":
        return {
          k: "Try", line, body: this.stmts(s.body),
          handlers: s.handlers.map((h: any) => ({ line: h.lineno, type: h.type ? this.expr(h.type) : null, name: h.name ? this.m(h.name) : null, body: this.stmts(h.body) })),
          orelse: this.stmts(s.orelse), finalbody: this.stmts(s.finalbody),
        };
      case "With":
        return { k: "With", line, items: s.items.map((i: any) => ({ context: this.expr(i.context_expr), target: i.optional_vars ? this.expr(i.optional_vars) : null })), body: this.stmts(s.body) };
      case "Assert":
        return { k: "Assert", line, test: this.expr(s.test), msg: s.msg ? this.expr(s.msg) : null };
      case "Delete":
        return { k: "Delete", line, targets: s.targets.map((t: any) => this.expr(t)) };
      case "AsyncFunctionDef":
        if (s.type_params.length) this.unsupported(s, "type parameters");
        return { k: "FunctionDef", line, name: this.m(s.name), args: this.params(s.args), body: this.asyncFn(true, () => this.stmts(s.body)), decorators: s.decorator_list.map((d: any) => this.expr(d)), isAsync: true, annotations: this.annotations(s) };
      case "AsyncFor":
        return this.asyncFor(s);
      case "AsyncWith":
        return { k: "If", line, test: { k: "Const", line, value: { t: "bool", v: true } }, body: this.asyncWith(s, s.items), orelse: [] };
      case "TryStar":
        this.unsupported(s, "except*");
      case "Match":
        return this.matchStmt(s);
      case "TypeAlias":
        this.unsupported(s, "type alias");
      default:
        this.unsupported(s, s._type);
    }
  }

  // match (PEP 634), lowered to an if chain over the subject, kept in a temp:
  //   $s = subject
  //   (each case, in order, until one matches) if <its test> [and <its guard>]: body
  // A case's test checks its pattern, capturing values into temps as it
  // goes, then binds the captured names all at once, as CPython binds them
  // only when the whole pattern has matched (and before the guard):
  // match_true(x := $cx, ...), which is True. Sequence, mapping and class
  // patterns check and unpack the subject with match_seq, match_map,
  // match_keys, match_rest and match_class (builtins.ts, intrinsics: no
  // user name can replace them), CPython's MATCH_SEQUENCE/MATCH_MAPPING/
  // MATCH_KEYS/MATCH_CLASS, staged as its compiler stages them. The SyntaxErrors past the
  // grammar's (unreachable patterns, repeated names...) are CPython's
  // compiler's, in its order.
  matchStmt(s: any): A.Stmt {
    const line = s.lineno;
    const n = this.tmp++;
    const subj = `$s${n}`;
    const tests: (A.Expr | null)[] = [];
    s.cases.forEach((c: any, i: number) => {
      const ctx: MatchCtx = { n, temps: new Map(), bound: new Set(), outer: [], ors: [], order: [] };
      const allow = !!c.guard || i === s.cases.length - 1;
      const parts: A.Expr[] = [];
      const t = this.pattern(c.pattern, this.name(subj, line), ctx, allow);
      if (t !== null) parts.push(t);
      if (ctx.order.length) parts.push(this.intrinsic("match_true", ctx.order.map((nm) => ({ k: "NamedExpr", line, target: nm, value: this.name(ctx.temps.get(nm)!, line) }) as A.Expr), line));
      if (c.guard) parts.push(this.expr(c.guard));
      tests.push(parts.length === 0 ? null : parts.length === 1 ? parts[0] : { k: "BoolOp", line, op: "and", values: parts });
    });
    // a flat chain, however many cases (no nesting for the JS parser):
    //   $d = False
    //   if not $d and <test>: $d = True; body    (for each case)
    const done = `$d${n}`;
    const T = (b: boolean): A.Expr => ({ k: "Const", line, value: { t: "bool", v: b } });
    const out: A.Stmt[] = [
      { k: "Assign", line, targets: [this.name(subj, line)], value: this.expr(s.subject) },
      { k: "Assign", line, targets: [this.name(done, line)], value: T(false) },
    ];
    s.cases.forEach((c: any, i: number) => {
      const l = c.pattern.lineno;
      const notDone: A.Expr = { k: "UnaryOp", line: l, op: "not", operand: this.name(done, l) };
      const t = tests[i];
      out.push({
        k: "If", line: l, test: t === null ? notDone : { k: "BoolOp", line: l, op: "and", values: [notDone, t] },
        body: [{ k: "Assign", line: l, targets: [this.name(done, l)], value: T(true) }, ...this.stmts(c.body)], orelse: [],
      });
    });
    return { k: "If", line, test: T(true), body: out, orelse: [] };
  }

  matchError(p: any, msg: string): never {
    const l = p.lineno ?? 1;
    throw new PySyntaxError(msg, this.filename, l, this.lines[l - 1] ?? "", (p.col_offset ?? 0) + 1, p.end_lineno ?? null, p.end_col_offset !== undefined ? p.end_col_offset + 1 : null);
  }

  // A capture: the value into the name's temp (shared by an or-pattern's
  // alternatives), its name bound when the case has matched.
  capture(p: any, name: string, value: A.Expr, ctx: MatchCtx): A.Expr {
    const line = p.lineno;
    const nm = this.m(name);
    // (one bound around an or-pattern: CPython reports it at the outermost
    // or-pattern it is bound around)
    const k = ctx.outer.findIndex((o) => o.has(nm));
    if (k >= 0) this.matchError(ctx.ors[k], `multiple assignments to name '${name}' in pattern`);
    if (ctx.bound.has(nm)) this.matchError(p, `multiple assignments to name '${name}' in pattern`);
    ctx.bound.add(nm);
    if (!ctx.temps.has(nm)) {
      ctx.temps.set(nm, `$c${ctx.n}_${ctx.temps.size}`);
      ctx.order.push(nm);
    }
    return this.intrinsic("match_true", [{ k: "NamedExpr", line, target: ctx.temps.get(nm)!, value }], line);
  }

  // A pattern's test of `subj`, or null when it always matches. `allow`:
  // whether it may be irrefutable (CPython's allow_irrefutable: not in a case
  // that is neither last nor guarded, nor in an or-pattern's alternative
  // but the last).
  pattern(p: any, subj: A.Expr, ctx: MatchCtx, allow: boolean): A.Expr | null {
    const line = p.lineno;
    const and = (xs: (A.Expr | null)[]): A.Expr | null => {
      const v = xs.filter((x): x is A.Expr => x !== null);
      return v.length === 0 ? null : v.length === 1 ? v[0] : { k: "BoolOp", line, op: "and", values: v };
    };
    const none: A.Expr = { k: "Const", line, value: { t: "None" } };
    const item = (t: string, i: number): A.Expr => ({ k: "Subscript", line, value: this.name(t, line), index: { k: "Const", line, value: { t: "int", v: BigInt(i) } } });
    const int = (v: number): A.Expr => ({ k: "Const", line, value: { t: "int", v: BigInt(v) } });
    const unpacked = (helper: string, args: A.Expr[]): [string, A.Expr] => {
      const t = `$m${ctx.n}_${this.tmp++}`;
      return [t, { k: "Compare", line, left: { k: "NamedExpr", line, target: t, value: this.intrinsic(helper, args, line) }, ops: ["is not"], comparators: [none] }];
    };
    const wildcard = (x: any) => (x._type === "MatchAs" && !x.pattern && !x.name) || (x._type === "MatchStar" && !x.name);
    switch (p._type) {
      case "MatchValue":
        // (an f-string is a JoinedStr: no literal, CPython's compiler says)
        if (!LITERALISH.has(p.value._type)) this.matchError(p, "patterns may only match literals and attribute lookups");
        return { k: "Compare", line, left: subj, ops: ["=="], comparators: [this.expr(p.value)] };
      case "MatchSingleton": {
        const v = p.value;
        const c: A.Constant = v === null || v === undefined || v instanceof PySingleton ? { t: "None" } : { t: "bool", v: !!v };
        return { k: "Compare", line, left: subj, ops: ["is"], comparators: [{ k: "Const", line, value: c }] };
      }
      case "MatchAs": {
        if (!p.pattern) {
          if (!allow) this.matchError(p, p.name ? `name capture '${p.name}' makes remaining patterns unreachable` : "wildcard makes remaining patterns unreachable");
          return p.name ? this.capture(p, p.name, subj, ctx) : null;
        }
        const t = this.pattern(p.pattern, subj, ctx, allow);
        return and([t, p.name ? this.capture(p, p.name, subj, ctx) : null]);
      }
      case "MatchOr": {
        // (each alternative's own names apart, the enclosing ones consulted
        // as they are: linear in the pattern, not alternatives x names)
        const saved = ctx.bound;
        ctx.outer.push(saved);
        ctx.ors.push(p);
        let first: Set<string> | null = null;
        const alts: A.Expr[] = [];
        p.patterns.forEach((alt: any, j: number) => {
          ctx.bound = new Set();
          const t = this.pattern(alt, subj, ctx, j === p.patterns.length - 1 ? allow : false);
          const mine = ctx.bound;
          if (first === null) first = mine;
          else if (mine.size !== first.size || [...mine].some((x) => !first!.has(x))) this.matchError(p, "alternative patterns bind different names");
          alts.push(t ?? { k: "Const", line, value: { t: "bool", v: true } });
        });
        ctx.outer.pop();
        ctx.ors.pop();
        ctx.bound = saved;
        for (const x of first!) saved.add(x);
        return { k: "BoolOp", line, op: "or", values: alts };
      }
      case "MatchSequence": {
        const pats = p.patterns;
        const stars = pats.filter((x: any) => x._type === "MatchStar").length;
        if (stars > 1) this.matchError(p, "multiple starred names in sequence pattern");
        const star = pats.findIndex((x: any) => x._type === "MatchStar");
        // (CPython's staging: only wildcards, nothing taken; a wildcard
        // star, the others by index; else all unpacked)
        const mode = pats.every(wildcard) ? 2 : star >= 0 && wildcard(pats[star]) ? 1 : 0;
        const [t, test] = unpacked("match_seq", [subj, int(pats.length), int(star), int(mode)]);
        if (mode === 0) return and([test, ...pats.map((x: any, i: number) => (x._type === "MatchStar" ? (x.name ? this.capture(x, x.name, item(t, i), ctx) : null) : this.pattern(x, item(t, i), ctx, true)))]);
        // (a wildcard star: each other item taken as its subpattern is
        // reached, not before, and none for a wildcard)
        return and([test, ...pats.map((x: any, i: number) => {
          if (mode === 2 || wildcard(x)) return null;
          const e = `$e${ctx.n}_${this.tmp++}`;
          const got: A.Expr = this.intrinsic("match_true", [{ k: "NamedExpr", line, target: e, value: this.intrinsic("match_item", [subj, int(i), int(pats.length), int(star)], line) }], line);
          return and([got, this.pattern(x, this.name(e, line), ctx, true)]);
        })]);
      }
      case "MatchMapping": {
        const seen = new Set<string>();
        for (const k of p.keys) {
          if (!LITERALISH.has(k._type)) this.matchError(p, "mapping pattern keys may only match literals and attribute lookups");
          // (literal keys folded, -1 and 1+0j included, compared as Python's
          // == compares numbers; attribute lookups aren't checked here)
          const v = foldLiteral(k);
          if (v === undefined) continue;
          if (v.t === "overflow") this.matchError(p, "mapping pattern keys may only match literals and attribute lookups");
          const key = literalKey(v);
          if (key !== null && seen.has(key)) this.matchError(p, `mapping pattern checks duplicate key (${literalRepr(v)})`);
          if (key !== null) seen.add(key);
        }
        // (CPython's staging: a mapping, long enough; then the keys, looked
        // up; then their subpatterns; then **rest, made last)
        const n = p.keys.length;
        const parts: (A.Expr | null)[] = [this.intrinsic("match_map", [subj, int(n)], line)];
        const kt = `$k${ctx.n}_${this.tmp++}`;
        const keys: A.Expr = { k: "Tuple", line, elts: p.keys.map((k: any) => this.expr(k)) };
        if (n > 0) {
          const [t, test] = unpacked("match_keys", [subj, { k: "NamedExpr", line, target: kt, value: keys }]);
          parts.push(test, ...p.patterns.map((x: any, i: number) => this.pattern(x, item(t, i), ctx, true)));
        }
        if (p.rest) parts.push(this.capture(p, p.rest, this.intrinsic("match_rest", [subj, n > 0 ? this.name(kt, line) : keys], line), ctx));
        return and(parts);
      }
      case "MatchClass": {
        const kw: string[] = p.kwd_attrs;
        const seenKw = new Set<string>();
        kw.forEach((a, j) => {
          if (seenKw.has(a)) this.matchError(p.kwd_patterns[j], `attribute name repeated in class pattern: ${a}`);
          seenKw.add(a);
        });
        const names: A.Expr = { k: "Tuple", line, elts: kw.map((a) => ({ k: "Const", line, value: { t: "str", v: a } }) as A.Expr) };
        const [t, test] = unpacked("match_class", [subj, this.expr(p.cls), int(p.patterns.length), names]);
        const subs = [...p.patterns, ...p.kwd_patterns].map((x: any, i: number) => this.pattern(x, item(t, i), ctx, true));
        return and([test, ...subs]);
      }
      default:
        this.matchError(p, `${p._type} is not supported in match`);
    }
  }

  keyword(k: any): A.Keyword {
    return { arg: k.arg ?? null, value: this.expr(k.value) };
  }

  // A def's annotations, in CPython's order: the parameters after the
  // positional-only ones, the positional-only ones, *args, the keyword-only
  // ones, **kwargs, the return (names mangled, as its keys are)
  annotations(s: any): [string, A.Expr][] {
    const a = s.args;
    const out: [string, A.Expr][] = [];
    const add = (p: any) => {
      if (p && p.annotation) out.push([this.m(p.arg), this.annot(p.annotation)]);
    };
    a.args.forEach(add);
    a.posonlyargs.forEach(add);
    add(a.vararg);
    a.kwonlyargs.forEach(add);
    add(a.kwarg);
    if (s.returns) out.push(["return", this.annot(s.returns)]);
    return out;
  }

  params(a: any): A.Params {
    const pos = [...a.posonlyargs, ...a.args];
    const nd = a.defaults.length;
    const args: A.Param[] = pos.map((p: any, i: number) => ({
      name: this.m(p.arg),
      default: i >= pos.length - nd ? this.expr(a.defaults[i - (pos.length - nd)]) : null,
    }));
    return {
      posonly: a.posonlyargs.length,
      args,
      vararg: a.vararg ? this.m(a.vararg.arg) : null,
      kwonly: a.kwonlyargs.map((p: any, i: number) => ({ name: this.m(p.arg), default: a.kw_defaults[i] ? this.expr(a.kw_defaults[i]) : null })),
      kwarg: a.kwarg ? this.m(a.kwarg.arg) : null,
    };
  }

  constant(v: any): A.Constant {
    if (typeof v === "bigint") return { t: "int", v };
    if (typeof v === "number") return { t: "float", v };
    if (typeof v === "string") return { t: "str", v };
    if (typeof v === "boolean") return { t: "bool", v };
    if (v instanceof PyComplex) return { t: "complex", v: v.imag };
    if (v instanceof Uint8Array) return { t: "bytes", v: Array.from(v) };
    if (v instanceof PySingleton) return v.name === "None" ? { t: "None" } : { t: "Ellipsis" };
    throw new Error("unknown constant " + String(v));
  }

  fparts(values: any[]): A.FPart[] {
    const parts: A.FPart[] = [];
    for (const v of values) {
      if (v._type === "Constant") {
        if (typeof parts[parts.length - 1] === "string") parts[parts.length - 1] += v.value;
        else parts.push(v.value);
      } else if (v._type === "FormattedValue") {
        parts.push({
          expr: this.expr(v.value),
          conv: v.conversion >= 0 ? String.fromCharCode(v.conversion) : null,
          spec: v.format_spec ? this.fparts(v.format_spec.values) : null,
          text: "",
        });
      } else this.unsupported(v, v._type);
    }
    return parts;
  }

  comp(e: any, kind: "list" | "set" | "gen" | "dict"): A.Expr {
    const generators = e.generators.map((g: any) => {
      if (g.is_async) this.unsupported(e, "async comprehensions");
      return { target: this.expr(g.target), iter: this.expr(g.iter), ifs: g.ifs.map((x: any) => this.expr(x)) };
    });
    if (kind === "dict") return { k: "Comp", line: e.lineno, kind, elt: this.expr(e.key), value: this.expr(e.value), generators };
    return { k: "Comp", line: e.lineno, kind, elt: this.expr(e.elt), value: null, generators };
  }

  expr(e: any): A.Expr {
    const line = e.lineno;
    switch (e._type) {
      case "Name":
        return { k: "Name", line, id: this.m(e.id) };
      case "Constant":
        return { k: "Const", line, value: this.constant(e.value) };
      case "JoinedStr":
        return { k: "FString", line, parts: this.fparts(e.values) };
      case "BinOp":
        return { k: "BinOp", line, op: this.binop(e.op._type), left: this.expr(e.left), right: this.expr(e.right) };
      case "UnaryOp": {
        const operand = this.expr(e.operand);
        // Fold -literal so that e.g. -9223372036854775808 stays an exact constant.
        if (e.op._type === "USub" && operand.k === "Const") {
          const v = operand.value;
          if (v.t === "int") return { k: "Const", line, value: { t: "int", v: -v.v } };
          if (v.t === "float") return { k: "Const", line, value: { t: "float", v: -v.v } };
        }
        return { k: "UnaryOp", line, op: UNARY[e.op._type], operand };
      }
      case "BoolOp":
        return { k: "BoolOp", line, op: e.op._type === "And" ? "and" : "or", values: e.values.map((v: any) => this.expr(v)) };
      case "Compare":
        return { k: "Compare", line, left: this.expr(e.left), ops: e.ops.map((o: any) => CMP[o._type]), comparators: e.comparators.map((c: any) => this.expr(c)) };
      case "IfExp":
        return { k: "IfExp", line, test: this.expr(e.test), body: this.expr(e.body), orelse: this.expr(e.orelse) };
      case "Call":
        return { k: "Call", line, func: this.expr(e.func), args: e.args.map((a: any) => this.expr(a)), keywords: e.keywords.map((k: any) => this.keyword(k)) };
      case "Attribute":
        return { k: "Attribute", line, value: this.expr(e.value), attr: this.m(e.attr) };
      case "Subscript":
        return { k: "Subscript", line, value: this.expr(e.value), index: this.expr(e.slice) };
      case "Slice":
        return { k: "Slice", line: line ?? 0, lower: e.lower ? this.expr(e.lower) : null, upper: e.upper ? this.expr(e.upper) : null, step: e.step ? this.expr(e.step) : null };
      case "List":
        return { k: "List", line, elts: e.elts.map((x: any) => this.expr(x)) };
      case "Tuple":
        return { k: "Tuple", line, elts: e.elts.map((x: any) => this.expr(x)) };
      case "Set":
        return { k: "Set", line, elts: e.elts.map((x: any) => this.expr(x)) };
      case "Dict":
        return { k: "Dict", line, keys: e.keys.map((x: any) => (x ? this.expr(x) : null)), values: e.values.map((x: any) => this.expr(x)) };
      case "ListComp":
        return this.comp(e, "list");
      case "SetComp":
        return this.comp(e, "set");
      case "GeneratorExp":
        return this.comp(e, "gen");
      case "DictComp":
        return this.comp(e, "dict");
      case "Lambda":
        return { k: "Lambda", line, args: this.params(e.args), body: this.asyncFn(false, () => this.expr(e.body)) };
      case "Await":
        if (!this.inAsync) throw new PySyntaxError("'await' outside async function", this.filename, line, this.lines[line - 1] ?? "", (e.col_offset ?? 0) + 1);
        return this.await(this.expr(e.value), line);
      case "Starred":
        return { k: "Starred", line, value: this.expr(e.value) };
      case "Yield":
        return { k: "Yield", line, value: e.value ? this.expr(e.value) : null };
      case "YieldFrom":
        return { k: "YieldFrom", line, value: this.expr(e.value) };
      case "NamedExpr":
        return { k: "NamedExpr", line, target: this.m(e.target.id), value: this.expr(e.value) };
      case "Await":
        this.unsupported(e, "await");
      case "TemplateStr":
        this.unsupported(e, "t-strings");
      default:
        this.unsupported(e, e._type);
    }
  }
}

// (frontend.ts checkStringized: a scope of a stringized annotation)
interface StrScope { kind: string; parent: StrScope | null; iter: number; iterVars: Set<string>; walrus: Set<string> }
// (a new scope inside a comprehension iterable is in it too: CPython's
// symtable_enter_block copies ste_comp_iter_expr, bpo-37757)
function strScope(kind: string, parent: StrScope | null, iter = 0): StrScope {
  return { kind, parent, iter, iterVars: new Set(), walrus: new Set() };
}
function strTargetNames(t: any): string[] {
  if (t._type === "Name") return [t.id];
  if (t._type === "Tuple" || t._type === "List") return t.elts.flatMap(strTargetNames);
  if (t._type === "Starred") return strTargetNames(t.value);
  return [];
}
