// Renaming a global name in notebook cells, for the reactive notebook's fix of
// "x is defined by several cells" (design/reactive-notebook.md, Compatibility):
// a notebook written for Jupyter's top-to-bottom order (`x = 1` ... `x = x +
// 1` ... `print(x)`) becomes one with the same meaning in which each name has
// one defining cell (`x = 1` ... `x_2 = x + 1` ... `print(x_2)`), as `marimo
// convert` does.
//
// Occurrences are found in CPython's AST (pyparse), with Python's scoping:
// a name bound in a function (and not declared global) is the function's, as
// are comprehension variables and parameters; attributes and keyword
// arguments are not names.  Sage cells are analyzed after preparsing and
// mapped back by the order of the name's occurrences on each line (refused if
// they do not correspond); Magma cells are not renamed.
import { parse } from "../pyparse/src/index";
import { preparse } from "./sagepre";

type Mode = "python" | "sage" | "magma";

interface Occurrence {
  line: number; // 1-based
  col: number; // UTF-8 byte offset (CPython's), in the analyzed source
  end: number;
  store: boolean;
  stmt: number; // the top-level statement it is in
  // its ancestors in that statement, each with the field it is under
  path: [any, string][];
  // `import x` / `from m import x` (the name is the module's or the
  // module's attribute): renamed by adding `as`; null: cannot be (`import x.y`)
  alias?: string | null;
  // `global x` in a function: the same name as that function's assignments
  global?: true;
  // in a class body, a load that may read the class's attribute or the
  // global, depending on the run: it can only keep its name
  maybe?: true;
  // the name of a def or class: the statement (what it evaluates before
  // binding the name reads the previous value)
  def?: any;
}

const BINDING_TYPES = new Set(["FunctionDef", "AsyncFunctionDef", "ClassDef"]);
// whether the name, where the walk is, is a local (true), the global (false),
// or, in a class body before the class binds it: the global for loads, an
// attribute for stores ("store"), or either for loads, depending on the run
// ("maybe")
type Shadow = boolean | "store" | "maybe";
// the scopes a class body's names are not visible in
const SCOPES = new Set(["FunctionDef", "AsyncFunctionDef", "ClassDef", "Lambda", "ListComp", "SetComp", "DictComp", "GeneratorExp"]);
// CPython's columns are UTF-8 byte offsets
const enc = new TextEncoder(), dec = new TextDecoder();
const bytesLen = (s: string) => enc.encode(s).length;
const byteSlice = (s: string, a: number, b?: number) => dec.decode(enc.encode(s).subarray(a, b));

// The names `:=` binds in a comprehension (in the scope around it).
function walrusTargets(n: any): string[] {
  const out: string[] = [];
  const scan = (m: any): void => {
    if (!m || typeof m !== "object") return;
    if (Array.isArray(m)) return m.forEach(scan);
    if (m._type === "NamedExpr" && m.target?._type === "Name") out.push(m.target.id);
    if (m._type === "Lambda" || m._type === "FunctionDef" || m._type === "AsyncFunctionDef" || m._type === "ClassDef") return;
    for (const k of Object.keys(m)) if (k !== "_type") scan(m[k]);
  };
  scan(n);
  return out;
}

// Whether evaluating expression (or simple statement) `n` binds `name` by
// `:=` here: "no", "yes", or "maybe" (under `and`/`or` after the first
// operand, a conditional expression's branches, a comprehension's body, a
// chained comparison's later operands, an assert's message).
function walrusBinds(n: any, name: string): "no" | "yes" | "maybe" {
  let res: "no" | "yes" | "maybe" = "no";
  const scan = (m: any, cond: boolean): void => {
    if (!m || typeof m !== "object") return;
    if (Array.isArray(m)) return m.forEach((x) => scan(x, cond));
    switch (m._type) {
      case "NamedExpr":
        if (m.target?._type === "Name" && m.target.id === name) res = cond || res === "maybe" ? "maybe" : "yes";
        scan(m.value, cond);
        return;
      case "BoolOp": m.values.forEach((v: any, i: number) => scan(v, cond || i > 0)); return;
      case "IfExp": scan(m.test, cond); scan([m.body, m.orelse], true); return;
      // (`a < b < c` evaluates c only if a < b; an assert's message only if it fails)
      case "Compare": scan([m.left, m.comparators[0]], cond); scan(m.comparators.slice(1), true); return;
      case "Assert": scan(m.test, cond); scan(m.msg, true); return;
      case "ListComp": case "SetComp": case "DictComp": case "GeneratorExp": scan(m.generators?.[0]?.iter, cond); scan([m.elt, m.key, m.value, m.generators?.map((g: any) => [g.ifs, g.iter])], true); return;
      case "FunctionDef": case "AsyncFunctionDef": scan([m.decorator_list, m.args?.defaults, m.args?.kw_defaults], cond); return;
      case "ClassDef": scan([m.decorator_list, m.bases, m.keywords], cond); return;
      case "Lambda": scan([m.args?.defaults, m.args?.kw_defaults], cond); return;
    }
    for (const k of Object.keys(m)) if (k !== "_type") scan(m[k], cond);
  };
  scan(n, false);
  return res;
}

/** The occurrences of global `name` in a module's AST. */
function occurrences(tree: any, name: string, lines: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  // the names a function (or lambda, comprehension) body binds, minus its
  // `global`s (with `walrus` false: not counting `:=`)
  const localsOf = (body: any[], params: string[], walrus = true): Set<string> => {
    const bound = new Set(params), glob = new Set<string>();
    const scan = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(scan);
      switch (n._type) {
        case "Global": case "Nonlocal": for (const g of n.names) glob.add(g); return;
        case "Name": if (n.ctx?._type !== "Load") bound.add(n.id); return;
        case "NamedExpr": if (walrus) scan(n.target); scan(n.value); return;
        // (a def's decorators, defaults, a class's bases are evaluated here)
        case "FunctionDef": case "AsyncFunctionDef": bound.add(n.name); scan([n.decorator_list, n.args?.defaults, n.args?.kw_defaults]); return;
        case "ClassDef": bound.add(n.name); scan([n.decorator_list, n.bases, n.keywords]); return;
        case "Lambda": scan([n.args?.defaults, n.args?.kw_defaults]); return;
        // (a comprehension's own scope, but its `:=` binds here)
        case "ListComp": case "SetComp": case "DictComp": case "GeneratorExp": if (walrus) for (const t of walrusTargets(n)) bound.add(t); return;
        case "alias": bound.add((n.asname ?? n.name).split(".")[0]); return;
        case "ExceptHandler": if (n.name) bound.add(n.name); break;
        case "MatchAs": case "MatchStar": if (n.name) bound.add(n.name); break;
        case "MatchMapping": if (n.rest) bound.add(n.rest); break;
      }
      for (const k of Object.keys(n)) if (k !== "_type") scan(n[k]);
    };
    scan(body);
    for (const g of glob) bound.delete(g);
    return bound;
  };
  const params = (args: any): string[] => args ? [...args.posonlyargs, ...args.args, ...args.kwonlyargs, args.vararg, args.kwarg].filter(Boolean).map((a: any) => a.arg) : [];
  // the position of a def's or class's name: after "def " / "class " on its line
  const defName = (n: any): [number, number] | null => {
    const text = lines[n.lineno - 1] ?? "";
    const m = new RegExp(`(?<![\\p{L}\\p{N}_])(?:def|class)\\s+(${name})(?![\\p{L}\\p{N}\\p{Mn}\\p{Mc}_\u02b9])`, "u").exec(text);
    if (!m) return null;
    const start = bytesLen(text.slice(0, m.index + m[0].length - name.length));
    return [start, start + bytesLen(name)];
  };
  // whether a class body declares `global name` (for the whole body)
  const declaresGlobal = (body: any[]): boolean => {
    let found = false;
    const scan = (n: any): void => {
      if (found || !n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(scan);
      if (n._type === "Global" && n.names.includes(name)) { found = true; return; }
      if (SCOPES.has(n._type)) return;
      for (const k of Object.keys(n)) if (k !== "_type") scan(n[k]);
    };
    scan(body);
    return found;
  };
  // A class: its decorators and bases are evaluated where it is (`here`); its
  // body in execution order: a load of the name reads the class's attribute
  // once the body has bound it, before that the scope around (`outer`, which
  // is also what the functions, lambdas, comprehensions and classes nested in
  // it see); the body's own bindings are attributes, never the global
  // ("store": loads visible, stores not).  Where it depends on the run (bound
  // in one branch of an if, or in a loop) a load may read either ("maybe").
  const walkClass = (n: any, here: Shadow, outer: boolean, stmt: number, path: [any, string][]): void => {
    const p = (key: string): [any, string][] => [...path, [n, key]];
    walk(n.decorator_list, here, stmt, p("decorator_list"), outer);
    walk(n.bases, here, stmt, p("bases"), outer);
    walk(n.keywords, here, stmt, p("keywords"), outer);
    if (n.name === name && !here) {
      const d = defName(n);
      if (d) out.push({ line: n.lineno, col: d[0], end: d[1], store: true, stmt, path, def: n });
    }
    if (declaresGlobal(n.body)) return walk(n.body, false, stmt, p("body"), outer);
    type State = boolean | "maybe";
    const join = (a: State, b: State): State => (a === b ? a : "maybe");
    let bound: State = false;
    // (the states anywhere in try bodies being walked, for their handlers)
    const tries: { s: State }[] = [];
    const note = () => { for (const t of tries) t.s = join(t.s, bound); };
    const now = (): Shadow => (outer || bound === true ? true : bound ? "maybe" : "store");
    // (an expression's loads see the state before it; with a `:=` binding the
    // name, loads on both sides of it, which may read either; after it, bound
    // if the `:=` surely ran)
    const expr = (x: any, at: [any, string][]) => {
      if (!x) return;
      const w = walrusBinds(x, name);
      if (w === "no") return walk(x, now(), stmt, at, outer);
      const before = bound;
      bound = join(bound, true);
      walk(x, now(), stmt, at, outer);
      bound = w === "yes" ? true : join(before, true);
    };
    const binds = (x: any) => localsOf([x], []).has(name);
    // whether it deletes the name: `del x`, `del (x, y)`, the end of `except E as x`
    const deletes = (x: any): boolean => {
      let found = false;
      const scan = (n: any): void => {
        if (found || !n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(scan);
        if ((n._type === "Name" && n.id === name && n.ctx?._type === "Del") || (n._type === "ExceptHandler" && n.name === name)) { found = true; return; }
        if (SCOPES.has(n._type)) return;
        for (const k of Object.keys(n)) if (k !== "_type") scan(n[k]);
      };
      scan(x);
      return found;
    };
    const block = (list: any[], at: [any, string][]) => { for (const st of list) one(st, at); };
    // In a block, statement after statement; where blocks meet (after an if,
    // a try, a with, a loop) the states that may arrive are joined.  An
    // exception may leave a try or a with body (one that suppresses it)
    // anywhere: all the states in it arrive.  Loops (break, continue, else)
    // are not followed: one that binds or deletes the name leaves it "maybe"
    // (unless bound before and never deleted).
    const one = (st: any, at: [any, string][]): void => {
      note();
      const u = (key: string, ...more: [any, string][]): [any, string][] => [...at, [st, key], ...more];
      switch (st._type) {
        case "If": {
          expr(st.test, u("test"));
          const b0 = bound;
          block(st.body, u("body"));
          const b1 = bound;
          bound = b0;
          block(st.orelse, u("orelse"));
          // (`if True:` takes its branch)
          const k = st.test._type === "Constant" && typeof st.test.value === "boolean" ? st.test.value : null;
          bound = k === null ? join(b1, bound) : k ? b1 : bound;
          break;
        }
        case "For": case "AsyncFor": case "While": {
          if (st._type !== "While") expr(st.iter, u("iter"));
          const touched = binds(st) || deletes(st);
          bound = !touched || (bound === true && !deletes(st)) ? bound : "maybe";
          const head = bound;
          if (st._type === "While") expr(st.test, u("test"));
          else {
            expr(st.target, u("target"));
            if (binds(st.target)) bound = true;
          }
          block(st.body, u("body"));
          bound = head;
          block(st.orelse, u("orelse"));
          bound = head;
          break;
        }
        case "With": case "AsyncWith": {
          const t = { s: bound };
          tries.push(t);
          for (const it of st.items) {
            expr(it.context_expr, u("items", [it, "context_expr"]));
            if (it.optional_vars) {
              expr(it.optional_vars, u("items", [it, "optional_vars"]));
              if (binds(it.optional_vars)) bound = true;
            }
          }
          block(st.body, u("body"));
          tries.pop();
          bound = join(t.s, bound);
          break;
        }
        case "Try": case "TryStar": {
          const t = { s: bound };
          tries.push(t);
          block(st.body, u("body"));
          tries.pop();
          note();
          block(st.orelse, u("orelse"));
          let end = bound;
          for (const h of st.handlers) {
            bound = t.s;
            expr(h.type, u("handlers", [h, "type"]));
            if (h.name === name) bound = true;
            block(h.body, u("handlers", [h, "body"]));
            // (`except E as x` deletes x at its end)
            if (h.name === name) bound = false;
            end = join(end, bound);
          }
          if (st.finalbody.length) {
            // (also run while an exception propagates)
            bound = join(end, t.s);
            block(st.finalbody, u("finalbody"));
          } else bound = end;
          break;
        }
        case "Match": {
          expr(st.subject, u("subject"));
          const b0 = bound;
          let end = b0; // (no case matched)
          for (const c of st.cases) {
            bound = b0;
            expr(c.pattern, u("cases", [c, "pattern"]));
            if (binds(c.pattern)) bound = "maybe"; // (a pattern may bind some of its names and fail)
            expr(c.guard, u("cases", [c, "guard"]));
            block(c.body, u("cases", [c, "body"]));
            end = join(end, bound);
          }
          bound = end;
          break;
        }
        case "Delete":
          walk(st, now(), stmt, at, outer);
          if (deletes(st)) bound = false;
          break;
        case "AnnAssign":
          // (`x: int` alone binds nothing)
          if (!st.value) { walk(st, now(), stmt, at, outer); break; }
          expr(st, at);
          if (binds(st.target)) bound = true;
          break;
        default:
          expr(st, at);
          // (`:=` done by expr)
          if (localsOf([st], [], false).has(name)) bound = true;
      }
      note();
    };
    block(n.body, p("body"));
  };
  // `shadowed`: what the name is here; `fn`: what it is in the scopes nested
  // here (functions, lambdas, comprehensions and class bodies), which do not
  // see a class's attributes
  const walk = (n: any, shadowed: Shadow, stmt: number, path: [any, string][], fn: boolean): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, shadowed, stmt, path, fn));
    if (typeof n._type !== "string") return;
    const under = (key: string): [any, string][] => [...path, [n, key]];
    switch (n._type) {
      case "Name": {
        if (n.id !== name) return;
        // (`del x` acts on the binding there: a use, not a definition)
        const o: Occurrence = { line: n.lineno, col: n.col_offset, end: n.end_col_offset, store: n.ctx?._type === "Store", stmt, path };
        if (!shadowed) out.push(o);
        else if (shadowed !== true) {
          // (a class body's `x += 1` reads the global and binds the attribute:
          // not renamable)
          const aug = path.at(-1)?.[0]._type === "AugAssign" && path.at(-1)?.[1] === "target";
          // (`del x` there deletes the class's x, never the global)
          if (n.ctx?._type === "Load" || aug) out.push({ ...o, store: false, ...(shadowed === "maybe" || aug ? { maybe: true as const } : {}) });
        }
        return;
      }
      case "FunctionDef": case "AsyncFunctionDef": case "Lambda": {
        // decorators, defaults and annotations are evaluated outside
        walk(n.decorator_list, shadowed, stmt, under("decorator_list"), fn);
        walk(n.args?.defaults, shadowed, stmt, under("args"), fn);
        walk(n.args?.kw_defaults, shadowed, stmt, under("args"), fn);
        walk(n.returns, shadowed, stmt, under("returns"), fn);
        // (annotations: evaluated when asked for, Python 3.14)
        const a = n.args;
        if (a) walk([...a.posonlyargs, ...a.args, ...a.kwonlyargs, a.vararg, a.kwarg].filter(Boolean).map((x: any) => x.annotation), shadowed, stmt, under("annotations"), fn);
        if (n._type !== "Lambda" && n.name === name && !shadowed) {
          const p = defName(n);
          if (p) out.push({ line: n.lineno, col: p[0], end: p[1], store: true, stmt, path, def: n });
        }
        const body = n._type === "Lambda" ? [n.body] : n.body;
        const inner = fn || localsOf(body, params(n.args)).has(name);
        walk(body, inner, stmt, under("body"), inner);
        return;
      }
      case "ClassDef":
        walkClass(n, shadowed, fn, stmt, path);
        return;
      case "ListComp": case "SetComp": case "GeneratorExp": case "DictComp": {
        const gens = n.generators;
        // the first iterable is evaluated outside
        walk(gens[0]?.iter, shadowed, stmt, under("iter0"), fn);
        const targets = new Set<string>();
        for (const g of gens) localsOf([g.target], []).forEach((t) => targets.add(t));
        const inner = fn || targets.has(name);
        gens.forEach((g: any, i: number) => { walk(g.target, inner, stmt, under("generators"), inner); if (i) walk(g.iter, inner, stmt, under("generators"), inner); walk(g.ifs, inner, stmt, under("generators"), inner); });
        walk(n._type === "DictComp" ? [n.key, n.value] : [n.elt], inner, stmt, under("elt"), inner);
        return;
      }
      case "alias": {
        // `import x`, `import m as x`, `from m import x`
        const bound = (n.asname ?? n.name.split(".")[0]);
        if (bound === name && !shadowed && n.lineno !== undefined) {
          const text = lines[n.lineno - 1] ?? "";
          const seg = byteSlice(text, n.col_offset, n.end_col_offset);
          const k = n.asname ? seg.lastIndexOf(name) : seg.indexOf(name);
          if (k >= 0) out.push({ line: n.lineno, col: n.col_offset + bytesLen(seg.slice(0, k)), end: n.col_offset + bytesLen(seg.slice(0, k + name.length)), store: true, stmt, path, ...(n.asname ? {} : { alias: n.name.includes(".") ? null : n.name }) });
        }
        return;
      }
      case "Global": {
        // (in a function: `global x` names the module's x)
        if (n.names.includes(name) && !shadowed) {
          // (names of any script; the statement may go on over `\` lines)
          const text = lines.slice(n.lineno - 1, n.end_lineno ?? n.lineno).join("\n");
          const m = new RegExp(`(?<![\\p{L}\\p{N}_])global(?![\\p{L}\\p{N}_])[^#]*?(?<![\\p{L}\\p{N}_\u02b9])(${name})(?![\\p{L}\\p{N}\\p{Mn}\\p{Mc}_\u02b9])`, "u").exec(text);
          if (m) {
            const at = m.index + m[0].length - name.length;
            const before = text.slice(0, at), ln = n.lineno + (before.match(/\n/g)?.length ?? 0);
            const start = bytesLen(before.slice(before.lastIndexOf("\n") + 1));
            out.push({ line: ln, col: start, end: start + bytesLen(name), store: false, stmt, path, global: true });
          } else out.push({ line: n.lineno, col: 0, end: 0, store: false, stmt, path, global: true, alias: null });
        }
        return;
      }
      case "ExceptHandler":
        // `except E as x` binds x: just after E (else not renamable)
        if (n.name === name && !shadowed) {
          const ln = n.type?.end_lineno ?? n.lineno;
          const text = lines[ln - 1] ?? "";
          const from = n.type ? n.type.end_col_offset : n.col_offset;
          const after = byteSlice(text, from);
          const m = new RegExp(`^([\\s)]*as\\s+)(${name})\\s*:`).exec(after);
          if (m && n.type) {
            const start = from + bytesLen(m[1]);
            out.push({ line: ln, col: start, end: start + bytesLen(name), store: true, stmt, path });
          } else out.push({ line: n.lineno, col: 0, end: 0, store: true, stmt, path, alias: null });
        }
        break;
      case "Attribute": walk(n.value, shadowed, stmt, under("value"), fn); return; // (not the attribute's name)
      case "keyword": walk(n.value, shadowed, stmt, under("value"), fn); return; // (not the argument's name)
    }
    for (const k of Object.keys(n)) if (k !== "_type") walk(n[k], shadowed, stmt, under(k), fn);
  };
  tree.body.forEach((st: any, i: number) => walk(st, false, i, [], false));
  return out;
}

// Which occurrences read the name's previous value (before the cell's first
// definition, `first`, takes effect) and which its new one, in execution
// order: by position, except what is evaluated before the binding (an
// assignment's value, a for loop's iterable, a with item's expression, :='s
// value), which reads the old one.  Null when no one name fits: a use inside
// a loop that also contains the definition, before it (the first pass reads
// the old value, later ones the new).
// When an occurrence inside a class (or a def's header) defining the name
// runs: "now", while the class is made (the previous value); "later" (the
// new one); or "maybe", when that cannot be told from the code.  The bodies
// of functions, lambdas and generator expressions run when called or
// consumed: a lambda called where it is written, or a generator passed to a
// call (`sum(x for ...)`), now; a function or lambda or generator stored in
// the class (a method, `f = lambda: ...`) and not used in its body again,
// or a def's default, later; anything else maybe.
function timing(o: Occurrence, defIdx: number, def: any): "now" | "later" | "maybe" {
  // (a decorator is a call: whatever its name, it may run the function)
  const plainDecorators = (f: any) => f.decorator_list.length === 0;
  // (the body of the def defining the name: its decorators may call it
  // before the name is bound, REACT-98EB-1)
  if (def._type !== "ClassDef" && o.path[defIdx][1] === "body") return plainDecorators(def) ? "later" : "maybe";
  // whether `name` is read in the class's body outside `except`
  const usedInClass = (name: string, except: any): boolean => {
    if (def._type !== "ClassDef") return false;
    let found = false;
    const scan = (n: any): void => {
      if (found || !n || typeof n !== "object" || n === except) return;
      if (Array.isArray(n)) return n.forEach(scan);
      if (n._type === "Name" && n.id === name && n.ctx?._type === "Load") { found = true; return; }
      for (const k of Object.keys(n)) if (k !== "_type") scan(n[k]);
    };
    scan(def.body);
    return found;
  };
  // (in a class nested in the one defining the name, a method or an
  // annotation can be reached through that class, `D.m()` or `read(D)`,
  // while the outer body still runs: so a use of the nested class there,
  // or its decorators or metaclass, may run it before the name is bound,
  // REACT-75A8-1)
  const viaNested = (upTo: number) => def._type === "ClassDef" && o.path.slice(defIdx + 1, upTo).some(([n]) => n._type === "ClassDef" && (n.decorator_list.length || n.keywords?.length || usedInClass(n.name, n)));
  // (annotations: evaluated when asked for, Python 3.14)
  const lazy = ([n, key]: [any, string]) => ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef") && (key === "annotations" || key === "returns")) || (n._type === "AnnAssign" && key === "annotation");
  // (asked for later, except: future annotations (source text); a
  // decorator, a metaclass, a method's decorator or the class body itself
  // may ask for them before the name is bound)
  if (o.path.slice(defIdx).some(lazy)) {
    if (FUTURE || def.decorator_list?.length || def.keywords?.length || viaNested(o.path.length)) return "maybe";
    if (o.path.slice(defIdx + 1).some(([n]) => (n._type === "FunctionDef" || n._type === "AsyncFunctionDef") && !plainDecorators(n))) return "maybe";
    if (def._type === "ClassDef" && mentions(def.body, ["__annotations__", "__annotate__", "annotationlib", "get_annotations", "get_type_hints", "locals", "vars"])) return "maybe";
    // (or a class body using one of its functions at all: given to a call,
    // in a container, through an alias, any of which may ask, REACT-98EB-3)
    if (def._type === "ClassDef") {
      // (its functions: also those under if, for, while, try, with and match, REACT-6748-3)
      const fns: string[] = [];
      const collect = (sts: any[]): void => {
        for (const b of sts ?? []) {
          if (b._type === "FunctionDef" || b._type === "AsyncFunctionDef") fns.push(b.name);
          else if (b._type !== "ClassDef") {
            for (const k of ["body", "orelse", "finalbody"]) if (Array.isArray(b[k])) collect(b[k]);
            for (const h of b.handlers ?? []) collect(h.body);
            for (const c of b.cases ?? []) collect(c.body);
          }
        }
      };
      collect(def.body);
      if (fns.some((f: string) => usedInClass(f, null))) return "maybe";
    }
    return "later";
  }
  for (let j = defIdx + 1; j < o.path.length; j++) {
    const [n, key] = o.path[j];
    const deferred = ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "Lambda") && key === "body") ||
      (n._type === "GeneratorExp" && (key === "elt" || key === "generators"));
    if (!deferred) continue;
    const [p, pkey] = o.path[j - 1] ?? [null, ""];
    if (n._type === "Lambda" && p?._type === "Call" && pkey === "func") continue;
    if ((n._type === "GeneratorExp" || n._type === "Lambda") && consumed(o.path, j)) continue;
    // a default of a function: runs when it is called, or anything given
    // the function calls it (its decorators, its class's decorators,
    // metaclass or body: REACT-98EB-1); a lambda's: not followed
    if ((p?._type === "FunctionDef" || p?._type === "AsyncFunctionDef" || p?._type === "Lambda") && pkey === "args") {
      if (p._type === "Lambda" || !plainDecorators(p)) return "maybe";
      if (def._type === "ClassDef" && (def.decorator_list.length || def.keywords?.length || usedInClass(p.name, p) || viaNested(j))) return "maybe";
      return "later";
    }
    let name: string | null = null;
    if (n._type === "FunctionDef" || n._type === "AsyncFunctionDef") {
      if (!plainDecorators(n)) return "maybe";
      name = n.name;
    } else if ((p?._type === "Assign" && p.targets.length === 1 && p.targets[0]._type === "Name") && pkey === "value") name = p.targets[0].id;
    else if (p?._type === "AnnAssign" && p.target._type === "Name" && pkey === "value") name = p.target.id;
    if (name === null) return "maybe";
    // (a class decorator, or a metaclass, may call it before the name is bound)
    if (def._type === "ClassDef" && (def.decorator_list.length || def.keywords?.length)) return "maybe";
    return usedInClass(name, n) || viaNested(j) ? "maybe" : "later";
  }
  return "now";
}

// Whether a lambda or generator (path entry j) is given to a call that runs
// it before returning: never assumed.  A name, even list or sorted, may be
// another cell's function, and builtins' arguments have roles (sum's start,
// max's several arguments) that keep what they are given; a lambda or
// generator given to any call may run later, and a read of the redefined
// name in it is refused.
const consumed = (_path: [any, string][], _j: number) => false;

// Whether a string constant's own literals (its span in the source:
// concatenated literals, the comments and line breaks between them) write a
// surrogate as an escape, \ud800 or \U0000d800: not in a raw literal, not
// after an escaped backslash (REACT-2E62-1).  True when its source cannot be
// read so (conservative).
function surrogateEscape(e: any): boolean {
  // (columns are UTF-8 byte offsets)
  const at = (line: string, bytes: number) => {
    let i = 0, b = 0;
    while (i < line.length && b < bytes) { const c = line.codePointAt(i)!; b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; i += c > 0xffff ? 2 : 1; }
    return i;
  };
  const first = e.lineno - 1, last = (e.end_lineno ?? e.lineno) - 1;
  if (!SOURCE[first] || !SOURCE[last]) return true;
  const t = first === last ? SOURCE[first].slice(at(SOURCE[first], e.col_offset), at(SOURCE[first], e.end_col_offset)) :
    [SOURCE[first].slice(at(SOURCE[first], e.col_offset)), ...SOURCE.slice(first + 1, last), SOURCE[last].slice(0, at(SOURCE[last], e.end_col_offset))].join("\n");
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    // (whitespace between tokens as the lexer skips it, form feed too: REACT-006F-1)
    if (c === " " || c === "\t" || c === "\f" || c === "\n" || c === "\r" || c === "(" || c === ")") { i++; continue; }
    if (c === "\\" && (t[i + 1] === "\n" || t[i + 1] === "\r")) { i += 2; continue; }
    if (c === "#") { while (i < t.length && t[i] !== "\n") i++; continue; }
    const pre = /^[rRbBuU]{0,2}/.exec(t.slice(i))![0];
    const raw = /[rR]/.test(pre);
    i += pre.length;
    const q = t[i];
    if (q !== "'" && q !== '"') return true;
    const close = t.startsWith(q.repeat(3), i) ? q.repeat(3) : q;
    i += close.length;
    for (;;) {
      if (i >= t.length) return true;
      if (t.startsWith(close, i)) { i += close.length; break; }
      if (t[i] === "\\") {
        if (!raw && ((t[i + 1] === "u" && /^[dD][89a-fA-F][0-9a-fA-F]{2}$/.test(t.slice(i + 2, i + 6))) || (t[i + 1] === "U" && /^0000[dD][89a-fA-F][0-9a-fA-F]{2}$/.test(t.slice(i + 2, i + 10))))) return true;
        i += 2;
        continue;
      }
      i++;
    }
  }
  return false;
}

// (whether the cell being renamed has `from __future__ import annotations`)
let FUTURE = false;
// (and its lines, as analyzed)
let SOURCE: string[] = [];

// The outermost part of an occurrence's statement that runs later than it is
// written: a function's body, a lambda's (unless called where it is
// written, or given to a call that runs it), a generator expression's body
// (unless given to a call that consumes it), an annotation; with the index
// in its path.
function deferredOf(o: Occurrence): { node: any; j: number; kind: "callable" | "annotation" } | null {
  for (let j = 0; j < o.path.length; j++) {
    const [n, key] = o.path[j];
    const [p, pkey] = o.path[j - 1] ?? [null, ""];
    if ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef") && (key === "annotations" || key === "returns")) return { node: n, j, kind: "annotation" };
    if ((n._type === "AnnAssign" && key === "annotation") || (n._type === "TypeAlias" && key === "value") || (n._type === "TypeVar" && key === "bound")) return { node: n, j, kind: "annotation" };
    if ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef") && key === "body") return { node: n, j, kind: "callable" };
    const passed = consumed(o.path, j);
    if (n._type === "Lambda" && key === "body" && !(p?._type === "Call" && pkey === "func") && !passed) return { node: n, j, kind: "callable" };
    if (n._type === "GeneratorExp" && (key === "elt" || key === "generators") && !passed) return { node: n, j, kind: "callable" };
  }
  return null;
}

// The name a callable written in a statement is kept under: a def's, or the
// target of `f = lambda: ...` / `g = (... for ...)`; else null.
function callableName(o: Occurrence, d: { node: any; j: number }): string | null {
  const n = d.node;
  if (n._type === "FunctionDef" || n._type === "AsyncFunctionDef") return n.name;
  const [p, pkey] = o.path[d.j - 1] ?? [null, ""];
  if (p?._type === "Assign" && pkey === "value" && p.targets.length === 1 && p.targets[0]._type === "Name") return p.targets[0].id;
  if (p?._type === "AnnAssign" && pkey === "value" && p.target._type === "Name") return p.target.id;
  return null;
}

// Where a cell's top-level statements use `fname`: each use's statement,
// position, whether it is a plain call that runs where it is written, and
// whether that runs exactly once (not under an if, a loop, `and`/`or`, a
// comprehension, an exception handler).
type Use = { stmt: number; line: number; col: number; call: boolean; once: boolean; node: any; path: [any, string][] };
function usesOf(body: any[], fname: string): Use[] {
  const out: Use[] = [];
  // (path: its ancestors in the statement, each with the field it is under, as an Occurrence's)
  const scan = (n: any, stmt: number, later: boolean, maybe: boolean, parent: any, key: string, path: [any, string][] = []): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x, i) => scan(x, stmt,
      // (a generator's later iterables run when it is consumed)
      later || (parent?._type === "GeneratorExp" && key === "generators" && i > 0),
      // (`and`/`or` after the first; a chained comparison's later operands; a
      // comprehension's later iterables)
      maybe || (parent?._type === "BoolOp" && key === "values" && i > 0) || (parent?._type === "Compare" && key === "comparators" && i > 0) ||
        ((parent?._type === "ListComp" || parent?._type === "SetComp" || parent?._type === "DictComp") && key === "generators" && i > 0),
      parent, key, path));
    if (n._type === "Name" && n.id === fname && n.ctx?._type === "Load") {
      const call = !later && parent?._type === "Call" && key === "func";
      out.push({ stmt, line: n.lineno, col: n.col_offset, call, once: call && !maybe, node: call ? parent : null, path });
      return;
    }
    for (const k of Object.keys(n)) {
      if (k === "_type") continue;
      const deferred = ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "Lambda") && k === "body") || (n._type === "GeneratorExp" && k !== "generators") ||
        (n._type === "comprehension" && (k === "ifs" || k === "target") && parent?._type === "GeneratorExp") ||
        // (annotations: evaluated when asked for)
        (n._type === "arg" && k === "annotation") || ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef") && k === "returns") || (n._type === "AnnAssign" && k === "annotation");
      const t = n._type;
      const cond = (t === "If" && k !== "test") || (t === "IfExp" && k !== "test") || ((t === "For" || t === "AsyncFor") && k !== "iter") || t === "While" ||
        // (a try body may stop at any statement; an assert's message runs
        // only when it fails)
        ((t === "Try" || t === "TryStar") && (k === "body" || k === "handlers" || k === "orelse")) || t === "Match" && k === "cases" || (t === "Assert" && k === "msg") ||
        // (a context manager may suppress an exception from its body)
        ((t === "With" || t === "AsyncWith") && k === "body") ||
        ((t === "ListComp" || t === "SetComp" || t === "DictComp" || t === "GeneratorExp") && k !== "generators") || t === "comprehension" && k !== "iter";
      scan(n[k], stmt, later || deferred, maybe || cond, n, k, [...path, [n, k]]);
    }
  };
  body.forEach((st, i) => scan(st, i, false, false, null, ""));
  return out;
}

// Whether code passes any of `names` to a call (as an argument).
function passesAny(n: any, names: Set<string>): boolean {
  if (!n || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some((x) => passesAny(x, names));
  if (n._type === "Call" && [...n.args, ...n.keywords.map((k: any) => k.value)].some((a: any) => a?._type === "Name" && names.has(a.id))) return true;
  return Object.keys(n).some((k) => k !== "_type" && passesAny(n[k], names));
}

// Whether code makes a call.
function hasCall(n: any): boolean {
  if (!n || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some(hasCall);
  return n._type === "Call" || Object.keys(n).some((k) => k !== "_type" && hasCall(n[k]));
}

// Whether code mentions any of `names` (as names or attributes).
function mentions(n: any, names: string[]): boolean {
  if (!n || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some((x) => mentions(x, names));
  if ((n._type === "Name" && names.includes(n.id)) || (n._type === "Attribute" && names.includes(n.attr))) return true;
  return Object.keys(n).some((k) => k !== "_type" && mentions(n[k], names));
}

// Whether a statement may return or raise (not counting nested scopes).
function exits(n: any): boolean {
  if (!n || typeof n !== "object") return false;
  if (Array.isArray(n)) return n.some(exits);
  if (n._type === "Return" || n._type === "Raise" || n._type === "Assert") return true;
  if (n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "ClassDef" || n._type === "Lambda") return false;
  return Object.keys(n).some((k) => k !== "_type" && exits(n[k]));
}

// Whether calling `fname` runs this function's body, where written: a plain
// def (not async, not a generator, not decorated), the only binding of its
// name in the cell.
function plainSetter(f: any, fname: string, body: any[]): boolean {
  if (f._type !== "FunctionDef" || f.decorator_list.length) return false;
  let ok = true, defs = 0;
  const scan = (n: any, inF: boolean): void => {
    if (!ok || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => scan(x, inF));
    if (inF && (n._type === "Yield" || n._type === "YieldFrom")) ok = false;
    if (!inF && ((n._type === "Name" && n.id === fname && n.ctx?._type !== "Load") || ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "ClassDef") && n.name === fname) || (n._type === "alias" && (n.asname ?? n.name) === fname))) defs++;
    // (not into nested scopes' own yields)
    const nested = inF && (n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "Lambda" || n._type === "GeneratorExp" || n._type === "ClassDef");
    if (nested) return;
    for (const k of Object.keys(n)) if (k !== "_type") scan(n[k], inF || n === f);
  };
  scan(body, false);
  return ok && defs === 1;
}

function whichReads(occ: Occurrence[], first: Occurrence, body: any[] = []): Map<Occurrence, "old" | "new"> | null {
  const out = new Map<Occurrence, "old" | "new">();
  // (`from __future__ import annotations`: annotations are their source
  // text, which a rename would change)
  const futureAnnotations = body.some((st) => st._type === "ImportFrom" && st.module === "__future__" && st.names.some((a: any) => a.name === "annotations"));
  const before = (a: { line: number; col: number }, b: { line: number; col: number }) => a.line < b.line || (a.line === b.line && a.col < b.col);
  // Whether occurrence a runs before b: in Python's order of evaluation,
  // which is the source's except where a node evaluates a later field first
  // (REACT-75A8-2, -3): an assignment its value before its targets, a call
  // its positional and starred arguments before its keyword ones, a
  // conditional expression its test, a loop or comprehension its iterable,
  // := and a with item their value.
  const FIRST: Record<string, string[]> = {
    Assign: ["value", "targets"], AnnAssign: ["value", "target"], NamedExpr: ["value", "target"],
    For: ["iter", "target"], AsyncFor: ["iter", "target"], comprehension: ["iter", "target", "ifs"],
    ListComp: ["generators", "elt"], SetComp: ["generators", "elt"], GeneratorExp: ["generators", "elt"], DictComp: ["generators", "key", "value"],
    Call: ["func", "args", "keywords"], ClassDef: ["bases", "keywords"], IfExp: ["test", "body", "orelse"], withitem: ["context_expr", "optional_vars"],
  };
  // (an occurrence's path takes shortcuts that a use's does not: a
  // comprehension's first iterable as "iter0", its targets, later iterables
  // and conditions under "generators" with no comprehension node, a dict
  // comprehension's key and value both as "elt", defaults under "args" with
  // no arguments node; both made the AST's, REACT-156C-1)
  type At = { stmt: number; line: number; col: number; path: [any, string][] };
  const COMPS = new Set(["ListComp", "SetComp", "GeneratorExp", "DictComp"]);
  const canon = (o: At): [any, string][] => {
    const out: [any, string][] = [];
    o.path.forEach(([n, k], j) => {
      const next = o.path[j + 1]?.[0];
      // (the child the path goes on to: the next entry's node, or at its end the name itself)
      const is = (v: any) => v != null && (next ? v === next : v._type === "Name" && v.lineno === o.line && v.col_offset === o.col);
      const has = (v: any) => (Array.isArray(v) ? v.some(is) : is(v));
      if (k === "iter0") { out.push([n, "generators"], [n.generators[0], "iter"]); return; }
      if (COMPS.has(n._type) && k === "generators") {
        const g = n.generators.find((g: any) => has(g.target) || has(g.iter) || has(g.ifs));
        if (g) { out.push([n, k], [g, has(g.target) ? "target" : has(g.iter) ? "iter" : "ifs"]); return; }
      }
      if (n._type === "DictComp" && k === "elt") { out.push([n, has(n.key) ? "key" : "value"]); return; }
      if ((n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "Lambda") && k === "args" && next !== n.args && n.args) {
        out.push([n, k], [n.args, has(n.args.kw_defaults) ? "kw_defaults" : "defaults"]);
        return;
      }
      out.push([n, k]);
    });
    return out;
  };
  const runsBefore = (a0: At, b0: At) => {
    if (a0.stmt !== b0.stmt) return a0.stmt < b0.stmt;
    const a = { ...a0, path: canon(a0) }, b = { ...b0, path: canon(b0) };
    for (let j = 0; j < Math.min(a.path.length, b.path.length) && a.path[j][0] === b.path[j][0]; j++) {
      const n = a.path[j][0], ka = a.path[j][1], kb = b.path[j][1];
      if (ka !== kb) {
        const order = FIRST[n._type], ia = order ? order.indexOf(ka) : -1, ib = order ? order.indexOf(kb) : -1;
        if (ia >= 0 && ib >= 0) return ia < ib;
        break;
      }
      // (the same field: different elements of it run in the source's order)
      if (a.path[j + 1]?.[0] !== b.path[j + 1]?.[0]) break;
    }
    return before(a, b);
  };
  // Where the definition takes effect: where it is written, or, made in a
  // function's body (`global x`), where the cell calls that function (only
  // there: a definition in code that runs at another time, or maybe never,
  // a lazy generator's, cannot be placed)
  const df = deferredOf(first);
  // (`node`: a setter's call, whose arguments are evaluated before it runs)
  let at: { stmt: number; line: number; col: number; node?: any; path: [any, string][] } = first;
  let calls = 0;
  if (df) {
    const fname = df.kind === "callable" ? callableName(first, df) : null;
    const uses = fname ? usesOf(body, fname) : [];
    if (!fname || !uses.length || uses.some((u) => !u.once) || !plainSetter(df.node, fname, body)) return null;
    // (and the call reaches the store: a statement of the function's body
    // itself, after no return or raise)
    // (a def's own name is stored by the def statement itself: first.def)
    const i = first.path.findIndex(([n, key]) => n === df.node && key === "body");
    const st = first.path[i + 1]?.[0] ?? first.def;
    const k = df.node.body.indexOf(st);
    const COMPOUND = new Set(["If", "For", "AsyncFor", "While", "Try", "TryStar", "With", "AsyncWith", "Match"]);
    if (k < 0 || COMPOUND.has(st._type) || df.node.body.slice(0, k).some((b: any) => exits(b))) return null;
    // (and within it, the store is not after `and`/`or`, in a conditional
    // expression's branch, an assert's message, a later comparison operand,
    // or a comprehension's element, unless every iterable is a literal with
    // elements and nothing filters: REACT-98EB-4; and run more than once,
    // the comprehension may not read the name: its later iterations read
    // the new value, REACT-6748-2)
    const nonEmpty = (g: any) => !g.ifs.length && !g.is_async && ["List", "Tuple", "Set"].includes(g.iter._type) && g.iter.elts.length > 0 && !g.iter.elts.some((e: any) => e._type === "Starred");
    const repeats = (n: any) => n.generators.some((g: any) => g.iter.elts.length > 1);
    const readsIn = (n: any) => occ.some((o) => o !== first && o.path.some(([m]) => m === n));
    const mayNotRun = (n: any, key: string, next: any, nextKey: string | undefined) =>
      n._type === "GeneratorExp" || ((n._type === "ListComp" || n._type === "SetComp" || n._type === "DictComp") &&
        (key === "generators" ? !(next === n.generators[0] && nextKey === "iter") : !n.generators.every(nonEmpty) || (repeats(n) && readsIn(n))));
    if (first.path.slice(i + 1).some(([n, key], j, rest) => {
      const next = rest[j + 1]?.[0];
      return (n._type === "BoolOp" && next && n.values.indexOf(next) > 0) || (n._type === "IfExp" && key !== "test") || (n._type === "Assert" && key === "msg") ||
        mayNotRun(n, key, next, rest[j + 1]?.[1]) ||
        (n._type === "Compare" && key === "comparators" && next && n.comparators.indexOf(next) > 0);
    })) return null;
    at = uses.reduce((a, u) => (u.stmt < a.stmt || (u.stmt === a.stmt && runsBefore(u, a)) ? u : a));
    calls = uses.length;
  }
  const inside = (o: Occurrence, node: any) => o.path.some(([n]) => n === node);
  // (what a statement evaluates before binding: an assignment's value, a for
  // loop's iterable, a with item's expression, :='s value)
  // (the binding elsewhere in that statement than the part evaluated first:
  // one inside it, `v = x if (x := 2) else 0`, is placed by runsBefore)
  // (the cell's first binding an augmented assignment's target: renamed as
  // `xʹ2 = x; xʹ2 += ...`, the new name bound before the statement runs)
  const prefixed = first.path.length === 1 && first.path[0][0]._type === "AugAssign" && first.path[0][1] === "target";
  const evaluatedFirst = (o: Occurrence, first: Occurrence) => o.path.some(([n, key]) => {
    const elsewhere = inside(first, n) && !first.path.some(([m, k]) => m === n && k === key);
    // (an augmented assignment loads its target, and evaluates what the
    // target is made of, before its value: the value comes first only for
    // the binding of the target name itself, `x += x`, REACT-321C-1)
    // (not when the cell's first binding is that target at the top level:
    // `xʹ2 = x; xʹ2 += ...` binds the new name first, and the value reads it)
    const augStore = n._type === "AugAssign" && first.path.at(-1)?.[0] === n && first.path.at(-1)?.[1] === "target" && !prefixed;
    const firstPart = elsewhere && (((n._type === "Assign" || n._type === "AnnAssign") && key === "value") || (augStore && key === "value") ||
      ((n._type === "For" || n._type === "AsyncFor") && key === "iter") ||
      (n._type === "NamedExpr" && key === "value") ||
      (n._type === "withitem" && key === "context_expr"));
    // (and no := in that part binds the name before the read: after one,
    // `x += (x := 2) + x`, it reads the new value, REACT-C199-1)
    return firstPart && !occ.some((s) => s.store && s !== first && !s.global && s.path.some(([m, k]) => m === n && k === key) && runsBefore(s, o));
  });
  const LOOPS = new Set(["For", "AsyncFor", "While"]);
  // (a `global x` takes the name of the assignments in its function, if any)
  const globals = occ.filter((o) => o.global);
  // (the function whose body it is in: a default is the enclosing one's)
  const fnOf = (o: Occurrence) => [...o.path].reverse().find(([n, key]) => (n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "ClassDef") && key === "body")?.[0];
  // A read in a part of the cell that repeats (a loop's body or a while's
  // test, a comprehension's element, conditions and later iterables), run
  // in an iteration before a binding of the name there: the first
  // iteration reads what was bound before, later ones what that binding
  // stored, and no one name fits (REACT-F813-1, FEED-1, FEED-3).  Unless the
  // part runs at most once; or a binding there always runs before the read
  // in the iteration; or one before the part (in this cell) already gave
  // the new name, which every iteration then reads (FEED-2).  A
  // comprehension's first iterable, and a for loop's, run once.
  const literalOnce = (it: any) => ["List", "Tuple", "Set"].includes(it?._type) && it.elts.length <= 1 && !it.elts.some((e: any) => e._type === "Starred");
  const repeats = (n: any, k: string) =>
    ((n._type === "For" || n._type === "AsyncFor") && (k === "target" || k === "body") && !literalOnce(n.iter)) ||
    (n._type === "While" && (k === "test" || k === "body")) ||
    (COMPS.has(n._type) && k !== "iter0" && !n.generators.every((g: any) => literalOnce(g.iter)));
  const inRepeat = (o: Occurrence, R: any) => o.path.some(([n, k]) => n === R && repeats(n, k));
  // (whether a path entry may skip what is under it: a branch of an if (not
  // `if True`) or a conditional expression, a later operand of and/or or of
  // a chained comparison, an assert's message, a loop's body (unless over a
  // literal with elements), a try's body or handlers, a with's body, a
  // match's cases, a comprehension's body (unless over literals with
  // elements and no conditions): REACT-E17D-2, -3)
  // (a constant's value, folded through not, unary minus, and/or and
  // comparisons of numbers and strings; undefined when not known.  pyparse
  // gives ints as BigInts, floats as numbers, None and ... as {name},
  // bytes as byte arrays, imaginary numbers as {imag}: REACT-67BD-1, -2)
  type K = { t: "bool" | "int" | "float" | "str" | "none" | "bytes" | "complex" | "ellipsis"; v: any };
  const konst = (e: any): K | undefined => {
    if (e?._type === "Constant") {
      const v = e.value;
      if (typeof v === "boolean") return { t: "bool", v };
      if (typeof v === "bigint") return { t: "int", v };
      if (typeof v === "number") return { t: "float", v };
      // (pyparse's JavaScript string cannot tell two lone surrogates written
      // as escapes, '\ud800\udc00', from the character they pair to: such a
      // string, a pair in it and a surrogate escape on its lines, is not
      // known, REACT-8BB7-1)
      if (typeof v === "string") {
        return /[\ud800-\udbff][\udc00-\udfff]/.test(v) && surrogateEscape(e) ? undefined : { t: "str", v };
      }
      if (v && typeof v === "object" && v.name === "None") return { t: "none", v: null };
      if (v && typeof v === "object" && v.name === "Ellipsis") return { t: "ellipsis", v: null };
      if (v && typeof v === "object" && "imag" in v) return { t: "complex", v };
      if (v instanceof Uint8Array) return { t: "bytes", v };
      return undefined;
    }
    if (e?._type === "UnaryOp") {
      const x = konst(e.operand);
      if (!x) return undefined;
      if (e.op?._type === "Not") return { t: "bool", v: !truth(x) };
      if (e.op?._type === "USub" && (x.t === "int" || x.t === "float")) return { t: x.t, v: -x.v };
      return undefined;
    }
    if (e?._type === "BoolOp") {
      const xs = e.values.map(konst);
      if (xs.some((x: K | undefined) => !x)) return undefined;
      const and = e.op?._type === "And";
      return xs.find((x: K) => truth(x) !== and) ?? xs.at(-1);
    }
    if (e?._type === "Compare") {
      const xs = [e.left, ...e.comparators].map(konst);
      if (xs.some((x) => !x)) return undefined;
      for (let i = 0; i < e.ops.length; i++) {
        const c = compare(e.ops[i]._type, xs[i]!, xs[i + 1]!);
        if (c === undefined) return undefined;
        if (!c) return { t: "bool", v: false };
      }
      return { t: "bool", v: true };
    }
    return undefined;
  };
  const truth = (x: K): boolean =>
    x.t === "bool" ? x.v : x.t === "int" ? x.v !== 0n : x.t === "float" ? x.v !== 0 : x.t === "str" ? x.v !== "" :
    x.t === "none" ? false : x.t === "bytes" ? x.v.length > 0 : x.t === "complex" ? x.v.imag !== 0 || !!x.v.real : true;
  // (an int as a BigInt, a bool as 0 or 1; a float as itself)
  const num = (x: K): bigint | number | undefined => (x.t === "int" ? x.v : x.t === "bool" ? (x.v ? 1n : 0n) : x.t === "float" ? x.v : undefined);
  const compare = (op: string, a: K, b: K): boolean | undefined => {
    let p = num(a), q = num(b);
    if (p !== undefined && q !== undefined) {
      // (an int and a float: exactly, only for ints a double holds exactly)
      if (typeof p !== typeof q) {
        const i = (typeof p === "bigint" ? p : q) as bigint;
        if (i > 2n ** 53n || i < -(2n ** 53n)) return undefined;
        p = Number(p); q = Number(q);
      }
      return ({ Lt: p < q, LtE: p <= q, Gt: p > q, GtE: p >= q, Eq: p === q, NotEq: p !== q } as Record<string, boolean>)[op];
    }
    // (by code point, as Python compares strings: REACT-DEEF-1)
    if (a.t === "str" && b.t === "str") {
      const c = [...a.v].map((ch) => ch.codePointAt(0)!), d = [...b.v].map((ch) => ch.codePointAt(0)!);
      let k = 0;
      while (k < c.length && k < d.length && c[k] === d[k]) k++;
      const r = k < c.length && k < d.length ? c[k] - d[k] : c.length - d.length;
      return ({ Lt: r < 0, LtE: r <= 0, Gt: r > 0, GtE: r >= 0, Eq: r === 0, NotEq: r !== 0 } as Record<string, boolean>)[op];
    }
    return undefined;
  };
  const known = (e: any, want: boolean) => { const x = konst(e); return x !== undefined && truth(x) === want; };
  const nonEmpty = (it: any) => ["List", "Tuple", "Set"].includes(it?._type) && it.elts.length > 0 && !it.elts.some((e: any) => e._type === "Starred");
  // (a statement that cannot raise before it binds: `x = 2`)
  const safe = (st: any) => (st?._type === "Assign" || st?._type === "AnnAssign") && st.value?._type === "Constant" && [st.targets ?? [st.target]].flat().every((t: any) => t._type === "Name");
  const mayskip = ([n, k]: [any, string], next: any) =>
    ((n._type === "If" || n._type === "IfExp") && k !== "test" && !(k === "body" && known(n.test, true)) && !(k === "orelse" && known(n.test, false))) ||
    (n._type === "BoolOp" && next && n.values.indexOf(next) > 0 && !n.values.slice(0, n.values.indexOf(next)).every((v: any) => known(v, n.op?._type === "And"))) ||
    (n._type === "Compare" && k === "comparators" && next && n.comparators.indexOf(next) > 0 &&
      !known({ _type: "Compare", left: n.left, ops: n.ops.slice(0, n.comparators.indexOf(next)), comparators: n.comparators.slice(0, n.comparators.indexOf(next)) }, true)) ||
    (n._type === "Assert" && k === "msg") ||
    ((n._type === "For" || n._type === "AsyncFor") && (k === "orelse" || ((k === "body" || k === "target") && !nonEmpty(n.iter)))) ||
    (n._type === "While" && (k === "body" || k === "orelse")) ||
    ((n._type === "Try" || n._type === "TryStar") && k !== "finalbody" && !(k === "body" && safe(n.body[0]) && n.body[0] === next)) ||
    ((n._type === "With" || n._type === "AsyncWith") && k === "body") ||
    (n._type === "Match" && k === "cases" && !(konst(n.subject) !== undefined && next === n.cases[0] && !n.cases[0].guard &&
      ((n.cases[0].pattern?._type === "MatchValue" && compare("Eq", konst(n.cases[0].pattern.value) ?? { t: "none", v: null }, konst(n.subject)!) === true && konst(n.cases[0].pattern.value)?.t === konst(n.subject)?.t) ||
        (n.cases[0].pattern?._type === "MatchAs" && !n.cases[0].pattern.pattern)))) ||
    (COMPS.has(n._type) && k !== "iter0" && !n.generators.every((g: any) => nonEmpty(g.iter) && !g.ifs.length));
  // (whether a binding runs whenever `from` does: nothing between them may skip it;
  // `from` is a path index in s, or the point where s's and r's paths part)
  // (a body reached through a test was reached with the test true: every
  // operand of an `and`, or of a chained comparison, in it ran)
  const surely = (s: Occurrence, from: number, r?: Occurrence) => {
    let start = from;
    const [n, k] = s.path[from] ?? [null, ""];
    if (r && n && k === "test" && (n._type === "If" || n._type === "While" || n._type === "IfExp") && r.path[from]?.[0] === n && r.path[from][1] === "body") {
      // (a true `and` makes each operand true, so an `and` or comparison in
      // one is true too; a true comparison only had its operands evaluated,
      // whatever they hold may have been skipped: REACT-67BD-3)
      start = from + 1;
      while (start < s.path.length && s.path[start][0]._type === "BoolOp" && s.path[start][0].op?._type === "And") start++;
      if (start < s.path.length && s.path[start][0]._type === "Compare") start++;
    }
    return !s.path.slice(start).some((e, i, rest) => mayskip(e, rest[i + 1]?.[0] ?? null));
  };
  const parting = (s: Occurrence, r: Occurrence) => {
    let j = 0;
    while (j < s.path.length && j < r.path.length && s.path[j][0] === r.path[j][0] && s.path[j][1] === r.path[j][1]) j++;
    return j;
  };
  // (a binding inside R runs in every iteration: nothing in R may skip it)
  const everyTime = (s: Occurrence, R: any) => surely(s, s.path.findIndex(([n]) => n === R) + 1);
  const plain = (o: Occurrence) => !o.global && !deferredOf(o);
  for (const r of occ) {
    if (r.store || !plain(r)) continue;
    // (a read after the cell's first binding in that same statement reads
    // the new name: some binding before it there must surely have run,
    // `(1 > 2 < (x := 10), x)` reads the previous x, REACT-E17D-2)
    if (r.stmt === first.stmt && runsBefore(first, r) && plain(first) && !occ.some((s) => s.store && plain(s) && s.stmt === r.stmt && runsBefore(s, r) && surely(s, parting(s, r), r))) return null;
    for (const [R, k] of r.path) {
      if (!repeats(R, k)) continue;
      const there = occ.filter((s) => s.store && plain(s) && inRepeat(s, R));
      if (!there.some((s) => s !== r && runsBefore(r, s))) continue;
      if (there.some((s) => runsBefore(s, r) && everyTime(s, R))) continue;
      // (an augmented assignment binds its target after its value)
      // (and one before R counts only if it surely ran: REACT-E17D-1)
      const boundBefore = (s: Occurrence) => (prefixed && s === first) ||
        (runsBefore(s, r) && surely(s, parting(s, r), r) && !(s.path.at(-1)?.[0]._type === "AugAssign" && s.path.at(-1)?.[1] === "target" && inside(r, s.path.at(-1)![0])));
      if (occ.some((s) => s.store && plain(s) && !inRepeat(s, R) && boundBefore(s))) continue;
      return null;
    }
  }
  for (const o of occ) {
    if (o.global) continue;
    if (o === first) { out.set(o, "new"); continue; }
    // in code that runs later than written (not the class or def defining
    // the name, below): an annotation is read when asked for, after; a
    // callable written after the definition runs after it; one written
    // before, if the cell uses it only after the definition, too; else
    // (used before, or kept nameless) it cannot be told
    const d = deferredOf(o);
    const inDef = first.def && o.path.some(([n]) => n === first.def);
    if (d && !inDef) {
      if (df && d.node === df.node) {
        // (the same function as the definition: in its order, with what an
        // assignment evaluates before binding; a read of the previous value
        // only if the function runs once: a second call reads the new one)
        const old = !o.store && (runsBefore(o, first) || evaluatedFirst(o, first));
        if (old && calls !== 1) return null;
        out.set(o, old ? "old" : "new");
        continue;
      }
      // (an annotation is read when asked for: written after the definition,
      // that is after it; before, it may be asked for before or after)
      if (d.kind === "annotation") {
        if (futureAnnotations || o.stmt <= at.stmt) return null;
        out.set(o, "new");
        continue;
      }
      if (o.stmt > at.stmt) { out.set(o, "new"); continue; }
      // (written before: decorators, a class's decorators, metaclass or
      // body may call it there, REACT-98EB-1)
      const encl = o.path.slice(0, o.path.findIndex(([n]) => n === d.node) + 1).map(([n]) => n);
      if (encl.some((n) => n.decorator_list?.length || (n._type === "ClassDef" && n.keywords?.length))) return null;
      if (encl.some((n, j) => n._type === "ClassDef" && n.body.includes(encl[j + 1]) && encl[j + 1].name && n.body.some((b: any) => b !== encl[j + 1] && mentions(b, [encl[j + 1].name])))) return null;
      const fname = callableName(o, d);
      if (!fname) return null;
      if (usesOf(body, fname).some((u) => u.stmt < at.stmt || (u.stmt === at.stmt && runsBefore(u, at)))) return null;
      out.set(o, "new");
      continue;
    }
    if (df && at.node && inside(o, at.node)) {
      // (the setter's arguments are evaluated before it runs, REACT-98EB-2;
      // not when they store the name or call anything, which may run the
      // setter or store it first, REACT-6748-1)
      if (o.store || hasCall([...at.node.args, ...at.node.keywords])) return null;
      out.set(o, "old");
      continue;
    }
    if (o.stmt > at.stmt || (o.stmt === at.stmt && o.store && !runsBefore(o, at))) { out.set(o, "new"); continue; }
    if (o.stmt < at.stmt) { out.set(o, "old"); continue; }
    if (df) { out.set(o, runsBefore(o, at) ? "old" : "new"); continue; }
    // the same statement
    // (a class's decorators, bases and body, a def's decorators, defaults
    // and annotations run before the name is bound: they read the previous
    // value; what runs later reads the new one: timing)
    const defIdx = first.def ? o.path.findIndex(([n]) => n === first.def) : -1;
    const t = defIdx >= 0 && (first.def._type === "ClassDef" || o.path[defIdx][1] !== "body" || first.def.decorator_list.length) ? timing(o, defIdx, first.def) : "later";
    if (t === "maybe") return null;
    const header = t === "now";
    if (header || evaluatedFirst(o, first)) { out.set(o, "old"); continue; }
    if (runsBefore(o, first)) {
      // (a loop's body repeats; a for loop's iterable runs once, REACT-F813-2)
      if (o.path.some(([n, k]) => LOOPS.has(n._type) && inside(first, n) && !((n._type === "For" || n._type === "AsyncFor") && k === "iter"))) return null;
      out.set(o, "old");
    } else out.set(o, "new");
  }
  for (const g of globals) {
    const f = fnOf(g);
    const store = occ.find((o) => o.store && !o.global && f && fnOf(o) === f);
    out.set(g, store ? out.get(store)! : g.stmt > first.stmt || (g.stmt === first.stmt && !before(g, first)) ? "new" : "old");
  }
  return out;
}

/**
 * Rename global `name` to `to` in a cell's source.  `from`: "all" renames
 * every occurrence (a cell reading the renamed definition); "definition"
 * keeps the occurrences before the cell first binds the name, and the reads
 * in the statement that binds it (`x = x + 1` -> `x_2 = x + 1`).  Returns the
 * new source, or null if it cannot be done reliably (Magma; a Sage cell
 * whose occurrences do not correspond after preparsing; a syntax error).
 */
export function renameInCell(source: string, name: string, to: string, opts: { mode?: Mode; from?: "all" | "definition"; before?: string } = {}): string | null {
  if (opts.mode === "magma") return null;
  const analyzed = opts.mode === "sage" ? preparse(source) : source;
  let tree: any;
  try {
    tree = parse(analyzed, "exec");
  } catch {
    return null;
  }
  const aLines = analyzed.split("\n");
  let occ = occurrences(tree, name, aLines);
  // each occurrence's new name: `to`, or (from the definition) `before` for those before it
  const target = new Map<Occurrence, string>();
  let prefix: { line: number; text: string } | null = null;
  if (opts.from === "definition") {
    const first = occ.find((o) => o.store);
    if (!first) return source;
    const old = opts.before ?? name;
    SOURCE = aLines;
    FUTURE = tree.body.some((st: any) => st._type === "ImportFrom" && st.module === "__future__" && st.names.some((a: any) => a.name === "annotations"));
    const reads = whichReads(occ, first, tree.body);
    if (!reads) return null;
    for (const o of occ) target.set(o, reads.get(o) === "old" ? old : to);
    // `x += 1` defining the new x: `xʹ2 = x; xʹ2 += 1` (at the top level only)
    const aug = first.path.at(-1);
    if (aug?.[0]._type === "AugAssign" && aug[1] === "target") {
      const st = aug[0];
      if (first.path.length !== 1 || st.col_offset !== 0) return null;
      prefix = { line: st.lineno, text: `${to} = ${old}; ` };
    }
  } else for (const o of occ) target.set(o, to);
  if (occ.some((o) => o.maybe && target.get(o) !== name)) return null;
  occ = occ.filter((o) => target.get(o) !== name);
  if (!occ.length && !prefix) return source;
  if (occ.some((o) => o.alias === null && target.get(o) !== name)) return null;
  const lines = source.split("\n");
  // positions in the original source: the same for Python; for Sage, the
  // k-th occurrence of the name on a line, as a whole word outside strings
  // and comments, if the counts agree
  const byLine = new Map<number, Occurrence[]>();
  for (const o of occ) (byLine.get(o.line) ?? byLine.set(o.line, []).get(o.line)!).push(o);
  for (const [ln, os] of byLine) {
    const text = lines[ln - 1];
    if (text === undefined) return null;
    let spans: [number, number][] = [];
    const reps: [number, number, string][] = [];
    if (opts.mode === "sage") {
      if (aLines.length !== lines.length) return null;
      const orig = wordSpans(text, name), ana = wordSpans(aLines[ln - 1], name);
      const targets = new Set(os.map((o) => target.get(o)));
      if (orig.length !== ana.length) {
        // the preparser added occurrences (`K.<a> = ...` is `K = ...; (a,) =
        // K._first_ngens(1)`): if they all get the same name, every one on
        // the line as written does (there are no others to keep)
        if (targets.size !== 1 || os.some((o) => o.alias) || ana.length !== os.length) return null;
        reps.push(...orig.map(([a, b]) => [a, b, [...targets][0]!] as [number, number, string]));
        os.length = 0;
      } else {
        const aText = aLines[ln - 1];
        spans = os.map((o) => {
          const i = ana.findIndex(([s]) => bytesLen(aText.slice(0, s)) === o.col);
          return i < 0 ? null : orig[i];
        }).filter((x): x is [number, number] => x !== null);
        if (spans.length !== os.length) return null;
      }
    } else {
      spans = os.map((o) => [byteSlice(text, 0, o.col).length, byteSlice(text, 0, o.end).length]);
    }
    // (with the occurrence's replacement: `x as to` for an import of x)
    reps.push(...spans.map(([s, e], i) => { const t = target.get(os[i])!; return [s, e, os[i].alias ? `${os[i].alias} as ${t}` : t] as [number, number, string]; }));
    reps.sort((a, b) => b[0] - a[0]);
    let t = text;
    for (const [s, e, r] of reps) t = t.slice(0, s) + r + t.slice(e);
    lines[ln - 1] = t;
  }
  if (prefix) lines[prefix.line - 1] = prefix.text + lines[prefix.line - 1];
  return lines.join("\n");
}

// The spans of `name` as a whole word in a line, outside strings and comments
// and not as an attribute (`.name`).
function wordSpans(line: string, name: string): [number, number][] {
  const out: [number, number][] = [];
  // (names of any script)
  const re = /(#.*)|((?:\b[rRbBuUfF]{1,2})?(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?))|([\p{L}_][\p{L}\p{N}\p{Mn}\p{Mc}_]*)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[3] !== name || line[m.index - 1] === ".") continue;
    // (not a keyword argument: f(name=...))
    if (/[(,]\s*$/.test(line.slice(0, m.index)) && /^\s*=(?!=)/.test(line.slice(m.index + name.length))) continue;
    out.push([m.index, m.index + name.length]);
  }
  return out;
}

/**
 * The renames that give `name` one defining cell, keeping the meaning of the
 * cells in page order: each later cell defining it gets a new name (name_2,
 * name_3, ...), and the cells below it read that one, until the next.
 * `cells`: the code cells in page order, with whether each defines and reads
 * `name`; `taken`: names in use.  Returns the new sources (by id) or null.
 */
export function renameRedefinitions(
  cells: { id: string; code: string; defines: boolean; reads: boolean }[],
  name: string,
  taken: Set<string>,
  mode: Mode = "python",
  sep = "_",
): Map<string, string> | null {
  const out = new Map<string, string>();
  let current = name, k = 1, seen = false;
  const fresh = () => {
    let n: string;
    do n = `${name}${sep}${++k}`;
    while (taken.has(n));
    taken.add(n);
    return n;
  };
  for (const c of cells) {
    if (c.defines && seen) {
      const to = fresh();
      // its reads before its definition are of the previous name (one pass: a Sage
      // cell is mapped back through the preparser by the original name)
      let code = renameInCell(c.code, name, to, { mode, from: "definition", ...(current === name ? {} : { before: current }) });
      if (code === null) return null;
      if (code === c.code && mode === "sage") code = renameVar(c.code, name, to, current);
      if (code === null || code === c.code) return null;
      // (Sage: var('x') also sets the global x, the first definition's: SR.var does not)
      if (mode === "sage") code = srVar(code, name);
      out.set(c.id, code);
      current = to;
    } else if (c.defines) {
      seen = true;
    } else if (c.reads && current !== name) {
      const code = renameInCell(c.code, name, current, { mode });
      if (code === null) return null;
      out.set(c.id, code);
    }
  }
  return out;
}

// A Sage cell defining the name only by `var('x')` on a line of its own:
// `xʹ2 = SR.var('x')` (which binds it without setting the global x); its
// earlier reads, of the previous name, renamed.  Null if it is not that simple.
function renameVar(source: string, name: string, to: string, before: string): string | null {
  const lines = source.split("\n");
  const re = new RegExp(`^(\\s*)var\\(\\s*(['"])${name}\\2\\s*\\)\\s*$`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0 || /^\s/.test(lines[i])) return null;
  let head = lines.slice(0, i).join("\n"), tail = lines.slice(i + 1).join("\n");
  if (before !== name && head) {
    const h = renameInCell(head, name, before, { mode: "sage" });
    if (h === null) return null;
    head = h;
  }
  if (tail) {
    const t = renameInCell(tail, name, to, { mode: "sage" });
    if (t === null) return null;
    tail = t;
  }
  return [...(i ? [head] : []), `${to} = SR.var(${JSON.stringify(name)})`, ...(i + 1 < lines.length ? [tail] : [])].join("\n");
}

// In Sage code, `var('... name ...')` calls (outside strings and comments) as
// SR.var(...), which binds without setting the global.
function srVar(code: string, name: string): string {
  // (the whole cell at once: a triple-quoted string may span lines)
  const re = /(#[^\n]*)|((?:\b[rRbBuUfF]{1,2})?(?:"""(?:\\[\s\S]|(?!""")[^\\])*(?:"""|$)|'''(?:\\[\s\S]|(?!''')[^\\])*(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?))|([\p{L}_][\p{L}\p{N}\p{Mn}\p{Mc}_]*)/gu;
  const at: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[3] !== "var" || code[m.index - 1] === ".") continue;
    const call = /^\s*\(\s*(['"])([^'"]*)\1/.exec(code.slice(m.index + 3));
    if (call && call[2].split(/[\s,]+/).includes(name)) at.push(m.index);
  }
  for (const i of at.reverse()) code = code.slice(0, i) + "SR." + code.slice(i);
  return code;
}

/**
 * Page-order scoping renames a definition (`class Cʹ2`).  So that it is
 * made under its written name (its `__name__`, `__qualname__`, code names,
 * what decorators and metaclasses see), each top-level def or class (also in
 * if, for, with, try blocks) whose name `scoped` maps to a name as written is
 * made under that name, between `__sb_push__(globals(), "C")`, which keeps
 * the previous C, and `__sb_pop__(globals(), "C", "Cʹ2")`, which moves the new
 * one to Cʹ2 and puts the previous C back.  And f-strings' `{x=}` text and
 * t-strings' expressions show the names as written.  In place, in pyparse's
 * tree, at the definition's positions (no line moves).  The interpreter
 * defines the two functions in its builtins (RENAME_HELPER).
 */
export function restoreDefNames(tree: any, scoped: Record<string, string>): void {
  const keys = Object.keys(scoped);
  if (!keys.length) return;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_\u02b9])(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}\\p{Mn}\\p{Mc}_\u02b9])`, "gu");
  const written = (t: string) => t.replace(re, (k) => scoped[k]);
  // (source text Python keeps: f"{x=}"'s label, a t-string's expression)
  const texts = (n: any): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(texts);
    if ((n._type === "JoinedStr" || n._type === "TemplateStr") && Array.isArray(n.values)) for (const v of n.values) if (v?._type === "Constant" && typeof v.value === "string") v.value = written(v.value);
    if (n._type === "Interpolation" && typeof n.str === "string") n.str = written(n.str);
    for (const k of Object.keys(n)) if (k !== "_type") texts(n[k]);
  };
  texts(tree.body);
  // (`globals`: in a function, the `global` statements naming the module's
  // names, or null at the top level; a definition there of an internal name
  // the function declares global is lowered too, with the written name
  // declared global as well)
  const fix = (list: any[], globals: any[] | null): any[] => {
    const out: any[] = [];
    for (const st of list) {
      const isDef = st._type === "FunctionDef" || st._type === "AsyncFunctionDef" || st._type === "ClassDef";
      if (!isDef) {
        for (const key of ["body", "orelse", "finalbody"]) if (Array.isArray(st[key])) st[key] = fix(st[key], globals);
        if (Array.isArray(st.handlers)) for (const h of st.handlers) h.body = fix(h.body, globals);
        if (Array.isArray(st.cases)) for (const c of st.cases) c.body = fix(c.body, globals);
      } else {
        // (a function's or class's body: its `global` statements)
        const gs: any[] = [];
        const scan = (n: any): void => {
          if (!n || typeof n !== "object") return;
          if (Array.isArray(n)) return n.forEach(scan);
          if (n._type === "Global") gs.push(n);
          if (n._type === "FunctionDef" || n._type === "AsyncFunctionDef" || n._type === "ClassDef" || n._type === "Lambda") return;
          for (const k of Object.keys(n)) if (k !== "_type") scan(n[k]);
        };
        scan(st.body);
        st.body = fix(st.body, gs);
      }
      const declared = globals === null || globals.some((g) => g.names.includes(st.name));
      const w = isDef && declared && Object.hasOwn(scoped, st.name) ? scoped[st.name] : null;
      if (w === null) {
        out.push(st);
        continue;
      }
      const at = (n: any) => ({ lineno: n.lineno, col_offset: n.col_offset, end_lineno: n.lineno, end_col_offset: n.col_offset });
      const call = (fn: string, args: string[], pos: any) => {
        const nm = (id: string) => ({ _type: "Name", id, ctx: { _type: "Load" }, ...pos });
        // ((lambda: 0).__globals__: the module's globals, whatever names the
        // code binds, `globals` included)
        const noArgs = { _type: "arguments", posonlyargs: [], args: [], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [] };
        const g = { _type: "Attribute", value: { _type: "Lambda", args: noArgs, body: { _type: "Constant", value: 0, kind: null, ...pos }, ...pos }, attr: "__globals__", ctx: { _type: "Load" }, ...pos };
        return { _type: "Expr", value: { _type: "Call", func: nm(fn), args: [g, ...args.map((v) => ({ _type: "Constant", value: v, kind: null, ...pos }))], keywords: [], ...pos }, ...pos };
      };
      const internal = st.name;
      st.name = w;
      if (globals) for (const g of globals) if (g.names.includes(internal) && !g.names.includes(w)) g.names.push(w);
      out.push(call("__sb_push__", [w], at(st)), st, call("__sb_pop__", [w, internal], { lineno: st.end_lineno, col_offset: st.end_col_offset, end_lineno: st.end_lineno, end_col_offset: st.end_col_offset }));
    }
    return out;
  };
  tree.body = fix(tree.body, null);
}

/** Python defining `__sb_push__` and `__sb_pop__` in the builtins (restoreDefNames). */
export const RENAME_HELPER = `import builtins as _b
def _sb_lowering():
    missing = object()
    saved = []
    def push(g, w):
        saved.append((w, g.get(w, missing)))
    def pop(g, w, n):
        g[n] = g[w]
        while saved:
            sw, v = saved.pop()
            if sw == w:
                break
        else:
            return
        if v is missing:
            g.pop(w, None)
        else:
            g[w] = v
    return push, pop
_b.__sb_push__, _b.__sb_pop__ = _sb_lowering()
del _b, _sb_lowering
`;
