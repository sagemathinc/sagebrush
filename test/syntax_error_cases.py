# A SyntaxError's attributes, args and str(), and compile(..., 'single')'s
# one statement, as CPython 3.14 (test/coverage-fixes.test.ts).
for src, mode in (("1 +", "exec"), ("for x in y:\n", "single"), ("def f():\nreturn 1", "exec"), ("  x = 1", "exec"), ("x = 1\ny = 2", "single"), ("print 'a'", "exec"), ("a b", "exec")):
    try:
        compile(src, "<stdin>", mode)
    except SyntaxError as e:
        print(type(e).__name__, repr(str(e)), e.filename, e.lineno, e.offset, repr(e.msg), repr(e.text), e.args[1:] and e.args[1][:2])
try:
    exec("1 +")
except SyntaxError as e:
    print(repr(str(e)), e.filename, e.lineno)
for args in ((), ("m",), ("m", ("f", 3, 1, "t")), ("m", (None, 3, 1, "t")), ("m", ("f", None, 1, "t"))):
    e = SyntaxError(*args)
    print(repr(str(e)), e.filename, e.lineno)
for s in ['x = 1\ny = 2', 'x = 1; y = 2', 'for i in x:\n    pass\ny = 1', 'def f():\n    return 1\n\nf()', 'x = (1,\n 2)\ny = 3', 'x = 1\n\n\ny = 2\n', '# c\nx = 1\ny = 2', 'x = 1\n', 'if 1:\n    a = 1\n    b = 2\n', 'class A:\n    pass\nclass B:\n    pass\n', 'x = 1  # c\ny = 2', 'try:\n    pass\nexcept E:\n    pass\nz = 1\n']:
    try:
        compile(s, '<stdin>', 'single'); print('ok', repr(s))
    except SyntaxError as e:
        print(repr(s), e.lineno, e.offset, repr(e.text), e.end_lineno, e.end_offset, str(e))
for s in ['x = 1   \ny = 2', 'x = 1   # c  \ny = 2', 'x = 1\\\n+2\ny = 3', 'for i in x: pass\ny = 1', 'if 1:\n    pass\n    \n  # c\n(y)', 'with a:\n  pass\n@d\ndef f(): pass']:
    try:
        compile(s, '<stdin>', 'single'); print('ok', repr(s))
    except SyntaxError as e:
        print(repr(s), e.lineno, e.offset, repr(e.text), e.end_lineno, e.end_offset, str(e))
# (one logical line on several physical ones; # in a string, CORR-606-1)
ns = {}
for s in ['a=(\n1); b=2\n', 'a=1; \\\nb=2\n', 'x = [1,\n 2]; y = 3\n']:
    exec(compile(s, 'x', 'single'), ns)
print(ns['a'], ns['b'], ns['x'], ns['y'])
for s in ['"#"\nx=2\n', "'a # b'  # c\nx=2\n", 'x = """\n#\n"""\ny = 1\n', 'a=(\n1); b=2\nc=3\n']:
    try:
        compile(s, '<stdin>', 'single'); print('ok', repr(s))
    except SyntaxError as e:
        print(repr(s), e.lineno, e.offset, repr(e.text), e.end_lineno, e.end_offset, str(e))
for s in ['if 1:\n    a = 1\nelif 2:\n    a = 2\nelse:\n    a = 3\n', 'try:\n    pass\nexcept E:\n    pass\nelse:\n    pass\nfinally:\n    pass\n', 'while 0:\n    pass\nelse:\n    pass\nq = 1\n', 'for i in []:\n    pass\nelse:\n    pass\n']:
    try:
        compile(s, '<stdin>', 'single'); print('ok', repr(s))
    except SyntaxError as e:
        print(repr(s), e.lineno, e.offset, repr(e.text), e.end_lineno, e.end_offset, str(e))
