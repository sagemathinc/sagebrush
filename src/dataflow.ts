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

export class ImportStarError extends Error {}

export interface CellAnalysis {
  /** global names the cell defines (not `_`-local ones) */
  defs: Set<string>;
  /** global names it reads but does not define (builtins included, as marimo) */
  refs: Set<string>;
  /** the refs it deletes (`del x`) */
  deleted: Set<string>;
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
    this.defineIn(name, kind, this.blocks[this.blocks.length - 1].globalNames.has(name) ? 0 : -1);
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
  visit_Import(node: Node): void {
    for (const a of node.names) this.define(this.aliasName(a), "import");
  }
  visit_ImportFrom(node: Node): void {
    for (const a of node.names) this.define(this.aliasName(a), "import");
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

/** A cell's definitions, references and deleted references, as marimo's compile_cell computes them. */
export function analyzeCell(source: string, cellId = "c"): CellAnalysis {
  // (marimo: some frontends send non-breaking spaces)
  const tree = parse(source.replaceAll(" ", " "), "exec") as Node;
  const v = new Visitor("cell_" + cellId);
  v.visit(tree);
  const top = v.blocks[0];
  return {
    defs: new Set([...top.defs].filter((n) => !isLocal(n))),
    refs: new Set(v.refs.keys()),
    deleted: new Set([...v.refs].filter(([, rs]) => rs.some((r) => r.deleted)).map(([n]) => n)),
  };
}
