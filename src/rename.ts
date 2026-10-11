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
// operand, a conditional expression's branches, a comprehension's body).
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
    const m = new RegExp(`\\b(?:def|class)\\s+(${name})\\b`).exec(text);
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
      if (d) out.push({ line: n.lineno, col: d[0], end: d[1], store: true, stmt, path });
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
        const o: Occurrence = { line: n.lineno, col: n.col_offset, end: n.end_col_offset, store: n.ctx?._type !== "Load", stmt, path };
        if (!shadowed) out.push(o);
        else if (shadowed !== true) {
          // (a class body's `x += 1` reads the global and binds the attribute:
          // not renamable)
          const aug = path.at(-1)?.[0]._type === "AugAssign" && path.at(-1)?.[1] === "target";
          if (!o.store || aug) out.push({ ...o, store: false, ...(shadowed === "maybe" || aug ? { maybe: true as const } : {}) });
        }
        return;
      }
      case "FunctionDef": case "AsyncFunctionDef": case "Lambda": {
        // decorators, defaults and annotations are evaluated outside
        walk(n.decorator_list, shadowed, stmt, under("decorator_list"), fn);
        walk(n.args?.defaults, shadowed, stmt, under("args"), fn);
        walk(n.args?.kw_defaults, shadowed, stmt, under("args"), fn);
        walk(n.returns, shadowed, stmt, under("returns"), fn);
        if (n._type !== "Lambda" && n.name === name && !shadowed) {
          const p = defName(n);
          if (p) out.push({ line: n.lineno, col: p[0], end: p[1], store: true, stmt, path });
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
        walk(gens[0]?.iter, shadowed, stmt, under("generators"), fn);
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
          const text = lines[n.lineno - 1] ?? "";
          const m = new RegExp(`\\bglobal\\b[^#]*?\\b(${name})\\b`).exec(text);
          if (m) {
            const start = bytesLen(text.slice(0, m.index + m[0].length - name.length));
            out.push({ line: n.lineno, col: start, end: start + bytesLen(name), store: false, stmt, path, global: true });
          }
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
function whichReads(occ: Occurrence[], first: Occurrence): Map<Occurrence, "old" | "new"> | null {
  const out = new Map<Occurrence, "old" | "new">();
  const before = (a: Occurrence, b: Occurrence) => a.line < b.line || (a.line === b.line && a.col < b.col);
  const inside = (o: Occurrence, node: any) => o.path.some(([n]) => n === node);
  const LOOPS = new Set(["For", "AsyncFor", "While"]);
  // (a `global x` takes the name of the assignments in its function, if any)
  const globals = occ.filter((o) => o.global);
  const fnOf = (o: Occurrence) => [...o.path].reverse().find(([n]) => n._type === "FunctionDef" || n._type === "AsyncFunctionDef")?.[0];
  for (const o of occ) {
    if (o.global) continue;
    if (o === first || o.stmt > first.stmt || (o.stmt === first.stmt && o.store && !before(o, first))) { out.set(o, "new"); continue; }
    if (o.stmt < first.stmt) { out.set(o, "old"); continue; }
    // the same statement
    const evaluatedFirst = o.path.some(([n, key]) =>
      ((n._type === "Assign" || n._type === "AnnAssign" || n._type === "AugAssign") && key === "value" && inside(first, n)) ||
      ((n._type === "For" || n._type === "AsyncFor") && key === "iter" && inside(first, n)) ||
      (n._type === "NamedExpr" && key === "value" && inside(first, n)) ||
      (n._type === "withitem" && key === "context_expr" && inside(first, n)));
    if (evaluatedFirst) { out.set(o, "old"); continue; }
    if (before(o, first)) {
      if (o.path.some(([n]) => LOOPS.has(n._type) && inside(first, n))) return null;
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
    const reads = whichReads(occ, first);
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
