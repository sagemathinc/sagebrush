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

// An integer argument through __index__ (PyNumber_Index): a float is
// "'float' object cannot be interpreted as an integer"
export const indexArg = (x: any): number | bigint => O.index(x);

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
export function fillCharArg(x: any): string {
  const v = unbox(x);
  if (typeof v !== "string") raise(T.TypeError, `The fill character must be a unicode character, not ${typeName(x)}`);
  if ([...v].length !== 1) raise(T.TypeError, "The fill character must be exactly one character long");
  return v;
}
