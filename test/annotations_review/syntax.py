sources=[
 'def f(x: (y := int)): pass',
 'x: (y := int)',
 'class C:\n x: (y := int)',
 'def outer():\n def f(x: (yield int)): pass',
 'def outer():\n def f(x: (yield from [int])): pass',
 'async def outer():\n def f(x: (await g())): pass',
 'def f():\n x: (y := int)',
 'class C:\n x: [int for y in (int,)]',
 'class C:\n T=int\n x: lambda: T',
]
for i,src in enumerate(sources):
 try:compile(src,'<ann>','exec');print(i,'accepted')
 except Exception as e:print(i,type(e).__name__,str(e).split(' (<ann>')[0])
