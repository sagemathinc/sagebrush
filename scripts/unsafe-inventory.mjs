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
    items.push({ item: name, line: at, hash, start: s, end });
  }
  // each site exactly once: no allowed item inside another
  for (const a of items) for (const b of items) if (a !== b && b.start >= a.start && b.end <= a.end) errors.push(`${rel}:${b.line}: an allowed item inside another allowed item (${a.item}, line ${a.line})`);
  return { items, errors };
}

function tracked() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

export function scan(files = tracked(), read = (f) => readFileSync(join(ROOT, f), "utf8")) {
  const errors = [], found = [];
  for (const f of files.filter((f) => f.startsWith("engine/") && f.endsWith(".rs"))) {
    let r;
    try { r = scanFile(f, read(f)); } catch (e) { errors.push(`${f}: ${e.message}`); continue; }
    errors.push(...r.errors);
    for (const it of r.items) found.push({ file: f, item: it.item, hash: it.hash });
  }
  // the lint configuration
  const ws = read("engine/Cargo.toml");
  if (!/\n\[workspace\.lints\.rust\]\nunsafe_code = "deny"\n/.test(ws)) errors.push(`engine/Cargo.toml: [workspace.lints.rust] unsafe_code = "deny" missing`);
  const members = [...(/members = \[([^\]]*)\]/.exec(ws)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const m of members) {
    const f = `engine/${m}/Cargo.toml`;
    if (!files.includes(f)) continue; // (a member deleted in this tree)
    const t = read(f);
    if (!/\n\[lints\]\nworkspace = true\n/.test(t)) errors.push(`${f}: [lints] workspace = true missing`);
    if (/\[lints\.|\nunsafe_code|\[lints\][^\[]*\n(?!workspace = true)[a-z]/.test(t)) errors.push(`${f}: its own lint table or unsafe_code setting`);
  }
  // unsafe_code / --cap-lints anywhere else
  const own = new Set(["engine/Cargo.toml", "scripts/unsafe-inventory.mjs", "scripts/test-unsafe-inventory.mjs", INVENTORY]);
  for (const f of files) {
    if (own.has(f) || (f.startsWith("engine/") && f.endsWith(".rs")) || /\.(wasm|png|gz|jpg|ico|woff2?)$/.test(f)) continue;
    if (/^engine\/[^/]+\/Cargo\.toml$/.test(f)) continue;
    let t;
    try { t = read(f); } catch { continue; }
    if (/unsafe_code|cap-lints/.test(t)) errors.push(`${f}: names unsafe_code or --cap-lints (only engine/Cargo.toml and the allowed items may)`);
  }
  return { errors, found };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const { errors, found } = scan();
  const path = join(ROOT, INVENTORY);
  if (process.argv.includes("--write")) {
    let old = { items: [] };
    try { old = JSON.parse(readFileSync(path, "utf8")); } catch {}
    const audits = new Map(old.items.map((x) => [`${x.file} :: ${x.item}`, x.audit]));
    const items = found.map((x) => ({ ...x, audit: audits.get(`${x.file} :: ${x.item}`) ?? "UNAUDITED" }));
    writeFileSync(path, JSON.stringify({ comment: old.comment ?? "", items }, null, 1) + "\n");
    console.log(`wrote ${INVENTORY}: ${items.length} items`);
  }
  const inv = JSON.parse(readFileSync(path, "utf8"));
  const all = [...errors, ...check(inv, found)];
  for (const e of all) console.log("FAIL", e);
  console.log(all.length ? `${all.length} problems` : `unsafe inventory: ${found.length} allowed items, all pinned and audited`);
  process.exit(all.length ? 1 : 0);
}
