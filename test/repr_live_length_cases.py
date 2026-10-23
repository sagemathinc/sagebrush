# repr of a list (and a dict) that an element's __repr__ changes while it is
# shown: CPython's list repr goes by index, to the list's length at each
# step. Run by test/repr-live-length.test.ts, under CPython and Sagebrush;
# the outputs must be the same. Each __repr__ also counts its calls.


class M:
    calls = 0

    def __init__(self, action, s="Q"):
        self.action = action
        self.s = s

    def __repr__(self):
        M.calls += 1
        self.action()
        return self.s


def show(label, build):
    M.calls = 0
    v = build()
    try:
        r = repr(v)
    except Exception as e:
        r = "%s: %s" % (type(e).__name__, e)
    print(label, r, M.calls)


def cleared():
    V = []
    V.append(M(V.clear))
    V.append(1)
    return V


def grows_once():
    V = []
    V.append(M(lambda: V.append(7)))
    V.append(1)
    return V


def grows_three():
    V = []
    def act():
        if len(V) < 5:
            V.append(M(act, "m"))
    V.append(M(act))
    return V


def pops_last():
    V = [0, 0, 0]
    V[0] = M(V.pop)
    return V


def pops_self():
    V = [0, 1, 2]
    V[0] = M(lambda: V.pop(0))
    return V


def replaces_next():
    V = [0, 1]
    V[0] = M(lambda: V.__setitem__(1, 7))
    return V


def inserts_front_once():
    V = [1, 2]
    V.insert(0, M(lambda: V.insert(0, 9) if len(V) < 4 else None))
    return V


def nested_cleared():
    W = [1, 2]
    return [M(W.clear), W]


def nested_grows():
    W = [1]
    return [M(lambda: W.append(2)), W]


def in_tuple():
    W = [1, 2]
    return (M(W.clear), W)


def holds_itself():
    V = [1]
    V.append(M(lambda: V.append(V)))
    return V


def extends():
    V = [1, 2]
    V.insert(0, M(lambda: V.extend([3, 4])))
    return V


def dict_pops_current():
    D = {1: 0, 2: 2, 3: 3}
    D[1] = M(lambda: D.pop(1))
    return D


def dict_adds():
    D = {}
    D[1] = M(lambda: D.__setitem__(9, 9))
    D[2] = 3
    return D


def dict_pops_next():
    D = {}
    D[1] = M(lambda: D.pop(2))
    D[2] = 3
    D[4] = 5
    return D


def dict_replaces_value():
    D = {}
    D[1] = M(lambda: D.__setitem__(2, "new"))
    D[2] = 3
    return D


def dict_clears():
    D = {}
    D[1] = M(D.clear)
    D[2] = 3
    return D


for name, f in list(globals().items()):
    if callable(f) and getattr(f, "__module__", None) == __name__ and name not in ("show", "M"):
        show(name, f)
