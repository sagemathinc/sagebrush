import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sys.flags (src/runtime/modules.ts): CPython 3.14's struct sequence (the reference: the newest 3.14 patch release,
// 3.14.8 when this was written, @sagebrush's ruling on #827; CI's unpinned "3.14"), not a module of two attributes. Its 18 fields
// and the three beyond them (gil, thread_inherit_context, context_aware_warnings) have the values of a script run
// with no options; locale.getpreferredencoding read sys.flags.warn_default_encoding and raised AttributeError
// (grader's aside on #820). int_max_str_digits is Sagebrush's default, 0 (William, Oct 24: format.ts's intDigits),
// so the oracle is CPython 3.14 run with -X int_max_str_digits=0, in a UTF-8 locale (Sagebrush's), with no PYTHON*
// variables that would set a flag.
const PROG = `
import sys, locale, io
f = sys.flags
print(f)
print(type(f), type(f).__name__, type(f).__module__, len(f), f.n_fields, f.n_sequence_fields, isinstance(f, tuple))
print(f.gil, f.thread_inherit_context, f.context_aware_warnings, [type(x).__name__ for x in f])
print(f[0], f[-1], f[2:4], f == tuple(f), f.utf8_mode, f.warn_default_encoding, f.int_max_str_digits)
try: type(f)()
except TypeError as e: print("TypeError", e)
try: f.debug = 1
except AttributeError as e: print("AttributeError", e)
try: del f.gil
except AttributeError as e: print("AttributeError", e)
try: type(sys.version_info)()
except TypeError as e: print("TypeError", e)
try: sys.float_info.max = 1.0
except AttributeError as e: print("AttributeError", e)
f0 = sys.flags
sys.set_int_max_str_digits(5000)
print(sys.flags.int_max_str_digits, f0 is sys.flags, f0[17], sys.get_int_max_str_digits())
sys.set_int_max_str_digits(0)
print(sys.flags.int_max_str_digits, f0 is sys.flags, f0 == sys.flags)
print(locale.getpreferredencoding(), locale.getpreferredencoding(False), locale.getencoding(), io.text_encoding(None))
`;

// (set_int_max_str_digits installs a new sys.flags, as CPython 3.14.8's does, the old object unchanged: its
// slot and its hash stay, a dict or set holding it still finds it, and the new one is a different key; with the
// limit back, an equal flags object is the old one's key again; daybreak3's SYS-FLAGS-HASH-1 on #827, re-ruled)
const REPLACED = `
import sys
f = sys.flags
h = hash(f)
d = {f: 1}
s = {f}
sys.set_int_max_str_digits(5000)
g = sys.flags
print(f is g, f[17], g[17], g.int_max_str_digits, hash(f) == h, hash(g) == hash(tuple(g)), hash(g) == h)
print(d.get(f), d.get(g), f in s, g in s, f == g)
sys.set_int_max_str_digits(0)
k = sys.flags
print(k is f, k is g, k == f, hash(k) == h, d.get(k), k in s)
`;

test("sys.flags: CPython 3.14's struct sequence and values; locale.getpreferredencoding works", () => {
  const env: Record<string, string> = { LC_ALL: "C.UTF-8", PATH: process.env.PATH ?? "" };
  const want = execFileSync("python3", ["-X", "int_max_str_digits=0", "-c", PROG], { encoding: "utf8", env });
  assert.equal(want.split("\n").length, 13, `CPython ran every line:\n${want}`);
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", PROG], { encoding: "utf8" });
  assert.equal(got, want);
});

test("set_int_max_str_digits installs a new sys.flags, the old one unchanged, as CPython 3.14.8's", () => {
  const env: Record<string, string> = { LC_ALL: "C.UTF-8", PATH: process.env.PATH ?? "" };
  const want = execFileSync("python3", ["-X", "int_max_str_digits=0", "-c", REPLACED], { encoding: "utf8", env });
  assert.equal(want.split("\n").length, 4, `CPython ran every line:\n${want}`);
  assert.equal(execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", REPLACED], { encoding: "utf8" }), want);
});
