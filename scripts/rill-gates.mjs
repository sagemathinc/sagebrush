// Rill's gate inventory (design/rill.md §9, astra's audit): every route from lib/_rill to the host, read from the code,
// each with a reviewed decision in scripts/rill-gates.json.  The census proves only that the routes are listed;
// test/rill.test.ts's pins prove the checks.  A route is:
//   import:<module>         a module Rill imports (absolute, at any indentation)
//   host:<module>.<attr>    an attribute Rill uses on a host module (HOST below)
//   call:<name>             a host builtin Rill calls by name (open, exec, eval, __import__, getattr, ...)
//   builtin:<name>          an R function Rill provides (base.py's BUILTINS)
//   value:<name>            an R value Rill provides (base.py's VALUES)
//   gate:<what>             a refusal or gate the code marks with "# gate: <what> refused|gated"
// The census fails closed (astra's R3): a spelling it can't read as one of these routes is a problem, never
// silently skipped: an import with `as`, an absolute `from … import`, a host module used as a value (not
// `module.attr`), a BUILTINS, VALUES or PREFLIGHT change in any form but `NAME["x"] = f` (or the operator loops),
// and the introspection attributes (__dict__, __class__, __globals__, __subclasses__, __builtins__).
// Each PR that adds a route lists it with its decision: internal (no effect outside the session but its own output
// and the memory figure), gated (through the page's or the CLI's file and network gates) or refused.
//   node scripts/rill-gates.mjs            print the census
//   node scripts/rill-gates.mjs --check    exit 1 if it isn't exactly scripts/rill-gates.json's routes
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HOST = ["sys", "os", "io", "subprocess", "socket", "shutil", "pathlib", "builtins", "importlib", "ctypes", "js", "_capacity", "_memguard"];
const CALLS = ["open", "exec", "eval", "compile", "__import__", "getattr", "setattr", "delattr", "globals", "locals", "vars", "input", "breakpoint"];

function pyFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...pyFiles(p));
    else if (name.endsWith(".py")) out.push(p);
  }
  return out;
}

const TABLES = ["BUILTINS", "VALUES", "PREFLIGHT"];
const TABLE_ROUTE = { BUILTINS: "builtin", VALUES: "value", PREFLIGHT: "preflight" };
const DUNDERS = ["__dict__", "__class__", "__globals__", "__subclasses__", "__builtins__"];

/** The routes in lib/_rill (route -> the files it appears in), and the problems: spellings it can't read. */
export function census(root = ROOT) {
  const routes = new Map();
  const problems = [];
  const add = (key, file) => (routes.get(key) ?? routes.set(key, new Set()).get(key)).add(relative(root, file));
  const problem = (file, n, what) => problems.push(`${relative(root, file)}:${n}: ${what}`);
  const tableInits = new Map();
  for (const file of pyFiles(join(root, "lib", "_rill"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    let inDoc = false;
    let n = 0;
    for (const line of lines) {
      n++;
      // (docstrings are prose, not code: a line inside one, or opening or closing one, is skipped)
      const quotes = (line.match(/"""/g) ?? []).length;
      if (inDoc || quotes) {
        if (quotes % 2 === 1) inDoc = !inDoc;
        continue;
      }
      const code = line.replace(/#.*$/, "");
      let m;
      if (/^\s*import\b/.test(code)) {
        if (/\bas\b/.test(code) || !/^\s*import\s+[\w.]+(?:\s*,\s*[\w.]+)*\s*$/.test(code)) problem(file, n, "an import the census can't read (no `as`, one plain list of modules)");
        else for (const mod of code.replace(/^\s*import\s+/, "").split(",")) add("import:" + mod.trim(), file);
      }
      if (/^\s*from\s/.test(code)) {
        if (!/^\s*from\s+\.[\w.]*\s+import\b/.test(code)) problem(file, n, "an absolute `from … import` (import the module, use module.attr)");
        else if (/\bas\b/.test(code)) problem(file, n, "an import with `as`");
      }
      for (const h of HOST) if (new RegExp(`(?<![\\w.])${h}(?![\\w.])`).test(code) && !/^\s*import\b/.test(code)) problem(file, n, `the host module ${h} used as a value`);
      // (a table's one initialization, `NAME = {…}` on one line: each literal key is a route, and a second
      // assignment of the same table anywhere is a problem; astra's R3 residual)
      for (const t of TABLES) {
        const init = new RegExp(`^\\s*${t}\\s*=\\s*\\{(.*)\\}\\s*$`).exec(code);
        if (!init) continue;
        tableInits.set(t, (tableInits.get(t) ?? 0) + 1);
        if (tableInits.get(t) > 1) problem(file, n, `${t} assigned more than once`);
        for (const k of init[1].matchAll(/(?:^|[,{]\s*)(["'])([^"']*)\1\s*:/g)) add(`${TABLE_ROUTE[t]}:${k[2]}`, file);
        if (/[^\s]/.test(init[1]) && !/^\s*(?:"[^"]+"\s*:\s*[^,]+(?:,\s*"[^"]+"\s*:\s*[^,]+)*)?\s*,?\s*$/.test(init[1].replace(/Vector\([^)]*\)/g, "V"))) problem(file, n, `${t}'s initialization in a form the census can't read`);
      }
      for (const t of TABLES) if (new RegExp(`(?<![\\w.])${t}\\b`).test(code)) {
        const ok = new RegExp(`^\\s*${t}\\[(?:"[^"]+"|_op)\\]\\s*=\\s*\\w+\\s*$|^\\s*${t}\\s*=\\s*(?:\\{\\}|\\{.*\\})\\s*$`).test(code) || new RegExp(`=\\s*(?:base\\.)?${t}\\s*$`).test(code) || new RegExp(`\\b${t}\\.get\\(`).test(code) || new RegExp(`in\\s+(?:self\\.)?${t}\\b`).test(code);
        if (!ok) problem(file, n, `${t} used in a form the census can't read`);
      }
      for (const d of DUNDERS) if (code.includes(d)) problem(file, n, `the introspection attribute ${d}`);
      for (const h of HOST) for (const a of code.matchAll(new RegExp(`(?<![\\w.])${h}\\.(\\w+(?:\\.\\w+)?)`, "g"))) add(`host:${h}.${a[1]}`, file);
      for (const c of CALLS) if (new RegExp(`(?<![\\w.])${c}\\s*\\(`).test(code)) add("call:" + c, file);
      if ((m = /#\s*gate:\s*(.+?)\s+(refused|gated)\b/.exec(line))) add("gate:" + m[1], file);
    }
    if (file.endsWith(join("_rill", "base.py"))) {
      const text = lines.join("\n");
      // (every table's NAME["x"] = f is a route, not only BUILTINS': a PREFLIGHT or VALUES entry added that way
      // was accepted as readable but not counted, #999 r2)
      for (const t of TABLES) for (const b of text.matchAll(new RegExp(`(?<![\\w.])${t}\\["([^"]+)"\\]\\s*=`, "g"))) add(`${TABLE_ROUTE[t]}:${b[1]}`, file);
      for (const loop of text.matchAll(/for _op in \(([^)]*)\):\n\s+BUILTINS\[_op\]/g)) for (const op of loop[1].matchAll(/"([^"]+)"/g)) add("builtin:" + op[1], file);
    }
  }
  return { routes, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { routes, problems: unread } = census();
  if (process.argv.includes("--check")) {
    const inventory = JSON.parse(readFileSync(join(ROOT, "scripts", "rill-gates.json"), "utf8")).routes;
    const problems = [...unread];
    for (const k of routes.keys()) if (!inventory[k]) problems.push(`unlisted route ${k} (${[...routes.get(k)].join(", ")})`);
    for (const k of Object.keys(inventory)) if (!routes.has(k)) problems.push(`stale route ${k}: not in the code`);
    for (const [k, v] of Object.entries(inventory)) if (!["internal", "gated", "refused"].includes(v.decision) || !v.why) problems.push(`${k}: a decision (internal, gated or refused) and why`);
    for (const p of problems) process.stdout.write(p + "\n");
    process.stdout.write((problems.length ? `${problems.length} problems` : `${routes.size} routes, each with its decision`) + "\n");
    process.exit(problems.length ? 1 : 0);
  }
  for (const [k, files] of [...routes].sort()) process.stdout.write(`${k.padEnd(40)} ${[...files].join(", ")}\n`);
  for (const p of unread) process.stdout.write(`PROBLEM ${p}\n`);
}
