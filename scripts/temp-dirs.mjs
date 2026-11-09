// The temp-dir census: no web/ test makes a directory inside the repository, but the allowances below.  A suite's
// dir in the tree races whatever reads the tree meanwhile (web/history/test-history-d11.mjs copies web/; a dir made
// or removed during the copy failed it with ENOENT, #909), and a killed run leaves it behind.  So every
// mkdtemp/mkdir call in a web/ test is classified by the root of its path: os.tmpdir() (or /tmp, or $TMPDIR), a
// variable made from one; the repository (import.meta, __dirname, process.cwd(), or a variable made from one); or
// unknown (a parameter, say), which the census can't place and counts.  A call rooted in the repository fails unless
// it is an allowance: its file, its dir's name prefix, and why it must be in the tree.  Each allowance is dot-named,
// so d11's copy skips it, and each must still match a call (a stale one fails).
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

const CALL = /(?<![\w$.])(?:(?:fs|fsp|promises)\.)?(mkdtempSync|mkdtemp|mkdirSync|mkdir)\s*\(/g;
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
  const calls = [];
  for (const m of code.matchAll(CALL)) {
    const arg = firstArg(code, m.index + m[0].length), line = code.slice(0, m.index).split("\n").length;
    calls.push({ fn: m[1], line, arg, kind: kind(arg) });
  }
  return calls;
}

export function census(files, read = (f) => readFileSync(join(ROOT, f), "utf8"), allowances = ALLOWANCES, unplaced = UNPLACED) {
  const problems = [], used = new Set(), seen = new Set(), counts = { tmp: 0, repo: 0, unknown: 0, allowed: 0 };
  for (const a of allowances) if (!/^\./.test(a.prefix) || !a.reason) problems.push(`allowance ${a.file} ${a.prefix}: must be dot-named (so d11's copy skips it) and give its reason`);
  for (const f of files) {
    for (const c of classify(read(f))) {
      if (c.kind === "tmp") { counts.tmp++; continue; }
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
