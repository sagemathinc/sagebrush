# Wrong answers astra's stateful hunt found at e4a9ce94 (PY-STATE-1..3):
# islice's consumption of its source, groupby's key equality, and the
# iterators that survive an exception from their source. astra's minimal
# program, then the 328 confirmed cases, each in a fresh namespace.
import itertools
it=iter(range(6))
print('islice empty output',list(itertools.islice(it,3,1)))
print('islice empty next',next(it,None))
it=iter(range(7))
print('islice step output',list(itertools.islice(it,0,5,3)))
print('islice step next',next(it,None))
nan=float('nan')
print('groupby shared nan',[len(list(g)) for _,g in itertools.groupby([nan,nan])])
class Equal:
    def __eq__(self,o):return True
    def __ne__(self,o):return True
print('groupby positive equality',[len(list(g)) for _,g in itertools.groupby([Equal(),Equal()])])
class Bumpy:
    def __init__(self):self.i=0
    def __iter__(self):return self
    def __next__(self):
        i=self.i;self.i+=1
        if i==1:raise ValueError('bump')
        if i>=4:raise StopIteration
        return i
it=itertools.chain(Bumpy(),[8])
print('chain first',next(it))
try:next(it)
except ValueError:pass
print('chain remaining',list(it))

CASES = [
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,1,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,2,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,5,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,10,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(1))\na=list(itertools.islice(it,12,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,0,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,0,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,0,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,0,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,0,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,1,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,2,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,5,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,10,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(3))\na=list(itertools.islice(it,12,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,0,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,1,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,2,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,5,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,10,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(6))\na=list(itertools.islice(it,12,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,0,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,1,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,2,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,5,10,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,0,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,0,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,0,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,0,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,1,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,1,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,1,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,1,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,2,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,2,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,2,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,2,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,4,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,4,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,4,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,4,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,5,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,5,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,5,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,5,5))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,10,1))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,10,2))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,10,3))', '(a,list(it))'),
    ('import itertools\nit=iter(range(10))\na=list(itertools.islice(it,12,10,5))', '(a,list(it))'),
    ("import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[float('nan')]*2", '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K()]*2', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K() for _ in range(2)]', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ("import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[float('nan')]*3", '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K()]*3', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K() for _ in range(3)]', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ("import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[float('nan')]*4", '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K()]*4', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K() for _ in range(4)]', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ("import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[float('nan')]*5", '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K()]*5', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K() for _ in range(5)]', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ("import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[float('nan')]*6", '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K()]*6', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ('import itertools\nclass K:\n    def __eq__(self,o):return True\n    def __ne__(self,o):return True\n\nitems=[K() for _ in range(6)]', '[len(list(g)) for k,g in itertools.groupby(items)]'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.chain(Bumpy(),[8])\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.accumulate(Bumpy())\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.cycle(Bumpy())\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.compress(Bumpy(),[True]*10)\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.dropwhile(lambda x:False,Bumpy())\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.takewhile(lambda x:True,Bumpy())\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.starmap(lambda x:x,zip(Bumpy()))\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
    ("import itertools\nclass Bumpy:\n    def __init__(self):self.i=0\n    def __iter__(self):return self\n    def __next__(self):\n        i=self.i;self.i+=1\n        if i==1:raise ValueError('bump')\n        if i>=4:raise StopIteration\n        return i\n\na=itertools.tee(Bumpy())[0]\nout=[]\nfor i in range(7):\n    try:out.append(next(a))\n    except Exception as e:out.append(type(e).__name__)", 'out'),
]
for setup, expr in CASES:
    ns = {}
    try:
        exec(setup, ns)
        r = repr(eval(expr, ns))
    except Exception as x:
        r = type(x).__name__ + ': ' + str(x)
    print(expr, '->', r)

# Each other iterator over a source, after a ValueError from it, and the
# argument checks and eager inputs around them.
import itertools as I
class Bump:
    def __init__(self, n=5):
        self.i, self.n = 0, n
    def __iter__(self):
        return self
    def __next__(self):
        i = self.i
        self.i += 1
        if i == 1:
            raise ValueError('bump')
        if i >= self.n:
            raise StopIteration
        return i
def resume(name, make):
    it = make()
    got = []
    for _ in range(12):
        try:
            got.append(next(it))
        except ValueError:
            got.append('E')
        except StopIteration:
            got.append('S')
            break
    print(name, got)
resume('islice', lambda: I.islice(Bump(), 0, None, 2))
resume('islice stop', lambda: I.islice(Bump(), 1, 4))
resume('filterfalse', lambda: I.filterfalse(None, Bump()))
resume('pairwise', lambda: I.pairwise(Bump()))
resume('zip_longest', lambda: I.zip_longest(Bump(), 'xy', fillvalue='-'))
resume('batched', lambda: I.batched(Bump(8), 2))
resume('groupby', lambda: (k for k, g in I.groupby(Bump())))
resume('accumulate initial', lambda: I.accumulate(Bump(), initial=100))
resume('cycle', lambda: I.cycle(Bump(4)))
resume('dropwhile', lambda: I.dropwhile(lambda x: x < 3, Bump(6)))
resume('takewhile', lambda: I.takewhile(lambda x: x < 3, Bump(6)))
resume('starmap', lambda: I.starmap(lambda x: -x, ((v,) for v in [1, 2, 3])))
a, b = I.tee(Bump())
resume('tee a', lambda: a)
resume('tee b', lambda: b)
c, = I.tee(a, 1)
print('tee of a tee', list(c), I.tee('ab', 0))
for args in [(), (1, 2, 3, 4), (-1,), (1, -1), (0, 5, 0), (None, None, None), (1.5,), ('a',)]:
    try:
        print('islice', args, list(I.islice(range(10), *args)))
    except (TypeError, ValueError) as e:
        print('islice', args, type(e).__name__, e)
for f, a in [(I.permutations, ('ab', -1)), (I.combinations, ('ab', -1)), (I.combinations_with_replacement, ('ab', -1)), (I.product, ('ab',))]:
    try:
        print(f.__name__, list(f(*a)) if f is not I.product else list(f(*a, repeat=-1)))
    except ValueError as e:
        print(f.__name__, e)
src = iter(range(5))
p = I.product(src, repeat=1)
print('product reads its input when called', next(src, None), list(p))
src = iter('abc')
q = I.combinations(src, 2)
print('combinations too', next(src, None), list(q))
try:
    list(I.batched('abcde', 2, strict=True))
except ValueError as e:
    print('batched strict', e)
print(list(I.batched('abcd', 2, strict=True)))
nan = float('nan')
# (a shared NaN is one group; separately made NaNs are not tested: pyjs's
# `is` cannot tell two NaN floats apart)
print([(k is nan, len(list(g))) for k, g in I.groupby([nan, nan, 1, 1.0, True])])
g = I.groupby('aabb')
k1, g1 = next(g)
k2, g2 = next(g)
print(k1, list(g1), k2, list(g2), list(g))

# every public name of CPython's itertools, and repeat (which zip_longest uses)
print(sorted(n for n in dir(I) if not n.startswith('_')))
print(list(I.repeat(7, 3)), list(I.islice(I.repeat('x'), 2)), list(I.zip_longest('abc', 'x', fillvalue=0)))

# astra's edges probe on c58fff1b (CORR-C58-1, -2): chain ends after an error
# from its outer source or an iterable's iter(); islice's arguments go
# through the index protocol (descriptors, non-int results, sys.maxsize);
# product(x, repeat=0) reads nothing
import itertools as it

def take(x,n=5):
 out=[]
 for _ in range(n):
  try:out.append(next(x))
  except Exception as e:out.append(type(e).__name__)
 return out
class Source:
 def __init__(self,events):self.events=iter(events)
 def __iter__(self):return self
 def __next__(self):
  x=next(self.events)
  if isinstance(x,BaseException):raise x
  return x
class Broken:
 def __iter__(self):raise ValueError('broken iter')
print('chain outer',take(it.chain.from_iterable(Source([[1],ValueError('x'),[2],[3]]))))
print('chain setup',take(it.chain([1],Broken(),[2])))
print('chain inner',take(it.chain(Source([1,ValueError('x'),2]),[3])))
for name,f in [('accumulate',it.accumulate),('compress',lambda x:it.compress(x,[1]*8)),('dropwhile',lambda x:it.dropwhile(lambda a:False,x)),('takewhile',lambda x:it.takewhile(lambda a:True,x)),('filterfalse',lambda x:it.filterfalse(None,x)),('tee',lambda x:it.tee(x)[0])]:
 print('resurrect',name,take(f(Source([0,StopIteration(),0,2]))))
x=iter([1,2,3]);p=it.product(x,repeat=0);print('product0',list(p),list(x))
class Static:
 __index__=staticmethod(lambda:2)
class Class:
 @classmethod
 def __index__(cls):return 2
class Prop:
 @property
 def __index__(self):return lambda:2
class BadReturn:
 def __index__(self):return 2.5
for C in [Static,Class,Prop,BadReturn]:
 for pos in range(3):
  a=[0,6,1];a[pos]=C()
  try:print('index',C.__name__,pos,list(it.islice(range(10),*a)))
  except Exception as e:print('index',C.__name__,pos,type(e).__name__)
for step in [2**63,2**100]:
 try:print('huge step',step,list(it.islice(range(4),0,3,step)))
 except Exception as e:print('huge step',step,type(e).__name__)

# operator.index, which islice uses: __index__ by special-method lookup
# (bound by its descriptor), its result an int
import operator
class IxS:
    __index__ = staticmethod(lambda: 2)
class IxC:
    @classmethod
    def __index__(cls): return 3
class IxP:
    @property
    def __index__(self): return lambda: 4
class IxN:
    def __index__(self): return 5
class IxF:
    def __index__(self): return 2.5
class IxNone:
    __index__ = None
for c in (IxS, IxC, IxP, IxN, IxF, IxNone):
    try:
        print('operator.index', c.__name__, operator.index(c()))
    except Exception as e:
        print('operator.index', c.__name__, type(e).__name__, e)
print(operator.index(True), operator.index(2**70), [10, 20, 30][IxS()], list(range(10))[IxS():IxC()])

# product's repeat is an index, converted before any pool is read (CORR-DC4-1)
class Twice(int):
    def __bool__(self): return False
class RepIx:
    def __index__(self): return 2
for r in (0.0, -1, 2**70, '2', Twice(2), RepIx(), True, 0):
    src = iter([1, 2])
    try:
        print('product repeat', repr(r) if not isinstance(r, RepIx) else 'RepIx', len(list(I.product(src, repeat=r))), list(src))
    except Exception as e:
        print('product repeat', repr(r) if not isinstance(r, RepIx) else 'RepIx', type(e).__name__, e, list(src))
for f, args in [(I.combinations, ('abc', 2.0)), (I.combinations, ('abc', Twice(2))), (I.combinations_with_replacement, ('ab', RepIx())),
                (I.permutations, ('abc', 2.0)), (I.permutations, ('abc', Twice(1))), (I.permutations, ('abc', None)), (I.permutations, ('abc', RepIx())), (I.permutations, ('abc', True)), (I.batched, ('abcde', 2.0)),
                (I.batched, ('abcde', Twice(2))), (I.combinations, ('ab', 2**70))]:
    try:
        print(f.__name__, len(list(f(*args))))
    except Exception as e:
        print(f.__name__, type(e).__name__, e)
