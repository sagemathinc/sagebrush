G={'__name__':'probe','T':int}
L={'T':str}
exec('def f(x:T)->T:pass',G,L)
print(L['f'].__annotations__)
G['T']=float
print(L['f'].__annotate__(1))
