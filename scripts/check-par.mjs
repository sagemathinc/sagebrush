#!/usr/bin/env node
// Every parallel mechanism in the engine crates goes through sagebrush-par
// (no-cliffs C r9 section 4, C-2c scope r2 section 1.5): the one wrapper whose
// closures run under their caller's ledger context and sequentially in
// exclusive mode.  This fails on any other use in an engine crate's src/
// tree: rayon (any mention, so aliases and glob imports too), parallel
// iterator methods (`.par_*(`, `into_par_iter`, `par_bridge`), thread pools,
// and the standard library's spawn/scope/Builder, however imported.
//
// A literal-token check is a backstop, not the proof: the wrapper's own tests
// prove the context is carried.  Exemptions are the reviewed list below (by
// file, or by file and line text), never an inline comment: a `#[cfg(test)]`
// module needs its own entry.
//
//   node scripts/check-par.mjs [ROOT]    (ROOT: the repository, by default)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// the wrapper itself
const WRAPPER = "engine/par/src/";
// reviewed exemptions: [file, line text or null for the whole file, reason]
export const EXEMPT = [
  ["engine/ledger/src/tests.rs", null, "the ledger's own unit tests (threads that race admissions on purpose)"],
  ["engine/interrupt/src/progress.rs", "let a = std::thread::spawn(move || {", "inside #[cfg(test)] mod tests"],
  ["engine/interrupt/src/progress.rs", "let w = std::thread::spawn(move || {", "inside #[cfg(test)] mod tests"],
];

const RULES = [
  [/\brayon\b/, "rayon"],
  [/\.par_[A-Za-z_]+\s*(::<[^>]*>)?\s*\(/, "a parallel iterator method"],
  [/\binto_par_iter\b|\bpar_bridge\b|\bpar_iter(_mut)?\b|\bpar_chunks(_mut|_exact)?\b/, "a parallel iterator"],
  [/\bThreadPool(Builder)?\b/, "a thread pool"],
  [/\bthread::(spawn|scope|Builder)\b/, "std::thread spawn/scope/Builder"],
  [/\buse\s+std::thread\s+as\b/, "an alias of std::thread"],
  [/\buse\s+std::thread::\{[^}]*\b(spawn|scope|Builder)\b/, "an import of std::thread spawn/scope/Builder"],
  [/\buse\s+std::thread::(spawn|scope|Builder)\b/, "an import of std::thread spawn/scope/Builder"],
  [/\buse\s+std::\{[^}]*\bthread\b/, "an import of std::thread"],
];

// a line without its // comment (string literals aside: a crude cut, which
// can only make the check stricter, never hide code)
const code = (line) => {
  const i = line.indexOf("//");
  return i < 0 ? line : line.slice(0, i);
};

function* rustFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* rustFiles(p);
    else if (name.endsWith(".rs")) yield p;
  }
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
      if (rel.startsWith(WRAPPER)) continue;
      if (EXEMPT.some(([file, text]) => file === rel && text === null)) continue;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        const c = code(line);
        for (const [re, what] of RULES) {
          if (!re.test(c)) continue;
          if (EXEMPT.some(([file, text]) => file === rel && text !== null && line.includes(text))) continue;
          out.push(`${rel}:${i + 1}: ${what} outside sagebrush-par: ${line.trim()}`);
          break;
        }
      });
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
