# reversed() as CPython 3.14's reversed_next and reversed_len: a list cleared or
# shortened under the iterator, a getter's IndexError, StopIteration or other
# error, a getter calling next on its own iterator, __length_hint__;
# compared line by line with CPython (test/reversed.test.ts)
def show(f):
    try:
        return repr(f())
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)


def run(label, it, n=6):
    out = []
    for _ in range(n):
        try:
            out.append(repr(next(it)))
        except StopIteration:
            out.append('stop')
        except Exception as e:
            out.append(type(e).__name__)
    print(label, out)


xs = [1, 2, 3]; it = reversed(xs); next(it); xs.clear(); run('cleared', it)
xs = [1, 2, 3, 4]; it = reversed(xs); next(it); del xs[1:]; run('shrunk', it)
xs = [1, 2, 3]; it = reversed(xs); xs.clear(); run('cleared at once', it); xs.extend([7, 8, 9]); run('regrown after stop', it)
xs = [1, 2]; it = reversed(xs); next(it); next(it); xs.append(5); run('appended', it)
xs = [1, 2, 3]; it = reversed(xs); next(it); xs.clear(); xs.extend([4, 5, 6, 7]); run('refilled', it)


class S:
    def __init__(self, n, bad=None, exc=IndexError):
        self.n, self.bad, self.exc, self.calls = n, bad, exc, []

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        self.calls.append(i)
        if i == self.bad:
            raise self.exc('at %d' % i)
        return i * 10


s = S(4, bad=2); it = reversed(s); run('getitem IndexError', it); print(s.calls)
s = S(4, bad=2, exc=StopIteration); it = reversed(s); run('getitem StopIteration', it); print(s.calls)
s = S(4, bad=2, exc=KeyError); it = reversed(s); run('getitem KeyError', it); print(s.calls)
s = S(4, bad=2, exc=ValueError); it = reversed(s); run('getitem ValueError', it, 3); s.bad = None; run('then fine', it); print(s.calls)


class Reentrant:
    def __len__(self):
        return 4

    def __getitem__(self, i):
        if i == 3 and not hasattr(self, 'inner'):
            self.inner = next(self.it)
        return i


r = Reentrant(); r.it = reversed(r); run('reentrant', r.it); print(getattr(r, 'inner', 'no inner'))
it = reversed([1, 2, 3]); print(it.__length_hint__(), next(it), it.__length_hint__())
xs = [1, 2, 3]; it = reversed(xs); next(it); xs.clear(); print(show(lambda: it.__length_hint__()), show(lambda: next(it)), show(lambda: it.__length_hint__()))
it = reversed(range(3)); print(list(it))
it = reversed('ab\U0001f600'); print(list(it))


# A getter that succeeds after a nested next(): the outer read moves on one
# from the index it started at (CPython: [3, 2, 1, 0], each index read twice)
class Nested:
    busy = False
    def __init__(self):
        self.reads = []
    def __len__(self):
        return 4
    def __getitem__(self, i):
        self.reads.append(i)
        if not self.busy:
            self.busy = True
            next(self.it)
            self.busy = False
        return i


r = Nested(); r.it = reversed(r); print('nested getter', list(r.it), r.reads)


# __length_hint__: 0 once at the end, without asking the sequence's length;
# the index taken before the length hook (which may advance the iterator)
class Len:
    bad = False
    def __init__(self, n):
        self.n = n
        self.lens = 0
    def __len__(self):
        self.lens += 1
        if self.bad:
            raise ValueError('length after end')
        return self.n
    def __getitem__(self, i):
        return i


s = Len(1); it = reversed(s); next(it); s.bad = True; print('hint after last read', show(lambda: it.__length_hint__()))
s = Len(0); it = reversed(s); s.bad = True; print('hint of empty', show(lambda: it.__length_hint__()))
s = Len(3); it = reversed(s); s.bad = True; print('hint, length error', show(lambda: it.__length_hint__()), show(lambda: next(it)))


class Advancing(Len):
    def __len__(self):
        self.lens += 1
        if self.lens == 2:
            next(self.it)
        return self.n


s = Advancing(4); s.it = reversed(s)
# (a comprehension, which asks no length hint: list() asks one, and Sagebrush's
# list() does not yet; a separate fix)
print('reentrant length', s.it.__length_hint__(), s.it.__length_hint__(), [x for x in s.it], s.it.__length_hint__(), s.lens)


# A list subclass's reverse iterator measures the list's storage, not __len__
class L(list):
    def __len__(self):
        raise ValueError('subclass length hook')


it = reversed(L([1, 2, 3])); print('list subclass hint', show(lambda: it.__length_hint__()), list(it), show(lambda: it.__length_hint__()))


# A reversed subclass's instances take ordinary attribute names, size among
# them (the runtime's own fields are not Python attributes)
class R(reversed):
    pass


for src in [(1, 2, 3), 'xyz']:
    r = R(src)
    r.size = 'user size'; r.index = 'user index'; r.seq = 'user seq'
    print('subclass attributes', type(src).__name__, r.size, r.index, r.seq, r.__length_hint__(), list(r), r.__length_hint__())
