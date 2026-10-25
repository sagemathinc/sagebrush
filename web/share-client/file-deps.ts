// The files a notebook depends on, from its code: which workspace files the
// Share dialog pre-checks (design: share-ux-plan r2 §2, the plan's frozen
// interface §2.4).  Pure: no DOM, no workspace, nothing run or evaluated
// beyond constant path parts.  It runs in the dialog's worker
// (deps-worker.ts) and reports as it goes.
//
// The rule throughout: a file wrongly pre-checked is shared without the user
// meaning to, so where the static rules can't be exact they leave a file out
// and say why (onUnfollowed); everything left out is still listed, a click away.
//
// What counts (plan §2.2):
//   - a string constant (or a constant path: Path("a") / "b", os.path.join
//     with constant parts, recognized by binding) that is an argument of a
//     call, or bound to a name in the same scope that is a call argument;
//     not docstrings, comparisons, f-strings' parts, print/logging/warnings
//     arguments, or anything inside a raise;
//   - imports, resolved in pyjs's own order (§2.3): native modules first,
//     then sys.path in order, each directory's name/__init__.py before
//     name.py, the first match winning (src/runtime/modules.ts importModule,
//     src/compile.ts R.loader.load); no namespace packages, as pyjs has none;
//   - `!`/%%bash words naming an existing file, %run (followed as a module),
//     %load; Markdown links and images.
import { parse } from "../../pyparse/src/index";
import { ipythonSyntax } from "../../src/help-syntax";
import { expandMagics, codeParser } from "../../src/magic-syntax";
import { preparse } from "../../src/sagepre";
import { magmaToPython } from "../../src/magma";
import { matlabToPython } from "../../src/matlab";

export type CellKind = "python" | "sage" | "magma" | "matlab" | "markdown";
export type Reason =
  | { kind: "read"; cell: number } // a runtime observation (merged by the dialog, never by fileDeps)
  | { kind: "opened" | "named" | "linked" | "imported"; cell: number }
  | { kind: "opened" | "named" | "imported"; by: string };
export type Unfollowed = { where: { cell: number } | { file: string }; line: number; why: string };
export interface FileDepsInput {
  cells: { index: number; kind: CellKind; source: string }[];
  /** workspace file metadata, by absolute workspace path ("/data/a.csv") */
  files: ReadonlyMap<string, { size?: number }>;
  /** the session's os.getcwd(), a workspace path */
  cwd: string;
  /** the session's sys.path, in order */
  importPath: { dir: string; workspace: boolean }[];
  /** native factory names (always win over sys.path) */
  builtinModules: ReadonlySet<string>;
  /** dotted names importable from the non-workspace sys.path entries */
  externalModules: ReadonlySet<string>;
  /** one .py's text, read lazily, only when needed */
  readFile: (path: string) => Promise<string>;
  onDep: (path: string, reason: Reason) => void;
  onUnfollowed: (u: Unfollowed) => void;
  onProgress: (p: { parsed: number; queued: number }) => void;
  signal: AbortSignal;
}

type Where = { cell: number } | { by: string };
type Node = any;

// ---- paths

/** A workspace path for `p` (relative to `cwd`), or null: a URL, or above the workspace's root. */
export function workspacePath(cwd: string, p: string): string | null {
  if (!p || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p) || p.includes("\0")) return null;
  const parts: string[] = [];
  for (const s of (p.startsWith("/") ? p : `${cwd}/${p}`).split("/")) {
    if (s === "" || s === ".") continue;
    if (s === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(s);
  }
  return "/" + parts.join("/");
}
const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const joinDir = (d: string, ...rest: string[]) => [d.replace(/\/+$/, ""), ...rest].join("/");

// ---- callers' names: what a name is bound to, by imports (plan §2.2 "by binding")

// The qualified names of the openers: "opened" rather than "named".
const OPENERS = new Set(["builtins.open", "io.open", "codecs.open", "numpy.load", "numpy.loadtxt", "numpy.genfromtxt", "numpy.fromfile"]);
const PATH_METHODS = new Set(["open", "read_text", "read_bytes"]);
const PATH_TYPES = new Set(["pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath", "pathlib.PurePosixPath"]);
const isOpener = (q: string | null) => !!q && (OPENERS.has(q) || q.startsWith("pandas.read_") || [...PATH_TYPES].some((t) => q.startsWith(t + "().") && PATH_METHODS.has(q.slice(t.length + 3))));
// Calls whose arguments are messages, never files.
const MESSAGES = (q: string | null) => !!q && (q === "builtins.print" || q.startsWith("logging.") || q === "warnings.warn" || /(Error|Exception|Warning)$/.test(q));
const BUILTINS = new Set(["open", "print", "exec", "__import__"]);

/** Names bound by imports in a unit (a notebook's cells together, or one file), and the names rebound otherwise. */
class Bindings {
  imported = new Map<string, string>();
  rebound = new Set<string>();
  scan(tree: Node) {
    walk(tree, (n) => {
      switch (n._type) {
        case "Import":
          for (const a of n.names) {
            if (a.asname) this.imported.set(a.asname, a.name);
            else this.imported.set(a.name.split(".")[0], a.name.split(".")[0]);
          }
          break;
        case "ImportFrom":
          if (n.module && !n.level) for (const a of n.names) if (a.name !== "*") this.imported.set(a.asname ?? a.name, `${n.module}.${a.name}`);
          break;
        case "FunctionDef":
        case "AsyncFunctionDef":
        case "ClassDef":
          this.rebound.add(n.name);
          break;
        case "Name":
          if (n.ctx?._type === "Store" || n.ctx?._type === "Del") this.rebound.add(n.id);
          break;
        case "arg":
          this.rebound.add(n.arg);
          break;
      }
      return true;
    });
  }
  /** The qualified name an expression stands for (os.path.join, pathlib.Path().read_text), or null. */
  qualified(e: Node): string | null {
    if (!e) return null;
    if (e._type === "Name") {
      if (this.rebound.has(e.id)) return null;
      const q = this.imported.get(e.id);
      if (q !== undefined) return q;
      return BUILTINS.has(e.id) ? `builtins.${e.id}` : null;
    }
    if (e._type === "Attribute") {
      const b = this.qualified(e.value);
      return b === null ? null : `${b}.${e.attr}`;
    }
    if (e._type === "Call") {
      const f = this.qualified(e.func);
      return f !== null && PATH_TYPES.has(f) ? `${f}()` : null;
    }
    return null;
  }
}

/** Visit every node; `f` returns false to skip a node's children. */
function walk(n: Node, f: (n: Node) => boolean): void {
  if (n === null || typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, f);
    return;
  }
  if (typeof n._type === "string" && !f(n)) return;
  for (const k in n) if (k !== "_type" && typeof n[k] === "object") walk(n[k], f);
}

// ---- the analysis

interface Unit {
  where: Where;
  /** a workspace .py's own path (for relative imports and reasons), or undefined for a cell */
  file?: string;
  /** the module's dotted name, for relative imports (a cell has none) */
  module?: string;
  isPackage?: boolean;
}

export async function fileDeps(input: FileDepsInput): Promise<{ complete: boolean }> {
  const { files, cwd, signal } = input;
  let complete = true;
  const seen = new Set<string>(); // paths reported
  const queued = new Set<string>(); // .py files queued or scanned
  const work: { path: string; module: string | null; isPackage: boolean; by: Where }[] = [];
  const trees = new Map<string, Node | null>();
  let parsed = 0;
  const aborted = () => signal.aborted;
  const dep = (path: string, kind: "opened" | "named" | "linked" | "imported", w: Where) => {
    if (seen.has(path) || !files.has(path)) return;
    seen.add(path);
    input.onDep(path, "cell" in w ? { kind, cell: w.cell } : { kind: kind === "linked" ? "named" : kind, by: w.by });
  };
  const unfollowed = (w: Where, line: number, why: string) => {
    input.onUnfollowed({ where: "cell" in w ? { cell: w.cell } : { file: w.by }, line, why });
  };
  const progress = () => input.onProgress({ parsed, queued: work.length });

  // A module's workspace files, in pyjs's order: native first (never a
  // file), then sys.path, then (not found) nothing.  Returns the files of
  // the chain a.__init__, a.b.__init__, ..., the module itself, or null when
  // it isn't a workspace module (native, external or not found).
  const resolve = (name: string): { file: string; module: string; isPackage: boolean }[] | null => {
    const parts = name.split(".");
    const chain: { file: string; module: string; isPackage: boolean }[] = [];
    let dir: string | null = null;
    for (let i = 0; i < parts.length; i++) {
      const mod = parts.slice(0, i + 1).join(".");
      if (input.builtinModules.has(mod)) return null;
      let found: { file: string; isPackage: boolean } | null = null;
      if (i === 0) {
        for (const e of input.importPath) {
          if (e.workspace) {
            const pkg = joinDir(e.dir, parts[0], "__init__.py"), m = joinDir(e.dir, parts[0] + ".py");
            if (files.has(pkg)) found = { file: pkg, isPackage: true };
            else if (files.has(m)) found = { file: m, isPackage: false };
            if (found) break;
          } else if (input.externalModules.has(parts[0])) return null;
        }
      } else {
        if (dir === null) return null; // (a module isn't a package: no submodules)
        const pkg = joinDir(dir, parts[i], "__init__.py"), m = joinDir(dir, parts[i] + ".py");
        if (files.has(pkg)) found = { file: pkg, isPackage: true };
        else if (files.has(m)) found = { file: m, isPackage: false };
      }
      if (!found) return null;
      chain.push({ ...found, module: mod });
      dir = found.isPackage ? dirOf(found.file) : null;
    }
    return chain;
  };
  const enqueue = (c: { file: string; module: string | null; isPackage: boolean }, w: Where) => {
    dep(c.file, "imported", w);
    if (queued.has(c.file)) return;
    queued.add(c.file);
    work.push({ path: c.file, module: c.module, isPackage: c.isPackage, by: w });
  };
  const importModule = (name: string, w: Where): boolean => {
    const chain = resolve(name);
    if (chain === null) return false;
    for (const c of chain) enqueue(c, w);
    return true;
  };

  const treeOf = async (path: string): Promise<Node | null> => {
    if (trees.has(path)) return trees.get(path)!;
    let t: Node | null = null;
    try {
      t = parse(await input.readFile(path), "exec");
    } catch {
      t = null;
    }
    trees.set(path, t);
    return t;
  };

  // The constant __all__ of a package's __init__ (for `from a import *`).
  const allOf = async (file: string): Promise<string[]> => {
    const t = await treeOf(file);
    const out: string[] = [];
    for (const s of t?.body ?? []) {
      if (s._type === "Assign" && s.targets.length === 1 && s.targets[0]._type === "Name" && s.targets[0].id === "__all__" && (s.value._type === "List" || s.value._type === "Tuple")) {
        for (const e of s.value.elts) if (e._type === "Constant" && typeof e.value === "string") out.push(e.value);
      }
    }
    return out;
  };

  // One unit's tree: its imports, call-argument constants, magics.
  const scan = async (tree: Node, unit: Unit, b: Bindings, constants: Map<string, string[]>, opts: { imports: boolean }) => {
    const w = unit.where;
    let chdir = false;
    // star imports need the package's __init__ read: done after the walk, in order
    const stars: string[] = [];
    // (a relative name after os.chdir/%cd is unknowable statically)
    const pathFound = (p: string, kind: "opened" | "named", line: number) => {
      if (!p.startsWith("/") && chdir) return unfollowed(w, line, `"${p}" after a change of directory`);
      const wp = workspacePath(cwd, p);
      if (wp !== null) dep(wp, kind, w);
    };
    const constPath = (e: Node): string | null => {
      if (!e) return null;
      if (e._type === "Constant" && typeof e.value === "string") return e.value;
      if (e._type === "BinOp" && e.op?._type === "Div") {
        const l = constPath(e.left), r = constPath(e.right);
        return l !== null && r !== null && isPathish(e.left) ? (r.startsWith("/") ? r : `${l.replace(/\/+$/, "")}/${r}`) : null;
      }
      if (e._type === "Call") {
        const q = b.qualified(e.func);
        if ((q !== null && PATH_TYPES.has(q)) || q === "os.path.join" || q === "posixpath.join") {
          if (!e.args.length || e.keywords.length) return null;
          const parts = e.args.map(constPath);
          if (parts.some((x: string | null) => x === null)) return null;
          return parts.reduce((a: string, x: string) => (x.startsWith("/") ? x : a ? `${a.replace(/\/+$/, "")}/${x}` : x), "");
        }
      }
      return null;
    };
    const isPathish = (e: Node): boolean => e?._type === "Call" || (e?._type === "BinOp" && isPathish(e.left));
    // a call argument: a constant path, or a name bound to constants in this scope
    const argValues = (e: Node, scope: Map<string, string[]>): string[] | null => {
      const p = constPath(e);
      if (p !== null) return [p];
      if (e?._type === "Name" && e.ctx?._type === "Load") return scope.get(e.id) ?? null;
      return null;
    };
    const computed = (e: Node) => e && (e._type === "JoinedStr" || (e._type === "BinOp" && (e.op?._type === "Mod" || e.op?._type === "Div" || e.op?._type === "Add")) || (e._type === "Call" && e.func?._type === "Attribute" && e.func.attr === "format"));

    const visit = (n: Node, scope: Map<string, string[]>): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) visit(x, scope);
        return;
      }
      switch (n._type) {
        case "Raise":
          return; // (its messages: never files)
        case "If": {
          const q = b.qualified(n.test) ?? (n.test?._type === "Name" ? n.test.id : null);
          if (q === "typing.TYPE_CHECKING" || q === "TYPE_CHECKING") return visit(n.orelse, scope);
          break;
        }
        case "FunctionDef":
        case "AsyncFunctionDef":
        case "Lambda": {
          const inner = new Map<string, string[]>();
          collectConstants(n.body, inner);
          visit(n.decorator_list, scope);
          visit(n.args, scope);
          visit(n.body, inner);
          return;
        }
        case "Import":
          if (opts.imports) for (const a of n.names) importModule(a.name, w);
          return;
        case "ImportFrom":
          if (opts.imports) importFrom(n, unit, stars);
          return;
        case "Call": {
          const q = b.qualified(n.func);
          const fname = n.func?._type === "Name" ? n.func.id : null;
          // the notebook's magics (help-syntax.ts): `!`, %cd, %run, %load, %%bash
          if (fname === "__pyjs_magic__" || fname === "__pyjs_cell_magic__") return magic(n, fname === "__pyjs_cell_magic__");
          if (q === "os.chdir") chdir = true;
          if (MESSAGES(q)) {
            // (its own arguments are messages; a call inside one still counts)
            visit(n.args, scope);
            visit(n.keywords, scope);
            return;
          }
          if (opts.imports && (q === "importlib.import_module" || q === "builtins.__import__")) {
            const a0 = n.args[0];
            if (a0?._type === "Constant" && typeof a0.value === "string" && n.args.length === 1 && !n.keywords.length) importModule(a0.value, w);
            else unfollowed(w, n.lineno ?? 0, "a module imported by a computed or relative name");
            return;
          }
          const kind = isOpener(q) ? "opened" : "named";
          const args = [...n.args, ...n.keywords.map((k: Node) => k.value)];
          for (const a of args) {
            const vs = argValues(a, scope);
            if (vs) for (const v of vs) pathFound(v, kind, n.lineno ?? 0);
            else if (kind === "opened" && computed(a)) unfollowed(w, n.lineno ?? 0, "a file name computed when the code runs");
          }
          // a Path(...) receiver of an opener: Path("a.csv").read_text()
          if (kind === "opened" && n.func?._type === "Attribute") {
            const p = constPath(n.func.value);
            if (p !== null) pathFound(p, "opened", n.lineno ?? 0);
          }
          visit(n.func, scope);
          for (const a of args) visit(a, scope);
          return;
        }
      }
      for (const k in n) if (k !== "_type" && typeof n[k] === "object") visit(n[k], scope);
    };
    const magic = (n: Node, cell: boolean) => {
      const [k, a1, a2] = n.args.map((x: Node) => (x?._type === "Constant" ? x.value : null));
      const line = n.lineno ?? 0;
      if (typeof k !== "string") return;
      const words = (s: unknown) => (typeof s === "string" ? s.split(/[\s;|&<>()]+/).map((x) => x.replace(/^['"]|['"]$/g, "")).filter(Boolean) : []);
      if (!cell && k === "system") for (const x of words(a1)) existing(x, line);
      else if (!cell && k === "cd") chdir = true;
      else if (!cell && k === "run") {
        const f = words(a1)[0];
        const wp = f ? workspacePath(cwd, f) : null;
        if (wp && files.has(wp) && wp.endsWith(".py")) enqueue({ file: wp, module: null, isPackage: false }, w);
      } else if (!cell && k === "load") {
        const f = words(a1)[0];
        if (f) pathFound(f, "opened", line);
      } else if (cell && (k === "bash" || k === "sh" || k === "script")) for (const x of words(a2)) existing(x, line);
    };
    // a shell word naming an existing file
    const existing = (x: string, line: number) => {
      if (!x.startsWith("/") && chdir) return;
      const wp = workspacePath(cwd, x);
      if (wp !== null && files.has(wp)) dep(wp, "named", w);
      void line;
    };
    visit(tree.body ?? tree, constants);
    for (const pkg of stars) {
      const chain = resolve(pkg);
      const last = chain?.[chain.length - 1];
      if (last?.isPackage) for (const sub of await allOf(last.file)) importModule(`${pkg}.${sub}`, w);
    }
  };

  const importFrom = (n: Node, unit: Unit, stars: string[]) => {
    const w = unit.where;
    let base: string | null = n.module ?? null;
    if (n.level) {
      // relative: within the importing module's package (a cell has none)
      if (!unit.module) return unfollowed(w, n.lineno ?? 0, "a relative import outside a package");
      const pkg = unit.isPackage ? unit.module.split(".") : unit.module.split(".").slice(0, -1);
      const drop = n.level - 1;
      if (!pkg.length || drop >= pkg.length) return unfollowed(w, n.lineno ?? 0, "a relative import beyond the top package");
      base = [...pkg.slice(0, pkg.length - drop), ...(n.module ? [n.module] : [])].join(".");
    }
    if (!base) return;
    // the base first (it runs for every from-import), then submodules
    const chain = resolve(base);
    if (chain === null) return;
    for (const c of chain) enqueue(c, w);
    if (!chain[chain.length - 1].isPackage) return;
    for (const a of n.names) {
      if (a.name === "*") stars.push(base);
      else importModule(`${base}.${a.name}`, w);
    }
  };

  // names bound to constants (or containers of them) in a scope: what a later call argument can reach
  const collectConstants = (body: Node, out: Map<string, string[]>) => {
    if (!Array.isArray(body)) return;
    for (const s of body) {
      if (s?._type !== "Assign") continue;
      const vals: string[] = [];
      const take = (v: Node) => {
        if (v?._type === "Constant" && typeof v.value === "string") vals.push(v.value);
        else if (v?._type === "List" || v?._type === "Tuple" || v?._type === "Set") v.elts.forEach(take);
        else if (v?._type === "Dict") v.values.forEach(take);
      };
      take(s.value);
      if (!vals.length) continue;
      for (const t of s.targets) if (t._type === "Name") out.set(t.id, [...(out.get(t.id) ?? []), ...vals]);
    }
  };

  try {
    // ---- the cells, in page order, as one unit's bindings (a notebook's globals)
    const cellTrees: { index: number; kind: CellKind; tree: Node }[] = [];
    const nb = new Bindings();
    const nbConstants = new Map<string, string[]>();
    for (const c of input.cells) {
      if (aborted()) return { complete: false };
      if (c.kind === "markdown") {
        markdown(c.source, c.index);
        continue;
      }
      let src = c.source.replaceAll(" ", " ");
      const ipython = c.kind === "python" || c.kind === "sage";
      try {
        if (ipython) src = ipythonSyntax(src);
        if (c.kind === "sage") src = preparse(src);
        else if (c.kind === "magma") src = magmaToPython(src, "<cell>");
        else if (c.kind === "matlab") src = matlabToPython(src, "<cell>", { cell: true });
        const tree = parse(src, "exec");
        if (ipython) expandMagics(tree, codeParser(c.kind === "sage"));
        parsed++;
        nb.scan(tree);
        collectConstants(tree.body, nbConstants);
        cellTrees.push({ index: c.index, kind: c.kind, tree });
      } catch {
        complete = false;
        unfollowed({ cell: c.index }, 0, "couldn't be parsed");
      }
      progress();
    }
    for (const c of cellTrees) {
      if (aborted()) return { complete: false };
      await scan(c.tree, { where: { cell: c.index } }, nb, nbConstants, { imports: c.kind === "python" || c.kind === "sage" });
    }
    // ---- the workspace .py files they import, FIFO, each once
    while (work.length) {
      if (aborted()) return { complete: false };
      const item = work.shift()!;
      const tree = await treeOf(item.path);
      if (aborted()) return { complete: false };
      if (tree === null) {
        complete = false;
        unfollowed({ by: item.path }, 0, "couldn't be parsed");
        progress();
        continue;
      }
      parsed++;
      const b = new Bindings();
      b.scan(tree);
      const constants = new Map<string, string[]>();
      collectConstants(tree.body, constants);
      await scan(tree, { where: { by: item.path }, file: item.path, module: item.module ?? undefined, isPackage: item.isPackage }, b, constants, { imports: true });
      progress();
    }
  } catch (e) {
    if (aborted()) return { complete: false };
    throw e;
  }
  return { complete: complete && !aborted() };

  function markdown(src: string, cell: number) {
    const targets: string[] = [];
    for (const m of src.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) targets.push(m[1]);
    for (const m of src.matchAll(/<(?:img|a)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) targets.push(m[1]);
    for (const t0 of targets) {
      let t = t0.split("#")[0].split("?")[0];
      try {
        t = decodeURI(t);
      } catch {}
      const wp = workspacePath(cwd, t);
      if (wp !== null) dep(wp, "linked", { cell });
    }
  }
}
