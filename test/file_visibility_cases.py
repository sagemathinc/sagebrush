# open(F, M).write(S) as a statement (any F, M and S): the file is written and
# closed at the statement, as CPython's dropped temporary is; python3 and Sagebrush
# print the same lines (test/file-once.test.ts).  Held files and the
# same-path cases: a held file's data is visible at its close, as CPython's
# buffer is.  (plan-pyjs-file-visibility r5 to r7)
import os, tempfile

d = tempfile.mkdtemp()
P = lambda n: os.path.join(d, n)
sz = os.path.getsize
rd = lambda p: open(p, "rb").read()
# (a declined site's file object is today's: written when pyjs flushes it,
# at a cell's end or the program's, which settle() stands for here; CPython
# has closed it already)
try:
    import _pyjs_open
    settle = _pyjs_open._flush_all
except ImportError:
    settle = lambda: None

# --- the eligible forms, module scope: names and literals, each mode
p = P("t"); S = "héllo 😀"; M = "w"
n = open(p, M).write(S)
print("1 names, text:", n, sz(p), repr(rd(p)))
L = P("lit")
n = open(L, "w").write("X = 5\n")
print("2 literals:", n, sz(L))
B = b"\x00\x01\x02"
n = open(p, "wb").write(B)
print("3 binary:", n, rd(p))
open(p, "a").write("A"); open(p, "a").write("B")
print("4 append:", rd(p))
n = open(p, "ab").write(b"C")
print("5 append bytes:", n, rd(p))
E = ""
n = open(p, "w").write(E)
print("6 empty str truncates:", n, sz(p))

# --- function scope: locals, a closure cell, a parameter
def local_site(q, s):
    m = "w"
    return open(q, m).write(s)
print("7 locals:", local_site(P("f1"), "abc"), sz(P("f1")))
def outer():
    q = P("f2"); m = "wb"; s = b"cell"
    def inner():
        return open(q, m).write(s)
    return inner()
print("8 cells:", outer(), rd(P("f2")))
def shadow(open=open):
    q = P("f3")
    return open(q, "w").write("local open")
print("9 a local open (the builtin):", shadow(), sz(P("f3")))

# --- the reported bug: a temporary write, then the file is read or imported
p = P("m.py"); open(p, "w").write("X = 5\n"); print("10 written, then size:", sz(p))
print("11 then read:", repr(open(p).read()))
import sys
sys.path.insert(0, d)
SRC = "VALUE = 42\n"
MOD = P("fvmod.py")
open(MOD, "w").write(SRC)
import fvmod
print("12 then imported:", fvmod.VALUE)

# --- held files: visible at close, as CPython's buffer
p = P("a"); open(p, "w").close()
g = open(p, "a"); g.write("A"); open(p, "a").write("B"); g.close()
print("13 held appender, temporary append, close:", repr(open(p).read()))
p = P("r"); h = open(p, "w"); h.write("x"); print("14 held writer, then read:", repr(open(p).read())); h.close()
print("14b after close:", repr(open(p).read()))
p = P("o2"); f = open(p, "w"); f.write("AAAA"); open(p, "w").write("B"); f.close()
print("15 held 'AAAA', temporary 'B', close:", repr(open(p).read()))
with open(P("wb"), "w") as f:
    f.write("with")
print("16 with block:", sz(P("wb")))
f = None

# --- the return value and truncation
n = open(P("n"), "w").write("😀😀abcde")
print("17 the return value, non-BMP:", n)
p = P("tr"); open(p, "w").write("0123456789"); E2 = "0"
n = open(p, "w").write(E2)
print("18 truncation:", n, repr(open(p).read()))

# --- the open's errors, before S is read
def err(label, f):
    try:
        f()
    except Exception as e:
        print(label, type(e).__name__, str(e).replace(d, "<d>"))
MISSING = "/nonexistent-dir/x.txt"
err("19 missing dir:", lambda: open(MISSING, "w").write("x"))
DIR = d
def dir_write():
    s = "x"
    return open(DIR, "w").write(s)
err("20 a directory:", dir_write)
def append_missing():
    open(MISSING, "a").write("x")
err("21 a missing dir, append:", append_missing)

# --- an unbound S: the open's effects, then the scope's own error
p = P("u1")
try:
    open(p, "w").write(UNBOUND)
except NameError as e:
    print("22 a global S:", type(e).__name__, e, "| exists", os.path.exists(p), sz(p))
def unbound_local():
    q = P("u2")
    try:
        open(q, "w").write(s)
    except UnboundLocalError as e:
        print("23 a local S:", type(e).__name__, e, "| exists", os.path.exists(q))
    s = 1
unbound_local()
def unbound_cell():
    q = P("u3")
    def inner():
        return open(q, "w").write(c)
    try:
        inner()
    except NameError as e:
        print("24 a cell S:", type(e).__name__, e, "| exists", os.path.exists(q))
    c = 1
unbound_cell()
p = P("u4"); open(p, "w").write("keep")
try:
    open(p, "a").write(UNBOUND)
except NameError as e:
    print("25 append, unbound S: the file is kept:", repr(open(p).read()))
try:
    open(MISSING, "w").write(UNBOUND)
except Exception as e:
    print("26 the open fails first:", type(e).__name__, e)

# --- declines: today's evaluation, same results
class Sub(str):
    pass
SUB = Sub("sub")
n = open(P("d1"), "w").write(SUB)
print("27 a str subclass:", n, sz(P("d1")))
err("28 bytes to a text file:", lambda: open(P("d2"), "w").write(b"x"))
err("29 str to a binary file:", lambda: open(P("d3"), "wb").write("x"))
Q = "x"
err("30 mode x, then again:", lambda: (open(P("d4"), "x").write(Q), open(P("d4"), "x").write(Q)))
# (31, a lone surrogate, declines too; today's write takes it, and its
# encoding fails at the flush, a pyjs divergence: test/file-once.test.ts)
BA = bytearray(b"ba")
n = open(P("d6"), "wb").write(BA)
print("32 a bytearray:", n, rd(P("d6")))

# --- the canonical open running user code (astra2's CORR-IO-R6-1 probes)
class FsRebind:
    def __fspath__(self):
        global S1
        S1 = "new"
        return P("p1")
S1 = "old"
FR = FsRebind()
open(FR, "w").write(S1)
settle()
print("33 __fspath__ rebinds S:", repr(open(P("p1")).read()))
class FsRaise:
    def __fspath__(self):
        raise RuntimeError("fspath")
FX = FsRaise()
err("34 __fspath__ raises:", lambda: open(FX, "w").write("x"))
class FsDel:
    def __fspath__(self):
        global S2
        del S2
        return P("p3")
S2 = "x"
FD = FsDel()
try:
    open(FD, "w").write(S2)
except NameError as e:
    print("35 __fspath__ deletes S:", type(e).__name__, e, "| exists", os.path.exists(P("p3")))
def fn_probes():
    class Rebind:
        def __fspath__(self):
            nonlocal s
            s = "new"
            return P("p4")
    s = "old"
    r = Rebind()
    open(r, "w").write(s)
    settle()
    print("36 function scope, __fspath__ rebinds S:", repr(open(P("p4")).read()))
fn_probes()

# --- a user open: read before S, called before S is read
held = []
def my_open(f, m):
    global S3
    S3 = "rebound"
    fh = real_open(f, m)
    held.append(fh)
    return fh
S3 = "first"
real_open = open
open = my_open
open(P("u5"), "w").write(S3)
open = real_open
held.pop().close()
print("37 a user open that rebinds S:", repr(open(P("u5")).read()))

# --- c1 + c2: computed operands; S evaluated with the file already open
import json
os.makedirs(D2 := P("cat") + "/python")
open(D2 + "/one.json", "w").write(json.dumps({"name": "f"}))
print("38 the catalog form, then read:", repr(open(D2 + "/one.json").read()))
F = P("abbb")
def other():
    open(F, "a").write("BBBB")
    return "A"
open(F, "w").write(other())
print("39 S writes BBBB through another handle, returns A:", repr(open(F).read()))
G = P("ren")
open(G, "w").write("old")
def rename():
    os.rename(G, G + ".moved")
    open(G, "w").write("new")
    return "X"
open(G, "w").write(rename())
print("40 S renames the file and recreates it:", repr(open(G).read()), repr(open(G + ".moved").read()))
H = P("raise")
open(H, "w").write("before")
def boom():
    raise ValueError("boom")
try:
    open(H, "w").write(boom())
except ValueError as e:
    print("41 S raises after the open:", e, sz(H))
def fails(label, f, path):
    try:
        print(label, "returned", f())
    except Exception as e:
        print(label, type(e).__name__, str(e).replace(d, "<d>"), "| size", sz(path) if os.path.exists(path) else None)
def w1():
    return open(P("e1"), "w").write(b"x")
def w2():
    return open(P("e2"), "wb").write("x")
def w3():
    return open(P("e3"), "w").write(5)
def w4():
    return open(P("e4"), "wb").write(None)
def w5():
    return open(P("e5"), "w").write("ab\ud800")
def w6():
    return open(MISSING, "w").write(UNDEFINED_NAME)
def w7():
    return open(os.path.join(DIR, "no", "such"), "a").write(str(1))
fails("42 bytes to a text file:", w1, P("e1"))
fails("43 str to a binary file:", w2, P("e2"))
fails("44 an int to a text file:", w3, P("e3"))
fails("45 None to a binary file:", w4, P("e4"))
fails("46 a lone surrogate:", w5, P("e5"))
fails("47 the open fails before S is evaluated:", w6, MISSING)
fails("48 a computed missing path, append:", w7, P("no"))
n = open(P("mv"), "wb").write(memoryview(b"abcd")[1:3])
print("49 a memoryview slice:", n, rd(P("mv")))
class Sub2(str):
    def __str__(self):
        return "not this"
n = open(P("s2"), "w").write(Sub2("this"))
print("50 a str subclass's own text, not its __str__:", n, repr(open(P("s2")).read()))
MODES = ["w", "b"]
n = open(P("cm"), MODES[0] + MODES[1]).write(bytes([1, 2]))
print("51 a computed mode:", n, rd(P("cm")))
# (52, a user open's write method rebound while S is evaluated, is a
# divergence: pyjs looks up a method after its arguments: test/file-once.test.ts)
def nested():
    x = open(P("nest"), "w").write("in a function: " + "joined")
    return x
print("53 a function's site:", nested(), repr(open(P("nest")).read()))
