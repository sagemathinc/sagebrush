# The Cayley graph cases of @sagebrush-astra's review (cayley-graph 7973e80d): test/cayley_oracle.json is native Sage 10.10's output; test/cayley-graph.test.ts compares
import json

def encoded(G, kw):
    D = G.cayley_graph(**kw)
    def perm(p):
        return [int(p(i)) for i in G.domain()]
    es = [[perm(u),perm(v),None if s is None else (perm(s) if callable(s) else int(s))] for u,v,s in D.edges(sort=False)]
    es.sort(key=lambda e: (e[0], e[1], str(e[2])))
    return {'directed':D.is_directed(),'vertices':sorted(perm(g) for g in D.vertices(sort=False)), 'edges':es}

out={}
for n in [1,2,3,4]:
    G=SymmetricGroup(n)
    for side in ['right','left']:
        for simple in [False,True]:
            try:out['S%s-%s-%s' % (n,side,simple)] = encoded(G,dict(side=side,simple=simple))
            except Exception as e:out['S%s-%s-%s' % (n,side,simple)]={'error':type(e).__name__,'message':str(e)}
G=SymmetricGroup(3)
a=G('(1,2)');b=G('(1,2,3)');one=G(())
for name,kw in [
 ('custom-right',dict(generators=[a,b])),
 ('custom-left',dict(generators=[a,b],side='left')),
 ('alias-right',dict(connecting_set=[a,b])),
 ('empty',dict(generators=[])),
 ('id',dict(generators=[one])),
 ('id-simple',dict(generators=[one],simple=True)),
 ('duplicates-simple',dict(generators=[a,a,one],simple=True)),
 ('subgroup',dict(generators=[a])),
 ('inverse',dict(generators=[b,b**-1])),
 ('list-input',dict(generators=[[2,1,3]])),
 ('tuple-input',dict(generators=[(1,2)])),
]:
    try:out[name]=encoded(G,kw)
    except Exception as e:out[name]={'error':type(e).__name__,'message':str(e)}
print(json.dumps(out,sort_keys=True))
