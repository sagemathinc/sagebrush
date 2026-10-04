// The object model: type objects, attribute lookup, calls, inline caches,
// exceptions.
//
// Value representation (see PLAN.md):
//   int    primitive integral number (always safe) | BigInt outside +-(2^53-1)
//   float  primitive non-integral number | FloatBox for integral values and -0.0
//   bool   JS boolean;  None  null;  str  JS string
//   list   JS Array;    tuple  JS Array with $t === true
//   other builtin values are instances of runtime classes whose prototype
//   carries `$cls` (their Python type);  instances of Python classes are
//   objects whose prototype chain holds only `$cls`, so a missing attribute
//   reads `undefined` and the instance dict is the object's own properties.
//
// `undefined` is never a Python value.  Runtime and compiled code use it for
// "missing": an unbound local, an absent attribute, an omitted argument.

export const hasOwn = Object.prototype.hasOwnProperty;

// ------------------------------------------------------------------ types

export interface PyType {
  (...args: any[]): any;
  $name: string;
  $qualname: string;
  $module: string;
  $dict: Map<string, any>;
  $bases: PyType[];
  $mro: PyType[];
  $ver: number;
  $subclasses: PyType[];
  // Instances of Python classes are created with `new $ctor()`.
  $ctor: (new () => any) | null;
  // True when some class in the MRO (other than `object`) overrides attribute
  // access, which disables the attribute caches.
  $customGet: boolean;
  $customSet: boolean;
  $kw?: (pos: any[], names: string[], values: any[]) => any;
  // JS class that instances of subclasses extend (list/tuple/dict/set layouts).
  $jsBase?: any;
}

let versionCounter = 1;

// Builtin types, filled in as they are created.
export const T: Record<string, PyType> = Object.create(null);

function c3Merge(seqs: PyType[][]): PyType[] {
  const out: PyType[] = [];
  seqs = seqs.map((s) => s.slice()).filter((s) => s.length);
  while (seqs.length) {
    let cand: PyType | undefined;
    for (const s of seqs) {
      const head = s[0];
      if (!seqs.some((o) => o.indexOf(head) > 0)) {
        cand = head;
        break;
      }
    }
    if (cand === undefined) raise(T.TypeError, "Cannot create a consistent method resolution order (MRO)");
    out.push(cand);
    seqs = seqs.map((s) => (s[0] === cand ? s.slice(1) : s)).filter((s) => s.length);
  }
  return out;
}

function finishType(cls: PyType, name: string, bases: PyType[], dict: Map<string, any>, module: string) {
  cls.$name = name;
  cls.$qualname = name;
  cls.$module = module;
  cls.$dict = dict;
  cls.$bases = bases;
  cls.$mro = [cls, ...c3Merge([...bases.map((b) => b.$mro), bases])];
  cls.$ver = versionCounter++;
  cls.$subclasses = [];
  for (const b of bases) b.$subclasses.push(cls);
  refreshFlags(cls);
}

function refreshFlags(cls: PyType) {
  cls.$customGet = cls.$mro.some((c) => c !== T.object && (c.$dict.has("__getattribute__") || c === T.type));
  cls.$customSet = cls.$mro.some((c) => c !== T.object && (c.$dict.has("__setattr__") || c.$dict.has("__delattr__")));
}

// A builtin type whose instances use a runtime representation.  `call`
// implements `T(...)`.
export function builtinType(name: string, bases: PyType[], call: (...args: any[]) => any, module = "builtins"): PyType {
  const cls = checkArity(call, name, false) as PyType;
  cls.$ctor = null;
  finishType(cls, name, bases, new Map(), module);
  T[name] = cls;
  return cls;
}

// A type whose instances are ordinary attribute-dict objects: classes defined
// in Python, and builtin types that behave like them (exceptions, object).
export function objectType(name: string, bases: PyType[], dict: Map<string, any>, module: string): PyType {
  const cls = function (...args: any[]) {
    return construct(cls, args);
  } as PyType;
  cls.$kw = (pos, names, values) => constructKw(cls, pos, names, values);
  // Subclasses of list/tuple/dict/set use a JS subclass of the runtime
  // class (layout); everything else is an attribute-dict object.
  let layout: any = null;
  for (const b of bases) {
    if (b.$jsBase !== undefined && b.$jsBase !== null) {
      if (layout !== null && layout !== b.$jsBase && !(b.$jsBase.prototype instanceof layout) && !(layout.prototype instanceof b.$jsBase)) raise(T.TypeError, "multiple bases have instance lay-out conflict");
      if (layout === null || b.$jsBase.prototype instanceof layout) layout = b.$jsBase;
    } else if (b.$ctor === null && b !== T.object) raise(T.TypeError, `subclassing '${b.$name}' is not supported yet`);
  }
  let Ctor: any;
  if (layout === ListLayout || layout === TupleLayout) {
    // Plain arrays with an own `$cls`, so V8's fast array builtins still apply.
    const isTuple = layout === TupleLayout;
    Ctor = function () {
      const a: any = [];
      a.$cls = cls;
      if (isTuple) a.$t = true;
      return a;
    };
  } else if (layout !== null) {
    Ctor = class extends layout {};
    Object.defineProperty(Ctor.prototype, "$cls", { value: cls, writable: true, configurable: true });
  } else {
    const proto = Object.create(null);
    proto.$cls = cls;
    Ctor = function () {} as any;
    Ctor.prototype = proto;
    // V8 keeps a new prototype in slow dictionary mode until a named store
    // on an instance updates an inline cache; do one now so `$cls` loads and
    // negative lookups through the prototype are fast from the start.
    new Ctor().$warm = 0;
  }
  cls.$ctor = Ctor;
  cls.$jsBase = layout === null ? null : layout === ListLayout || layout === TupleLayout ? layout : Ctor;
  finishType(cls, name, bases, dict, module);
  if (layout !== null && layout.prototype instanceof PrimBox) {
    const i = cls.$mro.findIndex((c) => c.$ctor === null && c.$jsBase !== undefined && c.$jsBase !== null);
    const px = hooks.primProxy(cls.$mro[i]);
    if (!cls.$mro.includes(px)) cls.$mro.splice(i, 0, px);
    refreshFlags(cls);
  }
  return cls;
}

// Layout markers for subclasses of list and tuple (see objectType).
export class ListLayout {}
export class TupleLayout {}
// Instances of metaclasses are type objects, made by type.__new__.
export class TypeLayout {}

// Instances of Python subclasses of int, float and str box the primitive
// value in `$v`.  The subclass's MRO gets a hidden copy of the base type
// whose methods unbox their arguments (see primProxy in types.ts).
export class PrimBox {
  declare $cls: any;
  $v: any;
}
export class IntLayout extends PrimBox {}
export class FloatLayout extends PrimBox {}
export class StrLayout extends PrimBox {}
export const unbox = (x: any): any => (x instanceof PrimBox ? x.$v : x);

export function isType(x: any): x is PyType {
  return typeof x === "function" && x.$dict !== undefined;
}

export function lookupType(cls: PyType, name: string): any {
  const mro = cls.$mro;
  for (let i = 0; i < mro.length; i++) {
    const v = mro[i].$dict.get(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

function bumpVersion(cls: PyType) {
  cls.$ver = versionCounter++;
  refreshFlags(cls);
  for (const s of cls.$subclasses) bumpVersion(s);
}

export function setTypeAttr(cls: PyType, name: string, value: any) {
  if (cls.$ctor === null && cls.$module === "builtins") raise(T.TypeError, `cannot set '${name}' attribute of immutable type '${cls.$name}'`);
  cls.$dict.set(name, value);
  bumpVersion(cls);
}

export function delTypeAttr(cls: PyType, name: string) {
  if (cls.$ctor === null && cls.$module === "builtins") raise(T.TypeError, `cannot delete '${name}' attribute of immutable type '${cls.$name}'`);
  if (!cls.$dict.delete(name)) raise(T.AttributeError, `type object '${cls.$name}' has no attribute '${name}'`);
  bumpVersion(cls);
}

// ------------------------------------------------------------------ values

export class FloatBox {
  constructor(public v: number) {}
}
// Iterators implement $next(), returning DONE when exhausted.
export const DONE: any = Object.freeze({ done: true });
export const NotImplemented: any = Object.create(null);
export const Ellipsis: any = Object.create(null);

export function typeOf(x: any): PyType {
  switch (typeof x) {
    case "number":
      return Number.isInteger(x) ? T.int : T.float;
    case "string":
      return T.str;
    case "boolean":
      return T.bool;
    case "bigint":
      return T.int;
    case "function":
      if (x.$dict !== undefined) return x.$meta ?? T.type;
      if (x.$self !== undefined) return T.method;
      return x.$pyfn === true ? T.function : T.builtin_function_or_method;
    case "object": {
      if (x === null) return T.NoneType;
      const c = x.$cls;
      if (c !== undefined) return c;
      if (Array.isArray(x)) return (x as any).$t === true ? T.tuple : T.list;
      if (x === NotImplemented) return T.NotImplementedType;
      if (x === Ellipsis) return T.ellipsis;
      if (x[Symbol.toStringTag] === "Generator") return T.generator;
      return T.object;
    }
  }
  throw new Error(`internal error: ${String(x)} is not a Python value`);
}

export function typeName(x: any): string {
  return typeOf(x).$name;
}

export function isinstance(x: any, cls: PyType): boolean {
  if (cls === T.object) return true;
  return typeOf(x).$mro.includes(cls);
}

// ------------------------------------------------------------------ functions

export interface Signature {
  args: string[];
  posonly: number;
  vararg: string | null;
  kwonly: string[];
  kwarg: string | null;
}

// Mark a JS function as a Python function (compiled code) or a builtin
// method that binds like one (takes self first).
export function pyfn(f: any, name: string, sig: Signature | null = null): any {
  f.$pyfn = true;
  f.__name__ = name;
  f.__qualname__ = name;
  if (sig !== null) f.$sig = sig;
  return f;
}

export function builtin(f: any, name: string, sig: Signature | null = null): any {
  f.__name__ = name;
  f.__qualname__ = name;
  if (sig !== null) f.$sig = sig;
  return f;
}

export function sig(args: string[], opts: Partial<Signature> = {}): Signature {
  return { args, posonly: opts.posonly ?? 0, vararg: opts.vararg ?? null, kwonly: opts.kwonly ?? [], kwarg: opts.kwarg ?? null };
}

// Lay out positional and keyword arguments as the implementation function's
// parameters: [...args, vararg tuple?, ...kwonly, kwarg dict?].  Missing
// arguments are `undefined`; the implementation applies defaults.
export function bindArgs(name: string, s: Signature, pos: any[], names: string[], values: any[]): any[] {
  const n = s.args.length;
  if (pos.length > n && s.vararg === null) {
    raise(T.TypeError, `${name}() takes ${n} positional argument${n === 1 ? "" : "s"} but ${pos.length} ${pos.length === 1 ? "was" : "were"} given`);
  }
  const out = new Array(n);
  for (let i = 0; i < n && i < pos.length; i++) out[i] = pos[i];
  const kwonly = new Array(s.kwonly.length);
  let kwdict: any;
  if (s.kwarg !== null) kwdict = newDict();
  for (let i = 0; i < names.length; i++) {
    const k = names[i];
    const j = s.args.indexOf(k);
    if (j >= s.posonly) {
      if (out[j] !== undefined) raise(T.TypeError, `${name}() got multiple values for argument '${k}'`);
      out[j] = values[i];
      continue;
    }
    const m = s.kwonly.indexOf(k);
    if (m >= 0) {
      kwonly[m] = values[i];
      continue;
    }
    if (kwdict !== undefined) dictSet(kwdict, k, values[i]);
    else if (j >= 0) raise(T.TypeError, `${name}() got some positional-only arguments passed as keyword arguments: '${k}'`);
    else raise(T.TypeError, `${name}() got an unexpected keyword argument '${k}'`);
  }
  if (s.vararg !== null) out.push(tuple(pos.slice(n)));
  for (const v of kwonly) out.push(v);
  if (s.kwarg !== null) out.push(kwdict);
  return out;
}

export function tooManyArgs(f: any, given: number): never {
  const n = f.$sig ? f.$sig.args.length : f.length;
  raise(T.TypeError, `${f.__name__}() takes ${n} positional argument${n === 1 ? "" : "s"} but ${given} ${given === 1 ? "was" : "were"} given`);
}

export function missingArg(f: any, name: string, kwonly = false): never {
  raise(T.TypeError, `${f.__name__}() missing 1 required ${kwonly ? "keyword-only" : "positional"} argument: '${name}'`);
}

export function bindMethod(f: any, self: any): any {
  const m: any = (...a: any[]) => f(self, ...a);
  m.$self = self;
  m.$func = f;
  m.$kw = (pos: any[], names: string[], values: any[]) => callKw(f, [self, ...pos], names, values);
  return m;
}

export function callObj(f: any, args: any[]): any {
  if (typeof f === "function") return f(...args);
  const c = lookupType(typeOf(f), "__call__");
  if (c !== undefined) return c(f, ...args);
  raise(T.TypeError, `'${typeName(f)}' object is not callable`);
}

export function callKw(f: any, pos: any[], names: string[], values: any[]): any {
  if (typeof f === "function") {
    if (names.length === 0) return f(...pos);
    if (f.$kw !== undefined) return f.$kw(pos, names, values);
    if (f.$sig !== undefined) return (f.$raw ?? f)(...bindArgs(f.__name__, f.$sig, pos, names, values));
    raise(T.TypeError, `${f.__name__ ?? f.name}() takes no keyword arguments`);
  }
  const c = lookupType(typeOf(f), "__call__");
  if (c !== undefined) return callKw(c, [f, ...pos], names, values);
  raise(T.TypeError, `'${typeName(f)}' object is not callable`);
}

// ------------------------------------------------------------------ construction

// Instances of a metaclass that overrides __call__ are created by it.
function metaCall(cls: any): any {
  const call = lookupType(cls.$meta, "__call__");
  return call === hooks.typeCall ? undefined : call;
}

function construct(cls: PyType, args: any[]): any {
  if ((cls as any).$meta !== undefined) {
    const call = metaCall(cls);
    if (call !== undefined) return call(cls, ...args);
  }
  return constructPlain(cls, args);
}

export function constructPlain(cls: PyType, args: any[]): any {
  if (cls.$ctor === null) return cls(...args);
  let c = (cls as any).$ni;
  if (c === undefined || c.ver !== cls.$ver) c = (cls as any).$ni = { ver: cls.$ver, nw: lookupType(cls, "__new__"), init: lookupType(cls, "__init__") };
  const nw = c.nw;
  let o: any;
  if (nw !== undefined && nw !== objectNew) {
    o = nw(cls, ...args);
    if (!isinstance(o, cls)) return o;
  } else o = new cls.$ctor!();
  const init = c.init;
  if (init === objectInit) {
    if (args.length && (nw === undefined || nw === objectNew)) raise(T.TypeError, `${cls.$name}() takes no arguments`);
  } else {
    const r = init(o, ...args);
    if (r !== null) raise(T.TypeError, `__init__() should return None, not '${typeName(r)}'`);
  }
  return o;
}

function constructKw(cls: PyType, pos: any[], names: string[], values: any[]): any {
  if ((cls as any).$meta !== undefined) {
    const call = metaCall(cls);
    if (call !== undefined) return callKw(call, [cls, ...pos], names, values);
  }
  return constructPlainKw(cls, pos, names, values);
}

export function constructPlainKw(cls: PyType, pos: any[], names: string[], values: any[]): any {
  if (cls.$ctor === null) return callKw(cls, pos, names, values);
  const nw = lookupType(cls, "__new__");
  let o: any;
  if (nw !== undefined && nw !== objectNew) {
    o = callKw(nw, [cls, ...pos], names, values);
    if (!isinstance(o, cls)) return o;
  } else o = new cls.$ctor!();
  const init = lookupType(cls, "__init__");
  if (init === objectInit) {
    if (nw === undefined || nw === objectNew) raise(T.TypeError, `${cls.$name}() takes no arguments`);
    return o;
  }
  const r = callKw(init, [o, ...pos], names, values);
  if (r !== null) raise(T.TypeError, `__init__() should return None, not '${typeName(r)}'`);
  return o;
}

export const objectInit = pyfn(function __init__(self: any, ...args: any[]) {
  return null;
}, "__init__");
export const objectNew = pyfn(function __new__(cls: PyType, ...args: any[]) {
  if (!isType(cls)) raise(T.TypeError, `object.__new__(X): X is not a type object (${typeName(cls)})`);
  if (cls.$ctor === null) raise(T.TypeError, `object.__new__(${cls.$name}) is not safe, use ${cls.$name}.__new__()`);
  return new cls.$ctor();
}, "__new__");

// ------------------------------------------------------------------ attributes

export function isDataDescriptor(d: any): boolean {
  if (d === null || typeof d !== "object") return false;
  const t = typeOf(d);
  return lookupType(t, "__set__") !== undefined || lookupType(t, "__delete__") !== undefined;
}

// Instances with an attribute dict: objects created from a Python class or a
// module, never runtime-internal objects.
export function hasInstanceDict(o: any): boolean {
  return o !== null && typeof o === "object" && o.$cls !== undefined && o.$cls.$ctor !== null;
}

function descrGet(d: any, o: any, t: PyType): any {
  if (typeof d === "function") return d.$pyfn === true && o !== null && d.$static !== true ? bindMethod(d, o) : d;
  if (d !== null && typeof d === "object") {
    const g = lookupType(typeOf(d), "__get__");
    if (g !== undefined) return g(d, o, t);
  }
  return d;
}

export function getattr(o: any, name: string, dflt?: any): any {
  if (isType(o)) return typeGetattr(o, name, dflt);
  const t = typeOf(o);
  if (t.$customGet) {
    const ga = lookupType(t, "__getattribute__");
    if (ga !== undefined) {
      try {
        return ga(o, name);
      } catch (e) {
        if (!isinstance(e, T.AttributeError)) throw e;
        const gf = lookupType(t, "__getattr__");
        if (gf !== undefined) return gf(o, name);
        if (dflt !== undefined) return dflt;
        throw e;
      }
    }
  }
  return genericGetattr(o, name, t, dflt);
}

export function genericGetattr(o: any, name: string, t: PyType, dflt?: any): any {
  const d = lookupType(t, name);
  // A data descriptor without __get__ yields to the instance dict.
  if (d !== undefined && isDataDescriptor(d) && (lookupType(typeOf(d), "__get__") !== undefined || !(hasInstanceDict(o) && hasOwn.call(o, name)))) return descrGetOrGetattr(d, o, t, name);
  if (hasInstanceDict(o) && hasOwn.call(o, name)) return o[name];
  if (typeof o === "function" && o.$attrs !== undefined && o.$attrs.has(name)) return o.$attrs.get(name);
  if (d !== undefined) return descrGetOrGetattr(d, o, t, name);
  const gf = lookupType(t, "__getattr__");
  if (gf !== undefined) return gf(o, name);
  if (dflt !== undefined) return dflt;
  raise(T.AttributeError, `'${t.$name}' object has no attribute '${name}'`);
}

// An AttributeError from a descriptor's __get__ falls back to __getattr__.
function descrGetOrGetattr(d: any, o: any, t: PyType, name: string): any {
  if (d === null || typeof d !== "object") return descrGet(d, o, t);
  const gf = lookupType(t, "__getattr__");
  if (gf === undefined) return descrGet(d, o, t);
  try {
    return descrGet(d, o, t);
  } catch (e) {
    if (!isinstance(e, T.AttributeError)) throw e;
    return gf(o, name);
  }
}

function typeGetattr(cls: PyType, name: string, dflt?: any): any {
  const meta = (cls as any).$meta ?? T.type;
  const md = lookupType(meta, name);
  if (md !== undefined && isDataDescriptor(md)) return descrGet(md, cls, meta);
  const d = lookupType(cls, name);
  if (d !== undefined) {
    if (typeof d === "function") return d.$builtinMethod === true && cls.$ctor === null ? selfChecked(d, cls) : d; // functions on a class are plain functions
    if (d !== null && typeof d === "object") {
      const g = lookupType(typeOf(d), "__get__");
      if (g !== undefined) return g(d, null, cls);
    }
    return d;
  }
  if (md !== undefined) return descrGet(md, cls, meta);
  if (dflt !== undefined) return dflt;
  raise(T.AttributeError, `type object '${cls.$name}' has no attribute '${name}'`);
}

// `list.append` and friends, called unbound: CPython checks self's type.
function selfChecked(f: any, cls: PyType): any {
  let c = f.$selfChecked;
  if (c === undefined) {
    c = function (self: any, ...args: any[]) {
      if (self === undefined) raise(T.TypeError, `unbound method ${cls.$name}.${f.__name__}() needs an argument`);
      if (!isinstance(self, cls)) raise(T.TypeError, `descriptor '${f.__name__}' for '${cls.$name}' objects doesn't apply to a '${typeName(self)}' object`);
      return f(self, ...args);
    };
    for (const k of Object.keys(f)) c[k] = f[k];
    if (f.$sig !== undefined) c.$kw = (pos: any[], names: string[], values: any[]) => callKw(f, pos, names, values);
    f.$selfChecked = c;
  }
  return c;
}

export function setattr(o: any, name: string, v: any): void {
  if (isType(o)) return setTypeAttr(o, name, v);
  const t = typeOf(o);
  if (t.$customSet) {
    const sa = lookupType(t, "__setattr__");
    if (sa !== undefined && sa !== objectSetattr) {
      sa(o, name, v);
      return;
    }
  }
  genericSetattr(o, name, v, t);
}

export function genericSetattr(o: any, name: string, v: any, t: PyType) {
  const d = lookupType(t, name);
  if (d !== undefined && d !== null && typeof d === "object") {
    const s = lookupType(typeOf(d), "__set__");
    if (s !== undefined) {
      s(d, o, v);
      return;
    }
  }
  if (hasInstanceDict(o)) {
    o[name] = v;
    return;
  }
  if (typeof o === "function" && o.$pyfn === true) {
    if (name === "__defaults__" || name === "__name__" || name === "__qualname__" || name === "__doc__" || name === "__module__") o[name] = v;
    else (o.$attrs ??= new Map()).set(name, v);
    return;
  }
  if (d !== undefined) raise(T.AttributeError, `'${t.$name}' object attribute '${name}' is read-only`);
  raise(T.AttributeError, `'${t.$name}' object has no attribute '${name}' and no __dict__ for setting new attributes`);
}

export const objectSetattr = pyfn(function __setattr__(o: any, name: string, v: any) {
  if (typeof name !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
  genericSetattr(o, name, v, typeOf(o));
  return null;
}, "__setattr__");

export function delattr(o: any, name: string): void {
  if (isType(o)) return delTypeAttr(o, name);
  const t = typeOf(o);
  const dl = lookupType(t, "__delattr__");
  if (dl !== undefined && dl.$genericDelattr !== true) {
    dl(o, name);
    return;
  }
  genericDelattr(o, name, t);
}

export function genericDelattr(o: any, name: string, t: PyType): void {
  if (name === "__dict__" && hasInstanceDict(o) && lookupType(t, "__dict__") === lookupType(T.object, "__dict__")) {
    for (const k of Object.keys(o)) if (k[0] !== "$" && !(Array.isArray(o) && /^\d+$/.test(k))) delete o[k];
    return;
  }
  const d = lookupType(t, name);
  if (d !== undefined && d !== null && typeof d === "object") {
    const del = lookupType(typeOf(d), "__delete__");
    if (del !== undefined) {
      del(d, o);
      return;
    }
  }
  if (hasInstanceDict(o) && hasOwn.call(o, name)) {
    delete o[name];
    return;
  }
  raise(T.AttributeError, `'${t.$name}' object has no attribute '${name}'`);
}

// ------------------------------------------------------------------ inline caches
//
// Each attribute or method-call site gets its own small generated function,
// so each owns its V8 type feedback.  Caches are keyed on (class, version);
// any change to a class or its bases bumps the version.

function getattrMiss(o: any, name: string, S: any): any {
  if (isType(o)) {
    // Class attributes that are plain values or functions can be cached
    // on (class, version); descriptors and type's own attributes cannot.
    const v = getattr(o, name);
    const d = lookupType(o, name);
    if (d !== undefined && d === v && lookupType(typeOf(o), name) === undefined && (typeof d !== "object" || d === null || lookupType(typeOf(d), "__get__") === undefined)) {
      S.tc = o;
      S.tv = o.$ver;
      S.tval = v;
    }
    return v;
  }
  if (o !== null && typeof o === "object" && o.$cls !== undefined) {
    const cls: PyType = o.$cls;
    if (!cls.$customGet && cls.$ctor !== null) {
      const d = lookupType(cls, name);
      if (d === undefined || !isDataDescriptor(d)) {
        if (hasOwn.call(o, name)) {
          S.c = cls;
          S.v = cls.$ver;
          S.k = 0;
          return o[name];
        }
        if (d !== undefined && !(typeof d === "function" && d.$pyfn === true) && (d === null || typeof d !== "object" || lookupType(typeOf(d), "__get__") === undefined)) {
          S.c = cls;
          S.v = cls.$ver;
          S.k = 1;
          S.val = d;
          return d;
        }
      }
    }
  }
  return getattr(o, name);
}

function setattrMiss(o: any, name: string, v: any, S: any): void {
  if (o !== null && typeof o === "object" && o.$cls !== undefined) {
    const cls: PyType = o.$cls;
    if (!cls.$customSet && cls.$ctor !== null) {
      const d = lookupType(cls, name);
      if (d === undefined || !isDataDescriptor(d)) {
        S.c = cls;
        S.v = cls.$ver;
        o[name] = v;
        return;
      }
    }
  }
  setattr(o, name, v);
}

// Receiver kinds without a `$cls` (primitives and arrays).
export const BK_STR = 1, BK_LIST = 2, BK_TUPLE = 3, BK_INT = 4, BK_FLOAT = 5;
export function builtinKind(o: any): number {
  switch (typeof o) {
    case "string":
      return BK_STR;
    case "number":
      return Number.isInteger(o) ? BK_INT : BK_FLOAT;
    case "bigint":
      return BK_INT;
    case "object":
      if (Array.isArray(o)) return (o as any).$t === true ? BK_TUPLE : BK_LIST;
  }
  return 0;
}
const KIND_TYPE: Record<number, string> = { [BK_STR]: "str", [BK_LIST]: "list", [BK_TUPLE]: "tuple", [BK_INT]: "int", [BK_FLOAT]: "float" };

const CALL_WAYS = 4;
function callMethodMiss(o: any, name: string, args: any[], S: any): any {
  if (isType(o)) {
    // Methods looked up on a class (functions, staticmethods, classmethods)
    // are stable for a given class version.
    const f = getattr(o, name);
    if (typeof f === "function" && lookupType(typeOf(o), name) === undefined) {
      S.tc = o;
      S.tv = o.$ver;
      S.tf = f;
    }
    return callObj(f, args);
  }
  if (o !== null && typeof o === "object" && o.$cls !== undefined) {
    const cls: PyType = o.$cls;
    if (!cls.$customGet && !(cls.$ctor !== null && hasOwn.call(o, name))) {
      const d = lookupType(cls, name);
      if (typeof d === "function" && d.$pyfn === true && d.$static !== true) {
        fillCallSite(S, cls, d);
        return d(o, ...args);
      }
    }
  } else {
    const k = builtinKind(o);
    if (k !== 0) {
      const d = T[KIND_TYPE[k]].$dict.get(name) ?? lookupType(T[KIND_TYPE[k]], name);
      if (typeof d === "function" && d.$pyfn === true) {
        S.bk = k;
        S.bfn = d;
        return d(o, ...args);
      }
    }
  }
  return callObj(getattr(o, name), args);
}

function fillCallSite(S: any, cls: PyType, fn: any) {
  for (let i = 0; i < CALL_WAYS; i++) {
    if (S["c" + i] === cls) {
      S["v" + i] = cls.$ver;
      S["f" + i] = fn;
      return;
    }
  }
  const i = S.next;
  S.next = (i + 1) % CALL_WAYS;
  S["c" + i] = cls;
  S["v" + i] = cls.$ver;
  S["f" + i] = fn;
}

const jsName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "attr");

export function siteGet(name: string): (o: any) => any {
  const S = { c: null, v: -1, k: 0, val: undefined, tc: undefined as any, tv: -1, tval: undefined };
  const p = JSON.stringify(name);
  return new Function("S", "miss", "hasOwn", `"use strict"; return function get_${jsName(name)}(o) {
  if (o != null && o.$cls === S.c && S.c.$ver === S.v) {
    if (S.k === 0) { const t = o[${p}]; if (t !== undefined) return t; }
    else if (o[${p}] === undefined || (S.c.$jsBase !== null && !hasOwn.call(o, ${p}))) return S.val;
  } else if (o === S.tc && o.$ver === S.tv) return S.tval;
  return miss(o, ${p}, S);
};`)(S, getattrMiss, hasOwn);
}

export function siteSet(name: string): (o: any, v: any) => void {
  const S = { c: null, v: -1 };
  const p = JSON.stringify(name);
  return new Function("S", "miss", `"use strict"; return function set_${jsName(name)}(o, v) {
  if (o != null && o.$cls === S.c && S.c.$ver === S.v) { o[${p}] = v; return; }
  miss(o, ${p}, v, S);
};`)(S, setattrMiss);
}

export function siteCall(name: string, n: number): (o: any, ...args: any[]) => any {
  const S: any = { next: 0, bk: 0, bfn: null, tc: undefined, tv: -1, tf: null };
  for (let i = 0; i < CALL_WAYS; i++) {
    S["c" + i] = null;
    S["v" + i] = -1;
    S["f" + i] = null;
  }
  const ps = Array.from({ length: n }, (_, i) => "a" + i).join(", ");
  const c = n ? ", " : "";
  const p = JSON.stringify(name);
  const ways = Array.from({ length: CALL_WAYS }, (_, i) => `    if (k === S.c${i} && k.$ver === S.v${i}) return S.f${i}(o${c}${ps});`).join("\n");
  return new Function("S", "miss", "kind", "hasOwn", `"use strict"; return function call_${jsName(name)}(o${c}${ps}) {
  if (o != null) {
    const k = o.$cls;
    if (k !== undefined && (o[${p}] === undefined || (k.$jsBase !== null && !hasOwn.call(o, ${p})))) {
${ways}
    }
  }
  if (o === S.tc && o.$ver === S.tv) return S.tf(${ps});
  if (S.bk !== 0 && kind(o) === S.bk) return S.bfn(o${c}${ps});
  return miss(o, ${p}, [${ps}], S);
};`)(S, callMethodMiss, builtinKind, hasOwn);
}

// ------------------------------------------------------------------ exceptions

// Raised Python exceptions are thrown as the exception instance itself.  The
// JS stack is captured into `$tb` when raised, for tracebacks.
export function raise(cls: PyType, msg?: string): never {
  throw newException(cls, msg === undefined ? [] : [msg]);
}

export function newException(cls: PyType, args: any[]): any {
  const e = cls(...args);
  captureTraceback(e);
  return e;
}

export function captureTraceback(e: any, force = false) {
  if (e.$tb === undefined || force) {
    const holder: any = {};
    Error.captureStackTrace(holder, captureTraceback);
    Object.defineProperty(e, "$tb", { value: holder, writable: true, enumerable: false, configurable: true });
  }
}

// `raise X` / `raise X from Y` in compiled code.
export function raiseExc(x: any, cause?: any): any {
  let e = x;
  if (isType(x)) {
    if (!x.$mro.includes(T.BaseException)) raise(T.TypeError, "exceptions must derive from BaseException");
    e = x();
  } else if (!isinstance(x, T.BaseException)) raise(T.TypeError, "exceptions must derive from BaseException");
  if (cause !== undefined) {
    const c = isType(cause) ? cause() : cause;
    if (c !== null && !isinstance(c, T.BaseException)) raise(T.TypeError, "exception causes must derive from BaseException");
    e.__cause__ = c;
    e.__suppress_context__ = true;
  }
  captureTraceback(e, true);
  return e;
}

// Convert anything caught by a JS `catch` into a Python exception.
export function toPyExc(e: any): any {
  if (e !== null && typeof e === "object" && e.$cls !== undefined && isinstance(e, T.BaseException)) return e;
  if (e instanceof TypeError && /Generator is already running|Generator is executing/.test(e.message)) {
    const r = T.ValueError("generator already executing");
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return r;
  }
  // A sandboxed runtime refused an operation: Deno permissions (NotCapable,
  // PermissionDenied) or Node's permission model (ERR_ACCESS_DENIED).
  if (e instanceof Error && (e.name === "NotCapable" || e.name === "PermissionDenied" || (e as any).code === "ERR_ACCESS_DENIED")) {
    const r = T.PermissionError(e.message.split("\n")[0]);
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return r;
  }
  if (e instanceof RangeError && /call stack/.test(e.message)) {
    const r = T.RecursionError("maximum recursion depth exceeded");
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return r;
  }
  const r = T.SystemError(`internal error: ${e && e.stack ? e.stack : String(e)}`);
  Object.defineProperty(r, "$tb", { value: e instanceof Error ? e : {}, writable: true, enumerable: false });
  return r;
}

export function excMatch(e: any, spec: any): boolean {
  if (Array.isArray(spec)) return spec.some((s) => excMatch(e, s));
  if (!isType(spec) || !spec.$mro.includes(T.BaseException)) raise(T.TypeError, "catching classes that do not inherit from BaseException is not allowed");
  return isinstance(e, spec);
}

// ------------------------------------------------------------------ containers used by the core

export function tuple(a: any[]): any[] {
  (a as any).$t = true;
  return a;
}

// dict: a Map from normalized keys.  Strings, ints, floats, None and bools
// normalize to JS primitives so that 1, 1.0 and True collide as in Python.
// Other keys hash to a number and live in per-hash buckets; their Map key is
// the bucket entry, which keeps one insertion order for all keys.
export class PyDict {
  declare $cls: any; // on the prototype: dict, or a Python subclass
  $m = new Map<any, any>();
  $orig: Map<any, any> | null = null; // normalized -> original key, when they differ
  $buckets: Map<number, any[]> | null = null; // hash -> entries {k, h}
  // hash -> numeric primitive keys, built on demand so that an object key
  // equal to a number (e.g. mpmath's mpf(1) == 1) finds its entry.
  $nidx: Map<number, any[]> | null = null;
  $hasNum = false;
}

// The numeric primitive key in `d` equal to the object key `k`, if any.
function numAlias(d: PyDict, k: any): any {
  if (!d.$hasNum) return undefined;
  let idx = d.$nidx;
  if (idx === null) {
    idx = d.$nidx = new Map();
    for (const pk of d.$m.keys()) {
      if (typeof pk === "number" || typeof pk === "bigint") {
        const h = hooks.hash(pk);
        const l = idx.get(h);
        if (l === undefined) idx.set(h, [pk]);
        else l.push(pk);
      }
    }
  }
  const l = idx.get(hooks.hash(k));
  if (l !== undefined) for (const pk of l) if (hooks.eq(pk, k)) return pk;
  return undefined;
}

// The live `__dict__` of an instance: a PyDict whose `$m` is this Map-like
// view of the object's own (non-`$`) properties.
const isAttrKey = (o: any, k: string) => k[0] !== "$" && !(Array.isArray(o) && /^\d+$/.test(k));
export class AttrMap {
  constructor(public o: any) {}
  private names(): string[] {
    return Object.keys(this.o).filter((k) => isAttrKey(this.o, k));
  }
  get(k: any): any {
    return typeof k === "string" && isAttrKey(this.o, k) && hasOwn.call(this.o, k) ? this.o[k] : undefined;
  }
  has(k: any): boolean {
    return typeof k === "string" && isAttrKey(this.o, k) && hasOwn.call(this.o, k);
  }
  set(k: any, v: any): this {
    if (typeof k !== "string") raise(T.TypeError, `instance __dict__ keys must be str here, not '${typeName(k)}'`);
    this.o[k] = v;
    return this;
  }
  delete(k: any): boolean {
    if (!this.has(k)) return false;
    delete this.o[k];
    return true;
  }
  clear(): void {
    for (const k of this.names()) delete this.o[k];
  }
  get size(): number {
    return this.names().length;
  }
  keys(): IterableIterator<string> {
    return this.names()[Symbol.iterator]();
  }
  values(): IterableIterator<any> {
    return this.names().map((k) => this.o[k])[Symbol.iterator]();
  }
  entries(): IterableIterator<[string, any]> {
    return this.names().map((k) => [k, this.o[k]] as [string, any])[Symbol.iterator]();
  }
  [Symbol.iterator](): IterableIterator<[string, any]> {
    return this.entries();
  }
  forEach(f: (v: any, k: string) => void): void {
    for (const k of this.names()) f(this.o[k], k);
  }
}
const instanceDicts = new WeakMap<object, PyDict>();
export function instanceDict(o: any): PyDict {
  let d = instanceDicts.get(o);
  if (d === undefined) {
    d = new PyDict();
    (d as any).$m = new AttrMap(o);
    instanceDicts.set(o, d);
  }
  return d;
}

export function newDict(): PyDict {
  return new PyDict();
}

// Hooks filled in by ops.ts (hash and equality need the full operator set).
export const hooks: { hash: (x: any) => number; eq: (a: any, b: any) => boolean; repr: (x: any) => string; primProxy: (base: PyType) => PyType; typeCall: any; importModule: (name: string) => any; callerModule: () => string } = {
  typeCall: null,
  importModule: () => null,
  callerModule: () => "__main__",
  hash: () => 0,
  eq: (a, b) => a === b,
  repr: (x) => String(x),
  primProxy: (b) => b,
};

function primitiveKey(k: any): any {
  switch (typeof k) {
    case "string":
    case "number":
    case "bigint":
      return k;
    case "boolean":
      return k ? 1 : 0;
    case "object":
      if (k === null) return null;
      if (k instanceof FloatBox) {
        const v = k.v + 0;
        return Number.isSafeInteger(v) ? v : Number.isFinite(v) ? BigInt(v) : v;
      }
      // A str/int/float subclass keeping the base __hash__ and __eq__ is
      // the same key as its value.
      if (k instanceof PrimBox && lookupType(k.$cls, "__hash__")?.$unboxing === true && lookupType(k.$cls, "__eq__")?.$unboxing === true) return primitiveKey(k.$v);
  }
  return undefined;
}

function bucketEntry(d: PyDict, k: any, create: boolean): any {
  const h = hooks.hash(k);
  let list = d.$buckets?.get(h);
  if (list !== undefined) {
    for (const e of list) if (e.k === k || hooks.eq(e.k, k)) return e;
  }
  if (!create) return undefined;
  const e = { k, h };
  d.$buckets ??= new Map();
  if (list === undefined) d.$buckets.set(h, (list = []));
  list.push(e);
  return e;
}

export function dictGet(d: PyDict, k: any): any {
  if (typeof k === "string") return d.$m.get(k);
  const p = primitiveKey(k);
  if (p !== undefined) {
    const v = d.$m.get(p);
    if (v !== undefined || d.$buckets === null || typeof p === "string" || p === null) return v;
    const e = bucketEntry(d, k, false);
    return e === undefined ? undefined : d.$m.get(e);
  }
  if (d.$buckets === null) {
    hooks.hash(k); // unhashable keys raise even on a miss
    const a = numAlias(d, k);
    return a === undefined ? undefined : d.$m.get(a);
  }
  const e = bucketEntry(d, k, false);
  if (e !== undefined) return d.$m.get(e);
  const a = numAlias(d, k);
  return a === undefined ? undefined : d.$m.get(a);
}

export function dictSet(d: PyDict, k: any, v: any): void {
  if (typeof k === "string") {
    d.$m.set(k, v);
    return;
  }
  const p = primitiveKey(k);
  if (p !== undefined) {
    if (typeof p !== "string" && p !== null && d.$buckets !== null && !d.$m.has(p)) {
      const e = bucketEntry(d, k, false);
      if (e !== undefined) {
        d.$m.set(e, v);
        return;
      }
    }
    if (p !== k && !d.$m.has(p)) (d.$orig ??= new Map()).set(p, k);
    if (typeof p === "number" || typeof p === "bigint") {
      d.$hasNum = true;
      d.$nidx = null;
    }
    d.$m.set(p, v);
    return;
  }
  if (d.$hasNum && (d.$buckets === null || bucketEntry(d, k, false) === undefined)) {
    const a = numAlias(d, k);
    if (a !== undefined) {
      d.$m.set(a, v);
      return;
    }
  }
  d.$m.set(bucketEntry(d, k, true), v);
}

export function dictDelete(d: PyDict, k: any): boolean {
  const p = primitiveKey(k);
  if (p !== undefined) {
    d.$orig?.delete(p);
    if (d.$m.delete(p)) {
      d.$nidx = null;
      return true;
    }
    if (typeof p === "string" || p === null || d.$buckets === null) return false;
  }
  const e = d.$buckets === null ? undefined : bucketEntry(d, k, false);
  if (e === undefined) {
    hooks.hash(k);
    const a = p === undefined ? numAlias(d, k) : undefined;
    if (a !== undefined) {
      d.$orig?.delete(a);
      d.$nidx = null;
      return d.$m.delete(a);
    }
    return false;
  }
  const list = d.$buckets!.get(e.h)!;
  list.splice(list.indexOf(e), 1);
  return d.$m.delete(e);
}

// Convert a Map key back to the Python key object.
export function dictKeyOf(d: PyDict, mk: any): any {
  if (mk !== null && typeof mk === "object") return mk.k;
  if (d.$orig !== null) {
    const o = d.$orig.get(mk);
    if (o !== undefined) return o;
  }
  return mk;
}

export function dictClear(d: PyDict) {
  d.$nidx = null;
  d.$m.clear();
  d.$orig = null;
  d.$buckets = null;
}

// bytes and bytearray share a byte buffer; only bytearray's length changes.
export class PyBytes {
  constructor(public a: Uint8Array, public n: number = a.length) {}
}
export class PyByteArray extends PyBytes {}
export function isBytesLike(x: any): x is PyBytes {
  return x instanceof PyBytes;
}

// ------------------------------------------------------------------ builtin arity

// [min, max] positional arguments of a JS function, from its source:
// parameters before the first default are required; `...rest` is unbounded.
export function jsArity(f: any): [number, number] {
  const src = Function.prototype.toString.call(f);
  const open = src.indexOf("(");
  const arrow = src.indexOf("=>");
  if (open < 0 || (arrow >= 0 && arrow < open)) return [1, 1]; // `x => ...`
  let depth = 0, i = open, params = "";
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
    }
    if (i > open) params += depth === 1 && c === "," ? "\u0000" : c;
  }
  const parts = params.split("\u0000").map((p) => p.trim()).filter((p) => p.length);
  if (parts.some((p) => p.startsWith("..."))) return [f.length, Infinity];
  return [f.length, parts.length];
}

function arityError(name: string, min: number, max: number, n: number, self: boolean): never {
  const d = self ? 1 : 0;
  const [lo, hi, got] = [min - d, max - d, n - d];
  let msg: string;
  if (lo === hi) msg = `${name}() takes ${lo === 0 ? "no arguments" : lo === 1 ? "exactly one argument" : `exactly ${lo} arguments`} (${got} given)`;
  else if (got < lo) msg = `${name} expected at least ${lo} argument${lo === 1 ? "" : "s"}, got ${got}`;
  else msg = `${name} expected at most ${hi} argument${hi === 1 ? "" : "s"}, got ${got}`;
  raise(T.TypeError, msg);
}

// Wrap a builtin so calls with the wrong number of positional arguments
// raise TypeError.  The wrapper has a fixed parameter list so V8 inlines it.
export function checkArity(f: any, name: string, self: boolean, range?: [number, number]): any {
  let [min, max] = range ?? jsArity(f);
  // A method written without parameters still receives self.
  if (self && range === undefined && max === 0) max = 1;
  // Keyword-only parameters cannot be passed positionally.
  const s = f.$sig;
  if (range === undefined && s !== undefined && s !== null && s.vararg === null && s.kwonly.length > 0) {
    max = s.args.length;
    min = Math.min(min, max);
  }
  let w: any;
  if (max === Infinity) {
    w = function (...a: any[]) {
      if (a.length < min) arityError(name, min, max, a.length, self);
      return f(...a);
    };
  } else {
    const ps = Array.from({ length: max }, (_, i) => "a" + i).join(", ");
    w = new Function("f", "err", `"use strict"; return function ${/^[A-Za-z_]\w*$/.test(name) ? name + "_" : "builtin"}(${ps}) { const n = arguments.length; if (n < ${min} || n > ${max}) err(n); return f(${ps}); };`)(f, (n: number) => arityError(name, min, max, n, self));
  }
  for (const k of Object.keys(f)) w[k] = f[k];
  // Keyword calls bind all parameters and call the unchecked function.
  w.$raw = f;
  return w;
}

// A Map-like view over an object's own properties, so a PyDict can be a
// live view of a module namespace (globals()).
export class ObjMap {
  constructor(public o: any) {}
  get size(): number {
    return this.names().length;
  }
  names(): string[] {
    return Object.keys(this.o).filter((k) => k[0] !== "$" && this.o[k] !== undefined);
  }
  keys(): IterableIterator<string> {
    return this.names().values();
  }
  get(k: any): any {
    return typeof k === "string" && Object.prototype.hasOwnProperty.call(this.o, k) ? this.o[k] : undefined;
  }
  has(k: any): boolean {
    return this.get(k) !== undefined;
  }
  set(k: any, v: any): this {
    if (typeof k !== "string") raise(T.TypeError, "module namespace keys must be strings");
    this.o[k] = v;
    return this;
  }
  delete(k: any): boolean {
    if (!this.has(k)) return false;
    delete this.o[k];
    return true;
  }
  clear() {
    for (const k of this.names()) delete this.o[k];
  }
  values(): IterableIterator<any> {
    return this.names().map((k) => this.o[k]).values();
  }
  entries(): IterableIterator<any[]> {
    return this.names().map((k) => [k, this.o[k]]).values();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}
export function globalsDict(g: any): PyDict {
  if (g.$globalsDict === undefined) {
    const d = new PyDict();
    (d as any).$m = new ObjMap(g);
    Object.defineProperty(g, "$globalsDict", { value: d, enumerable: false });
  }
  return g.$globalsDict;
}
// The namespace object behind a globals dict, or a proxy over a plain dict
// (exec/eval with an explicit globals mapping).
export const NS_DICT = Symbol("globals dict");
export const NS_GLOBALS = Symbol("globals of a layered namespace");
export function namespaceOf(d: any): any {
  if (d instanceof PyDict && (d.$m as any) instanceof ObjMap) return ((d.$m as any) as ObjMap).o;
  return new Proxy(Object.create(null), {
    get: (_t, k) => (typeof k === "string" ? dictGet(d, k) : k === NS_DICT ? d : undefined),
    set: (_t, k, v) => (typeof k === "string" && dictSet(d, k, v), true),
    has: (_t, k) => typeof k === "string" && dictGet(d, k) !== undefined,
    deleteProperty: (_t, k) => (typeof k === "string" && dictDelete(d, k), true),
    ownKeys: () => [...d.$m.keys()].filter((k: any) => typeof k === "string"),
    getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && dictGet(d, k) !== undefined ? { value: dictGet(d, k), writable: true, enumerable: true, configurable: true } : undefined),
  });
}
