#!/usr/bin/env node
// Optional packages (optional/<name>/; plan-modular-packages-r4): check them,
// lint them against the Core API contract, and build package sets.  None of
// this is part of the core's build: optional/ is outside the build id, the
// worker's manifest and the CLI bundle, and its CI tier is optional.yml.
//
//   node scripts/optional-packages.mjs check [NAME...]
//       each package's sagebrush.json, its pins, and the contract lint (§5)
//   node scripts/optional-packages.mjs build --out DIR [--pre] [--costs FILE] [NAME...]
//       a package set in DIR: pkg/<sha256>.json chunks, pkgset/<S>.json (S is
//       the index's own SHA-256), pkgmeta/<S>/uses-<dir>.json; prints S.
//       --pre also compiles every module with the built CLI
//       (build/cli/pyjs.cjs) and adds the precompiled chunk for its build.
//       --costs adds measured grader costs ({id: {build: {src, pre?}}}, §4.5).
//
// Needs the TypeScript build (dist/): the lint parses with the core's own
// parser (src/parse.ts), and checks every reference against
// core-api-surface.json (scripts/core-api-surface.mjs).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const DOCS = /^(sagebrush\.json|README\.md|LICENSE[^/]*|NOTICE[^/]*|known\.json|contract-declarations\.json)$/;
const safePath = (p) => typeof p === "string" && p !== "" && !p.startsWith("/") && p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && /^[A-Za-z0-9_.-]+$/.test(s));
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 8785 (JCS) for the data sets hold: strings, integers, booleans, null, arrays, objects. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object") {
    // (UTF-16 code unit order, as JCS sorts keys)
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  if (typeof v === "number" && !Number.isInteger(v)) throw new Error("canonical: only integers in package sets");
  return JSON.stringify(v);
}

function walkFiles(dir, base = dir, out = []) {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f), st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${relative(root, p)} is a symbolic link (a package's files are its own)`);
    if (st.isDirectory()) {
      if (f !== "__pycache__") walkFiles(p, base, out);
    } else if (st.isFile()) out.push(relative(base, p));
    else throw new Error(`${relative(root, p)} is not a file or a directory`);
  }
  return out;
}

/** The optional packages under root/optional (or just `names`): their manifests and file texts; throws on the first problem. */
export function readOptional(rootDir = root, names = null) {
  const odir = join(rootDir, "optional");
  const out = [];
  // (each directory of optional/ is a package; its README and other files are not)
  const dirs = existsSync(odir) ? readdirSync(odir).filter((f) => lstatSync(join(odir, f)).isDirectory()).sort() : [];
  for (const dir of names && names.length ? names : dirs) {
    const at = join(odir, dir);
    const bad = (why) => {
      throw new Error(`optional/${dir}: ${why}`);
    };
    if (!existsSync(join(at, "sagebrush.json"))) bad("no sagebrush.json");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(dir)) bad("a package's directory is its name: lowercase letters, digits and -");
    let m;
    try {
      m = JSON.parse(readFileSync(join(at, "sagebrush.json"), "utf8"));
    } catch (e) {
      bad(`sagebrush.json is not JSON (${e.message})`);
    }
    if (m && Object.hasOwn(m, "js")) {
      out.push(readJsPackage(rootDir, dir, at, m, bad));
      continue;
    }
    const known = new Set(["name", "version", "kind", "sagebrush", "modes", "python", "requires", "private_prefix", "provides", "oracle", "files"]);
    for (const k of Object.keys(m)) if (!known.has(k)) bad(`unknown field ${k}`);
    if (m.name !== `@sagebrush/${dir}`) bad(`name must be @sagebrush/${dir}`);
    if (typeof m.version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(m.version)) bad("version must be MAJOR.MINOR.PATCH");
    if (m.kind !== "optional") bad('kind must be "optional"');
    if (typeof m.sagebrush !== "string" || !m.sagebrush) bad("sagebrush must be a version range");
    if (!Array.isArray(m.modes) || !m.modes.length || !m.modes.every((x) => ["python", "sage", "matlab", "magma"].includes(x))) bad("modes must be some of python, sage, matlab, magma");
    const py = m.python;
    if (!py || !safePath(py.root)) bad("python.root must be a directory inside the package");
    if (!Array.isArray(py.modules) || !py.modules.length || !py.modules.every((x) => typeof x === "string" && x.split(".").every((s) => IDENT.test(s)))) bad("python.modules must be module names");
    if (!Array.isArray(m.requires) || !m.requires.every((r) => typeof r === "string" && /^@sagebrush\/[a-z0-9][a-z0-9-]*@\d+\.\d+\.\d+$/.test(r))) bad("requires lists exact package ids");
    if (typeof m.private_prefix !== "string" || !/^_[a-z][a-z0-9]*_$/.test(m.private_prefix)) bad('private_prefix must look like "_name_"');
    if (m.provides !== undefined && (typeof m.provides !== "object" || Array.isArray(m.provides))) bad("provides must be {class: {method: [argument]}}");
    // (shipped files: everything under python.root, each pinned; tests and docs aren't shipped)
    const present = walkFiles(at).filter((f) => !DOCS.test(f) && f.startsWith(py.root + "/"));
    if (!m.files || typeof m.files !== "object") bad("files must map each shipped file to its SHA-256");
    for (const f of present) if (!Object.hasOwn(m.files, f)) bad(`${f} is not in files (every shipped file is pinned)`);
    const files = {};
    for (const [f, pin] of Object.entries(m.files)) {
      if (!safePath(f) || !f.startsWith(py.root + "/") || !f.endsWith(".py")) bad(`${f}: shipped files are .py files under python.root`);
      if (!present.includes(f)) bad(`${f} is in files but not in the package`);
      const bytes = readFileSync(join(at, f));
      if (sha256(bytes) !== pin) bad(`${f}: its SHA-256 is ${sha256(bytes)}, not ${pin} (update sagebrush.json)`);
      files[f] = bytes.toString("utf8");
    }
    for (const mod of py.modules) {
      const rel = py.root + "/" + mod.split(".").join("/");
      if (!files[rel + ".py"] && !files[rel + "/__init__.py"]) bad(`no file for module ${mod}`);
      if (existsSync(join(rootDir, "lib", mod.split(".").join("/") + ".py")) || existsSync(join(rootDir, "lib", ...mod.split("."), "__init__.py"))) bad(`module ${mod} is also in lib/`);
    }
    let declarations = [];
    if (existsSync(join(at, "contract-declarations.json"))) declarations = JSON.parse(readFileSync(join(at, "contract-declarations.json"), "utf8"));
    out.push({ dir, id: `${m.name}@${m.version}`, manifest: m, files, declarations });
  }
  return out;
}

// ---------------------------------------------------------------------------
// js packages (r4 addendum A1): one self-contained ES module, bundled from the
// package's pinned sources and vendored files, for a host that runs it in its
// own worker (the bash shell, plan-bash-shell r3 §1).  sagebrush.json:
//   name, version, kind "optional", sagebrush (a range),
//   js {entry: "<name>.js", source: the entry's path, aliases: {bare import:
//   a path in the package}, banner: the module's leading /*! comment,
//   notices: the file of license texts the chunk carries (A1.1a)},
//   files: every input file -> SHA-256 (all but sagebrush.json, README,
//   LICENSE*, NOTICE*, vendor.json files and the vendor's verify-from-npm.mjs,
//   which aren't bundled)
const JS_ENTRY = /^[a-z0-9][a-z0-9._-]{0,63}\.js$/;
const JS_UNBUNDLED = /(^|\/)(sagebrush\.json|README\.md|LICENSE[^/]*|NOTICE[^/]*|vendor\.json|verify-from-npm\.mjs)$/;
function readJsPackage(rootDir, dir, at, m, bad) {
  const known = new Set(["name", "version", "kind", "sagebrush", "js", "files"]);
  for (const k of Object.keys(m)) if (!known.has(k)) bad(`unknown field ${k} (a js package has no Python fields)`);
  if (m.name !== `@sagebrush/${dir}`) bad(`name must be @sagebrush/${dir}`);
  if (typeof m.version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(m.version)) bad("version must be MAJOR.MINOR.PATCH");
  if (m.kind !== "optional") bad('kind must be "optional"');
  if (typeof m.sagebrush !== "string" || !m.sagebrush) bad("sagebrush must be a version range");
  const js = m.js;
  if (!js || typeof js !== "object" || Array.isArray(js)) bad("js must be {entry, source, aliases}");
  for (const k of Object.keys(js)) if (!["entry", "source", "aliases", "banner", "notices"].includes(k)) bad(`js: unknown field ${k}`);
  if (typeof js.banner !== "string" || !/^\/\*![^\n]*\*\/$/.test(js.banner)) bad("js.banner must be one /*! … */ line");
  if (!safePath(js.notices)) bad("js.notices must be a file of the package");
  if (typeof js.entry !== "string" || !JS_ENTRY.test(js.entry)) bad("js.entry is a file name like shell.js");
  if (!safePath(js.source) || !js.source.endsWith(".js")) bad("js.source must be a .js file inside the package");
  const aliases = js.aliases ?? {};
  if (typeof aliases !== "object" || Array.isArray(aliases)) bad("js.aliases maps bare imports to files of the package");
  const present = walkFiles(at).filter((f) => !JS_UNBUNDLED.test(f));
  if (!m.files || typeof m.files !== "object") bad("files must map each input file to its SHA-256");
  for (const f of present) if (!Object.hasOwn(m.files, f)) bad(`${f} is not in files (every input file is pinned)`);
  for (const [f, pin] of Object.entries(m.files)) {
    if (!safePath(f) || !present.includes(f)) bad(`${f} is in files but not in the package`);
    const bytes = readFileSync(join(at, f));
    if (sha256(bytes) !== pin) bad(`${f}: its SHA-256 is ${sha256(bytes)}, not ${pin} (update sagebrush.json)`);
  }
  if (!Object.hasOwn(m.files, js.source)) bad(`js.source ${js.source} is not a pinned file`);
  if (!Object.hasOwn(m.files, js.notices)) bad(`js.notices ${js.notices} is not a pinned file`);
  for (const [spec, f] of Object.entries(aliases)) if (!safePath(f) || !Object.hasOwn(m.files, f)) bad(`js.aliases.${spec}: ${f} is not a pinned file`);
  return { dir, id: `${m.name}@${m.version}`, manifest: m, kind: "js", at };
}

/** The shell host's message table (web/shell/host-levels.json): name -> level. */
export function hostLevels(rootDir = root) {
  return JSON.parse(readFileSync(join(rootDir, "web", "shell", "host-levels.json"), "utf8")).names;
}
/** Its compatible widenings: "name.field.path" -> the level that added the field. */
export function hostFields(rootDir = root) {
  return JSON.parse(readFileSync(join(rootDir, "web", "shell", "host-levels.json"), "utf8")).fields ?? {};
}

/**
 * A js package's published module: bundled (scripts/js-bundle.mjs, under
 * bun), then checked on those exact bytes (A1.3, A1.4): self-contained by
 * AST, host_req from its literal hostCall names, at most PKGSET_LIMITS'
 * jsModuleBytes of text and, as a chunk, at most chunkBytes.  Throws before
 * anything is written.  Returns {text, chunk, host_req}.
 */
export async function buildJsModule(p, rootDir = root) {
  const C = await import("./js-module-check.mjs");
  const L = require(join(rootDir, "dist", "src", "pkgset.js")).PKGSET_LIMITS;
  const tmp = mkdtempSync(join(tmpdir(), "sb-optional-js-"));
  try {
    const outFile = join(tmp, p.manifest.js.entry);
    execFileSync(process.env.BUN ?? "bun", [join(rootDir, "scripts", "js-bundle.mjs"), p.at, outFile], { stdio: ["ignore", "ignore", "pipe"] });
    const text = readFileSync(outFile, "utf8");
    const found = C.importFindings(text);
    if (found.length) throw new Error(`${p.id}: its module is not self-contained:\n  ` + found.slice(0, 20).join("\n  "));
    // the notices (A1.1a, A1.3): the module begins with its banner; the
    // notices name every vendored package and everything each one inlines
    // (vendor/*/vendor.json, derived from its own lockfile), at their exact
    // versions; and what a vendored bundle's own license banner says agrees
    const banner = C.bannerFindings(text);
    if (banner.length) throw new Error(`${p.id}: ${banner.join("; ")}`);
    const notices = readFileSync(join(p.at, p.manifest.js.notices), "utf8");
    const entries = [], disagree = [];
    const vdir = join(p.at, "vendor");
    for (const d of existsSync(vdir) ? readdirSync(vdir).sort() : []) {
      if (!existsSync(join(vdir, d, "vendor.json"))) continue;
      const v = JSON.parse(readFileSync(join(vdir, d, "vendor.json"), "utf8"));
      entries.push({ name: v.package, version: v.version }, ...(v.inlined ?? []));
      for (const f of Object.keys(v.files)) if (/\.m?js$/.test(f)) disagree.push(...C.inlinedFindings(readFileSync(join(vdir, d, f), "utf8"), v.inlined ?? []).map((x) => `vendor/${d}/${f}: ${x}`));
    }
    if (disagree.length) throw new Error(`${p.id}: ${disagree.join("; ")}`);
    const missing = C.missingNotices(notices, entries);
    if (missing.length) throw new Error(`${p.id}: its notices (${p.manifest.js.notices}) have no entry for ${missing.join(", ")}`);
    const req = C.hostRequirement(text, hostLevels(rootDir), hostFields(rootDir));
    if (req.errors.length) throw new Error(`${p.id}: its host calls:\n  ` + req.errors.slice(0, 20).join("\n  "));
    if (req.host_req < 1) throw new Error(`${p.id}: its module makes no hostCall (a js package talks to its host only through hostCall)`);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > L.jsModuleBytes) throw new Error(`${p.id}: its module is ${bytes} bytes; at most ${L.jsModuleBytes} (r4 addendum A1.2)`);
    const noticeBytes = Buffer.byteLength(notices, "utf8");
    if (!noticeBytes || noticeBytes > L.jsNoticesBytes) throw new Error(`${p.id}: its notices are ${noticeBytes} bytes; 1 to ${L.jsNoticesBytes} (r4 addendum A1.2)`);
    const chunk = { format: "sagebrush-pkg-chunk", v: 1, kind: "js", package: p.id, entry: p.manifest.js.entry, modules: { [p.manifest.js.entry]: text }, notices };
    const size = Buffer.byteLength(canonical(chunk), "utf8");
    if (size > L.chunkBytes) throw new Error(`${p.id}: its chunk is ${size} bytes; at most ${L.chunkBytes} (r4 addendum A1.2)`);
    return { text, chunk, host_req: req.host_req, moduleBytes: bytes, chunkBytes: size, noticeBytes };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The contract lint (§5): a reviewed first-party package uses only the
// documented public core; reflection and dynamic import are banned outright
// unless a reviewed declaration names the exact line.  Not a sandbox (§5.1).

const BANNED_NAMES = new Set(["eval", "exec", "compile", "getattr", "setattr", "delattr", "hasattr", "vars", "globals", "locals", "dir", "__import__", "__builtins__", "breakpoint"]);
const BANNED_MODULES = new Set(["importlib", "builtins", "inspect", "ctypes", "gc"]);
const BANNED_ATTRS = new Set(["__dict__", "__getattribute__", "__setattr__", "__delattr__", "__globals__", "__code__", "__closure__", "__builtins__", "__subclasses__", "__mro__", "__bases__", "_getframe"]);

function nodes(tree, visit) {
  const seen = new Set();
  const go = (n, parent) => {
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      for (const x of n) go(x, parent);
      return;
    }
    if (typeof n.k === "string") visit(n, parent);
    for (const [key, v] of Object.entries(n)) if (key !== "k" && v && typeof v === "object") go(v, typeof n.k === "string" ? n : parent);
  };
  go(tree, null);
}

/**
 * Lint one package (from readOptional) against `api` (core-api-surface.json):
 * {findings: [{file, line, construct, target, message}], uses: [...], level}.
 */
export function lintPackage(pkg, api) {
  const { parse } = require(join(root, "dist", "src", "parse.js"));
  const findings = [], uses = [];
  const own = new Set(pkg.manifest.python.modules);
  const ownTop = new Set([...own].map((m) => m.split(".")[0]));
  const prefix = pkg.manifest.private_prefix;
  const coreModule = (name) => Object.hasOwn(api.modules, name);
  const declaration = (file, line, construct, target) => pkg.declarations.find((d) => d.file === file && d.line === line && d.construct === construct && (d.target === undefined || d.target === target));
  // (a declared dynamic access waives its finding and is a use of the core
  // name it reaches, "access" (else its target), in its stated call form,
  // "call": [parameter names], or else at that name's maximum parameter
  // level: §5.3, §6.2, astra's CORR-PR68-2)
  const flag = (file, line, construct, target, message) => {
    const d = declaration(file, line, construct, target);
    if (!d) findings.push({ file, line, construct, target, message });
    else uses.push({ file, line, target: d.access ?? d.target ?? target, bound: Array.isArray(d.call) ? { npos: 0, kw: d.call.map(String), unpack: false } : "any", declared: true });
  };
  // (the prefix must not begin any core module's or type's attribute, private
  // ones included: core-api-surface.json lists every "_name_" prefix the
  // core's attributes begin with; §5.2)
  if ((api.prefixes ?? []).includes(prefix)) flag("sagebrush.json", 0, "private_prefix", prefix, `the private prefix ${prefix} begins some core attribute's name: pick another`);
  for (const [file, text] of Object.entries(pkg.files)) {
    let tree;
    try {
      tree = parse(text, file, "exec");
    } catch (e) {
      findings.push({ file, line: e.lineno ?? 0, construct: "syntax", target: "", message: String(e.msg ?? e.message ?? e) });
      continue;
    }
    // names bound to core modules, or to names imported from them, in this file
    const coreAlias = new Map(); // local name -> "module" or "module.attr"
    nodes(tree, (n) => {
      if (n.k === "Import") {
        for (const a of n.names) {
          const parts = a.name.split(".");
          if (!ownTop.has(parts[0])) {
            if (parts.some((p) => p.startsWith("_"))) flag(file, n.line, "import", a.name, `imports the private module ${a.name}`);
            if (BANNED_MODULES.has(parts[0])) flag(file, n.line, "import", a.name, `imports ${a.name}, a reflection or dynamic-import module`);
            else if (!coreModule(a.name)) flag(file, n.line, "import", a.name, `${a.name} is not a public core module (core-api-surface.json)`);
            coreAlias.set(a.asname ?? parts[0], a.asname ? a.name : parts[0]);
          }
        }
      } else if (n.k === "ImportFrom") {
        const mod = n.module ?? "";
        if (n.level > 0 || ownTop.has(mod.split(".")[0])) return;
        if (mod.split(".").some((p) => p.startsWith("_"))) flag(file, n.line, "import", mod, `imports from the private module ${mod}`);
        if (BANNED_MODULES.has(mod.split(".")[0])) flag(file, n.line, "import", mod, `imports from ${mod}, a reflection or dynamic-import module`);
        else if (!coreModule(mod)) flag(file, n.line, "import", mod, `${mod} is not a public core module (core-api-surface.json)`);
        for (const a of n.names) {
          if (a.name === "*") flag(file, n.line, "import", mod + ".*", "from ... import * hides which core names are used");
          else if (a.name.startsWith("_")) flag(file, n.line, "import", `${mod}.${a.name}`, `imports the private name ${mod}.${a.name}`);
          else {
            coreAlias.set(a.asname ?? a.name, `${mod}.${a.name}`);
            uses.push({ file, line: n.line, target: `${mod}.${a.name}`, bound: null });
          }
        }
      }
    });
    // the resolved core target of an expression, or null
    const resolve = (e) => {
      if (e?.k === "Name") return coreAlias.get(e.id) ?? null;
      if (e?.k === "Attribute") {
        const b = resolve(e.value);
        return b === null ? null : b + "." + e.attr;
      }
      return null;
    };
    const rootName = (e) => (e?.k === "Attribute" ? rootName(e.value) : e?.k === "Name" ? e.id : null);
    // the names and attributes stored to, and those only read as the start of
    // a longer reference: neither lets a core callable escape
    const notEscaping = new Set();
    // the exact argument nodes of a reviewed dynamic access, such as the m of a
    // declared getattr(m, "f"): they reach what the declaration says and no more,
    // so they are not escapes. Only those nodes: any other reference on the same
    // line is judged on its own (astra's CORR-PR68-2 on 18a26195).
    const declaredArgs = new Set();
    const stored = (x) => {
      if (x?.k === "Tuple" || x?.k === "List") for (const y of x.elts ?? []) stored(y);
      else if (x?.k === "Starred") stored(x.value);
      else if (x) notEscaping.add(x);
    };
    nodes(tree, (n) => {
      if (n.k === "Attribute") notEscaping.add(n.value);
      if (n.k === "Call") notEscaping.add(n.func);
      for (const t of n.k === "Assign" || n.k === "Delete" ? n.targets ?? [] : n.k === "AugAssign" || n.k === "AnnAssign" || n.k === "For" || n.k === "AsyncFor" || n.k === "comprehension" ? [n.target] : []) stored(t);
      if (n.k === "withitem") stored(n.optional_vars);
      if (n.k === "Call" && n.func?.k === "Name" && BANNED_NAMES.has(n.func.id) && declaration(file, n.line, "name", n.func.id)) {
        for (const a of n.args ?? []) declaredArgs.add(a);
      }
    });
    nodes(tree, (n) => {
      if (n.k === "Name" && BANNED_NAMES.has(n.id)) flag(file, n.line, "name", n.id, `uses ${n.id}, which the contract bans (reflection, dynamic code or the builtins' namespace)`);
      if (n.k === "Attribute") {
        if (BANNED_ATTRS.has(n.attr)) flag(file, n.line, "attribute", n.attr, `uses .${n.attr}, which the contract bans`);
        else if (n.attr === "modules" && rootName(n.value) !== null && coreAlias.get(rootName(n.value)) === "sys") flag(file, n.line, "attribute", "sys.modules", "uses sys.modules");
        else if (n.attr.startsWith("_") && !(n.attr.startsWith("__") && n.attr.endsWith("__")) && !n.attr.startsWith(prefix)) {
          const base = n.value?.k === "Name" ? n.value.id : null;
          if (base !== "self" && base !== "cls") flag(file, n.line, "attribute", n.attr, `.${n.attr} on something other than self or cls: package-private names start with ${prefix}`);
        }
        const t = resolve(n);
        if (t !== null && n.attr.startsWith("_") && !(n.attr.startsWith("__") && n.attr.endsWith("__"))) flag(file, n.line, "attribute", t, `uses the private core name ${t}`);
      }
      // monkeypatching: assigning or deleting an attribute of a core module or core name
      const targets = n.k === "Assign" ? n.targets : n.k === "AugAssign" || n.k === "AnnAssign" ? [n.target] : n.k === "Delete" ? n.targets : [];
      for (const t of targets ?? []) {
        const walk = (x) => {
          if (x?.k === "Tuple" || x?.k === "List") for (const y of x.elts ?? []) walk(y);
          else if (x?.k === "Attribute" && resolve(x.value) !== null) flag(file, n.line, "monkeypatch", resolve(x), `changes the core's ${resolve(x)}`);
        };
        walk(t);
      }
      if (n.k === "Call") {
        const t = resolve(n.func);
        const unpack = (n.args ?? []).some((a) => a.k === "Starred") || (n.keywords ?? []).some((k) => k.arg === null);
        const bound = { npos: (n.args ?? []).filter((a) => a.k !== "Starred").length, kw: (n.keywords ?? []).filter((k) => k.arg !== null).map((k) => k.arg), unpack };
        if (t !== null) uses.push({ file, line: n.line, target: t, bound });
        // (a method call on a receiver the lint can't type: every core member of that name counts, §6.2)
        else if (n.func?.k === "Attribute" && !n.func.attr.startsWith("_")) uses.push({ file, line: n.line, target: "*." + n.func.attr, bound });
      }
      // a core callable that escapes (g = f, passed, returned, stored) may be
      // called with any of its parameters: it takes their maximum level (§6.2)
      if ((n.k === "Name" || n.k === "Attribute") && !notEscaping.has(n) && !declaredArgs.has(n)) {
        const t = resolve(n);
        if (t !== null) uses.push({ file, line: n.line, target: t, bound: "any" });
      } else if (n.k === "Attribute") {
        const t = resolve(n);
        if (t !== null) uses.push({ file, line: n.line, target: t, bound: null });
      }
    });
  }
  // core_req: the highest level any use needs (§6.2)
  let level = 1;
  for (const u of uses) {
    const l = useLevel(api, u);
    if (l === null) {
      if (!u.target.startsWith("*.") && !u.declared) findings.push({ file: u.file, line: u.line, construct: "reference", target: u.target, message: `${u.target} is not in the Core API (core-api-surface.json)` });
    } else level = Math.max(level, l);
  }
  return { findings, uses, level };
}

// the entry for a dotted core name: module.name[.member]
function entryFor(api, target) {
  const parts = target.split(".");
  for (let k = parts.length; k >= 1; k--) {
    const mod = parts.slice(0, k).join(".");
    if (!Object.hasOwn(api.modules, mod)) continue;
    const rest = parts.slice(k);
    if (rest.length === 0) return { since: api.modules[mod].since ?? 1 };
    const e = api.modules[mod].names?.[rest[0]];
    if (!e) return null;
    if (rest.length === 1) return e;
    const m = e.members?.[rest[1]];
    return rest.length === 2 && m ? m : null;
  }
  return null;
}
// the highest level anything reachable from an entry can need: its since, its
// parameters', and its members' (a class's methods), recursively
// (a parameter's highest level: its since, or the level that gave it a
// default, which a call leaving it out needs: core-api-surface.mjs's default_since)
const paramLevel = (p) => Math.max(p.since ?? 1, p.default_since ?? 1);
function deepLevel(e) {
  let l = e.since ?? 1;
  for (const p of Array.isArray(e.params) ? e.params : []) l = Math.max(l, paramLevel(p));
  for (const m of Object.values(e.members ?? {})) l = Math.max(l, deepLevel(m));
  return l;
}
// the level a use needs: the entry's since and its bound parameters' (§6.2);
// bound null is a bare reference (an import, or the start of a longer one),
// bound "any" one that may be called with every parameter. An escaping core
// name (an alias, passed or stored) can be used later in ways the lint can't
// follow, so it takes the highest level of everything reachable from it: a
// class's members too, and a module's every name and submodule (astra's
// CORR-PR68-2 on c6580f48: `n = m; n.f(1, extra=True)`).
export function useLevel(api, use) {
  if (use.bound === "any" && !use.target.startsWith("*.")) {
    const mods = Object.keys(api.modules).filter((k) => k === use.target || k.startsWith(use.target + "."));
    if (Object.hasOwn(api.modules, use.target)) {
      let level = 1;
      for (const k of mods) {
        level = Math.max(level, api.modules[k].since ?? 1);
        for (const e of Object.values(api.modules[k].names ?? {})) level = Math.max(level, deepLevel(e));
      }
      return level;
    }
    const e = entryFor(api, use.target);
    return e ? Math.max(1, deepLevel(e)) : null;
  }
  // (a method call on a receiver the lint can't type: every core member of
  // that name, and every module function of that name, since the receiver
  // may be a module reached some way the lint didn't see)
  const attr = use.target.slice(2);
  const entries = use.target.startsWith("*.")
    ? Object.values(api.modules).flatMap((m) => [
        ...(m.names && Object.hasOwn(m.names, attr) ? [m.names[attr]] : []),
        ...Object.values(m.names ?? {}).flatMap((e) => (e.members && Object.hasOwn(e.members, attr) ? [e.members[attr]] : [])),
      ])
    : [entryFor(api, use.target)].filter(Boolean);
  if (!entries.length) return null;
  let level = 1;
  for (const e of entries) {
    let l = e.since ?? 1;
    const params = e.params;
    if (use.bound && Array.isArray(params)) {
      if (use.bound === "any" || use.bound.unpack || use.target.startsWith("*.")) for (const p of params) l = Math.max(l, paramLevel(p));
      else {
        const positional = params.filter((p) => p.kind === "posonly" || p.kind === "pos");
        const bound = new Set();
        for (let i = 0; i < use.bound.npos; i++) {
          const p = positional[i] ?? params.find((q) => q.kind === "varargs");
          if (p) l = Math.max(l, p.since ?? 1), bound.add(p);
        }
        for (const kw of use.bound.kw) {
          const p = params.find((q) => q.name === kw && q.kind !== "posonly" && q.kind !== "varargs" && q.kind !== "varkw") ?? params.find((q) => q.kind === "varkw");
          if (p) l = Math.max(l, p.since ?? 1), bound.add(p);
        }
        // (a parameter the call leaves out relies on its default)
        for (const p of params) if (!bound.has(p) && p.default_since !== undefined) l = Math.max(l, p.default_since);
      }
    }
    level = Math.max(level, l);
  }
  return level;
}

// ---------------------------------------------------------------------------
// Building a set (§3.1)

function put(outDir, obj) {
  const bytes = Buffer.from(canonical(obj));
  const h = sha256(bytes);
  mkdirSync(join(outDir, "pkg"), { recursive: true });
  writeFileSync(join(outDir, "pkg", h + ".json"), bytes);
  return { sha256: h, size: bytes.length };
}

/** Build the set for `pkgs` into outDir; its id S.  A set with js packages is format v2 (A1.1), and is admitted by the core's own validator before its id is returned. */
export async function buildSet(pkgs, api, outDir, { pre = null, costs = null } = {}) {
  const ix = { format: "sagebrush-pkgset", v: pkgs.some((p) => p.kind === "js") ? 2 : 1, core_api: api.api, packages: {} };
  const meta = {};
  const jsChunks = new Map();
  for (const p of pkgs) {
    if (p.kind === "js") {
      const m = await buildJsModule(p);
      const ref = put(outDir, m.chunk);
      jsChunks.set(p.id, ref);
      ix.packages[p.id] = { dir: p.dir, js: { ...ref, host_req: m.host_req } };
      continue;
    }
    const lint = lintPackage(p, api);
    if (lint.findings.length) throw new Error(`${p.id}: the contract lint failed:\n` + lint.findings.map((f) => `  ${f.file}:${f.line} ${f.message}`).join("\n"));
    const files = {};
    for (const [f, text] of Object.entries(p.files)) files[f] = sha256(Buffer.from(text, "utf8"));
    const entry = {
      dir: p.dir, root: p.manifest.python.root, files, modules: p.manifest.python.modules, requires: p.manifest.requires,
      core_req: { api: api.api, level: lint.level },
      src: put(outDir, { format: "sagebrush-pkg-chunk", v: 1, kind: "src", package: p.id, files: p.files }),
      pre: {}, cost: {},
    };
    if (p.manifest.provides) entry.provides = p.manifest.provides;
    for (const [build, modules] of Object.entries(pre?.[p.id] ?? {})) entry.pre[build] = put(outDir, { format: "sagebrush-pkg-chunk", v: 1, kind: "pre", package: p.id, build, modules });
    if (costs?.[p.id]) entry.cost = costs[p.id];
    ix.packages[p.id] = entry;
    meta[p.dir] = lint.uses;
  }
  const bytes = Buffer.from(canonical(ix));
  const S = sha256(bytes);
  if (jsChunks.size) {
    // (refused before it is published: the set as every host will admit it,
    // and each js chunk as the loader will check it, A1.2)
    const P = require(join(root, "dist", "src", "pkgset.js"));
    const plan = P.admitIndex(S, new Uint8Array(bytes), "0".repeat(16), { isCoreModule: () => false, bundledDirs: new Set() });
    for (const [id, ref] of jsChunks) P.checkJsChunk(plan, id, new Uint8Array(readFileSync(join(outDir, "pkg", ref.sha256 + ".json"))));
  }
  mkdirSync(join(outDir, "pkgset"), { recursive: true });
  writeFileSync(join(outDir, "pkgset", S + ".json"), bytes);
  mkdirSync(join(outDir, "pkgmeta", S), { recursive: true });
  for (const [dir, uses] of Object.entries(meta)) writeFileSync(join(outDir, "pkgmeta", S, `uses-${dir}.json`), JSON.stringify(uses, null, 1) + "\n");
  return S;
}

// Compile every module of a built set with the CLI, and keep what it compiled
// for each package ({id: {build: {key: {code, lineMap, path}}}})
function recordPre(outDir, S, pkgs) {
  const cli = join(root, "build", "cli", "pyjs.cjs");
  if (!existsSync(cli)) throw new Error("--pre needs the built CLI (node scripts/build-cli.mjs)");
  const tmp = mkdtempSync(join(tmpdir(), "sb-optional-pre-"));
  try {
    const rec = join(tmp, "rec.json");
    const imports = pkgs.flatMap((p) => p.manifest.python.modules).map((m) => `import ${m}`).join("\n");
    execFileSync("node", [cli, "--pkgset", join(outDir, "pkgset", S + ".json"), "-c", imports], { env: { ...process.env, SAGEBRUSH_PRECOMPILE_OUT: rec, SAGEBRUSH_NO_COMPILE_CACHE: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    const r = JSON.parse(readFileSync(rec, "utf8"));
    const out = {};
    for (const [key, m] of Object.entries(r.modules)) {
      const o = /^opt:(@sagebrush\/[^:]+):(.+)$/.exec(m.path);
      if (!o) continue;
      ((out[o[1]] ??= {})[r.build] ??= {})[key] = { code: m.code, lineMap: m.lineMap, path: o[2] };
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function loadApi(rootDir = root) {
  return JSON.parse(readFileSync(join(rootDir, "core-api-surface.json"), "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name) => {
    const i = rest.indexOf(name);
    if (i < 0) return null;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v;
  };
  const flag = (name) => {
    const i = rest.indexOf(name);
    if (i < 0) return false;
    rest.splice(i, 1);
    return true;
  };
  try {
    if (cmd === "check") {
      const api = loadApi();
      let bad = 0;
      for (const p of readOptional(root, rest)) {
        if (p.kind === "js") {
          // (bundled and checked as build does, nothing written)
          const m = await buildJsModule(p);
          console.log(`${p.id}: ok; js module ${m.moduleBytes} bytes, notices ${m.noticeBytes} bytes, chunk ${m.chunkBytes} bytes, host_req ${m.host_req}`);
          continue;
        }
        const { findings, level } = lintPackage(p, api);
        for (const f of findings) console.error(`optional/${p.dir}/${f.file}:${f.line}: ${f.message}`);
        bad += findings.length;
        console.log(`${p.id}: ${findings.length ? findings.length + " contract finding(s)" : "ok"}; needs core API ${api.api} level ${level}`);
      }
      process.exit(bad ? 1 : 0);
    } else if (cmd === "build") {
      const out = opt("--out");
      const costsFile = opt("--costs");
      const withPre = flag("--pre");
      if (!out) throw new Error("build needs --out DIR");
      const api = loadApi();
      const pkgs = readOptional(root, rest);
      const costs = costsFile ? JSON.parse(readFileSync(costsFile, "utf8")) : null;
      let S = await buildSet(pkgs, api, out, { costs });
      if (withPre) S = await buildSet(pkgs, api, out, { costs, pre: recordPre(out, S, pkgs.filter((p) => p.kind !== "js")) });
      console.log(S);
    } else if (cmd === "test") {
      // each package's tests/test_*.py, run by the built CLI with the set,
      // compared with its .out (the recorded output) or, for a package with
      // an oracle, with that program's output under CPython (PYTHON_ORACLE,
      // a python with the oracle installed); known.json lists accepted differences
      const set = opt("--pkgset");
      if (!set) throw new Error("test needs --pkgset DIR/pkgset/<S>.json");
      const cli = join(root, "build", "cli", "pyjs.cjs");
      let bad = 0;
      for (const p of readOptional(root, rest)) {
        // (a js package's tests run in a browser: web/shell/test-shell.mjs)
        if (p.kind === "js") continue;
        const tdir = join(root, "optional", p.dir, "tests");
        if (!existsSync(tdir)) continue;
        const known = existsSync(join(root, "optional", p.dir, "known.json")) ? JSON.parse(readFileSync(join(root, "optional", p.dir, "known.json"), "utf8")).tests ?? [] : [];
        for (const t of readdirSync(tdir).filter((f) => /^test_.*\.py$/.test(f)).sort()) {
          const run = (cmdv) => {
            try {
              return execFileSync(cmdv[0], cmdv.slice(1), { encoding: "utf8", cwd: tdir, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
            } catch (e) {
              return (e.stdout ?? "") + `\n[exit ${e.status}] ` + String(e.stderr ?? "").trim().split("\n").pop();
            }
          };
          const got = run(["node", cli, "--pkgset", set, t]);
          const outFile = join(tdir, t.replace(/\.py$/, ".out"));
          let want = null;
          if (existsSync(outFile)) want = readFileSync(outFile, "utf8");
          else if (p.manifest.oracle && process.env.PYTHON_ORACLE) want = run([process.env.PYTHON_ORACLE, t]);
          if (want === null) {
            console.error(`optional/${p.dir}/tests/${t}: no .out and no oracle to compare with`);
            bad++;
          } else if (got !== want && !known.some((k) => k.test === t.replace(/\.py$/, ""))) {
            console.error(`optional/${p.dir}/tests/${t}: differs\n--- expected\n${want}--- got\n${got}`);
            bad++;
          } else console.log(`optional/${p.dir}/tests/${t}: ok`);
        }
      }
      process.exit(bad ? 1 : 0);
    } else {
      console.error("usage: optional-packages.mjs check [NAME...] | build --out DIR [--pre] [--costs FILE] [NAME...] | test --pkgset FILE [NAME...]");
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
