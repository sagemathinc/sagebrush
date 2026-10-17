import types
m=types.ModuleType('m')
exec("""if False:
 x: Bad
if True:
 x: int
else:
 x: Bad
x: str
""",m.__dict__)
print(m.__annotations__)
print(m.__conditional_annotations__)
class C:
 if False:x:Bad
 if True:x:int
 else:x:Bad
 x:str
print(C.__annotations__)
print([(k,type(v).__name__) for k,v in C.__dict__.items() if 'annot' in k])
