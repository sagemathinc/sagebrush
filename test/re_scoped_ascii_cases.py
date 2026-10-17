# re's scoped ASCII flag, (?a:...), as CPython 3.14's (compared with CPython
# by test/stdlib-string-traceback.test.ts): its \w \d \s \b and IGNORECASE are
# ASCII's inside the group, the pattern's outside it (string.Template's
# idpattern is (?a:[_a-z][_a-z0-9]*) under IGNORECASE)
import re, string

KELVIN, LONG_S, DOTLESS = "\u212a", "\u017f", "\u0131"


def show(label, f):
    try:
        print(label, "->", repr(f()))
    except Exception as e:
        print(label, "raises", type(e).__name__, e)


for pat in [r"[a-z]+", r"(?a:[a-z]+)", r"(?a:[_a-z][_a-z0-9]*)", r"(?a:k)", r"(?a:\w+)", r"\w+", r"(?a:[^a-z]+)"]:
    for s in ["Kelvin", KELVIN + "elvin", "ma" + LONG_S + "s", "caf\u00e9", "x" + DOTLESS + "y"]:
        show("%s I %r" % (pat, s), lambda: re.match(pat, s, re.I) and re.match(pat, s, re.I).group())
show("outside the group unchanged", lambda: re.match(r"(?a:k)" + KELVIN, "k" + "k", re.I) is not None)
show("\\b ascii", lambda: re.findall(r"(?a:\b\w+\b)", "caf\u00e9 ok"))
show("\\d ascii", lambda: re.findall(r"(?a:\d+)|\d+", "12\u0663\u0664"))
show("\\s ascii", lambda: re.findall(r"(?a:\s)", " \u00a0\t"))
show("nested i in a", lambda: re.findall(r"(?a:(?i:k)x)", "kx Kx " + KELVIN + "x kX"))
try:
    re.compile(r"(?au:x)")
except re.error as e:
    print("a and u: re.error", e)
show("named group in a", lambda: re.match(r"(?a:(?P<w>\w+))", "abc\u00e9").group("w"))

T = string.Template
show("template", lambda: T("$who likes ${what}").substitute(who="tim", what="pao"))
show("template kelvin", lambda: T("$" + KELVIN + "elvin").safe_substitute())
show("template non-ascii", lambda: T("$caf\u00e9").safe_substitute(caf="X"))
show("template identifiers", lambda: T("$a $" + KELVIN + " ${b}").get_identifiers())
