// Compile and run Python modules.

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, rmSync } from "fs";
import { join, resolve as resolvePath, dirname } from "path";
import { runInThisContext, Script } from "vm";
import { createHash } from "crypto";
import { homedir } from "os";
import { initParser, parse, PySyntaxError } from "./parse";
import { TokState, decodeBytes } from "../pyparse/src/lexer";
import * as TK from "../pyparse/src/tokens.gen";
import { analyze, SyntaxErr } from "./scope";
import { Emitter, Compiled } from "./emit";
import { R, ENTRY_FILE, ENTRY_NAME, frameState } from "./runtime/index";
import { cwdPath, isBuiltinModule } from "./runtime/modules";
import { dictDelete } from "./runtime/object";
import { admitIndex, checkChunk, PkgsetError, type ChunkRef, type SetPlan, type SrcChunk, type PreChunk } from "./pkgset";
import { classCellReport, endsWithSemicolon } from "./magic-syntax";
import { sha256Hex } from "./runtime/sha256";

const builtinNames = new Set(Object.keys(R.builtins));

// compile(..., "single"): expression statements outside functions and
// classes display their value, as at the interactive prompt. Sage code
// calls its own hook, which sage_all sets (Sage's display: matrices side by
// side, dicts sorted), so that it changes no Python cell's display, in this
// session or another (the runtime's default passes the value on to
// __pyjs_displayhook__)
function displayExprs(body: any[], hook: string): void {
  for (const st of body) {
    if (st.k === "Expr") st.value = { k: "Call", line: st.line, func: { k: "Name", line: st.line, id: hook }, args: [st.value], keywords: [] };
    for (const key of ["body", "orelse", "finalbody"]) if (Array.isArray(st[key]) && st.k !== "FunctionDef" && st.k !== "ClassDef") displayExprs(st[key], hook);
    if (st.k === "Try") for (const h of st.handlers) displayExprs(h.body, hook);
  }
}

// A notebook cell (mode "cell"): like Jupyter, only a final expression
// statement displays its value, and not when the cell ends with ; (IPython's
// rule: its last token, past comments and blank lines, is ;)
function displayLast(body: any[], src: string, opts: CompileOptions, hook: string): void {
  const st = body[body.length - 1];
  if (st !== undefined && st.k === "Expr" && !endsWithSemicolon(src, !!opts.sage)) displayExprs([st], hook);
}


export interface CompileOptions {
  /** Sage syntax: `^` is `**`, `^^` is xor, int/int is an exact Rational. */
  sage?: boolean;
  /** changes the parsed tree (CPython's AST) before compiling it */
  transform?: (tree: any) => void;
}

export function compile(source: string, filename: string, moduleName: string, evalMode = false, single: boolean | "cell" = false, opts: CompileOptions = {}): Compiled {
  const mod = parse(source, filename, evalMode ? "eval" : "exec", opts);
  const hook = opts.sage ? "__pyjs_sage_displayhook__" : "__pyjs_displayhook__";
  if (single === "cell") displayLast(mod.body, source, opts, hook);
  else if (single) displayExprs(mod.body, hook);
  try {
    return new Emitter(analyze(mod), builtinNames, moduleName).module(mod.body, evalMode);
  } catch (e) {
    if (e instanceof SyntaxErr) throw new PySyntaxError(e.msg, filename, e.line, mod.lines[e.line - 1] ?? "");
    throw e;
  }
}

function syntaxError(e: PySyntaxError): any {
  const cls = (R.T as any)[e.type] ?? R.T.SyntaxError;
  // (CPython's args: (msg, (filename, lineno, offset, text, end_lineno, end_offset)))
  const none = (v: any) => (v === undefined ? null : v);
  return cls(e.msg, R.tuple([none(e.filename), none(e.lineno), none(e.offset), none(e.text), none(e.end_lineno), none(e.end_offset)]));
}

// A per-user cache of compiled library modules (and V8's code cache for
// them), for bundled builds: their build id names the compiler, so a new
// build never reads an older build's output.  --sage imports most of the
// library, and compiling its 2.9 MB of Python took about 1.5 s at every start.
// Best effort: an unwritable or sandboxed home just compiles as before.  Node
// only: the browser worker bundles the same build id but has no disk.
const BUILD_ID: string | undefined = process.versions?.node ? (globalThis as any).__SAGEBRUSH_BUILD_ID__ : undefined;
let cacheRoot: string | null | undefined;
function compileCacheDir(): string | null {
  if (cacheRoot !== undefined) return cacheRoot;
  cacheRoot = null;
  if (!BUILD_ID || process.env.SAGEBRUSH_NO_COMPILE_CACHE) return null;
  try {
    const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
    const parent = join(base, "sagebrush");
    const dir = join(parent, "pyjs-" + BUILD_ID);
    if (!existsSync(dir)) {
      // one level at a time: Node's recursive mkdir never returns under
      // some paths (/proc), and a cache must not hang the program
      for (const d of [base, parent, dir]) {
        if (!existsSync(d)) mkdirSync(d);
      }
      // older builds' caches (about 15 MB each) are not read again
      for (const f of readdirSync(parent)) {
        if (f.startsWith("pyjs-") && f !== "pyjs-" + BUILD_ID) {
          try {
            rmSync(join(parent, f), { recursive: true, force: true });
          } catch {}
        }
      }
    }
    cacheRoot = dir;
  } catch {
    cacheRoot = null;
  }
  return cacheRoot;
}

function writeAtomic(path: string, data: string | Uint8Array): void {
  try {
    const tmp = path + "." + process.pid + ".tmp";
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch {}
}

// Library modules compiled when the site was built (the browser's worker
// fetches them: web/worker.ts, made by web/build.ts with
// SAGEBRUSH_PRECOMPILE_OUT): Sage mode's start compiled 2 MB of Python, more
// than a second, at every page load.  An entry is used only for the library
// file it was made from: by the build that made it (whose id covers the
// compiler and the library), for its mode and module, at its exact path in
// the library, whose source is the library's own (the embedded copy,
// __PYJS_LIB__).  (The worker checks each chunk's SHA-256 before installing
// it: web/lib-lazy.ts; design/security.md, SEC-8D6-1, PRE-8D6-2.)
interface Precompiled { build: string; modules: Record<string, Compiled & { path: string }> }
const precompiledKey = (name: string, sage: boolean) => (sage ? "sage|" : "py|") + name;
// (a file in the library: its path in it, or null)
function libPath(filename: string): string | null {
  const dir = libDir();
  return filename.startsWith(dir + "/") ? filename.slice(dir.length + 1) : null;
}
// (a module's path for precompiled code: a library file's path in lib/, or
// a mounted package file's "pkg:<dir>/<path>" (its checked bytes); else null)
function precompiledPath(filename: string): string | null {
  const key = pkgKeys.get(filename);
  if (key !== undefined) return "pkg:" + key;
  // (an optional package's file: "opt:<package id>:<path in the package>",
  // for scripts/optional-packages.mjs pre, which records them apart)
  const o = optKeys.get(filename);
  return o !== undefined ? "opt:" + o.id + ":" + o.path : libPath(filename);
}
function precompiled(source: string, filename: string, name: string, sage: boolean): Compiled | null {
  // (an optional package's file: only its own set's precompiled code, from
  // its own store, never the core's table, src/pkgset.ts; plan §4.1)
  if (optKeys.has(filename)) {
    if (mounted.get(filename) !== source) return null;
    const e = optPre.get(filename + (sage ? "\0sage" : "\0py"));
    return e === undefined || e.module !== name ? null : { code: e.code, lineMap: e.lineMap as any };
  }
  const g = globalThis as any;
  const p: Precompiled | undefined = g.__SAGEBRUSH_PRECOMPILED__;
  if (p === undefined || p === null || typeof p !== "object" || p.build !== g.__SAGEBRUSH_BUILD_ID__ || typeof p.modules !== "object" || p.modules === null) return null;
  // (a library file's own source, or a package file's checked bytes)
  const rel = precompiledPath(filename), lib = g.__PYJS_LIB__;
  if (rel === null) return null;
  if (rel.startsWith("pkg:")) {
    if (mounted.get(filename) !== source) return null;
  } else if (lib === undefined || !Object.hasOwn(lib, rel) || lib[rel] !== source) return null;
  const key = precompiledKey(name, sage);
  const m = Object.hasOwn(p.modules, key) ? p.modules[key] : undefined;
  if (m === undefined || m === null || typeof m !== "object" || m.path !== rel || typeof m.code !== "string" || !Array.isArray(m.lineMap)) return null;
  return { code: m.code, lineMap: m.lineMap };
}
// (making them: every library module compiled in this process, written at exit)
const recording: Record<string, Compiled & { path: string }> | null = process.versions?.node && process.env.SAGEBRUSH_PRECOMPILE_OUT ? {} : null;
if (recording !== null) {
  process.on("exit", () => {
    const out = process.env.SAGEBRUSH_PRECOMPILE_OUT!;
    let prev: Precompiled | null = null;
    try { prev = JSON.parse(readFileSync(out, "utf8")); } catch {}
    const build = (globalThis as any).__SAGEBRUSH_BUILD_ID__;
    const modules = prev !== null && prev.build === build ? { ...prev.modules, ...recording } : recording;
    writeFileSync(out, JSON.stringify({ build, modules }));
  });
}

// The compiled module, from the cache when there.
function compileCached(source: string, filename: string, name: string, sage: boolean, jsName: string): { compiled: Compiled; script: Script } {
  const pre = precompiled(source, filename, name, sage);
  if (pre !== null) return { compiled: pre, script: new Script(pre.code, { filename: jsName }) };
  if (recording !== null && precompiledPath(filename) !== null) {
    const compiled = compile(source, filename, name, false, false, { sage });
    recording[precompiledKey(name, sage)] = { ...compiled, path: precompiledPath(filename)! };
    return { compiled, script: new Script(compiled.code, { filename: jsName }) };
  }
  // (a package's module too, by its checked bytes, which the key covers)
  const dir = filename.startsWith(libDir()) || mounted.has(filename) ? compileCacheDir() : null;
  if (dir !== null) {
    const key = createHash("sha256").update(name + "\0" + (sage ? "1" : "0") + "\0" + source).digest("hex").slice(0, 32);
    const jsonPath = join(dir, key + ".json");
    const v8Path = join(dir, key + ".v8");
    // an entry is used only when whole: its code's hash recorded beside it
    // (a file holding {} was accepted, and the module failed to load: the
    // review's CACHE2-F1)
    const sum = (code: string) => createHash("sha256").update(code).digest("hex");
    let compiled: Compiled | null = null;
    try {
      const c = JSON.parse(readFileSync(jsonPath, "utf8"));
      if (typeof c?.code === "string" && Array.isArray(c.lineMap) && c.sum === sum(c.code)) {
        compiled = { code: c.code, lineMap: c.lineMap };
      }
    } catch {}
    if (compiled === null) {
      compiled = compile(source, filename, name, false, false, { sage });
      writeAtomic(jsonPath, JSON.stringify({ ...compiled, sum: sum(compiled.code) }));
    }
    let cachedData: Buffer | undefined;
    try {
      cachedData = readFileSync(v8Path);
    } catch {}
    const script = new Script(compiled.code, { filename: jsName, cachedData });
    if (cachedData === undefined || (script as any).cachedDataRejected) {
      try {
        writeAtomic(v8Path, script.createCachedData());
      } catch {}
    }
    return { compiled, script };
  }
  const compiled = compile(source, filename, name, false, false, { sage });
  return { compiled, script: new Script(compiled.code, { filename: jsName }) };
}

// The name of a module's compiled script.  In the browser it becomes a
// `//# sourceURL=` comment after the code (web/shims/vm.ts), and Python
// controls the file name (through sys.path), so everything but plain path
// characters is percent-encoded: a line terminator in a file name must never
// end the comment and inject JavaScript (design/security.md).  Tracebacks
// show the real file name, from R.scripts.
export function scriptName(path: string): string {
  return "py:" + path.replace(/[^\w/.~:@+,=-]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

// The entry marker every Python execution runs inside: it counts the
// executions running, for sys._getframe's proof that a stack is complete
// (src/runtime/index.ts).  Built from text, in a script of its own, so that
// its name and script survive bundling and minification.
const pyEntry: (code: any, g: any, R: any, state: typeof frameState) => any = runInThisContext(
  `(function ${ENTRY_NAME}(code, g, R, state) { state.entryDepth++; try { return code(g, R); } finally { state.entryDepth--; } })`,
  { filename: ENTRY_FILE },
);

// Execute `source` as module `name`, registering it in sys.modules first.
let moduleRuns = 0;
export function execModule(source: string, filename: string, name: string, isPackage = false, sage = filename.endsWith(".sage")): any {
  const m = R.newModule(name);
  m.__file__ = filename;
  m.__package__ = isPackage ? name : name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
  if (isPackage) m.__path__ = [dirname(filename)];
  m.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, name, m);
  // (a file run again, by reload or imported under a second name, is a
  // script of its own: the first run's functions keep their own globals)
  let jsName = scriptName(resolvePath(filename));
  if (R.scripts.has(jsName)) jsName += `%run${++moduleRuns}`;
  let compiled: Compiled;
  let script: Script;
  try {
    ({ compiled, script } = compileCached(source, filename, name, sage, jsName));
  } catch (e) {
    if (e instanceof PySyntaxError) throw syntaxError(e);
    throw e;
  }
  R.scripts.set(jsName, { filename, lines: source.split("\n"), lineMap: compiled.lineMap, globals: new WeakRef(m) });
  const fn = script.runInThisContext();
  try {
    if (sage) R.loader.exec("from sage_all import *\nimport _sage_lazy as _sage_lazy_; _sage_lazy_.bind(globals()); del _sage_lazy_\n", m, "exec", "<sage>");
    pyEntry(fn, m, R, frameState);
  } catch (e) {
    dictDelete(R.sysModules, name);
    throw e;
  }
  return m;
}

// %autoreload's check of a module's classes (lib/_pyjs_magic.py): JSON of
// {name: may the class be updated} for its top-level classes, or null if the
// source does not parse
R.builtins.__pyjs_class_cells__ = (src: any) => JSON.stringify(classCellReport(String(src)));

// compile(src, filename, "single"), as CPython's: one interactive statement,
// that is one logical line (statements joined by ;) or one compound
// statement; else the SyntaxError where the first one ends (the REPL, the
// console and doctests, which run "single" too, take several)
const COMPOUND = new Set(["If", "While", "For", "FunctionDef", "ClassDef", "Try", "With", "Match"]);
const CLAUSES = new Set(["else", "elif", "except", "finally"]);
function checkSingle(src: string, filename: string, opts: CompileOptions): void {
  const body: any[] = parse(src, filename, "exec", opts).body;
  if (body.length < 2) return;
  // (the tokenizer's view: where the first statement's logical line, or its
  // block, ends, and the next token; continued lines, strings and comments
  // as CPython's tokenizer has them, CORR-606-1)
  const tok = new TokState(src.endsWith("\n") ? src : src + "\n", { sage: opts.sage });
  const toks: any[] = [];
  for (;;) {
    const raw: any = { type: 0, start: -1, end: -1, level: 0, lineno: 0, col_offset: -1, end_lineno: 0, end_col_offset: -1, metadata: null };
    const t = tok.get(raw);
    toks.push({ t, ...raw, text: raw.start >= 0 ? decodeBytes(tok.buf, raw.start, raw.end) : "" });
    if (t === TK.ENDMARKER || t < 0 || toks.length > src.length + 16) break;
  }
  // (the next token that begins something: past NL and DEDENT)
  const nextText = (i: number) => {
    for (let j = i + 1; j < toks.length; j++) if (toks[j].t !== TK.DEDENT && toks[j].t !== TK.NL) return toks[j].text;
    return undefined;
  };
  let depth = 0, end = -1, first = -1;
  for (let i = 0; i < toks.length && end < 0; i++) {
    const t = toks[i].t;
    // (the first token of the logical line)
    if (first < 0 && t !== TK.NL && t !== TK.INDENT && t !== TK.DEDENT) first = i;
    if (t === TK.INDENT) depth++;
    else if (t === TK.DEDENT) {
      // (back at the top level, unless a clause of the same statement follows)
      if (--depth === 0 && !CLAUSES.has(nextText(i))) end = i;
    } else if (t === TK.NEWLINE) {
      // (a logical line at the top level ends the statement unless a block,
      // or a clause of the same statement (an inline if's else), follows,
      // or it is a decorator, CORR-50F-2)
      if (depth === 0 && toks[i + 1]?.t !== TK.INDENT && toks[first]?.text !== "@" && !CLAUSES.has(nextText(i))) end = i;
      first = -1;
    }
  }
  if (end < 0) return;
  const second = toks.slice(end + 1).find((x) => x.t !== TK.NL && x.t !== TK.DEDENT && x.t !== TK.NEWLINE);
  if (second === undefined || second.t === TK.ENDMARKER || second.t < 0) return;
  const lines = src.split("\n");
  const withNewline = (n: number) => lines[n - 1] + (n < lines.length ? "\n" : "");
  if (COMPOUND.has(body[0].k)) {
    // (after a compound statement: "invalid syntax" at the next one's first token)
    throw new PySyntaxError("invalid syntax", filename, second.lineno, withNewline(second.lineno), second.col_offset + 1, second.lineno, second.end_col_offset + 1);
  }
  // (a simple statement: at the NEWLINE that ends its logical line, which
  // begins at a trailing comment)
  const nl = toks[end];
  throw new PySyntaxError("multiple statements found while compiling a single statement", filename, nl.lineno, withNewline(nl.lineno), nl.col_offset + 1, nl.lineno, nl.end_col_offset + 1);
}

// exec/eval/compile: compile `src` and run it with `ns` as its globals.
let execCounter = 0;
R.loader.exec = (src: string, ns: any, mode: string, filename: string, opts: CompileOptions = {}) => {
  const evalMode = mode === "eval" || mode === "check-eval";
  let compiled: Compiled;
  try {
    compiled = compile(src, filename, "__main__", evalMode, mode === "cell" ? "cell" : mode === "single", opts);
    if (mode === "check-single") checkSingle(src, filename, opts);
  } catch (e) {
    if (e instanceof PySyntaxError) throw syntaxError(e);
    throw e;
  }
  if (mode === "check" || mode === "check-eval" || mode === "check-single") return null;
  const jsName = `py:<exec-${++execCounter}>`; // no spaces: it may become a //# sourceURL
  R.scripts.set(jsName, { filename, lines: src.split("\n"), lineMap: compiled.lineMap, globals: new WeakRef(ns) });
  return pyEntry(runInThisContext(compiled.code, { filename: jsName }), ns, R, frameState);
};

// The pure-Python library (../lib) can be embedded in a single-file build:
// the bundler defines globalThis.__PYJS_LIB__ (relative path -> source),
// served under the virtual directory LIB_VIRTUAL.
export const LIB_VIRTUAL = "/$pyjs/lib";
const embedded: Record<string, string> | undefined = (globalThis as any).__PYJS_LIB__;
// A sandboxed runtime may refuse to look at a path: then it is not there.
const safeExists = (p: string) => {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
};
// (a file's presence is a property of its own: in the browser's worker,
// reading one fetches its part of the library, web/lib-lazy.ts)
const fileExists = (p: string) => {
  // (a mounted package's directory holds exactly its checked files)
  if (mountedBases.length && mountedBases.some((b) => p.startsWith(b + "/"))) return mounted.has(p);
  // (a relative path, from a relative sys.path entry, against os.chdir's
  // directory: a worker thread's is virtual, modules.ts)
  return embedded !== undefined && p.startsWith(LIB_VIRTUAL + "/") ? Object.hasOwn(embedded, p.slice(LIB_VIRTUAL.length + 1)) : safeExists(cwdPath(p));
};
const fileRead = (p: string) => {
  const checked = mounted.get(p);
  if (checked !== undefined) return checked;
  if (embedded === undefined || !p.startsWith(LIB_VIRTUAL + "/")) return readFileSync(cwdPath(p), "utf8");
  try {
    return embedded[p.slice(LIB_VIRTUAL.length + 1)];
  } catch (e: any) {
    // (the browser's worker: a part of the library it could not fetch,
    // web/lib-lazy.ts, whose message says which and why: an ImportError,
    // not an internal error)
    throw (R.T as any).ImportError(String(e?.message ?? e));
  }
};
export function libDir(): string {
  return embedded !== undefined ? LIB_VIRTUAL : resolvePath(__dirname, "../../lib");
}

// Import search: directories in sys.path, `name.py` or `name/__init__.py`.
R.loader.load = (name: string) => {
  const sys = R.importModule("sys");
  const parts = name.split(".");
  let dirs: string[];
  if (parts.length > 1) {
    const parentName = parts.slice(0, -1).join(".");
    const parent = R.sysModules.$m.get(parentName);
    // (a module without __path__ is not a package: no submodules, from
    // anywhere, and CPython's message; the review's astra HOLD on 40c6b962)
    if (parent !== undefined && parent !== null && parent.__path__ === undefined) {
      const e = R.T.ModuleNotFoundError(`No module named '${name}'; '${parentName}' is not a package`);
      e.name = name;
      throw e;
    }
    dirs = parent?.__path__ ? R.toArray(parent.__path__) : [];
  } else dirs = R.toArray(sys.path);
  const leaf = parts[parts.length - 1];
  for (const d of dirs) {
    const pkg = join(d, leaf, "__init__.py");
    if (fileExists(pkg)) return execModule(fileRead(pkg), pkg, name, true);
    const file = join(d, leaf + ".py");
    if (fileExists(file)) return execModule(fileRead(file), file, name);
  }
  // (not on sys.path: a package's, if the registry names one for it; then
  // this session's optional package set's)
  const found = packageModule(name, false) ?? optionalModule(name, false);
  return found === null ? null : execModule(found[0], found[1], name, found[1].endsWith("/__init__.py"));
};

// Packages (packages/<name>/sagebrush.json; scripts/packages.mjs): modules
// kept outside lib/, each file pinned by its SHA-256 in the build's registry
// (packages/registry.json, which the CLI bundle and the browser's worker
// carry: __SAGEBRUSH_PACKAGES__ {registry, files}).  An import that sys.path
// does not satisfy looks its full dotted name up in the registry; the
// package's files are read once, each checked against its pin, and imported
// from those same bytes.  sys.path is searched first, so a user's own file of
// the same name comes first, as it does over lib/: moving a module from lib/
// to a package changes no import's result.  The files come from the
// directory SAGEBRUSH_PACKAGES, else the bundle's own copies, else the
// repository's packages/.
export const PKG_VIRTUAL = "/$pyjs/packages";
type PackageEntry = { dir: string; root: string; manifest_sha256: string; files: Record<string, string> };
type Registry = { format: number; modules: Record<string, string>; packages: Record<string, PackageEntry> };
const embeddedPackages: { registry: Registry; files: Record<string, string> } | undefined = (globalThis as any).__SAGEBRUSH_PACKAGES__;
let registry: Registry | null | undefined;
function packageRegistry(): Registry | null {
  if (registry !== undefined) return registry;
  let r: Registry | null = null;
  if (embeddedPackages !== undefined) r = embeddedPackages.registry;
  else {
    try {
      r = JSON.parse(readFileSync(resolvePath(__dirname, "../../packages/registry.json"), "utf8"));
    } catch {}
  }
  return (registry = r);
}
function packagesDir(): string {
  const env = process.env.SAGEBRUSH_PACKAGES;
  if (env) return resolvePath(env);
  return embeddedPackages !== undefined ? PKG_VIRTUAL : resolvePath(__dirname, "../../packages");
}
// (checked files by path, and each mounted package's directory)
const mounted = new Map<string, string>();
const mountedBases: string[] = [];
const mountedRoots = new Map<string, string>();
// (the repository path of a mounted file, for the catalog's source links,
// and its package path "<dir>/<path>", for precompiled code)
const repoPaths = new Map<string, string>();
const pkgKeys = new Map<string, string>();
const packageName = (id: string) => id.slice(0, id.lastIndexOf("@"));
// A package's file: its bytes and text, or null if it isn't there
function readPackageFile(dir: string, pkg: PackageEntry, path: string): { bytes: Uint8Array; text: string } | null {
  if (dir === PKG_VIRTUAL) {
    const files = embeddedPackages!.files, key = pkg.dir + "/" + path;
    if (!Object.hasOwn(files, key)) return null;
    let text: string;
    try {
      text = files[key];
    } catch (e: any) {
      // (the browser's worker: a chunk it could not fetch, web/lib-lazy.ts)
      throw (R.T as any).ImportError(String(e?.message ?? e));
    }
    return { bytes: new TextEncoder().encode(text), text };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(dir, pkg.dir, path));
  } catch {
    return null;
  }
  return { bytes, text: bytes.toString("utf8") };
}
// Mount package `id` (once): every file read and checked before any of it
// runs.  Its Python root, as a directory.
function mountPackage(id: string, name: string): string {
  const done = mountedRoots.get(id);
  if (done !== undefined) return done;
  const pkg = packageRegistry()!.packages[id];
  if (!pkg) throw (R.T as any).ImportError(`the registry names ${id} for '${name}' but has no entry for it`);
  const dir = packagesDir(), base = join(dir, pkg.dir);
  const got = new Map<string, string>();
  for (const path of Object.keys(pkg.files).sort()) {
    const f = readPackageFile(dir, pkg, path);
    if (f === null) {
      const e = R.T.ModuleNotFoundError(`No module named '${name}' (it is in ${packageName(id)}, which is not installed here)`);
      e.name = name;
      throw e;
    }
    if (sha256Hex(f.bytes) !== pkg.files[path]) throw (R.T as any).ImportError(`${packageName(id)}: ${path} is not the file this build pinned`);
    if (path.endsWith(".py")) got.set(join(base, path), f.text);
  }
  for (const [p, text] of got) {
    mounted.set(p, text);
    repoPaths.set(p, "packages/" + pkg.dir + "/" + p.slice(base.length + 1));
    pkgKeys.set(p, pkg.dir + "/" + p.slice(base.length + 1));
  }
  mountedBases.push(base);
  const root = join(base, pkg.root);
  mountedRoots.set(id, root);
  return root;
}
// The [source, filename] of module `name` from a package (with `main`, a
// package's __main__ instead of its __init__), or null if no package has it
function packageModule(name: string, main: boolean): [string, string] | null {
  const reg = packageRegistry();
  if (reg === null || !Object.hasOwn(reg.modules, name)) return null;
  // (a submodule only of a package, as CPython has it: a parent that is a
  // module without __path__, a user's parent.py say, has no submodules, and
  // a package's never attaches to it; an empty __path__ is a package's)
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const parent = R.sysModules.$m.get(name.slice(0, dot));
    if (parent === undefined || parent === null || parent.__path__ === undefined) return null;
  }
  const id = reg.modules[name];
  const at = join(mountPackage(id, name), ...name.split("."));
  for (const p of [join(at, main ? "__main__.py" : "__init__.py"), at + ".py"]) {
    const text = mounted.get(p);
    if (text !== undefined) return [text, p];
  }
  throw (R.T as any).ImportError(`${packageName(id)} has no file for module '${name}'`);
}
/** The top-level module names the registry's packages provide. */
export function packageModuleNames(): string[] {
  const reg = packageRegistry();
  return reg === null ? [] : Object.keys(reg.modules).filter((m) => !m.includes("."));
}
// (the catalog's source links, lib/_catalog.py: JSON of a mounted file's
// path in the repository and its text, or null)
R.builtins.__pyjs_package_file__ = (p: any) => {
  const rel = repoPaths.get(String(p));
  return rel === undefined ? null : JSON.stringify([rel, mounted.get(String(p))]);
};
// (the registry as JSON, or null: the curated PyPI packages' search entries,
// lib/_python_docsearch.py)
R.builtins.__pyjs_package_registry__ = () => {
  const reg = packageRegistry();
  return reg === null ? null : JSON.stringify(reg);
};
/** Tests only: replace the registry (null: none). */
export function setPackageRegistry(r: Registry | null): void {
  registry = r;
}

// `python -m name`: the source of module `name` (a package runs its
// __main__), found as an import would, without importing it.
export function findModuleSource(name: string): [string, string] | null {
  const sys = R.importModule("sys");
  const parts = name.split(".");
  let dirs: string[] = R.toArray(sys.path);
  if (parts.length > 1) {
    const parent = R.importModule(parts.slice(0, -1).join("."));
    dirs = parent?.__path__ ? R.toArray(parent.__path__) : [];
  }
  const leaf = parts[parts.length - 1];
  for (const d of dirs) {
    const main = join(d, leaf, "__main__.py");
    if (fileExists(main)) return [fileRead(main), main];
    const file = join(d, leaf + ".py");
    if (fileExists(file)) return [fileRead(file), file];
  }
  return packageModule(name, true) ?? optionalModule(name, true);
}

// Optional packages (optional/<name>/; src/pkgset.ts; plan-modular-packages-r4):
// a runtime has at most one package set, the one its document pins.  The host
// admits the set's index (installPackageSet) and supplies a function that
// returns a chunk's bytes; a module is looked up only after sys.path, the
// library and the bundled registry.  A package's dependencies are mounted
// first; each chunk and file is checked (src/pkgset.ts checkChunk) before any
// of the package is mounted, at /$pyjs/optional/<set>/<dir>/, apart from
// every other mount.  Its precompiled code, if the set has it for this build,
// is kept in its own store and used only for its own files.
export const OPT_VIRTUAL = "/$pyjs/optional";
export type ChunkFetch = (ref: ChunkRef, what: string) => Uint8Array;
let optional: { plan: SetPlan; fetch: ChunkFetch } | null = null;
const optKeys = new Map<string, { id: string; path: string }>(); // mounted file -> its package and path in it
const optPre = new Map<string, { module: string; code: string; lineMap: unknown[] }>(); // file + "\0py"/"\0sage"
const optMounted = new Map<string, string>(); // package id -> its Python root
/** This core's build id, as optional sets' precompiled code and costs are keyed (an unbundled build has none: 0s, which no set uses). */
export function coreBuildId(): string {
  const b = (globalThis as any).__SAGEBRUSH_BUILD_ID__;
  return typeof b === "string" && /^[0-9a-f]{16}$/.test(b) ? b : "0".repeat(16);
}
// (the names a set may not take: the library's modules, builtin modules and
// the bundled packages', and their directories; plan §4.1 rule 4)
export function reservedNames() {
  const reg = packageRegistry();
  const lib = libDir();
  return {
    isCoreModule(name: string) {
      if (isBuiltinModule(name)) return true;
      if (reg !== null && Object.hasOwn(reg.modules, name)) return true;
      const rel = name.split(".").join("/");
      return fileExists(join(lib, rel + ".py")) || fileExists(join(lib, rel, "__init__.py"));
    },
    bundledDirs: new Set(reg === null ? [] : Object.values(reg.packages).map((p) => p.dir)),
  };
}
/**
 * Admit package set `S` from its index's bytes and use it for this runtime;
 * `fetch` returns a chunk's bytes (the host's: a cache, a fetch, the grader
 * child's modules).  Once per runtime: the same set again is a no-op, another
 * one is refused (plan §4.1, §4.4).  Throws a PkgsetError, having changed nothing.
 */
export function installPackageSet(S: string, index: Uint8Array, fetch: ChunkFetch): SetPlan {
  if (optional !== null) {
    if (optional.plan.S === S) return optional.plan;
    throw new PkgsetError(`this session uses package set ${optional.plan.S.slice(0, 12)}; reopen it to use ${S.slice(0, 12)}`);
  }
  const plan = admitIndex(S, index, coreBuildId(), reservedNames());
  optional = { plan, fetch };
  return plan;
}
/** The top-level module names this runtime's optional package set provides (none without one). */
export function optionalModuleNames(): string[] {
  return optional === null ? [] : [...optional.plan.modules.keys()].filter((m) => !m.includes("."));
}
/** This runtime's package set id, or null. */
export function packageSetId(): string | null {
  return optional === null ? null : optional.plan.S;
}
// Mount package `id` and its dependencies (each once): all of a package's
// chunks are fetched and checked before any of it is mounted.
function mountOptional(id: string, name: string): string {
  const done = optMounted.get(id);
  if (done !== undefined) return done;
  const { plan, fetch } = optional!;
  for (const dep of plan.closure.get(id)!) {
    if (optMounted.has(dep)) continue;
    const p = plan.packages.get(dep)!;
    const build = coreBuildId();
    let src: SrcChunk, pre: PreChunk | null = null;
    try {
      src = checkChunk(plan, dep, "src", build, fetch(p.src, `${dep} (source)`)) as SrcChunk;
      if (p.pre[build]) pre = checkChunk(plan, dep, "pre", build, fetch(p.pre[build], `${dep} (precompiled)`)) as PreChunk;
    } catch (e: any) {
      const err = (R.T as any).ImportError(`No module named '${name}' could be loaded: ${String(e?.message ?? e)}`);
      err.name = name;
      throw err;
    }
    const base = join(OPT_VIRTUAL, plan.S, p.dir);
    for (const [path, text] of src.files) {
      const f = join(base, path);
      mounted.set(f, text);
      optKeys.set(f, { id: dep, path });
    }
    if (pre !== null) for (const e of pre.entries) optPre.set(join(base, e.path) + (e.sage ? "\0sage" : "\0py"), { module: e.module, code: e.code, lineMap: e.lineMap });
    mountedBases.push(base);
    optMounted.set(dep, join(base, p.root));
  }
  return optMounted.get(id)!;
}
// The [source, filename] of module `name` from this runtime's optional set, or null
function optionalModule(name: string, main: boolean): [string, string] | null {
  if (optional === null || !optional.plan.modules.has(name)) return null;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    const parent = R.sysModules.$m.get(name.slice(0, dot));
    if (parent === undefined || parent === null || parent.__path__ === undefined) return null;
  }
  const id = optional.plan.modules.get(name)!;
  const at = join(mountOptional(id, name), ...name.split("."));
  for (const p of [join(at, main ? "__main__.py" : "__init__.py"), at + ".py"]) {
    const text = mounted.get(p);
    if (text !== undefined) return [text, p];
  }
  throw (R.T as any).ImportError(`${id} has no file for module '${name}'`);
}
/**
 * Mount the packages that provide `modules` (and their dependencies) now,
 * without importing them: the grader's Dynamic Worker child calls this at its
 * top level, so every chunk is checked and mounted in its startup, where
 * code may be generated (plan §4.5), whichever cell first imports them.
 * The ids mounted, dependencies first.
 */
export function premountPackages(modules: string[]): string[] {
  if (optional === null) return [];
  const ids: string[] = [];
  for (const name of modules) {
    const id = optional.plan.modules.get(name);
    if (id === undefined) continue;
    mountOptional(id, name);
    for (const d of optional.plan.closure.get(id)!) if (!ids.includes(d)) ids.push(d);
  }
  return ids;
}
/** A chunk reader over bytes the host already has (the grader's child: its {json}/{data} modules), by SHA-256. */
export function chunksFrom(entries: Iterable<[string, Uint8Array]>): ChunkFetch {
  const m = new Map(entries);
  return (ref) => {
    const b = m.get(ref.sha256);
    if (b === undefined) throw new PkgsetError(`chunk ${ref.sha256.slice(0, 12)} was not given to this runtime`);
    return b;
  };
}
/** Tests only: forget this runtime's package set (a real runtime never does: a new set means a new runtime). */
export function resetPackageSetForTests(): void {
  for (const [f] of optKeys) mounted.delete(f);
  for (let i = mountedBases.length - 1; i >= 0; i--) if (mountedBases[i].startsWith(OPT_VIRTUAL + "/")) mountedBases.splice(i, 1);
  optKeys.clear();
  optPre.clear();
  optMounted.clear();
  optional = null;
}

export { initParser, R };
