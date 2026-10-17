// Builtin functions, the builtins module, stdout, and builtin modules.

import { writeSync, readSync } from "fs";
import {
  T, PyType, FloatBox, PyDict, DONE, NotImplemented, Ellipsis, typeOf, typeName, lookupType, isType, raise, builtin, sig, tuple, hooks,
  isinstance, getattr, setattr, delattr, callObj, callKw, bindArgs, dictSet, dictGet, hasInstanceDict, PyBytes, builtinType, checkArity, unbox,
} from "./object";
import * as O from "./ops";
import { INTR } from "./interrupt";
import { repr, str, format, formatFixed } from "./format";
import * as Ty from "./types";
import { glibcPow } from "./libm";

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
// the sys module (modules.ts), whose stdout print() writes to: Python code
// may replace sys.stdout (with an io.StringIO, say), as in CPython
export const sysRef: { m: any } = { m: null };
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
  if (file === null) {
    // (sys.stdout as it is now; None: print writes nothing, as in CPython)
    const cur = sysRef.m === null ? stdout : sysRef.m.stdout;
    if (cur === null) return null;
    file = cur === undefined ? stdout : cur;
  }
  if (file === stdout) {
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
    if (!Object.hasOwn(kw, n)) raise(T.TypeError, `print() got an unexpected keyword argument '${n}'`);
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
  if (it instanceof Ty.PyRange && typeof s === "number" && isInt(s) && Math.abs(s) <= HALF_SAFE) {
    // A range of doubles, summed in chunks: chunk length times the largest
    // |term| stays below 2^52, so each chunk is an exact double sum (a tight
    // loop, ~2 ns a term), added to a BigInt once per chunk; Ctrl-C between
    // chunks.
    const { start, step } = it;
    let k = it.length;
    const last = start + (k - 1) * step;
    const m = Math.max(Math.abs(start), Math.abs(last), 1);
    const chunk = Math.max(1, Math.min(1 << 20, Math.floor(HALF_SAFE / m)));
    let acc = BigInt(s), x = start;
    while (k > 0) {
      const c = Math.min(k, chunk);
      let small = 0;
      if (m < HALF_SAFE) for (let j = 0; j < c; j++, x += step) small += x;
      else for (let j = 0; j < c; j++, x += step) acc += BigInt(x);
      acc += BigInt(small);
      k -= c;
      if (INTR[0]) {
        INTR[0] = 0;
        raise(T.KeyboardInterrupt);
      }
    }
    return O.normBig(acc);
  }
  const acc = new SumAcc(s);
  if (Array.isArray(it)) for (let i = 0; i < it.length; i++) acc.push(it[i]);
  else {
    const iter = O.iter(it);
    for (let v = iter.$next(); v !== DONE; v = iter.$next()) acc.push(v);
  }
  return acc.total();
}
// sum()'s total, item by item, as CPython's builtin_sum_impl keeps it: Python
// ints first, then while the total is an exact float (or complex) and the
// items are exact floats (or complex), or ints a C long holds, Neumaier's
// compensated sum (3.12, 3.14), so sum([0.1] * 10) is 1.0; anything else is
// added as it is.  An item is added when it comes, so a generator's items and
// their __add__/__radd__ calls interleave as in CPython.  (The compiler's
// sum(genexpr) uses it too: R.sumAcc.)
export class SumAcc {
  // 0: ints (a double kept below 2^52 in absolute value and flushed into a
  // BigInt when it passes that: sum(range(10**9)) takes 1.4 s, not 35 s with
  // BigInt additions; exact, as each step stays below 2^53), 1: float, 2:
  // complex, 3: anything
  mode = 3;
  s: any;
  small = 0;
  big = 0n;
  f: CompSum | null = null;
  im: CompSum | null = null;
  constructor(start: any) {
    if (typeof start === "number" && isInt(start) && Math.abs(start) <= HALF_SAFE) {
      this.mode = 0;
      this.small = start;
    } else this.enter(start, 1);
  }
  // the total is now s: the float, complex or general path, whichever is
  // the first of them from `from` on that applies
  enter(s: any, from: number) {
    if (from <= 1 && exactFloat(s)) {
      this.mode = 1;
      this.f = new CompSum(O.fv(s)!);
    } else if (from <= 2 && typeOf(s) === T.complex) {
      this.mode = 2;
      this.f = new CompSum(s.re);
      this.im = new CompSum(s.im);
    } else {
      this.mode = 3;
      this.s = s;
    }
  }
  push(v: any) {
    switch (this.mode) {
      case 0:
        if (typeof v === "number" && isInt(v)) {
          if (v > HALF_SAFE || v < -HALF_SAFE) this.big += BigInt(v);
          else {
            this.small += v;
            if (this.small > HALF_SAFE || this.small < -HALF_SAFE) {
              this.big += BigInt(this.small);
              this.small = 0;
            }
          }
        } else if (typeof v === "bigint") this.big += v;
        else this.enter(O.add(this.total(), v), 1);
        return;
      case 1: {
        const x = exactFloat(v) ? O.fv(v)! : longValue(v);
        if (x !== undefined) this.f!.add(x);
        else this.enter(O.add(this.total(), v), 2);
        return;
      }
      case 2: {
        if (typeOf(v) === T.complex) {
          this.f!.add(v.re);
          this.im!.add(v.im);
          return;
        }
        const x = exactFloat(v) ? O.fv(v)! : longValue(v);
        if (x !== undefined) this.f!.add(x);
        else this.enter(O.add(this.total(), v), 3);
        return;
      }
      default:
        this.s = O.add(this.s, v);
    }
  }
  total(): any {
    switch (this.mode) {
      case 0:
        return this.big === 0n ? this.small : O.normBig(this.big + BigInt(this.small));
      case 1:
        return O.mkfloat(this.f!.total());
      case 2:
        return T.complex(O.mkfloat(this.f!.total()), O.mkfloat(this.im!.total()));
      default:
        return this.s;
    }
  }
}
// an exact float (a JS number that is not an integer, or a boxed integral one)
const exactFloat = (x: any) => (typeof x === "number" && !isInt(x)) || x instanceof FloatBox;
// an int (or bool, or int subclass) as a double, if a C long holds it
function longValue(x: any): number | undefined {
  if (typeof x === "boolean") return +x;
  if (typeof x === "number") return isInt(x) ? x : undefined;
  const u = unbox(x);
  if (typeof u === "number" && isInt(u) && u !== x) return u;
  if (typeof u === "bigint" && u >= -(2n ** 63n) && u < 2n ** 63n) return Number(u);
  return undefined;
}
// Neumaier's compensated sum, as CPython's sum keeps it
class CompSum {
  c = 0;
  constructor(public f: number) {}
  add(x: number) {
    const t = this.f + x;
    if (Math.abs(this.f) >= Math.abs(x)) this.c += this.f - t + x;
    else this.c += x - t + this.f;
    this.f = t;
  }
  // (the compensation only if finite: an infinite or overflowed sum stays one)
  total() {
    return this.c && Number.isFinite(this.c) ? this.f + this.c : this.f;
  }
}
const HALF_SAFE = 2 ** 52;

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
    const p = glibcPow(10, -n);
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
  // (as CPython's: o.__dict__, whatever defines it, a function's too; an
  // AttributeError is the TypeError, so a dict's, object's generic
  // __dict__ that it lacks, is not an AttributeError)
  try {
    return getattr(o, "__dict__");
  } catch (e) {
    if (isinstance(e, T.AttributeError)) raise(T.TypeError, "vars() argument must have __dict__ attribute");
    throw e;
  }
}
function hashImpl(x: any): any {
  return O.hashExact(x);
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
    v.__module__ = "builtins";
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
// int.__round__ and float.__round__: how a subclass of int or float (numpy's
// float64, say) rounds, to an exact int or float, as in CPython
for (const t of [T.int, T.float]) Ty.method(t, "__round__", (x: any, nd: any = null) => roundImpl(unbox(x), nd));
define("divmod", O.divmod, [2, 2]);
define("pow", powImpl, [2, 3]);
// (pow(2, 3, mod=5), as CPython's; a missing base or exp is its TypeError, CORR-71C-1)
builtins.pow.$kw = (pos: any[], names: string[], values: any[]) => {
  const [b, e, m] = bindArgs("pow", sig(["base", "exp", "mod"]), pos, names, values);
  if (b === undefined) raise(T.TypeError, "pow() missing required argument 'base' (pos 1)");
  if (e === undefined) raise(T.TypeError, "pow() missing required argument 'exp' (pos 2)");
  return powImpl(b, e, m === undefined ? null : m);
};
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

// match statements (frontend.ts lowers them): CPython's MATCH_SEQUENCE,
// MATCH_MAPPING, MATCH_KEYS and MATCH_CLASS, each checking a subject, then
// extracting what a pattern's subpatterns need, as CPython's compiler
// stages them. Intrinsics (R.$i): no Python name reaches them.
// A subject is a sequence or a mapping by its real type (not __class__),
// as CPython's Py_TPFLAGS_SEQUENCE/MAPPING: the builtins that have the flag
// and their subclasses, and what collections.abc's Sequence and Mapping
// count by inheritance or register(); str, bytes and bytearray never.
let abcs: { Sequence: any; Mapping: any } | null = null;
const abcOf = () => {
  if (abcs === null) {
    const m = hooks.importModule("collections.abc");
    abcs = { Sequence: getattr(m, "Sequence"), Mapping: getattr(m, "Mapping") };
  }
  return abcs;
};
// (the runtime's own isinstance and issubclass, which no rebinding of the
// builtins reaches; the types by identity, which no class's name or module
// imitates)
let seqTypes: Set<any> | null = null, notSeqTypes: Set<any> | null = null, mapTypes: Set<any> | null = null;
const isSequence = (s: any): boolean => {
  seqTypes ??= new Set([T.list, T.tuple, T.range, T.memoryview]);
  // (array.array, once its module has made it: array.ts)
  if ((T as any).$arrayType !== undefined) seqTypes.add((T as any).$arrayType);
  notSeqTypes ??= new Set([T.str, T.bytes, T.bytearray]);
  const t = typeOf(s);
  for (const c of t.$mro) {
    if (seqTypes.has(c)) return true;
    if (notSeqTypes.has(c)) return false;
  }
  return issubclassImpl(t, abcOf().Sequence);
};
const isMapping = (s: any): boolean => {
  mapTypes ??= new Set([T.dict, Ty.mappingproxy]);
  const t = typeOf(s);
  for (const c of t.$mro) if (mapTypes.has(c)) return true;
  return issubclassImpl(t, abcOf().Mapping);
};
// the values a fixed-length or starred sequence pattern takes, by iterating
// the subject (CPython's UNPACK_SEQUENCE and UNPACK_EX; an exact list or
// tuple by its items, copied): at most `limit` items, one more than a fixed
// pattern's, so that a longer subject stops there
const unpack = (s: any, limit: number): any[] => {
  const t = typeOf(s);
  if (t === T.list || t === T.tuple) return s.slice(0, limit);
  const out: any[] = [];
  const it = O.iter(s);
  while (out.length < limit) {
    const v = it.$next();
    if (v === DONE) break;
    out.push(v);
  }
  return out;
};
// (the types whose one positional subpattern is the subject itself,
// CPython's Py_TPFLAGS_MATCH_SELF, which their subclasses inherit)
const MATCH_SELF = ["bool", "bytearray", "bytes", "dict", "float", "frozenset", "int", "list", "set", "str", "tuple"];
const ONLY_WILDCARDS: any[] = Object.freeze([]) as any;
export const intrinsics: any = {
  // size: the sequence pattern's subpatterns, its star among them (or -1);
  // mode 0: the values unpacked; 1 (a wildcard star) and 2 (only
  // wildcards): nothing taken here (match_item takes mode 1's, each as its
  // subpattern is reached)
  match_seq(s: any, size: number, star: number, mode: number): any {
    if (!isSequence(s)) return null;
    if (star < 0) {
      if (O.len(s) !== size) return null;
    } else if (size - 1 > 0 && O.len(s) < size - 1) return null;
    if (mode !== 0) return ONLY_WILDCARDS;
    if (star < 0) {
      const items = unpack(s, size + 1);
      if (items.length !== size) raise(T.ValueError, items.length > size ? `too many values to unpack (expected ${size})` : `not enough values to unpack (expected ${size}, got ${items.length})`);
      return items;
    }
    const items = unpack(s, Infinity);
    const fixed = size - 1, after = size - 1 - star;
    if (items.length < fixed) raise(T.ValueError, `not enough values to unpack (expected at least ${fixed}, got ${items.length})`);
    return [...items.slice(0, star), items.slice(star, items.length - after), ...items.slice(items.length - after)];
  },
  // item i of a sequence matched by a pattern with a wildcard star: by its
  // nonnegative index, from the subject's length after the star (CPython's:
  // a subject needn't take negative indexes)
  match_item(s: any, i: number, size: number, star: number): any {
    return O.getitem(s, i < star ? i : O.sub(O.len(s), size - i));
  },
  // a mapping, with at least n items (none asked when n is 0)
  match_map(s: any, n: number): boolean {
    return isMapping(s) && (n === 0 || O.len(s) >= n);
  },
  // the keys' values, by the mapping's get() looked up once, or None
  match_keys(s: any, keys: any[]): any {
    const seen = new PyDict();
    const dummy = {};
    const get = getattr(s, "get");
    const out: any[] = [];
    for (const k of keys) {
      if (dictGet(seen, k) !== undefined) raise(T.ValueError, `mapping pattern checks duplicate key (${repr(k)})`);
      dictSet(seen, k, true);
      const v = callObj(get, [k, dummy]);
      if (v === dummy) return null;
      out.push(v);
    }
    return out;
  },
  // **rest: a new dict of the subject's items but the keys, made only once
  // the other subpatterns have matched
  match_rest(s: any, keys: any[]): any {
    const d = new PyDict();
    callObj(getattr(d, "update"), [s]);
    for (const k of keys) callObj(getattr(d, "__delitem__"), [k]);
    return d;
  },
  match_class(s: any, cls: any, npos: number, kw: string[]): any {
    if (!isType(cls)) raise(T.TypeError, "called match pattern must be a class");
    if (!isinstanceImpl(s, cls)) return null;
    const name = (cls as any).$name;
    const seen = new Set<string>();
    const out: any[] = [];
    let missing = false;
    // (each attribute in order: its name checked, then looked up; a missing
    // one fails the match at once, as CPython's match_class_attr)
    const attr = (a: string): void => {
      if (seen.has(a)) raise(T.TypeError, `${name}() got multiple sub-patterns for attribute ${repr(a)}`);
      seen.add(a);
      try {
        out.push(getattr(s, a));
      } catch (e: any) {
        if (!isinstance(e, T.AttributeError)) throw e;
        missing = true;
      }
    };
    if (npos > 0) {
      let ma: any = undefined;
      try {
        ma = getattr(cls, "__match_args__");
      } catch (e: any) {
        if (!isinstance(e, T.AttributeError)) throw e;
      }
      if (ma === undefined) {
        const self = (cls as any).$mro.some((c: any) => MATCH_SELF.includes(c.$name) && c === (T as any)[c.$name]);
        const allowed = self ? 1 : 0;
        if (npos > allowed) raise(T.TypeError, `${name}() accepts ${allowed} positional sub-pattern${allowed === 1 ? "" : "s"} (${npos} given)`);
        out.push(s);
      } else {
        if (typeOf(ma) !== T.tuple) raise(T.TypeError, `${name}.__match_args__ must be a tuple (got ${typeName(ma)})`);
        if (npos > ma.length) raise(T.TypeError, `${name}() accepts ${ma.length} positional sub-pattern${ma.length === 1 ? "" : "s"} (${npos} given)`);
        for (let i = 0; i < npos && !missing; i++) {
          const a = ma[i];
          // (exact strs, as CPython's PyUnicode_CheckExact)
          if (typeof a !== "string") raise(T.TypeError, `__match_args__ elements must be strings (got ${typeName(a)})`);
          attr(a);
        }
      }
    }
    for (const a of kw) {
      if (missing) break;
      attr(a);
    }
    return missing ? null : out;
  },
  match_true: (..._a: any[]) => true,
  // async for / async with (frontend.ts)
  aiter: (x: any) => aiterImpl(x),
  anext: (x: any) => anextImpl(x),
  aenter: (m: any) => aenterImpl(m),
  aexit: (m: any) => aexitImpl(m),
  type: (x: any) => typeOf(x),
  get BaseException() {
    return T.BaseException;
  },
  get StopAsyncIteration() {
    return T.StopAsyncIteration;
  },
};
const aenterImpl = (m: any) => {
  const f = Ty.lookupDunder(m, "__aenter__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the asynchronous context manager protocol`);
  return f(m);
};
const aexitImpl = (m: any) => {
  const f = Ty.lookupDunder(m, "__aexit__");
  if (f === undefined) raise(T.TypeError, `'${typeName(m)}' object does not support the asynchronous context manager protocol (missed __aexit__ method)`);
  return builtin((t: any, v: any, tb: any) => f(m, t, v, tb), "__aexit__");
};
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
