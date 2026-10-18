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
