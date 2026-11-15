// Python scoping: which names are local, closure (free), global, or class
// namespace entries.  One Scope per module, function, lambda, class body and
// comprehension.

import * as A from "./ast";

export type ScopeKind = "module" | "function" | "class" | "comp";

export class Scope {
  bound = new Set<string>();
  globals = new Set<string>();
  // (a comprehension's own walrus targets: those written directly in it,
  // not in a comprehension inside it; src/emit.ts gns)
  walrusTargets = new Set<string>();
  nonlocals = new Set<string>();
  params = new Set<string>();
  iterVars = new Set<string>(); // comprehension targets
  // what CPython's symbol table has seen of a name in this scope, which a
  // later `global` or `nonlocal` naming it may not follow: a use, an
  // annotation (`x: int`), a binding (not an import; not a module's `:=` in
  // a comprehension).  Annotations of other names are evaluated later, in
  // scopes of their own (Python 3.14), so they are not uses.
  before = new Map<string, number>();
  nonlocalLines = new Map<string, number>();
  isGenerator = false;
  isAsync = false;
  // the JS name of this class's cell, once a function of the class uses its
  // __class__ (by name, or by naming super): the class body makes the cell
  // and passes it as __classcell__ (set while the class's functions are
  // compiled; each class its own name, so an inner class's cell never hides
  // an outer one's)
  cellName: string | null = null;
  // the JS name of this class's __classdict__ cell, once an annotation
  // scope of the class sees it (src/emit.ts annotateFn)
  classDictName: string | null = null;
  // a lazy annotation's own scope (CPython 3.14's annotation scope): a
  // function of one parameter, format; in a class, the class's namespace
  // seen first (its __classdict__); and a module's or class body's one
  // annotation scope, for its annotated names
  annotation = false;
  annotScope: Scope | null = null;
  // (PEP 695) a generic's type parameters' own scope, CPython's
  // <generic parameters of NAME>: a function the def, class or type alias
  // statement runs in, binding the parameters, so the body sees them as
  // closures; it is transparent to qualified names
  typeParamsBlock = false;
  // the class whose namespace this scope looks names up in first (CPython's
  // can_see_class_scope): a class body's annotation scopes and a generic's
  // type parameters' scope directly in a class, and the annotation scopes
  // inside those (a parameter's bound, a generic def's annotations)
  classView: Scope | null = null;
  // what an annotation-like scope is, for what it can't hold (yield, await,
  // :=): "annotation", "generic", "type alias", or a type parameter's part
  // ("a TypeVar bound", ...); null for any other scope
  info: string | null = null;
  children = new Map<object, Scope>();
  constructor(
    public kind: ScopeKind,
    public name: string,
    public parent: Scope | null,
    public qualname: string
  ) {}

  child(node: object): Scope {
    const s = this.children.get(node);
    if (s === undefined) throw new Error("internal: no scope for node");
    return s;
  }
}

export type Resolution =
  | { kind: "local" } // a JS `let` in the current JS function
  | { kind: "free"; scope: Scope } // a JS `let` in an enclosing JS function
  | { kind: "global" }
  | { kind: "class"; outer: Resolution } // class namespace, falling back to `outer`
  | { kind: "classcell"; scope: Scope }; // __class__ in a function of a class: that class's cell

export function resolve(scope: Scope, name: string): Resolution {
  if (scope.globals.has(name)) return { kind: "global" };
  if (scope.kind === "module") return { kind: "global" };
  if (scope.nonlocals.has(name)) {
    // (nonlocal __class__: the nearest class's cell, or a function between's)
    if (name === "__class__") return resolveFree(scope.parent!, name);
    const s = findEnclosing(scope.parent, name);
    return s === null ? { kind: "global" } : { kind: "free", scope: s };
  }
  // (a class binding __classdict__ itself: its annotations' name is the
  // namespace's entry first, the implicit cell after, as CPython's
  // LOAD_FROM_DICT_OR_DEREF; its locals() and lambdas see the cell)
  if (name === "__classdict__" && implicitClassDict(scope) && scope.classView!.bound.has(name)) return { kind: "class", outer: { kind: "local" } };
  if (bindsName(scope, name)) {
    // A name bound in a class body is looked up in the class namespace and
    // then the globals, never in enclosing functions (LOAD_NAME).
    if (scope.kind === "class") return { kind: "class", outer: { kind: "global" } };
    return { kind: "local" };
  }
  // (a scope seeing a class's namespace: a name the class declares global is
  // the globals', not looked up in its namespace, as CPython's)
  if (scope.classView !== null && scope.classView.globals.has(name)) return { kind: "global" };
  if (scope.kind === "class" || scope.classView !== null) return { kind: "class", outer: resolveFree(scope.parent!, name) };
  return resolveFree(scope.parent!, name);
}

// A name not bound in some inner scope: the nearest enclosing function or
// comprehension binding it (class scopes are skipped), else global.
// __class__ is the exception: the nearest class gives its functions an
// implicit __class__ (CPython's class cell), unless a function between binds
// the name.
function resolveFree(scope: Scope, name: string): Resolution {
  if (name === "__class__") {
    for (let s: Scope | null = scope; s !== null; s = s.parent) {
      if (s.kind === "class") return { kind: "classcell", scope: s };
      if (s.kind === "module" || s.globals.has(name)) return { kind: "global" };
      if (s.bound.has(name) && !s.nonlocals.has(name)) return { kind: "free", scope: s };
    }
    return { kind: "global" };
  }
  const s = findEnclosing(scope, name);
  return s === null ? { kind: "global" } : { kind: "free", scope: s };
}

// Whether scope s binds name: a scope seeing a class's namespace binds
// __classdict__ too (CPython's implicit cell of the class's namespace,
// which its lambdas and comprehensions capture), unless the class
// declares that name global
export function bindsName(s: Scope, name: string): boolean {
  return s.bound.has(name) || (name === "__classdict__" && implicitClassDict(s));
}
export function implicitClassDict(s: Scope): boolean {
  return s.classView !== null && !s.classView.globals.has("__classdict__");
}

// The key of a type parameter's default's scope (its bound's is the
// parameter itself), as CPython's address + 1: never an expression's own,
// which a comprehension's scope has
const defaultKeys = new WeakMap<A.TypeParam, object>();
export function defaultKey(t: A.TypeParam): object {
  let k = defaultKeys.get(t);
  if (k === undefined) defaultKeys.set(t, (k = {}));
  return k;
}

// (what CPython's symtable says of an expression an annotation-like scope can't hold)
function notWithin(s: Scope, what: string): string | null {
  switch (s.info) {
    case null:
      return null;
    case "annotation":
      return `${what} cannot be used within an annotation`;
    case "generic":
      return `${what} cannot be used within the definition of a generic`;
    case "type alias":
      return `${what} cannot be used within a type alias`;
    default:
      return `${what} cannot be used within ${s.info}`;
  }
}

function findEnclosing(scope: Scope | null, name: string): Scope | null {
  for (let s = scope; s !== null; s = s.parent) {
    if (s.kind === "class") continue;
    if (s.kind === "module" || s.globals.has(name)) return null;
    if (bindsName(s, name) || s.nonlocals.has(name)) {
      if (s.nonlocals.has(name)) return findEnclosing(s.parent, name);
      return s;
    }
  }
  return null;
}

const USE = 1, ANNOT = 2, BOUND = 4;

export class SyntaxErr extends Error {
  constructor(
    public msg: string,
    public line: number
  ) {
    super(msg);
  }
}

// Build the scope tree for a module.
export function analyze(mod: A.Module): Scope {
  const top = new Scope("module", "<module>", null, "");
  new Collector(top).stmts(mod.body);
  checkNonlocals(top);
  return top;
}

function checkNonlocals(s: Scope) {
  for (const [n, line] of s.nonlocalLines) {
    const at = n === "__class__" ? null : findEnclosing(s.parent, n);
    const found = n === "__class__" ? resolveFree(s.parent!, n).kind !== "global" : at !== null;
    if (!found) throw new SyntaxErr(`no binding for nonlocal '${n}' found`, line);
    // (a generic's type parameters' scope binds only them)
    if (at !== null && at.typeParamsBlock) throw new SyntaxErr(`nonlocal binding not allowed for type parameter '${n}'`, line);
  }
  for (const c of s.children.values()) checkNonlocals(c);
}

class Collector {
  constructor(private s: Scope) {}

  bindTarget(t: A.Expr) {
    switch (t.k) {
      case "Name":
        this.bind(t.id);
        break;
      case "Tuple":
      case "List":
        t.elts.forEach((e) => this.bindTarget(e));
        break;
      case "Starred":
        this.bindTarget(t.value);
        break;
      default:
        this.expr(t);
    }
  }

  bind(name: string, how = BOUND) {
    this.s.bound.add(name);
    this.mark(this.s, name, how);
  }

  mark(s: Scope, name: string, how: number) {
    if (how) s.before.set(name, (s.before.get(name) ?? 0) | how);
  }

  // `global` or `nonlocal` naming n: an error after a use, an annotation or a binding of n here
  declare(n: string, what: "global" | "nonlocal", line: number) {
    const f = this.s.before.get(n) ?? 0;
    if (f & USE) throw new SyntaxErr(`name '${n}' is used prior to ${what} declaration`, line);
    if (f & ANNOT) throw new SyntaxErr(`annotated name '${n}' can't be ${what}`, line);
    if (f & BOUND) throw new SyntaxErr(`name '${n}' is assigned to before ${what} declaration`, line);
  }

  stmts(body: A.Stmt[]) {
    for (const st of body) this.stmt(st);
  }

  params(p: A.Params) {
    for (const a of [...p.args, ...p.kwonly]) if (a.default) this.expr(a.default);
  }

  newScope(kind: ScopeKind, name: string, node: object): Scope {
    // (CPython: a name the enclosing scope declares global is qualified as
    // the module's; a generic's type parameters' scope is skipped)
    let o = this.s;
    while (o.typeParamsBlock) o = o.parent!;
    const prefix = o.kind === "module" || o.globals.has(name) ? "" : o.kind === "function" ? `${o.qualname}.<locals>.` : `${o.qualname}.`;
    const sc = new Scope(kind, name, this.s, prefix + name);
    this.s.children.set(node, sc);
    return sc;
  }

  // A generic's type parameters' scope here (PEP 695), entered: each
  // parameter bound in it, its bound and default each in an annotation
  // scope of their own; in a class, the class's namespace seen first, as
  // CPython's. Returns the scope this one was.
  enterTypeParams(params: A.TypeParam[], name: string): Scope {
    const sc = this.newScope("function", `<generic parameters of ${name}>`, params);
    sc.typeParamsBlock = true;
    sc.info = "generic";
    if (this.s.kind === "class") sc.classView = this.s;
    const saved = this.s;
    this.s = sc;
    let seenDefault = false;
    for (const t of params) {
      if (t.name === "__classdict__") throw new SyntaxErr("reserved name '__classdict__' cannot be used for type parameter", t.line);
      if (sc.bound.has(t.bind)) throw new SyntaxErr(`duplicate type parameter '${t.name}'`, t.line);
      this.bind(t.bind);
      if (t.bound !== null) this.lazy(t, t.name, t.bound, t.bound.k === "Tuple" ? "a TypeVar constraint" : "a TypeVar bound");
      if (t.default !== null) {
        this.lazy(defaultKey(t), t.name, t.default.k === "Starred" ? t.default.value : t.default, `a ${t.kind} default`);
        seenDefault = true;
      } else if (seenDefault) throw new SyntaxErr(`non-default type parameter '${t.name}' follows default type parameter`, t.line);
    }
    return saved;
  }
  // A lazily evaluated expression's annotation scope (a type parameter's
  // bound or default, a type alias's value), named `name`, key `key`
  lazy(key: object, name: string, e: A.Expr, info: string) {
    const sc = this.newScope("function", name, key);
    sc.annotation = true;
    sc.info = info;
    sc.classView = this.s.kind === "class" ? this.s : this.s.classView;
    this.annotation(sc, e);
  }

  func(node: object, name: string, p: A.Params, body: () => void) {
    const fs = this.newScope("function", name, node);
    const names = [...p.args.map((a) => a.name), ...(p.vararg ? [p.vararg] : []), ...p.kwonly.map((a) => a.name), ...(p.kwarg ? [p.kwarg] : [])];
    for (const n of names) {
      if (fs.bound.has(n)) throw new SyntaxErr(`duplicate argument '${n}' in function definition`, (node as any).line ?? 0);
      fs.bound.add(n);
      fs.params.add(n);
    }
    const saved = this.s;
    this.s = fs;
    body();
    this.s = saved;
  }

  stmt(st: A.Stmt) {
    switch (st.k) {
      case "Expr":
        return this.expr(st.value);
      case "Assign":
        this.expr(st.value);
        return st.targets.forEach((t) => this.bindTarget(t));
      case "AugAssign":
        this.expr(st.value);
        if (st.target.k === "Name") this.bind(st.target.id);
        else this.expr(st.target);
        return;
      case "AnnAssign": {
        if (st.value) this.expr(st.value);
        const t = st.target;
        // (a module's or class's annotation of a name: compiled into its
        // lazy __annotate__, in the body's annotation scope; any other one,
        // never evaluated, checked in a scope of its own, as CPython's)
        if (t.k === "Name" && st.simple && (this.s.kind === "module" || this.s.kind === "class")) {
          this.s.annotScope ??= this.annotationScope({});
          this.annotation(this.s.annotScope, st.annotation);
        } else this.annotation(this.annotationScope(st), st.annotation);
        // `(x): int`, not simple: x is neither annotated nor (without a value) bound
        if (t.k !== "Name" || !st.simple) {
          if (st.value || t.k !== "Name") this.bindTarget(t);
          return;
        }
        // (a name declared global or nonlocal cannot be annotated, but at a module's top level)
        if (this.s.kind !== "module" && (this.s.globals.has(t.id) || this.s.nonlocals.has(t.id))) {
          throw new SyntaxErr(`annotated name '${t.id}' can't be ${this.s.globals.has(t.id) ? "global" : "nonlocal"}`, st.line);
        }
        if (st.value) this.bindTarget(t);
        else if (this.s.kind !== "module" && this.s.kind !== "class") this.bind(t.id);
        this.mark(this.s, t.id, ANNOT);
        return;
      }
      case "Return":
        if (st.value) this.expr(st.value);
        return;
      case "If":
      case "While":
        this.expr(st.test);
        this.stmts(st.body);
        return this.stmts(st.orelse);
      case "For":
        this.expr(st.iter);
        this.bindTarget(st.target);
        this.stmts(st.body);
        return this.stmts(st.orelse);
      case "FunctionDef": {
        st.decorators.forEach((d) => this.expr(d));
        this.params(st.args);
        this.bind(st.name);
        // (a generic's annotations and body in its type parameters' scope)
        const outer = st.typeParams ? this.enterTypeParams(st.typeParams, st.name) : null;
        // (its annotations, compiled into its lazy __annotate__ in their
        // own scope, keyed by the list)
        if (st.annotations?.length) {
          const as = this.annotationScope(st.annotations);
          st.annotations.forEach(([, e]) => this.annotation(as, e));
        }
        this.func(st, st.name, st.args, () => {
          if (st.isAsync) this.s.isAsync = this.s.isGenerator = true;
          this.stmts(st.body);
        });
        if (outer !== null) this.s = outer;
        return;
      }
      case "ClassDef": {
        st.decorators.forEach((d) => this.expr(d));
        this.bind(st.name);
        // (a generic's bases, keywords and body in its type parameters' scope)
        const outer = st.typeParams ? this.enterTypeParams(st.typeParams, st.name) : null;
        st.bases.forEach((b) => this.expr(b));
        st.keywords.forEach((k) => this.expr(k.value));
        const cs = this.newScope("class", st.name, st);
        const saved = this.s;
        this.s = cs;
        this.stmts(st.body);
        this.s = outer ?? saved;
        return;
      }
      case "TypeAlias": {
        this.bind(st.name);
        // (its value lazy, in a scope of its own, inside its type
        // parameters' if it is generic; seeing a class's namespace from a
        // class body, as CPython's)
        const inClass = this.s.kind === "class" ? this.s : null;
        const outer = st.typeParams.length ? this.enterTypeParams(st.typeParams, st.name) : null;
        const sc = this.newScope("function", st.name, st);
        sc.annotation = true;
        sc.info = "type alias";
        sc.classView = inClass ?? (outer !== null ? this.s.classView : null);
        this.annotation(sc, st.value);
        if (outer !== null) this.s = outer;
        return;
      }
      case "Import":
        return st.names.forEach((a) => this.bind(a.asname ?? a.name.split(".")[0], 0));
      case "ImportFrom":
        return st.names.forEach((a) => {
          if (a.name !== "*") this.bind(a.asname ?? a.name, 0);
        });
      case "Global":
        return st.names.forEach((n) => {
          if (this.s.params.has(n)) throw new SyntaxErr(`name '${n}' is parameter and global`, st.line);
          if (this.s.nonlocals.has(n)) throw new SyntaxErr(`name '${n}' is nonlocal and global`, st.line);
          this.declare(n, "global", st.line);
          this.s.globals.add(n);
        });
      case "Nonlocal":
        return st.names.forEach((n) => {
          if (this.s.kind === "module") throw new SyntaxErr("nonlocal declaration not allowed at module level", st.line);
          if (this.s.params.has(n)) throw new SyntaxErr(`name '${n}' is parameter and nonlocal`, st.line);
          if (this.s.globals.has(n)) throw new SyntaxErr(`name '${n}' is nonlocal and global`, st.line);
          this.declare(n, "nonlocal", st.line);
          this.s.nonlocals.add(n);
          if (this.s.kind !== "class") this.s.nonlocalLines.set(n, st.line);
        });
      case "Raise":
        if (st.exc) this.expr(st.exc);
        if (st.cause) this.expr(st.cause);
        return;
      case "Try":
        this.stmts(st.body);
        for (const h of st.handlers) {
          if (h.type) this.expr(h.type);
          if (h.name) this.bind(h.name);
          this.stmts(h.body);
        }
        this.stmts(st.orelse);
        return this.stmts(st.finalbody);
      case "With":
        for (const it of st.items) {
          this.expr(it.context);
          if (it.target) this.bindTarget(it.target);
        }
        return this.stmts(st.body);
      case "Assert":
        this.expr(st.test);
        if (st.msg) this.expr(st.msg);
        return;
      case "Delete":
        return st.targets.forEach((t) => this.bindTarget(t));
      default:
        return;
    }
  }

  expr(e: A.Expr | null) {
    if (e === null) return;
    switch (e.k) {
      case "Name":
        this.mark(this.s, e.id, USE);
        return;
      case "Const":
        return;
      case "FString":
        for (const p of e.parts) if (typeof p !== "string") this.fpart(p);
        return;
      case "BinOp":
        this.expr(e.left);
        return this.expr(e.right);
      case "UnaryOp":
        return this.expr(e.operand);
      case "BoolOp":
        return e.values.forEach((v) => this.expr(v));
      case "Compare":
        this.expr(e.left);
        return e.comparators.forEach((c) => this.expr(c));
      case "IfExp":
        this.expr(e.test);
        this.expr(e.body);
        return this.expr(e.orelse);
      case "Call":
        this.expr(e.func);
        e.args.forEach((a) => this.expr(a));
        return e.keywords.forEach((k) => this.expr(k.value));
      case "Attribute":
        return this.expr(e.value);
      case "Subscript":
        this.expr(e.value);
        return this.expr(e.index);
      case "Slice":
        this.expr(e.lower);
        this.expr(e.upper);
        return this.expr(e.step);
      case "List":
      case "Tuple":
      case "Set":
        return e.elts.forEach((x) => this.expr(x));
      case "Dict":
        e.keys.forEach((k) => this.expr(k));
        return e.values.forEach((v) => this.expr(v));
      case "Comp": {
        // The first iterable is evaluated in the enclosing scope.
        this.expr(e.generators[0].iter);
        const cs = this.newScope("comp", e.kind === "gen" ? "<genexpr>" : `<${e.kind}comp>`, e);
        if (e.kind === "gen") cs.isGenerator = true;
        const saved = this.s;
        this.s = cs;
        e.generators.forEach((g, i) => {
          if (i > 0) this.expr(g.iter);
          this.bindTarget(g.target);
          for (const n of targetNames(g.target)) cs.iterVars.add(n);
          g.ifs.forEach((c) => this.expr(c));
        });
        this.expr(e.elt);
        this.expr(e.value);
        this.s = saved;
        return;
      }
      case "Lambda":
        this.params(e.args);
        return this.func(e, "<lambda>", e.args, () => this.expr(e.body));
      case "Starred":
        return this.expr(e.value);
      case "Await": {
        const no = notWithin(this.s, "await expression");
        if (no !== null) throw new SyntaxErr(no, e.line);
        if (!this.s.isAsync) throw new SyntaxErr(this.s.kind === "comp" ? "await in comprehensions is not supported yet" : "'await' outside async function", e.line);
        return this.expr(e.value);
      }
      case "Yield":
      case "YieldFrom": {
        const no = notWithin(this.s, "yield expression");
        if (no !== null) throw new SyntaxErr(no, e.line);
        if (this.s.kind !== "function") throw new SyntaxErr("'yield' outside function", e.line);
        if (this.s.isAsync) throw new SyntaxErr(e.k === "YieldFrom" ? "'yield from' inside async function" : "async generators are not supported yet", e.line);
        this.s.isGenerator = true;
        return this.expr(e.value);
      }
      case "Intrinsic":
        return e.args?.forEach((a) => this.expr(a));
      case "NamedExpr": {
        // Binds in the nearest enclosing non-comprehension scope.
        if (this.s.kind === "comp") this.s.walrusTargets.add(e.target);
        let s: Scope = this.s;
        while (s.kind === "comp") {
          if (s.iterVars.has(e.target)) throw new SyntaxErr(`assignment expression cannot rebind comprehension iteration variable '${e.target}'`, e.line);
          s = s.parent!;
        }
        const no = notWithin(s, "named expression");
        if (no !== null) throw new SyntaxErr(s !== this.s && s.info === "generic" ? "assignment expression within a comprehension cannot be used within the definition of a generic" : no, e.line);
        if (s !== this.s) {
          if (s.kind === "class") throw new SyntaxErr("assignment expression within a comprehension cannot be used in a class body", e.line);
          for (let c: Scope = this.s; c !== s; c = c.parent!) c.nonlocals.add(e.target);
        }
        s.bound.add(e.target);
        // (in a comprehension at a module's top level, CPython's table does not count it)
        if (s === this.s || s.kind !== "module") this.mark(s, e.target, BOUND);
        return this.expr(e.value);
      }
    }
  }

  // A new annotation scope here. Its one parameter, format, binds no source
  // name (an annotation's `format` is the enclosing scopes', as CPython's):
  // src/emit.ts gives it a JS name of its own, ANNOT_FORMAT, which only
  // its locals() shows
  annotationScope(key: object, seesClass = true): Scope {
    const sc = this.newScope("function", "__annotate__", key);
    sc.annotation = true;
    sc.info = "annotation";
    // (in a class, or in a generic's type parameters' scope in one: the class's namespace first)
    if (seesClass) sc.classView = this.s.kind === "class" ? this.s : this.s.classView;
    return sc;
  }
  // An annotation's expression, in annotation scope `as`: its names that
  // scope's uses, not this one's
  annotation(as: Scope, e: A.Expr) {
    const saved = this.s;
    this.s = as;
    try {
      this.expr(e);
    } finally {
      this.s = saved;
    }
  }

  fpart(p: Exclude<A.FPart, string>) {
    this.expr(p.expr);
    if (p.spec) for (const q of p.spec) if (typeof q !== "string") this.fpart(q);
  }
}

function targetNames(t: A.Expr): string[] {
  switch (t.k) {
    case "Name":
      return [t.id];
    case "Tuple":
    case "List":
      return t.elts.flatMap(targetNames);
    case "Starred":
      return targetNames(t.value);
    default:
      return [];
  }
}
