"""Valid Python cells in which lines start with %, %% or ! inside strings,
f-string fields, brackets and continued lines: IPython's magic syntax must
leave every one unchanged (src/magic-syntax.ts), and running it must print
what CPython prints.  Writes test/magic-syntax-corpus.json:

    python3 test/magic_syntax_gen.py

Each case is checked with CPython's compile() and run under CPython for its
output (test/magics.test.ts compares Sagebrush's)."""
import contextlib
import io
import json
import os
import random

MAGICS = ["%time x", "%%time", "!ls -l", "%timeit -n 1 f()", "  %autoreload 2", "%matplotlib inline", "!pip install numpy"]


def piece(rng, depth=0):
    """an expression whose source spans lines, some starting with a magic"""
    m = rng.choice(MAGICS)
    kinds = [
        lambda: '"a\\\n%s b"' % m,                               # continued one-line string
        lambda: "'a\\\n%s'" % m,
        lambda: 'b"a\\\n%s"' % m.replace("!", "!"),               # bytes
        lambda: 'r"a\\\n%s"' % m,                                # raw, continued
        lambda: 'f"a{1}\\\n%s"' % m,                             # f-string, continued
        lambda: 'rb"x\\\n%s"' % m,
        lambda: '"""a\n%s\n"""' % m,                             # triple
        lambda: "'''\n%s\n'''" % m,
        lambda: 'f"""{1}\n%s\n{2}"""' % m,
        lambda: "f\"{'''a\n%s\n'''}\"" % m,                     # a string in an f-string's field
        lambda: 'f"""{"""x\n%s\n"""}"""' % m,                   # (3.12+: the same quotes nested)
        lambda: 'f"{(1,\n%s)}"' % ("2" if not m.strip().startswith("%") else "2  # " + m),
        lambda: 'f"{1 +\n2}{\'\'\'\n%s\n\'\'\'}"' % m,          # a field over lines, then a triple string
        lambda: 'f"{f\'\'\'{1}\n%s\n\'\'\'}"' % m,              # an f-string in an f-string
        lambda: 'f"{x!r:>{w}}\\\n%s"' % m,                     # conversion and nested spec, continued
        lambda: '("a"\n%s"b")' % ("" if "!" in m else ""),       # implicit concatenation in brackets
        lambda: "[1,\n%% 2]" if False else "[5\n% 2]",          # modulo on a line in brackets
        lambda: "(5 \\\n% 3)",
        lambda: '"{}"\\\n.format(1)',
        lambda: '"%d" % 3',
        lambda: '"#" + """\n%s"""' % m,                         # a # inside a string is not a comment
        lambda: "u'a\\\n%s'" % m,
        lambda: "'''it''s\n%s'''" % m,
        lambda: '"\\\\"',                                        # an escaped backslash ends the string
    ]
    s = rng.choice(kinds)()
    if depth < 1 and rng.random() < 0.3:
        s = "(%s,\n%s)" % (s, piece(rng, depth + 1))
    return s


def case(rng):
    lines = ["x = 1", "w = 3", "def f():\n    return 2"]
    for _ in range(rng.randint(1, 3)):
        lines.append("v%d = %s" % (rng.randint(0, 9), piece(rng)))
        if rng.random() < 0.4:
            lines.append("y = 5 \\\n%% 2")
    names = sorted({l.split(" ")[0] for l in lines if l.startswith("v")})
    lines.append("print(%s)" % ", ".join("repr(%s)" % n for n in names))
    return "\n".join(lines)


def main():
    rng = random.Random(725)
    out, seen = [], set()
    while len(out) < 400:
        src = case(rng)
        if src in seen:
            continue
        try:
            code = compile(src, "<cell>", "exec")
        except SyntaxError:
            continue
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            exec(code, {})
        seen.add(src)
        out.append([src, buf.getvalue()])
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "magic-syntax-corpus.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=0, ensure_ascii=True)
        f.write("\n")
    print("wrote %d cases to %s" % (len(out), path))


main()
