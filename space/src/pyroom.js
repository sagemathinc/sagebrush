// A file's room: what one Python or Sage file holds, from a real parse (pyparse, CPython's own grammar; Sage's
// preparser first for .sage), as a space of its own.  Its objects: each top-level function, each class (entered in
// turn: its methods), each run of other top-level code, and each imported module (a portal on the wall).  Its links
// are the file's own references, read from the parse: a function that calls another, or uses a constant defined in a
// block, or a class's base.  Laid out by roomlayout.js: what calls stands above what it calls.
//   pythonRoom(text, { path, sage, scope })  -> a sagebrush-space (scope: a class's name, for that class's room)
import { parse } from "../../pyparse/src/index.ts";
import { preparse } from "../../src/sagepre.ts";
import { layered } from "./roomlayout.js";

const isDef = (s) => s?._type === "FunctionDef" || s?._type === "AsyncFunctionDef";
const docOf = (body) => {
  const s = body?.[0];
  return s?._type === "Expr" && s.value?._type === "Constant" && typeof s.value.value === "string" ? s.value.value : null;
};
// (a docstring's first paragraph, as the object's summary until someone writes a better one)
const firstPara = (doc) => {
  if (!doc) return null;
  const p = doc.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return p ? (p.length > 400 ? p.slice(0, 397) + "…" : p) : null;
};

function signature(name, a) {
  if (!a) return name + "()";
  const ps = [];
  for (const x of a.posonlyargs ?? []) ps.push(x.arg);
  if ((a.posonlyargs ?? []).length) ps.push("/");
  for (const x of a.args ?? []) ps.push(x.arg);
  if (a.vararg) ps.push("*" + a.vararg.arg);
  else if ((a.kwonlyargs ?? []).length) ps.push("*");
  for (const x of a.kwonlyargs ?? []) ps.push(x.arg);
  if (a.kwarg) ps.push("**" + a.kwarg.arg);
  const s = `${name}(${ps.join(", ")})`;
  return s.length > 64 ? s.slice(0, 61) + "…)" : s;
}

// every AST node under `n` (its fields, arrays included), depth first
function walk(n, visit) {
  if (Array.isArray(n)) { for (const x of n) walk(x, visit); return; }
  if (!n || typeof n !== "object" || !n._type) return;
  if (visit(n) === false) return;
  for (const k in n) {
    const v = n[k];
    if (v && typeof v === "object" && k !== "ctx") walk(v, visit);
  }
}

// what a stretch of code refers to: names it reads, `X.attr` pairs, which of them it calls, and the names it binds
// itself (a function's parameters and locals shadow the file's names)
function refsOf(nodes) {
  const loads = new Set(), attrs = new Set(), calls = new Set(), binds = new Set();
  walk(nodes, (n) => {
    if (n._type === "Name") {
      if (n.ctx?._type === "Store" || n.ctx?._type === "Del") binds.add(n.id); else loads.add(n.id);
    } else if (n._type === "Attribute" && n.value?._type === "Name") attrs.add(n.value.id + "." + n.attr);
    else if (n._type === "Call") {
      const f = n.func;
      if (f?._type === "Name") calls.add(f.id);
      else if (f?._type === "Attribute" && f.value?._type === "Name") calls.add(f.value.id + "." + f.attr);
    } else if (n._type === "arg") binds.add(n.arg);
    else if (isDef(n) || n._type === "ClassDef") binds.add(n.name);
  });
  return { loads, attrs, calls, binds };
}

// the statements of a body, with those inside a top-level `if`, `try` or `with` (a def under `try:` is still one of
// the file's) flattened in
function flat(body) {
  const out = [];
  for (const s of body ?? []) {
    if (["If", "Try", "TryStar", "With", "AsyncWith"].includes(s._type) && containsDef(s)) {
      out.push({ _type: "_Head", stmt: s });
      for (const k of ["body", "orelse", "finalbody"]) out.push(...flat(s[k]));
      for (const h of s.handlers ?? []) out.push(...flat(h.body));
    } else out.push(s);
  }
  return out;
}
const containsDef = (s) => [s.body, s.orelse, s.finalbody, ...(s.handlers ?? []).map((h) => h.body)].some((b) => (b ?? []).some((x) => isDef(x) || x._type === "ClassDef" || x._type === "Import" || x._type === "ImportFrom"));

export function parsePython(text, { sage = false } = {}) {
  try {
    return parse(sage ? preparse(text) : text, "exec", { sage });
  } catch (e) {
    const i = e?.info;
    throw new Error(i ? `${i.type}: ${i.msg} (line ${i.lineno})` : String(e?.message ?? e));
  }
}

export function pythonRoom(text, { path = "", sage = /\.sage$/.test(path), scope = null } = {}) {
  const tree = parsePython(text, { sage });
  const src = text.split("\n");
  const lang = sage ? "sage" : "python";
  // (an object's own lines, its decorators included, without the indentation it shares)
  const startOf = (s) => Math.min(s.lineno, ...(s.decorator_list ?? []).map((d) => d.lineno));
  const sliceOf = (a, b) => {
    const ls = src.slice(a - 1, b);
    const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    return ls.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join("\n");
  };
  if (scope) return classRoom(tree, scope, { path, lang, startOf, sliceOf });

  const nodes = [], edges = [];
  const named = new Map(); // (a name the file binds at the top -> the id of the object binding it)
  const portals = new Map(); // (module -> its portal)
  const bindPortal = (name, mod, line) => {
    if (!portals.has(mod)) {
      const p = { id: "m:" + mod, kind: "import", title: mod, group: "imports", lang, names: [], text: "", start: line, end: line, lines: 1 };
      portals.set(mod, p);
      nodes.push(p);
    }
    const p = portals.get(mod);
    if (name && !p.names.includes(name)) p.names.push(name);
    if (name && name !== "*") named.set(name, p.id);
  };
  const body = flat(tree.body);
  const moduleDoc = docOf(tree.body);
  let run = null; // (the block of other top-level code being gathered)
  const blocks = [];
  const endRun = () => { if (run) { blocks.push(run); run = null; } };
  for (const s of body) {
    if (s === tree.body[0] && moduleDoc !== null) continue;
    if (s._type === "_Head") { endRun(); continue; }
    if (isDef(s)) {
      endRun();
      const a = startOf(s), id = "f:" + s.name;
      const nd = { id, kind: "fn", title: signature(s.name, s.args), name: s.name, group: "functions", lang, start: a, end: s.end_lineno,
        lines: s.end_lineno - a + 1, text: sliceOf(a, s.end_lineno), summary: firstPara(docOf(s.body)), _ast: s };
      dropId(nodes, id);
      nodes.push(nd); named.set(s.name, id);
    } else if (s._type === "ClassDef") {
      endRun();
      const a = startOf(s), id = "c:" + s.name;
      const methods = flat(s.body).filter(isDef);
      // (its header: to the line before its first statement (or that statement's decorators), the class line at least)
      const head = sliceOf(a, Math.max(s.lineno, s.body[0] ? startOf(s.body[0]) - 1 : s.lineno)).split("\n");
      const doc = docOf(s.body);
      const outline = methods.map((m) => `    def ${signature(m.name, m.args)}: …  # ${m.end_lineno - startOf(m) + 1} lines`);
      const nd = { id, kind: "class", title: "class " + s.name, name: s.name, group: "classes", lang, start: a, end: s.end_lineno,
        lines: s.end_lineno - a + 1, methods: methods.length,
        text: [...head, ...(doc ? ['    """' + firstPara(doc) + '"""'] : []), ...outline].join("\n"),
        summary: firstPara(doc), enter: { kind: "class", name: s.name }, _ast: s };
      dropId(nodes, id);
      nodes.push(nd); named.set(s.name, id);
    } else if (s._type === "Import") {
      for (const al of s.names) bindPortal(al.asname ?? al.name.split(".")[0], al.name, s.lineno);
      addImportLine(portals, s, src);
    } else if (s._type === "ImportFrom") {
      const mod = ".".repeat(s.level ?? 0) + (s.module ?? "");
      for (const al of s.names) bindPortal(al.asname ?? al.name, mod, s.lineno);
      addImportLine(portals, s, src);
    } else {
      if (!run) run = { stmts: [] };
      run.stmts.push(s);
    }
  }
  endRun();
  for (const b of blocks) {
    const a = Math.min(...b.stmts.map((s) => startOf(s))), e = Math.max(...b.stmts.map((s) => s.end_lineno));
    const id = "b:" + a;
    const r = refsOf(b.stmts);
    const nd = { id, kind: "block", title: blockTitle(b.stmts, src), names: targetNames(b.stmts), group: "top-level code", lang, start: a, end: e, lines: e - a + 1, text: sliceOf(a, e), _stmts: b.stmts };
    nodes.push(nd);
    // (a block binds names: a function that reads one depends on the block)
    for (const n of r.binds) if (!named.has(n)) named.set(n, id);
  }
  // the links: who refers to whom, a call or a use
  const seen = new Map();
  const link = (from, to, kind) => {
    if (!to || from === to) return;
    const k = from + ">" + to, was = seen.get(k);
    if (was) { if (kind === "calls" && was.kind !== "calls") was.kind = "calls"; return; }
    const e = { from, to, kind };
    seen.set(k, e); edges.push(e);
  };
  for (const nd of nodes) {
    if (nd.kind === "import") continue;
    const part = nd._ast ?? nd._stmts;
    let r;
    if (nd.kind === "class") {
      // (a class: its bases, decorators, and everything its methods and body refer to)
      const s = nd._ast;
      for (const b of s.bases ?? []) if (b._type === "Name") link(nd.id, named.get(b.id), "inherits");
      // (each method on its own, without its own parameters and locals; and the class's other statements)
      const body = flat(s.body);
      for (const m of body.filter(isDef)) refer(nd.id, refsOf([...(m.decorator_list ?? []), m.args, ...m.body]), true);
      refer(nd.id, refsOf([...(s.decorator_list ?? []), ...body.filter((x) => !isDef(x) && x._type !== "_Head")]), false);
    } else refer(nd.id, refsOf(nd.kind === "fn" ? [...(part.decorator_list ?? []), part.args, ...part.body] : part), nd.kind === "fn");
  }
  // (what a stretch refers to, as links; a function's own parameters and locals aren't the file's names, while a
  //  block's own bindings are the file's)
  function refer(id, r, local) {
    const own = local ? r.binds : new Set();
    for (const n of r.loads) if (!own.has(n)) link(id, named.get(n), r.calls.has(n) ? "calls" : "uses");
    for (const at of r.calls) if (at.includes(".") && !own.has(at.split(".")[0])) link(id, named.get(at.split(".")[0]), "calls");
  }
  for (const nd of nodes) { delete nd._ast; delete nd._stmts; }
  const room = { kind: "file", path, lang, labels: ["imports", "not linked here"] };
  return finish({ title: path || "a file", summary: firstPara(moduleDoc), room, nodes, edges, src });
}

function classRoom(tree, name, { path, lang, startOf, sliceOf }) {
  const cls = flat(tree.body).find((s) => s._type === "ClassDef" && s.name === name);
  if (!cls) throw new Error(`no class ${name} in ${path}`);
  const methods = flat(cls.body).filter(isDef);
  const nodes = [], edges = [], ids = new Map();
  for (const m of methods) {
    const a = startOf(m), id = "f:" + m.name;
    dropId(nodes, id);
    nodes.push({ id, kind: "fn", title: signature(m.name, m.args), name: m.name, group: "methods", lang, start: a, end: m.end_lineno,
      lines: m.end_lineno - a + 1, text: sliceOf(a, m.end_lineno), summary: firstPara(docOf(m.body)), _ast: m });
    ids.set(m.name, id);
  }
  const rest = flat(cls.body).filter((s) => !isDef(s) && s._type !== "ClassDef" && s._type !== "_Head" && !(s === cls.body[0] && docOf(cls.body) !== null));
  if (rest.length) {
    const a = Math.min(...rest.map((s) => s.lineno)), e = Math.max(...rest.map((s) => s.end_lineno));
    nodes.push({ id: "b:" + a, kind: "block", title: "class attributes", group: "class body", lang, start: a, end: e, lines: e - a + 1, text: sliceOf(a, e) });
  }
  // (a method calls another through self, cls, or the class's own name)
  const seen = new Set();
  for (const nd of nodes) {
    if (!nd._ast) continue;
    const r = refsOf([...nd._ast.body]);
    for (const at of [...r.attrs]) {
      const [recv, attr] = at.split(".");
      if ((recv === "self" || recv === "cls" || recv === name) && ids.has(attr) && ids.get(attr) !== nd.id) {
        const k = nd.id + ">" + ids.get(attr);
        if (!seen.has(k)) { seen.add(k); edges.push({ from: nd.id, to: ids.get(attr), kind: r.calls.has(at) ? "calls" : "uses" }); }
      }
    }
  }
  for (const nd of nodes) delete nd._ast;
  return finish({ title: `class ${name} · ${path}`, summary: firstPara(docOf(cls.body)), room: { kind: "class", path, lang, name, labels: ["not linked here"] }, nodes, edges });
}

function addImportLine(portals, s, src) {
  const mod = s._type === "Import" ? null : ".".repeat(s.level ?? 0) + (s.module ?? "");
  const line = src.slice(s.lineno - 1, s.end_lineno).map((l) => l.trim()).join(" ");
  for (const m of mod === null ? s.names.map((a) => a.name) : [mod]) {
    const p = portals.get(m);
    if (p && !p.text.split("\n").includes(line)) p.text = p.text ? p.text + "\n" + line : line;
  }
}
// (the names a block's assignments bind, in order)
function targetNames(stmts) {
  const names = [];
  for (const t of stmts) {
    for (const tg of t.targets ?? (t.target ? [t.target] : [])) walk(tg, (n) => { if (n._type === "Name" && !names.includes(n.id)) names.push(n.id); });
  }
  return names;
}
function blockTitle(stmts, src) {
  const s = stmts[0];
  if (stmts.length === 1 && s._type === "If" && /__name__/.test(src[s.lineno - 1])) return "if __name__ == \"__main__\"";
  const names = targetNames(stmts);
  if (names.length) return names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "") + " =";
  const first = src[s.lineno - 1].trim();
  return first.length > 48 ? first.slice(0, 45) + "…" : first;
}
const dropId = (nodes, id) => { const k = nodes.findIndex((n) => n.id === id); if (k >= 0) nodes.splice(k, 1); };

// (the room laid out, and each object's links listed for the summary line)
function finish({ title, summary, room, nodes, edges }) {
  for (const nd of nodes) {
    // (what isn't linked to anything here, imports aside, waits on a shelf of its own below)
    if (nd.kind !== "import" && !edges.some((e) => e.from === nd.id || e.to === nd.id)) nd.shelf = true;
    if (nd.kind === "import") nd.lines = Math.max(1, nd.text.split("\n").length);
  }
  layered(nodes, edges);
  for (const nd of nodes) if (nd.shelf) nd.group = "not linked here";
  return { format: "sagebrush-space", version: 1, title, summary, room, directed: true, nodes, edges };
}
