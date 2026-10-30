// The runtime object handed to compiled modules, plus function creation and
// tracebacks.

import { INTR, consumeCtrlC } from "./interrupt";
import * as Obj from "./object";
import * as O from "./ops";
import * as F from "./format";
import * as Ty from "./types";
import * as B from "./builtins";
import * as M from "./modules";
import * as Arr from "./array";
import "./struct";
import "./zlib";
import "./json";
import "./memoryview";
import "./re";
import "./numpy";
import "./numpy_random";
import "./numpy_linalg";
import "./numpy_fft";
import "./engine";
import "./progress-module";
import * as Prog from "./progress";
import "./raster";
import * as Cx from "./complex";
import * as FO from "./file-once";
O.complexHooks.pow = Cx.complexPow;

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
    f.$kwPos = true; // (bindArgs checks the count and makes *args one tuple: BIG_CALL)
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
      return O.delegateTo(x);
    }
    raise(T.TypeError, "'generator' object can't be awaited");
  }
  const f = Ty.lookupDunder(x, "__await__");
  if (f === undefined) raise(T.TypeError, `'${typeName(x)}' object can't be awaited`);
  const it = f(x);
  if (it instanceof Ty.CoroWrapper) return O.delegateTo(it.g);
  if (it !== null && typeof it === "object" && it[Symbol.toStringTag] === "Generator") {
    if (it.$cls === T.coroutine) raise(T.TypeError, "__await__() returned a coroutine");
    return O.delegateTo(it);
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

// CPython's _PyObject_FunctionStr, which names the callee in keyword errors:
// "module.qualname()", or "qualname()" for a builtin's
function funcStr(f: any): string {
  let qual: any, mod: any;
  try {
    qual = Obj.getattr(f, "__qualname__", null);
    mod = Obj.getattr(f, "__module__", null);
  } catch {
    qual = null;
  }
  if (typeof qual !== "string") return typeName(f) + " object";
  return typeof mod === "string" && mod !== "builtins" ? `${mod}.${qual}()` : `${qual}()`;
}

// Merge a call's keyword pieces: names/values for k=v, and mappings for **m,
// as CPython's DICT_MERGE: a name given twice, also by a mapping that is not
// a dict, is a TypeError, keys must be strings, and a KeyError from the
// mapping's __getitem__ reads as a name given twice (format_kwargs_error).
export function kwMerge(names: string[], values: any[], mapping: any, f?: any): void {
  const who = () => (f === undefined ? "" : funcStr(f) + " ");
  const twice = (key: string) => raise(T.TypeError, `${who()}got multiple values for keyword argument '${key}'`);
  if (mapping instanceof Obj.PyDict) {
    for (const [k, v] of mapping.$m) {
      const key = Obj.dictKeyOf(mapping, k);
      if (typeof key !== "string") raise(T.TypeError, "keywords must be strings");
      if (names.includes(key)) twice(key);
      names.push(key);
      values.push(v);
    }
    return;
  }
  const keys = Ty.lookupDunder(mapping, "keys");
  if (keys === undefined) raise(T.TypeError, `${who()}argument after ** must be a mapping, not ${typeName(mapping)}`);
  O.forEach(keys(mapping), (k) => {
    // (a name given twice is refused before its value is fetched, as
    // CPython's dict_merge; a key that is not a string, after)
    if (typeof k === "string" && names.includes(k)) twice(k);
    let v: any;
    try {
      v = O.getitem(mapping, k);
    } catch (e: any) {
      const x = Obj.toPyExc(e);
      if (!Obj.isinstance(x, T.KeyError)) throw e;
      const args = Obj.getattr(x, "args", null);
      const a = Array.isArray(args) && args.length === 1 ? args[0] : undefined;
      if (a === undefined) throw e;
      if (typeof a !== "string") raise(T.TypeError, "keywords must be strings");
      twice(a);
    }
    if (typeof k !== "string") raise(T.TypeError, "keywords must be strings");
    if (names.includes(k)) twice(k);
    names.push(k);
    values.push(v);
  });
}

export function callEx(f: any, pos: any[], names: string[], values: any[], maps: any[]): any {
  for (const m of maps) kwMerge(names, values, m, f);
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
  if (it instanceof O.GenIter) return O.delegateTo(it.g);
  const target = it instanceof O.ProtoIter ? it.o : it;
  const stop = (e: any) => ({ done: true, value: e.args?.length ? e.args[0] : null });
  const step = (f: () => any) => {
    try {
      return { done: false, value: f() };
    } catch (e: any) {
      adaptor.live = false;
      if (Obj.isinstance(e, T.StopIteration)) return stop(e);
      throw e;
    }
  };
  const adaptor: any = {
    live: true,
    [Symbol.iterator]() {
      return adaptor;
    },
    next(v: any) {
      if (v !== undefined && v !== null) return step(() => Obj.callObj(Obj.getattr(target, "send"), [v]));
      if (it instanceof O.ProtoIter) return step(() => it.nx(it.o));
      return step(() => {
        O.lastStop.e = null;
        const r = it.$next();
        if (r === Obj.DONE) throw O.lastStop.e ?? Obj.markRaised(T.StopIteration());
        return r;
      });
    },
    throw(e: any) {
      // generator.throw(typ, val): a delegate's own throw() gets the
      // arguments unchanged, as in CPython.
      const raw = e?.$rawThrow;
      if (raw !== undefined) {
        const t0 = Obj.getattr(target, "throw", null);
        if (t0 !== null) return step(() => Obj.callObj(t0, raw));
        if (raw.invalid) throw Obj.markRaised(Obj.T.TypeError(raw.invalid));
      }
      if (Obj.isinstance(e, T.GeneratorExit)) {
        const c = Obj.getattr(target, "close", null);
        if (c !== null) Obj.callObj(c, []);
        throw e;
      }
      const t = Obj.getattr(target, "throw", null);
      // CPython's CLEANUP_THROW: a StopIteration thrown in at a `yield from`
      // ends it with that value.
      if (t === null) adaptor.live = false;
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

// A bare `raise` outside any except clause of its own function: the
// exception being handled, as in CPython, if a caller is handling one.
// A bare `raise`. The exception's traceback, from the frame that caught it,
// goes on outward from the frame re-raising it, as CPython's: its frames now
// are the stack's at the raise, but for the frame re-raising it, which
// CPython doesn't add (in a helper the handler calls too), then those it had
// from where it was caught in. (A generator resumed elsewhere since the
// catch has new callers.) Where the frames it had can't be told, it keeps
// its stack, as before.
export function reraise(): any {
  const e = Obj.currentExc();
  if (e === null) return Obj.newException(T.RuntimeError, ["No active exception to reraise"]);
  if (e.$tb !== undefined && e.$caught !== undefined && e.$caught.tb === e.$tb) {
    let inner: Frame[] | null = null;
    try {
      inner = caughtFrames(e);
    } catch {}
    if (inner !== null) {
      const tb: any = {};
      Error.captureStackTrace(tb, reraise);
      setFrames(e, tb, inner, true, null);
    }
  }
  return e;
}

// An exception's frames from now on: the stack's (tb, captured) outside,
// without its innermost frame if `drop` (the one re-raising it), then
// `inner`; kept to the stack limit's frames, its innermost: past it, or
// with the stack itself cut, the record is cut, and format_exc refuses
// rather than show part of it (HARD-96A-1). A refusal's reason, `why`,
// when its frames can't be known at all.
function setFrames(e: any, tb: any, inner: Frame[], drop: boolean, why: string | null): void {
  const sites = sitesOf(tb);
  const now = pyFrames(sites);
  let frames = (drop ? now.slice(0, -1) : now).concat(inner);
  const max = Error.stackTraceLimit;
  // (frames that can't be known are no less cut)
  let cut = sites.length >= max || why !== null;
  if (frames.length > max) {
    frames = frames.slice(frames.length - max);
    cut = true;
  }
  Object.defineProperty(e, "$tb", { value: tb, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(e, "$reraised", { value: { tb, frames, cut, why }, writable: true, enumerable: false, configurable: true });
}

// A generator resuming, with an exception it is handling (an except clause
// or a finally it paused in): its traceback's outer frames are its new
// callers', from here, as CPython's tb chain when it propagates on (by
// itself, after a finally or an unmatched except, or re-raised): the
// frames it had from the generator in, after the stack now; and the
// generator stays the frame that caught it (CORR-6AF-2). Where its frames
// can't be told, they are refused from now on, never left stale.
Obj.hooks.excResumed = (e: any) => {
  if (e === null || typeof e !== "object" || e.$tb === undefined) return;
  const c = e.$caught;
  let inner: Frame[] | null = null;
  let why: string | null = null;
  try {
    inner = caughtFrames(e);
  } catch (x: any) {
    why = c === undefined ? "it was not caught since it was raised" : String(Obj.toPyExc(x).args?.[0] ?? "").replace(/^which frame caught this exception is unknown: /, "");
  }
  const tb: any = {};
  Error.captureStackTrace(tb);
  setFrames(e, tb, inner ?? [], false, inner === null ? why : null);
  if (inner !== null && inner.length) Object.defineProperty(e, "$caught", { value: { tb, frame: inner[0] }, writable: true, enumerable: false, configurable: true });
  else if (c !== undefined) c.tb = tb;
};
// A StopIteration the generator's frame let out (PEP 479 makes it the
// cause of a RuntimeError): the runtime caught it, as the generator's frame
// ended, so its traceback is the frames from the generator's in, the
// generator's being the one after the stack here (CORR-581-1). Where that
// can't be told, it stays refused, as any the runtime caught.
Obj.hooks.genRaised = (e: any) => {
  if (e === null || typeof e !== "object" || e.$tb === undefined) return;
  const { frames, cut } = raisedFrames(e);
  if (cut) return;
  const here: any = {};
  Error.captureStackTrace(here);
  const sites = sitesOf(here);
  if (sites.length >= Error.stackTraceLimit) return;
  const now = pyFrames(sites);
  const gen = frames[now.length];
  if (gen === undefined || (now.length && frames[now.length - 1].fn !== now[now.length - 1].fn)) return;
  Object.defineProperty(e, "$caught", { value: { tb: e.$tb, frame: gen }, writable: true, enumerable: false, configurable: true });
};
// An exception thrown into a generator (throw(), close()'s GeneratorExit)
// is raised at the generator's yield, whose line isn't known here: its
// frames are refused from now on, never the stale ones it had.
Obj.hooks.excThrown = (e: any) => {
  if (e === null || typeof e !== "object" || e.$cls === undefined) return;
  Obj.markRaised(e);
  const tb: any = {};
  Error.captureStackTrace(tb);
  setFrames(e, tb, [], false, "it was thrown into a generator, at a yield whose line is not kept");
};

// ------------------------------------------------------------------ globals, locals, exec, eval

export function sortedKeys(d: any): any[] {
  if (Obj.typeOf(d) === T.dict) return O.toArray(d).sort();
  const a = mappingKeys(d);
  Ty.sortList(a, null, false);
  return a;
}
// dir() over exec's locals mapping: its keys(), as CPython's PyMapping_Keys,
// read one at a time against a budget of the list CPython would build (a
// repeated key counts each time): past it, a MemoryError, never the heap
// running out (HARD-5F6-1)
function mappingKeys(d: any): any[] {
  const ks = Obj.callObj(Obj.getattr(d, "keys"), []);
  if (Ty.lookupDunder(ks, "__iter__") === undefined && Ty.lookupDunder(ks, "__getitem__") === undefined) raise(T.TypeError, `${typeName(d)}.keys() returned a non-iterable (type ${typeName(ks)})`);
  // (bytes: a list slot and an object's header per key, a string's chars)
  const budget = M.heapLimit() / 8;
  let work = 0;
  const a: any[] = [];
  const it = O.iter(ks);
  for (let v = it.$next(); v !== Obj.DONE; v = it.$next()) {
    work += 64 + (typeof v === "string" ? 2 * v.length : 0);
    if (work > budget) raise(T.MemoryError, `${typeName(d)}.keys() is too long to list`);
    a.push(v);
  }
  return a;
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
function execNamespace(globals: any, locals: any, g: any, callerLocals: any, bl?: any): any {
  if (locals !== undefined && locals !== null && !(locals instanceof Obj.PyDict) && Ty.lookupDunder(locals, "__getitem__") === undefined) raise(T.TypeError, `locals must be a mapping or None, not ${typeName(locals)}`);
  if (globals !== undefined && globals !== null) {
    if (!(globals instanceof Obj.PyDict)) raise(T.TypeError, `globals must be a dict, not ${typeName(globals)}`);
    // (as CPython's exec/eval: the builtins module's dict, not the module)
    // (the calling code's builtins, CPython's frame builtins, CORR-6C9-2)
    if (Obj.dictGet(globals, "__builtins__") === undefined) Obj.dictSet(globals, "__builtins__", M.builtinsObject(bl));
    const ns = Obj.namespaceOf(globals);
    if (locals !== undefined && locals !== null && locals !== globals) return layered(localsNamespace(locals), ns);
    // (a dict subclass as both: its own methods for the names, as locals,
    // and its storage behind them, as LOAD_NAME's globals, CORR-FBF-2)
    return Obj.typeOf(globals) === T.dict ? ns : layered(mappingNamespace(globals), ns);
  }
  if (g === null || g === undefined) g = Obj.dictGet(M.sysModules, "__main__") ?? Ty.newModule("__main__");
  // (explicit locals over the real globals: an exec inside exec's top level
  // reads its locals, then the globals, never the outer locals, CORR-C0F-3)
  if (locals !== undefined && locals !== null) return layered(localsNamespace(locals), Obj.realGlobals(g));
  // (a class body's prepared namespace through its own methods, CORR-6C9-3)
  if (callerLocals !== null && callerLocals !== undefined) return layered(localsNamespace(callerLocals), g);
  return g;
}
// exec/eval's locals: an exact dict's storage, else the mapping itself,
// which CPython's LOAD_NAME, STORE_NAME and DELETE_NAME use through
// __getitem__, __setitem__ and __delitem__ (a dict subclass's too)
function localsNamespace(m: any): any {
  return Obj.typeOf(m) === T.dict ? Obj.namespaceOf(m) : mappingNamespace(m);
}
const NS_MAPPING = Symbol("a namespace over a mapping");
function mappingNamespace(m: any): any {
  const get = (k: string): any => {
    try {
      return O.getitem(m, k);
    } catch (e) {
      // (a KeyError, or a subclass's, means unbound here: the globals next)
      if (Obj.isinstance(e, T.KeyError)) return undefined;
      throw e;
    }
  };
  return new Proxy(Object.create(null), {
    get: (_t, k) => (typeof k === "string" ? get(k) : k === NS_MAPPING ? true : k === Obj.NS_DICT ? m : undefined),
    set: (_t, k, v) => (typeof k === "string" && O.setitem(m, k, v), true),
    has: (_t, k) => typeof k === "string" && get(k) !== undefined,
    deleteProperty: (_t, k) => {
      if (typeof k !== "string") return true;
      // (any failure, as DELETE_NAME's, is the name's NameError)
      try {
        O.delitem(m, k);
      } catch {
        raise(T.NameError, `name '${k}' is not defined`);
      }
      return true;
    },
    ownKeys: () => [...new Set(mappingKeys(m).filter((k: any) => typeof k === "string"))],
    getOwnPropertyDescriptor: (_t, k) => {
      const v = typeof k === "string" ? get(k) : undefined;
      return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
}
const NS_FRONT = Symbol("the locals of a layered namespace, as a namespace");
// `from __future__ import annotations` at a module's top level: its
// __annotations__ made only if its namespace (exec's locals, when separate)
// has none, as CPython's SETUP_ANNOTATIONS; an existing mapping kept
export function setupAnnotations(g: any): void {
  const ns = g[NS_FRONT] ?? g;
  const v = ns[NS_MAPPING] === true ? ns.__annotations__ : Object.prototype.hasOwnProperty.call(ns, "__annotations__") ? ns.__annotations__ : undefined;
  if (v === undefined) g.__annotations__ = Obj.newDict();
}
// Reads see `front` then `back`; writes go to `front`.
function layered(front: any, back: any): any {
  // (a mapping's binding: one __getitem__, not one for `in` and another)
  const own = front[NS_MAPPING] === true ? (k: any) => front[k] : (k: any) => (k in front ? front[k] : undefined);
  const read = (k: any) => {
    const v = own(k);
    return v !== undefined ? v : back[k];
  };
  return new Proxy(Object.create(null), {
    get: (_t, k) => (k === Obj.NS_GLOBALS ? back : k === Obj.NS_LOCALS ? Obj.globalsDict(front) : k === NS_FRONT ? front : k === Obj.NS_DICT ? undefined : read(k)),
    set: (_t, k, v) => { if (typeof k === "string" && k.charCodeAt(0) === 36) raise(T.TypeError, `name '${k}' is reserved`); front[k] = v; return true; },
    has: (_t, k) => k in front || k in back,
    // (del deletes from the locals only: unbound there, the NameError even
    // when the globals bind it, as DELETE_NAME)
    deleteProperty: (_t, k) => {
      if (typeof k === "string" && front[NS_MAPPING] !== true && own(k) === undefined) raise(T.NameError, `name '${k}' is not defined`);
      delete front[k];
      return true;
    },
    ownKeys: () => [...new Set([...Reflect.ownKeys(front), ...Reflect.ownKeys(back)])],
    getOwnPropertyDescriptor: (_t, k) => {
      const v = read(k);
      return v === undefined ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
    },
  });
}
// `del name` of a name unbound there (a builtin's too)
export function unboundName(k: string): never {
  return raise(T.NameError, `name '${k}' is not defined`);
}
// A class body's __module__: its __name__, as LOAD_NAME there, the globals'
// (not exec's locals) and then the builtins'
export function classModule(g: any, b: any): any {
  const v = g.__name__;
  return v !== undefined ? v : M.builtinName(b, "__name__");
}
// The globals a function's code reads (LOAD_GLOBAL): a dict subclass's
// through its __getitem__, a KeyError meaning the builtins next, as
// CPython's when the globals aren't an exact dict; the storage otherwise,
// and for writes and deletes always
export function globalLoads(G: any): any {
  const d = G[Obj.NS_DICT];
  if (d === undefined || Obj.typeOf(d) === T.dict) return G;
  return new Proxy(Object.create(null), {
    get: (_t, k) => {
      if (typeof k !== "string") return G[k];
      try {
        return O.getitem(d, k);
      } catch (e) {
        if (Obj.isinstance(e, T.KeyError)) return undefined;
        throw e;
      }
    },
  });
}
// `del name` at a module's top level, or of a name declared global
export function delName(ns: any, k: string): void {
  // (a layered namespace checks its locals itself; elsewhere a builtin's
  // name is unbound too, unlike a load's, CPython's DELETE_NAME/GLOBAL)
  if (ns[Obj.NS_GLOBALS] === undefined && ns[k] === undefined) raise(T.NameError, `name '${k}' is not defined`);
  delete ns[k];
}

// sage: Sage source, which exec and eval compile in Sage mode
export class CodeObject {
  constructor(public src: string, public filename: string, public mode: string, public sage = false) {}
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

export function execIn(src: any, globals: any, locals: any, g: any, callerLocals: any, bl?: any): any {
  const [text, filename] = sourceOf(src, "exec");
  const sage = src instanceof CodeObject && src.sage;
  M.loader.exec(text, execNamespace(globals, locals, g, callerLocals, bl), src instanceof CodeObject && src.mode === "single" ? "single" : "exec", filename, { sage });
  return null;
}
export function evalIn(src: any, globals: any, locals: any, g: any, callerLocals: any, bl?: any): any {
  if (src instanceof CodeObject && src.mode === "exec") return execIn(src, globals, locals, g, callerLocals, bl);
  const [text, filename] = sourceOf(src, "eval");
  const sage = src instanceof CodeObject && src.sage;
  return M.loader.exec(text.replace(/^[ \t]+/, ""), execNamespace(globals, locals, g, callerLocals, bl), "eval", filename, { sage });
}
function compileSource(src: any, filename: any, mode: any, sage: boolean): CodeObject {
  const [text] = sourceOf(src, "compile");
  if (mode !== "exec" && mode !== "eval" && mode !== "single") raise(T.ValueError, "compile() mode must be 'exec', 'eval' or 'single'");
  M.loader.exec(text, null, mode === "eval" ? "check-eval" : mode === "single" ? "check-single" : "check", String(filename), { sage });
  return new CodeObject(text, String(filename), mode, sage);
}
function compileBuiltin(src: any, filename: any, mode: any): CodeObject {
  return compileSource(src, filename, mode, false);
}
Obj.builtin(compileBuiltin, "compile");
B.builtins.compile = compileBuiltin;
// compile() for Sage source (lib/sage_all.py's timeit): 2^3 is a power and
// 1/2 exact when the code object runs
B.builtins.__pyjs_compile_sage__ = Obj.builtin((src: any, filename: any, mode: any) => compileSource(src, filename, mode, true), "__pyjs_compile_sage__");
B.builtins.open = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_open"), "open"), a), "open");
B.builtins.open.$kw = (pos: any[], names: string[], values: any[]) => Obj.callKw(Obj.getattr(M.importModule("_pyjs_open"), "open"), pos, names, values);
// (open(F, M).write(S) with plain operands checks open by this identity: file-once.ts)
FO.setCanonicalOpen(B.builtins.open);
// help(obj), and obj? / obj?? in interactive input: lib/_pyjs_help.py
B.builtins.help = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_help"), "help"), a), "help");
// Run interactive input (mode "single": expression values are displayed) in
// the module ns, capturing what it prints: (output, traceback or None).
// lib/_pyjs_doctest.py runs examples with it; sage chooses Sage syntax.
B.builtins.__pyjs_run__ = Obj.builtin((src: any, ns: any, sage: any) => {
  // ns is the globals the compiled code reads and writes as `$g[name]`: it
  // must be a module (null-prototype) or a dict (wrapped in a null-prototype
  // namespace), never an object through whose JavaScript prototype `$g[name]`
  // could reach a raw function (design/security.md rule 6).
  const g = Obj.typeOf(ns) === T.module ? ns : ns instanceof Obj.PyDict ? Obj.namespaceOf(ns) : raise(T.TypeError, "__pyjs_run__() globals must be a module or dict");
  B.stdout.flush();
  const out: string[] = [];
  const so = B.stdout as any, se = B.stderr as any;
  so.write = (s: string) => void out.push(s);
  se.write = (s: string) => void out.push(s);
  let err: string | null = null;
  // values display as their text repr, as in Sage's doctests (no rich host)
  const host = R.host;
  R.host = null;
  try {
    (M.loader.exec as any)(String(src), g, "single", "<doctest>", { sage: O.truth(sage) });
  } catch (e) {
    err = formatException(Obj.toPyExc(e));
  } finally {
    R.host = host;
    delete so.write;
    delete se.write;
  }
  return tuple([out.join(""), err]);
}, "__pyjs_run__");

// The lines of a file the runtime has executed (for obj??), or None.
B.builtins.__pyjs_source_lines__ = Obj.builtin((filename: any) => {
  let found: string[] | null = null;
  for (const info of scripts.values()) if (info.filename === filename) found = info.lines;
  return found === null ? null : tuple(found);
}, "__pyjs_source_lines__");
B.builtins.__pyjs_help__ = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_help"), "inspect_object"), a), "__pyjs_help__");
// IPython's magics (src/magic-syntax.ts writes %name args as these calls)
B.builtins.__pyjs_magic__ = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_magic"), "run_line_magic"), a), "__pyjs_magic__");
B.builtins.__pyjs_cell_magic__ = Obj.builtin((...a: any[]) => Obj.callObj(Obj.getattr(M.importModule("_pyjs_magic"), "run_cell_magic"), a), "__pyjs_cell_magic__");
// and the code %time and %timeit run, expanded in the cell, calls these: timer, time_value, keep, kept, timeit_run
B.builtins.__pyjs_magic_api__ = Obj.builtin((name: any) => Obj.getattr(Obj.getattr(M.importModule("_pyjs_magic"), "API"), String(name)), "__pyjs_magic_api__");
B.builtins.__pyjs_displayhook__ = Obj.builtin((v: any) => {
  if (v !== null) {
    B.builtins._ = v;
    displayValue(v);
  }
  return null;
}, "displayhook");
// Sage code's (src/compile.ts): until sage_all sets its own, the hook a
// host has set for all code, looked up at each call
B.builtins.__pyjs_sage_displayhook__ = Obj.builtin((v: any) => Obj.callObj(B.builtins.__pyjs_displayhook__, [v]), "displayhook");

// ------------------------------------------------------------------ rich display
// Jupyter's display protocol: _repr_mimebundle_, _repr_svg_, ... make a MIME
// bundle that the host shows (R.host.display, set by the browser worker),
// when there is one; otherwise the text repr is printed.  R.host is also
// reachable from Python as __pyjs_host__(op, *args) for things like
// interact's output routing.
const RICH: [string, string][] = [
  ["_repr_svg_", "image/svg+xml"], ["_repr_png_", "image/png"], ["_repr_jpeg_", "image/jpeg"], ["_repr_html_", "text/html"],
  ["_repr_markdown_", "text/markdown"], ["_repr_latex_", "text/latex"], ["_repr_json_", "application/json"],
];
function base64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function mimeValue(v: any): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (v instanceof Obj.PyBytes) return base64(v.a.subarray(0, v.n));
  return F.str(v);
}
export function mimeBundle(v: any): Record<string, string> | null {
  if (v === null || Obj.isType(v)) return null;
  const out: Record<string, string> = {};
  const mb = Obj.getattr(v, "_repr_mimebundle_", null);
  if (mb !== null) {
    let r = Obj.callObj(mb, []);
    if (r !== null && !(r instanceof Obj.PyDict)) r = O.toArray(r)[0]; // (data, metadata)
    if (r instanceof Obj.PyDict) {
      for (const k of O.toArray(r)) {
        const s = mimeValue(O.getitem(r, k));
        if (s !== null) out[String(k)] = s;
      }
    }
  }
  for (const [method, mime] of RICH) {
    if (mime in out) continue;
    const f = Obj.getattr(v, method, null);
    if (f === null) continue;
    const s = mimeValue(Obj.callObj(f, []));
    if (s !== null) out[mime] = s;
  }
  return Object.keys(out).length ? out : null;
}
// Show v richly if the host can, else print its repr; true if shown richly.
// A Python function's parameters as the compiler bound them, (args,
// posonly count, vararg, kwonly, kwarg), for the notebook's IPython display
// of a function (lib/_pyjs_pretty.py); None for anything else
B.builtins.__pyjs_signature__ = Obj.builtin((f: any) => {
  const s = f?.$sig;
  if (Obj.typeOf(f) !== T.function || s === undefined || s === null) return null;
  return tuple([tuple([...s.args]), s.posonly, s.vararg, tuple([...s.kwonly]), s.kwarg]);
}, "__pyjs_signature__");

// A value's text as shown: IPython's (lib/_pyjs_pretty.py: int, not <class
// 'int'>; <function __main__.f(c=3)>) where the host is a notebook
// (host.ipython), else its repr, as CPython's prompt shows it
export function displayText(v: any): string {
  if (R.host?.ipython !== true) return F.repr(v);
  const t = Obj.callObj(Obj.getattr(M.importModule("_pyjs_pretty"), "text"), [v]);
  return typeof t === "string" ? t : F.str(t);
}

function displayValue(v: any): boolean {
  const host = R.host;
  // IPython's _ipython_display_ (ipywidgets' widgets draw themselves as
  // controls), where the host can draw them
  if (host?.interact && v !== null && !Obj.isType(v)) {
    const ipd = Obj.getattr(v, "_ipython_display_", null);
    if (ipd !== null) {
      Obj.callObj(ipd, []);
      return true;
    }
  }
  if (host?.display) {
    const b = mimeBundle(v);
    if (b !== null) {
      b["text/plain"] ??= displayText(v);
      B.stdout.flush();
      if (host.display(b)) return true;
    }
  }
  B.stdout.write(displayText(v) + "\n");
  return false;
}
B.builtins.__pyjs_display__ = Obj.builtin((v: any) => displayValue(v), "display");
B.builtins.__pyjs_host__ = Obj.builtin((op: any, ...args: any[]) => {
  // (an own operation of the host, named by a string: never an inherited
  // JavaScript method like `constructor` or `toString`, design/security.md rule 6)
  if (typeof op !== "string" || R.host == null || !Object.hasOwn(R.host, op)) return null;
  const f = R.host[op];
  if (typeof f !== "function") return null;
  B.stdout.flush();
  return f(...args) ?? null;
}, "__pyjs_host__");
// input([prompt]): a line from the host, when it can ask for one (a notebook
// page: R.host.input(prompt) gives the line typed, without its newline; null
// at the end of input; {interrupted: true} if a Stop came while it waited);
// the prompt and the line are then written as output, as Jupyter shows them.
// With no such host: the prompt written, then EOFError, as CPython's with no
// stdin.
B.builtins.input = Obj.builtin((...args: any[]) => {
  if (args.length > 1) raise(T.TypeError, `input expected at most 1 argument, got ${args.length}`);
  const prompt = args.length ? String(F.str(args[0])) : "";
  const ask = R.host != null && Object.hasOwn(R.host, "input") ? R.host.input : null;
  if (typeof ask !== "function") {
    if (prompt) B.stdout.write(prompt);
    B.stdout.flush();
    return raise(T.EOFError, "EOF when reading a line");
  }
  B.stdout.flush();
  const line = ask(prompt);
  if (line !== null && typeof line === "object" && line.interrupted === true) {
    consumeCtrlC();
    return raise(T.KeyboardInterrupt);
  }
  if (typeof line !== "string") return raise(T.EOFError, "EOF when reading a line");
  B.stdout.write(prompt + line + "\n");
  return line;
}, "input");
B.builtins.exec = Obj.builtin((src: any, gl: any = undefined, lo: any = undefined) => execIn(src, gl ?? null, lo, null, null), "exec");
B.builtins.eval = Obj.builtin((src: any, gl: any = undefined, lo: any = undefined) => evalIn(src, gl ?? null, lo, null, null), "eval");
B.builtins.globals = Obj.builtin(() => raise(T.RuntimeError, "globals() called indirectly is not supported"), "globals");
B.builtins.locals = Obj.builtin(() => raise(T.RuntimeError, "locals() called indirectly is not supported"), "locals");
// The builtins the compiler runs in place (introspection calls, consuming
// calls of a generator expression, `for` over range): their own functions,
// which a call's guard compares with, not the builtins' names, which code
// can rebind (CORR-FBF-3)
const originalBuiltins: any = Object.create(null);
for (const n of ["globals", "locals", "vars", "dir", "eval", "exec", "tuple", "list", "set", "frozenset", "sum", "any", "all", "sorted", "min", "max", "range"]) originalBuiltins[n] = B.builtins[n];
Object.freeze(originalBuiltins);

// ------------------------------------------------------------------ classes

// builtins.__build_class__ can be replaced; the class body has already run
// by the time it is called, so it receives a stand-in body function.
export const defaultBuildClass = Obj.builtin((..._a: any[]) => raise(T.NotImplementedError, "calling __build_class__ directly is not supported"), "__build_class__");
B.builtins.__build_class__ = defaultBuildClass;
// The __build_class__ of a class statement's builtins, CPython's
// LOAD_BUILD_CLASS
export function buildClassOf(b: any): any {
  const bc = b.__build_class__;
  if (bc === undefined) raise(T.NameError, "__build_class__ not found");
  return bc;
}
// The namespace a class body runs in, made before it (CPython's
// __build_class__: the metaclass resolved, its __prepare__ called); a
// replaced __build_class__, given a stand-in body afterwards, a Map
// (the bases first updated, as its update_bases: a base that isn't a class
// replaced by what its __mro_entries__ gives, PEP 560; the statement's own
// bases array then holds the new ones, and $orig the originals, its
// __orig_bases__)
export function classNamespace(name: string, bases: any[], kwNames: string[], kwValues: any[], bc: any): Map<string, any> | Ty.PreparedNs {
  if (bc !== defaultBuildClass) return new Map();
  const ub = Ty.updateBases(bases);
  if (ub !== bases) {
    // (__orig_bases__: the very tuple the __mro_entries__ calls were given)
    (bases as any).$orig = (ub as any).$orig;
    bases.splice(0, bases.length, ...ub);
  }
  return Ty.classNamespace(name, bases, kwNames, kwValues);
}
// A class body's __module__: its __name__, as LOAD_NAME there, the
// namespace's (a prepared one's), then the globals' and the builtins'
export function classModuleIn(ns: Map<string, any> | Ty.PreparedNs, g: any, b: any): any {
  const v = ns.get("__name__");
  return v !== undefined ? v : classModule(g, b);
}
// locals() in a class body: a prepared namespace's mapping itself
export function classLocals(ns: Map<string, any> | Ty.PreparedNs): any {
  return ns instanceof Ty.PreparedNs ? ns.m : localsDict([...ns.keys()], [...ns.values()]);
}
// A class body's __classdict__, CPython's implicit cell of its annotation
// scopes (a types.CellType, stored in the namespace as __classdictcell__):
// the body's namespace while it runs (a prepared one's mapping itself),
// then the class's own dict, from type.__new__ on (types.ts), the same
// object every time it is read
class ClassMap {
  // (a dict's store over a class namespace, str keys only. Once the class
  // is made a write through it is refused: CPython's raw writes to a
  // type's dict skip its attribute cache, which Sagebrush's own caches
  // would not, so neither answer would be CPython's, astra CORR-2F0-2)
  constructor(public m: Map<string, any>, public cls: any) {}
  get size(): number {
    return this.m.size;
  }
  keys() {
    return this.m.keys();
  }
  values() {
    return this.m.values();
  }
  entries() {
    return this.m.entries();
  }
  [Symbol.iterator]() {
    return this.m.entries();
  }
  get(k: any): any {
    return typeof k === "string" ? this.m.get(k) : undefined;
  }
  has(k: any): boolean {
    return typeof k === "string" && this.m.has(k);
  }
  private writable() {
    if (this.cls) raise(T.NotImplementedError, `writing to the dict of class '${this.cls.$name}' through __classdict__ is not supported yet`);
  }
  set(k: any, v: any): this {
    this.writable();
    if (typeof k !== "string") raise(T.NotImplementedError, "a key other than a str in a class's __classdict__ is not supported yet");
    this.m.set(k, v);
    return this;
  }
  delete(k: any): boolean {
    this.writable();
    return typeof k === "string" && this.m.delete(k);
  }
  clear() {
    this.writable();
    this.m.clear();
  }
}
function dictOver(m: Map<string, any>, cls: any): any {
  const d = new Obj.PyDict();
  (d as any).$m = new ClassMap(m, cls);
  (d as any).$strOnly = true;
  return d;
}
// (one dict over a class body's namespace: its __classdict__'s, and the
// namespace a metaclass is given)
const nsViews = new WeakMap<Map<string, any>, any>();
const nsView = (ns: Map<string, any>) => {
  let d = nsViews.get(ns);
  if (d === undefined) nsViews.set(ns, (d = dictOver(ns, null)));
  return d;
};
Ty.classDictHooks.view = nsView;
export const classDictCell = (ns: Map<string, any> | Ty.PreparedNs) => Ty.newCell(ns instanceof Ty.PreparedNs ? ns.m : nsView(ns));
export const classDict = (c: Ty.PyCell): any => c.v;
// (the class made: its own dict, the same dict object when that is the
// body's namespace)
Ty.classDictHooks.bind = (c: Ty.PyCell, cls: any) => {
  const m = cls.$dict, v = c.v;
  if (v instanceof Obj.PyDict && (v as any).$m instanceof ClassMap && (v as any).$m.m === m) (v as any).$m.cls = cls;
  else c.v = dictOver(m, cls);
};
export function classDef(name: string, qualname: string, module: string, bases: any[], ns: Map<string, any> | Ty.PreparedNs, kwNames: string[], kwValues: any[], cell?: Ty.PyCell, bc: any = B.builtins.__build_class__): any {
  if (bc !== defaultBuildClass) return Obj.callKw(bc, [Obj.pyfn(() => null, name), name, ...bases], kwNames, kwValues);
  const orig = (bases as any).$orig;
  if (orig !== undefined) ns.set("__orig_bases__", orig);
  const cls = Ty.makeClass(name, bases, ns, module, qualname, kwNames, kwValues);
  // CPython's __build_class__: type.__new__ must have set the class cell
  // (a metaclass may drop __classcell__ on the way)
  if (cell !== undefined && Obj.isType(cls) && cell.v !== cls) {
    if (cell.v === undefined) raise(T.RuntimeError, `__class__ not set defining ${F.repr(name)} as ${F.repr(cls)}. Was __classcell__ propagated to type.__new__?`);
    raise(T.TypeError, `__class__ set to ${F.repr(cell.v)} defining ${F.repr(name)} as ${F.repr(cls)}`);
  }
  return cls;
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
  fn: string; // which function: its compiled script and position there
}

// The frames an exception was raised through, outermost first, and whether
// the JS stack limit may have cut outer ones off; after a bare re-raise, the
// frames reraise recorded
function raisedFrames(e: any): { frames: Frame[]; cut: boolean; why: string | null } {
  if (e.$tb === undefined) return { frames: [], cut: false, why: null };
  const r = e.$reraised;
  if (r !== undefined && r.tb === e.$tb) return r;
  const sites = sitesOf(e.$tb);
  return { frames: pyFrames(sites), cut: sites.length >= Error.stackTraceLimit, why: null };
}
function framesOf(e: any): Frame[] {
  return raisedFrames(e).frames;
}

// a captured stack's call sites, innermost first
function sitesOf(holder: any): any[] {
  const prev = (Error as any).prepareStackTrace;
  (Error as any).prepareStackTrace = (_: any, cs: any[]) => cs;
  let sites: any;
  try {
    sites = holder.stack;
  } finally {
    (Error as any).prepareStackTrace = prev;
  }
  // JavaScriptCore (Bun) formats the stack when it is captured: parse
  // "at name (file:line:col)" lines instead of V8 call sites.
  if (!Array.isArray(sites)) {
    const text = String(sites ?? holder.stack ?? "");
    sites = [];
    for (const l of text.split("\n")) {
      const m = /at (?:(\S+) \()?(.+?):(\d+):\d+\)?\s*$/.exec(l);
      if (m) sites.push({ getFileName: () => m[2], getLineNumber: () => Number(m[3]), getFunctionName: () => m[1] ?? "" });
    }
  }
  return sites;
}

// the Python frames among call sites, outermost first
function pyFrames(sites: any[]): Frame[] {
  const frames: Frame[] = [];
  for (const cs of sites) {
    // Evaluated code (the browser build) has no file name, only a sourceURL.
    const info = scripts.get(cs.getFileName?.() ?? "") ?? scripts.get(cs.getScriptNameOrSourceURL?.() ?? "");
    if (info === undefined) continue;
    const pyLine = info.lineMap[cs.getLineNumber()] ?? 0;
    let name = String(cs.getFunctionName() ?? "");
    name = name.endsWith("$$") ? name.slice(0, -2) : name === "module$$" || name === "" ? "<module>" : name;
    if (name === "module") name = "<module>";
    const at = cs.getEnclosingLineNumber?.();
    const fn = at === undefined ? `${info.filename}:${name}` : `${info.filename}:${at}:${cs.getEnclosingColumnNumber?.()}`;
    frames.push({ file: info.filename, line: pyLine, name, text: (info.lines[pyLine - 1] ?? "").trim(), fn });
  }
  return frames.reverse();
}

// The frames of a handled exception's traceback, as CPython's: from the
// frame that caught it (excEnter records which function that was) to where
// it was raised, however the stack has changed since. Refused, not guessed,
// where that frame can't be told: the function isn't among the raise's
// frames, or is there more than once (recursion through the handler), or
// the JS stack limit may have cut the raise's outer frames off. (Every
// exception format_exc shows, the chain's too, was caught or passed through
// a finally; one never raised has no frames.)
function caughtFrames(e: any): Frame[] {
  if (e.$tb === undefined) return [];
  const { frames, cut } = raisedFrames(e);
  const c = e.$caught;
  const unknown = (why: string) => raise(T.NotImplementedError, `which frame caught this exception is unknown: ${why}`);
  // (not caught by Python code: never raised, as a cause made by
  // ValueError("x"), so no traceback, as CPython's __traceback__ None; or
  // raised, then consumed by the runtime (hasattr, next's default...),
  // whose catches record nothing: refused, CORR-581-1)
  if (c === undefined) {
    if (e.$raised === true) unknown("it was caught by the runtime (as hasattr, or a default of getattr or next, does), which keeps no record of where");
    return [];
  }
  if (c.tb !== e.$tb) unknown("it was raised again and not caught since");
  const { why } = raisedFrames(e);
  if (why !== null) unknown(why);
  // (the catching frame: from the one JS frame excEnter kept, or, for a
  // generator's exception as it resumed, the generator's own)
  let catcher: Frame | undefined = c.frame;
  if (catcher === undefined) {
    const near = pyFrames(sitesOf(c.at));
    catcher = near[near.length - 1];
  }
  if (catcher === undefined) unknown("it was not caught in Python code");
  if (cut) unknown(`its traceback is deeper than the ${Error.stackTraceLimit} JavaScript frames kept`);
  const at: number[] = [];
  const fr = catcher!;
  frames.forEach((f, i) => f.fn === fr.fn && at.push(i));
  if (at.length === 0) unknown(`${fr.name} caught it, but is not among the frames it was raised through`);
  if (at.length > 1) unknown(`${fr.name}, which caught it, is ${at.length} of the frames it was raised through (recursion through the handler)`);
  return frames.slice(at[0]);
}

// (limit, as traceback's: the first `limit` frames, or with a negative one
// the last -limit; null: all). The items CPython's format_exception lists:
// the header, one per frame, the exception's line)
function formatOne(e: any, caught = false, limit: number | null = null): string[] {
  const out: string[] = [];
  let frames = caught ? caughtFrames(e) : framesOf(e);
  if (limit !== null) frames = limit >= 0 ? frames.slice(0, limit) : frames.slice(Math.max(0, frames.length + limit));
  if (frames.length) {
    out.push("Traceback (most recent call last):\n");
    for (const f of frames) out.push(`  File "${f.file}", line ${f.line}, in ${f.name}\n` + (f.text ? `    ${f.text}\n` : ""));
  }
  out.push(...exceptionOnly(e));
  return out;
}

// The exception's own lines, as traceback.format_exception_only: its type and
// message; a SyntaxError's with where it was found above (syntaxErrorLines).
function exceptionOnly(e: any): string[] {
  const t = Obj.typeOf(e);
  const mod = t.$module === "builtins" || t.$module === "__main__" ? "" : t.$module + ".";
  const stype = `${mod}${t.$qualname}`;
  if (Obj.isinstance(e, T.SyntaxError)) return syntaxErrorLines(e, stype);
  let msg: string;
  try {
    msg = F.str(e);
  } catch {
    msg = "<exception str() failed>";
  }
  return [`${stype}${msg ? ": " + msg : ""}\n`];
}

// (Python's str.isspace, for the caret line's alignment)
const PY_SPACE_CODES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
const isPySpace = (c: string) => PY_SPACE_CODES.has(c.codePointAt(0)!);

// A SyntaxError's lines, as CPython 3.14's TracebackException.
// _format_syntax_error: `  File "name", line N`, the line's text stripped
// of its indentation, carets under offset..end_offset (1-based, in code
// points), then "Type: msg" (the file name after it when there is no line).
// Not CPython's keyword-typo hint ("Did you mean 'for'?"), which needs the
// compiler's metadata.
function syntaxErrorLines(e: any, stype: string): string[] {
  const out: string[] = [];
  // (an offset is any int, as CPython's isinstance(offset, int): a bool, an
  // int subclass's value too; astra's CORR-PR54-1)
  const num = (v: any): number | null => (typeof v === "boolean" ? Number(v) : v !== null && v !== undefined && Obj.isinstance(v, T.int) ? Number(O.index(v)) : null);
  const strOf = (v: any): string | null => (typeof v === "string" ? v : v !== null && v !== undefined && Obj.isinstance(v, T.str) ? F.str(v) : null);
  let suffix = "";
  if (e.lineno !== null && e.lineno !== undefined) {
    const file = e.filename === null || e.filename === undefined || !O.truth(e.filename) ? "<string>" : F.str(e.filename);
    out.push(`  File "${file}", line ${F.str(e.lineno)}\n`);
  } else if (e.filename !== null && e.filename !== undefined) {
    suffix = ` (${F.str(e.filename)})`;
  }
  const text = strOf(e.text);
  if (text !== null) {
    const rtext = Array.from(text.replace(/\n+$/, ""));
    let i = 0;
    while (i < rtext.length && (rtext[i] === " " || rtext[i] === "\n" || rtext[i] === "\f")) i++;
    const ltext = rtext.slice(i);
    const spaces = rtext.length - ltext.length;
    const len = Array.from(text).length;
    let offset = num(e.offset);
    if (e.offset === null || e.offset === undefined) {
      out.push(`    ${ltext.join("")}\n`);
    } else if (offset !== null) {
      const endOffsetAttr = num(e.end_offset);
      let endOffset: number;
      if (O.truth(O.eq(e.lineno, e.end_lineno))) endOffset = endOffsetAttr !== null && endOffsetAttr !== 0 ? endOffsetAttr : offset;
      else endOffset = rtext.length + 1;
      if (len && offset > len) offset = rtext.length + 1;
      if (len && endOffset > len) endOffset = rtext.length + 1;
      if (offset >= endOffset || endOffset < 0) endOffset = offset + 1;
      const colno = offset - 1 - spaces;
      const endColno = endOffset - 1 - spaces;
      out.push(`    ${ltext.join("")}\n`);
      if (colno >= 0) {
        const caretspace = ltext.slice(0, colno).map((c) => (isPySpace(c) ? c : " ")).join("");
        out.push(`    ${caretspace}${"^".repeat(Math.max(0, endColno - colno))}\n`);
      }
    }
  }
  let msg: string;
  try {
    msg = O.truth(e.msg ?? null) ? F.str(e.msg) : "<no detail available>";
  } catch {
    msg = "<exception str() failed>";
  }
  out.push(`${stype}: ${msg}${suffix}\n`);
  return out;
}

export function formatException(e: any, caught = false, limit: number | null = null, chain = true): string {
  return formatExceptionItems(e, caught, limit, chain).join("");
}

export function formatExceptionItems(e: any, caught = false, limit: number | null = null, chain = true): string[] {
  const parts: string[][] = [];
  const seen = new Set<any>();
  let cur = e;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    parts.unshift(formatOne(cur, caught, limit));
    if (!chain) break;
    if (cur.__cause__ !== null && cur.__cause__ !== undefined) {
      parts.unshift(["\nThe above exception was the direct cause of the following exception:\n\n"]);
      cur = cur.__cause__;
    } else if (cur.__context__ !== null && cur.__context__ !== undefined && cur.__suppress_context__ !== true) {
      parts.unshift(["\nDuring handling of the above exception, another exception occurred:\n\n"]);
      cur = cur.__context__;
    } else break;
  }
  return parts.flat();
}

// Sage mode: `/` on two ints is an exact rational (sage_all.Rational).
let sageIntDiv: any;
function sagediv(a: any, b: any): any {
  if (O.isPyInt(a) && O.isPyInt(b)) {
    sageIntDiv ??= Obj.getattr(M.importModule("sage_all"), "_intdiv");
    return Obj.callObj(sageIntDiv, [a, b]);
  }
  return O.truediv(a, b);
}
const isagediv = (a: any, b: any) => (O.isPyInt(a) && O.isPyInt(b) ? sagediv(a, b) : O.itruediv(a, b));
// ...and an int to a negative int power is a Rational too: 2^-1 == 1/2.
const negIntPow = (a: any, b: any) => O.isPyInt(a) && O.isPyInt(b) && b < 0;
const sagepow = (a: any, b: any) => (negIntPow(a, b) ? sagediv(1, O.pow(a, O.neg(b))) : O.pow(a, b));
const isagepow = (a: any, b: any) => (negIntPow(a, b) ? sagepow(a, b) : O.ipow(a, b));

// ------------------------------------------------------------------ the runtime object

// Ctrl-C in compiled loops (`if (INTR[0] & 1) interrupted();`, emit.ts):
// KeyboardInterrupt, and bit 0 consumed, the word's other bits left.
function interrupted(): never {
  consumeCtrlC();
  return raise(T.KeyboardInterrupt);
}

export const R: any = {
  $i: B.intrinsics,
  // a compiled __annotate__'s format check, as CPython's (`format > 2`:
  // only VALUE and VALUE_WITH_FAKE_GLOBALS; a non-number a TypeError)
  annotateFormat: (f: any) => {
    if (O.truth(O.gt(f, 2))) raise(T.NotImplementedError);
  },
  annotateSig: Obj.sig(["format"], { posonly: 1 }),
  // whether a module's annotated statement i has run
  annotIn: (s: any, i: number) => O.truth(O.contains(s, i)),
  /** Set by an embedding (the browser worker): display(bundle) -> shown?, and other hooks. */
  host: null,
  INTR,
  interrupted,
  // live progress (design-estimates-progress r4 §6): R.progress.snapshot()
  // is every call in progress, as progress/1 records; .buffer the shared slots
  progress: { snapshot: () => Prog.snapshot(), buffer: Prog.PROGRESS },
  mimeBundle,
  displayText,
  ...O,
  ...F,
  sagediv,
  isagediv,
  sagepow,
  isagepow,
  T,
  FloatBox: Obj.FloatBox,
  PyDict: Obj.PyDict,
  DONE: Obj.DONE,
  NotImplemented: Obj.NotImplemented,
  Ellipsis: Obj.Ellipsis,
  tuple,
  sumAcc: (start: any) => new B.SumAcc(start),
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
  superNoArgs: Ty.superNoArgs,
  superAttr: Ty.superAttr,
  newCell: Ty.newCell,
  classCellGet: Ty.classCellGet,
  makeRange: Ty.makeRange,
  PyRange: Ty.PyRange,
  defn,
  globalsDict: Obj.globalsDict,
  moduleLocals: Obj.moduleLocals,
  realGlobals: Obj.realGlobals,
  localsDict,
  sortedKeys,
  delName,
  originalBuiltins,
  builtinsOf: M.builtinsOf,
  builtinName: M.builtinName,
  fileOnceOpen: FO.fileOnceOpen,
  fileOnceBegin: FO.fileOnceBegin,
  fileOnceEnd: FO.fileOnceEnd,
  fileOnceAbort: FO.fileOnceAbort,
  fileOnceS: FO.fileOnceS,
  fileOnceTake: FO.fileOnceTake,
  globalLoads,
  buildClassOf,
  classNamespace,
  classModuleIn,
  classLocals,
  setupAnnotations,
  classDictCell,
  classDict,
  classModule,
  unboundName,
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
  excEnter: Obj.excEnter,
  excLeave: Obj.excLeave,
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
  builtinModuleNames: M.builtinModuleNames,
  resolvedModuleNames: M.resolvedModuleNames,
  PyComplex: Cx.PyComplex,
  importAs: M.importAs,
  importFromStmt: M.importFromStmt,
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

// A small traceback module over the runtime's own traceback formatting.
M.newBuiltinModule("traceback", (m) => {
  const exc = (a: any, b: any) => (b !== undefined && b !== null ? b : a);
  const fn = (name: string, f: any) => (m[name] = Obj.builtin(f, name));
  // format_exception(exc, /, value=, tb=, limit=None, chain=True, **kwargs),
  // print_exception(exc, /, value=, tb=, limit=None, file=None, chain=True,
  // **kwargs), format_exc(limit=None, chain=True) and print_exc(limit=None,
  // file=None, chain=True), as CPython 3.14's: their arguments by position
  // or keyword (exc only by position), limit's frames, chain, the file
  // (kwargs: the two that take **kwargs accept any other name, as CPython's,
  // which reads colorize: a true one isn't implemented, refused)
  const parse = (name: string, params: string[], posOnly: number, pos: any[], names: string[] = [], values: any[] = [], kwargs = false) => {
    const got: Record<string, any> = {};
    if (pos.length > params.length) raise(T.TypeError, `${name}() takes from ${posOnly} to ${params.length} positional arguments but ${pos.length} were given`);
    pos.forEach((v, i) => (got[params[i]] = v));
    const extra: Record<string, any> = {};
    names.forEach((k, i) => {
      if (!params.includes(k) || params.indexOf(k) < posOnly) {
        if (!kwargs) raise(T.TypeError, `${name}() got an unexpected keyword argument '${k}'`);
        extra[k] = values[i];
        return;
      }
      if (Object.hasOwn(got, k)) raise(T.TypeError, `${name}() got multiple values for argument '${k}'`);
      got[k] = values[i];
    });
    for (let i = 0; i < posOnly; i++) if (!Object.hasOwn(got, params[i])) raise(T.TypeError, `${name}() missing 1 required positional argument: '${params[i]}'`);
    if (Object.hasOwn(extra, "colorize") && O.truth(extra.colorize)) raise(T.NotImplementedError, `traceback.${name}(colorize=True) is not supported here`);
    return got;
  };
  // (limit as CPython's StackSummary takes it: None, then sys.tracebacklimit,
  // a negative one 0; then limit >= 0 decides, by Python's own comparison,
  // between islice's stop (an integer 0 <= x <= sys.maxsize) and deque's
  // maxlen -limit (an int or int subclass, within ssize_t, non-negative),
  // with their errors; the
  // exact integer checked before it becomes a JS number, astra's CORR-484-3)
  const MAXSIZE = 9223372036854775807n;
  // (an int or int subclass, by its payload, not its __index__ or __int__,
  // as PyLong_AsSsize_t reads it; null for anything else)
  const asInt = (x: any): bigint | null =>
    O.isPyInt(x)
      ? BigInt(O.index(x))
      : x instanceof Obj.PrimBox && Obj.typeOf(x).$mro.includes(T.int) && O.shimName(x, "int") === null
        ? BigInt(x.$v)
        : null;
  const limitOf = (v: any): number | null => {
    let lim = v;
    if (lim === undefined || lim === null) {
      lim = Obj.getattr(M.importModule("sys"), "tracebacklimit", null);
      if (lim === null) return null;
      if (O.truth(O.lt(lim, 0))) lim = 0;
    }
    if (O.truth(O.ge(lim, 0))) {
      const bad = () => raise(T.ValueError, "Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.");
      let n: bigint;
      try {
        n = BigInt(O.index(lim));
      } catch {
        return bad();
      }
      if (n < 0n || n > MAXSIZE) return bad();
      return Number(n);
    }
    // (deque's maxlen: an int, within ssize_t either way, then non-negative)
    const n = asInt(O.neg(lim));
    if (n === null) raise(T.TypeError, "an integer is required");
    if (n! > MAXSIZE || n! < -MAXSIZE - 1n) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
    if (n! < 0n) raise(T.ValueError, "maxlen must be non-negative");
    return -Number(n);
  };
  const chainOf = (g: Record<string, any>) => (Object.hasOwn(g, "chain") ? O.truth(g.chain) : true);
  // (the exception: value if given, else exc; both or neither of value and
  // tb. A tb can't be honored here: this runtime has no traceback objects
  // (sys.exc_info()[2] and __traceback__ are None), so an explicit tb is
  // refused; None only where it drops nothing, an exception with no frames,
  // as one never raised: astra's CORR-484-2)
  const frameless = (e: any) => {
    if (e === null || typeof e !== "object") return true;
    try {
      return caughtFrames(e).length === 0;
    } catch {
      return false;
    }
  };
  const target = (g: Record<string, any>) => {
    const hasV = Object.hasOwn(g, "value"), hasT = Object.hasOwn(g, "tb");
    if (hasV !== hasT) raise(T.ValueError, "Both or neither of value and tb must be given");
    const e = hasV ? g.value : g.exc;
    if (hasT && (g.tb !== null || !frameless(e)))
      raise(T.NotImplementedError, "traceback objects are not supported here (sys.exc_info()[2] and __traceback__ are None): pass the exception alone, format_exception(e)");
    return e;
  };
  const text = (e: any, limit: number | null, chain: boolean) => (e === null || e === undefined ? ["NoneType: None\n"] : formatExceptionItems(e, true, limit, chain));
  // (to file, else the current sys.stderr; None: nothing; per item, a write
  // of it and of "", as CPython's print(item, file=file, end=""))
  const emit = (items: string[], file: any) => {
    if (file === undefined || file === null) {
      file = Obj.getattr(M.importModule("sys"), "stderr", null);
      if (file === null) return null;
    }
    const w = Obj.getattr(file, "write");
    for (const l of items) {
      Obj.callObj(w, [l]);
      Obj.callObj(w, [""]);
    }
    return null;
  };
  const withKw = (name: string, params: string[], posOnly: number, impl: (g: Record<string, any>) => any, kwargs = false) => {
    fn(name, (...pos: any[]) => impl(parse(name, params, posOnly, pos, [], [], kwargs)));
    m[name].$kw = (pos: any[], names: string[], values: any[]) => impl(parse(name, params, posOnly, pos, names, values, kwargs));
    m[name].$kwPos = true;
  };
  withKw("format_exception", ["exc", "value", "tb", "limit", "chain"], 1, (g) => {
    const e = target(g);
    return text(e, limitOf(g.limit), chainOf(g));
  }, true);
  fn("format_exception_only", (a: any, b: any = undefined) => {
    const e = exc(a, b);
    // (a SyntaxError's location lines too, as CPython's)
    if (Obj.isinstance(e, T.SyntaxError)) return exceptionOnly(e);
    const s = F.str(e);
    return [`${typeName(e)}${s ? ": " + s : ""}\n`];
  });
  withKw("print_exception", ["exc", "value", "tb", "limit", "file", "chain"], 1, (g) => {
    const e = target(g);
    return emit(text(e, limitOf(g.limit), chainOf(g)), g.file);
  }, true);
  // (the exception being handled, as sys.exc_info() has it; None's line
  // outside any; limit as format_exception's, checked even then, as CPython)
  const formatExc = (limit: any = null, chain: any = true) => {
    const lim = limitOf(limit);
    return text(Obj.currentExc(), lim, O.truth(chain));
  };
  const excSig = Obj.sig(["limit", "chain"]);
  const tooMany = (n: number) => raise(T.TypeError, `format_exc() takes from 0 to 2 positional arguments but ${n} were given`);
  fn("format_exc", (...a: any[]) => (a.length > 2 ? tooMany(a.length) : formatExc(a[0], a[1]).join("")));
  m.format_exc.$kw = (pos: any[], names: string[], values: any[]) => (pos.length > 2 ? tooMany(pos.length) : formatExc(...bindArgs("format_exc", excSig, pos, names, values)).join(""));
  m.format_exc.$kwPos = true;
  // (print_exc prints what format_exc returns, a write per item)
  withKw("print_exc", ["limit", "file", "chain"], 0, (g) => emit(formatExc(g.limit ?? null, Object.hasOwn(g, "chain") ? g.chain : true), g.file));
  fn("format_tb", (..._a: any[]) => []);
  fn("extract_tb", (..._a: any[]) => []);
  fn("extract_stack", (..._a: any[]) => []);
  fn("format_stack", (..._a: any[]) => []);
  fn("print_stack", (..._a: any[]) => null);
});

// The module whose Python code is calling (for type(name, bases, ns), which
// CPython names after the caller's globals): the nearest compiled frame.
Obj.hooks.callerModule = () => {
  const stack = new Error().stack ?? "";
  const m = /\((py:[^:)]+(?:\.py)?):\d+:\d+\)|at (py:[^:\s]+):\d+:\d+/.exec(stack.split("\n").slice(2).join("\n"));
  const js = m ? m[1] ?? m[2] : undefined;
  const info = js === undefined ? undefined : scripts.get(js);
  if (info === undefined) return "__main__";
  for (const mod of M.sysModules.$m.values()) if (mod !== null && typeof mod === "object" && mod.__file__ === info.filename) return mod.__name__;
  return "__main__";
};
