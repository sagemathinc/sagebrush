"""collections for the pyjs runtime: deque, namedtuple, OrderedDict,
defaultdict, Counter, ChainMap, UserDict, UserList, UserString."""

import sys as _sys
import _collections_abc
_GenericAlias = _collections_abc.GenericAlias

# (as CPython's: collections.abc is _collections_abc)
_sys.modules["collections.abc"] = _collections_abc
abc = _collections_abc

__all__ = ["ChainMap", "Counter", "OrderedDict", "UserDict", "UserList",
           "UserString", "defaultdict", "deque", "namedtuple"]


# ---------------------------------------------------------------- deque

from operator import index as _index


def _ssize(x):
    # (an argument CPython takes as a Py_ssize_t: an index, in its range,
    # CORR-72B-4)
    x = _index(x)
    if not -9223372036854775808 <= x <= 9223372036854775807:
        raise OverflowError("Python int too large to convert to C ssize_t")
    return x


_mro = type.__dict__["__mro__"].__get__
_tdict = type.__dict__["__dict__"].__get__


def _slice_index(v):
    # (an index bound as CPython's _PyEval_SliceIndexNotNone: __index__ in
    # the type's own slots, read from the classes' dicts, no metaclass
    # __getattribute__ or __getattr__ run)
    if not any("__index__" in _tdict(c) for c in _mro(type(v))):
        raise TypeError("slice indices must be integers or have an __index__ method")
    return _index(v)


def _dlen(d):
    # (a deque's own length, never a subclass's __len__, as CPython's)
    return len(d._l) + len(d._r)


_deque_iterators_sealed = False


class _deque_iterator:
    # (as CPython's dequeiter: the deque's mutation count when it was made,
    # a change of it a RuntimeError; reading by position, so reverse() and
    # item assignment, which change no count, are seen: astra3 A28)
    __slots__ = ("_d", "_i", "_n", "_state", "_step")

    def __new__(cls, *args, **kwargs):
        # (as CPython's dequeiter_new: a deque, and how many of its items
        # are taken already, CORR-28A-4; by position only, keywords
        # ignored, as its PyArg_ParseTuple, CORR-B3F-1)
        if not args:
            raise TypeError("function takes at least 1 argument (0 given)")
        if len(args) > 2:
            raise TypeError("function takes at most 2 arguments (%d given)" % len(args))
        d = args[0]
        index = args[1] if len(args) > 1 else 0
        if not isinstance(d, deque):
            raise TypeError("argument 1 must be collections.deque, not %s" % type(d).__name__)
        index = _ssize(index)
        it = cls._make(d)
        for _ in range(min(index, it._n)):
            next(it)
        return it

    def __init_subclass__(cls, **kwargs):
        # (CPython's iterator types are no base types)
        if _deque_iterators_sealed:
            raise TypeError("type 'collections.%s' is not an acceptable base type" % cls.__mro__[1].__name__)
        super().__init_subclass__(**kwargs)

    @classmethod
    def _make(cls, d):
        it = object.__new__(cls)
        it._d = d
        it._n = _dlen(d)
        reverse = cls is _deque_reverse_iterator
        it._i = it._n - 1 if reverse else 0
        it._step = -1 if reverse else 1
        it._state = d._state
        return it

    def __iter__(self):
        return self

    def __next__(self):
        d = self._d
        # (the reverse one ends once its count is out, the error raised once;
        # the forward one checks the deque first, every time, as CPython's)
        if self._n == 0 and self._step < 0:
            raise StopIteration
        if d._state != self._state:
            self._n = 0
            raise RuntimeError("deque mutated during iteration")
        if self._n == 0:
            raise StopIteration
        i = self._i
        self._i = i + self._step
        self._n -= 1
        return d._get(i)

    def __length_hint__(self):
        return self._n


_deque_iterator.__module__ = "collections"


class _deque_reverse_iterator(_deque_iterator):
    __slots__ = ()


_deque_reverse_iterator.__module__ = "collections"
_deque_iterators_sealed = True


def _same(item, x):
    # (CPython's PyObject_RichCompareBool: identity first)
    return item is x or bool(item == x)


class deque:
    """Two stacks: _l holds the left part reversed, _r the right part, so
    both ends and indexing are O(1) (amortized). _state counts the
    mutations CPython's deque counts (its deque->state), for the
    iterators."""

    __slots__ = ("_l", "_r", "_maxlen", "_state")

    def __init__(self, iterable=(), maxlen=None):
        if maxlen is not None:
            if not isinstance(maxlen, int):
                raise TypeError("an integer is required")
            if maxlen < 0:
                raise ValueError("maxlen must be non-negative")
        # (as CPython's deque_init: a new deque's count starts at 0; a deque
        # made again is cleared, which counts, then extended, CORR-28A-2)
        # (whether its storage exists, read past any subclass __getattr__,
        # CORR-B3F-2)
        try:
            object.__getattribute__(self, "_state")
        except AttributeError:
            self._l = []
            self._r = []
            self._state = 0
        else:
            deque.clear(self)
        self._maxlen = maxlen
        deque.extend(self, iterable)

    @property
    def maxlen(self):
        return self._maxlen

    def __len__(self):
        return len(self._l) + len(self._r)

    def __bool__(self):
        return bool(self._l) or bool(self._r)

    def _items(self):
        return self._l[::-1] + self._r

    def _set(self, items):
        self._l = []
        self._r = items
        self._state += 1

    def _get(self, i):
        nl = len(self._l)
        return self._l[nl - 1 - i] if i < nl else self._r[i - nl]

    def __iter__(self):
        return _deque_iterator._make(self)

    def __reversed__(self):
        return _deque_reverse_iterator._make(self)

    def __repr__(self):
        if self._maxlen is None:
            return "deque(%r)" % (self._items(),)
        return "deque(%r, maxlen=%d)" % (self._items(), self._maxlen)

    def __eq__(self, other):
        if not isinstance(other, deque):
            return NotImplemented
        return self._items() == other._items()

    def __lt__(self, other):
        if not isinstance(other, deque):
            return NotImplemented
        return self._items() < other._items()

    def __le__(self, other):
        if not isinstance(other, deque):
            return NotImplemented
        return self._items() <= other._items()

    def __gt__(self, other):
        if not isinstance(other, deque):
            return NotImplemented
        return self._items() > other._items()

    def __ge__(self, other):
        if not isinstance(other, deque):
            return NotImplemented
        return self._items() >= other._items()

    __hash__ = None

    # (count, in, index and remove walk the deque as it is, compare with
    # identity first, and stop on a mutation by a comparison, as CPython's:
    # a RuntimeError, but an IndexError for remove, astra3 A31)
    def __contains__(self, x):
        n, state = _dlen(self), self._state
        for i in range(n):
            if _same(self._get(i), x):
                return True
            if self._state != state:
                raise RuntimeError("deque mutated during iteration")
        return False

    def _index(self, i):
        if not isinstance(i, int):
            raise TypeError("sequence index must be integer, not '%s'" % type(i).__name__)
        n = _dlen(self)
        if i < 0:
            i += n
        if i < 0 or i >= n:
            raise IndexError("deque index out of range")
        return i

    def __getitem__(self, i):
        return self._get(deque._index(self, i))

    def __setitem__(self, i, v):
        i = deque._index(self, i)
        nl = len(self._l)
        if i < nl:
            self._l[nl - 1 - i] = v
        else:
            self._r[i - nl] = v

    def __delitem__(self, i):
        i = deque._index(self, i)
        items = self._items()
        del items[i]
        self._set(items)

    def append(self, x):
        self._r.append(x)
        self._state += 1
        if self._maxlen is not None and _dlen(self) > self._maxlen:
            deque.popleft(self)

    def appendleft(self, x):
        self._l.append(x)
        self._state += 1
        if self._maxlen is not None and _dlen(self) > self._maxlen:
            deque.pop(self)

    def pop(self):
        if not self._r:
            if not self._l:
                raise IndexError("pop from an empty deque")
            k = (len(self._l) + 1) // 2
            self._r = self._l[:k][::-1]
            self._l = self._l[k:]
        self._state += 1
        return self._r.pop()

    def popleft(self):
        if not self._l:
            if not self._r:
                raise IndexError("pop from an empty deque")
            k = (len(self._r) + 1) // 2
            self._l = self._r[:k][::-1]
            self._r = self._r[k:]
        self._state += 1
        return self._l.pop()

    def extend(self, iterable):
        if iterable is self:
            iterable = list(iterable)
        # (a deque of maxlen 0 takes nothing, and is not changed, as CPython's)
        if self._maxlen == 0:
            for x in iterable:
                pass
            return
        for x in iterable:
            deque.append(self, x)

    def extendleft(self, iterable):
        if iterable is self:
            iterable = list(iterable)
        if self._maxlen == 0:
            for x in iterable:
                pass
            return
        for x in iterable:
            deque.appendleft(self, x)

    def clear(self):
        if self._l or self._r:
            self._state += 1
        self._l = []
        self._r = []

    def copy(self):
        return deque(self, self._maxlen)

    __copy__ = copy

    def count(self, x):
        n, state, k = _dlen(self), self._state, 0
        for i in range(n):
            k += _same(self._get(i), x)
            if self._state != state:
                raise RuntimeError("deque mutated during iteration")
        return k

    def index(self, x, start=0, stop=_sys.maxsize):
        # (start and stop as CPython's: slice indices, through __index__)
        start, stop = _slice_index(start), _slice_index(stop)
        n, state = _dlen(self), self._state
        if start < 0:
            start = max(start + n, 0)
        if stop < 0:
            stop = max(stop + n, 0)
        stop = min(stop, n)
        for i in range(start, stop):
            if _same(self._get(i), x):
                return i
            if self._state != state:
                raise RuntimeError("deque mutated during iteration")
        raise ValueError("deque.index(x): x not in deque")

    def insert(self, i, x):
        # (the index converted first, then the size checked, as CPython's)
        i = _ssize(i)
        if self._maxlen is not None and _dlen(self) >= self._maxlen:
            raise IndexError("deque already at its maximum size")
        items = self._items()
        items.insert(i, x)
        self._set(items)

    def remove(self, x):
        n, state = _dlen(self), self._state
        for i in range(n):
            found = _same(self._get(i), x)
            if self._state != state:
                raise IndexError("deque mutated during iteration")
            if found:
                deque.__delitem__(self, i)
                return
        raise ValueError("deque.remove(x): x not in deque")

    def reverse(self):
        # (no mutation count: an iterator goes on, reading the items reversed)
        self._l, self._r = self._r, self._l

    def rotate(self, n=1):
        n = _ssize(n)
        k = _dlen(self)
        if k <= 1:
            return
        # (a count even for rotate(0), as CPython's _deque_rotate)
        n %= k
        if n:
            items = self._items()
            self._set(items[-n:] + items[:-n])
        else:
            self._state += 1

    def __add__(self, other):
        if not isinstance(other, deque):
            raise TypeError('can only concatenate deque (not "%s") to deque' % type(other).__name__)
        d = deque.copy(self)
        d.extend(other)
        return d

    def __iadd__(self, other):
        deque.extend(self, other)
        return self

    def __mul__(self, n):
        d = deque((), self._maxlen)
        d.extend(self._items() * n)
        return d

    __rmul__ = __mul__

    def __imul__(self, n):
        items = self._items() * n
        # (an empty deque, or a repeat by 1, is not changed, as CPython's)
        if len(items) == _dlen(self):
            return self
        deque.clear(self)
        deque.extend(self, items)
        return self

    __class_getitem__ = classmethod(_GenericAlias)


# ---------------------------------------------------------------- namedtuple

def namedtuple(typename, field_names, *, rename=False, defaults=None, module=None):
    if isinstance(field_names, str):
        field_names = field_names.replace(",", " ").split()
    field_names = list(map(str, field_names))
    typename = _sys.intern(str(typename)) if hasattr(_sys, "intern") else str(typename)
    if rename:
        seen = set()
        for i, name in enumerate(field_names):
            if (not name.isidentifier() or _iskeyword(name) or name.startswith("_") or name in seen):
                field_names[i] = "_%d" % i
            seen.add(name)
    for name in [typename] + field_names:
        if type(name) is not str:
            raise TypeError("Type names and field names must be strings")
        if not name.isidentifier():
            raise ValueError("Type names and field names must be valid identifiers: %r" % name)
        if _iskeyword(name):
            raise ValueError("Type names and field names cannot be a keyword: %r" % name)
    seen = set()
    for name in field_names:
        if name.startswith("_") and not rename:
            raise ValueError("Field names cannot start with an underscore: %r" % name)
        if name in seen:
            raise ValueError("Encountered duplicate field name: %r" % name)
        seen.add(name)
    fields = tuple(field_names)
    nf = len(fields)
    field_defaults = {}
    if defaults is not None:
        defaults = tuple(defaults)
        if len(defaults) > nf:
            raise TypeError("Got more default values than field names")
        field_defaults = dict(zip(fields[nf - len(defaults):], defaults))

    def __new__(cls, *args, **kwargs):
        if len(args) > nf:
            raise TypeError("%s.__new__() takes %d positional arguments but %d were given" % (typename, nf + 1, len(args) + 1))
        values = list(args)
        for name in fields[len(args):]:
            if name in kwargs:
                values.append(kwargs.pop(name))
            elif name in field_defaults:
                values.append(field_defaults[name])
            else:
                missing = [n for n in fields[len(values):] if n not in kwargs and n not in field_defaults]
                raise TypeError("%s.__new__() missing %d required positional argument%s: %s" % (
                    typename, len(missing), "" if len(missing) == 1 else "s", ", ".join(repr(m) for m in missing)))
        if kwargs:
            k = next(iter(kwargs))
            if k in fields:
                raise TypeError("%s.__new__() got multiple values for argument %r" % (typename, k))
            raise TypeError("%s.__new__() got an unexpected keyword argument %r" % (typename, k))
        return tuple.__new__(cls, values)

    def _make(cls, iterable):
        result = tuple.__new__(cls, iterable)
        if len(result) != nf:
            raise TypeError("Expected %d arguments, got %d" % (nf, len(result)))
        return result

    def _replace(self, **kwargs):
        result = self._make([kwargs.pop(name, v) for name, v in zip(fields, self)])
        if kwargs:
            raise TypeError("Got unexpected field names: %r" % list(kwargs))
        return result

    def __repr__(self):
        return "%s(%s)" % (self.__class__.__name__, ", ".join("%s=%r" % (n, v) for n, v in zip(fields, self)))

    def _asdict(self):
        return dict(zip(fields, self))

    def __getnewargs__(self):
        return tuple(self)

    ns = {
        "__doc__": "%s(%s)" % (typename, ", ".join(fields)),
        "__slots__": (),
        "_fields": fields,
        "_field_defaults": field_defaults,
        "__new__": __new__,
        "_make": classmethod(_make),
        "_replace": _replace,
        "__repr__": __repr__,
        "_asdict": _asdict,
        "__getnewargs__": __getnewargs__,
        "__match_args__": fields,
    }
    for i, name in enumerate(fields):
        ns[name] = _field(i, name)
    result = type(typename, (tuple,), ns)
    if module is None:
        try:
            module = _sys._getframe(1).f_globals.get("__name__", "__main__")
        except (AttributeError, ValueError):
            module = None
    if module is not None:
        result.__module__ = module
    return result


def _field(i, name):
    def get(self):
        return self[i]
    return property(get, doc="Alias for field number %d" % i)


_KEYWORDS = frozenset("""False None True and as assert async await break class continue
def del elif else except finally for from global if import in is lambda nonlocal not
or pass raise return try while with yield""".split())


def _iskeyword(s):
    return s in _KEYWORDS


# ---------------------------------------------------------------- dicts

# (as CPython's: a deque is a MutableSequence)
_collections_abc.MutableSequence.register(deque)


class OrderedDict(dict):
    def __repr__(self):
        if not self:
            return "%s()" % (self.__class__.__name__,)
        return "%s(%r)" % (self.__class__.__name__, dict(self.items()))

    def popitem(self, last=True):
        if not self:
            raise KeyError("dictionary is empty")
        key = next(reversed(self)) if last else next(iter(self))
        value = dict.pop(self, key)
        return key, value

    def move_to_end(self, key, last=True):
        value = dict.pop(self, key)
        if last:
            dict.__setitem__(self, key, value)
        else:
            items = list(self.items())
            dict.clear(self)
            dict.__setitem__(self, key, value)
            for k, v in items:
                dict.__setitem__(self, k, v)

    def __eq__(self, other):
        if isinstance(other, OrderedDict):
            return dict.__eq__(self, other) and list(self) == list(other)
        return dict.__eq__(self, other)

    def __ne__(self, other):
        return not self == other

    __hash__ = None

    def copy(self):
        return self.__class__(self)

    @classmethod
    def fromkeys(cls, iterable, value=None):
        d = cls()
        for k in iterable:
            d[k] = value
        return d

    def __or__(self, other):
        if not isinstance(other, dict):
            return NotImplemented
        new = self.__class__(self)
        new.update(other)
        return new

    def __ror__(self, other):
        if not isinstance(other, dict):
            return NotImplemented
        new = self.__class__(other)
        new.update(self)
        return new


class defaultdict(dict):
    def __init__(self, default_factory=None, *args, **kwargs):
        if default_factory is not None and not callable(default_factory):
            raise TypeError("first argument must be callable or None")
        dict.__init__(self, *args, **kwargs)
        self.default_factory = default_factory

    def __missing__(self, key):
        if self.default_factory is None:
            raise KeyError(key)
        self[key] = value = self.default_factory()
        return value

    def __repr__(self):
        f = self.default_factory
        fr = "None" if f is None else getattr(f, "__qualname__", None) and repr(f) or repr(f)
        return "%s(%s, %s)" % (self.__class__.__name__, fr, dict.__repr__(self))

    def copy(self):
        return self.__class__(self.default_factory, self)

    __copy__ = copy

    def __or__(self, other):
        if not isinstance(other, dict):
            return NotImplemented
        new = self.copy()
        new.update(other)
        return new


# Counter: CPython 3.14's (Lib/collections/__init__.py, with its pure-Python
# _count_elements; PSF License, see cdn/LICENSE-CPython.txt and NOTICE.md)
from itertools import chain as _chain
from itertools import repeat as _repeat
from itertools import starmap as _starmap
from operator import eq as _eq
from operator import itemgetter as _itemgetter
from reprlib import recursive_repr as _recursive_repr

heapq = None    # Counter.most_common's lazy import, as CPython's


def _count_elements(mapping, iterable):
    'Tally elements from the iterable.'
    mapping_get = mapping.get
    for elem in iterable:
        mapping[elem] = mapping_get(elem, 0) + 1

try:                                    # Load C helper function if available
    from _collections import _count_elements
except ImportError:
    pass

class Counter(dict):
    '''Dict subclass for counting hashable items.  Sometimes called a bag
    or multiset.  Elements are stored as dictionary keys and their counts
    are stored as dictionary values.

    When constructed from a Mapping or Counter, the original object's
    values will be used as the initial counts.

    >>> c = Counter('abcdeabcdabcaba')  # count elements from a string

    >>> c.most_common(3)                # three most common elements
    [('a', 5), ('b', 4), ('c', 3)]
    >>> sorted(c)                       # list all unique elements
    ['a', 'b', 'c', 'd', 'e']
    >>> ''.join(sorted(c.elements()))   # list elements with repetitions
    'aaaaabbbbcccdde'
    >>> sum(c.values())                 # total of all counts
    15

    >>> c['a']                          # count of letter 'a'
    5
    >>> for elem in 'shazam':           # update counts from an iterable
    ...     c[elem] += 1                # by adding 1 to each element's count
    >>> c['a']                          # now there are seven 'a'
    7
    >>> del c['b']                      # remove all 'b'
    >>> c['b']                          # now there are zero 'b'
    0

    >>> d = Counter('simsalabim')       # make another counter
    >>> c.update(d)                     # add in the second counter
    >>> c['a']                          # now there are nine 'a'
    9

    >>> c.clear()                       # empty the counter
    >>> c
    Counter()

    Note:  If a count is set to zero or reduced to zero, it will remain
    in the counter until the entry is deleted or the counter is cleared:

    >>> c = Counter('aaabbc')
    >>> c['b'] -= 2                     # reduce the count of 'b' by two
    >>> c.most_common()                 # 'b' is still in, but its count is zero
    [('a', 3), ('c', 1), ('b', 0)]

    '''
    # References:
    #   http://en.wikipedia.org/wiki/Multiset
    #   http://www.gnu.org/software/smalltalk/manual-base/html_node/Bag.html
    #   http://www.java2s.com/Tutorial/Cpp/0380__set-multiset/Catalog0380__set-multiset.htm
    #   http://code.activestate.com/recipes/259174/
    #   Knuth, TAOCP Vol. II section 4.6.3

    def __init__(self, iterable=None, /, **kwds):
        '''Create a new, empty Counter object.  And if given, count elements
        from an input iterable.  Or, initialize the count from another mapping
        of elements to their counts.

        >>> c = Counter()                           # a new, empty counter
        >>> c = Counter('gallahad')                 # a new counter from an iterable
        >>> c = Counter({'a': 4, 'b': 2})           # a new counter from a mapping
        >>> c = Counter(a=4, b=2)                   # a new counter from keyword args

        '''
        super().__init__()
        self.update(iterable, **kwds)

    def __missing__(self, key):
        'The count of elements not in the Counter is zero.'
        # Needed so that self[missing_item] does not raise KeyError
        return 0

    def total(self):
        'Sum of the counts'
        return sum(self.values())

    def most_common(self, n=None):
        '''List the n most common elements and their counts from the most
        common to the least.  If n is None, then list all element counts.

        >>> Counter('abracadabra').most_common(3)
        [('a', 5), ('b', 2), ('r', 2)]

        '''
        # Emulate Bag.sortedByCount from Smalltalk
        if n is None:
            return sorted(self.items(), key=_itemgetter(1), reverse=True)

        # Lazy import to speedup Python startup time
        global heapq
        if heapq is None:
            import heapq

        return heapq.nlargest(n, self.items(), key=_itemgetter(1))

    def elements(self):
        '''Iterator over elements repeating each as many times as its count.

        >>> c = Counter('ABCABC')
        >>> sorted(c.elements())
        ['A', 'A', 'B', 'B', 'C', 'C']

        Knuth's example for prime factors of 1836:  2**2 * 3**3 * 17**1

        >>> import math
        >>> prime_factors = Counter({2: 2, 3: 3, 17: 1})
        >>> math.prod(prime_factors.elements())
        1836

        Note, if an element's count has been set to zero or is a negative
        number, elements() will ignore it.

        '''
        # Emulate Bag.do from Smalltalk and Multiset.begin from C++.
        return _chain.from_iterable(_starmap(_repeat, self.items()))

    # Override dict methods where necessary

    @classmethod
    def fromkeys(cls, iterable, v=None):
        # There is no equivalent method for counters because the semantics
        # would be ambiguous in cases such as Counter.fromkeys('aaabbc', v=2).
        # Initializing counters to zero values isn't necessary because zero
        # is already the default value for counter lookups.  Initializing
        # to one is easily accomplished with Counter(set(iterable)).  For
        # more exotic cases, create a dictionary first using a dictionary
        # comprehension or dict.fromkeys().
        raise NotImplementedError(
            'Counter.fromkeys() is undefined.  Use Counter(iterable) instead.')

    def update(self, iterable=None, /, **kwds):
        '''Like dict.update() but add counts instead of replacing them.

        Source can be an iterable, a dictionary, or another Counter instance.

        >>> c = Counter('which')
        >>> c.update('witch')           # add elements from another iterable
        >>> d = Counter('watch')
        >>> c.update(d)                 # add elements from another counter
        >>> c['h']                      # four 'h' in which, witch, and watch
        4

        '''
        # The regular dict.update() operation makes no sense here because the
        # replace behavior results in some of the original untouched counts
        # being mixed-in with all of the other counts for a mismash that
        # doesn't have a straight-forward interpretation in most counting
        # contexts.  Instead, we implement straight-addition.  Both the inputs
        # and outputs are allowed to contain zero and negative counts.

        if iterable is not None:
            if isinstance(iterable, _collections_abc.Mapping):
                if self:
                    self_get = self.get
                    for elem, count in iterable.items():
                        self[elem] = count + self_get(elem, 0)
                else:
                    # fast path when counter is empty
                    super().update(iterable)
            else:
                _count_elements(self, iterable)
        if kwds:
            self.update(kwds)

    def subtract(self, iterable=None, /, **kwds):
        '''Like dict.update() but subtracts counts instead of replacing them.
        Counts can be reduced below zero.  Both the inputs and outputs are
        allowed to contain zero and negative counts.

        Source can be an iterable, a dictionary, or another Counter instance.

        >>> c = Counter('which')
        >>> c.subtract('witch')             # subtract elements from another iterable
        >>> c.subtract(Counter('watch'))    # subtract elements from another counter
        >>> c['h']                          # 2 in which, minus 1 in witch, minus 1 in watch
        0
        >>> c['w']                          # 1 in which, minus 1 in witch, minus 1 in watch
        -1

        '''
        if iterable is not None:
            self_get = self.get
            if isinstance(iterable, _collections_abc.Mapping):
                for elem, count in iterable.items():
                    self[elem] = self_get(elem, 0) - count
            else:
                for elem in iterable:
                    self[elem] = self_get(elem, 0) - 1
        if kwds:
            self.subtract(kwds)

    def copy(self):
        'Return a shallow copy.'
        return self.__class__(self)

    def __reduce__(self):
        return self.__class__, (dict(self),)

    def __delitem__(self, elem):
        'Like dict.__delitem__() but does not raise KeyError for missing values.'
        if elem in self:
            super().__delitem__(elem)

    def __repr__(self):
        if not self:
            return f'{self.__class__.__name__}()'
        try:
            # dict() preserves the ordering returned by most_common()
            d = dict(self.most_common())
        except TypeError:
            # handle case where values are not orderable
            d = dict(self)
        return f'{self.__class__.__name__}({d!r})'

    # Multiset-style mathematical operations discussed in:
    #       Knuth TAOCP Volume II section 4.6.3 exercise 19
    #       and at http://en.wikipedia.org/wiki/Multiset
    #
    # Outputs guaranteed to only include positive counts.
    #
    # To strip negative and zero counts, add-in an empty counter:
    #       c += Counter()
    #
    # Results are ordered according to when an element is first
    # encountered in the left operand and then by the order
    # encountered in the right operand.
    #
    # When the multiplicities are all zero or one, multiset operations
    # are guaranteed to be equivalent to the corresponding operations
    # for regular sets.
    #     Given counter multisets such as:
    #         cp = Counter(a=1, b=0, c=1)
    #         cq = Counter(c=1, d=0, e=1)
    #     The corresponding regular sets would be:
    #         sp = {'a', 'c'}
    #         sq = {'c', 'e'}
    #     All of the following relations would hold:
    #         set(cp + cq) == sp | sq
    #         set(cp - cq) == sp - sq
    #         set(cp | cq) == sp | sq
    #         set(cp & cq) == sp & sq
    #         (cp == cq) == (sp == sq)
    #         (cp != cq) == (sp != sq)
    #         (cp <= cq) == (sp <= sq)
    #         (cp < cq) == (sp < sq)
    #         (cp >= cq) == (sp >= sq)
    #         (cp > cq) == (sp > sq)

    def __eq__(self, other):
        'True if all counts agree. Missing counts are treated as zero.'
        if not isinstance(other, Counter):
            return NotImplemented
        return all(self[e] == other[e] for c in (self, other) for e in c)

    def __ne__(self, other):
        'True if any counts disagree. Missing counts are treated as zero.'
        if not isinstance(other, Counter):
            return NotImplemented
        return not self == other

    def __le__(self, other):
        'True if all counts in self are a subset of those in other.'
        if not isinstance(other, Counter):
            return NotImplemented
        return all(self[e] <= other[e] for c in (self, other) for e in c)

    def __lt__(self, other):
        'True if all counts in self are a proper subset of those in other.'
        if not isinstance(other, Counter):
            return NotImplemented
        return self <= other and self != other

    def __ge__(self, other):
        'True if all counts in self are a superset of those in other.'
        if not isinstance(other, Counter):
            return NotImplemented
        return all(self[e] >= other[e] for c in (self, other) for e in c)

    def __gt__(self, other):
        'True if all counts in self are a proper superset of those in other.'
        if not isinstance(other, Counter):
            return NotImplemented
        return self >= other and self != other

    def __add__(self, other):
        '''Add counts from two counters.

        >>> Counter('abbb') + Counter('bcc')
        Counter({'b': 4, 'c': 2, 'a': 1})

        '''
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for elem, count in self.items():
            newcount = count + other[elem]
            if newcount > 0:
                result[elem] = newcount
        for elem, count in other.items():
            if elem not in self and count > 0:
                result[elem] = count
        return result

    def __sub__(self, other):
        ''' Subtract count, but keep only results with positive counts.

        >>> Counter('abbbc') - Counter('bccd')
        Counter({'b': 2, 'a': 1})

        '''
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for elem, count in self.items():
            newcount = count - other[elem]
            if newcount > 0:
                result[elem] = newcount
        for elem, count in other.items():
            if elem not in self and count < 0:
                result[elem] = 0 - count
        return result

    def __or__(self, other):
        '''Union is the maximum of value in either of the input counters.

        >>> Counter('abbb') | Counter('bcc')
        Counter({'b': 3, 'c': 2, 'a': 1})

        '''
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for elem, count in self.items():
            other_count = other[elem]
            newcount = other_count if count < other_count else count
            if newcount > 0:
                result[elem] = newcount
        for elem, count in other.items():
            if elem not in self and count > 0:
                result[elem] = count
        return result

    def __and__(self, other):
        ''' Intersection is the minimum of corresponding counts.

        >>> Counter('abbb') & Counter('bcc')
        Counter({'b': 1})

        '''
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for elem, count in self.items():
            other_count = other[elem]
            newcount = count if count < other_count else other_count
            if newcount > 0:
                result[elem] = newcount
        return result

    def __pos__(self):
        'Adds an empty counter, effectively stripping negative and zero counts'
        result = Counter()
        for elem, count in self.items():
            if count > 0:
                result[elem] = count
        return result

    def __neg__(self):
        '''Subtracts from an empty counter.  Strips positive and zero counts,
        and flips the sign on negative counts.

        '''
        result = Counter()
        for elem, count in self.items():
            if count < 0:
                result[elem] = 0 - count
        return result

    def _keep_positive(self):
        '''Internal method to strip elements with a negative or zero count'''
        nonpositive = [elem for elem, count in self.items() if not count > 0]
        for elem in nonpositive:
            del self[elem]
        return self

    def __iadd__(self, other):
        '''Inplace add from another counter, keeping only positive counts.

        >>> c = Counter('abbb')
        >>> c += Counter('bcc')
        >>> c
        Counter({'b': 4, 'c': 2, 'a': 1})

        '''
        for elem, count in other.items():
            self[elem] += count
        return self._keep_positive()

    def __isub__(self, other):
        '''Inplace subtract counter, but keep only results with positive counts.

        >>> c = Counter('abbbc')
        >>> c -= Counter('bccd')
        >>> c
        Counter({'b': 2, 'a': 1})

        '''
        for elem, count in other.items():
            self[elem] -= count
        return self._keep_positive()

    def __ior__(self, other):
        '''Inplace union is the maximum of value from either counter.

        >>> c = Counter('abbb')
        >>> c |= Counter('bcc')
        >>> c
        Counter({'b': 3, 'c': 2, 'a': 1})

        '''
        for elem, other_count in other.items():
            count = self[elem]
            if other_count > count:
                self[elem] = other_count
        return self._keep_positive()

    def __iand__(self, other):
        '''Inplace intersection is the minimum of corresponding counts.

        >>> c = Counter('abbb')
        >>> c &= Counter('bcc')
        >>> c
        Counter({'b': 1})

        '''
        for elem, count in self.items():
            other_count = other[elem]
            if other_count < count:
                self[elem] = other_count
        return self._keep_positive()


# ChainMap: CPython 3.14's (Lib/collections/__init__.py; PSF License, see
# cdn/LICENSE-CPython.txt and NOTICE.md)
from reprlib import recursive_repr as _recursive_repr


class ChainMap(_collections_abc.MutableMapping):
    ''' A ChainMap groups multiple dicts (or other mappings) together
    to create a single, updateable view.

    The underlying mappings are stored in a list.  That list is public and can
    be accessed or updated using the *maps* attribute.  There is no other
    state.

    Lookups search the underlying mappings successively until a key is found.
    In contrast, writes, updates, and deletions only operate on the first
    mapping.

    '''

    def __init__(self, *maps):
        '''Initialize a ChainMap by setting *maps* to the given mappings.
        If no mappings are provided, a single empty dictionary is used.

        '''
        self.maps = list(maps) or [{}]          # always at least one map

    def __missing__(self, key):
        raise KeyError(key)

    def __getitem__(self, key):
        for mapping in self.maps:
            try:
                return mapping[key]             # can't use 'key in mapping' with defaultdict
            except KeyError:
                pass
        return self.__missing__(key)            # support subclasses that define __missing__

    def get(self, key, default=None):
        return self[key] if key in self else default    # needs to make use of __contains__

    def __len__(self):
        return len(set().union(*self.maps))     # reuses stored hash values if possible

    def __iter__(self):
        d = {}
        for mapping in map(dict.fromkeys, reversed(self.maps)):
            d |= mapping                        # reuses stored hash values if possible
        return iter(d)

    def __contains__(self, key):
        for mapping in self.maps:
            if key in mapping:
                return True
        return False

    def __bool__(self):
        return any(self.maps)

    @_recursive_repr()
    def __repr__(self):
        return f'{self.__class__.__name__}({", ".join(map(repr, self.maps))})'

    @classmethod
    def fromkeys(cls, iterable, value=None, /):
        'Create a new ChainMap with keys from iterable and values set to value.'
        return cls(dict.fromkeys(iterable, value))

    def copy(self):
        'New ChainMap or subclass with a new copy of maps[0] and refs to maps[1:]'
        return self.__class__(self.maps[0].copy(), *self.maps[1:])

    __copy__ = copy

    def new_child(self, m=None, **kwargs):      # like Django's Context.push()
        '''New ChainMap with a new map followed by all previous maps.
        If no map is provided, an empty dict is used.
        Keyword arguments update the map or new empty dict.
        '''
        if m is None:
            m = kwargs
        elif kwargs:
            m.update(kwargs)
        return self.__class__(m, *self.maps)

    @property
    def parents(self):                          # like Django's Context.pop()
        'New ChainMap from maps[1:].'
        return self.__class__(*self.maps[1:])

    def __setitem__(self, key, value):
        self.maps[0][key] = value

    def __delitem__(self, key):
        try:
            del self.maps[0][key]
        except KeyError:
            raise KeyError(f'Key not found in the first mapping: {key!r}')

    def popitem(self):
        'Remove and return an item pair from maps[0]. Raise KeyError is maps[0] is empty.'
        try:
            return self.maps[0].popitem()
        except KeyError:
            raise KeyError('No keys found in the first mapping.')

    def pop(self, key, *args):
        'Remove *key* from maps[0] and return its value. Raise KeyError if *key* not in maps[0].'
        try:
            return self.maps[0].pop(key, *args)
        except KeyError:
            raise KeyError(f'Key not found in the first mapping: {key!r}')

    def clear(self):
        'Clear maps[0], leaving maps[1:] intact.'
        self.maps[0].clear()

    def __ior__(self, other):
        self.maps[0].update(other)
        return self

    def __or__(self, other):
        if not isinstance(other, _collections_abc.Mapping):
            return NotImplemented
        m = self.copy()
        m.maps[0].update(other)
        return m

    def __ror__(self, other):
        if not isinstance(other, _collections_abc.Mapping):
            return NotImplemented
        m = dict(other)
        for child in reversed(self.maps):
            m.update(child)
        return self.__class__(m)


# UserDict, UserList and UserString: CPython 3.14's (Lib/collections/__init__.py;
# PSF License, see cdn/LICENSE-CPython.txt and NOTICE.md)

class UserDict(_collections_abc.MutableMapping):

    # Start by filling-out the abstract methods
    def __init__(self, dict=None, /, **kwargs):
        self.data = {}
        if dict is not None:
            self.update(dict)
        if kwargs:
            self.update(kwargs)

    def __len__(self):
        return len(self.data)

    def __getitem__(self, key):
        if key in self.data:
            return self.data[key]
        if hasattr(self.__class__, "__missing__"):
            return self.__class__.__missing__(self, key)
        raise KeyError(key)

    def __setitem__(self, key, item):
        self.data[key] = item

    def __delitem__(self, key):
        del self.data[key]

    def __iter__(self):
        return iter(self.data)

    # Modify __contains__ and get() to work like dict
    # does when __missing__ is present.
    def __contains__(self, key):
        return key in self.data

    def get(self, key, default=None):
        if key in self:
            return self[key]
        return default


    # Now, add the methods in dicts but not in MutableMapping
    def __repr__(self):
        return repr(self.data)

    def __or__(self, other):
        if isinstance(other, UserDict):
            return self.__class__(self.data | other.data)
        if isinstance(other, dict):
            return self.__class__(self.data | other)
        return NotImplemented

    def __ror__(self, other):
        if isinstance(other, UserDict):
            return self.__class__(other.data | self.data)
        if isinstance(other, dict):
            return self.__class__(other | self.data)
        return NotImplemented

    def __ior__(self, other):
        if isinstance(other, UserDict):
            self.data |= other.data
        else:
            self.data |= other
        return self

    def __copy__(self):
        inst = self.__class__.__new__(self.__class__)
        inst.__dict__.update(self.__dict__)
        # Create a copy and avoid triggering descriptors
        inst.__dict__["data"] = self.__dict__["data"].copy()
        return inst

    def copy(self):
        if self.__class__ is UserDict:
            return UserDict(self.data.copy())
        import copy
        data = self.data
        try:
            self.data = {}
            c = copy.copy(self)
        finally:
            self.data = data
        c.update(self)
        return c

    @classmethod
    def fromkeys(cls, iterable, value=None):
        d = cls()
        for key in iterable:
            d[key] = value
        return d


################################################################################
### UserList
################################################################################

class UserList(_collections_abc.MutableSequence):
    """A more or less complete user-defined wrapper around list objects."""

    def __init__(self, initlist=None):
        self.data = []
        if initlist is not None:
            # XXX should this accept an arbitrary sequence?
            if type(initlist) == type(self.data):
                self.data[:] = initlist
            elif isinstance(initlist, UserList):
                self.data[:] = initlist.data[:]
            else:
                self.data = list(initlist)

    def __repr__(self):
        return repr(self.data)

    def __lt__(self, other):
        return self.data < self.__cast(other)

    def __le__(self, other):
        return self.data <= self.__cast(other)

    def __eq__(self, other):
        return self.data == self.__cast(other)

    def __gt__(self, other):
        return self.data > self.__cast(other)

    def __ge__(self, other):
        return self.data >= self.__cast(other)

    def __cast(self, other):
        return other.data if isinstance(other, UserList) else other

    def __contains__(self, item):
        return item in self.data

    def __len__(self):
        return len(self.data)

    def __getitem__(self, i):
        if isinstance(i, slice):
            return self.__class__(self.data[i])
        else:
            return self.data[i]

    def __setitem__(self, i, item):
        self.data[i] = item

    def __delitem__(self, i):
        del self.data[i]

    def __add__(self, other):
        if isinstance(other, UserList):
            return self.__class__(self.data + other.data)
        elif isinstance(other, type(self.data)):
            return self.__class__(self.data + other)
        return self.__class__(self.data + list(other))

    def __radd__(self, other):
        if isinstance(other, UserList):
            return self.__class__(other.data + self.data)
        elif isinstance(other, type(self.data)):
            return self.__class__(other + self.data)
        return self.__class__(list(other) + self.data)

    def __iadd__(self, other):
        if isinstance(other, UserList):
            self.data += other.data
        elif isinstance(other, type(self.data)):
            self.data += other
        else:
            self.data += list(other)
        return self

    def __mul__(self, n):
        return self.__class__(self.data * n)

    __rmul__ = __mul__

    def __imul__(self, n):
        self.data *= n
        return self

    def __copy__(self):
        inst = self.__class__.__new__(self.__class__)
        inst.__dict__.update(self.__dict__)
        # Create a copy and avoid triggering descriptors
        inst.__dict__["data"] = self.__dict__["data"][:]
        return inst

    def append(self, item):
        self.data.append(item)

    def insert(self, i, item):
        self.data.insert(i, item)

    def pop(self, i=-1):
        return self.data.pop(i)

    def remove(self, item):
        self.data.remove(item)

    def clear(self):
        self.data.clear()

    def copy(self):
        return self.__class__(self)

    def count(self, item):
        return self.data.count(item)

    def index(self, item, *args):
        return self.data.index(item, *args)

    def reverse(self):
        self.data.reverse()

    def sort(self, /, *args, **kwds):
        self.data.sort(*args, **kwds)

    def extend(self, other):
        if isinstance(other, UserList):
            self.data.extend(other.data)
        else:
            self.data.extend(other)


################################################################################
### UserString
################################################################################

class UserString(_collections_abc.Sequence):

    def __init__(self, seq):
        if isinstance(seq, str):
            self.data = seq
        elif isinstance(seq, UserString):
            self.data = seq.data[:]
        else:
            self.data = str(seq)

    def __str__(self):
        return str(self.data)

    def __repr__(self):
        return repr(self.data)

    def __int__(self):
        return int(self.data)

    def __float__(self):
        return float(self.data)

    def __complex__(self):
        return complex(self.data)

    def __hash__(self):
        return hash(self.data)

    def __getnewargs__(self):
        return (self.data[:],)

    def __eq__(self, string):
        if isinstance(string, UserString):
            return self.data == string.data
        return self.data == string

    def __lt__(self, string):
        if isinstance(string, UserString):
            return self.data < string.data
        return self.data < string

    def __le__(self, string):
        if isinstance(string, UserString):
            return self.data <= string.data
        return self.data <= string

    def __gt__(self, string):
        if isinstance(string, UserString):
            return self.data > string.data
        return self.data > string

    def __ge__(self, string):
        if isinstance(string, UserString):
            return self.data >= string.data
        return self.data >= string

    def __contains__(self, char):
        if isinstance(char, UserString):
            char = char.data
        return char in self.data

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        return self.__class__(self.data[index])

    def __add__(self, other):
        if isinstance(other, UserString):
            return self.__class__(self.data + other.data)
        elif isinstance(other, str):
            return self.__class__(self.data + other)
        return self.__class__(self.data + str(other))

    def __radd__(self, other):
        if isinstance(other, str):
            return self.__class__(other + self.data)
        return self.__class__(str(other) + self.data)

    def __mul__(self, n):
        return self.__class__(self.data * n)

    __rmul__ = __mul__

    def __mod__(self, args):
        return self.__class__(self.data % args)

    def __rmod__(self, template):
        return self.__class__(str(template) % self)

    # the following methods are defined in alphabetical order:
    def capitalize(self):
        return self.__class__(self.data.capitalize())

    def casefold(self):
        return self.__class__(self.data.casefold())

    def center(self, width, *args):
        return self.__class__(self.data.center(width, *args))

    def count(self, sub, start=0, end=_sys.maxsize):
        if isinstance(sub, UserString):
            sub = sub.data
        return self.data.count(sub, start, end)

    def removeprefix(self, prefix, /):
        if isinstance(prefix, UserString):
            prefix = prefix.data
        return self.__class__(self.data.removeprefix(prefix))

    def removesuffix(self, suffix, /):
        if isinstance(suffix, UserString):
            suffix = suffix.data
        return self.__class__(self.data.removesuffix(suffix))

    def encode(self, encoding='utf-8', errors='strict'):
        encoding = 'utf-8' if encoding is None else encoding
        errors = 'strict' if errors is None else errors
        return self.data.encode(encoding, errors)

    def endswith(self, suffix, start=0, end=_sys.maxsize):
        return self.data.endswith(suffix, start, end)

    def expandtabs(self, tabsize=8):
        return self.__class__(self.data.expandtabs(tabsize))

    def find(self, sub, start=0, end=_sys.maxsize):
        if isinstance(sub, UserString):
            sub = sub.data
        return self.data.find(sub, start, end)

    def format(self, /, *args, **kwds):
        return self.data.format(*args, **kwds)

    def format_map(self, mapping):
        return self.data.format_map(mapping)

    def index(self, sub, start=0, end=_sys.maxsize):
        if isinstance(sub, UserString):
            sub = sub.data
        return self.data.index(sub, start, end)

    def isalpha(self):
        return self.data.isalpha()

    def isalnum(self):
        return self.data.isalnum()

    def isascii(self):
        return self.data.isascii()

    def isdecimal(self):
        return self.data.isdecimal()

    def isdigit(self):
        return self.data.isdigit()

    def isidentifier(self):
        return self.data.isidentifier()

    def islower(self):
        return self.data.islower()

    def isnumeric(self):
        return self.data.isnumeric()

    def isprintable(self):
        return self.data.isprintable()

    def isspace(self):
        return self.data.isspace()

    def istitle(self):
        return self.data.istitle()

    def isupper(self):
        return self.data.isupper()

    def join(self, seq):
        return self.data.join(seq)

    def ljust(self, width, *args):
        return self.__class__(self.data.ljust(width, *args))

    def lower(self):
        return self.__class__(self.data.lower())

    def lstrip(self, chars=None):
        return self.__class__(self.data.lstrip(chars))

    # (a staticmethod: Sagebrush's builtins would bind an instance)
    maketrans = staticmethod(str.maketrans)

    def partition(self, sep):
        return self.data.partition(sep)

    def replace(self, old, new, maxsplit=-1):
        if isinstance(old, UserString):
            old = old.data
        if isinstance(new, UserString):
            new = new.data
        return self.__class__(self.data.replace(old, new, maxsplit))

    def rfind(self, sub, start=0, end=_sys.maxsize):
        if isinstance(sub, UserString):
            sub = sub.data
        return self.data.rfind(sub, start, end)

    def rindex(self, sub, start=0, end=_sys.maxsize):
        if isinstance(sub, UserString):
            sub = sub.data
        return self.data.rindex(sub, start, end)

    def rjust(self, width, *args):
        return self.__class__(self.data.rjust(width, *args))

    def rpartition(self, sep):
        return self.data.rpartition(sep)

    def rstrip(self, chars=None):
        return self.__class__(self.data.rstrip(chars))

    def split(self, sep=None, maxsplit=-1):
        return self.data.split(sep, maxsplit)

    def rsplit(self, sep=None, maxsplit=-1):
        return self.data.rsplit(sep, maxsplit)

    def splitlines(self, keepends=False):
        return self.data.splitlines(keepends)

    def startswith(self, prefix, start=0, end=_sys.maxsize):
        return self.data.startswith(prefix, start, end)

    def strip(self, chars=None):
        return self.__class__(self.data.strip(chars))

    def swapcase(self):
        return self.__class__(self.data.swapcase())

    def title(self):
        return self.__class__(self.data.title())

    def translate(self, *args):
        return self.__class__(self.data.translate(*args))

    def upper(self):
        return self.__class__(self.data.upper())

    def zfill(self, width):
        return self.__class__(self.data.zfill(width))
