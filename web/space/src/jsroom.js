// A JavaScript or TypeScript file's room, from Babel's parser (@babel/parser, loaded the first time one is entered):
// its functions (declared, or a const bound to an arrow or function), classes (entered in turn: their methods), types
// (interfaces, type aliases, enums), runs of other top-level code, and its imports (portals: a relative one leads to
// the file, resolveJs).  Links: calls, the names each refers to (a type's too), `this.m()` in a class's room.
//   jsRoom(text, { path, scope })  -> a sagebrush-space (scope: [a class's id], for its room)
import { parse } from "@babel/parser";
import { buildRoom } from "./coderoom.js";

const SKIP = new Set(["_exp", "loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments", "tokens"]);
// every node under `n`, with its parent and the key it is under
function walk(n, visit, parent = null, key = null) {
  if (Array.isArray(n)) { for (const x of n) walk(x, visit, parent, key); return; }
  if (!n || typeof n !== "object" || typeof n.type !== "string") return;
  if (visit(n, parent, key) === false) return;
  for (const k in n) if (!SKIP.has(k) && n[k] && typeof n[k] === "object") walk(n[k], visit, n, k);
}
// (where an identifier is a name read, rather than a property's key, a declaration, a label)
function isRead(n, parent, key) {
  if (!parent) return true;
  const t = parent.type;
  if ((t === "MemberExpression" || t === "OptionalMemberExpression" || t === "TSQualifiedName") && key === "property" && !parent.computed) return false;
  if (t === "TSQualifiedName" && key === "right") return false;
  if ((t === "ObjectProperty" || t === "ObjectMethod" || t === "ClassMethod" || t === "ClassProperty" || t === "ClassPrivateMethod" || t === "TSPropertySignature" || t === "TSMethodSignature") && key === "key" && !parent.computed) return false;
  if (key === "id" || key === "label" || t === "ImportSpecifier" || t === "ImportDefaultSpecifier" || t === "ImportNamespaceSpecifier" || t === "ExportSpecifier") return false;
  if ((t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression" || t === "ClassMethod" || t === "ObjectMethod") && key === "params") return false;
  return true;
}
// what a stretch of code refers to, and what it binds itself (parameters, locals: not the file's names)
function refsOf(node) {
  const calls = new Set(), methods = new Set(), names = new Set(), own = new Set();
  // (the names a pattern binds: not its type annotations, whose names are uses)
  const TYPE_KEYS = new Set(["typeAnnotation", "returnType", "typeParameters", "decorators"]);
  const bindPattern = (p) => walk(p, (x, par, k) => { if (TYPE_KEYS.has(k)) return false; if (x.type === "Identifier" && !(par?.type === "ObjectProperty" && k === "key" && !par.computed && par.value !== x)) own.add(x.name); if (x.type === "AssignmentPattern") { walk(x.left, (y) => { if (y.type === "Identifier") own.add(y.name); }); walk(x.right, () => {}); return false; } });
  walk(node, (n, parent, key) => {
    if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression" || n.type === "ClassMethod" || n.type === "ObjectMethod" || n.type === "ClassPrivateMethod") && n.params) for (const p of n.params) bindPattern(p);
    if (n.type === "VariableDeclarator") bindPattern(n.id);
    if (n.type === "CatchClause" && n.param) bindPattern(n.param);
    if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id && n !== node) own.add(n.id.name);
    if (n.type === "CallExpression" || n.type === "NewExpression" || n.type === "OptionalCallExpression") {
      const c = n.callee;
      if (c?.type === "Identifier") calls.add(c.name);
      else if ((c?.type === "MemberExpression" || c?.type === "OptionalMemberExpression") && !c.computed && c.property?.type === "Identifier") {
        if (c.object?.type === "ThisExpression") methods.add("this." + c.property.name);
        else if (c.object?.type === "Identifier") { calls.add(c.object.name + "." + c.property.name); methods.add(c.property.name); }
        else methods.add(c.property.name);
      }
    }
    if (n.type === "Identifier" && isRead(n, parent, key)) names.add(n.name);
  });
  // (a function's own name isn't a reference to itself)
  return { calls: [...calls], methods: [...methods], names: [...names], own: [...own] };
}
const jsdoc = (n) => {
  const c = (n.leadingComments ?? []).filter((x) => x.type === "CommentBlock" && x.value.startsWith("*")).at(-1);
  return c ? c.value.replace(/^\*+/, "").split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n").trim() : null;
};
const sig = (name, params) => {
  const ps = (params ?? []).map((p) => (p.type === "Identifier" ? p.name : p.type === "AssignmentPattern" && p.left?.type === "Identifier" ? p.left.name : p.type === "RestElement" && p.argument?.type === "Identifier" ? "..." + p.argument.name : p.type === "TSParameterProperty" && p.parameter?.type === "Identifier" ? p.parameter.name : p.type === "ObjectPattern" ? "{…}" : p.type === "ArrayPattern" ? "[…]" : "_"));
  const s = `${name}(${ps.join(", ")})`;
  return s.length > 64 ? s.slice(0, 61) + "…)" : s;
};
const isFn = (n) => n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression");

export function parseJs(text, path) {
  const ts = /\.(ts|mts|cts|tsx)$/.test(path), jsx = /\.(jsx|tsx)$/.test(path) || /\.js$/.test(path);
  const opts = { sourceType: "unambiguous", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
    plugins: [...(ts ? ["typescript"] : []), ...(jsx ? ["jsx"] : []), "decorators-legacy"] };
  try { return parse(text, opts); } catch (e) {
    // (a file the strict parse refuses: once more, keeping what parses, with the first error said)
    try { const t = parse(text, { ...opts, errorRecovery: true }); t.recovered = String(e?.message ?? e); return t; } catch { throw new Error(`it doesn't parse: ${e?.message ?? e}`); }
  }
}

export function jsRoom(text, { path = "", scope = null } = {}) {
  const ast = parseJs(text, path);
  const lang = /\.(ts|mts|cts|tsx)$/.test(path) ? "typescript" : "javascript";
  const top = ast.program.body.map((s) => ((s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") && s.declaration && s.declaration.type !== "Identifier" ? Object.assign(s.declaration, { leadingComments: s.leadingComments ?? s.declaration.leadingComments, _exp: s }) : s));
  const lines = (n) => [(n._exp ?? n).loc.start.line, (n._exp ?? n).loc.end.line];
  // (down the scope: a function's body (its inner functions are its room), or a class (its methods))
  let list = top, inFn = null;
  for (const [i, id] of (scope ?? []).entries()) {
    if (id.startsWith("c:") && i === scope.length - 1) break;
    const f = list.find((s) => fnName(s) && "f:" + fnName(s) === id);
    const b = f && bodyOf(f);
    if (!b) throw new Error(`no function ${id.slice(2)} in ${path}`);
    list = b; inFn = { name: id.slice(2), node: f };
  }
  const last = scope?.at(-1);
  if (last?.startsWith("c:")) {
    // (a class's room: its methods, and fields holding functions)
    const cls = list.find((s) => (s.type === "ClassDeclaration" && "c:" + s.id?.name === last) || (s.type === "VariableDeclaration" && s.declarations.some((d) => d.init?.type === "ClassExpression" && "c:" + d.id?.name === last)));
    const body = cls?.type === "ClassDeclaration" ? cls.body.body : cls?.declarations.find((d) => d.init?.type === "ClassExpression").init.body.body;
    if (!body) throw new Error(`no class ${last.slice(2)} in ${path}`);
    const entities = [];
    for (const m of body) {
      const name = m.key?.type === "Identifier" ? m.key.name : m.key?.type === "PrivateName" ? "#" + m.key.id.name : m.key?.type === "StringLiteral" ? m.key.value : null;
      if (!name) continue;
      const fn = m.type === "ClassMethod" || m.type === "ClassPrivateMethod" ? m : (m.type === "ClassProperty" || m.type === "ClassPrivateProperty") && isFn(m.value) ? m.value : null;
      const [a, b] = [m.loc.start.line, m.loc.end.line];
      if (fn) {
        const r = refsOf(fn);
        entities.push({ id: "f:" + name, kind: "fn", title: (m.kind === "get" ? "get " : m.kind === "set" ? "set " : m.static ? "static " : "") + sig(name, fn.params), name, group: "methods", start: a, end: b, doc: jsdoc(m), refs: r, own: r.own });
      } else entities.push({ id: "y:" + name, kind: "block", title: (m.static ? "static " : "") + name, name, names: [name], group: "fields", start: a, end: b, doc: jsdoc(m), refs: refsOf(m.value ?? {}) });
    }
    const name = last.slice(2);
    return buildRoom({ entities, text, lang, path, title: `class ${name} · ${path}`, summary: jsdoc(cls), room: { kind: "class", path, lang, name: "class " + name, scope }, self: ["this", name] });
  }
  const entities = [], portals = [];
  let run = null;
  const endRun = () => {
    if (!run) return;
    const r = refsOf({ type: "Program", body: run.stmts });
    const a = run.start, b = run.end, first = run.names.length ? run.names.slice(0, 3).join(", ") + (run.names.length > 3 ? ", …" : "") + " =" : (text.split("\n")[a - 1] ?? "").trim().slice(0, 48);
    entities.push({ id: "b:" + a, kind: "block", title: first, names: run.names, start: a, end: b, doc: run.doc, refs: { ...r, names: r.names.filter((n) => !run.names.includes(n)) } });
    run = null;
  };
  const addPortal = (src, locals, imported, n) => {
    const old = portals.find((p) => p.title === src);
    if (old) { old.locals.push(...locals); old.imported.push(...imported); old.end = Math.max(old.end, n.loc.end.line); return; }
    portals.push({ id: "m:" + src, title: src, locals, imported, start: n.loc.start.line, end: n.loc.end.line, extra: { js: { spec: src } } });
  };
  // (a function with inner functions is entered too: they are its room)
  const enterFn = (s, name) => ((bodyOf(s) ?? []).filter((x) => fnName(x)).length >= 2 ? { enter: { kind: "class", scope: [...(scope ?? []), "f:" + name] } } : {});
  for (const s of list) {
    const [a, b] = lines(s);
    if (s.type === "ImportDeclaration") {
      addPortal(s.source.value, s.specifiers.map((x) => x.local.name), s.specifiers.map((x) => (x.type === "ImportSpecifier" ? (x.imported.name ?? x.imported.value) : x.type === "ImportDefaultSpecifier" ? "default" : "*")), s);
      continue;
    }
    if ((s.type === "ExportNamedDeclaration" || s.type === "ExportAllDeclaration") && s.source) { addPortal(s.source.value, [], (s.specifiers ?? []).map((x) => x.local?.name ?? "*"), s); continue; }
    if (s.type === "FunctionDeclaration" && s.id) {
      endRun();
      const r = refsOf(s);
      entities.push({ id: "f:" + s.id.name, kind: "fn", title: sig(s.id.name, s.params), name: s.id.name, start: a, end: b, doc: jsdoc(s), refs: r, own: r.own, ...enterFn(s, s.id.name) });
      continue;
    }
    if (s.type === "ClassDeclaration" && s.id) {
      endRun();
      const members = s.body.body.map((m) => (m.key?.type === "Identifier" ? m.key.name : null)).filter(Boolean);
      const r = refsOf(s);
      entities.push({ id: "c:" + s.id.name, kind: "class", title: "class " + s.id.name, name: s.id.name, start: a, end: b, doc: jsdoc(s), members, enter: { kind: "class", scope: [...(scope ?? []), "c:" + s.id.name] },
        refs: { ...r, names: r.names.filter((n) => !members.includes(n)) }, own: [...r.own, "this"], links: s.superClass?.type === "Identifier" ? [[s.superClass.name, "uses"]] : [] });
      continue;
    }
    if (s.type === "VariableDeclaration" && s.declarations.length === 1 && s.declarations[0].id?.type === "Identifier" && (isFn(s.declarations[0].init) || s.declarations[0].init?.type === "ClassExpression")) {
      endRun();
      const d = s.declarations[0], name = d.id.name, r = refsOf(d.init);
      if (d.init.type === "ClassExpression") {
        const members = d.init.body.body.map((m) => (m.key?.type === "Identifier" ? m.key.name : null)).filter(Boolean);
        entities.push({ id: "c:" + name, kind: "class", title: "class " + name, name, start: a, end: b, doc: jsdoc(s), members, enter: { kind: "class", scope: [...(scope ?? []), "c:" + name] }, refs: r, own: [...r.own, "this"] });
      } else entities.push({ id: "f:" + name, kind: "fn", title: sig(name, d.init.params), name, start: a, end: b, doc: jsdoc(s), refs: r, own: r.own, ...enterFn(s, name) });
      continue;
    }
    if (/^TS(Interface|TypeAlias|Enum|Module)Declaration$/.test(s.type) && s.id) {
      endRun();
      const name = s.id.name ?? s.id.value, what = { TSInterfaceDeclaration: "interface", TSTypeAliasDeclaration: "type", TSEnumDeclaration: "enum", TSModuleDeclaration: "namespace" }[s.type];
      entities.push({ id: "y:" + name, kind: "block", title: `${what} ${name}`, name, names: [name], start: a, end: b, doc: jsdoc(s), refs: refsOf(s) });
      continue;
    }
    // (anything else: a run of top-level code, with the names it declares)
    if (!run) run = { stmts: [], names: [], start: a, end: b, doc: jsdoc(s) };
    run.stmts.push(s); run.end = b;
    if (s.type === "VariableDeclaration") for (const d of s.declarations) walk(d.id, (x, par, k) => { if (x.type === "Identifier" && !(par?.type === "ObjectProperty" && k === "key" && par.value !== x) && !run.names.includes(x.name)) run.names.push(x.name); });
  }
  endRun();
  const leading = (ast.comments ?? []).find((c) => c.loc.start.line <= 3);
  const summary = leading ? leading.value.replace(/^\*+/, "").split("\n").map((l) => l.replace(/^\s*(\*|\/\/)?\s?/, "")).join("\n") : null;
  if (inFn) return buildRoom({ entities, portals, text, lang, path, title: `${inFn.name}() · ${path}`, summary: jsdoc(inFn.node), room: { kind: "class", path, lang, name: inFn.name + "()", scope } });
  return buildRoom({ entities, portals, text, lang, path, title: path || "a file", summary: (ast.recovered ? `(Parsed with errors: ${ast.recovered}) ` : "") + (summary ?? ""), room: { kind: "file", path, lang } });
}
// (a statement's function name, if it declares one: function f, or const f = () => …)
function fnName(s) {
  if (s.type === "FunctionDeclaration" && s.id) return s.id.name;
  if (s.type === "VariableDeclaration" && s.declarations.length === 1 && s.declarations[0].id?.type === "Identifier" && isFn(s.declarations[0].init)) return s.declarations[0].id.name;
  return null;
}
// (a function's statements, when it has a block body)
function bodyOf(s) {
  const f = s.type === "FunctionDeclaration" ? s : s.type === "VariableDeclaration" ? s.declarations[0]?.init : null;
  return f?.body?.type === "BlockStatement" ? f.body.body : null;
}

// Where a JS/TS import leads in a tree: a relative specifier, with the extensions a bundler tries; else null
export function resolveJs(tree, from, spec) {
  if (!spec.startsWith(".")) return null;
  const has = new Set(tree.files.map((f) => f[0]));
  const parts = [], d = from.slice(0, Math.max(0, from.lastIndexOf("/")));
  for (const s of (d ? d + "/" + spec : spec).split("/")) { if (s === "..") parts.pop(); else if (s && s !== ".") parts.push(s); }
  const b = parts.join("/");
  for (const c of [b, b + ".ts", b + ".mts", b + ".tsx", b + ".js", b + ".mjs", b + ".jsx", b.replace(/\.js$/, ".ts"), b.replace(/\.mjs$/, ".mts"), b.replace(/\.js$/, ".tsx"), b + "/index.ts", b + "/index.js"])
    if (has.has(c) && c !== from) return { path: c, sub: false };
  return null;
}
