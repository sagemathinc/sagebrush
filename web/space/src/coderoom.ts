// A room from a file's outline, for the languages whose parsers give one (rsroom.js: Rust, by syn; jsroom.js:
// JavaScript and TypeScript, by Babel): the outline's entities (functions, classes or impl blocks, types, runs of other
// top-level code) and its imports (portals), linked by what each entity refers to.  pyroom.js is Python's own.
//   buildRoom({ entities, portals, text, lang, path, title, summary, room, self })  -> a sagebrush-space
// An entity: { id, kind ("fn" | "class" | "block"), title, name, names (what a block binds), start, end, doc, enter,
//   forType (an impl block's type),
//   members (a container's method names), refs: { calls, methods, names }, own (its own parameters and locals),
//   links (more: [to, kind]) }.  A portal: { id, title, locals (the names it binds here), imported, start, end }.
// `self`: in a container's room (a class, an impl block), the words that name the container ("this", "self",
// "Self", its type's name): `this.m()`, `self.m()` and `Self::m()` link to its member m.
import { layered } from "./roomlayout.ts";
import { checkSpace } from "./read.ts";

const firstPara = (doc) => {
  const p = String(doc ?? "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return p ? (p.length > 400 ? p.slice(0, 397) + "…" : p) : null;
};

export function buildRoom({ entities, portals = [], text, lang, path, title, summary, room, self = null }) {
  const src = String(text).split("\n");
  const sliceOf = (a, b) => {
    const ls = src.slice(a - 1, b);
    const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    return ls.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join("\n");
  };
  const nodes = [], edges = [], named = new Map(), seen = new Map(), ids = new Set();
  const uniq = (id) => { let k = id, n = 2; while (ids.has(k)) k = `${id}#${n++}`; ids.add(k); return k; };
  for (const p of portals) {
    p.id = uniq(p.id);
    nodes.push({ id: p.id, kind: "import", title: p.title, group: "imports", lang, names: p.locals ?? [], imported: p.imported ?? [], start: p.start, end: p.end,
      text: sliceOf(p.start, p.end), lines: Math.max(1, (p.end ?? p.start) - p.start + 1), ...(p.extra ?? {}) });
    for (const n of p.locals ?? []) if (n !== "*" && !named.has(n)) named.set(n, p.id);
  }
  for (const e of entities) {
    e.id = uniq(e.id);
    const nd = { id: e.id, kind: e.kind, title: e.title, name: e.name, group: e.group ?? (e.kind === "fn" ? "functions" : e.kind === "class" ? "classes" : "top-level code"),
      lang, start: e.start, end: e.end, lines: e.end - e.start + 1, text: sliceOf(e.start, e.end), summary: firstPara(e.doc), ...(e.enter ? { enter: e.enter } : {}),
      ...(e.names?.length ? { names: e.names } : {}), ...(e.members ? { methods: e.members.length } : {}) };
    if (!nd.summary) delete nd.summary;
    nodes.push(nd);
  }
  // (the names the room's own objects bind: theirs over an import's)
  for (const e of entities) {
    if (e.name) named.set(e.name, e.id);
    for (const n of e.names ?? []) if (!named.has(n)) named.set(n, e.id);
  }
  const memberOf = new Map(); // (a method name -> the containers defining it)
  for (const e of entities) for (const m of e.members ?? []) (memberOf.get(m) ?? memberOf.set(m, []).get(m)).push(e.id);
  const link = (from, to, kind) => {
    if (!to || from === to) return;
    const k = from + ">" + to, was = seen.get(k);
    if (was) { if (kind === "calls" && was.kind !== "calls") was.kind = "calls"; return; }
    const ed = { from, to, kind };
    seen.set(k, ed); edges.push(ed);
  };
  const selfWords = new Set(self ?? []);
  for (const e of entities) {
    const r: any = e.refs ?? {}, own = new Set(e.own ?? []);
    const calls = new Set<string>(r.calls ?? []);
    for (const n of r.names ?? []) if (!own.has(n)) link(e.id, named.get(n), calls.has(n) ? "calls" : "uses");
    for (const c of calls) {
      const parts = c.split(/::|\./);
      if (parts.length < 2) continue;
      // (Self::m, Type::m, this.m in a container's room: its member; Type::m with an impl block of Type here
      //  defining m: that block; else X::y, X.y: X)
      const m = parts[parts.length - 1], impl = entities.find((x) => x.forType === parts[parts.length - 2] && x.members?.includes(m));
      if (selfWords.has(parts[0]) && named.has(m)) link(e.id, named.get(m), "calls");
      else if (impl) link(e.id, impl.id, "calls");
      else if (!own.has(parts[0])) link(e.id, named.get(parts[0]), "calls");
    }
    for (const m of r.methods ?? []) {
      const [recv, name] = m.includes(".") ? m.split(".") : [null, m];
      if (recv && selfWords.has(recv)) { link(e.id, named.get(name), "calls"); continue; }
      // (x.m(): the one container here with a method m, if only one has it)
      const cs = memberOf.get(name);
      if (cs?.length === 1) link(e.id, cs[0], "calls");
    }
    for (const [to, kind] of e.links ?? []) link(e.id, named.get(to) ?? (ids.has(to) ? to : null), kind);
  }
  for (const nd of nodes) if (nd.kind !== "import" && !edges.some((x) => x.from === nd.id || x.to === nd.id)) nd.shelf = true;
  // (checked whole before it is laid out, so a room over the limits never is, and again after: positions add bytes)
  const space = { format: "sagebrush-space", version: 1, title, summary: firstPara(summary), room: { ...room, labels: ["imports", "not linked here"] }, directed: true, nodes, edges };
  checkSpace(space);
  layered(nodes, edges);
  for (const nd of nodes) if (nd.shelf) nd.group = "not linked here";
  return checkSpace(space);
}
