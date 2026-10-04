// Builtin functions, the builtins module, stdout, and builtin modules.

import { writeSync, readSync } from "fs";
import {
  T, PyType, FloatBox, PyDict, DONE, NotImplemented, Ellipsis, typeOf, typeName, lookupType, isType, raise, builtin, sig, tuple,
  isinstance, getattr, setattr, delattr, callObj, callKw, bindArgs, dictSet, dictGet, hasInstanceDict, PyBytes, builtinType, checkArity,
} from "./object";
import * as O from "./ops";
import { repr, str, format, formatFixed } from "./format";
import * as Ty from "./types";

const isInt = Number.isInteger;

// ------------------------------------------------------------------ stdout

export class StdStream {
  buf: string[] = [];
  size = 0;
  constructor(public fd: number, public name: string) {}
  write(s: string) {
    this.buf.push(s);
    this.size += s.length;
    if (this.size > 1 << 16 || this.fd === 2) this.flush();
  }
  flush() {
    if (this.fd === 2) stdout.flush();
    if (this.buf.length) {
      const data = this.buf.join("");
      this.buf = [];
      this.size = 0;
      writeSync(this.fd, data);
    }
  }
}
export const stdout = new StdStream(1, "<stdout>");
export const stderr = new StdStream(2, "<stderr>");
const streamType = builtinType("TextIOWrapper", [T.object], () => raise(T.TypeError, "cannot create 'TextIOWrapper' instances"), "_io");
Ty.bindClass(StdStream, streamType);
Ty.method(streamType, "write", (s: StdStream, x: any) => {
  if (typeof x !== "string") raise(T.TypeError, `write() argument must be str, not ${typeName(x)}`);
  s.write(x);
  return x.length;
});
Ty.method(streamType, "flush", (s: StdStream) => (s.flush(), null));
Ty.getset(streamType, "name", (s) => s.name);
Ty.method(streamType, "isatty", () => false);
Ty.method(streamType, "__repr__", (s: StdStream) => `<_io.TextIOWrapper name='${s.name}' mode='${s.fd === 0 ? "r" : "w"}' encoding='utf-8'>`);
Ty.method(streamType, "fileno", (s: StdStream) => s.fd);
Ty.getset(streamType, "encoding", () => "utf-8");
Ty.getset(streamType, "closed", () => false);
// stdin: read synchronously from fd 0.
let stdinBuf = "", stdinEof = false;
function stdinFill(): boolean {
  if (stdinEof) return false;
  const b = Buffer.alloc(65536);
  let n = 0;
  try {
    n = readSync(0, b, 0, b.length, null);
  } catch (e: any) {
    if (e.code === "EAGAIN") return true;
    n = 0;
  }
  if (n === 0) stdinEof = true;
  else stdinBuf += b.toString("utf8", 0, n);
  return n > 0;
}
export function stdinReadline(): string {
  let i;
  while ((i = stdinBuf.indexOf("\n")) < 0 && stdinFill());
  i = stdinBuf.indexOf("\n");
  const line = i < 0 ? stdinBuf : stdinBuf.slice(0, i + 1);
  stdinBuf = stdinBuf.slice(line.length);
  return line;
}
export const stdin = new StdStream(0, "<stdin>");
Ty.method(streamType, "readline", (s: StdStream, _n: any = -1) => (s.fd === 0 ? stdinReadline() : raise(T.OSError, "not readable")));
Ty.method(streamType, "read", (s: StdStream, n: any = -1) => {
  if (s.fd !== 0) raise(T.OSError, "not readable");
  while (stdinFill());
  const k = n === null || Number(n) < 0 ? stdinBuf.length : Number(n);
  const r = stdinBuf.slice(0, k);
  stdinBuf = stdinBuf.slice(k);
  return r;
});

// ------------------------------------------------------------------ builtin functions

function print(...args: any[]) {
  return printImpl(args, " ", "\n", null, false);
}
function printImpl(args: any[], sep: any, end: any, file: any, flush: any) {
  if (sep === null) sep = " ";
  if (end === null) end = "\n";
  if (typeof sep !== "string") raise(T.TypeError, `sep must be None or a string, not ${typeName(sep)}`);
  if (typeof end !== "string") raise(T.TypeError, `end must be None or a string, not ${typeName(end)}`);
  let s = "";
  for (let i = 0; i < args.length; i++) {
    if (i) s += sep;
    const a = args[i];
    s += typeof a === "string" ? a : str(a);
  }
  s += end;
  if (file === null || file === stdout) {
    stdout.write(s);
    if (O.truth(flush)) stdout.flush();
  } else if (file instanceof StdStream) {
    file.write(s);
  } else {
    // Other files get each piece written separately, as CPython does.
    const w = getattr(file, "write");
    for (let i = 0; i < args.length; i++) {
      if (i) callObj(w, [sep]);
      const a = args[i];
      callObj(w, [typeof a === "string" ? a : str(a)]);
    }
    callObj(w, [end]);
    if (O.truth(flush)) callObj(getattr(file, "flush"), []);
  }
  return null;
}
(print as any).$kw = (pos: any[], names: string[], values: any[]) => {
  const kw: any = { sep: " ", end: "\n", file: null, flush: false };
  names.forEach((n, i) => {
    if (!(n in kw)) raise(T.TypeError, `print() got an unexpected keyword argument '${n}'`);
    kw[n] = values[i];
  });
  return printImpl(pos, kw.sep, kw.end, kw.file, kw.flush);
};

function minmax(name: string, args: any[], key: any, dflt: any, wantMax: boolean): any {
  let items: any[];
  if (args.length === 1) items = O.toArray(args[0]);
  else if (args.length === 0) raise(T.TypeError, `${name} expected at least 1 argument, got 0`);
  else items = args;
  if (items.length === 0) {
    if (dflt !== undefined) return dflt;
    raise(T.ValueError, `${name}() iterable argument is empty`);
  }
  let best = items[0];
  let bestKey = key === null || key === undefined ? best : callObj(key, [best]);
  for (let i = 1; i < items.length; i++) {
    const v = items[i];
    const k = key === null || key === undefined ? v : callObj(key, [v]);
    if (O.truth(wantMax ? O.gt(k, bestKey) : O.lt(k, bestKey))) {
      best = v;
      bestKey = k;
    }
  }
  return best;
}
const minmaxKw = (name: string, wantMax: boolean) => (pos: any[], names: string[], values: any[]) => {
  let key: any = null, dflt: any = undefined;
  names.forEach((n, i) => {
    if (n === "key") key = values[i];
    else if (n === "default") dflt = values[i];
    else raise(T.TypeError, `${name}() got an unexpected keyword argument '${n}'`);
  });
  return minmax(name, pos, key, dflt, wantMax);
};

function sum(it: any, start: any = 0): any {
  if (typeof start === "string") raise(T.TypeError, "sum() can't sum strings [use ''.join(seq) instead]");
  let s = start;
  if (it instanceof PyBytes) {
    if (typeof s === "number" && isInt(s) && Number.isSafeInteger(Math.abs(s) + 255 * it.n)) {
      const a = it.a;
      for (let i = 0; i < it.n; i++) s += a[i];
      return s;
    }
  }
  if (Array.isArray(it)) {
    for (let i = 0; i < it.length; i++) s = O.add(s, it[i]);
    return s;
  }
  const iter = O.iter(it);
  for (let v = iter.$next(); v !== DONE; v = iter.$next()) s = O.add(s, v);
  return s;
}

function sorted(it: any, key: any = null, reverse: any = false) {
  const a = O.toArray(it);
  Ty.sortList(a, key, reverse);
  return a;
}
(sorted as any).$sig = sig(["iterable"], { posonly: 1, kwonly: ["key", "reverse"] });

function roundImpl(x: any, nd: any = null): any {
  if (O.isPyInt(x)) {
    if (nd === null) return typeof x === "boolean" ? +x : x;
    const n = Number(nd);
    if (n >= 0) return typeof x === "boolean" ? +x : x;
    const p = 10n ** BigInt(-n);
    const v = BigInt(x);
    let q = v / p, r = v % p;
    if (r < 0n) {
      r += p;
      q -= 1n;
    }
    if (2n * r > p || (2n * r === p && q % 2n !== 0n)) q += 1n;
    return O.normBig(q * p);
  }
  if (typeof x === "number" || x instanceof FloatBox) {
    const v = O.fv(x)!;
    if (nd === null) {
      if (!Number.isFinite(v)) raise(v !== v ? T.ValueError : T.OverflowError, v !== v ? "cannot convert float NaN to integer" : "cannot convert float infinity to integer");
      let r = Math.round(v);
      if (Math.abs(v - Math.trunc(v)) === 0.5) r = 2 * Math.round(v / 2);
      return Number.isSafeInteger(r) ? r + 0 : O.normBig(BigInt(r));
    }
    const n = Number(nd);
    if (!Number.isFinite(v) || v === 0) return x;
    if (n >= 0) return O.mkfloat(n > 330 ? v : parseFloat(formatFixed(v, n)));
    if (n < -330) return O.mkfloat(0 * v);
    const p = Math.pow(10, -n);
    const q = v / p;
    let r = Math.round(q);
    if (Math.abs(q - Math.trunc(q)) === 0.5) r = 2 * Math.round(q / 2);
    return O.mkfloat(r * p);
  }
  const f = lookupType(typeOf(x), "__round__");
  if (f === undefined) raise(T.TypeError, `type ${typeName(x)} doesn't define __round__ method`);
  return nd === null ? f(x) : f(x, nd);
}

// A metaclass's own __instancecheck__ / __subclasscheck__, if any.
function metaCheck(spec: any, name: string): any {
  const m = spec.$meta;
  if (m === undefined) return undefined;
  const f = lookupType(m, name);
  return f === T.type.$dict.get(name) ? undefined : f;
}
function isinstanceImpl(x: any, spec: any): boolean {
  if (Array.isArray(spec)) return spec.some((s) => isinstanceImpl(x, s));
  if (!isType(spec)) {
    const ic = lookupType(typeOf(spec), "__instancecheck__");
    if (ic !== undefined) return O.truth(ic(spec, x));
    raise(T.TypeError, "isinstance() arg 2 must be a type, a tuple of types, or a union");
  }
  const t = typeOf(x);
  if (t === spec) return true;
  const mc = metaCheck(spec, "__instancecheck__");
  if (mc !== undefined) return O.truth(mc(spec, x));
  if (t.$mro.includes(spec) || spec === T.object) return true;
  return subclassHook(spec, t);
}
// ABC-style structural checks: a class's __subclasshook__ classmethod,
// looked up once per class version.
function subclassHook(spec: any, c: PyType): boolean {
  if (spec.$hookVer !== spec.$ver) {
    spec.$hookVer = spec.$ver;
    const h = spec.$ctor === null ? undefined : lookupType(spec, "__subclasshook__");
    spec.$hook = h instanceof Ty.PyClassMethod && h.f.$default !== true ? h : null;
  }
  return spec.$hook !== null && spec.$hook.f(spec, c) === true;
}
function issubclassImpl(c: any, spec: any): boolean {
  if (Array.isArray(spec)) return spec.some((s) => issubclassImpl(c, s));
  if (!isType(c) && (isType(spec) || lookupType(typeOf(spec), "__subclasscheck__") === undefined)) raise(T.TypeError, "issubclass() arg 1 must be a class");
  if (!isType(spec)) {
    const sc = lookupType(typeOf(spec), "__subclasscheck__");
    if (sc !== undefined) return O.truth(sc(spec, c));
    raise(T.TypeError, "issubclass() arg 2 must be a class, a tuple of classes, or a union");
  }
  const mc = metaCheck(spec, "__subclasscheck__");
  if (mc !== undefined) return O.truth(mc(spec, c));
  return c.$mro.includes(spec) || subclassHook(spec, c);
}

function hasattrImpl(o: any, name: string): boolean {
  if (typeof name !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
  try {
    getattr(o, name);
    return true;
  } catch (e: any) {
    if (e?.$cls !== undefined && isinstance(e, T.AttributeError)) return false;
    throw e;
  }
}
function getattrImpl(o: any, name: any, dflt: any = undefined): any {
  if (typeof name !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(name)}'`);
  if (dflt === undefined) return getattr(o, name);
  try {
    return getattr(o, name);
  } catch (e: any) {
    if (e?.$cls !== undefined && isinstance(e, T.AttributeError)) return dflt;
    throw e;
  }
}

function iterImpl(x: any, sentinel: any = undefined): any {
  if (sentinel !== undefined) {
    return new CallableIter(x, sentinel);
  }
  if (x !== null && typeof x === "object" && x[Symbol.toStringTag] === "Generator") return x;
  return O.iter(x);
}

class CallableIter {
  done = false;
  constructor(public f: any, public sentinel: any) {}
  $next(): any {
    if (this.done) return DONE;
    const v = callObj(this.f, []);
    if (O.eqBool(v, this.sentinel)) {
      this.done = true;
      return DONE;
    }
    return v;
  }
}
Ty.bindClass(CallableIter, builtinType("callable_iterator", [T.object], () => raise(T.TypeError, "cannot create 'callable_iterator' instances")));
Ty.method(T.callable_iterator, "__next__", (it: CallableIter) => {
  const v = it.$next();
  if (v === DONE) raise(T.StopIteration);
  return v;
});
Ty.method(T.callable_iterator, "__iter__", (it: CallableIter) => it);

const chr = (i: any) => {
  const n = Number(O.index(i));
  if (n < 0 || n > 0x10ffff) raise(T.ValueError, "chr() arg not in range(0x110000)");
  return String.fromCodePoint(n);
};
const ord = (c: any) => {
  if (typeof c === "string") {
    const cs = [...c];
    if (cs.length !== 1) raise(T.TypeError, `ord() expected a character, but string of length ${cs.length} found`);
    return cs[0].codePointAt(0);
  }
  if (c instanceof PyBytes && c.n === 1) return c.a[0];
  raise(T.TypeError, `ord() expected string of length 1, but ${typeName(c)} found`);
};
const radix = (prefix: string, base: number) => (x: any) => {
  const v = BigInt(O.index(x));
  return (v < 0n ? "-" : "") + prefix + (v < 0n ? -v : v).toString(base);
};

function anyImpl(x: any): boolean {
  const it = O.iter(x);
  for (let v = it.$next(); v !== DONE; v = it.$next()) if (O.truth(v)) return true;
  return false;
}
function allImpl(x: any): boolean {
  const it = O.iter(x);
  for (let v = it.$next(); v !== DONE; v = it.$next()) if (!O.truth(v)) return false;
  return true;
}
function varsImpl(o: any = undefined): PyDict {
  if (o === undefined) raise(T.NotImplementedError, "vars() without an argument is not supported");
  if (isType(o)) return getattr(o, "__dict__");
  if (!hasInstanceDict(o)) raise(T.TypeError, "vars() argument must have __dict__ attribute");
  return getattr(o, "__dict__");
}
function hashImpl(x: any): any {
  return O.hashAny(x);
}
function absImpl(x: any): any {
  return O.abs(x);
}
function callable(x: any): boolean {
  return typeof x === "function" || lookupType(typeOf(x), "__call__") !== undefined;
}
function nextImpl(it: any, dflt: any = undefined): any {
  return O.next(it, dflt);
}
function powImpl(a: any, b: any, m: any = null): any {
  return O.pow(a, b, m);
}
function formatImpl(v: any, spec: any = ""): string {
  return format(v, spec);
}
function asciiImpl(x: any): string {
  return repr(x).replace(/[^\x00-\x7f]/gu, (c) => {
    const n = c.codePointAt(0)!;
    return n <= 0xff ? "\\x" + n.toString(16).padStart(2, "0") : n <= 0xffff ? "\\u" + n.toString(16).padStart(4, "0") : "\\U" + n.toString(16).padStart(8, "0");
  });
}

// ------------------------------------------------------------------ the builtins module

export const builtins: any = Ty.newModule("builtins");
const define = (name: string, v: any, range?: [number, number]) => {
  if (typeof v === "function" && !isType(v)) {
    const kw = v.$kw, sg = v.$sig;
    v = checkArity(v, name, false, range);
    builtin(v, name);
    if (kw !== undefined) v.$kw = kw;
    if (sg !== undefined) v.$sig = sg;
  }
  builtins[name] = v;
};
for (const name of ["object", "type", "int", "float", "bool", "str", "list", "tuple", "dict", "set", "frozenset", "range", "slice", "bytes", "bytearray", "property", "staticmethod", "classmethod", "super", "enumerate", "zip", "map", "filter", "reversed"]) define(name, T[name]);
for (const name of Object.keys(T)) if (T[name].$mro.includes(T.BaseException)) define(name, T[name]);
define("None", null);
define("True", true);
define("False", false);
define("NotImplemented", NotImplemented);
define("Ellipsis", Ellipsis);
define("__debug__", true);
define("print", print);
define("len", O.len, [1, 1]);
define("repr", repr, [1, 1]);
define("ascii", asciiImpl);
define("abs", absImpl);
define("sum", sum, [1, 2]);
define("min", (...a: any[]) => minmax("min", a, null, undefined, false));
builtins.min.$kw = minmaxKw("min", false);
define("max", (...a: any[]) => minmax("max", a, null, undefined, true));
builtins.max.$kw = minmaxKw("max", true);
define("sorted", sorted, [1, 1]);
define("round", roundImpl, [1, 2]);
define("divmod", O.divmod, [2, 2]);
define("pow", powImpl, [2, 3]);
define("hash", hashImpl);
define("id", O.id, [1, 1]);
define("isinstance", isinstanceImpl);
define("issubclass", issubclassImpl);
define("hasattr", hasattrImpl);
define("getattr", getattrImpl, [2, 3]);
const attrName = (n: any) => {
  if (typeof n !== "string") raise(T.TypeError, `attribute name must be string, not '${typeName(n)}'`);
  return n;
};
define("setattr", (o: any, n: string, v: any) => (setattr(o, attrName(n), v), null));
define("delattr", (o: any, n: string) => (delattr(o, attrName(n)), null));
define("iter", iterImpl, [1, 2]);
// async for / async with (see frontend.ts), and the aiter/anext builtins.
const aiterImpl = (x: any) => {
  const f = Ty.lookupDunder(x, "__aiter__");
  if (f === undefined) raise(T.TypeError, `'async for' requires an object with __aiter__ method, got ${typeName(x)}`);
  return f(x);
};
const anextImpl = (x: any) => {
  const f = Ty.lookupDunder(x, "__anext__");
  if (f === undefined) raise(T.TypeError, `'async for' received an object from __aiter__ that does not implement __anext__: ${typeName(x)}`);
  return f(x);
};
define("aiter", aiterImpl, [1, 1]);
define("anext", anextImpl, [1, 2]);
define("__pyjs_aiter__", aiterImpl, [1, 1]);
define("__pyjs_anext__", anextImpl, [1, 1]);
define("__pyjs_aenter__", (m: any) => {
  const f = Ty.lookupDunder(m, "__aenter__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the asynchronous context manager protocol`);
  return f(m);
}, [1, 1]);
define("__pyjs_aexit__", (m: any) => {
  const f = Ty.lookupDunder(m, "__aexit__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the asynchronous context manager protocol (missed __aexit__ method)`);
  return builtin((t: any, v: any, tb: any) => f(m, t, v, tb), "__aexit__");
}, [1, 1]);
define("next", nextImpl, [1, 2]);
define("any", anyImpl);
define("all", allImpl);
define("callable", callable);
define("chr", chr);
define("ord", ord);
define("hex", radix("0x", 16));
define("oct", radix("0o", 8));
define("bin", radix("0b", 2));
define("format", formatImpl, [1, 2]);
define("vars", varsImpl, [0, 1]);
define("dir", Ty.dir, [0, 1]);
define("input", () => raise(T.EOFError, "EOF when reading a line"));

// Global-name lookup miss: builtins, else NameError.
export function gname(name: string): any {
  const v = builtins[name];
  if (v !== undefined && Object.prototype.hasOwnProperty.call(builtins, name)) return v;
  raise(T.NameError, `name '${name}' is not defined`);
}
export function unboundLocal(name: string): never {
  raise(T.UnboundLocalError, `cannot access local variable '${name}' where it is not associated with a value`);
}
export function unboundFree(name: string): never {
  raise(T.NameError, `cannot access free variable '${name}' where it is not associated with a value in enclosing scope`);
}
