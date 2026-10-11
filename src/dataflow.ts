// A cell's definitions and references, for the reactive notebook
// (design/reactive-notebook.md): which global names a cell defines, which it
// reads but does not define, and which it deletes.
//
// The semantics are marimo's: this is a port of marimo's ScopedVisitor
// (marimo/_ast/visitor.py, marimo-team/marimo, Apache-2.0, Copyright 2026
// Marimo), over pyparse's AST, which is CPython's (same node types, same
// fields, in the same order).  Only what determines definitions and
// references is ported; marimo's SQL cells and its per-variable metadata
// (annotations, import data, closures' required refs) are not.  The real
// marimo is the oracle: test/dataflow.test.ts compares the two.
import { parse } from "../pyparse/src/index";
import { preparse } from "./sagepre";
import { magmaToPython } from "./magma";
import { helpSyntax } from "./help-syntax";

type Node = { _type: string; [field: string]: any };

const enum Scope {
  Module,
  Class,
  Function,
  Comprehension,
  Annotation,
}

class Block {
  defs = new Set<string>();
  globalNames = new Set<string>();
  // the kinds of the definitions of each name ("method" matters below)
  kinds = new Map<string, string[]>();
  constructor(public scope: Scope = Scope.Module) {}
}

interface RefData {
  deleted: boolean;
  block: Block;
  parents: Block[];
}

/** marimo's is_local: `_x` (not `__x`), and `__` itself. */
export const isLocal = (name: string): boolean => name === "__" || (name.startsWith("_") && !name.startsWith("__"));

export class ImportStarError extends Error {
  override name = "ImportStarError";
}

export interface CellAnalysis {
  /** global names the cell defines (not `_`-local ones) */
  defs: Set<string>;
  /** global names it reads but does not define (builtins included, as marimo) */
  refs: Set<string>;
  /** the refs it deletes (`del x`) */
  deleted: Set<string>;
  /**
   * refs whose objects it visibly mutates at its top level (`v[i] = ...`,
   * `z.x = ...`, `del v[i]`, `v.append(...)`, ...): ours, not marimo's
   * (design/reactive-notebook.md, mutation tracking)
   */
  mutations?: Set<string>;
  /**
   * defs bound only by an import, with what is imported ("numpy",
   * "numpy.linalg:norm"): the same import in several cells defines the same
   * thing (ours: not an error)
   */
  imports?: Map<string, string>;
}

const clone = (x: any): any =>
  Array.isArray(x) ? x.map(clone) : x && typeof x === "object" && typeof x._type === "string" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, clone(v)])) : x;

class Visitor {
  blocks: Block[] = [new Block()];
  obscured: (string | null)[] = [];
  refs = new Map<string, RefData[]>();
  constructor(public id: string) {}

  mangle(name: string, ignoreScope = false): string {
    return isLocal(name) && (this.blocks.length === 1 || ignoreScope) ? `_${this.id}${name}` : name;
  }
  isDefined(name: string): boolean {
    return this.blocks.some((b) => b.defs.has(name));
  }
  addRef(name: string, deleted: boolean): void {
    let list = this.refs.get(name);
    if (!list) this.refs.set(name, (list = []));
    const block = this.blocks[this.blocks.length - 1];
    const found = list.find((r) => r.block === block);
    if (found && deleted) found.deleted = true;
    else if (!found) list.push({ deleted, block, parents: this.blocks.slice(0, -1) });
  }
  removeRef(name: string, block: Block): void {
    const list = (this.refs.get(name) ?? []).filter((r) => !r.parents.includes(block));
    if (list.length) this.refs.set(name, list);
    else this.refs.delete(name);
  }
  defineIn(name: string, kind: string, idx: number): void {
    const block = idx < 0 ? this.blocks[this.blocks.length + idx] : this.blocks[idx];
    block.defs.add(name);
    let ks = block.kinds.get(name);
    if (!ks) block.kinds.set(name, (ks = []));
    ks.push(kind);
    // a name defined at the top after being captured (def f(): print(x) / x = 0)
    if (kind !== "method" && (this.refs.get(name) ?? []).some((r) => r.parents.includes(block))) this.removeRef(name, block);
  }
  define(name: string, kind: string): void {
    const idx = this.blocks[this.blocks.length - 1].globalNames.has(name) ? 0 : -1;
    if (kind !== "import" && (idx === 0 || this.blocks.length === 1)) this.imported.set(name, null);
    this.defineIn(name, kind, idx);
  }

  visit(node: any): void {
    if (node === null || typeof node !== "object" || typeof node._type !== "string") return;
    const f = (this as any)["visit_" + node._type];
    if (f) f.call(this, node);
    else this.genericVisit(node);
  }
  // Python's ast.NodeVisitor.generic_visit: every child, in field order
  children(node: Node): void {
    for (const key of Object.keys(node)) {
      if (key === "_type") continue;
      const v = node[key];
      if (Array.isArray(v)) for (const x of v) this.visit(x);
      else this.visit(v);
    }
  }
  genericVisit(node: Node): void {
    const t = node._type;
    if (t === "ClassDef" || t === "Lambda") {
      this.blocks.push(new Block(t === "ClassDef" ? Scope.Class : Scope.Function));
      this.children(node);
      this.blocks.pop();
    } else if (t === "AsyncFunctionDef" || t === "FunctionDef") {
      this.blocks.push(new Block(Scope.Function));
      for (const p of node.type_params ?? []) this.visit(p);
      this.children(node);
      this.blocks.pop();
    } else if (t === "ListComp" || t === "SetComp" || t === "GeneratorExp") {
      this.blocks.push(new Block(Scope.Comprehension));
      for (const g of node.generators) this.visit(g);
      this.visit(node.elt);
      this.blocks.pop();
    } else if (t === "DictComp") {
      this.blocks.push(new Block(Scope.Comprehension));
      for (const g of node.generators) this.visit(g);
      this.visit(node.value);
      this.visit(node.key);
      this.blocks.pop();
    } else if (t === "Try" || t === "TryStar") {
      for (const s of node.body) this.visit(s);
      for (const h of node.handlers) {
        this.obscured.push(h.name ?? null);
        this.visit(h);
        this.obscured.pop();
      }
      for (const s of node.orelse) this.visit(s);
      for (const s of node.finalbody) this.visit(s);
    } else if (t === "TypeAlias") {
      this.visit(node.name);
      this.blocks.push(new Block(Scope.Annotation));
      for (const p of node.type_params ?? []) this.visit(p);
      this.visit(node.value);
      this.blocks.pop();
    } else this.children(node);
  }

  // A function's or class's signature, then all of it (marimo's
  // _visit_and_get_refs; the signature is visited on a copy, as visiting
  // renames `_`-locals).
  visitDefinition(node: Node): void {
    const mock = { ...clone(node), body: [] };
    this.genericVisit(mock);
    if ((node._type === "FunctionDef" || node._type === "AsyncFunctionDef") && this.blocks[this.blocks.length - 1].scope !== Scope.Class) {
      this.blocks[this.blocks.length - 1].defs.add(node.name);
    }
    this.genericVisit(node);
  }
  visit_ClassDef(node: Node): void {
    node.name = this.mangle(node.name);
    this.visitDefinition(node);
    this.define(node.name, "class");
  }
  visit_FunctionDef(node: Node): void {
    node.name = this.mangle(node.name);
    this.visitDefinition(node);
    this.define(node.name, this.blocks[this.blocks.length - 1].scope === Scope.Class ? "method" : "function");
  }
  visit_AsyncFunctionDef(node: Node): void {
    this.visit_FunctionDef(node);
  }
  visit_arg(node: Node): void {
    node.arg = this.mangle(node.arg);
    this.define(node.arg, "variable");
    if (node.annotation) this.visit(node.annotation);
  }
  visit_arguments(node: Node): void {
    for (const v of node.kw_defaults) if (v) this.visit(v);
    for (const v of node.defaults) if (v) this.visit(v);
    for (const a of node.posonlyargs) this.visit(a);
    for (const a of node.args) this.visit(a);
    for (const a of node.kwonlyargs) this.visit(a);
    if (node.vararg) this.visit(node.vararg);
    if (node.kwarg) this.visit(node.kwarg);
  }
  visit_Assign(node: Node): void {
    this.visit(node.value);
    for (const t of node.targets) this.visit(t);
  }
  visit_AugAssign(node: Node): void {
    this.visit(node.value);
    this.visit(node.target);
  }
  visit_AnnAssign(node: Node): void {
    if (node.value) this.visit(node.value);
    this.visit(node.annotation);
    this.visit(node.target);
  }
  visit_comprehension(node: Node): void {
    this.visit(node.iter);
    this.visit(node.target);
    for (const c of node.ifs) this.visit(c);
  }
  visit_NamedExpr(node: Node): void {
    this.visit(node.value);
    if (this.blocks[this.blocks.length - 1].scope === Scope.Comprehension && node.target._type === "Name") {
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        if (this.blocks[i].scope !== Scope.Comprehension) {
          node.target.id = this.mangle(node.target.id, i === 0);
          this.defineIn(node.target.id, "variable", i);
          break;
        }
      }
    } else this.visit(node.target);
  }
  visit_Name(node: Node): void {
    if (this.obscured.includes(node.id)) return;
    const ctx = node.ctx?._type;
    if (ctx === "Store") {
      node.id = this.mangle(node.id);
      this.define(node.id, "variable");
    } else if (ctx === "Load" && !this.isDefined(node.id) && !isLocal(node.id)) {
      this.addRef(node.id, false);
    } else if (ctx === "Del" && !this.isDefined(node.id) && !isLocal(node.id)) {
      this.addRef(node.id, true);
    } else if (isLocal(node.id)) {
      // a local resolves against the top-level block (marimo's mangling)
      const mangled = this.mangle(node.id, true);
      for (let i = this.blocks.length - 1; i >= 0; i--) {
        const b = this.blocks[i];
        if (i === 0) {
          if (b.defs.has(mangled) || !b.defs.has(node.id)) node.id = mangled;
        } else if (b.defs.has(node.id)) break;
      }
    }
  }
  visit_Global(node: Node): void {
    node.names = node.names.map((n: string) => this.mangle(n, true));
    for (const n of node.names) {
      this.blocks[this.blocks.length - 1].globalNames.add(n);
      if (!this.blocks[0].defs.has(n)) this.addRef(n, false);
    }
  }
  aliasName(alias: Node): string {
    if (alias.asname == null) {
      const base = alias.name.split(".")[0];
      if (base === "*") throw new ImportStarError("Importing symbols with `import *` is not allowed in marimo.");
      return base;
    }
    alias.asname = this.mangle(alias.asname);
    return alias.asname;
  }
  // (what each top-level name was bound to by an import; any other binding clears it)
  imported = new Map<string, string | null>();
  noteImport(name: string, what: string | null): void {
    if (this.blocks.length !== 1 || this.blocks[0].globalNames.has(name)) return;
    this.imported.set(name, this.imported.has(name) && this.imported.get(name) !== what ? null : what);
  }
  visit_Import(node: Node): void {
    for (const a of node.names) {
      const n = this.aliasName(a);
      this.define(n, "import");
      this.noteImport(n, a.asname == null ? a.name.split(".")[0] : a.name);
    }
  }
  visit_ImportFrom(node: Node): void {
    for (const a of node.names) {
      const n = this.aliasName(a);
      this.define(n, "import");
      this.noteImport(n, `${".".repeat(node.level ?? 0)}${node.module ?? ""}:${a.name}`);
    }
  }
  visit_MatchAs(node: Node): void {
    if (node.name != null) {
      node.name = this.mangle(node.name);
      this.define(node.name, "variable");
    }
    if (node.pattern) this.visit(node.pattern);
  }
  visit_MatchMapping(node: Node): void {
    if (node.rest != null) {
      node.rest = this.mangle(node.rest);
      this.define(node.rest, "variable");
    }
    for (const k of node.keys) this.visit(k);
    for (const p of node.patterns) this.visit(p);
  }
  visit_MatchStar(node: Node): void {
    if (node.name != null) {
      node.name = this.mangle(node.name);
      this.define(node.name, "variable");
    }
  }
  visit_TypeVar(node: Node): void {
    this.define(node.name, "variable");
    if (Array.isArray(node.bound)) for (const b of node.bound) this.visit(b);
    else if (node.bound) this.visit(node.bound);
  }
  visit_ParamSpec(node: Node): void {
    this.define(node.name, "variable");
  }
  visit_TypeVarTuple(node: Node): void {
    this.define(node.name, "variable");
  }
}

/**
 * A cell's definitions, references and deleted references, as marimo's
 * compile_cell computes them.  Sage cells are analyzed after preparsing, and
 * Magma cells after translation to Python, as they run.  In Sage, a top-level
 * `var('x y')` (or `function('f')`) defines its names, as running it does.
 */
export function analyzeCell(source: string, cellId = "c", opts: { mode?: "python" | "sage" | "magma" } = {}): CellAnalysis {
  // (marimo: some frontends send non-breaking spaces)
  source = source.replaceAll(" ", " ");
  // (IPython's obj? help lines, as the notebook runs them)
  if (opts.mode !== "magma") source = helpSyntax(source);
  if (opts.mode === "sage") source = preparse(source);
  // (the translation's `from _magma import *` brings Magma's functions, not the notebook's names)
  else if (opts.mode === "magma") source = magmaToPython(source, "<cell>").replace(/^from _magma import \*\n/, "");
  const tree = parse(source, "exec") as Node;
  const injected = opts.mode === "sage" ? sageInjected(tree) : [];
  const v = new Visitor("cell_" + cellId);
  v.visit(tree);
  const top = v.blocks[0];
  const defs = new Set([...top.defs].filter((n) => !isLocal(n)));
  for (const n of injected) {
    // (a private _x of var('_x') is the cell's own: privateVars)
    if (!isLocal(n)) defs.add(n);
  }
  const refs = new Set([...v.refs.keys()].filter((n) => !injected.includes(n)));
  return {
    defs,
    refs,
    deleted: new Set([...v.refs].filter(([, rs]) => rs.some((r) => r.deleted)).map(([n]) => n)),
    mutations: new Set([...mutated(tree)].filter((n) => refs.has(n) && !defs.has(n))),
    imports: new Map([...v.imported].filter((e): e is [string, string] => e[1] !== null && defs.has(e[0]))),
  };
}

// Methods that change their object in place (lists, dicts, sets, bytearrays,
// deques, NumPy arrays, Sage's mutable matrices and vectors).
const MUTATORS = new Set([
  "append", "extend", "insert", "pop", "popitem", "remove", "clear", "update", "add", "discard", "sort", "reverse",
  "setdefault", "appendleft", "extendleft", "popleft", "rotate", "difference_update", "intersection_update",
  "symmetric_difference_update", "fill", "resize", "put", "itemset", "partition", "byteswap", "set_immutable",
  "set_row", "set_column", "set_block", "swap_rows", "swap_columns", "rescale_row", "add_multiple_of_row",
  "add_multiple_of_column", "__setitem__", "__delitem__", "__iadd__", "__isub__", "__imul__",
]);
// Functions that change their first argument in place.
const MUTATING_FUNCTIONS = new Set(["shuffle", "heappush", "heappop", "heapify", "heapreplace", "heappushpop", "copyto", "place", "putmask"]);

// The names whose objects a module's top-level code visibly mutates (not
// inside functions or classes: those mutate when called).
function mutated(tree: Node): Set<string> {
  const out = new Set<string>();
  const root = (e: any): string | null => {
    while (e && (e._type === "Subscript" || e._type === "Attribute")) e = e.value;
    return e?._type === "Name" ? e.id : null;
  };
  const target = (t: any) => {
    if (!t) return;
    if (t._type === "Subscript" || t._type === "Attribute") {
      const n = root(t);
      if (n) out.add(n);
    } else if (t._type === "Tuple" || t._type === "List") for (const x of t.elts) target(x);
    else if (t._type === "Starred") target(t.value);
  };
  const walk = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node._type !== "string") return;
    switch (node._type) {
      case "FunctionDef": case "AsyncFunctionDef": case "ClassDef": case "Lambda":
        // (their decorators and defaults run now)
        walk(node.decorator_list);
        walk(node.args?.defaults);
        walk(node.args?.kw_defaults);
        return;
      case "Assign": for (const t of node.targets) target(t); break;
      case "AugAssign": case "AnnAssign": target(node.target); break;
      case "Delete": for (const t of node.targets) target(t); break;
      case "For": case "AsyncFor": target(node.target); break;
      case "With": case "AsyncWith": for (const it of node.items) target(it.optional_vars); break;
      case "Call": {
        const f = node.func;
        if (f?._type === "Attribute" && MUTATORS.has(f.attr)) {
          const n = root(f.value);
          if (n) out.add(n);
        }
        const fname = f?._type === "Name" ? f.id : f?._type === "Attribute" ? f.attr : null;
        if (fname && MUTATING_FUNCTIONS.has(fname) && node.args.length) {
          const n = root(node.args[0]);
          if (n) out.add(n);
        }
        break;
      }
    }
    for (const key of Object.keys(node)) if (key !== "_type") walk(node[key]);
  };
  walk(tree.body);
  return out;
}

/**
 * Rename a cell's `_` names as marimo does (`_x` -> `_cell_<id>_x`, where it
 * refers to the cell's global), in place, in pyparse's tree: then each cell's
 * `_` names are its own, though cells share the interpreter's globals.
 * `id` must be alphanumeric.  (`import *`, an error in the graph, is left.)
 */
export function mangleLocals(tree: any, id: string, opts: { sage?: boolean } = {}): void {
  try {
    if (opts.sage) privateVars(tree);
    const v = new Visitor("cell_" + id);
    v.visit(tree);
  } catch (e) {
    if (!(e instanceof ImportStarError)) throw e;
  }
}
/** The prefix of a cell's renamed `_` names. */
export const localPrefix = (id: string) => `_cell_${id}_`;

// a Python identifier (of any script)
const IDENT = /^[\p{L}_][\p{L}\p{N}\p{Mn}\p{Mc}_]*$/u;

// A Sage cell's top-level `var('_x ...')` naming private names: it would set
// the global _x, shared by every cell; as `_x, ... = SR.var('_x ...')` (which
// sets no global) it binds the cell's own _x, renamed as the cell's other
// private names are.  In place, in pyparse's tree.
function privateVars(tree: Node): void {
  tree.body = tree.body.map((st: any) => {
    const call = st._type === "Expr" ? st.value : null;
    if (call?._type !== "Call" || call.func._type !== "Name" || call.func.id !== "var" || !call.args.length) return st;
    if (!call.args.every((a: any) => a._type === "Constant" && typeof a.value === "string")) return st;
    const names = call.args.flatMap((a: any) => a.value.split(/[\s,]+/).filter(Boolean));
    if (!names.some(isLocal) || !names.every((n: string) => IDENT.test(n))) return st;
    const pos = { lineno: st.lineno, col_offset: st.col_offset, end_lineno: st.end_lineno, end_col_offset: st.end_col_offset };
    const name = (id: string) => ({ _type: "Name", id, ctx: { _type: "Store" }, ...pos });
    const target = names.length === 1 ? name(names[0]) : { _type: "Tuple", elts: names.map(name), ctx: { _type: "Store" }, ...pos };
    const func = { _type: "Attribute", value: { _type: "Name", id: "SR", ctx: { _type: "Load" }, ...pos }, attr: "var", ctx: { _type: "Load" }, ...pos };
    // (one string: SR.var('a b') gives a tuple for several names; keywords
    // such as domain= kept)
    const arg = { _type: "Constant", value: names.join(" "), kind: null, ...pos };
    return { _type: "Assign", targets: [target], value: { ...call, func, args: [arg] }, type_comment: null, ...pos };
  });
}

// The names a Sage cell's top-level `var("x y")`, `var("x", "y")` or
// `function("f")` statements bind in the notebook's namespace.
function sageInjected(tree: Node): string[] {
  const out: string[] = [];
  for (const st of tree.body) {
    const call = st._type === "Expr" ? st.value : null;
    if (call?._type !== "Call" || call.func._type !== "Name" || !["var", "function"].includes(call.func.id)) continue;
    for (const a of call.args) {
      if (a._type === "Constant" && typeof a.value === "string") out.push(...a.value.split(/[\s,]+/).filter((n: string) => IDENT.test(n)));
    }
  }
  return out;
}
