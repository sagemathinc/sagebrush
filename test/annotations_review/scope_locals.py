def show(label,f):
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e))
def f(x: sorted(locals())):pass
show('locals',lambda:f.__annotations__)
def outer():
 T=int
 def f(x:T):pass
 return f
f=outer()
class C:
 x:__class__
 def f(self,x:__class__):pass
