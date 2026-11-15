import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// MATLAB's search path in the CLI (lib/_matlab_files.py): function files and scripts found in the current folder,
// on the path addpath builds and in the program's folder; +namespace folders and import; run, which, path, rmpath and
// genpath; and Octave's pkg, which loads nothing and says so.

const cli = join(__dirname, "..", "src", "cli.js");

/** a folder of MATLAB files: {relative path: text} */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-mpath-"));
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  }
  return dir;
}

/** the program run as main.m in dir, from dir: its stdout, stderr and status */
function run(dir: string, src: string) {
  writeFileSync(join(dir, "main.m"), src);
  const r = spawnSync(process.execPath, [cli, "--matlab", "main.m"], { cwd: dir, encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, status: r.status };
}

const fn = (name: string, body: string, args = "x") => `function r = ${name}(${args})\n  ${body}\nend\n`;

const FILES = {
  "lib/cube.m": fn("cube", "r = x.^3;"),
  "lib/sub/quart.m": fn("quart", "r = x.^4;"),
  "lib/private/hidden.m": fn("hidden", "r = 0;"),
  "lib/+util/hello.m": fn("hello", "r = 'hi';", ""),
  "+geom/area.m": fn("area", "r = pi*x^2;"),
  "+geom/twice.m": fn("twice", "r = 2*x;"),
  "+geom/+sub/deep.m": fn("deep", "r = 7;", ""),
  "+geom/usesib.m": fn("usesib", "r = geom.twice(x) + 1;"),
  "+geom/withimport.m": "function r = withimport(x)\n  import geom.*\n  r = twice(x) + area(1);\nend\n",
  "setup.m": "k = 42;\n",
  "bump.m": "y = x + 1;\nfprintf('bumped to %d\\n', y);\n",
  "early.m": "z = 1;\nif z\n  return\nend\nz = 2;\n",
  "fails.m": "a = 1;\nerror('from the script');\n",
  "withlocal.m": "w = helper(3);\nfunction r = helper(x)\n  r = 10*x;\nend\n",
  "scripts/inner.m": "where = pwd;\n",
  "lib/oops.m": "function r = oops(x)\n  r = x;\n  error('oops in a file');\nend\n",
};

test("addpath puts folders on the search path, and their functions are found; rmpath and path take them off", () => {
  const dir = tree(FILES);
  assert.deepEqual(run(dir, "addpath('lib');\ndisp(cube(2))\n").out, "     8\n");
  // (command syntax, and with -end)
  assert.equal(run(dir, "addpath lib\ndisp(cube(2))\n").out, "     8\n");
  assert.equal(run(dir, "addpath lib/sub\naddpath lib -end\np = strrep(path, [pwd filesep], '');\ndisp(p)\n").out, "lib/sub:lib\n");
  // genpath: the tree, each folder followed by pathsep, without private, + and @ folders
  assert.equal(run(dir, "disp(genpath('lib'))\n").out, "lib:lib/sub:\n");
  assert.equal(run(dir, "addpath(genpath('lib'));\ndisp(quart(2))\n").out, "    16\n");
  // (a link back up the tree is followed once, never endlessly)
  mkdirSync(join(dir, "lib", "sub", "loop"));
  symlinkSync(join(dir, "lib"), join(dir, "lib", "sub", "loop", "up"));
  assert.equal(run(dir, "disp(genpath('lib'))\n").out, "lib:lib/sub:lib/sub/loop:\n");
  // a namespace folder inside a folder on the path
  assert.equal(run(dir, "addpath('lib');\ndisp(util.hello())\n").out, "hi\n");
  // rmpath, and path(old) giving back the path addpath returned
  let r = run(dir, "addpath('lib');\nrmpath('lib');\ncube(2)\n");
  assert.match(r.err, /^Unrecognized function or variable 'cube'\./);
  r = run(dir, "old = addpath('lib');\npath(old);\ncube(2)\n");
  assert.match(r.err, /^Unrecognized function or variable 'cube'\./);
  // a folder that does not exist: a warning, and the program goes on
  r = run(dir, "addpath('nodir');\ndisp(1)\n");
  assert.equal(r.out, "     1\n");
  assert.match(r.err, /^Warning: Name is nonexistent or not a directory: .*nodir\n$/);
  // a namespace folder is never put on the path itself
  r = run(dir, "addpath('+geom');\n");
  assert.match(r.err, /^Warning: Namespace folders are not allowed on the path/);
});

test("the current folder is searched first: after cd, its functions are found", () => {
  const dir = tree(FILES);
  assert.equal(run(dir, "cd lib\ndisp(cube(2))\n").out, "     8\n");
});

test("namespaces: +ns/f.m is ns.f, nested namespaces, and import of a name or of a whole namespace", () => {
  const dir = tree(FILES);
  assert.equal(run(dir, "disp(geom.area(1))\n").out, "    3.1416\n");
  assert.equal(run(dir, "disp(geom.sub.deep())\ndisp(geom.sub.deep)\n").out, "     7\n     7\n");
  // (a namespace's function calls its siblings by their full names, or imports them)
  assert.equal(run(dir, "disp(geom.usesib(2))\ndisp(geom.withimport(1))\n").out, "     5\n    5.1416\n");
  assert.equal(run(dir, "import geom.*\ndisp(twice(4))\n").out, "     8\n");
  assert.equal(run(dir, "import geom.twice\ndisp(twice(5))\nimport\nL = import;\ndisp(class(L))\n").out, "    10\ngeom.twice\ncell\n");
  // a function's imports are its own: the caller's names are unchanged
  assert.match(run(dir, "disp(geom.withimport(1))\ntwice(1)\n").err, /^Unrecognized function or variable 'twice'\./);
  // a namespace is no value, and a missing member is named in full
  assert.match(run(dir, "x = geom\n").err, /^Unrecognized function or variable 'geom'\./);
  assert.match(run(dir, "geom.nothere(1)\n").err, /^Unrecognized function or variable 'geom\.nothere'\./);
  // @ns.f and feval of a namespace's function
  assert.equal(run(dir, "h = @geom.twice;\ndisp(h(3))\ndisp(feval('geom.twice', 4))\n").out, "     6\n     8\n");
  // clear import empties the workspace's list
  assert.match(run(dir, "import geom.*\nclear import\ntwice(1)\n").err, /^Unrecognized function or variable 'twice'\./);
});

test("scripts on the path run in the workspace by name and with run; return ends one; an error names it", () => {
  const dir = tree(FILES);
  assert.equal(run(dir, "setup\ndisp(k)\n").out, "    42\n");
  assert.equal(run(dir, "x = 4;\nbump\ndisp(y)\n").out, "bumped to 5\n     5\n");
  assert.equal(run(dir, "early\ndisp(z)\n").out, "     1\n");
  assert.equal(run(dir, "run('setup')\ndisp(k)\nrun setup.m\ndisp(k)\n").out, "    42\n    42\n");
  // run with a folder: the script runs there, and the folder is the caller's again afterwards
  assert.equal(run(dir, "run('scripts/inner.m')\ndisp(strcmp(where, pwd))\ndisp(endsWith(where, 'scripts'))\n").out, "   0\n   1\n");
  // a script's local functions are its own
  let r = run(dir, "withlocal\ndisp(w)\nhelper(1)\n");
  assert.equal(r.out, "    30\n");
  assert.match(r.err, /^Unrecognized function or variable 'helper'\./);
  r = run(dir, "fails\n");
  assert.equal(r.status, 1);
  assert.match(r.err, /from the script\n\nError in fails \(line 2\)\nerror\('from the script'\);\n\nError in main \(line 1\)\nfails\n$/);
  // (a function file's frame quotes its own line)
  r = run(dir, "addpath lib\noops(1)\n");
  assert.match(r.err, /oops in a file\n\nError in oops \(line 3\)\nerror\('oops in a file'\);\n\nError in main \(line 2\)\noops\(1\)\n$/);
  r = run(dir, "setup(1)\n");
  assert.match(r.err, /^Attempt to execute SCRIPT setup as a function:/);
  r = run(dir, "run('nothere')\n");
  assert.match(r.err, /^RUN cannot execute the file 'nothere'\./);
  // a script named in a function is refused, with what to do instead
  r = run(dir, "f()\nfunction f()\n  setup\nend\n");
  assert.match(r.err, /^Calling the script 'setup' from a function is not supported in Sagebrush yet/);
});

test("which and exist find what the search path finds", () => {
  const dir = tree(FILES);
  const r = run(dir, "x = 1;\nwhich x\nwhich sin\nwhich nothere\naddpath lib\ns = which('cube');\ndisp(endsWith(s, 'cube.m'))\ndisp(exist('cube'))\ndisp(exist('setup'))\n");
  assert.equal(r.out, "'x' is a variable.\nbuilt-in (Sagebrush)\n'nothere' not found.\n   1\n     2\n     2\n");
});

test("Octave's pkg loads nothing and says so; pkg list gives no packages", () => {
  const dir = tree({});
  let r = run(dir, "pkg load statistics\ndisp(1)\n");
  assert.equal(r.out, "     1\n");
  assert.equal(r.err, "Warning: pkg load: Octave packages are not available in Sagebrush yet, so nothing was loaded (statistics).\n");
  r = run(dir, "pkg install -forge io\n");
  assert.equal(r.err, "Warning: pkg install: Octave packages are not available in Sagebrush yet, so nothing was installed (io).\n");
  r = run(dir, "L = pkg('list');\ndisp(isempty(L))\n");
  assert.equal(r.out, "   1\n");
  assert.equal(r.err, "");
});

test("notebook session: the path, imports and scripts last from cell to cell; a script's variables are the notebook's", async () => {
  const dir = tree(FILES);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { notebookSession } = require("../src/notebook-session");
    const msgs: any[] = [];
    const s = notebookSession((m: any) => msgs.push(m), { captureStreams: true });
    await s.ready;
    const cells = ["addpath lib", "disp(cube(2))", "setup", "disp(k)", "import geom.*", "disp(twice(3))", "x = 1;", "bump", "disp(y)"];
    for (let i = 0; i < cells.length; i++) await s.handle({ id: i + 1, code: cells[i], matlab: true });
    const out = (id: number) => msgs.filter((m) => m.id === id && m.stream === "stdout").map((m) => m.text).join("");
    const errs = msgs.filter((m) => m.stream === "stderr").map((m) => m.text).join("");
    assert.equal(errs, "");
    assert.deepEqual([2, 4, 6, 8, 9].map(out), ["     8\n", "    42\n", "     6\n", "bumped to 2\n", "     2\n"]);
  } finally {
    process.chdir(cwd);
  }
});
