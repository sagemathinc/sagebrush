import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// html and html.entities (lib/html, CPython 3.14's, unchanged) and importlib
// (lib/importlib: import_module and its checks ported, importlib.metadata
// over the package registry), compared with CPython 3.14 (S1 of the stdlib
// the curated PyPI packages need: tabulate imports html and
// importlib.metadata).
const TEST = __dirname + "/../../test/";
const cli = (args: string[]) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
for (const name of ["html_cases.py", "importlib_cases.py"])
  test(`${name}: CPython's output`, () => {
    const want = execFileSync("python3", [TEST + name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n");
    const got = cli([TEST + name]).split("\n");
    for (let i = 0; i < Math.max(want.length, got.length); i++) assert.equal(got[i], want[i], `${name} line ${i + 1}`);
  });

// What depends on the installation, apart from CPython: a curated package's
// version is its pinned one, by the normalized project name; what this
// runtime does not do is refused (NotImplementedError), never approximated.
test("importlib.metadata: a curated package's pinned version; the rest of its API, and importlib.reload, refused", () => {
  const code = [
    "import importlib, importlib.metadata as md, json",
    "print(md.version('sortedcontainers'), md.version('SortedContainers'))",
    "for label, f in [",
    "    ('not curated', lambda: md.version('numpy')),",
    "    ('another normalization', lambda: md.version('sorted-containers')),",
    "    ('entry_points', lambda: md.entry_points()),",
    "    ('from-import of distribution', lambda: __import__('importlib.metadata', fromlist=['distribution']).distribution),",
    "    ('not an API', lambda: md.no_such_api),",
    "    ('reload', lambda: importlib.reload(json)),",
    "    ('importlib.util', lambda: importlib.import_module('importlib.util')),",
    "]:",
    "    try:",
    "        print(label, 'returned', f())",
    "    except Exception as e:",
    "        print(label, type(e).__name__, e)",
  ].join("\n");
  assert.deepEqual(cli(["-c", code]).trim().split("\n"), [
    "2.4.0 2.4.0",
    "not curated PackageNotFoundError No package metadata was found for numpy",
    "another normalization PackageNotFoundError No package metadata was found for sorted-containers",
    "entry_points NotImplementedError importlib.metadata.entry_points is not supported here: only version() and PackageNotFoundError, for the curated PyPI packages",
    "from-import of distribution NotImplementedError importlib.metadata.distribution is not supported here: only version() and PackageNotFoundError, for the curated PyPI packages",
    "not an API AttributeError module 'importlib.metadata' has no attribute 'no_such_api'",
    "reload NotImplementedError importlib.reload(json): re-executing a module is not supported here; start a new session to run a changed module",
    "importlib.util ModuleNotFoundError No module named 'importlib.util'",
  ]);
});

// (the registry is read once per call, through a builtin anyone can
// replace: a stateful reader's second answer is never what is parsed)
test("importlib.metadata.version() calls the registry reader once per call (daybreak2's HOLD on c0f49426)", () => {
  const code = [
    "import builtins, json, importlib.metadata as md",
    "real = builtins.__pyjs_package_registry__",
    "calls = []",
    "def reader():",
    "    calls.append(1)",
    "    return real() if len(calls) % 2 == 1 else json.dumps({'packages': {}})",
    "builtins.__pyjs_package_registry__ = reader",
    "def ask():",
    "    try:",
    "        return md.version('sortedcontainers')",
    "    except md.PackageNotFoundError as e:",
    "        return 'not found'",
    "print(ask(), len(calls))",
    "print(ask(), len(calls))",
    "builtins.__pyjs_package_registry__ = lambda: None",
    "print('no registry:', ask())",
  ].join("\n");
  // (the first call's one read is the real registry; the second call's one
  // read is the empty one. Read twice, the first call would parse the empty one)
  assert.deepEqual(cli(["-c", code]).trim().split("\n"), ["2.4.0 1", "not found 2", "no registry: not found"]);
});
