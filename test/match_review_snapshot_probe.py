# astra's match-statement review probe (snapshot_probe.py, 35611c48), compared with CPython 3.14 by test/match.test.ts
# A sequence's unpacked values must survive a subpattern mutating the subject.
class Equal:
    def __eq__(self, other):
        subject[1]=99
        return True
class Values:
    first=Equal()
subject=[1,2]
match subject:
    case [Values.first,x]: print('snapshot',x,subject)

# Hidden compiler helpers must not resolve as user locals or prepared keys.
def helper_shadow():
    __pyjs_match_seq__=lambda *a:[8,9]
    match [1,2]:
        case [a,b]: return a,b
print('local-helper',helper_shadow())
class NS(dict):
    def __getitem__(self,k):
        if k=='__pyjs_match_seq__': return lambda *a:[8,9]
        return super().__getitem__(k)
class Meta(type):
    @classmethod
    def __prepare__(m,n,b): return NS()
class C(metaclass=Meta):
    match [1,2]:
        case [a,b]: pass
print('prepared-helper',C.a,C.b)
