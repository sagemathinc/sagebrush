def show(label,f):
 try:print(label,repr(f()))
 except Exception as e:print(label,type(e).__name__,str(e))
show('runtime list',lambda:(list[int] is list,repr(list[int])))
show('origin args',lambda:(list[int].__origin__,list[int].__args__))
show('runtime dict',lambda:(dict[str,int] is dict,repr(dict[str,int])))
show('invalid int',lambda:int[str])
def f(x:list[int])->dict[str,int]:pass
show('annotations',lambda:f.__annotations__)
