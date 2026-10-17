# str() and str.__str__ of a str subclass: an exact str copy unless __str__
# is overridden (compared with CPython 3.14 by test/str-subclass.test.ts)
class S(str):
    def __len__(self): return 0
class T(str):
    def __str__(self): return "custom"
class U(str):
    def __str__(self): return S("sub")
class V(str):
    def __str__(self): return 5
for f in [lambda: str.__str__(S("{x}")), lambda: str(S("{x}")), lambda: str(T("a")), lambda: str.__str__(T("a")), lambda: str(U("a")), lambda: "%s" % S("q"), lambda: f"{S('q')}", lambda: format(S("q")), lambda: "".join([S("q")]), lambda: S("q") + "", lambda: str(S("q")) is S("q"), lambda: str(V("a")), lambda: S("q").__str__(), lambda: repr(S("q")), lambda: print(S("pp"))]:
    try:
        r = f(); print(type(r).__name__, repr(r), len(r) if isinstance(r, str) else "")
    except Exception as e: print(type(e).__name__, e)
# a str subclass's __str__ returning another subclass instance, and str's
# own methods on a subclass
class W(str):
    def __str__(self): return T("w")
for f in [lambda: str(W("x")), lambda: type(str(W("x"))).__name__, lambda: str.__str__(W("x")), lambda: type(S("abc").upper()).__name__,
          lambda: type(S("abc")[0:2]).__name__, lambda: type(str(S("abc"))).__name__, lambda: type(f"{S('abc')}").__name__, lambda: str(S("")) == ""]:
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)
