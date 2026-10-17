// Front end: Python source -> the compiler's AST (src/ast.ts), via pyparse,
// which is CPython 3.14's own grammar generated in TypeScript.  Syntax
// errors therefore match CPython exactly (message, line, offset, end).

import { preparse } from "./sagepre";
import * as A from "./ast";
import { parse as pyparse, PegenError } from "../pyparse/src/index";
import { PySingleton } from "../pyparse/src/helpers";
import { PyComplex } from "../pyparse/src/pegen";

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
  order: string[]; // the captured names, in first-capture order
}
// a literal mapping key, for the duplicate check: as Python's set sees it
// (1, 1.0 and True are one key)
function constKey(v: any): string {
  if (v === null || v === undefined || v instanceof PySingleton) return "None";
  if (typeof v === "boolean") return "n:" + (v ? 1 : 0);
  if (typeof v === "number" || typeof v === "bigint") return "n:" + String(typeof v === "bigint" ? v : v);
  if (typeof v === "string") return "s:" + v;
  if (v instanceof Uint8Array || Array.isArray(v)) return "b:" + Array.from(v as any).join(",");
  return "o:" + String(v);
}
function constRepr(v: any): string {
  if (v === null || v === undefined || v instanceof PySingleton) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(1) : String(v);
  if (typeof v === "string") return v.includes("'") && !v.includes('"') ? JSON.stringify(v) : "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  return String(v);
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
  await(e: A.Expr, line: number): A.Expr {
    return { k: "Await", line, value: e };
  }

  // async for t in it: body else: orelse
  //   $ai = __pyjs_aiter__(it); $done = False
  //   while True:
  //     try: $v = await __pyjs_anext__($ai)
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
        body: [{ k: "Assign", line, targets: [this.name(v, line)], value: this.await(this.call("__pyjs_anext__", [this.name(ai, line)], line), line) }],
        handlers: [{ line, type: this.name("StopAsyncIteration", line), name: null, body: [{ k: "Assign", line, targets: [this.name(done, line)], value: T(true) }, { k: "Break", line }] }],
        orelse: [], finalbody: [],
      },
      { k: "Assign", line, targets: [this.expr(s.target)], value: this.name(v, line) },
      ...this.stmts(s.body),
    ];
    const out: A.Stmt[] = [
      { k: "Assign", line, targets: [this.name(ai, line)], value: this.call("__pyjs_aiter__", [this.expr(s.iter)], line) },
      { k: "Assign", line, targets: [this.name(done, line)], value: T(false) },
      { k: "While", line, test: T(true), body, orelse: [] },
    ];
    const orelse = this.stmts(s.orelse);
    if (orelse.length) out.push({ k: "If", line, test: this.name(done, line), body: orelse, orelse: [] });
    return { k: "If", line, test: T(true), body: out, orelse: [] };
  }

  // async with m as t: body   (one item; several items nest)
  //   $m = m; $x = __pyjs_aexit__($m); t = await __pyjs_aenter__($m); $ok = True
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
    const enter = this.await(this.call("__pyjs_aenter__", [this.name(m, line)], line), line);
    const inner = rest.length ? this.asyncWith(s, rest) : this.stmts(s.body);
    const exitCall = (args: A.Expr[]): A.Expr => this.await({ k: "Call", line, func: this.name(x, line), args, keywords: [] }, line);
    return [
      { k: "Assign", line, targets: [this.name(m, line)], value: this.expr(item.context_expr) },
      { k: "Assign", line, targets: [this.name(x, line)], value: this.call("__pyjs_aexit__", [this.name(m, line)], line) },
      item.optional_vars ? { k: "Assign", line, targets: [this.expr(item.optional_vars)], value: enter } : { k: "Expr", line, value: enter },
      { k: "Assign", line, targets: [this.name(ok, line)], value: T(true) },
      {
        k: "Try", line,
        body: [{
          k: "Try", line, body: inner,
          handlers: [{
            line, type: this.name("BaseException", line), name: e,
            body: [
              { k: "Assign", line, targets: [this.name(ok, line)], value: T(false) },
              {
                k: "If", line,
                test: { k: "UnaryOp", line, op: "not", operand: exitCall([this.call("type", [this.name(e, line)], line), this.name(e, line), { k: "Attribute", line, value: this.name(e, line), attr: "__traceback__" }]) },
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
        return { k: "AnnAssign", line, target: this.expr(s.target), value: s.value ? this.expr(s.value) : null, simple: !!s.simple };
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
        return { k: "FunctionDef", line, name: this.m(s.name), args: this.params(s.args), body: this.asyncFn(false, () => this.stmts(s.body)), decorators: s.decorator_list.map((d: any) => this.expr(d)) };
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
        if (s.module === "__future__") return null;
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
        return { k: "FunctionDef", line, name: this.m(s.name), args: this.params(s.args), body: this.asyncFn(true, () => this.stmts(s.body)), decorators: s.decorator_list.map((d: any) => this.expr(d)), isAsync: true };
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
  // __pyjs_match_true__(x := $cx, ...), which is True. Sequence, mapping and
  // class patterns check and unpack the subject with __pyjs_match_seq__,
  // __pyjs_match_map__ and __pyjs_match_class__ (builtins.ts), CPython's
  // MATCH_SEQUENCE/MATCH_KEYS/MATCH_CLASS. The SyntaxErrors past the
  // grammar's (unreachable patterns, repeated names...) are CPython's
  // compiler's, in its order.
  matchStmt(s: any): A.Stmt {
    const line = s.lineno;
    const n = this.tmp++;
    const subj = `$s${n}`;
    const tests: (A.Expr | null)[] = [];
    s.cases.forEach((c: any, i: number) => {
      const ctx: MatchCtx = { n, temps: new Map(), bound: new Set(), outer: [], order: [] };
      const allow = !!c.guard || i === s.cases.length - 1;
      const parts: A.Expr[] = [];
      const t = this.pattern(c.pattern, this.name(subj, line), ctx, allow);
      if (t !== null) parts.push(t);
      if (ctx.order.length) parts.push(this.call("__pyjs_match_true__", ctx.order.map((nm) => ({ k: "NamedExpr", line, target: nm, value: this.name(ctx.temps.get(nm)!, line) }) as A.Expr), line));
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
    if (ctx.bound.has(nm) || ctx.outer.some((o) => o.has(nm))) this.matchError(p, `multiple assignments to name '${name}' in pattern`);
    ctx.bound.add(nm);
    if (!ctx.temps.has(nm)) {
      ctx.temps.set(nm, `$c${ctx.n}_${ctx.temps.size}`);
      ctx.order.push(nm);
    }
    return this.call("__pyjs_match_true__", [{ k: "NamedExpr", line, target: ctx.temps.get(nm)!, value }], line);
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
    const unpacked = (helper: string, args: A.Expr[]): [string, A.Expr] => {
      const t = `$m${ctx.n}_${this.tmp++}`;
      return [t, { k: "Compare", line, left: { k: "NamedExpr", line, target: t, value: this.call(helper, args, line) }, ops: ["is not"], comparators: [none] }];
    };
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
        ctx.bound = saved;
        for (const x of first!) saved.add(x);
        return { k: "BoolOp", line, op: "or", values: alts };
      }
      case "MatchSequence": {
        const pats = p.patterns;
        const stars = pats.filter((x: any) => x._type === "MatchStar").length;
        if (stars > 1) this.matchError(p, "multiple starred names in sequence pattern");
        const star = pats.findIndex((x: any) => x._type === "MatchStar");
        const fixed = pats.length - (star < 0 ? 0 : 1);
        const [t, test] = unpacked("__pyjs_match_seq__", [{ k: "Const", line, value: { t: "int", v: BigInt(fixed) } }, { k: "Const", line, value: { t: "int", v: BigInt(star) } }].map((x) => x as A.Expr));
        (test as any).left.value.args.unshift(subj);
        return and([test, ...pats.map((x: any, i: number) => (x._type === "MatchStar" ? (x.name ? this.capture(x, x.name, item(t, i), ctx) : null) : this.pattern(x, item(t, i), ctx, true)))]);
      }
      case "MatchMapping": {
        const seen = new Map<string, true>();
        for (const k of p.keys) {
          if (!LITERALISH.has(k._type)) this.matchError(p, "mapping pattern keys may only match literals and attribute lookups");
          if (k._type !== "Constant") continue;
          const key = constKey(k.value);
          if (seen.has(key)) this.matchError(p, `mapping pattern checks duplicate key (${constRepr(k.value)})`);
          seen.set(key, true);
        }
        const keys: A.Expr = { k: "Tuple", line, elts: p.keys.map((k: any) => this.expr(k)) };
        const [t, test] = unpacked("__pyjs_match_map__", [subj, keys, { k: "Const", line, value: { t: "bool", v: !!p.rest } }]);
        const subs = p.patterns.map((x: any, i: number) => this.pattern(x, item(t, i), ctx, true));
        if (p.rest) subs.push(this.capture(p, p.rest, item(t, p.keys.length), ctx));
        return and([test, ...subs]);
      }
      case "MatchClass": {
        const kw: string[] = p.kwd_attrs;
        const seenKw = new Set<string>();
        kw.forEach((a, j) => {
          if (seenKw.has(a)) this.matchError(p.kwd_patterns[j], `attribute name repeated in class pattern: ${a}`);
          seenKw.add(a);
        });
        const names: A.Expr = { k: "Tuple", line, elts: kw.map((a) => ({ k: "Const", line, value: { t: "str", v: a } }) as A.Expr) };
        const [t, test] = unpacked("__pyjs_match_class__", [subj, this.expr(p.cls), { k: "Const", line, value: { t: "int", v: BigInt(p.patterns.length) } }, names]);
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
