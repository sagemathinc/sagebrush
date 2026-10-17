import types

def show(label,f):
 try: print(label,repr(f()))
 except Exception as e: print(label,type(e).__name__,str(e))
for kind in ['class','module','function','dynamic']:
 if kind=='class':
  class A:pass
 elif kind=='module': A=types.ModuleType('m')
 elif kind=='function':
  def A():pass
 else:A=type('A',(),{})
 show((kind,'initial'),lambda:(A.__annotate__,A.__annotations__))
 show((kind,'setann'),lambda:setattr(A,'__annotations__',{'x':1}))
 show((kind,'setannot'),lambda:setattr(A,'__annotate__',lambda f:{'y':2}))
 show((kind,'after'),lambda:(A.__annotations__,A.__annotate__(1)))
 show((kind,'delannot'),lambda:delattr(A,'__annotate__'))
 show((kind,'afterdel'),lambda:callable(A.__annotate__))
 show((kind,'delann'),lambda:delattr(A,'__annotations__'))
 show((kind,'regen'),lambda:A.__annotations__)
class A:
 def __annotate__(format):return {'x':format}
show('manual class',lambda:(A.__annotate__(1),A.__annotations__))
