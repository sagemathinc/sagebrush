// The temp-dir census: no web/ test makes a directory inside the repository, but the allowances below.  A suite's
// dir in the tree races whatever reads the tree meanwhile (web/history/test-history-d11.mjs copies web/; a dir made
// or removed during the copy failed it with ENOENT, #909), and a killed run leaves it behind.  So every
// mkdtemp/mkdir call in a web/ test is classified by the root of its path: os.tmpdir() (or /tmp, or $TMPDIR), a
// variable made from one; the repository (import.meta, __dirname, process.cwd(), or a variable made from one); or
// unknown (a parameter, say), which the census can't place and counts.  A call rooted in the repository fails unless
// it is an allowance: its file, its dir's name prefix, and why it must be in the tree.  Each allowance is dot-named,
// so d11's copy skips it, and each must still match a call (a stale one fails).  The calls are found by name and
// through the file's node:fs and node:fs/promises bindings (import or require: a named alias, a namespace or default,
// .promises); a use of such a binding the census can't follow (passed on, aliased, indexed, a bare require("fs"))
// fails, so a refactor can't hide a call from it.
//   node scripts/temp-dirs.mjs        (prints the census; exits 1 on a problem)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const ALLOWANCES = [
  {
    file: "web/workspace/test-checkpoint.mjs", prefix: ".ck-types-",
    reason: "the type-level control runs tsc on a copy of checkpoint-types.ts, which must sit in this checkout so `patchflow` resolves (node_modules) as for the real file",
  },
  {
    file: "web/test-frame-ancestors.mjs", prefix: ".g3a-mut-atlas-",
    reason: "control C-A serves a mutated copy of web/atlas beside the original, so its imports (katex) resolve as the original's",
  },
];

// (the calls the census can't place, each reviewed: not a dir in the repository.  A new one fails until it is placed
// (rooted at tmpdir() or a variable made from it) or reviewed and listed here; one no longer found fails too)
export const UNPLACED = {
  "web/atlas/test-atlas.mjs :: mkdirSync(shots)": "$SHOTS, the screenshots' dir the person running it names",
  "web/test-board.mjs :: mkdirSync(process.env.SHOT)": "$SHOT, the screenshots' dir the person running it names",
  "web/latex/test-latex-run.mjs :: mkdirSync(d)": "a loop over A, A/pkg and B, all under its mkdtempSync(join(tmpdir(), ...)) root",
  "web/share/test-download-deps.mjs :: mkdir(\"/_code\")": "a folder in the page's workspace (IndexedDB), not on disk",
  "web/share/test-download-deps.mjs :: mkdir(\"/data\")": "a folder in the page's workspace (IndexedDB), not on disk",
  "web/share/test-download-deps.mjs :: mkdir(\"/proj\")": "a folder in the page's workspace (IndexedDB), not on disk",
  "web/share/test-download-deps.mjs :: mkdir(\"/proj/_code\")": "a folder in the page's workspace (IndexedDB), not on disk",
  "web/share/test-download-deps.mjs :: mkdir(\"/other\")": "a folder in the page's workspace (IndexedDB), not on disk",
  "web/share/test-share-copy-race.mjs :: mkdir(p)": "a fake workspace's method (a Map), not a call",
  "web/test-pathlib-worker.mjs :: mkdir(parents=True)": "words in a check's message (Python's Path.mkdir), not a call",
  "web/test-port-devtools.mjs :: mkdirSync(process.argv[2])": "a fake Chrome's source; its argv[2] is a profile under the suite's mkdtempSync(join(tmpdir(), ...)) dir",
  "web/workspace/test-workspace-pages.mjs :: mkdirSync(${JSON.stringify(profile)})": "a watchdog's source; profile is the suite's Chrome profile under tmpdir()",
};

// (the web/ tests: test-*.mjs/js/ts and *.test.*, helpers named test-* included)
export const isTest = (f) => /^web\//.test(f) && /(^|\/)(test-[^/]*|[^/]*\.test)\.(mjs|js|ts|mts)$/.test(f);

const DIR = ["mkdtempSync", "mkdtemp", "mkdirSync", "mkdir"], PDIR = ["mkdtemp", "mkdir"];
const CALL = /(?<![\w$.])(?:(?:fs|fsp|promises)\.)?(mkdtempSync|mkdtemp|mkdirSync|mkdir)\s*\(/g;
const FS = /^(?:node:)?fs(\/promises)?$/, ID = /^[A-Za-z_$][\w$]*$/;
// (comments and template literals blanked (`blank(src, false)`), or every string too (`blank(src, true)`); line
// numbers and offsets kept)
const LEX = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const blank = (src, strings) => src.replace(LEX, (m) => (strings || m[0] === "/" || m[0] === "`" ? m.replace(/[^\n]/g, " ") : m));

// (the file's node:fs bindings: names: local -> the operation; ns: namespaces and defaults of node:fs; pns: of
// node:fs/promises, and node:fs's promises; decls: the spans of the declarations themselves)
export function fsBindings(src) {
  const code = blank(src, false), names = new Map(), ns = new Set(), pns = new Set(), decls = [];
  const bind = (whole, promises) => (whole ? (promises ? pns : ns).add(whole) : null);
  const named = (list, promises, sep) => {
    for (const part of list.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [name, local = name] = part.split(sep).map((x) => x.trim());
      if (!ID.test(local)) continue;
      if (!promises && name === "promises") pns.add(local);
      else if ((promises ? PDIR : DIR).includes(name)) names.set(local, name);
    }
  };
  for (const m of code.matchAll(/\bimport\s+([\w$\s,*{}]*?)\s*from\s*["']([^"']+)["']/g)) {
    const f = FS.exec(m[2]);
    if (!f) continue;
    decls.push([m.index, m.index + m[0].length]);
    const clause = m[1], braces = /\{([^}]*)\}/.exec(clause), star = /\*\s*as\s+([\w$]+)/.exec(clause), def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
    if (braces) named(braces[1], !!f[1], /\s+as\s+/);
    if (star) bind(star[1], !!f[1]);
    if (def) bind(def[1], !!f[1]);
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
    const f = FS.exec(m[2]);
    if (!f) continue;
    decls.push([m.index, m.index + m[0].length]);
    if (m[1].startsWith("{")) named(m[1].slice(1, -1), !!f[1], /\s*:\s*/);
    else bind(m[1], !!f[1]);
  }
  return { names, ns, pns, decls };
}

const TMP = [/^(?:os\.)?tmpdir\(\)/, /^process\.env\.TMPDIR\s*\|\|\s*(?:os\.)?tmpdir\(\)/, /^["'`]\/tmp\//, /^(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)/,
  /^(?:join|resolve)\(\s*process\.env\.TMPDIR\s*\|\|\s*(?:os\.)?tmpdir\(\)/];
// (the repository: an expression that reaches import.meta, __dirname or process.cwd())
const REPO = /\bimport\.meta\b|\b__dirname\b|\bprocess\.cwd\(\)/;

// (the first argument's text, or an assignment's right side: up to its top-level comma, semicolon, line end or close;
// strings and templates skipped whole)
export function firstArg(src, i) {
  while (/\s/.test(src[i] ?? "")) i++;
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < src.length && src[j] !== c; j++) if (src[j] === "\\") j++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") { if (depth === 0) break; depth--; }
    else if ((c === "," || c === ";" || c === "\n") && depth === 0) break;
  }
  return src.slice(i, j).trim();
}

// (the variable an expression is rooted at: join(v, ...), resolve(v, ...), v, `${v}/...`, mkdtempSync(<rooted>))
function rootVar(a) {
  const m = /^(?:(?:join|resolve)\(\s*|`\$\{)?([A-Za-z_$][\w$]*)\s*(?:[,)}]|$)/.exec(a);
  return m && !/^(?:join|resolve|tmpdir|mkdtempSync|mkdtemp|dirname|fileURLToPath)$/.test(m[1]) ? m[1] : null;
}

export function classify(src) {
  const code = src.replace(/^[ \t]*\/\/.*$/gm, (l) => " ".repeat(l.length));
  const tmp = new Set(), repo = new Set();
  const kind = (a) => {
    for (let b; (b = a.replace(/^(?:mkdtempSync|mkdtemp|realpathSync|dirname)\(\s*/, "")) !== a;) a = b;
    if (TMP.some((r) => r.test(a))) return "tmp";
    if (REPO.test(a)) return "repo";
    const v = rootVar(a);
    return v && tmp.has(v) ? "tmp" : v && repo.has(v) ? "repo" : "unknown";
  };
  // (the variables' roots, to a fixpoint: `v = <expr>`, in declarations and assignments)
  const assigns = [...code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/g)].map((m) => [m[1], firstArg(code, m.index + m[0].length)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [v, e] of assigns) {
      const k = kind(e);
      if (k === "tmp" && !tmp.has(v) && !repo.has(v)) (tmp.add(v), changed = true);
      if (k === "repo" && !repo.has(v) && !tmp.has(v)) (repo.add(v), changed = true);
    }
  }
  const calls = [], at = new Set(), lineOf = (i) => code.slice(0, i).split("\n").length;
  const push = (fn, i, open) => {
    if (at.has(i)) return;
    at.add(i);
    const arg = firstArg(code, open);
    calls.push({ fn, line: lineOf(i), arg, kind: kind(arg) });
  };
  for (const m of code.matchAll(CALL)) push(m[1], m.index, m.index + m[0].length);
  // (through the file's node:fs bindings: a named alias, ns.op(, ns.promises.op(, pns.op()
  const { names, ns, pns, decls } = fsBindings(src), esc = (x) => x.replace(/\$/g, "\\$");
  for (const [local, fn] of names) for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${esc(local)}\\s*\\(`, "g"))) push(fn, m.index, m.index + m[0].length);
  for (const n of ns) for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${esc(n)}\\s*\\.\\s*(?:(${DIR.join("|")})|promises\\s*\\.\\s*(${PDIR.join("|")}))\\s*\\(`, "g"))) push(m[1] ?? m[2], m.index, m.index + m[0].length);
  for (const n of pns) for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${esc(n)}\\s*\\.\\s*(${PDIR.join("|")})\\s*\\(`, "g"))) push(m[1], m.index, m.index + m[0].length);
  // (fail closed: a use of a binding that isn't a call or a member (ns.x, ns.promises.x, pns.x), outside strings and
  // its own declaration, and a require("fs")/import("fs") that isn't a declaration the census reads)
  const bare = blank(src, true), inDecl = (i) => decls.some(([a, b]) => i >= a && i < b);
  const opaque = (i, what) => calls.push({ fn: "fs", line: lineOf(i), arg: what, kind: "opaque" });
  for (const local of names.keys()) for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${esc(local)}(?![\\w$])(?!\\s*\\()`, "g"))) if (!inDecl(m.index)) opaque(m.index, `${local}, not called`);
  for (const n of ns) for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${esc(n)}(?![\\w$])(?!\\s*\\.\\s*(?!promises(?![\\w$]))[\\w$]|\\s*\\.\\s*promises\\s*\\.\\s*[\\w$])`, "g"))) if (!inDecl(m.index)) opaque(m.index, `${n}, not a member`);
  for (const n of pns) for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${esc(n)}(?![\\w$])(?!\\s*\\.\\s*[\\w$])`, "g"))) if (!inDecl(m.index)) opaque(m.index, `${n}, not a member`);
  // (an inline load, (await import("node:fs")).x or require("fs").x, is read as a namespace's member)
  for (const m of blank(src, false).matchAll(/\b(?:require|import)\(\s*["'](?:node:)?fs(\/promises)?["']\s*\)/g)) {
    if (inDecl(m.index)) continue;
    const tail = /^(?:\s*\))?\s*\.\s*([\w$]+)(?:\s*\.\s*([\w$]+))?\s*(\()?/.exec(code.slice(m.index + m[0].length)), end = m.index + m[0].length;
    if (!tail) { opaque(m.index, m[0]); continue; }
    const [whole, a, b, open] = tail, ops = m[1] ? PDIR : DIR;
    if (ops.includes(a) && !b && open) push(a, m.index, end + whole.length);
    else if (!m[1] && a === "promises" && PDIR.includes(b) && open) push(b, m.index, end + whole.length);
    else if (a === "promises" && !m[1] && !b) opaque(m.index, m[0] + ".promises");
  }
  return calls.sort((a, b) => a.line - b.line);
}

export function census(files, read = (f) => readFileSync(join(ROOT, f), "utf8"), allowances = ALLOWANCES, unplaced = UNPLACED) {
  const problems = [], used = new Set(), seen = new Set(), counts = { tmp: 0, repo: 0, unknown: 0, allowed: 0, opaque: 0 };
  for (const a of allowances) if (!/^\./.test(a.prefix) || !a.reason) problems.push(`allowance ${a.file} ${a.prefix}: must be dot-named (so d11's copy skips it) and give its reason`);
  for (const f of files) {
    for (const c of classify(read(f))) {
      if (c.kind === "tmp") { counts.tmp++; continue; }
      if (c.kind === "opaque") { counts.opaque++; problems.push(`${f}:${c.line}: ${c.arg}: a node:fs binding the census can't follow (call it directly: name(...), ns.name(...), ns.promises.name(...))`); continue; }
      if (c.kind === "unknown") {
        const key = `${f} :: ${c.fn}(${c.arg})`;
        counts.unknown++, seen.add(key);
        if (!Object.hasOwn(unplaced, key)) problems.push(`${f}:${c.line}: ${c.fn}(${c.arg}): the census can't place this dir: root it at tmpdir() (or a variable made from it), or review it and list it in UNPLACED (${JSON.stringify(key)})`);
        continue;
      }
      const a = allowances.find((x) => x.file === f && c.fn.startsWith("mkdtemp") && c.arg.includes(JSON.stringify(x.prefix)));
      if (a) { used.add(a); counts.allowed++; continue; }
      counts.repo++;
      problems.push(`${f}:${c.line}: ${c.fn}(${c.arg}) makes a dir inside the repository: make it under tmpdir(), or (if its imports need the tree) add a dot-named allowance with the reason`);
    }
  }
  for (const k of Object.keys(unplaced)) if (!seen.has(k)) problems.push(`UNPLACED ${JSON.stringify(k)} matches no call (stale: remove it)`);
  for (const a of allowances) if (!used.has(a)) problems.push(`allowance ${a.file} ${a.prefix} matches no call (stale: remove it)`);
  return { problems, counts };
}

export const webTests = () => execFileSync("git", ["ls-files", "web"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(isTest);

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = webTests(), { problems, counts } = census(files);
  console.log(JSON.stringify({ files: files.length, ...counts, allowances: ALLOWANCES.map((a) => `${a.file} ${a.prefix}`) }));
  for (const p of problems) console.log("FAIL " + p);
  process.exit(problems.length ? 1 : 0);
}
