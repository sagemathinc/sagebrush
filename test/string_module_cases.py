# The string module (lib/string/__init__.py, CPython 3.14's, over
# lib/_string.py), as CPython 3.14's (compared with CPython by
# test/stdlib-string-traceback.test.ts)
import string


def show(label, f):
    try:
        print(label, "->", repr(f()))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


for name in ["whitespace", "ascii_lowercase", "ascii_uppercase", "ascii_letters", "digits", "hexdigits", "octdigits", "punctuation", "printable"]:
    print(name, repr(getattr(string, name)))
print(sorted(string.__all__))

show("capwords", lambda: string.capwords("  hello   wORLD  of\tpython "))
show("capwords sep", lambda: string.capwords("a-b--c", "-"))
show("capwords empty", lambda: string.capwords(""))

T = string.Template
show("substitute", lambda: T("$who likes ${what}, $$5").substitute(who="tim", what="kung pao"))
show("substitute mapping", lambda: T("$a+$b").substitute({"a": 1}, b=2))
show("substitute missing", lambda: T("$who $missing").substitute(who="x"))
show("substitute invalid", lambda: T("$who $").substitute(who="x"))
show("substitute invalid line", lambda: T("line1\nline2 ${").substitute())
show("safe_substitute", lambda: T("$who $missing ${x} $").safe_substitute(who="x"))
show("get_identifiers", lambda: T("$a ${b} $a $$c ${d}").get_identifiers())
show("is_valid", lambda: (T("$a ${b}").is_valid(), T("$a $").is_valid()))
show("template attr", lambda: T("x").template)


class MyTemplate(string.Template):
    delimiter = "%"
    idpattern = "[a-z]+"


show("subclass delimiter", lambda: MyTemplate("%who %% %{x}").substitute(who="w", x="X"))

F = string.Formatter()
show("format", lambda: F.format("{0} {1!r} {name:>6} {{}}", 1, "a", name="n"))
show("format nested spec", lambda: F.format("{0:{1}{2}}", 3.14159, ".", "3f"))
show("format attr item", lambda: F.format("{0.real} {1[k]} {1[0]}", 3 + 4j, {"k": "v", 0: "zero"}))
show("format auto", lambda: F.format("{} {} {}", "a", "b", "c"))
show("format auto then manual", lambda: F.format("{} {1}", "a", "b"))
show("format manual then auto", lambda: F.format("{0} {}", "a", "b"))
show("format missing", lambda: F.format("{x}"))
show("format index", lambda: F.format("{3}", 1))
show("format bad conversion", lambda: F.format("{0!z}", 1))
show("format conversions", lambda: F.format("{0!s} {0!r} {0!a}", "é"))
show("format single brace", lambda: F.format("a } b"))
show("format unclosed", lambda: F.format("a { b"))
show("vformat", lambda: F.vformat("{a}-{0}", (1,), {"a": 2}))
show("parse", lambda: list(F.parse("x{0!r:>{w}}y{{z}}")))
show("get_field", lambda: F.get_field("0.imag", (2 + 3j,), {}))
show("check_unused_args", lambda: F.check_unused_args(set(), (), {}))
show("format recursion depth", lambda: F.format("{0:{1:{2:{3}}}}", 1, 2, 3, 4))


class Strict(string.Formatter):
    def check_unused_args(self, used_args, args, kwargs):
        unused = set(kwargs) - {k for k in used_args if isinstance(k, str)}
        if unused:
            raise ValueError("unused: %s" % sorted(unused))

    def convert_field(self, value, conversion):
        if conversion == "u":
            return str(value).upper()
        return super().convert_field(value, conversion)


show("subclass", lambda: Strict().format("{a!u} {b}", a="x", b="y"))
show("subclass unused", lambda: Strict().format("{a}", a=1, extra=2))


# Formatter over a str subclass with its own __len__ or __getitem__: the
# string's characters (astra's CORR-484-1)
class Short(str):
    def __len__(self):
        return 0


class Indexed(str):
    def __getitem__(self, key):
        return "bad"


show("subclass __len__", lambda: string.Formatter().format(Short("{x}"), x="value"))
show("subclass __getitem__", lambda: string.Formatter().format(Indexed("{x}!"), x="value"))
show("subclass field name", lambda: string.Formatter().format("{0[k]}", {Short("k"): 1, "k": 2}))
