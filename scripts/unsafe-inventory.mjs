// The engine's unsafe-code boundary (no-cliffs C-2c-ii scope r4 section 1.3, r5): the workspace denies
// the `unsafe_code` lint (engine/Cargo.toml), and each existing site carries `#[allow(unsafe_code)]` on
// its smallest enclosing item.  This pins those exceptions: test/unsafe-allow-inventory.json lists every
// allowed item with a hash of its tokens (comments and layout excluded, so only a code change moves it)
// and its audit answer.  It fails, naming the cause, on:
// - any spelling of the lint other than an outer `#[allow(unsafe_code)]` attribute alone (warn, expect,
//   forbid, deny, an inner `#![...]`, cfg_attr, another lint in the same list, a macro building one);
// - an allow nested inside another allowed item (each site is covered exactly once);
// - an allowed item that is new, gone or changed against the inventory, or whose audit is missing;
// - a member Cargo.toml without `[lints] workspace = true`, or with its own lint table; the workspace
//   lint not "deny"; `unsafe_code` or `--cap-lints` named anywhere else in the tracked files.
// The compiler proves the other half (every unsafe site is inside an allowed item); this proves that
// the allowed set is exactly the reviewed one.
//   node scripts/unsafe-inventory.mjs --check      (CI)
//   node scripts/unsafe-inventory.mjs --write      (refresh hashes; new items get audit "UNAUDITED")
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBuildInput } from "./build-inputs.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
export const INVENTORY = "test/unsafe-allow-inventory.json";

// ---- a Rust tokenizer: identifiers, punctuation, literals; comments and whitespace dropped
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const isId = (c) => /[A-Za-z0-9_]/.test(c);
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; } else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; } else i++;
      }
      if (depth > 0) throw new Error("unterminated block comment");
      continue;
    }
    const start = i;
    // raw strings r"..." r#"..."# (also br, cr)
    const raw = /^(b|c)?r(#*)"/.exec(src.slice(i, i + 260));
    if (raw && (i === 0 || !isId(src[i - 1]))) {
      const close = '"' + raw[2];
      const end = src.indexOf(close, i + raw[0].length);
      if (end < 0) throw new Error("unterminated raw string");
      i = end + close.length;
      out.push({ t: "lit", v: src.slice(start, i), at: start });
      continue;
    }
    if (c === '"' || ((c === "b" || c === "c") && src[i + 1] === '"' && (i === 0 || !isId(src[i - 1])))) {
      i += c === '"' ? 1 : 2;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      if (i >= n) throw new Error("unterminated string");
      i++;
      out.push({ t: "lit", v: src.slice(start, i), at: start });
      continue;
    }
    if (c === "'" || (c === "b" && src[i + 1] === "'" && (i === 0 || !isId(src[i - 1])))) {
      // a char literal ('x', '\n', '\u{..}', b'x') or a lifetime/label ('a)
      const j = c === "'" ? i + 1 : i + 2;
      const m = /^(\\(u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/su.exec(src.slice(j, j + 16));
      if (m) { i = j + m[0].length; out.push({ t: "lit", v: src.slice(start, i), at: start }); continue; }
      i = j;
      while (i < n && isId(src[i])) i++;
      out.push({ t: "life", v: src.slice(start, i), at: start });
      continue;
    }
    if (isId(c)) {
      if (c === "r" && src[i + 1] === "#" && isId(src[i + 2] ?? "")) i += 2; // raw identifier r#name
      while (i < n && isId(src[i])) i++;
      // number suffixes / floats stay one token enough for hashing purposes
      out.push({ t: /^[0-9]/.test(src[start]) ? "num" : "id", v: src.slice(start, i).replace(/^r#/, ""), at: start });
      continue;
    }
    out.push({ t: "p", v: c, at: start });
    i++;
  }
  return out;
}

const lineOf = (src, at) => src.slice(0, at).split("\n").length;

// the index just past the item starting at token k (after its attributes): its braces, or its `;`
function itemEnd(toks, k) {
  let depth = 0;
  for (let j = k; j < toks.length; j++) {
    const v = toks[j].v;
    if (toks[j].t !== "p") continue;
    if (v === "(" || v === "[" || v === "{") depth++;
    else if (v === ")" || v === "]") depth--;
    else if (v === "}") { depth--; if (depth === 0) return j + 1; }
    else if (v === ";" && depth === 0) return j + 1;
  }
  throw new Error("item without an end");
}

// the allowed items of one file: [{ item, line, hash, start, end }], or errors
// each token's enclosing impl / trait / mod / macro_rules! headers, outermost first ("" at top level)
function contexts(toks) {
  const ctx = new Array(toks.length);
  const stack = [];
  let since = 0; // the first token of the current header (after the last `;`, `{` or `}`)
  for (let i = 0; i < toks.length; i++) {
    ctx[i] = stack.filter(Boolean).join(" > ");
    const v = toks[i].v;
    if (toks[i].t !== "p") continue;
    if (v === "{") {
      const head = toks.slice(since, i).filter((x) => !(x.t === "p" && x.v === "#"));
      const kw = head.findIndex((x) => x.t === "id" && ["impl", "trait", "mod", "macro_rules"].includes(x.v));
      // (attributes before the header are skipped: from the keyword on)
      stack.push(kw < 0 ? null : head.slice(kw).map((x) => x.v).join(" ").replace(/ ([,>)\]]) ?/g, "$1 ").replace(/ < /g, "<").trim());
      since = i + 1;
    } else if (v === "}") {
      stack.pop();
      since = i + 1;
    } else if (v === ";") since = i + 1;
  }
  return ctx;
}

export function scanFile(rel, src) {
  const toks = tokenize(src);
  const ctx = contexts(toks);
  const errors = [], items = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t !== "id" || toks[k].v !== "unsafe_code") continue;
    const at = lineOf(src, toks[k].at);
    // exactly `# [ allow ( unsafe_code ) ]`: not `#![...]` (the token before `[` would be `!`), not
    // cfg_attr (before `allow` would be `,`), not with another lint (after it would be `,`)
    const v = (d) => toks[k + d]?.v;
    if (!(v(-4) === "#" && v(-3) === "[" && v(-2) === "allow" && v(-1) === "(" && v(1) === ")" && v(2) === "]")) {
      errors.push(`${rel}:${at}: unsafe_code named other than as an outer #[allow(unsafe_code)] alone (${toks.slice(Math.max(0, k - 5), k + 3).map((x) => x.v).join(" ")})`);
      continue;
    }
    // the item's start: back over the outer attributes before the allow (so they are hashed too)
    let s = k - 4;
    while (s > 0 && toks[s - 1].v === "]") {
      let d = 0, b = s - 1;
      for (; b >= 0; b--) {
        if (toks[b].v === "]") d++;
        else if (toks[b].v === "[" && --d === 0) break;
      }
      if (b > 0 && toks[b - 1].v === "#") s = b - 1;
      else break;
    }
    // the item: skip the following attributes (#[...]) and find its end
    let j = k + 3;
    while (toks[j] && toks[j].v === "#" && toks[j + 1]?.v === "[") j = itemEnd(toks, j + 1);
    const end = itemEnd(toks, j);
    const body = toks.slice(j, end);
    const hashed = toks.slice(s, end);
    const kw = body.findIndex((x) => x.t === "id" && ["fn", "impl", "static", "trait", "mod", "const"].includes(x.v));
    const own = kw < 0 ? "?" : body[kw].v === "impl" ? "impl " + body.slice(kw + 1, body.findIndex((x) => x.v === "{")).map((x) => x.v).join(" ") : body[kw].v + " " + (body[kw + 1]?.v === "$" ? "$" + (body[kw + 2]?.v ?? "?") : body[kw + 1]?.v ?? "?");
    const name = (ctx[j] ? ctx[j] + " > " : "") + own;
    const hash = createHash("sha256").update(hashed.map((x) => x.v).join(" ")).digest("hex");
    items.push({ item: name, line: at, hash, start: s, end, from: lineOf(src, toks[s].at), to: lineOf(src, toks[end - 1].at) });
  }
  // each site exactly once: no allowed item inside another
  for (const a of items) for (const b of items) if (a !== b && b.start >= a.start && b.end <= a.end) errors.push(`${rel}:${b.line}: an allowed item inside another allowed item (${a.item}, line ${a.line})`);
  // the generation closure the compiler sweep can't see (#234 r2 U1: rustc doesn't report unsafe produced by
  // another crate's macros): no code include!, no exported macro, and every `unsafe` inside a macro_rules!
  // body lies in an allowed item written in that body (so the macro's expansion is the pinned item)
  for (let k = 0; k + 1 < toks.length; k++) {
    const at = () => lineOf(src, toks[k].at);
    if (toks[k].t === "id" && toks[k].v === "include" && toks[k + 1].v === "!") errors.push(`${rel}:${at()}: include! of code (generated or out-of-tree source can't be pinned; include_str!/include_bytes! data is fine)`);
    if (toks[k].t === "id" && toks[k].v === "macro_export") errors.push(`${rel}:${at()}: #[macro_export] (a macro expanded in another crate is invisible to the compiler sweep: review it, then extend the check)`);
    if (toks[k].t === "id" && toks[k].v === "macro_rules" && toks[k + 1].v === "!") {
      let j = k + 2;
      while (toks[j] && toks[j].v !== "{" && toks[j].v !== "(" && toks[j].v !== "[") j++;
      const end = itemEnd(toks, j);
      for (let u = j; u < end; u++) {
        if (toks[u].t === "id" && toks[u].v === "unsafe" && !items.some((x) => u >= x.start && u < x.end)) errors.push(`${rel}:${lineOf(src, toks[u].at)}: unsafe in a macro_rules! body outside an allowed item written in it`);
      }
    }
  }
  return { items, errors };
}

function tracked() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

// ---- the engine workspace's membership, from a strict model of its manifests (#234 r2 U2): no globs, no
// exclude, no patch/replace; every tracked Cargo.toml under engine/ is the root or a listed member; every
// path dependency resolves to a listed member; every member inherits the workspace lints.  Anything the
// model can't account for is an error, never skipped.  (`--metadata` cross-checks it against cargo's.)
// The test-only crates linking LGPL FLINT, kept out of every shipped graph (and of the compiler sweep)
export const TEST_ONLY = ["flint", "oracle"];
export function workspaceModel(files, read) {
  const errors = [];
  const ws = read("engine/Cargo.toml");
  const membersText = /\n\[workspace\]\n(?:[^\[]*?\n)?members\s*=\s*\[([^\]]*)\]/.exec("\n" + ws);
  if (!membersText) return { errors: ["engine/Cargo.toml: no literal [workspace] members = [...] list"], members: [] };
  const members = [...membersText[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  for (const m of members) if (/[*?\[\]{}]/.test(m) || m.includes("..") || m.includes("/") || !m) errors.push(`engine/Cargo.toml: member "${m}" is a glob, a nested path or a path out of engine/ (the model takes only plain names)`);
  for (const k of ["exclude", "default-members"]) if (new RegExp(`\\n${k}\\s*=`).test(ws)) errors.push(`engine/Cargo.toml: workspace ${k} is not modelled (review it, then extend the model)`);
  const manifests = files.filter((f) => f.startsWith("engine/") && /(^|\/)Cargo\.toml$/.test(f));
  for (const f of manifests) {
    if (f === "engine/Cargo.toml") continue;
    const m = /^engine\/([^/]+)\/Cargo\.toml$/.exec(f);
    if (!m || !members.includes(m[1])) errors.push(`${f}: a manifest under engine/ that isn't a listed workspace member (implicit, nested or another workspace)`);
  }
  for (const m of members) if (!files.includes(`engine/${m}/Cargo.toml`)) errors.push(`engine/Cargo.toml: member "${m}" has no tracked manifest`);
  const deps = {};
  for (const f of ["engine/Cargo.toml", ...members.map((m) => `engine/${m}/Cargo.toml`)].filter((f) => files.includes(f))) {
    const t = read(f);
    const dir = f.slice(0, f.lastIndexOf("/"));
    if (/^\s*\[(patch|replace)\b/m.test(t)) errors.push(`${f}: [patch]/[replace] is not modelled`);
    if (f !== "engine/Cargo.toml") {
      if (!/\n\[lints\]\nworkspace = true\n/.test(t)) errors.push(`${f}: [lints] workspace = true missing`);
      if (/\[lints\./.test(t) || /\[lints\][^\[]*\n(?!workspace = true)[a-z]/.test(t)) errors.push(`${f}: its own lint table`);
    }
    // path dependencies: every one must be a listed member (a path elsewhere would be built without the lints)
    let section = "";
    const own = f === "engine/Cargo.toml" ? null : dir.slice("engine/".length);
    deps[own] = new Set();
    for (const line of t.split("\n")) {
      const h = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
      if (h) { section = h[1].trim(); continue; }
      if (!/dependencies/.test(section)) continue;
      const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1] ?? (/dependencies\.([A-Za-z0-9_-]+)$/.exec(section)?.[1]);
      const pkg = /package\s*=\s*"([^"]+)"/.exec(line)?.[1];
      if (own && (pkg ?? name)) deps[own].add(pkg ?? name);
      for (const p of line.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) {
        const parts = (dir + "/" + p[1]).split("/");
        const norm = [];
        for (const x of parts) { if (x === "..") norm.pop(); else if (x !== "." && x !== "") norm.push(x); }
        const target = norm.join("/");
        const tm = /^engine\/([^/]+)$/.exec(target);
        if (!tm || !members.includes(tm[1])) errors.push(`${f}: path dependency "${p[1]}" -> ${target} is not a listed workspace member`);
      }
    }
  }
  // the test-only crates stay out of shipped graphs: only another test-only crate may depend on them
  for (const [m, ds] of Object.entries(deps)) for (const t of TEST_ONLY) if (m !== "null" && !TEST_ONLY.includes(m) && ds.has(`sagebrush-${t}`)) errors.push(`engine/${m}/Cargo.toml: depends on test-only sagebrush-${t}`);
  return { errors, members, deps };
}

// ---- overrides in build inputs (#234 r2 U3a): the lint name in either spelling (rustc takes unsafe-code too),
// cap-lints and force-warn, anywhere in a build input; only the canonical workspace deny and the compiler
// sweep's own force-warn line are expected, each exactly once
export const CANONICAL_DENY = '\n[workspace.lints.rust]\nunsafe_code = "deny"\n';
export const SWEEP_FLAGS = 'RUSTFLAGS: "--force-warn unsafe-code"';
const OVERRIDE = /unsafe[-_]code|cap-lints|force-warn/i;
export function overrideErrors(files, read) {
  const errors = [];
  const own = new Set(["scripts/unsafe-inventory.mjs", "scripts/test-unsafe-inventory.mjs", "scripts/build-inputs.mjs", INVENTORY]);
  for (const f of files) {
    if (own.has(f) || !isBuildInput(f)) continue;
    if (f.startsWith("engine/") && f.endsWith(".rs")) continue; // (the token scanner's)
    let t;
    try { t = read(f); } catch { continue; }
    if (f === "engine/Cargo.toml") {
      if (t.split(CANONICAL_DENY).length !== 2) { errors.push(`engine/Cargo.toml: the canonical [workspace.lints.rust] unsafe_code = "deny" block, exactly once`); continue; }
      t = t.replace(CANONICAL_DENY, "\n");
    }
    if (f === ".github/workflows/ci.yml") {
      if (t.split(SWEEP_FLAGS).length !== 2) errors.push(`.github/workflows/ci.yml: the compiler sweep's ${SWEEP_FLAGS}, exactly once`);
      t = t.replace(SWEEP_FLAGS, "");
    }
    if (f.endsWith(".rs")) {
      if (/unsafe[-_]code/i.test(t)) errors.push(`${f}: Rust outside engine/ names the unsafe-code lint (the boundary has no exceptions there)`);
      continue;
    }
    const m = OVERRIDE.exec(t);
    if (m) errors.push(`${f}:${lineOf(t, m.index)}: "${m[0]}" in a build input (a lint override; only engine/Cargo.toml's deny and the sweep's force-warn line may name it)`);
  }
  return errors;
}

// re-exports of the ledger: none outside it, so "a crate without a direct ledger dependency can't name a
// ledger type" (the audits' premise) holds; the premise itself is checked per crate below
function reexportErrors(rel, toks) {
  const errors = [];
  for (let k = 0; k + 2 < toks.length; k++) {
    if (toks[k].v !== "pub") continue;
    let j = k + 1;
    if (toks[j].v === "use" || (toks[j].v === "extern" && toks[j + 1]?.v === "crate")) {
      j += toks[j].v === "use" ? 1 : 2;
      while (toks[j] && toks[j].v === ":") j++;
      if (toks[j]?.v === "sagebrush_ledger") errors.push(`${rel}: re-exports sagebrush_ledger (pub use / pub extern crate)`);
    }
  }
  return errors;
}

export function scan(files = tracked(), read = (f) => readFileSync(join(ROOT, f), "utf8"), premises = null) {
  const errors = [], found = [];
  for (const f of files.filter((f) => f.startsWith("engine/") && f.endsWith(".rs"))) {
    let r, src;
    try { src = read(f); r = scanFile(f, src); } catch (e) { errors.push(`${f}: ${e.message}`); continue; }
    errors.push(...r.errors);
    if (!f.startsWith("engine/ledger/")) errors.push(...reexportErrors(f, tokenize(src)));
    for (const it of r.items) found.push({ file: f, item: it.item, hash: it.hash, from: it.from, to: it.to });
  }
  if (!files.includes("engine/Cargo.toml")) return { errors: [...errors, "engine/Cargo.toml missing"], found };
  const model = workspaceModel(files, read);
  errors.push(...model.errors);
  errors.push(...overrideErrors(files, read));
  // build scripts: exactly the pinned ones, byte for byte (a build script can generate code: #234 r2 U1)
  const pinnedBuild = premises?.build_scripts ?? {};
  const buildFiles = files.filter((f) => /^engine\/.*(^|\/)build\.rs$/.test(f));
  for (const m of model.members) if (/\nbuild\s*=/.test(read(`engine/${m}/Cargo.toml`))) errors.push(`engine/${m}/Cargo.toml: a custom build = key is not modelled`);
  for (const f of buildFiles) {
    const h = createHash("sha256").update(read(f)).digest("hex");
    if (!pinnedBuild[f]) errors.push(`${f}: a build script not pinned in ${INVENTORY} (review what it generates, then pin it)`);
    else if (pinnedBuild[f].sha256 !== h) errors.push(`${f}: the build script changed (sha256 ${h.slice(0, 12)}): re-review it`);
  }
  for (const f of Object.keys(pinnedBuild)) if (!buildFiles.includes(f)) errors.push(`${f}: pinned but not found`);
  // local proc-macro crates: none unless pinned, each by a hash over its whole tracked source (the caller's
  // item hash can't see a generator change; this does)
  for (const [dir, pin] of Object.entries(premises?.local_proc_macros ?? {})) {
    const own = files.filter((f) => f.startsWith(dir + "/")).sort();
    if (!own.length) { errors.push(`${dir}: a pinned local proc-macro crate not found`); continue; }
    const h = createHash("sha256");
    for (const f of own) h.update(f + "\0" + read(f) + "\0");
    const d = h.digest("hex");
    if (d !== pin.sha256) errors.push(`${dir}: the local proc-macro crate changed (sha256 ${d.slice(0, 12)}): re-review what it generates`);
  }
  // the audits' premise: these crates have no direct ledger dependency (any section, any name)
  for (const c of premises?.no_ledger_dep ?? []) {
    if (!model.members.includes(c)) { errors.push(`premise no_ledger_dep: "${c}" is not a member`); continue; }
    if (model.deps[c]?.has("sagebrush-ledger")) errors.push(`engine/${c}/Cargo.toml: depends on sagebrush-ledger, against the audits' premise (re-audit its items)`);
  }
  return { errors, found, model };
}

export function check(inv, found) {
  const errors = [];
  const key = (x) => `${x.file} :: ${x.item}`;
  const want = new Map(inv.items.map((x) => [key(x), x]));
  const have = new Map();
  for (const x of found) {
    if (have.has(key(x))) { errors.push(`${key(x)}: two allowed items with this name in one file (rename or merge)`); continue; }
    have.set(key(x), x);
  }
  for (const [k, x] of have) {
    const w = want.get(k);
    if (!w) errors.push(`${k}: a new allowed item, not in ${INVENTORY} (it needs its own review and audit)`);
    else if (w.hash !== x.hash) errors.push(`${k}: the allowed item changed (hash ${x.hash.slice(0, 12)}, inventory ${w.hash.slice(0, 12)}): re-review it`);
  }
  for (const k of want.keys()) if (!have.has(k)) errors.push(`${k}: in ${INVENTORY} but not found`);
  for (const w of inv.items) if (!w.audit || /^UNAUDITED/.test(w.audit)) errors.push(`${key(w)}: no audit answer`);
  return errors;
}

// ---- the compiler sweep (#234 r2 U1): cargo's JSON under RUSTFLAGS="--force-warn unsafe-code" reports every
// unsafe_code site whatever allows it, generated and expanded code included.  Each site in the repo or in a
// build script's OUT_DIR must lie inside a pinned allowed item; registry and toolchain sources are outside
// the boundary.  Returns { sites, errors }.
export function compilerSites(jsonTexts, found, root = ROOT) {
  const errors = [], sites = [];
  const byFile = new Map();
  for (const x of found) (byFile.get(x.file) ?? byFile.set(x.file, []).get(x.file)).push(x);
  const external = (p) => /\/\.cargo\/(registry|git)\/|^\/rustc\/|\/lib\/rustlib\//.test(p);
  for (const text of jsonTexts) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.reason !== "compiler-message" || (m.message?.code?.code) !== "unsafe_code") continue;
      const sp = m.message.spans.find((s) => s.is_primary) ?? m.message.spans[0];
      if (!sp) { errors.push(`an unsafe_code report without a span (${m.message.message})`); continue; }
      let p = sp.file_name;
      if (external(p)) continue;
      if (p.startsWith(root)) p = p.slice(root.length);
      else if (!p.startsWith("/")) p = "engine/" + p;
      sites.push(`${p}:${sp.line_start}`);
      if (p.startsWith("/") || /\/out\//.test(p) || /(^|\/)target\//.test(p)) { errors.push(`${p}:${sp.line_start}: an unsafe_code site in generated code (OUT_DIR or another file outside the tree): ${m.message.message}`); continue; }
      const ok = (byFile.get(p) ?? []).some((x) => sp.line_start >= x.from && sp.line_start <= x.to);
      if (!ok) errors.push(`${p}:${sp.line_start}: an unsafe_code site outside every pinned allowed item: ${m.message.message}`);
    }
  }
  return { sites: [...new Set(sites)], errors };
}

// `--metadata FILE`: `cargo metadata --format-version 1 --locked` run in engine/ (the sweep's own root, config and
// lockfile).  Its workspace members must equal the model's; no member may be a proc-macro crate; the external
// proc-macro crates (whose expansions the compiler sweep can't see, rustc treating them as external) must be
// exactly the pinned name/version set; the build scripts must be exactly the pinned ones
export function metadataErrors(metaText, model, premises, root = ROOT) {
  const errors = [];
  let meta;
  try { meta = JSON.parse(metaText); } catch { return ["cargo metadata output isn't JSON (a failed metadata run rejects)"]; }
  if (!Array.isArray(meta.workspace_members) || !Array.isArray(meta.packages)) return ["cargo metadata output has no workspace_members/packages"];
  const ws = new Set(meta.workspace_members);
  const rel = (p) => p.replace(root, "").replace(/\/Cargo\.toml$/, "").replace(/^engine\//, "");
  const dirs = meta.packages.filter((p) => ws.has(p.id)).map((p) => rel(p.manifest_path));
  const a = [...dirs].sort().join(","), b = [...model.members].sort().join(",");
  if (a !== b) errors.push(`cargo metadata's workspace members (${a}) differ from the model's (${b})`);
  const kinds = (p) => p.targets.flatMap((t) => t.kind);
  const pinnedPm = premises?.local_proc_macros ?? {};
  for (const p of meta.packages) if (ws.has(p.id) && kinds(p).includes("proc-macro") && !pinnedPm[`engine/${rel(p.manifest_path)}`]) errors.push(`engine/${rel(p.manifest_path)}: a local proc-macro crate not pinned (its expansions are invisible to the compiler sweep)`);
  const ext = meta.packages.filter((p) => !ws.has(p.id) && kinds(p).includes("proc-macro")).map((p) => `${p.name} ${p.version}`).sort();
  const want = [...(premises?.external_proc_macros ?? [])].sort();
  if (ext.join(",") !== want.join(",")) errors.push(`the external proc-macro crates (${ext.join(", ")}) differ from the pinned set (${want.join(", ")}): review the new or changed ones`);
  const builds = meta.packages.filter((p) => ws.has(p.id)).flatMap((p) => p.targets.filter((t) => t.kind.includes("custom-build")).map((t) => t.src_path.replace(root, ""))).sort();
  const wantB = Object.keys(premises?.build_scripts ?? {}).sort();
  if (builds.join(",") !== wantB.join(",")) errors.push(`cargo's build scripts (${builds.join(", ")}) differ from the pinned ones (${wantB.join(", ")})`);
  return errors;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = join(ROOT, INVENTORY);
  let inv0 = { items: [] };
  try { inv0 = JSON.parse(readFileSync(path, "utf8")); } catch {}
  const { errors, found, model } = scan(undefined, undefined, inv0.premises);
  if (process.argv.includes("--write")) {
    const audits = new Map(inv0.items.map((x) => [`${x.file} :: ${x.item}`, x.audit]));
    const items = found.map(({ from, to, ...x }) => ({ ...x, audit: audits.get(`${x.file} :: ${x.item}`) ?? "UNAUDITED" }));
    writeFileSync(path, JSON.stringify({ comment: inv0.comment ?? "", premises: inv0.premises ?? {}, items }, null, 1) + "\n");
    console.log(`wrote ${INVENTORY}: ${items.length} items`);
  }
  const inv = JSON.parse(readFileSync(path, "utf8"));
  const all = [...errors, ...check(inv, found)];
  // (the files after a flag, up to the next flag)
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    if (i < 0) return [];
    const rest = process.argv.slice(i + 1);
    const stop = rest.findIndex((x) => x.startsWith("--"));
    return stop < 0 ? rest : rest.slice(0, stop);
  };
  const compiler = arg("--compiler");
  if (compiler.length) {
    const r = compilerSites(compiler.map((f) => readFileSync(f, "utf8")), found, ROOT);
    all.push(...r.errors);
    if (r.sites.length === 0) all.push("the compiler sweep reported no unsafe_code site at all (a misconfigured sweep, not a clean tree)");
    console.log(`compiler sweep: ${r.sites.length} distinct sites, each checked against the pinned items`);
  }
  const meta = arg("--metadata");
  if (meta.length && model) all.push(...metadataErrors(readFileSync(meta[0], "utf8"), model, inv.premises, ROOT));
  for (const e of all) console.log("FAIL", e);
  console.log(all.length ? `${all.length} problems` : `unsafe inventory: ${found.length} allowed items, all pinned and audited`);
  process.exit(all.length ? 1 : 0);
}
