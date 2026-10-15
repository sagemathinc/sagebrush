// IPython's magic syntax in notebook cells and interactive input, in two steps.
//
// 1. magicSyntax (text): at the start of a statement,
//      %name args       a line magic (indented too)
//      %%name args      a cell magic, on the cell's first line
//      !command         a shell command (Sagebrush has no shell: an error)
//    become calls of the builtins __pyjs_magic__(name, args) and
//    __pyjs_cell_magic__(name, args[, body]), as IPython turns them into
//    get_ipython().run_line_magic(...).  Such lines are never valid Python.
//    A lexer follows Python's strings (prefixes, triple quotes, backslash
//    continuations, f-strings' replacement fields with their own strings),
//    brackets and backslash continuations, so nothing inside a string or a
//    continued statement is touched; a magic's line is opaque (its argument
//    may hold an unbalanced quote).
//
// 2. expandMagics (tree): the code %time, %timeit, %%time and %%timeit run
//    becomes part of the cell's own tree, where it was written, so it is
//    compiled with the cell (Sage's syntax, the reactive notebook's renamed
//    names, a function's locals) and analyzed with it:
//      %time S          with __pyjs_magic_api__("timer")(): S
//      %time E          with <timer>: <keep>(E)     then <kept>()  (shown: E's value)
//      %timeit [opts] S def F(IT, CLOCK): T0 = CLOCK(); for I in IT: S ...; return CLOCK() - T0
//                       __pyjs_magic_api__("timeit_run")(opts, F, top)
//    so %time's code is in its own scope (walrus, locals(), a class body),
//    %timeit's assignments are its own (a function's), as in IPython, and
//    %%time's and %%timeit's bodies keep their lines.  F, IT, CLOCK, T0 and I
//    are fresh names, used nowhere in the cell.  The other magics stay calls
//    (lib/_pyjs_magic.py).
import { parse as pyparse } from "../pyparse/src/index";
import { preparse } from "./sagepre";

const LINE_MAGIC = /^(\s*)%([A-Za-z_][\w.]*)(.*)$/;
const CELL_MAGIC = /^%%([A-Za-z_][\w.]*)(.*)$/;
const SHELL = /^(\s*)!(.*)$/;
// magics whose argument (or body) is code, expanded into the tree
const CODE_MAGICS = new Set(["time", "timeit"]);

// The session's Python around cells: %autoreload (lib/_pyjs_magic.py), before and after a Python cell, once its extension is loaded
export const MAGIC_PRE = "import sys as _s\n_a = _s.modules.get('_pyjs_magic')\nif _a is not None: _a.pre_run_cell()\n";
// (after code that imported sys as _s)
export const MAGIC_POST = "_a = _s.modules.get('_pyjs_magic')\nif _a is not None: _a.post_run_cell()\n";
export const GET_IPYTHON = "import builtins as _b\ndef get_ipython():\n    from _pyjs_magic import get_ipython as _g\n    return _g()\n_b.get_ipython = get_ipython\ndel _b, get_ipython\n";

// Python string literals as JSON gives them, which Python reads the same
// (\uXXXX escapes, no \/)
const lit = (s: string) => JSON.stringify(s);

// ------------------------------------------------------------------ the lexer

type Ctx =
  | { k: "code"; depth: number }
  | { k: "str"; q: string; raw: boolean; f: boolean }   // q: the closing quote(s)
  | { k: "fexpr"; depth: number }                        // an f-string's {...}
  | { k: "fspec" };                                      // its :format spec
const STRING_PREFIX = /^(?:[rRuUbBfFtT]|[bB][rR]|[rR][bB]|[fF][rR]|[rR][fF]|[tT][rR]|[rR][tT])$/;
const IDENT = /[\p{L}\p{N}_]/u;

class Lexer {
  stack: Ctx[] = [{ k: "code", depth: 0 }];
  continued = false;

  /** Whether the next line starts a statement. */
  atStatement(): boolean {
    const base = this.stack[0] as { depth: number };
    return this.stack.length === 1 && base.depth === 0 && !this.continued;
  }

  line(s: string) {
    this.continued = false;
    let strContinued = false;   // (a string's text continued with \ at the line's end)
    let i = 0;
    while (i < s.length) {
      const top = this.stack[this.stack.length - 1];
      const c = s[i];
      if (top.k === "str") {
        if (c === "\\") {
          // (an escaped character, or a continued line at the end; in an
          // f-string, \{ still opens a field)
          if (i === s.length - 1) strContinued = true;
          i += top.f && (s[i + 1] === "{" || s[i + 1] === "}") ? 1 : 2;
          continue;
        }
        if (top.f && c === "{") {
          if (s[i + 1] === "{") i += 2;
          else { this.stack.push({ k: "fexpr", depth: 0 }); i++; }
          continue;
        }
        if (top.f && c === "}") { i += s[i + 1] === "}" ? 2 : 1; continue; }
        if (s.startsWith(top.q, i)) { this.stack.pop(); i += top.q.length; continue; }
        i++;
        continue;
      }
      if (top.k === "fspec") {
        if (c === "{") this.stack.push({ k: "fexpr", depth: 0 });
        else if (c === "}") { this.stack.pop(); this.stack.pop(); }
        i++;
        continue;
      }
      // code, or an f-string's replacement field
      if (c === "#") break;
      if (c === "'" || c === '"') {
        let p = i;
        while (p > 0 && /[A-Za-z]/.test(s[p - 1])) p--;
        const prefix = s.slice(p, i);
        const ok = prefix === "" || (STRING_PREFIX.test(prefix) && !(p > 0 && IDENT.test(s[p - 1])));
        const pre = ok ? prefix.toLowerCase() : "";
        const triple = s.startsWith(c.repeat(3), i);
        const q = triple ? c.repeat(3) : c;
        this.stack.push({ k: "str", q, raw: pre.includes("r"), f: pre.includes("f") || pre.includes("t") });
        i += q.length;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") top.depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (top.k === "fexpr" && top.depth === 0 && c === "}") { this.stack.pop(); i++; continue; }
        top.depth = Math.max(0, top.depth - 1);
      } else if (top.k === "fexpr" && top.depth === 0 && c === ":") this.stack.push({ k: "fspec" });
      else if (c === "\\" && i === s.length - 1) this.continued = true;
      i++;
    }
    // A line's end inside a one-line string's text ends it, unless the line
    // is continued with \ (an unterminated string is the compiler's error to
    // report).  An f-string's replacement field may go on to the next line
    // (Python 3.12+), and so may a triple-quoted string.
    const top = this.stack[this.stack.length - 1];
    if (top.k === "str" && top.q.length === 1 && !strContinued) this.stack.pop();
  }
}

// %timeit's options, as lib/_pyjs_magic.py reads them: [options, statement]
export function splitTimeit(args: string): [string, string] {
  const words = args.split(" ");
  let i = 0;
  const opts: string[] = [];
  while (i < words.length) {
    const w = words[i];
    if (w === "") { i++; continue; }
    if (!(w.length > 1 && w[0] === "-" && /[A-Za-z]/.test(w[1]))) break;
    opts.push(w);
    if (["-n", "-r", "-p"].includes(w) && i + 1 < words.length) opts.push(words[++i]);
    i++;
  }
  return [opts.join(" "), words.slice(i).join(" ")];
}

export function magicSyntax(src: string): string {
  if (!src.includes("%") && !src.includes("!")) return src;
  const lines = src.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const before = lines.slice(0, Math.max(first, 0));
  const head = (s: string) => before.concat([s]);
  if (first >= 0) {
    const m = CELL_MAGIC.exec(lines[first]);
    if (m) {
      const name = m[1], args = m[2].trim();
      // %%time takes nothing on its line (IPython refuses a statement there);
      // %%timeit's line is its options and setup.  Their bodies stay code,
      // on their own lines (expandMagics); other cell magics' bodies are text.
      if (CODE_MAGICS.has(name) && !(name === "time" && args !== "")) {
        // (its body's own line magics too, as IPython runs them)
        return head(`__pyjs_cell_magic__(${lit(name)}, ${lit(args)})`).concat(lineMagics(lines.slice(first + 1))).join("\n");
      }
      return head(`__pyjs_cell_magic__(${lit(name)}, ${lit(args)}, ${lit(lines.slice(first + 1).join("\n"))})`).join("\n");
    }
  }
  return lineMagics(lines).join("\n");
}

function lineMagics(lines: string[]): string[] {
  const lex = new Lexer();
  const out: string[] = [];
  for (const line of lines) {
    if (lex.atStatement()) {
      let m = LINE_MAGIC.exec(line);
      if (m) { out.push(`${m[1]}__pyjs_magic__(${lit(m[2])}, ${lit(m[3].trim())})`); continue; }
      m = SHELL.exec(line);
      if (m && !m[2].startsWith("=")) { out.push(`${m[1]}__pyjs_magic__("system", ${lit(m[2].trim())})`); continue; }
    }
    lex.line(line);
    out.push(line);
  }
  return out;
}

// ------------------------------------------------------------------ the tree

type Node = { _type: string; [k: string]: any };
const STMT_LISTS = ["body", "orelse", "finalbody"];

/** The code of a cell magic's line or a line magic: statements, or null if
 *  it does not parse (the call stays, and raises the SyntaxError when run). */
type ParseCode = (code: string) => Node[] | null;
export function codeParser(sage: boolean): ParseCode {
  return (code) => {
    try {
      return pyparse(sage ? preparse(code) : code, "exec", { sage }).body;
    } catch {
      return null;
    }
  };
}

function at(line: number, col: number) {
  return { lineno: line, col_offset: col, end_lineno: line, end_col_offset: col };
}
// every node of a parsed snippet on the magic's line
function relocate(node: any, line: number, col: number) {
  if (Array.isArray(node)) { for (const n of node) relocate(n, line, col); return; }
  if (!node || typeof node !== "object") return;
  if ("lineno" in node) {
    node.lineno = line;
    node.end_lineno = line;
    node.col_offset = col + (node.col_offset ?? 0);
    node.end_col_offset = col + (node.end_col_offset ?? 0);
  }
  for (const k of Object.keys(node)) if (k !== "_type") relocate(node[k], line, col);
}

const magicCall = (st: Node, fn: string): [string, string, Node[]] | null => {
  if (st._type !== "Expr" || st.value._type !== "Call") return null;
  const c = st.value;
  if (c.func._type !== "Name" || c.func.id !== fn || c.keywords.length) return null;
  if (!c.args.every((a: Node) => a._type === "Constant" && typeof a.value === "string")) return null;
  return [c.args[0]?.value, c.args[1]?.value, c.args.slice(2)];
};

// every identifier in a tree (names, arguments, definitions, attributes,
// keywords, imports), so that fresh names can avoid them
function identifiers(tree: any): Set<string> {
  const out = new Set<string>();
  const walk = (n: any) => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (!n || typeof n !== "object") return;
    for (const k of ["id", "arg", "name", "attr", "asname"]) if (typeof n[k] === "string") out.add(n[k]);
    if ((n._type === "Global" || n._type === "Nonlocal") && Array.isArray(n.names)) for (const x of n.names) out.add(x);
    for (const k of Object.keys(n)) if (k !== "_type") walk(n[k]);
  };
  walk(tree);
  return out;
}
// a name like _pyjs_timeit_3f9a0c2b1d4e, in no use in the cell
function freshNamer(taken: Set<string>) {
  return (base: string) => {
    for (;;) {
      const n = `_pyjs_${base}_${Math.floor(Math.random() * 2 ** 48).toString(16).padStart(12, "0")}`;
      if (!taken.has(n)) { taken.add(n); return n; }
    }
  };
}

function builders(line: number, col: number, fresh: (base: string) => string) {
  const F = fresh("timeit"), IT = fresh("it"), CLOCK = fresh("clock"), T0 = fresh("t0"), I = fresh("i");
  const p = at(line, col);
  const name = (id: string, store = false): Node => ({ _type: "Name", id, ctx: { _type: store ? "Store" : "Load" }, ...p });
  const str = (v: string): Node => ({ _type: "Constant", value: v, kind: null, ...p });
  const call = (func: Node, args: Node[]): Node => ({ _type: "Call", func, args, keywords: [], ...p });
  const api = (fn: string) => call(name("__pyjs_magic_api__"), [str(fn)]);
  const noArgs = (names: string[] = []) => ({
    _type: "arguments", posonlyargs: [], vararg: null, kwonlyargs: [], kw_defaults: [], kwarg: null, defaults: [],
    args: names.map((a) => ({ _type: "arg", arg: a, annotation: null, type_comment: null, ...p })),
  });
  const expr = (value: Node): Node => ({ _type: "Expr", value, ...p });
  return {
    p, name, str, call, api, expr,
    withTimer: (body: Node[]): Node => ({ _type: "With", items: [{ _type: "withitem", context_expr: call(api("timer"), []), optional_vars: null }], body, type_comment: null, ...p }),
    // def F(IT, CLOCK): setup; T0 = CLOCK(); for I in IT: body; return CLOCK() - T0
    timeitDef: (setup: Node[], body: Node[]): Node => ({
      _type: "FunctionDef", name: F, args: noArgs([IT, CLOCK]), decorator_list: [], returns: null, type_comment: null, type_params: [], ...p,
      body: [
        ...setup,
        { _type: "Assign", targets: [name(T0, true)], value: call(name(CLOCK), []), type_comment: null, ...p },
        { _type: "For", target: name(I, true), iter: name(IT), body: body.length ? body : [{ _type: "Pass", ...p }], orelse: [], type_comment: null, ...p },
        { _type: "Return", value: { _type: "BinOp", left: call(name(CLOCK), []), op: { _type: "Sub" }, right: name(T0), ...p }, ...p },
      ],
    }),
    timeitRun: (opts: string, top: boolean): Node => expr(call(api("timeit_run"), [str(opts), name(F), { _type: "Constant", value: top, kind: null, ...p }])),
  };
}

/** Expand %time, %timeit, %%time and %%timeit into the tree (see above). */
export function expandMagics(tree: Node, parseCode: ParseCode) {
  const body: Node[] = tree.body ?? [];
  // (the code of every magic in the cell, parsed, for the names it uses)
  const taken = identifiers(tree);
  const fresh = freshNamer(taken);
  const reserve = (nodes: Node[] | null) => { if (nodes) for (const n of identifiers(nodes)) taken.add(n); return nodes; };
  const walk = (stmts: Node[], top: boolean) => {
    for (let i = 0; i < stmts.length; i++) {
      const st = stmts[i];
      const lm = magicCall(st, "__pyjs_magic__");
      if (lm && CODE_MAGICS.has(lm[0]) && lm[2].length === 0) {
        const [mname, args] = lm;
        const [opts, code] = mname === "timeit" ? splitTimeit(args) : ["", args];
        const parsed = code.trim() ? reserve(parseCode(code)) : null;
        if (parsed === null || parsed.length === 0) continue;    // (the call reports it)
        relocate(parsed, st.lineno, st.col_offset);
        const b = builders(st.lineno, st.col_offset, fresh);
        let repl: Node[];
        if (mname === "time") {
          // an expression's value: kept inside the timed block, then shown
          // (no function around it: its scope is the cell's, as in IPython)
          repl = parsed.length === 1 && parsed[0]._type === "Expr"
            ? [b.withTimer([b.expr(b.call(b.api("keep"), [parsed[0].value]))]), b.expr(b.call(b.api("kept"), []))]
            : [b.withTimer(parsed)];
        } else repl = [b.timeitDef([], parsed), b.timeitRun(opts, top)];
        stmts.splice(i, 1, ...repl);
        i += repl.length - 1;
        continue;
      }
      // (inside compound statements; a function's or class's body is not the top)
      for (const k of STMT_LISTS) if (Array.isArray(st[k])) walk(st[k], top && !["FunctionDef", "AsyncFunctionDef", "ClassDef"].includes(st._type));
      if (Array.isArray(st.handlers)) for (const h of st.handlers) walk(h.body, top);
      if (Array.isArray(st.cases)) for (const c of st.cases) walk(c.body, top);
    }
  };
  // a cell magic: the module's first statement
  const cm = body.length ? magicCall(body[0], "__pyjs_cell_magic__") : null;
  if (cm && cm[2].length === 0 && CODE_MAGICS.has(cm[0])) {
    const [mname, args] = cm;
    const st = body[0], rest = body.slice(1);
    // (the line magics in its body first; %%timeit's body is in a function)
    walk(rest, mname === "time");
    const setupSrc = mname === "timeit" ? splitTimeit(args)[1] : "";
    const setup = setupSrc.trim() ? reserve(parseCode(setupSrc)) : [];
    const b = builders(st.lineno, st.col_offset, fresh);
    if (mname === "time") {
      // (the last expression's value is shown, as IPython does)
      const last = rest.length && rest[rest.length - 1]._type === "Expr" ? rest.pop()! : null;
      const inner = last ? [...rest, b.expr(b.call(b.api("keep"), [last.value]))] : rest;
      tree.body = [b.withTimer(inner.length ? inner : [{ _type: "Pass", ...b.p }]), ...(last ? [b.expr(b.call(b.api("kept"), []))] : [])];
    } else {
      const [opts] = splitTimeit(args);
      if (setup === null) return;    // (the call raises the SyntaxError)
      relocate(setup, st.lineno, st.col_offset);
      tree.body = [b.timeitDef(setup, rest), b.timeitRun(opts, true)];
    }
    return;
  }
  walk(body, true);
}

/** The tree transform for cells whose text went through magicSyntax. */
export function magicTransform(sage: boolean): (tree: any) => void {
  const parseCode = codeParser(sage);
  return (tree) => expandMagics(tree, parseCode);
}
