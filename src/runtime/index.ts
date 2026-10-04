// The runtime object handed to compiled modules, plus function creation and
// tracebacks.

import * as Obj from "./object";
import * as O from "./ops";
import * as F from "./format";
import * as Ty from "./types";
import * as B from "./builtins";
import * as M from "./modules";
import * as Arr from "./array";
import "./struct";
import "./memoryview";

O.arrayHooks.cls = Arr.PyArray;
O.arrayHooks.get = Arr.arrayGetitem;
O.arrayHooks.set = Arr.arraySetitem;

const { T, raise, tuple, bindArgs, typeName } = Obj;

Error.stackTraceLimit = 200;

// ------------------------------------------------------------------ functions

// Create a Python function from a compiled implementation.  Simple
// signatures (positional parameters with optional defaults) call the
// implementation directly; others go through a binding wrapper.
export function defn(impl: any, name: string, qualname: string, module: string, defaults: any[] | null, kwdefaults: Obj.PyDict | null, sig: Obj.Signature, doc: any, g?: any): any {
  const simple = sig.vararg === null && sig.kwarg === null && sig.kwonly.length === 0;
  let f = impl;
  if (!simple) {
    f = function (...a: any[]) {
      return impl(...bindArgs(f.__name__, sig, a, [], []));
    };
    f.$kw = (pos: any[], names: string[], values: any[]) => impl(...bindArgs(f.__name__, sig, pos, names, values));
    impl.$public = f;
  }
  f.$pyfn = true;
  f.$sig = sig;
  f.__name__ = name;
  f.__qualname__ = qualname;
  f.__module__ = module;
  f.__doc__ = doc;
  f.__defaults__ = defaults === null ? null : tuple(defaults);
  f.__kwdefaults__ = kwdefaults;
  f.$globals = g;
  // Generator and coroutine objects find their function's name through
  // their prototype (the generator function's `prototype`).
  if (impl.prototype !== undefined && Object.getPrototypeOf(impl) === GeneratorFunctionProto) impl.prototype.$fn = f;
  return f;
}
const GeneratorFunctionProto = Object.getPrototypeOf(function* () {});

// `async def`: generators of this function are coroutines.
export function markCoro(impl: any): any {
  impl.prototype.$cls = T.coroutine;
  return impl;
}

// `await x`: the iterator a JS yield* delegates to.
export function awaitIter(x: any): any {
  if (x !== null && typeof x === "object" && x[Symbol.toStringTag] === "Generator") {
    if (x.$cls === T.coroutine || x.$awaitable === true) {
      if (x.$awaiting === true) raise(T.RuntimeError, "coroutine is being awaited already");
      return x;
    }
    raise(T.TypeError, "'generator' object can't be awaited");
  }
  const f = Ty.lookupDunder(x, "__await__");
  if (f === undefined) raise(T.TypeError, `'${typeName(x)}' object can't be awaited`);
  const it = f(x);
  if (it instanceof Ty.CoroWrapper) return it.g;
  if (it !== null && typeof it === "object" && it[Symbol.toStringTag] === "Generator") {
    if (it.$cls === T.coroutine) raise(T.TypeError, "__await__() returned a coroutine");
    return it;
  }
  if (Ty.lookupDunder(it, "__next__") === undefined && !(it !== null && typeof it === "object" && typeof it.$next === "function")) raise(T.TypeError, `__await__() returned non-iterator of type '${typeName(it)}'`);
  return yieldFrom(it);
}


// Default for parameter `i` of `nargs` when the caller omitted it.
export function dflt(f: any, i: number, nargs: number, name: string): any {
  const d = (f.$public ?? f).__defaults__;
  const j = i - (nargs - (d === null ? 0 : d.length));
  if (d === null || j < 0) Obj.missingArg(f.$public ?? f, name);
  return d[j];
}
export function kwdflt(f: any, name: string): any {
  const d = (f.$public ?? f).__kwdefaults__;
  const v = d === null ? undefined : Obj.dictGet(d, name);
  if (v === undefined) Obj.missingArg(f.$public ?? f, name, true);
  return v;
}

// ------------------------------------------------------------------ calls with *args / **kwargs

// Merge a call's keyword pieces: names/values for k=v, and mappings for **m.
export function kwMerge(names: string[], values: any[], mapping: any): void {
  if (mapping instanceof Obj.PyDict) {
    for (const [k, v] of mapping.$m) {
      const key = Obj.dictKeyOf(mapping, k);
      if (typeof key !== "string") raise(T.TypeError, "keywords must be strings");
      if (names.includes(key)) raise(T.TypeError, `got multiple values for keyword argument '${key}'`);
      names.push(key);
      values.push(v);
    }
    return;
  }
  const keys = Ty.lookupDunder(mapping, "keys");
  if (keys === undefined) raise(T.TypeError, `argument after ** must be a mapping, not ${typeName(mapping)}`);
  O.forEach(keys(mapping), (k) => {
    names.push(k);
    values.push(O.getitem(mapping, k));
  });
}

export function callEx(f: any, pos: any[], names: string[], values: any[], maps: any[]): any {
  for (const m of maps) kwMerge(names, values, m);
  return Obj.callKw(f, pos, names, values);
}

export function dictOf(...kv: any[]): Obj.PyDict {
  const d = new Obj.PyDict();
  for (let i = 0; i < kv.length; i += 2) Obj.dictSet(d, kv[i], kv[i + 1]);
  return d;
}

// `yield from x`: a JS iterable delegating to x.  Generators delegate
// natively; anything else gets an adaptor that forwards send() and throw()
// and turns StopIteration(value) into the result of the `yield from`.
export function yieldFrom(x: any): any {
  if (Array.isArray(x) && (x as any).$cls === undefined) return x;
  const it = O.iter(x);
  if (it instanceof O.GenIter) return it.g;
  const target = it instanceof O.ProtoIter ? it.o : it;
  const stop = (e: any) => ({ done: true, value: e.args?.length ? e.args[0] : null });
  const step = (f: () => any) => {
    try {
      return { done: false, value: f() };
    } catch (e: any) {
      if (Obj.isinstance(e, T.StopIteration)) return stop(e);
      throw e;
    }
  };
  const adaptor = {
    [Symbol.iterator]() {
      return adaptor;
    },
    next(v: any) {
      if (v !== undefined && v !== null) return step(() => Obj.callObj(Obj.getattr(target, "send"), [v]));
      if (it instanceof O.ProtoIter) return step(() => it.nx(it.o));
      return step(() => {
        O.lastStop.e = null;
        const r = it.$next();
        if (r === Obj.DONE) throw O.lastStop.e ?? T.StopIteration();
        return r;
      });
    },
    throw(e: any) {
      if (Obj.isinstance(e, T.GeneratorExit)) {
        const c = Obj.getattr(target, "close", null);
        if (c !== null) Obj.callObj(c, []);
        throw e;
      }
      const t = Obj.getattr(target, "throw", null);
      // CPython's CLEANUP_THROW: a StopIteration thrown in at a `yield from`
      // ends it with that value.
      if (t === null && Obj.isinstance(e, T.StopIteration)) return stop(e);
      if (t === null) throw e;
      return step(() => Obj.callObj(t, [e]));
    },
    return(v: any) {
      const c = Obj.getattr(target, "close", null);
      if (c !== null) Obj.callObj(c, []);
      return { done: true, value: v };
    },
  };
  return adaptor;
}

// The value of a `yield from` that delegated natively with yield*.  When the
// delegating generator is being closed and the inner one swallowed the
// GeneratorExit and returned, CPython still raises GeneratorExit here.
export function yfr(v: any): any {
  if (O.closing.e !== null) throw O.closing.e;
  return v ?? null;
}

export function withEnter(m: any): any {
  const f = Ty.lookupDunder(m, "__enter__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the context manager protocol`);
  return f(m);
}
export function withExit(m: any): (t: any, v: any, tb: any) => any {
  const f = Ty.lookupDunder(m, "__exit__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the context manager protocol (missed __exit__ method)`);
  return (t, v, tb) => f(m, t, v, tb);
}

export function reraise(): any {
  return Obj.newException(T.RuntimeError, ["No active exception to reraise"]);
}

// ------------------------------------------------------------------ globals, locals, exec, eval

export function sortedKeys(d: Obj.PyDict): string[] {
  return O.toArray(d).sort();
}

export function localsDict(names: string[], values: any[]): Obj.PyDict {
  const d = new Obj.PyDict();
  names.forEach((n, i) => {
    if (values[i] !== undefined) Obj.dictSet(d, n, values[i]);
  });
  return d;
}

// The namespace exec/eval code runs in: explicit globals (and locals), or
// the caller's module plus, inside a function, a snapshot of its locals.
function execNamespace(globals: any, locals: any, g: any, callerLocals: any): any {
  if (locals !== undefined && locals !== null && !(locals instanceof Obj.PyDict) && Ty.lookupDunder(locals, "__getitem__") === undefined) raise(T.TypeError, `locals must be a mapping or None, not ${typeName(locals)}`);
  if (globals !== undefined && globals !== null) {
    if (!(globals instanceof Obj.PyDict)) raise(T.TypeError, `globals must be a dict, not ${typeName(globals)}`);
    if (Obj.dictGet(globals, "__builtins__") === undefined) Obj.dictSet(globals, "__builtins__", B.builtins);
    const ns = Obj.namespaceOf(globals);
    return locals !== undefined && locals !== null && locals !== globals ? layered(Obj.namespaceOf(locals), ns) : ns;
  }
  if (g === null || g === undefined) g = Obj.dictGet(M.sysModules, "__main__") ?? Ty.newModule("__main__");
  if (locals !== undefined && locals !== null) return layered(Obj.namespaceOf(locals), g);
  if (callerLocals !== null && callerLocals !== undefined) return layered(Obj.namespaceOf(callerLocals), g);
  return g;
}
// Reads see `front` then `back`; writes go to `front`.
function layered(front: any, back: any): any {
  return new Proxy(Object.create(null), {
    get: (_t, k) => (k === Obj.NS_GLOBALS ? back : k in front && front[k] !== undefined ? front[k] : back[k]),
    set: (_t, k, v) => ((front[k] = v), true),
    has: (_t, k) => k in front || k in back,
    deleteProperty: (_t, k) => (delete front[k], true),
    ownKeys: () => [...new Set([...Reflect.ownKeys(front), ...Reflect.ownKeys(back)])],
    getOwnPropertyDescriptor: (_t, k) => {
      const v = k in front && front[k] !== undefined ? front[k] : back[k];
      return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
}

export class CodeObject {
  constructor(public src: string, public filename: string, public mode: string) {}
}
const codeType = Ty.builtinTypeFor("code", CodeObject, "builtins", () => raise(T.TypeError, "cannot create 'code' objects"));
Ty.getset(codeType, "co_filename", (c) => c.filename);
Ty.getset(codeType, "co_name", () => "<module>");

function sourceOf(src: any, fn: string): [string, string] {
  if (src instanceof CodeObject) return [src.src, src.filename];
  if (src instanceof Obj.PyBytes) return [Ty.decode(src), "<string>"];
  const buf = O.bufferOf(src);
  if (buf !== undefined) return [Ty.decode(new Obj.PyBytes(buf.slice())), "<string>"];
  if (typeof src !== "string") raise(T.TypeError, `${fn}() arg 1 must be a string, bytes or code object`);
  return [src, "<string>"];
}

export function execIn(src: any, globals: any, locals: any, g: any, callerLocals: any): any {
  const [text, filename] = sourceOf(src, "exec");
  M.loader.exec(text, execNamespace(globals, locals, g, callerLocals), src instanceof CodeObject && src.mode === "single" ? "single" : "exec", filename);
  return null;
}
export function evalIn(src: any, globals: any, locals: any, g: any, callerLocals: any): any {
  if (src instanceof CodeObject && src.mode === "exec") return execIn(src, globals, locals, g, callerLocals);
  const [text, filename] = sourceOf(src, "eval");
  return M.loader.exec(text.replace(/^[ \t]+/, ""), execNamespace(globals, locals, g, callerLocals), "eval", filename);
}
function compileBuiltin(src: any, filename: any, mode: any): CodeObject {
  const [text] = sourceOf(src, "compile");
  if (mode !== "exec" && mode !== "eval" && mode !== "single") raise(T.ValueError, "compile() mode must be 'exec', 'eval' or 'single'");
  M.loader.exec(text, null, mode === "eval" ? "check-eval" : "check", String(filename));
  return new CodeObject(text, String(filename), mode);
}
Obj.builtin(compileBuiltin, "compile");
B.builtins.compile = compileBuiltin;
B.builtins.open = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_open"), "open"), a), "open");
B.builtins.open.$kw = (pos: any[], names: string[], values: any[]) => Obj.callKw(Obj.getattr(M.importModule("_pyjs_open"), "open"), pos, names, values);
B.builtins.__pyjs_displayhook__ = Obj.builtin((v: any) => {
  if (v !== null) {
    B.builtins._ = v;
    B.stdout.write(F.repr(v) + "\n");
  }
  return null;
}, "displayhook");
B.builtins.exec = Obj.builtin((src: any, gl: any = undefined, lo: any = undefined) => execIn(src, gl ?? null, lo, null, null), "exec");
B.builtins.eval = Obj.builtin((src: any, gl: any = undefined, lo: any = undefined) => evalIn(src, gl ?? null, lo, null, null), "eval");
B.builtins.globals = Obj.builtin(() => raise(T.RuntimeError, "globals() called indirectly is not supported"), "globals");
B.builtins.locals = Obj.builtin(() => raise(T.RuntimeError, "locals() called indirectly is not supported"), "locals");

// ------------------------------------------------------------------ classes

export function classDef(name: string, qualname: string, module: string, bases: any[], ns: Map<string, any>, kwNames: string[], kwValues: any[]): any {
  return Ty.makeClass(name, bases, ns, module, qualname, kwNames, kwValues);
}

// ------------------------------------------------------------------ tracebacks

export interface ScriptInfo {
  filename: string;
  lines: string[]; // Python source lines
  lineMap: number[]; // JS line (1-based) -> Python line
}
export const scripts = new Map<string, ScriptInfo>();

interface Frame {
  file: string;
  line: number;
  name: string;
  text: string;
}

function framesOf(e: any): Frame[] {
  const holder = e.$tb;
  if (holder === undefined) return [];
  const prev = (Error as any).prepareStackTrace;
  (Error as any).prepareStackTrace = (_: any, cs: any[]) => cs;
  let sites: any;
  try {
    sites = holder.stack;
  } finally {
    (Error as any).prepareStackTrace = prev;
  }
  if (!Array.isArray(sites)) return [];
  const frames: Frame[] = [];
  for (const cs of sites) {
    const info = scripts.get(cs.getFileName?.() ?? "");
    if (info === undefined) continue;
    const pyLine = info.lineMap[cs.getLineNumber()] ?? 0;
    let name = String(cs.getFunctionName() ?? "");
    name = name.endsWith("$$") ? name.slice(0, -2) : name === "module$$" || name === "" ? "<module>" : name;
    if (name === "module") name = "<module>";
    frames.push({ file: info.filename, line: pyLine, name, text: (info.lines[pyLine - 1] ?? "").trim() });
  }
  return frames.reverse();
}

function formatOne(e: any): string {
  let out = "";
  const frames = framesOf(e);
  if (frames.length) {
    out += "Traceback (most recent call last):\n";
    for (const f of frames) {
      out += `  File "${f.file}", line ${f.line}, in ${f.name}\n`;
      if (f.text) out += `    ${f.text}\n`;
    }
  }
  const t = Obj.typeOf(e);
  let msg: string;
  try {
    msg = F.str(e);
  } catch {
    msg = "<exception str() failed>";
  }
  const mod = t.$module === "builtins" || t.$module === "__main__" ? "" : t.$module + ".";
  out += `${mod}${t.$qualname}${msg ? ": " + msg : ""}\n`;
  return out;
}

export function formatException(e: any): string {
  const parts: string[] = [];
  const seen = new Set<any>();
  let cur = e;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    parts.unshift(formatOne(cur));
    if (cur.__cause__ !== null && cur.__cause__ !== undefined) {
      parts.unshift("\nThe above exception was the direct cause of the following exception:\n\n");
      cur = cur.__cause__;
    } else if (cur.__context__ !== null && cur.__context__ !== undefined && cur.__suppress_context__ !== true) {
      parts.unshift("\nDuring handling of the above exception, another exception occurred:\n\n");
      cur = cur.__context__;
    } else break;
  }
  return parts.join("");
}

// ------------------------------------------------------------------ the runtime object

export const R: any = {
  ...O,
  ...F,
  T,
  FloatBox: Obj.FloatBox,
  PyDict: Obj.PyDict,
  DONE: Obj.DONE,
  NotImplemented: Obj.NotImplemented,
  Ellipsis: Obj.Ellipsis,
  tuple,
  raise,
  raiseExc: Obj.raiseExc,
  toPyExc: Obj.toPyExc,
  excMatch: Obj.excMatch,
  getattr: Obj.getattr,
  setattr: Obj.setattr,
  delattr: Obj.delattr,
  siteGet: Obj.siteGet,
  siteSet: Obj.siteSet,
  siteCall: Obj.siteCall,
  callObj: Obj.callObj,
  callKw: Obj.callKw,
  tooManyArgs: Obj.tooManyArgs,
  missingArg: Obj.missingArg,
  dictSet: Obj.dictSet,
  newDict: Obj.newDict,
  typeOf: Obj.typeOf,
  superOf: Ty.superOf,
  makeRange: Ty.makeRange,
  PyRange: Ty.PyRange,
  defn,
  globalsDict: Obj.globalsDict,
  localsDict,
  sortedKeys,
  execIn,
  evalIn,
  callEx,
  dictOf,
  yieldFrom,
  yfr,
  markCoro,
  awaitIter,
  withEnter,
  withExit,
  reraise,
  PyBytes: Obj.PyBytes,
  dflt,
  kwdflt,
  kwMerge,
  classDef,
  builtins: B.builtins,
  gname: B.gname,
  unboundLocal: B.unboundLocal,
  unboundFree: B.unboundFree,
  stdout: B.stdout,
  stderr: B.stderr,
  importModule: M.importModule,
  importTop: M.importTop,
  importFrom: M.importFrom,
  importStar: M.importStar,
  resolveRelative: M.resolveRelative,
  sysModules: M.sysModules,
  loader: M.loader,
  newModule: Ty.newModule,
  formatException,
  scripts,
};
