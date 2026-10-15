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
import { R } from "./runtime/index";
import { classCellReport } from "./magic-syntax";

const builtinNames = new Set(Object.keys(R.builtins));

// compile(..., "single"): expression statements outside functions and
// classes display their value, as at the interactive prompt.
function displayExprs(body: any[]): void {
  for (const st of body) {
    if (st.k === "Expr") st.value = { k: "Call", line: st.line, func: { k: "Name", line: st.line, id: "__pyjs_displayhook__" }, args: [st.value], keywords: [] };
    for (const key of ["body", "orelse", "finalbody"]) if (Array.isArray(st[key]) && st.k !== "FunctionDef" && st.k !== "ClassDef") displayExprs(st[key]);
    if (st.k === "Try") for (const h of st.handlers) displayExprs(h.body);
  }
}

// A notebook cell (mode "cell"): like Jupyter, only a final expression
// statement displays its value.
function displayLast(body: any[]): void {
  const st = body[body.length - 1];
  if (st !== undefined && st.k === "Expr") displayExprs([st]);
}

export interface CompileOptions {
  /** Sage syntax: `^` is `**`, `^^` is xor, int/int is an exact Rational. */
  sage?: boolean;
  /** changes the parsed tree (CPython's AST) before compiling it */
  transform?: (tree: any) => void;
}

export function compile(source: string, filename: string, moduleName: string, evalMode = false, single: boolean | "cell" = false, opts: CompileOptions = {}): Compiled {
  const mod = parse(source, filename, evalMode ? "eval" : "exec", opts);
  if (single === "cell") displayLast(mod.body);
  else if (single) displayExprs(mod.body);
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
// __PYJS_LIB__).  (The worker checks the whole table's SHA-256 before
// installing it: design/security.md, SEC-8D6-1, PRE-8D6-2.)
interface Precompiled { build: string; modules: Record<string, Compiled & { path: string }> }
const precompiledKey = (name: string, sage: boolean) => (sage ? "sage|" : "py|") + name;
// (a file in the library: its path in it, or null)
function libPath(filename: string): string | null {
  const dir = libDir();
  return filename.startsWith(dir + "/") ? filename.slice(dir.length + 1) : null;
}
function precompiled(source: string, filename: string, name: string, sage: boolean): Compiled | null {
  const g = globalThis as any;
  const p: Precompiled | undefined = g.__SAGEBRUSH_PRECOMPILED__;
  if (p === undefined || p === null || typeof p !== "object" || p.build !== g.__SAGEBRUSH_BUILD_ID__ || typeof p.modules !== "object" || p.modules === null) return null;
  const rel = libPath(filename), lib = g.__PYJS_LIB__;
  if (rel === null || lib === undefined || !Object.hasOwn(lib, rel) || lib[rel] !== source) return null;
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
  if (recording !== null && libPath(filename) !== null) {
    const compiled = compile(source, filename, name, false, false, { sage });
    recording[precompiledKey(name, sage)] = { ...compiled, path: libPath(filename)! };
    return { compiled, script: new Script(compiled.code, { filename: jsName }) };
  }
  const dir = filename.startsWith(libDir()) ? compileCacheDir() : null;
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

// Execute `source` as module `name`, registering it in sys.modules first.
export function execModule(source: string, filename: string, name: string, isPackage = false, sage = filename.endsWith(".sage")): any {
  const m = R.newModule(name);
  m.__file__ = filename;
  m.__package__ = isPackage ? name : name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
  if (isPackage) m.__path__ = [dirname(filename)];
  m.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, name, m);
  const jsName = scriptName(resolvePath(filename));
  let compiled: Compiled;
  let script: Script;
  try {
    ({ compiled, script } = compileCached(source, filename, name, sage, jsName));
  } catch (e) {
    if (e instanceof PySyntaxError) throw syntaxError(e);
    throw e;
  }
  R.scripts.set(jsName, { filename, lines: source.split("\n"), lineMap: compiled.lineMap });
  const fn = script.runInThisContext();
  try {
    if (sage) R.loader.exec("from sage_all import *\n", m, "exec", "<sage>");
    fn(m, R);
  } catch (e) {
    R.sysModules.$m.delete(name);
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
  let depth = 0, end = -1;
  for (let i = 0; i < toks.length && end < 0; i++) {
    const t = toks[i].t;
    if (t === TK.INDENT) depth++;
    else if (t === TK.DEDENT) {
      // (back at the top level, unless a clause of the same statement follows)
      if (--depth === 0 && !CLAUSES.has(toks.slice(i + 1).find((x) => x.t !== TK.DEDENT && x.t !== TK.NL)?.text)) end = i;
    } else if (t === TK.NEWLINE && depth === 0 && toks[i + 1]?.t !== TK.INDENT) end = i;
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
  R.scripts.set(jsName, { filename, lines: src.split("\n"), lineMap: compiled.lineMap });
  return runInThisContext(compiled.code, { filename: jsName })(ns, R);
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
const fileExists = (p: string) => (embedded !== undefined && p.startsWith(LIB_VIRTUAL + "/") ? embedded[p.slice(LIB_VIRTUAL.length + 1)] !== undefined : safeExists(p));
const fileRead = (p: string) => (embedded !== undefined && p.startsWith(LIB_VIRTUAL + "/") ? embedded[p.slice(LIB_VIRTUAL.length + 1)] : readFileSync(p, "utf8"));
export function libDir(): string {
  return embedded !== undefined ? LIB_VIRTUAL : resolvePath(__dirname, "../../lib");
}

// Import search: directories in sys.path, `name.py` or `name/__init__.py`.
R.loader.load = (name: string) => {
  const sys = R.importModule("sys");
  const parts = name.split(".");
  let dirs: string[];
  if (parts.length > 1) {
    const parent = R.sysModules.$m.get(parts.slice(0, -1).join("."));
    dirs = parent?.__path__ ? R.toArray(parent.__path__) : [];
  } else dirs = R.toArray(sys.path);
  const leaf = parts[parts.length - 1];
  for (const d of dirs) {
    const pkg = join(d, leaf, "__init__.py");
    if (fileExists(pkg)) return execModule(fileRead(pkg), pkg, name, true);
    const file = join(d, leaf + ".py");
    if (fileExists(file)) return execModule(fileRead(file), file, name);
  }
  return null;
};

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
  return null;
}

export { initParser, R };
