format=99
def f(x:format):pass
print('global format',f.__annotations__)
def g():
 format=88
 def h(x:format):pass
 return h
print('free format',g().__annotations__)
class C:
 format=77
 x:format
 def f(y:format):pass
print('class format',C.__annotations__,C.f.__annotations__)
class D:
 x: __classdict__
try: print('classdict',D.__annotations__['x'] is vars(D))
except Exception as e: print('classdict',type(e).__name__,str(e))
class E:
 def f(x:sorted(locals())):pass
print('locals',E.f.__annotations__)
