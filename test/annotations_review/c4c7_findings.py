# astra's lazy-annotations 4c7ab32d findings; its setdefault on a made
# class's __classdict__ is a read here (such writes are refused, CORR-2F0-2:
# test/annotations-review.test.ts)
def case(label, src):
 print(label)
 try: exec(src, {'__name__':'probe'})
 except Exception as e: print(type(e).__name__, getattr(e,'msg',str(e)).splitlines()[0])

case('stable classdict', """class C:
 a: __classdict__ is __classdict__
 b: locals()['__classdict__'] is __classdict__
 def f(x: __classdict__.get('added',12), y: __classdict__.get('added')):pass
print(C.__annotations__,C.f.__annotations__)
""")
case('nested classdict', """class C:
 value=27
 a: (lambda: __classdict__)()['value']
print(C.__annotations__)
""")
case('global classdict', """__classdict__=27
class C:
 global __classdict__
 a: __classdict__
v=C.__annotations__['a'];print(type(v).__name__,v if isinstance(v,int) else 'namespace')
""")
case('nonlocal classdict', """def outer():
 __classdict__=27
 class C:
  nonlocal __classdict__
  a: __classdict__
 return C
v=outer().__annotations__['a'];print(type(v).__name__,v if isinstance(v,int) else 'namespace')
""")
case('future iterable nested lambda', """from __future__ import annotations
x: [a for a in (lambda: (b := 1))]
print(__annotations__)
""")
case('future iterable nested comprehension', """from __future__ import annotations
x: [a for a in [(b := 1) for c in d]]
print(__annotations__)
""")
case('valid ordinary lambda', """from __future__ import annotations
x: [lambda: (a := 1) for a in b]
print(__annotations__)
""")
