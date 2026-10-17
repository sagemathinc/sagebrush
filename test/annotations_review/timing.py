import sys,types
m=types.ModuleType('ann_probe')
sys.modules[m.__name__]=m
src="""import sys
m=sys.modules[__name__]
print('early',m.__annotations__)
x:int
if True:
 y:str
print('late',m.__annotations__)
print('direct',m.__annotate__(1))
print('conditional',m.__conditional_annotations__)
"""
exec(src,m.__dict__)
