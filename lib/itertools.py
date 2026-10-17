"""itertools, following the pure-Python equivalents in CPython's docs, with
CPython's own behaviour where they differ: the iterators that go on after an
exception from their source (cycle, accumulate, chain, compress, dropwhile,
takewhile, filterfalse, starmap, tee) are objects whose state survives it;
the others end, as generators do."""


def count(start=0, step=1):
    # (a bool start counts from its int, as Python's: count(False) is 0, 1, ...)
    n = int(start) if type(start) is bool else start
    while True:
        yield n
        n += step


import operator as _operator

_NULL = object()


def _index(x, msg):
    # (as CPython's islice: any failure of the index protocol, a result out
    # of 0..sys.maxsize included, is this ValueError)
    if x is None:
        return None
    try:
        v = _operator.index(x)
    except Exception:
        raise ValueError(msg) from None
    if v < 0 or v > 9223372036854775807:
        raise ValueError(msg)
    return v


# The iterators over a source are objects, as CPython's: an exception from
# the source (or a function) reaches the caller and leaves the iterator as it
# was, so a caller that handles it can go on; only the end of the source ends
# them.


class cycle:
    def __init__(self, iterable):
        self._it = iter(iterable)
        self._saved = []
        self._index = 0

    def __iter__(self):
        return self

    def __next__(self):
        if self._it is not None:
            try:
                item = next(self._it)
            except StopIteration:
                self._it = None
            else:
                self._saved.append(item)
                return item
        if not self._saved:
            raise StopIteration
        item = self._saved[self._index]
        self._index = (self._index + 1) % len(self._saved)
        return item


class accumulate:
    def __init__(self, iterable, func=None, *, initial=None):
        self._it = iter(iterable)
        self._func = func
        self._total = _NULL
        self._initial = initial

    def __iter__(self):
        return self

    def __next__(self):
        if self._initial is not None:
            self._total, self._initial = self._initial, None
            return self._total
        value = next(self._it)
        if self._total is _NULL:
            self._total = value
        elif self._func is None:
            self._total = self._total + value
        else:
            self._total = self._func(self._total, value)
        return self._total


class chain:
    def __init__(self, *iterables):
        self._source = iter(iterables)
        self._active = None

    @classmethod
    def from_iterable(cls, iterables):
        c = cls()
        c._source = iter(iterables)
        return c

    def __iter__(self):
        return self

    def __next__(self):
        while self._source is not None:
            if self._active is None:
                # (an exception while getting the next iterable, or its
                # iterator, ends the chain, as CPython's; one from the
                # active iterator does not)
                try:
                    self._active = iter(next(self._source))
                except BaseException:
                    self._source = None
                    raise
            try:
                return next(self._active)
            except StopIteration:
                self._active = None
        raise StopIteration


class compress:
    def __init__(self, data, selectors):
        self._data = iter(data)
        self._selectors = iter(selectors)

    def __iter__(self):
        return self

    def __next__(self):
        while True:
            datum = next(self._data)
            if next(self._selectors):
                return datum


class dropwhile:
    def __init__(self, predicate, iterable):
        self._predicate = predicate
        self._it = iter(iterable)
        self._dropping = True

    def __iter__(self):
        return self

    def __next__(self):
        while True:
            item = next(self._it)
            if not self._dropping or not self._predicate(item):
                self._dropping = False
                return item


class takewhile:
    def __init__(self, predicate, iterable):
        self._predicate = predicate
        self._it = iter(iterable)
        self._stopped = False

    def __iter__(self):
        return self

    def __next__(self):
        if self._stopped:
            raise StopIteration
        item = next(self._it)
        if self._predicate(item):
            return item
        self._stopped = True
        raise StopIteration


class filterfalse:
    def __init__(self, predicate, iterable):
        self._predicate = predicate
        self._it = iter(iterable)

    def __iter__(self):
        return self

    def __next__(self):
        while True:
            item = next(self._it)
            if not (item if self._predicate is None else self._predicate(item)):
                return item


def groupby(iterable, key=None):
    # (keys compare by identity, then ==, as CPython's PyObject_RichCompareBool:
    # a shared NaN is one group)
    keyfunc = (lambda x: x) if key is None else key
    it = iter(iterable)
    exhausted = False
    try:
        curr_value = next(it)
    except StopIteration:
        return
    curr_key = keyfunc(curr_value)

    def grouper(target_key):
        nonlocal curr_value, curr_key, exhausted
        yield curr_value
        for curr_value in it:
            curr_key = keyfunc(curr_value)
            if not (target_key is curr_key or target_key == curr_key):
                return
            yield curr_value
        exhausted = True

    while not exhausted:
        target_key = curr_key
        curr_group = grouper(target_key)
        yield curr_key, curr_group
        if target_key is curr_key or target_key == curr_key:
            for _ in curr_group:
                pass


def islice(iterable, *args):
    # (the source is read up to max(start, stop) whatever the step, as
    # CPython's: past the last item taken, the skipped ones are read too; any
    # exception from it ends the islice, as a generator's does)
    if not args:
        raise TypeError("islice expected at least 2 arguments, got 1")
    if len(args) > 3:
        raise TypeError("islice expected at most 4 arguments, got %d" % (len(args) + 1))
    start, step = 0, 1
    if len(args) == 1:
        stop = args[0]
    else:
        start, stop = args[0], args[1]
        if len(args) == 3:
            step = args[2]
    stop = _index(stop, "Stop argument for islice() must be None or an integer: 0 <= x <= sys.maxsize.")
    start = _index(start, "Indices for islice() must be None or an integer: 0 <= x <= sys.maxsize.")
    if step is not None:
        try:
            step = _operator.index(step)
        except Exception:
            step = 0
        if step < 1 or step > 9223372036854775807:
            raise ValueError("Step for islice() must be a positive integer or None.")
    return _islice(iter(iterable), 0 if start is None else start, stop, 1 if step is None else step)


def _islice(it, nexti, stop, step):
    i = 0
    while True:
        try:
            while i < nexti:
                next(it)
                i += 1
            if stop is not None and i >= stop:
                return
            item = next(it)
        except StopIteration:
            return
        i += 1
        yield item
        nexti += step
        if stop is not None and nexti > stop:
            nexti = stop


class starmap:
    def __init__(self, function, iterable):
        self._function = function
        self._it = iter(iterable)

    def __iter__(self):
        return self

    def __next__(self):
        return self._function(*next(self._it))


class _tee_link:
    __slots__ = ("value", "next")

    def __init__(self, value):
        self.value = value
        self.next = None


class _tee:
    # (the tees of one source share a linked list of the values read, so a
    # value is read from the source once, and is freed once every tee has it)
    def __init__(self, it, link):
        self._source = it
        self._link = link

    def __iter__(self):
        return self

    def __next__(self):
        link = self._link.next
        if link is None:
            link = _tee_link(next(self._source[0]))
            self._link.next = link
        self._link = link
        return link.value

    def __copy__(self):
        return _tee(self._source, self._link)


def tee(iterable, n=2):
    import sys
    if not isinstance(n, int):
        if not hasattr(type(n), "__index__"):
            raise TypeError("'%s' object cannot be interpreted as an integer" % type(n).__name__)
        n = n.__index__()
    if n < 0:
        raise ValueError("n must be >= 0")
    if n > sys.maxsize:
        raise OverflowError("Python int too large to convert to C ssize_t")
    # (n copies are n objects: past what the heap holds, a MemoryError, never
    # the heap running out)
    if n * 256 > getattr(sys, "_sagebrush_heap_limit", 1 << 30) // 4:
        raise MemoryError("tee: %d copies are more than this heap holds" % n)
    if n == 0:
        return ()
    it = iter(iterable)
    first = it if type(it) is _tee else _tee([it], _tee_link(None))
    return (first,) + tuple(first.__copy__() for _ in range(n - 1))


def zip_longest(*args, fillvalue=None):
    iterators = [iter(it) for it in args]
    num_active = len(iterators)
    if not num_active:
        return
    while True:
        values = []
        for i, it in enumerate(iterators):
            try:
                value = next(it)
            except StopIteration:
                num_active -= 1
                if not num_active:
                    return
                iterators[i] = repeat(fillvalue)
                value = fillvalue
            values.append(value)
        yield tuple(values)


# (product, permutations and the combinations read their input when called,
# as CPython's)
def _ssize(x):
    # (an argument CPython takes as a Py_ssize_t: an index, in its range)
    x = _operator.index(x)
    if not -9223372036854775808 <= x <= 9223372036854775807:
        raise OverflowError("Python int too large to convert to C ssize_t")
    return x


class repeat:
    """repeat(object [,times]) -> create an iterator which returns the object
for the specified number of times.  If not specified, returns the object
endlessly."""

    # (as CPython's: times a Py_ssize_t, given or not (None is no count:
    # a TypeError), a negative one none; its repr shows what is left)
    __slots__ = ("_obj", "_cnt")

    def __new__(cls, object, times=_NULL):
        self = super().__new__(cls)
        self._obj = object
        if times is _NULL:
            self._cnt = -1
        else:
            n = _ssize(times)
            self._cnt = n if n > 0 else 0
        return self

    def __iter__(self):
        return self

    def __next__(self):
        if self._cnt == 0:
            raise StopIteration
        if self._cnt > 0:
            self._cnt -= 1
        return self._obj

    def __repr__(self):
        if self._cnt == -1:
            return "%s(%r)" % (type(self).__name__, self._obj)
        return "%s(%r, %d)" % (type(self).__name__, self._obj, self._cnt)

    def __length_hint__(self):
        if self._cnt == -1:
            raise TypeError("len() of unsized object")
        return self._cnt


def product(*args, repeat=1):
    # (repeat is a Py_ssize_t, as CPython's: an index, converted before
    # anything is read; then 0 reads nothing)
    repeat = _ssize(repeat)
    if repeat < 0:
        raise ValueError("repeat argument cannot be negative")
    return _product([tuple(pool) for pool in args] * repeat if repeat != 0 else [])


def _product(pools):
    result = [[]]
    for pool in pools:
        result = [x + [y] for x in result for y in pool]
    for prod in result:
        yield tuple(prod)


def permutations(iterable, r=None):
    pool = tuple(iterable)
    if r is not None:
        # (an int itself, not an index, as CPython's)
        if not isinstance(r, int):
            raise TypeError("Expected int as r")
        r = _ssize(int.__index__(r))
    if r is not None and r < 0:
        raise ValueError("r must be non-negative")
    return _permutations(pool, len(pool) if r is None else r)


def _permutations(pool, r):
    n = len(pool)
    if r > n:
        return
    indices = list(range(n))
    cycles = list(range(n, n - r, -1))
    yield tuple(pool[i] for i in indices[:r])
    while n:
        for i in reversed(range(r)):
            cycles[i] -= 1
            if cycles[i] == 0:
                indices[i:] = indices[i + 1 :] + indices[i : i + 1]
                cycles[i] = n - i
            else:
                j = cycles[i]
                indices[i], indices[-j] = indices[-j], indices[i]
                yield tuple(pool[i] for i in indices[:r])
                break
        else:
            return


def combinations(iterable, r):
    # (r is converted before the pool is read, as CPython's arguments are;
    # its sign is checked after, CORR-DBB-1)
    r = _ssize(r)
    pool = tuple(iterable)
    if r < 0:
        raise ValueError("r must be non-negative")
    return _combinations(pool, r)


def _combinations(pool, r):
    n = len(pool)
    if r > n:
        return
    indices = list(range(r))
    yield tuple(pool[i] for i in indices)
    while True:
        for i in reversed(range(r)):
            if indices[i] != i + n - r:
                break
        else:
            return
        indices[i] += 1
        for j in range(i + 1, r):
            indices[j] = indices[j - 1] + 1
        yield tuple(pool[i] for i in indices)


def combinations_with_replacement(iterable, r):
    # (r is converted before the pool is read, as CPython's arguments are;
    # its sign is checked after, CORR-DBB-1)
    r = _ssize(r)
    pool = tuple(iterable)
    if r < 0:
        raise ValueError("r must be non-negative")
    return _combinations_with_replacement(pool, r)


def _combinations_with_replacement(pool, r):
    n = len(pool)
    if not n and r:
        return
    indices = [0] * r
    yield tuple(pool[i] for i in indices)
    while True:
        for i in reversed(range(r)):
            if indices[i] != n - 1:
                break
        else:
            return
        indices[i:] = [indices[i] + 1] * (r - i)
        yield tuple(pool[i] for i in indices)


def pairwise(iterable):
    it = iter(iterable)
    try:
        a = next(it)
    except StopIteration:
        return
    for b in it:
        yield a, b
        a = b


def batched(iterable, n, *, strict=False):
    n = _ssize(n)
    if n < 1:
        raise ValueError("n must be at least one")
    return _batched(iter(iterable), n, strict)


def _batched(it, n, strict):
    while True:
        batch = tuple(islice(it, n))
        if not batch:
            return
        if strict and len(batch) != n:
            raise ValueError("batched(): incomplete batch")
        yield batch
