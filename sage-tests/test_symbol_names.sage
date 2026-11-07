# Symbolic variable names as Sage 10.10 takes them (SR.var and var: a name must be a Python identifier, not a
# keyword; no name is Sage's ValueError), and hashing with a function whose name is not ASCII and holds a brace
# (the grader's r776b H7: a name's length is read in UTF-8 bytes; the hash of equal expressions agrees).
def show(label, f):
    try:
        print(label, "->", f())
    except Exception as e:
        print(label, "->", "%s: %s" % (type(e).__name__, e))
for n in ['a{b', 'for', 'lambda', 'None', '1a', '_a', 'a b', 'a,b', 'x y{', '变', 'αβ', 'a.b', 'a-b', '']:
    show("SR.var(%r)" % n, lambda: SR.var(n))
    show("var(%r)" % n, lambda: var(n))
x = SR.var('x')
for n in ['变{', '{变', 'a{变', '变{d', 'α{{', 'f']:
    f = function(n)
    a = f(x) + SR(RR(1.5)); b = f(x) + SR(RDF(1.5))
    print(repr(n), hash(a) == hash(b), bool(a == b))
v = var('变')
print(hash(v + SR(RR(1.5))) == hash(v + SR(RDF(1.5))), hash(sin(v) + SR(CC(2.5))) == hash(sin(v) + SR(CDF(2.5))))
