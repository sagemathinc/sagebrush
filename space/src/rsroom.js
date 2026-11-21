// A Rust file's room, from syn, Rust's own parser, compiled to WebAssembly (space/rustroom, served beside the page as
// rustroom.wasm): its functions, impl blocks and traits (each entered in turn: its methods), types, constants and
// macros, inline modules (entered: their items), and its `use`s and `mod` declarations (portals to the files they
// lead to, resolveRust).  Links: a function's calls (`f()`, `Type::new()`, `x.method()` when only one impl block here
// has it), the types and constants it names, the macros it invokes.
//   rustRoom(text, { path, scope })  -> a sagebrush-space (scope: the ids of a container, from the top, for its room)
import { buildRoom } from "./coderoom.js";

let engine = null, given = null;
/** (tests, outside a page: the parser's bytes) */
export const useRustParser = (bytes) => { given = bytes; engine = null; };
function parser() {
  engine ??= (async () => {
    let bytes = given;
    if (!bytes) {
      const r = await fetch(new URL("rustroom.wasm", location.href));
      if (!r.ok) throw new Error(`the Rust parser didn't load (${r.status})`);
      bytes = await r.arrayBuffer();
    }
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance.exports;
  })();
  engine.catch(() => (engine = null));
  return engine;
}
// (the outlines of the last few texts: entering an impl block or a module reuses its file's.  The parser keeps
//  every text it saw (proc-macro2's line tables), so after many bytes a fresh one is made)
const outlines = new Map();
let parsedBytes = 0;
export async function rustOutline(text) {
  if (outlines.has(text)) return outlines.get(text);
  const x = await parser();
  let s;
  try {
    const b = new TextEncoder().encode(text);
    const p = x.alloc(b.length) >>> 0;
    new Uint8Array(x.memory.buffer, p, b.length).set(b);
    const q = x.outline(p, b.length) >>> 0;
    const n = new DataView(x.memory.buffer).getUint32(q, true);
    s = new TextDecoder().decode(new Uint8Array(x.memory.buffer, q + 4, n).slice());
    x.dealloc(q, n + 4);
    parsedBytes += b.length;
    if (parsedBytes > 64 << 20) { engine = null; parsedBytes = 0; }
  } catch (e) {
    // (a trap (a panic, too deep a nesting) leaves the instance unusable: the next parse makes a new one)
    engine = null; parsedBytes = 0;
    throw new Error(`the Rust parser failed on it (${e?.message ?? e})`);
  }
  const o = JSON.parse(s);
  outlines.set(text, o);
  if (outlines.size > 4) outlines.delete(outlines.keys().next().value);
  return o;
}

// (an item's id; an impl block's and a module's with its line too: `impl A` twice, `impl From<u8> for A` and
//  `impl From<u16> for A`, or two #[cfg] `mod imp`, are each their own)
const idOf = (it) => (it.k === "fn" ? "f:" : it.k === "impl" ? "i:" : it.k === "trait" ? "t:" : it.k === "mod" ? "m:" : "y:") + it.name +
  (it.k === "impl" && it.trait ? ":" + it.trait : "") + (it.k === "impl" || (it.k === "mod" && it.inline) ? "@" + it.start : "");

export async function rustRoom(text, { path = "", scope = null } = {}) {
  const o = await rustOutline(text);
  if (o.error) throw new Error(`it doesn't parse: ${o.error} (line ${o.line})`);
  // (a container's room: down the scope's ids)
  let items = o.items, container = null;
  for (const id of scope ?? []) {
    container = items.find((it) => idOf(it) === id);
    if (!container) throw new Error(`no ${id} in ${path}`);
    items = container.items ?? [];
  }
  const lang = "rust";
  if (container && (container.k === "impl" || container.k === "trait")) {
    // (an impl block's or a trait's room: its methods, linked by self.m(), Self::m() and Type::m())
    const entities = items.map((f) => ({ id: "f:" + f.name, kind: "fn", title: f.sig + (f.required ? " (required)" : ""), name: f.name, group: "methods",
      start: f.start, end: f.end, doc: f.doc, refs: f.refs, own: f.params }));
    const head = container.k === "impl" ? `impl ${container.trait ? container.trait + " for " : ""}${container.name}` : `trait ${container.name}`;
    return buildRoom({ entities, text, lang, path, title: `${head} · ${path}`, summary: container.doc,
      room: { kind: "class", path, lang, name: head, scope }, self: ["self", "Self", container.name] });
  }
  const entities = [], portals = [];
  for (const it of items) {
    const base = { id: idOf(it), start: it.start, end: it.end, doc: it.doc, refs: it.refs };
    if (it.k === "fn") entities.push({ ...base, kind: "fn", title: it.sig, name: it.name, own: it.params });
    else if (it.k === "impl" || it.k === "trait") {
      const head = it.k === "impl" ? `impl ${it.trait ? it.trait + " for " : ""}${it.name}` : `trait ${it.name}`;
      // (an impl block's references: its methods', but not its own methods' names; and the type it is for)
      const calls = new Set(), methods = new Set(), names = new Set(it.refs?.names ?? []);
      for (const f of it.items) { for (const c of f.refs.calls) calls.add(c); for (const m of f.refs.methods) if (!m.startsWith("self.")) methods.add(m); for (const n of f.refs.names) if (!f.params.includes(n)) names.add(n); }
      for (const f of it.items) names.delete(f.name);
      entities.push({ ...base, kind: "class", title: head, name: it.k === "trait" ? it.name : undefined, forType: it.k === "impl" ? it.name : undefined, members: it.items.map((f) => f.name),
        enter: { kind: "class", scope: [...(scope ?? []), idOf(it)] }, refs: { calls: [...calls], methods: [...methods], names: [...names] },
        own: ["Self", "self"], links: it.k === "impl" ? [[it.name, "uses"], ...(it.trait ? [[it.trait, "uses"]] : [])] : [] });
    } else if (it.k === "mod" && it.inline) {
      entities.push({ ...base, kind: "class", title: "mod " + it.name, name: it.name, enter: { kind: "class", scope: [...(scope ?? []), idOf(it)] }, refs: { calls: [], methods: [], names: [] } });
    } else if (it.k === "mod") {
      portals.push({ id: "m:mod " + it.name, title: "mod " + it.name, locals: [it.name], imported: [], start: it.start, end: it.end, extra: { rust: { mod: it.name } } });
    } else if (it.k === "use") {
      // (one portal per module the paths come from: `use crate::poly::{Held, lift}` is crate::poly, bringing Held, lift)
      const by = new Map();
      for (const [p, local] of it.paths) {
        const segs = p.split("::"), mod = segs.length > 1 ? segs.slice(0, -1).join("::") : p, item = segs[segs.length - 1];
        const g = by.get(mod) ?? by.set(mod, { locals: [], imported: [] }).get(mod);
        if (local !== "*") g.locals.push(local);
        g.imported.push(item);
      }
      for (const [mod, g] of by) {
        const old = portals.find((x) => x.title === mod);
        if (old) { old.locals.push(...g.locals); old.imported.push(...g.imported); old.end = Math.max(old.end, it.end); continue; }
        portals.push({ id: "u:" + mod, title: mod, locals: g.locals, imported: g.imported, start: it.start, end: it.end, extra: { rust: { use: mod } } });
      }
    } else if (it.k === "type") {
      if (it.what === "macro_rules") entities.push({ ...base, kind: "block", title: `macro_rules! ${it.name}`, name: it.name + "!", names: [it.name + "!"] });
      else if (it.what === "invocation") entities.push({ ...base, kind: "block", title: it.name, names: [] });
      else entities.push({ ...base, kind: "block", title: `${it.what} ${it.name}`, name: it.name, names: [it.name] });
    }
  }
  const where = container ? `mod ${container.name} · ${path}` : path;
  return buildRoom({ entities, portals, text, lang, path, title: where || "a Rust file", summary: container ? container.doc : o.doc,
    room: container ? { kind: "class", path, lang, name: "mod " + container.name, scope } : { kind: "file", path, lang } });
}

// Where a `mod` or `use` leads in a tree of files: { path, sub } or null (the standard library, another crate that
// isn't in the tree).  `mod x;` in lib.rs, main.rs or mod.rs is x.rs or x/mod.rs beside it, in a.rs it is a/x.rs;
// `use crate::a::b::Item` is the deepest module of the path that is a file, from the crate's root (src/lib.rs or
// src/main.rs); self:: and super:: from this file's module; another crate by its directory's name.
export function resolveRust(tree, from, portal) {
  const has = new Set(tree.files.map((f) => f[0]));
  const dir = (p) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const base = (p) => p.slice(p.lastIndexOf("/") + 1);
  const modFile = (d, name) => (has.has(`${d ? d + "/" : ""}${name}.rs`) ? `${d ? d + "/" : ""}${name}.rs` : has.has(`${d ? d + "/" : ""}${name}/mod.rs`) ? `${d ? d + "/" : ""}${name}/mod.rs` : null);
  // (the directory where a file's child modules are)
  const childDir = (f) => (/^(lib|main|mod)\.rs$/.test(base(f)) ? dir(f) : f.replace(/\.rs$/, ""));
  const r = portal.rust ?? {};
  if (r.mod) { const p = modFile(childDir(from), r.mod); return p ? { path: p, sub: true } : null; }
  if (!r.use) return null;
  const segs = r.use.split("::");
  let d, file;
  if (segs[0] === "crate") {
    // (the crate's root: the nearest src/lib.rs or src/main.rs above this file)
    for (let a = dir(from); ; a = dir(a)) {
      const root = ["lib.rs", "main.rs"].map((n) => (a.endsWith("/src") || a === "src" ? `${a}/${n}` : `${a ? a + "/" : ""}src/${n}`)).find((p) => has.has(p));
      if (root) { file = root; d = dir(root); break; }
      if (!a) return null;
    }
    segs.shift();
  } else if (segs[0] === "self" || segs[0] === "super") {
    d = childDir(from); file = from;
    while (segs[0] === "self" || segs[0] === "super") {
      if (segs.shift() === "super") {
        // (up one module: this file's parent module's file)
        const up = /^(lib|main|mod)\.rs$/.test(base(file)) ? dir(dir(file)) : dir(file);
        file = modFile(dir(up), base(up)) ?? ["mod.rs", "lib.rs", "main.rs"].map((n) => `${up}/${n}`).find((p) => has.has(p)) ?? file;
        d = up;
      }
    }
  } else {
    // (another crate of the tree, by its directory: sagebrush_core is …/core or …/sagebrush-core)
    const names = [segs[0], segs[0].replace(/_/g, "-"), segs[0].replace(/^sagebrush_/, ""), segs[0].replace(/^sagebrush_/, "").replace(/_/g, "-")];
    const root = tree.files.map((f) => f[0]).find((p) => names.some((n) => p.endsWith(`/${n}/src/lib.rs`) || p === `${n}/src/lib.rs`));
    if (!root) return null;
    file = root; d = dir(root);
    segs.shift();
  }
  for (const s of segs) {
    const f = modFile(d, s);
    if (!f) break;
    file = f; d = /mod\.rs$/.test(f) ? dir(f) : f.replace(/\.rs$/, "");
  }
  // (`use crate::poly;` brings a module itself: its file)
  const only = (portal.imported ?? []).length === 1 ? modFile(d, portal.imported[0]) : null;
  if (only && only !== from) return { path: only, sub: true };
  return file && file !== from ? { path: file, sub: false } : null;
}
