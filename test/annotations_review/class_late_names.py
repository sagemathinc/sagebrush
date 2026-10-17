def show(label,f):
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e))
class A:
 T=int
 def f(self,x:T):pass
class B(A):pass
show('base',lambda:A.f.__annotations__)
show('inherited',lambda:B.__annotations__)
class C:
 x:int
C.__annotate__=lambda f:{'custom':1}
print('before delete',C.__annotations__)
try:del C.__annotations__
except Exception as e:print('delete',type(e).__name__,str(e))
print('after delete',C.__annotations__,C.__annotate__ is None)
import types
m=types.ModuleType('m')
m.__annotate__=lambda f:{'custom':1}
print('mod before',m.__annotations__)
del m.__annotations__
print('mod after',m.__annotations__,m.__annotate__ is None)
