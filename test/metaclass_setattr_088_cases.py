# astra's python-metaclass-setattr 0880754a probe (CORR-088-1): a hook's __get__
# a staticmethod, a callable object or a classmethod; compared with CPython by
# test/metaclass-setattr.test.ts
log=[]
def show(label,f):
 log.clear()
 try: print(label,repr(f()),log)
 except Exception as e: print(label,type(e).__name__,str(e).splitlines()[0],log)
class SD:
 @staticmethod
 def __get__(desc,obj,owner):
  log.append(('bind-static',owner.__name__))
  return lambda *a:log.append(('call',a))
class CD:
 @classmethod
 def __get__(cls,obj,owner):
  log.append(('bind-class',cls.__name__,owner.__name__))
  return lambda *a:log.append(('call',a))
class Get:
 def __call__(self,desc,obj,owner):
  log.append(('bind-callable',owner.__name__))
  return lambda *a:log.append(('call',a))
class OD: __get__=Get()
class ND:
 def __get__(self,obj,owner):
  log.append(('bind-plain',owner.__name__))
  return lambda *a:log.append(('call',a))
for D in (ND,SD,CD,OD):
 class M(type):
  __setattr__=D()
  __delattr__=D()
 class C(metaclass=M):x=1
 show(D.__name__+' meta-set',lambda:setattr(C,'x',2))
 show(D.__name__+' meta-del',lambda:delattr(C,'x'))
 class I:
  __setattr__=D()
  __delattr__=D()
 i=I()
 show(D.__name__+' instance-set',lambda:setattr(i,'x',2))
 show(D.__name__+' instance-del',lambda:delattr(i,'x'))
# (its keyword-against-receiver diagnostic order, a separate item, left out)
