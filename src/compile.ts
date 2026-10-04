// Compile and run Python modules.

import { readFileSync, existsSync } from "fs";
import { join, resolve as resolvePath, dirname } from "path";
import { runInThisContext } from "vm";
import { initParser, parse, PySyntaxError } from "./parse";
import { analyze, SyntaxErr } from "./scope";
import { Emitter, Compiled } from "./emit";
import { R } from "./runtime/index";

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

export function compile(source: string, filename: string, moduleName: string, evalMode = false, single = false): Compiled {
  const mod = parse(source, filename, evalMode ? "eval" : "exec");
  if (single) displayExprs(mod.body);
  try {
    return new Emitter(analyze(mod), builtinNames, moduleName).module(mod.body, evalMode);
  } catch (e) {
    if (e instanceof SyntaxErr) throw new PySyntaxError(e.msg, filename, e.line, mod.lines[e.line - 1] ?? "");
    throw e;
  }
}

function syntaxError(e: PySyntaxError): any {
  const cls = (R.T as any)[e.type] ?? R.T.SyntaxError;
  const err = cls(e.msg);
  err.filename = e.filename;
  err.lineno = e.lineno;
  err.text = e.text;
  err.offset = e.offset;
  err.end_lineno = e.end_lineno;
  err.end_offset = e.end_offset;
  return err;
}

// Execute `source` as module `name`, registering it in sys.modules first.
export function execModule(source: string, filename: string, name: string, isPackage = false): any {
  const m = R.newModule(name);
  m.__file__ = filename;
  m.__package__ = isPackage ? name : name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
  if (isPackage) m.__path__ = [dirname(filename)];
  m.__builtins__ = R.builtins;
  R.dictSet(R.sysModules, name, m);
  let compiled: Compiled;
  try {
    compiled = compile(source, filename, name);
  } catch (e) {
    if (e instanceof PySyntaxError) throw syntaxError(e);
    throw e;
  }
  const jsName = "py:" + resolvePath(filename);
  R.scripts.set(jsName, { filename, lines: source.split("\n"), lineMap: compiled.lineMap });
  const fn = runInThisContext(compiled.code, { filename: jsName });
  try {
    fn(m, R);
  } catch (e) {
    R.sysModules.$m.delete(name);
    throw e;
  }
  return m;
}

// exec/eval/compile: compile `src` and run it with `ns` as its globals.
let execCounter = 0;
R.loader.exec = (src: string, ns: any, mode: string, filename: string) => {
  const evalMode = mode === "eval" || mode === "check-eval";
  let compiled: Compiled;
  try {
    compiled = compile(src, filename, "__main__", evalMode, mode === "single");
  } catch (e) {
    if (e instanceof PySyntaxError) throw syntaxError(e);
    throw e;
  }
  if (mode === "check" || mode === "check-eval") return null;
  const jsName = `py:<exec ${++execCounter}>`;
  R.scripts.set(jsName, { filename, lines: src.split("\n"), lineMap: compiled.lineMap });
  return runInThisContext(compiled.code, { filename: jsName })(ns, R);
};

// The pure-Python library (../lib) can be embedded in a single-file build:
// the bundler defines globalThis.__PYJS_LIB__ (relative path -> source),
// served under the virtual directory LIB_VIRTUAL.
export const LIB_VIRTUAL = "/$pyjs/lib";
const embedded: Record<string, string> | undefined = (globalThis as any).__PYJS_LIB__;
const fileExists = (p: string) => (embedded !== undefined && p.startsWith(LIB_VIRTUAL + "/") ? embedded[p.slice(LIB_VIRTUAL.length + 1)] !== undefined : existsSync(p));
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
