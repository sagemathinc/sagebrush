# a stringized annotation is still checked, as CPython's symtable checks it
cases = [
    'x: (y := 1)', 'x: (yield)', 'x: lambda: (yield)', 'x: lambda: (y := 1)',
    'x: [(y := 1) for a in b]', 'x: [(yield) for a in b]', 'x: lambda: await z',
    'async def f():\n    x: [a async for a in b]', 'async def f():\n    x: [await a for a in b]',
    'async def f():\n    x: await y', 'async def f():\n    x: lambda: [a async for a in b]',
    'x: (a for a in b if (yield))', 'def f():\n    x: (yield)', 'x: {a: (yield) for a in b}',
    'x: {(yield) for a in b}', 'x: lambda: [(y := 1) for a in b]', 'x: (a async for a in b)',
    'x: [a for a in (yield)]', 'x: [a for a in (y := b)]', 'x: lambda: [await a for a in b]',
    'x: [(lambda: (yield)) for a in b]', 'x: [a for a in b for c in (yield)]',
    'x: [a for a in b if (y := 1)]', 'x: [[c async for c in a] for a in b]',
    'x: ((c async for c in a) for a in b)', 'x: [(await a) for a in b]',
    'def f(a: (y := 1)): pass', 'def f() -> (yield): pass', 'x: lambda *, k: k',
    'x: lambda *a, **k: 0', 'x: lambda **k: 0', 'x: lambda a, *b: 0',
    'x: lambda: (y := a + b)', 'x: lambda: (yield from z)', 'x: lambda: (yield a, b)',
    'x: [((y := a), b) for a in c]', 'x: f(lambda: (y := 1))', 'x: lambda: [y := 1, 2]',
    # (astra CORR-A2A-3: the comprehension restrictions on walrus still apply)
    'x: [(a := 1) for a in b]', 'x: lambda: [a for a in (b := c)]', 'x: lambda: [(a := 1) for a in b]',
    'x: [a for c in d for a in (b := e)]', 'x: [(a := 1) for b in c]', 'x: [[(a := 1) for c in d] for a in b]',
    'x: [[(c := 1) for c in d] for a in b]', 'x: [i for i in b if (j := 0) for j in c]', 'x: [lambda: (a := 1) for a in b]',
    'x: [(a := 1) for (a, b) in c]', 'x: [(a := 1) for [*a] in c]', 'x: lambda: [x for x in [(y := 1)]]', 'x: {(a := 1): 2 for a in b}',
    'x: [a for a in b if [(a := 1) for c in d]]', 'x: [(lambda: [y for y in (z := 1)]) for a in b]', 'x: (a for a in b if (a := 1))',
    'x: [a for a in [b for b in (c := d)]]', 'x: lambda: [[c for c in (d := e)] for a in b]', 'x: [j for i in b if (j := 0) for k in c]',
    "x: u'hello'", "x: (u'a', 'b', f'{u\"c\"}')",
]
for c in cases:
    src = 'from __future__ import annotations\n' + c + '\n'
    try:
        ns = {}
        exec(compile(src, '<case>', 'exec'), ns)
        print(repr(c), 'ok', ns.get('__annotations__'))
    except SyntaxError as e:
        print(repr(c), type(e).__name__, e.msg, e.lineno)
