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
]
for c in cases:
    src = 'from __future__ import annotations\n' + c + '\n'
    try:
        ns = {}
        exec(compile(src, '<case>', 'exec'), ns)
        print(repr(c), 'ok', ns.get('__annotations__'))
    except SyntaxError as e:
        print(repr(c), type(e).__name__, e.msg, e.lineno)
