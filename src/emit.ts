// Python AST -> JavaScript.  See PLAN.md for the value representation and
// the shapes of generated code.

import * as A from "./ast";
import { Scope, resolve, Resolution, SyntaxErr, implicitClassDict } from "./scope";

const BIN: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "truediv", "//": "floordiv", "%": "mod", "**": "pow", "<<": "lshift", ">>": "rshift", "&": "and", "|": "or", "^": "xor", "@": "matmul", "sage/": "sagediv", "sage**": "sagepow" };
const CMP: Record<string, string> = { "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "==": "eq", "!=": "ne" };
const UNARY: Record<string, string> = { "-": "neg", "+": "pos", "~": "invert" };
// an __annotate__'s format parameter: a JS name no source name compiles to
const ANNOT_FORMAT = "$afmt";

const REUSING = new Set(["add", "sub", "mul", "truediv"]);
const FRESH_OPS = new Set(["add", "sub", "mul", "truediv", "floordiv", "mod", "pow"]);
const tmpOperand = (e: A.Expr) => (e.k === "BinOp" && FRESH_OPS.has(BIN[e.op])) || (e.k === "UnaryOp" && e.op === "-");

export const q = (s: string) => JSON.stringify(s);
const JS_ID = /^[\p{ID_Start}_$][\p{ID_Continue}$‌‍]*$/u;
// Python names in JS: locals get a `$` suffix, which no Python name can
// contain, so they never collide with runtime helpers or temporaries.
export function js(id: string): string {
  if (JS_ID.test(id)) return id + "$";
  return "u" + [...id].map((c) => c.codePointAt(0)!.toString(16)).join("_") + "$";
}
const prop = (id: string) => (/^[A-Za-z_$][\w$]*$/.test(id) ? "." + id : `[${q(id)}]`);

interface Line {
  text: string;
  py: number;
}

// One compiled JS function: module body, def, lambda, class body, comprehension.
class Fn {
  temps: string[] = []; // every temporary declared in this JS function
  free: string[] = []; // temporaries available for reuse
  inUse: string[] = [];
  assigned = new Set<string>();
  buf: Line[] = [];
  loops: { label: string | null }[] = [];
  // a module's or class body's annotated names: each statement's index, and
  // how one is marked executed (the module's __conditional_annotations__,
  // or the class body's own set)
  annots: { index: Map<A.Stmt, number>; mark: (i: number) => string } | null = null;
  constructor(
    public scope: Scope,
    public parent: Fn | null,
    public selfName: string, // JS name of the function, for prologue references
    // the Python name of its first positional parameter, for super() (".0"
    // for a generator expression, whose first argument is its iterator; a
    // list, set or dict comprehension has its function's, being inlined in
    // CPython)
    public firstParam: string | null
  ) {}
}

export interface Compiled {
  code: string;
  lineMap: number[];
}

export class Emitter {
  fn!: Fn;
  indent = 0;
  line = 1;
  hoisted: string[] = [];
  private counter = 0;
  private cells = 0;

  constructor(
    private top: Scope,
    private builtinNames: Set<string>,
    private moduleName: string
  ) {}

  // ------------------------------------------------------------ output

  w(text: string) {
    this.fn.buf.push({ text: "  ".repeat(this.indent) + text, py: this.line });
  }
  // Temporaries live until the end of the statement that allocated them
  // (compound statements: until the end of their body), then are reused.
  temp(): string {
    let t = this.fn.free.pop();
    if (t === undefined) {
      t = "$" + ++this.counter;
      this.fn.temps.push(t);
    }
    this.fn.inUse.push(t);
    return t;
  }
  hoist(expr: string): string {
    const name = "$K" + this.hoisted.length;
    this.hoisted.push(`const ${name} = ${expr};`);
    return name;
  }

  site(kind: string, name: string, n?: number): string {
    return this.hoist(`R.${kind}(${q(name)}${n === undefined ? "" : ", " + n})`);
  }
  fail(msg: string, line = this.line): never {
    throw new SyntaxErr(msg, line);
  }

  // ------------------------------------------------------------ names

  private moduleNames: Set<string> | null = null;
  moduleBinds(id: string): boolean {
    if (this.moduleNames === null) {
      this.moduleNames = new Set(this.top.bound);
      for (const s of allScopes(this.top)) for (const g of s.globals) this.moduleNames.add(g);
    }
    return this.moduleNames.has(id);
  }

  load(id: string): string {
    // (naming super in a function of a class gives the class its cell, as in
    // CPython, whatever the name is used for)
    if (id === "super" && this.fn.scope.kind !== "class" && this.fn.scope.kind !== "module") {
      const r = resolve(this.fn.scope, "__class__");
      if (r.kind === "classcell") this.cellOf(r.scope);
    }
    return this.loadRes(resolve(this.fn.scope, id), id);
  }
  // the JS name of a class's cell (scope.ts: cellName), the class now making one
  cellOf(cls: Scope): string {
    if (cls.cellName === null) cls.cellName = `$cc${this.cells++}`;
    return cls.cellName;
  }
  // The namespace a global name is read, written and deleted in: $g, the
  // module's namespace, at its top level (an inlined list, set or dict
  // comprehension's too, as CPython's); $G, its globals, everywhere else
  // (functions, lambdas, generator expressions, class bodies) and for a
  // name the top level declares global. They differ only for exec and eval
  // with separate globals and locals, where $g reads the locals, then the
  // globals, and writes the locals (CPython's LOAD_NAME and STORE_NAME),
  // and a function defined there sees only the globals.
  gns(id: string): string {
    const cur = this.fn.scope;
    let s = cur;
    const comp = s.kind === "comp" && !s.isGenerator;
    // (a walrus target of a top-level comprehension is the globals' in that
    // comprehension, reads and writes alike, declared global or not:
    // CPython's symbol table does not count it as the top level's local,
    // CORR-756-1; only that comprehension's own targets, not those of one
    // inside or around it, CORR-7D2-1)
    const walrus = comp && cur.walrusTargets.has(id);
    while (s.kind === "comp" && !s.isGenerator && s.parent !== null) s = s.parent;
    if (s.kind !== "module") return "$G";
    // (an inlined comprehension at the top level reads the top level's
    // namespace even for a name declared global there, as CPython's,
    // CORR-C0F-1; the top level itself uses the globals for a name
    // declared global there or in any scope inside, CORR-C0F-2)
    if (comp) return walrus ? "$G" : "$g";
    return s.globals.has(id) || this.globalAnywhere().has(id) || this.moduleWalrus().has(id) ? "$G" : "$g";
  }
  // the names a comprehension's walrus binds at the module's top level (in
  // one there, or nested in one, a generator expression's too): CPython's
  // symbol table makes them the top level's globals, its loads, stores and
  // deletes of them the globals' outside comprehensions
  private walrusNames: Set<string> | null = null;
  moduleWalrus(): Set<string> {
    if (this.walrusNames === null) {
      this.walrusNames = new Set();
      for (const s of allScopes(this.top)) {
        let p: Scope | null = s;
        while (p !== null && p.kind === "comp") p = p.parent;
        if (p !== s && p !== null && p.kind === "module") for (const n of s.walrusTargets) this.walrusNames.add(n);
      }
    }
    return this.walrusNames;
  }
  // the names some scope of this module declares global
  private globalNames: Set<string> | null = null;
  globalAnywhere(): Set<string> {
    if (this.globalNames === null) {
      this.globalNames = new Set();
      for (const s of allScopes(this.top)) for (const n of s.globals) this.globalNames.add(n);
    }
    return this.globalNames;
  }
  // (nameLoad: a class body's read past its namespace, LOAD_NAME's, whose
  // globals are their storage)
  loadRes(r: Resolution, id: string, nameLoad = false): string {
    switch (r.kind) {
      case "local":
        return this.fn.assigned.has(id) && !this.innerNonlocals(this.fn.scope).has(id) ? js(id) : `(${js(id)} !== undefined ? ${js(id)} : unboundLocal(${q(id)}))`;
      case "free":
        return `(${js(id)} !== undefined ? ${js(id)} : unboundFree(${q(id)}))`;
      case "global": {
        const t = this.temp();
        // (the globals' loads, $GL, where they are $G: LOAD_GLOBAL's; then
        // the code's builtins, $B)
        const ns = this.gns(id) === "$G" ? (nameLoad ? "$G" : "$GL") : "$g";
        if (!this.moduleBinds(id) && this.builtinNames.has(id)) return `((${t} = ${ns}${prop(id)}) !== undefined ? ${t} : (${t} = $B${prop(id)}) !== undefined ? ${t} : R.unboundName(${q(id)}))`;
        return `((${t} = ${ns}${prop(id)}) !== undefined ? ${t} : R.builtinName($B, ${q(id)}))`;
      }
      case "class": {
        if (id[0] === "$") return this.classTemp(id);
        // (one read of the namespace: a prepared one's __getitem__ once)
        const t = this.temp();
        return `((${t} = $ns.get(${q(id)})) !== undefined ? ${t} : ${this.loadRes(r.outer, id, true)})`;
      }
      case "classcell":
        return `classCellGet(${this.cellOf(r.scope)})`;
    }
  }
  // The names scopes inside `scope` declare nonlocal: a call can unbind
  // them (`nonlocal x; del x`), so an assignment seen here does not make
  // them bound afterwards
  innerNonlocals(scope: Scope): Set<string> {
    let r = this.innerNonlocalsOf.get(scope);
    if (r === undefined) {
      r = new Set<string>();
      const walk = (s: Scope) => {
        for (const c of s.children.values()) {
          for (const n of c.nonlocals) r!.add(n);
          walk(c);
        }
      };
      walk(scope);
      this.innerNonlocalsOf.set(scope, r);
    }
    return r;
  }
  innerNonlocalsOf = new Map<Scope, Set<string>>();
  // A statement storing `value` into a name.
  storeName(id: string, value: string): string {
    const r = resolve(this.fn.scope, id);
    switch (r.kind) {
      case "local":
        this.fn.assigned.add(id);
        return `${js(id)} = ${value};`;
      case "free":
        return `${js(id)} = ${value};`;
      case "global":
        return `${this.gns(id)}${prop(id)} = ${value};`;
      case "class":
        if (id[0] === "$") return `${this.classTemp(id)} = ${value};`;
        return `$ns.set(${q(id)}, ${value});`;
      case "classcell":
        // (nonlocal __class__)
        return `${this.cellOf(r.scope)}.v = ${value};`;
    }
  }

  // A lazy __annotate__(format, /) for `entries` (CPython 3.14's, PEP
  // 649/749), in annotation scope `as` (src/scope.ts): its own JS function
  // inside this one, its names resolved as CPython's annotation scope's (an
  // enclosing function's locals as closures, the globals as a function's,
  // a class's namespace first); an entry with a gate only if that is true
  // (an annotated statement executed). Returns the temp holding it.
  // (a function's is named for it: f.__annotate__, as CPython 3.14.8's; a
  // class body's or module's for the scope)
  annotateFn(as: Scope, entries: { key: string; expr: A.Expr; gate: string | null }[], owner: string | null = null): string {
    const s = this.fn.scope;
    const qual = owner !== null ? `${owner}.__annotate__` : (s.kind === "module" ? "" : s.kind === "function" ? `${s.qualname}.<locals>.` : `${s.qualname}.`) + "__annotate__";
    const line = this.line;
    const fmt = ANNOT_FORMAT;
    // (a class's: its __classdict__, the class body's one cell's dict)
    const cd = implicitClassDict(as) ? (as.parent!.classDictName ??= `$cd${this.cells++}`) : null;
    const { lines, decls } = this.nested(as, "__annotate__$", null, [], () => {
      this.w(`R.annotateFormat(${fmt});`);
      if (cd !== null) this.w(`const ${js("__classdict__")} = R.classDict(${cd});`);
      this.w("const $d = newDict();");
      for (const e of entries) {
        this.line = e.expr.line;
        const set = `dictSet($d, ${q(e.key)}, ${this.ex(e.expr)});`;
        this.w(e.gate === null ? set : `if (${e.gate}) ${set}`);
      }
      this.w("return $d;");
    });
    this.line = line;
    const t = this.temp();
    this.w(`${t} = defn(function __annotate__$(${fmt}) {`);
    this.indent++;
    if (decls.length) this.w(`let ${decls.join(", ")};`);
    this.indent--;
    this.splice(lines);
    this.w(`}, "__annotate__", ${q(qual)}, $G.__name__, null, null, R.annotateSig, null, $g);`);
    return t;
  }

  // (a stringized annotation stored as it executes: __annotations__[name] =
  // its string, the name looked up as the body looks it up)
  futureMark(index: Map<A.Stmt, number>, i: number): string {
    const st = [...index].find(([, j]) => j === i)![0] as any;
    return `setitem(${this.load("__annotations__")}, ${q(st.target.id)}, ${q(st.annotation.value.v)});`;
  }

  // A temp the front end made ("$" names: match's subject and captures) in
  // a class body: a JS variable of the body's function, not the namespace
  // (CPython's are on its stack, never in the class's __dict__)
  classTemp(id: string): string {
    const v = js(id);
    if (!this.fn.temps.includes(v)) this.fn.temps.push(v);
    return v;
  }

  // An except clause's name at its end: None, then deleted, through the
  // namespace's own operations (a locals mapping sees both, CORR-FBF-1)
  clearName(id: string): string {
    const r = resolve(this.fn.scope, id);
    if (r.kind === "global") return `${this.gns(id)}${prop(id)} = null; R.delName(${this.gns(id)}, ${q(id)});`;
    if (r.kind === "class") return `$ns.set(${q(id)}, null); if (!$ns.delete(${q(id)})) R.unboundName(${q(id)});`;
    return this.storeName(id, "undefined");
  }

  // ------------------------------------------------------------ expressions

  ex(e: A.Expr): string {
    switch (e.k) {
      case "Name":
        return this.load(e.id);
      case "Const":
        return this.constant(e.value);
      case "FString":
        return this.fstring(e.parts);
      case "BinOp": {
        // an operand that is itself an operator expression may be a
        // temporary array the operation can reuse (FRESH in runtime/ops.ts)
        const w = (tmpOperand(e.left) ? 1 : 0) | (tmpOperand(e.right) ? 2 : 0);
        if (w && REUSING.has(BIN[e.op])) return `${BIN[e.op]}T(${this.ex(e.left)}, ${this.ex(e.right)}, ${w})`;
        return `${BIN[e.op]}(${this.ex(e.left)}, ${this.ex(e.right)})`;
      }
      case "UnaryOp":
        if (e.op === "not") return `!${this.bool(e.operand)}`;
        return `${UNARY[e.op]}(${this.ex(e.operand)})`;
      case "BoolOp": {
        let code = this.ex(e.values[e.values.length - 1]);
        for (let i = e.values.length - 2; i >= 0; i--) {
          const t = this.temp();
          const v = this.ex(e.values[i]);
          code = e.op === "and" ? `(truth(${t} = ${v}) ? ${code} : ${t})` : `(truth(${t} = ${v}) ? ${t} : ${code})`;
        }
        return code;
      }
      case "Compare":
        return this.compare(e);
      case "IfExp":
        return `(${this.bool(e.test)} ? ${this.ex(e.body)} : ${this.ex(e.orelse)})`;
      case "Call":
        return this.call(e);
      case "Attribute":
        return `${this.site("siteGet", e.attr)}(${this.attrBase(e.value)})`;
      case "Subscript":
        return `getitem(${this.ex(e.value)}, ${this.ex(e.index)})`;
      case "Slice":
        return `new PySlice(${this.opt(e.lower)}, ${this.opt(e.upper)}, ${this.opt(e.step)})`;
      case "List":
        return this.items(e.elts);
      case "Tuple":
        if (e.elts.every((x) => x.k === "Const")) return this.hoist(`R.tuple(${this.items(e.elts)})`);
        return `tuple(${this.items(e.elts)})`;
      case "Set":
        return `newSet(${this.items(e.elts)})`;
      case "Dict": {
        const t = this.temp();
        const parts = [`${t} = newDict()`];
        e.keys.forEach((k, i) => parts.push(k === null ? `dictUpdate(${t}, ${this.ex(e.values[i])})` : `dictSet(${t}, ${this.ex(k)}, ${this.ex(e.values[i])})`));
        return `(${parts.join(", ")}, ${t})`;
      }
      case "Comp":
        return this.comprehension(e);
      case "Lambda":
        return this.lambda(e);
      case "Starred":
        this.fail("can't use starred expression here", e.line);
      case "Yield":
        return `(yield ${e.value === null ? "null" : this.ex(e.value)})`;
      case "YieldFrom":
        return `yfr(yield* yieldFrom(${this.ex(e.value)}))`;
      case "Await":
        return `yfr(yield* awaitIter(${this.ex(e.value)}))`;
      case "Intrinsic":
        return e.args === null ? `R.$i.${e.name}` : `R.$i.${e.name}(${e.args.map((a) => this.ex(a)).join(", ")})`;
      case "NamedExpr": {
        const t = this.temp();
        let s: Scope = this.fn.scope;
        const target = this.storeName(e.target, t);
        void s;
        return `(${t} = ${this.ex(e.value)}, ${target.slice(0, -1)}, ${t})`;
      }
    }
  }

  opt(e: A.Expr | null): string {
    return e === null ? "null" : this.ex(e);
  }

  // A JS boolean for a Python truth test.
  bool(e: A.Expr): string {
    if (e.k === "UnaryOp" && e.op === "not") return `!${this.bool(e.operand)}`;
    if (e.k === "BoolOp") return `(${e.values.map((v) => this.bool(v)).join(e.op === "and" ? " && " : " || ")})`;
    if (e.k === "Const" && e.value.t === "bool") return String(e.value.v);
    if (e.k === "Compare" && e.ops.length === 1 && ["is", "is not", "in", "not in"].includes(e.ops[0])) return this.compare(e);
    return `truth(${this.ex(e)})`;
  }

  items(elts: A.Expr[]): string {
    return `[${elts.map((x) => (x.k === "Starred" ? `...toArray(${this.ex(x.value)})` : this.ex(x))).join(", ")}]`;
  }

  constant(c: A.Constant): string {
    switch (c.t) {
      case "int":
        if (c.v >= -9007199254740991n && c.v <= 9007199254740991n) return c.v < 0n ? `(${c.v})` : String(c.v);
        return `${c.v}n`;
      case "float": {
        const v = c.v;
        if (Number.isInteger(v)) return this.hoist(`fbox(${Object.is(v, -0) ? "-0" : String(v)})`);
        if (v !== v) return "NaN";
        if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "(-Infinity)";
        return v < 0 ? `(${String(v)})` : String(v);
      }
      case "complex": {
        const v = c.v;
        return this.hoist(`new R.PyComplex(0, ${v !== v ? "NaN" : v === Infinity ? "Infinity" : String(v)})`);
      }
      case "str":
        return q(c.v);
      case "bytes":
        return this.hoist(`new R.PyBytes(Uint8Array.from(${JSON.stringify(c.v)}))`);
      case "bool":
        return String(c.v);
      case "None":
        return "null";
      case "Ellipsis":
        return "Ellipsis";
    }
  }

  fstring(parts: A.FPart[]): string {
    if (parts.length === 0) return '""';
    const pieces: string[] = [];
    for (const p of parts) {
      if (typeof p === "string") {
        pieces.push(q(p));
        continue;
      }
      const spec = p.spec === null ? '""' : this.fstring(p.spec);
      if (p.text) pieces.push(q(p.text));
      pieces.push(`fmt(${this.ex(p.expr)}, ${p.conv === null ? "null" : q(p.conv)}, ${spec})`);
    }
    // (fcat joins the pieces refusing to join lone surrogates into one
    // character, CORR-C4D-1; one piece is a string already)
    return pieces.length === 1 ? pieces[0] : `fcat(${pieces.join(", ")})`;
  }

  compare(e: Extract<A.Expr, { k: "Compare" }>): string {
    const one = (op: string, a: string, b: string): string => {
      switch (op) {
        case "in":
          return `contains(${b}, ${a})`;
        case "not in":
          return `!contains(${b}, ${a})`;
        case "is":
          return b === "null" ? `(${a} === null)` : `is(${a}, ${b})`;
        case "is not":
          return b === "null" ? `(${a} !== null)` : `!is(${a}, ${b})`;
        default:
          return `${CMP[op]}(${a}, ${b})`;
      }
    };
    if (e.ops.length === 1) return one(e.ops[0], this.ex(e.left), this.ex(e.comparators[0]));
    // a < b < c: b evaluated once; stop at the first false result.
    let left = this.ex(e.left);
    const parts: string[] = [];
    for (let i = 0; i < e.ops.length; i++) {
      const last = i === e.ops.length - 1;
      const right = last ? this.ex(e.comparators[i]) : `(${this.temp()} = ${this.ex(e.comparators[i])})`;
      const rtemp = last ? right : right.slice(1, right.indexOf(" ="));
      parts.push(one(e.ops[i], left, right));
      left = rtemp;
    }
    let code = parts[parts.length - 1];
    for (let i = parts.length - 2; i >= 0; i--) {
      const t = this.temp();
      code = `(truth(${t} = ${parts[i]}) ? ${code} : ${t})`;
    }
    return code;
  }
  // ------------------------------------------------------------ calls

  call(e: Extract<A.Expr, { k: "Call" }>): string {
    const f = e.func;
    if (this.isZeroArgSuper(e)) return this.zeroArgSuper(false);
    const intro = this.introspectionCall(e);
    if (intro !== null) {
      // (guarded on the name still being the builtin's own function: a
      // locals mapping, the globals or the builtins module can bind it
      // otherwise, and CPython looks it up as any name)
      const t = this.temp();
      const id = (f as Extract<A.Expr, { k: "Name" }>).id;
      return `((${t} = ${this.load(id)}) === R.originalBuiltins${prop(id)} ? ${intro} : ${this.plainCall(e, t)})`;
    }
    const consumed = this.consumingCall(e);
    if (consumed !== null) return consumed;
    return this.plainCall(e);
  }
  // `open(F, M).write(S)` as a statement (an expression statement, a cell's
  // displayed last one, one assignment's value, a return's): the file is opened at
  // the open call's position, written and closed at the statement, as
  // CPython's temporary is when its last reference goes, where pyjs's file
  // object would keep the data until a close, the cell's end or the
  // program's (plan-pyjs-file-visibility r7, addendum 1, then c1 + c2:
  // runtime/file-once.ts has the protocol).  F, M and S are any expressions,
  // each evaluated once, where today's code evaluates it: open, F and M
  // first; then, when open is the builtin, F an exact str and M one of w, a,
  // wb, ab (identity, typeof and ===, no Python call), the native open, else
  // today's call of open; then S, in a try whose finally closes the native descriptor
  // once, on an exception or Stop too; then the write.  Nothing is read
  // ahead of its place, so no namespace needs checking.  S with yield or
  // await isn't a site (the descriptor isn't held across a suspension).
  fileOnceShape(e: A.Expr): { o: A.Expr; f: A.Expr; m: A.Expr; s: A.Expr } | null {
    if (e.k !== "Call" || e.func.k !== "Attribute" || e.func.attr !== "write" || e.args.length !== 1 || e.keywords.length !== 0 || e.args[0].k === "Starred") return null;
    const c = e.func.value;
    if (c.k !== "Call" || c.args.length !== 2 || c.keywords.length !== 0 || c.args.some((a) => a.k === "Starred")) return null;
    // (the calls the compiler gives its caller's namespaces stay as they are)
    if (c.func.k === "Name" && ["globals", "locals", "vars", "dir", "eval", "exec", "super"].includes(c.func.id)) return null;
    if (suspends(e.args[0])) return null;
    return { o: c.func, f: c.args[0], m: c.args[1], s: e.args[0] };
  }
  fileOnceStmt(value: A.Expr, after: ((v: string) => void) | null): boolean {
    const x = this.fileOnceShape(value);
    if (x === null) return false;
    const canon = this.hoist("R.fileOnceOpen()");
    // (the declined path: today's write call, its method looked up after S
    // is evaluated as for any call of a method in pyjs; looking it up before
    // S, CPython's order, made a bound method per call and cost a near-no-op
    // writer 15 times its time)
    // (WAIVER, approved by William on 2026-10-25 at 1:20 PM PDT, "Accept
    // this one documented exception": a declined site whose open is a user
    // function returning a near-no-op writer, in a tight loop, costs 1.114
    // times the same code without the site (7 rounds of best-of-5, VM1;
    // 15.75 against 14.22 ns a call, 1.53 ns more), over the 1.01 gate;
    // every other gate passes.  /scratch/sagebrush-reviews/fv-gates-r3-vm1/
    // g6-nosite.json)
    const call = this.site("siteCall", "write", 1);
    const [to, tf, tm, th, tobj, tv] = [this.temp(), this.temp(), this.temp(), this.temp(), this.temp(), this.temp()];
    const eo = this.ex(x.o);
    this.w(`${to} = ${eo};`);
    const ef = this.ex(x.f);
    this.w(`${tf} = ${ef};`);
    const em = this.ex(x.m);
    this.w(`${tm} = ${em}; ${th} = null;`);
    this.w(`if (${to} === ${canon} && typeof ${tf} === "string" && (${tm} === "w" || ${tm} === "a" || ${tm} === "wb" || ${tm} === "ab")) ${th} = R.fileOnceBegin(${tf}, ${tm});`);
    this.w(`else ${tobj} = typeof ${to} === "function" ? ${to}(${tf}, ${tm}) : callObj(${to}, [${tf}, ${tm}]);`);
    this.w("try {");
    this.indent++;
    // (S, evaluated once, on either branch: handed over in R.fileOnceS on the
    // native one, so that no temporary, argument or register of the frame
    // keeps it (addendum 1); passed as today's code passes it on the
    // declined one, where a slot round trip cost the near-no-op writer)
    const es = this.ex(x.s);
    this.w(`${tv} = ${th} !== null ? (R.fileOnceS.v = ${es}, R.fileOnceEnd(${th})) : ${call}(${tobj}, ${es});`);
    this.indent--;
    this.w(`} finally {`);
    this.w(`  if (${th} !== null) { R.fileOnceAbort(${th}); ${th} = null; }`);
    this.w(`  ${tobj} = undefined;`);
    this.w("}");
    if (after !== null) after(tv);
    return true;
  }
  // A call of e.func, or of `callee`, the JavaScript holding it
  plainCall(e: Extract<A.Expr, { k: "Call" }>, callee?: string): string {
    const f = e.func;
    const simple = !e.args.some((a) => a.k === "Starred") && e.keywords.length === 0;
    if (simple) {
      if (f.k === "Attribute") {
        const s = this.site("siteCall", f.attr, e.args.length);
        return `${s}(${[this.attrBase(f.value), ...e.args.map((a) => this.ex(a))].join(", ")})`;
      }
      // Evaluate the callee and arguments into temporaries so the generated
      // code stays linear in the nesting depth.
      const t = this.temp();
      const pre = [`${t} = ${callee ?? this.ex(f)}`];
      const args = e.args.map((a) => {
        const at = this.temp();
        pre.push(`${at} = ${this.ex(a)}`);
        return at;
      });
      return `(${pre.join(", ")}, typeof ${t} === "function" ? ${t}(${args.join(", ")}) : callObj(${t}, [${args.join(", ")}]))`;
    }
    const fn = callee ?? this.ex(f);
    const pos = this.items(e.args);
    const names: string[] = [], values: string[] = [], maps: string[] = [];
    for (const k of e.keywords) {
      if (k.arg === null) maps.push(this.ex(k.value));
      else {
        if (names.includes(q(k.arg))) this.fail(`keyword argument repeated: ${k.arg}`, e.line);
        names.push(q(k.arg));
        values.push(this.ex(k.value));
      }
    }
    if (maps.length === 0) return `callKw(${fn}, ${pos}, [${names.join(", ")}], [${values.join(", ")}])`;
    return `callEx(${fn}, ${pos}, [${names.join(", ")}], [${values.join(", ")}], [${maps.join(", ")}])`;
  }

  // globals(), locals(), vars(), dir(), eval() and exec() need the caller's
  // namespaces, which only the compiler knows.
  introspectionCall(e: Extract<A.Expr, { k: "Call" }>): string | null {
    const f = e.func;
    if (f.k !== "Name" || e.keywords.length !== 0 || e.args.some((a) => a.k === "Starred")) return null;
    const names = ["globals", "locals", "vars", "dir", "eval", "exec"];
    const r = resolve(this.fn.scope, f.id);
    const isGlobal = r.kind === "global" || (r.kind === "class" && r.outer.kind === "global" && !this.fn.scope.bound.has(f.id));
    if (!names.includes(f.id) || !isGlobal || this.moduleBinds(f.id)) return null;
    const n = e.args.length;
    if ((f.id === "vars" || f.id === "dir") && n !== 0) return null;
    if (f.id === "globals" && n === 0) return "R.globalsDict($g)";
    const scope = this.fn.scope;
    const localsExpr = (): string => {
      if (scope.kind === "module") return "R.moduleLocals($g)";
      if (scope.kind === "class") return "R.classLocals($ns)";
      const ls = [...scope.bound].filter((x) => !scope.globals.has(x));
      const vs = ls.map((x) => (resolve(scope, x).kind === "global" ? "undefined" : js(x)));
      // (an annotation scope's: its format parameter, and in a class the
      // class's namespace, __classdict__, as CPython's)
      if (scope.annotation) {
        const cd = implicitClassDict(scope);
        ls.unshift(...(cd ? ["format", "__classdict__"] : ["format"]));
        vs.unshift(...(cd ? [ANNOT_FORMAT, js("__classdict__")] : [ANNOT_FORMAT]));
      }
      return `R.localsDict(${JSON.stringify(ls)}, [${vs.join(", ")}])`;
    };
    if (f.id === "locals" || f.id === "vars") return n === 0 ? localsExpr() : null;
    if (f.id === "dir") return `sortedKeys(${localsExpr()})`;
    if (n < 1 || n > 3) return null;
    const args = e.args.map((a) => this.ex(a));
    const callerLocals = n === 1 && scope.kind !== "module" ? localsExpr() : "null";
    const fn = f.id === "eval" ? "R.evalIn" : "R.execIn";
    // (a function's exec and eval run in its globals, $G)
    return `${fn}(${args[0]}, ${args[1] ?? "undefined"}, ${args[2] ?? "undefined"}, ${scope.kind === "module" ? "$g" : "$G"}, ${callerLocals}, $B)`;
  }

  // `tuple(x for ...)`, `sum(...)`, `any(...)` etc. on the builtin: run the
  // generator expression as an eager loop (they consume it entirely or stop
  // at the first decisive item), guarded on the name still being the builtin.
  consumingCall(e: Extract<A.Expr, { k: "Call" }>): string | null {
    const f = e.func;
    if (f.k !== "Name" || e.args.length !== 1 || e.keywords.length !== 0 || e.args[0].k !== "Comp" || e.args[0].kind !== "gen") return null;
    const kinds: Record<string, string> = { tuple: "tuple", list: "list", set: "set", frozenset: "frozenset", sum: "sum", any: "any", all: "all", sorted: "list", min: "list", max: "list" };
    const kind = kinds[f.id];
    if (kind === undefined || resolve(this.fn.scope, f.id).kind !== "global" || this.moduleBinds(f.id)) return null;
    const comp = e.args[0];
    const fn = this.temp();
    const fast = this.comprehension(comp, kind);
    const slow = this.comprehension(comp);
    const wrap: Record<string, string> = { tuple: `tuple(${fast})`, list: fast, set: fast, frozenset: `R.newSet(${fast}, true)`, sum: fast, any: fast, all: fast, sorted: `${fn}(${fast})`, min: `${fn}(${fast})`, max: `${fn}(${fast})` };
    return `((${fn} = ${this.load(f.id)}) === R.originalBuiltins${prop(f.id)} ? ${wrap[f.id]} : callObj(${fn}, [${slow}]))`;
  }

  // super(), with no arguments, naming the builtin
  isZeroArgSuper(e: A.Expr): boolean {
    if (e.k !== "Call" || e.func.k !== "Name" || e.func.id !== "super" || e.args.length !== 0 || e.keywords.length !== 0) return false;
    const r = resolve(this.fn.scope, "super");
    return (r.kind === "global" || (r.kind === "class" && !this.fn.scope.bound.has("super") && r.outer.kind === "global")) && !this.moduleBinds("super");
  }

  // The object of an attribute load or method call: super().x is CPython's
  // LOAD_SUPER_ATTR, which loads __class__ and the first argument as
  // variables (their NameError and UnboundLocalError) before super's checks.
  attrBase(v: A.Expr): string {
    return this.isZeroArgSuper(v) ? this.zeroArgSuper(true) : this.ex(v);
  }

  // super() with no arguments, as CPython's super_init_without_args: the
  // code's first argument (none: "no arguments"; deleted: "arg[0] deleted")
  // and its free __class__ (none: "cell not found"), the class's cell or a
  // variable of a function between.  As an attribute's object (attrForm),
  // when there is a __class__, CPython loads the two as variables first.
  zeroArgSuper(attrForm: boolean): string {
    if (this.fn.scope.kind === "class" || this.fn.scope.kind === "module") return "superNoArgs()";
    // (naming super gives the class its cell even where the call then fails)
    const r = resolve(this.fn.scope, "__class__");
    if (r.kind === "classcell") this.cellOf(r.scope);
    const fp = this.fn.firstParam;
    if (fp === null) return "superNoArgs()";
    if (attrForm && (r.kind === "classcell" || r.kind === "free")) {
      const obj = fp === ".0" ? "$it0" : this.load(fp);
      return `superAttr(${this.loadRes(r, "__class__")}, ${obj})`;
    }
    const obj = fp === ".0" ? "$it0" : js(fp);
    const cell = r.kind === "classcell" ? this.cellOf(r.scope) : r.kind === "free" ? `newCell(${js("__class__")})` : "null";
    return `superOf(${cell}, ${obj})`;
  }

  // ------------------------------------------------------------ comprehensions

  comprehension(e: Extract<A.Expr, { k: "Comp" }>, eager: string | null = null): string {
    const scope = this.fn.scope.child(e);
    const first = `iter(${this.ex(e.generators[0].iter)})`;
    const saved = this.fn;
    this.fn = new Fn(scope, saved, "", e.kind === "gen" ? ".0" : saved.firstParam);
    const its: string[] = [];
    let body: string;
    const r = "$r";
    const loops: string[] = [];
    const closes: string[] = [];
    e.generators.forEach((g, i) => {
      const it = i === 0 ? "$it0" : this.temp();
      its.push(it);
      const v = this.temp();
      const head = i === 0 ? "" : `${it} = iter(${this.ex(g.iter)}); `;
      const assign = this.assignCode(g.target, v);
      const conds = g.ifs.map((c) => `if (${this.bool(c)}) { `).join("");
      loops.push(`${head}for (let ${v} = ${it}.$next(); ${v} !== DONE; ${v} = ${it}.$next()) { ${INTR_CHECK} ${assign} ${conds}`);
      closes.push("}".repeat(1 + g.ifs.length));
    });
    // The element is compiled after the targets, so the comprehension
    // variables count as assigned.
    if (eager === "tuple" || eager === "list" || eager === "frozenset") body = `${r}.push(${this.ex(e.elt)});`;
    else if (eager === "set") body = `setAdd(${r}, ${this.ex(e.elt)});`;
    else if (eager === "sum") body = `${r}.push(${this.ex(e.elt)});`; // (R.sumAcc: the builtin's own total, item by item)
    else if (eager === "any") body = `if (${this.bool(e.elt)}) return true;`;
    else if (eager === "all") body = `if (!${this.bool(e.elt)}) return false;`;
    else if (e.kind === "gen") body = `yield ${this.ex(e.elt)};`;
    else if (e.kind === "list") body = `${r}.push(${this.ex(e.elt)});`;
    else if (e.kind === "set") body = `setAdd(${r}, ${this.ex(e.elt)});`;
    else body = `dictSet(${r}, ${this.ex(e.elt)}, ${this.ex(e.value!)});`;
    const locals = [...scope.bound].filter((n) => resolve(scope, n).kind === "local").map(js);
    const decls = [...locals, ...this.fn.temps].filter((x) => x !== "$it0");
    if (eager !== null) {
      const init: Record<string, string> = { tuple: "[]", list: "[]", set: "newSet()", frozenset: "[]", sum: "R.sumAcc(0)", any: "", all: "" };
      const fin: Record<string, string> = { tuple: `return ${r};`, list: `return ${r};`, set: `return ${r};`, frozenset: `return ${r};`, sum: `return ${r}.total();`, any: "return false;", all: "return true;" };
      const start = init[eager] ? `let ${r} = ${init[eager]}; ` : "";
      const decls2 = [...locals, ...this.fn.temps].filter((x) => x !== "$it0");
      const inner2 = `${decls2.length ? `let ${decls2.join(", ")}; ` : ""}${start}${loops.join(" ")} ${body} ${closes.reverse().join(" ")} ${fin[eager]}`;
      this.fn = saved;
      return `(function $genexpr$$($it0) { ${inner2} })(${first})`;
    }
    const inner = `${decls.length ? `let ${decls.join(", ")}; ` : ""}${e.kind === "gen" ? "" : `const ${r} = ${e.kind === "list" ? "[]" : e.kind === "set" ? "newSet()" : "newDict()"}; `}${loops.join(" ")} ${body} ${closes.reverse().join(" ")}${e.kind === "gen" ? "" : ` return ${r};`}`;
    this.fn = saved;
    // (compiler-only names: a leading $ no Python identifier can give, so
    // frames tell these apart from a def of the same name: sys._getframe)
    if (e.kind === "gen") return `(function* $genexpr$$($it0) { ${inner} })(${first})`;
    return `(function $${e.kind}comp$$($it0) { ${inner} })(${first})`;
  }

  // An assignment's value, evaluated before its target's container and index
  // or object, as Python does (`a[f()] = g()` calls g first): kept in a
  // temporary unless it is a constant (even loading a name can raise, and
  // its error comes before the target's: REACT-156C-3).
  valueFirst(t: A.Expr, value: A.Expr): string {
    const v = this.ex(value);
    if (t.k !== "Subscript" && t.k !== "Attribute") return v;
    if (value.k === "Const") return v;
    const tmp = this.temp();
    this.w(`${tmp} = ${v};`);
    return tmp;
  }

  // Code (one line) assigning `value` (a JS expression) to a target.
  assignCode(t: A.Expr, value: string): string {
    switch (t.k) {
      case "Name":
        return this.storeName(t.id, value);
      case "Attribute":
        return `${this.site("siteSet", t.attr)}(${this.ex(t.value)}, ${value});`;
      case "Subscript":
        return `setitem(${this.ex(t.value)}, ${this.ex(t.index)}, ${value});`;
      case "Tuple":
      case "List": {
        const star = t.elts.findIndex((x) => x.k === "Starred");
        const u = this.temp();
        let code: string;
        if (star < 0) code = `${u} = unpack(${value}, ${t.elts.length});`;
        else {
          if (t.elts.filter((x) => x.k === "Starred").length > 1) this.fail("multiple starred expressions in assignment", t.line);
          code = `${u} = unpackEx(${value}, ${star}, ${t.elts.length - star - 1});`;
        }
        t.elts.forEach((x, i) => {
          const target = x.k === "Starred" ? x.value : x;
          code += " " + this.assignCode(target, `${u}[${i}]`);
        });
        return code;
      }
      case "Starred":
        this.fail("starred assignment target must be in a list or tuple", t.line);
      default:
        this.fail(`cannot assign to ${t.k === "Call" ? "function call" : "expression"}`, t.line);
    }
  }

  // ------------------------------------------------------------ functions

  // [JS parameter list, prologue lines, defaults expr, kwdefaults expr, signature]
  params(p: A.Params, selfName: string): [string, string[], string, string, string] {
    const names = p.args.map((a) => a.name);
    const simple = p.vararg === null && p.kwarg === null && p.kwonly.length === 0;
    const jsParams = [...names.map(js)];
    if (p.vararg) jsParams.push(js(p.vararg));
    jsParams.push(...p.kwonly.map((a) => js(a.name)));
    if (p.kwarg) jsParams.push(js(p.kwarg));
    const pro: string[] = [];
    if (simple) pro.push(`if (arguments.length > ${names.length}) tooManyArgs(${selfName}, arguments.length);`);
    names.forEach((n, i) => pro.push(`if (${js(n)} === undefined) ${js(n)} = dflt(${selfName}, ${i}, ${names.length}, ${q(n)});`));
    for (const a of p.kwonly) pro.push(`if (${js(a.name)} === undefined) ${js(a.name)} = kwdflt(${selfName}, ${q(a.name)});`);
    const defs = p.args.filter((a) => a.default !== null);
    const defaults = defs.length ? `[${defs.map((a) => this.ex(a.default!)).join(", ")}]` : "null";
    const kwd = p.kwonly.filter((a) => a.default !== null);
    const kwdefaults = kwd.length ? `dictOf(${kwd.map((a) => `${q(a.name)}, ${this.ex(a.default!)}`).join(", ")})` : "null";
    const sig = `{args: ${JSON.stringify(names)}, posonly: ${p.posonly}, vararg: ${p.vararg === null ? "null" : q(p.vararg)}, kwonly: ${JSON.stringify(p.kwonly.map((a) => a.name))}, kwarg: ${p.kwarg === null ? "null" : q(p.kwarg)}}`;
    return [jsParams.join(", "), pro, defaults, kwdefaults, this.hoist(sig)];
  }

  lambda(e: Extract<A.Expr, { k: "Lambda" }>): string {
    const scope = this.fn.scope.child(e);
    const self = "lambda$$";
    const [ps, pro, defaults, kwdefaults, sig] = this.params(e.args, self);
    const saved = this.fn;
    this.fn = new Fn(scope, saved, self, e.args.args.length ? e.args.args[0].name : null);
    for (const n of [...e.args.args, ...e.args.kwonly]) this.fn.assigned.add(n.name);
    if (e.args.vararg) this.fn.assigned.add(e.args.vararg);
    if (e.args.kwarg) this.fn.assigned.add(e.args.kwarg);
    const body = this.ex(e.body);
    const locals = [...scope.bound].filter((n) => !this.isParam(e.args, n) && resolve(scope, n).kind === "local").map(js);
    const decls = [...locals, ...this.fn.temps];
    const star = scope.isGenerator ? "*" : "";
    this.fn = saved;
    return `defn(function${star} ${self}(${ps}) { ${pro.join(" ")} ${decls.length ? `let ${decls.join(", ")}; ` : ""}return ${body}; }, "<lambda>", ${q(scope.qualname)}, $G.__name__, ${defaults}, ${kwdefaults}, ${sig}, null, $g)`;
  }

  isParam(p: A.Params, n: string): boolean {
    return p.args.some((a) => a.name === n) || p.kwonly.some((a) => a.name === n) || p.vararg === n || p.kwarg === n;
  }

  // ------------------------------------------------------------ statements

  block(body: A.Stmt[]) {
    this.indent++;
    for (const st of body) this.stmt(st);
    this.indent--;
  }

  // Compile `body` under each branch's own copy of the definitely-assigned
  // set and keep the intersection.
  branches(...bodies: (() => void)[]) {
    const before = new Set(this.fn.assigned);
    let result: Set<string> | undefined;
    for (const b of bodies) {
      this.fn.assigned = new Set(before);
      b();
      const cur: Set<string> = this.fn.assigned;
      result = result === undefined ? cur : new Set([...result].filter((x: string) => cur.has(x)));
    }
    this.fn.assigned = result ?? before;
  }

  stmt(st: A.Stmt) {
    const fn = this.fn;
    const depth = fn.inUse.length;
    this.stmtInner(st);
    // Release this statement's temporaries (most recent first, so nested
    // allocations come back in a stable order).
    while (fn.inUse.length > depth) fn.free.push(fn.inUse.pop()!);
  }

  stmtInner(st: A.Stmt) {
    this.line = st.line;
    switch (st.k) {
      case "Expr": {
        if (st.value.k === "Const") return;
        if (this.fileOnceStmt(st.value, null)) return;
        // (a cell's last expression, displayed: its value through the hook)
        const v = st.value;
        if (v.k === "Call" && v.func.k === "Name" && (v.func.id === "__pyjs_displayhook__" || v.func.id === "__pyjs_sage_displayhook__") && v.args.length === 1 && v.keywords.length === 0) {
          const hook = v.func.id;
          if (this.fileOnceStmt(v.args[0], (r) => {
            const h = this.temp();
            this.w(`${h} = ${this.load(hook)}; typeof ${h} === "function" ? ${h}(${r}) : callObj(${h}, [${r}]);`);
          })) return;
        }
        return this.w(`${this.ex(st.value)};`);
      }
      case "Assign": {
        if (st.targets.length === 1 && st.targets[0].k === "Tuple" && st.value.k === "Tuple" && st.targets[0].elts.length === st.value.elts.length && ![...st.targets[0].elts, ...st.value.elts].some((x) => x.k === "Starred")) {
          // a, b = b, a: evaluate every right-hand side first.
          const ts = st.value.elts.map((v) => {
            const t = this.temp();
            this.w(`${t} = ${this.ex(v)};`);
            return t;
          });
          st.targets[0].elts.forEach((t, i) => this.w(this.assignCode(t, ts[i])));
          return;
        }
        if (st.targets.length === 1 && this.fileOnceStmt(st.value, (r) => this.w(this.assignCode(st.targets[0], r)))) return;
        if (st.targets.length === 1) return this.w(this.assignCode(st.targets[0], this.valueFirst(st.targets[0], st.value)));
        const v = this.ex(st.value);
        const t = this.temp();
        this.w(`${t} = ${v};`);
        for (const target of st.targets) this.w(this.assignCode(target, t));
        return;
      }
      case "AugAssign":
        return this.augAssign(st);
      case "AnnAssign":
        if (st.value !== null) this.w(this.assignCode(st.target, this.valueFirst(st.target, st.value)));
        // (an annotated name of a module or class body: marked executed, its
        // annotation in the __annotate__ only then)
        if (this.fn.annots?.index.has(st)) this.w(this.fn.annots.mark(this.fn.annots.index.get(st)!));
        // (alone, one of an attribute or an item evaluates the object and the
        // index, and fetches and stores nothing: REACT-44C5-3)
        else if (st.target.k === "Attribute") this.w(`void (${this.ex(st.target.value)});`);
        else if (st.target.k === "Subscript") {
          this.w(`void (${this.ex(st.target.value)});`);
          this.w(`void (${this.ex(st.target.index)});`);
        }
        return;
      case "Return":
        if (this.fn.scope.kind !== "function") this.fail("'return' outside function");
        if (st.value !== null && this.fileOnceStmt(st.value, (r) => this.w(`return ${r};`))) return;
        return this.w(`return ${st.value === null ? "null" : this.ex(st.value)};`);
      case "If": {
        this.w(`if (${this.bool(st.test)}) {`);
        this.branches(
          () => this.block(st.body),
          () => {
            if (st.orelse.length) {
              this.w("} else {");
              this.block(st.orelse);
            }
          }
        );
        return this.w("}");
      }
      case "While":
        return this.loop(st.orelse, () => {
          this.w(`while (${this.bool(st.test)}) {`);
          this.w(`  ${INTR_CHECK}`);
          this.block(st.body);
          this.w("}");
        });
      case "For":
        if (this.isRangeCall(st.iter)) return this.rangeFor(st);
        return this.loop(st.orelse, () => {
          const it = this.temp();
          const v = this.temp();
          this.w(`${it} = iter(${this.ex(st.iter)});`);
          this.w(`for (let ${v} = ${it}.$next(); ${v} !== DONE; ${v} = ${it}.$next()) {`);
          this.indent++;
          this.w(INTR_CHECK);
          this.w(this.assignCode(st.target, v));
          this.indent--;
          this.block(st.body);
          this.w("}");
        });
      case "Break": {
        const l = this.fn.loops[this.fn.loops.length - 1];
        if (l === undefined) this.fail("'break' outside loop");
        return this.w(l.label === null ? "break;" : `break ${l.label};`);
      }
      case "Continue":
        if (!this.fn.loops.length) this.fail("'continue' not properly in loop");
        return this.w("continue;");
      case "Pass":
        return;
      case "FunctionDef":
        return this.funcDef(st);
      case "ClassDef":
        return this.classDef(st);
      case "Import":
        for (const a of st.names) {
          if (a.asname !== null) this.w(this.storeName(a.asname, `importAs(${q(a.name)}, $g, $B)`));
          else this.w(this.storeName(a.name.split(".")[0], `importTop(${q(a.name)}, $g, $B)`));
        }
        return;
      case "ImportFrom": {
        const m = this.temp();
        this.w(`${m} = importFromStmt(${q(st.module)}, [${st.names.map((a) => q(a.name)).join(", ")}], ${st.level}, $g, $B);`);
        for (const a of st.names) {
          if (a.name === "*") {
            if (this.fn.scope.kind !== "module") this.fail("import * only allowed at module level");
            this.w(`importStar(${m}, $g);`);
          } else this.w(this.storeName(a.asname ?? a.name, `importFrom(${m}, ${q(a.name)})`));
        }
        return;
      }
      case "Global":
      case "Nonlocal":
        return;
      case "Raise": {
        // (the exception being handled, which in a finally run for one is
        // that one, not the enclosing except clause's)
        if (st.exc === null) return this.w("throw reraise();");
        const cause = st.cause === null ? "" : `, ${this.ex(st.cause)}`;
        return this.w(`throw raiseExc(${this.ex(st.exc)}${cause});`);
      }
      case "Try":
        return this.tryStmt(st);
      case "With":
        return this.withStmt(st, 0);
      case "Assert": {
        const msg = st.msg === null ? "" : this.ex(st.msg);
        return this.w(`if (!${this.bool(st.test)}) throw raiseExc(T.AssertionError(${msg}));`);
      }
      case "Delete":
        for (const t of st.targets) this.del(t);
        return;
    }
  }

  isRangeCall(e: A.Expr): e is Extract<A.Expr, { k: "Call" }> {
    return e.k === "Call" && e.func.k === "Name" && e.func.id === "range" && e.keywords.length === 0 && e.args.length >= 1 && e.args.length <= 3 && !e.args.some((a) => a.k === "Starred") && resolve(this.fn.scope, "range").kind === "global" && !this.moduleBinds("range");
  }

  // `for x in range(...)`: count in JS numbers while `range` is the builtin
  // and the arguments are small ints; otherwise iterate the range object.
  // One loop body serves both paths.
  rangeFor(st: Extract<A.Stmt, { k: "For" }>) {
    const call = st.iter as Extract<A.Expr, { k: "Call" }>;
    this.loop(st.orelse, () => {
      const f = this.temp(), it = this.temp(), i = this.temp(), end = this.temp(), step = this.temp(), v = this.temp();
      const args = call.args.map((a) => {
        const t = this.temp();
        this.w(`${t} = ${this.ex(a)};`);
        return t;
      });
      this.w(`${f} = ${this.load("range")};`);
      const [start, stop, stp] = args.length === 1 ? ["0", args[0], "1"] : args.length === 2 ? [args[0], args[1], "1"] : args;
      const ints = args.map((a) => `typeof ${a} === "number" && Number.isInteger(${a})`).join(" && ");
      this.w(`if (${f} === R.originalBuiltins.range && ${ints}${args.length === 3 ? ` && ${stp} !== 0` : ""}) { ${i} = ${start}; ${end} = ${stop}; ${step} = ${stp}; ${it} = null; }`);
      this.w(`else ${it} = iter(callObj(${f}, [${args.join(", ")}]));`);
      this.w(`for (;;) {`);
      this.indent++;
      if (args.length === 3) this.w(`if (${it} === null) { if (${step} > 0 ? ${i} >= ${end} : ${i} <= ${end}) break; ${v} = ${i}; ${i} += ${step}; }`);
      else this.w(`if (${it} === null) { if (${i} >= ${end}) break; ${v} = ${i}++; }`);
      this.w(`else { ${v} = ${it}.$next(); if (${v} === DONE) break; }`);
      this.w(INTR_CHECK);
      this.w(this.assignCode(st.target, v));
      this.indent--;
      this.block(st.body);
      this.w("}");
    });
  }

  del(t: A.Expr) {
    switch (t.k) {
      case "Name": {
        const r = resolve(this.fn.scope, t.id);
        if (r.kind === "global") {
          const ns = this.gns(t.id);
          return this.w(`R.delName(${ns}, ${q(t.id)});`);
        }
        if (r.kind === "class") return this.w(`if (!$ns.delete(${q(t.id)})) R.unboundName(${q(t.id)});`);
        if (r.kind === "classcell") return this.w(`classCellGet(${this.cellOf(r.scope)}); ${this.cellOf(r.scope)}.v = undefined;`);
        this.w(`${this.load(t.id)}; ${js(t.id)} = undefined;`);
        this.fn.assigned.delete(t.id);
        return;
      }
      case "Attribute":
        return this.w(`delattr(${this.ex(t.value)}, ${q(t.attr)});`);
      case "Subscript":
        return this.w(`delitem(${this.ex(t.value)}, ${this.ex(t.index)});`);
      case "Tuple":
      case "List":
        return t.elts.forEach((x) => this.del(x));
      default:
        this.fail("cannot delete expression");
    }
  }

  augAssign(st: Extract<A.Stmt, { k: "AugAssign" }>) {
    const op = "i" + BIN[st.op];
    const t = st.target;
    if (t.k === "Name") return this.w(this.storeName(t.id, `${op}(${this.load(t.id)}, ${this.ex(st.value)})`));
    if (t.k === "Attribute") {
      const o = this.temp();
      this.w(`${o} = ${this.ex(t.value)};`);
      return this.w(`${this.site("siteSet", t.attr)}(${o}, ${op}(${this.site("siteGet", t.attr)}(${o}), ${this.ex(st.value)}));`);
    }
    if (t.k === "Subscript") {
      const o = this.temp(), k = this.temp();
      this.w(`${o} = ${this.ex(t.value)}; ${k} = ${this.ex(t.index)};`);
      return this.w(`setitem(${o}, ${k}, ${op}(getitem(${o}, ${k}), ${this.ex(st.value)}));`);
    }
    this.fail("illegal expression for augmented assignment");
  }

  // A loop with an optional else clause; `break` must skip the else.
  loop(orelse: A.Stmt[], body: () => void) {
    const label = orelse.length ? "L" + ++this.counter : null;
    if (label !== null) {
      this.w(`${label}: {`);
      this.indent++;
    }
    this.fn.loops.push({ label });
    const before = new Set(this.fn.assigned);
    body();
    this.fn.assigned = before;
    this.fn.loops.pop();
    if (label !== null) {
      for (const s of orelse) this.stmt(s);
      this.fn.assigned = before;
      this.indent--;
      this.w("}");
    }
  }

  // Run `body` with a fresh Fn for a nested scope; returns its lines and
  // declarations.
  nested(scope: Scope, selfName: string, firstParam: string | null, assigned: string[], body: () => void): { lines: Line[]; decls: string[] } {
    const saved = this.fn, savedIndent = this.indent;
    this.fn = new Fn(scope, saved, selfName, firstParam);
    for (const a of assigned) this.fn.assigned.add(a);
    this.indent = 1;
    body();
    const lines = this.fn.buf;
    const decls = this.fn.temps;
    this.fn = saved;
    this.indent = savedIndent;
    return { lines, decls };
  }

  // Splice compiled lines of a nested function into the current buffer.
  splice(lines: Line[]) {
    const pad = "  ".repeat(this.indent);
    for (const l of lines) this.fn.buf.push({ text: pad + l.text, py: l.py });
  }

  decorate(decorators: A.Expr[], value: string): string {
    // Decorator expressions are evaluated first, then applied innermost first.
    let code = value;
    for (let i = decorators.length - 1; i >= 0; i--) {
      code = `callObj(${decorators[i]}, [${code}])`;
    }
    return code;
  }

  evalDecorators(decorators: A.Expr[]): A.Expr[] {
    return decorators.map((d) => {
      const t = this.temp();
      this.w(`${t} = ${this.ex(d)};`);
      return { k: "Name", line: d.line, id: t } as A.Expr;
    });
  }

  funcDef(st: Extract<A.Stmt, { k: "FunctionDef" }>) {
    const decs = this.evalDecorators(st.decorators).map((d) => (d as any).id as string);
    const scope = this.fn.scope.child(st);
    const self = js(st.name) + "$";
    const [ps, pro, defaults, kwdefaults, sig] = this.params(st.args, self);
    const p = st.args;
    const params = [...p.args.map((a) => a.name), ...p.kwonly.map((a) => a.name), ...(p.vararg ? [p.vararg] : []), ...(p.kwarg ? [p.kwarg] : [])];
    let doc = "null";
    let body = st.body;
    if (body[0]?.k === "Expr" && body[0].value.k === "Const" && body[0].value.value.t === "str") doc = q(body[0].value.value.v);
    const { lines, decls } = this.nested(scope, self, p.args.length ? p.args[0].name : null, params, () => {
      for (const s of body) this.stmt(s);
      this.w("return null;");
    });
    this.line = st.line;
    const locals = [...scope.bound].filter((n) => !params.includes(n) && resolve(scope, n).kind === "local").map(js);
    const star = scope.isGenerator ? "*" : "";
    const f = this.temp();
    this.w(`${f} = defn(${scope.isAsync ? "markCoro(" : ""}function${star} ${self}(${ps}) {`);
    this.indent++;
    for (const l of pro) this.w(l);
    if (locals.length + decls.length) this.w(`let ${[...locals, ...decls].join(", ")};`);
    this.indent--;
    this.splice(lines);
    this.line = st.line;
    this.w(`}${scope.isAsync ? ")" : ""}, ${q(st.name)}, ${q(scope.qualname)}, $G.__name__, ${defaults}, ${kwdefaults}, ${sig}, ${doc}, $g);`);
    this.w(`${f}.$line = ${st.line};`);
    if (st.annotations?.length) this.w(`${f}.$annotate = ${this.annotateFn(this.fn.scope.child(st.annotations), st.annotations.map(([key, expr]) => ({ key, expr, gate: null })), scope.qualname)};`);
    this.w(this.storeName(st.name, decs.reduceRight((acc, d) => `callObj(${d}, [${acc}])`, f)));
  }

  classDef(st: Extract<A.Stmt, { k: "ClassDef" }>) {
    const decs = this.evalDecorators(st.decorators).map((d) => (d as any).id as string);
    const scope = this.fn.scope.child(st);
    const bases = this.items(st.bases);
    const kwNames = st.keywords.filter((k) => k.arg !== null).map((k) => q(k.arg!));
    const kwValues = st.keywords.filter((k) => k.arg !== null).map((k) => this.ex(k.value));
    // (the builtins' __build_class__ first, CPython's LOAD_BUILD_CLASS,
    // before the bases and the body)
    const bc = this.temp();
    this.w(`${bc} = R.buildClassOf($B);`);
    const b = this.temp();
    this.w(`${b} = ${bases};`);
    // (the keywords before the body, as __build_class__'s arguments)
    const kv = this.temp();
    this.w(`${kv} = [${kwValues.join(", ")}];`);
    const { lines, decls } = this.nested(scope, "", null, [], () => {
      const body = st.body;
      this.w(`$ns.set("__module__", R.classModuleIn($ns, $G, $B)); $ns.set("__qualname__", ${q(scope.qualname)}); $ns.set("__firstlineno__", ${st.line});`);
      if (body[0]?.k === "Expr" && body[0].value.k === "Const" && body[0].value.value.t === "str") this.w(`$ns.set("__doc__", ${q(body[0].value.value.v)});`);
      // (annotated names: those executed, in the body's own set, then its
      // __annotate__, the class's __annotate_func__, at the end)
      const index = annotatedIn(body);
      // (under `from __future__ import annotations`: __annotations__ made
      // first and each executed annotation's string stored in it, as
      // CPython's; no __annotate__)
      const future = [...index.keys()].some((s) => (s as any).stringized);
      const seen = index.size && !future ? this.classTemp("$ca") : "";
      if (future) {
        this.w(`if ($ns.get("__annotations__") === undefined) $ns.set("__annotations__", newDict());`);
        this.fn.annots = { index, mark: (i) => this.futureMark(index, i) };
      } else if (index.size) {
        this.w(`${seen} = new Set();`);
        this.fn.annots = { index, mark: (i) => `${seen}.add(${i});` };
      }
      for (const s of body) this.stmt(s);
      if (index.size && !future) {
        const entries = [...index].map(([s, i]) => ({ key: ((s as any).target as any).id as string, expr: (s as any).annotation as A.Expr, gate: `${seen}.has(${i})` }));
        this.w(`$ns.set("__annotate__", ${this.annotateFn(scope.annotScope!, entries)});`);
      }
    });
    this.line = st.line;
    // (the namespace prepared, and the class made from it, in the frame the
    // class statement runs in, as CPython's __build_class__: the body's own
    // frame has returned before the metaclass, __init_subclass__ or
    // __set_name__ run, so their tracebacks and sys._getframe don't show it)
    const ns = this.temp();
    this.w(`${ns} = R.classNamespace(${q(st.name)}, ${b}, [${kwNames.join(", ")}], ${kv}, ${bc});`);
    const c = this.temp();
    this.w(`${c} = (function ${js(st.name)}$($ns) {`);
    this.indent++;
    // the class cell, when its functions use __class__ or super()
    const cell = scope.cellName;
    const cdc = scope.classDictName;
    if (cell || cdc) this.w(`${cell ? `const ${cell} = newCell();` : ""}${cell && cdc ? " " : ""}${cdc ? `const ${cdc} = R.classDictCell($ns);` : ""}`);
    if (decls.length) this.w(`let ${decls.join(", ")};`);
    this.indent--;
    this.splice(lines);
    this.line = st.line;
    this.indent++;
    if (cell) this.w(`$ns.set("__classcell__", ${cell});`);
    if (scope.classDictName) this.w(`$ns.set("__classdictcell__", ${scope.classDictName});`);
    // (its cell, for classDef; none: undefined, as the function returns)
    if (cell) this.w(`return ${cell};`);
    this.indent--;
    this.w(`})(${ns});`);
    this.w(`${c} = classDef(${q(st.name)}, ${q(scope.qualname)}, $G.__name__, ${b}, ${ns}, [${kwNames.join(", ")}], ${kv}, ${c}, ${bc});`);
    this.w(this.storeName(st.name, decs.reduceRight((acc, d) => `callObj(${d}, [${acc}])`, c)));
  }

  tryStmt(st: Extract<A.Stmt, { k: "Try" }>) {
    const before = new Set(this.fn.assigned);
    const hasFinally = st.finalbody.length > 0;
    // (the exception passing through the finally, if any)
    const p = hasFinally ? this.temp() : null;
    if (p !== null) {
      this.w(`${p} = undefined;`);
      this.w("try {");
      this.indent++;
    }
    const ok = st.orelse.length ? this.temp() : null;
    if (st.handlers.length) {
      if (ok !== null) this.w(`${ok} = false;`);
      this.w("try {");
      this.block(st.body);
      if (ok !== null) this.w(`  ${ok} = true;`);
      this.fn.assigned = new Set(before);
      const e = this.temp();
      this.w(`} catch (${e}_) {`);
      this.indent++;
      this.w(`${e} = toPyExc(${e}_);`);
      // It is the exception being handled, for sys.exception() and
      // sys.exc_info(), while the clauses are matched and the chosen one runs.
      this.w(`excEnter(${e});`);
      // (whether a clause with a name has left it already, CORR-142-1)
      const left = st.handlers.some((h) => h.name !== null) ? this.temp() : null;
      if (left !== null) this.w(`${left} = false;`);
      this.w("try {");
      this.indent++;
      st.handlers.forEach((h, i) => {
        this.line = h.line;
        if (h.type === null && i !== st.handlers.length - 1) this.fail("default 'except:' must be last", h.line);
        const cond = h.type === null ? "true" : `excMatch(${e}, ${this.ex(h.type)})`;
        this.w(`${i === 0 ? "" : "} else "}if (${cond}) {`);
        this.indent++;
        if (h.name !== null) this.w(this.storeName(h.name, e));
        // Exceptions raised while handling get this one as __context__ when
        // raised (raiseExc); this catches the runtime's own errors.
        const x = this.temp();
        if (h.name !== null) this.w(`${x} = undefined;`);
        this.w("try {");
        this.block(h.body);
        // (the name is cleared however the clause ends, CPython's
        // `name = None; del name`: after the exception stops being the one
        // handled when the clause ends or jumps out, before when it raises)
        const clear = h.name === null ? "" : ` finally { if (${x} === undefined) { excLeave(${e}); ${left} = true; } ${this.clearName(h.name)} }`;
        this.w(`} catch (${x}_) { ${x} = toPyExc(${x}_); if (${x} !== ${e} && ${x}.__context__ === undefined) ${x}.__context__ = ${e}; throw ${x}; }${clear}`);
        if (h.name !== null) this.fn.assigned.delete(h.name);
        this.indent--;
      });
      this.w(`} else throw ${e};`);
      this.indent--;
      this.w(`} finally { ${left !== null ? `if (!${left}) ` : ""}excLeave(${e}); }`);
      this.indent--;
      this.w("}");
    } else {
      this.w("{");
      this.block(st.body);
      this.w("}");
    }
    if (ok !== null) {
      this.w(`if (${ok}) {`);
      this.block(st.orelse);
      this.w("}");
    }
    this.fn.assigned = before;
    if (p !== null) {
      // An exception passing through is the one being handled while the
      // finally runs, and the __context__ of one the finally raises.
      const x = this.temp();
      this.indent--;
      this.w(`} catch (${p}_) { ${p} = toPyExc(${p}_); throw ${p}; } finally {`);
      this.indent++;
      this.w(`if (${p} !== undefined) excEnter(${p});`);
      this.w("try {");
      this.block(st.finalbody);
      this.w(`} catch (${x}_) { ${x} = toPyExc(${x}_); if (${p} !== undefined && ${x} !== ${p} && ${x}.__context__ === undefined) ${x}.__context__ = ${p}; throw ${x}; } finally { if (${p} !== undefined) excLeave(${p}); }`);
      this.indent--;
      this.w("}");
    }
  }

  withStmt(st: Extract<A.Stmt, { k: "With" }>, i: number) {
    if (i === st.items.length) return this.block(st.body);
    const item = st.items[i];
    const m = this.temp(), exit = this.temp(), v = this.temp(), ok = this.temp(), e = this.temp();
    this.w(`${m} = ${this.ex(item.context)}; ${exit} = withExit(${m}); ${v} = withEnter(${m}); ${ok} = true;`);
    this.w("try {");
    this.indent++;
    if (item.target !== null) this.w(this.assignCode(item.target, v));
    this.indent--;
    if (i + 1 < st.items.length) {
      this.indent++;
      this.withStmt(st, i + 1);
      this.indent--;
    } else this.block(st.body);
    // (the body's exception is the one being handled while __exit__ runs)
    const x = this.temp();
    this.w(`} catch (${e}_) { ${ok} = false; ${e} = toPyExc(${e}_); excEnter(${e}); try { if (!truth(${exit}(typeOf(${e}), ${e}, null))) throw ${e}; } catch (${x}_) { ${x} = toPyExc(${x}_); if (${x} !== ${e} && ${x}.__context__ === undefined) ${x}.__context__ = ${e}; throw ${x}; } finally { excLeave(${e}); } } finally { if (${ok}) ${exit}(null, null, null); }`);
  }

  // ------------------------------------------------------------ module

  module(body: A.Stmt[], evalMode = false): Compiled {
    this.fn = new Fn(this.top, null, "$module$$", null);
    if (evalMode) {
      if (body.length !== 1 || body[0].k !== "Expr") this.fail("invalid syntax", body[0]?.line ?? 1);
      this.line = body[0].line;
      this.w(`return ${this.ex((body[0] as Extract<A.Stmt, { k: "Expr" }>).value)};`);
    } else {
      // (a module's annotated names, as CPython 3.14's: its __annotate__
      // first, and __conditional_annotations__, the indexes of those
      // executed, read when __annotate__ is called)
      const index = annotatedIn(body);
      if ([...index.keys()].some((s) => (s as any).stringized)) {
        this.w(`R.setupAnnotations($g);`);
        this.fn.annots = { index, mark: (i) => this.futureMark(index, i) };
      } else if (index.size) {
        const entries = [...index].map(([s, i]) => ({ key: ((s as any).target as any).id as string, expr: (s as any).annotation as A.Expr, gate: `R.annotIn($g.__conditional_annotations__, ${i})` }));
        this.w(`$g.__annotate__ = ${this.annotateFn(this.fn.scope.annotScope!, entries)};`);
        this.w(`$g.__conditional_annotations__ = newSet();`);
        this.fn.annots = { index, mark: (i) => `setAdd($g.__conditional_annotations__, ${i});` };
      }
      for (const s of body) this.stmt(s);
    }
    const head = [
      "(function $module$$($g, R) {",
      '"use strict";',
      `const {${RUNTIME_NAMES.join(", ")}} = R;`,
      "const $G = R.realGlobals($g);",
      "const $GL = R.globalLoads($G);",
      "const $B = R.builtinsOf($G);",
      ...this.hoisted,
    ];
    if (this.fn.temps.length) head.push(`let ${this.fn.temps.join(", ")};`);
    const lineMap = [0, ...head.map(() => 0)];
    const out = [...head];
    for (const l of this.fn.buf) {
      out.push(l.text);
      lineMap.push(l.py);
    }
    out.push("})");
    lineMap.push(0);
    return { code: out.join("\n"), lineMap };
  }

}

// A module's or class body's annotated names (`x: int`, a name not in
// parentheses), its own statements' and those of its compound statements,
// not of functions or classes in it: each with its index, in source order
function annotatedIn(body: A.Stmt[]): Map<A.Stmt, number> {
  const out = new Map<A.Stmt, number>();
  const walk = (ss: A.Stmt[]): void => {
    for (const s of ss) {
      switch (s.k) {
        case "AnnAssign":
          if (s.target.k === "Name" && s.simple) out.set(s, out.size);
          break;
        case "If":
        case "While":
        case "For":
          walk(s.body);
          walk(s.orelse);
          break;
        case "Try":
          walk(s.body);
          s.handlers.forEach((h) => walk(h.body));
          walk(s.orelse);
          walk(s.finalbody);
          break;
        case "With":
          walk(s.body);
          break;
      }
    }
  };
  walk(body);
  return out;
}

function* allScopes(s: Scope): Generator<Scope> {
  yield s;
  for (const c of s.children.values()) yield* allScopes(c);
}

// Ctrl-C: every loop iteration of compiled Python tests the interrupt flag
// (runtime/interrupt.ts), one typed-array load.
// (bit 0 only: the word's other bits, a frame request or a persistent armed
// allowance, never take a loop to interrupted(); src/runtime/interrupt.ts)
const INTR_CHECK = "if (INTR[0] & 1) interrupted();";

// Runtime helpers referenced by generated code.
const RUNTIME_NAMES = [
  "add", "sub", "mul", "truediv", "floordiv", "mod", "pow", "lshift", "rshift", "and", "or", "xor", "matmul",
  "iadd", "isub", "imul", "itruediv", "ifloordiv", "imod", "ipow", "ilshift", "irshift", "iand", "ior", "ixor", "imatmul",
  "addT", "subT", "mulT", "truedivT",
  "sagediv", "isagediv", "sagepow", "isagepow",
  "neg", "pos", "invert", "truth", "lt", "le", "gt", "ge", "eq", "ne", "is", "contains",
  "getitem", "setitem", "delitem", "PySlice", "tuple", "newSet", "setAdd", "newDict", "dictSet", "dictUpdate", "dictOf",
  "iter", "DONE", "unpack", "unpackEx", "toArray", "fmt", "fcat", "fbox", "callObj", "callKw", "callEx", "superOf", "superAttr", "superNoArgs", "newCell", "classCellGet",
  "defn", "dflt", "kwdflt", "tooManyArgs", "gname", "unboundLocal", "unboundFree", "yieldFrom", "yfr", "awaitIter", "markCoro",
  "raiseExc", "toPyExc", "excMatch", "withEnter", "withExit", "reraise", "excEnter", "excLeave", "classDef",
  "importModule", "importTop", "importAs", "importFromStmt", "importFrom", "importStar", "resolveRelative", "delattr", "Ellipsis", "T", "typeOf",
  "sortedKeys", "INTR", "interrupted",
];

// Whether evaluating e can suspend its frame (yield, yield from, await),
// outside a lambda's body, which is its own frame; a lambda's defaults are
// evaluated in this one, so they count (astra2's CORR-FV-R3-2)
function suspends(e: any): boolean {
  if (e === null || typeof e !== "object") return false;
  if (Array.isArray(e)) return e.some(suspends);
  if (e.k === "Yield" || e.k === "YieldFrom" || e.k === "Await") return true;
  if (e.k === "Lambda") return [...e.args.args, ...e.args.kwonly].some((p: any) => suspends(p.default));
  for (const k of Object.keys(e)) if (k !== "k" && k !== "line" && suspends(e[k])) return true;
  return false;
}
