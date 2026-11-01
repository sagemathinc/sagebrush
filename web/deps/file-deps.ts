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
//     call, or bound to a name that is a call argument; not docstrings,
//     comparisons, f-strings' parts, print/logging/warnings arguments, the
//     parts of a path expression, or anything inside a raise;
//   - imports, resolved in pyjs's own order (§2.3): native modules first,
//     then sys.path in order, each directory's name/__init__.py before
//     name.py, the first match winning (src/runtime/modules.ts importModule,
//     src/compile.ts R.loader.load), then the package registry and the
//     optional set; no namespace packages, as pyjs has none;
//   - `!`/%%bash words naming an existing file, %run (followed as a module),
//     %load; Markdown links and images.
//
// Names (#170 review, CORR-170-ASTRA-2/3): each of Python's scopes (a module,
// which for a notebook is its cells together; each function, lambda, class
// body and comprehension) has its own bindings, found wherever the scope binds
// the name (an assignment, import, def, parameter, for/with/except target...),
// in any order.  A name stands for a constant, or for an import, only when
// every one of its bindings agrees; otherwise what it names is only known
// when the code runs, and a file it might name is reported, not pre-checked.
// As in Python (#170 r2's review, CORR-170-R2-ASTRA-1..3): a nonlocal write binds in the nearest
// enclosing function that binds the name itself; a class body runs in order, so a use there sees the
// class's own bindings made before it, else the outer name (and both, where one is conditional).
// Containers (#170 r4's review): a name stands for a container's constants only if the value is immutable
// all the way down (strings in tuples, nested or not); one holding a list, dict or set anywhere, directly
// or through another name, is reported, never pre-checked, since any alias of any part of it can change
// it before the call.  A container written out in the call itself still counts.
// (Not modelled: names a star import binds, and exec/globals() tricks.)
//
// The working directory (PY-170-1/2): a relative path, or an import through
// one of sys.path's relative entries (which pyjs resolves against the working
// directory), means something else once the code has changed directory.  So
// from the first cell whose own code, or a workspace module it imports, can
// call os.chdir or %cd (found before anything is reported), every cell is
// taken as after a change of directory; so is every function body and
// generator expression, anywhere, once one can (they run when called); a
// module's top level is as of the first import of it, or throughout if it
// changes directory itself.  There, such paths and imports are reported.
//
// `complete` is false when a cell or a file couldn't be read or parsed, or
// the run was aborted: something wasn't looked at.  Reports don't change it.
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
  /** the session's sys.path, in order; a dir not starting with "/" is relative to the working directory, as in pyjs */
  importPath: { dir: string; workspace: boolean }[];
  /** native factory names (always win over sys.path) */
  builtinModules: ReadonlySet<string>;
  /** the top-level names the non-workspace sys.path entries provide, together */
  externalModules: ReadonlySet<string>;
  /** the top-level names found after sys.path: the package registry's and the optional set's */
  packageModules: ReadonlySet<string>;
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

// ---- what calls are

// The qualified names of the openers: "opened" rather than "named".
const OPENERS = new Set(["builtins.open", "io.open", "codecs.open", "numpy.load", "numpy.loadtxt", "numpy.genfromtxt", "numpy.fromfile"]);
const PATH_METHODS = new Set(["open", "read_text", "read_bytes"]);
const PATH_TYPES = new Set(["pathlib.Path", "pathlib.PurePath", "pathlib.PosixPath", "pathlib.PurePosixPath"]);
const pathMethod = (q: string | null, methods: ReadonlySet<string>) => !!q && [...PATH_TYPES].some((t) => q.startsWith(t + "().") && methods.has(q.slice(t.length + 3)));
const isPathMethod = (q: string | null) => pathMethod(q, PATH_METHODS);
const isOpener = (q: string | null) => !!q && (OPENERS.has(q) || q.startsWith("pandas.read_") || isPathMethod(q));
// (an opener's file: its first argument, or one of these keywords; a Path method's is its receiver)
const FILE_KEYWORDS = new Set(["file", "filename", "fname", "filepath", "filepath_or_buffer", "path", "path_or_buf", "io"]);
// Path builders: their arguments are a path's parts, never files of their own (CORR-170-ASTRA-1).
const isPathBuilder = (q: string | null) => q !== null && (PATH_TYPES.has(q) || q === "os.path.join" || q === "posixpath.join");
// Calls that list files: what they find is only known when the code runs.
const LISTINGS = new Set(["glob.glob", "glob.iglob", "os.listdir", "os.scandir", "os.walk"]);
const isListing = (q: string | null) => !!q && (LISTINGS.has(q) || pathMethod(q, new Set(["glob", "rglob", "iterdir"])));
// Calls whose arguments are messages, never files.
const MESSAGES = (q: string | null) => !!q && (q === "builtins.print" || q.startsWith("logging.") || q === "warnings.warn" || /(Error|Exception|Warning)$/.test(q));
const BUILTINS = new Set(["open", "print", "exec", "__import__"]);
const isBuiltinName = (id: string) => BUILTINS.has(id) || /^[A-Z]\w*(Error|Exception|Warning)$/.test(id);

// ---- scopes: what a name is bound to, where it is used

type Binding = { kind: "import"; q: string } | { kind: "value"; e: Node; s: Scope } | { kind: "other" };
const OTHER: Binding = { kind: "other" };

class Scope {
  names = new Map<string, Binding[]>();
  globals = new Set<string>();
  nonlocals = new Set<string>();
  /** a class body's bindings that are its own statements (unconditional): for each name, the indexes of
   * the body statements binding it, in order, or null when some binding of it is conditional */
  order: Map<string, number[] | null> | null = null;
  constructor(
    readonly kind: "module" | "function" | "class" | "comprehension",
    readonly parent: Scope | null,
  ) {}
  get module(): Scope {
    let s: Scope = this;
    while (s.parent) s = s.parent;
    return s;
  }
  /** Where a write of `name` here goes; null for a nonlocal one (resolved once the unit is read: finishScopes). */
  target(name: string): Scope | null {
    return this.globals.has(name) ? this.module : this.nonlocals.has(name) ? null : this;
  }
  /** The function scope a `nonlocal name` here refers to: the nearest enclosing one that binds it itself, as in Python. */
  nonlocalOwner(name: string): Scope | null {
    for (let s = this.parent; s && s.kind !== "module"; s = s.parent) if (s.kind === "function" && !s.nonlocals.has(name) && !s.globals.has(name) && s.names.has(name)) return s;
    return null;
  }
  /** The bindings a use of `name` here sees (Python's LEGB), or null: bound nowhere, a builtin. */
  lookup(name: string): Binding[] | null {
    if (this.globals.has(name)) return this.module.names.get(name) ?? null;
    if (this.nonlocals.has(name)) return this.nonlocalOwner(name)?.names.get(name) ?? null;
    const own = this.names.get(name);
    // (a class body runs in order: without knowing where in it, both its own and the outer binding may be seen)
    if (this.kind === "class") return own ? [...own, ...(this.outer(name) ?? [OTHER])] : this.outer(name);
    return own ?? this.outer(name);
  }
  /** A use of `name` in the class body's statement i (CORR-170-R2-ASTRA-2). */
  lookupAt(name: string, i: number): Binding[] | null {
    if (this.globals.has(name) || this.nonlocals.has(name)) return this.lookup(name);
    const own = this.names.get(name);
    if (!own) return this.outer(name);
    const at = this.order?.get(name);
    if (!at) return this.lookup(name); // (a conditional binding: either may be seen)
    // the class namespace has what the statements before this one bound: the last of them; else the outer name
    const before = own.filter((_, k) => at[k] < i);
    return before.length ? [before[before.length - 1]] : this.outer(name);
  }
  /** The enclosing scopes' bindings (class bodies aren't seen from inside them). */
  outer(name: string): Binding[] | null {
    for (let s = this.parent; s; s = s.parent) {
      if (s.kind === "class") continue;
      if (s.globals.has(name)) return s.module.names.get(name) ?? null;
      if (s.nonlocals.has(name)) return s.nonlocalOwner(name)?.names.get(name) ?? null;
      const b = s.names.get(name);
      if (b) return b;
    }
    return null;
  }
}

const COMPREHENSIONS = new Set(["ListComp", "SetComp", "DictComp", "GeneratorExp"]);

/** The names a class body's statement binds itself, unconditionally (its targets, imports, def or class). */
function directNames(st: Node): string[] {
  const out: string[] = [];
  const target = (t: Node) => {
    if (t?._type === "Name") out.push(t.id);
    else if (t?._type === "Tuple" || t?._type === "List") t.elts.forEach(target);
    else if (t?._type === "Starred") target(t.value);
  };
  switch (st?._type) {
    case "Assign":
      st.targets.forEach(target);
      break;
    case "AnnAssign":
      if (st.value) target(st.target);
      break;
    case "AugAssign":
      target(st.target);
      break;
    case "Import":
      for (const a of st.names) out.push(a.asname ?? a.name.split(".")[0]);
      break;
    case "ImportFrom":
      for (const a of st.names) if (a.name !== "*") out.push(a.asname ?? a.name);
      break;
    case "FunctionDef":
    case "AsyncFunctionDef":
    case "ClassDef":
      out.push(st.name);
      break;
  }
  return out;
}

/** What a unit's scopes still need once all of it is read: its nonlocal writes. */
type Pending = { nonlocal: { s: Scope; name: string; b: Binding }[] };
const newPending = (): Pending => ({ nonlocal: [] });

function finishScopes(p: Pending): void {
  // a nonlocal write binds the name where Python puts it: the nearest enclosing function that binds it itself
  // (CORR-170-R2-ASTRA-1); resolved now, when every binding of the unit is known
  for (const { s, name, b } of p.nonlocal) {
    const owner = s.nonlocalOwner(name);
    if (owner) owner.names.get(name)!.push(b);
  }
}

/** Record the bindings of a unit's statements in `mod` and the scopes nested in it (by their node); finishScopes(pending) once the unit is read. */
function buildScopes(body: Node, mod: Scope, scopes: Map<Node, Scope>, pending: Pending): void {
  const bind = (s: Scope, name: string, b: Binding) => {
    const t = s.target(name);
    if (t === null) return void pending.nonlocal.push({ s, name, b });
    const l = t.names.get(name);
    if (l) l.push(b);
    else t.names.set(name, [b]);
  };
  // global/nonlocal declarations of a scope's own body (not its nested scopes')
  const scopeDeclarations = (b: Node, s: Scope) =>
    walk(b, (n) => {
      if (n._type === "Global") n.names.forEach((x: string) => s.globals.add(x));
      else if (n._type === "Nonlocal") n.names.forEach((x: string) => s.nonlocals.add(x));
      return !(n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "ClassDef" || n._type === "Lambda" || COMPREHENSIONS.has(n._type));
    });
  const params = (a: Node, f: Scope) => {
    for (const x of [...(a?.posonlyargs ?? []), ...(a?.args ?? []), ...(a?.kwonlyargs ?? []), a?.vararg, a?.kwarg]) if (x?.arg) bind(f, x.arg, OTHER);
  };
  const go = (n: Node, s: Scope): void => {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) go(x, s);
      return;
    }
    switch (n._type) {
      case "FunctionDef":
      case "AsyncFunctionDef":
      case "Lambda": {
        if (n._type !== "Lambda") bind(s, n.name, OTHER);
        go(n.decorator_list, s);
        go(n.args?.defaults, s);
        go(n.args?.kw_defaults, s);
        const f = new Scope("function", s);
        scopes.set(n, f);
        if (n._type !== "Lambda") scopeDeclarations(n.body, f);
        params(n.args, f);
        go(n.body, f);
        return;
      }
      case "ClassDef": {
        bind(s, n.name, OTHER);
        go(n.decorator_list, s);
        go(n.bases, s);
        go(n.keywords, s);
        const c = new Scope("class", s);
        scopes.set(n, c);
        scopeDeclarations(n.body, c);
        go(n.body, c);
        // which of its bindings are its own statements, in order (the rest are conditional)
        const direct = new Map<string, number[]>();
        n.body.forEach((st: Node, i: number) => {
          for (const x of directNames(st)) direct.set(x, [...(direct.get(x) ?? []), i]);
        });
        c.order = new Map([...c.names].map(([x, bs]) => [x, direct.get(x)?.length === bs.length ? direct.get(x)! : null]));
        return;
      }
      case "ListComp":
      case "SetComp":
      case "DictComp":
      case "GeneratorExp": {
        const c = new Scope("comprehension", s);
        scopes.set(n, c);
        n.generators.forEach((g: Node, i: number) => {
          go(g.iter, i === 0 ? s : c); // (the first iterable is evaluated outside)
          go(g.target, c);
          go(g.ifs, c);
        });
        go(n.elt, c);
        go(n.key, c);
        go(n.value, c);
        return;
      }
      case "Assign":
        for (const t of n.targets) {
          if (t._type === "Name") bind(s, t.id, { kind: "value", e: n.value, s });
          else go(t, s); // (a tuple's names bind its parts: other; an attribute or subscript binds none)
        }
        go(n.value, s);
        return;
      case "AnnAssign":
        if (n.value && n.target._type === "Name") bind(s, n.target.id, { kind: "value", e: n.value, s });
        else if (n.value) go(n.target, s);
        go(n.value, s);
        return;
      case "Import":
        for (const a of n.names) bind(s, a.asname ?? a.name.split(".")[0], { kind: "import", q: a.asname ? a.name : a.name.split(".")[0] });
        return;
      case "ImportFrom":
        for (const a of n.names) if (a.name !== "*") bind(s, a.asname ?? a.name, n.module && !n.level ? { kind: "import", q: `${n.module}.${a.name}` } : OTHER);
        return;
      case "NamedExpr": {
        let t = s;
        while (t.kind === "comprehension" && t.parent) t = t.parent; // (a walrus binds outside its comprehension)
        if (n.target?._type === "Name") bind(t, n.target.id, OTHER);
        go(n.value, s);
        return;
      }
      case "ExceptHandler":
        if (typeof n.name === "string") bind(s, n.name, OTHER);
        go(n.type, s);
        go(n.body, s);
        return;
      case "MatchAs":
      case "MatchStar":
        if (typeof n.name === "string") bind(s, n.name, OTHER);
        go(n.pattern, s);
        return;
      case "MatchMapping":
        if (typeof n.rest === "string") bind(s, n.rest, OTHER);
        go(n.keys, s);
        go(n.patterns, s);
        return;
      case "Name":
        if (n.ctx?._type === "Store" || n.ctx?._type === "Del") bind(s, n.id, OTHER);
        return;
    }
    for (const k in n) if (k !== "_type" && typeof n[k] === "object") go(n[k], s);
  };
  scopeDeclarations(body, mod);
  go(body, mod);
}

/** The qualified name an expression stands for in scope s (os.path.join, pathlib.Path().read_text), or null. */
function qualified(e: Node, s: Scope, seen = new Set<Node>()): string | null {
  if (!e || seen.has(e)) return null;
  if (e._type === "Name") {
    const bs = s.lookup(e.id);
    if (bs === null) return isBuiltinName(e.id) ? `builtins.${e.id}` : null;
    seen.add(e);
    // every binding must agree: an import, or an alias of one (j = os.path.join)
    const qs = bs.map((b) => (b.kind === "import" ? b.q : b.kind === "value" ? qualified(b.e, b.s, seen) : null));
    return qs.every((q) => q !== null && q === qs[0]) ? qs[0] : null;
  }
  if (e._type === "Attribute") {
    const b = qualified(e.value, s, seen);
    return b === null ? null : `${b}.${e.attr}`;
  }
  if (e._type === "Call") {
    const f = qualified(e.func, s, seen);
    return f !== null && PATH_TYPES.has(f) ? `${f}()` : null;
  }
  return null;
}

// What an expression names: constant paths, or (a name bound more than once,
// to different things) the candidates, or null: only known when it runs.
type Val = { values: string[] } | { candidates: string[]; why: string } | null;

function constValues(e: Node, s: Scope, seen = new Set<Node>()): Val {
  if (!e) return null;
  switch (e._type) {
    case "Constant":
      return typeof e.value === "string" ? { values: [e.value] } : null;
    case "BinOp": {
      if (e.op?._type !== "Div" || !isPathish(e.left, s)) return null;
      const l = single(constValues(e.left, s, seen)), r = single(constValues(e.right, s, seen));
      return l !== null && r !== null ? { values: [r.startsWith("/") ? r : `${l.replace(/\/+$/, "")}/${r}`] } : null;
    }
    case "Call": {
      if (!isPathBuilder(qualified(e.func, s)) || !e.args.length || e.keywords.length) return null;
      const parts = e.args.map((a: Node) => single(constValues(a, s, seen)));
      if (parts.some((x: string | null) => x === null)) return null;
      return { values: [parts.reduce((a: string, x: string) => (x.startsWith("/") ? x : a ? `${a.replace(/\/+$/, "")}/${x}` : x), "")] };
    }
    case "List":
    case "Tuple":
    case "Set":
    case "Dict": {
      // (written out in the call itself, its constants are what the call gets; but a part that is itself
      // uncertain makes the whole uncertain)
      const out: string[] = [], doubt: string[] = [];
      let why = "";
      for (const x of e._type === "Dict" ? e.values : e.elts) {
        const v = constValues(x, s, seen);
        if (v && "values" in v) out.push(...v.values);
        else if (v) (doubt.push(...v.candidates), (why = v.why));
      }
      if (doubt.length) return { candidates: [...new Set([...out, ...doubt])], why };
      return out.length ? { values: out } : null;
    }
    case "Name": {
      if (e.ctx?._type !== "Load" || seen.has(e)) return null;
      const bs = s.lookup(e.id);
      if (!bs) return null;
      seen.add(e);
      const vs = bs.map((b) => (b.kind === "value" ? constValues(b.e, b.s, seen) : null));
      seen.delete(e);
      const candidates = () => [...new Set(vs.flatMap((v) => (v === null ? [] : "values" in v ? v.values : v.candidates)))];
      // a name stands for a container's constants only if it is immutable all the way down (CORR-170-R4-ASTRA-1)
      if (bs.some((b) => b.kind === "value" && holdsMutable(b.e, b.s))) {
        const c = candidates();
        return c.length ? { candidates: c, why: "holds a list, dict or set, whose contents may change before it is used" } : null;
      }
      const known = vs.filter((v): v is { values: string[] } => !!v && "values" in v);
      if (known.length === vs.length && known.every((v) => JSON.stringify(v.values) === JSON.stringify(known[0].values))) return known[0];
      const c = candidates();
      return c.length ? { candidates: c, why: vs.length > 1 ? "is bound more than once" : "may not hold what it was bound to" } : null;
    }
  }
  return null;
}
/**
 * Whether a value holds a list, dict or set anywhere in it (directly, inside a tuple, or through a name).
 * Its contents can change in place, through any alias of any part of it, before a call gets it; rather
 * than follow every such change, a name bound to one stands for no constants (#170 r4's review).
 */
function holdsMutable(e: Node, s: Scope, seen = new Set<Node>()): boolean {
  if (!e || seen.has(e)) return false;
  switch (e._type) {
    case "List":
    case "Dict":
    case "Set":
    case "ListComp":
    case "DictComp":
    case "SetComp":
      return true;
    case "Tuple":
      return e.elts.some((x: Node) => holdsMutable(x, s, seen));
    case "Starred":
      return holdsMutable(e.value, s, seen);
    case "Name": {
      seen.add(e);
      return (s.lookup(e.id) ?? []).some((b) => b.kind === "value" && holdsMutable(b.e, b.s, seen));
    }
  }
  return false;
}
const single = (v: Val): string | null => (v && "values" in v && v.values.length === 1 ? v.values[0] : null);
const isPathish = (e: Node, s: Scope): boolean => (e?._type === "Call" && isPathBuilder(qualified(e.func, s))) || (e?._type === "BinOp" && isPathish(e.left, s));

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

/** Whether code can change the working directory: any call of a chdir, or %cd (by spelling: this errs towards yes). */
function changesDirectory(tree: Node): boolean {
  let yes = false;
  walk(tree, (n) => {
    if (yes) return false;
    if (n._type === "Call") {
      const f = n.func;
      const name = f?._type === "Name" ? f.id : f?._type === "Attribute" ? f.attr : null;
      if (name === "chdir" || name === "fchdir") yes = true;
      if (name === "__pyjs_magic__" && n.args[0]?._type === "Constant" && n.args[0].value === "cd") yes = true;
    }
    return true;
  });
  return yes;
}

/** The names a package's __init__ binds at its top level, but for the submodules it imports itself. */
function initDefines(tree: Node, pkg: string): Set<string> {
  const out = new Set<string>();
  walk(tree?.body, (n) => {
    switch (n._type) {
      case "FunctionDef":
      case "AsyncFunctionDef":
      case "ClassDef":
        out.add(n.name);
        return false;
      case "Lambda":
        return false;
      case "Import":
        for (const a of n.names) out.add(a.asname ?? a.name.split(".")[0]);
        return false;
      case "ImportFrom":
        // (from . import x, or from pkg import x, is the submodule itself)
        if (!((n.level === 1 && !n.module) || (!n.level && n.module === pkg))) for (const a of n.names) if (a.name !== "*") out.add(a.asname ?? a.name);
        return false;
      case "ExceptHandler":
        if (typeof n.name === "string") out.add(n.name);
        return true;
      case "Name":
        if (n.ctx?._type === "Store" || n.ctx?._type === "Del") out.add(n.id);
        return false;
    }
    return !COMPREHENSIONS.has(n._type);
  });
  return out;
}

/** The constant __all__ of a package's __init__ (for `from a import *`). */
function allOf(tree: Node): string[] {
  const out: string[] = [];
  for (const s of tree?.body ?? []) {
    if (s._type === "Assign" && s.targets.length === 1 && s.targets[0]._type === "Name" && s.targets[0].id === "__all__" && (s.value._type === "List" || s.value._type === "Tuple")) {
      for (const e of s.value.elts) if (e._type === "Constant" && typeof e.value === "string") out.push(e.value);
    }
  }
  return out;
}

const shellWords = (s: unknown) => (typeof s === "string" ? s.split(/[\s;|&<>()]+/).map((x) => x.replace(/^['"]|['"]$/g, "")).filter(Boolean) : []);

// ---- the analysis

interface Unit {
  where: Where;
  /** a workspace .py's own path (for relative imports and reasons), or undefined for a cell */
  file?: string;
  /** the module's dotted name, for relative imports (a cell or a %run file has none) */
  module?: string;
  isPackage?: boolean;
}
type Found = { file: string; module: string | null; isPackage: boolean };

export async function fileDeps(input: FileDepsInput): Promise<{ complete: boolean }> {
  const { files, cwd, signal } = input;
  let complete = true;
  const seen = new Set<string>(); // paths reported
  const queued = new Set<string>(); // .py files queued or scanned
  const work: (Found & { by: Where; moved: boolean })[] = [];
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

  // (a name that, once the directory changed, could still be one of the workspace's files: any file whose path ends with it)
  let tails: Set<string> | null = null;
  const couldBeFile = (p: string) => {
    if (p.startsWith("/")) return files.has(p);
    if (!tails) {
      tails = new Set();
      for (const f of files.keys()) {
        const parts = f.split("/").filter(Boolean);
        for (let i = 0; i < parts.length; i++) tails.add(parts.slice(i).join("/"));
      }
    }
    const q = p.replace(/^(\.\/)+/, "");
    return q.split("/").includes("..") || tails.has(q);
  };

  // ---- imports
  const look = (dir: string, name: string): { file: string; isPackage: boolean } | null => {
    const pkg = joinDir(dir, name, "__init__.py"), m = joinDir(dir, name + ".py");
    return files.has(pkg) ? { file: pkg, isPackage: true } : files.has(m) ? { file: m, isPackage: false } : null;
  };
  const entryDir = (dir: string) => (dir.startsWith("/") ? dir : workspacePath(cwd, dir || "."));
  const outside = input.importPath.filter((e) => !e.workspace).length;
  // A module's workspace files, in pyjs's order: native first (never a file),
  // then sys.path, then the registry and the optional set (never a file).
  // The chain is a.__init__, a.b.__init__, ..., the module, as far as it is
  // found; `why` says what wasn't followed (moved: after a change of directory).
  const resolve = (name: string, moved: boolean): { chain: Found[]; why?: string } => {
    const parts = name.split(".");
    const chain: Found[] = [];
    if (input.builtinModules.has(parts[0])) return { chain };
    let found: { file: string; isPackage: boolean } | null = null;
    const path = input.importPath;
    for (let k = 0; k < path.length && !found; k++) {
      const e = path[k];
      if (!e.workspace) {
        if (!input.externalModules.has(parts[0])) continue;
        if (outside > 1) {
          // (externalModules can't say which of several entries has it: a workspace file after this one may be what loads)
          for (const x of path.slice(k + 1)) {
            const d = x.workspace && !(moved && !x.dir.startsWith("/")) ? entryDir(x.dir) : null;
            const f = d !== null ? look(d, parts[0]) : null;
            if (f) return { chain, why: `${name}: ${f.file} or a ${parts[0]} outside the workspace, ahead of it on sys.path; which one loads can't be told` };
          }
        }
        return { chain }; // (the session's own, not the workspace's)
      }
      if (moved && !e.dir.startsWith("/")) return { chain, why: `import ${name} after a change of directory (sys.path's ${JSON.stringify(e.dir)} follows it)` };
      const d = entryDir(e.dir);
      if (d !== null) found = look(d, parts[0]);
    }
    if (!found) return input.packageModules.has(parts[0]) ? { chain } : { chain, why: `no module ${parts[0]} in the workspace or the session` };
    chain.push({ ...found, module: parts[0] });
    for (let i = 1; i < parts.length; i++) {
      const mod = parts.slice(0, i + 1).join(".");
      if (input.builtinModules.has(mod)) return { chain };
      const last = chain[chain.length - 1];
      if (!last.isPackage) return { chain, why: `no module ${mod}: ${last.file} is a module, not a package` };
      const f = look(dirOf(last.file), parts[i]);
      if (!f) return { chain, why: `no module ${mod} (no ${parts[i]}.py or ${parts[i]}/__init__.py in ${dirOf(last.file)})` };
      chain.push({ ...f, module: mod });
    }
    return { chain };
  };
  // (every workspace file an import could load, whatever the order: for finding a change of directory first)
  const candidates = (name: string): Found[] => {
    const parts = name.split(".");
    const out: Found[] = [];
    if (input.builtinModules.has(parts[0])) return out;
    for (const e of input.importPath) {
      const d = e.workspace ? entryDir(e.dir) : null;
      if (d === null) continue;
      let dir = d;
      for (let i = 0; i < parts.length; i++) {
        const mod = parts.slice(0, i + 1).join(".");
        if (i > 0 && input.builtinModules.has(mod)) break;
        const f = look(dir, parts[i]);
        if (!f) break;
        out.push({ ...f, module: mod });
        if (!f.isPackage) break;
        dir = dirOf(f.file);
      }
    }
    return out;
  };
  // A relative import's package: its directory and dotted name, or why there is none.
  const relativeBase = (unit: Unit, level: number): { dir: string; module: string } | string => {
    if (!unit.module || !unit.file) return "a relative import outside a package";
    const pkg = unit.isPackage ? unit.module.split(".") : unit.module.split(".").slice(0, -1);
    const drop = level - 1;
    if (!pkg.length || drop >= pkg.length) return "a relative import beyond the top package";
    let dir = dirOf(unit.file);
    for (let i = 0; i < drop; i++) dir = dirOf(dir);
    return { dir, module: pkg.slice(0, pkg.length - drop).join(".") };
  };
  const enqueue = (c: Found, w: Where, moved: boolean) => {
    dep(c.file, "imported", w);
    if (queued.has(c.file)) return;
    queued.add(c.file);
    work.push({ ...c, by: w, moved });
  };
  const importModule = (name: string, w: Where, moved: boolean, line: number) => {
    const r = resolve(name, moved);
    for (const c of r.chain) enqueue(c, w, moved);
    if (r.why) unfollowed(w, line, r.why);
  };

  const treeOf = async (path: string): Promise<Node | null> => {
    if (trees.has(path)) return trees.get(path)!;
    let t: Node | null = null;
    try {
      t = parse(await input.readFile(path), "exec");
      parsed++;
    } catch {
      t = null;
    }
    trees.set(path, t);
    return t;
  };

  // The workspace files a unit's code could import, by any route (the first pass).
  const discover = async (tree: Node, unit: Unit): Promise<Found[]> => {
    const out: Found[] = [];
    const subs: { pkg: Found; names: string[] | "*" }[] = [];
    walk(tree, (n) => {
      if (n._type === "Import") for (const a of n.names) out.push(...candidates(a.name));
      else if (n._type === "ImportFrom") {
        let bases: Found[] = [];
        if (n.level) {
          const rb = relativeBase(unit, n.level);
          if (typeof rb !== "string") {
            let last: Found | null = { file: joinDir(rb.dir, "__init__.py"), module: rb.module, isPackage: true };
            for (const part of n.module ? n.module.split(".") : []) {
              const f: { file: string; isPackage: boolean } | null = last?.isPackage ? look(dirOf(last.file), part) : null;
              last = f ? { ...f, module: `${last!.module}.${part}` } : null;
              if (last) out.push(last);
            }
            if (last) bases = [last];
          }
        } else if (n.module) {
          const c = candidates(n.module);
          out.push(...c);
          bases = c.filter((x) => x.module === n.module);
        }
        for (const b of bases) if (b.isPackage) subs.push({ pkg: b, names: n.names.some((a: Node) => a.name === "*") ? "*" : n.names.map((a: Node) => a.name) });
      } else if (n._type === "Call") {
        const f = n.func;
        const name = f?._type === "Name" ? f.id : f?._type === "Attribute" ? f.attr : null;
        const a0 = n.args[0]?._type === "Constant" ? n.args[0].value : null;
        if ((name === "import_module" || name === "__import__") && typeof a0 === "string") out.push(...candidates(a0));
        if (name === "__pyjs_magic__" && a0 === "run") {
          const w = shellWords(n.args[1]?.value)[0];
          const wp = w ? workspacePath(cwd, w) : null;
          if (wp && files.has(wp) && wp.endsWith(".py")) out.push({ file: wp, module: null, isPackage: false });
        }
      }
      return true;
    });
    for (const { pkg, names } of subs) {
      const list = names === "*" ? allOf(await treeOf(pkg.file)) : names;
      for (const x of list) {
        const f = look(dirOf(pkg.file), x);
        if (f) out.push({ ...f, module: `${pkg.module}.${x}` });
      }
    }
    return out;
  };

  // ---- one unit's tree: its imports, call arguments, magics
  const scan = async (tree: Node, unit: Unit, mod: Scope, scopes: Map<Node, Scope>, opts: { imports: boolean; moved: boolean; anyMove: boolean }) => {
    const w = unit.where;
    // from-imports' names, once the package's __init__ is read: done after the walk, in order
    const pending: { pkg: Found; names: string[] | "*"; moved: boolean; line: number }[] = [];
    type Ctx = { s: Scope; fn: boolean };
    // (the code here may run after a change of directory: a function body whenever it is called)
    const moved = (c: Ctx) => (c.fn ? opts.anyMove : opts.moved);
    const pathFound = (p: string, kind: "opened" | "named", line: number, mv: boolean) => {
      if (!p.startsWith("/") && mv) {
        if (kind === "opened" || couldBeFile(p)) unfollowed(w, line, `"${p}" after a change of directory`);
        return;
      }
      const wp = workspacePath(cwd, p);
      if (wp !== null) dep(wp, kind, w);
    };
    // a call's argument: what it names, if that can be known; `file`: it must be a file (an opener's)
    const useArg = (e: Node, c: Ctx, kind: "opened" | "named", line: number, file: boolean) => {
      const v = constValues(e, c.s);
      if (v && "values" in v) for (const p of v.values) pathFound(p, kind, line, moved(c));
      else if (v && v.candidates.some((p) => (p.startsWith("/") ? files.has(p) : couldBeFile(p)))) {
        unfollowed(w, line, `${e._type === "Name" ? e.id : "a name"} ${v.why} (${v.candidates.map((p) => JSON.stringify(p)).join(", ")}): which file it names is only known when the code runs`);
      } else if (file) unfollowed(w, line, "a file name computed when the code runs");
    };
    // visit an argument for the calls inside it, but never a recognized path's own parts (CORR-170-ASTRA-1)
    const visitArg = (e: Node, c: Ctx) => {
      const v = constValues(e, c.s);
      if (!(v && "values" in v)) visit(e, c);
    };

    const visit = (n: Node, c: Ctx): void => {
      if (n === null || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (const x of n) visit(x, c);
        return;
      }
      const line = n.lineno ?? 0;
      switch (n._type) {
        case "Raise":
          return; // (its messages: never files)
        case "If": {
          const q = qualified(n.test, c.s) ?? (n.test?._type === "Name" ? n.test.id : null);
          if (q === "typing.TYPE_CHECKING" || q === "TYPE_CHECKING") return visit(n.orelse, c);
          break;
        }
        case "FunctionDef":
        case "AsyncFunctionDef":
        case "Lambda":
          visit(n.decorator_list, c);
          visit(n.args?.defaults, c);
          visit(n.args?.kw_defaults, c);
          visit(n.body, { s: scopes.get(n) ?? c.s, fn: true });
          return;
        case "ClassDef":
          visit(n.decorator_list, c);
          visit(n.bases, c);
          visit(n.keywords, c);
          {
            // (each statement of the body sees the class's bindings made before it: Scope.lookupAt)
            const cs = scopes.get(n) ?? c.s;
            n.body.forEach((st: Node, i: number) => {
              const at: Scope = Object.create(cs);
              at.lookup = (name: string) => cs.lookupAt(name, i);
              visit(st, { s: at, fn: c.fn });
            });
          }
          return;
        case "ListComp":
        case "SetComp":
        case "DictComp":
        case "GeneratorExp": {
          // (a generator expression runs when it is iterated: like a function body)
          const inner = { s: scopes.get(n) ?? c.s, fn: c.fn || n._type === "GeneratorExp" };
          n.generators.forEach((g: Node, i: number) => {
            visit(g.iter, i === 0 ? c : inner);
            visit(g.ifs, inner);
          });
          visit(n.elt, inner);
          visit(n.key, inner);
          visit(n.value, inner);
          return;
        }
        case "Import":
          if (opts.imports) for (const a of n.names) importModule(a.name, w, moved(c), line);
          return;
        case "ImportFrom":
          if (opts.imports) importFrom(n, moved(c));
          return;
        case "Call": {
          const q = qualified(n.func, c.s);
          const fname = n.func?._type === "Name" ? n.func.id : null;
          // the notebook's magics (help-syntax.ts): `!`, %cd, %run, %load, %%bash
          if (fname === "__pyjs_magic__" || fname === "__pyjs_cell_magic__") return magic(n, fname === "__pyjs_cell_magic__", moved(c));
          const args: Node[] = [...n.args, ...n.keywords.map((k: Node) => k.value)];
          // a path's parts, a directory to change to, messages: never files of their own (N-170-2)
          if (isPathBuilder(q) || q === "os.chdir" || q === "os.fchdir" || MESSAGES(q)) {
            for (const a of args) visitArg(a, c);
            return;
          }
          if (opts.imports && (q === "importlib.import_module" || q === "builtins.__import__")) {
            const a0 = n.args[0];
            if (a0?._type === "Constant" && typeof a0.value === "string" && n.args.length === 1 && !n.keywords.length) importModule(a0.value, w, moved(c), line);
            else unfollowed(w, line, "a module imported by a computed or relative name");
            return;
          }
          if (isListing(q)) {
            const a0 = n.args[0];
            unfollowed(w, line, `files listed when the code runs (${q!.replace(/^pathlib\.\w+\(\)/, "Path()")}${a0?._type === "Constant" && typeof a0.value === "string" ? `(${JSON.stringify(a0.value)})` : ""}): not pre-checked`);
            visit(n.func, c);
            for (const a of args) visitArg(a, c);
            return;
          }
          let file: Node | null = null;
          if (isOpener(q)) {
            if (isPathMethod(q)) file = n.func.value;
            else file = n.args[0] && n.args[0]._type !== "Starred" ? n.args[0] : (n.keywords.find((k: Node) => k.arg && FILE_KEYWORDS.has(k.arg))?.value ?? null);
            if (file) useArg(file, c, "opened", line, true);
            else if (args.length) unfollowed(w, line, "a file name computed when the code runs");
          }
          for (const a of args) if (a !== file && a?._type !== "Starred") useArg(a, c, "named", line, false);
          visit(n.func, c);
          for (const a of args) visitArg(a, c);
          return;
        }
      }
      for (const k in n) if (k !== "_type" && typeof n[k] === "object") visit(n[k], c);
    };
    const magic = (n: Node, cell: boolean, mv: boolean) => {
      const [k, a1, a2] = n.args.map((x: Node) => (x?._type === "Constant" ? x.value : null));
      const line = n.lineno ?? 0;
      if (typeof k !== "string") return;
      if (!cell && k === "system") for (const x of shellWords(a1)) existing(x, line, mv);
      else if (!cell && k === "run") {
        const f = shellWords(a1)[0];
        if (!f) return;
        if (!f.startsWith("/") && mv) return unfollowed(w, line, `%run ${f} after a change of directory`);
        const wp = workspacePath(cwd, f);
        if (wp && files.has(wp) && wp.endsWith(".py")) enqueue({ file: wp, module: null, isPackage: false }, w, mv);
      } else if (!cell && k === "load") {
        const f = shellWords(a1)[0];
        if (f) pathFound(f, "opened", line, mv);
      } else if (cell && (k === "bash" || k === "sh" || k === "script")) for (const x of shellWords(a2)) existing(x, line, mv);
      // (%cd: found before the scan, changesDirectory)
    };
    // a shell word naming an existing file
    const existing = (x: string, line: number, mv: boolean) => {
      if (!x.startsWith("/") && mv) {
        if (couldBeFile(x)) unfollowed(w, line, `"${x}" after a change of directory`);
        return;
      }
      const wp = workspacePath(cwd, x);
      if (wp !== null && files.has(wp)) dep(wp, "named", w);
    };
    const importFrom = (n: Node, mv: boolean) => {
      const line = n.lineno ?? 0;
      let pkg: Found;
      if (n.level) {
        // relative: within the importing module's package (a cell has none), whatever the working directory
        const rb = relativeBase(unit, n.level);
        if (typeof rb === "string") return unfollowed(w, line, rb);
        pkg = { file: joinDir(rb.dir, "__init__.py"), module: rb.module, isPackage: true };
        for (const part of n.module ? n.module.split(".") : []) {
          const f = pkg.isPackage ? look(dirOf(pkg.file), part) : null;
          if (!f) return unfollowed(w, line, `no module ${pkg.module}.${part}`);
          pkg = { ...f, module: `${pkg.module}.${part}` };
          enqueue(pkg, w, mv);
        }
      } else {
        if (!n.module) return;
        // the base first (it runs for every from-import), then submodules
        const r = resolve(n.module, mv);
        for (const c of r.chain) enqueue(c, w, mv);
        if (r.why) return unfollowed(w, line, r.why);
        if (r.chain.length !== n.module.split(".").length) return; // (native, or the session's)
        pkg = r.chain[r.chain.length - 1];
      }
      if (pkg.isPackage) pending.push({ pkg, names: n.names.some((a: Node) => a.name === "*") ? "*" : n.names.map((a: Node) => a.name), moved: mv, line });
    };

    visit(tree.body ?? tree, { s: mod, fn: false });
    for (const p of pending) {
      // a name the package's __init__ binds is that, and pyjs then imports no submodule of that name (N-170-1);
      // a star import follows the constant __all__ only (pyjs's fromlist, as CPython's)
      const init = await treeOf(p.pkg.file);
      const names = p.names === "*" ? allOf(init) : p.names;
      const defined = init ? initDefines(init, p.pkg.module!) : new Set<string>();
      for (const x of names) {
        const f = look(dirOf(p.pkg.file), x);
        if (!f) continue; // (an attribute of the package)
        if (defined.has(x)) unfollowed(w, p.line, `${p.pkg.module}.${x}: ${p.pkg.file} defines ${x}, so ${f.file} may never be imported`);
        else enqueue({ ...f, module: `${p.pkg.module}.${x}` }, w, p.moved);
      }
    }
  };

  try {
    // ---- the cells, in page order, as one module (a notebook's globals)
    const cellTrees: { index: number; kind: CellKind; tree: Node }[] = [];
    const nb = new Scope("module", null);
    const nbScopes = new Map<Node, Scope>();
    const nbPending = newPending();
    for (const c of input.cells) {
      if (aborted()) return { complete: false };
      if (c.kind === "markdown") {
        markdown(c.source, c.index);
        continue;
      }
      let src = c.source.replaceAll(" ", " ");
      const ipython = c.kind === "python" || c.kind === "sage";
      try {
        if (ipython) src = ipythonSyntax(src);
        if (c.kind === "sage") src = preparse(src);
        else if (c.kind === "magma") src = magmaToPython(src, "<cell>");
        else if (c.kind === "matlab") src = matlabToPython(src, "<cell>", { cell: true });
        const tree = parse(src, "exec");
        if (ipython) expandMagics(tree, codeParser(c.kind === "sage"));
        parsed++;
        buildScopes(tree.body, nb, nbScopes, nbPending);
        cellTrees.push({ index: c.index, kind: c.kind, tree });
      } catch {
        complete = false;
        unfollowed({ cell: c.index }, 0, "couldn't be parsed");
      }
      progress();
    }
    finishScopes(nbPending);
    const imports = (k: CellKind) => k === "python" || k === "sage";

    // ---- first: the first cell from which the directory may have changed
    // (its code, or a workspace module it could import, can change it)
    let firstMove: number | null = null;
    const looked = new Set<string>();
    find: for (let i = 0; i < cellTrees.length; i++) {
      const c = cellTrees[i];
      if (changesDirectory(c.tree)) {
        firstMove = i;
        break;
      }
      if (!imports(c.kind)) continue;
      const q = await discover(c.tree, { where: { cell: c.index } });
      while (q.length) {
        if (aborted()) return { complete: false };
        const f = q.shift()!;
        if (looked.has(f.file)) continue;
        looked.add(f.file);
        const t = await treeOf(f.file);
        progress();
        if (t === null) continue;
        if (changesDirectory(t)) {
          firstMove = i;
          break find;
        }
        q.push(...(await discover(t, { where: { by: f.file }, file: f.file, module: f.module ?? undefined, isPackage: f.isPackage })));
      }
    }
    const anyMove = firstMove !== null;

    // ---- then each cell, and the workspace .py files it imports (FIFO, each once), in page order
    for (let i = 0; i < cellTrees.length; i++) {
      const c = cellTrees[i];
      if (aborted()) return { complete: false };
      await scan(c.tree, { where: { cell: c.index } }, nb, nbScopes, { imports: imports(c.kind), moved: anyMove && i >= firstMove!, anyMove });
      while (work.length) {
        if (aborted()) return { complete: false };
        const item = work.shift()!;
        const tree = await treeOf(item.file);
        if (aborted()) return { complete: false };
        if (tree === null) {
          complete = false;
          unfollowed({ by: item.file }, 0, "couldn't be parsed");
          progress();
          continue;
        }
        const mod = new Scope("module", null);
        const scopes = new Map<Node, Scope>();
        const pend = newPending();
        buildScopes(tree.body, mod, scopes, pend);
        finishScopes(pend);
        // (its top level runs at its first import; throughout, if it changes directory itself)
        await scan(tree, { where: { by: item.file }, file: item.file, module: item.module ?? undefined, isPackage: item.isPackage }, mod, scopes, { imports: true, moved: item.moved || changesDirectory(tree), anyMove: anyMove || changesDirectory(tree) });
        progress();
      }
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
