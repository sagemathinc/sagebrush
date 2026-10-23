import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Optional packages are outside every core input (plan-modular-packages-r4
// §7.2): adding or changing files under optional/ leaves the build id (which
// names the compiler, the library and the bundled packages' registry) and the
// bundled registry unchanged, so no core artifact can change with them.
const repo = join(__dirname, "..", "..");
// (the scripts are ES modules: imported for real, as tsc would make import() a require; test/marimo-format.test.ts)
const esm = (rel: string): Promise<any> => new Function("u", "return import(u)")(pathToFileURL(join(repo, rel)).href);

test("files under optional/ don't change the build id", async () => {
  const { buildId } = await esm("scripts/build-id.mjs");
  // (a copy of the inputs: src, lib and the registry, plus an optional/ tree)
  const dir = mkdtempSync(join(tmpdir(), "sb-buildid-"));
  try {
    for (const d of ["src", "lib"]) cpSync(join(repo, d), join(dir, d), { recursive: true });
    mkdirSync(join(dir, "packages"));
    cpSync(join(repo, "packages", "registry.json"), join(dir, "packages", "registry.json"));
    const before = buildId(dir);
    mkdirSync(join(dir, "optional", "demo", "py", "demo"), { recursive: true });
    writeFileSync(join(dir, "optional", "demo", "py", "demo", "__init__.py"), "X = 1\n");
    writeFileSync(join(dir, "optional", "demo", "sagebrush.json"), "{}\n");
    assert.equal(buildId(dir), before);
    // (while a change to the library does change it: the test can see a difference)
    writeFileSync(join(dir, "lib", "zz_probe.py"), "\n");
    assert.notEqual(buildId(dir), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no optional package is in the bundled registry", async () => {
  const reg = readFileSync(join(repo, "packages", "registry.json"), "utf8");
  const { readOptional } = await esm("scripts/optional-packages.mjs");
  const pkgs = readOptional(repo);
  assert.ok(pkgs.length >= 1, "optional/hello exists");
  for (const p of pkgs) {
    assert.ok(!reg.includes(p.id), `${p.id} is not in packages/registry.json`);
    for (const m of p.manifest.python.modules) assert.ok(!reg.includes(`"${m}"`), `${m} is not a bundled module`);
  }
});

test("the contract lint flags reflection, private access and monkeypatching, and passes protocols and package-private state (§5.4)", async () => {
  const { lintPackage, loadApi } = await esm("scripts/optional-packages.mjs");
  const api = loadApi(repo);
  const pkg = (files: Record<string, string>, extra: any = {}) => ({ dir: "fixture", id: "@sagebrush/fixture@0.1.0", manifest: { python: { root: "py", modules: ["fixture"] }, private_prefix: "_fx_", ...extra }, files, declarations: extra.declarations ?? [] });
  const flagged: [string, string][] = [
    // astra's three probes, verbatim
    ["computed private import", "import importlib\nname = ''.join(['_', 'sb', '_check'])\nm = importlib.import_module(name)\nprint(m is not None)\n"],
    ["computed internal builtin", "import builtins\nlookup = getattr\nname = ''.join(['__', 'pyjs_package', '_registry__'])\nf = lookup(builtins, name)\nprint(callable(f))\n"],
    ["computed core write", "import math\nput = setattr\nput(math, 'modular_probe', 7)\nprint(math.modular_probe)\ndelattr(math, 'modular_probe')\n"],
    ["__import__", "m = __import__('x')\n"],
    ["eval", "eval('1')\n"],
    ["exec", "exec('x = 1')\n"],
    ["compile", "compile('1', 'f', 'eval')\n"],
    ["vars", "import numpy as np\nd = vars(np)\n"],
    ["__dict__", "import numpy as np\nd = np.__dict__\n"],
    ["sys.modules", "import sys\nm = sys.modules['_x']\n"],
    ["a getattr helper", "def g(o, n):\n    return getattr(o, n)\n"],
    ["monkeypatch a module", "import math\nmath.pi = 3\n"],
    ["monkeypatch a type", "import numpy as np\nnp.ndarray.x = 1\n"],
    ["delete a core name", "import matplotlib.pyplot\ndel matplotlib.pyplot.figure\n"],
    ["a private import", "import _sb_check\n"],
    ["a private from-import", "from numpy import _private\n"],
    ["private attribute on another object", "class F:\n    def __init__(self):\n        self._data = 1\n    def f(self, arr):\n        return arr._data\n"],
  ];
  for (const [what, src] of flagged) {
    const r = lintPackage(pkg({ "py/fixture.py": src }), api);
    assert.ok(r.findings.length > 0, `${what} is flagged`);
  }
  const passing = [
    "class F:\n    def __init__(self):\n        self._data = []\n        self._fx_cache = None\n    def other(self, o):\n        return o._fx_cache\n    def __array__(self, dtype=None):\n        return None\n    def _repr_html_(self):\n        return '<b>F</b>'\n    def __add__(self, x):\n        return self\n",
    "import numpy as np\nimport matplotlib.pyplot as plt\n_helper = 1\ndef f(xs):\n    return np.sum(np.asarray(xs))\n",
  ];
  for (const src of passing) {
    const r = lintPackage(pkg({ "py/fixture.py": src }), api);
    assert.deepEqual(r.findings, [], src);
  }
  // a reviewed declaration allows that one line only
  const decl = [{ file: "py/fixture.py", line: 1, construct: "name", target: "hasattr", reason: "duck typing an ndarray-like" }];
  assert.deepEqual(lintPackage(pkg({ "py/fixture.py": "ok = hasattr(1, 'shape')\n" }, { declarations: decl }), api).findings, []);
  assert.equal(lintPackage(pkg({ "py/fixture.py": "\nok = hasattr(1, 'shape')\n" }, { declarations: decl }), api).findings.length, 1);
  // a private prefix the core already uses is refused
  const used = api.prefixes[0];
  assert.ok(lintPackage(pkg({ "py/fixture.py": "" }, { private_prefix: used }), api).findings.some((f: any) => f.construct === "private_prefix"));
});

test("requirements come from the call forms used (§6.2–6.3): a new keyword raises the level, the old call doesn't", async () => {
  const { useLevel } = await esm("scripts/optional-packages.mjs");
  // level 1 had f(x); level 2 added extra=False (keyword-only) and a positional y=0
  const api = {
    api: 1, level: 2, prefixes: [],
    modules: {
      m: {
        since: 1,
        names: {
          f: { kind: "function", since: 1, params: [{ name: "x", kind: "pos", default: false, since: 1 }, { name: "y", kind: "pos", default: true, since: 2 }, { name: "extra", kind: "kwonly", default: true, since: 2 }] },
          C: { kind: "class", since: 1, members: { meth: { kind: "function", since: 1, params: [{ name: "self", kind: "pos", default: false, since: 1 }, { name: "extra", kind: "kwonly", default: true, since: 2 }] } } },
        },
      },
    },
  };
  assert.equal(useLevel(api, { target: "m.f", bound: { npos: 1, kw: [], unpack: false } }), 1);
  assert.equal(useLevel(api, { target: "m.f", bound: { npos: 1, kw: ["extra"], unpack: false } }), 2);
  assert.equal(useLevel(api, { target: "m.f", bound: { npos: 2, kw: [], unpack: false } }), 2, "a positional past the old arity");
  assert.equal(useLevel(api, { target: "m.f", bound: { npos: 1, kw: [], unpack: true } }), 2, "unpacking takes the maximum");
  assert.equal(useLevel(api, { target: "*.meth", bound: { npos: 0, kw: [], unpack: false } }), 2, "an untyped method call takes the maximum");
  assert.equal(useLevel(api, { target: "m.C.meth", bound: { npos: 1, kw: [], unpack: false } }), 1);
  assert.equal(useLevel(api, { target: "m.nothere", bound: null }), null);
  assert.equal(useLevel(api, { target: "m.f", bound: "any" }), 2, "an escaping reference takes the maximum");

  // through lintPackage: an alias, a reference passed or stored, and a
  // declared dynamic target with and without its call form (astra's CORR-PR68-2)
  const { lintPackage } = await esm("scripts/optional-packages.mjs");
  const pkg = (src: string, declarations: any[] = []) => ({ dir: "fixture", id: "@sagebrush/fixture@0.1.0", manifest: { python: { root: "py", modules: ["fixture"] }, private_prefix: "_fx_" }, files: { "py/fixture.py": src }, declarations });
  const level = (src: string, declarations: any[] = []) => {
    const r = lintPackage(pkg(src, declarations), api);
    assert.deepEqual(r.findings, [], src);
    return r.level;
  };
  assert.equal(level("from m import f\nf(1)\n"), 1);
  assert.equal(level("from m import f\ng = f\ng(1, extra=True)\n"), 2, "an alias");
  assert.equal(level("import m\ng = m.f\n"), 2, "an attribute alias");
  assert.equal(level("from m import f\nxs = list(map(f, [1]))\n"), 2, "passed as an argument");
  assert.equal(level("from m import f\nfs = [f]\n"), 2, "stored in a container");
  assert.equal(level("from m import f\nf(1)\nf = 2\n"), 1, "a name stored to doesn't escape");
  const dyn = (extra: any) => [{ file: "py/fixture.py", line: 2, construct: "name", target: "getattr", access: "m.f", reason: "a reviewed fixture", ...extra }];
  const src = "import m\nr = getattr(m, 'f')(1)\n";
  assert.equal(level(src, dyn({ call: [] })), 1, "a declared dynamic target in its call form");
  assert.equal(level(src, dyn({ call: ["extra"] })), 2, "a declared call form passing a newer keyword");
  assert.equal(level(src, dyn({})), 2, "a declared dynamic target without a call form takes the maximum");
  assert.ok(lintPackage(pkg(src, dyn({})), api).uses.some((u: any) => u.target === "m.f" && u.declared), "the declared target is in uses");
});
