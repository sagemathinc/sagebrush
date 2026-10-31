// Module registry, import machinery, and builtin modules written in JS.

import { globalsDict, realGlobals, namespaceOf, instanceDict, NS_DICT, hooks, setattr, putAttr, currentExc, lookupType, isType, checkArity, bindArgs, sig, raiseExc } from "./object";
import { glibcLog, glibcExp, glibcExp2, glibcLog1p, glibcPow } from "./libm";
import { T, DONE, markRaised, FloatBox, PyDict, PyBytes, NotImplemented, typeOf, raise, PrimBox, unbox, builtin, tuple, getattr, isinstance, dictSet, dictGet, dictDelete, typeName, callKw, callObj, positionalArray } from "./object";
import * as O from "./ops";
import { INTR } from "./interrupt";
import { fullGc } from "./gc";
import * as Ty from "./types";
import { builtins, stdout, stderr, stdin, sysRef } from "./builtins";
import * as FD from "./fdlibm";
import * as CR from "./crmath";
import * as PG from "./pygamma";
import { floatRepr, intDigits } from "./format";
import { heapLimit } from "./heap";

export const sysModules = new PyDict();
const factories: Record<string, (m: any) => void> = Object.create(null);

// Set by the driver: find and execute a Python source module, or return
// null; compile and run source text for exec/eval/compile.
export const loader: { load: (name: string) => any | null; exec: (src: string, g: any, mode: string, filename: string, opts?: { sage?: boolean }) => any } = {
  load: () => null,
  exec: () => null,
};

export function builtinModuleNames(): string[] {
  return Object.keys(factories).filter((n) => !n.startsWith("_"));
}

// The modules the runtime puts in sys.modules itself, never found on sys.path: builtins (below) and
// __main__ (the namespace code runs in, its driver's).  importModule answers from sys.modules first.
export const SEEDED_MODULES: readonly string[] = ["builtins", "__main__"];
/**
 * Every name an import resolves to without sys.path: the builtin (JavaScript) modules, the runtime's
 * own (_fs, ...) too, and the ones it seeds in sys.modules (#172 r2's review, PY-172-1).  Not the live
 * sys.modules, which also holds the workspace modules a session has imported.
 */
export function resolvedModuleNames(): string[] {
  return [...new Set([...Object.keys(factories), ...SEEDED_MODULES])];
}

/** Is `name` a builtin (JavaScript) module, public or the runtime's own? (src/pkgset.ts reserves these names.) */
export function isBuiltinModule(name: string): boolean {
  return Object.hasOwn(factories, name);
}

export function newBuiltinModule(name: string, fill: (m: any) => void) {
  factories[name] = fill;
}

function fn(m: any, name: string, f: any) {
  builtin(f, name);
  f.__module__ = m.__name__; // (as CPython's: math.isclose.__module__ is 'math')
  m[name] = f;
}

// A builtin module's functions take the positional arguments CPython's do,
// and a call with more or fewer is a TypeError: a JS function ignores extra
// arguments, so math.sqrt(4, 5) was 2.0.  Once a public module is filled,
// each of its plain functions not already checked is wrapped by checkArity,
// with the count from its JS parameters or, where those differ from
// CPython's signature, from ARITY.  (test/module-arity.test.ts compares every
// one with CPython's inspect.signature.)  Modules whose names start with _
// are the runtime's own, called only by its Python-written modules.
export const ARITY: Record<string, Record<string, [number, number]>> = {
  // (os's functions are written (...a) to pass their errors through oserr)
  os: { getcwd: [0, 0], chdir: [1, 1], listdir: [0, 1], mkdir: [1, 2], makedirs: [1, 3], remove: [1, 1], unlink: [1, 1], rmdir: [1, 1], rename: [2, 2], replace: [2, 2], stat: [1, 1] },
  sys: { audit: [1, Infinity], getsizeof: [1, 2] },
  gc: { set_threshold: [1, 3] },
};

function checkModuleArity(m: any) {
  const mod: string = m.__name__;
  if (mod.startsWith("_")) return;
  const table = ARITY[mod];
  const wrapped = new Map<any, any>(); // (an alias stays the same object)
  for (const k of Object.keys(m)) {
    const f = m[k];
    // (a function written in Python checks its own arguments)
    if (typeof f !== "function" || isType(f) || f.$argRange !== undefined || (f.$pyfn === true && f.$globals !== undefined)) continue;
    let w = wrapped.get(f);
    if (w === undefined) {
      w = checkArity(f, f.__name__ ?? k, false, table?.[k]);
      wrapped.set(f, w);
    }
    m[k] = w;
  }
}

// (None in sys.modules stops an import, as CPython's _find_and_load: a way
// to make a module unimportable)
function halted(name: string): never {
  const e = T.ModuleNotFoundError(`import of ${name} halted; None in sys.modules`);
  e.name = name;
  throw e;
}

// A memory guard's refusal (item D): lib's _memguard.memory_guard builds it,
// so a runtime guard raises the same class (SagebrushMemoryError, a
// MemoryError) with the same text and fields as a lib guard: the wording
// lives there once.  Called before anything is allocated; the sizes are
// exact (a bigint past 2^53).
// (fixed: a limit that is the same whatever memory there is)
export function memoryGuard(what: string, needBytes: number | bigint, limitBytes: number | bigint, allowanceFor: string, fixed = false): never {
  const norm = (x: number | bigint) => (typeof x === "bigint" ? O.normBig(x) : x);
  const e = callKw(getattr(importModule("_memguard"), "memory_guard"), [what, norm(needBytes), norm(limitBytes), allowanceFor], ["fixed"], [fixed]);
  throw raiseExc(e);
}

export function importModule(name: string): any {
  // (a module's name is never one of the runtime's own, checked before the
  // lookup so a pre-seeded sys.modules entry cannot smuggle one in: rule 6)
  // (no `$` anywhere, no empty part; no allocation, as this runs on every import)
  if (typeof name !== "string" || name === "" || name.indexOf("$") >= 0 || name.indexOf("..") >= 0 || name.charCodeAt(0) === 46 || name.charCodeAt(name.length - 1) === 46) {
    const e = T.ModuleNotFoundError(`No module named '${name}'`);
    e.name = name;
    throw e;
  }
  const existing = dictGet(sysModules, name);
  if (existing !== undefined) return existing === null ? halted(name) : existing;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    // (a parent that is None in sys.modules is not imported again: as
    // CPython's _find_and_load_unlocked, it has no __path__, so not a package)
    if (dictGet(sysModules, name.slice(0, dot)) === null) {
      const e = T.ModuleNotFoundError(`No module named '${name}'; '${name.slice(0, dot)}' is not a package`);
      e.name = name;
      throw e;
    }
    importModule(name.slice(0, dot));
    // The parent's __init__ may have imported this module already.
    const now = dictGet(sysModules, name);
    if (now !== undefined) return now === null ? halted(name) : now;
  }
  // sys.meta_path finders (find_spec -> loader.create_module/exec_module)
  const mp = dictGet(sysModules, "sys")?.meta_path;
  if (Array.isArray(mp) && mp.length) {
    for (const finder of [...mp]) {
      const spec = callObj(getattr(finder, "find_spec"), [name, null, null]);
      if (spec === null || spec === undefined) continue;
      const ld = getattr(spec, "loader");
      let mod = callObj(getattr(ld, "create_module"), [spec]);
      if (mod === null || mod === undefined) mod = Ty.newModule(name);
      dictSet(sysModules, name, mod);
      try {
        callObj(getattr(ld, "exec_module"), [mod]);
      } catch (e) {
        // (a module whose exec raised, a Stop's KeyboardInterrupt included, leaves sys.modules, as CPython's
        // _load_unlocked deletes the entry, whatever it holds by then: else the next import returns it half-made)
        dictDelete(sysModules, name);
        throw e;
      }
      if (dot > 0) bindChild(name, dot, mod);
      return mod;
    }
  }
  const f = factories[name];
  let m: any;
  if (f !== undefined) {
    m = Ty.newModule(name);
    dictSet(sysModules, name, m);
    try {
      f(m);
    } catch (e) {
      // (likewise a builtin whose filling raised: a Stop during the first `import time`, whose factory imports
      // lib/_pytime.py, left a `time` with no sleep for every later import)
      dictDelete(sysModules, name);
      throw e;
    }
    checkModuleArity(m);
  } else {
    m = loader.load(name);
    if (m === null) {
      const e = T.ModuleNotFoundError(`No module named '${name}'`);
      e.name = name;
      throw e;
    }
  }
  if (dot > 0) bindChild(name, dot, m);
  return m;
}
// A submodule becomes its parent's attribute, as CPython does it: setattr
// (sys.modules may hold any object as the parent).
function bindChild(name: string, dot: number, m: any) {
  const parent = dictGet(sysModules, name.slice(0, dot));
  if (parent !== undefined && parent !== null) setattr(parent, name.slice(dot + 1), m);
}

const hasAttr = (o: any, name: string): boolean => {
  try {
    getattr(o, name);
    return true;
  } catch (e) {
    if (isinstance(e, T.AttributeError)) return false;
    throw e;
  }
};
// (a package's fromlist, as CPython's _handle_fromlist: each name it lacks
// imported as its child; a child that does not exist is passed over, for
// the from-import to report, unless it is None in sys.modules; '*' is its
// __all__'s names)
// (each item through the iterator protocol, a list subclass's __iter__
// included, and validated and imported before the next is asked for, as
// CPython's `for x in fromlist`: astra's CORR-C0F-1)
function handleFromlist(m: any, fromlist: any, recursive: boolean): void {
  const it = O.iter(fromlist);
  for (let x = it.$next(); x !== DONE; x = it.$next()) {
    if (!isinstance(x, T.str)) {
      const where = recursive ? `${getattr(m, "__name__")}.__all__` : "``from list''";
      raise(T.TypeError, `Item in ${where} must be str, not ${typeName(x)}`);
    }
    const name: string = unbox(x);
    if (name === "*") {
      if (!recursive && hasAttr(m, "__all__")) handleFromlist(m, getattr(m, "__all__"), true);
    } else if (!hasAttr(m, name)) {
      const from = `${unbox(getattr(m, "__name__"))}.${name}`;
      try {
        importModule(from);
      } catch (e: any) {
        if (isinstance(e, T.ModuleNotFoundError) && e.name === from && dictGet(sysModules, from) !== null) continue;
        throw e;
      }
    }
  }
}

// The import operation itself, for importlib.import_module, which (as
// CPython's _bootstrap._gcd_import) does not go through builtins.__import__
// or importlib.__import__, whoever replaced them: a checked absolute name
// to the module itself, from sys.modules or loaded
newBuiltinModule("_pyjs_import", (m) => {
  m.find_and_load = builtin((name: any) => importModule(name), "find_and_load");
});

// builtins.__import__, and the import statements, which call a replaced
// builtins.__import__ the way CPython does.
export function defaultImport(name: any, globals: any = null, _locals: any = null, fromlist: any = null, level: any = 0): any {
  if (typeof name !== "string") raise(T.TypeError, `module name must be str, not ${typeName(name)}`);
  const lv = Number(level);
  let full = name;
  if (lv > 0) {
    const pkg = globals instanceof PyDict ? dictGet(globals, "__package__") ?? dictGet(globals, "__name__") : null;
    full = resolveRelative(name, lv, pkg);
  }
  const m = importModule(full);
  if (fromlist !== null && O.truth(fromlist)) {
    if (hasAttr(m, "__path__")) handleFromlist(m, fromlist, false);
    return m;
  }
  if (lv === 0) return dictGet(sysModules, name.split(".")[0]);
  const base = full.slice(0, full.length - name.length);
  return dictGet(sysModules, base + name.split(".")[0]);
}
// The builtins code with globals `G` reads, CPython's frame builtins
// (_PyEval_BuiltinsFromGlobals): the globals' own __builtins__, a module's
// namespace or an exact dict's storage, any other object read through its
// __getitem__ (a non-mapping's TypeError then); without one, the builtins
// module
export function builtinsOf(G: any): any {
  const b = G.__builtins__;
  // (exec's default: the builtins module's __dict__, a live view)
  if (b === undefined || b === builtins || b === instanceDict(builtins)) return builtins;
  if (typeOf(b) === T.module) return b;
  if (b instanceof PyDict && typeOf(b) === T.dict) return namespaceOf(b);
  return new Proxy(Object.create(null), {
    get: (_t, k) => {
      if (typeof k !== "string") return k === NS_DICT ? b : undefined;
      try {
        return O.getitem(b, k);
      } catch (e) {
        if (isinstance(e, T.KeyError)) return undefined;
        throw e;
      }
    },
  });
}
// A name the builtins `b` must have: its value, else the NameError
// The builtins `b` as the object a frame's are (exec's default
// __builtins__ for new globals): a dict, a module's __dict__, the mapping
export function builtinsObject(b: any): any {
  if (b === undefined || b === builtins) return instanceDict(builtins);
  // (an exact dict's or a mapping's namespace: that object)
  const d = b[NS_DICT];
  return d !== undefined ? d : instanceDict(b);
}
export function builtinName(b: any, k: string): any {
  const v = b === builtins ? (Object.prototype.hasOwnProperty.call(b, k) ? b[k] : undefined) : b[k];
  if (v === undefined) raise(T.NameError, `name '${k}' is not defined`);
  return v;
}
// (the importing code's builtins' __import__, those it started with:
// CPython's IMPORT_NAME, the frame's builtins)
const customImport = (b: any = builtins): any => {
  const f = b.__import__;
  if (f === undefined) raise(T.ImportError, "__import__ not found");
  return f === defaultImport ? null : f;
};
const gdict = (g: any) => (g === undefined || g === null ? null : globalsDict(g));
// `import a.b.c` binds `a`.
export function importTop(name: string, g?: any, b?: any): any {
  const c = customImport(b);
  if (c !== null) return callObj(c, [name, gdict(g), null, null, 0]);
  importModule(name);
  return dictGet(sysModules, name.split(".")[0]);
}
// `import a.b.c as x`
export function importAs(name: string, g?: any, b?: any): any {
  const c = customImport(b);
  if (c === null) return importModule(name);
  let m = callObj(c, [name, gdict(g), null, null, 0]);
  for (const part of name.split(".").slice(1)) m = getattr(m, part);
  return m;
}
// The module of `from m import names` (relative when level > 0).
export function importFromStmt(module: string, names: string[], level: number, g: any, b?: any): any {
  const c = customImport(b);
  if (c !== null) return callObj(c, [module, gdict(g), null, tuple(names), level]);
  // (the globals' __package__, never exec's locals')
  return importModule(level ? resolveRelative(module, level, realGlobals(g).__package__) : module);
}

export function resolveRelative(name: string, level: number, pkg: any): string {
  if (level === 0) return name;
  if (typeof pkg !== "string" || pkg === "") raise(T.ImportError, "attempted relative import with no known parent package");
  const parts = pkg.split(".");
  if (level - 1 > parts.length - 1 && level > 1) raise(T.ImportError, "attempted relative import beyond top-level package");
  const base = parts.slice(0, parts.length - (level - 1)).join(".");
  return name ? `${base}.${name}` : base;
}

// `from m import name`
export function importFrom(m: any, name: string): any {
  if (!isinstance(m, T.module)) {
    // sys.modules entries may be any object.
    const v = getattr(m, name, null);
    if (v !== null || hasattr(m, name)) return v;
    raise(T.ImportError, `cannot import name '${name}' from '${typeName(m)}' object`);
  }
  const v = m[name];
  if (v !== undefined && Object.prototype.hasOwnProperty.call(m, name)) return v;
  // an attribute from the module's __getattr__ (PEP 562, or a module
  // subclass) comes before a submodule, as in CPython
  if (typeOf(m) !== T.module || m.__getattr__ !== undefined) {
    try {
      return typeOf(m) === T.module ? callObj(m.__getattr__, [name]) : getattr(m, name);
    } catch (e: any) {
      if (!(e?.$cls !== undefined && isinstance(e, T.AttributeError))) throw e;
    }
  }
  try {
    return importModule(`${m.__name__}.${name}`);
  } catch (e: any) {
    if (!(e?.$cls !== undefined && isinstance(e, T.ModuleNotFoundError))) throw e;
  }
  const err = T.ImportError(`cannot import name '${name}' from '${m.__name__}'`);
  throw err;
}
function hasattr(o: any, name: string): boolean {
  try {
    getattr(o, name);
    return true;
  } catch (e: any) {
    if (isinstance(e, T.AttributeError)) return false;
    throw e;
  }
}

// `from m import *`
export function importStar(m: any, g: any) {
  const all = getattr(m, "__all__", null);
  let names: any[];
  if (all !== null) names = O.toArray(all);
  else {
    const d = getattr(m, "__dict__", null);
    if (d === null) raise(T.ImportError, "from-import-* object has no __dict__ and no __all__");
    names = O.toArray(d).filter((k: any) => typeof k === "string" && !k.startsWith("_") && !k.startsWith("$"));
  }
  for (const k of names) {
    if (typeof k !== "string") raise(T.TypeError, `Item in ${m.__name__}.__all__ must be str, not ${typeName(k)}`);
    // (getattr refuses a `$` name; putAttr stores `__proto__` as data)
    putAttr(g, k, getattr(m, k));
  }
}

// ------------------------------------------------------------------ sys

export { heapLimit } from "./heap";

export const sysExtras: Record<string, any> = Object.create(null);
newBuiltinModule("sys", (m) => {
  m.argv = [];
  m.version = "3.14.0 (pyjs-spike)";
  m.hash_info = Ty.structseq("sys.hash_info", ["width", "modulus", "inf", "nan", "imag", "algorithm", "hash_bits", "seed_bits", "cutoff"], [64, 2305843009213693951n, 314159, 0, 1000003, "siphash13", 64, 128, 0]);
  // (default_max_str_digits: Sagebrush's default, 0, where CPython's is
  // 4300: format.ts's intDigits)
  m.int_info = Ty.structseq("sys.int_info", ["bits_per_digit", "sizeof_digit", "default_max_str_digits", "str_digits_check_threshold"], [30, 4, 0, 640]);
  m.version_info = Ty.structseq("sys.version_info", ["major", "minor", "micro", "releaselevel", "serial"], [3, 14, 0, "final", 0]);
  m.hexversion = 0x30e00f0;
  m.implementation = Ty.simpleNamespace({ name: "pyjs", cache_tag: null, version: m.version_info, _multiarch: "js" });
  m.maxsize = 9223372036854775807n;
  m.maxunicode = 0x10ffff;
  m.byteorder = "little";
  m.platform = process.platform === "win32" ? "win32" : process.platform;
  // the old generation this process can grow to, in bytes, for size
  // budgets that must scale with it (a matrix over a field is refused
  // before it is built, not by the heap running out): heapLimit()
  m._sagebrush_heap_limit = heapLimit();
  // the live heap now, in bytes: V8's used_heap_size after a full
  // collection (before one it counts garbage too, and varied by 25 MB from
  // run to run), for a budget taken from what is free rather than from the
  // whole limit (lib/_magma.py's comprehension limit, which calls it once).
  // None where the host has no V8 heap statistics or can't collect (the
  // browser, Bun, Deno)
  m._sagebrush_heap_used = builtin(() => {
    try {
      // (Node only, and only where the collection ran: gc.ts)
      if (!fullGc()) return null;
      const v8 = (globalThis as any).process.getBuiltinModule("node:v8");
      const n = v8.getHeapStatistics().used_heap_size;
      return typeof n === "number" && n > 0 ? Math.floor(n) : null;
    } catch {
      return null;
    }
  }, "_sagebrush_heap_used");
  // the external memory now (ArrayBuffer backing stores: bytes, typed arrays), in bytes, read
  // without a collection of its own: right after _sagebrush_heap_used() (its full collection),
  // the two are the live total (the interrupt matrix's leak measure, web/test-interrupt-matrix.mjs).
  // None where the host has neither figure (the browser, Bun, Deno)
  m._sagebrush_heap_external = builtin(() => {
    try {
      const v8 = (globalThis as any).process.getBuiltinModule("node:v8");
      const n = v8.getHeapStatistics().external_memory;
      return typeof n === "number" && n >= 0 ? Math.floor(n) : null;
    } catch {
      return null;
    }
  }, "_sagebrush_heap_external");
  // the function catalog the CLI bundle carries (scripts/build-cli.mjs,
  // catalog.gen.js: JSON text), for lib/_catalog.py away from a source tree;
  // None in the browser, whose search reads the built indexes
  m._sagebrush_catalog = (globalThis as any).__SAGEBRUSH_CATALOG__ ?? null;
  // the commit the CLI bundle was built from (a clean tree's; else None),
  // and its library's own files by their path in lib/, for the catalog's
  // links to the source (lib/_catalog.py source_url)
  m._sagebrush_commit = (globalThis as any).__SAGEBRUSH_COMMIT__ ?? null;
  m._sagebrush_lib_file = builtin((rel: any) => {
    const lib = (globalThis as any).__PYJS_LIB__;
    return lib !== undefined && typeof rel === "string" && Object.prototype.hasOwnProperty.call(lib, rel) ? lib[rel] : null;
  }, "_sagebrush_lib_file");
  sysRef.m = m;
  m.stdout = stdout;
  m.stderr = stderr;
  m.stdin = stdin;
  m.__stdout__ = stdout;
  m.__stderr__ = stderr;
  m.__stdin__ = stdin;
  m.modules = sysModules;
  m.path = [];
  m.meta_path = [];
  m.flags = Ty.newModule("flags");
  m.flags.optimize = 0;
  m.flags.int_max_str_digits = intDigits.max;
  fn(m, "get_int_max_str_digits", () => intDigits.max);
  // (as CPython's: the exact integer, in C int range, checked before
  // anything is changed, CORR-606-2)
  const setDigits = (maxdigits: any) => {
    const i = O.index(maxdigits);
    const b = typeof i === "bigint" ? i : BigInt(i);
    if (b > 2147483647n || b < -2147483648n) raise(T.OverflowError, "Python int too large to convert to C int");
    const n = Number(b);
    if (n !== 0 && n < 640) raise(T.ValueError, "maxdigits must be >= 640 or 0 for unlimited");
    intDigits.max = n;
    m.flags.int_max_str_digits = n;
    return null;
  };
  fn(m, "set_int_max_str_digits", setDigits);
  m.set_int_max_str_digits.$kw = (pos: any[], names: string[], values: any[]) => {
    if (names.length !== 1 || names[0] !== "maxdigits" || pos.length !== 0)
      raise(T.TypeError, names.find((k) => k !== "maxdigits") !== undefined ? `set_int_max_str_digits() got an unexpected keyword argument '${names.find((k) => k !== "maxdigits")}'` : "set_int_max_str_digits() takes exactly one argument");
    return setDigits(values[0]);
  };
  let limit = 1000;
  fn(m, "getrecursionlimit", () => limit);
  fn(m, "setrecursionlimit", (n: any) => ((limit = Number(n)), null));
  fn(m, "exit", (code: any = undefined) => {
    throw markRaised(code === undefined ? T.SystemExit() : T.SystemExit(code));
  });
  // (sys._getframe and _getframemodulename: index.ts)
  Object.assign(m, sysExtras);
  fn(m, "intern", (s: string) => s);
  fn(m, "audit", (..._a: any[]) => null);
  fn(m, "addaudithook", (_f: any) => null);
  fn(m, "getsizeof", (_x: any) => 64);
  // (the exception being handled, innermost; None outside any)
  const handled = currentExc;
  fn(m, "exception", () => handled());
  fn(m, "exc_info", () => {
    const e = handled();
    return e === null ? tuple([null, null, null]) : tuple([typeOf(e), e, e.__traceback__ ?? null]);
  });
  m.float_info = Ty.structseq("sys.float_info", ["max", "max_exp", "max_10_exp", "min", "min_exp", "min_10_exp", "dig", "mant_dig", "epsilon", "radix", "rounds"], [1.7976931348623157e308, 1024, 308, 2.2250738585072014e-308, -1021, -307, 15, 53, 2.220446049250313e-16, 2, 1]);
});
dictSet(sysModules, "builtins", builtins);

// ------------------------------------------------------------------ time

// The time module is builtin, as CPython's: made from lib/_pytime.py's
// public names (struct_time, gmtime, localtime, mktime, strftime and the
// rest), so a script named time.py does not hide it
newBuiltinModule("time", (m) => {
  const py = importModule("_pytime");
  for (const k of Object.keys(py)) {
    if (k.startsWith("_") && k !== "__doc__" && k !== "__getattr__") continue;
    m[k] = py[k];
  }
});

// (the clocks, and the host's zone, for lib/_pytime.py)
newBuiltinModule("_time", (m) => {
  const t0 = performance.now();
  const epochOffset = Date.now() / 1000 - t0 / 1000;
  fn(m, "perf_counter", () => performance.now() / 1000);
  fn(m, "perf_counter_ns", () => O.normBig(BigInt(Math.round(performance.now() * 1e6))));
  fn(m, "monotonic", () => performance.now() / 1000);
  fn(m, "monotonic_ns", () => O.normBig(BigInt(Math.round(performance.now() * 1e6))));
  fn(m, "time", () => epochOffset + performance.now() / 1000);
  fn(m, "time_ns", () => O.normBig(BigInt(Date.now()) * 1000000n));
  fn(m, "process_time", () => {
    const u = process.cpuUsage();
    return (u.user + u.system) / 1e6;
  });
  fn(m, "process_time_ns", () => {
    const u = process.cpuUsage();
    return O.normBig(BigInt(u.user + u.system) * 1000n);
  });
  // (the clocks' docstrings, CPython 3.14's: time shows them)
  const docs: Record<string, string> = {
    monotonic: "monotonic() -> float\n\nMonotonic clock, cannot go backward.",
    monotonic_ns: "monotonic_ns() -> int\n\nMonotonic clock, cannot go backward, as nanoseconds.",
    perf_counter: "perf_counter() -> float\n\nPerformance counter for benchmarking.",
    perf_counter_ns: "perf_counter_ns() -> int\n\nPerformance counter for benchmarking as nanoseconds.",
    process_time: "process_time() -> float\n\nProcess time for profiling: sum of the kernel and user-space CPU time.",
    process_time_ns: "process_time() -> int\n\nProcess time for profiling as nanoseconds:\nsum of the kernel and user-space CPU time.",
    time: "time() -> floating-point number\n\nReturn the current time in seconds since the Epoch.\nFractions of a second may be present if the system clock provides them.",
    time_ns: "time_ns() -> int\n\nReturn the current time in nanoseconds since the Epoch.",
  };
  for (const [k, d] of Object.entries(docs)) m[k].__doc__ = d;
  // (the host's zone, as lib/_tzrules.py resolves it: (the TZ variable as
  // given or None, TZDIR or None, whether this is Node, where glibc's files
  // are read, Intl's IANA name or None, for a browser))
  fn(m, "_zone", () => {
    const env = typeof process !== "undefined" ? process.env : undefined;
    // (SAGEBRUSH_TIME_NO_ZONE_FILES=1: as a browser, without zone files, for
    // the tests of that way under Node, whose Intl follows TZ)
    const node = typeof process !== "undefined" && !!process.versions?.node && env?.SAGEBRUSH_TIME_NO_ZONE_FILES !== "1";
    let z: unknown;
    if (!node) {
      try {
        z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        z = undefined;
      }
    }
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    return tuple([str(env?.TZ), str(env?.TZDIR), node, typeof z === "string" && z !== "" ? z : null]);
  });
  // (the most a zone file read may ask for: _tzrules.MAX_FILE + 1, the most
  // any caller needs. _read and _tzfile are importable, so a limit is an
  // int in 0..ZONE_READ_MAX, checked before anything is opened or allocated:
  // daybreak2's HARD-ZI-1)
  const ZONE_READ_MAX = (1 << 20) + 1;
  const zoneReadLimit = (fname: string, limit: any, most: number = ZONE_READ_MAX): number => {
    if (!O.isPyInt(limit) || typeof limit === "boolean") raise(T.TypeError, `_time.${fname}: the limit must be an int, not ${typeName(limit)}`);
    const n = typeof limit === "bigint" ? limit : BigInt(limit);
    if (n < 0n || n > BigInt(most)) raise(T.ValueError, `_time.${fname}: the limit must be in 0..${most}, not ${n}`);
    return Number(n);
  };
  // (zoneinfo's available_timezones walks TZPATH, which a user may set: one
  // directory's names, at most limit of them, read one by one, so that a
  // directory of millions of names is never listed whole. limit is an int
  // in 0..ZONE_DIR_MAX (zoneinfo/_tzpath.py's bound + 1), checked first;
  // os.listdir's OSError for what cannot be listed)
  const ZONE_DIR_MAX = (1 << 16) + 1;
  // (and at most chars characters of names in all: past them, None, before
  // the name that would cross them is kept (daybreak2's HARD-TZB-1: names
  // near NAME_MAX each). chars is an int in 0..ZONE_DIR_CHARS_MAX, zoneinfo/
  // _tzpath.py's bound)
  const ZONE_DIR_CHARS_MAX = 1 << 21;
  fn(m, "_zonedir", (path: any, limit: any, chars: any) => {
    const fs = require("fs");
    const max = zoneReadLimit("_zonedir", limit, ZONE_DIR_MAX);
    const maxChars = zoneReadLimit("_zonedir", chars, ZONE_DIR_CHARS_MAX);
    const name = String(path);
    let dir: any;
    try {
      dir = fs.opendirSync(at(name));
      const out: string[] = [];
      let used = 0;
      while (out.length < max) {
        const e = dir.readSync();
        if (e === null) break;
        used += e.name.length;
        if (used > maxChars) return null;
        out.push(e.name);
      }
      return out;
    } catch (e: any) {
      if (e?.$cls !== undefined) throw e;
      if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw markRaised(callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]));
      const cls = e?.code === "ENOENT" ? T.FileNotFoundError : e?.code === "EACCES" || e?.code === "EPERM" ? T.PermissionError : e?.code === "ENOTDIR" ? T.NotADirectoryError ?? T.OSError : T.OSError;
      throw markRaised(callObj(cls, [e?.errno ? -e.errno : 0, String(e?.message ?? e), path]));
    } finally {
      if (dir !== undefined) {
        try {
          dir.closeSync();
        } catch {}
      }
    }
  });
  // (a zone file's bytes, at most limit of them, as glibc reads one: None
  // where it cannot be read (missing, not permitted, a directory: glibc then
  // reads the TZ value as a rule), PermissionError where a sandbox refuses
  // the read outright, OSError for anything else)
  fn(m, "_read", (path: any, limit: any) => {
    const fs = require("fs");
    const max = zoneReadLimit("_read", limit);
    const p = at(String(path));
    let fd: number | undefined;
    try {
      // (never blocking: a FIFO or another special file named by TZ or TZDIR
      // would hang a plain open or read. A symbolic link is followed, as
      // glibc follows it, and its target checked: a directory is as glibc
      // reads one (None); anything but a regular file is refused)
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) return null;
      if (!st.isFile()) throw markRaised(callObj(T.OSError, [0, "not a regular file", String(path)]));
      const buf = new Uint8Array(max);
      let n = 0;
      while (n < max) {
        const k = fs.readSync(fd, buf, n, max - n, null);
        if (k === 0) break;
        n += k;
      }
      return new PyBytes(buf.slice(0, n));
    } catch (e: any) {
      if (e?.$cls !== undefined) throw e;
      if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw markRaised(callObj(T.PermissionError, [13, String(e.message).split("\n")[0], String(path)]));
      if (["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(e?.code)) return null;
      throw markRaised(callObj(T.OSError, [e?.errno ? -e.errno : 0, String(e?.message ?? e), String(path)]));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
  // (zoneinfo's io.open(path, "rb") of a zone file on TZPATH, as bytes: at
  // most limit of them, never blocking (a FIFO), a symbolic link followed;
  // open()'s errors, CPython's words: FileNotFoundError, PermissionError,
  // IsADirectoryError for a directory, ...; NotImplementedError for a file
  // that is not a regular one, which CPython would block on or read without
  // end)
  fn(m, "_tzfile", (path: any, limit: any) => {
    const fs = require("fs");
    const max = zoneReadLimit("_tzfile", limit);
    const name = String(path);
    // (errno, strerror and the OSError subclass CPython's OSError makes of
    // that errno, named here: Sagebrush's OSError(errno, ...) stays OSError)
    const STRERROR: Record<string, [number, string, any]> = {
      ENOENT: [2, "No such file or directory", T.FileNotFoundError],
      EACCES: [13, "Permission denied", T.PermissionError],
      EPERM: [1, "Operation not permitted", T.PermissionError],
      EISDIR: [21, "Is a directory", T.IsADirectoryError],
      ENOTDIR: [20, "Not a directory", T.NotADirectoryError ?? T.OSError],
      ELOOP: [40, "Too many levels of symbolic links", T.OSError],
      ENAMETOOLONG: [36, "File name too long", T.OSError],
      EMFILE: [24, "Too many open files", T.OSError],
      EIO: [5, "Input/output error", T.OSError],
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(at(name), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) throw markRaised(callObj(T.IsADirectoryError, [21, "Is a directory", path]));
      if (!st.isFile()) throw markRaised(callObj(T.NotImplementedError, [`zoneinfo: ${JSON.stringify(name)} is not a regular file, which Sagebrush does not read as a zone file`]));
      const buf = new Uint8Array(max);
      let n = 0;
      while (n < max) {
        const k = fs.readSync(fd, buf, n, max - n, null);
        if (k === 0) break;
        n += k;
      }
      return new PyBytes(buf.slice(0, n));
    } catch (e: any) {
      if (e?.$cls !== undefined) throw e;
      if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw markRaised(callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]));
      const known = STRERROR[e?.code];
      // (OSError(errno, strerror, filename) is the subclass the errno names)
      if (known) throw markRaised(callObj(known[2], [known[0], known[1], path]));
      throw markRaised(callObj(T.OSError, [e?.errno ? -e.errno : 0, String(e?.message ?? e), path]));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
  // (the pinned zone data's zone names, as tzdata's zones file lists them:
  // web/lib-lazy.ts's __SAGEBRUSH_TZDATA_ZONES__ in a browser, the files under
  // SAGEBRUSH_TIME_PINNED_DIR in the tests of that way under Node)
  fn(m, "_pinned_zones", () => {
    const hook = (globalThis as any).__SAGEBRUSH_TZDATA_ZONES__;
    const dir = typeof process !== "undefined" ? process.env?.SAGEBRUSH_TIME_PINNED_DIR : undefined;
    try {
      if (typeof hook === "function") return tuple((hook() as string[]).map((z) => z));
      if (typeof dir === "string") {
        const fs = require("fs");
        const out: string[] = [];
        const walk = (rel: string) => {
          for (const f of fs.readdirSync(rel ? dir + "/" + rel : dir).sort()) {
            const r = rel ? rel + "/" + f : f;
            // (a symbolic link is not followed: no cycle; a test hook's)
            const st = fs.lstatSync(dir + "/" + r);
            if (st.isDirectory()) walk(r);
            else if (st.isFile()) out.push(r);
          }
        };
        walk("");
        return tuple(out);
      }
    } catch (e: any) {
      throw markRaised(callObj(T.OSError, [0, String(e?.message ?? e)]));
    }
    throw markRaised(callObj(T.OSError, [0, "there is no pinned zone data here"]));
  });
  // (in a browser, which has no zone files: the pinned zone data's file for
  // a zone (web/lib-lazy.ts's __SAGEBRUSH_TZDATA__, each file checked against
  // its SHA-256), or None where the pinned data has no such zone; OSError
  // where it cannot be had. Under Node as a browser, for the tests of that
  // way: SAGEBRUSH_TIME_PINNED_DIR's file, a tzdata/zoneinfo directory)
  fn(m, "_pinned", (zone: any) => {
    const name = String(zone);
    const hook = (globalThis as any).__SAGEBRUSH_TZDATA__;
    const dir = typeof process !== "undefined" ? process.env?.SAGEBRUSH_TIME_PINNED_DIR : undefined;
    try {
      if (typeof hook === "function") {
        const b = hook(name);
        return b === null ? null : new PyBytes(new Uint8Array(b));
      }
      if (typeof dir === "string" && /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(name)) {
        const fs = require("fs");
        try {
          return new PyBytes(new Uint8Array(fs.readFileSync(dir + "/" + name)));
        } catch (e: any) {
          if (e?.code === "ENOENT") return null;
          throw e;
        }
      }
    } catch (e: any) {
      throw markRaised(callObj(T.OSError, [0, String(e?.message ?? e)]));
    }
    throw markRaised(callObj(T.OSError, [0, "there is no pinned zone data here"]));
  });
  // (the host zone's UTC offset at a UTC second, from JS's Date (ICU's
  // tzdata): (year, month, day, hour, minute, second, utcoffset), the offset
  // in whole seconds from the fields themselves, as Date's own offset is in
  // minutes; None outside the instants a Date holds)
  fn(m, "_local", (s: any) => {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || Math.abs(n) > 8.64e12) return null;
    const d = new Date(n * 1000);
    const f = [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
    const u = new Date(0);
    u.setUTCFullYear(f[0], f[1], f[2]);
    u.setUTCHours(f[3], f[4], f[5], 0);
    return tuple([f[0], f[1] + 1, f[2], f[3], f[4], f[5], Math.round((u.getTime() - n * 1000) / 1000)]);
  });
  // (time.sleep checks its argument as CPython's does; this, which anyone
  // can import, still waits only a finite time a PyTime_t can hold)
  fn(m, "sleep", (s: any) => {
    const v = O.fv(s);
    if (v === undefined) raise(T.TypeError, `'${typeName(s)}' object cannot be interpreted as an integer or float`);
    if (!(Math.abs(v) <= 9223372036)) raise(T.OverflowError, "timestamp out of range for C PyTime_t");
    if (v < 0) raise(T.ValueError, "sleep length must be non-negative");
    // (waiting on the interrupt flag, when it is shared memory: Ctrl-C, which
    // sets it and notifies, ends the sleep with KeyboardInterrupt at once, as
    // in CPython)
    if (v > 0) {
      const flag = INTR.buffer instanceof SharedArrayBuffer ? INTR : new Int32Array(new SharedArrayBuffer(8));
      for (const end = Date.now() + v * 1000; ; ) {
        O.pollInterrupt();
        const left = end - Date.now();
        if (left <= 0) break;
        // (on the word's present value: another bit set, a frame request or
        // a persistent armed allowance, must not turn the wait into a spin;
        // a producer's notify wakes it, and only bit 0 ends it)
        Atomics.wait(flag, 0, Atomics.load(flag, 0) & ~1, left);
      }
    }
    return null;
  });
});

// ------------------------------------------------------------------ math

newBuiltinModule("math", (m) => {
  // (PyFloat_AsDouble, Ty.asDouble: an int subclass's __float__ too)
  const F = (x: any): number => {
    const v = Ty.asDouble(x);
    return v === undefined ? raise(T.TypeError, `must be real number, not ${typeName(x)}`) : v;
  };
  const domain = () => raise(T.ValueError, "math domain error");
  const range = () => raise(T.OverflowError, "math range error");
  // CPython 3.14's math_1: a NaN from a non-NaN, or (unless the function can
  // overflow) an infinity from a finite input, is a domain error, in the
  // function's own words when it has them (msg, with the input's repr)
  const OVERFLOWS = new Set(["exp", "exp2", "expm1", "sinh", "cosh"]);
  const unary = (name: string, f: (x: number) => number, ok: (x: number) => boolean = () => true, msg: string | null = null) =>
    fn(m, name, (x: any) => {
      const v = F(x);
      const bad = () => (msg === null ? domain() : raise(T.ValueError, msg.replace("%s", floatRepr(v))));
      if (!ok(v)) bad();
      const r = f(v);
      if (r !== r && v === v) bad();
      if (!Number.isFinite(r) && Number.isFinite(v)) {
        if (OVERFLOWS.has(name)) range();
        bad();
      }
      return O.mkfloat(r);
    });
  m.pi = Math.PI;
  m.e = Math.E;
  m.tau = 2 * Math.PI;
  m.inf = new FloatBox(Infinity);
  m.nan = NaN;
  unary("sqrt", Math.sqrt, (x) => x >= 0 || x !== x, "expected a nonnegative input, got %s");
  unary("exp", glibcExp);
  unary("expm1", FD.expm1);
  unary("sin", CR.sin, (x) => Number.isFinite(x) || x !== x, "expected a finite input, got %s");
  unary("cos", CR.cos, (x) => Number.isFinite(x) || x !== x, "expected a finite input, got %s");
  unary("tan", CR.tan, (x) => Number.isFinite(x) || x !== x, "expected a finite input, got %s");
  unary("asin", CR.asin, (x) => (x >= -1 && x <= 1) || x !== x, "expected a number in range from -1 up to 1, got %s");
  unary("acos", CR.acos, (x) => (x >= -1 && x <= 1) || x !== x, "expected a number in range from -1 up to 1, got %s");
  unary("atan", CR.atan);
  unary("sinh", FD.sinh);
  unary("cosh", FD.cosh);
  unary("tanh", FD.tanh);
  unary("asinh", CR.asinh);
  unary("acosh", CR.acosh, (x) => x >= 1 || x !== x, "expected argument value not less than 1, got %s");
  unary("atanh", CR.atanh, (x) => (x > -1 && x < 1) || x !== x, "expected a number between -1 and 1, got %s");
  unary("fabs", Math.abs);
  unary("log1p", glibcLog1p, (x) => x > -1 || x !== x, "expected argument value > -1, got %s");
  // (x times CPython's constants, so no intermediate overflows, CORR-447-4;
  // an infinite result is CPython's too)
  const radToDeg = 180 / Math.PI, degToRad = Math.PI / 180;
  fn(m, "degrees", (x: any) => O.mkfloat(F(x) * radToDeg));
  fn(m, "radians", (x: any) => O.mkfloat(F(x) * degToRad));
  unary("cbrt", FD.cbrt);
  // CPython's loghelper: an int (huge ones too) by its own path, refused
  // without its value; anything else as a float, refused with it
  const logOf = (v: any, f: (x: number) => number, ln2: number): number => {
    // (an int subclass too, as CPython's: its int value, not its __float__,
    // CORR-CA8-1)
    if (typeof v === "bigint" || typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v)) || O.isPyInt(v) || (v instanceof PrimBox && typeOf(v).$mro.includes(T.int))) {
      const b = BigInt(typeof v === "boolean" ? +v : v instanceof PrimBox ? unbox(v) : O.index(v));
      if (b <= 0n) raise(T.ValueError, "expected a positive input");
      const d = Number(b);
      if (d !== Infinity) return f(d);
      // as CPython: frexp (mantissa rounded to 53 bits) for ints beyond
      // float range, of any size, as CPython has no bound (it was 2^27 bits,
      // HARD-315-1, before the bit length was found with small copies)
      const s = O.bitLengthSmallCopies(b); // (not b.toString(2): HARD-909-1)
      let top = b >> BigInt(s - 64);
      // the sticky bit, for correct rounding: it matters only when the 11
      // bits below the 53 kept are exactly half, so only then is the rest
      // of b examined, a copy of it, admitted against the heap
      if ((top & 0x7ffn) === 0x400n) {
        const bytes = (s - 64) / 8;
        if (bytes > heapLimit() / 2)
          raise(T.MemoryError, `math.log of an int of ${s} bits needs a copy of it (about ${Math.ceil(bytes / 2 ** 20)} MiB) to round correctly, more than half this session's heap`);
        if (BigInt.asUintN(s - 64, b) !== 0n) top |= 1n;
      }
      let x = Number(top) / 18446744073709551616, e = s;
      if (x === 1) {
        x = 0.5;
        e += 1;
      }
      return f(x) + e * ln2;
    }
    const x = F(v);
    if (x <= 0) raise(T.ValueError, `expected a positive input, got ${floatRepr(x)}`);
    return f(x);
  };
  fn(m, "log", (x: any, base: any = undefined) => {
    const num = logOf(x, glibcLog, Math.LN2);
    if (base === undefined) return O.mkfloat(num);
    const den = logOf(base, glibcLog, Math.LN2);
    // (a base of 1: float division by zero, CORR-447-2)
    if (den === 0) raise(T.ZeroDivisionError, "division by zero");
    return O.mkfloat(num / den);
  });
  fn(m, "log2", (x: any) => O.mkfloat(logOf(x, CR.log2, 1)));
  fn(m, "log10", (x: any) => O.mkfloat(logOf(x, FD.log10, Math.log10(2))));
  fn(m, "pow", (x: any, y: any) => {
    const a = F(x), b = F(y);
    // (errors only for finite arguments, as CPython's: 0 to a negative finite power is a pole,
    // pow(0, -inf) is inf (CORR-447-5), pow(-inf, 0.5) inf)
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (a === 0 && b < 0) domain();
      if (a < 0 && !Number.isInteger(b)) domain();
    }
    const r = glibcPow(a, b);
    if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) range();
    return O.mkfloat(r);
  });
  fn(m, "atan2", (y: any, x: any) => O.mkfloat(CR.atan2(F(y), F(x))));
  // (also as an array of its arguments, for hypot(*xs) of any length:
  // BIG_CALL; the call's own temporary array, converted in place with Stop
  // polled, no second array, HARD-592-1)
  const hypotN = (xs: any[]) => {
    for (let i = 0; i < xs.length; i++) {
      if ((i & 1023) === 1023) O.pollInterrupt();
      xs[i] = F(xs[i]);
    }
    return O.mkfloat(CR.hypotN(xs));
  };
  fn(m, "hypot", positionalArray((...xs: any[]) => hypotN(xs), hypotN));
  fn(m, "copysign", (x: any, y: any) => {
    // (through the bits: y's sign bit, a NaN's too, on x's magnitude)
    const dv = new DataView(new ArrayBuffer(16));
    dv.setFloat64(0, F(x));
    dv.setFloat64(8, F(y));
    dv.setUint8(0, (dv.getUint8(0) & 0x7f) | (dv.getUint8(8) & 0x80));
    return O.mkfloat(dv.getFloat64(0));
  });
  // (CPython's math_fmod_impl: JS's % is C's fmod; a nan from operands
  // that are not is outside the domain)
  fn(m, "fmod", (x: any, y: any) => {
    const a = F(x), b = F(y);
    const r = a % b;
    if (Number.isNaN(r) && !Number.isNaN(a) && !Number.isNaN(b)) domain();
    return O.mkfloat(r);
  });
  const toInt = (v: number) => {
    if (v !== v) raise(T.ValueError, "cannot convert float NaN to integer");
    if (!Number.isFinite(v)) raise(T.OverflowError, "cannot convert float infinity to integer");
    return Number.isSafeInteger(v) ? v + 0 : O.normBig(BigInt(v));
  };
  const intOr = (name: string, f: (v: number) => number) => (x: any) => {
    if (O.isPyInt(x)) return typeof x === "boolean" ? +x : x;
    const d = Ty.lookupDunder(x, name);
    if (d !== undefined) return d(x);
    if (x instanceof PrimBox && typeOf(x).$mro.includes(T.int)) return unbox(x); // (an int subclass's value, not its __float__)
    return toInt(f(F(x)));
  };
  fn(m, "floor", intOr("__floor__", Math.floor));
  fn(m, "ceil", intOr("__ceil__", Math.ceil));
  fn(m, "trunc", intOr("__trunc__", Math.trunc));
  fn(m, "isfinite", (x: any) => Number.isFinite(F(x)));
  fn(m, "isinf", (x: any) => Math.abs(F(x)) === Infinity);
  fn(m, "isnan", (x: any) => F(x) !== F(x));
  // (CPython's math_isclose_impl: rel_tol and abs_tol keyword-only)
  const isclose = (a: any, b: any, relTol = 1e-9, absTol = 0.0) => {
    if (relTol < 0.0 || absTol < 0.0) raise(T.ValueError, "tolerances must be non-negative");
    if (a === b) return true;
    if (a === Infinity || a === -Infinity || b === Infinity || b === -Infinity) return false;
    const diff = Math.abs(b - a);
    return diff <= Math.abs(relTol * b) || diff <= Math.abs(relTol * a) || diff <= absTol;
  };
  fn(m, "isclose", (a: any, b: any) => isclose(F(a), F(b)));
  // (keywords bound by CPython's signature, isclose(a, b, *, rel_tol, abs_tol):
  // a= and b= too, a duplicate or an unknown name refused)
  m.isclose.$kw = (pos: any[], names: string[], values: any[]) => {
    const [a, b, rel, abs] = bindArgs("isclose", sig(["a", "b"], { kwonly: ["rel_tol", "abs_tol"] }), pos, names, values);
    if (a === undefined) raise(T.TypeError, "isclose() missing required argument 'a' (pos 1)");
    if (b === undefined) raise(T.TypeError, "isclose() missing required argument 'b' (pos 2)");
    return isclose(F(a), F(b), rel === undefined ? 1e-9 : F(rel), abs === undefined ? 0.0 : F(abs));
  };
  // (CPython's math_modf_impl: the parts keep x's sign, an infinity's
  // fractional part is a signed zero)
  fn(m, "modf", (x: any) => {
    const v = F(x);
    if (v === Infinity || v === -Infinity) return tuple([O.mkfloat(Math.sign(v) * 0), O.mkfloat(v)]);
    const i = Math.trunc(v);
    const f = v - i;
    return tuple([O.mkfloat(f === 0 ? (v < 0 || Object.is(v, -0) ? -0 : 0) : f), O.mkfloat(i)]);
  });
  // (CPython's m_remainder: the IEEE 754 remainder, x - n*y with n the
  // integer nearest x/y, ties to even; exact)
  fn(m, "remainder", (a: any, b: any) => {
    const x = F(a), y = F(b);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (y === 0) raise(T.ValueError, "math domain error");
      const ax = Math.abs(x), ay = Math.abs(y);
      const md = ax % ay;
      const c = ay - md;
      let r: number;
      if (md < c) r = md;
      else if (md > c) r = -c;
      else r = md - 2.0 * ((0.5 * (ax - md)) % ay);
      return O.mkfloat((x < 0 || Object.is(x, -0) ? -1 : 1) * r);
    }
    if (Number.isNaN(x)) return O.mkfloat(x);
    if (Number.isNaN(y)) return O.mkfloat(y);
    if (x === Infinity || x === -Infinity) raise(T.ValueError, "math domain error");
    return O.mkfloat(x);
  });
  fn(m, "frexp", (x: any) => {
    let v = F(x);
    if (v === 0 || !Number.isFinite(v)) return tuple([O.mkfloat(v), 0]);
    let e = 0;
    while (Math.abs(v) >= 1) { v /= 2; e++; }
    while (Math.abs(v) < 0.5) { v *= 2; e--; }
    return tuple([O.mkfloat(v), e]);
  });
  // x * 2**i rounded once, as CPython's (C's ldexp): a subnormal result is
  // rounded half to even, an overflow is OverflowError
  fn(m, "ldexp", (x: any, i: any) => {
    const v = F(x);
    if (!O.isPyInt(i) && typeof i !== "boolean") raise(T.TypeError, "Expected an int as second argument to ldexp.");
    if (v === 0 || !Number.isFinite(v)) return O.mkfloat(v);
    const big = BigInt(typeof i === "boolean" ? +i : i);
    // |v| = m * 2**ev with 0.5 <= m < 1
    let ev = Math.floor(Math.log2(Math.abs(v))) + 1;
    let mant = v / Math.pow(2, ev);
    if (!(Math.abs(mant) >= 0.5 && Math.abs(mant) < 1)) {
      // (log2's rounding, and subnormal inputs: exact halving and doubling)
      mant = v; ev = 0;
      while (Math.abs(mant) >= 1) { mant /= 2; ev++; }
      while (Math.abs(mant) < 0.5) { mant *= 2; ev--; }
    }
    const total = big + BigInt(ev);
    if (total > 1024n) raise(T.OverflowError, "math range error");
    let r: number;
    if (total >= -1021n) {
      const t = Number(total);
      // (2**1024 is not a double: m * 2 first)
      r = t === 1024 ? mant * 2 * Math.pow(2, 1023) : mant * Math.pow(2, t);
    } else if (total < -1074n - 54n) {
      r = mant < 0 ? -0 : 0;
    } else {
      // exactly into the normal range, then one rounding to the subnormal
      r = mant * Math.pow(2, Number(total) + 1074) * Math.pow(2, -1074);
    }
    if (!Number.isFinite(r)) raise(T.OverflowError, "math range error");
    return O.mkfloat(r);
  });
  const bigOf = (x: any): bigint => {
    // as CPython: anything with __index__ (int subclasses included)
    if (!O.isPyInt(x)) x = O.index(x);
    return BigInt(typeof x === "boolean" ? +x : x);
  };
  // ---- products of many integers, as CPython's math_factorial,
  // perm_comb and math_prod (Modules/mathmodule.c, ported: NOTICE.md):
  // balanced, so its multiplications are of like sizes, not one big
  // integer times a small one n times (factorial(100000) took 4 s)
  const LLONG_MAX = 9223372036854775807n;
  // (V8's largest BigInt has 2**30 bits: a result known to be past it is a
  // MemoryError before anything is computed, from a lower bound on its
  // size, so a value that fits is never refused; one found past it on the
  // way, V8's RangeError, a MemoryError too)
  const MAX_BITS = 2 ** 30;
  const tooBig = (bitsAtLeast: number) => {
    if (bitsAtLeast > MAX_BITS) raise(T.MemoryError);
  };
  const bigMul = (a: bigint, b: bigint): bigint => {
    // (Stop is seen between multiplications)
    O.pollInterrupt();
    try {
      return a * b;
    } catch (e) {
      if (e instanceof RangeError) raise(T.MemoryError);
      throw e;
    }
  };
  // (n below 2**32 here: factorial's n is below 2**26 by then)
  const bitLength = (n: number) => (n <= 0 ? 0 : 32 - Math.clz32(n));
  // (start * (start + 2) * ... * (stop - 2), odd start < stop, each below
  // 2**max_bits: CPython's factorial_partial_product; a product that fits
  // 64 bits multiplied at once, else the two halves; the depth is that of
  // halving, at most 64)
  const partialProduct = (start: number, stop: number, maxBits: number): bigint => {
    const numOperands = Math.floor((stop - start) / 2);
    if (numOperands <= 64 && numOperands * maxBits <= 64) {
      let total = BigInt(start);
      for (let j = start + 2; j < stop; j += 2) total *= BigInt(j);
      return total;
    }
    const midpoint = (start + numOperands) | 1;
    const left = partialProduct(start, midpoint, bitLength(midpoint - 2));
    const right = partialProduct(midpoint, stop, maxBits);
    return bigMul(left, right);
  };
  // (n!'s odd part, CPython's factorial_odd_part: the product over i of
  // the odd numbers in (n >> (i+1), n >> i], each to the power i + 1, as
  // the running products inner and outer)
  const factorialOddPart = (n: number): bigint => {
    let inner = 1n, outer = 1n;
    let upper = 3;
    for (let i = bitLength(n) - 2; i >= 0; i--) {
      const v = Math.floor(n / 2 ** i);
      if (v <= 2) continue;
      const lower = upper;
      upper = (v + 1) | 1;
      inner = bigMul(inner, partialProduct(lower, upper, bitLength(upper - 2)));
      outer = bigMul(outer, inner);
    }
    return outer;
  };
  const SMALL_FACTORIALS: number[] = [1];
  for (let i = 1; i <= 18; i++) SMALL_FACTORIALS.push(SMALL_FACTORIALS[i - 1] * i);
  const factorial = (x: any): any => {
    const n = bigOf(x);
    if (n > LLONG_MAX) raise(T.OverflowError, `factorial() argument should not exceed ${LLONG_MAX}`);
    if (n < 0n) raise(T.ValueError, "factorial() not defined for negative values");
    if (n < BigInt(SMALL_FACTORIALS.length)) return SMALL_FACTORIALS[Number(n)];
    // (n! > (n/e)**n)
    const k = Number(n);
    tooBig(k * Math.log2(k / Math.E));
    let pop = 0;
    for (let v = k; v > 0; v = Math.floor(v / 2)) pop += v % 2;
    // (n! is its odd part times 2**(n - popcount(n)))
    try {
      return O.normBig(factorialOddPart(k) << BigInt(k - pop));
    } catch (e) {
      if (e instanceof RangeError) raise(T.MemoryError);
      throw e;
    }
  };
  fn(m, "factorial", factorial);
  const gcd2 = (a: bigint, b: bigint): bigint => {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
  };
  // (each also as an array of its arguments, for gcd(*xs) of any length: BIG_CALL)
  // (streamed, no mapped copy, and Stop polled over a long list)
  const gcdN = (xs: any[]) => {
    let g = 0n;
    for (let i = 0; i < xs.length; i++) {
      if ((i & 1023) === 1023) O.pollInterrupt();
      g = gcd2(g, bigOf(xs[i]));
    }
    return O.normBig(g);
  };
  const lcmN = (xs: any[]) => {
    let l = 1n;
    for (let i = 0; i < xs.length; i++) {
      if ((i & 1023) === 1023) O.pollInterrupt();
      const b = bigOf(xs[i]);
      l = l === 0n || b === 0n ? 0n : ((l * b < 0n ? -(l * b) : l * b) / gcd2(l, b));
    }
    return O.normBig(l);
  };
  fn(m, "gcd", positionalArray((...xs: any[]) => gcdN(xs), gcdN));
  fn(m, "lcm", positionalArray((...xs: any[]) => lcmN(xs), lcmN));
  fn(m, "isqrt", (x: any) => {
    const n = bigOf(x);
    if (n < 0n) raise(T.ValueError, "isqrt() argument must be nonnegative");
    if (n < 2n) return Number(n);
    if (n < 2n ** 52n) {
      let r = BigInt(Math.floor(Math.sqrt(Number(n))));
      while (r * r > n) r--;
      while ((r + 1n) * (r + 1n) <= n) r++;
      return O.normBig(r);
    }
    // Newton's method from above (a float start is off by far more than 1 here)
    let g = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) {
      const y = (g + n / g) >> 1n;
      if (y >= g) break;
      g = y;
    }
    return O.normBig(g);
  });
  // (P(n, k), or C(n, k) for comb, as CPython's perm_comb: P(n, k) =
  // P(n, j) * P(n - j, k - j) and C(n, k) = C(n, j) * C(n - j, k - j) //
  // C(k, j) for j = k // 2, so like sizes are multiplied; a few factors
  // one after another; the depth is that of halving k)
  const permComb = (n: bigint, k: number, comb: boolean): bigint => {
    if (k === 0) return 1n;
    if (k === 1) return n;
    if (k <= 16) {
      let r = n;
      for (let i = 1; i < k; i++) r = comb ? (r * (n - BigInt(i))) / BigInt(i + 1) : r * (n - BigInt(i));
      return r;
    }
    const j = Math.floor(k / 2);
    const a = bigMul(permComb(n, j, comb), permComb(n - BigInt(j), k - j, comb));
    return comb ? a / permComb(BigInt(k), j, true) : a;
  };
  // (the product of xs, a balanced tree of pairs, level by level: no
  // recursion; small factors first multiplied as numbers while exact)
  const productOf = (xs: bigint[]): bigint => {
    let level: bigint[] = [];
    let acc = 1;
    for (const x of xs) {
      if (x < 67108864n && acc * Number(x) <= Number.MAX_SAFE_INTEGER) acc *= Number(x);
      else if (x < 67108864n) {
        level.push(BigInt(acc));
        acc = Number(x);
      } else level.push(x);
    }
    level.push(BigInt(acc));
    while (level.length > 1) {
      const next: bigint[] = [];
      for (let i = 0; i + 1 < level.length; i += 2) next.push(bigMul(level[i], level[i + 1]));
      if (level.length % 2) next.push(level[level.length - 1]);
      level = next;
    }
    return level[0];
  };
  // (C(n, k) for n up to 2**25 from its primes, no division: each prime
  // p's exponent the number of carries adding k and n - k in base p, as
  // Kummer's theorem, Legendre's sums; the same value as CPython's
  // perm_comb, whose divisions of big integers V8 does slowly)
  const COMB_SIEVE_MAX = 2 ** 25;
  const combByPrimes = (n: number, k: number): bigint => {
    const composite = new Uint8Array(n + 1);
    const factors: bigint[] = [];
    for (let p = 2; p <= n; p++) {
      if ((p & 65535) === 0) O.pollInterrupt();
      if (composite[p]) continue;
      if (p <= n / p) for (let q = p * p; q <= n; q += p) composite[q] = 1;
      let e = 0;
      for (let pp = p; pp <= n; pp *= p) e += Math.floor(n / pp) - Math.floor(k / pp) - Math.floor((n - k) / pp);
      if (e === 1) factors.push(BigInt(p));
      else if (e > 1) factors.push(BigInt(p) ** BigInt(e));
    }
    return productOf(factors);
  };
  // (a lower bound on log2(n), n >= 1, in bounded space, no digits of n
  // made: n may be near the largest BigInt, daybreak2's LIMIT-AF5-1. Below
  // 2**1024, n as a number, less a margin for its rounding. Above, the
  // largest s, stepping down from V8's 2**30 bits by 1/64 at a time, with
  // n >> s not 0: a shift past n's bits is 0 at once, and the first that is
  // not has fewer bits than the step, under 1/64 of 2**30, so log2(n) is
  // bounded to within 1/64 of itself. A product the bound still admits and
  // V8 cannot hold, V8 refuses before making it, a RangeError, so a
  // MemoryError at once.)
  const log2Big = (n: bigint): number => {
    const v = Number(n);
    if (Number.isFinite(v)) return Math.log2(v) - 1e-9;
    for (let s = MAX_BITS; s > 1023; s -= Math.max(1, s >> 6)) if (n >> BigInt(s) !== 0n) return s;
    return 1023;
  };
  // (the sizes of P and C a lower bound: P(n, k) >= max(n - k + 1, k/e)**k,
  // C(n, k) >= max(n/k, 2)**k for k <= n/2; the bounds on k alone first,
  // so a k past them is refused without reading n's digits)
  const permCombBig = (n: bigint, k: bigint, comb: boolean): any => {
    // (k of 0 or 1: 1 or n itself, before any size bound, which reads n's
    // digits: n may be near the largest BigInt; daybreak2's LIMIT-PTREE-1)
    if (k === 0n) return 1;
    if (k === 1n) return O.normBig(n);
    const kf = Number(k);
    if (comb) {
      tooBig(kf - 1);
      tooBig(kf * (log2Big(n) - Math.log2(kf)) - 1);
    } else {
      tooBig(kf * Math.log2(kf / Math.E) - 1);
      tooBig(kf * log2Big(n - k + 1n) - 1);
    }
    try {
      if (comb && kf > 64 && n <= BigInt(COMB_SIEVE_MAX)) return O.normBig(combByPrimes(Number(n), kf));
      return O.normBig(permComb(n, kf, comb));
    } catch (e) {
      if (e instanceof RangeError) raise(T.MemoryError);
      throw e;
    }
  };
  // (CPython 3.14's math_comb_impl and math_perm_impl: n and k converted,
  // their signs checked, then an n or k past a C long long told apart)
  fn(m, "comb", (nn: any, kk: any) => {
    const n = bigOf(nn);
    let k = bigOf(kk);
    if (n < 0n) raise(T.ValueError, "n must be a non-negative integer");
    if (k < 0n) raise(T.ValueError, "k must be a non-negative integer");
    if (n <= LLONG_MAX) {
      if (k > n) return 0;
      if (n - k < k) k = n - k;
    } else {
      const t = n - k;
      if (t < 0n) return 0;
      if (t < k) k = t;
      if (k > LLONG_MAX) raise(T.OverflowError, `min(n - k, k) must not exceed ${LLONG_MAX}`);
    }
    return permCombBig(n, k, true);
  });
  fn(m, "perm", (nn: any, kk: any = null) => {
    // (perm(n) is factorial(n), its checks and messages)
    if (kk === null) return factorial(nn);
    const n = bigOf(nn);
    const k = bigOf(kk);
    if (n < 0n) raise(T.ValueError, "n must be a non-negative integer");
    if (k < 0n) raise(T.ValueError, "k must be a non-negative integer");
    if (n <= LLONG_MAX) {
      if (k > n) return 0;
    } else if (k > LLONG_MAX) {
      if (k > n) return 0;
      raise(T.OverflowError, `k must not exceed ${LLONG_MAX}`);
    }
    return permCombBig(n, k, false);
  });
  // (positional only, CPython's messages)
  for (const name of ["comb", "perm"]) {
    m[name].$kw = (pos: any[], names: string[]) => {
      if (names.length) raise(T.TypeError, `math.${name}() takes no keyword arguments`);
      return m[name](...pos);
    };
  }
  // CPython's math_fsum_impl (Modules/mathmodule.c, ported: NOTICE.md):
  // Shewchuk's exact partials, infinities and nans summed apart, an
  // intermediate overflow an error, and the partials added from the top with
  // half-even rounding carried across them
  fn(m, "fsum", (it: any) => {
    const p: number[] = [];
    let n = 0, specialSum = 0.0, infSum = 0.0;
    O.forEach(it, (v) => {
      let x = F(v);
      const xsave = x;
      let i = 0;
      for (let j = 0; j < n; j++) {
        let y = p[j];
        if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
        const hi = x + y;
        const lo = y - (hi - x);
        if (lo !== 0.0) p[i++] = lo;
        x = hi;
      }
      n = i;
      if (x !== 0.0) {
        if (!Number.isFinite(x)) {
          // (from an infinity or nan among the items, or an overflow)
          if (Number.isFinite(xsave)) raise(T.OverflowError, "intermediate overflow in fsum");
          if (xsave === Infinity || xsave === -Infinity) infSum += xsave;
          specialSum += xsave;
          n = 0;
        } else p[n++] = x;
      }
    });
    if (specialSum !== 0.0) {
      if (Number.isNaN(infSum)) raise(T.ValueError, "-inf + inf in fsum");
      return O.mkfloat(specialSum);
    }
    let hi = 0.0, lo = 0.0;
    if (n > 0) {
      hi = p[--n];
      // (the partials from the top, while their sum is exact)
      while (n > 0) {
        const x = hi, y = p[--n];
        hi = x + y;
        lo = y - (hi - x);
        if (lo !== 0.0) break;
      }
      // (half-even rounding across partials)
      if (n > 0 && ((lo < 0.0 && p[n - 1] < 0.0) || (lo > 0.0 && p[n - 1] > 0.0))) {
        const y = lo * 2.0;
        const x = hi + y;
        if (y === x - hi) hi = x;
      }
    }
    return O.mkfloat(hi);
  });
  // math.prod(iterable, /, *, start=1) as CPython's math_prod_impl: left
  // to right, each item's __mul__ called in turn; while the product and
  // the items are exact ints (bools among the items), CPython's int fast
  // path, here a balanced product of them, the same value: the items
  // multiplied as they come in blocks of like sizes, merged as a binary
  // counter (memory for log2 of their number of blocks); at the first other
  // item, that product, then on one at a time
  const prod = (it: any, start: any) => {
    let r: any = start;
    if (!(typeof r !== "boolean" && O.isPyInt(r))) {
      O.forEach(it, (v) => (r = O.mul(r, v)));
      return r;
    }
    const stack: bigint[] = [], sizes: number[] = [];
    const push = (v: bigint) => {
      let size = 1;
      while (sizes.length && sizes[sizes.length - 1] === size) {
        v = bigMul(stack.pop()!, v);
        sizes.pop();
        size *= 2;
      }
      stack.push(v);
      sizes.push(size);
    };
    // (small items multiplied as numbers while the product is exact)
    let acc = 1, ints = true, count = 0;
    const flush = (): any => {
      push(BigInt(acc));
      acc = 1;
      let p = BigInt(r);
      while (stack.length) {
        sizes.pop();
        p = bigMul(stack.pop()!, p);
      }
      return O.normBig(p);
    };
    O.forEach(it, (v) => {
      if (ints && O.isPyInt(v)) {
        if ((++count & 1023) === 0) O.pollInterrupt();
        const x = typeof v === "boolean" ? +v : v;
        if (typeof x === "number" && Math.abs(acc * x) <= Number.MAX_SAFE_INTEGER) acc *= x;
        else {
          push(BigInt(acc));
          acc = 1;
          if (typeof x === "number" && Math.abs(x) <= 2 ** 26) acc = x;
          else push(BigInt(x));
        }
        return;
      }
      if (ints) {
        ints = false;
        r = flush();
      }
      r = O.mul(r, v);
    });
    return ints ? flush() : r;
  };
  const prodArity = (n: number) => {
    if (n !== 1) raise(T.TypeError, `prod() takes exactly 1 positional argument (${n} given)`);
  };
  fn(m, "prod", (...pos: any[]) => (prodArity(pos.length), prod(pos[0], 1)));
  // (its count checked by itself, with CPython's message: the module's
  // arity wrapper skips it, and reads its range here)
  m.prod.$argRange = [1, 1];
  m.prod.$kw = (pos: any[], names: string[], values: any[]) => {
    prodArity(pos.length);
    let start: any = 1;
    names.forEach((k, i) => {
      if (k !== "start") raise(T.TypeError, `prod() got an unexpected keyword argument '${k}'`);
      start = values[i];
    });
    return prod(pos[0], start);
  };
  // erf, erfc and exp2 (fdlibm.ts, libm.ts), and gamma and lgamma as
  // CPython computes them (pygamma.ts), raising as CPython's do
  unary("erf", FD.erf);
  unary("erfc", FD.erfc);
  unary("exp2", glibcExp2);
  // (0, the negative integers and -inf are outside their domain; CPython 3.14's message)
  const notInteger = (v: number) => raise(T.ValueError, `expected a noninteger or positive integer, got ${floatRepr(v)}`);
  fn(m, "gamma", (x: any) => {
    const v = F(x);
    if (v === 0 || v === -Infinity || (v < 0 && Math.floor(v) === v)) notInteger(v);
    const r = PG.tgamma(v);
    if (!Number.isFinite(r) && Number.isFinite(v)) range();
    return O.mkfloat(r);
  });
  // (the C library's tgamma and lgamma, musl's and fdlibm's, which MATLAB
  // mode keeps: Octave's are the C library's)
  fn(m, "_libm_gamma", (x: any) => O.mkfloat(FD.tgamma(F(x))));
  fn(m, "_libm_lgamma", (x: any) => O.mkfloat(FD.lgamma(F(x))));
  fn(m, "lgamma", (x: any) => {
    const v = F(x);
    if (v <= 0 && v !== -Infinity && Math.floor(v) === v) notInteger(v);
    const r = PG.lgamma(v);
    if (!Number.isFinite(r) && Number.isFinite(v)) range();
    return O.mkfloat(r);
  });
  // nextafter and ulp: steps through the doubles in order (their bits, as integers ordered with the sign)
  const bitsF = new Float64Array(1), bitsI = new BigInt64Array(bitsF.buffer);
  const toOrd = (v: number): bigint => {
    bitsF[0] = v;
    const b = bitsI[0];
    return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
  };
  const fromOrd = (k: bigint): number => {
    bitsI[0] = k < 0n ? (-k) | -0x8000000000000000n : k;
    return bitsF[0];
  };
  const nextafter = (a: number, b: number, steps = 1n): number => {
    // (no steps: x itself, its zero's sign too, even toward a NaN, CORR-447-3)
    if (steps === 0n) return a;
    if (a !== a || b !== b) return a !== a ? a : b;
    if (a === b) return b;
    const ka = toOrd(a), kb = toOrd(b);
    const r = kb > ka ? (kb - ka <= steps ? kb : ka + steps) : (ka - kb <= steps ? kb : ka - steps);
    if (r === kb) return b;
    // (0 and -0 are one place in this order: a zero has a's sign, as CPython's)
    if (r === 0n) return a < 0 || Object.is(a, -0) ? -0 : 0;
    return fromOrd(r);
  };
  m.nextafter = builtin((x: any, y: any, steps: any) => {
    let n = 1n;
    if (steps !== undefined && steps !== null) {
      n = BigInt(typeof steps === "boolean" ? +steps : O.index(steps));
      if (n < 0n) raise(T.ValueError, "steps must be a non-negative integer");
    }
    return O.mkfloat(nextafter(F(x), F(y), n));
  }, "nextafter", { args: ["x", "y"], posonly: 2, vararg: null, kwonly: ["steps"], kwarg: null });
  fn(m, "ulp", (x: any) => {
    let v = F(x);
    if (v !== v) return O.mkfloat(v);
    v = Math.abs(v);
    if (v === Infinity) return O.mkfloat(v);
    const up = nextafter(v, Infinity);
    if (up === Infinity) return O.mkfloat(v - nextafter(v, -Infinity));
    return O.mkfloat(up - v);
  });
  fn(m, "dist", (p: any, q: any) => {
    const a = O.toArray(p).map(F), b = O.toArray(q).map(F);
    if (a.length !== b.length) raise(T.ValueError, "both points must have the same number of dimensions");
    return O.mkfloat(CR.hypotN(a.map((v, i) => v - b[i])));
  });
});

// ------------------------------------------------------------------ __future__

// A type's attribute as CPython's _PyType_Lookup finds it: from the type's
// own MRO and dicts, raw, with no descriptor, metaclass property or
// __getattribute__ consulted (lib/io.py's special-method lookup).
newBuiltinModule("_pyjs_types", (m) => {
  // (a lib class standing for one of CPython's C types: its messages name
  // it as that type's tp_name does, 'datetime.date', object.ts typeName)
  m.c_name = builtin((tp: any, name: any) => {
    if (typeof name !== "string" || !isType(tp)) raise(T.TypeError, "c_name(type, str)");
    (tp as any).$tpName = name;
    return null;
  }, "c_name");
  // (found, value): (False, None) when no class in the MRO has it
  m.lookup = builtin((tp: any, name: any) => {
    if (typeof name !== "string" || !isType(tp)) raise(T.TypeError, "lookup(type, str)");
    const v = lookupType(tp, name);
    return tuple(v === undefined ? [false, null] : [true, v]);
  }, "lookup");
  // (a hook's int result checked as everywhere else, O.intResult: an int; a
  // strict subclass's value with the DeprecationWarning; else TypeError)
  m.int_result = builtin((what: any, r: any) => O.intResult(String(what), r), "int_result");
});

newBuiltinModule("types", (m) => {
  m.FunctionType = m.LambdaType = T.function;
  m.MethodType = T.method;
  m.BuiltinFunctionType = m.BuiltinMethodType = T.builtin_function_or_method;
  m.GeneratorType = T.generator;
  m.CoroutineType = T.coroutine;
  m.ModuleType = T.module;
  m.NoneType = T.NoneType;
  m.NotImplementedType = T.NotImplementedType;
  m.EllipsisType = T.ellipsis;
  m.SimpleNamespace = Ty.SimpleNamespace;
  m.UnionType = Ty.unionType;
  m.GenericAlias = Ty.genericAliasType;
  m.CodeType = T.code;
  m.MappingProxyType = Ty.mappingproxy;
  m.GetSetDescriptorType = T.getset_descriptor;
  m.CellType = typeOf(Ty.newCell());
  // (CPython's own Python class, from lib/_pytypes.py; enum.py imports it)
  m.DynamicClassAttribute = importModule("_pytypes").DynamicClassAttribute;
  setattr(m.DynamicClassAttribute, "__module__", "types");
  for (const n of ["MemberDescriptorType", "WrapperDescriptorType", "MethodWrapperType", "MethodDescriptorType", "ClassMethodDescriptorType", "FrameType", "TracebackType", "AsyncGeneratorType", "CapsuleType"]) {
    m[n] = Ty.builtinTypeFor(n, class {}, "types", () => raise(T.TypeError, `cannot create '${n}' instances`));
  }
  // A generator function whose generators may be awaited.
  fn(m, "coroutine", (f: any) => {
    if (typeof f !== "function") raise(T.TypeError, "types.coroutine() expects a callable");
    const w: any = (...a: any[]) => mark(f(...a));
    const mark = (g: any) => {
      if (g !== null && typeof g === "object" && g[Symbol.toStringTag] === "Generator") g.$awaitable = true;
      return g;
    };
    w.$kw = (pos: any[], names: string[], values: any[]) => mark(callKw(f, pos, names, values));
    w.$pyfn = true;
    for (const k of ["__name__", "__qualname__", "__module__", "__doc__"]) w[k] = f[k] ?? null;
    return w;
  });
});

// ------------------------------------------------------------------ _random: MT19937 exactly as CPython

export class MT {
  mt = new Uint32Array(624);
  mti = 625;
  initGenrand(s: number) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = 624;
  }
  initByArray(key: number[]) {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1, j = 0;
    const n = 624, len = Math.max(1, key.length);
    for (let k = Math.max(n, len); k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + (key[j] ?? 0) + j) >>> 0;
      i++;
      j++;
      if (i >= n) {
        mt[0] = mt[n - 1];
        i = 1;
      }
      if (j >= len) j = 0;
    }
    for (let k = n - 1; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= n) {
        mt[0] = mt[n - 1];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
    this.mti = 624;
  }
  genrand(): number {
    const mt = this.mt;
    if (this.mti >= 624) {
      let kk = 0;
      const mag = (y: number) => (y & 1 ? 0x9908b0df : 0);
      for (; kk < 624 - 397; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ mag(y);
      }
      for (; kk < 623; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
        mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ mag(y);
      }
      const y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
      mt[623] = mt[396] ^ (y >>> 1) ^ mag(y);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  random(): number {
    const a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
  seed(x: any) {
    let v: bigint;
    // seed(None): 256 bits of os.urandom, as CPython (it was the clock)
    if (x === null || x === undefined) v = [...(require("crypto").randomBytes(32) as Uint8Array)].reduce((a, b) => (a << 8n) | BigInt(b), 0n);
    else if (O.isPyInt(x)) v = BigInt(typeof x === "boolean" ? +x : x);
    else if (typeof x === "string") v = BigInt.asUintN(64, BigInt(O.hashAny(x)));
    else v = BigInt.asUintN(64, BigInt(O.hashAny(x)));
    if (v < 0n) v = -v;
    const key: number[] = [];
    do {
      key.push(Number(v & 0xffffffffn));
      v >>= 32n;
    } while (v > 0n);
    this.initByArray(key);
  }
  getrandbits(k: number): number | bigint {
    if (k < 0) raise(T.ValueError, "number of bits must be non-negative");
    if (k === 0) return 0;
    if (k <= 32) return this.genrand() >>> (32 - k);
    let r = 0n, shift = 0n;
    for (let left = k; left > 0; left -= 32) {
      let w = this.genrand();
      if (left < 32) w >>>= 32 - left;
      r |= BigInt(w) << shift;
      shift += 32n;
    }
    return O.normBig(r);
  }
}

newBuiltinModule("_random", (m) => {
  const RandomType = Ty.builtinTypeFor("Random", MT, "_random", (x: any = undefined) => {
    const r = new MT();
    r.seed(x === undefined ? null : x);
    return r;
  });
  Ty.method(RandomType, "seed", (r: MT, x: any = null) => (r.seed(x), null));
  Ty.method(RandomType, "random", (r: MT) => O.mkfloat(r.random()));
  Ty.method(RandomType, "getrandbits", (r: MT, k: any) => r.getrandbits(Number(k)));
  Ty.method(RandomType, "getstate", (r: MT) => tuple([3, tuple([...r.mt, r.mti]), null]));
  Ty.method(RandomType, "setstate", (r: MT, st: any) => {
    const inner = O.toArray(st[1]);
    r.mt = Uint32Array.from(inner.slice(0, 624).map(Number));
    r.mti = Number(inner[624]);
    return null;
  });
  m.Random = RandomType;
});

// ------------------------------------------------------------------ _weakref, gc

// Weak references use JS WeakRef; callbacks run from a FinalizationRegistry,
// i.e. some time after the referent is collected.
export class PyWeakRef {
  w: WeakRef<any>;
  h: number | undefined;
  constructor(o: any, public cb: any) {
    this.w = new WeakRef(o);
  }
}
const weakable = (o: any) => (o !== null && typeof o === "object" && (hasInstanceDictLocal(o) || o instanceof O.PySet)) || (typeof o === "function");
const hasInstanceDictLocal = (o: any) => o.$cls !== undefined && o.$cls.$ctor !== null && !Array.isArray(o);
const registry = new FinalizationRegistry((r: PyWeakRef) => {
  if (r.cb !== null && r.cb !== undefined) {
    try {
      callObj(r.cb, [r]);
    } catch {
      // ignored, as CPython prints and ignores
    }
  }
});
newBuiltinModule("_weakref", (m) => {
  const ref = Ty.builtinTypeFor("weakref.ReferenceType", PyWeakRef, "weakref", (o: any, cb: any = null) => {
    if (!weakable(o)) raise(T.TypeError, `cannot create weak reference to '${typeName(o)}' object`);
    const r = new PyWeakRef(o, cb);
    // the registry holds r until o dies: without a callback there is nothing
    // to run, and registering would leak every temporary ref to a long-lived
    // object (WeakSet.__contains__ makes one per isinstance check on an ABC)
    if (cb !== null && cb !== undefined) registry.register(o, r);
    return r;
  });
  (ref as any).$name = "ReferenceType";
  Ty.method(ref, "__call__", (r: PyWeakRef) => r.w.deref() ?? null);
  Ty.method(ref, "__repr__", (r: PyWeakRef) => {
    const o = r.w.deref();
    return o === undefined ? `<weakref at 0x${O.id(r).toString(16)}; dead>` : `<weakref at 0x${O.id(r).toString(16)}; to '${typeName(o)}' at 0x${O.id(o).toString(16)}>`;
  });
  Ty.getset(ref, "__callback__", (r: PyWeakRef) => r.cb ?? null);
  // as in CPython: live refs compare (and hash) by their referents, so that
  // WeakSet/WeakKeyDictionary lookups with a fresh ref (abc's caches) hit
  const sameRef = (r: PyWeakRef, o: any) => {
    if (!(o instanceof PyWeakRef)) return NotImplemented;
    const a = r.w.deref(), b = o.w.deref();
    return a === undefined || b === undefined ? r === o : O.eqBool(a, b);
  };
  Ty.method(ref, "__eq__", sameRef);
  Ty.method(ref, "__ne__", (r: PyWeakRef, o: any) => {
    const v = sameRef(r, o);
    return v === NotImplemented ? v : !v;
  });
  Ty.method(ref, "__hash__", (r: PyWeakRef) => {
    if (r.h === undefined) {
      const o = r.w.deref();
      if (o === undefined) raise(T.TypeError, "weak object has gone away");
      r.h = O.hashAny(o);
    }
    return r.h;
  });
  m.ref = ref;
  m.ReferenceType = ref;
  fn(m, "getweakrefcount", (_o: any) => 0);
});
newBuiltinModule("gc", (m) => {
  let enabled = true;
  fn(m, "enable", () => ((enabled = true), null));
  fn(m, "disable", () => ((enabled = false), null));
  fn(m, "isenabled", () => enabled);
  fn(m, "collect", (_gen: any = 2) => {
    const g = (globalThis as any).gc;
    if (typeof g === "function") g();
    return 0;
  });
  fn(m, "get_count", () => tuple([0, 0, 0]));
  fn(m, "get_threshold", () => tuple([700, 10, 10]));
  fn(m, "set_threshold", (..._a: any[]) => null);
  fn(m, "is_tracked", (_o: any) => false);
  fn(m, "get_referrers", (..._a: any[]) => []);
  m.garbage = [];
  m.callbacks = [];
});

// ------------------------------------------------------------------ the working directory
// Node's worker threads (the Jupyter kernel runs Python in one) cannot chdir,
// so there os.chdir keeps a virtual working directory that relative paths
// resolve against.
let virtualCwd: string | null = null;
const cwd = (): string => virtualCwd ?? process.cwd();
const at = (p: any): any => (virtualCwd !== null && typeof p === "string" && !p.startsWith("/") ? (p === "." || p === "" ? virtualCwd : virtualCwd.replace(/\/$/, "") + "/" + p) : p);
// (open(F, M).write(S)'s native step, file-once.ts, opens the path _fs would)
export const hostPath = (p: string): string => at(p);
// (a path as this working directory resolves it: the importer's too,
// compile.ts, so that sys.path's relative entries follow os.chdir)
export const cwdPath = (p: string): string => at(p);
function chdir(p: string) {
  try {
    process.chdir(at(p));
    if (virtualCwd !== null) virtualCwd = process.cwd();
  } catch (e: any) {
    if (e?.code !== "ERR_WORKER_UNSUPPORTED_OPERATION") throw e;
    const fs = require("fs"), path = require("path");
    const d = path.resolve(cwd(), p);
    if (!fs.statSync(d).isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a directory, chdir '${p}'`), { code: "ENOTDIR", errno: -20 });
    virtualCwd = d;
  }
}

// ------------------------------------------------------------------ _fs (backs open() in lib/_pyjs_open.py)

newBuiltinModule("_fs", (m) => {
  const fs = require("fs");
  const oserr = (e: any, path: string): never => {
    if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw markRaised(callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]));
    const cls = e.code === "ENOENT" ? T.FileNotFoundError : e.code === "EISDIR" ? T.IsADirectoryError : e.code === "EACCES" ? T.PermissionError : e.code === "EEXIST" ? T.FileExistsError : T.OSError;
    throw markRaised(callObj(cls, [e.errno ? -e.errno : 0, e.code === "ENOENT" ? "No such file or directory" : String(e.message), path]));
  };
  fn(m, "read", (path: string) => {
    try {
      return new PyBytes(new Uint8Array(fs.readFileSync(at(path))));
    } catch (e: any) {
      return oserr(e, path);
    }
  });
  fn(m, "write", (path: string, data: any, append: any) => {
    try {
      const b = O.bufferOf(data)!;
      if (O.truth(append)) fs.appendFileSync(at(path), b);
      else fs.writeFileSync(at(path), b);
    } catch (e: any) {
      return oserr(e, path);
    }
    return null;
  });
  // Denied by a sandbox counts as absent, as os.path.exists does for EACCES.
  const quiet = (f: () => boolean) => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  fn(m, "exists", (path: string) => quiet(() => fs.existsSync(at(path))));
  fn(m, "isdir", (path: string) => quiet(() => fs.existsSync(at(path)) && fs.statSync(at(path)).isDirectory()));
  // (CPython's path_converter, for os.path (lib/posixpath.py): a path argument
  // of stat ("stat", allowFd), lstat ("lstat"), or posix._path_normpath and
  // _path_splitroot_ex (not strict). In its order: a str or bytes, a
  // subclass's payload taken as it is, no method of it called; else an int,
  // or an object with __index__, is a file descriptor where allowFd (the int
  // is returned, _fd_converter's OverflowError past a C int); else
  // __fspath__, looked up on the type and bound to the object as a special
  // method is, whose result must be a str or bytes; anything else is
  // fname's TypeError. Strict: a str must encode to the file system's UTF-8
  // with surrogateescape (UnicodeEncodeError), and a NUL is a ValueError.
  // The result is the exact str or bytes: astra's CORR-9C4-1, -2, -4)
  fn(m, "path", (p: any, fname: any, allowFd: any, strict: any) => {
    const name = String(fname);
    const fdOk = O.truth(allowFd);
    // (a str or bytes, a subclass's too, is a path before anything else: its
    // __index__ is never asked; astra's CORR-E51-1)
    const isPath = isinstance(p, T.str) || isinstance(p, T.bytes);
    if (fdOk && !isPath && (O.isPyInt(p) || lookupType(typeOf(p), "__index__") !== undefined)) {
      const n = O.index(p);
      if (n > 2147483647) raise(T.OverflowError, "fd is greater than maximum");
      if (n < -2147483648) raise(T.OverflowError, "fd is less than minimum");
      return Number(n);
    }
    let o = p;
    if (!isinstance(o, T.str) && !isinstance(o, T.bytes)) {
      const f = O.lookupSpecial(p, "__fspath__");
      if (f === undefined) raise(T.TypeError, `${name}: path should be string, bytes${fdOk ? ", os.PathLike or integer" : " or os.PathLike"}, not ${typeName(p)}`);
      o = f(p);
      if (!isinstance(o, T.str) && !isinstance(o, T.bytes)) raise(T.TypeError, `expected ${typeName(p)}.__fspath__() to return str or bytes, not ${typeName(o)}`);
    }
    if (isinstance(o, T.str)) {
      const s: string = typeof o === "string" ? o : unbox(o);
      if (O.truth(strict)) {
        for (let i = 0; i < s.length; i++) {
          const c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { i++; continue; }
          if (c >= 0xd800 && c <= 0xdfff && !(c >= 0xdc80 && c <= 0xdcff)) throw markRaised(callObj(T.UnicodeEncodeError, ["utf-8", s, i, i + 1, "surrogates not allowed"]));
        }
        if (s.includes("\0")) raise(T.ValueError, `${name}: embedded null character in path`);
      }
      return s;
    }
    const data = new Uint8Array(O.bufferOf(o)!);
    if (O.truth(strict) && data.includes(0)) raise(T.ValueError, `${name}: embedded null character in path`);
    return new PyBytes(data);
  });
  // (posixpath's isfile, islink and lexists, as CPython's stat and lstat
  // answer them: a regular file (a symbolic link followed); a symbolic link;
  // anything there, a dangling link included)
  fn(m, "isfile", (path: string) => quiet(() => fs.statSync(at(path)).isFile()));
  fn(m, "islink", (path: string) => quiet(() => fs.lstatSync(at(path)).isSymbolicLink()));
  fn(m, "lexists", (path: string) => quiet(() => (fs.lstatSync(at(path)), true)));
  // (this process's CPU time, all its threads, user and system apart, in
  // seconds: for tests' diagnostics, sbx's CPU ratio, shard-7 proposal r1;
  // time.process_time() is their sum)
  fn(m, "cpu_times", () => {
    const u = process.cpuUsage();
    return tuple([O.mkfloat(u.user / 1e6), O.mkfloat(u.system / 1e6)]);
  });
});

// ------------------------------------------------------------------ os

newBuiltinModule("os", (m) => {
  const fs = require("fs");
  const nodeOs = require("os");
  const oserr = (e: any, path: any): never => {
    if (e?.name === "NotCapable" || e?.name === "PermissionDenied" || e?.code === "ERR_ACCESS_DENIED") throw markRaised(callObj(T.PermissionError, [13, String(e.message).split("\n")[0], path]));
    const cls = e.code === "ENOENT" ? T.FileNotFoundError : e.code === "EEXIST" ? T.FileExistsError : e.code === "EACCES" || e.code === "EPERM" ? T.PermissionError : e.code === "EISDIR" ? T.IsADirectoryError : e.code === "ENOTDIR" ? T.NotADirectoryError ?? T.OSError : T.OSError;
    throw markRaised(callObj(cls, [e.errno ? -e.errno : 0, String(e.message).replace(/^[A-Z]+: /, "").replace(/, .*$/, ""), path]));
  };
  const wrap = (name: string, f: (...a: any[]) => any) =>
    fn(m, name, (...a: any[]) => {
      try {
        return f(...a);
      } catch (e: any) {
        if (e && e.code && e.errno !== undefined) return oserr(e, a[0]);
        throw e;
      }
    });
  m.name = "posix";
  m.sep = "/";
  m.altsep = null;
  m.extsep = ".";
  m.pathsep = ":";
  m.linesep = "\n";
  m.curdir = ".";
  m.pardir = "..";
  m.devnull = "/dev/null";
  const env = new PyDict();
  try {
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) dictSet(env, k, v);
  } catch {
    // environment access denied (sandboxed runtime): os.environ is empty
  }
  m.environ = env;
  fn(m, "getenv", (k: string, d: any = null) => dictGet(env, k) ?? d);
  wrap("getcwd", () => cwd());
  wrap("chdir", (p: string) => (chdir(p), null));
  wrap("listdir", (p: string = ".") => fs.readdirSync(at(p)));
  wrap("mkdir", (p: string, _mode: any = 0o777) => (fs.mkdirSync(at(p)), null));
  wrap("makedirs", (p: string, _mode: any = 0o777, exist_ok: any = false) => {
    if (fs.existsSync(at(p)) && !O.truth(exist_ok)) fs.mkdirSync(at(p));
    fs.mkdirSync(at(p), { recursive: true });
    return null;
  });
  m.makedirs.$sig = { args: ["name", "mode", "exist_ok"], posonly: 0, vararg: null, kwonly: [], kwarg: null };
  wrap("remove", (p: string) => (fs.unlinkSync(at(p)), null));
  wrap("unlink", (p: string) => (fs.unlinkSync(at(p)), null));
  wrap("rmdir", (p: string) => (fs.rmdirSync(at(p)), null));
  wrap("rename", (a: string, b: string) => (fs.renameSync(at(a), at(b)), null));
  wrap("replace", (a: string, b: string) => (fs.renameSync(at(a), at(b)), null));
  wrap("stat", (p: string) => {
    const s = fs.statSync(at(p));
    return Ty.structseq("os.stat_result", ["st_mode", "st_ino", "st_dev", "st_nlink", "st_uid", "st_gid", "st_size", "st_atime", "st_mtime", "st_ctime"], [s.mode, s.ino, s.dev, s.nlink, s.uid, s.gid, s.size, O.mkfloat(s.atimeMs / 1000), O.mkfloat(s.mtimeMs / 1000), O.mkfloat(s.ctimeMs / 1000)]);
  });
  fn(m, "uname", () => Ty.structseq("posix.uname_result", ["sysname", "nodename", "release", "version", "machine"], [nodeOs.type(), nodeOs.hostname(), nodeOs.release(), String(nodeOs.version?.() ?? ""), nodeOs.machine?.() ?? nodeOs.arch()]));
  fn(m, "getpid", () => process.pid);
  fn(m, "cpu_count", () => nodeOs.cpus().length);
  fn(m, "urandom", (n: any) => new PyBytes(new Uint8Array(require("crypto").randomBytes(Number(n)))));
  fn(m, "fspath", (p: any) => {
    // (a str or bytes, subclasses included, as it is; a bytearray is neither)
    if (isinstance(p, T.str) || isinstance(p, T.bytes)) return p;
    // (looked up on the type and bound to the object once, as a special
    // method is: astra's CORR-9C4-2)
    const f = O.lookupSpecial(p, "__fspath__");
    if (f === undefined) raise(T.TypeError, `expected str, bytes or os.PathLike object, not ${typeName(p)}`);
    // (what __fspath__ returns must be a str or bytes, subclasses included)
    const r = f(p);
    if (!isinstance(r, T.str) && !isinstance(r, T.bytes)) raise(T.TypeError, `expected ${typeName(p)}.__fspath__() to return str or bytes, not ${typeName(r)}`);
    return r;
  });
  m.path = importModule("posixpath");
  dictSet(sysModules, "os.path", m.path);
});

builtin(defaultImport, "__import__", { args: ["name", "globals", "locals", "fromlist", "level"], posonly: 0, vararg: null, kwonly: [], kwarg: null });
builtins.__import__ = defaultImport;

hooks.importModule = importModule;
