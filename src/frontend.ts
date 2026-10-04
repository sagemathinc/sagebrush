// Front end: Python source -> the compiler's AST (src/ast.ts), via pyparse,
// which is CPython 3.14's own grammar generated in TypeScript.  Syntax
// errors therefore match CPython exactly (message, line, offset, end).

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
export function parse(source: string, filename: string, mode: "exec" | "eval" = "exec"): A.Module {
  const lines = source.split("\n");
  let tree: any;
  try {
    tree = pyparse(source, mode);
  } catch (e) {
    if (e instanceof PegenError) {
      const i = e.info;
      throw new PySyntaxError(i.msg, filename, i.lineno, (i.text ?? lines[i.lineno - 1] ?? ""), i.offset, i.end_lineno, i.end_offset, i.type);
    }
    throw e;
  }
  const c = new Convert(filename, lines);
  if (mode === "eval") return { body: [{ k: "Expr", line: tree.body.lineno, value: c.expr(tree.body) }], lines };
  return { body: c.stmts(tree.body), lines };
}

class Convert {
  constructor(private filename: string, private lines: string[]) {}

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
        return { k: "AugAssign", line, target: this.expr(s.target), op: BIN[s.op._type], value: this.expr(s.value) };
      case "AnnAssign":
        return { k: "AnnAssign", line, target: this.expr(s.target), value: s.value ? this.expr(s.value) : null };
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
        this.unsupported(s, "match");
      case "TypeAlias":
        this.unsupported(s, "type alias");
      default:
        this.unsupported(s, s._type);
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
        return { k: "BinOp", line, op: BIN[e.op._type], left: this.expr(e.left), right: this.expr(e.right) };
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
