import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// lib/ctypes.py: the simple number types as CPython's ctypes has them on
// 64-bit Linux (sizes, wraparound, float32 rounding, reprs, errors), and an
// error for everything that would reach C memory or libraries.
const PROGRAM = String.raw`
import ctypes
from ctypes import *
names = ["c_bool", "c_char", "c_wchar", "c_byte", "c_ubyte", "c_short", "c_ushort", "c_int", "c_uint", "c_long", "c_ulong",
         "c_longlong", "c_ulonglong", "c_int8", "c_uint8", "c_int16", "c_uint16", "c_int32", "c_uint32", "c_int64", "c_uint64",
         "c_size_t", "c_ssize_t", "c_float", "c_double", "c_time_t"]
for n in names:
    t = getattr(ctypes, n)
    print(n, t.__name__, t._type_, sizeof(t))
for t, vals in [(c_int32, [5, 2**31, -2**31 - 1, 2**40 + 7, True]), (c_uint8, [-1, 256, 300]), (c_int64, [2**63, -1]),
                (c_uint64, [-1, 2**64 + 5]), (c_short, [40000]), (c_float, [0.1, 1e300, -1e300, 3, 1e-50]),
                (c_double, [1, 0.1, 2**1023 * 1.5]), (c_bool, [5, 0, "a", "", None]), (c_char, [b"a", 97, b"\x00"])]:
    for v in vals:
        x = t(v)
        print(repr(x), x.value, bool(x))
for t, v in [(c_int, 1.5), (c_int, "3"), (c_double, "1"), (c_char, b"ab"), (c_char, 300), (c_char, "a"), (c_int, None),
             (c_double, None), (c_wchar, "ab"), (c_wchar, 65), (c_wchar, b"a")]:
    try:
        print(repr(t(v)))
    except TypeError as e:
        print("TypeError", e)
x = c_int32()
print(repr(x), x.value)
x.value = 2**32 + 3
print(x.value, repr(x))
print(c_int(1) == c_int(1), sizeof(c_int(3)), c_int32 is c_int, c_int64 is c_long, c_size_t is c_ulong)
print(str(c_int(4)), c_double(2.5).value, repr(c_wchar("é")))
for x in [c_int(0), c_double(0.0), c_bool(), c_char(), c_wchar(), c_uint8()]:
    print(repr(x), bool(x))
print(sizeof(c_double), alignment(c_int16), sizeof(c_bool(True)))
class Sub(c_int):
    pass
print(repr(Sub(3))[:12], Sub(3).value)
for bad in [lambda: c_int(1) + 1, lambda: c_int(1, 2), lambda: sizeof(3)]:
    try:
        bad()
    except TypeError as e:
        print("TypeError", e)
`;
const cli = (code: string) => execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", code], { encoding: "utf8" });

test("ctypes' simple types print what CPython's print", () => {
  const want = execFileSync("python3", ["-c", PROGRAM], { encoding: "utf8" });
  assert.equal(cli(PROGRAM), want);
});

test("ctypes: libraries, pointers, arrays and structures raise NotImplementedError", () => {
  const names = ["CDLL", "cdll", "POINTER", "pointer", "byref", "Structure", "c_char_p", "c_void_p", "create_string_buffer", "cast"];
  const out = cli(`
import ctypes
for name in ${JSON.stringify(names)}:
    try:
        getattr(ctypes, name)
        print(name, "no error")
    except NotImplementedError as e:
        print(name, str(e).startswith("ctypes.%s is not available in Sagebrush" % name))
try:
    ctypes.c_int * 3
except NotImplementedError as e:
    print(str(e)[:36])
try:
    from ctypes import CDLL
except NotImplementedError:
    print("from ctypes import CDLL: NotImplementedError")
try:
    ctypes.nothing
except AttributeError as e:
    print(e)
`);
  assert.equal(out, names.map((n) => n + " True\n").join("") +
    "ctypes arrays (c_int * 3) is not ava\nfrom ctypes import CDLL: NotImplementedError\nmodule 'ctypes' has no attribute 'nothing'\n");
});
