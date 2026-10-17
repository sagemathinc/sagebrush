// Builtins' argument conversions, as CPython's Argument Clinic converters
// (Python/getargs.c and the clinic-generated parsers): one place for each
// check and its message, so a builtin cannot take an argument CPython
// refuses and give a plausible answer (@sagebrush-astra3's sweep, A08-A12).

import { T, raise, typeName, unbox, PyBytes } from "./object";
import * as O from "./ops";

// (the type an argument error names: None by name, as _PyArg_BadArgument)
const argType = (x: any): string => (x === null ? "None" : typeName(x));

// "f() argument 2 must be T, not U", CPython's _PyArg_BadArgument; `arg` is
// "argument 2", "argument 'name'" or, for a sole argument, "argument"
export function badArgument(fname: string, arg: string, expected: string, x: any): never {
  return raise(T.TypeError, `${fname}() ${arg} must be ${expected}, not ${argType(x)}`);
}

// A str argument (a str subclass's value)
export function strArg(fname: string, arg: string, x: any): string {
  const v = unbox(x);
  return typeof v === "string" ? v : badArgument(fname, arg, "str", x);
}

// An integer argument through __index__ (PyNumber_Index), unbounded (a
// start, as enumerate's): a float is "'float' object cannot be interpreted
// as an integer"
export const indexArg = (x: any): number | bigint => O.index(x);

// A Py_ssize_t argument (clinic's 'n': a width, a count, maxsplit): through
// __index__, then within a signed 64-bit integer, else CPython's
// OverflowError; exact (a bigint near the bounds)
const SSIZE_MAX = 2n ** 63n - 1n;
export function ssizeArg(x: any): number | bigint {
  const v = O.index(x);
  if (typeof v === "bigint" && (v > SSIZE_MAX || v < -SSIZE_MAX - 1n)) raise(T.OverflowError, "Python int too large to convert to C ssize_t");
  return v;
}

// A C int argument (clinic's 'i': expandtabs' tabsize): within 32 bits
export function cIntArg(x: any): number {
  const v = O.index(x);
  if (v > 2147483647 || v < -2147483648) raise(T.OverflowError, "Python int too large to convert to C int");
  return Number(v);
}

// The longest string a result can be (V8's limit, in UTF-16 units): a
// longer one CPython could try to allocate is a MemoryError here, never a
// host RangeError or a hang
export const MAX_STR = 2 ** 29 - 24;
export function allocStr(n: number | bigint): void {
  if (n > MAX_STR) raise(T.MemoryError);
}

// A bytes-like argument's bytes (the Py_buffer converter): a str or any
// other non-buffer is "a bytes-like object is required, not 'int'"
export function bufferArg(x: any): Uint8Array {
  const b = typeof x === "string" ? undefined : O.bufferOf(x);
  return b ?? raise(T.TypeError, `a bytes-like object is required, not '${typeName(x)}'`);
}

// A fill byte (the `char` converter): a bytes or bytearray of length 1
export function byteCharArg(fname: string, arg: string, x: any): number {
  if (x instanceof PyBytes && x.n === 1) return x.a[0];
  return badArgument(fname, arg, "a byte string of length 1", x);
}

// str's fill character (str.center, ljust and rjust's convert_uc)
// (exactly one code point: the first two looked at, not the whole string)
export function fillCharArg(x: any): string {
  const v = unbox(x);
  if (typeof v !== "string") raise(T.TypeError, `The fill character must be a unicode character, not ${typeName(x)}`);
  const it = v[Symbol.iterator]();
  if (it.next().done || !it.next().done) raise(T.TypeError, "The fill character must be exactly one character long");
  return v;
}
