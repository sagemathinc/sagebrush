// Python AST -> JavaScript.  See PLAN.md for the value representation and
// the shapes of generated code.

import * as A from "./ast";
import { Scope, resolve, Resolution, SyntaxErr } from "./scope";

const BIN: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "truediv", "//": "floordiv", "%": "mod", "**": "pow", "<<": "lshift", ">>": "rshift", "&": "and", "|": "or", "^": "xor", "@": "matmul", "sage/": "sagediv", "sage**": "sagepow" };
const CMP: Record<string, string> = { "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "==": "eq", "!=": "ne" };
const UNARY: Record<string, string> = { "-": "neg", "+": "pos", "~": "invert" };

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
  handlers: string[] = []; // JS variables holding the exceptions being handled
  constructor(
    public scope: Scope,
    public parent: Fn | null,
    public selfName: string, // JS name of the function, for prologue references
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
    return this.loadRes(resolve(this.fn.scope, id), id);
  }
  loadRes(r: Resolution, id: string): string {
    switch (r.kind) {
      case "local":
        return this.fn.assigned.has(id) ? js(id) : `(${js(id)} !== undefined ? ${js(id)} : unboundLocal(${q(id)}))`;
      case "free":
        return `(${js(id)} !== undefined ? ${js(id)} : unboundFree(${q(id)}))`;
      case "global": {
        const t = this.temp();
        if (!this.moduleBinds(id) && this.builtinNames.has(id)) return `((${t} = $g${prop(id)}) !== undefined ? ${t} : $B${prop(id)})`;
        return `((${t} = $g${prop(id)}) !== undefined ? ${t} : gname(${q(id)}))`;
      }
      case "class":
        return `($ns.has(${q(id)}) ? $ns.get(${q(id)}) : ${this.loadRes(r.outer, id)})`;
    }
  }
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
        return `$g${prop(id)} = ${value};`;
      case "class":
        return `$ns.set(${q(id)}, ${value});`;
    }
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
      case "BinOp":
        return `${BIN[e.op]}(${this.ex(e.left)}, ${this.ex(e.right)})`;
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
        return `${this.site("siteGet", e.attr)}(${this.ex(e.value)})`;
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
    const pieces = parts.map((p) => {
      if (typeof p === "string") return q(p);
      const spec = p.spec === null ? '""' : this.fstring(p.spec);
      const v = `fmt(${this.ex(p.expr)}, ${p.conv === null ? "null" : q(p.conv)}, ${spec})`;
      return p.text ? `${q(p.text)} + ${v}` : v;
    });
    return `(${typeof parts[0] === "string" ? "" : '"" + '}${pieces.join(" + ")})`;
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
    if (f.k === "Name" && f.id === "super" && e.args.length === 0 && e.keywords.length === 0 && resolve(this.fn.scope, "super").kind === "global" && !this.moduleBinds("super")) {
      const cls = this.classCell();
      if (cls !== null && this.fn.firstParam !== null) return `superOf(${cls}, ${this.fn.firstParam})`;
    }
    const intro = this.introspectionCall(e);
    if (intro !== null) return intro;
    const consumed = this.consumingCall(e);
    if (consumed !== null) return consumed;
    const simple = !e.args.some((a) => a.k === "Starred") && e.keywords.length === 0;
    if (simple) {
      if (f.k === "Attribute") {
        const s = this.site("siteCall", f.attr, e.args.length);
        return `${s}(${[this.ex(f.value), ...e.args.map((a) => this.ex(a))].join(", ")})`;
      }
      // Evaluate the callee and arguments into temporaries so the generated
      // code stays linear in the nesting depth.
      const t = this.temp();
      const pre = [`${t} = ${this.ex(f)}`];
      const args = e.args.map((a) => {
        const at = this.temp();
        pre.push(`${at} = ${this.ex(a)}`);
        return at;
      });
      return `(${pre.join(", ")}, typeof ${t} === "function" ? ${t}(${args.join(", ")}) : callObj(${t}, [${args.join(", ")}]))`;
    }
    const callee = this.ex(f);
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
    if (maps.length === 0) return `callKw(${callee}, ${pos}, [${names.join(", ")}], [${values.join(", ")}])`;
    return `callEx(${callee}, ${pos}, [${names.join(", ")}], [${values.join(", ")}], [${maps.join(", ")}])`;
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
      if (scope.kind === "module") return "R.globalsDict($g)";
      if (scope.kind === "class") return "R.localsDict([...$ns.keys()], [...$ns.values()])";
      const ls = [...scope.bound].filter((x) => !scope.globals.has(x));
      return `R.localsDict(${JSON.stringify(ls)}, [${ls.map((x) => (resolve(scope, x).kind === "global" ? "undefined" : js(x))).join(", ")}])`;
    };
    if (f.id === "locals" || f.id === "vars") return n === 0 ? localsExpr() : null;
    if (f.id === "dir") return `sortedKeys(${localsExpr()})`;
    if (n < 1 || n > 3) return null;
    const args = e.args.map((a) => this.ex(a));
    const callerLocals = n === 1 && scope.kind !== "module" ? localsExpr() : "null";
    const fn = f.id === "eval" ? "R.evalIn" : "R.execIn";
    return `${fn}(${args[0]}, ${args[1] ?? "undefined"}, ${args[2] ?? "undefined"}, $g, ${callerLocals})`;
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
    return `((${fn} = ${this.load(f.id)}) === $B${prop(f.id)} ? ${wrap[f.id]} : callObj(${fn}, [${slow}]))`;
  }

  // JS variable holding the class being defined, for zero-argument super().
  classCell(): string | null {
    for (let s: Scope | null = this.fn.scope; s !== null; s = s.parent) if (s.kind === "class") return "__class__$";
    return null;
  }

  // ------------------------------------------------------------ comprehensions

  comprehension(e: Extract<A.Expr, { k: "Comp" }>, eager: string | null = null): string {
    const scope = this.fn.scope.child(e);
    const first = `iter(${this.ex(e.generators[0].iter)})`;
    const saved = this.fn;
    this.fn = new Fn(scope, saved, "", saved.firstParam);
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
      loops.push(`${head}for (let ${v} = ${it}.$next(); ${v} !== DONE; ${v} = ${it}.$next()) { ${assign} ${conds}`);
      closes.push("}".repeat(1 + g.ifs.length));
    });
    // The element is compiled after the targets, so the comprehension
    // variables count as assigned.
    if (eager === "tuple" || eager === "list" || eager === "frozenset") body = `${r}.push(${this.ex(e.elt)});`;
    else if (eager === "set") body = `setAdd(${r}, ${this.ex(e.elt)});`;
    else if (eager === "sum") body = `${r} = add(${r}, ${this.ex(e.elt)});`;
    else if (eager === "any") body = `if (${this.bool(e.elt)}) return true;`;
    else if (eager === "all") body = `if (!${this.bool(e.elt)}) return false;`;
    else if (e.kind === "gen") body = `yield ${this.ex(e.elt)};`;
    else if (e.kind === "list") body = `${r}.push(${this.ex(e.elt)});`;
    else if (e.kind === "set") body = `setAdd(${r}, ${this.ex(e.elt)});`;
    else body = `dictSet(${r}, ${this.ex(e.elt)}, ${this.ex(e.value!)});`;
    const locals = [...scope.bound].filter((n) => resolve(scope, n).kind === "local").map(js);
    const decls = [...locals, ...this.fn.temps].filter((x) => x !== "$it0");
    if (eager !== null) {
      const init: Record<string, string> = { tuple: "[]", list: "[]", set: "newSet()", frozenset: "[]", sum: "0", any: "", all: "" };
      const fin: Record<string, string> = { tuple: `return ${r};`, list: `return ${r};`, set: `return ${r};`, frozenset: `return ${r};`, sum: `return ${r};`, any: "return false;", all: "return true;" };
      const start = init[eager] ? `let ${r} = ${init[eager]}; ` : "";
      const decls2 = [...locals, ...this.fn.temps].filter((x) => x !== "$it0");
      const inner2 = `${decls2.length ? `let ${decls2.join(", ")}; ` : ""}${start}${loops.join(" ")} ${body} ${closes.reverse().join(" ")} ${fin[eager]}`;
      this.fn = saved;
      return `(function genexpr$$($it0) { ${inner2} })(${first})`;
    }
    const inner = `${decls.length ? `let ${decls.join(", ")}; ` : ""}${e.kind === "gen" ? "" : `const ${r} = ${e.kind === "list" ? "[]" : e.kind === "set" ? "newSet()" : "newDict()"}; `}${loops.join(" ")} ${body} ${closes.reverse().join(" ")}${e.kind === "gen" ? "" : ` return ${r};`}`;
    this.fn = saved;
    if (e.kind === "gen") return `(function* genexpr$$($it0) { ${inner} })(${first})`;
    return `(function ${e.kind}comp$$($it0) { ${inner} })(${first})`;
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
    this.fn = new Fn(scope, saved, self, e.args.args.length ? js(e.args.args[0].name) : null);
    for (const n of [...e.args.args, ...e.args.kwonly]) this.fn.assigned.add(n.name);
    if (e.args.vararg) this.fn.assigned.add(e.args.vararg);
    if (e.args.kwarg) this.fn.assigned.add(e.args.kwarg);
    const body = this.ex(e.body);
    const locals = [...scope.bound].filter((n) => !this.isParam(e.args, n) && resolve(scope, n).kind === "local").map(js);
    const decls = [...locals, ...this.fn.temps];
    const star = scope.isGenerator ? "*" : "";
    this.fn = saved;
    return `defn(function${star} ${self}(${ps}) { ${pro.join(" ")} ${decls.length ? `let ${decls.join(", ")}; ` : ""}return ${body}; }, "<lambda>", ${q(scope.qualname)}, $g.__name__, ${defaults}, ${kwdefaults}, ${sig}, null, $g)`;
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
      case "Expr":
        if (st.value.k === "Const") return;
        return this.w(`${this.ex(st.value)};`);
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
        const v = this.ex(st.value);
        if (st.targets.length === 1) return this.w(this.assignCode(st.targets[0], v));
        const t = this.temp();
        this.w(`${t} = ${v};`);
        for (const target of st.targets) this.w(this.assignCode(target, t));
        return;
      }
      case "AugAssign":
        return this.augAssign(st);
      case "AnnAssign":
        if (st.value !== null) this.w(this.assignCode(st.target, this.ex(st.value)));
        return;
      case "Return":
        if (this.fn.scope.kind !== "function") this.fail("'return' outside function");
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
          if (a.asname !== null) this.w(this.storeName(a.asname, `importAs(${q(a.name)}, $g)`));
          else this.w(this.storeName(a.name.split(".")[0], `importTop(${q(a.name)}, $g)`));
        }
        return;
      case "ImportFrom": {
        const m = this.temp();
        this.w(`${m} = importFromStmt(${q(st.module)}, [${st.names.map((a) => q(a.name)).join(", ")}], ${st.level}, $g);`);
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
        if (st.exc === null) {
          const h = this.fn.handlers[this.fn.handlers.length - 1];
          return this.w(h !== undefined ? `throw ${h};` : "throw reraise();");
        }
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
      this.w(`if (${f} === $B.range && ${ints}${args.length === 3 ? ` && ${stp} !== 0` : ""}) { ${i} = ${start}; ${end} = ${stop}; ${step} = ${stp}; ${it} = null; }`);
      this.w(`else ${it} = iter(callObj(${f}, [${args.join(", ")}]));`);
      this.w(`for (;;) {`);
      this.indent++;
      if (args.length === 3) this.w(`if (${it} === null) { if (${step} > 0 ? ${i} >= ${end} : ${i} <= ${end}) break; ${v} = ${i}; ${i} += ${step}; }`);
      else this.w(`if (${it} === null) { if (${i} >= ${end}) break; ${v} = ${i}++; }`);
      this.w(`else { ${v} = ${it}.$next(); if (${v} === DONE) break; }`);
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
        if (r.kind === "global") return this.w(`if ($g${prop(t.id)} === undefined) gname(${q(t.id)}); delete $g${prop(t.id)};`);
        if (r.kind === "class") return this.w(`if (!$ns.delete(${q(t.id)})) gname(${q(t.id)});`);
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
    const { lines, decls } = this.nested(scope, self, p.args.length ? js(p.args[0].name) : null, params, () => {
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
    this.w(`}${scope.isAsync ? ")" : ""}, ${q(st.name)}, ${q(scope.qualname)}, $g.__name__, ${defaults}, ${kwdefaults}, ${sig}, ${doc}, $g);`);
    this.w(this.storeName(st.name, decs.reduceRight((acc, d) => `callObj(${d}, [${acc}])`, f)));
  }

  classDef(st: Extract<A.Stmt, { k: "ClassDef" }>) {
    const decs = this.evalDecorators(st.decorators).map((d) => (d as any).id as string);
    const scope = this.fn.scope.child(st);
    const bases = this.items(st.bases);
    const kwNames = st.keywords.filter((k) => k.arg !== null).map((k) => q(k.arg!));
    const kwValues = st.keywords.filter((k) => k.arg !== null).map((k) => this.ex(k.value));
    const b = this.temp();
    this.w(`${b} = ${bases};`);
    const { lines, decls } = this.nested(scope, "", null, [], () => {
      const body = st.body;
      this.w(`$ns.set("__module__", $g.__name__); $ns.set("__qualname__", ${q(scope.qualname)}); $ns.set("__firstlineno__", ${st.line});`);
      if (body[0]?.k === "Expr" && body[0].value.k === "Const" && body[0].value.value.t === "str") this.w(`$ns.set("__doc__", ${q(body[0].value.value.v)});`);
      for (const s of body) this.stmt(s);
    });
    this.line = st.line;
    const c = this.temp();
    this.w(`${c} = (function ${js(st.name)}$() {`);
    this.indent++;
    this.w(`const $ns = new Map(); let __class__$;`);
    if (decls.length) this.w(`let ${decls.join(", ")};`);
    this.indent--;
    this.splice(lines);
    this.line = st.line;
    this.indent++;
    this.w(`return (__class__$ = classDef(${q(st.name)}, ${q(scope.qualname)}, $g.__name__, ${b}, $ns, [${kwNames.join(", ")}], [${kwValues.join(", ")}]));`);
    this.indent--;
    this.w("})();");
    this.w(this.storeName(st.name, decs.reduceRight((acc, d) => `callObj(${d}, [${acc}])`, c)));
  }

  tryStmt(st: Extract<A.Stmt, { k: "Try" }>) {
    const before = new Set(this.fn.assigned);
    const hasFinally = st.finalbody.length > 0;
    if (hasFinally) {
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
      st.handlers.forEach((h, i) => {
        this.line = h.line;
        if (h.type === null && i !== st.handlers.length - 1) this.fail("default 'except:' must be last", h.line);
        const cond = h.type === null ? "true" : `excMatch(${e}, ${this.ex(h.type)})`;
        this.w(`${i === 0 ? "" : "} else "}if (${cond}) {`);
        this.indent++;
        if (h.name !== null) this.w(this.storeName(h.name, e));
        // Exceptions raised while handling get this one as __context__.
        const x = this.temp();
        this.w("try {");
        this.fn.handlers.push(e);
        this.block(h.body);
        this.fn.handlers.pop();
        this.w(`} catch (${x}_) { ${x} = toPyExc(${x}_); if (${x} !== ${e} && ${x}.__context__ == null) ${x}.__context__ = ${e}; throw ${x}; }`);
        if (h.name !== null) {
          this.w(this.storeName(h.name, "undefined"));
          this.fn.assigned.delete(h.name);
        }
        this.indent--;
      });
      this.w(`} else throw ${e};`);
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
    if (hasFinally) {
      this.indent--;
      this.w("} finally {");
      this.block(st.finalbody);
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
    this.w(`} catch (${e}_) { ${ok} = false; ${e} = toPyExc(${e}_); if (!truth(${exit}(typeOf(${e}), ${e}, null))) throw ${e}; } finally { if (${ok}) ${exit}(null, null, null); }`);
  }

  // ------------------------------------------------------------ module

  module(body: A.Stmt[], evalMode = false): Compiled {
    this.fn = new Fn(this.top, null, "module$$", null);
    if (evalMode) {
      if (body.length !== 1 || body[0].k !== "Expr") this.fail("invalid syntax", body[0]?.line ?? 1);
      this.line = body[0].line;
      this.w(`return ${this.ex((body[0] as Extract<A.Stmt, { k: "Expr" }>).value)};`);
    } else for (const s of body) this.stmt(s);
    const head = [
      "(function module$$($g, R) {",
      '"use strict";',
      `const {${RUNTIME_NAMES.join(", ")}} = R;`,
      "const $B = R.builtins;",
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

function* allScopes(s: Scope): Generator<Scope> {
  yield s;
  for (const c of s.children.values()) yield* allScopes(c);
}

// Runtime helpers referenced by generated code.
const RUNTIME_NAMES = [
  "add", "sub", "mul", "truediv", "floordiv", "mod", "pow", "lshift", "rshift", "and", "or", "xor", "matmul",
  "iadd", "isub", "imul", "itruediv", "ifloordiv", "imod", "ipow", "ilshift", "irshift", "iand", "ior", "ixor", "imatmul",
  "sagediv", "isagediv", "sagepow", "isagepow",
  "neg", "pos", "invert", "truth", "lt", "le", "gt", "ge", "eq", "ne", "is", "contains",
  "getitem", "setitem", "delitem", "PySlice", "tuple", "newSet", "setAdd", "newDict", "dictSet", "dictUpdate", "dictOf",
  "iter", "DONE", "unpack", "unpackEx", "toArray", "fmt", "fbox", "callObj", "callKw", "callEx", "superOf",
  "defn", "dflt", "kwdflt", "tooManyArgs", "gname", "unboundLocal", "unboundFree", "yieldFrom", "yfr", "awaitIter", "markCoro",
  "raiseExc", "toPyExc", "excMatch", "withEnter", "withExit", "reraise", "classDef",
  "importModule", "importTop", "importAs", "importFromStmt", "importFrom", "importStar", "resolveRelative", "delattr", "Ellipsis", "T", "typeOf",
  "sortedKeys",
];
