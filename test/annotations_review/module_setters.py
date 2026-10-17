import types

def show(label,f):
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e))
m=types.ModuleType('m')
for v in [5,None,lambda f:{'x':1}]:
 show('setannot',lambda:setattr(m,'__annotate__',v))
 show('getannot',lambda:type(m.__annotate__).__name__)
 show('getann',lambda:m.__annotations__)
 show('delann',lambda:delattr(m,'__annotations__'))
 show('delannot',lambda:delattr(m,'__annotate__'))
 show('getannot_after_delete',lambda:m.__annotate__)
