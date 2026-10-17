import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
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

// (a zip made byte by byte, as an attacker could: each entry's name as
// given, its data stored or deflated, and its declared size, CRC and local
// header offset overridable; then the central directory and its end)
type Entry = { name: string | Buffer; data: Buffer; method?: 0 | 8; usize?: number; crc?: number; local?: number };
function rawZip(entries: Entry[], eocd: { count?: number; cdOffset?: number; cdSize?: number } = {}): Buffer {
  const parts: Buffer[] = [], cd: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name);
    const method = e.method ?? 8, body = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? crc32(e.data), usize = e.usize ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.local ?? off, 42);
    parts.push(lh, name, body);
    cd.push(ch, name);
    off += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.count ?? entries.length, 8); end.writeUInt16LE(eocd.count ?? entries.length, 10);
  end.writeUInt32LE(eocd.cdSize ?? cdBuf.length, 12); end.writeUInt32LE(eocd.cdOffset ?? off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
const script = pathToFileURL(join(repo, "scripts", "pypi-import.mjs")).href;
// (JavaScript run against the importer's exports, its last value printed, or "ERROR " and the message)
function importer(body: string): string {
  const js = `import * as P from ${JSON.stringify(script)}; import { readFileSync } from "node:fs";
try { console.log(JSON.stringify(await (async () => { ${body} })())); } catch (e) { console.log("ERROR " + e.message); }`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", js], { encoding: "utf8" }).trim();
}
let nzip = 0;
function unzipOf(buf: Buffer, limits = ""): string {
  const path = join(dir, `raw-${nzip++}.zip`);
  writeFileSync(path, buf);
  return importer(`const z = P.unzip(readFileSync(${JSON.stringify(path)})${limits ? `, { ...P.LIMITS, ${limits} }` : ""}); return [...z.keys()];`);
}
const py = (name: string, text = "X = 1\n"): Entry => ({ name, data: Buffer.from(text) });

test("pypi-import: a zip entry's name must be a canonical relative path, or the archive is refused (HARD-PYPI-1)", () => {
  assert.equal(unzipOf(rawZip([py("demo/__init__.py"), { name: "demo/", data: Buffer.alloc(0), method: 0 }])), JSON.stringify(["demo/__init__.py"]));
  for (const [name, why] of [
    ["demo/../../victim.py", /component/],
    ["../victim.py", /component/],
    ["demo/./x.py", /component/],
    ["demo//x.py", /component/],
    ["/etc/victim.py", /is absolute/],
    ["C:/victim.py", /names a drive/],
    ["demo\\..\\..\\victim.py", /has a backslash/],
    [Buffer.from("demo/x.py\0.txt"), /control character/],
    [Buffer.from([0x64, 0xff, 0x2e, 0x70, 0x79]), /not UTF-8/],
    ["", /is empty/],
  ] as const) assert.match(unzipOf(rawZip([py("demo/__init__.py"), py(name as any)])), new RegExp("^ERROR .*" + why.source), String(name));
  // (and through derive, with a wheel Python's zipfile makes, as a build tool could)
  const w = wheel("dotdot.whl", { "demo/__init__.py": "X = 1\n", "demo/../../victim.py": "import os\n", ...LIC });
  assert.match(derive(w), /^ERROR .*"demo\/\.\.\/\.\.\/victim\.py" has an empty, "\." or "\.\." component/);
});

test("pypi-import: writing and checking a package stay under its directory, refusing a path out and a symbolic link (HARD-PYPI-1)", () => {
  const top = mkdtempSync(join(tmpdir(), "sb-tree-")), pk = join(top, "packages");
  mkdirSync(pk);
  const m = `{ name: "@sagebrush/pypi-demo" }`;
  // (a key that leaves the package: refused before anything is removed or written)
  mkdirSync(join(pk, "pypi-demo"));
  writeFileSync(join(pk, "pypi-demo", "known.json"), "{}");
  for (const f of ["py/demo/../../victim.py", "../victim.py", "/tmp/victim.py"]) {
    assert.match(importer(`P.writeTree(${JSON.stringify(pk)}, "pypi-demo", new Map([["py/demo/__init__.py", Buffer.from("X = 1")], [${JSON.stringify(f)}, Buffer.from("bad")]]), ${m}); return "written";`), /^ERROR /, f);
    assert.match(importer(`return P.compareTree(${JSON.stringify(pk)}, "pypi-demo", new Map([[${JSON.stringify(f)}, Buffer.from("bad")]]), ${m});`), /^ERROR /, f);
  }
  assert.equal(existsSync(join(top, "victim.py")) || existsSync(join(pk, "victim.py")), false);
  assert.equal(existsSync(join(pk, "pypi-demo", "known.json")), true);
  for (const d of ["..", "../packages-x", "pypi-demo/../.."]) assert.match(importer(`P.writeTree(${JSON.stringify(pk)}, ${JSON.stringify(d)}, new Map(), ${m}); return "written";`), /^ERROR .*outside/, d);
  // (the package's directory, or a directory in it, a symbolic link elsewhere)
  const elsewhere = mkdtempSync(join(tmpdir(), "sb-elsewhere-"));
  symlinkSync(elsewhere, join(pk, "pypi-link"));
  assert.match(importer(`P.writeTree(${JSON.stringify(pk)}, "pypi-link", new Map([["py/x.py", Buffer.from("X")]]), ${m}); return "written";`), /^ERROR .*a symbolic link/);
  assert.equal(existsSync(join(elsewhere, "py")), false);
  mkdirSync(join(pk, "pypi-inner"));
  symlinkSync(elsewhere, join(pk, "pypi-inner", "py"));
  assert.match(importer(`P.writeTree(${JSON.stringify(pk)}, "pypi-inner", new Map([["py/x.py", Buffer.from("X")]]), ${m}); return "written";`), /^ERROR .*a symbolic link/);
  assert.match(importer(`return P.compareTree(${JSON.stringify(pk)}, "pypi-inner", new Map(), ${m});`), /^ERROR .*a symbolic link/);
  assert.equal(existsSync(join(elsewhere, "x.py")), false);
  // (and a good tree is written, then found as written)
  assert.equal(importer(`P.writeTree(${JSON.stringify(pk)}, "pypi-demo", new Map([["py/demo/__init__.py", Buffer.from("X = 1")]]), ${m}); return P.compareTree(${JSON.stringify(pk)}, "pypi-demo", new Map([["py/demo/__init__.py", Buffer.from("X = 1")]]), ${m});`), "[]");
  assert.equal(existsSync(join(pk, "pypi-demo", "known.json")), true);
});

test("pypi-import: sizes and counts past fixed ceilings are refused before inflating, and bad records fail cleanly (HARD-PYPI-2)", () => {
  const zeros = Buffer.alloc(2 << 20);
  // (declared past the per-entry ceiling: refused from the directory alone)
  assert.match(unzipOf(rawZip([{ name: "demo/big.py", data: Buffer.from("X"), usize: (16 << 20) + 1 }])), /^ERROR .*demo\/big\.py: 16777217 bytes uncompressed, past the 16777216 allowed/);
  // (declared small, inflating to more: stopped at the declared size)
  assert.match(unzipOf(rawZip([{ name: "demo/liar.py", data: Buffer.alloc(100000), usize: 10 }])), /^ERROR .*demo\/liar\.py: inflates past its declared size/);
  // (a deflate bomb: 2 MiB of zeros in a few KB, past the ratio)
  assert.match(unzipOf(rawZip([{ name: "demo/bomb.py", data: zeros }])), /^ERROR .*demo\/bomb\.py: compressed \d+ to 1, past the 100 allowed/);
  // (in all, and how many: against smaller ceilings, the same checks)
  assert.match(unzipOf(rawZip([py("demo/a.py", "A".repeat(600)), py("demo/b.py", "B".repeat(600))]), "totalBytes: 1000"), /^ERROR .*past the 1000 bytes allowed uncompressed in all/);
  assert.match(unzipOf(rawZip([py("demo/a.py"), py("demo/b.py"), py("demo/c.py")]), "entries: 2"), /^ERROR .*3 entries, past the 2 allowed/);
  assert.match(unzipOf(rawZip([py("demo/a.py")]), "wheelBytes: 50"), /^ERROR .*bytes, past the 50 allowed/);
  // (truncated, or records pointing outside the archive)
  const good = rawZip([py("demo/a.py"), py("demo/b.py")]);
  assert.equal(unzipOf(good), JSON.stringify(["demo/a.py", "demo/b.py"]));
  assert.match(unzipOf(good.subarray(0, good.length - 30)), /^ERROR bad zip archive/);
  assert.match(unzipOf(good.subarray(0, 10)), /^ERROR bad zip archive: too short/);
  assert.match(unzipOf(rawZip([py("demo/a.py")], { cdOffset: 1 << 30 })), /^ERROR .*central directory is outside the archive/);
  assert.match(unzipOf(rawZip([py("demo/a.py")], { cdSize: 1 << 20 })), /^ERROR .*central directory is outside the archive/);
  assert.match(unzipOf(rawZip([py("demo/a.py")], { count: 2 })), /^ERROR .*central directory entry 1 is truncated or missing/);
  assert.match(unzipOf(rawZip([py("demo/a.py"), { ...py("demo/b.py"), local: 1 << 30 }])), /^ERROR .*demo\/b\.py: its local header is truncated or missing/);
  assert.match(unzipOf(rawZip([py("demo/a.py"), { ...py("demo/b.py"), local: 0 }])), /^ERROR .*demo\/b\.py: its local header names another file/);
  assert.match(unzipOf(rawZip([{ ...py("demo/a.py"), crc: 1 }])), /^ERROR .*demo\/a\.py: corrupt \(size or CRC\)/);
  assert.match(unzipOf(rawZip([{ ...py("demo/a.py"), method: 0, usize: 3 }])), /^ERROR .*demo\/a\.py: stored, but 6 bytes for 3/);
  assert.match(unzipOf(rawZip([py("demo/a.py"), py("demo/a.py")])), /^ERROR .*demo\/a\.py: twice in the archive/);
});

test("pypi-import: a download past its ceiling is refused as it streams, and before, if Content-Length says so (HARD-PYPI-2)", () => {
  // (a stream that would never end: refused once past the ceiling, having read just past it)
  assert.equal(importer(`let n = 0; const body = new ReadableStream({ pull(c) { n++; c.enqueue(new Uint8Array(1000)); } });
    try { await P.boundedBody(new Response(body), 5000, "x"); return "read"; } catch (e) { return [e.message, n <= 8]; }`), JSON.stringify(["x: past the 5000 bytes allowed", true]));
  assert.equal(importer(`let pulled = false; const body = new ReadableStream({ pull(c) { pulled = true; c.enqueue(new Uint8Array(10)); c.close(); } }, { highWaterMark: 0 });
    try { await P.boundedBody(new Response(body, { headers: { "content-length": "999999" } }), 5000, "x"); return "read"; } catch (e) { return [e.message, pulled]; }`), JSON.stringify(["x: 999999 bytes, past the 5000 allowed", false]));
  assert.equal(importer(`return (await P.boundedBody(new Response(new Uint8Array(5000)), 5000, "x")).length;`), "5000");
});

test("the committed curated packages are as their pinned wheels have them (scripts/pypi-import.mjs --check)", { skip: !process.env.SAGEBRUSH_PYPI_CHECK && "needs the network or a wheel cache: set SAGEBRUSH_PYPI_CHECK=1 (CI runs it as its own step)" }, () => {
  execFileSync(process.execPath, [join(repo, "scripts", "pypi-import.mjs"), "--check"], { encoding: "utf8" });
});
