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
  /** a JS-backed layout's own implementation field names (bytes' `a`/`n`, ...): not Python attributes */
  $impl?: Set<string>;
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
  // (a subclass of a JS-backed builtin inherits the names of that builtin's
  // own implementation fields, so they are not exposed as Python attributes)
  for (const b of cls.$mro) if (b !== cls && b.$impl) for (const f of b.$impl) (cls.$impl ??= new Set()).add(f);
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
  cls.$dict.set("__new__", inheritedNew(cls));
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
  (cls as any).$kwPos = true;
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

export function bumpVersion(cls: PyType) {
  cls.$ver = versionCounter++;
  refreshFlags(cls);
  for (const s of cls.$subclasses) bumpVersion(s);
}

export function setTypeAttr(cls: PyType, name: string, value: any) {
  if (cls.$ctor === null && cls.$module === "builtins") raise(T.TypeError, `cannot set '${name}' attribute of immutable type '${cls.$name}'`);
  // a data descriptor of the metaclass takes it (type's __name__,
  // __qualname__, or a metaclass's property), as CPython's type.__setattr__
  const d = lookupType(typeOf(cls), name);
  if (d !== undefined && d !== null && typeof d === "object") {
    const set = lookupType(typeOf(d), "__set__");
    if (set !== undefined) {
      set(d, cls, value);
      bumpVersion(cls);
      return;
    }
  }
  cls.$dict.set(name, value);
  bumpVersion(cls);
}

// (as setTypeAttr: CPython's type.__setattr__ with no value, the same
// TypeError for a builtin class, a data descriptor of the metaclass
// deleting it: a class's __annotations__)
export function delTypeAttr(cls: PyType, name: string) {
  if (cls.$ctor === null && cls.$module === "builtins") raise(T.TypeError, `cannot set '${name}' attribute of immutable type '${cls.$name}'`);
  const d = lookupType(typeOf(cls), name);
  if (d !== undefined && d !== null && typeof d === "object") {
    // (type's own writable ones without a deleter, __name__ or __doc__:
    // CPython's check_set_special_type_attr)
    if (typeOf(d) === T.getset_descriptor && d.owner === T.type && d.set !== null && d.del === null) raise(T.TypeError, `cannot delete '${name}' attribute of immutable type '${cls.$name}'`);
    const del = lookupType(typeOf(d), "__delete__");
    if (del !== undefined) {
      del(d, cls);
      bumpVersion(cls);
      return;
    }
  }
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

// The dunders CPython's builtin types give through their slots
// (typeobject.c slotdefs): their methods are wrapper_descriptors
export const SLOT_WRAPPERS = new Set(
  ("__getattribute__ __getattr__ __setattr__ __delattr__ __repr__ __str__ __hash__ __call__ __lt__ __le__ __eq__ __ne__ __gt__ __ge__ " +
    "__iter__ __next__ __get__ __set__ __delete__ __init__ __del__ __await__ __aiter__ __anext__ __add__ __radd__ __sub__ __rsub__ " +
    "__mul__ __rmul__ __mod__ __rmod__ __divmod__ __rdivmod__ __pow__ __rpow__ __neg__ __pos__ __abs__ __bool__ __invert__ " +
    "__lshift__ __rlshift__ __rshift__ __rrshift__ __and__ __rand__ __xor__ __rxor__ __or__ __ror__ __int__ __float__ __index__ " +
    "__iadd__ __isub__ __imul__ __imod__ __ipow__ __ilshift__ __irshift__ __iand__ __ixor__ __ior__ __truediv__ __rtruediv__ " +
    "__floordiv__ __rfloordiv__ __itruediv__ __ifloordiv__ __matmul__ __rmatmul__ __imatmul__ __len__ __getitem__ __setitem__ " +
    "__delitem__ __contains__ __buffer__ __release_buffer__").split(" "),
);
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
      // (a builtin type's method, unbound: CPython's method_descriptor, or
      // wrapper_descriptor for a slot's dunder, but for the few a type defines
// as methods, $methodDescr; types.ts)
      if (x.$pyfn === true && x.$builtinMethod === true) return (SLOT_WRAPPERS.has(x.__name__) && x.$methodDescr !== true ? T.wrapper_descriptor : T.method_descriptor) ?? T.function;
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

// (a lib class standing for a CPython C type: its tp_name, _pyjs_types.c_name)
export function typeName(x: any): string {
  const t: any = typeOf(x);
  return t.$tpName ?? t.$name;
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
  // (__func__: a builtin method's receiver-checking form, never the raw function)
  m.$func = f.$owner !== undefined ? selfChecked(f) : f;
  m.$kw = (pos: any[], names: string[], values: any[]) => callKw(f, [self, ...pos], names, values);
  m.$kwPos = true;
  return m;
}

// The __call__ of f's type when it is not a function, bound as CPython's
// call slot binds it: through its own type's __get__(c, f, type(f)) when
// that exists (a classmethod, property or descriptor), else c itself
// (None then raises TypeError when called).
function callSlot(c: any, f: any): any {
  if (c === null) return null;
  const get = lookupType(typeOf(c), "__get__");
  return get !== undefined ? callObj(get, [c, f, typeOf(f)]) : c;
}

// A call with this many positional arguments or more is never spread into a
// JS call: V8 puts spread arguments on the stack, so f(*xs) of a few hundred
// thousand items was a RecursionError where CPython takes it.  It goes
// through the function's own array forms instead (callKw).
export const BIG_CALL = 2048;

export function callObj(f: any, args: any[]): any {
  if (args.length >= BIG_CALL) return callKw(f, args, [], []);
  if (typeof f === "function") return f(...args);
  const c = lookupType(typeOf(f), "__call__");
  if (c !== undefined) return typeof c === "function" ? c(f, ...args) : callObj(callSlot(c, f), args);
  raise(T.TypeError, `'${typeName(f)}' object is not callable`);
}

// Give a builtin that takes only positional arguments, any number of them, an
// array form for calls too big to spread (BIG_CALL); keywords stay refused.
export function positionalArray(f: any, impl: (pos: any[]) => any): any {
  f.$kw = (pos: any[], names: string[], _values: any[]) => {
    if (names.length) raise(T.TypeError, `${f.__name__ ?? f.$name ?? f.name}() takes no keyword arguments`);
    return impl(pos);
  };
  f.$kwPos = true;
  return f;
}

export function callKw(f: any, pos: any[], names: string[], values: any[]): any {
  if (typeof f === "function") {
    if (names.length === 0) {
      if (pos.length < BIG_CALL) return f(...pos);
      // The arguments as an array: a builtin's count checked first; then a
      // keyword adapter known to check the positional count itself ($kwPos:
      // compiled functions, bound methods, classes) or behind that check,
      // else the signature's binding; anything else is spread as before.
      if (f.$arity !== undefined) f.$arity(pos.length);
      if (f.$kw !== undefined) {
        if (f.$arity !== undefined || f.$kwPos === true) return f.$kw(pos, names, values);
      } else if (f.$sig !== undefined && f.$sig !== null) return (f.$raw ?? f)(...bindArgs(f.__name__, f.$sig, pos, names, values));
      return f(...pos);
    }
    if (f.$kw !== undefined) return f.$kw(pos, names, values);
    if (f.$sig !== undefined) return (f.$raw ?? f)(...bindArgs(f.__name__, f.$sig, pos, names, values));
    // (a builtin method by its qualified name, str.ljust(), as CPython 3.14's)
    raise(T.TypeError, `${f.$builtinMethod && f.__qualname__ ? f.__qualname__ : (f.__name__ ?? f.$name ?? f.name)}() takes no keyword arguments`);
  }
  const c = lookupType(typeOf(f), "__call__");
  if (c !== undefined) return typeof c === "function" ? callKw(c, [f, ...pos], names, values) : callKw(callSlot(c, f), pos, names, values);
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
  if (c === undefined || c.ver !== cls.$ver) c = (cls as any).$ni = { ver: cls.$ver, nw: effectiveNew(lookupType(cls, "__new__")), init: lookupType(cls, "__init__") };
  let nw = c.nw;
  let o: any;
  let init = c.init;
  let sub: any = null;
  if (nw !== undefined && nw !== objectNew) {
    o = nw(cls, ...args);
    if (!isinstance(o, cls)) return o;
    // (an instance of a subclass is initialized by its own type's __init__,
    // as CPython's type.__call__ does: type(obj).__init__)
    const t = typeOf(o);
    if (t !== cls) ({ init, nw, sub } = subclassInit(t));
  } else o = new cls.$ctor!();
  if (init === objectInit) {
    if (args.length && (nw === undefined || nw === objectNew)) noArgs(cls, sub);
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

// the __init__ and __new__ that decide how type(obj) is initialized. Its
// __new__ is CPython's tp_new slot: the __new__ its MRO finds, but where
// that is object.__new__, set by a class (`__new__ = object.__new__`), the
// slot the type inherits from its first base (CORR-6AF-1).
function tpNew(t: any): any {
  const e = effectiveNew(lookupType(t, "__new__"));
  if (e !== objectNew || t === T.object) return e;
  const base = t.$bases?.[0];
  return base === undefined ? objectNew : tpNew(base);
}
function subclassInit(t: any): { init: any; nw: any; sub: any } {
  return { init: lookupType(t, "__init__"), nw: tpNew(t), sub: t };
}
// arguments object.__init__ can't take: CPython's object_new's message, or,
// for a returned subclass (its __new__ already ran), object_init's
function noArgs(cls: any, sub: any): never {
  raise(T.TypeError, sub === null ? `${cls.$name}() takes no arguments` : `${sub.$name}.__init__() takes exactly one argument (the instance to initialize)`);
}

export function constructPlainKw(cls: PyType, pos: any[], names: string[], values: any[]): any {
  if (cls.$ctor === null) return callKw(cls, pos, names, values);
  let nw = effectiveNew(lookupType(cls, "__new__"));
  let o: any;
  let init = lookupType(cls, "__init__");
  let sub: any = null;
  if (nw !== undefined && nw !== objectNew) {
    o = callKw(nw, [cls, ...pos], names, values);
    if (!isinstance(o, cls)) return o;
    const t = typeOf(o);
    if (t !== cls) ({ init, nw, sub } = subclassInit(t));
  } else o = new cls.$ctor!();
  if (init === objectInit) {
    if (nw === undefined || nw === objectNew) noArgs(cls, sub);
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
  if (cls === undefined) raise(T.TypeError, "object.__new__(): not enough arguments");
  if (!isType(cls)) raise(T.TypeError, `object.__new__(X): X is not a type object (${typeName(cls)})`);
  if (cls.$ctor === null) raise(T.TypeError, `object.__new__(${cls.$name}) is not safe, use ${cls.$name}.__new__()`);
  return new cls.$ctor();
}, "__new__");
objectNew.$static = true; // (a builtin __new__ is static: never bound to an instance, as CPython's)

// A builtin type's __new__ until it has its own (an allocator, types.ts):
// it makes only the type's subtypes ("dict.__new__(object): object is not a
// subtype of dict", as CPython's), through the next __new__ in its MRO
function inheritedNew(owner: PyType): any {
  const nw: any = pyfn(function __new__(cls: any, ...args: any[]) {
    if (cls === undefined) raise(T.TypeError, `${owner.$name}.__new__(): not enough arguments`);
    if (!isType(cls)) raise(T.TypeError, `${owner.$name}.__new__(X): X is not a type object (${typeName(cls)})`);
    if (!cls.$mro.includes(owner)) raise(T.TypeError, `${owner.$name}.__new__(${cls.$name}): ${cls.$name} is not a subtype of ${owner.$name}`);
    return effectiveNew(nw)(cls, ...args);
  }, "__new__");
  nw.$allocator = owner;
  nw.$inherited = true;
  nw.$static = true;
  return nw;
}
// The __new__ an inherited one calls (constructing an instance of a subtype
// needs no check)
function effectiveNew(nw: any): any {
  while (nw !== undefined && nw.$inherited === true) {
    const mro = nw.$allocator.$mro;
    let next: any;
    for (let i = 1; i < mro.length && next === undefined; i++) next = mro[i].$dict.get("__new__");
    nw = next;
  }
  return nw;
}

// ------------------------------------------------------------------ attributes

export function isDataDescriptor(d: any): boolean {
  if (d === null || typeof d !== "object") return false;
  const t = typeOf(d);
  return lookupType(t, "__set__") !== undefined || lookupType(t, "__delete__") !== undefined;
}

// Python must never reach JavaScript objects (design/security.md).  Names
// starting with `$` are the runtime's own slots ($cls, $m, ...), so Python
// attribute access never sees them; and `__proto__` is stored as an own data
// property, since assignment would run JavaScript's prototype setter on
// instances whose layout inherits from Object.prototype (subclasses of list,
// dict, int, ...).
export const reservedName = (name: string): boolean => name.charCodeAt(0) === 36;
/** A lookup table with no prototype: only its own entries are ever found
 * (a Python-chosen key like "constructor" is not in it), design/security.md rule 6. */
export const table = <V extends object>(entries: V): V => Object.assign(Object.create(null), entries);
function reservedAttr(o: any, name: string): never {
  const why = reservedName(name) ? "names starting with '$' belong to the runtime" : "it is the runtime's own field of this type";
  raise(T.AttributeError, `'${typeName(o)}' object attribute '${name}' is reserved: ${why}`);
}
// An array's length and elements are its list's, not attributes.
const arraySlot = (o: any, name: string): boolean => Array.isArray(o) && (name === "length" || /^\d+$/.test(name));
// A JS-backed layout's own implementation field (bytes' `a`), which is the runtime's, not an attribute.
const implField = (o: any, name: string): boolean => o.$cls !== undefined && o.$cls.$impl !== undefined && o.$cls.$impl.has(name);
const ownAttr = (o: any, name: string): boolean => hasOwn.call(o, name) && !arraySlot(o, name) && !implField(o, name);
export function putAttr(o: any, name: string, v: any): void {
  // (every Python-named write comes here: setattr, the store cache, an
  // instance's __dict__ and its assignment, import *)
  if (implField(o, name)) reservedAttr(o, name);
  if (arraySlot(o, name)) raise(T.AttributeError, `'${typeName(o)}' object attribute '${name}' is not supported`);
  if (name === "__proto__") Object.defineProperty(o, name, { value: v, writable: true, enumerable: true, configurable: true });
  else o[name] = v;
}

// Instances with an attribute dict: objects created from a Python class or a
// module, never runtime-internal objects.
// (a class whose __slots__ give its instances none: $noDict, types.ts)
export function hasInstanceDict(o: any): boolean {
  return o !== null && typeof o === "object" && o.$cls !== undefined && o.$cls.$ctor !== null && o.$cls.$noDict !== true;
}

// d, found on t for the instance o.  (None is JS null, which a
// descriptor's __get__ reads as access on the class: for the instance None,
// as on its type NoneType, a method is bound and a get/set descriptor gives
// its value, as CPython's lookup does; None.__class__ was the descriptor
// itself, and so isinstance(None, an ABC) a TypeError)
function descrGet(d: any, o: any, t: PyType): any {
  const none = o === null && t === T.NoneType;
  if (typeof d === "function") return d.$pyfn === true && (o !== null || none) && d.$static !== true ? bindMethod(d, o) : d;
  if (d !== null && typeof d === "object") {
    if (none && typeOf(d) === T.getset_descriptor) {
      if (!isinstance(o, d.owner)) raise(T.TypeError, `descriptor '${d.name}' for '${d.owner.$name}' objects doesn't apply to a 'NoneType' object`);
      return d.get(o);
    }
    const g = lookupType(typeOf(d), "__get__");
    if (g !== undefined) return g(d, o, t);
  }
  return d;
}

// __getattr__(o, name); with a default (getattr(o, name, dflt)) an
// AttributeError from it gives the default, as in CPython.
function callGetattrHook(gf: any, o: any, name: string, dflt: any): any {
  if (dflt === undefined) return gf(o, name);
  try {
    return gf(o, name);
  } catch (e) {
    if (!isinstance(e, T.AttributeError)) throw e;
    return dflt;
  }
}

export function getattr(o: any, name: string, dflt?: any): any {
  if (reservedName(name)) {
    if (dflt !== undefined) return dflt;
    raise(T.AttributeError, `'${typeName(o)}' object has no attribute '${name}'`);
  }
  if (isType(o)) {
    // (a metaclass's own __getattribute__, then its __getattr__, as
    // CPython's slot_tp_getattr_hook; type's own lookup otherwise)
    const meta = typeOf(o);
    if (meta !== T.type) {
      const ga = lookupType(meta, "__getattribute__");
      const own = ga !== undefined && ga !== T.object.$dict.get("__getattribute__") && ga !== T.type.$dict.get("__getattribute__");
      const gf = lookupType(meta, "__getattr__");
      if (own || gf !== undefined) {
        try {
          return own ? metaHookCall(ga, o, meta, name) : typeGetattr(o, name);
        } catch (e) {
          if (!isinstance(e, T.AttributeError)) throw e;
          if (gf === undefined) {
            if (dflt !== undefined) return dflt;
            throw e;
          }
        }
        try {
          return metaHookCall(gf, o, meta, name);
        } catch (e) {
          if (dflt === undefined || !isinstance(e, T.AttributeError)) throw e;
          return dflt;
        }
      }
    }
    return typeGetattr(o, name, dflt);
  }
  const t = typeOf(o);
  if (t.$customGet) {
    const ga = lookupType(t, "__getattribute__");
    if (ga !== undefined) {
      try {
        return ga(o, name);
      } catch (e) {
        if (!isinstance(e, T.AttributeError)) throw e;
        const gf = lookupType(t, "__getattr__");
        if (gf !== undefined) return callGetattrHook(gf, o, name, dflt);
        if (dflt !== undefined) return dflt;
        throw e;
      }
    }
  }
  return genericGetattr(o, name, t, dflt);
}

// (hook false: object.__getattribute__ itself, CPython's
// PyObject_GenericGetAttr, which never calls __getattr__; the slot does,
// once. A class as the object: its own __dict__ is its instance dict, read
// raw)
export function genericGetattr(o: any, name: string, t: PyType, dflt?: any, hook = true): any {
  if (reservedName(name)) return getattr(o, name, dflt);
  const d = lookupType(t, name);
  const ownDict = isType(o) ? o.$dict.has(name) : hasInstanceDict(o) && ownAttr(o, name);
  // A data descriptor without __get__ yields to the instance dict.
  if (d !== undefined && isDataDescriptor(d) && (lookupType(typeOf(d), "__get__") !== undefined || !ownDict)) return hook ? descrGetOrGetattr(d, o, t, name) : descrGet(d, o, t);
  if (ownDict) return isType(o) ? o.$dict.get(name) : o[name];
  if (typeof o === "function" && o.$attrs !== undefined && o.$attrs.has(name)) return o.$attrs.get(name);
  if (d !== undefined) return hook ? descrGetOrGetattr(d, o, t, name) : descrGet(d, o, t);
  const gf = hook ? lookupType(t, "__getattr__") : undefined;
  if (gf !== undefined) return callGetattrHook(gf, o, name, dflt);
  if (t.$name === "module" && hasInstanceDict(o) && typeof o.__name__ === "string") {
    // PEP 562: a module-level __getattr__ answers for missing attributes
    const g = Object.prototype.hasOwnProperty.call(o, "__getattr__") ? o.__getattr__ : undefined;
    if (g !== undefined && name !== "__getattr__") {
      if (dflt === undefined) return callObj(g, [name]);
      try {
        return callObj(g, [name]);
      } catch (e: any) {
        if (isinstance(e, T.AttributeError)) return dflt;
        throw e;
      }
    }
    if (dflt !== undefined) return dflt;
    const own = Object.prototype.hasOwnProperty.call(o, "__sagebrush_missing__") ? o.__sagebrush_missing__ : undefined;
    raise(T.AttributeError, `module '${o.__name__}' has no attribute '${name}'${missingHint(own, name)}`);
  }
  if (dflt !== undefined) return dflt;
  raise(T.AttributeError, `'${(t as any).$tpName ?? t.$name}' object has no attribute '${name}'${missingHint(lookupType(t, "__sagebrush_missing__"), name)}`);
}

// What a library class or module of Sagebrush's adds to the AttributeError
// for a name it lacks: its __sagebrush_missing__(name), a plain function
// (lib/matplotlib/pyplot.py: a name of matplotlib's that Sagebrush does not
// have yet, and where to search for what it has), or "".
function missingHint(h: any, name: string): string {
  if (h === undefined || name.startsWith("_")) return "";
  const r = callObj(h, [name]);
  return typeof r === "string" ? r : "";
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

// (a metaclass's hook called as CPython's call_attribute: a function with
// the class, a descriptor bound through its __get__, another callable with
// the name alone)
function metaHookCall(f: any, cls: any, meta: any, name: string): any {
  if (typeof f === "function") return f(cls, name);
  const get = lookupType(typeOf(f), "__get__");
  return get !== undefined ? callObj(get(f, cls, meta), [name]) : callObj(f, [name]);
}
export function typeGetattr(cls: PyType, name: string, dflt?: any): any {
  const meta = (cls as any).$meta ?? T.type;
  const md = lookupType(meta, name);
  if (md !== undefined && isDataDescriptor(md)) return descrGet(md, cls, meta);
  const d = lookupType(cls, name);
  if (d !== undefined) {
    if (typeof d === "function") return unboundFunction(d); // functions on a class are plain functions (builtin ones check their receiver)
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

// A builtin method (types.ts method(): a JS function taking self first, its
// immutable owner in $owner) as Python may hold it: `list.append` and friends
// check self's type, as CPython's do, on every way of calling them
// (positionally, by keyword, self= included).  The raw function trusts its
// receiver; it is used only where the receiver is known to be right (an
// instance's own lookup) and is never handed to Python: class lookup, the
// class's __dict__, super(), function.__get__ and a bound method's __func__
// all give this form.  One per function, made for its owner (never for the
// class it happened to be reached through: bool.bit_length checks for int).
// The arguments str's own methods read as a str value, by position (self
// being 0) and by keyword: there, and only there, a str subclass's
// instance is taken by its value, as CPython's C methods take it.  Every
// other argument is passed as it is, so its own protocol applies: join's
// iterable is iterated, translate's table indexed, splitlines' keepends
// tested for truth, an index or a width read through __index__, format's
// and %'s arguments formatted with their own __repr__, __str__, __format__.
const STR_VALUE_ARGS: Record<string, number[]> = {
  split: [1], rsplit: [1], partition: [1], rpartition: [1], replace: [1, 2],
  count: [1], find: [1], rfind: [1], index: [1], rindex: [1], startswith: [1], endswith: [1],
  strip: [1], lstrip: [1], rstrip: [1], removeprefix: [1], removesuffix: [1],
  center: [2], ljust: [2], rjust: [2], encode: [1, 2], __format__: [1],
  __contains__: [1], __add__: [1], __eq__: [1], __ne__: [1], __lt__: [1], __le__: [1], __gt__: [1], __ge__: [1],
};
const STR_VALUE_KEYWORDS: Record<string, string[]> = { split: ["sep"], rsplit: ["sep"], encode: ["encoding", "errors"] };
const strBox = (a: any) => a instanceof PrimBox && typeof a.$v === "string";
export function selfChecked(f: any): any {
  if (f.$selfChecked !== undefined) return f.$selfChecked;
  // (a subclass's unboxing copy of int's, float's or str's method is that
  // method as Python sees it: J.__repr__ is int.__repr__, as in CPython)
  if (f.$orig !== undefined) return (f.$selfChecked = selfChecked(f.$orig));
  const cls: PyType = f.$owner;
  if (cls === undefined) throw new Error(`selfChecked: ${f.__name__} has no owner`);
  const check = (self: any) => {
    if (self === undefined) raise(T.TypeError, `unbound method ${cls.$name}.${f.__name__}() needs an argument`);
    if (!isinstance(self, cls)) raise(T.TypeError, `descriptor '${f.__name__}' for '${cls.$name}' objects doesn't apply to a '${typeName(self)}' object`);
  };
  // (int's, float's and str's own methods take a subclass instance, a box,
  // as self by its value, as CPython's: str.__eq__(K('ab'), 'ab'), or a
  // class body's __hash__ = str.__hash__; of the other arguments only the
  // str values STR_VALUE_ARGS names, any other passed as it is)
  const prim = cls === T.int || cls === T.float || cls === T.str;
  const valueArgs = cls === T.str ? STR_VALUE_ARGS[f.__name__] : undefined;
  const valueKeywords = cls === T.str ? STR_VALUE_KEYWORDS[f.__name__] : undefined;
  // (argument i, self being 0, as passed on)
  const arg = (a: any, i: number) => (valueArgs?.includes(i) && strBox(a) ? a.$v : a);
  const c: any = function (self: any, ...args: any[]) {
    check(self);
    return f(prim && self instanceof PrimBox ? self.$v : self, ...args.map((a, i) => arg(a, i + 1)));
  };
  // (its name, signature, qualname, ...; not the raw function's own keyword
  // adapter, nor anything leading back to the raw function)
  for (const k of Object.keys(f)) if (k !== "$kw" && k !== "$raw" && k !== "$selfChecked") c[k] = f[k];
  // keywords: the receiver is checked once it is known (self= included), then
  // the raw function (or its own adapter) runs
  const kw = f.$kw;
  if (kw !== undefined) {
    c.$kw = (pos: any[], names: string[], values: any[]) => {
      check(pos[0]);
      if (prim && pos[0] instanceof PrimBox) pos = [pos[0].$v, ...pos.slice(1)];
      if (valueArgs) pos = [pos[0], ...pos.slice(1).map((a, i) => arg(a, i + 1))];
      if (valueKeywords) values = values.map((v, j) => (valueKeywords.includes(names[j]) && strBox(v) ? v.$v : v));
      return kw(pos, names, values);
    };
  } else if (f.$sig !== undefined) {
    c.$kw = (pos: any[], names: string[], values: any[]) => {
      const a = bindArgs(f.__name__, f.$sig, pos, names, values);
      check(a[0]);
      if (prim && a[0] instanceof PrimBox) a[0] = a[0].$v;
      if (valueArgs) for (let i = 1; i < a.length; i++) a[i] = arg(a[i], i);
      return (f.$raw ?? f)(...a);
    };
    c.$kwPos = true;
  }
  c.$selfChecked = c;
  f.$selfChecked = c;
  return c;
}

// A function found in a class's dict, as Python sees it when no instance binds it.
export function unboundFunction(d: any): any {
  return d.$owner !== undefined ? selfChecked(d) : d;
}

// A special method found on a type, called for self as CPython's
// vectorcall_method: a function (or a builtin type's method) with self
// first; another object with a __get__ (staticmethod, classmethod, a
// descriptor) bound by it to self and owner, then called with the rest; any
// other callable with the rest (astra CORR-96B-1)
function callSpecial(f: any, self: any, owner: any, args: any[]): any {
  if (typeof f === "function" && !isType(f) && f.$self === undefined && (typeOf(f) === T.function || f.$builtinMethod === true)) return f(self, ...args);
  const get = lookupType(typeOf(f), "__get__");
  // (the __get__ called as CPython's slot_tp_descr_get: the raw one found on
  // the descriptor's type, with (descriptor, receiver, owner), through the
  // callable protocol: a staticmethod's function, a classmethod's TypeError)
  if (get !== undefined) return callObj(callObj(get, [f, self, owner]), args);
  return callObj(f, args);
}
// A class's attribute set and deleted through its metaclass's own
// __setattr__ and __delattr__ when it has one, as CPython's type slots
// (type's own: typeSetattr, typeDelattr)
export function setattr(o: any, name: string, v: any): void {
  if (reservedName(name)) reservedAttr(o, name);
  if (isType(o)) {
    const meta = typeOf(o);
    if (meta !== T.type) {
      const sa = lookupType(meta, "__setattr__");
      if (sa !== undefined && sa !== typeSetattr) {
        callSpecial(sa, o, meta, [name, v]);
        return;
      }
    }
    return setTypeAttr(o, name, v);
  }
  const t = typeOf(o);
  if (t.$customSet) {
    const sa = lookupType(t, "__setattr__");
    if (sa !== undefined && sa !== objectSetattr) {
      callSpecial(sa, o, t, [name, v]);
      return;
    }
  }
  genericSetattr(o, name, v, t);
}

export function genericSetattr(o: any, name: string, v: any, t: PyType) {
  if (reservedName(name)) reservedAttr(o, name);
  if (o !== null && implField(o, name)) reservedAttr(o, name);
  const d = lookupType(t, name);
  if (d !== undefined && d !== null && typeof d === "object") {
    const s = lookupType(typeOf(d), "__set__");
    if (s !== undefined) {
      s(d, o, v);
      return;
    }
  }
  // (None has no __dict__: CPython's AttributeError, after a data
  // descriptor's own answer, such as __class__'s TypeError)
  if (o === null) raise(T.AttributeError, `'NoneType' object has no attribute '${name}' and no __dict__ for setting new attributes`);
  if (hasInstanceDict(o)) {
    putAttr(o, name, v);
    return;
  }
  if (typeof o === "function" && o.$pyfn === true) {
    if (name === "__defaults__" || name === "__name__" || name === "__qualname__" || name === "__doc__" || name === "__module__") o[name] = v;
    else (o.$attrs ??= new Map()).set(name, v);
    return;
  }
  if (d !== undefined) raise(T.AttributeError, `'${(t as any).$tpName ?? t.$name}' object attribute '${name}' is read-only`);
  raise(T.AttributeError, `'${(t as any).$tpName ?? t.$name}' object has no attribute '${name}' and no __dict__ for setting new attributes`);
}

// (object's on a class is CPython's hackcheck TypeError: a class's
// attributes are type's to set)
export function notForType(o: any, fn: string): void {
  if (isType(o)) raise(T.TypeError, `can't apply this ${fn} to ${typeName(o)} object`);
}
// (a slot wrapper's arguments, as CPython's: the receiver, then exactly n
// more, checked before anything is read or changed, astra CORR-96B-2)
export function slotArgs(fn: string, owner: string, a: ArrayLike<any>, n: number, receiver?: (x: any) => void): void {
  if (a.length === 0) raise(T.TypeError, `descriptor '${fn}' of '${owner}' object needs an argument`);
  receiver?.(a[0]);
  if (a.length - 1 !== n) raise(T.TypeError, n === 2 ? `${fn} expected 2 arguments, got ${a.length - 1}` : `expected 1 argument, got ${a.length - 1}`);
}
// (keywords refused with a slot wrapper's message)
export function noKeywords(f: any): any {
  f.$kw = (pos: any[], names: string[], values: any[]) => (names.length ? raise(T.TypeError, `wrapper ${f.__name__}() takes no keyword arguments`) : f(...pos));
  return f;
}
export const objectSetattr = noKeywords(pyfn(function __setattr__(o: any, name: string, v: any) {
  slotArgs("__setattr__", "object", arguments, 2);
  notForType(o, "__setattr__");
  if (typeof name !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
  genericSetattr(o, name, v, typeOf(o));
  return null;
}, "__setattr__"));

// type.__setattr__ and type.__delattr__ (types.ts puts them on type)
const typeAttrName = (fn: string, c: any, name: any): string => {
  if (!isType(c)) raise(T.TypeError, `descriptor '${fn}' requires a 'type' object but received a '${typeName(c)}'`);
  if (typeof name !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
  return name;
};
const typeReceiver = (fn: string) => (c: any) => {
  if (!isType(c)) raise(T.TypeError, `descriptor '${fn}' requires a 'type' object but received a '${typeName(c)}'`);
};
export const typeSetattr = noKeywords(pyfn(function __setattr__(c: any, name: any, v: any) {
  slotArgs("__setattr__", "type", arguments, 2, typeReceiver("__setattr__"));
  setTypeAttr(c, typeAttrName("__setattr__", c, name), v);
  return null;
}, "__setattr__"));
export const typeDelattr = noKeywords(pyfn(function __delattr__(c: any, name: any) {
  slotArgs("__delattr__", "type", arguments, 1, typeReceiver("__delattr__"));
  delTypeAttr(c, typeAttrName("__delattr__", c, name));
  return null;
}, "__delattr__"));
export function delattr(o: any, name: string): void {
  if (reservedName(name)) reservedAttr(o, name);
  if (isType(o)) {
    const meta = typeOf(o);
    if (meta !== T.type) {
      const dl = lookupType(meta, "__delattr__");
      if (dl !== undefined && dl !== typeDelattr) {
        callSpecial(dl, o, meta, [name]);
        return;
      }
    }
    return delTypeAttr(o, name);
  }
  const t = typeOf(o);
  const dl = lookupType(t, "__delattr__");
  if (dl !== undefined && dl.$genericDelattr !== true) {
    callSpecial(dl, o, t, [name]);
    return;
  }
  genericDelattr(o, name, t);
}

export function genericDelattr(o: any, name: string, t: PyType): void {
  if (reservedName(name)) reservedAttr(o, name);
  if (name === "__dict__" && hasInstanceDict(o) && lookupType(t, "__dict__") === lookupType(T.object, "__dict__")) {
    for (const k of attrNames(o)) delete o[k];
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
  if (hasInstanceDict(o) && ownAttr(o, name)) {
    delete o[name];
    return;
  }
  raise(T.AttributeError, `'${(t as any).$tpName ?? t.$name}' object has no attribute '${name}'`);
}

// ------------------------------------------------------------------ inline caches
//
// Each attribute or method-call site gets its own small generated function,
// so each owns its V8 type feedback.  Caches are keyed on (class, version);
// any change to a class or its bases bumps the version.

// The prototype an instance of a Python class has: its constructor's (an
// array, for a list or tuple subclass).
function instanceProto(cls: PyType): any {
  return cls.$jsBase === ListLayout || cls.$jsBase === TupleLayout ? Array.prototype : cls.$ctor!.prototype;
}

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
        if (ownAttr(o, name)) {
          // The fast path answers with any property of that name, so a name
          // that is also on the JavaScript prototype chain of the class's
          // instances (a list or dict subclass's `constructor`, `push`) is
          // never cached: Python never adds to these prototypes, so a name
          // not on the chain now never will be.
          // (and only for an object that has its class's layout: never one
          // whose `$cls` says otherwise)
          const proto = Object.getPrototypeOf(o);
          if (proto === instanceProto(cls) && (cls.$jsBase === null || !(name in proto))) {
            S.c = cls;
            S.v = cls.$ver;
            S.k = 0;
          }
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
    // (never a runtime slot or a layout's own implementation field: not cached, so the fast path never writes one)
    if (!cls.$customSet && cls.$ctor !== null && (cls as any).$noDict !== true && !reservedName(name) && !(cls.$impl !== undefined && cls.$impl.has(name))) {
      const d = lookupType(cls, name);
      if (d === undefined || !isDataDescriptor(d)) {
        S.c = cls;
        S.v = cls.$ver;
        putAttr(o, name, v);
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

// The attribute-read backstop (design/security.md, SEC-5DE-1): a cached read
// of an instance attribute returns a value only when it is the object's own
// property, so that even an object forging another class's tag could never
// get an inherited JavaScript property (constructor: Function) from a site.
// The primary rule is getattrMiss's (a site is primed only by an object with
// its class's own prototype); this is defense in depth, and costs about half
// as much again on attribute-heavy code.  On by default; SAGEBRUSH_HARDENED=0
// in the environment, or setHardened(false) before any code is compiled, turns
// it off.  It is chosen as each read site is generated, so off costs nothing.
let hardened = !(typeof process === "object" && process?.env?.SAGEBRUSH_HARDENED === "0");
/** Turn the attribute-read backstop on or off: for read sites generated from now on (so, before code runs). */
export function setHardened(on: boolean): void {
  hardened = on;
}
export const isHardened = (): boolean => hardened;

export function siteGet(name: string): (o: any) => any {
  const S = { c: null, v: -1, k: 0, val: undefined, tc: undefined as any, tv: -1, tval: undefined };
  const p = JSON.stringify(name);
  const own = hardened ? `if (hasOwn.call(o, ${p})) { const t = o[${p}]; if (t !== undefined) return t; }` : `{ const t = o[${p}]; if (t !== undefined) return t; }`;
  return new Function("S", "miss", "hasOwn", `"use strict"; return function get_${jsName(name)}(o) {
  if (o != null && o.$cls === S.c && S.c.$ver === S.v) {
    if (S.k === 0) { ${own} }
    else if (o[${p}] === undefined || (S.c.$jsBase !== null && !hasOwn.call(o, ${p}))) return S.val;
  } else if (o === S.tc && o.$ver === S.tv) return S.tval;
  return miss(o, ${p}, S);
};`)(S, getattrMiss, hasOwn);
}

export function siteSet(name: string): (o: any, v: any) => void {
  const S = { c: null, v: -1 };
  const p = JSON.stringify(name);
  // A store to `__proto__` or `length` always takes the slow path (see putAttr).
  const fast = name === "__proto__" || name === "length" ? "" : `if (o != null && o.$cls === S.c && S.c.$ver === S.v) { o[${p}] = v; return; }`;
  return new Function("S", "miss", `"use strict"; return function set_${jsName(name)}(o, v) {
  ${fast}
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
// The exceptions being handled, innermost last (sys.exception(),
// sys.exc_info()): an except clause's exception while it is matched and its
// body runs, a finally's or a with's while an exception passes through it.
// A generator's entries are its own: genStep moves them off when it pauses
// and back when it resumes, as CPython keeps them in each frame.
export const handledExceptions: any[] = [];
// Where each exception is caught, with the raise it belongs to: its
// traceback runs from that frame to where it was raised, as CPython's tb
// chain, however the stack changes after (CORR-6AF-2). Only the catching
// frame is needed, so only the top JS frames are captured (a whole stack
// costs as much as the raise's own capture); a later catch replaces the
// record, one per exception. Runtime-internal catches (StopIteration ending
// a loop, getattr's default...) don't come here: only compiled except,
// finally and with do.
const CATCH_FRAMES = 1;
export function excEnter(e: any): void {
  handledExceptions.push(e);
  if (e !== null && typeof e === "object" && e.$tb !== undefined) {
    const at: any = {};
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = CATCH_FRAMES;
    try {
      Error.captureStackTrace(at, excEnter);
    } finally {
      Error.stackTraceLimit = limit;
    }
    e.$caught = { tb: e.$tb, at };
  }
}
// (by identity: a generator resumed outside the frame that ran it may not
// have its entries on top)
export function excLeave(e: any): void {
  const n = handledExceptions.length - 1;
  if (handledExceptions[n] === e) handledExceptions.length = n;
  else {
    const i = handledExceptions.lastIndexOf(e);
    if (i >= 0) handledExceptions.splice(i, 1);
  }
}
export function currentExc(): any {
  const n = handledExceptions.length;
  return n === 0 ? null : handledExceptions[n - 1];
}
// What raising e does to its __context__, as CPython's _PyErr_SetObject: the
// exception being handled becomes it, with any cycle back to e cut.
export function setContext(e: any): void {
  const h = currentExc();
  if (h === null || h === e) return;
  let o = h, slow = h, step = false;
  for (;;) {
    const c = o.__context__;
    if (c === null || c === undefined) break;
    if (c === e) {
      o.__context__ = null;
      break;
    }
    o = c;
    // (a cycle not through e, made by assigning __context__, would loop)
    if (o === slow) break;
    if (step) slow = slow.__context__;
    step = !step;
  }
  e.__context__ = h;
}

export function raise(cls: PyType, msg?: string): never {
  const e = newException(cls, msg === undefined ? [] : [msg]);
  if (handledExceptions.length !== 0) setContext(e);
  throw e;
}

export function newException(cls: PyType, args: any[]): any {
  const e = cls(...args);
  captureTraceback(e);
  return markRaised(e);
}

// An exception that is raised, by Python code (raiseExc) or by the runtime
// (raise, newException, the few direct throws, toPyExc's conversions): it
// has a traceback of its own even if only the runtime catches it, unlike
// one never raised (CORR-581-1). O(1): a plain property (a "$" name, which
// Python's attribute and __dict__ views leave out), far cheaper than
// defineProperty on this path.
export function markRaised(e: any): any {
  if (e !== null && typeof e === "object") e.$raised = true;
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
  setContext(e);
  captureTraceback(e, true);
  return markRaised(e);
}

// Convert anything caught by a JS `catch` into a Python exception.
export function toPyExc(e: any): any {
  if (e !== null && typeof e === "object" && e.$cls !== undefined && isinstance(e, T.BaseException)) return e;
  if (e instanceof TypeError && /Generator is already running|Generator is executing/.test(e.message)) {
    const r = T.ValueError("generator already executing");
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return markRaised(r);
  }
  // A sandboxed runtime refused an operation: Deno permissions (NotCapable,
  // PermissionDenied) or Node's permission model (ERR_ACCESS_DENIED).
  if (e instanceof Error && (e.name === "NotCapable" || e.name === "PermissionDenied" || (e as any).code === "ERR_ACCESS_DENIED")) {
    const r = T.PermissionError(e.message.split("\n")[0]);
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return markRaised(r);
  }
  // An allocation JS can't make (a string or array past its maximum
  // length, an ArrayBuffer it can't allocate, a BigInt past the engine's
  // largest, V8's or JavaScriptCore's, 2^20 bits, so Bun's): MemoryError,
  // as CPython's when memory runs out, not an internal error (HARD-978-2).
  // (JavaScriptCore sizes a result before it computes or allocates it, so
  // nothing is spent first)
  if (e instanceof RangeError && /Invalid string length|Invalid array length|Array buffer allocation failed|Invalid typed array length|Maximum BigInt size exceeded|BigInt generated from this operation is too big/.test(e.message)) {
    const r = T.MemoryError();
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return markRaised(r);
  }
  if (e instanceof RangeError && /call stack/.test(e.message)) {
    const r = T.RecursionError("maximum recursion depth exceeded");
    Object.defineProperty(r, "$tb", { value: e, writable: true, enumerable: false });
    return markRaised(r);
  }
  const r = T.SystemError(`internal error: ${e && e.stack ? e.stack : String(e)}`);
  Object.defineProperty(r, "$tb", { value: e instanceof Error ? e : {}, writable: true, enumerable: false });
  return markRaised(r);
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
  // (what its iterators need, made by the first one, or by a Map shared
  // with something else: until then, no change to the dict counts anything)
  $it: DictMeta | null = null;
}

// A dict's changes, as its iterators need them (one per dict, its size
// fixed; an iterator keeps what they were when it began, and compares).
export interface DictMeta {
  // (clear()s: a dict's iterator then goes on in the emptied dict from the
  // same position, as CPython's goes on in its new table)
  clears: number;
  // (changes to its keys or values other than a new key, which changes its
  // size: a deletion, a clear(), a value stored over one there; reversed()
  // takes its keys and values at the start, and while this and the size are
  // as they were, they are the dict's)
  ver: number;
  // (a Map also changed without the dict, a function's attributes: then
  // reversed() counts on neither)
  shared: boolean;
  // (the reversed() of its values that took no keys yet, if any: told just
  // before a key is deleted, so that it takes them as they were)
  rev: WeakRef<{ keep(): void }> | null;
}

export function dictMeta(d: PyDict): DictMeta {
  return (d.$it ??= { clears: 0, ver: 0, shared: false, rev: null });
}

// A store into a dict that has had an iterator: one over a key already
// there (the size is the same) is a change to its values, counted in ver; a
// new key changes the size. (Only a plain Map: the other kinds are always
// looked up.)
function put(d: PyDict, x: DictMeta, mk: any, v: any): void {
  const m = d.$m;
  if (m.constructor === Map) {
    const n = m.size;
    m.set(mk, v);
    if (m.size === n) x.ver++;
  } else m.set(mk, v);
}

// The numeric primitive key in `d` equal to the object key `k`, if any.
// A dict key's (a set element's) hash: an exact TypeError from it becomes
// CPython 3.14's "cannot use 'list' as a dict key (unhashable type:
// 'list')" (dict_unhashable_type; a set's dict is marked $elem)
function keyHash(d: PyDict, k: any): number {
  try {
    return hooks.hash(k);
  } catch (e: any) {
    if (e === null || typeof e !== "object" || e.$cls !== T.TypeError) throw e;
    const msg = callObj(lookupType(typeOf(e), "__str__"), [e]);
    return raise(T.TypeError, `cannot use '${typeName(k)}' as a ${(d as any).$elem === true ? "set element" : "dict key"} (${msg})`);
  }
}
// (h: k's hash, made once by the caller, as CPython hashes a key once per
// operation, CORR-D77-2)
function numAlias(d: PyDict, k: any, h: number): any {
  // (a str subclass key with its own __eq__ or __hash__ is the str key of
  // its value when it hashes as that str and the two compare equal, as
  // CPython's lookup compares them: K('ab') finds 'ab')
  if (k instanceof PrimBox && typeof k.$v === "string" && d.$m.has(k.$v) && h === hooks.hash(k.$v) && hooks.eq(k.$v, k)) return k.$v;
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
  const l = idx.get(h);
  if (l !== undefined) for (const pk of l) if (hooks.eq(pk, k)) return pk;
  return undefined;
}

// The live `__dict__` of an instance: a PyDict whose `$m` is this Map-like
// view of the object's own (non-`$`) properties.
const isAttrKey = (o: any, k: string) => k[0] !== "$" && !arraySlot(o, k) && !implField(o, k);
/** The names in an instance's attribute dict (its `__dict__`, `vars()`, `dir()`). */
export const attrNames = (o: any): string[] => Object.keys(o).filter((k) => isAttrKey(o, k));
export class AttrMap {
  constructor(public o: any) {}
  private names(): string[] {
    return attrNames(this.o);
  }
  get(k: any): any {
    return typeof k === "string" && isAttrKey(this.o, k) && hasOwn.call(this.o, k) ? this.o[k] : undefined;
  }
  has(k: any): boolean {
    return typeof k === "string" && isAttrKey(this.o, k) && hasOwn.call(this.o, k);
  }
  set(k: any, v: any): this {
    if (typeof k !== "string") raise(T.TypeError, `instance __dict__ keys must be str here, not '${typeName(k)}'`);
    if (reservedName(k)) raise(T.TypeError, `instance __dict__ key '${k}' is reserved: names starting with '$' belong to the runtime`);
    putAttr(this.o, k, v);
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

// (the instance's attribute dict, if it has one, made a dict of its own with
// what it holds now: the next instanceDict(o) is a new one)
export function detachInstanceDict(o: any): void {
  const d = instanceDicts.get(o);
  if (d === undefined) return;
  (d as any).$m = new Map(d.$m.entries());
  instanceDicts.delete(o);
}

export function newDict(): PyDict {
  return new PyDict();
}

// Hooks filled in by ops.ts (hash and equality need the full operator set).
export const hooks: { hash: (x: any) => number; eq: (a: any, b: any) => boolean; repr: (x: any) => string; primProxy: (base: PyType) => PyType; typeCall: any; importModule: (name: string) => any; callerModule: () => string; excResumed: (e: any) => void; excThrown: (e: any) => void; genRaised: (e: any) => void; isinstance: (x: any, spec: any) => boolean; issubclass: (c: any, spec: any) => boolean } = {
  typeCall: null,
  // (isinstance() and issubclass()'s whole protocol, builtins.ts; never
  // through the replaceable builtins)
  isinstance: () => false,
  issubclass: () => false,
  // (a generator's handled exception, as it resumes; one thrown into a
  // generator: the traceback bookkeeping, index.ts)
  excResumed: () => {},
  excThrown: () => {},
  genRaised: () => {},
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

function bucketEntry(d: PyDict, k: any, create: boolean, h: number = keyHash(d, k)): any {
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

// A dict over a class namespace (index.ts's ClassMap) takes str keys
// only: any other is refused here, before its hash, its __eq__ or any of
// the dict's own state is touched (daybreak2's HARD-E4A-1)
function strOnly(d: PyDict, k: any): void {
  if ((d as any).$strOnly === true && typeof k !== "string") raise(T.NotImplementedError, "a key other than a str in a class's __classdict__ is not supported yet");
}

// A key's hash for the dict operations below when it is an object key (one
// hashed by Python code), else undefined: an operation made of two (get
// then set, get then delete) hashes it once, as CPython's (CORR-D77-2);
// a class namespace's dict refuses it first, unhashed
export function dictKeyHash(d: PyDict, k: any): number | undefined {
  if (typeof k === "string") return undefined;
  strOnly(d, k);
  return primitiveKey(k) !== undefined ? undefined : keyHash(d, k);
}

export function dictGet(d: PyDict, k: any, kh?: number): any {
  if (typeof k === "string") return d.$m.get(k);
  strOnly(d, k);
  const p = primitiveKey(k);
  if (p !== undefined) {
    const v = d.$m.get(p);
    if (v !== undefined || d.$buckets === null || typeof p === "string" || p === null) return v;
    const e = bucketEntry(d, k, false);
    return e === undefined ? undefined : d.$m.get(e);
  }
  const h = kh ?? keyHash(d, k); // (unhashable keys raise even on a miss)
  const e = d.$buckets === null ? undefined : bucketEntry(d, k, false, h);
  if (e !== undefined) return d.$m.get(e);
  const a = numAlias(d, k, h);
  return a === undefined ? undefined : d.$m.get(a);
}

export function dictSet(d: PyDict, k: any, v: any, kh?: number): void {
  if (typeof k === "string") {
    const x = d.$it;
    if (x === null) d.$m.set(k, v);
    else put(d, x, k, v);
    return;
  }
  strOnly(d, k);
  const p = primitiveKey(k);
  if (p !== undefined) {
    if (typeof p !== "string" && p !== null && d.$buckets !== null && !d.$m.has(p)) {
      const e = bucketEntry(d, k, false);
      if (e !== undefined) {
        const x = d.$it;
        if (x === null) d.$m.set(e, v);
        else put(d, x, e, v);
        return;
      }
    }
    if (p !== k && !d.$m.has(p)) (d.$orig ??= new Map()).set(p, k);
    if (typeof p === "number" || typeof p === "bigint") {
      d.$hasNum = true;
      d.$nidx = null;
    }
    const x = d.$it;
    if (x === null) d.$m.set(p, v);
    else put(d, x, p, v);
    return;
  }
  const h = kh ?? keyHash(d, k);
  if (d.$hasNum && (d.$buckets === null || bucketEntry(d, k, false, h) === undefined)) {
    const a = numAlias(d, k, h);
    if (a !== undefined) {
      const x = d.$it;
      if (x === null) d.$m.set(a, v);
      else put(d, x, a, v);
      return;
    }
  }
  const e = bucketEntry(d, k, true, h);
  // (read after the key's __eq__ and __hash__ have run, which may make the
  // dict's first iterator)
  const x = d.$it;
  if (x === null) d.$m.set(e, v);
  else put(d, x, e, v);
}

// (a deletion, about to be made, in a dict that has had an iterator: a
// reversed() of its values that took no keys takes them now, as they are;
// counted even if there is no such key, which only makes a reversed() look
// each up)
function beforeDelete(x: DictMeta): void {
  x.ver++;
  if (x.rev !== null) {
    const r = x.rev.deref();
    x.rev = null;
    r?.keep();
  }
}

export function dictDelete(d: PyDict, k: any, kh?: number): boolean {
  if (typeof k !== "string") strOnly(d, k);
  const x = d.$it;
  if (x !== null) beforeDelete(x);
  const p = primitiveKey(k);
  if (p !== undefined) {
    d.$orig?.delete(p);
    if (d.$m.delete(p)) {
      d.$nidx = null;
      return true;
    }
    if (typeof p === "string" || p === null || d.$buckets === null) return false;
  }
  const h = kh ?? keyHash(d, k);
  const e = d.$buckets === null ? undefined : bucketEntry(d, k, false, h);
  if (e === undefined) {
    const a = p === undefined ? numAlias(d, k, h) : undefined;
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
  const x = d.$it;
  if (x !== null) {
    x.clears++;
    x.ver++;
  }
  d.$orig = null;
  d.$buckets = null;
}

// bytes and bytearray share a byte buffer; only bytearray's length changes.
export class PyBytes {
  constructor(public a: Uint8Array, public n: number = a.length) {}
}
// A bytearray counts the exports of its buffer (CPython's ob_exports): while
// one is held it may be written but not re-sized (BufferError).
export class PyByteArray extends PyBytes {
  $exports = 0;
}
export function checkResizable(b: PyByteArray) {
  if (b.$exports > 0) raise(T.BufferError, "Existing exports of data: object cannot be re-sized");
}
// f() with an export of x's buffer held (a bytearray's), released on every path
export function withExport<R>(x: any, f: () => R): R {
  if (!(x instanceof PyByteArray)) return f();
  x.$exports++;
  try {
    return f();
  } finally {
    x.$exports--;
  }
}
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
  w.$argRange = [min, max]; // (the positional counts it takes: test/module-arity.test.ts)
  // (the count check, for calls too big to spread: BIG_CALL)
  w.$arity = (n: number) => {
    if (n < min || n > max) arityError(name, min, max, n, self);
  };
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
  // (the runtime's own slots, `$...`, are no names: design/security.md rule 6)
  get(k: any): any {
    return typeof k === "string" && !reservedName(k) && Object.prototype.hasOwnProperty.call(this.o, k) ? this.o[k] : undefined;
  }
  has(k: any): boolean {
    return this.get(k) !== undefined;
  }
  set(k: any, v: any): this {
    if (typeof k !== "string") raise(T.TypeError, "module namespace keys must be strings");
    if (reservedName(k)) raise(T.TypeError, `namespace key '${k}' is reserved: names starting with '$' belong to the runtime`);
    putAttr(this.o, k, v);
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
  // (exec/eval's namespace over a dict: that dict itself; a property must
  // not be defined on the proxy, whose get answers from the dict)
  const own = g[NS_DICT];
  if (own !== undefined) return own;
  // (a layered namespace, exec/eval with locals: its globals' dict)
  const back = g[NS_GLOBALS];
  if (back !== undefined) return globalsDict(back);
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
export const NS_LOCALS = Symbol("locals of a layered namespace");
// The globals behind a module's namespace: a layered one's (exec and eval
// with separate locals), else the namespace itself
export function realGlobals(g: any): any {
  // (every layer: exec's inside exec's, CORR-C0F-3)
  while (g[NS_GLOBALS] !== undefined) g = g[NS_GLOBALS];
  return g;
}
// locals() at a module's top level: the module's dict, or, in exec/eval with
// separate locals, the locals mapping
export function moduleLocals(g: any): PyDict {
  return g[NS_LOCALS] ?? globalsDict(g);
}
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
