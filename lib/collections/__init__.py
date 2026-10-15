"""collections for the pyjs runtime: deque, namedtuple, OrderedDict,
defaultdict, Counter, ChainMap, UserDict, UserList, UserString."""

import sys as _sys
import _collections_abc

# (as CPython's: collections.abc is _collections_abc)
_sys.modules["collections.abc"] = _collections_abc
abc = _collections_abc

__all__ = ["ChainMap", "Counter", "OrderedDict", "UserDict", "UserList",
           "UserString", "defaultdict", "deque", "namedtuple"]


# ---------------------------------------------------------------- deque

class deque:
    """Two stacks: _l holds the left part reversed, _r the right part, so
    both ends and indexing are O(1) (amortized)."""

    __slots__ = ("_l", "_r", "_maxlen")

    def __init__(self, iterable=(), maxlen=None):
        if maxlen is not None:
            if not isinstance(maxlen, int):
                raise TypeError("an integer is required")
            if maxlen < 0:
                raise ValueError("maxlen must be non-negative")
        self._l = []
        self._r = []
        self._maxlen = maxlen
        self.extend(iterable)

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

    def __iter__(self):
        return iter(self._items())

    def __reversed__(self):
        return iter(self._items()[::-1])

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

    def __contains__(self, x):
        return x in self._l or x in self._r

    def _index(self, i):
        if not isinstance(i, int):
            raise TypeError("sequence index must be integer, not '%s'" % type(i).__name__)
        n = len(self)
        if i < 0:
            i += n
        if i < 0 or i >= n:
            raise IndexError("deque index out of range")
        return i

    def __getitem__(self, i):
        i = self._index(i)
        nl = len(self._l)
        return self._l[nl - 1 - i] if i < nl else self._r[i - nl]

    def __setitem__(self, i, v):
        i = self._index(i)
        nl = len(self._l)
        if i < nl:
            self._l[nl - 1 - i] = v
        else:
            self._r[i - nl] = v

    def __delitem__(self, i):
        i = self._index(i)
        items = self._items()
        del items[i]
        self._set(items)

    def append(self, x):
        self._r.append(x)
        if self._maxlen is not None and len(self) > self._maxlen:
            self.popleft()

    def appendleft(self, x):
        self._l.append(x)
        if self._maxlen is not None and len(self) > self._maxlen:
            self.pop()

    def pop(self):
        if not self._r:
            if not self._l:
                raise IndexError("pop from an empty deque")
            k = (len(self._l) + 1) // 2
            self._r = self._l[:k][::-1]
            self._l = self._l[k:]
        return self._r.pop()

    def popleft(self):
        if not self._l:
            if not self._r:
                raise IndexError("pop from an empty deque")
            k = (len(self._r) + 1) // 2
            self._l = self._r[:k][::-1]
            self._r = self._r[k:]
        return self._l.pop()

    def extend(self, iterable):
        if iterable is self:
            iterable = list(iterable)
        for x in iterable:
            self.append(x)

    def extendleft(self, iterable):
        if iterable is self:
            iterable = list(iterable)
        for x in iterable:
            self.appendleft(x)

    def clear(self):
        self._l = []
        self._r = []

    def copy(self):
        return deque(self, self._maxlen)

    __copy__ = copy

    def count(self, x):
        return self._l.count(x) + self._r.count(x)

    def index(self, x, start=0, stop=None):
        items = self._items()
        if stop is None:
            stop = len(items)
        try:
            return items.index(x, start, stop)
        except ValueError:
            raise ValueError("%r is not in deque" % (x,)) from None

    def insert(self, i, x):
        if self._maxlen is not None and len(self) >= self._maxlen:
            raise IndexError("deque already at its maximum size")
        items = self._items()
        items.insert(i, x)
        self._set(items)

    def remove(self, x):
        items = self._items()
        try:
            items.remove(x)
        except ValueError:
            raise ValueError("deque.remove(x): x not in deque") from None
        self._set(items)

    def reverse(self):
        self._l, self._r = self._r, self._l

    def rotate(self, n=1):
        k = len(self)
        if k <= 1:
            return
        n %= k
        if n:
            items = self._items()
            self._set(items[-n:] + items[:-n])

    def __add__(self, other):
        if not isinstance(other, deque):
            raise TypeError('can only concatenate deque (not "%s") to deque' % type(other).__name__)
        d = self.copy()
        d.extend(other)
        return d

    def __iadd__(self, other):
        self.extend(other)
        return self

    def __mul__(self, n):
        d = deque((), self._maxlen)
        d.extend(self._items() * n)
        return d

    __rmul__ = __mul__

    def __imul__(self, n):
        items = self._items() * n
        self.clear()
        self.extend(items)
        return self

    @classmethod
    def __class_getitem__(cls, item):
        return cls


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


class Counter(dict):
    def __init__(self, iterable=None, /, **kwds):
        dict.__init__(self)
        self.update(iterable, **kwds)

    def __missing__(self, key):
        return 0

    def total(self):
        return sum(self.values())

    def most_common(self, n=None):
        items = sorted(self.items(), key=lambda kv: kv[1], reverse=True)
        return items if n is None else items[:n]

    def elements(self):
        for k, v in self.items():
            for _ in range(v):
                yield k

    @classmethod
    def fromkeys(cls, iterable, v=None):
        raise NotImplementedError("Counter.fromkeys() is undefined.  Use Counter(iterable) instead.")

    def update(self, iterable=None, /, **kwds):
        if iterable is not None:
            if isinstance(iterable, dict):
                for k, v in iterable.items():
                    self[k] = self.get(k, 0) + v
            else:
                for k in iterable:
                    self[k] = self.get(k, 0) + 1
        if kwds:
            self.update(kwds)

    def subtract(self, iterable=None, /, **kwds):
        if iterable is not None:
            if isinstance(iterable, dict):
                for k, v in iterable.items():
                    self[k] = self.get(k, 0) - v
            else:
                for k in iterable:
                    self[k] = self.get(k, 0) - 1
        if kwds:
            self.subtract(kwds)

    def copy(self):
        return self.__class__(self)

    def __delitem__(self, k):
        if k in self:
            dict.__delitem__(self, k)

    def __repr__(self):
        if not self:
            return "%s()" % self.__class__.__name__
        return "%s({%s})" % (self.__class__.__name__, ", ".join("%r: %r" % kv for kv in self.most_common()))

    def __add__(self, other):
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for k, v in self.items():
            n = v + other[k]
            if n > 0:
                result[k] = n
        for k, v in other.items():
            if k not in self and v > 0:
                result[k] = v
        return result

    def __sub__(self, other):
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for k, v in self.items():
            n = v - other[k]
            if n > 0:
                result[k] = n
        for k, v in other.items():
            if k not in self and v < 0:
                result[k] = -v
        return result

    def __or__(self, other):
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for k in list(self) + [k for k in other if k not in self]:
            n = max(self[k], other[k])
            if n > 0:
                result[k] = n
        return result

    def __and__(self, other):
        if not isinstance(other, Counter):
            return NotImplemented
        result = Counter()
        for k, v in self.items():
            n = min(v, other[k])
            if n > 0:
                result[k] = n
        return result

    def __pos__(self):
        return Counter({k: v for k, v in self.items() if v > 0})

    def __neg__(self):
        return Counter({k: -v for k, v in self.items() if v < 0})


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

    maketrans = str.maketrans

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
