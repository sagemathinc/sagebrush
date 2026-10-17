import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Packages (src/compile.ts, scripts/packages.mjs): a module that sys.path
// doesn't have is looked up by its full dotted name in the build's registry,
// and imported only from bytes that have the registry's SHA-256.
const DIST = __dirname + "/..";
const repo = join(__dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// A packages directory (dir -> {path: text}) and the registry that pins it
function fixture(pkgs: Record<string, { root?: string; modules: string[]; files: Record<string, string> }>) {
  const dir = mkdtempSync(join(tmpdir(), "sb-packages-"));
  const registry: any = { format: 1, modules: {}, packages: {} };
  for (const [name, p] of Object.entries(pkgs)) {
    const id = `@sagebrush/${name}@0.1.0`;
    const files: Record<string, string> = {};
    for (const [f, text] of Object.entries(p.files)) {
      mkdirSync(dirname(join(dir, name, f)), { recursive: true });
      writeFileSync(join(dir, name, f), text);
      files[f] = sha(text);
    }
    registry.packages[id] = { dir: name, root: p.root ?? "py", manifest_sha256: "0".repeat(64), files };
    for (const m of p.modules) registry.modules[m] = id;
  }
  return { dir, registry };
}

// Run `code` in a fresh runtime (a package is mounted once per process) with
// this registry and packages directory; its output, or the exception's last line
function run(code: string, registry: any, packages: string, extraPath: string[] = []): Promise<string> {
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    process.env.SAGEBRUSH_PACKAGES = workerData.packages;
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.setPackageRegistry(workerData.registry);
      const path = c.R.importModule("sys").path;
      for (const p of workerData.extraPath) path.push(p);
      path.push(c.libDir());
      // (its output, collected in the module's own _out)
      const code = "import io as _io, sys as _sys\\n_buf = _sys.stdout = _io.StringIO()\\n" + workerData.code + "\\n_out = _buf.getvalue()\\n";
      try {
        parentPort.postMessage(c.execModule(code, "<test>", "__main__")._out);
      } catch (e) {
        parentPort.postMessage(c.R.formatException(e).trim().split("\\n").pop());
      }
    });
    `,
    { eval: true, workerData: { dist: DIST, code, registry, packages, extraPath } },
  );
  return new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
}

test("a package's module imports on a sys.path miss, from its own directory; its submodules too", async () => {
  const f = fixture({ "demo-pkg": { modules: ["demopkg"], files: { "py/demopkg/__init__.py": "X = 1\n", "py/demopkg/sub.py": "Y = 2\n" } } });
  const out = await run("import demopkg, demopkg.sub\nprint(demopkg.X, demopkg.sub.Y)\nprint(demopkg.__file__.endswith('demo-pkg/py/demopkg/__init__.py'), demopkg.__path__[0].endswith('demo-pkg/py/demopkg'))\n", f.registry, f.dir);
  assert.equal(out, "1 2\nTrue True\n");
});

test("a file of the same name on sys.path comes first, as it would over lib/", async () => {
  const f = fixture({ "demo-mod": { modules: ["demomod"], files: { "py/demomod.py": "WHO = 'package'\n" } } });
  const mine = mkdtempSync(join(tmpdir(), "sb-mine-"));
  writeFileSync(join(mine, "demomod.py"), "WHO = 'mine'\n");
  assert.equal(await run("import demomod\nprint(demomod.WHO)\n", f.registry, f.dir, [mine]), "mine\n");
  assert.equal(await run("import demomod\nprint(demomod.WHO)\n", f.registry, f.dir), "package\n");
});

test("a file that is not the pinned one is an ImportError saying which, and none of the package runs", async () => {
  const f = fixture({ "demo-mod": { modules: ["demomod"], files: { "py/a.py": "A = 1\n", "py/demomod.py": "import builtins\nbuiltins.RAN = True\n" } } });
  writeFileSync(join(f.dir, "demo-mod", "py", "a.py"), "A = 2\n");
  const out = await run("try:\n    import demomod\nexcept ImportError as e:\n    print(type(e).__name__, e)\nimport builtins\nprint(hasattr(builtins, 'RAN'))\n", f.registry, f.dir);
  assert.equal(out, "ImportError @sagebrush/demo-mod: py/a.py is not the file this build pinned\nFalse\n");
});

test("a package that isn't there is a ModuleNotFoundError naming it", async () => {
  const f = fixture({ "demo-mod": { modules: ["demomod"], files: { "py/demomod.py": "\n" } } });
  const empty = mkdtempSync(join(tmpdir(), "sb-none-"));
  const out = await run("try:\n    import demomod\nexcept ModuleNotFoundError as e:\n    print(e.name, '|', e)\n", f.registry, empty);
  assert.equal(out, "demomod | No module named 'demomod' (it is in @sagebrush/demo-mod, which is not installed here)\n");
  // (and a name no package has is the usual error)
  assert.equal(await run("import nosuchmodule\n", f.registry, f.dir), "ModuleNotFoundError: No module named 'nosuchmodule'");
});

test("only pinned files are importable from a mounted package, from the bytes checked when it was mounted", async () => {
  const f = fixture({ "demo-pkg": { modules: ["demopkg"], files: { "py/demopkg/__init__.py": "\n", "py/demopkg/b.py": "B = 'checked'\n" } } });
  writeFileSync(join(f.dir, "demo-pkg", "py", "demopkg", "extra.py"), "E = 1\n");
  assert.equal(await run("import demopkg.extra\n", f.registry, f.dir), "ModuleNotFoundError: No module named 'demopkg.extra'");
  // (b.py changed on disk after the mount: the import still has the checked bytes)
  const code = `import demopkg\nopen(${JSON.stringify(join(f.dir, "demo-pkg", "py", "demopkg", "b.py"))}, "w").write("B = 'changed'\\n")\nimport demopkg.b\nprint(demopkg.b.B)\n`;
  assert.equal(await run(code, f.registry, f.dir), "checked\n");
});

test("a dotted name is a package's by its full name, run with its own __path__ (the parent's is unchanged)", async () => {
  const f = fixture({ "demo-sub": { modules: ["demoparent.sub"], files: { "py/demoparent/sub/__init__.py": "from . import leaf\n", "py/demoparent/sub/leaf.py": "L = 'leaf'\n" } } });
  const mine = mkdtempSync(join(tmpdir(), "sb-parent-"));
  mkdirSync(join(mine, "demoparent"));
  writeFileSync(join(mine, "demoparent", "__init__.py"), "\n");
  const code = "import demoparent.sub\nprint(demoparent.sub.leaf.L, len(demoparent.__path__), demoparent.sub.__path__[0].endswith('demo-sub/py/demoparent/sub'))\n";
  assert.equal(await run(code, f.registry, f.dir, [mine]), "leaf 1 True\n");
});

test("the catalog links a package's function to its file in packages/", async () => {
  const f = fixture({ "demo-mod": { modules: ["demomod"], files: { "py/demomod.py": "X = 1\n\ndef f():\n    return 1\n" } } });
  const out = await run("import demomod, _catalog\nprint(_catalog.source_url(demomod.f, 'REF').split('/blob/')[1])\n", f.registry, f.dir);
  assert.equal(out, "REF/packages/demo-mod/py/demomod.py#L3-L4\n");
});

test("-m finds a package's module (findModuleSource), its __main__ for a package", async () => {
  const f = fixture({ "demo-pkg": { modules: ["demopkg", "demomod"], files: { "py/demopkg/__init__.py": "\n", "py/demopkg/__main__.py": "print('main')\n", "py/demomod.py": "print('mod')\n" } } });
  const w = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    process.env.SAGEBRUSH_PACKAGES = workerData.packages;
    const c = require(workerData.dist + "/src/compile.js");
    Promise.resolve(c.initParser && c.initParser()).then(() => {
      c.setPackageRegistry(workerData.registry);
      c.R.importModule("sys").path.push(c.libDir());
      const tail = (r) => r && [r[0], r[1].split("/").slice(-3).join("/")];
      parentPort.postMessage([tail(c.findModuleSource("demopkg")), tail(c.findModuleSource("demomod")), c.findModuleSource("nosuchmodule")]);
    });
    `,
    { eval: true, workerData: { dist: DIST, registry: f.registry, packages: f.dir } },
  );
  const got = await new Promise((resolve, reject) => {
    w.once("message", (m) => (w.terminate(), resolve(m)));
    w.once("error", reject);
  });
  assert.deepEqual(got, [["print('main')\n", "py/demopkg/__main__.py"], ["print('mod')\n", "demo-pkg/py/demomod.py"], null]);
});

// scripts/packages.mjs on a repository of its own: what it refuses
function check(files: Record<string, string>, lib: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "sb-pkgroot-"));
  for (const [f, text] of Object.entries({ ...files, ...Object.fromEntries(Object.entries(lib).map(([k, v]) => ["lib/" + k, v])) })) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const url = pathToFileURL(join(repo, "scripts", "packages.mjs")).href;
  return execFileSync(process.execPath, ["--input-type=module", "-e", `import { readPackages } from ${JSON.stringify(url)};\ntry { console.log(JSON.stringify(readPackages(${JSON.stringify(root)}).registry.modules)); } catch (e) { console.log(e.message); }`], { encoding: "utf8" }).trim();
}
const manifest = (o: object) => JSON.stringify({ name: "@sagebrush/demo", version: "0.1.0", sagebrush: ">=0.4", modes: ["python"], python: { root: "py", modules: ["demo"] }, files: { "py/demo.py": sha("D = 1\n") }, requires: [], catalog: null, ...o });

test("scripts/packages.mjs: a well-formed package is registered, and each malformed one refused with why", () => {
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({}), "packages/demo/py/demo.py": "D = 1\n", "packages/demo/README.md": "x" }), '{"demo":"@sagebrush/demo@0.1.0"}');
  // (an npm package's directory is not one)
  assert.equal(check({ "packages/npm-thing/package.json": "{}" }), "{}");
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({}), "packages/demo/py/demo.py": "D = 2\n" }), `packages/demo: py/demo.py: its SHA-256 is ${sha("D = 2\n")}, not ${sha("D = 1\n")} (update sagebrush.json)`);
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({}), "packages/demo/py/demo.py": "D = 1\n", "packages/demo/py/more.py": "" }), "packages/demo: py/more.py is not in files (every file is pinned)");
  assert.equal(check({ "packages/other/sagebrush.json": manifest({}), "packages/other/py/demo.py": "D = 1\n" }), 'packages/other: its name must be @sagebrush/other, the directory\'s (it is "@sagebrush/demo")');
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({}), "packages/demo/py/demo.py": "D = 1\n" }, { "demo.py": "" }), "packages/demo: module demo is also in lib/, which would shadow it");
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({ files: { "../x.py": sha("") } }), "packages/demo/py/demo.py": "D = 1\n" }), "packages/demo: py/demo.py is not in files (every file is pinned)");
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({ files: { "py/demo.py": sha("D = 1\n"), "../x.py": sha("") } }), "packages/demo/py/demo.py": "D = 1\n" }), 'packages/demo: "../x.py" is not a path inside the package');
  assert.equal(check({ "packages/demo/sagebrush.json": manifest({ python: { root: "py", modules: ["demo", "gone"] } }), "packages/demo/py/demo.py": "D = 1\n" }), "packages/demo: it has no file for module gone");
});

test("the repository's packages/registry.json is current", () => {
  execFileSync(process.execPath, [join(repo, "scripts", "packages.mjs"), "--check"], { encoding: "utf8" });
});
