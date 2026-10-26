# open(F, M).write(S) where reading a name runs user code: every lookup, in
# order, with whether F's file exists when it happens (astra2's probe); a
# site there declines before any read, so python3 and Sagebrush print the
# same lines (test/file-once.test.ts).
import builtins, os, tempfile

d = tempfile.mkdtemp()
F = os.path.join(d, "f")
try:
    import _pyjs_open
    settle = _pyjs_open._flush_all
except ImportError:
    settle = lambda: None


class Logging(dict):
    def __getitem__(self, k):
        log.append((k, os.path.exists(F)))
        return dict.__getitem__(self, k)


def show(label):
    settle()
    print(label, log, open(F).read() if os.path.exists(F) else None)
    if os.path.exists(F):
        os.remove(F)


SRC = "open(F, M).write(S)"
log = []
exec(SRC, {"F": F, "M": "w", "S": "a"}, Logging(F=F, M="w", S="a"))
show("1 mapping locals:")

log = []
g = Logging(F=F, M="w", S="b", __builtins__=builtins)
exec("def f():\n    open(F, M).write(S)", g)
log = []
g["f"]()
show("2 a function over subclass globals:")

log = []
b = Logging(builtins.__dict__)
exec("def f():\n    open(F, M).write(S)", h := {"F": F, "M": "w", "S": "c", "__builtins__": b})
h["f"]()
show("3 custom builtins:")


class Meta(type):
    @classmethod
    def __prepare__(m, name, bases):
        return Logging(F=F, M="w", S="d")


log = []


class C(metaclass=Meta):
    open(F, M).write(S)


show("4 a __prepare__ namespace:")

log = []
exec(SRC, Logging(F=F, M="w", S="e", __builtins__=builtins))
show("5 subclass globals, module level:")


# a S lookup that rebinds S (seen only by a later read)
class Rebinding(dict):
    def __getitem__(self, k):
        log.append((k, os.path.exists(F)))
        if k == "S":
            dict.__setitem__(self, "S", "second")
        return dict.__getitem__(self, k)


log = []
ns = Rebinding(F=F, M="w", S="first")
exec(SRC, {}, ns)
show("6 a rebinding lookup:")
print("6b S afterwards:", dict.__getitem__(ns, "S"))
