def show(label,f):
 try: print(label,repr(f()))
 except Exception as e: print(label,type(e).__name__,str(e))
def outer():
 if False:T=int
 def f(x:T):pass
 return f
show('unbound closure',lambda:outer().__annotations__)
class C:
 T=int
 x:T
 def m(self,x:T):pass
C.T=str
show('class latest',lambda:C.__annotations__)
show('method latest',lambda:C.m.__annotations__)
class D:
 x:__class__
 def m(self,x:__class__):pass
show('class cell',lambda:D.__annotations__)
show('method cell',lambda:D.m.__annotations__)
class E:
 T=int
 x:[T for _ in range(1)]
 def m(self,x:[T for _ in range(1)]):pass
show('comp class',lambda:E.__annotations__)
show('comp method',lambda:E.m.__annotations__)
