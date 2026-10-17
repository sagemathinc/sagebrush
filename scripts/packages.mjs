#!/usr/bin/env node
// Sagebrush's packages: modules kept outside lib/, each in
// packages/<name>/ with a sagebrush.json, and the build's registry of them,
// packages/registry.json, which pins every file a build may load by its
// SHA-256 (src/compile.ts imports a package's module only from those bytes).
// A directory of packages/ without a sagebrush.json (an npm package) is not
// one of them.
//
//   node scripts/packages.mjs           check the packages, write packages/registry.json
//   node scripts/packages.mjs --check   fail if a package is malformed or the registry is out of date
//
// sagebrush.json:
//   name       "@sagebrush/<its directory's name>"
//   version    "MAJOR.MINOR.PATCH"
//   sagebrush  the Sagebrush versions it is for (a range, as npm's)
//   modes      the modes it serves: "python", "sage", "matlab", "magma"
//   python     {root: its Python files' directory, modules: the module
//              names an import looks it up by, dotted for a submodule}
//   files      every file of it -> SHA-256 (but sagebrush.json, and its README,
//              LICENSE* and NOTICE* files)
//   requires   other packages (not used yet), catalog (null; not used yet)
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const MODES = new Set(["python", "sage", "matlab", "magma"]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// (beside the code, not pinned: the manifest, a README, licenses and notices)
const DOCS = /^(sagebrush\.json|README\.md|LICENSE[^/]*|NOTICE[^/]*|known\.json)$/;
// (a relative path inside the package: no "..", no absolute or odd names)
const safePath = (p) => typeof p === "string" && p !== "" && !p.startsWith("/") && p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/.test(s));

// A package's files, by path in it.  A symbolic link anywhere is refused,
// looked at before it is followed: it could pin a file outside the package,
// lead out of it, or loop (daybreak2's HARD-40C-1).
function walk(dir, bad, base = dir, out = []) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f), st = lstatSync(p);
    if (st.isSymbolicLink()) bad(`${relative(base, p)} is a symbolic link (a package's files are its own)`);
    if (st.isDirectory()) {
      if (f !== "__pycache__") walk(p, bad, base, out);
    } else if (st.isFile()) out.push(relative(base, p));
    else bad(`${relative(base, p)} is not a file or a directory`);
  }
  return out;
}

/** The packages under root/packages: {registry, files ("<dir>/<path>" -> text)}; throws on the first problem. */
export function readPackages(root) {
  const pdir = join(root, "packages");
  const modules = {}, packages = {}, files = {};
  const lib = join(root, "lib");
  for (const dir of existsSync(pdir) ? readdirSync(pdir).sort() : []) {
    const at = join(pdir, dir);
    const bad = (why) => {
      throw new Error(`packages/${dir}: ${why}`);
    };
    const st = lstatSync(at);
    if (st.isSymbolicLink() && existsSync(join(at, "sagebrush.json"))) bad("is a symbolic link (a package is a directory of packages/)");
    if (!st.isDirectory() || !existsSync(join(at, "sagebrush.json"))) continue;
    if (lstatSync(join(at, "sagebrush.json")).isSymbolicLink()) bad("sagebrush.json is a symbolic link");
    const raw = readFileSync(join(at, "sagebrush.json"));
    let m;
    try {
      m = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      bad(`sagebrush.json is not JSON (${e.message})`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(dir)) bad("a package's directory is its name: lowercase letters, digits and -");
    if (m.name !== `@sagebrush/${dir}`) bad(`its name must be @sagebrush/${dir}, the directory's (it is ${JSON.stringify(m.name)})`);
    if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) bad("version must be MAJOR.MINOR.PATCH");
    if (typeof m.sagebrush !== "string" || !m.sagebrush) bad("sagebrush must be a version range");
    if (!Array.isArray(m.modes) || !m.modes.length || !m.modes.every((x) => MODES.has(x))) bad(`modes must be some of ${[...MODES].join(", ")}`);
    const py = m.python;
    if (!py || !safePath(py.root)) bad("python.root must be a directory inside the package");
    if (!Array.isArray(py.modules) || !py.modules.length || !py.modules.every((x) => typeof x === "string" && x.split(".").every((s) => IDENT.test(s)))) bad("python.modules must be module names");
    if (m.requires !== undefined && (!Array.isArray(m.requires) || m.requires.length)) bad("requires is not supported yet: []");
    if (m.catalog !== undefined && m.catalog !== null) bad("catalog is not supported yet: null");
    if (m.wasm !== undefined) bad("wasm is not supported yet");
    // (a curated PyPI package, packages/pypi-<name>/, records the wheel it is
    // from; scripts/pypi-import.mjs --check re-derives it from that wheel)
    if (dir.startsWith("pypi-") !== (m.source?.pypi !== undefined)) bad("a packages/pypi-<name> directory is exactly a package with source.pypi");
    if (m.source !== undefined) {
      const p = m.source?.pypi;
      if (!p || typeof p !== "object" || Object.keys(m.source).length !== 1) bad("source must be {pypi: {...}}");
      if (typeof p.project !== "string" || dir !== "pypi-" + p.project.toLowerCase().replace(/[-_.]+/g, "-")) bad(`source.pypi.project must be the project this directory is named for`);
      if (p.version !== m.version) bad("source.pypi.version must be the package's version");
      if (typeof p.filename !== "string" || !/^[A-Za-z0-9_.]+-[0-9.]+-[A-Za-z0-9_.]+-none-any\.whl$/.test(p.filename)) bad("source.pypi.filename must be a pure-Python wheel's");
      if (typeof p.url !== "string" || !p.url.startsWith("https://files.pythonhosted.org/") || !p.url.endsWith("/" + p.filename)) bad("source.pypi.url must be the wheel's on files.pythonhosted.org");
      if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) bad("source.pypi.sha256 must be the wheel's SHA-256");
      if (typeof p.license !== "string" || !p.license) bad("source.pypi.license must be its license");
    }
    if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) bad("files must map each file to its SHA-256");
    // (every file pinned, and only files that are there)
    const present = walk(at, bad).filter((f) => !DOCS.test(f));
    for (const f of present) if (!Object.hasOwn(m.files, f)) bad(`${f} is not in files (every file is pinned)`);
    const pins = {};
    for (const [f, sum] of Object.entries(m.files).sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!safePath(f)) bad(`${JSON.stringify(f)} is not a path inside the package`);
      if (!present.includes(f)) bad(`${f} is in files but not in the package`);
      const bytes = readFileSync(join(at, f));
      if (sum !== sha256(bytes)) bad(`${f}: its SHA-256 is ${sha256(bytes)}, not ${sum} (update sagebrush.json)`);
      if (!f.startsWith(py.root + "/")) bad(`${f} is outside python.root (only Python files, for now)`);
      if (!f.endsWith(".py")) bad(`${f}: only Python files, for now`);
      pins[f] = sum;
      files[`${dir}/${f}`] = bytes.toString("utf8");
    }
    // (a curated package's known differences from CPython, pypi-tests/README.md:
    // each upstream test allowed to fail here, only with exactly this error:
    // its type and its message's first line, as pypi-tests/harness.py prints it)
    let known = [];
    if (existsSync(join(at, "known.json"))) {
      if (!m.source?.pypi) bad("known.json is for curated PyPI packages (packages/pypi-<name>)");
      if (lstatSync(join(at, "known.json")).isSymbolicLink()) bad("known.json is a symbolic link");
      let k;
      try {
        k = JSON.parse(readFileSync(join(at, "known.json"), "utf8"));
      } catch (e) {
        bad(`known.json is not JSON (${e.message})`);
      }
      if (!k || !Array.isArray(k.tests) || Object.keys(k).length !== 1) bad('known.json must be {"tests": [{test, error, message, reason}, ...]}');
      for (const t of k.tests) {
        if (!t || typeof t !== "object" || Object.keys(t).sort().join() !== "error,message,reason,test") bad("each known difference is {test, error, message, reason}");
        if (typeof t.test !== "string" || !/^test_\w+(\.test\w*)?$/.test(t.test)) bad(`known test ${JSON.stringify(t.test)} must name an upstream test, module.function`);
        if (typeof t.error !== "string" || !/^[A-Z]\w*(Error|Exception)$/.test(t.error)) bad(`known test ${t.test}: error must be an exception's name, raised instead of passing`);
        if (typeof t.message !== "string" || /[\r\n]/.test(t.message) || t.message.length > 200) bad(`known test ${t.test}: message must be the error's first line, as the harness prints it (at most 200 characters)`);
        if (typeof t.reason !== "string" || t.reason.trim().length < 10) bad(`known test ${t.test}: give the reason in plain words`);
      }
      if (new Set(k.tests.map((t) => t.test)).size !== k.tests.length) bad("known.json lists a test twice");
      known = k.tests.map((t) => ({ test: t.test, error: t.error, message: t.message, reason: t.reason }));
    }
    const id = `${m.name}@${m.version}`;
    for (const mod of py.modules) {
      const rel = mod.split(".").join("/");
      if (!pins[`${py.root}/${rel}.py`] && !pins[`${py.root}/${rel}/__init__.py`]) bad(`it has no file for module ${mod}`);
      if (modules[mod]) bad(`module ${mod} is also ${modules[mod]}'s`);
      // (lib/ comes first on sys.path: a module in both would never be the package's)
      if (existsSync(join(lib, rel + ".py")) || existsSync(join(lib, rel, "__init__.py"))) bad(`module ${mod} is also in lib/, which would shadow it`);
      modules[mod] = id;
    }
    packages[id] = { dir, root: py.root, manifest_sha256: sha256(raw), files: pins, ...(m.source?.pypi ? { pypi: { project: m.source.pypi.project, version: m.source.pypi.version, known } } : {}) };
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => a[0].localeCompare(b[0])));
  return { registry: { format: 1, modules: sorted(modules), packages: sorted(packages) }, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(fileURLToPath(import.meta.url), "..", "..");
  const out = join(root, "packages", "registry.json");
  let text;
  try {
    text = JSON.stringify(readPackages(root).registry, null, 2) + "\n";
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const now = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (now !== text) {
      console.error("out of date: packages/registry.json (run node scripts/packages.mjs)");
      process.exit(1);
    }
  } else writeFileSync(out, text);
}
