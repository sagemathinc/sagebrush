def case(name, src):
    print('CASE',name)
    try:
        exec(src, {'__name__': 'probe'})
    except Exception as e:
        print(type(e).__name__, str(e))

case('future exec keeps existing dictionary', '''
ns = {'__annotations__': {'old': 'saved'}}
a = ns['__annotations__']
exec('from __future__ import annotations\\nx: int', ns)
print(ns['__annotations__'], a is ns['__annotations__'])
''')
case('future separate globals locals', '''
g = {'__annotations__': {'global': 'G'}}
l = {'__annotations__': {'local': 'L'}}
exec('from __future__ import annotations\\nx: int', g, l)
print(g['__annotations__'], l['__annotations__'])
''')
case('future class prepare', '''
class Meta(type):
    @classmethod
    def __prepare__(m, name, bases):
        return {'__annotations__': {'from_prepare': 'saved'}}
ns={'Meta':Meta}
exec('from __future__ import annotations\\nclass C(metaclass=Meta):\\n x: int', ns)
print(ns['C'].__annotations__)
''')
case('future function provider', '''
ns={}
exec('from __future__ import annotations\\ndef f(x: Missing): pass',ns)
f=ns['f']; print(f.__annotate__ is None, f.__annotations__)
''')
case('format global vs local', '''
format=99
x: format
def f(y: format): pass
print(__annotations__, f.__annotations__)
''')
case('class annotation nested scopes', '''
x=8
class C:
    x=5
    a: x
    b: (lambda: x)()
    c: [x for _ in [0]]
    def f(y: x, z: (lambda: x)()): pass
print(C.__annotations__)
print(C.f.__annotations__)
''')
case('class global declaration', '''
x=8
class C:
    global x
    a: x
    def f(y:x):pass
C.x=5
print(C.__annotations__, C.f.__annotations__)
''')
case('closure in annotation nested class', '''
def outer():
 x=7
 class C:
  x=8
  a: x
  b: (lambda: x)()
  def f(y:x, z:(lambda: x)()):pass
 return C
C=outer()
print(C.__annotations__, C.f.__annotations__)
''')
case('annotation nonlocal', '''
def outer():
 x=7
 class C:
  nonlocal x
  a: x
  def f(y:x):pass
 C.x=9
 return C
C=outer()
print(C.__annotations__, C.f.__annotations__)
''')
case('annotation classdict returned', '''
class C:
 x: sorted(locals())
 def f(y: sorted(locals())):pass
print(C.__annotations__, C.f.__annotations__)
''')
case('metaclass descriptor deletion', '''
seen=[]
class D:
 def __get__(self,o,t): return 3
 def __delete__(self,o): seen.append(o.__name__)
class M(type):
 x=D()
class C(metaclass=M):pass
del C.x
print(seen)
''')
case('future repeat exec', '''
ns={}
exec('from __future__ import annotations\\na: int',ns)
exec('from __future__ import annotations\\nb: str',ns)
print(ns['__annotations__'])
''')
