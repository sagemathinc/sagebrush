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
}

const BINDING_TYPES = new Set(["FunctionDef", "AsyncFunctionDef", "ClassDef"]);
// CPython's columns are UTF-8 byte offsets
const enc = new TextEncoder(), dec = new TextDecoder();
const bytesLen = (s: string) => enc.encode(s).length;
const byteSlice = (s: string, a: number, b?: number) => dec.decode(enc.encode(s).subarray(a, b));

/** The occurrences of global `name` in a module's AST. */
function occurrences(tree: any, name: string, lines: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  // the names a function (or lambda, comprehension) body binds, minus its `global`s
  const localsOf = (body: any[], params: string[]): Set<string> => {
    const bound = new Set(params), glob = new Set<string>();
    const scan = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(scan);
      switch (n._type) {
        case "Global": case "Nonlocal": for (const g of n.names) glob.add(g); return;
        case "Name": if (n.ctx?._type !== "Load") bound.add(n.id); return;
        case "FunctionDef": case "AsyncFunctionDef": case "ClassDef": bound.add(n.name); scan(n.decorator_list); return;
        case "Lambda": case "ListComp": case "SetComp": case "DictComp": case "GeneratorExp": return; // (their own scopes)
        case "alias": bound.add((n.asname ?? n.name).split(".")[0]); return;
        case "ExceptHandler": if (n.name) bound.add(n.name); break;
        case "MatchAs": case "MatchStar": if (n.name) bound.add(n.name); break;
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
  const walk = (n: any, shadowed: boolean, stmt: number, path: [any, string][] = []): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => walk(x, shadowed, stmt, path));
    if (typeof n._type !== "string") return;
    const under = (key: string): [any, string][] => [...path, [n, key]];
    switch (n._type) {
      case "Name":
        if (n.id === name && !shadowed) out.push({ line: n.lineno, col: n.col_offset, end: n.end_col_offset, store: n.ctx?._type !== "Load", stmt, path });
        return;
      case "FunctionDef": case "AsyncFunctionDef": case "Lambda": {
        // decorators, defaults and annotations are evaluated outside
        walk(n.decorator_list, shadowed, stmt, under("decorator_list"));
        walk(n.args?.defaults, shadowed, stmt, under("args"));
        walk(n.args?.kw_defaults, shadowed, stmt, under("args"));
        walk(n.returns, shadowed, stmt, under("returns"));
        if (n._type !== "Lambda" && n.name === name && !shadowed) {
          const p = defName(n);
          if (p) out.push({ line: n.lineno, col: p[0], end: p[1], store: true, stmt, path });
        }
        const body = n._type === "Lambda" ? [n.body] : n.body;
        walk(body, shadowed || localsOf(body, params(n.args)).has(name), stmt, under("body"));
        return;
      }
      case "ClassDef":
        walk(n.decorator_list, shadowed, stmt, under("decorator_list"));
        walk(n.bases, shadowed, stmt, under("bases"));
        walk(n.keywords, shadowed, stmt, under("keywords"));
        if (n.name === name && !shadowed) {
          const p = defName(n);
          if (p) out.push({ line: n.lineno, col: p[0], end: p[1], store: true, stmt, path });
        }
        // (a class body's own bindings are its attributes; methods do not see them)
        {
          const attr = shadowed || localsOf(n.body.filter((s: any) => !BINDING_TYPES.has(s._type)), []).has(name);
          for (const st of n.body) walk(st, BINDING_TYPES.has(st._type) ? shadowed : attr, stmt, under("body"));
        }
        return;
      case "ListComp": case "SetComp": case "GeneratorExp": case "DictComp": {
        const gens = n.generators;
        // the first iterable is evaluated outside
        walk(gens[0]?.iter, shadowed, stmt, under("generators"));
        const targets = new Set<string>();
        for (const g of gens) localsOf([g.target], []).forEach((t) => targets.add(t));
        const inner = shadowed || targets.has(name);
        gens.forEach((g: any, i: number) => { walk(g.target, inner, stmt, under("generators")); if (i) walk(g.iter, inner, stmt, under("generators")); walk(g.ifs, inner, stmt, under("generators")); });
        walk(n._type === "DictComp" ? [n.key, n.value] : [n.elt], inner, stmt, under("elt"));
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
            out.push({ line: n.lineno, col: start, end: start + bytesLen(name), store: false, stmt, path });
          }
        }
        return;
      }
      case "Attribute": walk(n.value, shadowed, stmt, under("value")); return; // (not the attribute's name)
      case "keyword": walk(n.value, shadowed, stmt, under("value")); return; // (not the argument's name)
    }
    for (const k of Object.keys(n)) if (k !== "_type") walk(n[k], shadowed, stmt, under(k));
  };
  tree.body.forEach((st: any, i: number) => walk(st, false, i, []));
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
  for (const o of occ) {
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
    occ = occ.filter((o) => target.get(o) !== name);
  } else for (const o of occ) target.set(o, to);
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
      if (mode === "sage") code = code.replace(/(^|[^\w.\u02b9])var\((\s*)(['"])([^'"]*)\3/g, (all, pre, sp, q, names) => (names.split(/[\s,]+/).includes(name) ? `${pre}SR.var(${sp}${q}${names}${q}` : all));
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
