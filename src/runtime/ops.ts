// Operators, comparison, hashing, truthiness, iteration and subscripting.
// Fast paths come first and only perform JS operations on already-checked
// types, so their V8 feedback stays clean when inlined into compiled code.

import * as SP from "./strpos";
import {
  T, markRaised, FloatBox, DONE, NotImplemented, PyDict, PyType, typeOf, typeName, lookupType, raise, isType, tuple, callObj, getattr, typeGetattr, isinstance,
  dictGet, dictSet, dictDelete, dictKeyOf, dictMeta, DictMeta, hooks, PyBytes, PyByteArray, checkResizable, PrimBox, table, handledExceptions,
} from "./object";
import { glibcPow } from "./libm";
import { consumeCtrlC } from "./interrupt";

const isInt = Number.isInteger;
const isSafe = Number.isSafeInteger;
const MINB = -9007199254740991n;
const MAXB = 9007199254740991n;

// Instances of Python subclasses of list/tuple/dict carry `$cls` on their
// prototype; plain values take the fast paths.
export const plainArr = (o: any): boolean => o.$cls === undefined;

const LAYOUT_DUNDERS = ["__len__", "__getitem__", "__setitem__", "__delitem__", "__iter__", "__contains__", "__eq__", "__ne__", "__lt__", "__le__", "__gt__", "__ge__", "__add__", "__mul__", "__bool__", "__hash__", "__repr__"];
// A subclass of list/tuple/dict/set that overrides none of the base type's
// dunders behaves exactly like its base for the operator fast paths.
export function layoutPlain(t: any): boolean {
  if (t.$lpVer === t.$ver) return t.$lp;
  const base = t.$mro.find((c: any) => c.$ctor === null && c.$jsBase !== undefined && c.$jsBase !== null);
  t.$lpVer = t.$ver;
  t.$lp = base !== undefined && LAYOUT_DUNDERS.every((n) => lookupType(t, n) === lookupType(base, n));
  return t.$lp;
}
export const plainDict = (o: any): boolean => o.$cls === T.dict;
// Sets and frozensets themselves: a subclass's operators may be its own.
const exactSet = (o: any): boolean => o instanceof PySet && (o.$cls === T.set || o.$cls === T.frozenset);
const exactSets = (a: any, b: any): boolean => exactSet(a) && exactSet(b);
// (and in place only into a set: a frozenset's |= makes a new one)
const inplaceSets = (a: any, b: any): boolean => a instanceof PySet && a.$cls === T.set && exactSet(b);

export const normBig = (r: bigint): number | bigint => (r >= MINB && r <= MAXB ? Number(r) : r);
export const mkfloat = (r: number): any => (isInt(r) ? new FloatBox(r) : r);
export const fbox = (v: number) => new FloatBox(v);
const big = (x: any): bigint => (typeof x === "bigint" ? x : BigInt(x));

export function isPyInt(x: any): boolean {
  const t = typeof x;
  return (t === "number" && isInt(x)) || t === "bigint" || t === "boolean";
}
export function isPyFloat(x: any): boolean {
  return (typeof x === "number" && !isInt(x)) || x instanceof FloatBox;
}

// The binary64 value of an int or float, or undefined for other types.
export function fv(x: any): number | undefined {
  const t = typeof x;
  if (t === "number") return x;
  if (x instanceof FloatBox) return x.v;
  if (t === "bigint") return bigToFloat(x);
  if (t === "boolean") return +x;
  if (x instanceof PrimBox) return fv(x.$v); // an int or float subclass
  return undefined;
}

// Both operands as doubles, or [undefined, undefined] unless both are ints
// or floats: a huge int only overflows when it meets a float, not when the
// other operand is an object whose reflected method should run.
const isNumLike = (x: any) => typeof x === "number" || typeof x === "bigint" || typeof x === "boolean" || x instanceof FloatBox;
function fv2(a: any, b: any): [number | undefined, number | undefined] {
  if (!isNumLike(a) || !isNumLike(b)) return [undefined, undefined];
  return [fv(a), fv(b)];
}

export function bigToFloat(x: bigint): number {
  const r = Number(x);
  if (!Number.isFinite(r)) raise(T.OverflowError, "int too large to convert to float");
  return r;
}

// Dunder lookup with a per-class cache, invalidated by the class version.
function special(o: any, name: string): any {
  const t: any = typeOf(o);
  let c = t.$dc;
  if (c === undefined || t.$dcVer !== t.$ver) {
    c = t.$dc = Object.create(null);
    t.$dcVer = t.$ver;
  }
  const v = c[name];
  if (v !== undefined) return v === MISSING ? undefined : v;
  let f = lookupType(t, name);
  if (f !== null && typeof f === "object" && f.asDunder !== undefined) f = f.asDunder();
  if (f !== undefined && typeof f !== "function") f = nonFunctionDunder(f, name);
  c[name] = f === undefined ? MISSING : f;
  return f;
}
const MISSING = {};
// special() for the runtime's builtin types: the special method of o's type,
// bound as Python binds one (a descriptor's __get__, a property, a callable
// object), callable as f(o, ...args)
export const lookupSpecial = special;

// The special method name of type t, normalized as special() does (for the
// lookups made on a type rather than on an object).
function typeDunder(t: any, name: string): any {
  let f = lookupType(t, name);
  if (f !== null && typeof f === "object" && f.asDunder !== undefined) f = f.asDunder();
  if (f !== undefined && typeof f !== "function") f = nonFunctionDunder(f, name);
  return f;
}

// A special method that is a class attribute but not a function, called as
// CPython calls it: through its __get__ when its type has one, else without
// self (C().__add__ = callable_instance gets only the other operand).  None
// (__iadd__ = None, __add__ = None) raises CPython's TypeError, not a JS
// error; for __contains__ and __iter__, None means the operation is not
// available, with no fallback to iteration or __getitem__.
//
// One wrapper per attribute object and name (WRAPPED), so that a class and
// its subclass inheriting the same attribute see the same wrapper.  The
// descriptor protocol is looked up when the wrapper is called, not when it
// is made: replacing, deleting or adding the type's __get__ takes effect
// (CPython's slot does the same).  The getter is called as Python calls
// any object, so a callable instance works and None raises TypeError.
const WRAPPED = new WeakMap<object, Record<string, any>>();
const NONE_WRAPPED: Record<string, any> = Object.create(null);
function nonFunctionDunder(g: any, name: string): any {
  if (g === null) {
    let w = NONE_WRAPPED[name];
    if (w === undefined) {
      if (name === "__contains__") w = (self: any) => raise(T.TypeError, `'${typeName(self)}' object is not a container`);
      else if (name === "__iter__") w = (self: any) => raise(T.TypeError, `'${typeName(self)}' object is not iterable`);
      else if (name === "__bool__") w = (self: any) => raise(T.TypeError, `'${typeName(self)}' cannot be interpreted as a boolean`);
      else w = () => callObj(null, []);
      NONE_WRAPPED[name] = w;
    }
    return w;
  }
  const isObj = typeof g === "object" || typeof g === "function";
  let byName = isObj ? WRAPPED.get(g) : undefined;
  if (byName !== undefined && byName[name] !== undefined) return byName[name];
  const w = (self: any, ...args: any[]) => {
    const get = lookupType(typeOf(g), "__get__");
    if (get !== undefined) return callObj(callObj(get, [g, self, typeOf(self)]), args);
    return callObj(g, args);
  };
  if (isObj) {
    const m: Record<string, any> = byName ?? Object.create(null);
    if (byName === undefined) WRAPPED.set(g, m);
    m[name] = w;
  }
  return w;
}

// Whether the right operand's type overrides the reflected method name of
// the left operand's (CPython's method_is_overloaded): the optional class
// attribute lookup getattr(type, name), through the metaclass's own
// __getattribute__ (and __getattr__) when it has one, where only an
// AttributeError means absent.  The right type is looked up first: absent
// there means not overridden (the left is not looked up); present there and
// absent on the left means overridden; otherwise the two are compared with
// !=.  For plain classes holding functions (or nothing) the lookup has no
// user code and is just the raw one, compared by identity.  The metaclass's
// hooks are bound as CPython binds them, through their type's __get__ (a
// staticmethod gets the name alone, a classmethod the metaclass).
const ABSENT = {};
function metaHook(meta: any, name: string): any {
  const f = lookupType(meta, name);
  return f === undefined || typeof f === "function" ? f : nonFunctionDunder(f, name);
}
function classAttrOpt(cls: any, name: string): any {
  const meta = cls.$meta ?? T.type;
  try {
    if (meta !== T.type) {
      const raw = lookupType(meta, "__getattribute__");
      const own = raw !== undefined && raw !== lookupType(T.type, "__getattribute__");
      const gf = metaHook(meta, "__getattr__");
      if (own || gf !== undefined) {
        try {
          return own ? callObj(metaHook(meta, "__getattribute__"), [cls, name]) : typeGetattr(cls, name);
        } catch (e) {
          if (gf === undefined || !isinstance(e, T.AttributeError)) throw e;
          return callObj(gf, [cls, name]);
        }
      }
    }
    return typeGetattr(cls, name);
  } catch (e) {
    if (isinstance(e, T.AttributeError)) return ABSENT;
    throw e;
  }
}
// The class attribute name of t as getattr(t, name) gives it when that
// runs no user code (a plain metaclass, an attribute whose type has no
// __get__: functions, None, callable instances), else NEEDS_GET.  Cached
// per version of t, as special()'s lookups, and, for an attribute that is
// an object, per identity and version of the attribute's own type: that
// type can gain or lose __get__, or the object change its type, without t
// changing.
const NEEDS_GET = {};
type RawAttr = { raw: any; at: any; atVer: number; plain: boolean };
function plainClassAttr(t: any, name: string): any {
  let c = t.$rc;
  if (c === undefined || t.$rcVer !== t.$ver) {
    c = t.$rc = Object.create(null);
    t.$rcVer = t.$ver;
  }
  let e: RawAttr | undefined = c[name];
  if (e === undefined) {
    const raw = lookupType(t, name);
    const at = raw === undefined || raw === null || typeof raw === "function" ? null : typeOf(raw);
    e = c[name] = { raw: raw === undefined ? MISSING : raw, at, atVer: -1, plain: at === null };
  }
  if (e.at !== null) {
    // (the attribute's type itself can change: a.__class__ = Descriptor)
    const at = typeOf(e.raw);
    if (at !== e.at || e.atVer !== at.$ver) {
      e.plain = lookupType(at, "__get__") === undefined;
      e.at = at;
      e.atVer = at.$ver;
    }
  }
  return e.plain ? e.raw : NEEDS_GET;
}
function overloaded(ta: any, tb: any, name: string): boolean {
  if ((ta.$meta ?? T.type) === T.type && (tb.$meta ?? T.type) === T.type) {
    const rb = plainClassAttr(tb, name);
    if (rb === MISSING) return false;
    if (rb !== NEEDS_GET) {
      const ra = plainClassAttr(ta, name);
      if (ra === MISSING) return true;
      // (two functions compare by identity, without user code)
      if (ra !== NEEDS_GET) return ra !== rb && ((typeof ra === "function" && typeof rb === "function") || truth(richCompare(ra, rb, "__ne__")));
    }
  }
  const b = classAttrOpt(tb, name);
  if (b === ABSENT) return false;
  const a = classAttrOpt(ta, name);
  if (a === ABSENT) return true;
  if (a === b) return false;
  return truth(richCompare(a, b, "__ne__"));
}

const OPS: Record<string, [string, string, string]> = table({
  add: ["__add__", "__radd__", "+"],
  sub: ["__sub__", "__rsub__", "-"],
  mul: ["__mul__", "__rmul__", "*"],
  truediv: ["__truediv__", "__rtruediv__", "/"],
  floordiv: ["__floordiv__", "__rfloordiv__", "//"],
  mod: ["__mod__", "__rmod__", "%"],
  pow: ["__pow__", "__rpow__", "** or pow()"],
  divmod: ["__divmod__", "__rdivmod__", "divmod()"],
  lshift: ["__lshift__", "__rlshift__", "<<"],
  rshift: ["__rshift__", "__rrshift__", ">>"],
  and: ["__and__", "__rand__", "&"],
  or: ["__or__", "__ror__", "|"],
  xor: ["__xor__", "__rxor__", "^"],
  matmul: ["__matmul__", "__rmatmul__", "@"],
});

// Reusing temporaries, as NumPy does (where the reference count is 1): in
// `a*2 + 1` the array from `a*2` exists only for the `+`, which can write
// its result into it instead of allocating another.  numpy's operator
// methods are tagged $fresh and record what they return in FRESH.v; any
// other dunder that returns that array (a Python __mul__ that stored it, say)
// clears FRESH.v.  The compiler emits addT/subT/mulT/truedivT for operators
// whose operand is itself an operator expression, and those may reuse the
// operand only while it is still FRESH.v: it then can only be on the JS stack.
export const FRESH: { v: any; inplace: ((op: string, t: any, o: any, tLeft: boolean) => any) | null } = { v: null, inplace: null };
function settle(f: any, r: any): any {
  if (r === FRESH.v && f.$fresh !== true) FRESH.v = null;
  return r;
}
function reuse(op: string, a: any, b: any, w: number): any {
  const f = FRESH.v;
  if (f === null) return undefined;
  if (w & 1 && a === f) return FRESH.inplace!(op, a, b, true);
  if (w & 2 && b === f) return FRESH.inplace!(op, b, a, false);
  return undefined;
}
export const addT = (a: any, b: any, w: number): any => reuse("add", a, b, w) ?? add(a, b);
export const subT = (a: any, b: any, w: number): any => reuse("sub", a, b, w) ?? sub(a, b);
export const mulT = (a: any, b: any, w: number): any => reuse("mul", a, b, w) ?? mul(a, b);
export const truedivT = (a: any, b: any, w: number): any => reuse("truediv", a, b, w) ?? truediv(a, b);

// (a builtin sequence's own __mul__, __rmul__ or __imul__: in CPython its
// sequence slot, sq_repeat or sq_inplace_repeat, not a numeric one, so
// left out of the numeric multiply and tried after it, unless a subclass
// has a __mul__ or __rmul__ of its own, below)
function seqBase(x: any): PyType | undefined {
  if (typeof x === "string" || (x instanceof PrimBox && typeof x.$v === "string")) return T.str;
  if (Array.isArray(x)) return (x as any).$t ? T.tuple : T.list;
  if (x instanceof PyByteArray) return T.bytearray;
  if (x instanceof PyBytes) return T.bytes;
  return undefined;
}
function nativeSeqMethod(x: any, name: string): boolean {
  const base = seqBase(x);
  if (base === undefined) return false;
  // (a str subclass's: str's, or the unboxing proxy's wrapper of it; a
  // class body's `__mul__ = list.__mul__`: the self-checking form Python
  // holds of it, the same descriptor, CORR-57F-1)
  const m = lookupType(typeOf(x), name), b = lookupType(base, name);
  return m === b || (b !== undefined && m === b.$selfChecked) || m?.$unboxing === true;
}
// Has a builtin sequence's type CPython's sequence repeat, sq_repeat? Only
// if it keeps the builtin's __mul__ and __rmul__: one of its own instead
// makes its multiply numeric, nb_multiply, that calls the two methods it
// has (the builtin's among them), and no repeat after
export function seqRepeats(x: any): boolean {
  return nativeSeqMethod(x, "__mul__") && nativeSeqMethod(x, "__rmul__");
}
// CPython's sequence_repeat: the count an index (else "can't multiply
// sequence by non-int"), index-sized (else OverflowError, naming its
// type), then the sequence's own repeat, without going back to the
// operator's dispatch (CORR-72B-3)
function seqCount(n: any): Count {
  if (lookupType(typeOf(n), "__index__") === undefined) raise(T.TypeError, `can't multiply sequence by non-int of type '${typeName(n)}'`);
  return ssizeCount(n);
}
// The count a builtin sequence's own __mul__, __rmul__ or __imul__ takes,
// as CPython's wrapper of its slot: an index (else "cannot be interpreted
// as an integer"), index-sized, below 0 none
export function ssizeCount(n: any): Count {
  const k = index(n);
  if (typeof k === "bigint" && (k > 9223372036854775807n || k < -9223372036854775808n)) raise(T.OverflowError, `cannot fit '${typeName(n)}' into an index-sized integer`);
  return exactCount(k);
}
// A repeat count, never below 0: a number while it is exact, else the
// bigint itself, so a length past Py_ssize_t is told from one within it
// exactly (sys.maxsize as a number is 2**63; daybreak2's LIMIT-51B-2)
export type Count = number | bigint;
function exactCount(k: number | bigint): Count {
  if (k < 0) return 0;
  return typeof k === "bigint" && k <= 9007199254740991n ? Number(k) : k;
}
// s * n as CPython's unicode_repeat: a length past Py_ssize_t an
// OverflowError, one past what a JS string holds a MemoryError, both
// before anything is made
export function strRepeat(s: string, n: Count): string {
  if (s.length === 0 || n <= 0) return "";
  if (n === 1) return s;
  if (BigInt(SP.cpLen(s)) * BigInt(n) > SSIZE_MAX) raise(T.OverflowError, "repeated string is too long");
  if (typeof n === "bigint" || s.length * n > 536870888) raise(T.MemoryError);
  return SP.repeatChecked(s, n);
}
function seqRepeat(seq: any, n: any): any {
  const c = seqCount(n);
  if (seq instanceof PrimBox) seq = seq.$v;
  if (typeof seq === "string") return strRepeat(seq, c);
  if (Array.isArray(seq)) return repeatArray(seq, c);
  return repeatBytes(seq, c);
}
export function binaryDunder(a: any, b: any, op: string): any {
  const [name, rname, sym] = OPS[op];
  const ta = typeOf(a), tb = typeOf(b);
  const r = binaryNumeric(a, b, op);
  if (r !== NotImplemented) return r;
  // (then a sequence's repeat, if its type keeps the builtin sequence's
  // __mul__ and __rmul__: the left operand's, else the right's, as
  // CPython's PyNumber_Multiply; a subclass that overrides either has none)
  if (op === "mul") {
    if (seqRepeats(a)) return seqRepeat(a, b);
    if (seqRepeats(b)) return seqRepeat(b, a);
  }
  raise(T.TypeError, `unsupported operand type(s) for ${sym}: '${ta.$name}' and '${tb.$name}'`);
}
// The numeric part of a binary operator: the methods, in CPython's order,
// NotImplemented if they all decline
function binaryNumeric(a: any, b: any, op: string): any {
  const [name, rname] = OPS[op];
  const ta = typeOf(a), tb = typeOf(b);
  const seqMul = op === "mul";
  const left = (x: any) => (seqMul && seqRepeats(x) ? undefined : special(x, name));
  const right = (x: any) => (seqMul && seqRepeats(x) ? undefined : special(x, rname));
  // As CPython's slot: the override test first (it may run user code that
  // replaces a method), then each method fetched when it is called.
  if (ta !== tb && tb.$mro.includes(ta) && (lookupType(tb, rname) !== undefined || lookupType(tb, name) !== undefined)
      && overloaded(ta, tb, rname)) {
    // A subclass's reflected method gets priority.
    const fb = right(b);
    if (fb !== undefined) {
      const r = settle(fb, fb(b, a));
      if (r !== NotImplemented) return r;
    }
    const fa = left(a);
    if (fa !== undefined) {
      const r2 = settle(fa, fa(a, b));
      if (r2 !== NotImplemented) return r2;
    }
  } else {
    const fa = left(a);
    if (fa !== undefined) {
      const r = settle(fa, fa(a, b));
      if (r !== NotImplemented) return r;
    }
    if (ta !== tb) {
      const fb = right(b);
      if (fb !== undefined) {
        const r = settle(fb, fb(b, a));
        if (r !== NotImplemented) return r;
      }
    }
  }
  return NotImplemented;
}

function inplace(a: any, b: any, op: string, iname: string): any {
  const f = special(a, iname);
  if (f !== undefined) {
    const r = f(a, b);
    if (r !== NotImplemented) return r;
  }
  return BIN[op](a, b);
}

// ------------------------------------------------------------------ arithmetic

export function add(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r : normBig(BigInt(a) + BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  if (typeof a === "string" && typeof b === "string") return SP.glue(a, b);
  return addSlow(a, b);
}
// Does x, an instance of a Python subclass of list or tuple, define its own
// version of the dunder `name`?
function overrides(x: any, name: string): boolean {
  if (x.$cls === undefined) return false;
  const base = x.$t ? T.tuple : T.list;
  return lookupType(typeOf(x), name) !== lookupType(base, name);
}
function addSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) + big(b));
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) return mkfloat(x + y);
  // (instances of Python subclasses of list/tuple that define __add__ or
  // __radd__ go through it)
  if (Array.isArray(a) && Array.isArray(b) && (a as any).$t === (b as any).$t && !overrides(a, "__add__") && !overrides(b, "__radd__")) {
    const r = a.concat(b);
    return (a as any).$t ? tuple(r) : r;
  }
  if (a instanceof PyBytes) {
    const bb = bufferOf(b);
    if (bb !== undefined) {
      const r = new Uint8Array(a.n + bb.length);
      r.set(a.a.subarray(0, a.n), 0);
      r.set(bb, a.n);
      return a instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
    }
  }
  return binaryDunder(a, b, "add");
}

export function sub(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r : normBig(BigInt(a) - BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  return subSlow(a, b);
}
function subSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) - big(b));
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) return mkfloat(x - y);
  if (exactSets(a, b)) return setOp(a, b, "sub");
  return binaryDunder(a, b, "sub");
}

export function mul(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (isInt(a) && isInt(b)) return isSafe(r) ? r + 0 : normBig(BigInt(a) * BigInt(b));
    return isInt(r) ? new FloatBox(r) : r;
  }
  return mulSlow(a, b);
}
function repeatCount(n: any): Count | undefined {
  // (an int subclass that keeps int's __mul__ and __rmul__ repeats by its
  // own value, as CPython's sequence repetition: [0] * J(2) is [0, 0])
  // (int's own: int's, or the unboxing proxy's wrapper of it, types.ts)
  const intsOwn = (t: any, name: string) => {
    const m = lookupType(t, name);
    return m === lookupType(T.int, name) || m?.$unboxing === true;
  };
  const orig = n;
  if (n instanceof PrimBox && typeOf(n).$mro.includes(T.int) && shimName(n, "int") === null && intsOwn(typeOf(n), "__mul__") && intsOwn(typeOf(n), "__rmul__")) n = n.$v;
  if (!isPyInt(n)) return undefined;
  // (an index-sized count, as CPython's sequence repeat takes it: past it
  // an OverflowError, before anything is made, LIMIT-COL-1)
  if (typeof n === "bigint" && (n > 9223372036854775807n || n < -9223372036854775808n)) raise(T.OverflowError, `cannot fit '${typeName(orig)}' into an index-sized integer`);
  return exactCount(typeof n === "boolean" ? +n : n);
}
function mulSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) * big(b));
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) return mkfloat(x * y);
  if (typeof a === "string" && repeatCount(b) !== undefined) return strRepeat(a, repeatCount(b)!);
  if (typeof b === "string" && repeatCount(a) !== undefined) return strRepeat(b, repeatCount(a)!);
  if (Array.isArray(a) && seqRepeats(a) && repeatCount(b) !== undefined) return repeatArray(a, repeatCount(b)!);
  // (a sequence's repeat only if its type keeps the builtin's __mul__ and
  // __rmul__, its sequence slot; a subclass's own either goes through
  // dispatch)
  if (Array.isArray(b) && seqRepeats(b) && repeatCount(a) !== undefined) return repeatArray(b, repeatCount(a)!);
  if (a instanceof PyBytes && seqRepeats(a) && repeatCount(b) !== undefined) return repeatBytes(a, repeatCount(b)!);
  if (b instanceof PyBytes && seqRepeats(b) && repeatCount(a) !== undefined) return repeatBytes(b, repeatCount(a)!);
  return binaryDunder(a, b, "mul");
}
export function repeatArray(a: any[], n: Count): any[] {
  const len = a.length;
  // (nothing to repeat, or no copies: no loop over the count, an empty
  // sequence repeated 2**62 times is empty at once; a result past what an
  // array holds is a MemoryError before it is made, as CPython's)
  if (len === 0 || n <= 0) return (a as any).$t ? tuple([]) : [];
  if (typeof n === "bigint" || len * n > 4294967295) raise(T.MemoryError);
  const r = new Array(len * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < len; j++) r[i * len + j] = a[j];
  return (a as any).$t ? tuple(r) : r;
}

export function repeatBytes(a: PyBytes, n: Count): PyBytes {
  // (a result past what a buffer holds: a MemoryError before it is made;
  // past an index-sized length, bytes's OverflowError, as CPython's, the
  // length exact)
  if (n < 0) n = 0;
  if (a.n > 0 && (typeof n === "bigint" || n > Math.floor(4294967295 / a.n))) {
    if (!(a instanceof PyByteArray) && BigInt(a.n) * BigInt(n) > SSIZE_MAX) raise(T.OverflowError, "repeated bytes are too long");
    raise(T.MemoryError);
  }
  n = Number(n);
  const total = a.n * n;
  const r = new Uint8Array(total);
  if (total > 0) {
    r.set(a.a.subarray(0, a.n), 0);
    for (let filled = a.n; filled < total; filled *= 2) r.copyWithin(filled, 0, Math.min(filled, total - filled));
  }
  return a instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
}

export function truediv(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && b !== 0) return mkfloat(a / b);
  return truedivSlow(a, b);
}
function truedivSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) === 0n) raise(T.ZeroDivisionError, "division by zero");
    return mkfloat(intTrueDiv(big(a), big(b)));
  }
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "division by zero");
    return mkfloat(x / y);
  }
  return binaryDunder(a, b, "truediv");
}

const absBig = (x: bigint) => (x < 0n ? -x : x);
const BIG = 1n << 1024n;
// The bit length of x, without a string of its digits once it is large:
// shifts bracket the length, then halve the bracket (each shift's result is
// no bigger than x, and soon small).  With max, a known bound on the length,
// the bracket starts there, so no shift copies more than half of x.
export function bitLength(x: bigint, max?: number): number {
  x = absBig(x);
  if (x < BIG) return x === 0n ? 0 : x.toString(2).length;
  let lo = 1024, hi = max ?? 2048; // x >> lo is nonzero, x >> hi is zero
  while (max === undefined && x >> BigInt(hi) !== 0n) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (x >> BigInt(mid) !== 0n) lo = mid;
    else hi = mid;
  }
  return hi;
}

// The bit length of x with no copy of more than about 1/64 of it, for an x
// of any size up to V8's largest BigInt (2^30 bits): shifts from that size
// down by 1/64 at a time, a shift past x's bits being 0 at once, until one is
// not; its result has fewer bits than the step, and x's length is the shift
// plus that result's.
// The bit length of |x| within one, [lo, hi], with small copies only: a
// negative x is not negated (its limbs are not copied).  Its shifts round
// towards minus infinity, so -(x >> t) is ceil(|x| / 2^t), whose length is
// that of floor(|x| / 2^t) or one more.
export function bitLengthSmallCopiesSigned(x: bigint): [number, number] {
  if (x >= 0n || x > -BIG) {
    const b = bitLengthSmallCopies(x);
    return [b, b];
  }
  for (let s = 2 ** 30; s > 1024; ) {
    const t = s - Math.max(1, s >> 6);
    const r = x >> BigInt(t);
    // (r is -1 while |x| <= 2^t)
    if (r < -1n) {
      const b = t + bitLength(-r);
      return [b - 1, b];
    }
    s = t;
  }
  const b = bitLength(x);
  return [b, b];
}

export function bitLengthSmallCopies(x: bigint): number {
  x = absBig(x);
  if (x < BIG) return x === 0n ? 0 : x.toString(2).length;
  for (let s = 2 ** 30; s > 1024; ) {
    const t = s - Math.max(1, s >> 6);
    const r = x >> BigInt(t);
    if (r !== 0n) return t + bitLength(r);
    s = t;
  }
  return bitLength(x);
}

// Correctly rounded int / int, subnormal results included, following the
// scheme of CPython's long_true_divide (Objects/longobject.c; see
// NOTICE.md): the quotient is formed with at least two bits beyond
// the result's precision (53 bits, or fewer below 2^-1022, where the last
// representable bit is 2^-1074) plus a sticky bit, rounded once to that
// precision (ties to even), then scaled by an exact power of 2.
export function intTrueDiv(a: bigint, b: bigint): number {
  if (absBig(a) <= MAXB && absBig(b) <= MAXB) return Number(a) / Number(b);
  const neg = a < 0n !== b < 0n;
  a = absBig(a);
  b = absBig(b);
  if (a === 0n) return neg ? -0 : 0;
  const diff = bitLength(a) - bitLength(b); // (a/b lies in [2^(diff-1), 2^(diff+1)))
  if (diff > 1025) raise(T.OverflowError, "integer division result too large for a float");
  if (diff < -1080) return neg ? -0 : 0; // (below half of 2^-1074)
  const shift = Math.max(diff, -1021) - 55;
  let q: bigint, r: bigint;
  if (shift >= 0) {
    const d = b << BigInt(shift);
    q = a / d;
    r = a % d;
  } else {
    const n = a << BigInt(-shift);
    q = n / b;
    r = n % b;
  }
  // (a/b = (q + r/b') 2^shift; drop the bits below the result's precision)
  const extra = Math.max(bitLength(q) - 53, -1074 - shift);
  const half = 1n << BigInt(extra - 1);
  const low = q & ((1n << BigInt(extra)) - 1n);
  q >>= BigInt(extra);
  if (low > half || (low === half && (r !== 0n || (q & 1n) === 1n))) q += 1n;
  const result = Number(q) * Math.pow(2, shift + extra);
  if (!Number.isFinite(result)) raise(T.OverflowError, "integer division result too large for a float");
  return neg ? -result : result;
}

// Python floor division and modulo on safe-integer numbers.  JS `%` on
// values outside int32 compiles to a slow fmod call, so outside int32 we
// divide in floating point and correct by one: with |a| + |b| < 2^53 the
// product q * b is exact, so r = a - q * b is exact.
const TWO53 = 9007199254740992;
function floorQuot(a: number, b: number): number {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (b > 0 ? r < 0 : r > 0) q -= 1;
  else if (b > 0 ? r >= b : r <= b) q += 1;
  return q;
}

export function floordiv(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b !== 0) {
    if (Math.abs(a) + Math.abs(b) < TWO53) return floorQuot(a, b) + 0;
    const r = a % b; // exact for safe integers, so (a - r) / b is exact too
    const q = (a - r) / b;
    return (r !== 0 && r < 0 !== b < 0 ? q - 1 : q) + 0;
  }
  return floordivSlow(a, b);
}
function floordivSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    const x = big(a), y = big(b);
    if (y === 0n) raise(T.ZeroDivisionError, "division by zero");
    // One BigInt division; flooring only matters when the signs differ.
    let q = x / y;
    if (x < 0n !== y < 0n && q * y !== x) q -= 1n;
    return normBig(q);
  }
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "division by zero");
    return mkfloat(floatDivmod(x, y)[0]);
  }
  return binaryDunder(a, b, "floordiv");
}

// CPython's _float_div_mod.  (C's `if (mod)` is true for a nan, which JS's
// `if (mod)` is not: the tests are `!== 0`, so an infinite or nan operand
// gives nan, as in CPython, not 0.0.)
export function floatDivmod(vx: number, wx: number): [number, number] {
  let mod = vx % wx;
  let div = (vx - mod) / wx;
  if (mod !== 0) {
    if (wx < 0 !== mod < 0) {
      mod += wx;
      div -= 1.0;
    }
  } else {
    mod = wx < 0 ? -0.0 : 0.0;
  }
  let floordiv: number;
  if (div !== 0) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    const q = vx / wx;
    floordiv = q < 0 || Object.is(q, -0) ? -0.0 : 0.0;
  }
  return [floordiv, mod];
}

export function mod(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b !== 0) {
    if ((a | 0) === a && (b | 0) === b) {
      const r = a % b;
      return (r !== 0 && r < 0 !== b < 0 ? r + b : r) + 0;
    }
    if (Math.abs(a) + Math.abs(b) < TWO53) {
      let r = a - Math.floor(a / b) * b;
      if (b > 0) {
        if (r < 0) r += b;
        else if (r >= b) r -= b;
      } else if (r > 0) r += b;
      else if (r <= b) r -= b;
      return r + 0;
    }
    const r = a % b;
    return (r !== 0 && r < 0 !== b < 0 ? r + b : r) + 0;
  }
  if (typeof a === "string") return strFormatOpHook.f(a, b);
  return modSlow(a, b);
}
function modSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    const x = big(a), y = big(b);
    if (y === 0n) raise(T.ZeroDivisionError, "division by zero");
    let r = x % y;
    if (r !== 0n && r < 0n !== y < 0n) r += y;
    return normBig(r);
  }
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "division by zero");
    return mkfloat(floatDivmod(x, y)[1]);
  }
  return binaryDunder(a, b, "mod");
}

export function divmod(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) return tuple([floordiv(a, b), mod(a, b)]);
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) {
    if (y === 0) raise(T.ZeroDivisionError, "division by zero");
    const [q, r] = floatDivmod(x, y);
    return tuple([mkfloat(q), mkfloat(r)]);
  }
  // (the binary protocol: a subclass's __rdivmod__ first, then __divmod__,
  // then the other operand's __rdivmod__)
  return binaryDunder(a, b, "divmod");
}

export function pow(a: any, b: any, m?: any): any {
  if (m !== undefined && m !== null) return powMod(a, b, m);
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0) {
    const r = Math.pow(a, b);
    if (isSafe(r)) return r + 0;
    return normBig(BigInt(a) ** BigInt(b));
  }
  return powSlow(a, b);
}
function powSlow(a: any, b: any): any {
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) >= 0n) return normBig(big(a) ** big(b));
    if (big(a) === 0n) raise(T.ZeroDivisionError, "0.0 cannot be raised to a negative power");
    return floatPow(fv(a)!, fv(b)!);
  }
  const [x, y] = fv2(a, b);
  if (x !== undefined && y !== undefined) return floatPow(x, y);
  return binaryDunder(a, b, "pow");
}
function floatPow(x: number, y: number): any {
  if (x === 0 && y < 0) raise(T.ZeroDivisionError, "zero to a negative power");
  if (x < 0 && !isInt(y) && Number.isFinite(y)) return complexHooks.pow(x, y);
  const r = glibcPow(x, y); // (glibc's, in every engine: Math.pow is the platform's)
  if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) raise(T.OverflowError, "(34, 'Numerical result out of range')");
  return mkfloat(r);
}
// A type's nb_power slot, as CPython's: int's, float's or complex's own
// (a subclass that defines neither __pow__ nor __rpow__ inherits it), or
// a class's slot_nb_power ("py") when its __pow__ or __rpow__ is another
// (the runtime's hidden layout classes, which carry their base's dunders,
// skipped)
function powDunder(t: any, name: string): any {
  for (const c of t.$mro) if (!c.$hidden && c.$dict.has(name)) return c.$dict.get(name);
  return undefined;
}
function powSlot(t: any): string | undefined {
  const p = powDunder(t, "__pow__"), r = powDunder(t, "__rpow__");
  if (p === undefined && r === undefined) return undefined;
  for (const [name, bt] of [["int", T.int], ["float", T.float], ["complex", T.complex]] as const) {
    if (p === bt.$dict.get("__pow__") && r === bt.$dict.get("__rpow__")) return name;
  }
  return "py";
}
// One slot's call with a modulus: float's refuses before anything (its
// float_pow); complex's once both convert to complex ("complex modulo");
// int's passes on (not all three are ints here); a class's as CPython
// 3.14's slot_nb_power: the exponent's __rpow__ first only when its type
// is a subtype of the base's that overrides it (method_is_overloaded),
// then the base's __pow__, then the exponent's __rpow__
function powSlotCall(slot: string, a: any, b: any, m: any): any {
  // (an int, float or complex subclass's instance counts as its base's)
  const isA = (x: any, t: any) => typeOf(x).$mro.includes(t);
  const intLike = (x: any) => isPyInt(x) || isA(x, T.int);
  const num = (x: any) => intLike(x) || isPyFloat(x) || isA(x, T.float) || isA(x, T.complex);
  if (slot === "float") raise(T.TypeError, "pow() 3rd argument not allowed unless all arguments are integers");
  if (slot === "complex") return num(a) && num(b) ? raise(T.ValueError, "complex modulo") : NotImplemented;
  if (slot === "int") {
    const v = (x: any) => (x instanceof PrimBox ? x.$v : x);
    return intLike(a) && intLike(b) && intLike(m) ? powMod(v(a), v(b), v(m)) : NotImplemented;
  }
  const ta = typeOf(a), tb = typeOf(b);
  let other = ta !== tb && powSlot(tb) === "py";
  // (an inherited int, float or complex method is that type's own slot:
  // float's refuses, as its wrapper's float_pow)
  const call = (o: any, name: string, x: any) => {
    const f = special(o, name);
    if (f === undefined) return NotImplemented;
    for (const [bs, bt] of [["int", T.int], ["float", T.float], ["complex", T.complex]] as const) if (powDunder(typeOf(o), name) === bt.$dict.get(name)) return powSlotCall(bs, a, b, m);
    return settle(f, f(o, x, m));
  };
  if (powSlot(ta) === "py") {
    if (other && tb.$mro.includes(ta) && powDunder(tb, "__rpow__") !== powDunder(ta, "__rpow__")) {
      const r = call(b, "__rpow__", a);
      if (r !== NotImplemented) return r;
      other = false;
    }
    const r = call(a, "__pow__", b);
    if (r !== NotImplemented || ta === tb) return r;
  }
  return other ? call(b, "__rpow__", a) : NotImplemented;
}
function powMod(a: any, b: any, m: any): any {
  if (!(isPyInt(a) && isPyInt(b) && isPyInt(m))) {
    // CPython 3.14's ternary_op over each type's nb_power slot (powSlot):
    // the base's, then the exponent's when it differs (first when the
    // exponent's type is a subtype of the base's), then the modulus's when
    // it differs from both, each NotImplemented passing on
    const ta = typeOf(a), tb = typeOf(b), tm = typeOf(m);
    const sv = powSlot(ta);
    let sw = tb !== ta ? powSlot(tb) : undefined;
    if (sw === sv) sw = undefined;
    if (sv !== undefined) {
      if (sw !== undefined && tb.$mro.includes(ta)) {
        const r = powSlotCall(sw, a, b, m);
        if (r !== NotImplemented) return r;
        sw = undefined;
      }
      const r = powSlotCall(sv, a, b, m);
      if (r !== NotImplemented) return r;
    }
    if (sw !== undefined) {
      const r = powSlotCall(sw, a, b, m);
      if (r !== NotImplemented) return r;
    }
    const sz = powSlot(tm);
    if (sz !== undefined && sz !== sv && sz !== sw) {
      const r = powSlotCall(sz, a, b, m);
      if (r !== NotImplemented) return r;
    }
    raise(T.TypeError, `unsupported operand type(s) for ** or pow(): '${typeName(a)}', '${typeName(b)}', '${typeName(m)}'`);
  }
  let base = big(a), e = big(b), n = big(m);
  if (n === 0n) raise(T.ValueError, "pow() 3rd argument cannot be 0");
  const neg = n < 0n;
  if (neg) n = -n;
  if (e < 0n) {
    base = modInverse(base, n);
    e = -e;
  }
  let r = 1n % n;
  base %= n;
  if (base < 0n) base += n;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % n;
    base = (base * base) % n;
    e >>= 1n;
  }
  if (neg && r !== 0n) r -= n;
  return normBig(r);
}
function modInverse(a: bigint, n: bigint): bigint {
  let [r0, r1, s0, s1] = [((a % n) + n) % n, n, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) raise(T.ValueError, "base is not invertible for the given modulus");
  return ((s0 % n) + n) % n;
}

const I32 = (x: any) => typeof x === "number" && (x | 0) === x;

export function lshift(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0 && b < 53) {
    const r = a * Math.pow(2, b);
    if (isSafe(r)) return r + 0;
  }
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) < 0n) raise(T.ValueError, "negative shift count");
    return normBig(big(a) << big(b));
  }
  return binaryDunder(a, b, "lshift");
}
export function rshift(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number" && isInt(a) && isInt(b) && b >= 0) {
    return b > 60 ? (a < 0 ? -1 : 0) : Math.floor(a / Math.pow(2, b)) + 0;
  }
  if (isPyInt(a) && isPyInt(b)) {
    if (big(b) < 0n) raise(T.ValueError, "negative shift count");
    return normBig(big(a) >> big(b));
  }
  return binaryDunder(a, b, "rshift");
}
export function and(a: any, b: any): any {
  if (I32(a) && I32(b)) return a & b;
  if (typeof a === "boolean" && typeof b === "boolean") return a && b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) & big(b));
  if (exactSets(a, b)) return setOp(a, b, "and");
  return binaryDunder(a, b, "and");
}
export function or(a: any, b: any): any {
  if (I32(a) && I32(b)) return a | b;
  if (typeof a === "boolean" && typeof b === "boolean") return a || b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) | big(b));
  if (exactSets(a, b)) return setOp(a, b, "or");
  if (a instanceof PyDict && b instanceof PyDict && plainDict(a) && plainDict(b)) {
    const r = dictCopy(a);
    dictUpdate(r, b);
    return r;
  }
  return binaryDunder(a, b, "or");
}
export function xor(a: any, b: any): any {
  if (I32(a) && I32(b)) return a ^ b;
  if (typeof a === "boolean" && typeof b === "boolean") return a !== b;
  if (isPyInt(a) && isPyInt(b)) return normBig(big(a) ^ big(b));
  if (exactSets(a, b)) return setOp(a, b, "xor");
  return binaryDunder(a, b, "xor");
}
export function matmul(a: any, b: any): any {
  return binaryDunder(a, b, "matmul");
}

const BIN: Record<string, (a: any, b: any) => any> = { add, sub, mul, truediv, floordiv, mod, pow: (a, b) => pow(a, b), lshift, rshift, and, or, xor, matmul };

export function iadd(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return add(a, b);
  if (typeof a === "string" && typeof b === "string") return SP.glue(a, b);
  // (a Python subclass of list with its own __iadd__ goes through it)
  if (Array.isArray(a) && (a as any).$t !== true && !overrides(a, "__iadd__")) {
    if (Array.isArray(b)) {
      const n = b.length;
      for (let i = 0; i < n; i++) a.push(b[i]);
    } else forEach(b, (v) => void a.push(v));
    return a;
  }
  return inplace(a, b, "add", "__iadd__");
}
export function isub(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return sub(a, b);
  if (inplaceSets(a, b)) return setInplace(a, b, "sub");
  return inplace(a, b, "sub", "__isub__");
}
// list *= n as CPython's list_inplace_repeat: n an index-sized integer
// (OverflowError past it, naming n's type); below 1 the list is emptied;
// an empty list, or n of 1, is left as it is; else the repeat, a
// MemoryError past what an array holds, before anything is copied
// (daybreak2's LIMIT-COL-1)
// (the count converted first: what its __index__ does to the list is
// then repeated, CORR-72B-1; list.__imul__ called itself converts it as
// its slot's wrapper, "cannot be interpreted as an integer")
export function listInplaceRepeat(a: any[], n: any, direct = false): any[] {
  const c = direct ? ssizeCount(n) : seqCount(n);
  if (c < 1) {
    a.length = 0;
    return a;
  }
  if (a.length === 0 || c === 1) return a;
  const r = repeatArray(a, c);
  a.length = 0;
  for (const v of r) a.push(v);
  return a;
}
// bytearray *= n as CPython's bytearray_irepeat: in place, the count
// converted first; a length past Py_ssize_t a MemoryError; then a resize
// refused under an export, before the new contents are made (a size it
// already has is no resize, so no export check; daybreak2's LIMIT-51B-1)
export function bytearrayInplaceRepeat(b: PyByteArray, n: any, direct = false): PyByteArray {
  const c = direct ? ssizeCount(n) : seqCount(n);
  if (c === 1) return b;
  const size = BigInt(b.n) * BigInt(c);
  if (size > SSIZE_MAX) raise(T.MemoryError);
  if (size !== BigInt(b.n)) checkResizable(b);
  const r = repeatBytes(b, c);
  b.a = r.a;
  b.n = r.n;
  return b;
}
// x *= n as CPython's PyNumber_InPlaceMultiply: an __imul__ of x's own
// (not a builtin sequence's), then the numeric multiply (a list
// subclass's own __mul__, CORR-970-1, the right operand's __rmul__,
// CORR-72B-2), then list's or bytearray's in-place repeat, else a
// sequence's repeat, of
// the left operand, else of the right one
export function imul(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return mul(a, b);
  // (an exact list by an int: no method can intervene)
  if (Array.isArray(a) && (a as any).$cls === undefined && (a as any).$t !== true && typeof b === "number") return listInplaceRepeat(a, b);
  if (!nativeSeqMethod(a, "__imul__")) {
    const f = special(a, "__imul__");
    if (f !== undefined) {
      const r = f(a, b);
      if (r !== NotImplemented) return r;
    }
  }
  const r = binaryNumeric(a, b, "mul");
  if (r !== NotImplemented) return r;
  if (Array.isArray(a) && (a as any).$t !== true && nativeSeqMethod(a, "__imul__")) return listInplaceRepeat(a, b);
  if (a instanceof PyByteArray && nativeSeqMethod(a, "__imul__")) return bytearrayInplaceRepeat(a, b);
  if (seqRepeats(a)) return seqRepeat(a, b);
  if (seqRepeats(b)) return seqRepeat(b, a);
  raise(T.TypeError, `unsupported operand type(s) for *=: '${typeOf(a).$name}' and '${typeOf(b).$name}'`);
}
export const itruediv = (a: any, b: any) => inplace(a, b, "truediv", "__itruediv__");
export const ifloordiv = (a: any, b: any) => (typeof a === "number" && typeof b === "number" ? floordiv(a, b) : inplace(a, b, "floordiv", "__ifloordiv__"));
export const imod = (a: any, b: any) => (typeof a === "number" && typeof b === "number" ? mod(a, b) : inplace(a, b, "mod", "__imod__"));
export const ipow = (a: any, b: any) => inplace(a, b, "pow", "__ipow__");
export const ilshift = (a: any, b: any) => inplace(a, b, "lshift", "__ilshift__");
export const irshift = (a: any, b: any) => inplace(a, b, "rshift", "__irshift__");
export const imatmul = (a: any, b: any) => inplace(a, b, "matmul", "__imatmul__");
export const iand = (a: any, b: any) => (inplaceSets(a, b) ? setInplace(a, b, "and") : inplace(a, b, "and", "__iand__"));
export const ixor = (a: any, b: any) => (inplaceSets(a, b) ? setInplace(a, b, "xor") : inplace(a, b, "xor", "__ixor__"));
export const ior = (a: any, b: any) => {
  if (inplaceSets(a, b)) return setInplace(a, b, "or");
  if (a instanceof PyDict && plainDict(a)) {
    dictUpdate(a, b);
    return a;
  }
  return inplace(a, b, "or", "__ior__");
};

export function neg(a: any): any {
  if (typeof a === "number") {
    if (isInt(a)) return a === 0 ? 0 : -a;
    return -a;
  }
  if (typeof a === "bigint") return normBig(-a);
  if (typeof a === "boolean") return a ? -1 : 0;
  if (a instanceof FloatBox) return mkfloat(-a.v);
  return unaryDunder(a, "__neg__", "-");
}
export function pos(a: any): any {
  if (typeof a === "number" || typeof a === "bigint" || a instanceof FloatBox) return a;
  if (typeof a === "boolean") return +a;
  return unaryDunder(a, "__pos__", "+");
}
export function invert(a: any): any {
  if (typeof a === "number" && isInt(a)) return -a - 1;
  if (isPyInt(a)) return normBig(-big(a) - 1n);
  return unaryDunder(a, "__invert__", "~");
}
function unaryDunder(a: any, name: string, sym: string): any {
  const f = special(a, name);
  if (f !== undefined) return settle(f, f(a));
  // (abs() is a function, not an operator, in CPython 3.14's message)
  raise(T.TypeError, sym === "abs()" ? `bad operand type for abs(): '${typeName(a)}'` : `bad operand type for unary ${sym}: '${typeName(a)}'`);
}

export function abs(a: any): any {
  if (typeof a === "number") return isInt(a) ? Math.abs(a) : Math.abs(a);
  if (typeof a === "bigint") return a < 0n ? -a : a;
  if (typeof a === "boolean") return +a;
  if (a instanceof FloatBox) return new FloatBox(Math.abs(a.v));
  return unaryDunder(a, "__abs__", "abs()");
}

// ------------------------------------------------------------------ comparison

const REFLECT: Record<string, string> = table({ __lt__: "__gt__", __le__: "__ge__", __gt__: "__lt__", __ge__: "__le__", __eq__: "__eq__", __ne__: "__ne__" });
const SYM: Record<string, string> = table({ __lt__: "<", __le__: "<=", __gt__: ">", __ge__: ">=" });

// -1, 0, 1 or NaN (unordered) when both are numbers, else undefined.
function numCmp(a: any, b: any): number | undefined {
  let x = a, y = b;
  if (x instanceof FloatBox) x = x.v;
  if (y instanceof FloatBox) y = y.v;
  const tx = typeof x, ty = typeof y;
  if ((tx === "number" || tx === "bigint" || tx === "boolean") && (ty === "number" || ty === "bigint" || ty === "boolean")) {
    if (tx === "boolean") x = +x;
    if (ty === "boolean") y = +y;
    return x < y ? -1 : x > y ? 1 : x == y ? 0 : NaN;
  }
  return undefined;
}

function cmpResult(c: number, op: string): boolean {
  switch (op) {
    case "__lt__": return c < 0;
    case "__le__": return c <= 0;
    case "__gt__": return c > 0;
    case "__ge__": return c >= 0;
    case "__eq__": return c === 0;
    default: return c !== 0;
  }
}

export function seqCmp(a: any[], b: any[], op: string): any {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i] || eqBool(a[i], b[i])) continue;
    if (op === "__eq__") return false;
    if (op === "__ne__") return true;
    return richCompare(a[i], b[i], op);
  }
  return cmpResult(a.length - b.length, op);
}

// Strings compare by code point, as in Python, not by UTF-16 unit as in
// JavaScript: U+10000 and up (a surrogate pair) is past U+E000..U+FFFF
// (REACT-DEEF-1), while a lone surrogate, which Python allows, is its own
// code point (REACT-71F5-1).  At the first unit that differs, the code
// points there: a pair's (stepping back to its first unit when the second
// differs), or the unit itself.
export function strCmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  if (i === n) return a.length - b.length;
  const low = (u: number) => u >= 0xdc00 && u <= 0xdfff;
  const p = i > 0 ? a.charCodeAt(i - 1) : 0;
  if (p >= 0xd800 && p <= 0xdbff && (low(a.charCodeAt(i)) || low(b.charCodeAt(i)))) i--;
  return a.codePointAt(i)! - b.codePointAt(i)!;
}

export function richCompare(a: any, b: any, op: string): any {
  const c = numCmp(a, b);
  if (c !== undefined) return cmpResult(c, op);
  if (typeof a === "string" && typeof b === "string") return cmpResult(strCmp(a, b), op);
  if (Array.isArray(a) && Array.isArray(b) && (a as any).$t === (b as any).$t && (a as any).$cls === undefined && (b as any).$cls === undefined) return seqCmp(a, b, op);
  if (a instanceof PySet && b instanceof PySet && (a.$cls === T.set || a.$cls === T.frozenset) && (b.$cls === T.set || b.$cls === T.frozenset)) {
    const na = a.$d.$m.size, nb = b.$d.$m.size;
    switch (op) {
      case "__eq__": return na === nb && setSubset(a, b);
      case "__ne__": return !(na === nb && setSubset(a, b));
      case "__le__": return setSubset(a, b);
      case "__lt__": return na < nb && setSubset(a, b);
      case "__ge__": return setSubset(b, a);
      default: return na > nb && setSubset(b, a);
    }
  }
  if (a instanceof PyBytes && b instanceof PyBytes) {
    const n = Math.min(a.n, b.n);
    let c = 0;
    for (let i = 0; i < n && c === 0; i++) c = a.a[i] - b.a[i];
    return cmpResult(c !== 0 ? c : a.n - b.n, op);
  }
  if (a instanceof PyDict && b instanceof PyDict && a.$cls === T.dict && b.$cls === T.dict && (op === "__eq__" || op === "__ne__")) {
    const same = dictEquals(a, b);
    return op === "__eq__" ? same : !same;
  }
  const ta = typeOf(a), tb = typeOf(b);
  const rop = REFLECT[op];
  const reflectedFirst = ta !== tb && tb.$mro.includes(ta) && lookupType(tb, rop) !== lookupType(ta, rop);
  const left = () => {
    const f = typeDunder(ta, op);
    return f === undefined ? NotImplemented : f(a, b);
  };
  const right = () => {
    const f = typeDunder(tb, rop);
    return f === undefined ? NotImplemented : f(b, a);
  };
  let r = reflectedFirst ? right() : left();
  if (r !== NotImplemented) return r;
  r = reflectedFirst ? left() : right();
  if (r !== NotImplemented) return r;
  if (op === "__eq__") return a === b;
  if (op === "__ne__") return a !== b;
  raise(T.TypeError, `'${SYM[op]}' not supported between instances of '${ta.$name}' and '${tb.$name}'`);
}

export function dictEquals(a: PyDict, b: PyDict): boolean {
  if (a.$m.size !== b.$m.size) return false;
  for (const [k, v] of a.$m) {
    const w = dictGet(b, dictKeyOf(a, k));
    if (w === undefined || !eqBool(v, w)) return false;
  }
  return true;
}

export function lt(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a < b : richCompare(a, b, "__lt__");
}
export function le(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a <= b : richCompare(a, b, "__le__");
}
export function gt(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a > b : richCompare(a, b, "__gt__");
}
export function ge(a: any, b: any): any {
  return typeof a === "number" && typeof b === "number" ? a >= b : richCompare(a, b, "__ge__");
}
export function eq(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a === null && b === null) return true;
  if (identityEq(a, b)) return a === b;
  return richCompare(a, b, "__eq__");
}
export function ne(a: any, b: any): any {
  if (typeof a === "number" && typeof b === "number") return a !== b;
  if (typeof a === "string" && typeof b === "string") return a !== b;
  if (a === null && b === null) return false;
  if (identityEq(a, b)) return a !== b;
  return richCompare(a, b, "__ne__");
}

// True when == between a and b reduces to identity: both are instances of
// Python classes (or None) whose __eq__/__ne__ are object's.
function identityEq(a: any, b: any): boolean {
  if (a === null || typeof a !== "object" || (b !== null && typeof b !== "object")) return false;
  const ta = a.$cls;
  if (ta === undefined || ta.$ctor === null || ta.$jsBase !== null || !defaultEq(ta)) return false;
  if (b === null) return true;
  const tb = b.$cls;
  return tb !== undefined && tb.$ctor !== null && tb.$jsBase === null && defaultEq(tb);
}
function defaultEq(t: any): boolean {
  if (t.$eqVer === t.$ver) return t.$eqDefault;
  t.$eqVer = t.$ver;
  t.$eqDefault = lookupType(t, "__eq__") === objectEq && lookupType(t, "__ne__") === objectNe;
  return t.$eqDefault;
}
// Equality as a JS boolean, with Python's identity shortcut for containers.
export function eqBool(a: any, b: any): boolean {
  if (a === b) return typeof a !== "number" || a === a;
  return truth(eq(a, b));
}
export function is(a: any, b: any): boolean {
  return a === b || (a !== a && b !== b);
}

// `x in c`
export function arrContains(c: any[], x: any): boolean {
  for (let i = 0; i < c.length; i++) if (c[i] === x || eqBool(c[i], x)) return true;
  return false;
}
export function contains(c: any, x: any): boolean {
  if (Array.isArray(c) && ((c as any).$cls === undefined || layoutPlain((c as any).$cls))) return arrContains(c, x);
  if (typeof c === "string") {
    if (typeof x !== "string") raise(T.TypeError, `'in <string>' requires string as left operand, not ${typeName(x)}`);
    return SP.indexOf(c, x, 0) >= 0;
  }
  if (c instanceof PyDict && c.$cls === T.dict) return dictGet(c, x) !== undefined;
  if (c instanceof PySet && (c.$cls === T.set || c.$cls === T.frozenset)) return dictGet(c.$d, x) !== undefined;
  if (c instanceof PyBytes) {
    if (isPyInt(x)) {
      const v = Number(x);
      if (v < 0 || v > 255) raise(T.ValueError, "byte must be in range(0, 256)");
      return c.a.subarray(0, c.n).includes(v);
    }
    const xb = bufferOf(x);
    if (xb === undefined) raise(T.TypeError, `a bytes-like object is required, not '${typeName(x)}'`);
    return Buffer.from(c.a.buffer, c.a.byteOffset, c.n).includes(Buffer.from(xb.buffer, xb.byteOffset, xb.length));
  }
  const f = special(c, "__contains__");
  if (f !== undefined) return truth(f(c, x));
  // (no __contains__: a search of its iterator; a TypeError getting that
  // iterator becomes CPython's _PySequence_IterSearch message)
  let it;
  try {
    it = iter(c);
  } catch (e) {
    if (!isinstance(e, T.TypeError)) throw e;
    raise(T.TypeError, `argument of type '${typeName(c)}' is not a container or iterable`);
  }
  for (let v = it.$next(); v !== DONE; v = it.$next()) if (eqBool(v, x)) return true;
  return false;
}

// ------------------------------------------------------------------ truth, len, hash

export function truth(x: any): boolean {
  if (x === true) return true;
  if (x === false) return false;
  if (typeof x === "number") return x !== 0;
  return truthSlow(x);
}
function truthSlow(x: any): boolean {
  if (x === null) return false;
  if (typeof x === "string") return x.length !== 0;
  if (typeof x === "bigint") return x !== 0n;
  if (x instanceof FloatBox) return x.v !== 0;
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return x.length !== 0;
  if (x instanceof PyDict && (x.$cls === T.dict || layoutPlain(x.$cls))) return x.$m.size !== 0;
  if (x instanceof PyBytes) return x.n !== 0;
  // (a function or class is true unless its type says otherwise: a class's
  // metaclass may define __bool__ or __len__)
  let f = special(x, "__bool__");
  if (f !== undefined) {
    const r = f(x);
    if (typeof r !== "boolean") raise(T.TypeError, `__bool__ should return bool, returned ${typeName(r)}`);
    return r;
  }
  f = special(x, "__len__");
  if (f !== undefined) return truth(f(x));
  return true;
}

export function len(x: any): number {
  if (typeof x === "string") return SP.cpLen(x);
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return x.length;
  if (x instanceof PyDict && (x.$cls === T.dict || layoutPlain(x.$cls))) return x.$m.size;
  if (x instanceof PySet && (x.$cls === T.set || x.$cls === T.frozenset)) return x.$d.$m.size;
  if (x instanceof PyBytes) return x.n;
  const f = special(x, "__len__");
  if (f !== undefined) {
    // (the result as CPython's slot_sq_length takes it: through the index
    // protocol, an int subclass as its own value)
    const r = f(x);
    const n = isPyInt(r) ? r : index(r);
    if (n < 0) raise(T.ValueError, "__len__() should return >= 0");
    if (typeof n === "bigint") {
      if (n > 9223372036854775807n) raise(T.OverflowError, "cannot fit 'int' into an index-sized integer");
      return n as any; // exact, for lengths beyond 2**53 (big ranges)
    }
    return Number(n);
  }
  raise(T.TypeError, `object of type '${typeName(x)}' has no len()`);
}

// The size list(x) presizes for, as CPython's PyObject_LengthHint after
// taking x's iterator: len(x), or, where x has no __len__ or it raises
// TypeError, __length_hint__ (looked up only then; TypeError and
// NotImplemented: no guess). Called for its errors: anything else either
// raises, len's result through the index protocol (len()), a hint that is
// not an int (an int subclass is its own value), negative or past a C
// ssize_t, and a guess too large to allocate (a MemoryError: past a JS
// array's length here). A type whose __len__ and __length_hint__ are both
// absent or builtin types' (which cannot raise there) is not asked.
const builtinSlot = (t: any, name: string): boolean => {
  for (const c of t.$mro) if (c.$dict?.has(name)) return c.$ctor === null;
  return true;
};
export function lengthHint(x: any): void {
  if (x === null || typeof x !== "object") return;
  const t: any = typeOf(x);
  if (builtinSlot(t, "__len__") && builtinSlot(t, "__length_hint__")) return;
  let n: number | bigint | undefined;
  if (special(x, "__len__") !== undefined) {
    try {
      n = len(x);
    } catch (e: any) {
      if (!isExc(e, T.TypeError)) throw e;
    }
  }
  if (n === undefined) {
    // (looked up and bound as CPython's _PyObject_LookupSpecial: a
    // function as itself, any other value through its type's __get__,
    // whose errors are raised; then called without arguments, where a
    // TypeError, from the call alone, means no guess)
    // (x's type now: __len__ may have changed x's __class__)
    const tn: any = typeOf(x);
    let f = lookupType(tn, "__length_hint__");
    if (f === undefined) return;
    // (a Python function: $pyfn, but not a builtin type's method, which has
    // $pyfn too, with $builtinMethod and its $owner)
    const pyfn = typeof f === "function" && f.$pyfn === true && f.$builtinMethod !== true && f.$owner === undefined;
    let method = builtinSlot(tn, "__length_hint__") || pyfn;
    if (f !== null && typeof f === "object" && f.asDunder !== undefined) {
      f = f.asDunder();
      method = true;
    }
    let call: () => any;
    // (a Python function, a staticmethod or classmethod, or a builtin type's
    // method found on that type, bound without fail; a builtin type's method
    // put on another class, bound with its receiver check (CPython's method
    // descriptor's: a wrong receiver is a TypeError then); anything else (a
    // class, a builtin function, a callable object, a descriptor) as CPython
    // binds it)
    if (method) call = () => f(x);
    else if (typeof f === "function" && f.$owner !== undefined) {
      if (!isinstance(x, f.$owner)) raise(T.TypeError, `descriptor '${f.__name__}' for '${f.$owner.$name}' objects doesn't apply to a '${typeName(x)}' object`);
      call = () => f(x);
    } else {
      const get = lookupType(typeOf(f), "__get__");
      const bound = get !== undefined ? callObj(get, [f, x, tn]) : f;
      call = () => callObj(bound, []);
    }
    let v: any;
    try {
      v = call();
    } catch (e: any) {
      if (isExc(e, T.TypeError)) return;
      throw e;
    }
    if (v === NotImplemented) return;
    let b: bigint;
    if (isPyInt(v)) b = BigInt(v);
    else if (v instanceof PrimBox && typeOf(v).$mro.includes(T.int) && shimName(v, "int") === null) b = BigInt(v.$v);
    else raise(T.TypeError, `__length_hint__ must be an integer, not ${typeName(v)}`);
    if (b > 9223372036854775807n || b < -9223372036854775808n) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
    if (b < 0n) raise(T.ValueError, "__length_hint__() should return >= 0");
    n = b;
  }
  if (BigInt(n) > 4294967295n) raise(T.MemoryError);
}

const HASH_MOD = (1n << 61n) - 1n;

function hashInt(x: number | bigint): number {
  if (typeof x === "number" && x >= -1073741824 && x < 1073741824) return x === -1 ? -2 : x;
  return Number(hashIntExact(x));
}
function hashIntExact(x: number | bigint): bigint {
  const b = big(x);
  const neg = b < 0n;
  let h = (neg ? -b : b) % HASH_MOD;
  if (neg) h = -h;
  return h === -1n ? -2n : h;
}

// hash() as CPython computes it, exactly (dict internals use hashAny,
// which may round large values to doubles).
export function hashExact(x: any): any {
  if (typeof x === "boolean") return +x;
  if (isPyInt(x)) return normBig(hashIntExact(x));
  if (typeof x === "number" || x instanceof FloatBox) {
    const v = fv(x)!;
    if (!Number.isFinite(v) || (isInt(v) && Math.abs(v) < 2 ** 52)) return hashFloat(v);
    if (isInt(v)) return normBig(hashIntExact(BigInt(v)));
    return normBig(hashFloatExact(v));
  }
  if (x !== null && typeof x === "object" && x.$cls !== undefined && !(x instanceof PySet)) {
    const f = lookupType(x.$cls, "__hash__");
    if (f !== undefined && f !== null && f !== objectHash) {
      const r = f(x);
      if (typeof r === "bigint") return normBig(hashIntExact(r));
      if (typeof r === "boolean") return +r;
      if (typeof r === "number" && isInt(r)) return r === -1 ? -2 : r;
      raise(T.TypeError, "__hash__ method should return an integer");
    }
  }
  return hashAny(x);
}

// CPython's _Py_HashDouble.
function hashFloat(v: number): number {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 0 : v > 0 ? 314159 : -314159;
  if (isInt(v)) return hashInt(isSafe(v) ? v : BigInt(v));
  return Number(hashFloatExact(v));
}
function hashFloatExact(v: number): bigint {
  let m = Math.abs(v);
  let e = 0;
  while (m >= 1) {
    m /= 2;
    e++;
  }
  while (m < 0.5) {
    m *= 2;
    e--;
  }
  let x = 0n;
  while (m) {
    x = ((x << 28n) & HASH_MOD) | (x >> 33n);
    m *= 268435456.0;
    e -= 28;
    const y = Math.floor(m);
    m -= y;
    x += BigInt(y);
    if (x >= HASH_MOD) x -= HASH_MOD;
  }
  const ee = ((e % 61) + 61) % 61;
  x = ((x << BigInt(ee)) & HASH_MOD) | (x >> BigInt(61 - ee));
  if (v < 0) x = -x;
  return x === -1n ? -2n : x;
}

// FNV-1a.  CPython randomizes str hashes per process, so programs cannot
// depend on their values.
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h === -1 ? -2 : h;
}

let idCounter = 0x7f0000001000;
const ids = new WeakMap<object, number>();
export function id(x: any): number {
  if (x === null || (typeof x !== "object" && typeof x !== "function")) return 0x7e0000000000 + (hashAny(x) & 0xffffff) * 32;
  let v = ids.get(x);
  if (v === undefined) {
    v = idCounter += 32;
    ids.set(x, v);
  }
  return v;
}

export function hashAny(x: any): number {
  switch (typeof x) {
    case "number":
      return isInt(x) ? hashInt(x) : hashFloat(x);
    case "bigint":
      return hashInt(x);
    case "string":
      return hashStr(x);
    case "boolean":
      return x ? 1 : 0;
  }
  if (x === null) return 0x5f5e1;
  if (x instanceof FloatBox) return hashFloat(x.v);
  if (Array.isArray(x) && (x as any).$cls === undefined) {
    if ((x as any).$t !== true) raise(T.TypeError, "unhashable type: 'list'");
    return hashTuple(x);
  }
  if (x instanceof PySet && x.$frozen) {
    let h = 0;
    for (const v of setItems(x)) h ^= hashAny(v) * 3644798167;
    return h | 0;
  }
  const t = typeOf(x);
  const f = lookupType(t, "__hash__");
  if (f === null) raise(T.TypeError, `unhashable type: '${t.$name}'`);
  if (f !== undefined && f !== objectHash) {
    const r = f(x);
    if (typeof r === "number" && isInt(r)) return r;
    if (typeof r === "boolean") return +r;
    if (typeof r === "bigint") return hashInt(r);
    raise(T.TypeError, "__hash__ method should return an integer");
  }
  return id(x) / 32;
}

export function hashTupleOf(a: any[]): number {
  return hashTuple(a);
}
// CPython's tuplehash (xxHash-based) on 64-bit lanes.
function hashTuple(a: any[]): number {
  const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P5 = 2870177450012600261n, M = (1n << 64n) - 1n;
  let acc = P5;
  for (const v of a) {
    const lane = BigInt.asUintN(64, BigInt(hashAny(v)));
    acc = (acc + lane * P2) & M;
    acc = ((acc << 31n) | (acc >> 33n)) & M;
    acc = (acc * P1) & M;
  }
  acc = (acc + (BigInt(a.length) ^ (P5 ^ 3527539n))) & M;
  if (acc === M) return 1546275796;
  return Number(BigInt.asIntN(64, acc));
}

function markPy(f: any, name: string) {
  f.$pyfn = true;
  f.__name__ = name;
  f.__qualname__ = name;
  return f;
}
export const objectHash = markPy(function __hash__(self: any) {
  return id(self) / 32;
}, "__hash__");
export const objectEq = markPy(function __eq__(self: any, other: any) {
  return self === other ? true : NotImplemented;
}, "__eq__");
export const objectNe = markPy(function __ne__(self: any, other: any) {
  const eq = typeDunder(typeOf(self), "__eq__");
  const r = eq === undefined ? NotImplemented : eq(self, other);
  return r === NotImplemented ? r : !truth(r);
}, "__ne__");

hooks.hash = hashAny;
hooks.eq = eqBool;

// ------------------------------------------------------------------ iteration
//
// Every iterator answers $next(), returning DONE when exhausted.  Compiled
// for-loops call $next() directly; no {value, done} objects are allocated.

export class ListIter {
  i = 0;
  constructor(public a: any[]) {}
  $next(): any {
    const a = this.a;
    return this.i < a.length ? a[this.i++] : DONE;
  }
}
export class RangeIter {
  constructor(public cur: number, public stop: number, public step: number) {}
  $next(): any {
    const c = this.cur;
    if (this.step > 0 ? c < this.stop : c > this.stop) {
      this.cur = c + this.step;
      return c;
    }
    return DONE;
  }
}
export class StrIter {
  i = 0;
  constructor(public s: string) {}
  $next(): any {
    const s = this.s;
    if (this.i >= s.length) return DONE;
    const cp = s.codePointAt(this.i)!;
    const ch = String.fromCodePoint(cp);
    this.i += ch.length;
    return ch;
  }
}
// kind: 0 keys, 1 values, 2 items. A dict's iterator, as CPython's: a
// changed size raises at every step after; it gives at most as many items
// as the dict had (so a loop that replaces each key it is given with a new
// one ends: "dictionary keys changed during iteration", and then no more);
// after clear(), it goes on in the new entries from the position it had
// reached.
// (an exhausted dict iterator's dict: empty, never changed, so the checks
// at each step pass and it gives no more, whatever its dict does after)
const ENDED = new PyDict();
const ENDED_META = dictMeta(ENDED);
const NOTHING: Iterator<any> = [][Symbol.iterator]();
export class DictIter {
  it: Iterator<any>;
  size: number;
  left: number;
  x: DictMeta;
  clears: number;
  constructor(public d: PyDict, public kind: number = 0) {
    const m = d.$m;
    this.it = kind === 1 ? m.values() : kind === 0 ? m.keys() : m.entries();
    this.size = this.left = m.size;
    this.x = dictMeta(d);
    this.clears = this.x.clears;
  }
  // (each kind's $next has the checks written out: the hot path)
  $next(): any {
    const d = this.d;
    // (one branch for both: the size changed, or the dict was cleared)
    if (((d.$m.size !== this.size) as any) | ((this.x.clears !== this.clears) as any)) this.changed();
    const r = this.it.next();
    if (r.done) return this.end();
    if (--this.left < 0) this.keysChanged();
    return dictKeyOf(d, r.value);
  }
  // (the rest at once, for list(d), tuple(d), sorted(d) and the like: no
  // user code runs as it goes, so the same items, checks and errors as one
  // $next at a time)
  rest(): any[] {
    const d = this.d;
    if (((d.$m.size !== this.size) as any) | ((this.x.clears !== this.clears) as any)) this.changed();
    const it = this.it;
    const out: any[] = [];
    if (this.kind === 0) for (let r = it.next(); !r.done; r = it.next()) out.push(dictKeyOf(d, r.value));
    else if (this.kind === 1) for (let r = it.next(); !r.done; r = it.next()) out.push(r.value);
    else for (let r = it.next(); !r.done; r = it.next()) out.push(tuple([dictKeyOf(d, r.value[0]), r.value[1]]));
    // (more than it may give: the same error one $next at a time meets)
    if (out.length > this.left) this.keysChanged();
    this.end();
    return out;
  }
  // (exhausted: no more, as CPython's, whatever the dict does after)
  end(): any {
    this.d = ENDED;
    this.x = ENDED_META;
    this.size = this.left = 0;
    this.clears = 0;
    this.it = NOTHING;
    return DONE;
  }
  keysChanged(): never {
    this.end();
    return raise(T.RuntimeError, "dictionary keys changed during iteration");
  }
  changed(): void {
    const d = this.d, m = d.$m;
    if (m.size !== this.size) {
      this.size = -1;
      raise(T.RuntimeError, "dictionary changed size during iteration");
    }
    // (cleared: on in the new entries, from the position it had reached)
    this.clears = this.x.clears;
    this.it = this.kind === 1 ? m.values() : this.kind === 0 ? m.keys() : m.entries();
    for (let i = this.size - this.left; i > 0; i--) this.it.next();
  }
}
export class DictValueIter extends DictIter {
  constructor(d: PyDict) {
    super(d, 1);
  }
  $next(): any {
    const d = this.d;
    if (((d.$m.size !== this.size) as any) | ((this.x.clears !== this.clears) as any)) this.changed();
    const r = this.it.next();
    if (r.done) return this.end();
    if (--this.left < 0) this.keysChanged();
    return r.value;
  }
}
export class DictItemIter extends DictIter {
  constructor(d: PyDict) {
    super(d, 2);
  }
  $next(): any {
    const d = this.d;
    if (((d.$m.size !== this.size) as any) | ((this.x.clears !== this.clears) as any)) this.changed();
    const r = this.it.next();
    if (r.done) return this.end();
    if (--this.left < 0) this.keysChanged();
    return tuple([dictKeyOf(d, r.value[0]), r.value[1]]);
  }
}
// kind: 0 keys, 1 values, 2 items
export function dictIter(d: PyDict, kind: number): DictIter {
  return kind === 0 ? new DictIter(d) : kind === 1 ? new DictValueIter(d) : new DictItemIter(d);
}
// A set's: a changed size raises at every step after, in a set's words
export class SetIter {
  it: Iterator<any>;
  size: number;
  constructor(public d: PyDict) {
    this.it = d.$m.keys();
    this.size = d.$m.size;
  }
  $next(): any {
    if (this.d.$m.size !== this.size) {
      this.size = -1;
      raise(T.RuntimeError, "Set changed size during iteration");
    }
    const r = this.it.next();
    return r.done ? DONE : dictKeyOf(this.d, r.value);
  }
}
// reversed() of a dict or its views: from the last entry back, as CPython's;
// a changed size raises; an entry deleted since is passed over; a value is
// read as it is when reached; after clear(), it goes on in the new entries
// from the same position. What it needs is taken at the start, the keys
// and, for the values and items, the values (LIMIT-PR66-2); a plain dict
// counts, once it has had an iterator, the changes that leave its size as
// it was (ver: a deletion, a clear(), a value stored over one there), and
// while its size and that are as they were, what was taken is the dict's,
// and nothing is looked up. After a change, each key is looked up as it is
// reached, and each value read from the dict, for good (one-way).
// reversed() of the values takes no keys: told just before a key is
// deleted (rev), it takes them then, as they were; after only values were
// stored, the dict's keys are in the order they had. A dict of attributes,
// globals or a class, or one sharing its Map (a function's __dict__), can
// change without the dict: for it, each is always looked up.
export class DictRevIter {
  keys: any[] | null;
  vals: any[] | null;
  x: DictMeta;
  size: number;
  i: number;
  clears: number;
  ver: number;
  live: boolean;
  constructor(public d: PyDict, public kind: number) {
    const m = d.$m;
    const x = (this.x = dictMeta(d));
    this.size = m.size;
    this.i = m.size - 1;
    this.clears = x.clears;
    this.ver = x.ver;
    this.live = m.constructor !== Map || x.shared;
    if (kind === 1 && !this.live) {
      this.keys = null;
      this.vals = [...m.values()];
      // (the reversed() of its values before this one takes its keys now)
      x.rev?.deref()?.keep();
      x.rev = new WeakRef(this);
    } else {
      this.keys = [...m.keys()];
      this.vals = kind === 2 && !this.live ? [...m.values()] : null;
    }
  }
  // (the keys as they are now: before a deletion, or after only stores)
  keep(): void {
    if (this.keys === null) this.keys = [...this.d.$m.keys()];
  }
  $next(): any {
    const d = this.d;
    if (((d.$m.size !== this.size) as any) | ((this.x.ver !== this.ver) as any)) this.changed();
    if (!this.live) {
      const i = this.i;
      if (i < 0) return this.end();
      this.i = i - 1;
      if (this.kind === 1) return this.vals![i];
      const k = this.keys![i];
      if (this.kind === 0) return dictKeyOf(d, k);
      return tuple([dictKeyOf(d, k), this.vals![i]]);
    }
    const keys = this.keys!;
    while (this.i >= 0) {
      const k = keys[this.i--];
      if (!d.$m.has(k)) continue;
      if (this.kind === 0) return dictKeyOf(d, k);
      if (this.kind === 1) return d.$m.get(k);
      return tuple([dictKeyOf(d, k), d.$m.get(k)]);
    }
    return this.end();
  }
  changed(): void {
    const d = this.d, x = this.x;
    if (d.$m.size !== this.size) {
      this.size = -1;
      raise(T.RuntimeError, "dictionary changed size during iteration");
    }
    this.ver = x.ver;
    if (x.rev?.deref() === this) x.rev = null;
    if (x.clears !== this.clears) {
      // (cleared: the new entries, from the same position)
      this.clears = x.clears;
      this.keys = [...d.$m.keys()];
    } else {
      // (a key deleted (its keys were taken just before), or values stored
      // (its keys are in the order they had))
      this.keep();
    }
    this.vals = null;
    this.live = true;
  }
  // (exhausted: no more, whatever the dict does after)
  end(): any {
    if (this.x.rev?.deref() === this) this.x.rev = null;
    this.d = ENDED;
    this.x = ENDED_META;
    this.size = 0;
    this.clears = 0;
    this.ver = 0;
    this.keys = [];
    this.vals = null;
    return DONE;
  }
}

export class BytesIter {
  i = 0;
  constructor(public b: PyBytes) {}
  $next(): any {
    return this.i < this.b.n ? this.b.a[this.i++] : DONE;
  }
}
export class GenIter {
  constructor(public g: Generator) {}
  $next(): any {
    const r = genStep(this.g, false, undefined);
    return r.done ? DONE : r.value;
  }
}

// The GeneratorExit being thrown into a generator by close(), if any.
export const closing: { e: any } = { e: null };

// One step of a generator (next/send, or throw), with Python's rules: a
// StopIteration escaping the body becomes RuntimeError (PEP 479), re-entry is
// a ValueError, and a just-started generator only accepts None.
export function genStep(g: any, isThrow: boolean, arg: any): IteratorResult<any> {
  if (g.$started !== true) {
    if (!isThrow && arg !== undefined && arg !== null) raise(T.TypeError, "can't send non-None value to a just-started generator");
    g.$started = true;
  }
  // The generator's own handled exceptions go above its caller's while it
  // runs, and come off with it when it pauses (CPython's per-frame exc_info).
  const base = handledExceptions.length;
  if (g.$exc !== undefined) resumeOwn(g);
  let paused = false;
  try {
    const r = isThrow ? thrown(g, arg) : g.next(arg);
    if (r.done && r.value === undefined) r.value = null;
    paused = !r.done;
    return r;
  } catch (e: any) {
    if (isExc(e, T.StopIteration)) {
      hooks.genRaised(e);
      const err = markRaised(T.RuntimeError(g.$async ? "coroutine raised StopIteration" : "generator raised StopIteration"));
      err.__cause__ = e;
      throw err;
    }
    if (e instanceof TypeError && /already running|is executing/.test(e.message)) raise(T.ValueError, "generator already executing");
    throw e;
  } finally {
    if (handledExceptions.length > base) {
      const own = handledExceptions.splice(base);
      if (paused) g.$exc = own;
    }
  }
}
// (out of genStep's line, the rare work: a generator resuming with its own
// handled exceptions, their tracebacks' new outer frames; an exception
// thrown into one)
function resumeOwn(g: any) {
  for (const e of g.$exc) hooks.excResumed(e);
  handledExceptions.push(...g.$exc);
  g.$exc = undefined;
}
function thrown(g: any, arg: any): IteratorResult<any> {
  hooks.excThrown(arg);
  return g.throw(arg);
}
// A generator's return(v) (JS's, when the frame delegating to it is
// returned from), with its own handled exceptions around it, as genStep.
export function genReturn(g: any, v: any): IteratorResult<any> {
  const base = handledExceptions.length;
  if (g.$exc !== undefined) resumeOwn(g);
  let paused = false;
  try {
    const r = g.return(v);
    paused = !r.done;
    return r;
  } finally {
    if (handledExceptions.length > base) {
      const own = handledExceptions.splice(base);
      if (paused) g.$exc = own;
    }
  }
}

// What a `yield from` or `await` of a generator or coroutine delegates to
// (JS's yield*): its every step a step of its own frame, through genStep, so
// it keeps its own handled exceptions however it is resumed (CORR-B7F-1).
class Delegate {
  constructor(public g: any) {}
  [Symbol.iterator]() {
    return this;
  }
  next(v: any) {
    return genStep(this.g, false, v);
  }
  throw(e: any) {
    return genStep(this.g, true, e);
  }
  return(v: any) {
    return genReturn(this.g, v);
  }
}
export function delegateTo(g: any): any {
  return new Delegate(g);
}

// The StopIteration a ProtoIter swallowed most recently, so wrappers such as
// enumerate and map can re-raise it with its value.
export const lastStop: { e: any } = { e: null };

// Any object implementing __next__.
export class ProtoIter {
  nx: any;
  constructor(public o: any) {
    const f = lookupType(typeOf(o), "__next__");
    if (f === undefined) raise(T.TypeError, `iter() returned non-iterator of type '${typeName(o)}'`);
    this.nx = f;
  }
  $next(): any {
    try {
      return this.nx(this.o);
    } catch (e: any) {
      if (isExc(e, T.StopIteration)) {
        lastStop.e = e;
        return DONE;
      }
      throw e;
    }
  }
}
export class GetitemIter {
  i = 0;
  constructor(public o: any, public gi: any) {}
  $next(): any {
    try {
      return this.gi(this.o, this.i++);
    } catch (e: any) {
      if (isExc(e, T.IndexError) || isExc(e, T.StopIteration)) return DONE;
      throw e;
    }
  }
}
function isExc(e: any, cls: PyType): boolean {
  return e !== null && typeof e === "object" && e.$cls !== undefined && e.$cls.$mro.includes(cls);
}
const isGen = (x: any) => x !== null && typeof x === "object" && x[Symbol.toStringTag] === "Generator";

export function iter(x: any): any {
  if (Array.isArray(x) && ((x as any).$cls === undefined || layoutPlain((x as any).$cls))) return new ListIter(x);
  if (typeof x === "string") return new StrIter(x);
  const isObj = x !== null && typeof x === "object";
  if (isObj) {
    if (typeof x.$next === "function") return x;
    if (x instanceof PyDict && x.$cls === T.dict) return new DictIter(x);
    if (x instanceof PySet && (x.$cls === T.set || x.$cls === T.frozenset)) return new SetIter(x.$d);
    if (x instanceof PyBytes) return new BytesIter(x);
    if (isGen(x)) return new GenIter(x);
  }
  // (a class iterates by its metaclass's __iter__ or __getitem__, as an
  // Enum does: classes are functions here)
  if (isObj || typeof x === "function") {
    const f = special(x, "__iter__");
    if (f !== undefined) {
      const it = f(x);
      if (it !== null && typeof it === "object" && typeof it.$next === "function") return it;
      if (isGen(it)) return new GenIter(it);
      return new ProtoIter(it);
    }
    const gi = special(x, "__getitem__");
    if (gi !== undefined) return new GetitemIter(x, gi);
  }
  raise(T.TypeError, `'${typeName(x)}' object is not iterable`);
}

export function next(it: any, dflt?: any): any {
  if (it !== null && typeof it === "object" && typeof it.$next === "function") {
    lastStop.e = null;
    const v = it.$next();
    if (v !== DONE) return v;
    if (dflt !== undefined) return dflt;
    throw lastStop.e ?? markRaised(T.StopIteration());
  }
  if (isGen(it)) {
    const r = genStep(it, false, undefined);
    if (!r.done) return r.value;
    if (dflt !== undefined) return dflt;
    throw stopIteration(r.value);
  }
  const f = special(it, "__next__");
  if (f === undefined) raise(T.TypeError, `'${typeName(it)}' object is not an iterator`);
  if (dflt === undefined) return f(it);
  try {
    return f(it);
  } catch (e: any) {
    if (isExc(e, T.StopIteration)) return dflt;
    throw e;
  }
}

export function stopIteration(value: any): any {
  return markRaised(T.StopIteration(...(value === undefined || value === null ? [] : [value])));
}

// (Stop is polled every 1024 items: a builtin consuming a long iterable,
// math.fsum(range(10**12)) say, can be interrupted)
export function forEach(x: any, f: (v: any) => void) {
  if (Array.isArray(x)) {
    for (let i = 0; i < x.length; i++) {
      if ((i & 1023) === 1023) pollInterrupt();
      f(x[i]);
    }
    return;
  }
  const it = iter(x);
  // (polled before the next item is taken: an iterator stopped here resumes
  // with the item after the last one used, none lost)
  for (let n = 1; ; n++) {
    if ((n & 1023) === 0) pollInterrupt();
    const v = it.$next();
    if (v === DONE) return;
    f(v);
  }
}

export function pollInterrupt() {
  if (consumeCtrlC()) raise(T.KeyboardInterrupt);
}

export function toArray(x: any): any[] {
  if (Array.isArray(x)) return x.slice();
  const it = iter(x);
  if (it instanceof DictIter) return it.rest();
  const out: any[] = [];
  for (let v = it.$next(); v !== DONE; v = it.$next()) out.push(v);
  return out;
}

// `a, b = x`. Too many values: CPython 3.14 says how many only for an
// exact list, tuple or dict, whose length it knows
const tooMany = (x: any, n: number) => {
  const t = typeOf(x);
  const known = t === T.list || t === T.tuple || t === T.dict ? `, got ${len(x)}` : "";
  return raise(T.ValueError, `too many values to unpack (expected ${n}${known})`);
};
export function unpack(x: any, n: number): any[] {
  if (Array.isArray(x)) {
    if (x.length === n) return x;
    if (x.length < n) raise(T.ValueError, `not enough values to unpack (expected ${n}, got ${x.length})`);
    tooMany(x, n);
  }
  const it = iter(x);
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const v = it.$next();
    if (v === DONE) raise(T.ValueError, `not enough values to unpack (expected ${n}, got ${i})`);
    out.push(v);
  }
  if (it.$next() !== DONE) tooMany(x, n);
  return out;
}
// `a, *b, c = x` -> [a, [b...], c]
export function unpackEx(x: any, before: number, after: number): any[] {
  const all = toArray(x);
  if (all.length < before + after) raise(T.ValueError, `not enough values to unpack (expected at least ${before + after}, got ${all.length})`);
  return [...all.slice(0, before), all.slice(before, all.length - after), ...all.slice(all.length - after)];
}

// ------------------------------------------------------------------ sets

// A set is a dict whose values are all `true`.
// (a set's elements: a dict's keys, marked for the unhashable-element
// message, object.ts keyHash)
const elemDict = (): PyDict => {
  const d = new PyDict();
  (d as any).$elem = true;
  return d;
};
export class PySet {
  declare $cls: any;
  $d = elemDict();
  $frozen = false;
}
export function newSet(items?: any, frozen = false): PySet {
  const s = new PySet();
  s.$frozen = frozen;
  if (items !== undefined) forEach(items, (v) => dictSet(s.$d, v, true));
  return s;
}
export function setAdd(s: PySet, v: any) {
  dictSet(s.$d, v, true);
}
export function setItems(s: PySet): any[] {
  const out: any[] = [];
  for (const k of s.$d.$m.keys()) out.push(dictKeyOf(s.$d, k));
  return out;
}
// Sets whose keys all normalize to JS primitives share one key space, so
// set algebra can work on the underlying Map keys directly.
const flat = (s: PySet) => s.$d.$buckets === null;

export function setSubset(a: PySet, b: PySet): boolean {
  if (a.$d.$m.size > b.$d.$m.size) return false;
  if (flat(a) && flat(b)) {
    const bm = b.$d.$m;
    for (const k of a.$d.$m.keys()) if (!bm.has(k)) return false;
    return true;
  }
  return setItems(a).every((v) => dictGet(b.$d, v) !== undefined);
}

export function setOp(a: PySet, b: PySet, op: string): PySet {
  const r = new PySet();
  r.$frozen = a.$frozen;
  if (flat(a) && flat(b)) {
    const am = a.$d.$m, bm = b.$d.$m, rm = r.$d.$m;
    // Equal keys keep the version CPython keeps: union and difference take
    // a's, intersection takes the smaller (iterated) set's.
    const ao = a.$d.$orig, bo = b.$d.$orig;
    let ro: Map<any, any> | null = null;
    const add = (k: any, orig: Map<any, any> | null) => {
      rm.set(k, true);
      const o = orig?.get(k);
      if (o !== undefined) (ro ??= new Map()).set(k, o);
    };
    if (op === "or") {
      for (const k of am.keys()) add(k, ao);
      for (const k of bm.keys()) if (!am.has(k)) add(k, bo);
    } else if (op === "and") {
      const aSmall = am.size <= bm.size;
      const [x, y, xo] = aSmall ? [am, bm, ao] : [bm, am, bo];
      for (const k of x.keys()) if (y.has(k)) add(k, xo);
    } else if (op === "sub") {
      for (const k of am.keys()) if (!bm.has(k)) add(k, ao);
    } else {
      for (const k of am.keys()) if (!bm.has(k)) add(k, ao);
      for (const k of bm.keys()) if (!am.has(k)) add(k, bo);
    }
    r.$d.$orig = ro;
    return r;
  }
  if (op === "or") {
    for (const v of setItems(a)) setAdd(r, v);
    for (const v of setItems(b)) setAdd(r, v);
  } else if (op === "and") {
    for (const v of setItems(a)) if (dictGet(b.$d, v) !== undefined) setAdd(r, v);
  } else if (op === "sub") {
    for (const v of setItems(a)) if (dictGet(b.$d, v) === undefined) setAdd(r, v);
  } else {
    for (const v of setItems(a)) if (dictGet(b.$d, v) === undefined) setAdd(r, v);
    for (const v of setItems(b)) if (dictGet(a.$d, v) === undefined) setAdd(r, v);
  }
  return r;
}
export function setInplace(a: PySet, b: PySet, op: string): PySet {
  a.$d = setOp(a, b, op).$d;
  return a;
}

// ------------------------------------------------------------------ dict helpers

export function dictCopy(d: PyDict): PyDict {
  const r = new PyDict();
  for (const [k, v] of d.$m) dictSet(r, dictKeyOf(d, k), v);
  return r;
}
export function dictUpdate(d: PyDict, other: any) {
  if (other instanceof PyDict) {
    for (const [k, v] of other.$m) dictSet(d, dictKeyOf(other, k), v);
    return;
  }
  const keys = special(other, "keys");
  if (keys !== undefined) {
    forEach(keys(other), (k) => dictSet(d, k, getitem(other, k)));
    return;
  }
  let i = 0;
  forEach(other, (item) => {
    const kv = toArray(item);
    if (kv.length !== 2) raise(T.ValueError, `dictionary update sequence element #${i} has length ${kv.length}; 2 is required`);
    dictSet(d, kv[0], kv[1]);
    i++;
  });
}

// ------------------------------------------------------------------ subscripting

export class PySlice {
  constructor(public start: any, public stop: any, public step: any) {}
}

export function index(x: any): number | bigint {
  if (typeof x === "number" && isInt(x)) return x;
  if (typeof x === "bigint") return x;
  if (typeof x === "boolean") return +x;
  // (an int subclass is its own value, its __index__ not called, as
  // CPython's PyNumber_Index; numpy's shims, no int subclasses there, are not)
  if (x instanceof PrimBox && typeOf(x).$mro.includes(T.int) && shimName(x, "int") === null) return x.$v;
  const f = special(x, "__index__");
  if (f !== undefined) return intResult("__index__", f(x));
  raise(T.TypeError, `'${typeName(x)}' object cannot be interpreted as an integer`);
}

// A conversion hook's result, as CPython checks it: an int (for __index__
// and __int__) or a float (__float__); an instance of a strict subclass
// (bool among them) with a DeprecationWarning, as CPython 3.14's; anything
// else a TypeError
// (numpy's scalar types are shims here, Python subclasses of int and float;
// NumPy's are not, but for float64, a float subclass there too: a shim's
// result is refused, as CPython refuses NumPy's, and named as CPython names
// it, "numpy.int64")
// (Sage's RR, RDF and CC elements, Python float and complex subclasses
// here, are none in Sage: refused alike, named as Sage's types)
const SAGE_SHIMS: Record<string, string> = {
  "_sage_lang.RealNumber": "sage.rings.real_mpfr.RealNumber",
  "_sage_rdf.RealDoubleElement": "sage.rings.real_double.RealDoubleElement",
  "_sage_matrix.ComplexNumber": "sage.rings.complex_mpfr.ComplexNumber",
};
export function shimName(r: any, base: string): string | null {
  for (const c of typeOf(r).$mro) {
    const sage = SAGE_SHIMS[`${c.$module}.${c.$name}`];
    if (sage !== undefined) return c === typeOf(r) ? sage : typeName(r);
    if (c.$module !== "numpy") continue;
    if ((base === "float" && c.$name === "float64") || (base === "complex" && c.$name === "complex128")) return null;
    return c === typeOf(r) ? `numpy.${c.$name}` : typeName(r);
  }
  return null;
}
const resultTypeName = (r: any) => (typeOf(r).$module === "numpy" ? `numpy.${typeName(r)}` : typeName(r));
export function deprecationWarning(msg: string): void {
  callObj(getattr(hooks.importModule("warnings"), "warn"), [msg, T.DeprecationWarning, 2]);
}
export function deprecatedSubclass(what: string, r: any, base: string): void {
  deprecationWarning(`${what} returned non-${base} (type ${resultTypeName(r)}).  The ability to return an instance of a strict subclass of ${base} is deprecated, and may be removed in a future version of Python.`);
}
export function intResult(what: string, r: any): number | bigint {
  if ((typeof r === "number" && isInt(r)) || typeof r === "bigint") return r;
  if (typeof r === "boolean" || (r instanceof PrimBox && typeOf(r).$mro.includes(T.int) && shimName(r, "int") === null)) {
    deprecatedSubclass(what, r, "int");
    return typeof r === "boolean" ? +r : r.$v;
  }
  return raise(T.TypeError, `${what} returned non-int (type ${shimName(r, "int") ?? typeName(r)})`);
}
export function floatResult(x: any, r: any): number {
  if ((typeof r === "number" && !isInt(r)) || r instanceof FloatBox) return fv(r)!;
  if (r instanceof PrimBox && typeOf(r).$mro.includes(T.float) && shimName(r, "float") === null) {
    deprecatedSubclass(`${typeName(x)}.__float__`, r, "float");
    return fv(r)!;
  }
  return raise(T.TypeError, `${typeName(x)}.__float__ returned non-float (type ${shimName(r, "float") ?? typeName(r)})`);
}

// CPython's PySlice_GetIndicesEx: [start, step, count].
// slice.indices(len): CPython's PySlice_AdjustIndices.
// A slice index's value, as CPython checks one (_PyEval_SliceIndex,
// evaluate_slice_index): None is null; an object with __index__ (an int
// subclass by its own value) is that exact integer; anything else (a str, a
// float) is TypeError, before any conversion
export function sliceIndexExact(v: any): number | bigint | null {
  if (v === null || v === undefined) return null;
  const ok = isPyInt(v) || (v instanceof PrimBox && typeOf(v).$mro.includes(T.int) && shimName(v, "int") === null) || special(v, "__index__") !== undefined;
  if (!ok) raise(T.TypeError, "slice indices must be integers or None or have an __index__ method");
  return index(v);
}
// ...for a concrete container's bounds: clamped to +-sys.maxsize, as
// PyNumber_AsSsize_t(v, NULL) does, so always finite (dflt for None)
const SSIZE_MAX = 9223372036854775807n;
export function sliceIndex(v: any, dflt: number): number {
  const r = sliceIndexExact(v);
  if (r === null) return dflt;
  if (typeof r !== "bigint") return r;
  return Number(r > SSIZE_MAX ? SSIZE_MAX : r < -SSIZE_MAX ? -SSIZE_MAX : r);
}

// (a concrete container's slice: start, stop and step clamped, as
// PySlice_Unpack and PySlice_AdjustIndices do)
export function sliceAdjust(s: PySlice, len: number): [number, number, number] {
  const step = s.step === null ? 1 : sliceIndex(s.step, 1);
  if (step === 0) raise(T.ValueError, "slice step cannot be zero");
  const lo = step < 0 ? -1 : 0, hi = step < 0 ? len - 1 : len;
  const fix = (v: any, dflt: number) => {
    if (v === null) return dflt;
    const n = sliceIndex(v, dflt);
    if (n < 0) return Math.max(n + len, lo);
    return Math.min(n, hi);
  };
  return [fix(s.start, step < 0 ? hi : lo), fix(s.stop, step < 0 ? lo : hi), step];
}

// The exact (start, stop, step) of slice.indices(len) and of a range's
// slice, as CPython's _PySlice_GetLongIndices: arbitrary integers, never
// clamped to sys.maxsize
export function sliceLongIndices(s: PySlice, len: bigint): [bigint, bigint, bigint] {
  const st = sliceIndexExact(s.step);
  const step = st === null ? 1n : BigInt(st);
  if (step === 0n) raise(T.ValueError, "slice step cannot be zero");
  const lo = step < 0n ? -1n : 0n, hi = step < 0n ? len - 1n : len;
  const fix = (v: any, dflt: bigint) => {
    const r = sliceIndexExact(v);
    if (r === null) return dflt;
    let x = BigInt(r);
    if (x < 0n) {
      x += len;
      return x < lo ? lo : x;
    }
    return x > hi ? hi : x;
  };
  return [fix(s.start, step < 0n ? hi : lo), fix(s.stop, step < 0n ? lo : hi), step];
}

export function sliceIndices(s: PySlice, len: number): [number, number, number] {
  const [start, stop, step] = sliceAdjust(s, len);
  let n = 0;
  if (step > 0 ? start < stop : start > stop) n = Math.floor((stop - start - (step > 0 ? 1 : -1)) / step) + 1;
  return [start, step, n];
}

export function seqIndex(i: any, len: number, what: string): number {
  let j: number;
  if (typeof i === "number" && isInt(i)) j = i;
  else if (typeof i === "boolean") j = +i;
  else if (typeof i === "bigint") j = i < 0n ? -Infinity : Infinity;
  else if (i instanceof PrimBox && typeOf(i).$mro.includes(T.int) && shimName(i, "int") === null) {
    // (an int subclass: its own value, as O.index)
    const v = i.$v;
    j = typeof v === "bigint" ? (v < 0n ? -Infinity : Infinity) : v;
  } else {
    const f = special(i, "__index__");
    if (f === undefined) raise(T.TypeError, `${what} indices must be integers or slices, not ${typeName(i)}`);
    const r = intResult("__index__", f(i));
    j = typeof r === "bigint" ? (r < 0n ? -Infinity : Infinity) : r;
  }
  if (j < 0) j += len;
  if (j < 0 || j >= len) raise(T.IndexError, `${what} index out of range`);
  return j;
}

function strGetitemPairs(o: string, p: SP.Pos, k: any): string {
  const len = o.length - p.n;
  if (!(k instanceof PySlice)) return SP.charAt(o, p, seqIndex(k, len, "string"));
  const [start, step, n] = sliceIndices(k, len);
  if (step === 1) return o.slice(SP.unitOf(p, start), SP.unitOf(p, start + n));
  let r = "";
  for (let i = 0, j = start; i < n; i++, j += step) r = SP.glue(r, SP.charAt(o, p, j));
  return r;
}
const LONE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
export function getitem(o: any, k: any): any {
  if (Array.isArray(o) && (o as any).$cls === undefined) {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) return o[k];
    return arrGet(o, k);
  }
  if (o instanceof PyDict && o.$cls === T.dict) {
    const v = dictGet(o, k);
    if (v !== undefined) return v;
    throw markRaised(T.KeyError(k));
  }
  return getitemSlow(o, k);
}
export function arrGet(o: any[], k: any): any {
  {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) return o[k];
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      const r = new Array(n);
      for (let i = 0, j = start; i < n; i++, j += step) r[i] = o[j];
      return (o as any).$t === true ? tuple(r) : r;
    }
    return o[seqIndex(k, o.length, (o as any).$t === true ? "tuple" : "list")];
  }
}
export function dictGetitem(o: PyDict, k: any): any {
  const v = dictGet(o, k);
  if (v !== undefined) return v;
  return dictMissing(o, k);
}
// complex.ts: a negative float to a fractional power is complex.
export const complexHooks: { pow: (x: number, y: number) => any } = { pow: () => raise(T.ValueError, "math domain error") };
export const arrayHooks: { cls: any; get: any; set: any } = { cls: null, get: null, set: null };

// The bytes of an object supporting the buffer protocol (bytes, bytearray,
// array.array, memoryview), or undefined.
export const bufferHooks: ((x: any) => Uint8Array | undefined)[] = [];
// The bytes of a bytes-like object as a view where it has one (a
// contiguous memoryview's, not a copy of them), else as bufferOf: for a
// reader that reads them once and keeps nothing (int()).  A hook's null:
// an object whose bytes have no such view (a non-contiguous or released
// memoryview), not bytes-like for this reader, never copied (CPython's
// int() refuses it too, daybreak2 PR134-MEM-1).
export const bufferViewHooks: ((x: any) => Uint8Array | null | undefined)[] = [];
export function bufferViewOf(x: any): Uint8Array | undefined {
  for (const h of bufferViewHooks) {
    const r = h(x);
    if (r === null) return undefined;
    if (r !== undefined) return r;
  }
  return bufferOf(x);
}

export function bufferOf(x: any): Uint8Array | undefined {
  if (x instanceof PyBytes) return x.a.subarray(0, x.n);
  if (arrayHooks.cls !== null && x instanceof arrayHooks.cls) return x.bytes();
  for (const h of bufferHooks) {
    const r = h(x);
    if (r !== undefined) return r;
  }
  return undefined;
}

const NO_ATTR = {};
function getitemSlow(o: any, k: any): any {
  if (o !== null && typeof o === "object") {
    const c = o.$cls;
    // Instances of Python classes: straight to the (cached) __getitem__.
    if (c !== undefined && c.$ctor !== null && c.$jsBase === null) {
      const f = special(o, "__getitem__");
      if (f !== undefined) return f(o, k);
    }
  }
  if (arrayHooks.cls !== null && o instanceof arrayHooks.cls) return arrayHooks.get(o, k);
  if (Array.isArray(o) || o instanceof PyDict) {
    const f = special(o, "__getitem__");
    return f(o, k);
  }
  if (o instanceof PyBytes) {
    if (typeof k === "number" && k >= 0 && k < o.n && isInt(k)) return o.a[k];
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.n);
      const r = new Uint8Array(n);
      for (let i = 0, j = start; i < n; i++, j += step) r[i] = o.a[j];
      return o instanceof PyByteArray ? new PyByteArray(r) : new PyBytes(r);
    }
    return o.a[seqIndex(k, o.n, "index")];
  }
  if (typeof o === "string") {
    // (positions are code points: a string with surrogate pairs converts)
    const p = SP.pairs(o);
    if (p !== null) return strGetitemPairs(o, p, k);
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      if (step === 1) return o.slice(start, start + n);
      let r = "";
      for (let i = 0, j = start; i < n; i++, j += step) r += o[j];
      // (o has no pairs, so a pair here is two lone surrogates joined: SP.glue)
      if (LONE_PAIR.test(r)) SP.refuseMerge();
      return r;
    }
    return o[seqIndex(k, o.length, "string")];
  }
  const f = special(o, "__getitem__");
  if (f !== undefined) return f(o, k);
  // (a class: its metaclass's __getitem__ first, then its own
  // __class_getitem__ as an attribute, bound as a classmethod is, as
  // CPython's PyObject_GetItem; one without either isn't generic: CPython's
  // TypeError, never the class itself)
  if (isType(o)) {
    // (type[X] itself, as CPython's special case: type has no __class_getitem__)
    if (o === T.type) return callObj(T.GenericAlias, [o, k]);
    // (an attribute lookup, the metaclass's __getattribute__ too; None or
    // none, not subscriptable)
    const cg = getattr(o, "__class_getitem__", NO_ATTR);
    if (cg !== NO_ATTR && cg !== null) return callObj(cg, [k]);
    raise(T.TypeError, `type '${o.$name}' is not subscriptable`);
  }
  raise(T.TypeError, `'${typeName(o)}' object is not subscriptable`);
}

function dictMissing(d: PyDict, k: any): any {
  const t = typeOf(d);
  if (t !== T.dict) {
    const m = typeDunder(t, "__missing__");
    if (m !== undefined) return m(d, k);
  }
  throw markRaised(T.KeyError(k));
}

function byteValue(v: any): number {
  if (!isPyInt(v)) raise(T.TypeError, `'${typeName(v)}' object cannot be interpreted as an integer`);
  const n = Number(v);
  if (n < 0 || n > 255) raise(T.ValueError, "byte must be in range(0, 256)");
  return n;
}

function bytearraySetSlice(o: PyByteArray, k: PySlice, v: any) {
  const src: Uint8Array = bufferOf(v)?.slice() ?? Uint8Array.from(toArray(v).map(byteValue));
  const [start, step, n] = sliceIndices(k, o.n);
  if (step === 1) {
    if (src.length !== n) checkResizable(o);
    const r = new Uint8Array(o.n - n + src.length);
    r.set(o.a.subarray(0, start), 0);
    r.set(src, start);
    r.set(o.a.subarray(start + n, o.n), start + src.length);
    o.a = r;
    o.n = r.length;
    return;
  }
  if (src.length !== n) raise(T.ValueError, `attempt to assign bytes of size ${src.length} to extended slice of size ${n}`);
  const a = o.a;
  for (let i = 0, j = start; i < n; i++, j += step) a[j] = src[i];
}

export function arrSet(o: any[], k: any, v: any): void {
  if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) o[k] = v;
  else if (k instanceof PySlice) setSlice(o, k, v);
  else o[seqIndex(k, o.length, "list")] = v;
}

export function setitem(o: any, k: any, v: any): void {
  if (o !== null && typeof o === "object" && !Array.isArray(o)) {
    const c = o.$cls;
    if (c !== undefined && c.$ctor !== null && c.$jsBase === null) {
      const f = special(o, "__setitem__");
      if (f !== undefined) {
        f(o, k, v);
        return;
      }
    }
  }
  if (Array.isArray(o) && (o as any).$t !== true && (o as any).$cls === undefined) {
    if (typeof k === "number" && k >= 0 && k < o.length && isInt(k)) {
      o[k] = v;
      return;
    }
    if (k instanceof PySlice) return setSlice(o, k, v);
    o[seqIndex(k, o.length, "list")] = v;
    return;
  }
  if (o instanceof PyDict && o.$cls === T.dict) {
    dictSet(o, k, v);
    return;
  }
  if (arrayHooks.cls !== null && o instanceof arrayHooks.cls) return arrayHooks.set(o, k, v);
  if (o instanceof PyByteArray) {
    if (k instanceof PySlice) return bytearraySetSlice(o, k, v);
    o.a[seqIndex(k, o.n, "bytearray")] = byteValue(v);
    return;
  }
  const f = special(o, "__setitem__");
  if (f !== undefined) {
    f(o, k, v);
    return;
  }
  raise(T.TypeError, `'${typeName(o)}' object does not support item assignment`);
}

function setSlice(o: any[], k: PySlice, v: any) {
  const items = toArray(v);
  const [start, step, n] = sliceIndices(k, o.length);
  if (step === 1) {
    o.splice(start, n, ...items);
    return;
  }
  if (items.length !== n) raise(T.ValueError, `attempt to assign sequence of size ${items.length} to extended slice of size ${n}`);
  for (let i = 0, j = start; i < n; i++, j += step) o[j] = items[i];
}

export function delitem(o: any, k: any): void {
  if (Array.isArray(o) && (o as any).$t !== true && (o as any).$cls === undefined) return arrDel(o, k);
  if (o instanceof PyDict && o.$cls === T.dict) {
    if (!dictDelete(o, k)) throw markRaised(T.KeyError(k));
    return;
  }
  const f = special(o, "__delitem__");
  if (f !== undefined) {
    f(o, k);
    return;
  }
  raise(T.TypeError, `'${typeName(o)}' object doesn't support item deletion`);
}
export function arrDel(o: any[], k: any): void {
  {
    if (k instanceof PySlice) {
      const [start, step, n] = sliceIndices(k, o.length);
      if (step === 1) o.splice(start, n);
      else {
        const drop = new Set<number>();
        for (let i = 0, j = start; i < n; i++, j += step) drop.add(j);
        const keep = o.filter((_, i) => !drop.has(i));
        o.length = 0;
        o.push(...keep);
      }
      return;
    }
    o.splice(seqIndex(k, o.length, "list"), 1);
    return;
  }
}

// `str % args`, filled in by format.ts.
export const strFormatOpHook: { f: (s: string, args: any) => string } = { f: () => "" };
