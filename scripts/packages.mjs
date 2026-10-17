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
const DOCS = /^(sagebrush\.json|README\.md|LICENSE[^/]*|NOTICE[^/]*)$/;
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
    const id = `${m.name}@${m.version}`;
    for (const mod of py.modules) {
      const rel = mod.split(".").join("/");
      if (!pins[`${py.root}/${rel}.py`] && !pins[`${py.root}/${rel}/__init__.py`]) bad(`it has no file for module ${mod}`);
      if (modules[mod]) bad(`module ${mod} is also ${modules[mod]}'s`);
      // (lib/ comes first on sys.path: a module in both would never be the package's)
      if (existsSync(join(lib, rel + ".py")) || existsSync(join(lib, rel, "__init__.py"))) bad(`module ${mod} is also in lib/, which would shadow it`);
      modules[mod] = id;
    }
    packages[id] = { dir, root: py.root, manifest_sha256: sha256(raw), files: pins };
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
