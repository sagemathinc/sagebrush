# astra's python-metaclass-setattr 96b07400 probe (CORR-96B-1/2); its str
# subclass name case is the str-subclass-attribute-names branch's, left out
log=[]
def show(label,f):
 log.clear()
 try:print(label,repr(f()),log)
 except Exception as e:print(label,type(e).__name__,str(e).splitlines()[0],log)
class Static(type):
 @staticmethod
 def __setattr__(k,v):log.append(('static set',k,v))
 @staticmethod
 def __delattr__(k):log.append(('static del',k))
class Class(type):
 @classmethod
 def __setattr__(m,k,v):log.append(('class set',m.__name__,k,v))
 @classmethod
 def __delattr__(m,k):log.append(('class del',m.__name__,k))
class Desc:
 def __init__(self,verb):self.verb=verb
 def __get__(self,obj,owner):
  log.append(('bind',self.verb,obj.__name__ if obj is not None else None,owner.__name__))
  return lambda *a:log.append((self.verb,a))
class Descriptor(type):
 __setattr__=Desc('set')
 __delattr__=Desc('del')
class Callable:
 def __init__(self,verb):self.verb=verb
 def __call__(self,*a):log.append((self.verb,a))
class Call(type):
 __setattr__=Callable('set')
 __delattr__=Callable('del')
class Inherited(Static):pass
class Plain(type):
 def __setattr__(c,k,v):log.append(('plain set',k,v));super().__setattr__(k,v)
 def __delattr__(c,k):log.append(('plain del',k));super().__delattr__(k)
for meta in (Static,Class,Descriptor,Call,Inherited,Plain):
 C=meta('C',(),{'x':1})
 show(meta.__name__+' set',lambda:setattr(C,'x',2))
 show(meta.__name__+' read',lambda:C.x)
 show(meta.__name__+' del',lambda:delattr(C,'x'))
 show(meta.__name__+' present',lambda:hasattr(C,'x'))
class C:pass
for f in (type.__setattr__,type.__delattr__,object.__setattr__,object.__delattr__):
 for args in ((),(C,),(C,'x'),(C,'x',2),(C,'x',2,3)):
  show(f.__qualname__+' arity '+str(len(args)),lambda:f(*args))
class Name(str):pass
for name in (1,None,b'foo'):
 show('type set '+type(name).__name__,lambda:type.__setattr__(C,name,4))
 show('type del '+type(name).__name__,lambda:type.__delattr__(C,name))
class Delete:
 def __delete__(self,obj):log.append('descriptor delete')
class M(type):x=Delete()
class D(metaclass=M):pass
show('direct delete descriptor',lambda:type.__delattr__(D,'x'))
show('delete descriptor',lambda:delattr(D,'x'))
