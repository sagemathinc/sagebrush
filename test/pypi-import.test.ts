import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// scripts/pypi-import.mjs: a curated PyPI package is one pinned pure-Python
// wheel, every file as its RECORD says, Python sources only, a permissive
// license (pypi-tests/README.md). Wheels are made here (Python's zipfile) and
// given to derive(), which accepts the good one and refuses each bad one,
// saying why.
const repo = join(__dirname, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "sb-wheels-"));
// (a wheel: files name -> text; RECORD made from them unless given; then its sha256)
function wheel(name: string, files: Record<string, string>, opts: { record?: string; wheel?: string; metadata?: string } = {}): { path: string; sha256: string } {
  const path = join(dir, name);
  const py = `
import base64, hashlib, json, sys, zipfile
files = json.loads(sys.argv[2]); opts = json.loads(sys.argv[3])
di = "demo-1.0.0.dist-info"
files.setdefault(di + "/WHEEL", opts.get("wheel") or "Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
files.setdefault(di + "/METADATA", opts.get("metadata") or "Metadata-Version: 2.1\\nName: demo\\nVersion: 1.0.0\\n")
rec = "".join("%s,sha256=%s,%d\\n" % (n, base64.urlsafe_b64encode(hashlib.sha256(t.encode()).digest()).rstrip(b"=").decode(), len(t)) for n, t in files.items())
files[di + "/RECORD"] = opts.get("record") or rec + di + "/RECORD,,\\n"
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    for n, t in files.items():
        z.writestr(n, t)
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())
`;
  const sha256 = execFileSync("python3", ["-c", py, path, JSON.stringify(files), JSON.stringify(opts)], { encoding: "utf8" }).trim();
  return { path, sha256 };
}
const LIC = { "demo-1.0.0.dist-info/LICENSE": "MIT License\n\nCopyright (c) Demo\n" };
// (derive() on that wheel: its result's files and modules, or the error)
function derive(w: { path: string; sha256: string }, more: object = {}): string {
  const url = pathToFileURL(join(repo, "scripts", "pypi-import.mjs")).href;
  const source = { project: "demo", version: "1.0.0", filename: "demo-1.0.0-py3-none-any.whl", url: "https://files.pythonhosted.org/x/demo-1.0.0-py3-none-any.whl", sha256: w.sha256, license: "MIT", ...more };
  const js = `import { derive } from ${JSON.stringify(url)}; import { readFileSync } from "node:fs";
try { const r = derive(${JSON.stringify(source)}, readFileSync(${JSON.stringify(w.path)})); console.log(JSON.stringify({ files: [...r.files.keys()], modules: r.manifest.python.modules, skipped: r.manifest.source.pypi.skipped ?? [] })); }
catch (e) { console.log("ERROR " + e.message); }`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", js], { encoding: "utf8" }).trim();
}

test("pypi-import: a pure-Python wheel becomes a package: its Python files, its license; type stubs and py.typed left out, listed", () => {
  const w = wheel("good.whl", { "demo/__init__.py": "X = 1\n", "demo/sub.py": "Y = 2\n", "demo/__init__.pyi": "X: int\n", "demo/py.typed": "", ...LIC });
  assert.equal(derive(w), JSON.stringify({ files: ["py/demo/__init__.py", "py/demo/sub.py", "LICENSE"], modules: ["demo"], skipped: ["demo/__init__.pyi", "demo/py.typed"] }));
});

test("pypi-import: each wheel that isn't one pinned, pure-Python, permissively licensed wheel, as its RECORD says, is refused, saying why", () => {
  const good = { "demo/__init__.py": "X = 1\n", ...LIC };
  const w = wheel("pin.whl", good);
  assert.match(derive({ ...w, sha256: "0".repeat(64) }), /^ERROR .*its SHA-256 is [0-9a-f]{64}, not the pinned 0{64}$/);
  assert.match(derive(wheel("impure.whl", good, { wheel: "Wheel-Version: 1.0\nRoot-Is-Purelib: false\nTag: py3-none-any\n" })), /^ERROR .*not a pure-Python wheel/);
  assert.match(derive(wheel("tag.whl", good, { wheel: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: cp314-cp314-linux_x86_64\n" })), /^ERROR .*tags cp314-cp314-linux_x86_64 \(only \*-none-any\)/);
  assert.match(derive(wheel("record.whl", good, { record: "demo/__init__.py,sha256=AAAA,6\n" })), /^ERROR .*(is not the file RECORD gives|has no SHA-256 in RECORD)/);
  assert.match(derive(wheel("so.whl", { ...good, "demo/_speedups.so": "\x7fELF" })), /^ERROR .*demo\/_speedups\.so is not Python source/);
  assert.match(derive(wheel("data.whl", { ...good, "demo-1.0.0.data/scripts/run": "#!/bin/sh\n" })), /^ERROR .*has a \.data directory/);
  assert.match(derive(wheel("gpl.whl", good), { license: "GPL-3.0-only" }), /^ERROR .*license GPL-3\.0-only is not on the list/);
  assert.match(derive(wheel("nolicense.whl", { "demo/__init__.py": "X = 1\n" })), /^ERROR .*no license file/);
  assert.match(derive(wheel("meta.whl", good, { metadata: "Metadata-Version: 2.1\nName: demo\nVersion: 9.9.9\n" })), /^ERROR .*METADATA is demo 9\.9\.9, not demo 1\.0\.0/);
  assert.match(derive(wheel("outside.whl", { ...good, "demo-1.0.0.dist-info/top_level.txt": "demo\n", "other.py": "Z = 3\n" })), /^ERROR .*other\.py is outside its top-level names \(demo\)/);
});

test("the committed curated packages are as their pinned wheels have them (scripts/pypi-import.mjs --check)", { skip: !process.env.SAGEBRUSH_PYPI_CHECK && "needs the network or a wheel cache: set SAGEBRUSH_PYPI_CHECK=1 (CI runs it as its own step)" }, () => {
  execFileSync(process.execPath, [join(repo, "scripts", "pypi-import.mjs"), "--check"], { encoding: "utf8" });
});
