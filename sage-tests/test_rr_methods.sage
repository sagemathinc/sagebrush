# RR, RealField(p) and RDF elements' real(), imag(), n() and str(): real()
# and imag() are methods (0 an Integer for RR and RealField, 0.0 for RDF);
# n() refuses a precision past the number's own; str() takes base first,
# then digits.
def show(label, f):
    try:
        r = f()
        # (the parent, not the type: sagebrush's RealField(p) elements are a
        # class of another name)
        print(label, "->", repr(r), r.parent() if hasattr(r, "parent") else type(r).__name__)
    except Exception as e:
        print(label, "!!", type(e).__name__, e)


for nm, v in [("RR", RR(2)), ("RR 1/3", RR(1/3)), ("big", RR(2)^2000), ("sub", RR(2)^-1070), ("RDF", RDF(2)), ("R30", RealField(30)(2)), ("R100", RealField(100)(1/3))]:
    show(nm + ".real()", lambda: v.real())
    show(nm + ".imag()", lambda: v.imag())
    for p in (2, 20, 30, 53, 54, 100, 200):
        show(nm + ".n(%d)" % p, lambda: v.n(p))
        show(nm + ".n(prec=%d)" % p, lambda: v.n(prec=p))
    for d in (1, 5, 15, 16, 20, 30):
        show(nm + ".n(digits=%d)" % d, lambda: v.n(digits=d))
    show(nm + ".numerical_approx(100)", lambda: v.numerical_approx(100))
    show("N(%s, 100)" % nm, lambda: N(v, 100))
    show("n(%s, digits=10)" % nm, lambda: n(v, digits=10))
    if nm != "RDF":
        show(nm + ".str()", lambda: v.str())
        show(nm + ".str(10)", lambda: v.str(10))
        show(nm + ".str(10, 5)", lambda: v.str(10, 5))
        show(nm + ".str(digits=5)", lambda: v.str(digits=5))
        show(nm + ".str(base=10, digits=8)", lambda: v.str(base=10, digits=8))
        show(nm + ".str(no_sci=True)", lambda: v.str(no_sci=True))
        show(nm + ".str(digits=5, no_sci=False)", lambda: v.str(digits=5, no_sci=False))
        for ns in (2, False, True, None, 0, 1):
            for k in (17, 20, -16, -17, -20, 200):
                # (scaled within its own field: RR(2) * 2^-16 is a float in
                # sagebrush for now)
                show(nm + " * 2^%d str(no_sci=%r)" % (k, ns), lambda: (v * v.parent()(2)^k).str(no_sci=ns)[:60])
        show(nm + ".str(truncate=True)", lambda: v.str(truncate=True))
        show(nm + ".str(digits=6, truncate=True)", lambda: v.str(digits=6, truncate=True))
show("RDF.str()", lambda: RDF(2).str())
show("RDF(1/3).str()", lambda: RDF(1/3).str())
show("RDF(-1e300).str()", lambda: RDF(-1e300).str())

# n() truncates a fractional precision before comparing it with the
# number's own (53.9 is 53); N does not call a float subclass's own n();
# str()'s options after digits are keyword-only
def show2(label, f):
    try:
        r = f(); print(label, "->", repr(r), r.parent() if hasattr(r, "parent") else type(r).__name__)
    except Exception as e:
        print(label, "!!", type(e).__name__, e)
R = RealField(100)
for nm, x in [("RR", RR(2)), ("RDF", RDF(2)), ("R100", R(2)), ("big", RR(2)^2000)]:
    for pn, p in [("54.5", 54.5), ("53.9", 53.9), ("100.9", 100.9), ("101.5", 101.5), ("0.5", 0.5), ("'53'", '53'), ("107/2", 107/2), ("RDF(54.2)", RDF(54.2))]:
        show2("%s.n(%s)" % (nm, pn), lambda: x.n(p))
    for dn, d in [("15.9", 15.9), ("16", 16), ("15", 15), ("31", 31)]:
        show2("%s.n(digits=%s)" % (nm, dn), lambda: x.n(digits=d))
class F(float):
    def n(self, *a, **k): return 99
show2("N(F)", lambda: N(F(1.25), 30))
show2("N(F) 53", lambda: N(F(1.25)))
show2("N(RR)", lambda: N(RR(2), 30))
show2("N(RDF,60)", lambda: N(RDF(2), 60))
show2("N(RR,60)", lambda: N(RR(2), 60))
show2("N(float 60)", lambda: N(float(2), 60))
show2("N(big,30)", lambda: N(RR(2)^2000, 30))
show2("N(R100,200)", lambda: N(R(2), 200))
for name,v,p in [('RR',RR(2),53.9),('RDF',RDF(2),53.9),('R30',RealField(30)(2),30.9),('R100',RealField(100)(2),100.9)]:
    show2(name+' fractional prec',lambda:v.n(p))
    show2(name+' alias fractional prec',lambda:v.numerical_approx(p))
class F(float):
    def n(self,*args,**kw):return 99
show2('user float N',lambda:N(F(1.25),30))
for name,v in [('RR',RR(2)),('big',RR(2)^2000),('R100',RealField(100)(2))]:
    show2(name+' str three args',lambda:v.str(10,5,False))
    show2(name+' str keyword',lambda:v.str(10,5,no_sci=False))
# a precision is an int or a number with __int__ (not bytes, a string or an
# object with only __index__); digits are a real number (not a string); N
# reads a float subclass's own value (its __float__ is not called)
class IndexOnly:
    def __index__(self): return int(30)
class IntOnly:
    def __int__(self): return int(30)
class FloatOnly:
    def __float__(self): return float(30.9)
for vn, v in [("RR", RR(2)), ("RDF", RDF(2)), ("R100", RealField(100)(2)), ("big", RR(2)^2000)]:
    for pn, p in [("bytes", b"30"), ("bytearray", bytearray(b"30")), ("memoryview", memoryview(b"30")), ("index-only", IndexOnly()), ("int-only", IntOnly()), ("float-only", FloatOnly()), ("str", "30")]:
        show2(vn + " prec " + pn, lambda: v.n(p))
        show2(vn + " alias prec " + pn, lambda: v.numerical_approx(p))
    for dn, d in [("str", "8.9"), ("bytes", b"8.9"), ("bytearray", bytearray(b"8.9")), ("frac", 8.9), ("index-only", IndexOnly()), ("float-only", FloatOnly())]:
        show2(vn + " digits " + dn, lambda: v.n(digits=d))
class V(float):
    def __float__(self): return float(8)
    def n(self, *a, **kw): return 99
class W(float):
    def __float__(self): raise RuntimeError("conversion")
for x in [V(1.25), W(1.25)]:
    show2(type(x).__name__ + " N", lambda: N(x, 30))
    show2(type(x).__name__ + " N digits", lambda: N(x, digits=5))
    show2(type(x).__name__ + " N 60", lambda: N(x, 60))
for p in [0, 0.5, -0.5, "30", b"30", 53.9, 54.2, IntOnly(), IndexOnly()]:
    show2("N plain " + repr(p) if not isinstance(p, (IntOnly, IndexOnly)) else "N plain " + type(p).__name__, lambda: N(float(2), p))
# a precision is converted once (an __int__ called once); an int subclass's
# precision is its value; digits are a real number, its __float__ bound as
# Python binds a special method (staticmethod, classmethod)
class Static:
    __float__=staticmethod(lambda:float(8.9))
class Class:
    __float__=classmethod(lambda cls:float(8.9))
class Index:
    def __index__(self):return int(8)
class FloatInt(int):
    def __float__(self):return float(8.9)
class IntInt(int):
    def __int__(self):return int(20)
for name,d in [('static',Static()),('class',Class()),('index',Index()),('int-float',FloatInt(2)),('int-int',IntInt(2))]:
    show2('digits '+name,lambda:RealField(100)(2).n(digits=d))
show2('prec int-int',lambda:RR(2).n(IntInt(30)))
calls=[]
class Changing:
    def __int__(self):
     calls.append('int');return int(20+len(calls)*10)
for name,f in [('float',lambda p:N(float(2),p)),('RR',lambda p:N(RR(2),p)),('RDF',lambda p:N(RDF(2),p)),('int',lambda p:N(2,p)),('method',lambda p:RR(2).n(p))]:
    calls.clear();show2('changing '+name,lambda:f(Changing()));print('calls',calls)
# a __float__ descriptor's __get__ is its type's own, not one a metaclass
# __getattribute__ makes up
calls = []
class Meta(type):
    def __getattribute__(cls, name):
        if name == '__get__':
            calls.append('meta-get')
            return lambda *args: lambda *args: float(18.9)
        return super().__getattribute__(name)
class Desc(metaclass=Meta):
    def __get__(self, obj, owner):
        calls.append('real-get')
        return lambda *args: float(8.9)
class V:
    __float__ = Desc()
show2("digits descriptor", lambda: RealField(100)(2).n(digits=V()))
print(calls)
# the MRO and class dicts are the type's own: a metaclass property named
# __mro__ or __dict__ is not consulted
for fake in ("__mro__", "__dict__"):
    calls = []
    def fake_attr(cls):
        calls.append('fake-' + fake)
        return (object,) if fake == "__mro__" else {}
    Meta2 = type("Meta2", (type,), {fake: property(fake_attr)})
    def real_get(self, obj, owner):
        calls.append('real-get')
        return lambda *args: float(8.9)
    Desc2 = Meta2("Desc2", (), {"__get__": real_get})
    V2 = type("V2", (), {"__float__": Desc2()})
    show2("digits " + fake + " property", lambda: RealField(100)(2).n(digits=V2()))
    print(calls)
