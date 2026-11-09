// ci: census order=30
// scripts/temp-dirs.mjs: no web/ test makes a dir inside the repository but its allowances (each dot-named, with its
// reason), and web/history/test-history-d11.mjs's copy of web/ skips them; the census's rules, on sources made to be
// wrong in one way each.
//   node scripts/test-temp-dirs.mjs
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ALLOWANCES, ROOT, UNPLACED, census, classify, isTest, webTests } from "./temp-dirs.mjs";

let failures = 0;
const ok = (c, what) => (c ? console.log("ok  ", what) : (failures++, console.log("FAIL", what)));
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// the tree: nothing in the repository but the allowances, each used
{
  const files = webTests(), { problems, counts } = census(files);
  ok(problems.length === 0, `the web/ tests (${files.length}) make no dir in the repository but the allowances: ${problems.join("; ") || "none"}`);
  ok(counts.allowed === ALLOWANCES.length && counts.repo === 0, `each allowance matches its one call: ${JSON.stringify(counts)}`);
  ok(ALLOWANCES.every((a) => a.prefix.startsWith(".") && a.reason.length > 20), "each allowance is dot-named and says why");
}

// the suites moved out of the tree (#909's race): their temp dirs all under tmpdir()
for (const f of ["web/board/test-board-journal.mjs", "web/board/test-board-journal-lib.mjs", "web/notebook/test-journal.mjs", "web/workspace/test-doc-sync.mjs"]) {
  const calls = classify(read(f)).filter((c) => c.fn.startsWith("mkdtemp"));
  ok(calls.length >= 2 && calls.every((c) => c.kind === "tmp"), `${f}: its ${calls.length} temp dirs are under tmpdir(): ${calls.map((c) => c.arg).join(" | ")}`);
}

// the census's rules
{
  const H = 'import { mkdirSync, mkdtempSync } from "node:fs";\nconst here = new URL(".", import.meta.url).pathname;\n';
  const run = (src, allowances = [], unplaced = {}) => census(["web/x/test-x.mjs"], () => H + src, allowances, unplaced).problems;
  ok(run('const d = mkdtempSync(join(tmpdir(), "sb-x-"));\nmkdirSync(join(d, "a"));\n').length === 0, "rule: a dir under tmpdir(), and one inside it, pass");
  ok(run('const a = mkdtempSync(join(os.tmpdir(), "x")), b = join(a, "y"), c = join(b, "z");\nmkdirSync(c, { recursive: true });\nmkdtempSync("/tmp/sb-");\nmkdtempSync(join(process.env.TMPDIR || tmpdir(), "e-"));\n').length === 0,
    "rule: a chain of variables from tmpdir(), /tmp and $TMPDIR pass");
  ok(run('const src = mkdtempSync(join(here, ".test-x-"));\n').length === 1, "rule: a temp dir beside the test (here) fails");
  ok(run('const root = join(here, "../..");\nmkdirSync(join(root, "build"));\n').length === 1, "rule: a dir under a variable made from the test's dir fails");
  ok(run('mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), "x-"));\nmkdirSync(join(process.cwd(), "out"));\nmkdirSync(join(__dirname, "o"));\n').length === 3, "rule: import.meta, process.cwd() and __dirname, written inline, fail");
  ok(run('const p = join(here, "a");\nconst q = mkdtempSync(join(tmpdir(), "b"));\nmkdirSync(p);\nmkdirSync(q);\n').length === 1, "rule: each call by its own root (one in the repository, one not)");
  ok(run('const p = join(here, "a"); mkdirSync(join(tmpdir(), "t")); mkdirSync(p);\n').length === 1, "rule: a statement's end (;) ends a variable's expression");
  ok(run('  // mkdtempSync(join(here, ".x-"))\n').length === 0, "rule: a commented-out call is not a call");
  const allow = [{ file: "web/x/test-x.mjs", prefix: ".x-", reason: "why it must be in the tree" }];
  ok(run('mkdtempSync(join(here, ".x-"));\n', allow).length === 0, "rule: an allowance (its file, its prefix) admits that call");
  ok(run('mkdtempSync(join(here, ".y-"));\n', allow).length === 2, "rule: another prefix in the same file still fails, and the unused allowance is stale");
  ok(run('mkdtempSync(join(tmpdir(), "x-"));\n', allow).some((p) => /stale/.test(p)), "rule: an allowance that matches no call fails (stale)");
  ok(run('mkdtempSync(join(here, "x-"));\n', [{ ...allow[0], prefix: "x-" }]).some((p) => /dot-named/.test(p)), "rule: an allowance not dot-named fails (d11's copy wouldn't skip it)");
  ok(run('function f(dir) { mkdirSync(join(dir, "a")); }\n').length === 1, "rule: a dir the census can't place fails until reviewed");
  ok(run('function f(dir) { mkdirSync(join(dir, "a")); }\n', [], { 'web/x/test-x.mjs :: mkdirSync(join(dir, "a"))': "reviewed" }).length === 0, "rule: a reviewed one (UNPLACED) passes");
  ok(run("", [], { "web/x/test-x.mjs :: mkdirSync(d)": "reviewed" }).some((p) => /stale/.test(p)), "rule: an UNPLACED entry that matches no call fails (stale)");
  // (the grader's rows, #920 r1: T7, T11, T14)
  ok(run('function f() { mkdirSync(c); }\nlet c, b;\nc = join(b, "z");\nb = mkdtempSync(join(tmpdir(), "x-"));\n').length === 0, "rule: a chain of variables assigned out of source order passes (to a fixpoint)");
  ok(run('const d = mkdtempSync(join(tmpdir(), "x-")); const p = d; const u = import.meta.url;\nmkdirSync(p);\n').length === 0, "rule: a later statement on the line doesn't root a variable");
  ok(run('mkdtempSync(join(here, ".x-"));\nmkdirSync(join(here, ".x-"));\n', allow).length === 1, "rule: an allowance admits its mkdtemp call only, not a mkdirSync of the same prefix");
  ok(Object.values(UNPLACED).every((r) => r.length > 20), "each UNPLACED entry says why it isn't in the repository");
  ok(isTest("web/a/test-a.mjs") && isTest("web/a/test-a.page.js") && isTest("web/a/b.test.ts") && !isTest("web/build.ts") && !isTest("scripts/test-x.mjs"), "the census's files: web/'s test-* and *.test.* files");
}

// the node:fs bindings (daybreak3's E1, #920 r1): each form's call is found (its repository twin fails, its tmpdir()
// twin passes), and a use of a binding the census can't follow fails
{
  const H = 'const here = new URL(".", import.meta.url).pathname;\n';
  const found = (src) => classify(H + src).filter((c) => c.kind !== "opaque");
  const problems = (src) => census(["web/x/test-x.mjs"], () => H + src, [], {}).problems;
  const FORMS = [
    ["a named alias", 'import { mkdirSync as make } from "node:fs";\n', "make(%)", "mkdirSync"],
    ["a namespace", 'import * as files from "node:fs";\n', "files.mkdirSync(%)", "mkdirSync"],
    ["a default's .promises", 'import fs from "node:fs";\n', "fs.promises.mkdir(%)", "mkdir"],
    ["a default and a named alias", 'import fs, { mkdtempSync as tmp } from "fs";\n', "tmp(%)", "mkdtempSync"],
    ["node:fs's promises, named", 'import { promises as P } from "node:fs";\n', "P.mkdtemp(%)", "mkdtemp"],
    ["node:fs/promises, a named alias", 'import { mkdir as md } from "node:fs/promises";\n', "await md(%)", "mkdir"],
    ["node:fs/promises, a namespace", 'import * as fsp2 from "node:fs/promises";\n', "await fsp2.mkdir(%)", "mkdir"],
    ["node:fs/promises, a default", 'import pf from "fs/promises";\n', "await pf.mkdtemp(%)", "mkdtemp"],
    ["require, a renamed destructuring", 'const { mkdirSync: mk } = require("node:fs");\n', "mk(%)", "mkdirSync"],
    ["require, a namespace", 'const nfs = require("fs");\n', "nfs.mkdirSync(%)", "mkdirSync"],
    ["a dynamic import, destructured", 'const { mkdir: m2 } = await import("node:fs/promises");\n', "await m2(%)", "mkdir"],
    ["an inline dynamic import", "", '(await import("node:fs")).mkdirSync(%)', "mkdirSync"],
    ["an inline require's .promises", "", 'await require("fs").promises.mkdir(%)', "mkdir"],
  ];
  for (const [what, imp, call, fn] of FORMS) {
    const repo = imp + call.replace("%", 'join(here, "x")') + ";\n", tmp = imp + call.replace("%", 'join(tmpdir(), "x")') + ";\n";
    const r = found(repo), t = found(tmp);
    ok(r.length === 1 && r[0].fn === fn && r[0].kind === "repo" && t.length === 1 && t[0].fn === fn && t[0].kind === "tmp", `fs binding, ${what}: its call is found as ${fn} (repository and tmpdir() twins): ${JSON.stringify([r, t])}`);
    ok(problems(repo).length === 1 && problems(tmp).length === 0, `fs binding, ${what}: in the repository it fails, under tmpdir() it passes`);
  }
  ok(problems('import * as files from "node:fs";\nfiles.readFileSync(join(here, "a"));\nfiles.promises.readFile("b");\n').length === 0, "fs binding: other members of a namespace (and of its .promises) pass");
  for (const [what, src] of [
    ["a named alias passed on", 'import { mkdirSync as make } from "node:fs";\nconst m = make;\n'],
    ["a namespace passed on", 'import * as files from "node:fs";\nhelper(files);\n'],
    ["a namespace indexed", 'import * as files from "node:fs";\nfiles["mkdir" + "Sync"](join(here, "x"));\n'],
    ["a .promises aliased", 'import fs from "node:fs";\nconst p = fs.promises;\n'],
    ["a node:fs/promises namespace passed on", 'import * as q from "node:fs/promises";\nuse(q);\n'],
    ["a bare require", 'const mods = [require("fs")];\n'],
    ["an inline import's .promises taken", 'const p = (await import("node:fs")).promises;\n'],
  ]) ok(problems(src).length === 1 && /can't follow/.test(problems(src)[0]), `fs binding, ${what}: fails (the census can't follow it): ${problems(src).join("; ")}`);
  ok(problems('const s = `import * as files from "node:fs"; helper(files);`;\n').length === 0, "fs binding: a binding inside a string (generated code) is not the file's");
}

// d11's copy of web/: no dot-named entry (so no allowance's dir, made or removed meanwhile) but .gitignore
{
  const d11 = read("web/history/test-history-d11.mjs"), line = /^const copyable = (.*);$/m.exec(d11)?.[1];
  ok(line !== undefined && /cpSync\(join\(root, "web"\), join\(dir, "web"\), \{ recursive: true, filter: copyable \}\)/.test(d11), "d11 copies web/ through its copyable filter");
  const copyable = line ? new Function("basename", `return ${line};`)(basename) : () => true, w = "/r/web";
  for (const a of ALLOWANCES) ok(!copyable(join(w, a.file, "..", a.prefix + "Ab12Cd")), `d11's copy skips ${a.file}'s ${a.prefix} dir`);
  ok(!copyable(join(w, "node_modules")) && !copyable(join(w, "x", "node_modules", "y")), "d11's copy skips node_modules");
  ok(["files", "share", "site"].every((d) => copyable(join(w, d, ".gitignore"))), "d11's copy keeps the tracked .gitignore files");
  ok(copyable(join(w, "workspace", "index.ts")) && copyable(join(w, "history")) && copyable(w), "d11's copy keeps the sources");
  ok(!copyable(join(w, ".anything")), "d11's copy skips any other dot-named entry");
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
