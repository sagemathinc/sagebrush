from __future__ import annotations
# the strings `from __future__ import annotations` makes of annotations,
# as CPython 3.14's ast_unparse writes them
a1: (a + b) * c - -d ** -e ** f
a2: (a ** b ** c, (a ** b) ** c)
a3: not a and b or c and not (d or e)
a4: (a if b else c) if d else e
a5: lambda: 0
a6: lambda x, /, y=1, *a, z, w=2, **k: x
a7: lambda *, k: k
a8: [x for x in y if x if not x]
a9: {k: v for k, v in d.items()}
a10: {*a, *b}
a11: {}
a12: {**a, 'b': 1}
a13: (x for x in y)
a14: f(x for x in y)
a15: f(a, *b, c=1, **d)
a16: (1 .real, 1.5.real, (1).imag)
a17: x[1:2, ::3, ...]
a18: (x[1:], x[:], x[::], x[a, b], x[(a, b)], x[a,])
a19: f"a{b!r:>{width}.{p}}c{{d}}{ {1: 2} }"
a20: b'\x00\xff' + 'é\n\t' + "it's" + 'say "hi"'
a21: (1e309, -1e309j, 2.5j, 1e-7, 10 ** 400, 0.1 + 0.2)
a22: x if y else (lambda: z)
a23: a < b <= c is not d not in e
a24: ~a | b ^ c & d << e >> f // g % h @ i
a25: (-(-a), +a, not not a)
a27: ([*a, *b], (*a,), ())
a28: a.b.c(d)[e](f).g
a29: (None, True, False, ...)
a30: 'a' 'b' f'{c}' 'd'
a31: (f'{x=}', f'{x!s}', f'{x:{y}}')
print(__annotations__)
