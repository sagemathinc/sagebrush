# astra's python-metaclass-setattr 96b07400 findings (CORR-96B-1/2)
log=[]
class M(type):
 @staticmethod
 def __setattr__(name,value):log.append(('set',name,value))
 @staticmethod
 def __delattr__(name):log.append(('delete',name))
class C(metaclass=M):x=1
for f in (lambda:setattr(C,'x',2),lambda:delattr(C,'x')):
 try:print('hook',f())
 except Exception as e:print('hook',type(e).__name__,str(e).splitlines()[0])
print('log',log)
class Plain:x=1
for label,f in [('set extra',lambda:type.__setattr__(Plain,'x',2,'extra')),('del extra',lambda:type.__delattr__(Plain,'x','extra'))]:
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e).splitlines()[0])
 print('state',hasattr(Plain,'x'),getattr(Plain,'x',None))
for label,f in [('set kwargs',lambda:type.__setattr__(Plain,name='x',value=3)),('del kwargs',lambda:type.__delattr__(Plain,name='x'))]:
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e).splitlines()[0])
