// Python scoping: which names are local, closure (free), global, or class
// namespace entries.  One Scope per module, function, lambda, class body and
// comprehension.

import * as A from "./ast";

export type ScopeKind = "module" | "function" | "class" | "comp";

export class Scope {
  bound = new Set<string>();
  globals = new Set<string>();
  nonlocals = new Set<string>();
  params = new Set<string>();
  iterVars = new Set<string>(); // comprehension targets
  nonlocalLines = new Map<string, number>();
  isGenerator = false;
  isAsync = false;
  usesSuper = false;
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
  | { kind: "class"; outer: Resolution }; // class namespace, falling back to `outer`

export function resolve(scope: Scope, name: string): Resolution {
  if (scope.globals.has(name)) return { kind: "global" };
  if (scope.kind === "module") return { kind: "global" };
  if (scope.nonlocals.has(name)) {
    const s = findEnclosing(scope.parent, name);
    return s === null ? { kind: "global" } : { kind: "free", scope: s };
  }
  if (scope.bound.has(name)) {
    // A name bound in a class body is looked up in the class namespace and
    // then the globals, never in enclosing functions (LOAD_NAME).
    if (scope.kind === "class") return { kind: "class", outer: { kind: "global" } };
    return { kind: "local" };
  }
  if (scope.kind === "class") return { kind: "class", outer: resolveFree(scope.parent!, name) };
  return resolveFree(scope.parent!, name);
}

// A name not bound in some inner scope: the nearest enclosing function or
// comprehension binding it (class scopes are skipped), else global.
function resolveFree(scope: Scope, name: string): Resolution {
  const s = findEnclosing(scope, name);
  return s === null ? { kind: "global" } : { kind: "free", scope: s };
}

function findEnclosing(scope: Scope | null, name: string): Scope | null {
  for (let s = scope; s !== null; s = s.parent) {
    if (s.kind === "class") continue;
    if (s.kind === "module" || s.globals.has(name)) return null;
    if (s.bound.has(name) || s.nonlocals.has(name)) {
      if (s.nonlocals.has(name)) return findEnclosing(s.parent, name);
      return s;
    }
  }
  return null;
}

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
    if (findEnclosing(s.parent, n) === null) throw new SyntaxErr(`no binding for nonlocal '${n}' found`, line);
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

  bind(name: string) {
    this.s.bound.add(name);
  }

  stmts(body: A.Stmt[]) {
    for (const st of body) this.stmt(st);
  }

  params(p: A.Params) {
    for (const a of [...p.args, ...p.kwonly]) if (a.default) this.expr(a.default);
  }

  newScope(kind: ScopeKind, name: string, node: object): Scope {
    const prefix = this.s.kind === "module" ? "" : this.s.kind === "function" ? `${this.s.qualname}.<locals>.` : `${this.s.qualname}.`;
    const sc = new Scope(kind, name, this.s, prefix + name);
    this.s.children.set(node, sc);
    return sc;
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
      case "AnnAssign":
        if (st.value) this.expr(st.value);
        if (st.value || st.target.k !== "Name") this.bindTarget(st.target);
        else if (st.target.k === "Name" && this.s.kind !== "module" && this.s.kind !== "class") this.bind(st.target.id);
        return;
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
      case "FunctionDef":
        st.decorators.forEach((d) => this.expr(d));
        this.params(st.args);
        this.bind(st.name);
        return this.func(st, st.name, st.args, () => {
          if (st.isAsync) this.s.isAsync = this.s.isGenerator = true;
          this.stmts(st.body);
        });
      case "ClassDef": {
        st.decorators.forEach((d) => this.expr(d));
        st.bases.forEach((b) => this.expr(b));
        st.keywords.forEach((k) => this.expr(k.value));
        this.bind(st.name);
        const cs = this.newScope("class", st.name, st);
        const saved = this.s;
        this.s = cs;
        this.stmts(st.body);
        this.s = saved;
        return;
      }
      case "Import":
        return st.names.forEach((a) => this.bind(a.asname ?? a.name.split(".")[0]));
      case "ImportFrom":
        return st.names.forEach((a) => {
          if (a.name !== "*") this.bind(a.asname ?? a.name);
        });
      case "Global":
        return st.names.forEach((n) => {
          if (this.s.params.has(n)) throw new SyntaxErr(`name '${n}' is parameter and global`, st.line);
          if (this.s.nonlocals.has(n)) throw new SyntaxErr(`name '${n}' is nonlocal and global`, st.line);
          if (this.s.bound.has(n)) throw new SyntaxErr(`name '${n}' is assigned to before global declaration`, st.line);
          this.s.globals.add(n);
        });
      case "Nonlocal":
        return st.names.forEach((n) => {
          if (this.s.kind === "module") throw new SyntaxErr("nonlocal declaration not allowed at module level", st.line);
          if (this.s.params.has(n)) throw new SyntaxErr(`name '${n}' is parameter and nonlocal`, st.line);
          if (this.s.globals.has(n)) throw new SyntaxErr(`name '${n}' is nonlocal and global`, st.line);
          if (this.s.bound.has(n)) throw new SyntaxErr(`name '${n}' is assigned to before nonlocal declaration`, st.line);
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
        if (e.id === "super" || e.id === "__class__") {
          for (let s: Scope | null = this.s; s !== null && s.kind !== "class"; s = s.parent) s.usesSuper = true;
        }
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
      case "Await":
        if (!this.s.isAsync) throw new SyntaxErr(this.s.kind === "comp" ? "await in comprehensions is not supported yet" : "'await' outside async function", e.line);
        return this.expr(e.value);
      case "Yield":
      case "YieldFrom":
        if (this.s.kind !== "function") throw new SyntaxErr("'yield' outside function", e.line);
        if (this.s.isAsync) throw new SyntaxErr(e.k === "YieldFrom" ? "'yield from' inside async function" : "async generators are not supported yet", e.line);
        this.s.isGenerator = true;
        return this.expr(e.value);
      case "NamedExpr": {
        // Binds in the nearest enclosing non-comprehension scope.
        let s: Scope = this.s;
        while (s.kind === "comp") {
          if (s.iterVars.has(e.target)) throw new SyntaxErr(`assignment expression cannot rebind comprehension iteration variable '${e.target}'`, e.line);
          s = s.parent!;
        }
        if (s !== this.s) {
          if (s.kind === "class") throw new SyntaxErr("assignment expression within a comprehension cannot be used in a class body", e.line);
          for (let c: Scope = this.s; c !== s; c = c.parent!) c.nonlocals.add(e.target);
        }
        if (s.kind !== "module") s.bound.add(e.target);
        else s.bound.add(e.target);
        return this.expr(e.value);
      }
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
