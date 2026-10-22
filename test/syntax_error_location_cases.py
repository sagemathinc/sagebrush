# A SyntaxError's location lines, as CPython 3.14's traceback module writes
# them: "  File ..., line N", the line stripped of its indentation, carets
# under offset..end_offset, then the message (test/syntax-error-location.test.ts).
import traceback

SOURCES = [
    "def f(x):\n    y =  # fill in\n    return y\n",
    "x = (1,\n2\n",
    "if True:\n  a = 1\n b = 2\n",
    "print('hi'\n",
    "a b c\n",
    "x = 1 +\n",
    "for i in range(3)\n    pass\n",
    "\tx = 1\n",
    "s = 'caf\u00e9 \u00fcber' +\n",
    "f(x for x in y, 1)\n",
    "class C:\npass\n",
    "1 = x\n",
]
for src in SOURCES:
    try:
        compile(src, "<cell>", "exec")
    except SyntaxError as e:
        print("".join(traceback.format_exception_only(e)), end="")
        print("--")

# made by hand: every branch of the location lines
CASES = [
    ("m", ("f.py", 3, 5, "  abc def ghi\n", 3, 8)),
    ("m", ("f.py", 3, 5, "  abc def ghi\n", 4, 2)),
    ("m", ("f.py", 3, None, "  abc\n")),
    ("m", ("f.py", 3, 50, "abc\n", 3, 60)),
    ("m", ("f.py", 3, 2, "abc\n", 3, 0)),
    ("m", ("f.py", 3, 3, "abc\n", 3, 2)),
    ("m", ("f.py", 3, 1, "   abc\n", 3, 2)),
    ("m", ("f.py", 3, 6, "\t\tab cd\n", 3, 8)),
    ("m", ("f.py", 3, 2, "abc", 3, 3)),
    ("m", (None, 3, 2, "abc\n", 3, 3)),
    ("m", ("", 3, 2, "abc\n", 3, 3)),
    ("m", ("f.py", None, 2, "abc\n", 3, 3)),
    ("m", (None, None, None, None)),
    ("", ("f.py", 1, 1, "x\n", 1, 2)),
    ("m", ("f.py", 1, 1, None, 1, 2)),
    ("m", ("f.py", 2, 4, "\u00e9\u00e9\u00e9 x\n", 2, 5)),
]
for args in CASES:
    e = SyntaxError(*args)
    print("".join(traceback.format_exception_only(e)), end="")
    print("--")
for cls in (IndentationError, TabError):
    e = cls("bad", ("g.py", 7, 3, "    x\n", 7, 4))
    print("".join(traceback.format_exception_only(e)), end="")
# raised through a frame: the frame lines, then the location
def compiles():
    compile("x = = 1\n", "<inner>", "exec")
try:
    compiles()
except SyntaxError as e:
    tb = traceback.format_exception(e)
    print(tb[0], end="")
    print("".join(tb[-4:]), end="")
