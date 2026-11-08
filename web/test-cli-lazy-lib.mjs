// ci: checks.3 order=12 -- build/cli/pyjs.cjs
// The CLI's lazily embedded library (P3a design note, accepted Nov 7; scripts/lazy-lib.mjs, src/lib-embed.ts): the
// files LAZY_LIB lists are a second gzip blob in the bundle, decoded the first time one of them is read, never at
// startup. Counted from outside, with nothing added to the runtime: a --require preload wraps zlib.gunzipSync (the
// decoder lib-embed.ts calls through the zlib module) and counts the decodes whose output is the lazy blob's JSON
// (its own files' names, and none of the eager library's), reported at exit. Checked (daybreak2's and daybreak3's
// requirements on the design):
//   - every CLI start path decodes it 0 times: -c, a .py file, -m, the REPL, --sage, --magma, --matlab;
//   - importing pathlib decodes it exactly once, and pathlib, glob, fnmatch, stat, ntpath, errno and os's lazy part
//     (os.walk, os.scandir) together still once;
//   - its files are exactly LAZY_LIB's, and none of them is in the eager blob;
//   - each keyed family (LAZY_FAMILIES: Rill's, design/rill.md §6.3) is its own blob: no other mode's start decodes it,
//     the Rill start decodes only Rill's (and not pathlib's), and its files are exactly the family's, in no other blob.
//   node web/test-cli-lazy-lib.mjs [bundle]      (default build/cli/pyjs.cjs)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bundle = resolve(process.argv[2] ?? new URL("../build/cli/pyjs.cjs", import.meta.url).pathname);
const { LAZY_LIB, isLazyLib, LAZY_FAMILIES, familyOf } = await import(new URL("../scripts/lazy-lib.mjs", import.meta.url).href);
const dir = mkdtempSync(join(tmpdir(), "sb-lazylib-"));
const fails = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) fails.push(what);
};
// (the preload: each gunzip's output kept as the lazy one when it names pathlib's package and not sage_all, counted;
// the eager blob's names and the lazy one's written at exit, for the split check)
const preload = join(dir, "count.cjs");
writeFileSync(preload, `
const zlib = require("zlib");
const fs = require("fs");
const orig = zlib.gunzipSync;
const seen = { lazy: 0, lazyNames: null, eagerNames: null, rill: 0, rillNames: null };
zlib.gunzipSync = function (...a) {
  const out = orig.apply(this, a);
  try {
    const t = Buffer.from(out).toString("utf8");
    if (t.startsWith("{") && t.includes('"pathlib/__init__.py":') && !t.includes('"sage_all.py":')) { seen.lazy++; seen.lazyNames = Object.keys(JSON.parse(t)); }
    else if (t.startsWith("{") && t.includes('"sage_all.py":')) seen.eagerNames = Object.keys(JSON.parse(t));
    else if (t.startsWith("{") && t.includes('"_rill/__init__.py":')) { seen.rill++; seen.rillNames = Object.keys(JSON.parse(t)); }
  } catch {}
  return out;
};
process.on("exit", () => fs.writeFileSync(process.env.SB_LAZY_COUNT, JSON.stringify(seen)));
`);
const run = (args, input = undefined) => {
  const out = join(dir, "seen.json");
  rmSync(out, { force: true });
  const stdout = execFileSync(process.execPath, ["--require", preload, bundle, ...args], { cwd: dir, encoding: "utf8", input, env: { ...process.env, SB_LAZY_COUNT: out }, timeout: 300000 });
  return { stdout, seen: JSON.parse(readFileSync(out, "utf8")) };
};

try {
  writeFileSync(join(dir, "prog.py"), "print('file')\n");
  writeFileSync(join(dir, "modx.py"), "print('module')\n");
  const starts = [
    ["-c", ["-c", "print('c')"], "c"],
    ["a .py file", ["prog.py"], "file"],
    ["-m", ["-m", "modx"], "module"],
    ["the REPL", [], null, "1 + 1\n"],
    ["--sage", ["--sage", "-c", "print(2^3)"], "8"],
    ["--magma", ["--magma", "-c", "print 2^3;"], "8"],
    ["--matlab", ["--matlab", "-c", "disp(2^3)"], "8"],
  ];
  for (const [what, args, want, input] of starts) {
    const r = run(args, input);
    check(want === null || r.stdout.trim().split("\n").pop() === want, `${what}: runs (${JSON.stringify(r.stdout.trim().slice(-40))})`);
    check(r.seen.lazy === 0, `${what}: the lazy library decoded 0 times at startup (${r.seen.lazy})`);
    check(r.seen.rill === 0, `${what}: Rill's family decoded 0 times (${r.seen.rill})`);
  }
  // (the Rill start, hidden until A1.7: decodes its own family once, and not pathlib's)
  const rill = run(["--rill", "-c", "1"]);
  check(rill.stdout === "[1] 1\n", `--rill: runs (${JSON.stringify(rill.stdout)})`);
  check(rill.seen.rill === 1 && rill.seen.lazy === 0, `--rill: Rill's family decoded once, pathlib's 0 times (${rill.seen.rill}, ${rill.seen.lazy})`);
  const rillNames = rill.seen.rillNames ?? [];
  check(rillNames.length > 0 && rillNames.every((n) => familyOf(n) === "rill"), `Rill's blob holds only its family's files (${rillNames.length}: ${rillNames.join(", ")})`);
  check(Object.keys(LAZY_FAMILIES).length === 1, `the keyed families are the ones with files: ${Object.keys(LAZY_FAMILIES).join(", ")}`);
  const one = run(["-c", "import pathlib; print(pathlib.Path('x').suffix == '')"]);
  check(one.stdout.trim() === "True" && one.seen.lazy === 1, `import pathlib: works, the lazy library decoded exactly once (${one.seen.lazy})`);
  const all = run(["-c", "import pathlib, glob, fnmatch, stat, ntpath, errno, genericpath, os; list(os.scandir('.')); list(os.walk('.')); import pathlib._os; print('all')"]);
  check(all.stdout.trim() === "all" && all.seen.lazy === 1, `every lazy module and os's lazy part: still exactly once (${all.seen.lazy})`);
  const names = all.seen.lazyNames ?? [];
  check(names.length > 0 && names.every((n) => isLazyLib(n)), `the lazy blob holds only LAZY_LIB's files (${names.length}: ${names.join(", ")})`);
  check(LAZY_LIB.every((e) => names.some((n) => (e.endsWith("/") ? n.startsWith(e) : n === e))), `…and every LAZY_LIB entry is in it (${LAZY_LIB.join(", ")})`);
  const eager = all.seen.eagerNames ?? [];
  check(eager.length > 100 && !eager.some((n) => isLazyLib(n)), `the eager blob (${eager.length} files) holds none of them`);
  check(!eager.some((n) => familyOf(n) !== null) && !names.some((n) => familyOf(n) !== null), `no keyed family's file is in the eager or pathlib's blob`);
} catch (e) {
  check(false, "the test ran: " + String(e?.stack ?? e).slice(0, 400));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails.length ? `${fails.length} failed` : "all passed");
process.exit(fails.length ? 1 : 0);
