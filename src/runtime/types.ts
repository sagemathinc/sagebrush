// Builtin types and their methods.

import {
  checkArity, ListLayout, TupleLayout, T, PyType, FloatBox, PyDict, PyBytes, PyByteArray, DONE, NotImplemented, Ellipsis,
  builtinType, objectType, typeOf, typeName, lookupType, isType, raise, pyfn, builtin, sig, tuple,
  isinstance, getattr, genericGetattr, setattr, genericSetattr, delattr, objectInit, objectNew, objectSetattr,
  bindMethod, bindArgs, genericDelattr, callKw, callObj, captureTraceback, dictGet, dictSet, dictDelete, dictKeyOf, dictClear, hasOwn, hasInstanceDict, Signature,
  hooks, unbox, instanceDict, PrimBox, NS_DICT, NS_GLOBALS, globalsDict, IntLayout, FloatLayout, StrLayout, TypeLayout, constructPlain, constructPlainKw,
} from "./object";
import * as O from "./ops";
import { repr, str, defaultRepr, dictRepr, setRepr, format, floatRepr, seqRepr, percentFormat } from "./format";

// Store a builtin method (a JS function taking self first) in a type's dict.
export function method(cls: PyType, name: string, f: any, s: Signature | null = null) {
  if (s !== null) f.$sig = s;
  f = checkArity(f, name, true);
  pyfn(f, name, s);
  f.$builtinMethod = true;
  f.__qualname__ = `${cls.$name}.${name}`;
  cls.$dict.set(name, f);
  return f;
}

// A data descriptor computed by JS: type `getset_descriptor`.
export class GetSet {
  constructor(public name: string, public get: (o: any) => any, public set: ((o: any, v: any) => void) | null = null) {}
}
export function getset(cls: PyType, name: string, get: (o: any) => any, set: ((o: any, v: any) => void) | null = null) {
  cls.$dict.set(name, new GetSet(name, get, set));
}

// ------------------------------------------------------------------ object, type

const object = objectType("object", [], new Map(), "builtins");
T.object = object;
object.$dict.set("__init__", objectInit);
object.$dict.set("__new__", objectNew);
object.$dict.set("__setattr__", objectSetattr);
object.$dict.set("__eq__", O.objectEq);
object.$dict.set("__ne__", O.objectNe);
object.$dict.set("__hash__", O.objectHash);
for (const n of ["__lt__", "__le__", "__gt__", "__ge__"]) object.$dict.set(n, pyfn((_a: any, _b: any) => NotImplemented, n));
method(object, "__repr__", (self: any) => defaultRepr(self));
method(object, "__str__", (self: any) => repr(self));
method(object, "__format__", (self: any, spec: string) => {
  if (spec !== "") raise(T.TypeError, `unsupported format string passed to ${typeName(self)}.__format__`);
  return str(self);
});
method(object, "__getattribute__", (self: any, name: string) => genericGetattr(self, name, typeOf(self)));
method(object, "__delattr__", (self: any, name: string) => {
  genericDelattr(self, name, typeOf(self));
  return null;
}).$genericDelattr = true;
method(object, "__init_subclass__", (_cls: any) => null);

const objectDir = method(object, "__dir__", (self: any) => defaultDir(self));

function typeCall(...args: any[]): any {
  if (args.length === 1) return typeOf(args[0]);
  if (args.length === 3) {
    const [name, bases, ns] = args;
    if (!(ns instanceof PyDict)) raise(T.TypeError, `type.__new__() argument 3 must be dict, not ${typeName(ns)}`);
    const m = new Map<string, any>();
    for (const [k, v] of (ns as PyDict).$m) m.set(dictKeyOf(ns, k), v);
    return makeClass(name, O.toArray(bases), m, m.get("__module__") ?? hooks.callerModule(), name, [], []);
  }
  raise(T.TypeError, "type() takes 1 or 3 arguments");
}
const type = builtinType("type", [object], typeCall);
type.$customGet = true;
getset(type, "__name__", (c) => c.$name, (c, v) => void (c.$name = v));
getset(type, "__qualname__", (c) => c.$qualname, (c, v) => void (c.$qualname = v));
getset(type, "__module__", (c) => c.$dict.get("__module__") ?? c.$module, (c, v) => c.$dict.set("__module__", v));
getset(type, "__mro__", (c) => tuple(c.$mro.slice()));
getset(type, "__bases__", (c) => tuple(c.$bases.slice()));
getset(type, "__base__", (c) => c.$bases[0] ?? null);
getset(type, "__dict__", (c) => {
  const d = new PyDict();
  for (const [k, v] of c.$dict) dictSet(d, k, v);
  // The class that first gives its instances a __dict__ shows the slot.
  if (c.$ctor !== null && c !== object && !c.$dict.has("__slots__") && !c.$dict.has("__dict__") && c.$bases.every((b: any) => b.$ctor === null || b === object || b.$jsBase !== null)) {
    dictSet(d, "__dict__", object.$dict.get("__dict__"));
  }
  return d;
});
getset(type, "__doc__", (c) => c.$dict.get("__doc__") ?? null);
method(type, "__repr__", (c: any) => repr(c));
method(type, "mro", (c: any) => c.$mro.slice());
method(type, "__subclasses__", (c: any) => c.$subclasses.slice());
method(type, "__instancecheck__", (c: any, x: any) => isinstance(x, c));
method(type, "__subclasscheck__", (c: any, x: any) => x.$mro.includes(c));
T.type = type;
type.$jsBase = TypeLayout;
// type.__call__ creates an instance without consulting the metaclass again,
// so a metaclass __call__ can delegate to it through super().
const typeCallM = method(type, "__call__", (c: any, ...args: any[]) => constructPlain(c, args));
typeCallM.$kw = (pos: any[], names: string[], values: any[]) => constructPlainKw(pos[0], pos.slice(1), names, values);
hooks.typeCall = typeCallM;
// type.__new__(mcls, name, bases, ns, **kw)
const typeNew = pyfn(function __new__(mcls: any, ...args: any[]) {
  if (args.length === 1 && mcls === type) return typeOf(args[0]);
  if (args.length !== 3) raise(T.TypeError, "type() takes 1 or 3 arguments");
  return typeNewImpl(mcls, args[0], args[1], args[2], new Map());
}, "__new__");
typeNew.$kw = (pos: any[], names: string[], values: any[]) => {
  if (pos.length !== 4) raise(T.TypeError, "type.__new__() takes exactly 3 arguments");
  return typeNewImpl(pos[0], pos[1], pos[2], pos[3], new Map(names.map((n, i) => [n, values[i]])));
};
type.$dict.set("__new__", typeNew);
function typeNewImpl(mcls: any, name: any, bases: any, ns: any, kw: Map<string, any>): PyType {
  if (!isType(mcls) || !mcls.$mro.includes(type)) raise(T.TypeError, `type.__new__(X): X is not a type object (${typeName(mcls)})`);
  if (typeof name !== "string") raise(T.TypeError, `type.__new__() argument 1 must be str, not ${typeName(name)}`);
  if (!(ns instanceof PyDict)) raise(T.TypeError, `type.__new__() argument 3 must be dict, not ${typeName(ns)}`);
  const m = new Map<string, any>();
  for (const [k, v] of (ns as PyDict).$m) m.set(dictKeyOf(ns, k), v);
  const b = O.toArray(bases);
  let winner: PyType = mcls;
  for (const x of b) {
    const mb = typeOf(x);
    if (winner.$mro.includes(mb)) continue;
    if (mb.$mro.includes(winner)) winner = mb;
    else raise(T.TypeError, "metaclass conflict: the metaclass of a derived class must be a (non-strict) subclass of the metaclasses of all its bases");
  }
  return buildClass(name, b, m, m.get("__module__") ?? hooks.callerModule(), m.get("__qualname__") ?? name, kw, winner);
}
const typeInit = method(type, "__init__", (_c: any, ..._args: any[]) => null);
typeInit.$kw = () => null;
const typePrepare = pyfn(function __prepare__(..._a: any[]) {
  return new PyDict();
}, "__prepare__");
typePrepare.$kw = () => new PyDict();
type.$dict.set("__prepare__", typePrepare);

// Mark runtime classes with their Python type.
export function bindClass(jsClass: any, cls: PyType) {
  jsClass.prototype.$cls = cls;
}

const getsetType = builtinType("getset_descriptor", [object], () => raise(T.TypeError, "cannot create 'getset_descriptor' instances"));
bindClass(GetSet, getsetType);
method(getsetType, "__get__", (d: GetSet, o: any, _t: any) => (o === null ? d : d.get(o)));
method(getsetType, "__set__", (d: GetSet, o: any, v: any) => {
  if (d.set === null) raise(T.AttributeError, `attribute '${d.name}' of '${typeName(o)}' objects is not writable`);
  d.set(o, v);
  return null;
});

// ------------------------------------------------------------------ descriptors

export class PyProperty {
  constructor(public fget: any, public fset: any, public fdel: any, public doc: any) {}
}
const property = builtinType("property", [object], (fget: any = null, fset: any = null, fdel: any = null, doc: any = null) => new PyProperty(fget, fset, fdel, doc));
property.$kw = (pos, names, values) => {
  const a = O.toArray(pos);
  const s = sig(["fget", "fset", "fdel", "doc"]);
  const b = bindArgs("property", s, a, names, values);
  return new PyProperty(b[0] ?? null, b[1] ?? null, b[2] ?? null, b[3] ?? null);
};
bindClass(PyProperty, property);
method(property, "__get__", (p: PyProperty, o: any, _t: any = null) => {
  if (o === null) return p;
  if (p.fget === null) raise(T.AttributeError, `property of '${typeName(o)}' object has no getter`);
  return callObj(p.fget, [o]);
});
method(property, "__set__", (p: PyProperty, o: any, v: any) => {
  if (p.fset === null) raise(T.AttributeError, `property of '${typeName(o)}' object has no setter`);
  callObj(p.fset, [o, v]);
  return null;
});
method(property, "__delete__", (p: PyProperty, o: any) => {
  if (p.fdel === null) raise(T.AttributeError, `property of '${typeName(o)}' object has no deleter`);
  callObj(p.fdel, [o]);
  return null;
});
// getter/setter/deleter(None) keep the existing function, as CPython does.
method(property, "getter", (p: PyProperty, f: any) => new PyProperty(f ?? p.fget, p.fset, p.fdel, p.doc));
method(property, "setter", (p: PyProperty, f: any) => new PyProperty(p.fget, f ?? p.fset, p.fdel, p.doc));
method(property, "deleter", (p: PyProperty, f: any) => new PyProperty(p.fget, p.fset, f ?? p.fdel, p.doc));
getset(property, "fget", (p) => p.fget);
getset(property, "fset", (p) => p.fset);
getset(property, "fdel", (p) => p.fdel);
getset(property, "__doc__", (p) => p.doc ?? (p.fget !== null ? p.fget.__doc__ ?? null : null), (p, v) => void (p.doc = v));

// asDunder(): the function implicit special-method calls use, which take
// the instance first (CPython binds the descriptor instead).
export class PyStaticMethod {
  constructor(public f: any) {}
  $d: any;
  asDunder(): any {
    return (this.$d ??= pyfn((_self: any, ...a: any[]) => callObj(this.f, a), "staticmethod"));
  }
}
export class PyClassMethod {
  constructor(public f: any) {}
  $d: any;
  asDunder(): any {
    return (this.$d ??= pyfn((self: any, ...a: any[]) => callObj(this.f, [isType(self) ? self : typeOf(self), ...a]), "classmethod"));
  }
}
const staticmethod = builtinType("staticmethod", [object], (f: any) => new PyStaticMethod(f));
bindClass(PyStaticMethod, staticmethod);
method(staticmethod, "__get__", (s: PyStaticMethod, _o: any, _t: any) => s.f);
getset(staticmethod, "__func__", (s) => s.f);
const classmethod = builtinType("classmethod", [object], (f: any) => new PyClassMethod(f));
bindClass(PyClassMethod, classmethod);
{
  const h = pyfn((_c: any, ..._a: any[]) => NotImplemented, "__subclasshook__");
  h.$default = true;
  object.$dict.set("__subclasshook__", new PyClassMethod(h));
}
method(classmethod, "__get__", (s: PyClassMethod, o: any, t: any) => bindMethod(s.f, t === null || t === undefined ? typeOf(o) : t));
getset(classmethod, "__func__", (s) => s.f);

export class PySuper {
  constructor(public cls: PyType, public obj: any) {}
}
const superType = builtinType("super", [object], (cls: any, obj: any) => {
  if (cls === undefined) raise(T.RuntimeError, "super(): no arguments");
  if (!isType(cls)) raise(T.TypeError, `super() argument 1 must be a type, not ${typeName(cls)}`);
  if (obj !== undefined && !(isType(obj) && obj.$mro.includes(cls)) && !isinstance(obj, cls)) {
    raise(T.TypeError, `super(type, obj): obj (${isType(obj) ? "type" : "instance of"} ${isType(obj) ? obj.$name : typeName(obj)}) is not an instance or subtype of type (${cls.$name}).`);
  }
  return new PySuper(cls, obj);
});
bindClass(PySuper, superType);
method(superType, "__repr__", (s: PySuper) => `<super: <class '${s.cls.$name}'>, ${s.obj === undefined ? "NULL" : isType(s.obj) ? `<class '${s.obj.$name}'>` : `<${typeName(s.obj)} object>`}>`);
method(superType, "__getattribute__", (s: PySuper, name: string) => {
  const start = isType(s.obj) && s.obj.$mro.includes(s.cls) ? s.obj : typeOf(s.obj);
  const mro = start.$mro;
  for (let i = mro.indexOf(s.cls) + 1; i < mro.length; i++) {
    const d = mro[i].$dict.get(name);
    if (d === undefined) continue;
    if (typeof d === "function") return d.$pyfn === true && !(isType(s.obj) && start === s.obj) ? bindMethod(d, s.obj) : d;
    const g = d !== null && typeof d === "object" ? lookupType(typeOf(d), "__get__") : undefined;
    if (g !== undefined) return g(d, isType(s.obj) && start === s.obj ? null : s.obj, start);
    return d;
  }
  if (name === "__class__") return superType;
  raise(T.AttributeError, `'super' object has no attribute '${name}'`);
});
superType.$customGet = true;

// Zero-argument super() in a method compiles to superOf(__class__, firstArg).
export function superOf(cls: any, obj: any): PySuper {
  if (cls === undefined) raise(T.RuntimeError, "super(): __class__ cell not found");
  if (obj === undefined) raise(T.RuntimeError, "super(): no arguments");
  return new PySuper(cls, obj);
}

// ------------------------------------------------------------------ simple types

builtinType("NoneType", [object], () => null);
builtinType("NotImplementedType", [object], () => NotImplemented);
builtinType("ellipsis", [object], () => Ellipsis);

const fnType = builtinType("function", [object], () => raise(T.TypeError, "cannot create 'function' instances"));
for (const a of ["__name__", "__qualname__", "__module__", "__doc__"]) getset(fnType, a, (f) => f[a] ?? null, (f, v) => void (f[a] = v));
getset(fnType, "__globals__", (f) => {
  if (f.$globals === undefined) raise(T.AttributeError, "'function' object has no attribute '__globals__'");
  const g = f.$globals[NS_GLOBALS] ?? f.$globals;
  return g[NS_DICT] ?? globalsDict(g);
});
// A code object describing a compiled function's signature (no bytecode).
export class FnCode {
  constructor(public f: any) {}
}
const fnCodeType = builtinTypeFor("code", FnCode, "builtins", () => raise(T.TypeError, "cannot create 'code' objects"));
{
  const sigOf = (c: FnCode) => c.f.$sig ?? { args: [], posonly: 0, vararg: null, kwonly: [], kwarg: null };
  getset(fnCodeType, "co_name", (c) => c.f.__name__);
  getset(fnCodeType, "co_qualname", (c) => c.f.__qualname__);
  getset(fnCodeType, "co_filename", (c) => c.f.$globals?.__file__ ?? "<string>");
  getset(fnCodeType, "co_argcount", (c) => sigOf(c).args.length);
  getset(fnCodeType, "co_posonlyargcount", (c) => sigOf(c).posonly);
  getset(fnCodeType, "co_kwonlyargcount", (c) => sigOf(c).kwonly.length);
  getset(fnCodeType, "co_varnames", (c) => {
    const s = sigOf(c);
    return tuple([...s.args, ...(s.vararg ? [s.vararg] : []), ...s.kwonly, ...(s.kwarg ? [s.kwarg] : [])]);
  });
  getset(fnCodeType, "co_flags", (c) => {
    const s = sigOf(c);
    return (s.vararg ? 4 : 0) | (s.kwarg ? 8 : 0) | (c.f.$isGen ? 0x20 : 0) | 3;
  });
  getset(fnCodeType, "co_firstlineno", (c) => c.f.$line ?? 1);
}
getset(fnType, "__code__", (f) => (f.$code ??= new FnCode(f)));
getset(fnType, "__defaults__", (f) => f.__defaults__ ?? null, (f, v) => void (f.__defaults__ = v));
getset(fnType, "__kwdefaults__", (f) => f.__kwdefaults__ ?? null, (f, v) => {
  if (v !== null && !(v instanceof PyDict)) raise(T.TypeError, "__kwdefaults__ must be set to a dict object");
  f.__kwdefaults__ = v;
});
getset(fnType, "__dict__", (f) => {
  const d = new PyDict();
  if (f.$attrs) for (const [k, v] of f.$attrs) dictSet(d, k, v);
  return d;
});
getset(fnType, "__wrapped__", (f) => (f.$attrs?.get("__wrapped__") ?? raise(T.AttributeError, "'function' object has no attribute '__wrapped__'")), (f, v) => (f.$attrs ??= new Map()).set("__wrapped__", v));
method(fnType, "__get__", (f: any, o: any, _t: any) => (o === null ? f : bindMethod(f, o)));
method(fnType, "__call__", (f: any, ...a: any[]) => f(...a));

const bfType = builtinType("builtin_function_or_method", [object], () => raise(T.TypeError, "cannot create 'builtin_function_or_method' instances"));
getset(bfType, "__name__", (f) => f.__name__ ?? f.name);
getset(bfType, "__qualname__", (f) => f.__qualname__ ?? f.name);
method(bfType, "__call__", (f: any, ...a: any[]) => f(...a));

const methodType = builtinType("method", [object], (f: any, self: any) => bindMethod(f, self));
getset(methodType, "__self__", (m) => m.$self);
getset(methodType, "__func__", (m) => m.$func);
getset(methodType, "__name__", (m) => m.$func.__name__);
getset(methodType, "__qualname__", (m) => m.$func.__qualname__);
getset(methodType, "__doc__", (m) => m.$func.__doc__ ?? null);
method(methodType, "__call__", (m: any, ...a: any[]) => m(...a));
// Other attributes of a bound method are those of its function.
method(methodType, "__getattr__", (m: any, name: string) => getattr(m.$func, name));
method(methodType, "__eq__", (m: any, o: any) => (typeof o === "function" && o.$self !== undefined ? m.$func === o.$func && m.$self === o.$self : NotImplemented));
method(methodType, "__hash__", (m: any) => (O.id(m.$self) / 32) ^ O.id(m.$func));

const moduleType = objectType("module", [object], new Map(), "builtins");
T.module = moduleType;
method(moduleType, "__repr__", (m: any) => `<module '${m.__name__}'>`);
method(moduleType, "__init__", (m: any, name: string, doc: any = null) => {
  m.__name__ = name;
  m.__doc__ = doc;
  return null;
});
export function newModule(name: string): any {
  const m = new moduleType.$ctor!();
  m.__name__ = name;
  m.__doc__ = null;
  m.__package__ = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "";
  m.__spec__ = null;
  m.__loader__ = null;
  return m;
}

// ------------------------------------------------------------------ classes

// `class C(bases, **kw): body` once the body has filled `ns`.
export function makeClass(name: string, bases: any[], ns: Map<string, any>, module: string, qualname: string, kwNames: string[], kwValues: any[]): PyType {
  let meta: any = null;
  const kw = new Map<string, any>();
  kwNames.forEach((k, i) => (k === "metaclass" ? (meta = kwValues[i]) : kw.set(k, kwValues[i])));
  if (meta !== null && !isType(meta)) return callKw(meta, [name, tuple(bases), nsDict(ns, module, qualname)], [...kw.keys()], [...kw.values()]);
  for (const b of bases) if (!isType(b)) raise(T.TypeError, `bases must be types, not ${typeName(b)}`);
  // The most derived metaclass of the explicit one and the bases' types.
  let winner: PyType = meta ?? T.type;
  for (const b of bases) {
    const mb = typeOf(b);
    if (winner.$mro.includes(mb)) continue;
    if (mb.$mro.includes(winner)) winner = mb;
    else raise(T.TypeError, "metaclass conflict: the metaclass of a derived class must be a (non-strict) subclass of the metaclasses of all its bases");
  }
  if (winner !== T.type) {
    const prep = getattr(winner, "__prepare__", null);
    let d = nsDict(ns, module, qualname);
    if (prep !== null && prep !== typePrepare) {
      const pd = callKw(prep, [name, tuple(bases)], [...kw.keys()], [...kw.values()]);
      if (pd instanceof PyDict) {
        for (const [k, v] of d.$m) dictSet(pd, dictKeyOf(d, k), v);
        d = pd;
      }
    }
    return callKw(winner, [name, tuple(bases), d], [...kw.keys()], [...kw.values()]);
  }
  return buildClass(name, bases, ns, module, qualname, kw, T.type);
}

function nsDict(ns: Map<string, any>, module: string, qualname: string): PyDict {
  const d = new PyDict();
  if (!ns.has("__module__")) dictSet(d, "__module__", module);
  if (!ns.has("__qualname__")) dictSet(d, "__qualname__", qualname);
  for (const [k, v] of ns) dictSet(d, k, v);
  return d;
}

function buildClass(name: string, bases: any[], ns: Map<string, any>, module: string, qualname: string, kw: Map<string, any>, meta: PyType): PyType {
  for (const b of bases) if (!isType(b)) raise(T.TypeError, `bases must be types, not ${typeName(b)}`);
  if (!ns.has("__module__")) ns.set("__module__", module);
  if (!ns.has("__qualname__")) ns.set("__qualname__", qualname);
  if (ns.has("__eq__") && !ns.has("__hash__")) ns.set("__hash__", null);
  // __new__ is implicitly a static method.
  const nw = ns.get("__new__");
  if (nw instanceof PyStaticMethod) ns.set("__new__", nw.f);
  const nw2 = ns.get("__new__");
  if (typeof nw2 === "function") nw2.$static = true;
  for (const k of ["__init_subclass__", "__class_getitem__"]) {
    const f = ns.get(k);
    if (typeof f === "function") ns.set(k, new PyClassMethod(f));
  }
  const cls = objectType(name, bases.length ? bases : [object], ns, module);
  if (meta !== T.type) (cls as any).$meta = meta;
  cls.$qualname = ns.get("__qualname__");
  ns.delete("__qualname__");
  // __set_name__ hooks see the original namespace even if one changes it.
  for (const [k, v] of [...ns]) {
    if (v !== null && typeof v === "object") {
      const sn = lookupType(typeOf(v), "__set_name__");
      if (sn !== undefined) sn(v, cls, k);
    }
  }
  const parent = cls.$mro[1];
  const isub = parent !== undefined ? lookupType(parent, "__init_subclass__") : undefined;
  if (isub instanceof PyClassMethod) callKw(isub.f, [cls], [...kw.keys()], [...kw.values()]);
  else if (kw.size) raise(T.TypeError, `${name}.__init_subclass__() takes no keyword arguments`);
  return cls;
}

// ------------------------------------------------------------------ exceptions

const BaseException = objectType("BaseException", [object], new Map(), "builtins");
T.BaseException = BaseException;
BaseException.$dict.set("__new__", pyfn(function __new__(cls: PyType, ...args: any[]) {
  const o = new cls.$ctor!();
  o.args = tuple(args);
  // Exceptions raised by the runtime are thrown right after creation, so
  // capture the stack now; `raise` re-captures at the raise site.
  captureTraceback(o);
  return o;
}, "__new__"));
method(BaseException, "__init__", (self: any, ...args: any[]) => {
  self.args = tuple(args);
  return null;
});
method(BaseException, "__str__", (self: any) => {
  const a = self.args;
  return a.length === 0 ? "" : a.length === 1 ? str(a[0]) : repr(a);
});
method(BaseException, "__repr__", (self: any) => {
  const a = self.args;
  return `${typeName(self)}(${a.length === 1 ? repr(a[0]) : a.map(repr).join(", ")})`;
});
method(BaseException, "with_traceback", (self: any, _tb: any) => self);
method(BaseException, "add_note", (self: any, note: string) => {
  (self.__notes__ ??= []).push(note);
  return null;
});
for (const [k, v] of [["__cause__", null], ["__context__", null], ["__suppress_context__", false], ["__traceback__", null]] as const) BaseException.$dict.set(k, v);

function exc(name: string, base: PyType, extra?: (cls: PyType) => void): PyType {
  const cls = objectType(name, [base], new Map(), "builtins");
  T[name] = cls;
  extra?.(cls);
  return cls;
}
const Exception = exc("Exception", BaseException);
exc("SystemExit", BaseException, (c) => {
  method(c, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.code = args.length === 0 ? null : args.length === 1 ? args[0] : tuple(args);
    return null;
  });
});
exc("KeyboardInterrupt", BaseException);
exc("GeneratorExit", BaseException);
exc("StopIteration", Exception, (c) => {
  method(c, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.value = args.length ? args[0] : null;
    return null;
  });
});
exc("StopAsyncIteration", Exception);
const ArithmeticError = exc("ArithmeticError", Exception);
exc("ZeroDivisionError", ArithmeticError);
exc("OverflowError", ArithmeticError);
exc("FloatingPointError", ArithmeticError);
const LookupError = exc("LookupError", Exception);
exc("IndexError", LookupError);
exc("KeyError", LookupError, (c) => {
  method(c, "__str__", (self: any) => (self.args.length === 1 ? repr(self.args[0]) : BaseException.$dict.get("__str__")(self)));
});
exc("AssertionError", Exception);
exc("AttributeError", Exception);
exc("BufferError", Exception);
exc("EOFError", Exception);
const ImportError = exc("ImportError", Exception);
exc("ModuleNotFoundError", ImportError);
exc("MemoryError", Exception);
const NameError = exc("NameError", Exception);
exc("UnboundLocalError", NameError);
const OSError = exc("OSError", Exception);
T.IOError = T.EnvironmentError = OSError;
exc("FileNotFoundError", OSError);
exc("FileExistsError", OSError);
exc("PermissionError", OSError);
exc("IsADirectoryError", OSError);
exc("NotADirectoryError", OSError);
exc("TimeoutError", OSError);
const ReferenceError = exc("ReferenceError", Exception);
void ReferenceError;
const RuntimeError = exc("RuntimeError", Exception);
exc("NotImplementedError", RuntimeError);
exc("RecursionError", RuntimeError);
exc("PythonFinalizationError", RuntimeError);
const SyntaxError = exc("SyntaxError", Exception);
exc("IndentationError", SyntaxError);
exc("TabError", (T as any).IndentationError);
exc("SystemError", Exception);
exc("TypeError", Exception);
const ValueError = exc("ValueError", Exception);
const UnicodeError = exc("UnicodeError", ValueError);
exc("UnicodeDecodeError", UnicodeError);
exc("UnicodeEncodeError", UnicodeError);
const Warning = exc("Warning", Exception);
for (const w of ["UserWarning", "DeprecationWarning", "PendingDeprecationWarning", "SyntaxWarning", "RuntimeWarning", "FutureWarning", "ImportWarning", "UnicodeWarning", "BytesWarning", "ResourceWarning", "EncodingWarning"]) exc(w, Warning);

// ------------------------------------------------------------------ numbers

const isInt = Number.isInteger;

function parseIntLiteral(s: string, base: number): number | bigint | undefined {
  let t = s.trim();
  let neg = false;
  if (t[0] === "+" || t[0] === "-") {
    neg = t[0] === "-";
    t = t.slice(1);
  }
  const prefixes: Record<string, number> = { "0x": 16, "0o": 8, "0b": 2 };
  const pre = t.slice(0, 2).toLowerCase();
  if (base === 0) {
    if (pre in prefixes) {
      base = prefixes[pre];
      t = t.slice(2);
    } else {
      base = 10;
      if (/^0+[1-9_]/.test(t)) return undefined;
    }
  } else if (pre in prefixes && prefixes[pre] === base) t = t.slice(2);
  if (t.startsWith("_")) t = t.slice(1);
  if (!/^[0-9a-zA-Z]+(_[0-9a-zA-Z]+)*$/.test(t)) return undefined;
  t = t.replace(/_/g, "");
  let v = 0n;
  const B = BigInt(base);
  for (const ch of t.toLowerCase()) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= base) return undefined;
    v = v * B + BigInt(d);
  }
  return O.normBig(neg ? -v : v);
}

export function intCall(x: any = 0, base: any = undefined): any {
  if (base !== undefined) {
    if (typeof x !== "string" && !(x instanceof PyBytes)) raise(T.TypeError, "int() can't convert non-string with explicit base");
    const b = Number(base);
    if (b !== 0 && (b < 2 || b > 36)) raise(T.ValueError, "int() base must be >= 2 and <= 36, or 0");
    const s = typeof x === "string" ? x : Buffer.from(x.a.subarray(0, x.n)).toString("latin1");
    const v = parseIntLiteral(s, b);
    if (v === undefined) raise(T.ValueError, `invalid literal for int() with base ${b}: ${repr(x)}`);
    return v;
  }
  if (typeof x === "number") {
    if (isInt(x)) return Number.isSafeInteger(x) ? x + 0 : O.normBig(BigInt(x));
    if (x !== x) raise(T.ValueError, "cannot convert float NaN to integer");
    if (!Number.isFinite(x)) raise(T.OverflowError, "cannot convert float infinity to integer");
    const t = Math.trunc(x);
    return Number.isSafeInteger(t) ? t + 0 : O.normBig(BigInt(t));
  }
  if (typeof x === "bigint") return x;
  if (typeof x === "boolean") return +x;
  if (x instanceof FloatBox) return intCall(x.v === 0 ? 0 : x.v);
  if (typeof x === "string" || x instanceof PyBytes) return intCall(x, 10);
  if (O.bufferOf(x) !== undefined) return intCall(new PyBytes(O.bufferOf(x)!.slice()), 10);
  for (const name of ["__int__", "__index__", "__trunc__"]) {
    const f = lookupType(typeOf(x), name);
    if (f !== undefined) {
      const r = f(x);
      if (!O.isPyInt(r) && !(r instanceof PrimBox && isinstance(r, int))) raise(T.TypeError, `${name}() returned non-int (type ${typeName(r)})`);
      return typeof r === "boolean" ? +r : unbox(r);
    }
  }
  raise(T.TypeError, `int() argument must be a string, a bytes-like object or a real number, not '${typeName(x)}'`);
}
const int = builtinType("int", [object], intCall);
int.$kw = (pos, names, values) => intCall(...bindArgs("int", sig(["x", "base"], { posonly: 1 }), pos, names, values));
const absBig = (x: any): bigint => {
  const b = BigInt(x);
  return b < 0n ? -b : b;
};
method(int, "bit_length", (x: any) => (O.truth(x) ? absBig(x).toString(2).length : 0));
method(int, "bit_count", (x: any) => [...absBig(x).toString(2)].filter((c) => c === "1").length);
method(int, "conjugate", (x: any) => +x);
method(int, "__index__", (x: any) => (typeof x === "boolean" ? +x : x));
method(int, "__int__", (x: any) => (typeof x === "boolean" ? +x : x));
method(int, "__float__", (x: any) => O.mkfloat(O.fv(x)!));
method(int, "__repr__", (x: any) => repr(unbox(x)));
method(int, "__hash__", (x: any) => O.hashExact(x));
method(int, "__format__", (x: any, spec: string) => format(x, spec));
method(int, "is_integer", () => true);
method(int, "as_integer_ratio", (x: any) => tuple([x, 1]));
method(int, "to_bytes", (x: any, length: any = 1, byteorder: string = "big", signed: any = false) => {
  let v = BigInt(x);
  const n = Number(length);
  if (n < 0) raise(T.ValueError, "length argument must be non-negative");
  if (O.truth(signed) && n > 0 && v >= 1n << BigInt(8 * n - 1)) raise(T.OverflowError, "int too big to convert");
  if (O.truth(signed) && n === 0 && v !== 0n) raise(T.OverflowError, "int too big to convert");
  if (v < 0n) {
    if (!O.truth(signed)) raise(T.OverflowError, "can't convert negative int to unsigned");
    if (n === 0 || v < -(1n << BigInt(8 * n - 1))) raise(T.OverflowError, "int too big to convert");
    v += 1n << BigInt(8 * n);
  }
  const a = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    a[i] = Number(v & 255n);
    v >>= 8n;
  }
  if (v !== 0n) raise(T.OverflowError, "int too big to convert");
  if (byteorder === "little") a.reverse();
  return new PyBytes(a);
}, sig(["self", "length", "byteorder"], { kwonly: ["signed"] }));
getset(int, "real", (x) => +x);
getset(int, "imag", () => 0);
getset(int, "numerator", (x) => +x);
getset(int, "denominator", () => 1);

function parseFloatLiteral(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/(?<=\d)_(?=\d)/g, "");
  if (/^[+-]?(inf|infinity)$/.test(t)) return t[0] === "-" ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) return undefined;
  return parseFloat(t);
}
export function floatCall(x: any = 0): any {
  if (typeof x === "string") {
    const v = parseFloatLiteral(x);
    if (v === undefined) raise(T.ValueError, `could not convert string to float: ${repr(x)}`);
    return O.mkfloat(v);
  }
  const v = O.fv(x);
  if (v !== undefined) return O.mkfloat(v);
  for (const name of ["__float__", "__index__"]) {
    const f = lookupType(typeOf(x), name);
    if (f !== undefined) return O.mkfloat(O.fv(f(x))!);
  }
  raise(T.TypeError, `float() argument must be a string or a real number, not '${typeName(x)}'`);
}
const float = builtinType("float", [object], floatCall);
bindClass(FloatBox, float);
method(float, "is_integer", (x: any) => isInt(O.fv(x)!));
method(float, "conjugate", (x: any) => x);
method(float, "__float__", (x: any) => x);
method(float, "__int__", (x: any) => intCall(x));
method(float, "__trunc__", (x: any) => intCall(x));
method(float, "__floor__", (x: any) => intCall(Math.floor(O.fv(x)!)));
method(float, "__ceil__", (x: any) => intCall(Math.ceil(O.fv(x)!)));
method(float, "__repr__", (x: any) => floatRepr(O.fv(x)!));
method(float, "__hash__", (x: any) => O.hashExact(x));
method(float, "__format__", (x: any, spec: string) => format(x, spec));
method(float, "as_integer_ratio", (x: any) => {
  let v = O.fv(x)!;
  if (!Number.isFinite(v)) raise(v !== v ? T.ValueError : T.OverflowError, `cannot convert ${v !== v ? "NaN" : "Infinity"} to integer ratio`);
  let d = 1n;
  while (!isInt(v)) {
    v *= 2;
    d *= 2n;
  }
  let n = BigInt(v);
  while (d > 1n && n % 2n === 0n) {
    n /= 2n;
    d /= 2n;
  }
  return tuple([O.normBig(n), O.normBig(d)]);
});
getset(float, "real", (x) => x);
getset(float, "imag", () => new FloatBox(0));
float.$dict.set("fromhex", new PyClassMethod(pyfn((_c: any, s: string) => O.mkfloat(parseFloat(s)), "fromhex")));

builtinType("bool", [int], (x: any = false) => O.truth(x));
method(T.bool, "__repr__", (x: any) => (x ? "True" : "False"));

// ------------------------------------------------------------------ str

const S = builtinType("str", [object], (x: any = "", encoding: any = undefined, errors: any = undefined) => {
  if (encoding !== undefined && x instanceof PyBytes) return decode(x, encoding, errors);
  return str(x);
});
S.$kw = (pos, names, values) => S(...bindArgs("str", sig(["object", "encoding", "errors"]), pos, names, values));

export function decode(b: PyBytes, encoding: any = "utf-8", errors: any = "strict"): string {
  const enc = String(encoding).toLowerCase().replace(/[-_]/g, "");
  const bytes = b.a.subarray(0, b.n);
  if (enc === "ascii" || enc === "latin1" || enc === "iso88591") {
    if (enc === "ascii" && errors === "strict") {
      const i = bytes.findIndex((c) => c > 127);
      if (i >= 0) raise(T.UnicodeDecodeError, `'ascii' codec can't decode byte 0x${bytes[i].toString(16)} in position ${i}: ordinal not in range(128)`);
    }
    return Buffer.from(bytes).toString("latin1");
  }
  if (enc === "utf8") {
    try {
      return new TextDecoder("utf-8", { fatal: errors === "strict" }).decode(bytes);
    } catch {
      raise(T.UnicodeDecodeError, "'utf-8' codec can't decode bytes");
    }
  }
  raise(T.LookupError, `unknown encoding: ${encoding}`);
}
export function encode(s: string, encoding: any = "utf-8", errors: any = "strict"): PyBytes {
  const enc = String(encoding).toLowerCase().replace(/[-_]/g, "");
  if (enc === "utf8") return new PyBytes(new TextEncoder().encode(s));
  if (enc === "ascii" || enc === "latin1" || enc === "iso88591") {
    const lim = enc === "ascii" ? 128 : 256;
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < lim) out.push(c);
      else if (errors === "replace") out.push(63);
      else if (errors !== "ignore") raise(T.UnicodeEncodeError, `'${enc === "ascii" ? "ascii" : "latin-1"}' codec can't encode character ${repr(ch).slice(1, -1)}`);
    }
    return new PyBytes(Uint8Array.from(out));
  }
  raise(T.LookupError, `unknown encoding: ${encoding}`);
}

const isWs = (c: string) => /[\s\x1c-\x1f\x85]/.test(c);
// Argument checks shared by str methods ("must be str, not int").
function needStr(x: any, what = "must be str"): string {
  if (typeof x !== "string") raise(T.TypeError, `${what}, not ${typeName(x)}`);
  return x;
}
function stripChars(s: string, chars: any, left: boolean, right: boolean): string {
  if (chars !== null && chars !== undefined && typeof chars !== "string") raise(T.TypeError, `strip arg must be None or str`);
  let i = 0, j = s.length;
  const drop = chars === null || chars === undefined ? isWs : (c: string) => chars.includes(c);
  if (left) while (i < j && drop(s[i])) i++;
  if (right) while (j > i && drop(s[j - 1])) j--;
  return s.slice(i, j);
}
function splitWhitespace(s: string, maxsplit: number): string[] {
  const out: string[] = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && isWs(s[i])) i++;
    if (i >= n) break;
    if (maxsplit >= 0 && out.length === maxsplit) {
      out.push(s.slice(i));
      return out;
    }
    let j = i;
    while (j < n && !isWs(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}
function rsplitWhitespace(s: string, maxsplit: number): string[] {
  const out: string[] = [];
  let j = s.length;
  while (j > 0) {
    while (j > 0 && isWs(s[j - 1])) j--;
    if (j <= 0) break;
    if (out.length === maxsplit) {
      out.push(s.slice(0, j));
      break;
    }
    let i = j;
    while (i > 0 && !isWs(s[i - 1])) i--;
    out.push(s.slice(i, j));
    j = i;
  }
  return out.reverse();
}
function clampRange(s: string, start: any, end: any): [number, number] {
  const n = s.length;
  let a = start === undefined || start === null ? 0 : Number(start);
  let b = end === undefined || end === null ? n : Number(end);
  if (a < 0) a = Math.max(0, a + n);
  if (b < 0) b = Math.max(0, b + n);
  return [a, Math.min(b, n)];
}
method(S, "join", (sep: string, items: any) => {
  const parts = Array.isArray(items) ? items : O.toArray(items);
  let out = parts;
  for (let i = 0; i < parts.length; i++) {
    if (typeof parts[i] === "string") continue;
    // an instance of a str subclass joins as its string
    if (parts[i] instanceof PrimBox && typeof parts[i].$v === "string") { if (out === parts) out = parts.slice(); out[i] = parts[i].$v; continue; }
    raise(T.TypeError, `sequence item ${i}: expected str instance, ${typeName(parts[i])} found`);
  }
  return out.join(sep);
});
method(S, "split", (s: string, sep: any = null, maxsplit: any = -1) => {
  const m = Number(maxsplit);
  if (sep === null) return splitWhitespace(s, m);
  if (typeof sep !== "string") raise(T.TypeError, `must be str or None, not ${typeName(sep)}`);
  if (sep === "") raise(T.ValueError, "empty separator");
  const parts = s.split(sep);
  if (m >= 0 && parts.length > m + 1) return [...parts.slice(0, m), parts.slice(m).join(sep)];
  return parts;
}, sig(["self", "sep", "maxsplit"]));
method(S, "rsplit", (s: string, sep: any = null, maxsplit: any = -1) => {
  const m = Number(maxsplit);
  if (sep === null) return m < 0 ? splitWhitespace(s, -1) : rsplitWhitespace(s, m);
  needStr(sep);
  if (sep === "") raise(T.ValueError, "empty separator");
  const parts = s.split(sep);
  if (m >= 0 && parts.length > m + 1) return [parts.slice(0, parts.length - m).join(sep), ...parts.slice(parts.length - m)];
  return parts;
}, sig(["self", "sep", "maxsplit"]));
// Python's line boundaries; LS and PS are built from char codes.
const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85" + String.fromCharCode(0x2028, 0x2029) + "]", "g");
method(S, "splitlines", (s: string, keepends: any = false) => {
  const out: string[] = [];
  const re = new RegExp(LINE_BREAK);
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(s.slice(last, O.truth(keepends) ? re.lastIndex : m.index));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}, sig(["self", "keepends"]));
method(S, "strip", (s: string, chars: any = null) => stripChars(s, chars, true, true));
method(S, "lstrip", (s: string, chars: any = null) => stripChars(s, chars, true, false));
method(S, "rstrip", (s: string, chars: any = null) => stripChars(s, chars, false, true));
method(S, "replace", (s: string, a: string, b: string, count: any = -1) => {
  needStr(a, "replace() argument 1 must be str");
  needStr(b, "replace() argument 2 must be str");
  let c = Number(count);
  if (c < 0 && a !== "") return s.split(a).join(b);
  if (c < 0) c = Infinity;
  let out = "", i = 0, k = 0;
  if (a === "") {
    for (const ch of s) out += k++ < c ? b + ch : ch;
    return k < c ? out + b : out;
  }
  while (k < c) {
    const j = s.indexOf(a, i);
    if (j < 0) break;
    out += s.slice(i, j) + b;
    i = j + a.length;
    k++;
  }
  return out + s.slice(i);
});
function findImpl(s: string, sub: string, start: any, end: any, rev: boolean): number {
  needStr(sub);
  const [a, b] = clampRange(s, start, end);
  if (b - a < sub.length || a > s.length) return -1;
  const j = rev ? s.lastIndexOf(sub, b - sub.length) : s.indexOf(sub, a);
  return j < a || j + sub.length > b ? -1 : j;
}
method(S, "find", (s: string, sub: string, start: any = undefined, end: any = undefined) => findImpl(s, sub, start, end, false));
method(S, "rfind", (s: string, sub: string, start: any = undefined, end: any = undefined) => findImpl(s, sub, start, end, true));
method(S, "index", (s: string, sub: string, start: any = undefined, end: any = undefined) => {
  const j = findImpl(s, sub, start, end, false);
  if (j < 0) raise(T.ValueError, "substring not found");
  return j;
});
method(S, "rindex", (s: string, sub: string, start: any = undefined, end: any = undefined) => {
  const j = findImpl(s, sub, start, end, true);
  if (j < 0) raise(T.ValueError, "substring not found");
  return j;
});
method(S, "count", (s: string, sub: string, start: any = undefined, end: any = undefined) => {
  needStr(sub);
  const [a, b] = clampRange(s, start, end);
  if (a > s.length) return 0;
  const t = s.slice(a, b);
  return sub === "" ? t.length + 1 : t.split(sub).length - 1;
});
function affix(s: string, x: any, start: any, end: any, ends: boolean): boolean {
  if (Array.isArray(x)) return x.some((p) => affix(s, p, start, end, ends));
  if (typeof x !== "string") raise(T.TypeError, `${ends ? "endswith" : "startswith"} first arg must be str or a tuple of str, not ${typeName(x)}`);
  const [a, b] = clampRange(s, start, end);
  if (a > s.length) return false;
  const t = s.slice(a, b);
  return ends ? t.endsWith(x) : t.startsWith(x);
}
method(S, "startswith", (s: string, p: any, start: any = undefined, end: any = undefined) => affix(s, p, start, end, false));
method(S, "endswith", (s: string, p: any, start: any = undefined, end: any = undefined) => affix(s, p, start, end, true));
method(S, "upper", (s: string) => s.toUpperCase());
method(S, "lower", (s: string) => s.toLowerCase());
method(S, "casefold", (s: string) => s.toLowerCase());
method(S, "swapcase", (s: string) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(""));
method(S, "capitalize", (s: string) => (s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s));
method(S, "title", (s: string) => {
  let out = "", prevCased = false;
  for (const c of s) {
    out += prevCased ? c.toLowerCase() : c.toUpperCase();
    prevCased = /\p{L}/u.test(c);
  }
  return out;
});
const allMatch = (re: RegExp) => (s: string) => s.length > 0 && [...s].every((c) => re.test(c));
method(S, "isdigit", allMatch(/\p{Nd}|[²³¹]/u));
method(S, "isdecimal", allMatch(/\p{Nd}/u));
method(S, "isnumeric", allMatch(/\p{N}/u));
method(S, "isalpha", allMatch(/\p{L}/u));
method(S, "isalnum", allMatch(/[\p{L}\p{N}]/u));
method(S, "isspace", allMatch(/[\s\x1c-\x1f\x85]/));
method(S, "isascii", (s: string) => /^[\x00-\x7f]*$/.test(s));
method(S, "isupper", (s: string) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s));
method(S, "islower", (s: string) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s));
method(S, "isidentifier", (s: string) => /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(s));
method(S, "isprintable", (s: string) => [...s].every((c) => c === " " || !/[\p{C}\p{Z}]/u.test(c)));
method(S, "istitle", (s: string) => /\p{L}/u.test(s) && s === S.$dict.get("title")(s));
function padTo(s: string, w: any, fill: string, where: string): string {
  const n = Number(w) - [...s].length;
  if (n <= 0) return s;
  if (where === "l") return s + fill.repeat(n);
  if (where === "r") return fill.repeat(n) + s;
  const left = Math.floor(n / 2) + (n & Number(w) & 1);
  return fill.repeat(left) + s + fill.repeat(n - left);
}
method(S, "center", (s: string, w: any, fill: string = " ") => padTo(s, w, fill, "c"));
method(S, "ljust", (s: string, w: any, fill: string = " ") => padTo(s, w, fill, "l"));
method(S, "rjust", (s: string, w: any, fill: string = " ") => padTo(s, w, fill, "r"));
method(S, "zfill", (s: string, w: any) => {
  const sign = s[0] === "-" || s[0] === "+" ? s[0] : "";
  const n = Number(w) - s.length;
  return n > 0 ? sign + "0".repeat(n) + s.slice(sign.length) : s;
});
method(S, "partition", (s: string, sep: string) => {
  if (needStr(sep) === "") raise(T.ValueError, "empty separator");
  const i = s.indexOf(sep);
  return i < 0 ? tuple([s, "", ""]) : tuple([s.slice(0, i), sep, s.slice(i + sep.length)]);
});
method(S, "rpartition", (s: string, sep: string) => {
  if (needStr(sep) === "") raise(T.ValueError, "empty separator");
  const i = s.lastIndexOf(sep);
  return i < 0 ? tuple(["", "", s]) : tuple([s.slice(0, i), sep, s.slice(i + sep.length)]);
});
method(S, "removeprefix", (s: string, p: string) => (s.startsWith(p) ? s.slice(p.length) : s));
method(S, "removesuffix", (s: string, p: string) => (p && s.endsWith(p) ? s.slice(0, -p.length) : s));
method(S, "encode", (s: string, encoding: any = "utf-8", errors: any = "strict") => encode(s, encoding, errors), sig(["self", "encoding", "errors"]));
method(S, "expandtabs", (s: string, ts: any = 8) => {
  let out = "", col = 0;
  const n = Number(ts);
  for (const c of s) {
    if (c === "\t") {
      const k = n > 0 ? n - (col % n) : 0;
      out += " ".repeat(k);
      col += k;
    } else {
      out += c;
      col = c === "\n" || c === "\r" ? 0 : col + 1;
    }
  }
  return out;
});
method(S, "format", (s: string, ...args: any[]) => strFormat(s, args, new Map()));
S.$dict.get("format").$kw = (pos: any[], names: string[], values: any[]) => strFormat(pos[0], pos.slice(1), new Map(names.map((n, i) => [n, values[i]])));
method(S, "format_map", (s: string, m: any) => strFormat(s, [], m));
method(S, "__len__", (s: string) => s.length);
method(S, "__contains__", (s: string, x: any) => O.contains(s, x));
method(S, "__getitem__", (s: string, k: any) => O.getitem(s, k));
method(S, "__add__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s + x : NotImplemented));
method(S, "__mul__", (s: string, x: any) => (O.isPyInt(x) ? s.repeat(Math.max(0, Number(x))) : NotImplemented));
method(S, "__mod__", (s: string, x: any) => O.strFormatOpHook.f(s, x));
method(S, "__eq__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s === x : NotImplemented));
method(S, "__lt__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s < x : NotImplemented));
method(S, "__hash__", (s: string) => O.hashAny(s));
method(S, "__str__", (s: string) => s);
method(S, "__repr__", (s: string) => repr(s));
method(S, "__format__", (s: string, spec: string) => format(s, spec));
method(S, "__iter__", (s: string) => O.iter(s));

// str.format: "{0.attr[key]!r:>{width}}"
export function strFormat(s: string, args: any[], kw: any): string {
  let out = "";
  let auto = 0;
  const lookup = (field: string): any => {
    const m = /^([^.[]*)(.*)$/s.exec(field)!;
    let first: any = m[1];
    let v: any;
    if (first === "") {
      if (auto < 0) raise(T.ValueError, "cannot switch from manual field specification to automatic field numbering");
      first = auto++;
    } else if (/^\d+$/.test(first)) {
      if (auto > 0) raise(T.ValueError, "cannot switch from automatic field numbering to manual field specification");
      auto = -1;
      first = parseInt(first);
    }
    if (typeof first === "number") {
      if (first >= args.length) raise(T.IndexError, `Replacement index ${first} out of range for positional args tuple`);
      v = args[first];
    } else if (kw instanceof Map) {
      if (!kw.has(first)) throw T.KeyError(first);
      v = kw.get(first);
    } else v = O.getitem(kw, first);
    let rest = m[2];
    while (rest.length) {
      const a = /^\.([^.[]+)/.exec(rest);
      if (a) {
        v = getattr(v, a[1]);
        rest = rest.slice(a[0].length);
        continue;
      }
      const b = /^\[([^\]]+)\]/.exec(rest);
      if (!b) raise(T.ValueError, "Only '.' or '[' may follow ']' in format field specifier");
      v = O.getitem(v, /^\d+$/.test(b[1]) ? parseInt(b[1]) : b[1]);
      rest = rest.slice(b[0].length);
    }
    return v;
  };
  const expand = (t: string, depth: number): string => {
    let r = "";
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === "{") {
        if (t[i + 1] === "{") {
          r += "{";
          i += 2;
          continue;
        }
        let j = i + 1, level = 1;
        while (j < t.length && level > 0) {
          if (t[j] === "{") level++;
          else if (t[j] === "}") level--;
          j++;
        }
        if (level > 0) raise(T.ValueError, "expected '}' before end of string");
        const m = /^([^!:]*)(?:!([rsa]))?(?::(.*))?$/s.exec(t.slice(i + 1, j - 1));
        if (m === null) raise(T.ValueError, "invalid format string");
        let v = lookup(m[1]);
        let spec = m[3] ?? "";
        if (spec.includes("{")) {
          if (depth > 1) raise(T.ValueError, "Max string recursion exceeded");
          spec = expand(spec, depth + 1);
        }
        if (m[2] === "r" || m[2] === "a") v = repr(v);
        else if (m[2] === "s") v = str(v);
        r += format(v, spec);
        i = j;
      } else if (c === "}") {
        if (t[i + 1] !== "}") raise(T.ValueError, "Single '}' encountered in format string");
        r += "}";
        i += 2;
      } else {
        r += c;
        i++;
      }
    }
    return r;
  };
  out = expand(s, 0);
  return out;
}

// ------------------------------------------------------------------ list, tuple

const list = builtinType("list", [object], (x: any = undefined) => (x === undefined ? [] : O.toArray(x)));
const tupleType = builtinType("tuple", [object], (x: any = undefined) => (x === undefined ? tuple([]) : Array.isArray(x) && (x as any).$t === true ? x : tuple(O.toArray(x))));

// Stable sort using only `<`, like CPython.  reverse=True keeps equal
// elements in their original order (reverse, sort, reverse).
export function sortList(a: any[], key: any, reverse: any): void {
  const n = a.length;
  let keys = a;
  if (key !== null && key !== undefined) keys = a.map((v) => callObj(key, [v]));
  const idx = Array.from({ length: n }, (_, i) => i);
  if (O.truth(reverse)) idx.reverse();
  let cmp: (i: number, j: number) => number;
  if (keys.every((k) => typeof k === "number")) cmp = (i, j) => (keys[i] < keys[j] ? -1 : keys[j] < keys[i] ? 1 : 0);
  else if (keys.every((k) => typeof k === "string")) cmp = (i, j) => (keys[i] < keys[j] ? -1 : keys[j] < keys[i] ? 1 : 0);
  else cmp = (i, j) => (O.truth(O.lt(keys[i], keys[j])) ? -1 : O.truth(O.lt(keys[j], keys[i])) ? 1 : 0);
  idx.sort(cmp);
  if (O.truth(reverse)) idx.reverse();
  const vals = idx.map((i) => a[i]);
  for (let i = 0; i < n; i++) a[i] = vals[i];
}

method(list, "append", (a: any[], x: any) => {
  a.push(x);
  return null;
});
method(list, "extend", (a: any[], x: any) => {
  O.iadd(a, x);
  return null;
});
method(list, "insert", (a: any[], i: any, x: any) => {
  let j = Number(O.index(i));
  if (j < 0) j = Math.max(0, j + a.length);
  a.splice(Math.min(j, a.length), 0, x);
  return null;
});
method(list, "pop", (a: any[], i: any = -1) => {
  if (a.length === 0) raise(T.IndexError, "pop from empty list");
  let j = Number(O.index(i));
  if (j === -1) return a.pop();
  if (j < 0) j += a.length;
  if (j < 0 || j >= a.length) raise(T.IndexError, "pop index out of range");
  return a.splice(j, 1)[0];
});
method(list, "remove", (a: any[], x: any) => {
  for (let i = 0; i < a.length; i++) {
    if (O.eqBool(a[i], x)) {
      a.splice(i, 1);
      return null;
    }
  }
  raise(T.ValueError, "list.remove(x): x not in list");
});
const seqIndexOf = (a: any[], x: any, start: any, end: any, what: string) => {
  let lo = start === undefined ? 0 : Number(start), hi = end === undefined ? a.length : Number(end);
  if (lo < 0) lo = Math.max(0, lo + a.length);
  if (hi < 0) hi += a.length;
  for (let i = lo; i < Math.min(hi, a.length); i++) if (O.eqBool(a[i], x)) return i;
  raise(T.ValueError, what === "list" ? "list.index(x): x not in list" : "tuple.index(x): x not in tuple");
};
method(list, "index", (a: any[], x: any, start: any = undefined, end: any = undefined) => seqIndexOf(a, x, start, end, "list"));
method(list, "count", (a: any[], x: any) => a.filter((v) => O.eqBool(v, x)).length);
method(list, "reverse", (a: any[]) => {
  a.reverse();
  return null;
});
method(list, "copy", (a: any[]) => a.slice());
method(list, "clear", (a: any[]) => {
  a.length = 0;
  return null;
});
method(list, "sort", (a: any[], key: any = null, reverse: any = false) => {
  sortList(a, key, reverse);
  return null;
}, sig(["self"], { kwonly: ["key", "reverse"] }));
// Subclass instances of list/tuple are plain arrays with an own $cls.
list.$jsBase = ListLayout;
tupleType.$jsBase = TupleLayout;
method(list, "__init__", (a: any[], it: any = undefined) => {
  const items = it === undefined ? [] : O.toArray(it);
  a.length = 0;
  for (const v of items) a.push(v);
  return null;
});
tupleType.$dict.set("__new__", pyfn(function __new__(cls: PyType, it: any = undefined) {
  const items = it === undefined ? [] : O.toArray(it);
  if (cls === tupleType) return tuple(items);
  const a = new cls.$ctor!();
  for (const v of items) a.push(v);
  return a;
}, "__new__"));
const seqOps = (cls: PyType, isTuple: boolean) => {
  const same = (b: any) => Array.isArray(b) && !!(b as any).$t === isTuple;
  for (const op of ["__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"]) method(cls, op, (a: any[], b: any) => (same(b) ? O.seqCmp(a, b, op) : NotImplemented));
  method(cls, "__len__", (a: any[]) => a.length);
  method(cls, "__getitem__", (a: any[], k: any) => O.arrGet(a, k));
  method(cls, "__contains__", (a: any[], x: any) => O.arrContains(a, x));
  method(cls, "__iter__", (a: any[]) => new O.ListIter(a));
  method(cls, "__repr__", (a: any[]) => seqRepr(a));
  method(cls, "__mul__", (a: any[], n: any) => (O.isPyInt(n) ? O.mul(isTuple ? tuple(a.slice()) : a.slice(), n) : NotImplemented));
};
seqOps(list, false);
seqOps(tupleType, true);
method(list, "__setitem__", (a: any[], k: any, v: any) => (O.arrSet(a, k, v), null));
method(list, "__delitem__", (a: any[], k: any) => (O.arrDel(a, k), null));
method(list, "__iadd__", (a: any[], b: any) => {
  for (const v of O.toArray(b)) a.push(v);
  return a;
});
method(list, "__add__", (a: any[], b: any) => (Array.isArray(b) && !(b as any).$t ? [...a, ...b] : NotImplemented));
list.$dict.set("__hash__", null);

method(tupleType, "index", (a: any[], x: any, start: any = undefined, end: any = undefined) => seqIndexOf(a, x, start, end, "tuple"));
method(tupleType, "count", (a: any[], x: any) => a.filter((v) => O.eqBool(v, x)).length);
method(tupleType, "__hash__", (a: any[]) => O.hashTupleOf(a));
method(tupleType, "__add__", (a: any[], b: any) => (Array.isArray(b) && (b as any).$t ? tuple([...a, ...b]) : NotImplemented));

// ------------------------------------------------------------------ dict

function dictCall(x: any = undefined): PyDict {
  const d = new PyDict();
  if (x !== undefined) O.dictUpdate(d, x);
  return d;
}
const dict = builtinType("dict", [object], dictCall);
dict.$kw = (pos, names, values) => {
  if (pos.length > 1) raise(T.TypeError, `dict expected at most 1 argument, got ${pos.length}`);
  const d = dictCall(pos[0]);
  names.forEach((n, i) => dictSet(d, n, values[i]));
  return d;
};
bindClass(PyDict, dict);
dict.$jsBase = PyDict;
method(dict, "__init__", (d: PyDict, x: any = undefined) => {
  if (x !== undefined) O.dictUpdate(d, x);
  return null;
});
dict.$dict.get("__init__").$kw = (pos: any[], names: string[], values: any[]) => {
  const d = pos[0];
  if (pos.length > 1) O.dictUpdate(d, pos[1]);
  names.forEach((n, i) => dictSet(d, n, values[i]));
  return null;
};

// Live views over a dict: kind 0 keys, 1 values, 2 items.
export class DictView {
  constructor(public d: PyDict, public kind: number) {}
}
const viewTypes = ["dict_keys", "dict_values", "dict_items"].map((name, kind) => {
  const vt = builtinType(name, [object], () => raise(T.TypeError, `cannot create '${name}' instances`));
  method(vt, "__iter__", (v: DictView) => new O.DictIter(v.d, v.kind));
  method(vt, "__len__", (v: DictView) => v.d.$m.size);
  if (kind !== 1) vt.$dict.set("__hash__", null);
  method(vt, "__reversed__", (v: DictView) => new O.ListIter(O.toArray(new O.DictIter(v.d, v.kind)).reverse()));
  method(vt, "__repr__", (v: DictView) => `${name}(${repr(O.toArray(new O.DictIter(v.d, v.kind)))})`);
  method(vt, "__contains__", (v: DictView, x: any) => {
    if (kind === 0) return dictGet(v.d, x) !== undefined;
    if (kind === 1) return O.contains(O.toArray(new O.DictIter(v.d, 1)), x);
    const kv = O.unpack(x, 2);
    const w = dictGet(v.d, kv[0]);
    return w !== undefined && O.eqBool(w, kv[1]);
  });
  if (kind !== 1) {
    for (const [op, f] of [["__and__", "and"], ["__or__", "or"], ["__sub__", "sub"], ["__xor__", "xor"]] as const) {
      method(vt, op, (v: DictView, other: any) => O.setOp(O.newSet(new O.DictIter(v.d, v.kind)), O.newSet(other), f));
    }
  }
  return vt;
});
Object.defineProperty(DictView.prototype, "$cls", {
  get(this: DictView) {
    return viewTypes[this.kind];
  },
});

method(dict, "keys", (d: PyDict) => new DictView(d, 0));
method(dict, "__reversed__", (d: PyDict) => new O.ListIter(O.toArray(new O.DictIter(d, 0)).reverse()));
method(dict, "values", (d: PyDict) => new DictView(d, 1));
method(dict, "items", (d: PyDict) => new DictView(d, 2));
method(dict, "get", (d: PyDict, k: any, dflt: any = null) => {
  const v = dictGet(d, k);
  return v === undefined ? dflt : v;
});
method(dict, "setdefault", (d: PyDict, k: any, dflt: any = null) => {
  const v = dictGet(d, k);
  if (v !== undefined) return v;
  dictSet(d, k, dflt);
  return dflt;
});
method(dict, "pop", (d: PyDict, k: any, dflt: any = undefined) => {
  const v = dictGet(d, k);
  if (v === undefined) {
    if (dflt !== undefined) return dflt;
    throw T.KeyError(k);
  }
  dictDelete(d, k);
  return v;
});
method(dict, "popitem", (d: PyDict) => {
  if (d.$m.size === 0) throw T.KeyError("popitem(): dictionary is empty");
  const mk = [...d.$m.keys()].pop();
  const k = dictKeyOf(d, mk);
  const v = d.$m.get(mk);
  dictDelete(d, k);
  return tuple([k, v]);
});
method(dict, "update", (d: PyDict, other: any = undefined) => {
  if (other !== undefined) O.dictUpdate(d, other);
  return null;
});
dict.$dict.get("update").$kw = (pos: any[], names: string[], values: any[]) => {
  const d = pos[0];
  if (pos.length > 1) O.dictUpdate(d, pos[1]);
  names.forEach((n, i) => dictSet(d, n, values[i]));
  return null;
};
method(dict, "copy", (d: PyDict) => O.dictCopy(d));
method(dict, "clear", (d: PyDict) => {
  dictClear(d);
  return null;
});
dict.$dict.set("fromkeys", new PyClassMethod(pyfn((_c: any, keys: any, v: any = null) => {
  const d = new PyDict();
  O.forEach(keys, (k) => dictSet(d, k, v));
  return d;
}, "fromkeys")));
method(dict, "__len__", (d: PyDict) => d.$m.size);
method(dict, "__getitem__", (d: PyDict, k: any) => O.dictGetitem(d, k));
method(dict, "__setitem__", (d: PyDict, k: any, v: any) => (dictSet(d, k, v), null));
method(dict, "__delitem__", (d: PyDict, k: any) => {
  if (!dictDelete(d, k)) throw T.KeyError(k);
  return null;
});
method(dict, "__contains__", (d: PyDict, k: any) => dictGet(d, k) !== undefined);
method(dict, "__iter__", (d: PyDict) => new O.DictIter(d, 0));
method(dict, "__eq__", (d: PyDict, o: any) => (o instanceof PyDict ? O.dictEquals(d, o) : NotImplemented));
method(dict, "__ne__", (d: PyDict, o: any) => (o instanceof PyDict ? !O.dictEquals(d, o) : NotImplemented));
method(dict, "__or__", (d: PyDict, o: any) => {
  if (!(o instanceof PyDict)) return NotImplemented;
  const r = dictCall(d);
  O.dictUpdate(r, o);
  return r;
});
method(dict, "__ror__", (d: PyDict, o: any) => {
  if (!(o instanceof PyDict)) return NotImplemented;
  const r = dictCall(o);
  O.dictUpdate(r, d);
  return r;
});
method(dict, "__ior__", (d: PyDict, o: any) => (O.dictUpdate(d, o), d));
method(dict, "__repr__", (d: PyDict) => dictRepr(d));
dict.$dict.set("__hash__", null);

// ------------------------------------------------------------------ set, frozenset

const set = builtinType("set", [object], (x: any = undefined) => O.newSet(x));
const frozenset = builtinType("frozenset", [object], (x: any = undefined) => (x instanceof O.PySet && x.$frozen ? x : O.newSet(x, true)));
class FrozenBase extends O.PySet {
  constructor() {
    super();
    this.$frozen = true;
  }
}
set.$jsBase = O.PySet;
frozenset.$jsBase = FrozenBase;
method(set, "__init__", (s: O.PySet, it: any = undefined) => {
  dictClear(s.$d);
  if (it !== undefined) O.forEach(it, (v) => O.setAdd(s, v));
  return null;
});
frozenset.$dict.set("__new__", pyfn(function __new__(cls: PyType, it: any = undefined) {
  const s = cls === frozenset ? O.newSet(undefined, true) : new cls.$ctor!();
  if (it !== undefined) O.forEach(it, (v) => O.setAdd(s, v));
  return s;
}, "__new__"));
Object.defineProperty(O.PySet.prototype, "$cls", {
  get(this: O.PySet) {
    return this.$frozen ? frozenset : set;
  },
});
const asSet = (x: any) => (x instanceof O.PySet ? x : O.newSet(x));
const setMethods = (cls: PyType, mutable: boolean) => {
  method(cls, "copy", (s: O.PySet) => O.setOp(s, O.newSet(), "or"));
  method(cls, "union", (s: O.PySet, ...others: any[]) => others.reduce((acc, o) => O.setOp(acc, asSet(o), "or"), O.setOp(s, O.newSet(), "or")));
  method(cls, "intersection", (s: O.PySet, ...others: any[]) => others.reduce((acc, o) => O.setOp(acc, asSet(o), "and"), O.setOp(s, O.newSet(), "or")));
  method(cls, "difference", (s: O.PySet, ...others: any[]) => others.reduce((acc, o) => O.setOp(acc, asSet(o), "sub"), O.setOp(s, O.newSet(), "or")));
  method(cls, "symmetric_difference", (s: O.PySet, o: any) => O.setOp(s, asSet(o), "xor"));
  method(cls, "issubset", (s: O.PySet, o: any) => O.setSubset(s, asSet(o)));
  method(cls, "issuperset", (s: O.PySet, o: any) => O.setSubset(asSet(o), s));
  method(cls, "isdisjoint", (s: O.PySet, o: any) => O.toArray(o).every((v) => dictGet(s.$d, v) === undefined));
  method(cls, "__len__", (s: O.PySet) => s.$d.$m.size);
  method(cls, "__contains__", (s: O.PySet, x: any) => dictGet(s.$d, x) !== undefined);
  method(cls, "__iter__", (s: O.PySet) => new O.DictIter(s.$d, 0));
  method(cls, "__repr__", (s: O.PySet) => setRepr(s));
  method(cls, "__eq__", (s: O.PySet, o: any) => (o instanceof O.PySet ? O.eq(s, o) : NotImplemented));
  for (const [op, f] of [["__and__", "and"], ["__or__", "or"], ["__sub__", "sub"], ["__xor__", "xor"]] as const) {
    method(cls, op, (s: O.PySet, o: any) => (o instanceof O.PySet ? O.setOp(s, o, f) : NotImplemented));
  }
  method(cls, "__le__", (s: O.PySet, o: any) => (o instanceof O.PySet ? cls.$dict.get("issubset")(s, o) : NotImplemented));
  method(cls, "__ge__", (s: O.PySet, o: any) => (o instanceof O.PySet ? cls.$dict.get("issuperset")(s, o) : NotImplemented));
  method(cls, "__lt__", (s: O.PySet, o: any) => (o instanceof O.PySet ? s.$d.$m.size < o.$d.$m.size && cls.$dict.get("issubset")(s, o) : NotImplemented));
  method(cls, "__gt__", (s: O.PySet, o: any) => (o instanceof O.PySet ? s.$d.$m.size > o.$d.$m.size && cls.$dict.get("issuperset")(s, o) : NotImplemented));
  if (!mutable) {
    method(cls, "__hash__", (s: O.PySet) => O.hashAny(s));
    return;
  }
  cls.$dict.set("__hash__", null);
  method(cls, "add", (s: O.PySet, x: any) => (O.setAdd(s, x), null));
  method(cls, "discard", (s: O.PySet, x: any) => (dictDelete(s.$d, x), null));
  method(cls, "remove", (s: O.PySet, x: any) => {
    if (!dictDelete(s.$d, x)) throw T.KeyError(x);
    return null;
  });
  method(cls, "pop", (s: O.PySet) => {
    const it = s.$d.$m.keys().next();
    if (it.done) throw T.KeyError("pop from an empty set");
    const k = dictKeyOf(s.$d, it.value);
    dictDelete(s.$d, k);
    return k;
  });
  method(cls, "clear", (s: O.PySet) => (dictClear(s.$d), null));
  method(cls, "update", (s: O.PySet, ...others: any[]) => {
    for (const o of others) O.forEach(o, (v) => O.setAdd(s, v));
    return null;
  });
  for (const [name, f] of [["intersection_update", "and"], ["difference_update", "sub"], ["symmetric_difference_update", "xor"]] as const) {
    method(cls, name, (s: O.PySet, ...os: any[]) => {
      for (const o of os) s.$d = O.setOp(s, asSet(o), f).$d;
      return null;
    });
  }
};
setMethods(set, true);
setMethods(frozenset, false);

// ------------------------------------------------------------------ range, slice

export class PyRange {
  constructor(public start: number, public stop: number, public step: number) {}
  get length(): number {
    const { start, stop, step } = this;
    if (step > 0) return start < stop ? Math.floor((stop - start - 1) / step) + 1 : 0;
    return start > stop ? Math.floor((start - stop - 1) / -step) + 1 : 0;
  }
}
// Ranges whose arguments do not all fit in doubles use BigInt arithmetic.
export class PyBigRange {
  constructor(public start: bigint, public stop: bigint, public step: bigint) {}
  get length(): bigint {
    const { start, stop, step } = this;
    if (step > 0n) return start < stop ? (stop - start - 1n) / step + 1n : 0n;
    return start > stop ? (start - stop - 1n) / -step + 1n : 0n;
  }
  at(i: bigint): any {
    return O.normBig(this.start + i * this.step);
  }
}
class BigRangeIter {
  constructor(public cur: bigint, public left: bigint, public step: bigint) {}
  $next(): any {
    if (this.left <= 0n) return DONE;
    const v = this.cur;
    this.cur += this.step;
    this.left--;
    return O.normBig(v);
  }
}
const rangeArg = (v: any) => O.index(v);
export function makeRange(a: any, b: any = undefined, c: any = undefined): any {
  const args = b === undefined ? [0, rangeArg(a), 1] : [rangeArg(a), rangeArg(b), c === undefined ? 1 : rangeArg(c)];
  if (Number(args[2]) === 0) raise(T.ValueError, "range() arg 3 must not be zero");
  if (args.some((x) => typeof x === "bigint")) return new PyBigRange(BigInt(args[0]), BigInt(args[1]), BigInt(args[2]));
  return new PyRange(args[0] as number, args[1] as number, args[2] as number);
}
const bigRangeMethods: Record<string, (r: PyBigRange, ...a: any[]) => any> = {
  __iter__: (r) => new BigRangeIter(r.start, r.length, r.step),
  __reversed__: (r) => new BigRangeIter(r.start + (r.length - 1n) * r.step, r.length, -r.step),
  __len__: (r) => {
    const n = r.length;
    if (n > 9223372036854775807n) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
    return O.normBig(n);
  },
  __contains__: (r, x) => {
    if (!O.isPyInt(x)) return O.truth(O.eq(x, x)) && false;
    const v = BigInt(x);
    const inside = r.step > 0n ? v >= r.start && v < r.stop : v <= r.start && v > r.stop;
    return inside && (v - r.start) % r.step === 0n;
  },
  __getitem__: (r, k) => {
    const n = r.length;
    if (k instanceof O.PySlice) {
      const st = k.step === null ? 1n : BigInt(O.index(k.step));
      if (st === 0n) raise(T.ValueError, "slice step cannot be zero");
      const lo = st < 0n ? -1n : 0n, hi = st < 0n ? n - 1n : n;
      const fix = (v: any, d: bigint) => {
        if (v === null) return d;
        let x = BigInt(O.index(v));
        if (x < 0n) x = x + n < lo ? lo : x + n;
        return x > hi ? hi : x;
      };
      const a = fix(k.start, st < 0n ? hi : lo), b = fix(k.stop, st < 0n ? lo : hi);
      return makeRange(O.normBig(r.start + a * r.step), O.normBig(r.start + b * r.step), O.normBig(st * r.step));
    }
    let i = BigInt(O.index(k));
    if (i < 0n) i += n;
    if (i < 0n || i >= n) raise(T.IndexError, "range object index out of range");
    return r.at(i);
  },
  index: (r, x) => {
    if (!bigRangeMethods.__contains__(r, x)) raise(T.ValueError, `${repr(x)} is not in range`);
    return O.normBig((BigInt(x) - r.start) / r.step);
  },
  count: (r, x) => (bigRangeMethods.__contains__(r, x) ? 1 : 0),
  __repr__: (r) => (r.step === 1n ? `range(${r.start}, ${r.stop})` : `range(${r.start}, ${r.stop}, ${r.step})`),
  __hash__: (r) => O.hashAny(tuple([O.normBig(r.length), O.normBig(r.start), O.normBig(r.step)])),
};
const range = builtinType("range", [object], makeRange);
bindClass(PyRange, range);
bindClass(PyBigRange, range);
getset(range, "start", (r) => (typeof r.start === "bigint" ? O.normBig(r.start) : r.start));
getset(range, "stop", (r) => (typeof r.stop === "bigint" ? O.normBig(r.stop) : r.stop));
getset(range, "step", (r) => (typeof r.step === "bigint" ? O.normBig(r.step) : r.step));
method(range, "__iter__", (r: PyRange) => new O.RangeIter(r.start, r.stop, r.step));
method(range, "__reversed__", (r: PyRange) => {
  const n = r.length;
  return new O.RangeIter(r.start + (n - 1) * r.step, r.start - r.step, -r.step);
});
method(range, "__len__", (r: PyRange) => r.length);
method(range, "__contains__", (r: PyRange, x: any) => {
  if (!(typeof x === "number" && isInt(x))) return O.contains(O.toArray(new O.RangeIter(r.start, r.stop, r.step)), x);
  const inside = r.step > 0 ? x >= r.start && x < r.stop : x <= r.start && x > r.stop;
  return inside && (x - r.start) % r.step === 0;
});
method(range, "__getitem__", (r: PyRange, k: any) => {
  if (k instanceof O.PySlice) {
    const [a, b, st] = O.sliceAdjust(k, r.length);
    return new PyRange(r.start + a * r.step, r.start + b * r.step, st * r.step);
  }
  return r.start + O.seqIndex(k, r.length, "range object") * r.step;
});
method(range, "index", (r: PyRange, x: any) => {
  if (!O.truth(range.$dict.get("__contains__")(r, x))) raise(T.ValueError, `${repr(x)} is not in range`);
  return (x - r.start) / r.step;
});
method(range, "count", (r: PyRange, x: any) => (O.truth(range.$dict.get("__contains__")(r, x)) ? 1 : 0));
method(range, "__repr__", (r: PyRange) => (r.step === 1 ? `range(${r.start}, ${r.stop})` : `range(${r.start}, ${r.stop}, ${r.step})`));
method(range, "__eq__", (r: PyRange, o: any) => {
  if (!(o instanceof PyRange)) return NotImplemented;
  const n = r.length;
  if (n !== o.length) return false;
  return n === 0 || (r.start === o.start && (n === 1 || r.step === o.step));
});
method(range, "__hash__", (r: PyRange) => O.hashAny(tuple([r.length, r.start, r.step])));

const sliceType = builtinType("slice", [object], (a: any, b: any = undefined, c: any = undefined) => (b === undefined ? new O.PySlice(null, a, null) : new O.PySlice(a, b, c ?? null)));
bindClass(O.PySlice, sliceType);
getset(sliceType, "start", (s) => s.start);
getset(sliceType, "stop", (s) => s.stop);
getset(sliceType, "step", (s) => s.step);
method(sliceType, "indices", (s: O.PySlice, n: any) => {
  const len = Number(O.index(n));
  if (len < 0) raise(T.ValueError, "length should not be negative");
  return tuple(O.sliceAdjust(s, len));
});
method(sliceType, "__repr__", (s: O.PySlice) => `slice(${repr(s.start)}, ${repr(s.stop)}, ${repr(s.step)})`);

// ------------------------------------------------------------------ bytes, bytearray

const Ty_lookup = (x: any, name: string) => lookupType(typeOf(x), name);
function toBytes(x: any, encoding: any = undefined, errors: any = undefined): Uint8Array {
  if (x === undefined) return new Uint8Array(0);
  if (typeof x === "string") {
    if (encoding === undefined) raise(T.TypeError, "string argument without an encoding");
    return encode(x, encoding, errors ?? "strict").a;
  }
  if (encoding !== undefined) raise(T.TypeError, typeof x === "string" ? "" : "encoding without a string argument");
  if (O.isPyInt(x)) {
    if (typeof x === "bigint" || Number(x) > 2 ** 32) raise(T.OverflowError, "cannot fit 'int' into an index-sized integer");
    if (Number(x) < 0) raise(T.ValueError, "negative count");
    return new Uint8Array(Number(x));
  }
  const buf = O.bufferOf(x);
  if (buf !== undefined) return buf.slice();
  if (typeof x === "object" && x !== null && Ty_lookup(x, "__bytes__") !== undefined) {
    const r = Ty_lookup(x, "__bytes__")(x);
    if (!(r instanceof PyBytes)) raise(T.TypeError, `__bytes__ returned non-bytes (type ${typeName(r)})`);
    return r.a.slice(0, r.n);
  }
  return Uint8Array.from(O.toArray(x).map((v) => {
    if (!O.isPyInt(v)) raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
    if (v < 0 || v > 255) raise(T.ValueError, "bytes must be in range(0, 256)");
    return Number(v);
  }));
}
const bytesType = builtinType("bytes", [object], (x: any = undefined, enc: any = undefined, errors: any = undefined) => new PyBytes(toBytes(x, enc, errors)));
const bytearray = builtinType("bytearray", [object], (x: any = undefined, enc: any = undefined, errors: any = undefined) => new PyByteArray(toBytes(x, enc, errors)));
bindClass(PyBytes, bytesType);
bindClass(PyByteArray, bytearray);
for (const bt of [bytesType, bytearray]) {
  method(bt, "decode", (b: PyBytes, encoding: any = "utf-8", errors: any = "strict") => decode(b, encoding, errors), sig(["self", "encoding", "errors"]));
  method(bt, "hex", (b: PyBytes, sep: any = undefined, bps: any = undefined) => bytesHex(b.a.subarray(0, b.n), sep, bps));
  method(bt, "__len__", (b: PyBytes) => b.n);
  method(bt, "__iter__", (b: PyBytes) => new O.BytesIter(b));
  method(bt, "__getitem__", (b: PyBytes, k: any) => O.getitem(b, k));
  method(bt, "__repr__", (b: PyBytes) => repr(b));
  method(bt, "__eq__", (b: PyBytes, o: any) => (o instanceof PyBytes ? O.eq(b, o) : NotImplemented));
  method(bt, "count", (b: PyBytes, x: any) => (O.isPyInt(x) ? b.a.subarray(0, b.n).filter((v) => v === Number(x)).length : decode(b, "latin1").split(decode(x, "latin1")).length - 1));
  method(bt, "find", (b: PyBytes, x: any) => (O.isPyInt(x) ? b.a.subarray(0, b.n).indexOf(Number(x)) : decode(b, "latin1").indexOf(decode(x, "latin1"))));
  method(bt, "startswith", (b: PyBytes, x: PyBytes) => decode(b, "latin1").startsWith(decode(x, "latin1")));
  method(bt, "endswith", (b: PyBytes, x: PyBytes) => decode(b, "latin1").endsWith(decode(x, "latin1")));
  method(bt, "join", (b: PyBytes, items: any) => new (bt === bytesType ? PyBytes : PyByteArray)(encode(O.toArray(items).map((x: PyBytes) => decode(x, "latin1")).join(decode(b, "latin1")), "latin1").a));
}
method(bytesType, "__hash__", (b: PyBytes) => O.hashAny(decode(b, "latin1")) ^ 0x5bd1e995);
bytearray.$dict.set("__hash__", null);
method(bytearray, "__setitem__", (b: PyByteArray, k: any, v: any) => (O.setitem(b, k, v), null));
const grow = (b: PyByteArray, extra: number) => {
  if (b.n + extra > b.a.length) {
    const a = new Uint8Array(Math.max(16, (b.n + extra) * 2));
    a.set(b.a.subarray(0, b.n));
    b.a = a;
  }
};
method(bytearray, "append", (b: PyByteArray, x: any) => {
  if (!O.isPyInt(x)) raise(T.TypeError, `'${typeName(x)}' object cannot be interpreted as an integer`);
  if (x < 0 || x > 255) raise(T.ValueError, "byte must be in range(0, 256)");
  grow(b, 1);
  b.a[b.n++] = Number(x);
  return null;
});
method(bytearray, "extend", (b: PyByteArray, x: any) => {
  const add = toBytes(x);
  grow(b, add.length);
  b.a.set(add, b.n);
  b.n += add.length;
  return null;
});
method(bytearray, "pop", (b: PyByteArray) => {
  if (b.n === 0) raise(T.IndexError, "pop from empty bytearray");
  return b.a[--b.n];
});

// ------------------------------------------------------------------ iterators

// An iterator type over a runtime class implementing $next().
function iteratorType(name: string, jsClass: any, call?: (...a: any[]) => any): PyType {
  const t = builtinType(name, [object], call ?? (() => raise(T.TypeError, `cannot create '${name}' instances`)));
  bindClass(jsClass, t);
  method(t, "__iter__", (it: any) => it);
  method(t, "__next__", (it: any) => {
    O.lastStop.e = null;
    const v = it.$next();
    if (v === DONE) throw O.lastStop.e ?? T.StopIteration();
    return v;
  });
  return t;
}
iteratorType("list_iterator", O.ListIter);
iteratorType("range_iterator", O.RangeIter);
iteratorType("str_ascii_iterator", O.StrIter);
iteratorType("dict_keyiterator", O.DictIter);
iteratorType("bytes_iterator", O.BytesIter);
iteratorType("generator_wrapper", O.GenIter);
iteratorType("iterator", O.ProtoIter);

export class Enumerate {
  constructor(public it: any, public i: any) {}
  $next(): any {
    const v = this.it.$next();
    if (v === DONE) return DONE;
    const r = tuple([this.i, v]);
    this.i = typeof this.i === "number" && this.i < 9007199254740990 ? this.i + 1 : O.add(this.i, 1);
    return r;
  }
}
const enumerate = iteratorType("enumerate", Enumerate, (x: any, start: any = 0) => new Enumerate(O.iter(x), start));
enumerate.$kw = (pos, names, values) => {
  const [x, start] = bindArgs("enumerate", sig(["iterable", "start"]), pos, names, values);
  return new Enumerate(O.iter(x), start ?? 0);
};

export class Zip {
  constructor(public its: any[], public strict: boolean) {}
  $next(): any {
    const its = this.its;
    if (its.length === 0) return DONE;
    const out = new Array(its.length);
    for (let i = 0; i < its.length; i++) {
      const v = its[i].$next();
      if (v === DONE) {
        if (this.strict && (i > 0 || its.slice(1).some((it) => it.$next() !== DONE))) raise(T.ValueError, `zip() argument ${i > 0 ? i + 1 : 2} is ${i > 0 ? "shorter" : "longer"} than argument${i > 1 ? "s 1-" + i : " 1"}`);
        return DONE;
      }
      out[i] = v;
    }
    return tuple(out);
  }
}
const zip = iteratorType("zip", Zip, (...xs: any[]) => new Zip(xs.map(O.iter), false));
zip.$kw = (pos, names, values) => new Zip(pos.map(O.iter), names[0] === "strict" && O.truth(values[0]));

export class MapIter {
  constructor(public f: any, public its: any[]) {}
  $next(): any {
    const args = new Array(this.its.length);
    for (let i = 0; i < this.its.length; i++) {
      const v = this.its[i].$next();
      if (v === DONE) return DONE;
      args[i] = v;
    }
    const f = this.f;
    return typeof f === "function" ? f(...args) : callObj(f, args);
  }
}
iteratorType("map", MapIter, (f: any, ...xs: any[]) => {
  if (xs.length === 0) raise(T.TypeError, "map() must have at least two arguments.");
  return new MapIter(f, xs.map(O.iter));
});

export class FilterIter {
  constructor(public f: any, public it: any) {}
  $next(): any {
    for (;;) {
      const v = this.it.$next();
      if (v === DONE) return DONE;
      if (this.f === null ? O.truth(v) : O.truth(callObj(this.f, [v]))) return v;
    }
  }
}
iteratorType("filter", FilterIter, (f: any, x: any) => new FilterIter(f, O.iter(x)));

export class ReversedIter {
  constructor(public a: any, public i: number, public get: (i: number) => any) {}
  $next(): any {
    return this.i >= 0 ? this.get(this.i--) : DONE;
  }
}
iteratorType("reversed", ReversedIter, (x: any) => {
  if (Array.isArray(x)) return new ReversedIter(x, x.length - 1, (i) => x[i]);
  const r = lookupType(typeOf(x), "__reversed__");
  if (r === null) raise(T.TypeError, `'${typeName(x)}' object is not reversible`);
  if (r !== undefined) return r(x);
  const gi = lookupType(typeOf(x), "__getitem__");
  if (gi === undefined) raise(T.TypeError, `'${typeName(x)}' object is not reversible`);
  if (typeof x === "string") {
    const cs = [...x];
    return new ReversedIter(cs, cs.length - 1, (i) => cs[i]);
  }
  return new ReversedIter(x, O.len(x) - 1, (i) => gi(x, i));
});

// `gen.throw(E)`, `gen.throw(E, v)`, `gen.throw(e)`.
export function throwable(e: any, v: any): any {
  if (isType(e)) {
    if (!e.$mro.includes(T.BaseException)) raise(T.TypeError, "exceptions must be classes or instances deriving from BaseException, not type");
    return v === undefined || v === null ? e() : isinstance(v, e) ? v : e(v);
  }
  if (e === null || typeof e !== "object" || !isinstance(e, T.BaseException)) raise(T.TypeError, `exceptions must be classes or instances deriving from BaseException, not ${typeName(e)}`);
  return e;
}

// Generators are JS generator objects.
const generator = builtinType("generator", [object], () => raise(T.TypeError, "cannot create 'generator' instances"));
const genResult = (r: IteratorResult<any>) => {
  if (r.done) throw O.stopIteration(r.value);
  return r.value;
};
method(generator, "__iter__", (g: Generator) => g);
method(generator, "__next__", (g: Generator) => genResult(O.genStep(g, false, undefined)));
method(generator, "send", (g: Generator, v: any) => genResult(O.genStep(g, false, v)));
method(generator, "throw", (g: any, e: any, v: any = undefined) => {
  let x: any;
  const args = v === undefined ? [e] : [e, v];
  try {
    x = throwable(e, v);
  } catch (err: any) {
    // Invalid here, but a delegate's throw() may accept it: send a TypeError
    // that carries the original arguments (see yieldFrom).
    x = err;
    (args as any).invalid = err.args[0];
  }
  Object.defineProperty(x, "$rawThrow", { value: args, configurable: true, writable: true });
  if (!isinstance(x, T.GeneratorExit)) return genResult(O.genStep(g, true, x));
  const prev = O.closing.e;
  O.closing.e = x;
  try {
    return genResult(O.genStep(g, true, x));
  } finally {
    O.closing.e = prev;
  }
});
// close() throws GeneratorExit in at the paused yield, as CPython does, so
// `except GeneratorExit` and `finally` both see it.
method(generator, "close", (g: any) => {
  if (!g.$started) {
    g.$started = true;
    g.return(undefined);
    return null;
  }
  let r: IteratorResult<any>;
  const prev = O.closing.e;
  const ge = (O.closing.e = T.GeneratorExit());
  try {
    r = O.genStep(g, true, ge);
  } catch (e: any) {
    if (isinstance(e, T.GeneratorExit) || isinstance(e, T.StopIteration)) return null;
    throw e;
  } finally {
    O.closing.e = prev;
  }
  if (!r.done) raise(T.RuntimeError, "generator ignored GeneratorExit");
  return r.value ?? null;
});
getset(generator, "gi_running", () => false);
getset(generator, "__name__", (g: any) => g.$fn?.__name__ ?? "<genexpr>");
getset(generator, "__qualname__", (g: any) => g.$fn?.__qualname__ ?? "<genexpr>");
method(generator, "__repr__", (g: any) => `<generator object ${g.$fn?.__qualname__ ?? "<genexpr>"} at 0x${O.id(g).toString(16)}>`);

// ------------------------------------------------------------------ dir

export function dir(x: any = undefined): any[] {
  if (!isType(x)) {
    const f = lookupType(typeOf(x), "__dir__");
    if (f !== undefined && f !== objectDir) {
      const r = O.toArray(f(x));
      return r.sort((a, b) => (O.truth(O.lt(a, b)) ? -1 : O.truth(O.lt(b, a)) ? 1 : 0));
    }
  }
  return defaultDir(x);
}
function defaultDir(x: any): any[] {
  const names = new Set<string>();
  if (isType(x)) for (const c of x.$mro) for (const k of c.$dict.keys()) names.add(k);
  else {
    if (hasInstanceDict(x)) for (const k of Object.keys(x)) if (k[0] !== "$") names.add(k);
    for (const c of typeOf(x).$mro) for (const k of c.$dict.keys()) names.add(k);
  }
  return [...names].sort();
}

// Helpers for builtin modules.
export function lookupDunder(x: any, name: string): any {
  const f = lookupType(typeOf(x), name);
  return f !== null && typeof f === "object" && f.asDunder !== undefined ? f.asDunder() : f;
}
// float(x) for objects with __float__/__index__, or undefined.
export function floatCallSafe(x: any): number | undefined {
  for (const name of ["__float__", "__index__"]) {
    const f = lookupType(typeOf(x), name);
    if (f !== undefined) return O.fv(f(x));
  }
  return undefined;
}

// A builtin type for a runtime JS class, created by a builtin module.
export function builtinTypeFor(name: string, jsClass: any, module: string, call: (...a: any[]) => any): PyType {
  const t = builtinType(name, [object], call, module);
  bindClass(jsClass, t);
  return t;
}

// object.__class__ and object.__dict__ (a snapshot for now; writes through
// __dict__ are not reflected).
getset(object, "__class__", (o) => typeOf(o), (o, c) => {
  if (!isType(c) || c.$ctor === null || !hasInstanceDict(o) || c.$jsBase !== null) raise(T.TypeError, "__class__ assignment only supported for mutable types or ModuleType subclasses");
  Object.setPrototypeOf(o, c.$ctor!.prototype);
});
getset(object, "__dict__", (o) => {
  if (!hasInstanceDict(o)) raise(T.AttributeError, `'${typeName(o)}' object has no attribute '__dict__'`);
  return instanceDict(o);
}, (o, v) => {
  if (!hasInstanceDict(o)) raise(T.AttributeError, `'${typeName(o)}' object has no attribute '__dict__'`);
  if (!(v instanceof PyDict)) raise(T.TypeError, `__dict__ must be set to a dictionary, not a '${typeName(v)}'`);
  const items = [...v.$m].map(([k, x]) => [dictKeyOf(v, k), x]);
  instanceDict(o).$m.clear();
  for (const [k, x] of items) instanceDict(o).$m.set(k, x);
});

// bytes/bytearray methods that mirror str methods run the str version on a
// latin-1 view and convert results back to the receiver's type.
{
  const latin = (x: any): any => {
    if (x instanceof PyBytes) return decode(x, "latin1");
    if (Array.isArray(x)) return (x as any).$t ? tuple(x.map(latin)) : x.map(latin);
    return x;
  };
  const back = (x: any, Cls: any): any => {
    if (typeof x === "string") return new Cls(encode(x, "latin1").a);
    if (Array.isArray(x)) return (x as any).$t ? tuple(x.map((v) => back(v, Cls))) : x.map((v) => back(v, Cls));
    return x;
  };
  const names = ["split", "rsplit", "strip", "lstrip", "rstrip", "partition", "rpartition", "replace", "index", "rindex", "find", "rfind", "count", "startswith", "endswith", "upper", "lower", "splitlines", "center", "ljust", "rjust", "zfill", "isdigit", "isalpha", "isspace", "isalnum", "isupper", "islower", "title", "capitalize", "swapcase", "removeprefix", "removesuffix", "expandtabs", "join"];
  for (const [bt, Cls] of [[T.bytes, PyBytes], [T.bytearray, PyByteArray]] as const) {
    for (const name of names) {
      const f = S.$dict.get(name);
      if (f === undefined) throw new Error(`internal: str.${name} missing`);
      const intArg = ["index", "rindex", "find", "rfind", "count"].includes(name);
      const m = function (self: PyBytes, ...args: any[]) {
        if (name === "join") return back(f(latin(self), O.toArray(args[0]).map((v) => {
          if (!(v instanceof PyBytes)) raise(T.TypeError, `sequence item: expected a bytes-like object, ${typeName(v)} found`);
          return latin(v);
        })), Cls);
        const conv = args.map((a, i) => {
          if (intArg && i === 0 && O.isPyInt(a)) {
            const v = Number(a);
            if (!(v >= 0 && v < 256)) raise(T.ValueError, "byte must be in range(0, 256)");
            return String.fromCharCode(v);
          }
          if (typeof a === "string") raise(T.TypeError, `a bytes-like object is required, not 'str'`);
          return a === undefined ? a : latin(a);
        });
        const r = f(latin(self), ...conv);
        if (Cls === PyBytes && typeof r === "string" && r.length === self.n && /strip|just|center|zfill|remove/.test(name)) return self;
        return back(r, Cls);
      };
      method(bt, name, m, f.$sig ?? null);
    }
  }
  const fromhex = (cls: any, s: any) => {
    if (s instanceof PyBytes) s = decode(s, "ascii");
    if (typeof s !== "string") raise(T.TypeError, `fromhex() argument must be str, not ${typeName(s)}`);
    // Whitespace may only separate bytes.
    const out: number[] = [];
    for (let i = 0; i < s.length; ) {
      if (/\s/.test(s[i])) {
        i++;
        continue;
      }
      if (!/^[0-9a-fA-F]{2}$/.test(s.slice(i, i + 2))) raise(T.ValueError, `non-hexadecimal number found in fromhex() arg at position ${/[0-9a-fA-F]/.test(s[i]) ? i + 1 : i}`);
      out.push(parseInt(s.slice(i, i + 2), 16));
      i += 2;
    }
    const a = Uint8Array.from(out);
    return cls === T.bytearray ? new PyByteArray(a) : new PyBytes(a);
  };
  T.bytes.$dict.set("fromhex", new PyClassMethod(pyfn(fromhex, "fromhex")));
  T.bytearray.$dict.set("fromhex", new PyClassMethod(pyfn(fromhex, "fromhex")));
  T.int.$dict.set("from_bytes", new PyClassMethod(pyfn((_c: any, b: any, byteorder: any = "big", signed: any = false) => {
    const a = O.toArray(b).map(Number);
    if (byteorder === "little") a.reverse();
    let v = 0n;
    for (const d of a) v = (v << 8n) | BigInt(d);
    if (O.truth(signed) && a.length && a[0] >= 128) v -= 1n << BigInt(8 * a.length);
    return O.normBig(v);
  }, "from_bytes", sig(["cls", "bytes", "byteorder"], { kwonly: ["signed"] }))));
  method(T.OSError, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.errno = args.length >= 2 ? args[0] : null;
    self.strerror = args.length >= 2 ? args[1] : null;
    self.filename = args.length >= 3 ? args[2] : null;
    return null;
  });
  method(T.OSError, "__str__", (self: any) => (self.errno !== null && self.errno !== undefined ? `[Errno ${str(self.errno)}] ${str(self.strerror)}${self.filename !== null && self.filename !== undefined ? `: ${repr(self.filename)}` : ""}` : T.BaseException.$dict.get("__str__")(self)));
}

// ------------------------------------------------------------------ subclassing builtin types

// Numeric dunders on int and float, so `int.__add__(a, b)`, `super().__add__`
// and reflected dispatch with subclasses behave as in CPython.
{
  const isNum = (x: any) => O.isPyInt(x) || O.isPyFloat(x);
  const numDunders = (cls: PyType, ok: (x: any) => boolean, intOnly: boolean) => {
    const bin = (name: string, f: (a: any, b: any) => any) => {
      method(cls, `__${name}__`, (a: any, b: any) => ((b = unbox(b)), ok(b) ? f(unbox(a), b) : NotImplemented));
      method(cls, `__r${name}__`, (a: any, b: any) => ((b = unbox(b)), ok(b) ? f(b, unbox(a)) : NotImplemented));
    };
    bin("add", O.add);
    bin("sub", O.sub);
    bin("mul", O.mul);
    bin("truediv", O.truediv);
    bin("floordiv", O.floordiv);
    bin("mod", O.mod);
    bin("divmod", O.divmod);
    method(cls, "__pow__", (a: any, b: any, m: any = null) => ((b = unbox(b)), ok(b) ? (m === null ? O.pow(unbox(a), b) : O.pow(unbox(a), b, unbox(m))) : NotImplemented));
    method(cls, "__rpow__", (a: any, b: any) => ((b = unbox(b)), ok(b) ? O.pow(b, unbox(a)) : NotImplemented));
    if (intOnly) {
      bin("lshift", O.lshift);
      bin("rshift", O.rshift);
      bin("and", O.and);
      bin("or", O.or);
      bin("xor", O.xor);
      method(cls, "__invert__", (a: any) => O.invert(unbox(a)));
    }
    for (const [n, f] of [["eq", O.eq], ["ne", O.ne], ["lt", O.lt], ["le", O.le], ["gt", O.gt], ["ge", O.ge]] as const) {
      method(cls, `__${n}__`, (a: any, b: any) => ((b = unbox(b)), isNum(b) ? f(unbox(a), b) : NotImplemented));
    }
    method(cls, "__neg__", (a: any) => O.neg(unbox(a)));
    method(cls, "__pos__", (a: any) => O.pos(unbox(a)));
    method(cls, "__abs__", (a: any) => O.abs(unbox(a)));
    method(cls, "__bool__", (a: any) => O.truth(unbox(a)));
  };
  numDunders(int, O.isPyInt, true);
  numDunders(float, isNum, false);
  method(S, "__ne__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s !== x : NotImplemented));
  method(S, "__le__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s <= x : NotImplemented));
  method(S, "__gt__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s > x : NotImplemented));
  method(S, "__ge__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s >= x : NotImplemented));
  method(S, "__rmul__", (s: string, x: any) => (O.isPyInt(unbox(x)) ? s.repeat(Math.max(0, Number(unbox(x)))) : NotImplemented));
}

// int, float, str: the subclass instance boxes the value.
const proxies = new Map<PyType, PyType>();
function unboxing(f: any): any {
  const w = function (self: any, ...args: any[]) {
    return f(unbox(self), ...args.map(unbox));
  };
  pyfn(w, f.__name__, f.$sig ?? null);
  (w as any).$builtinMethod = true;
  (w as any).__qualname__ = f.__qualname__;
  (w as any).$unboxing = true;
  return w;
}
hooks.primProxy = (base: PyType): PyType => {
  let px = proxies.get(base);
  if (px !== undefined) return px;
  const d = new Map<string, any>();
  for (const [k, v] of base.$dict) {
    if (k === "__new__" || k === "__init__") continue;
    if (typeof v === "function" && v.$builtinMethod === true) d.set(k, unboxing(v));
    else if (v instanceof GetSet) d.set(k, new GetSet(v.name, (o) => v.get(unbox(o)), v.set));
  }
  // int.__format__ with a float presentation type goes through float(self),
  // which a subclass may override.
  if (base === int) {
    const f0 = d.get("__format__");
    d.set("__format__", unboxing(f0));
    const fmtW = pyfn((self: any, spec: string) => {
      const fl = lookupType(typeOf(self), "__float__");
      if (typeof spec === "string" && /[eEfFgG%]$/.test(spec) && fl !== undefined && fl.$unboxing !== true) return format(fl(self), spec);
      return f0(unbox(self), spec);
    }, "__format__");
    (fmtW as any).$builtinMethod = true;
    (fmtW as any).$unboxing = true;
    d.set("__format__", fmtW);
  }
  px = { $name: base.$name, $qualname: base.$name, $module: "builtins", $dict: d, $bases: [], $mro: [], $subclasses: [], $ver: 0, $hidden: true } as any;
  px!.$mro = [px!, ...base.$mro];
  proxies.set(base, px!);
  return px!;
};
for (const [P, L] of [[int, IntLayout], [float, FloatLayout], [S, StrLayout]] as const) {
  P.$jsBase = L;
  const nw = pyfn(function __new__(cls: PyType, ...args: any[]) {
    const v = P(...args);
    if (cls === P) return v;
    if (!isType(cls) || !cls.$mro.includes(P)) raise(T.TypeError, `${P.$name}.__new__(X): X is not a subtype of ${P.$name}`);
    const o = new cls.$ctor!();
    o.$v = v;
    return o;
  }, "__new__");
  nw.$kw = (pos: any[], names: string[], values: any[]) => {
    const v = callKw(P, pos.slice(1), names, values);
    if (pos[0] === P) return v;
    const o = new pos[0].$ctor!();
    o.$v = v;
    return o;
  };
  P.$dict.set("__new__", nw);
}
getset(type, "__mro__", (c) => tuple(c.$mro.filter((x: any) => !x.$hidden)));
method(type, "mro", (c: any) => c.$mro.filter((x: any) => !x.$hidden));

// Types whose instances are runtime JS objects: a subclass instance is the
// base type's object re-prototyped onto the subclass.
export function subclassable(P: PyType, jsClass: any) {
  P.$jsBase = jsClass;
  const make = (cls: any, o: any) => {
    if (cls === P) return o;
    if (!isType(cls) || !cls.$mro.includes(P)) raise(T.TypeError, `${P.$name}.__new__(X): X is not a subtype of ${P.$name}`);
    Object.setPrototypeOf(o, cls.$ctor!.prototype);
    return o;
  };
  const nw = pyfn(function __new__(cls: PyType, ...args: any[]) {
    return make(cls, P(...args));
  }, "__new__");
  nw.$kw = (pos: any[], names: string[], values: any[]) => make(pos[0], callKw(P, pos.slice(1), names, values));
  P.$dict.set("__new__", nw);
}
subclassable(bytesType, PyBytes);
subclassable(bytearray, PyByteArray);
subclassable(T.map, MapIter);
subclassable(T.filter, FilterIter);
subclassable(T.zip, Zip);
subclassable(T.enumerate, Enumerate);
subclassable(T.reversed, ReversedIter);
subclassable(staticmethod, PyStaticMethod);
subclassable(classmethod, PyClassMethod);
// property subclasses commonly override __init__ and call super().__init__.
property.$jsBase = PyProperty;
property.$dict.set("__new__", pyfn(function __new__(cls: PyType, ..._args: any[]) {
  if (!isType(cls) || !cls.$mro.includes(property)) raise(T.TypeError, `property.__new__(X): X is not a subtype of property`);
  const o = cls === property ? new PyProperty(null, null, null, null) : new cls.$ctor!();
  o.fget = o.fset = o.fdel = o.doc = null;
  return o;
}, "__new__"));
method(property, "__init__", (p: PyProperty, fget: any = null, fset: any = null, fdel: any = null, doc: any = null) => {
  p.fget = fget;
  p.fset = fset;
  p.fdel = fdel;
  p.doc = doc;
  return null;
}, sig(["self", "fget", "fset", "fdel", "doc"]));

// Named tuples made by the runtime (sys.version_info, os.stat_result, ...).
const structseqTypes = new Map<string, PyType>();
export function structseq(name: string, fields: string[], values: any[]): any {
  let cls = structseqTypes.get(name);
  if (cls === undefined) {
    const d = new Map<string, any>();
    cls = objectType(name.slice(name.lastIndexOf(".") + 1), [tupleType], d, name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : "builtins");
    fields.forEach((f, i) => d.set(f, new GetSet(f, (o) => o[i])));
    d.set("n_fields", fields.length);
    d.set("_fields", tuple(fields));
    const c = cls;
    method(c, "__repr__", (o: any) => `${name}(${fields.map((f, i) => `${f}=${repr(o[i])}`).join(", ")})`);
    structseqTypes.set(name, cls);
  }
  const o = new cls.$ctor!();
  for (const v of values) o.push(v);
  return o;
}

// ------------------------------------------------------------------ coroutines

// `async def` compiles to a JS generator function whose generator objects
// have type coroutine (via `$cls` on the function's prototype).
export const coroutine = builtinType("coroutine", [object], () => raise(T.TypeError, "cannot create 'coroutine' instances"));
for (const n of ["send", "throw", "close"]) coroutine.$dict.set(n, generator.$dict.get(n));
method(coroutine, "__repr__", (g: any) => `<coroutine object ${g.$fn?.__qualname__ ?? "?"} at 0x${O.id(g).toString(16)}>`);
// coro.__await__() is an iterator over the same frames.
export class CoroWrapper {
  constructor(public g: any) {}
  $next(): any {
    const r = O.genStep(this.g, false, undefined);
    return r.done ? (O.lastStop.e = O.stopIteration(r.value), DONE) : r.value;
  }
}
const coroWrapper = iteratorType("coroutine_wrapper", CoroWrapper);
method(coroWrapper, "send", (w: CoroWrapper, v: any) => genResult(O.genStep(w.g, false, v)));
method(coroWrapper, "throw", (w: CoroWrapper, e: any, v: any = undefined) => generator.$dict.get("throw")(w.g, e, v));
method(coroWrapper, "close", (w: CoroWrapper) => generator.$dict.get("close")(w.g));
method(coroutine, "__await__", (g: any) => new CoroWrapper(g));
getset(coroutine, "cr_running", () => false);
getset(coroutine, "__name__", (g: any) => g.$fn?.__name__ ?? "?");
getset(coroutine, "__qualname__", (g: any) => g.$fn?.__qualname__ ?? "?");

// types.SimpleNamespace
export const SimpleNamespace = objectType("SimpleNamespace", [object], new Map(), "types");
{
  const init = method(SimpleNamespace, "__init__", (self: any, ...a: any[]) => {
    if (a.length) raise(T.TypeError, "SimpleNamespace() takes no positional arguments");
    return null;
  });
  init.$kw = (pos: any[], names: string[], values: any[]) => {
    if (pos.length > 2) raise(T.TypeError, "SimpleNamespace expected at most 1 positional argument");
    const self = pos[0];
    if (pos.length === 2) O.forEach(callObj(T.dict, [pos[1]]), (k: any) => void (self[k] = O.getitem(pos[1], k)));
    names.forEach((n, i) => (self[n] = values[i]));
    return null;
  };
  method(SimpleNamespace, "__repr__", (self: any) => {
    const ks = Object.keys(self).filter((k) => k[0] !== "$");
    return `${typeOf(self) === SimpleNamespace ? "namespace" : typeName(self)}(${ks.map((k) => `${k}=${repr(self[k])}`).join(", ")})`;
  });
  method(SimpleNamespace, "__eq__", (a: any, b: any) => {
    if (!isinstance(b, SimpleNamespace)) return NotImplemented;
    const ka = Object.keys(a).filter((k) => k[0] !== "$"), kb = Object.keys(b).filter((k) => k[0] !== "$");
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && O.eqBool(a[k], b[k]));
  });
  SimpleNamespace.$dict.set("__hash__", null);
}
export function simpleNamespace(fields: Record<string, any>): any {
  const o = new SimpleNamespace.$ctor!();
  Object.assign(o, fields);
  return o;
}

// bytes.hex(sep, bytes_per_sep): groups count from the right when
// bytes_per_sep > 0, from the left when < 0.
export function bytesHex(a: Uint8Array, sep: any = undefined, bps: any = undefined): string {
  const h = Buffer.from(a).toString("hex");
  if (sep === undefined || sep === null) return h;
  if (sep instanceof PyBytes) sep = decode(sep, "ascii");
  if (typeof sep !== "string") raise(T.TypeError, "sep must be str or bytes.");
  if ([...sep].length !== 1) raise(T.ValueError, "sep must be length 1.");
  let k = bps === undefined ? 1 : Number(bps);
  if (k === 0 || a.length === 0) return h;
  const groups: string[] = [];
  const n = a.length, size = Math.abs(k);
  if (k > 0) {
    for (let end = n; end > 0; end -= size) groups.unshift(h.slice(Math.max(0, end - size) * 2, end * 2));
  } else {
    for (let st = 0; st < n; st += size) groups.push(h.slice(st * 2, Math.min(n, st + size) * 2));
  }
  return groups.join(sep);
}

// bytes % args
for (const [bt, Cls] of [[T.bytes, PyBytes], [T.bytearray, PyByteArray]] as const) {
  method(bt, "__mod__", (b: PyBytes, x: any) => new Cls(encode(percentFormat(decode(b, "latin1"), x, true), "latin1").a));
}

// Big ranges share the range type: each method dispatches on the class.
for (const [name, bf] of Object.entries(bigRangeMethods)) {
  const f = T.range.$dict.get(name);
  method(T.range, name, (r: any, ...a: any[]) => (r instanceof PyBigRange ? bf(r, ...a) : f(r, ...a)));
}
{
  const eq = T.range.$dict.get("__eq__");
  method(T.range, "__eq__", (r: any, o: any) => {
    if (!(r instanceof PyBigRange) && !(o instanceof PyBigRange)) return eq(r, o);
    if (!(o instanceof PyRange) && !(o instanceof PyBigRange)) return NotImplemented;
    const big = (x: any) => (x instanceof PyBigRange ? x : new PyBigRange(BigInt(x.start), BigInt(x.stop), BigInt(x.step)));
    const a = big(r), b = big(o), n = a.length;
    if (n !== b.length) return false;
    return n === 0n || (a.start === b.start && (n === 1n || a.step === b.step));
  });
}

// X | Y on types: types.UnionType, usable with isinstance/issubclass.
export class PyUnion {
  constructor(public args: any[]) {}
}
export const unionType = builtinTypeFor("UnionType", PyUnion, "types", () => raise(T.TypeError, "cannot create 'types.UnionType' instances"));
{
  const unionArg = (x: any): any[] | undefined => {
    if (x === null) return [T.NoneType];
    if (isType(x)) return [x];
    if (x instanceof PyUnion) return x.args;
    return undefined;
  };
  const make = (a: any, b: any): any => {
    const x = unionArg(a), y = unionArg(b);
    if (x === undefined || y === undefined) return NotImplemented;
    const args: any[] = [];
    for (const t of [...x, ...y]) if (!args.includes(t)) args.push(t);
    return args.length === 1 ? args[0] : new PyUnion(args);
  };
  method(type, "__or__", (a: any, b: any) => make(a, b));
  method(type, "__ror__", (a: any, b: any) => make(b, a));
  method(unionType, "__or__", (a: any, b: any) => make(a, b));
  method(unionType, "__ror__", (a: any, b: any) => make(b, a));
  method(unionType, "__repr__", (u: PyUnion) => u.args.map((t) => (t === T.NoneType ? "None" : t.$module === "builtins" ? t.$qualname : `${t.$module}.${t.$qualname}`)).join(" | "));
  method(unionType, "__eq__", (u: PyUnion, o: any) => (o instanceof PyUnion ? u.args.length === o.args.length && u.args.every((t) => o.args.includes(t)) : NotImplemented));
  method(unionType, "__hash__", (u: PyUnion) => u.args.reduce((h, t) => h ^ O.id(t), 0));
  method(unionType, "__instancecheck__", (u: PyUnion, x: any) => u.args.some((t) => isinstance(x, t)));
  method(unionType, "__subclasscheck__", (u: PyUnion, c: any) => u.args.some((t) => c.$mro.includes(t)));
  getset(unionType, "__args__", (u: PyUnion) => tuple(u.args));
}

// Pickling support as in CPython's Objects/typeobject.c (reduce_newobj).
{
  const copyreg = () => hooks.importModule("copyreg");
  const getstate = method(object, "__getstate__", (self: any) => {
    if (!hasInstanceDict(self)) return null;
    const d = new PyDict();
    for (const k of Object.keys(self)) if (k[0] !== "$" && !(Array.isArray(self) && /^\d+$/.test(k))) dictSet(d, k, self[k]);
    return d.$m.size ? d : null;
  });
  const reduceNewobj = (self: any) => {
    const cls = typeOf(self);
    if (cls.$ctor === null && cls.$module === "builtins" && lookupType(cls, "__getnewargs__") === undefined && lookupType(cls, "__getnewargs_ex__") === undefined) raise(T.TypeError, `cannot pickle '${cls.$name}' object`);
    let args: any[] = [];
    const gna = lookupType(cls, "__getnewargs_ex__");
    if (gna !== undefined) {
      const [a, kw] = gna(self);
      if (kw instanceof PyDict && kw.$m.size) {
        const st = lookupType(cls, "__getstate__")(self);
        return tuple([getattr(copyreg(), "__newobj_ex__"), tuple([cls, a, kw]), st, null, null]);
      }
      args = O.toArray(a);
    } else {
      const gn = lookupType(cls, "__getnewargs__");
      if (gn !== undefined) args = O.toArray(gn(self));
    }
    const state = lookupType(cls, "__getstate__")(self);
    const listitems = Array.isArray(self) && !(self as any).$t ? O.iter(self) : null;
    const dictitems = self instanceof PyDict ? O.iter(callObj(getattr(self, "items"), [])) : null;
    return tuple([getattr(copyreg(), "__newobj__"), tuple([cls, ...args]), state, listitems, dictitems]);
  };
  const objectReduce = method(object, "__reduce__", (self: any) => callObj(getattr(copyreg(), "_reduce_ex"), [self, 0]));
  method(object, "__reduce_ex__", (self: any, proto: any = 0) => {
    const r = lookupType(typeOf(self), "__reduce__");
    if (r !== objectReduce) return callObj(getattr(self, "__reduce__"), []);
    if (Number(proto) >= 2) return reduceNewobj(self);
    return callObj(getattr(copyreg(), "_reduce_ex"), [self, proto]);
  });
  void getstate;
}
