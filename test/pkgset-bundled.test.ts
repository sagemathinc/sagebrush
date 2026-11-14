import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

// The package set the CLI carries (scripts/bundled-set.mjs, src/pkgcache.ts bundledSet): the notebooks' set, pandas,
// in one file beside the bundle, installed the first time an import finds nothing else. Made here as the build makes
// it, from optional/pandas; nothing is fetched.
const ROOT = join(__dirname, "..", "..");
const DIST = join(__dirname, "..");
const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "sb-bundled-set-"));
const FILE = join(dir, "sagebrush-pkgset.json");
const S = execFileSync(process.execPath, [join(ROOT, "scripts", "bundled-set.mjs"), FILE], { encoding: "utf8" }).trim();
const PANDAS = JSON.parse(readFileSync(join(ROOT, "optional", "pandas", "sagebrush.json"), "utf8"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// A fresh runtime whose bundled set is the one in `dirs` (counting how often it is read); the output of each of
// `codes` (or its exception's last line), then "loads=N"
function run(codes: string[], opts: { dirs?: string[]; grading?: boolean; installFirst?: boolean } = {}): Promise<string[]> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    const pc = require(workerData.dist + "/src/pkgcache.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      let loads = 0;
      const load = pc.bundledSet(workerData.dirs);
      if (workerData.installFirst) c.installPackageSet(...load());
      c.setBundledPackageSet(() => (loads++, load()));
      // (a grading allowance armed: INTR bit 3, as item G sets it)
      if (workerData.grading) Atomics.or(require(workerData.dist + "/src/runtime/interrupt.js").INTR, 0, 8);
      c.R.importModule("sys").path.push(c.libDir());
      const out = workerData.codes.map((src) => {
        try {
          return c.execModule("import io as _io, sys as _sys\\n_buf = _sys.stdout = _io.StringIO()\\n" + src + "\\n_out = _buf.getvalue()\\n", "<test>", "__main__")._out;
        } catch (e) {
          return c.R.formatException(e).trim().split("\\n").pop();
        }
      });
      parentPort.postMessage([...out, "loads=" + loads]);
    });
    `,
    { eval: true, workerData: { dist: DIST, codes, dirs: opts.dirs ?? [dir], grading: !!opts.grading, installFirst: !!opts.installFirst } },
  );
  return new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
}

test("the file: the set's id, its index and its chunks, the same set web/build.ts names for notebooks", () => {
  const b = JSON.parse(readFileSync(FILE, "utf8"));
  assert.equal(b.format, "sagebrush-bundled-set");
  assert.equal(b.v, 1);
  assert.equal(b.S, S);
  assert.match(S, /^[0-9a-f]{64}$/);
  assert.equal(Object.keys(b.chunks).length, 1, "pandas' source chunk, and no precompiled code");
  assert.ok(b.index.includes(`"${PANDAS.name}@${PANDAS.version}"`));
});

test("pandas imports from the bundled set, read once, at the first import nothing else provides", async () => {
  const out = await run(["import json, math\nprint('library only')", "import pandas as pd\nprint(pd.DataFrame({'a': [1, 2], 'b': [3.5, 4.0]}))", "import pandas._pd_frame\nprint(pandas.__name__)"]);
  assert.deepEqual(out, ["library only\n", "   a    b\n0  1  3.5\n1  2  4.0\n", "pandas\n", "loads=1"]);
  // (a program that imports only what the library has never reads it)
  assert.deepEqual(await run(["import json, os, re\nprint(1)"]), ["1\n", "loads=0"]);
});

test("a module nobody provides is still ModuleNotFoundError, and the set is read for it only once", async () => {
  assert.deepEqual(await run(["import nosuch", "import nosuch2", "import pandas\nprint(pandas.DataFrame().empty)"]), [
    "ModuleNotFoundError: No module named 'nosuch'",
    "ModuleNotFoundError: No module named 'nosuch2'",
    "True\n",
    "loads=1",
  ]);
});

test("a set installed by the host comes first: the bundled one is never read", async () => {
  assert.deepEqual(await run(["import pandas\nprint(pandas.__name__)"], { installFirst: true }), ["pandas\n", "loads=0"]);
});

test("while a grading allowance is armed, the bundled pandas is refused as any set's is", async () => {
  const [out] = await run(["import pandas"], { grading: true });
  assert.equal(out, `ImportError: No module named 'pandas' in a graded run: ${PANDAS.name}@${PANDAS.version} is not admitted for grading yet: its memory and timing gates are still to be measured`);
});

test("no file, or one that isn't a bundled set: imports go on as if there were none", async () => {
  const empty = join(dir, "empty");
  const bad = join(dir, "bad");
  mkdirSync(empty, { recursive: true });
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "sagebrush-pkgset.json"), JSON.stringify({ format: "something else" }));
  for (const d of [empty, bad]) assert.deepEqual(await run(["import pandas", "import json\nprint(2)"], { dirs: [d] }), ["ModuleNotFoundError: No module named 'pandas'", "2\n", "loads=1"]);
  // (a chunk changed: refused by the set's own check, before any of it is mounted)
  const b = JSON.parse(readFileSync(FILE, "utf8"));
  const k = Object.keys(b.chunks)[0];
  b.chunks[k] = b.chunks[k].replace("DataFrame", "DataFramE");
  writeFileSync(join(bad, "sagebrush-pkgset.json"), JSON.stringify(b));
  const [out] = await run(["import pandas"], { dirs: [bad] });
  assert.match(out, /^ImportError: No module named 'pandas' could be loaded: /);
});

// The notebook server's, the board runner's and the Jupyter kernel's workers, through their own entry points: each
// registers the bundled set, found beside this process's script (here a driver in the same folder as the file)
function workerSmoke(host: string): string {
  const driver = join(dir, `smoke-${host}.cjs`);
  writeFileSync(driver, `
const { Worker } = require("node:worker_threads");
const host = ${JSON.stringify(host)}, dist = ${JSON.stringify(DIST)};
const w = new Worker(\`const { workerData } = require("node:worker_threads");
const h = workerData.host, dist = workerData.dist;
if (h === "kernel") require(dist + "/src/kernel.js").kernelWorker("python");
else if (h === "notebook") require(dist + "/src/notebook.js").notebookWorker({ dir: workerData.dir });
else require(dist + "/src/board-run.js").boardRunWorker({ dir: workerData.dir });\`, { eval: true, workerData: { host, dist, dir: ${JSON.stringify(dir)} } });
const out = [];
const timer = setTimeout(() => { console.log("timeout"); process.exit(1); }, 60000);
w.on("message", (m) => {
  if (m.ready) w.postMessage({ id: 1, code: "import pandas as pd\\nprint(pd.Series([1, 2, 3]).sum())" });
  if (m.stream === "stdout" || m.name === "stdout") out.push(m.text || "");
  if (m.stream === "stderr" || m.name === "stderr") out.push("stderr: " + (m.text || ""));
  if (m.error) out.push("error: " + JSON.stringify(m.error).slice(0, 200));
  if (m.done) { clearTimeout(timer); console.log(JSON.stringify(out.join(""))); process.exit(0); }
});
`);
  return JSON.parse(execFileSync(process.execPath, [driver], {
    encoding: "utf8",
    env: { ...process.env, SAGEBRUSH_PKGSET: "", SAGEBRUSH_PKG_BASE: "http://127.0.0.1:9" },
  }).trim().split("\n").pop()!);
}

for (const host of ["notebook", "board", "kernel"]) {
  test(`the ${host} worker imports pandas from the bundled set`, () => {
    assert.equal(workerSmoke(host), "6\n");
  });
}

test("a provider that gives no set is asked once, however many imports find nothing", async () => {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.R.importModule("sys").path.push(c.libDir());
      let loads = 0;
      c.setBundledPackageSet(() => (loads++, null));
      for (const name of ["missing_one", "missing_two", "missing_three"]) {
        try { c.R.importModule(name); } catch {}
      }
      parentPort.postMessage(loads);
    });
    `,
    { eval: true, workerData: { dist: DIST } },
  );
  const loads = await new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
  assert.equal(loads, 1);
});

test("where it is looked for: beside the entry, then dist/ beside a launcher's bin/", () => {
  const pc = require(join(DIST, "src", "pkgcache.js"));
  const bin = join(dir, "pkg", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "sagebrush.cjs"), "");
  const dirs: string[] = pc.bundledSetDirs(join(bin, "sagebrush.cjs"));
  assert.deepEqual(dirs.slice(0, 2), [bin, join(bin, "..", "dist")]);
});

test("the built CLI imports pandas with no package set given and nothing fetched; SAGEBRUSH_PKGSET=none turns it off", { skip: !existsSync(join(ROOT, "build", "cli", "sagebrush-pkgset.json")) && "build the CLI first (node scripts/build-cli.mjs)" }, () => {
  const cache = mkdtempSync(join(dir, "cache-"));
  const out = execFileSync(process.execPath, [join(ROOT, "build", "cli", "pyjs.cjs"), "-c", "import pandas as pd\nprint(pd.Series([1, 2, 3]).sum())"], {
    encoding: "utf8",
    env: { ...process.env, SAGEBRUSH_PKGSET: "", SAGEBRUSH_PKG_BASE: "http://127.0.0.1:9", XDG_CACHE_HOME: cache },
  });
  assert.equal(out, "6\n");
  // (SAGEBRUSH_PKGSET=none or --pkgset none: no set at all, this one included)
  for (const [args, env] of [[[], { SAGEBRUSH_PKGSET: "none" }], [["--pkgset", "none"], {}]] as [string[], Record<string, string>][]) {
    const r = spawnSync(process.execPath, [join(ROOT, "build", "cli", "pyjs.cjs"), ...args, "-c", "import pandas"], {
      encoding: "utf8",
      env: { ...process.env, SAGEBRUSH_PKG_BASE: "http://127.0.0.1:9", XDG_CACHE_HOME: cache, ...env },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /ModuleNotFoundError: No module named 'pandas'/);
  }
});
