#!/usr/bin/env node
// Every parallel mechanism in the engine crates goes through sagebrush-par
// (no-cliffs C r9 section 4, C-2c scope r2 section 1.5): the one wrapper whose
// closures run under their caller's ledger context and sequentially in
// exclusive mode.  This fails on any other use in an engine crate's src/
// tree: rayon (any mention, so aliases and glob imports too), parallel
// iterator methods (`.par_*(`, `into_par_iter`, `par_bridge`), thread pools,
// and the standard library's spawn/scope/Builder, however imported: plain,
// grouped (`use std::thread::{self as t}`), renamed, or across lines.
//
// The source is first stripped lexically: comments (line, nested block, doc)
// and the contents of string, raw-string and character literals become
// spaces, so neither a comment nor a string hides code, and a mention inside
// a string or a comment is not code.  A `use` statement is matched as a
// whole, newlines included.  A token check is a backstop, not the proof: the
// wrapper's own tests prove the context is carried.  Exemptions are the
// reviewed list below (by file, or by file and line text), never an inline
// comment: a `#[cfg(test)]` module needs its own entry.
//
//   node scripts/check-par.mjs [ROOT]    (ROOT: the repository, by default)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// the wrapper itself
const WRAPPER = "engine/par/src/";
// reviewed exemptions: [file, the exact trimmed line text or null for the whole file, reason]
export const EXEMPT = [
  ["engine/ledger/src/tests.rs", null, "the ledger's own unit tests (threads that race admissions on purpose)"],
  ["engine/interrupt/src/progress.rs", "let a = std::thread::spawn(move || {", "inside #[cfg(test)] mod tests"],
  ["engine/interrupt/src/progress.rs", "let w = std::thread::spawn(move || {", "inside #[cfg(test)] mod tests"],
  // Ctrl-C PR B: the worker's control listener (Unix), a blocking reader of the control fd that arms a request and wakes
  // the main thread with SIGUSR1.  It runs no engine work and carries no ledger context, and it must run concurrently
  // with the request it interrupts: under sagebrush-par's exclusive (sequential) mode it would run inline, forever.
  ["engine/py/src/serve.rs", "std::thread::Builder::new()", "the dedicated once-per-process control reader (sagebrush-control): no user or compute work; must stay concurrent with the request loop"],
  ["engine/py/src/serve.rs", "let t = std::thread::spawn(move || {", "inside #[cfg(test)] mod tests (a pipe writer)"],
];

// rules for code, line by line (after stripping)
const RULES = [
  [/\brayon\b/, "rayon"],
  [/\.\s*par_[A-Za-z_]+\s*(::\s*<[^>]*>)?\s*\(/, "a parallel iterator method"],
  [/\binto_par_iter\b|\bpar_bridge\b|\bpar_iter(_mut)?\b|\bpar_chunks(_mut|_exact)?\b/, "a parallel iterator"],
  [/\bThreadPool(Builder)?\b/, "a thread pool"],
  [/\bthread\s*::\s*(spawn|scope|Builder)\b/, "std::thread spawn/scope/Builder"],
];
// rules for a whole `use` statement (after stripping, whitespace collapsed)
const USE_RULES = [
  [/\bstd\s*::\s*thread\s+as\b/, "an alias of std::thread"],
  [/\bstd\s*::\s*thread\s*::\s*\{[^}]*\bself\b/, "a grouped import of std::thread itself"],
  [/\bstd\s*::\s*thread\s*::\s*\{[^}]*\b(spawn|scope|Builder)\b/, "an import of std::thread spawn/scope/Builder"],
  [/\bstd\s*::\s*thread\s*::\s*(spawn|scope|Builder)\b/, "an import of std::thread spawn/scope/Builder"],
  [/\bstd\s*::\s*\{[^;]*\bthread\b/, "an import of std::thread in a group"],
  [/\bstd\s*::\s*thread\s*::\s*\*/, "a glob import of std::thread"],
];

/** The source with comments and literal contents replaced by spaces (newlines kept). */
export function strip(src) {
  const out = src.split("");
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
    } else if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if ((c === "r" || (c === "b" && d === "r")) && /^b?r#*"/.test(src.slice(i, i + 260)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")) {
      // a raw string: r"..", r#".."#, br#".."#
      const m = /^b?r(#*)"/.exec(src.slice(i));
      const close = '"' + m[1];
      const start = i + m[0].length;
      let j = src.indexOf(close, start);
      j = j < 0 ? n : j + close.length;
      blank(start, j - close.length);
      i = j;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = j + 1;
    } else if (c === "'") {
      // a char literal ('x', '\n', '\u{..}'), not a lifetime ('a)
      const m = /^'(\\.[^']*|[^\\'])'/.exec(src.slice(i, i + 16));
      if (m) {
        blank(i + 1, i + m[0].length - 1);
        i += m[0].length;
      } else i++;
    } else i++;
  }
  return out.join("");
}

function* rustFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* rustFiles(p);
    else if (name.endsWith(".rs")) yield p;
  }
}

/** The findings for one file's source (rel: its path from the repository root). */
export function checkSource(rel, src) {
  const out = [];
  if (rel.startsWith(WRAPPER)) return out;
  if (EXEMPT.some(([file, text]) => file === rel && text === null)) return out;
  const orig = src.split("\n");
  const code = strip(src);
  const lines = code.split("\n");
  // (the whole trimmed line must equal the entry's text: other code can't ride along on an exempt line)
  const exempt = (i) => EXEMPT.some(([file, text]) => file === rel && text !== null && orig[i].trim() === text);
  lines.forEach((line, i) => {
    for (const [re, what] of RULES) {
      if (re.test(line) && !exempt(i)) {
        out.push(`${rel}:${i + 1}: ${what} outside sagebrush-par: ${orig[i].trim()}`);
        break;
      }
    }
  });
  // whole `use` statements, across lines
  for (const m of code.matchAll(/\buse\b[^;]*;/g)) {
    const stmt = m[0].replace(/\s+/g, " ");
    const line = code.slice(0, m.index).split("\n").length - 1;
    for (const [re, what] of USE_RULES) {
      if (re.test(stmt) && !exempt(line)) {
        out.push(`${rel}:${line + 1}: ${what} outside sagebrush-par: ${stmt.trim()}`);
        break;
      }
    }
  }
  return out;
}

export function check(root) {
  const out = [];
  const engine = join(root, "engine");
  for (const crate of readdirSync(engine)) {
    const src = join(engine, crate, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of rustFiles(src)) {
      const rel = relative(root, f).split(sep).join("/");
      out.push(...checkSource(rel, readFileSync(f, "utf8")));
    }
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith("check-par.mjs")) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..");
  const v = check(root);
  for (const l of v) console.error(l);
  if (v.length) {
    console.error(`${v.length} parallel use(s) outside engine/par (route them through sagebrush-par, or add a reviewed exemption)`);
    process.exit(1);
  }
  console.log("check-par: every parallel entry in the engine crates goes through sagebrush-par");
}
