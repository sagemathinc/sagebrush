// Builtin types and their methods.

import * as SP from "./strpos";
import { CASEFOLD } from "./casefold-data";
import {
  checkArity, ListLayout, TupleLayout, T, PyType, FloatBox, PyDict, dictMeta, PyBytes, PyByteArray, checkResizable, DONE, NotImplemented, Ellipsis,
  builtinType, markRaised, objectType, typeOf, typeName, lookupType, isType, raise, pyfn, builtin, sig, tuple,
  isinstance, getattr, genericGetattr, setattr, genericSetattr, delattr, objectInit, objectNew, objectSetattr, selfChecked, unboundFunction,
  bindMethod, bindArgs, genericDelattr, callKw, callObj, captureTraceback, dictGet, dictKeyHash, dictSet, dictDelete, dictKeyOf, dictClear, hasOwn, hasInstanceDict, Signature,
  hooks, unbox, toPyExc, instanceDict, detachInstanceDict, attrNames, PrimBox, NS_DICT, NS_GLOBALS, globalsDict, IntLayout, FloatLayout, StrLayout, TypeLayout, constructPlain, constructPlainKw, positionalArray, bumpVersion, typeGetattr, typeSetattr, typeDelattr, notForType, slotArgs, noKeywords,
} from "./object";
import * as O from "./ops";
import * as UC from "./unicodecs";
import * as AC from "./argconv";
import { repr, str, defaultRepr, dictRepr, setRepr, format, floatRepr, seqRepr, percentFormat, intDigits, admitDigits, parseDigits, strReprPrefix, bytesReprPrefix } from "./format";

// Store a builtin method (a JS function taking self first) in a type's dict.
export function method(cls: PyType, name: string, f: any, s: Signature | null = null) {
  if (s !== null) f.$sig = s;
  f = checkArity(f, name, true);
  pyfn(f, name, s);
  f.$builtinMethod = true;
  f.$owner = cls; // the type whose instances this method is for (a receiver check applies everywhere it is called)
  f.__qualname__ = `${cls.$name}.${name}`;
  cls.$dict.set(name, f);
  return f;
}

// Store a builtin type's __new__ (its first argument the class to make): it
// makes only instances of that type's subtypes, checked on every way of
// calling it (positionally, and by keyword through `kw`, the adapter for
// keyword arguments, given the class first), as CPython's do.  The type is
// kept as `$allocator` (test/security.test.ts checks every type's __new__).
export function allocator(owner: PyType, f: (cls: any, ...args: any[]) => any, kw?: (pos: any[], names: string[], values: any[]) => any) {
  const check = (cls: any) => {
    if (cls === owner) return;
    if (!isType(cls)) raise(T.TypeError, `${owner.$name}.__new__(X): X is not a type object (${typeName(cls)})`);
    if (!cls.$mro.includes(owner)) raise(T.TypeError, `${owner.$name}.__new__(${cls.$name}): ${cls.$name} is not a subtype of ${owner.$name}`);
  };
  const nw: any = pyfn(function __new__(cls: any, ...args: any[]) {
    if (cls === undefined) raise(T.TypeError, `${owner.$name}.__new__(): not enough arguments`);
    check(cls);
    return f(cls, ...args);
  }, "__new__");
  if (kw !== undefined) {
    nw.$kw = (pos: any[], names: string[], values: any[]) => {
      if (pos.length === 0) raise(T.TypeError, `${owner.$name}.__new__(): not enough arguments`);
      check(pos[0]);
      return kw(pos, names, values);
    };
  }
  nw.$allocator = owner;
  nw.$static = true; // (never bound to an instance: (1).__new__ is int.__new__)
  owner.$dict.set("__new__", nw);
  return nw;
}

// A data descriptor computed by JS: type `getset_descriptor`.
export class GetSet {
  constructor(public owner: PyType, public name: string, public get: (o: any) => any, public set: ((o: any, v: any) => void) | null = null, public del: ((o: any) => void) | null = null) {}
}
export function getset(cls: PyType, name: string, get: (o: any) => any, set: ((o: any, v: any) => void) | null = null, del: ((o: any) => void) | null = null) {
  cls.$dict.set(name, new GetSet(cls, name, get, set, del));
}
// A get/set descriptor applies only to an instance of the type it is for; a
// wrong receiver reaches a JavaScript property of an opaque object otherwise
// (design/security.md rule 6).
function descrReceiver(d: { owner: PyType; name: string }, o: any): void {
  if (!isinstance(o, d.owner)) raise(T.TypeError, `descriptor '${d.name}' for '${d.owner.$name}' objects doesn't apply to a '${typeName(o)}' object`);
}

// ------------------------------------------------------------------ object, type

const object = objectType("object", [], new Map(), "builtins");
T.object = object;
object.$dict.set("__init__", objectInit);
object.$dict.set("__new__", objectNew);
object.$dict.set("__setattr__", objectSetattr);
(objectSetattr as any).__qualname__ = "object.__setattr__";
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
// (the name of type.__getattribute__ and object.__getattribute__ checked
// first: an exact str; a str subclass refused, not looked up by a payload
// its own __hash__ or __eq__ might disagree with; anything else CPython's
// TypeError, before any lookup)
function exactAttrName(name: any): string {
  if (typeof name === "string") return name;
  if (typeof unbox(name) === "string") raise(T.NotImplementedError, `attribute names of str subclasses ('${typeName(name)}') are not supported yet`);
  return raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
}
method(object, "__getattribute__", (self: any, name: any) => genericGetattr(self, exactAttrName(name), typeOf(self), undefined, false));
// (its arguments as a slot wrapper's: slotArgs)
{
  const od: any = noKeywords(pyfn(function __delattr__(self: any, name: string) {
    slotArgs("__delattr__", "object", arguments, 1);
    notForType(self, "__delattr__");
    genericDelattr(self, name, typeOf(self));
    return null;
  }, "__delattr__"));
  od.$builtinMethod = true;
  od.$owner = object;
  od.__qualname__ = "object.__delattr__";
  od.$selfChecked = od;
  od.$genericDelattr = true;
  object.$dict.set("__delattr__", od);
}

const objectDir = method(object, "__dir__", (self: any) => defaultDir(self));

function typeCall(...args: any[]): any {
  if (args.length === 1) return typeOf(args[0]);
  if (args.length === 3) return typeMake(args[0], args[1], args[2], [], []);
  raise(T.TypeError, "type() takes 1 or 3 arguments");
}
const type = builtinType("type", [object], typeCall);
// type(name, bases, ns, **kw), as CPython's type_call and type_new: the
// most derived metaclass of the bases makes the class, its own __new__ (if
// it has one) called directly, not through its metaclass's __call__, with
// the caller's dict and the keywords; then the new class's type's __init__
// gets them too.  type's own __new__ passes them to __init_subclass__, and
// metaclass= is one of them here, not the class statement's.
function typeMake(name: any, bases: any, ns: any, names: string[], values: any[]): any {
  if (typeof name !== "string") raise(T.TypeError, `type.__new__() argument 1 must be str, not ${typeName(name)}`);
  if (!isinstance(bases, T.tuple)) raise(T.TypeError, `type.__new__() argument 2 must be tuple, not ${typeName(bases)}`);
  if (!(ns instanceof PyDict)) raise(T.TypeError, `type.__new__() argument 3 must be dict, not ${typeName(ns)}`);
  const winner = classMetaclass(O.toArray(bases), [], []).meta;
  const obj = winner !== type && lookupType(winner, "__new__") !== typeNew
    ? callKw(getattr(winner, "__new__"), [winner, name, bases, ns], names, values)
    : typeNewImpl(type, name, bases, ns, new Map(names.map((n, i) => [n, values[i]])));
  if (isinstance(obj, type)) {
    const init = lookupType(typeOf(obj), "__init__");
    const r = init === typeInit ? null : callKw(init, [obj, name, bases, ns], names, values);
    if (r !== null) raise(T.TypeError, `__init__() should return None, not '${typeName(r)}'`);
  }
  return obj;
}
type.$kw = (pos: any[], names: string[], values: any[]) => {
  if (names.length === 0) return typeCall(...pos);
  if (pos.length !== 3) raise(T.TypeError, pos.length === 1 ? "type() takes no keyword arguments" : "type() takes 1 or 3 arguments");
  return typeMake(pos[0], pos[1], pos[2], names, values);
};
type.$customGet = true;
// type.__getattribute__: type's own lookup (CPython's type_getattro: the
// metaclass's data descriptors, the class's MRO through __get__(None, cls),
// then the metaclass's other attributes), what a metaclass's
// super().__getattribute__ reaches; never __getattr__ (the slot calls that)
method(type, "__getattribute__", (c: any, name: any) => typeGetattr(c, exactAttrName(name)));
// (type's own __setattr__ and __delattr__, the metaclass hooks' default)
for (const f of [typeSetattr, typeDelattr] as any[]) {
  f.$builtinMethod = true;
  f.$owner = type;
  f.__qualname__ = `type.${f.__name__}`;
  f.$selfChecked = f; // (it checks its receiver itself, CPython's wording)
  type.$dict.set(f.__name__, f);
}
getset(type, "__name__", (c) => c.$name, (c, v) => void (c.$name = v));
getset(type, "__qualname__", (c) => c.$qualname, (c, v) => void (c.$qualname = v));
// (a class's __module__: its dict's, but not its instances' __module__
// descriptor there, as `type`'s or a function type's own: then its builtin
// module, as CPython's for a static type)
export function typeModule(c: PyType): any {
  const m = c.$dict.get("__module__");
  return m === undefined || typeOf(m) === T.getset_descriptor ? c.$module : m;
}
getset(type, "__module__", typeModule, (c, v) => c.$dict.set("__module__", v));
getset(type, "__mro__", (c) => tuple(c.$mro.slice()));
getset(type, "__bases__", (c) => tuple(c.$bases.slice()));
getset(type, "__base__", (c) => c.$bases[0] ?? null);
// types.MappingProxyType: a read-only view of a mapping, as CPython's (what
// a class's __dict__ is)
export class MappingProxy {
  constructor(public m: any) {}
}
const isMappingLike = (m: any) =>
  m instanceof PyDict || (!isinstance(m, T.list) && !isinstance(m, T.tuple) && lookupType(typeOf(m), "__getitem__") !== undefined && lookupType(typeOf(m), "keys") !== undefined);
export const mappingproxy = builtinType("mappingproxy", [object], (m: any) => {
  if (!isMappingLike(m)) raise(T.TypeError, `mappingproxy() argument must be a mapping, not ${typeName(m)}`);
  return new MappingProxy(m);
});
bindClass(MappingProxy, mappingproxy);
const viaMapping = (name: string) => (p: MappingProxy, ...a: any[]) => callObj(getattr(p.m, name), a);
method(mappingproxy, "__getitem__", (p: MappingProxy, k: any) => O.getitem(p.m, k));
method(mappingproxy, "__contains__", (p: MappingProxy, k: any) => O.contains(p.m, k));
method(mappingproxy, "__iter__", (p: MappingProxy) => O.iter(p.m));
method(mappingproxy, "__len__", (p: MappingProxy) => O.len(p.m));
method(mappingproxy, "__reversed__", (p: MappingProxy) => callObj(getattr(p.m, "__reversed__"), []));
for (const n of ["keys", "values", "items", "copy"]) method(mappingproxy, n, viaMapping(n));
method(mappingproxy, "get", (p: MappingProxy, k: any, dflt: any = null) => callObj(getattr(p.m, "get"), [k, dflt]));
method(mappingproxy, "__repr__", (p: MappingProxy) => `mappingproxy(${repr(p.m)})`);
method(mappingproxy, "__str__", (p: MappingProxy) => str(p.m));
// (comparisons and | are the mapping's, with a proxy operand unwrapped)
method(mappingproxy, "__eq__", (p: MappingProxy, o: any) => O.eq(p.m, o));
method(mappingproxy, "__ne__", (p: MappingProxy, o: any) => O.ne(p.m, o));
method(mappingproxy, "__lt__", (p: MappingProxy, o: any) => O.lt(p.m, o));
method(mappingproxy, "__le__", (p: MappingProxy, o: any) => O.le(p.m, o));
method(mappingproxy, "__gt__", (p: MappingProxy, o: any) => O.gt(p.m, o));
method(mappingproxy, "__ge__", (p: MappingProxy, o: any) => O.ge(p.m, o));
const unproxy = (o: any) => (o instanceof MappingProxy ? o.m : o);
method(mappingproxy, "__or__", (p: MappingProxy, o: any) => O.or(p.m, unproxy(o)));
method(mappingproxy, "__ror__", (p: MappingProxy, o: any) => O.or(unproxy(o), p.m));
method(mappingproxy, "__ior__", (p: MappingProxy, o: any) => raise(T.TypeError, "'|=' is not supported by mappingproxy; use '|' instead"));
method(mappingproxy, "__hash__", (p: MappingProxy) => O.hashExact(p.m)); // (as CPython's: the mapping's hash)

getset(type, "__dict__", (c) => {
  const d = new PyDict();
  // (a builtin method leaves the type's dict as its receiver-checking form, so
  // vars(cls)[name](receiver, ...) cannot run it on a wrong receiver)
  for (const [k, v] of c.$dict) dictSet(d, k, v !== null && typeof v === "function" && v.$owner !== undefined ? selfChecked(v) : v);
  // The class that first gives its instances a __dict__ shows the slot.
  if (c.$ctor !== null && c !== object && !c.$dict.has("__slots__") && !c.$dict.has("__dict__") && c.$bases.every((b: any) => b.$ctor === null || b === object || b.$jsBase !== null)) {
    dictSet(d, "__dict__", object.$dict.get("__dict__"));
  }
  // (read-only, as CPython's: a class's attributes are set with setattr)
  return new MappingProxy(d);
});
getset(type, "__doc__", (c) => c.$dict.get("__doc__") ?? null, (c, v) => void c.$dict.set("__doc__", v));
// A class's annotations (PEP 649/749): its own __annotations__ if its body
// set one, else those kept in __annotations_cache__, else what its
// __annotate_func__ gives (the body's __annotate__), kept; a class made by
// a class statement only (the builtins have none)
const noAnnot = (c: any, name: string): never => raise(T.AttributeError, `type object '${c.$name}' has no attribute '${name}'`);
const immutableAnnot = (c: any, name: string): never => raise(T.TypeError, `cannot set '${name}' attribute of immutable type '${c.$name}'`);
// (none yet: None, kept as __annotate_func__, as CPython's type_get_annotate)
getset(type, "__annotate__", (c) => {
  if (!c.$heap) noAnnot(c, "__annotate__");
  if (c.$dict.has("__annotate__")) return c.$dict.get("__annotate__");
  if (!c.$dict.has("__annotate_func__")) {
    c.$dict.set("__annotate_func__", null);
    bumpVersion(c);
  }
  return c.$dict.get("__annotate_func__");
}, (c, v) => {
  if (!c.$heap) immutableAnnot(c, "__annotate__");
  checkAnnotate(v);
  c.$dict.set("__annotate_func__", v);
  if (v !== null) c.$dict.delete("__annotations_cache__");
  bumpVersion(c);
}, () => raise(T.TypeError, "cannot delete __annotate__ attribute"));
getset(type, "__annotations__", (c) => {
  if (!c.$heap) noAnnot(c, "__annotations__");
  if (c.$dict.has("__annotations__")) return c.$dict.get("__annotations__");
  if (c.$dict.has("__annotations_cache__")) return c.$dict.get("__annotations_cache__");
  const a = c.$dict.has("__annotate__") ? c.$dict.get("__annotate__") : (c.$dict.get("__annotate_func__") ?? null);
  const d = a !== null && a !== undefined ? callAnnotate(a) : new PyDict();
  c.$dict.set("__annotations_cache__", d);
  bumpVersion(c);
  return d;
}, (c, v) => {
  if (!c.$heap) immutableAnnot(c, "__annotations__");
  c.$dict.delete("__annotations__");
  c.$dict.set("__annotations_cache__", v);
  dropAnnotate(c);
}, (c) => {
  // (what is kept deleted, and the provider with it: the next read {}, as
  // CPython's type_set_annotations; nothing kept, AttributeError)
  if (!c.$heap) immutableAnnot(c, "__annotations__");
  if (c.$dict.has("__annotations__")) c.$dict.delete("__annotations__");
  else if (c.$dict.has("__annotations_cache__")) c.$dict.delete("__annotations_cache__");
  else raise(T.AttributeError, "__annotations__");
  dropAnnotate(c);
});
function dropAnnotate(c: any): void {
  c.$dict.delete("__annotate_func__");
  c.$dict.delete("__annotate__");
  bumpVersion(c);
}
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
// (the owner optional, as CPython's wrap_descr_get; __get__(None, None) refused)
method(getsetType, "__get__", (d: GetSet, o: any = undefined, t: any = null) => {
  if (o === undefined) raise(T.TypeError, "__get__ expected at least 1 argument, got 0");
  if (o === null) return t === null ? raise(T.TypeError, "__get__(None, None) is invalid") : ((d as any).$orig ?? d);
  descrReceiver(d, o);
  return d.get(o);
});
method(getsetType, "__set__", (d: GetSet, o: any, v: any) => {
  // (the receiver first, as CPython: nothing about the descriptor is used on a wrong one)
  descrReceiver(d, o);
  if (d.set === null) raise(T.AttributeError, `attribute '${d.name}' of '${d.owner.$name}' objects is not writable`);
  d.set(o, v);
  return null;
});
// A __slots__ entry: type `member_descriptor`, the value kept in the
// instance's own runtime slot (a `$` key, never an attribute), as
// CPython's member descriptors; each its own slot, so that a subclass's
// slot of the same name as a base's is another (CORR-D77-1)
let memberIds = 0;
export class PyMember {
  key: string;
  constructor(public owner: PyType, public name: string) {
    this.key = `$slot:${++memberIds}:${name}`;
  }
}
const memberType = builtinType("member_descriptor", [object], () => raise(T.TypeError, "cannot create 'member_descriptor' instances"));
bindClass(PyMember, memberType);
const memberOf = (d: PyMember, o: any) => {
  descrReceiver(d, o);
  const v = o[d.key];
  return v === undefined ? raise(T.AttributeError, `'${typeName(o)}' object has no attribute '${d.name}'`) : v;
};
method(memberType, "__get__", (d: PyMember, o: any = undefined, t: any = null) => {
  if (o === undefined) raise(T.TypeError, "__get__ expected at least 1 argument, got 0");
  if (o === null) return t === null ? raise(T.TypeError, "__get__(None, None) is invalid") : d;
  return memberOf(d, o);
});
method(memberType, "__set__", (d: PyMember, o: any, v: any) => {
  descrReceiver(d, o);
  Object.defineProperty(o, d.key, { value: v, writable: true, configurable: true, enumerable: false });
  return null;
});
method(memberType, "__delete__", (d: PyMember, o: any) => {
  memberOf(d, o);
  delete o[d.key];
  return null;
});
method(memberType, "__repr__", (d: PyMember) => `<member '${d.name}' of '${d.owner.$name}' objects>`);
getset(memberType, "__name__", (d: PyMember) => d.name);
getset(memberType, "__qualname__", (d: PyMember) => `${d.owner.$qualname ?? d.owner.$name}.${d.name}`);
getset(memberType, "__objclass__", (d: PyMember) => d.owner);
memberType.$dict.set("__doc__", null);

// (a get/set descriptor without a deleter cannot be deleted, as CPython's
// read-only ones: del (1).real)
method(getsetType, "__delete__", (d: GetSet, o: any) => {
  descrReceiver(d, o);
  if (d.del === null) raise(T.AttributeError, `attribute '${d.name}' of '${d.owner.$name}' objects is not writable`);
  d.del(o);
  return null;
});

// ------------------------------------------------------------------ descriptors

export class PyProperty {
  // (name: __set_name__'s, as CPython's prop_name; kept by getter, setter
  // and deleter)
  name: any = null;
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
// (a property's missing accessor as CPython's: "property 'key' of 'X' object
// has no setter", its name __set_name__'s or its getter's __name__, the
// type's qualified name; unnamed, "property of 'X' object ...")
const propName = (p: PyProperty): any => p.name ?? (p.fget !== null ? getattr(p.fget, "__name__", null) : null);
const noAccessor = (p: PyProperty, o: any, what: string): never => {
  const n = propName(p), t = `'${typeOf(o).$qualname ?? typeName(o)}'`;
  return raise(T.AttributeError, n !== null && n !== undefined ? `property ${repr(n)} of ${t} object has no ${what}` : `property of ${t} object has no ${what}`);
};
method(property, "__get__", (p: PyProperty, o: any, _t: any = null) => {
  if (o === null) return p;
  if (p.fget === null) noAccessor(p, o, "getter");
  return callObj(p.fget, [o]);
});
method(property, "__set__", (p: PyProperty, o: any, v: any) => {
  if (p.fset === null) noAccessor(p, o, "setter");
  callObj(p.fset, [o, v]);
  return null;
});
method(property, "__delete__", (p: PyProperty, o: any) => {
  if (p.fdel === null) noAccessor(p, o, "deleter");
  callObj(p.fdel, [o]);
  return null;
});
method(property, "__set_name__", (p: PyProperty, _owner: any, name: any) => {
  p.name = name;
  return null;
});
getset(property, "__name__", (p: PyProperty) => propName(p) ?? raise(T.AttributeError, "'property' object has no attribute '__name__'"), (p: PyProperty, v: any) => void (p.name = v));
// getter/setter/deleter(None) keep the existing function, as CPython does.
const propCopy = (p: PyProperty, fget: any, fset: any, fdel: any) => {
  const q = new PyProperty(fget, fset, fdel, p.doc);
  q.name = p.name;
  return q;
};
method(property, "getter", (p: PyProperty, f: any) => propCopy(p, f ?? p.fget, p.fset, p.fdel));
method(property, "setter", (p: PyProperty, f: any) => propCopy(p, p.fget, f ?? p.fset, p.fdel));
method(property, "deleter", (p: PyProperty, f: any) => propCopy(p, p.fget, p.fset, f ?? p.fdel));
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
// (callable since CPython 3.10: a staticmethod used directly, as a __get__)
const staticCall = method(staticmethod, "__call__", (s: PyStaticMethod, ...a: any[]) => callObj(s.f, a));
staticCall.$kw = (pos: any[], names: string[], values: any[]) => callKw(pos[0].f, pos.slice(1), names, values);
getset(staticmethod, "__func__", (s) => s.f);
const classmethod = builtinType("classmethod", [object], (f: any) => new PyClassMethod(f));
bindClass(PyClassMethod, classmethod);
{
  const h = pyfn((_c: any, ..._a: any[]) => NotImplemented, "__subclasshook__");
  h.$default = true;
  object.$dict.set("__subclasshook__", new PyClassMethod(h));
  // object.__init_subclass__ is a class method taking nothing, so a class's
  // own __init_subclass__ can end with super().__init_subclass__(**kw)
  const named = (c: any) => `${c?.$qualname ?? c?.$name ?? "object"}.__init_subclass__()`;
  const isub = pyfn((cls: any, ...a: any[]) => {
    if (a.length) raise(T.TypeError, `${named(cls)} takes no arguments (${a.length} given)`);
    return null;
  }, "__init_subclass__");
  isub.$kw = (pos: any[], names: string[], _values: any[]) => {
    if (names.length) raise(T.TypeError, `${named(pos[0])} takes no keyword arguments`);
    return isub(...pos);
  };
  object.$dict.set("__init_subclass__", new PyClassMethod(isub));
}
method(classmethod, "__get__", (s: PyClassMethod, o: any, t: any) => bindMethod(s.f, t === null || t === undefined ? typeOf(o) : t));
getset(classmethod, "__func__", (s) => s.f);

export class PySuper {
  constructor(public cls: PyType, public obj: any) {}
}
// CPython's supercheck: obj must be an instance or a subtype of cls.
function superChecked(cls: any, obj: any): PySuper {
  if (obj !== undefined && !(isType(obj) && obj.$mro.includes(cls)) && !isinstance(obj, cls)) {
    raise(T.TypeError, `super(type, obj): obj (${isType(obj) ? "type" : "instance of"} ${isType(obj) ? obj.$name : typeName(obj)}) is not an instance or subtype of type (${cls.$name}).`);
  }
  return new PySuper(cls, obj);
}
const superType = builtinType("super", [object], (...a: any[]) => {
  if (a.length > 2) raise(T.TypeError, `super() expected at most 2 arguments, got ${a.length}`);
  const [cls, obj] = a;
  // A direct super() call compiles to superOf; this is super called some
  // other way (s = super; s()), whose method CPython finds from its frame.
  if (cls === undefined) raise(T.NotImplementedError, "super() without arguments works in Sagebrush only when called directly as super()");
  if (!isType(cls)) raise(T.TypeError, `super() argument 1 must be a type, not ${typeName(cls)}`);
  return superChecked(cls, obj);
});
bindClass(PySuper, superType);
// (CPython shows the type the lookup starts from: obj, or obj's type)
method(superType, "__repr__", (s: PySuper) => `<super: <class '${s.cls.$name}'>, ${s.obj === undefined ? "NULL" : `<${isType(s.obj) && s.obj.$mro.includes(s.cls) ? s.obj.$name : typeName(s.obj)} object>`}>`);
method(superType, "__getattribute__", (s: PySuper, name: string) => {
  const start = isType(s.obj) && s.obj.$mro.includes(s.cls) ? s.obj : typeOf(s.obj);
  const mro = start.$mro;
  for (let i = mro.indexOf(s.cls) + 1; i < mro.length; i++) {
    const d = mro[i].$dict.get(name);
    if (d === undefined) continue;
    if (typeof d === "function") return d.$pyfn === true && !(isType(s.obj) && start === s.obj) ? bindMethod(d, s.obj) : unboundFunction(d);
    const g = d !== null && typeof d === "object" ? lookupType(typeOf(d), "__get__") : undefined;
    if (g !== undefined) return g(d, isType(s.obj) && start === s.obj ? null : s.obj, start);
    return d;
  }
  if (name === "__class__") return superType;
  raise(T.AttributeError, `'super' object has no attribute '${name}'`);
});
superType.$customGet = true;

// A cell, as CPython's: the class cell of a class whose methods use
// __class__ or super() (the class body passes it to type.__new__ as
// __classcell__), and types.CellType.
// (src/runtime/index.ts: a __classdictcell__'s dict made the class's own)
export const classDictHooks: { bind: ((c: PyCell, cls: PyType) => void) | null; view: ((ns: Map<string, any>) => PyDict) | null } = { bind: null, view: null };
export class PyCell {
  constructor(public v: any = undefined) {}
}
const cellType = builtinType("cell", [object], (...a: any[]) => {
  if (a.length > 1) raise(T.TypeError, `cell expected at most 1 argument, got ${a.length}`);
  return new PyCell(a[0]);
});
bindClass(PyCell, cellType);
getset(cellType, "cell_contents", (c: PyCell) => (c.v === undefined ? raise(T.ValueError, "Cell is empty") : c.v), (c: PyCell, v: any) => void (c.v = v), (c: PyCell) => void (c.v = undefined));
export const newCell = (v?: any) => new PyCell(v);
// A function's free __class__, from its class's cell
export function classCellGet(c: PyCell): any {
  if (c.v === undefined) raise(T.NameError, "cannot access free variable '__class__' where it is not associated with a value in enclosing scope");
  return c.v;
}
// Zero-argument super() compiles to superOf(cell, firstArg): the cell
// holding the function's __class__ (null when it has none) and its first
// argument (undefined when deleted), as CPython's super_init_without_args.
// A function without a positional argument compiles to superNoArgs()
// instead, and super().x to superAttr(__class__, firstArg) (both loaded).
export function superOf(cell: PyCell | null, obj: any): PySuper {
  if (obj === undefined) raise(T.RuntimeError, "super(): arg[0] deleted");
  if (cell === null) raise(T.RuntimeError, "super(): __class__ cell not found");
  if (cell.v === undefined) raise(T.RuntimeError, "super(): empty __class__ cell");
  if (!isType(cell.v)) raise(T.RuntimeError, `super(): __class__ is not a type (${typeName(cell.v)})`);
  return superChecked(cell.v, obj);
}
export function superAttr(cls: any, obj: any): PySuper {
  if (!isType(cls)) raise(T.RuntimeError, `super(): __class__ is not a type (${typeName(cls)})`);
  return superChecked(cls, obj);
}
export function superNoArgs(): never {
  raise(T.RuntimeError, "super(): no arguments");
}

// ------------------------------------------------------------------ simple types

const noneType = builtinType("NoneType", [object], () => null);
// (None's own methods, as CPython's: reached through None.__repr__() and
// type(None).__repr__(None) as well as repr(None))
method(noneType, "__repr__", (_n: any) => "None");
method(noneType, "__bool__", (_n: any) => false);
method(noneType, "__hash__", (n: any) => O.hashAny(n));
noneType.$dict.set("__doc__", "The type of the None singleton.");
allocator(noneType, (_cls: any, ...args: any[]) => {
  if (args.length) raise(T.TypeError, "NoneType takes no arguments");
  return null;
});
builtinType("NotImplementedType", [object], () => NotImplemented);
builtinType("ellipsis", [object], () => Ellipsis);

const fnType = builtinType("function", [object], () => raise(T.TypeError, "cannot create 'function' instances"));
for (const a of ["__name__", "__qualname__", "__module__", "__doc__"]) getset(fnType, a, (f) => f[a] ?? null, (f, v) => void (f[a] = v));
getset(fnType, "__globals__", (f) => {
  if (f.$globals === undefined) raise(T.AttributeError, "'function' object has no attribute '__globals__'");
  const g = f.$globals[NS_GLOBALS] ?? f.$globals;
  return g[NS_DICT] ?? globalsDict(g);
});
// (the builtins' namespace, as CPython 3.10's functions have it: page-order
// scoping's initialization line reads it, src/rename.ts initLine)
getset(fnType, "__builtins__", () => getattr(hooks.importModule("builtins"), "__dict__"));
// A code object describing a compiled function's signature (no bytecode).
export class FnCode {
  constructor(public f: any) {}
}
const fnCodeType = builtinTypeFor("code", FnCode, "builtins", () => raise(T.TypeError, "cannot create 'code' objects"));
{
  const sigOf = (c: FnCode) => c.f.$sig ?? { args: [], posonly: 0, vararg: null, kwonly: [], kwarg: null };
  getset(fnCodeType, "co_name", (c) => c.f.__name__);
  getset(fnCodeType, "co_qualname", (c) => c.f.__qualname__);
  // (the globals', never exec's locals mapping's)
  getset(fnCodeType, "co_filename", (c) => (c.f.$globals === undefined ? undefined : c.f.$globals[NS_GLOBALS] ?? c.f.$globals)?.__file__ ?? "<string>");
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
  // (a live view of the function's attributes, as CPython's: what is set in
  // it is an attribute, functools.update_wrapper's update too, CORR-D1C-2)
  if (f.$dictView === undefined) {
    const d = new PyDict();
    d.$m = f.$attrs ??= new Map();
    // (its Map is the function's attributes too: set and deleted without
    // the dict, so its reversed() looks each key and value up)
    dictMeta(d).shared = true;
    Object.defineProperty(f, "$dictView", { value: d, enumerable: false });
  }
  return f.$dictView;
});
// Annotations as CPython 3.14's (PEP 649/749): a function's __annotate__,
// called with VALUE (1) the first time __annotations__ is read, its dict
// kept; setting __annotations__ drops __annotate__, setting a callable
// __annotate__ drops the kept dict
// (callable(), the runtime's own test: no rebinding of the builtin reaches it)
const isCallable = (v: any): boolean => typeof v === "function" || lookupType(typeOf(v), "__call__") !== undefined;
function checkAnnotate(v: any): void {
  if (v === undefined) raise(T.TypeError, "__annotate__ cannot be deleted");
  if (v !== null && !isCallable(v)) raise(T.TypeError, "__annotate__ must be callable or None");
}
function callAnnotate(a: any): PyDict {
  const d = callObj(a, [1]);
  if (!(d instanceof PyDict)) raise(T.TypeError, `__annotate__ returned non-dict of type '${typeName(d)}'`);
  return d;
}
getset(fnType, "__annotate__", (f) => f.$annotate ?? null, (f, v) => {
  checkAnnotate(v);
  f.$annotate = v;
  if (v !== null) f.$annotations = undefined;
}, () => raise(T.TypeError, "__annotate__ cannot be deleted"));
getset(fnType, "__annotations__", (f) => {
  if (f.$annotations !== undefined && f.$annotations !== null) return f.$annotations;
  const a = f.$annotate ?? null;
  return (f.$annotations = a !== null ? callAnnotate(a) : new PyDict());
}, (f, v) => {
  if (v !== null && !(v instanceof PyDict)) raise(T.TypeError, "__annotations__ must be set to a dict object");
  f.$annotations = v;
  f.$annotate = null;
}, (f) => {
  f.$annotations = undefined;
  f.$annotate = null;
});
getset(fnType, "__wrapped__", (f) => (f.$attrs?.get("__wrapped__") ?? raise(T.AttributeError, "'function' object has no attribute '__wrapped__'")), (f, v) => (f.$attrs ??= new Map()).set("__wrapped__", v));
method(fnType, "__get__", (f: any, o: any, _t: any) => (o === null ? f : bindMethod(f.$owner !== undefined ? selfChecked(f) : f, o)));
// (f.__call__(...), and the same for builtins, bound methods and types:
// their arguments as an array, keywords and BIG_CALL included, HARD-A78-1)
const callSlot = (m: any) => {
  m.$kw = (pos: any[], names: string[], values: any[]) => callKw(pos[0], pos.slice(1), names, values);
  return m;
};
callSlot(method(fnType, "__call__", (f: any, ...a: any[]) => f(...a)));

const bfType = builtinType("builtin_function_or_method", [object], () => raise(T.TypeError, "cannot create 'builtin_function_or_method' instances"));
getset(bfType, "__name__", (f) => f.__name__ ?? f.name);
getset(bfType, "__qualname__", (f) => f.__qualname__ ?? f.name);
getset(bfType, "__module__", (f) => f.__module__ ?? null); // (a module's functions: its name, as CPython's)
// (its docstring where it has one; None, not an AttributeError, where not:
// functools.cached_property and wraps read it)
getset(bfType, "__doc__", (f) => f.__doc__ ?? null);
callSlot(method(bfType, "__call__", (f: any, ...a: any[]) => f(...a)));

// (pickled as CPython's: by name, getattr(obj, name) when bound)
const builtinGetattr = () => getattr(hooks.importModule("builtins"), "getattr");
method(bfType, "__reduce__", (f: any) => (f.$self !== undefined ? tuple([builtinGetattr(), tuple([f.$self, f.__name__ ?? f.name])]) : f.__qualname__ ?? f.__name__ ?? f.name));
// A builtin type's method, unbound (typeOf): method_descriptor, or a slot's
// wrapper_descriptor, as CPython's; pickled as getattr(type, name)
for (const [tname, kind] of [["method_descriptor", "method"], ["wrapper_descriptor", "slot wrapper"]] as const) {
  const dt = builtinType(tname, [object], () => raise(T.TypeError, `cannot create '${tname}' instances`));
  (T as any)[tname] = dt;
  getset(dt, "__name__", (f) => f.__name__ ?? f.name);
  getset(dt, "__qualname__", (f) => f.__qualname__ ?? f.name);
  getset(dt, "__doc__", (f) => f.__doc__ ?? null);
  getset(dt, "__objclass__", (f) => f.$owner);
  callSlot(method(dt, "__call__", (f: any, ...a: any[]) => f(...a)));
  method(dt, "__get__", (f: any, o: any = undefined, t: any = null) => {
    if (o === undefined) raise(T.TypeError, "__get__ expected at least 1 argument, got 0");
    if (o === null) return t === null ? raise(T.TypeError, "__get__(None, None) is invalid") : f;
    return bindMethod(selfChecked(f), o);
  });
  method(dt, "__repr__", (f: any) => `<${kind} '${f.__name__ ?? f.name}' of '${f.$owner?.$name}' objects>`);
  method(dt, "__reduce__", (f: any) => tuple([builtinGetattr(), tuple([f.$owner, f.__name__ ?? f.name])]));
}
const methodType = builtinType("method", [object], (f: any, self: any) => bindMethod(f, self));
method(methodType, "__reduce__", (m: any) => tuple([builtinGetattr(), tuple([m.$self, m.$func.__name__])]));
getset(methodType, "__self__", (m) => m.$self);
getset(methodType, "__func__", (m) => m.$func);
getset(methodType, "__name__", (m) => m.$func.__name__);
getset(methodType, "__qualname__", (m) => m.$func.__qualname__);
getset(methodType, "__doc__", (m) => m.$func.__doc__ ?? null);
callSlot(method(methodType, "__call__", (m: any, ...a: any[]) => m(...a)));
// Other attributes of a bound method are those of its function.
method(methodType, "__getattr__", (m: any, name: string) => getattr(m.$func, name));
method(methodType, "__eq__", (m: any, o: any) => (typeof o === "function" && o.$self !== undefined ? m.$func === o.$func && m.$self === o.$self : NotImplemented));
method(methodType, "__hash__", (m: any) => (O.id(m.$self) / 32) ^ O.id(m.$func));

const moduleType = objectType("module", [object], new Map(), "builtins");
T.module = moduleType;
method(moduleType, "__repr__", (m: any) => `<module '${m.__name__}'>`);
// (as CPython's module.__dir__: the module's own __dir__() if it defines
// one, else the names in its __dict__; not the attributes of its type)
method(moduleType, "__dir__", (m: any) => {
  if (Object.prototype.hasOwnProperty.call(m, "__dir__")) return callObj(m.__dir__, []);
  return O.toArray(instanceDict(m));
});
method(moduleType, "__init__", (m: any, name: string, doc: any = null) => {
  m.__name__ = name;
  m.__doc__ = doc;
  // (as CPython's module(): these too, None until an import sets them)
  m.__package__ = null;
  m.__loader__ = null;
  m.__spec__ = null;
  return null;
});
// A module's annotations (PEP 649/749): its __annotations__ if set, else
// what its __annotate__ gives (the module body's), kept in its namespace
// (none yet: None, kept in its namespace, as CPython's module_get_annotate;
// setting __annotations__ or deleting it makes it None)
getset(moduleType, "__annotate__", (m) => (Object.prototype.hasOwnProperty.call(m, "__annotate__") ? m.__annotate__ : (m.__annotate__ = null)), (m, v) => {
  checkAnnotate(v);
  m.__annotate__ = v;
  if (v !== null) delete m.__annotations__;
}, () => raise(T.TypeError, "cannot delete __annotate__ attribute"));
getset(moduleType, "__annotations__", (m) => {
  if (Object.prototype.hasOwnProperty.call(m, "__annotations__")) return m.__annotations__;
  const a = Object.prototype.hasOwnProperty.call(m, "__annotate__") ? m.__annotate__ : null;
  return (m.__annotations__ = a !== null ? callAnnotate(a) : new PyDict());
}, (m, v) => {
  m.__annotations__ = v;
  m.__annotate__ = null;
}, (m) => {
  if (!Object.prototype.hasOwnProperty.call(m, "__annotations__")) raise(T.AttributeError, "__annotations__");
  delete m.__annotations__;
  m.__annotate__ = null;
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

// A class body's namespace from its metaclass's __prepare__ (made before
// the body, as CPython's __build_class__): the body's names are read,
// written and deleted through its own methods, an exact dict's storage
// otherwise, and the metaclass receives it itself
export class PreparedNs {
  private exact: boolean;
  constructor(public m: any, public meta: any, public kw: Map<string, any>) {
    this.exact = typeOf(m) === T.dict;
  }
  get(k: string): any {
    if (this.exact) return dictGet(this.m, k);
    try {
      return O.getitem(this.m, k);
    } catch (e) {
      // (a KeyError: unbound here, the globals next)
      if (isinstance(e, T.KeyError)) return undefined;
      throw e;
    }
  }
  has(k: string): boolean {
    return this.get(k) !== undefined;
  }
  set(k: string, v: any): this {
    if (this.exact) dictSet(this.m, k, v);
    else O.setitem(this.m, k, v);
    return this;
  }
  // (false, the name's NameError, for any failure, as DELETE_NAME's)
  delete(k: string): boolean {
    try {
      if (this.exact) return dictDelete(this.m, k);
      O.delitem(this.m, k);
      return true;
    } catch {
      return false;
    }
  }
}
// The metaclass of `class C(bases, metaclass=..., **kw)` and the other
// keywords: the explicit one, else type; a type is replaced by the most
// derived of it and the bases' types (a conflict: TypeError)
export function classMetaclass(bases: any[], kwNames: string[], kwValues: any[]): { meta: any; kw: Map<string, any> } {
  // (an explicit metaclass=None too: called, a TypeError)
  let meta: any = undefined;
  const kw = new Map<string, any>();
  kwNames.forEach((k, i) => (k === "metaclass" ? (meta = kwValues[i]) : kw.set(k, kwValues[i])));
  if (meta !== undefined && !isType(meta)) return { meta, kw };
  let winner: PyType = meta ?? T.type;
  for (const b of bases) {
    const mb = typeOf(b);
    if (winner.$mro.includes(mb)) continue;
    if (mb.$mro.includes(winner)) winner = mb;
    else raise(T.TypeError, "metaclass conflict: the metaclass of a derived class must be a (non-strict) subclass of the metaclasses of all its bases");
  }
  return { meta: winner, kw };
}
// A class statement's bases as CPython's update_bases (PEP 560): each that
// isn't a class and has __mro_entries__ replaced by the tuple that gives for
// the original bases; the same array when none was replaced
export function updateBases(bases: any[]): any[] {
  let out: any[] | null = null;
  // (the original bases, one tuple for every __mro_entries__ call)
  let orig: any = undefined;
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    let entries: any = undefined;
    if (!isType(b)) {
      try {
        entries = getattr(b, "__mro_entries__");
      } catch (e: any) {
        if (!isinstance(toPyExc(e), T.AttributeError)) throw e;
      }
    }
    if (entries === undefined) {
      out?.push(b);
      continue;
    }
    const r = callObj(entries, [(orig ??= tuple(bases.slice()))]);
    if (!isinstance(r, T.tuple)) raise(T.TypeError, "__mro_entries__ must return a tuple");
    out ??= bases.slice(0, i);
    out.push(...r);
  }
  // (the original bases tuple kept on the new array, for __orig_bases__)
  if (out !== null) (out as any).$orig = orig;
  return out ?? bases;
}
// The namespace a class body runs in, before it runs: its metaclass's
// __prepare__'s mapping, or for type's own a Map
// type's own __prepare__'s namespace, a Map, with the metaclass and the
// keywords found before the body: never looked up again after it
// (CORR-6C9-5)
export class ClassNs extends Map<string, any> {
  constructor(public meta: any, public kw: Map<string, any>) {
    super();
  }
}
const NO_PREPARE = {};
export function classNamespace(name: string, bases: any[], kwNames: string[], kwValues: any[]): ClassNs | PreparedNs {
  const { meta, kw } = classMetaclass(bases, kwNames, kwValues);
  // (only a missing one is none: __prepare__ = None is called, a TypeError)
  const prep = getattr(meta, "__prepare__", NO_PREPARE);
  if (prep === NO_PREPARE || prep === typePrepare) return new ClassNs(meta, kw);
  const m = callKw(prep, [name, tuple(bases)], [...kw.keys()], [...kw.values()]);
  if (!(m instanceof PyDict) && lookupDunder(m, "__getitem__") === undefined) raise(T.TypeError, `${isType(meta) ? getattr(meta, "__name__") : "<metaclass>"}.__prepare__() must return a mapping, not ${typeName(m)}`);
  return new PreparedNs(m, meta, kw);
}
// `class C(bases, **kw): body` once the body has filled `ns`.
export function makeClass(name: string, bases: any[], ns: Map<string, any> | PreparedNs, module: string, qualname: string, kwNames: string[], kwValues: any[]): PyType {
  if (ns instanceof PreparedNs) return callKw(ns.meta, [name, tuple(bases), ns.m], [...ns.kw.keys()], [...ns.kw.values()]);
  if (ns instanceof ClassNs) {
    const { meta, kw } = ns;
    if (!isType(meta)) return callKw(meta, [name, tuple(bases), nsDict(ns, module, qualname)], [...kw.keys()], [...kw.values()]);
    for (const b of bases) if (!isType(b)) raise(T.TypeError, `bases must be types, not ${typeName(b)}`);
    if (meta !== T.type) return callKw(meta, [name, tuple(bases), nsDict(ns, module, qualname)], [...kw.keys()], [...kw.values()]);
    return buildClass(name, bases, ns, module, qualname, kw, T.type);
  }
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

// The namespace a metaclass is given: the class body's own, a dict over
// it (the one its __classdict__ is: classDictHooks.view), not a copy, as
// CPython's
function nsDict(ns: Map<string, any>, module: string, qualname: string): PyDict {
  if (!ns.has("__module__")) ns.set("__module__", module);
  if (!ns.has("__qualname__")) ns.set("__qualname__", qualname);
  return classDictHooks.view!(ns);
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
  // __classcell__: the class body's cell for its methods' __class__, set
  // here, before __set_name__ and __init_subclass__, and not kept in the dict
  const cell = ns.get("__classcell__");
  if (cell !== undefined) {
    if (!(cell instanceof PyCell)) raise(T.TypeError, `__classcell__ must be a nonlocal cell, not ${repr(typeOf(cell))}`);
    ns.delete("__classcell__");
  }
  // __classdictcell__: the cell of the body's __classdict__, its
  // annotation scopes' view of the namespace, then the class's own dict,
  // set here, before __set_name__ and __init_subclass__, as CPython's
  const dcell = ns.get("__classdictcell__");
  if (dcell !== undefined) {
    if (!(dcell instanceof PyCell)) raise(T.TypeError, `__classdictcell__ must be a nonlocal cell, not ${repr(typeOf(dcell))}`);
    ns.delete("__classdictcell__");
  }
  // (the body's __annotate__ is the class's __annotate_func__, as CPython's)
  if (ns.has("__annotate__")) {
    ns.set("__annotate_func__", ns.get("__annotate__"));
    ns.delete("__annotate__");
  }
  // __slots__, as CPython's type_new: its names, mangled, become member
  // descriptors; the instances have no __dict__ unless a slot or a base
  // gives them one
  let slotNames: string[] | null = null, slotDict = false;
  if (ns.has("__slots__")) {
    const sv = ns.get("__slots__");
    const items = typeof unbox(sv) === "string" ? [sv] : O.toArray(sv);
    const baseDict = bases.some((b: any) => b.$heap === true && b.$noDict !== true);
    slotNames = [];
    for (const it of items) {
      const n = unbox(it);
      if (typeof n !== "string") raise(T.TypeError, `__slots__ items must be strings, not '${typeName(it)}'`);
      if (!/^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(n)) raise(T.TypeError, "__slots__ must be identifiers");
      if (n === "__dict__") {
        if (baseDict || slotDict) raise(T.TypeError, "__dict__ slot disallowed: we already got one");
        slotDict = true;
        continue;
      }
      if (n === "__weakref__") continue;
      // (a private name mangled, as CPython's _Py_Mangle)
      const owner = name.replace(/^_+/, "");
      slotNames.push(n.startsWith("__") && !n.endsWith("__") && owner !== "" ? `_${owner}${n}` : n);
    }
    for (const n of slotNames) if (ns.has(n)) raise(T.ValueError, `'${n}' in __slots__ conflicts with class variable`);
  }
  const cls = objectType(name, bases.length ? bases : [object], ns, module);
  (cls as any).$heap = true;
  if (slotNames !== null) {
    for (const n of slotNames) ns.set(n, new PyMember(cls, n));
    if (!slotDict && bases.every((b: any) => b.$heap !== true || b.$noDict === true)) (cls as any).$noDict = true;
  }
  if (cell !== undefined) cell.v = cls;
  if (dcell !== undefined) classDictHooks.bind!(dcell, cls);
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
const newException = (cls: PyType, ...args: any[]) => {
  const o = new cls.$ctor!();
  o.args = tuple(args);
  // Exceptions raised by the runtime are thrown right after creation, so
  // capture the stack now; `raise` re-captures at the raise site.
  captureTraceback(o);
  return o;
};
// (as CPython's BaseException_new: keywords are ignored there, for a
// subclass's __init__ that takes them; args are the positional ones)
allocator(BaseException, newException, (pos: any[]) => newException(pos[0], ...pos.slice(1)));
const baseInit = method(BaseException, "__init__", (self: any, ...args: any[]) => {
  self.args = tuple(args);
  return null;
});
// (...and BaseException_init refuses them, naming the type)
baseInit.$kw = (pos: any[], names: string[], _values: any[]) => {
  if (names.length) raise(T.TypeError, `${typeName(pos[0])}() takes no keyword arguments`);
  return baseInit(...pos);
};
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
// (as CPython's ImportError_init: keyword-only name, path and name_from, and
// msg, the message when there is exactly one argument; str() is msg when it
// is a str. The runtime's own import errors set name the same way)
const ImportError = exc("ImportError", Exception, (c) => {
  for (const k of ["msg", "name", "path", "name_from"]) c.$dict.set(k, null);
  const init = method(c, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.msg = args.length === 1 ? args[0] : null;
    self.name = self.path = self.name_from = null;
    return null;
  });
  init.$kw = (pos: any[], names: string[], values: any[]) => {
    const [self, ...args] = pos;
    // (as ImportError_init: args first, as BaseException_init sets them;
    // then the keywords, a bad one refused with msg, name, path and
    // name_from as they were; then those set)
    self.args = tuple(args);
    for (const k of names) if (k !== "name" && k !== "path" && k !== "name_from") raise(T.TypeError, `ImportError() got an unexpected keyword argument '${k}'`);
    init(self, ...args);
    names.forEach((k, i) => (self[k] = values[i]));
    return null;
  };
  method(c, "__str__", (self: any) => (typeof self.msg === "string" ? self.msg : BaseException.$dict.get("__str__")(self)));
});
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
exc("BlockingIOError", OSError);
exc("ChildProcessError", OSError);
const ConnectionError = exc("ConnectionError", OSError);
exc("BrokenPipeError", ConnectionError);
exc("ConnectionAbortedError", ConnectionError);
exc("ConnectionRefusedError", ConnectionError);
exc("ConnectionResetError", ConnectionError);
exc("InterruptedError", OSError);
exc("ProcessLookupError", OSError);
// OSError(errno, strerror, ...) is the subclass its errno names, as
// CPython's OSError.__new__ (exceptions.c errnomap, Linux's numbers): only
// OSError itself, with 2 to 5 arguments (as oserror_parse_args), an int errno
const ERRNO_CLASS = new Map<number, PyType>(
  ([[11, "BlockingIOError"], [114, "BlockingIOError"], [115, "BlockingIOError"], [32, "BrokenPipeError"], [108, "BrokenPipeError"],
    [10, "ChildProcessError"], [103, "ConnectionAbortedError"], [111, "ConnectionRefusedError"], [104, "ConnectionResetError"],
    [17, "FileExistsError"], [2, "FileNotFoundError"], [21, "IsADirectoryError"], [20, "NotADirectoryError"], [4, "InterruptedError"],
    [13, "PermissionError"], [1, "PermissionError"], [3, "ProcessLookupError"], [110, "TimeoutError"]] as const).map(([n, c]) => [n, T[c]]),
);
const errnoClass = (cls: any, args: any[]): any => {
  if (cls !== OSError || args.length < 2 || args.length > 5) return cls;
  const v = unbox(args[0]);
  const n = typeof v === "boolean" ? +v : typeof v === "bigint" ? (v >= 0n && v < 1024n ? Number(v) : -1) : typeof v === "number" && Number.isInteger(v) ? v : -1;
  return ERRNO_CLASS.get(n) ?? cls;
};
allocator(OSError, (cls: any, ...args: any[]) => newException(errnoClass(cls, args), ...args), (pos: any[]) => newException(errnoClass(pos[0], pos.slice(1)), ...pos.slice(1)));
const ReferenceError = exc("ReferenceError", Exception);
void ReferenceError;
const RuntimeError = exc("RuntimeError", Exception);
exc("NotImplementedError", RuntimeError);
exc("RecursionError", RuntimeError);
exc("PythonFinalizationError", RuntimeError);
// (as CPython's: SyntaxError(msg, (filename, lineno, offset, text[,
// end_lineno, end_offset])) sets those attributes, and str() adds the
// file's base name and the line when they are known)
const SyntaxError = exc("SyntaxError", Exception, (c) => {
  method(c, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.msg = args.length >= 1 ? args[0] : null;
    for (const k of ["filename", "lineno", "offset", "text", "end_lineno", "end_offset", "print_file_and_line"]) self[k] = null;
    if (args.length === 2) {
      const info = O.toArray(args[1]);
      if (info.length !== 4 && info.length !== 6) raise(T.IndexError, "tuple index out of range");
      [self.filename, self.lineno, self.offset, self.text] = info;
      if (info.length === 6) [self.end_lineno, self.end_offset] = info.slice(4);
    }
    return null;
  });
  method(c, "__str__", (self: any) => {
    const msg = str(self.msg ?? null);
    const file = typeof self.filename === "string" ? self.filename.slice(self.filename.lastIndexOf("/") + 1) : null;
    const line = O.isPyInt(self.lineno) && typeof self.lineno !== "boolean" ? str(self.lineno) : null;
    if (file !== null && line !== null) return `${msg} (${file}, line ${line})`;
    if (file !== null) return `${msg} (${file})`;
    if (line !== null) return `${msg} (line ${line})`;
    return msg;
  });
});
exc("IndentationError", SyntaxError);
exc("TabError", (T as any).IndentationError);
exc("SystemError", Exception);
exc("TypeError", Exception);
const ValueError = exc("ValueError", Exception);
const UnicodeError = exc("UnicodeError", ValueError);
// UnicodeEncodeError(encoding, object, start, end, reason), and Decode's
// and Translate's, as CPython's (Objects/exceptions.c): the arguments
// parsed as "UOnnU" (Decode's object any bytes-like, kept as bytes;
// Translate's without the encoding), each kept as given (a str subclass
// too), start and end C ssize_t values; the start and end attributes take
// only an int (their setters, unlike the constructor, no __index__); and
// __str__ checking the object's type, naming the character (or byte) when
// the range is one long and inside it, else "characters in position
// start-end-1" with C's ssize_t arithmetic, positions exact
{
  const SMAX = 2n ** 63n - 1n, SMIN = -(2n ** 63n);
  const ssize = (v: any): number | bigint => {
    if (typeof v === "bigint" && (v > SMAX || v < SMIN)) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
    return v;
  };
  const kinds: [string, boolean, boolean][] = [["UnicodeEncodeError", true, false], ["UnicodeDecodeError", true, true], ["UnicodeTranslateError", false, false]];
  for (const [name, hasEnc, bytesObj] of kinds) {
    exc(name, UnicodeError, (c) => {
      const n = hasEnc ? 5 : 4;
      const strArg = (i: number, v: any): any => (typeof unbox(v) === "string" ? v : raise(T.TypeError, `argument ${i} must be str, not ${typeName(v)}`));
      method(c, "__init__", (self: any, ...args: any[]) => {
        self.args = tuple(args);
        if (args.length !== n) raise(T.TypeError, `function takes exactly ${n} arguments (${args.length} given)`);
        let i = 0;
        if (hasEnc) self.encoding = strArg(1, args[i++]);
        const o = args[i++];
        if (bytesObj) {
          const b = O.bufferOf(o);
          if (b === undefined) raise(T.TypeError, `a bytes-like object is required, not '${typeName(o)}'`);
          self.object = typeOf(o) === T.bytes ? o : new PyBytes(b.slice());
        } else self.object = strArg(hasEnc ? 2 : 1, o);
        self.$start = ssize(O.index(args[i++]));
        self.$end = ssize(O.index(args[i++]));
        self.reason = strArg(n, args[i++]);
        return null;
      });
      for (const k of ["start", "end"] as const) {
        getset(c, k, (self: any) => self[`$${k}`] ?? null, (self: any, v: any) => {
          const u = unbox(v);
          if (!O.isPyInt(u)) raise(T.TypeError, "an integer is required");
          self[`$${k}`] = ssize(typeof u === "boolean" ? +u : u);
        });
      }
      method(c, "__str__", (self: any) => {
        if (self.object === undefined) return "";
        const ob = unbox(self.object);
        if (bytesObj ? !(ob instanceof PyBytes && !(ob instanceof PyByteArray)) : typeof ob !== "string") raise(T.TypeError, `UnicodeError 'object' attribute must be a ${bytesObj ? "bytes" : "string"}`);
        const len = BigInt(bytesObj ? ob.n : SP.cpLen(ob));
        const start = BigInt(self.$start), end = BigInt(self.$end);
        const what = name === "UnicodeEncodeError" ? "encode" : name === "UnicodeDecodeError" ? "decode" : "translate";
        const pre = hasEnc ? `'${str(self.encoding)}' codec can't ${what}` : `can't ${what}`;
        if (start >= 0n && start < len && end >= 0n && end <= len && end === start + 1n) {
          const at = Number(start);
          if (bytesObj) return `${pre} byte 0x${ob.a[at].toString(16).padStart(2, "0")} in position ${start}: ${str(self.reason)}`;
          const ch = [...ob][at].codePointAt(0)!;
          const esc = ch <= 0xff ? `\\x${ch.toString(16).padStart(2, "0")}` : ch <= 0xffff ? `\\u${ch.toString(16).padStart(4, "0")}` : `\\U${ch.toString(16).padStart(8, "0")}`;
          return `${pre} character '${esc}' in position ${start}: ${str(self.reason)}`;
        }
        return `${pre} ${bytesObj ? "bytes" : "characters"} in position ${start}-${BigInt.asIntN(64, end - 1n)}: ${str(self.reason)}`;
      });
    });
  }
}
const Warning = exc("Warning", Exception);
for (const w of ["UserWarning", "DeprecationWarning", "PendingDeprecationWarning", "SyntaxWarning", "RuntimeWarning", "FutureWarning", "ImportWarning", "UnicodeWarning", "BytesWarning", "ResourceWarning", "EncodingWarning"]) exc(w, Warning);

// ------------------------------------------------------------------ numbers

const isInt = Number.isInteger;

// A str as int(), float() and complex() read it, CPython's
// _PyUnicode_TransformDecimalAndSpaceToASCII: each non-ASCII Unicode decimal
// digit (Nd) its ASCII digit, each non-ASCII whitespace character
// (str.isspace) a space; at the first other non-ASCII character a "?", where
// the text ends, as CPython's (no literal has a "?"; complex()'s underscore
// check sees what is before it, CORR follow-up of fbb39db5).
// (Then only ASCII whitespace is stripped, as CPython's Py_ISSPACE: not
// \x1c-\x1f, nor U+FEFF.)
const NON_ASCII_SPACE = /[\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
// (Unicode 16's decimal digits, CPython 3.14's: the engine's, but for those
// a later Unicode added, Unicode 17's U+11DE0..U+11DE9)
const ND = /^(?![\u{11DE0}-\u{11DE9}])\p{Nd}$/u;
const ndValues = new Map<number, number>();
// (a digit's value is its place in its block: Unicode's decimal digits come
// in runs of whole sets of ten, 0 to 9)
function ndValue(ch: string): number {
  if (!ND.test(ch)) return -1;
  const c = ch.codePointAt(0)!;
  let v = ndValues.get(c);
  if (v === undefined) {
    let z = c;
    while (ND.test(String.fromCodePoint(z - 1))) z--;
    v = (c - z) % 10;
    ndValues.set(c, v);
  }
  return v;
}
export function asciiNumeral(s: string): string {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  let out = "", n = 0;
  for (const ch of s) {
    if ((++n & 65535) === 0) O.pollInterrupt();
    if (ch.charCodeAt(0) < 128) out += ch;
    else if (NON_ASCII_SPACE.test(ch)) out += " ";
    else {
      const d = ndValue(ch);
      if (d < 0) return out + "?";
      out += String.fromCharCode(48 + d);
    }
  }
  return out;
}
export const stripAscii = (s: string): string => s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

// int() from text (plan-int-digit-oom r4): one pass over the input as it is,
// a str or a bytes-like view, that checks CPython's grammar, counts the
// digits and notes the quotes, with no copy of the text; then the configured
// digit limit, then memory admission (every base); and only then the digits
// the conversion needs, made once.  A copy made before admission was as
// large as the input: int() of a 40,000,000-digit string held it twice and
// could exhaust a small heap before refusing (int-digit-limits, Oct 25).
type IntText = string | Uint8Array;
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);
// the character at i as asciiNumeral maps it: [code, its width in units];
// a non-ASCII Unicode digit is 48 + its value, a non-ASCII space 32, any
// other non-ASCII character 63 ("?": never in a literal); bytes are only
// ASCII
function mappedAt(t: IntText, i: number): [number, number] {
  if (typeof t !== "string") {
    const c = t[i];
    return [c < 128 ? c : 63, 1];
  }
  const c = t.charCodeAt(i);
  if (c < 128) return [c, 1];
  const cp = t.codePointAt(i)!;
  const w = cp > 0xffff ? 2 : 1;
  const ch = t.slice(i, i + w);
  if (NON_ASCII_SPACE.test(ch)) return [32, w];
  const d = ndValue(ch);
  return [d < 0 ? 63 : 48 + d, w];
}
const digitOf = (c: number) => (c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 122 ? c - 87 : c >= 65 && c <= 90 ? c - 55 : -1);
interface IntScan {
  ok: boolean;
  neg: boolean;
  base: number;
  digits: number; // (without the underscores)
  start: number; // the body, in units: after the sign, prefix and an underscore after it
  end: number;
  plain: boolean; // the body is only ASCII digits and letters: a slice of the input is the digits
  single: boolean; // the whole input has a ' / a " (for the error's quotes)
  double: boolean;
}
const POLL = 65536;
function scanInt(t: IntText, base: number): IntScan {
  const n = t.length, given = base;
  const r: IntScan = { ok: false, neg: false, base, digits: 0, start: 0, end: 0, plain: true, single: false, double: false };
  // (Stop tested every POLL characters inspected, counted across all the
  // passes, leading, trailing and body: never by a position, which the
  // trailing pass counts from the other end, daybreak2 PR134-INTR-1)
  let work = 0;
  const poll = () => {
    if (++work >= POLL) {
      work = 0;
      O.pollInterrupt();
    }
  };
  const quote = (c: number) => {
    if (c === 39) r.single = true;
    else if (c === 34) r.double = true;
  };
  // (the rest of an invalid str: only its quotes, for the error, still
  // polled; bytes' error takes its quotes from its first 200 bytes)
  const fail = (i: number): IntScan => {
    if (typeof t !== "string") return r;
    for (; i < n; i++) {
      poll();
      const c = typeof t === "string" ? t.charCodeAt(i) : t[i];
      quote(c);
    }
    return r;
  };
  // the trimmed bounds: ASCII whitespace, and what maps to a space
  let lo = 0, hi = n;
  while (lo < hi) {
    poll();
    const [c, w] = mappedAt(t, lo);
    if (!isSpace(c)) break;
    lo += w;
  }
  while (hi > lo) {
    poll();
    const last = typeof t === "string" && hi - 2 >= lo && t.charCodeAt(hi - 1) >= 0xdc00 && t.charCodeAt(hi - 1) <= 0xdfff && t.charCodeAt(hi - 2) >= 0xd800 && t.charCodeAt(hi - 2) <= 0xdbff ? hi - 2 : hi - 1;
    const [c] = mappedAt(t, last);
    if (!isSpace(c)) break;
    hi = last;
  }
  let i = lo;
  const at = (k: number) => (k < hi ? mappedAt(t, k) : ([-1, 0] as [number, number]));
  let [c, w] = at(i);
  if (c === 43 || c === 45) {
    r.neg = c === 45;
    quote(c);
    i += w;
    [c, w] = at(i);
  }
  // a prefix: 0x 0o 0b in either case, choosing the base (0) or matching it
  let prefixed = false;
  if (c === 48) {
    const [c2, w2] = at(i + w);
    const p = c2 === 120 || c2 === 88 ? 16 : c2 === 111 || c2 === 79 ? 8 : c2 === 98 || c2 === 66 ? 2 : 0;
    if (p !== 0 && (base === 0 || base === p)) {
      r.base = base = p;
      prefixed = true;
      i += w + w2;
      [c, w] = at(i);
      // (an underscore may follow a base prefix, as in 0x_1f: not start a number)
      if (c === 95) {
        i += w;
        [c, w] = at(i);
      }
    }
  }
  if (base === 0) r.base = base = 10;
  const zeroRule = !prefixed && given === 0;
  r.start = i;
  // the body: [0-9a-zA-Z]+(_[0-9a-zA-Z]+)*, each a digit of the base
  let prevUnderscore = true, allZero = true, any = false;
  for (; i < hi; ) {
    poll();
    [c, w] = mappedAt(t, i);
    quote(c);
    if (c === 95) {
      if (prevUnderscore) return fail(i + w);
      prevUnderscore = true;
      r.plain = false;
      i += w;
      continue;
    }
    const d = digitOf(c);
    if (d < 0 || d >= base) return fail(i + w);
    if (w !== 1 || (typeof t === "string" && t.charCodeAt(i) >= 128)) r.plain = false;
    if (d !== 0) allZero = false;
    any = true;
    prevUnderscore = false;
    r.digits++;
    i += w;
  }
  if (!any || prevUnderscore) return fail(hi);
  // (base 0: a leading 0 only in a zero: 0_0 and 00 are 0, 01 and 00_1 invalid)
  if (zeroRule && !allZero && mappedAt(t, r.start)[0] === 48) return fail(hi);
  r.end = hi;
  r.ok = true;
  return r;
}

// The digits of a scanned literal as the conversion takes them: ASCII, no
// underscores (either case: BigInt and parseInt read both).  A slice of the
// input where it is that already (V8 shares a str slice's characters);
// otherwise made in pieces, after admission, which counts them.
function digitsOf(t: IntText, r: IntScan): string {
  if (r.plain) {
    if (typeof t === "string") return t.slice(r.start, r.end);
    return Buffer.from(t.buffer, t.byteOffset + r.start, r.end - r.start).toString("latin1");
  }
  const pieces: string[] = [];
  let piece = "";
  for (let i = r.start; i < r.end; ) {
    const [c, w] = mappedAt(t, i);
    if (c !== 95) piece += String.fromCharCode(c);
    i += w;
    if (piece.length >= POLL) {
      pieces.push(piece);
      piece = "";
      O.pollInterrupt();
    }
  }
  pieces.push(piece);
  return pieces.join("");
}

// The int of a valid scanned literal: the configured digit limit (CPython's,
// every base but the powers of 2), then memory admission (every base: the
// digits, the value and its powers of the base, before any is made), then
// the digits and the value.
function intOfScan(t: IntText, r: IntScan): number | bigint {
  const base = r.base, pow2 = (base & (base - 1)) === 0;
  const m = intDigits.max;
  if (m > 0 && !pow2 && r.digits > m)
    raise(T.ValueError, `Exceeds the limit (${m} digits) for integer string conversion: value has ${r.digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
  admitDigits(r.digits, (r.digits * Math.log2(base)) / 8);
  const d = digitsOf(t, r);
  // (bases 2, 8 and 16 natively, in linear time; the others, 4 and 32 too,
  // by halves, with Stop tested between the pieces)
  const v = base === 16 || base === 8 || base === 2 ? BigInt((base === 16 ? "0x" : base === 8 ? "0o" : "0b") + d) : parseDigits(d, base);
  return O.normBig(r.neg ? -v : v);
}

// int(x, base) of a str or a bytes-like view; an invalid literal's error
// shows it cut at 200 code points, as CPython's %.200R: a str with the
// quotes the scan saw in the whole of it; bytes-like in b'' form, from its
// first 200 bytes, as CPython's
function intFromText(x: IntText, base: number): number | bigint {
  const r = scanInt(x, base);
  if (r.ok) return intOfScan(x, r);
  const op = typeof x === "string" ? strReprPrefix(x, 200, r.single, r.double) : bytesReprPrefix(x, 200);
  return raise(T.ValueError, `invalid literal for int() with base ${base}: ${op}`);
}

export function intCall(x: any = 0, base: any = undefined): any {
  if (base !== undefined) {
    if (typeof x !== "string" && !(x instanceof PyBytes)) raise(T.TypeError, "int() can't convert non-string with explicit base");
    const b = Number(base);
    if (b !== 0 && (b < 2 || b > 36)) raise(T.ValueError, "int() base must be >= 2 and <= 36, or 0");
    return intFromText(typeof x === "string" ? x : x.a.subarray(0, x.n), b);
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
  // (a view of its bytes, not a copy; the error shows them as bytes, as
  // CPython's)
  const view = O.bufferViewOf(x);
  if (view !== undefined) return intFromText(view, 10);
  for (const name of ["__int__", "__index__", "__trunc__"]) {
    const f = lookupType(typeOf(x), name);
    if (f !== undefined) {
      if (name !== "__trunc__") return O.intResult(name, O.lookupSpecial(x, name)(x));
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
// (in hexadecimal: a binary string of a 2^29-bit integer exceeds V8's
// string length, so 2^(10^9) had no bit_length)
method(int, "bit_length", (x: any) => {
  if (!O.truth(x)) return 0;
  const h = absBig(x).toString(16);
  return (h.length - 1) * 4 + (32 - Math.clz32(parseInt(h[0], 16)));
});
method(int, "bit_count", (x: any) => [...absBig(x).toString(2)].filter((c) => c === "1").length);
method(int, "conjugate", (x: any) => +x);
// (an exact int, for a bool or an int subclass instance too, as CPython's)
const exactInt = (x: any) => {
  const v = unbox(x);
  return typeof v === "boolean" ? +v : v;
};
method(int, "__index__", exactInt);
method(int, "__trunc__", exactInt);
method(int, "__floor__", exactInt);
method(int, "__ceil__", exactInt);
// (pickling a subclass instance keeps its value: an int/float/str/bytes/tuple
// subclass, a Sage RealNumber among them, was pickled without it)
method(int, "__getnewargs__", (x: any) => tuple([unbox(x)]));
method(int, "__int__", exactInt);
method(int, "__float__", (x: any) => O.mkfloat(O.fv(x)!));
method(int, "__repr__", (x: any) => repr(unbox(x)));
method(int, "__hash__", (x: any) => O.hashExact(unbox(x)));
method(int, "__format__", (x: any, spec: string) => format(x, spec));
method(int, "is_integer", () => true);
method(int, "as_integer_ratio", (x: any) => tuple([x, 1]));
// (to_bytes and from_bytes: byteorder a str, "little" or "big", as
// CPython's argument clinic and int_to_bytes_impl check it)
// (in the order CPython's argument clinic and then the method's body check
// them: byteorder's type, signed's truth, once, then byteorder's value;
// astra's CORR-E6D-2)
const byteorderStr = (fn: string, byteorder: any): string => {
  if (typeof byteorder !== "string" && !isinstance(byteorder, T.str)) raise(T.TypeError, `${fn}() argument 'byteorder' must be str, not ${typeName(byteorder)}`);
  return unbox(byteorder);
};
const littleEndian = (b: string): boolean => {
  if (b === "little") return true;
  if (b !== "big") raise(T.ValueError, "byteorder must be either 'little' or 'big'");
  return false;
};
// (n's bit length, n >= 0, from its hex digits)
const hexBits = (hex: string) => (hex === "0" ? 0 : 4 * (hex.length - 1) + (32 - Math.clz32(parseInt(hex[0], 16))));
// int.to_bytes(length=1, byteorder="big", *, signed=False) as CPython's
// int_to_bytes_impl: length an index-sized count, the byte order checked,
// then the length's sign, then the value against the length; linear, the
// bytes read from the value's hex digits (a byte at a time took 23 s for
// 415 KB)
method(int, "to_bytes", (x: any, length: any = 1, byteorder: any = "big", signed: any = false) => {
  const k = O.index(length);
  if (typeof k === "bigint" && (k > 9223372036854775807n || k < -9223372036854775808n)) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
  const order = byteorderStr("to_bytes", byteorder);
  const isSigned = O.truth(signed);
  const little = littleEndian(order);
  const n = Number(k);
  if (n < 0) raise(T.ValueError, "length argument must be non-negative");
  const v = BigInt(x);
  if (v < 0n && !isSigned) raise(T.OverflowError, "can't convert negative int to unsigned");
  // (the digits of the value's magnitude only, never of the padding: a
  // negative value's two's complement in 8n bits is ~(-v - 1), which must
  // fit in 8n - 1 bits; daybreak2's limits finding on 6ce60e6b)
  const neg = v < 0n;
  const hex = (neg ? -v - 1n : v).toString(16);
  const bits = hexBits(hex);
  if (bits > 8 * n - (isSigned ? 1 : 0) && !(n === 0 && v === 0n)) raise(T.OverflowError, "int too big to convert");
  let a: Uint8Array;
  try {
    a = new Uint8Array(n);
  } catch (e) {
    if (e instanceof RangeError) raise(T.MemoryError);
    throw e;
  }
  // (the value's bytes at the end, big-endian, the rest padding: 0, or
  // 0xff for a negative value, whose bytes are those of -v - 1 inverted)
  if (neg) a.fill(255);
  const nb = hex === "0" ? 0 : (hex.length + 1) >> 1, odd = hex.length & 1;
  for (let i = 0; i < nb; i++) {
    if ((i & 65535) === 65535) O.pollInterrupt();
    const j = 2 * i - odd;
    const d = j < 0 ? parseInt(hex[0], 16) : parseInt(hex.slice(j, j + 2), 16);
    a[n - nb + i] = neg ? 255 - d : d;
  }
  if (little) a.reverse();
  return new PyBytes(a);
}, sig(["self", "length", "byteorder"], { kwonly: ["signed"] }));
// (the int itself, a plain one: a bool's 0 or 1, a subclass's value; a
// big int as it is, which + cannot convert)
const plainInt = (x: any) => {
  const v = typeof x === "object" && x !== null ? x.valueOf() : x;
  return typeof v === "bigint" ? v : +v;
};
getset(int, "real", plainInt);
getset(int, "imag", () => 0);
getset(int, "numerator", plainInt);
getset(int, "denominator", () => 1);

function parseFloatLiteral(s: string): number | undefined {
  const t = stripAscii(asciiNumeral(s)).toLowerCase().replace(/(?<=\d)_(?=\d)/g, "");
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
  // (as CPython's PyNumber_Float: an int or float as it is; else __float__,
  // its result checked, which an int or float subclass may override; else
  // __index__)
  if (typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" || x instanceof FloatBox) return O.mkfloat(O.fv(x)!);
  const v = floatCallSafe(x) ?? O.fv(x);
  if (v !== undefined) return O.mkfloat(v);
  raise(T.TypeError, `float() argument must be a string or a real number, not '${typeName(x)}'`);
}
const float = builtinType("float", [object], floatCall);
bindClass(FloatBox, float);
method(float, "is_integer", (x: any) => isInt(O.fv(x)!));
method(float, "conjugate", (x: any) => x);
method(float, "__float__", (x: any) => (typeof x === "number" || x instanceof FloatBox ? x : O.mkfloat(O.fv(x)!))); // (a subclass's value as a float)
method(float, "__getnewargs__", (x: any) => tuple([O.mkfloat(O.fv(unbox(x))!)]));
method(float, "__int__", (x: any) => intCall(x));
method(float, "__trunc__", (x: any) => intCall(x));
method(float, "__floor__", (x: any) => intCall(Math.floor(O.fv(x)!)));
method(float, "__ceil__", (x: any) => intCall(Math.ceil(O.fv(x)!)));
method(float, "__repr__", (x: any) => floatRepr(O.fv(x)!));
method(float, "__hash__", (x: any) => O.hashExact(unbox(x))); // (a subclass's __hash__ calling float.__hash__(self) recursed)
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
// (CPython's: the sign, 0x, the leading digit (0 only for zero and subnormals), all 13
// digits of the fraction, and the binary exponent: 0x1.0000000000000p+0)
method(float, "hex", (x: any) => {
  const v = O.fv(x)!;
  if (v !== v) return "nan";
  if (!Number.isFinite(v)) return v < 0 ? "-inf" : "inf";
  const sign = v < 0 || Object.is(v, -0) ? "-" : "";
  if (v === 0) return sign + "0x0.0p+0";
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v);
  const bits = dv.getBigUint64(0), biased = Number((bits >> 52n) & 0x7ffn);
  const e = biased ? biased - 1023 : -1022;
  return `${sign}0x${biased ? 1 : 0}.${(bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0")}p${e < 0 ? "-" : "+"}${Math.abs(e)}`;
});
function floatFromHex(s: string): number {
  const bad = () => raise(T.ValueError, "invalid hexadecimal floating-point string");
  const t = String(s).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) {
    if (special[2].toLowerCase() !== "nan") return special[1] === "-" ? -Infinity : Infinity;
    // (-nan keeps its sign bit, as CPython's)
    if (special[1] !== "-") return NaN;
    const dv = new DataView(new ArrayBuffer(8));
    dv.setBigUint64(0, 0xfff8000000000000n);
    return dv.getFloat64(0);
  }
  const m = /^([+-]?)(?:0x)?([0-9a-f]*)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?$/i.exec(t);
  if (!m || !(m[2] + (m[3] ?? ""))) bad();
  const neg = m![1] === "-", frac = m![3] ?? "";
  // the value is N 2^adj exactly; rounded to the nearest double, ties to even
  const N = BigInt("0x" + (m![2] + frac || "0"));
  const adj = BigInt(m![4] ?? 0) - 4n * BigInt(frac.length);
  if (N === 0n) return neg ? -0 : 0;
  const e = BigInt(N.toString(2).length - 1) + adj; // 2^e <= value < 2^(e+1)
  const big = () => raise(T.OverflowError, "hexadecimal value too large to represent as a float");
  if (e > 1023n) big();
  if (e < -1076n) return neg ? -0 : 0;
  const lsb = (e > -1022n ? e : -1022n) - 52n, shift = lsb - adj;
  let q: bigint;
  if (shift > 0n) {
    q = N >> shift;
    const rem = N - (q << shift), half = 1n << (shift - 1n);
    if (rem > half || (rem === half && (q & 1n))) q += 1n;
  } else q = N << -shift;
  const v = Number(q) * 2 ** Number(lsb);
  if (v === Infinity) big();
  return neg ? -v : v;
}
float.$dict.set("fromhex", new PyClassMethod(pyfn((c: any, s: any) => {
  if (s instanceof StrLayout) s = s.$v; // (a str subclass)
  if (typeof s !== "string") raise(T.TypeError, `bad argument type for built-in operation`);
  const f = O.mkfloat(floatFromHex(s));
  return c === float ? f : c(f);
}, "fromhex")));

builtinType("bool", [int], (x: any = false) => O.truth(x));
method(T.bool, "__repr__", (x: any) => (x ? "True" : "False"));

// ------------------------------------------------------------------ str

const S = builtinType("str", [object], (x: any = "", encoding: any = undefined, errors: any = undefined) => {
  // (an encoding or errors: each a str, then the object decoded, which must
  // be bytes-like, as CPython's unicode_new and PyUnicode_FromEncodedObject;
  // astra3 A11)
  if (encoding !== undefined || errors !== undefined) {
    const strOf = (v: any, n: string): string => {
      const u = unbox(v);
      return typeof u === "string" ? u : raise(T.TypeError, `str() argument '${n}' must be str, not ${typeName(v)}`);
    };
    const enc = encoding === undefined ? "utf-8" : strOf(encoding, "encoding");
    const err = errors === undefined ? "strict" : strOf(errors, "errors");
    if (x instanceof PyBytes) return decode(x, enc, err);
    if (typeof unbox(x) === "string") raise(T.TypeError, "decoding str is not supported");
    const b = O.bufferOf(x);
    if (b === undefined) raise(T.TypeError, `decoding to str: need a bytes-like object, ${typeName(x)} found`);
    return decode(new PyBytes(b.slice()), enc, err);
  }
  // (a __str__ returning a str subclass instance gives that instance, as
  // CPython's PyObject_Str; str's own __str__ gives an exact copy)
  if (x !== null && typeof x === "object" && !(x instanceof FloatBox)) {
    const f = lookupType(typeOf(x), "__str__");
    if (f !== undefined) {
      const r = f(x);
      if (typeof r === "string" || r instanceof StrLayout) return r;
      raise(T.TypeError, `__str__ returned non-string (type ${typeName(r)})`);
    }
  }
  return str(x);
});
S.$kw = (pos, names, values) => S(...bindArgs("str", sig(["object", "encoding", "errors"]), pos, names, values));

// (the Unicode codecs, src/runtime/unicodecs.ts)
export function decode(b: PyBytes, encoding: any = "utf-8", errors: any = "strict"): string {
  return UC.decodeBytes(b.a.subarray(0, b.n), encoding, errors);
}
export function encode(s: string, encoding: any = "utf-8", errors: any = "strict"): PyBytes {
  return UC.encodeStr(s, encoding, errors);
}

const isWs = (c: string) => /[\s\x1c-\x1f\x85]/.test(c);
// Argument checks shared by str methods ("must be str, not int").
function needStr(x: any, what = "must be str"): string {
  if (typeof x !== "string") raise(T.TypeError, `${what}, not ${typeName(x)}`);
  return x;
}
function stripChars(s: string, chars: any, left: boolean, right: boolean): string {
  if (chars !== null && chars !== undefined && typeof chars !== "string") raise(T.TypeError, `${left && right ? "strip" : left ? "lstrip" : "rstrip"} arg must be None or str`);
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
// start and end as UTF-16 offsets, from code-point positions (a start past
// the end stays past it)
function clampRange(s: string, start: any, end: any): [number, number] {
  const p = SP.pairs(s);
  const n = p === null ? s.length : s.length - p.n;
  // (start and end as slice indices: CPython's _PyEval_SliceIndex)
  let a = O.sliceIndex(start, 0);
  let b = O.sliceIndex(end, n);
  if (a < 0) a = Math.max(0, a + n);
  if (b < 0) b = Math.max(0, b + n);
  b = Math.min(b, n);
  if (p === null) return [a, b];
  return [a > n ? s.length + 1 : SP.unitOf(p, a), SP.unitOf(p, Math.max(b, 0))];
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
  return SP.joinChecked(out, sep);
});
// (maxsplit through __index__, converted before sep is looked at, as
// CPython's clinic does)
method(S, "split", (s: string, sep: any = null, maxsplit: any = -1) => {
  const m = Number(AC.ssizeArg(maxsplit));
  if (sep === null) return splitWhitespace(s, m);
  if (typeof sep !== "string") raise(T.TypeError, `must be str or None, not ${typeName(sep)}`);
  if (sep === "") raise(T.ValueError, "empty separator");
  const parts = SP.split(s, sep);
  if (m >= 0 && parts.length > m + 1) return [...parts.slice(0, m), parts.slice(m).join(sep)];
  return parts;
}, sig(["self", "sep", "maxsplit"]));
method(S, "rsplit", (s: string, sep: any = null, maxsplit: any = -1) => {
  const m = Number(AC.ssizeArg(maxsplit));
  if (sep === null) return m < 0 ? splitWhitespace(s, -1) : rsplitWhitespace(s, m);
  needStr(sep, "must be str or None");
  if (sep === "") raise(T.ValueError, "empty separator");
  const parts = SP.split(s, sep);
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
  let c = Number(AC.ssizeArg(count));
  // (matches on code-point boundaries, and no lone surrogates joined: SP)
  if (c < 0 && a !== "") return SP.joinChecked(SP.split(s, a), b);
  if (c < 0) c = Infinity;
  const out: string[] = [];
  let i = 0, k = 0;
  if (a === "") {
    for (const ch of s) {
      if (k++ < c) out.push(b);
      out.push(ch);
    }
    if (k < c) out.push(b);
    return SP.joinChecked(out, "");
  }
  while (k < c) {
    const j = SP.indexOf(s, a, i);
    if (j < 0) break;
    out.push(s.slice(i, j), b);
    i = j + a.length;
    k++;
  }
  out.push(s.slice(i));
  return SP.joinChecked(out, "");
});
// (sub a str, "find() argument 1 must be str, not int", as CPython's clinic)
function findImpl(s: string, sub: any, start: any, end: any, rev: boolean, name: string): number {
  sub = AC.strArg(name, "argument 1", sub);
  const [a, b] = clampRange(s, start, end);
  if (b - a < sub.length || a > s.length) return -1;
  const j = rev ? SP.lastIndexOf(s, sub, b - sub.length) : SP.indexOf(s, sub, a);
  if (j < a || j + sub.length > b) return -1;
  const p = SP.pairs(s);
  return p === null ? j : SP.cpOf(p, j);
}
method(S, "find", (s: string, sub: string, start: any = undefined, end: any = undefined) => findImpl(s, sub, start, end, false, "find"));
method(S, "rfind", (s: string, sub: string, start: any = undefined, end: any = undefined) => findImpl(s, sub, start, end, true, "rfind"));
method(S, "index", (s: string, sub: string, start: any = undefined, end: any = undefined) => {
  const j = findImpl(s, sub, start, end, false, "index");
  if (j < 0) raise(T.ValueError, "substring not found");
  return j;
});
method(S, "rindex", (s: string, sub: string, start: any = undefined, end: any = undefined) => {
  const j = findImpl(s, sub, start, end, true, "rindex");
  if (j < 0) raise(T.ValueError, "substring not found");
  return j;
});
method(S, "count", (s: string, sub: any, start: any = undefined, end: any = undefined) => {
  sub = AC.strArg("count", "argument 1", sub);
  const [a, b] = clampRange(s, start, end);
  if (a > s.length) return 0;
  const t = s.slice(a, b);
  return sub === "" ? SP.cpLen(t) + 1 : SP.split(t, sub).length - 1;
});
// (start and end converted once, before the prefix is looked at, as CPython
// parses its arguments; then a str, a str subclass by its payload, or a
// tuple of them, each checked only when reached, as CPython's tailmatch
// loop does: ("x", 5) is True)
function affix(s: string, x: any, start: any, end: any, ends: boolean): boolean {
  const name = ends ? "endswith" : "startswith";
  const [a, b] = clampRange(s, start, end);
  if (isinstance(x, T.tuple)) {
    for (const p of x as any[]) {
      if (typeof p !== "string" && !(p instanceof StrLayout)) raise(T.TypeError, `tuple for ${name} must only contain str, not ${typeName(p)}`);
      if (affixAt(s, p instanceof StrLayout ? p.$v : p, a, b, ends)) return true;
    }
    return false;
  }
  if (x instanceof StrLayout) x = x.$v;
  if (typeof x !== "string") raise(T.TypeError, `${name} first arg must be str or a tuple of str, not ${typeName(x)}`);
  return affixAt(s, x, a, b, ends);
}
function affixAt(s: string, x: string, a: number, b: number, ends: boolean): boolean {
  if (a > s.length) return false;
  const t = s.slice(a, b);
  return ends ? t.endsWith(x) && SP.onBoundaries(t, t.length - x.length, x.length) : t.startsWith(x) && SP.onBoundaries(t, 0, x.length);
}
method(S, "startswith", (s: string, p: any, start: any = undefined, end: any = undefined) => affix(s, p, start, end, false));
method(S, "endswith", (s: string, p: any, start: any = undefined, end: any = undefined) => affix(s, p, start, end, true));
method(S, "upper", (s: string) => s.toUpperCase());
method(S, "lower", (s: string) => s.toLowerCase());
// str.casefold: full case folding, per code point (no context, unlike
// lower()): Python 3.14's table (casefold-data.ts), read at the first use
// past ASCII; "Straße" is "strasse" (CORR-D1C-1)
let FOLD: Map<number, string> | null = null;
function casefold(s: string): string {
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
  if (FOLD === null) {
    FOLD = new Map();
    for (const e of CASEFOLD.split(";")) {
      const i = e.indexOf(":");
      FOLD.set(parseInt(e.slice(0, i), 16), String.fromCodePoint(...e.slice(i + 1).split(",").map((h) => parseInt(h, 16))));
    }
  }
  let out = "";
  for (const ch of s) out += FOLD.get(ch.codePointAt(0)!) ?? ch;
  return out;
}
method(S, "casefold", (s: string) => casefold(s));
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
method(S, "isdecimal", allMatch(ND));
method(S, "isnumeric", allMatch(/\p{N}/u));
method(S, "isalpha", allMatch(/\p{L}/u));
method(S, "isalnum", allMatch(/[\p{L}\p{N}]/u));
// (CPython's whitespace exactly: JS's \s has U+FEFF too, which isn't)
method(S, "isspace", allMatch(/[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/));
method(S, "isascii", (s: string) => /^[\x00-\x7f]*$/.test(s));
method(S, "isupper", (s: string) => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s));
method(S, "islower", (s: string) => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s));
method(S, "isidentifier", (s: string) => /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u.test(s));
method(S, "isprintable", (s: string) => [...s].every((c) => c === " " || !/[\p{C}\p{Z}]/u.test(c)));
method(S, "istitle", (s: string) => /\p{L}/u.test(s) && s === S.$dict.get("title")(s));
// (the result's length in UTF-16 units checked first: s's, and the padding's
// code points times the fill's units, an astral fill two each)
function padTo(s: string, w: any, fill: string, where: string): string {
  const cp = SP.cpLen(s);
  if (w <= cp) return s;
  AC.allocStr(s.length + (Number(w) - cp) * fill.length);
  const n = Number(w) - cp;
  // (the fill meets s: no lone surrogates joined, SP.glue)
  if (where === "l") return SP.glue(s, fill.repeat(n));
  if (where === "r") return SP.glue(fill.repeat(n), s);
  const left = Math.floor(n / 2) + (n & Number(w) & 1);
  return SP.glue(SP.glue(fill.repeat(left), s), fill.repeat(n - left));
}
// (the width through __index__, then the fill character checked, padding
// needed or not: astra3 A08)
method(S, "center", (s: string, w: any, fill: any = " ") => padTo(s, AC.ssizeArg(w), AC.fillCharArg(fill), "c"));
method(S, "ljust", (s: string, w: any, fill: any = " ") => padTo(s, AC.ssizeArg(w), AC.fillCharArg(fill), "l"));
method(S, "rjust", (s: string, w: any, fill: any = " ") => padTo(s, AC.ssizeArg(w), AC.fillCharArg(fill), "r"));
method(S, "zfill", (s: string, w: any) => {
  const sign = s[0] === "-" || s[0] === "+" ? s[0] : "";
  const wv = AC.ssizeArg(w);
  if (wv > SP.cpLen(s)) AC.allocStr(s.length + (Number(wv) - SP.cpLen(s)));
  const n = Number(wv) - SP.cpLen(s);
  return n > 0 ? sign + "0".repeat(n) + s.slice(sign.length) : s;
});
// str.translate and str.maketrans, as CPython's (their messages included);
// they take int and str subclasses' instances (not float's, nor __index__)
const intOrStr = (x: any): any => (x instanceof IntLayout || x instanceof StrLayout ? x.$v : x);
// (the longest string JS makes: past it, translate's output is a MemoryError
// before it is built, HARD-978-2)
const MAX_STR = 2 ** 29 - 24;
method(S, "translate", (s: string, table: any) => {
  // The output in blocks: unchanged runs are sliced, the pieces joined every
  // 4096 and the blocks appended, so memory goes with the output, not with a
  // JS entry per input character (HARD-C56-1).  A plain dict is read
  // directly for each character, without a KeyError per unmapped one: every
  // lookup is made, as CPython's (a key's __eq__ may count them, CORR-8E6-1),
  // and nothing is kept per code point (HARD-72C-1).
  const plain = table instanceof PyDict && (table as any).$cls === T.dict;
  const NONE = {}; // (a key that is not in the table: kept as is)
  let out = "";
  let pieces: string[] = [];
  let size = 0, n = 0, run = 0;
  // (every piece goes through put: a deleted or mapped character must not
  // leave a lone high surrogate before a lone low one, CORR-C4D-1)
  let high = false;
  const put = (piece: string) => {
    if (piece.length === 0) return;
    if (high && (piece.charCodeAt(0) & 0xfc00) === 0xdc00) SP.refuseMerge();
    high = (piece.charCodeAt(piece.length - 1) & 0xfc00) === 0xd800;
    pieces.push(piece);
  };
  const flush = (upto: number) => {
    if (upto > run) put(s.slice(run, upto));
    if (pieces.length >= 4096) {
      out += pieces.join("");
      pieces = [];
    }
  };
  for (let i = 0; i < s.length; ) {
    // (Stop, every 4096 characters: the table's __getitem__ may be a builtin)
    if ((++n & 4095) === 0) O.pollInterrupt();
    const cp = s.codePointAt(i)!;
    const w = cp > 0xffff ? 2 : 1;
    let r: any;
    if (plain) {
      // (each lookup made, as CPython's, but no KeyError raised for a miss)
      const v = dictGet(table, cp);
      r = v === undefined ? NONE : v;
    } else {
      try {
        r = O.getitem(table, cp);
      } catch (e: any) {
        if (!isinstance(toPyExc(e), T.LookupError)) throw e;
        r = NONE;
      }
    }
    if (r === NONE) {
      size += w;
      i += w;
      continue;
    }
    flush(i);
    i += w;
    run = i;
    if (r === null) continue;
    r = intOrStr(r);
    if (typeof r === "string") {
      size += r.length;
      if (size > MAX_STR) raise(T.MemoryError);
      put(r);
    } else if (O.isPyInt(r)) {
      const c = Number(r);
      if (!(c >= 0 && c < 0x110000)) raise(T.ValueError, "character mapping must be in range(0x110000)");
      size += c > 0xffff ? 2 : 1;
      if (size > MAX_STR) raise(T.MemoryError);
      put(String.fromCodePoint(c));
    } else raise(T.TypeError, "character mapping must return integer, None or str");
  }
  flush(s.length);
  return out + pieces.join("");
});
S.$dict.set("maketrans", new PyStaticMethod(pyfn((...a: any[]) => {
  if (a.length === 0) raise(T.TypeError, "maketrans expected at least 1 argument, got 0");
  if (a.length > 3) raise(T.TypeError, `maketrans expected at most 3 arguments, got ${a.length}`);
  const d = new PyDict();
  if (a.length === 1) {
    if (!(a[0] instanceof PyDict)) raise(T.TypeError, "if you give only one argument to maketrans it must be a dict");
    let n = 0;
    for (const k of O.toArray(a[0])) {
      if ((++n & 4095) === 0) O.pollInterrupt();
      const v = O.getitem(a[0], k);
      const kk = intOrStr(k);
      if (typeof kk === "string") {
        if ([...kk].length !== 1) raise(T.ValueError, "string keys in translatetable must be of length 1");
        dictSet(d, kk.codePointAt(0)!, v);
      } else if (O.isPyInt(kk)) dictSet(d, k, v);
      else raise(T.TypeError, "keys in translate table mustbe strings or integers");
    }
    return d;
  }
  // (the second and third are checked first, as CPython's argument parsing)
  for (let i = 1; i < a.length; i++) {
    if (typeof intOrStr(a[i]) !== "string") raise(T.TypeError, `maketrans() argument ${i + 1} must be str, not ${typeName(a[i])}`);
    a[i] = intOrStr(a[i]);
  }
  if (typeof intOrStr(a[0]) !== "string") raise(T.TypeError, "first maketrans argument must be a string if there is a second argument");
  a[0] = intOrStr(a[0]);
  // (by code points, both strings in step: no array of either, HARD-C56-1;
  // the dict has at most one entry per code point)
  const x: string = a[0], y: string = a[1];
  const count = (t: string) => {
    let k = 0;
    for (let i = 0; i < t.length; i += t.codePointAt(i)! > 0xffff ? 2 : 1) {
      if ((++k & 65535) === 0) O.pollInterrupt();
    }
    return k;
  };
  if (count(x) !== count(y)) raise(T.ValueError, "the first two maketrans arguments must have equal length");
  for (let i = 0, j = 0, n = 0; i < x.length; n++) {
    if ((n & 4095) === 4095) O.pollInterrupt();
    const c = x.codePointAt(i)!, e = y.codePointAt(j)!;
    dictSet(d, c, e);
    i += c > 0xffff ? 2 : 1;
    j += e > 0xffff ? 2 : 1;
  }
  if (a.length === 3) {
    const z: string = a[2];
    for (let i = 0, n = 0; i < z.length; n++) {
      if ((n & 4095) === 4095) O.pollInterrupt();
      const c = z.codePointAt(i)!;
      dictSet(d, c, null);
      i += c > 0xffff ? 2 : 1;
    }
  }
  return d;
}, "maketrans")));
method(S, "partition", (s: string, sep: string) => {
  if (needStr(sep) === "") raise(T.ValueError, "empty separator");
  const i = SP.indexOf(s, sep, 0);
  return i < 0 ? tuple([s, "", ""]) : tuple([s.slice(0, i), sep, s.slice(i + sep.length)]);
});
method(S, "rpartition", (s: string, sep: string) => {
  if (needStr(sep) === "") raise(T.ValueError, "empty separator");
  const i = SP.lastIndexOf(s, sep, s.length);
  return i < 0 ? tuple(["", "", s]) : tuple([s.slice(0, i), sep, s.slice(i + sep.length)]);
});
// (a str argument only: astra3 A09)
method(S, "removeprefix", (s: string, p: any) => ((p = AC.strArg("removeprefix", "argument", p)), s.startsWith(p) && SP.onBoundaries(s, 0, p.length) ? s.slice(p.length) : s));
method(S, "removesuffix", (s: string, p: any) => ((p = AC.strArg("removesuffix", "argument", p)), p && s.endsWith(p) && SP.onBoundaries(s, s.length - p.length, p.length) ? s.slice(0, -p.length) : s));
method(S, "encode", (s: string, encoding: any = "utf-8", errors: any = "strict") => encode(s, encoding, errors), sig(["self", "encoding", "errors"]));
method(S, "expandtabs", (s: string, ts: any = 8) => {
  let out = "", col = 0;
  const n = AC.cIntArg(ts);
  // (the result's whole length counted first, without building it: a tab's
  // spaces and every other character's units, suffix too)
  {
    let units = 0, c0 = 0;
    for (const c of s) {
      if (c === "\t") {
        const k = n > 0 ? n - (c0 % n) : 0;
        units += k;
        c0 += k;
        if (units > AC.MAX_STR) AC.allocStr(units);
      } else {
        units += c.length;
        c0 = c === "\n" || c === "\r" ? 0 : c0 + 1;
      }
    }
    AC.allocStr(units);
  }
  const seams: number[] = []; // (a tab expanded to nothing joins its neighbours: SP.checkSeams)
  for (const c of s) {
    if (c === "\t") {
      const k = n > 0 ? n - (col % n) : 0;
      if (k === 0) seams.push(out.length);
      out += " ".repeat(k);
      col += k;
    } else {
      out += c;
      col = c === "\n" || c === "\r" ? 0 : col + 1;
    }
  }
  return SP.checkSeams(out, seams);
});
method(S, "format", (s: string, ...args: any[]) => strFormat(s, args, new Map()));
S.$dict.get("format").$kw = (pos: any[], names: string[], values: any[]) => strFormat(pos[0], pos.slice(1), new Map(names.map((n, i) => [n, values[i]])));
method(S, "format_map", (s: string, m: any) => strFormat(s, [], m));
method(S, "__len__", (s: string) => SP.cpLen(s));
method(S, "__contains__", (s: string, x: any) => O.contains(s, x));
method(S, "__getitem__", (s: string, k: any) => O.getitem(s, k));
method(S, "__add__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? SP.glue(s, x) : NotImplemented));
// (a builtin sequence's own repeat takes an index, else a TypeError, never
// NotImplemented, as CPython's wrapper of its sq_repeat)
method(S, "__mul__", (s: string, x: any) => O.strRepeat(s, O.ssizeCount(x)));
method(S, "__mod__", (s: string, x: any) => O.strFormatOpHook.f(s, x));
method(S, "__eq__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s === x : NotImplemented));
method(S, "__lt__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? O.strCmp(s, x) < 0 : NotImplemented));
method(S, "__hash__", (s: any) => O.hashAny(unbox(s)));
// (an exact str, of a subclass's too: its overrides gone, as CPython's)
method(S, "__str__", (s: any) => (s instanceof StrLayout ? s.$v : s));
method(S, "__getnewargs__", (s: any) => tuple([unbox(s)]));
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
      if (!kw.has(first)) throw markRaised(T.KeyError(first));
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
    const seams: number[] = [];
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
        // (a field's ends are seams: no lone surrogates joined)
        seams.push(r.length);
        r += format(v, spec);
        seams.push(r.length);
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
    return SP.checkSeams(r, seams);
  };
  out = expand(s, 0);
  return out;
}

// ------------------------------------------------------------------ list, tuple

// (anything but an exact list or tuple is copied through its iterator, its
// own __iter__ if it has one, after which its length hint is asked, as
// CPython's list_extend does)
const list = builtinType("list", [object], (x: any = undefined) => {
  if (x === undefined) return [];
  if (Array.isArray(x) && (typeOf(x) === list || typeOf(x) === tupleType)) return O.toArray(x);
  const it = O.iter(x);
  O.lengthHint(x);
  return O.toArray(it);
});
// (tuple(x) is x itself only for an exact tuple: a subclass's instance is
// copied into a new exact tuple through its iterator, its own __iter__ if
// it has one, as CPython's tuple_new does)
const tupleType = builtinType("tuple", [object], (x: any = undefined) =>
  x === undefined ? tuple([]) : Array.isArray(x) && (x as any).$t === true && typeOf(x) === tupleType ? x : tuple(O.toArray(Array.isArray(x) ? O.iter(x) : x)),
);

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
  else if (keys.every((k) => typeof k === "string")) cmp = (i, j) => Math.sign(O.strCmp(keys[i], keys[j]));
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
// (list.index's and tuple.index's start and stop as CPython's
// _PyEval_SliceIndexNotNone: an int or an __index__, clamped; None and
// anything else its TypeError)
const boundNotNone = (v: any, dflt: number): number => {
  if (v === undefined) return dflt;
  if (v === null || !(O.isPyInt(v) || isinstance(v, T.int) || lookupType(typeOf(v), "__index__") !== undefined)) raise(T.TypeError, "slice indices must be integers or have an __index__ method");
  return O.sliceIndex(v, dflt);
};
const seqIndexOf = (a: any[], x: any, start: any, end: any, what: string) => {
  let lo = boundNotNone(start, 0), hi = boundNotNone(end, a.length);
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
allocator(tupleType, (cls: PyType, it: any = undefined) => {
  const items = it === undefined ? [] : O.toArray(it);
  if (cls === tupleType) return tuple(items);
  const a = new cls.$ctor!();
  for (const v of items) a.push(v);
  return a;
});
const seqOps = (cls: PyType, isTuple: boolean) => {
  const same = (b: any) => Array.isArray(b) && !!(b as any).$t === isTuple;
  for (const op of ["__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__"]) method(cls, op, (a: any[], b: any) => (same(b) ? O.seqCmp(a, b, op) : NotImplemented));
  method(cls, "__len__", (a: any[]) => a.length);
  method(cls, "__getitem__", (a: any[], k: any) => O.arrGet(a, k));
  method(cls, "__contains__", (a: any[], x: any) => O.arrContains(a, x));
  method(cls, "__iter__", (a: any[]) => new O.ListIter(a));
  method(cls, "__repr__", (a: any[]) => seqRepr(a));
  method(cls, "__mul__", (a: any[], n: any) => O.repeatArray(a, O.ssizeCount(n)));
  method(cls, "__rmul__", (a: any[], n: any) => O.repeatArray(a, O.ssizeCount(n)));
};
seqOps(list, false);
seqOps(tupleType, true);
method(list, "__setitem__", (a: any[], k: any, v: any) => (O.arrSet(a, k, v), null));
method(list, "__delitem__", (a: any[], k: any) => (O.arrDel(a, k), null));
method(list, "__iadd__", (a: any[], b: any) => {
  for (const v of O.toArray(b)) a.push(v);
  return a;
});
// (in place, as CPython's list_inplace_repeat: the count through __index__,
// so an alias sees it; [1] *= Index() made a new list)
method(list, "__imul__", (a: any[], n: any) => O.listInplaceRepeat(a, n, true));
method(list, "__add__", (a: any[], b: any) => (Array.isArray(b) && !(b as any).$t ? [...a, ...b] : NotImplemented));
list.$dict.set("__hash__", null);

method(tupleType, "index", (a: any[], x: any, start: any = undefined, end: any = undefined) => seqIndexOf(a, x, start, end, "tuple"));
method(tupleType, "count", (a: any[], x: any) => a.filter((v) => O.eqBool(v, x)).length);
method(tupleType, "__hash__", (a: any[]) => O.hashTupleOf(a));
method(tupleType, "__getnewargs__", (a: any[]) => tuple([tuple([...a])]));
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
  if (pos.length > 2) raise(T.TypeError, `dict expected at most 1 argument, got ${pos.length - 1}`);
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
  method(vt, "__iter__", (v: DictView) => O.dictIter(v.d, v.kind));
  method(vt, "__len__", (v: DictView) => v.d.$m.size);
  if (kind !== 1) vt.$dict.set("__hash__", null);
  method(vt, "__reversed__", (v: DictView) => new O.DictRevIter(v.d, v.kind));
  method(vt, "__repr__", (v: DictView) => `${name}(${repr(O.toArray(O.dictIter(v.d, v.kind)))})`);
  method(vt, "__contains__", (v: DictView, x: any) => {
    if (kind === 0) return dictGet(v.d, x) !== undefined;
    if (kind === 1) return O.contains(O.toArray(new O.DictValueIter(v.d)), x);
    const kv = O.unpack(x, 2);
    const w = dictGet(v.d, kv[0]);
    return w !== undefined && O.eqBool(w, kv[1]);
  });
  if (kind !== 1) {
    for (const [op, f] of [["__and__", "and"], ["__or__", "or"], ["__sub__", "sub"], ["__xor__", "xor"]] as const) {
      method(vt, op, (v: DictView, other: any) => O.setOp(O.newSet(O.dictIter(v.d, v.kind)), O.newSet(other), f));
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
method(dict, "__reversed__", (d: PyDict) => new O.DictRevIter(d, 0));
method(dict, "values", (d: PyDict) => new DictView(d, 1));
method(dict, "items", (d: PyDict) => new DictView(d, 2));
method(dict, "get", (d: PyDict, k: any, dflt: any = null) => {
  const v = dictGet(d, k);
  return v === undefined ? dflt : v;
});
method(dict, "setdefault", (d: PyDict, k: any, dflt: any = null) => {
  // (the key hashed once for both, as CPython's, CORR-D77-2)
  const kh = dictKeyHash(d, k);
  const v = dictGet(d, k, kh);
  if (v !== undefined) return v;
  dictSet(d, k, dflt, kh);
  return dflt;
});
method(dict, "pop", (d: PyDict, k: any, dflt: any = undefined) => {
  // (an empty dict's: the default or KeyError, the key never hashed, as
  // CPython's dict_pop)
  // (but a class namespace's dict refuses a key other than a str even
  // when empty, daybreak2's HARD-E4A-1)
  const empty = d.$m.size === 0 && (d as any).$strOnly !== true;
  const kh = empty ? undefined : dictKeyHash(d, k);
  const v = empty ? undefined : dictGet(d, k, kh);
  if (v === undefined) {
    if (dflt !== undefined) return dflt;
    throw markRaised(T.KeyError(k));
  }
  dictDelete(d, k, kh);
  return v;
});
method(dict, "popitem", (d: PyDict) => {
  if (d.$m.size === 0) throw markRaised(T.KeyError("popitem(): dictionary is empty"));
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
  if (pos.length > 2) raise(T.TypeError, `update expected at most 1 argument, got ${pos.length - 1}`);
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
  if (!dictDelete(d, k)) throw markRaised(T.KeyError(k));
  return null;
});
method(dict, "__contains__", (d: PyDict, k: any) => dictGet(d, k) !== undefined);
method(dict, "__iter__", (d: PyDict) => new O.DictIter(d));
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
allocator(frozenset, (cls: PyType, it: any = undefined) => {
  const s = cls === frozenset ? O.newSet(undefined, true) : new cls.$ctor!();
  if (it !== undefined) O.forEach(it, (v) => O.setAdd(s, v));
  return s;
});
Object.defineProperty(O.PySet.prototype, "$cls", {
  get(this: O.PySet) {
    return this.$frozen ? frozenset : set;
  },
});
const asSet = (x: any) => (x instanceof O.PySet ? x : O.newSet(x));
const setMethods = (cls: PyType, mutable: boolean) => {
  method(cls, "copy", (s: O.PySet) => O.setOp(s, O.newSet(), "or"));
  // (each also as an array of its arguments, for s.union(*xs) of any length: BIG_CALL)
  // (union and difference work on one copy: a copy per argument was quadratic)
  const fold = (op: "or" | "and" | "sub") => (a: any[]) => {
    let r = O.setOp(a[0], O.newSet(), "or");
    for (let i = 1; i < a.length; i++) {
      if ((i & 1023) === 0) O.pollInterrupt(); // (Stop reaches a long argument list)
      if (op === "or") O.forEach(a[i], (v) => O.setAdd(r, v));
      else if (op === "sub") O.forEach(a[i], (v) => void dictDelete(r.$d, v));
      else r = O.setOp(r, asSet(a[i]), "and");
    }
    return r;
  };
  for (const [name, op] of [["union", "or"], ["intersection", "and"], ["difference", "sub"]] as const) {
    const f = fold(op);
    positionalArray(method(cls, name, (s: O.PySet, ...others: any[]) => f([s, ...others])), f);
  }
  method(cls, "symmetric_difference", (s: O.PySet, o: any) => O.setOp(s, asSet(o), "xor"));
  method(cls, "issubset", (s: O.PySet, o: any) => O.setSubset(s, asSet(o)));
  method(cls, "issuperset", (s: O.PySet, o: any) => O.setSubset(asSet(o), s));
  method(cls, "isdisjoint", (s: O.PySet, o: any) => O.toArray(o).every((v) => dictGet(s.$d, v) === undefined));
  method(cls, "__len__", (s: O.PySet) => s.$d.$m.size);
  method(cls, "__contains__", (s: O.PySet, x: any) => dictGet(s.$d, x) !== undefined);
  method(cls, "__iter__", (s: O.PySet) => new O.SetIter(s.$d));
  method(cls, "__repr__", (s: O.PySet) => setRepr(s));
  method(cls, "__eq__", (s: O.PySet, o: any) => (o instanceof O.PySet ? O.eq(s, o) : NotImplemented));
  // (the binary operators, reflected too, and for a set the in-place ones,
  // as CPython's slots: what a subclass inherits, CORR-A2B-1, -2)
  for (const [op, f] of [["__and__", "and"], ["__or__", "or"], ["__sub__", "sub"], ["__xor__", "xor"]] as const) {
    method(cls, op, (s: O.PySet, o: any) => (o instanceof O.PySet ? O.setOp(s, o, f) : NotImplemented));
    method(cls, "__r" + op.slice(2), (s: O.PySet, o: any) => (o instanceof O.PySet ? O.setOp(o, s, f) : NotImplemented));
    if (mutable) method(cls, "__i" + op.slice(2), (s: O.PySet, o: any) => (o instanceof O.PySet ? O.setInplace(s, o, f) : NotImplemented));
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
    if (!dictDelete(s.$d, x)) throw markRaised(T.KeyError(x));
    return null;
  });
  method(cls, "pop", (s: O.PySet) => {
    const it = s.$d.$m.keys().next();
    if (it.done) throw markRaised(T.KeyError("pop from an empty set"));
    const k = dictKeyOf(s.$d, it.value);
    dictDelete(s.$d, k);
    return k;
  });
  method(cls, "clear", (s: O.PySet) => (dictClear(s.$d), null));
  const update = (a: any[]) => {
    const s: O.PySet = a[0];
    for (let i = 1; i < a.length; i++) {
      if ((i & 1023) === 0) O.pollInterrupt();
      O.forEach(a[i], (v) => O.setAdd(s, v));
    }
    return null;
  };
  positionalArray(method(cls, "update", (s: O.PySet, ...others: any[]) => update([s, ...others])), update);
  method(cls, "symmetric_difference_update", (s: O.PySet, o: any) => ((s.$d = O.setOp(s, asSet(o), "xor").$d), null));
  for (const [name, f] of [["intersection_update", "and"], ["difference_update", "sub"]] as const) {
    const g = (a: any[]) => {
      const s: O.PySet = a[0];
      for (let i = 1; i < a.length; i++) {
        if ((i & 1023) === 0) O.pollInterrupt();
        s.$d = O.setOp(s, asSet(a[i]), f).$d;
      }
      return null;
    };
    positionalArray(method(cls, name, (s: O.PySet, ...os: any[]) => g([s, ...os])), g);
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
// (a range's slice, as CPython's compute_slice: exact, from the slice's
// _PySlice_GetLongIndices, so a step past 2**53 stays an exact int)
function rangeSlice(start: bigint, step: bigint, n: bigint, k: O.PySlice): any {
  const [a, b, st] = O.sliceLongIndices(k, n);
  return makeRange(O.normBig(start + a * step), O.normBig(start + b * step), O.normBig(st * step));
}
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
    if (k instanceof O.PySlice) return rangeSlice(r.start, r.step, n, k);
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
  if (k instanceof O.PySlice) return rangeSlice(BigInt(r.start), BigInt(r.step), BigInt(r.length), k);
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
// (exact, as CPython's slice_indices: _PySlice_GetLongIndices)
method(sliceType, "indices", (s: O.PySlice, n: any) => {
  const len = BigInt(O.index(n));
  if (len < 0n) raise(T.ValueError, "length should not be negative");
  return tuple(O.sliceLongIndices(s, len).map(O.normBig));
});
method(sliceType, "__repr__", (s: O.PySlice) => `slice(${repr(s.start)}, ${repr(s.stop)}, ${repr(s.step)})`);

// ------------------------------------------------------------------ bytes, bytearray

const Ty_lookup = (x: any, name: string) => lookupType(typeOf(x), name);
// bytes()'s and bytearray()'s encoding and errors are str, checked before
// anything else (a bytearray is not emptied), as CPython's argument parsing
function codecArgs(array: boolean, encoding: any, errors: any): [any, any] {
  const str = (v: any, what: string) => {
    if (v === undefined || typeof v === "string") return v;
    if (isinstance(v, T.str)) return unbox(v);
    return raise(T.TypeError, `${array ? "bytearray" : "bytes"}() argument '${what}' must be str, not ${v === null ? "None" : typeName(v)}`);
  };
  return [str(encoding, "encoding"), str(errors, "errors")];
}
// (`reserve`, if given, is told each length the result grows to before it
// is allocated or extended: bytearray.__init__ under an export refuses there,
// after one item of an iterable, as CPython's, never materializing it all)
// CPython's PyObject_Bytes, as int.from_bytes reads its argument: bytes as
// they are; an object's __bytes__, which must give bytes; a str refused;
// a buffer's bytes; each item of a list, tuple or other iterable through
// __index__, in range(0, 256); anything else "cannot convert"
function objectBytes(x: any): Uint8Array {
  if (x instanceof PyBytes && !(x instanceof PyByteArray) && typeOf(x) === T.bytes) return x.a.subarray(0, x.n);
  // (the type's __bytes__ as a special method: a staticmethod, a
  // classmethod, a property or any descriptor bound as CPython binds it, a
  // metaclass's for a class, a None one a TypeError when called;
  // astra's CORR-E6D-1)
  const f = O.lookupSpecial(x, "__bytes__");
  if (f !== undefined) {
    const r = f(x);
    if (!(r instanceof PyBytes) || r instanceof PyByteArray) raise(T.TypeError, `__bytes__ returned non-bytes (type ${typeName(r)})`);
    return r.a.subarray(0, r.n);
  }
  const cannot = () => raise(T.TypeError, `cannot convert '${typeName(x)}' object to bytes`);
  if (typeof x === "string" || isinstance(x, T.str)) cannot();
  const buf = O.bufferOf(x);
  if (buf !== undefined) return buf;
  let it: any;
  try {
    it = O.iter(x);
  } catch (e: any) {
    if (isinstance(toPyExc(e), T.TypeError)) cannot();
    throw e;
  }
  const out: number[] = [];
  const END = {};
  for (let i = 0; ; i++) {
    if ((i & 65535) === 65535) O.pollInterrupt();
    const v = O.next(it, END);
    if (v === END) break;
    const d = O.index(v);
    if (!(d >= 0 && d < 256)) raise(T.ValueError, "bytes must be in range(0, 256)");
    out.push(Number(d));
  }
  return Uint8Array.from(out);
}
function toBytes(x: any, encoding: any = undefined, errors: any = undefined, array = false, reserve?: (n: number) => void): Uint8Array {
  [encoding, errors] = codecArgs(array, encoding, errors);
  if (x !== undefined && typeof x !== "string" && isinstance(x, T.str)) x = unbox(x);
  if (typeof x !== "string") {
    // (with no source too: bytes(encoding='ascii') is TypeError, as CPython's)
    if (encoding !== undefined) raise(T.TypeError, "encoding without a string argument");
    if (errors !== undefined) raise(T.TypeError, "errors without a string argument");
  }
  if (x === undefined) return new Uint8Array(0);
  if (typeof x === "string") {
    if (encoding === undefined) raise(T.TypeError, "string argument without an encoding");
    return encode(x, encoding, errors ?? "strict").a;
  }
  if (encoding !== undefined) raise(T.TypeError, typeof x === "string" ? "" : "encoding without a string argument");
  if (O.isPyInt(x)) {
    if (typeof x === "bigint" || Number(x) > 2 ** 32) raise(T.OverflowError, "cannot fit 'int' into an index-sized integer");
    if (Number(x) < 0) raise(T.ValueError, "negative count");
    reserve?.(Number(x));
    return new Uint8Array(Number(x));
  }
  const buf = O.bufferOf(x);
  if (buf !== undefined) return buf.slice();
  if (typeof x === "object" && x !== null && Ty_lookup(x, "__bytes__") !== undefined) {
    const r = Ty_lookup(x, "__bytes__")(x);
    if (!(r instanceof PyBytes)) raise(T.TypeError, `__bytes__ returned non-bytes (type ${typeName(r)})`);
    return r.a.slice(0, r.n);
  }
  // an object with __index__ is a count, and so is each item, as in CPython:
  // the special method resolved as any other (a staticmethod or classmethod
  // too), each item converted as it is fetched (bytes of Sage's Rational 4/2
  // was "not iterable")
  const index = (v: any): any => {
    if (O.isPyInt(v)) return typeof v === "boolean" ? +v : v;
    if (typeof v !== "object" || v === null) return undefined;
    const f = O.lookupSpecial(v, "__index__");
    if (f === undefined) return undefined;
    const r = f(v);
    // (a strict int subclass, bool among them: with CPython's DeprecationWarning)
    if (typeof r === "boolean" || (r instanceof PrimBox && isinstance(r, int))) return O.intResult("__index__", r);
    if (O.isPyInt(r)) return r;
    return { bad: r };
  };
  if (typeof x === "object" && x !== null && O.lookupSpecial(x, "__index__") !== undefined) {
    // (a TypeError from __index__ is "cannot convert", as in CPython)
    let n: any;
    try {
      n = index(x);
    } catch (e: any) {
      if (isinstance(e, T.TypeError)) raise(T.TypeError, `cannot convert '${typeName(x)}' object to bytes`);
      throw e;
    }
    if (n === undefined || (typeof n === "object" && "bad" in n)) raise(T.TypeError, `cannot convert '${typeName(x)}' object to bytes`);
    return toBytes(n, undefined, undefined, array, reserve);
  }
  const it = O.iter(x);
  const out: number[] = [];
  const END = {};
  for (;;) {
    const v = O.next(it, END);
    if (v === END) break;
    const n = index(v);
    if (n === undefined) raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
    if (typeof n === "object") raise(T.TypeError, `__index__ returned non-int (type ${typeName(n.bad)})`);
    if (n < 0 || n > 255) raise(T.ValueError, array ? "byte must be in range(0, 256)" : "bytes must be in range(0, 256)");
    reserve?.(out.length + 1);
    out.push(Number(n));
  }
  return Uint8Array.from(out);
}
const bytesType = builtinType("bytes", [object], (x: any = undefined, enc: any = undefined, errors: any = undefined) => new PyBytes(toBytes(x, enc, errors)));
const bytearray = builtinType("bytearray", [object], (x: any = undefined, enc: any = undefined, errors: any = undefined) => new PyByteArray(toBytes(x, enc, errors, true)));
bindClass(PyBytes, bytesType);
bindClass(PyByteArray, bytearray);
for (const bt of [bytesType, bytearray]) {
  method(bt, "decode", (b: PyBytes, encoding: any = "utf-8", errors: any = "strict") => decode(b, encoding, errors), sig(["self", "encoding", "errors"]));
  method(bt, "hex", (b: PyBytes, sep: any = undefined, bps: any = undefined) => bytesHex(b.a.subarray(0, b.n), sep, bps));
  // translate(table, /, delete=b'') as CPython's: table a 256-byte buffer or
  // None, delete a buffer, each C-contiguous (a strided memoryview is
  // CPython's BufferError); the result the receiver's base type (an exact
  // bytes left as it was is itself); CPython's argument messages
  const contiguous = (x: any): Uint8Array => {
    if (O.bufferViewOf(x) === undefined && O.bufferOf(x) !== undefined) raise(T.BufferError, "memoryview: underlying buffer is not C-contiguous");
    return AC.bufferArg(x);
  };
  const translate = (b: PyBytes, table: any, del: any) => {
    const t = table === null ? null : contiguous(table);
    if (t !== null && t.length !== 256) raise(T.ValueError, "translation table must be 256 characters long");
    const drop = new Uint8Array(256);
    if (del !== undefined) for (const v of contiguous(del)) drop[v] = 1;
    const src = b.a.subarray(0, b.n), out = new Uint8Array(b.n);
    let n = 0, same = true;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (drop[v]) {
        same = false;
        continue;
      }
      const w = t === null ? v : t[v];
      if (w !== v) same = false;
      out[n++] = w;
    }
    if (same && typeOf(b) === bytesType) return b;
    return bt === bytearray ? new PyByteArray(out.slice(0, n)) : new PyBytes(out.slice(0, n));
  };
  const arity = (k: number) => {
    if (k === 0) raise(T.TypeError, "translate() takes at least 1 positional argument (0 given)");
    if (k > 2) raise(T.TypeError, `translate() takes at most 2 arguments (${k} given)`);
  };
  const tr: any = (b: PyBytes, ...a: any[]) => (arity(a.length), translate(b, a[0], a[1]));
  tr.$kw = (pos: any[], names: string[], values: any[]) => {
    const [b, ...a] = pos;
    // (as CPython's argument clinic: no positional argument, then too many
    // arguments in all, then the keywords' names)
    if (a.length === 0) arity(0);
    arity(a.length + names.length);
    let del: any = a[1];
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== "delete") raise(T.TypeError, `translate() got an unexpected keyword argument '${names[i]}'`);
      del = values[i];
    }
    return translate(b, a[0], del);
  };
  method(bt, "translate", tr);
  // maketrans(frm, to, /), a static method: the 256-byte table that maps
  // frm's bytes to to's, a bytes for either type
  const mk: any = pyfn((...a: any[]) => {
    if (a.length !== 2) raise(T.TypeError, `maketrans expected 2 arguments, got ${a.length}`);
    const frm = contiguous(a[0]), to = contiguous(a[1]);
    if (frm.length !== to.length) raise(T.ValueError, "maketrans arguments must have same length");
    const out = new Uint8Array(256);
    for (let i = 0; i < 256; i++) out[i] = i;
    for (let i = 0; i < frm.length; i++) out[frm[i]] = to[i];
    return new PyBytes(out);
  }, "maketrans");
  mk.__qualname__ = `${bt.$name}.maketrans`;
  mk.$builtinMethod = true;
  bt.$dict.set("maketrans", new PyStaticMethod(mk));
  method(bt, "__len__", (b: PyBytes) => b.n);
  method(bt, "__mul__", (b: PyBytes, n: any) => O.repeatBytes(b, O.ssizeCount(n)));
  method(bt, "__rmul__", (b: PyBytes, n: any) => O.repeatBytes(b, O.ssizeCount(n)));
  if (bt === bytearray) method(bt, "__imul__", (b: PyByteArray, n: any) => O.bytearrayInplaceRepeat(b, n, true));
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
method(bytesType, "__getnewargs__", (b: PyBytes) => tuple([new PyBytes(b.a.slice(0, b.n))]));
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
  checkResizable(b);
  grow(b, 1);
  b.a[b.n++] = Number(x);
  return null;
});
method(bytearray, "extend", (b: PyByteArray, x: any) => {
  // an iterable of bytes, never a count (extend(5) added five zero bytes)
  if (O.isPyInt(x) || (typeof x === "object" && x !== null && O.bufferOf(x) === undefined
      && lookupDunder(x, "__iter__") === undefined && lookupDunder(x, "__getitem__") === undefined)) {
    raise(T.TypeError, `can't extend bytearray with ${typeName(x)}`);
  }
  const add = toBytes(x, undefined, undefined, true);
  // (only a real re-size is refused while exported: extending by nothing
  // is not one, CORR-185-1)
  if (add.length === 0) return null;
  checkResizable(b);
  grow(b, add.length);
  b.a.set(add, b.n);
  b.n += add.length;
  return null;
});
method(bytearray, "pop", (b: PyByteArray) => {
  if (b.n === 0) raise(T.IndexError, "pop from empty bytearray");
  checkResizable(b);
  return b.a[--b.n];
});

// ------------------------------------------------------------------ iterators

// Iterator vocabulary:
// - $next() is the internal step: a value or DONE (the exhaustion sentinel).
// - __next__ is the Python boundary: a value or a raised StopIteration.
// - O.lastStop.e carries a source's StopIteration, including its payload,
//   across the internal DONE return. Clear it before starting a new step.
// Stored fields retain their runtime names: it/its = source iterator(s),
// i = counter/index, f = callable, a/get = reverse sequence/accessor.

// Expose an internal iterator class as a Python type.
function iteratorType(name: string, jsClass: any, call?: (...a: any[]) => any): PyType {
  const iteratorClass = builtinType(name, [object], call ?? (() => raise(T.TypeError, `cannot create '${name}' instances`)));
  bindClass(jsClass, iteratorClass);
  method(iteratorClass, "__iter__", (iterator: any) => iterator);
  method(iteratorClass, "__next__", (iterator: any) => {
    O.lastStop.e = null;
    const value = iterator.$next();
    if (value === DONE) throw O.lastStop.e ?? markRaised(T.StopIteration());
    return value;
  });
  return iteratorClass;
}
iteratorType("list_iterator", O.ListIter);
iteratorType("range_iterator", O.RangeIter);
// A range too long for doubles has its own Python iterator type.
iteratorType("longrange_iterator", BigRangeIter);
iteratorType("str_ascii_iterator", O.StrIter);
iteratorType("dict_keyiterator", O.DictIter);
iteratorType("dict_valueiterator", O.DictValueIter);
iteratorType("dict_itemiterator", O.DictItemIter);
iteratorType("dict_reversekeyiterator", O.DictRevIter);
iteratorType("set_iterator", O.SetIter);
iteratorType("bytes_iterator", O.BytesIter);
iteratorType("generator_wrapper", O.GenIter);
// Python's "iterator" is its __getitem__ adapter. ProtoIter wraps Python
// iterators internally; iter() exposes the original Python object instead.
bindClass(O.ProtoIter, iteratorType("iterator", O.GetitemIter));

// One below Number.MAX_SAFE_INTEGER: at this boundary and beyond, use O.add,
// which handles integer promotion to bigint.
const ENUMERATE_NATIVE_INCREMENT_LIMIT = 9007199254740990;

export class Enumerate {
  constructor(public it: any, public i: any) {}
  $next(): any {
    const value = this.it.$next();
    if (value === DONE) return DONE;
    const result = tuple([this.i, value]);
    this.i = typeof this.i === "number" && this.i < ENUMERATE_NATIVE_INCREMENT_LIMIT ? this.i + 1 : O.add(this.i, 1);
    return result;
  }
}
// Convert start through __index__ before obtaining the source iterator.
// Only an omitted start defaults to zero; explicit None must be converted.
const enumNew = (iterable: any, start: any): Enumerate => {
  const startIndex = start === undefined ? 0 : O.index(start);
  return new Enumerate(O.iter(iterable), startIndex);
};
const enumerate = iteratorType("enumerate", Enumerate, (iterable: any, start: any = undefined) => enumNew(iterable, start));
enumerate.$kw = (pos, names, values) => {
  const [iterable, start] = bindArgs("enumerate", sig(["iterable", "start"]), pos, names, values);
  return enumNew(iterable, start);
};

// Earlier sources have already yielded on this row. If a later source ends,
// report it immediately; do not probe any following sources. If the first
// source ends, probe the others in order and stop at the first extra value.
function strictEnd(name: string, iterators: any[], endedIndex: number): any {
  const precedingArguments = (count: number) => `argument${count === 1 ? " " : "s 1-"}${count}`;
  if (endedIndex > 0) raise(T.ValueError, `${name}() argument ${endedIndex + 1} is shorter than ${precedingArguments(endedIndex)}`);
  for (let index = 1; index < iterators.length; index++) {
    if (iterators[index].$next() !== DONE) raise(T.ValueError, `${name}() argument ${index + 1} is longer than ${precedingArguments(index)}`);
  }
  // All sources ended together. Python raises a fresh, valueless
  // StopIteration here, so discard the sources' saved exceptions.
  O.lastStop.e = null;
  return DONE;
}

// Admission order is observable through strict.__bool__: validate keyword
// count, then names, then convert truth. Callers obtain source iterators later;
// map also checks its positional argument count only after this function.
function strictKeyword(name: "zip" | "map", names: string[], values: any[]): boolean {
  if (names.length > 1) raise(T.TypeError, `${name}() takes at most 1 keyword argument (${names.length} given)`);
  for (const keyword of names) if (keyword !== "strict") raise(T.TypeError, `${name}() got an unexpected keyword argument '${keyword}'`);
  let strict = false;
  names.forEach((_keyword, index) => (strict = O.truth(values[index])));
  return strict;
}

export class Zip {
  constructor(public its: any[], public strict: boolean) {}
  $next(): any {
    const iterators = this.its;
    if (iterators.length === 0) return DONE;
    const values = new Array(iterators.length);
    for (let index = 0; index < iterators.length; index++) {
      const value = iterators[index].$next();
      // Earlier values stay consumed; later sources are untouched unless
      // strictEnd must check them after the first source ends.
      if (value === DONE) return this.strict ? strictEnd("zip", iterators, index) : DONE;
      values[index] = value;
    }
    return tuple(values);
  }
}
const zip = iteratorType("zip", Zip, (...iterables: any[]) => new Zip(iterables.map(O.iter), false));
zip.$kw = (pos, names, values) => {
  const strict = strictKeyword("zip", names, values);
  return new Zip(pos.map(O.iter), strict);
};
(zip as any).$kwPos = true; // Route arbitrary-length positional calls through the keyword adapter too.

export class MapIter {
  constructor(public f: any, public its: any[], public strict = false) {}
  $next(): any {
    const args = new Array(this.its.length);
    for (let index = 0; index < this.its.length; index++) {
      const value = this.its[index].$next();
      if (value === DONE) return this.strict ? strictEnd("map", this.its, index) : DONE;
      args[index] = value;
    }
    // Call only after every source yielded; exhaustion never invokes f.
    const mapping = this.f;
    return typeof mapping === "function" ? mapping(...args) : callObj(mapping, args);
  }
}
const map = iteratorType("map", MapIter, (mapping: any, ...iterables: any[]) => {
  if (iterables.length === 0) raise(T.TypeError, "map() must have at least two arguments.");
  return new MapIter(mapping, iterables.map(O.iter));
});
map.$kw = (pos, names, values) => {
  const strict = strictKeyword("map", names, values);
  if (pos.length < 2) raise(T.TypeError, "map() must have at least two arguments.");
  return new MapIter(pos[0], pos.slice(1).map(O.iter), strict);
};
(map as any).$kwPos = true;

export class FilterIter {
  constructor(public f: any, public it: any) {}
  $next(): any {
    for (;;) {
      const value = this.it.$next();
      if (value === DONE) return DONE;
      if (this.f === null ? O.truth(value) : O.truth(callObj(this.f, [value]))) return value;
    }
  }
}
iteratorType("filter", FilterIter, (predicate: any, iterable: any) => new FilterIter(predicate, O.iter(iterable)));

// (a list's item past its end, read by reversed's getter: CPython's
// IndexError, which ends the iteration)
const PAST_END = {};
export class ReversedIter {
  // (its fields and methods are the runtime's, $-named, so that a subclass's
  // instance may have attributes of any name, as CPython's: $a the sequence,
  // $i the next index, $get the item getter, $size the sequence's current
  // length for __length_hint__, a list's storage, as list's own reverse
  // iterator, else len())
  constructor(public $a: any, public $i: number, public $get: (i: number) => any, public $size: () => number) {}
  // As CPython's reversed_next: the item at the index taken before the read,
  // and then that index less one (a getter that calls next on the same
  // iterator reads the same index again, and the outer read still moves on
  // by one from where it started). An IndexError or StopIteration from
  // reading it ends the iteration; any other error is raised and ends it
  // too. Once ended, the sequence is dropped, and the iteration stays ended
  // however the sequence grows. (Before, a list cleared or shortened under
  // the iterator gave a SystemError, and a getter's error was skipped over.)
  $next(): any {
    const index = this.$i;
    if (index >= 0) {
      let item: any;
      try {
        item = this.$get(index);
      } catch (e: any) {
        this.$end();
        const x = toPyExc(e);
        if (isinstance(x, T.IndexError) || isinstance(x, T.StopIteration)) return DONE;
        throw e;
      }
      if (item !== PAST_END) {
        this.$i = index - 1;
        return item;
      }
    }
    this.$end();
    return DONE;
  }
  $end(): void {
    this.$i = -1;
    this.$a = null;
    this.$get = () => PAST_END;
    this.$size = () => 0;
  }
}
iteratorType("reversed", ReversedIter, (sequence: any) => {
  // Retain the live array, with its initial length fixing the starting index.
  if (Array.isArray(sequence)) return new ReversedIter(sequence, sequence.length - 1, (index) => (index < sequence.length ? sequence[index] : PAST_END), () => sequence.length);
  // r is the reverse hook; gi below is the item getter. These local names
  // also occur in existing native errors for non-callable hooks.
  const r = lookupType(typeOf(sequence), "__reversed__");
  if (r === null) raise(T.TypeError, `'${typeName(sequence)}' object is not reversible`);
  if (r !== undefined) return r(sequence);
  const gi = lookupType(typeOf(sequence), "__getitem__");
  if (gi === undefined) raise(T.TypeError, `'${typeName(sequence)}' object is not reversible`);
  if (typeof sequence === "string") {
    // Copy Unicode code points, rather than indexing UTF-16 code units.
    const codePoints = [...sequence];
    return new ReversedIter(codePoints, codePoints.length - 1, (index) => codePoints[index], () => codePoints.length);
  }
  return new ReversedIter(sequence, O.len(sequence) - 1, (index) => gi(sequence, index), () => O.len(sequence));
});
// (CPython's reversed_len and listreviter_len: the index taken first; 0
// once ended, without asking the sequence; else the items left, the
// sequence's current length asked each time, 0 if it is now shorter)
method(T.reversed, "__length_hint__", (it: ReversedIter) => {
  const index = it.$i;
  if (index < 0 || it.$a === null) return 0;
  const size = it.$size(), position = index + 1;
  return size < position ? 0 : position;
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
    if (hasInstanceDict(x)) for (const k of attrNames(x)) names.add(k);
    for (const c of typeOf(x).$mro) for (const k of c.$dict.keys()) names.add(k);
  }
  return [...names].sort();
}

// Helpers for builtin modules.
export function lookupDunder(x: any, name: string): any {
  const f = lookupType(typeOf(x), name);
  return f !== null && typeof f === "object" && f.asDunder !== undefined ? f.asDunder() : f;
}
// float(x) for objects with __float__/__index__, or undefined: the hooks
// dispatched as special methods, their results checked (a strict subclass's
// with a DeprecationWarning), as CPython's
export function floatCallSafe(x: any): number | undefined {
  const t = typeOf(x);
  if (lookupType(t, "__float__") !== undefined) return O.floatResult(x, O.lookupSpecial(x, "__float__")(x));
  if (lookupType(t, "__index__") !== undefined) {
    const n = O.intResult("__index__", O.lookupSpecial(x, "__index__")(x));
    return typeof n === "bigint" ? O.bigToFloat(n) : n;
  }
  return undefined;
}
// PyFloat_AsDouble: a float (a subclass's value too) or an exact int or bool
// as it is; else __float__ (an int subclass's override), else __index__;
// else undefined
export function asDouble(x: any): number | undefined {
  if (typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" || x instanceof FloatBox || typeOf(x).$mro.includes(float)) return O.fv(x);
  return floatCallSafe(x);
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
  if (!isType(c) || c.$ctor === null || !hasInstanceDict(o) || c.$jsBase !== null || o.$cls.$jsBase !== null) raise(T.TypeError, "__class__ assignment only supported for mutable types or ModuleType subclasses");
  Object.setPrototypeOf(o, c.$ctor!.prototype);
});
getset(object, "__dict__", (o) => {
  if (!hasInstanceDict(o)) raise(T.AttributeError, `'${typeName(o)}' object has no attribute '__dict__'`);
  return instanceDict(o);
}, (o, v) => {
  if (!hasInstanceDict(o)) raise(T.AttributeError, `'${typeName(o)}' object has no attribute '__dict__'`);
  if (!(v instanceof PyDict)) raise(T.TypeError, `__dict__ must be set to a dictionary, not a '${typeName(v)}'`);
  const items = [...v.$m].map(([k, x]) => [dictKeyOf(v, k), x]);
  // (the dict it had keeps what it had, as CPython's: whoever holds it, and
  // an iterator over it, go on there; the instance has a new one)
  detachInstanceDict(o);
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
  const latinOf = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.length).toString("latin1");
  // (the methods' arguments by kind, converted in CPython's clinic order: b
  // bytes-like, b? bytes-like or None, c a fill byte, i a Py_ssize_t, t a C
  // int (a tab size), * as it is; a kind ending in ! after all the others, as an
  // object the method itself converts: split's sep after maxsplit)
  const BYTES_ARGS: Record<string, string[]> = {
    split: ["b?!", "i"], rsplit: ["b?!", "i"], strip: ["b?"], lstrip: ["b?"], rstrip: ["b?"], partition: ["b"], rpartition: ["b"],
    replace: ["b", "b", "i"], removeprefix: ["b"], removesuffix: ["b"], center: ["i", "c"], ljust: ["i", "c"], rjust: ["i", "c"],
    zfill: ["i"], expandtabs: ["t"], splitlines: ["*"],
  };
  const names = ["split", "rsplit", "strip", "lstrip", "rstrip", "partition", "rpartition", "replace", "index", "rindex", "find", "rfind", "count", "startswith", "endswith", "upper", "lower", "splitlines", "center", "ljust", "rjust", "zfill", "isdigit", "isalpha", "isspace", "isalnum", "isupper", "islower", "title", "capitalize", "swapcase", "removeprefix", "removesuffix", "expandtabs", "join"];
  for (const [bt, Cls] of [[T.bytes, PyBytes], [T.bytearray, PyByteArray]] as const) {
    for (const name of names) {
      const f = S.$dict.get(name);
      if (f === undefined) throw new Error(`internal: str.${name} missing`);
      const intArg = ["index", "rindex", "find", "rfind", "count"].includes(name);
      const m = function (self: PyBytes, ...args: any[]) {
        // (each item bytes-like: a memoryview too)
        if (name === "join") return back(f(latin(self), O.toArray(args[0]).map((v, i) => {
          const b = typeof v === "string" ? undefined : O.bufferOf(v);
          if (b === undefined) raise(T.TypeError, `sequence item ${i}: expected a bytes-like object, ${typeName(v)} found`);
          return latinOf(b);
        })), Cls);
        // (bytes' startswith and endswith: a bytes-like object or a tuple of
        // them, each checked only when reached, with CPython's messages)
        if (name === "startswith" || name === "endswith") {
          const bytesLike = (x: any): string | undefined => {
            const b = typeof x === "string" ? undefined : O.bufferOf(x);
            return b === undefined ? undefined : Buffer.from(b.buffer, b.byteOffset, b.length).toString("latin1");
          };
          // (start and end converted once, first, as for str: plain numbers
          // after that, which str's method takes as they are)
          const [x, ...raw] = args;
          const rest = raw.map((v) => (v === undefined || v === null ? v : O.sliceIndex(v, 0)));
          if (isinstance(x, T.tuple)) {
            for (const p of x as any[]) {
              const t = bytesLike(p);
              if (t === undefined) raise(T.TypeError, `a bytes-like object is required, not '${typeName(p)}'`);
              if (f(latin(self), t, ...rest)) return true;
            }
            return false;
          }
          const t = bytesLike(x);
          if (t === undefined) raise(T.TypeError, `${name} first arg must be bytes or a tuple of bytes, not ${typeName(x)}`);
          return f(latin(self), t, ...rest);
        }
        // (each argument converted as CPython's clinic does, whether or not
        // it is needed: bytes-like ones through the buffer protocol, a
        // fill byte, None where it means the default; astra3 A08, A09)
        const kinds = BYTES_ARGS[name];
        if (kinds !== undefined) {
          // (a bytes-like argument held as its live view, a bytearray's
          // export counted, until every argument is converted: a later
          // __index__ may write into it, not resize it, as CPython's Py_buffer)
          // (a memoryview's or array's bytes are a copy, with no export
          // held: one taken before an argument whose conversion runs Python
          // code, which could write into or release its exporter, is
          // refused, never an answer from the copy, astra CORR-3C7-5)
          const out = args.slice();
          const held: any[] = [];
          let copied = false;
          // (an int or int subclass is taken by its value, a builtin
          // buffer by its bytes: only another object's __index__ or
          // __buffer__ runs Python code)
          const runsCode = (a: any, k: string) =>
            k === "i" || k === "t" ? !(typeof a === "number" || typeof a === "bigint" || typeof a === "boolean" || typeOf(a).$mro.includes(T.int)) : k === "c" ? false : !(a instanceof PyBytes) && (typeOf(a) as any).$heap === true;
          try {
            const one = (i: number) => {
              const a = args[i], k = (kinds[i] ?? "*").replace("!", "");
              if (a === undefined || k === "*" || (k === "b?" && a === null)) return;
              if (copied && runsCode(a, k)) raise(T.NotImplementedError, `${typeName(self)}.${name}() with a memoryview or array argument before one converted by Python code is not supported yet`);
              if (k === "i") out[i] = AC.ssizeArg(a);
              else if (k === "t") out[i] = AC.cIntArg(a);
              else if (k === "c") out[i] = String.fromCharCode(AC.byteCharArg(name, `argument ${i + 1}`, a));
              else {
                out[i] = AC.bufferArg(a);
                if (a instanceof PyByteArray) {
                  a.$exports++;
                  held.push(a);
                } else if (!(a instanceof PyBytes)) copied = true;
              }
            };
            for (let i = 0; i < args.length; i++) if (!(kinds[i] ?? "").endsWith("!")) one(i);
            for (let i = 0; i < args.length; i++) if ((kinds[i] ?? "").endsWith("!")) one(i);
            for (let i = 0; i < out.length; i++) if (out[i] instanceof Uint8Array) out[i] = latinOf(out[i]);
          } finally {
            for (const a of held) a.$exports--;
          }
          // (a bytes object past Py_ssize_t's limit: CPython's _PyBytes_FromSize)
          if (Cls === PyBytes && kinds[0] === "i" && name !== "split" && name !== "rsplit" && out[0] !== undefined && BigInt(out[0]) > 2n ** 63n - 34n) raise(T.OverflowError, "byte string is too large");
          const r = f(latin(self), ...out);
          if (Cls === PyBytes && typeof r === "string" && r.length === self.n && /strip|just|center|zfill|remove/.test(name)) return self;
          return back(r, Cls);
        }
        // (find, rfind, index, rindex and count: start and end first, each
        // converted once, as slice indices, then the subject: an int byte or
        // bytes-like; index's and rindex's "subsection not found")
        if (intArg) {
          const idx = args.slice(1).map((a) => (a === undefined ? a : O.sliceIndexExact(a)));
          const a = args[0];
          let sub: string;
          if (O.isPyInt(a)) {
            const v = Number(a);
            if (!(v >= 0 && v < 256)) raise(T.ValueError, "byte must be in range(0, 256)");
            sub = String.fromCharCode(v);
          } else {
            const b = typeof a === "string" ? undefined : O.bufferOf(a);
            if (b === undefined) raise(T.TypeError, `argument should be integer or bytes-like object, not '${typeName(a)}'`);
            sub = latinOf(b);
          }
          if (name === "index" || name === "rindex") {
            const j = S.$dict.get(name === "index" ? "find" : "rfind")(latin(self), sub, ...idx);
            if (j < 0) raise(T.ValueError, "subsection not found");
            return j;
          }
          return f(latin(self), sub, ...idx);
        }
        const conv = args.map((a, i) => {
          // (find, rfind, index, rindex and count: after the subject, start
          // and end, slice indices, which str's method checks)
          if (intArg && i >= 1) return a;
          if (intArg && i === 0 && O.isPyInt(a)) {
            const v = Number(a);
            if (!(v >= 0 && v < 256)) raise(T.ValueError, "byte must be in range(0, 256)");
            return String.fromCharCode(v);
          }
          if (intArg && i === 0) return latinOf(AC.bufferArg(a));
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
  // int.from_bytes(bytes, byteorder="big", *, signed=False) as CPython's
  // int_from_bytes_impl: the byte order checked, then the bytes as
  // PyObject_Bytes gives them, then the value, linear, from their hex
  // digits (a shift per byte was quadratic: 136 ms for 42 KB), made the
  // class's (a subclass called with it, bool's a bool)
  T.int.$dict.set("from_bytes", new PyClassMethod(pyfn((cls: any, b: any, byteorder: any = "big", signed: any = false) => {
    const order = byteorderStr("from_bytes", byteorder);
    const isSigned = O.truth(signed);
    const little = littleEndian(order);
    const a = objectBytes(b);
    const n = a.length;
    let hex = "";
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      if ((i & 65535) === 65535) O.pollInterrupt();
      const d = a[little ? n - 1 - i : i];
      hex += d < 16 ? "0" + d.toString(16) : d.toString(16);
      if (hex.length >= 65536) parts.push(hex), (hex = "");
    }
    parts.push(hex);
    let v = n ? BigInt("0x" + parts.join("")) : 0n;
    if (isSigned && n && a[little ? n - 1 : 0] >= 128) v -= 1n << BigInt(8 * n);
    const r = O.normBig(v);
    return cls === T.int ? r : callObj(cls, [r]);
  }, "from_bytes", sig(["cls", "bytes", "byteorder"], { kwonly: ["signed"] }))));
  // (as CPython's oserror_init: with 2 to 5 arguments, errno, strerror,
  // filename, winerror and filename2, the args then only the first two
  // once a filename is given; an exact BlockingIOError's numeric third
  // argument is characters_written instead)
  // (characters_written as PyNumber_AsSsize_t converts it: an index, and a
  // ValueError past the signed 64-bit range, CORR-D77-5)
  const writtenOf = (v: any): any => {
    const k = O.index(v);
    const b = typeof k === "bigint" ? k : BigInt(k);
    if (b < -(2n ** 63n) || b >= 2n ** 63n) raise(T.ValueError, `cannot fit '${typeName(v)}' into an index-sized integer`);
    return k;
  };
  method(T.OSError, "__init__", (self: any, ...args: any[]) => {
    self.args = tuple(args);
    self.errno = self.strerror = self.filename = null;
    if (args.length >= 2 && args.length <= 5) {
      self.errno = args[0];
      self.strerror = args[1];
      const f = args.length >= 3 ? args[2] : null;
      if (f !== null) {
        if (typeOf(self) === T.BlockingIOError && (O.isPyInt(unbox(f)) || O.isPyFloat(unbox(f)))) {
          Object.defineProperty(self, "$written", { value: writtenOf(f), writable: true, configurable: true });
        } else {
          self.filename = f;
          if (args.length >= 5 && args[4] !== null) Object.defineProperty(self, "$filename2", { value: args[4], writable: true, configurable: true });
          self.args = tuple([args[0], args[1]]);
        }
      }
    }
    return null;
  });
  getset(T.OSError, "filename2", (self: any) => self.$filename2 ?? null, (self: any, v: any) => void Object.defineProperty(self, "$filename2", { value: v, writable: true, configurable: true }));
  // (a C Py_ssize_t there: -1 is unset, as on reading, CORR-D77-5)
  getset(
    T.BlockingIOError,
    "characters_written",
    (self: any) => (self.$written === undefined || self.$written === -1 ? raise(T.AttributeError, "characters_written") : self.$written),
    (self: any, v: any) => void Object.defineProperty(self, "$written", { value: writtenOf(v), writable: true, configurable: true }),
  );
  method(T.OSError, "__str__", (self: any) => {
    if (self.errno === null || self.errno === undefined) return T.BaseException.$dict.get("__str__")(self);
    const f = self.filename !== null && self.filename !== undefined ? `: ${repr(self.filename)}${self.$filename2 !== undefined && self.$filename2 !== null ? ` -> ${repr(self.$filename2)}` : ""}` : "";
    return `[Errno ${str(self.errno)}] ${str(self.strerror)}${f}`;
  });
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
    // (a modulus: ints only, int's NotImplemented for another, float's
    // CPython's TypeError; it recursed through the float's own __pow__,
    // astra3 A13)
    method(cls, "__pow__", (a: any, b: any, m: any = null) => {
      b = unbox(b);
      if (!ok(b)) return NotImplemented;
      if (m === null) return O.pow(unbox(a), b);
      if (!intOnly) raise(T.TypeError, "pow() 3rd argument not allowed unless all arguments are integers");
      m = unbox(m);
      return O.isPyInt(m) ? O.pow(unbox(a), b, m) : NotImplemented;
    });
    method(cls, "__rpow__", (a: any, b: any, m: any = null) => {
      b = unbox(b);
      if (!ok(b)) return NotImplemented;
      if (m === null) return O.pow(b, unbox(a));
      if (!intOnly) raise(T.TypeError, "pow() 3rd argument not allowed unless all arguments are integers");
      m = unbox(m);
      return O.isPyInt(m) ? O.pow(b, unbox(a), m) : NotImplemented;
    });
    if (intOnly) {
      bin("lshift", O.lshift);
      bin("rshift", O.rshift);
      bin("and", O.and);
      bin("or", O.or);
      bin("xor", O.xor);
      method(cls, "__invert__", (a: any) => O.invert(unbox(a)));
    }
    // (int's take only ints, float's ints and floats: int.__eq__(1, 1.0) is
    // NotImplemented, as CPython's long_richcompare; astra3 A01)
    for (const [n, f] of [["eq", O.eq], ["ne", O.ne], ["lt", O.lt], ["le", O.le], ["gt", O.gt], ["ge", O.ge]] as const) {
      method(cls, `__${n}__`, (a: any, b: any) => ((b = unbox(b)), ok(b) ? f(unbox(a), b) : NotImplemented));
    }
    method(cls, "__neg__", (a: any) => O.neg(unbox(a)));
    method(cls, "__pos__", (a: any) => O.pos(unbox(a)));
    method(cls, "__abs__", (a: any) => O.abs(unbox(a)));
    method(cls, "__bool__", (a: any) => O.truth(unbox(a)));
  };
  numDunders(int, O.isPyInt, true);
  numDunders(float, isNum, false);
  method(S, "__ne__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? s !== x : NotImplemented));
  method(S, "__le__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? O.strCmp(s, x) <= 0 : NotImplemented));
  method(S, "__gt__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? O.strCmp(s, x) > 0 : NotImplemented));
  method(S, "__ge__", (s: string, x: any) => ((x = unbox(x)), typeof x === "string" ? O.strCmp(s, x) >= 0 : NotImplemented));
  method(S, "__rmul__", (s: string, x: any) => O.strRepeat(s, O.ssizeCount(unbox(x))));
}

// int, float, str: the subclass instance boxes the value.
const proxies = new Map<PyType, PyType>();
function unboxing(f: any): any {
  const w = function (self: any, ...args: any[]) {
    return f(unbox(self), ...args.map(unbox));
  };
  pyfn(w, f.__name__, f.$sig ?? null);
  (w as any).$builtinMethod = true;
  (w as any).$owner = f.$owner; // (the base type's: a str subclass's upper is str's, checked as str's)
  (w as any).__qualname__ = f.__qualname__;
  (w as any).$unboxing = true;
  (w as any).$orig = f; // (as Python sees it: the base's own, selfChecked)
  return w;
}
hooks.primProxy = (base: PyType): PyType => {
  let px = proxies.get(base);
  if (px !== undefined) return px;
  const d = new Map<string, any>();
  for (const [k, v] of base.$dict) {
    if (k === "__new__" || k === "__init__") continue;
    if (typeof v === "function" && v.$builtinMethod === true) d.set(k, unboxing(v));
    else if (v instanceof GetSet) d.set(k, Object.assign(new GetSet(v.owner, v.name, (o) => v.get(unbox(o)), v.set), { $orig: v }));
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
    (fmtW as any).$owner = int;
    (fmtW as any).$unboxing = true;
    (fmtW as any).$orig = f0.$orig;
    d.set("__format__", fmtW);
  }
  px = { $name: base.$name, $qualname: base.$name, $module: "builtins", $dict: d, $bases: [], $mro: [], $subclasses: [], $ver: 0, $hidden: true } as any;
  px!.$mro = [px!, ...base.$mro];
  proxies.set(base, px!);
  return px!;
};
for (const [P, L] of [[int, IntLayout], [float, FloatLayout], [S, StrLayout]] as const) {
  P.$jsBase = L;
  // (a subclass's instance boxes the value: the exact one, as CPython's
  // unicode_subtype_new copies it, when P gave a subclass instance, as
  // str() does for a __str__ returning one, CORR-B14-1; never a box in a
  // box)
  const box = (cls: any, v: any) => {
    if (cls === P) return v;
    if (v instanceof PrimBox) v = v.$v;
    if (v instanceof PrimBox) throw new Error(`internal: a boxed ${P.$name} inside a ${cls.$name}`);
    const o = new cls.$ctor!();
    o.$v = v;
    return o;
  };
  allocator(P, (cls: any, ...args: any[]) => box(cls, P(...args)), (pos, names, values) => box(pos[0], callKw(P, pos.slice(1), names, values)));
}
getset(type, "__mro__", (c) => tuple(c.$mro.filter((x: any) => !x.$hidden)));
method(type, "mro", (c: any) => c.$mro.filter((x: any) => !x.$hidden));

// Types whose instances are runtime JS objects: a subclass instance is the
// base type's object re-prototyped onto the subclass.
// `fields`: the layout's own implementation property names (not Python attributes).
export function subclassable(P: PyType, jsClass: any, fields: string[] = []) {
  P.$jsBase = jsClass;
  if (fields.length) P.$impl = new Set(fields);
  // (a subclass's instance is the base type's object, re-prototyped)
  const adopt = (cls: any, o: any) => {
    if (cls !== P) Object.setPrototypeOf(o, cls.$ctor!.prototype);
    return o;
  };
  allocator(P, (cls: any, ...args: any[]) => adopt(cls, P(...args)), (pos, names, values) => adopt(pos[0], callKw(P, pos.slice(1), names, values)));
}
subclassable(bytesType, PyBytes, ["a", "n"]);
subclassable(bytearray, PyByteArray, ["a", "n"]);
// bytearray.__new__ makes an empty one, and __init__ fills it, as CPython's
// (its __new__ gave the filled bytearray, so __new__(bytearray, b"xy") had 2)
{
  const empty = (cls: any) => {
    const o = new PyByteArray(new Uint8Array(0));
    if (cls !== bytearray) Object.setPrototypeOf(o, cls.$ctor!.prototype);
    return o;
  };
  allocator(bytearray, (cls: any, ..._args: any[]) => empty(cls), (pos) => empty(pos[0]));
  method(bytearray, "__init__", (b: PyByteArray, source: any = undefined, encoding: any = undefined, errors: any = undefined) => {
    // (emptied, then filled, as CPython's: each a re-size, refused while
    // exported, and a bad source leaves it empty; but bad encoding or
    // errors types are refused first, leaving it as it was)
    codecArgs(true, encoding, errors);
    if (b.n !== 0) checkResizable(b);
    b.n = 0;
    // (under an export, refused as soon as it would grow: an exact list or
    // tuple before its items are converted, another iterable after its
    // first item, a count before its allocation, as CPython's; HARD-CBE-1)
    if (b.$exports > 0 && source !== undefined && (typeOf(source) === T.list || typeOf(source) === T.tuple) && source.length > 0) checkResizable(b);
    const a = toBytes(source, encoding, errors, true, b.$exports > 0 ? (n) => { if (n !== 0) checkResizable(b); } : undefined);
    if (a.length !== 0) checkResizable(b);
    b.a = a;
    b.n = a.length;
    return null;
  }, sig(["self", "source", "encoding", "errors"]));
}
subclassable(T.map, MapIter, ["f", "its", "strict"]);
subclassable(T.filter, FilterIter, ["f", "it"]);
subclassable(T.zip, Zip, ["its", "strict"]);
subclassable(T.enumerate, Enumerate, ["it", "i"]);
subclassable(T.reversed, ReversedIter);
subclassable(staticmethod, PyStaticMethod, ["f"]);
subclassable(classmethod, PyClassMethod, ["f"]);
// property subclasses commonly override __init__ and call super().__init__.
property.$jsBase = PyProperty;
allocator(property, (cls: PyType, ..._args: any[]) => {
  const o = cls === property ? new PyProperty(null, null, null, null) : new cls.$ctor!();
  o.fget = o.fset = o.fdel = o.doc = null;
  return o;
});
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
    fields.forEach((f, i) => d.set(f, new GetSet(cls!, f, (o) => o[i])));
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
// (its own methods, doing what a generator's do: a method is its owner's
// alone, and checks for it, so the generator's cannot be shared)
for (const n of ["send", "throw", "close"]) {
  const g = generator.$dict.get(n);
  const f = method(coroutine, n, (c: any, ...a: any[]) => g(c, ...a), g.$sig ?? null);
  if (g.$kw !== undefined) f.$kw = (pos: any[], names: string[], values: any[]) => g.$kw(pos, names, values);
}
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
    // (as attributes are set: a name is a string, and never one of the runtime's own)
    const put = (k: any, v: any) => {
      if (typeof k !== "string") raise(T.TypeError, `keywords must be strings, not '${typeName(k)}'`);
      setattr(self, k, v);
    };
    if (pos.length === 2) O.forEach(callObj(T.dict, [pos[1]]), (k: any) => put(k, O.getitem(pos[1], k)));
    names.forEach((n, i) => put(n, values[i]));
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
// (X | Y: the union, or NotImplemented; GenericAlias's | too)
let unionOf: (a: any, b: any) => any;
{
  const unionArg = (x: any): any[] | undefined => {
    if (x === null) return [T.NoneType];
    if (isType(x) || x instanceof PyGenericAlias) return [x];
    if (x instanceof PyUnion) return x.args;
    return undefined;
  };
  const make = (a: any, b: any): any => {
    const x = unionArg(a), y = unionArg(b);
    if (x === undefined || y === undefined) return NotImplemented;
    const args: any[] = [];
    // (an alias equal to one already there is a duplicate, as CPython's)
    const same = (s: any, t: any) => s === t || (s instanceof PyGenericAlias && t instanceof PyGenericAlias && O.truth(O.eq(s, t)));
    for (const t of [...x, ...y]) if (!args.some((s) => same(s, t))) args.push(t);
    return args.length === 1 ? args[0] : new PyUnion(args);
  };
  unionOf = make;
  method(type, "__or__", (a: any, b: any) => make(a, b));
  method(type, "__ror__", (a: any, b: any) => make(b, a));
  method(unionType, "__or__", (a: any, b: any) => make(a, b));
  method(unionType, "__ror__", (a: any, b: any) => make(b, a));
  method(unionType, "__repr__", (u: PyUnion) => u.args.map((t) => (t === T.NoneType ? "None" : t instanceof PyGenericAlias ? repr(t) : t.$module === "builtins" ? t.$qualname : `${t.$module}.${t.$qualname}`)).join(" | "));
  // (a GenericAlias member: equal by value, hashed by value)
  const same = (a: any, b: any) => a === b || (a instanceof PyGenericAlias && O.truth(O.eq(a, b)));
  method(unionType, "__eq__", (u: PyUnion, o: any) => (o instanceof PyUnion ? u.args.length === o.args.length && u.args.every((t) => o.args.some((x) => same(t, x))) : NotImplemented));
  method(unionType, "__hash__", (u: PyUnion) => u.args.reduce((h, t) => h ^ (t instanceof PyGenericAlias ? O.hashExact(t) : O.id(t)), 0));
  // (each member in order through the whole protocol, stopping at the
  // first that holds, as isinstance() with a tuple: an alias raises only
  // when it is reached)
  method(unionType, "__instancecheck__", (u: PyUnion, x: any) => u.args.some((t) => hooks.isinstance(x, t)));
  method(unionType, "__subclasscheck__", (u: PyUnion, c: any) => u.args.some((t) => hooks.issubclass(c, t)));
  getset(unionType, "__args__", (u: PyUnion) => tuple(u.args));
}

// types.GenericAlias: list[int] and the like, as CPython's
// Objects/genericaliasobject.c: __origin__ and __args__, CPython's repr,
// equality and hash by value, the origin's other attributes, calling it
// makes an origin instance (its __orig_class__ set), a base class through
// __mro_entries__, never an isinstance() class. Substituting type variables
// isn't done yet: refused.
export class PyGenericAlias {
  // (starred: *list[int], what unpacking an alias gives; params: the
  // computed __parameters__, kept once computed)
  starred = false;
  params: any[] | undefined = undefined;
  constructor(public origin: any, public args: any[]) {}
}
// (the __class_getitem__ of the builtins that are generic, as CPython 3.14's:
// it makes the alias; memoryview's set by src/runtime/memoryview.ts)
export const genericClassGetitem = new PyClassMethod(builtin((cls: any, item: any) => new PyGenericAlias(cls, isinstance(item, T.tuple) ? [...item] : [item]), "__class_getitem__"));
export const genericAliasType = builtinTypeFor("GenericAlias", PyGenericAlias, "types", (...a: any[]) => {
  if (a.length !== 2) raise(T.TypeError, `GenericAlias expected 2 arguments, got ${a.length}`);
  const [origin, args] = a;
  return new PyGenericAlias(origin, isinstance(args, T.tuple) ? [...args] : [args]);
});
T.GenericAlias = genericAliasType;
{
  const ga = genericAliasType;
  // (the names an alias answers itself; every other its origin's)
  const OWN = new Set(["__class__", "__bases__", "__origin__", "__args__", "__unpacked__", "__parameters__", "__typing_unpacked_tuple_args__", "__mro_entries__", "__reduce_ex__", "__reduce__", "__copy__", "__deepcopy__"]);
  // (an attribute, or undefined for an AttributeError)
  const attr = (o: any, name: string): any => {
    try {
      return getattr(o, name);
    } catch (e: any) {
      if (!isinstance(toPyExc(e), T.AttributeError)) throw e;
      return undefined;
    }
  };
  // (an item of the repr, as CPython's ga_repr_item: ... for Ellipsis, an
  // alias's (anything with __origin__ and __args__) own repr, a class or
  // function by its __module__ and __qualname__, without "builtins.",
  // anything else its repr; an argument that is a list, its items so in
  // brackets, only at the top: a list in it is its repr, as
  // ga_repr_items_list, so a list holding itself is [[...]] inside)
  const argRepr = (t: any): string => (Array.isArray(t) && typeOf(t) === T.list ? `[${t.map(typeRepr).join(", ")}]` : typeRepr(t));
  // (a class too through its attributes: a metaclass may answer them)
  const typeRepr = (t: any): string => {
    if (t === Ellipsis) return "...";
    if (attr(t, "__origin__") !== undefined && attr(t, "__args__") !== undefined) return repr(t);
    const qn = attr(t, "__qualname__");
    if (qn === undefined) return repr(t);
    const m = attr(t, "__module__");
    if (m === undefined || m === null) return repr(t);
    return m === "builtins" ? str(qn) : `${str(m)}.${str(qn)}`;
  };
  method(ga, "__repr__", (a: PyGenericAlias) => `${a.starred ? "*" : ""}${typeRepr(a.origin)}[${a.args.length ? a.args.map(argRepr).join(", ") : "()"}]`);
  method(ga, "__getattribute__", (a: PyGenericAlias, name: string) => (OWN.has(name) ? genericGetattr(a, name, typeOf(a)) : getattr(a.origin, name)));
  getset(ga, "__origin__", (a) => a.origin);
  getset(ga, "__args__", (a) => tuple(a.args));
  getset(ga, "__unpacked__", (a) => a.starred);
  getset(ga, "__typing_unpacked_tuple_args__", (a) => (a.starred && a.origin === T.tuple ? tuple(a.args) : null));
  // (unpacking, *list[int]: one starred alias, as CPython's ga_iter)
  method(ga, "__iter__", (a: PyGenericAlias) => {
    const s = new PyGenericAlias(a.origin, a.args);
    s.starred = true;
    return O.iter([s]);
  });
  // (the type variables among the args, nested ones too, in order, each
  // once: what has __typing_subst__, or an arg's own __parameters__; lists
  // and tuples descended without the JS stack, and one holding itself a
  // RecursionError, as CPython's _Py_make_parameters, which recurses)
  const params = (args: any[]): any[] => {
    const out: any[] = [];
    const have = new Set<any>();
    const push = (p: any) => {
      if (!have.has(p)) {
        have.add(p);
        out.push(p);
      }
    };
    const path = new Set<any>([args]);
    const stack: [any[], number][] = [[args, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top[1] >= top[0].length) {
        path.delete(top[0]);
        stack.pop();
        continue;
      }
      const t = top[0][top[1]++];
      if (isType(t)) continue;
      if (Array.isArray(t) && (isinstance(t, T.list) || isinstance(t, T.tuple))) {
        if (path.has(t)) raise(T.RecursionError, "maximum recursion depth exceeded in __parameter__ calculation");
        path.add(t);
        stack.push([t, 0]);
        continue;
      }
      if (attr(t, "__typing_subst__") !== undefined) {
        push(t);
        continue;
      }
      const sub = attr(t, "__parameters__");
      if (sub !== undefined && isinstance(sub, T.tuple)) for (const p of sub) push(p);
    }
    return out;
  };
  // (computed once, when first asked for and it succeeds, then kept)
  const paramsOf = (a: PyGenericAlias): any[] => (a.params ??= tuple(params(a.args)));
  getset(ga, "__parameters__", paramsOf);
  method(ga, "__mro_entries__", (a: PyGenericAlias, _bases: any) => tuple([a.origin]));
  method(ga, "__eq__", (a: PyGenericAlias, o: any) => {
    if (!(o instanceof PyGenericAlias)) return NotImplemented;
    if (a.starred !== o.starred) return false;
    return O.truth(O.eq(a.origin, o.origin)) && O.truth(O.eq(tuple(a.args), tuple(o.args)));
  });
  method(ga, "__hash__", (a: PyGenericAlias) => O.hashExact(a.origin) ^ O.hashExact(tuple(a.args)));
  method(ga, "__or__", (a: any, b: any) => unionOf(a, b));
  method(ga, "__ror__", (a: any, b: any) => unionOf(b, a));
  method(ga, "__instancecheck__", (_a: any, _o: any) => raise(T.TypeError, "isinstance() argument 2 cannot be a parameterized generic"));
  method(ga, "__subclasscheck__", (_a: any, _o: any) => raise(T.TypeError, "issubclass() argument 2 cannot be a parameterized generic"));
  method(ga, "__getitem__", (a: PyGenericAlias, _k: any) => {
    if (paramsOf(a).length === 0) raise(T.TypeError, `${repr(a)} is not a generic class`);
    raise(T.NotImplementedError, `substituting the type variables of ${repr(a)} is not supported yet`);
  });
  // (by its own type: a subclass's instance copies as one)
  method(ga, "__reduce__", (a: PyGenericAlias) => {
    if (a.starred) raise(T.NotImplementedError, `reducing an unpacked alias (${repr(a)}) is not supported yet`);
    return tuple([typeOf(a), tuple([a.origin, tuple(a.args)])]);
  });
  method(ga, "__dir__", (a: PyGenericAlias) => {
    const names = new Set<string>([...O.toArray(callObj(hooks.importModule("builtins").dir, [a.origin])), ...OWN]);
    return [...names].sort();
  });
  const call = (a: PyGenericAlias, pos: any[], names: string[], values: any[]) => {
    const r = callKw(a.origin, pos, names, values);
    try {
      setattr(r, "__orig_class__", a);
    } catch (e: any) {
      const pe = toPyExc(e);
      if (!isinstance(pe, T.AttributeError) && !isinstance(pe, T.TypeError)) throw e;
    }
    return r;
  };
  const callFn: any = method(ga, "__call__", (a: PyGenericAlias, ...pos: any[]) => call(a, pos, [], []));
  // (by keyword: the receiver checked as method()'s own path checks it)
  callFn.$kw = (pos: any[], names: string[], values: any[]) => {
    if (!(pos[0] instanceof PyGenericAlias)) raise(T.TypeError, `descriptor '__call__' for 'types.GenericAlias' objects doesn't apply to a '${typeName(pos[0])}' object`);
    return call(pos[0], pos.slice(1), names, values);
  };
  callFn.$kwPos = true;
  // (subclassed by collections.abc's _CallableGenericAlias)
  subclassable(ga, PyGenericAlias, ["origin", "args"]);
  // (the builtins that are generic, as CPython 3.14's: their
  // __class_getitem__ makes the alias)
  for (const c of [T.list, T.tuple, T.dict, T.set, T.frozenset, T.enumerate, T.classmethod, T.staticmethod]) c.$dict.set("__class_getitem__", genericClassGetitem);
  // (its __getattribute__ now in effect)
  bumpVersion(ga);
}

// Pickling support as in CPython's Objects/typeobject.c (reduce_newobj).
{
  const copyreg = () => hooks.importModule("copyreg");
  const getstate = method(object, "__getstate__", (self: any) => {
    let state: any = null;
    if (hasInstanceDict(self)) {
      const d = new PyDict();
      // (the attribute dict: never a layout's own storage, as a bytes
      // subclass's buffer, which a pickle would restore as attributes)
      for (const k of attrNames(self)) dictSet(d, k, self[k]);
      if (d.$m.size) state = d;
    }
    // (__slots__' values as CPython's object_getstate_default: those set,
    // by copyreg._slotnames, then (state, slots))
    const cls = typeOf(self);
    if (cls.$mro.some((c: any) => c.$dict.has("__slots__"))) {
      const slots = new PyDict();
      for (const n of O.toArray(callObj(getattr(copyreg(), "_slotnames"), [cls]))) {
        try {
          dictSet(slots, n, getattr(self, n));
        } catch (e) {
          if (!isinstance(e, T.AttributeError)) throw e;
        }
      }
      if (slots.$m.size) state = tuple([state, slots]);
    }
    return state;
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

// The dunders a builtin type defines as methods, not through its slot:
// method_descriptor in CPython, not wrapper_descriptor (CORR-D77-3)
for (const [t, name] of [[dict, "__getitem__"], [dict, "__contains__"], [list, "__getitem__"], [set, "__contains__"], [frozenset, "__contains__"]] as const) {
  const f = t.$dict.get(name);
  if (f !== undefined) f.$methodDescr = true;
}
