import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// sys.flags (src/runtime/modules.ts): CPython 3.14's struct sequence, not a module of two attributes. Its 18 fields
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
print(sys.flags.int_max_str_digits)
print(locale.getpreferredencoding(), locale.getpreferredencoding(False), locale.getencoding(), io.text_encoding(None))
`;

// (its hash: the first one computed is kept through set_int_max_str_digits' in-place change, so a dict keyed by
// sys.flags still finds it, as CPython 3.14's; and one first computed after the change is the changed tuple's;
// daybreak3's SYS-FLAGS-HASH-1 on #827; each in its own process, the first hash being the one that's kept)
const HASH_BEFORE = `
import sys
f = sys.flags
h = hash(f)
d = {f: 1}
sys.set_int_max_str_digits(5000)
print(hash(f) == h, d.get(f), f in d, {sys.flags: 2}[f], tuple(f)[17], hash(tuple(f)) == h)
sys.set_int_max_str_digits(0)
print(hash(sys.flags) == h, d[sys.flags])
`;
const HASH_AFTER = `
import sys
sys.set_int_max_str_digits(5000)
f = sys.flags
print(hash(f) == hash(tuple(f)), f.int_max_str_digits)
sys.set_int_max_str_digits(0)
print(hash(f) == hash(tuple(f)), {f: 3}[sys.flags])
`;

test("sys.flags: CPython 3.14's struct sequence and values; locale.getpreferredencoding works", () => {
  const env: Record<string, string> = { LC_ALL: "C.UTF-8", PATH: process.env.PATH ?? "" };
  const want = execFileSync("python3", ["-X", "int_max_str_digits=0", "-c", PROG], { encoding: "utf8", env });
  assert.equal(want.split("\n").length, 13, `CPython ran every line:\n${want}`);
  const got = execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", PROG], { encoding: "utf8" });
  assert.equal(got, want);
});

test("sys.flags' hash: the first one kept through set_int_max_str_digits, as CPython 3.14's", () => {
  const env: Record<string, string> = { LC_ALL: "C.UTF-8", PATH: process.env.PATH ?? "" };
  for (const prog of [HASH_BEFORE, HASH_AFTER]) {
    const want = execFileSync("python3", ["-X", "int_max_str_digits=0", "-c", prog], { encoding: "utf8", env });
    assert.equal(want.split("\n").length, 3, `CPython ran every line:\n${want}`);
    assert.equal(execFileSync(process.execPath, [__dirname + "/../src/cli.js", "-c", prog], { encoding: "utf8" }), want);
  }
});
