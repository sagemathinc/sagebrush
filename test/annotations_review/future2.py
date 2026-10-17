from __future__ import annotations
import sys
def f(x: Missing, *a: tuple[int, ...], y: "q" = 1, **k: dict[str, int]) -> list[int]: pass
print(f.__annotations__, f.__annotate__)
class C:
    a: int
    b: Missing = 3
    def m(self) -> C: pass
print(C.__annotations__, C.__annotate__, C.m.__annotations__)
x: lambda: 1 + 2
y: [i for i in range(3)]
z: a.b[c:d, ::2] | None
w: f"{x!r:>10}"
v: (1, 2) and not -x ** 2
u: 1 if x else 2
t: {"k": [1, 2.5, 1e100, 1j, ..., None, True]}
s: await_ if 0 else 'it''s'
print(__annotations__)
print(sys.modules[__name__].__annotate__)
def g():
    loc: Missing = 1
    return loc
print(g())
