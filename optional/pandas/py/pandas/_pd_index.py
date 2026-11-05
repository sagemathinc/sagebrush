"""Index and RangeIndex for Sagebrush's pandas (plan-pandas m1 r1 §2.4,
r7).

- RangeIndex(start, stop, step) keeps three integers and is never
  materialized, except where positions are needed (a take, a repr).
- Index holds its labels in a column (_pd_column), and a lazy dict from
  label to positions, built at the first label lookup and dropped on any
  change: a unique label maps to an int, a repeated one to a list.  (The
  read_csv budget charges it when built, r7 §E 1a.)
"""

from ._pd_column import Column, column_from
from ._pd_dtypes import is_missing, infer
from ._pd_datetime import DT, NAT_INT, as_us, is_time, Timestamp, NaT

__all__ = ["Index", "RangeIndex", "DatetimeIndex", "default_index", "ensure_index"]


class Index(object):
    """An immutable sequence of labels, with an optional name."""

    __slots__ = ("_pd_col", "_pd_name", "_pd_map", "_pd_budget")

    def __new__(cls, data=None, dtype=None, copy=False, name=None):
        # (an index of times is a DatetimeIndex, as pandas makes it)
        if cls is Index and _is_times(data, dtype):
            return object.__new__(DatetimeIndex)
        return object.__new__(cls)

    def __init__(self, data=None, dtype=None, copy=False, name=None):
        if isinstance(data, Index):
            col = data._pd_column().copy()
            if name is None:
                name = data.name
        elif isinstance(data, Column):
            col = data.copy()
        else:
            col = column_from([] if data is None else data, dtype)
        self._pd_col = col
        self._pd_name = name
        self._pd_map = None
        self._pd_budget = None

    # (the labels as a column; a RangeIndex makes one)
    def _pd_column(self):
        return self._pd_col

    @property
    def name(self):
        return self._pd_name

    @name.setter
    def name(self, v):
        self._pd_name = v

    @property
    def dtype(self):
        d = self._pd_column().dtype
        if isinstance(d, str):
            import numpy as np
            return np.dtype(d) if d != "object" else d
        return d

    def __len__(self):
        return len(self._pd_column())

    @property
    def size(self):
        return len(self)

    @property
    def shape(self):
        return (len(self),)

    @property
    def empty(self):
        return len(self) == 0

    def tolist(self):
        return self._pd_column().tolist()

    def to_list(self):
        return self.tolist()

    def __iter__(self):
        return iter(self.tolist())

    def __getitem__(self, i):
        if isinstance(i, slice):
            # (the positions the slice selects, as range() gives them from
            # indices: then a plain slice from the first to just past the
            # last, whose bounds are never negative, so Python slicing can't
            # read a -1 from indices ("before position 0") as the last
            # position; astra's PD626-1)
            r = range(*i.indices(len(self)))
            if len(r) == 0:
                start, stop, step = 0, 0, 1
            else:
                start, step = r[0], r.step
                stop = r[-1] + step
                if stop < 0:
                    stop = None
            return Index(self._pd_column().slice(start, stop, step), name=self._pd_name)
        if isinstance(i, int):
            n = len(self)
            if i < -n or i >= n:
                raise IndexError("index %d is out of bounds for axis 0 with size %d" % (i, n))
            return self._pd_column().value(i % n if i < 0 else i)
        raise NotImplementedError("pandas: Index[%s] is not in Sagebrush's pandas 0.x subset" % type(i).__name__)

    def _pd_positions(self, label):
        """The positions of label: an int (unique), a list, or KeyError."""
        if self._pd_map is None:
            # (from read_csv under a finite budget: each growth preflighted,
            # 100 B a label and 8 B a position in a duplicate's list)
            b = self._pd_budget
            m = {}
            charged = 0
            # (the labels read one at a time from the column's own storage:
            # no full copy of them before the first charge; astra's PD626-3)
            col = self._pd_column()
            vals = col._pd_values
            is_list = isinstance(vals, list)
            times = col.dtype is DT
            try:
                for i in range(len(vals)):
                    v = vals[i] if is_list else (from_key(vals[i].item()) if times else vals[i].item())
                    key = _key(v)
                    old = m.get(key)
                    if old is None:
                        if b is not None:
                            b.charge(100, "the index's lookup map")
                            charged += 100
                        m[key] = i
                    elif isinstance(old, list):
                        if b is not None:
                            b.charge(8, "the index's lookup map")
                            charged += 8
                        old.append(i)
                    else:
                        if b is not None:
                            b.charge(16, "the index's lookup map")
                            charged += 16
                        m[key] = [old, i]
            except BaseException:
                # (a refusal leaves no partial map, and returns what the
                # map had charged)
                if b is not None:
                    b.release(charged)
                raise
            self._pd_map = m
        hit = self._pd_map.get(_key(label))
        if hit is None:
            raise KeyError(label)
        return hit

    def get_loc(self, key):
        p = self._pd_positions(key)
        if isinstance(p, list):
            raise NotImplementedError("pandas: Index.get_loc of a repeated label is not in Sagebrush's pandas 0.x subset")
        return p

    def __contains__(self, key):
        try:
            self._pd_positions(key)
            return True
        except (KeyError, TypeError):
            return False

    @property
    def is_unique(self):
        return len(set(_key(v) for v in self.tolist())) == len(self)

    def _pd_take(self, positions):
        return Index(self._pd_column().take(positions), name=self._pd_name)

    def copy(self, name=None):
        return Index(self._pd_column().copy(), name=self._pd_name if name is None else name)

    def equals(self, other):
        return isinstance(other, Index) and self.tolist() == other.tolist()

    def __repr__(self):
        from ._pd_repr import index_repr
        return index_repr(self)

    def __getattr__(self, name):
        from ._pd_names import INDEX
        if not name.startswith("_") and name in INDEX:
            raise NotImplementedError("pandas.%s.%s is not in Sagebrush's pandas 0.x subset" % (type(self).__name__, name))
        raise AttributeError("'%s' object has no attribute '%s'" % (type(self).__name__, name))

    __str__ = __repr__

    def __setitem__(self, key, value):
        raise TypeError("Index does not support mutable operations")

    __hash__ = None


def _is_times(data, dtype):
    if isinstance(data, Index):
        return data._pd_column().dtype is DT
    if isinstance(data, Column):
        return data.dtype is DT
    if dtype is not None:
        return dtype is DT or (isinstance(dtype, str) and dtype in ("datetime64[us]", "M8[us]", "<M8[us]"))
    if isinstance(data, (list, tuple)):
        return any(is_time(v) for v in data) and infer(list(data)) is DT
    return False


class DatetimeIndex(Index):
    """An index of times (datetime64[us]): its labels are Timestamps (or
    NaT); a label is looked up as a Timestamp, a datetime or a string."""

    __slots__ = ()

    def __init__(self, data=None, dtype=None, copy=False, name=None, freq=None):
        if freq is not None:
            raise NotImplementedError("pandas: DatetimeIndex(freq=) is not in Sagebrush's pandas 0.x subset")
        if not isinstance(data, (Index, Column)):
            from ._pd_datetime import to_datetime
            data = to_datetime([] if data is None else list(data))
        Index.__init__(self, data, None, copy, name)
        if self._pd_col.dtype is not DT:
            raise TypeError("DatetimeIndex needs times, got %s" % (self._pd_col.dtype,))

    def _pd_positions(self, label):
        try:
            us = _label_us(label)
            return Index._pd_positions(self, from_key(us))
        except (TypeError, ValueError, KeyError):
            # (the label as given, as pandas' KeyError has it)
            raise KeyError(label) from None

    def _pd_field(self, f):
        import numpy as np
        from ._pd_datetime import FIELDS
        vals = [FIELDS[f](t) for t in self.tolist() if t is not NaT]
        if len(vals) < len(self):
            raise NotImplementedError("pandas: DatetimeIndex.%s with NaT (a float64 index) is not in Sagebrush's pandas 0.x subset" % f)
        return Index(Column("int32", np.array(vals, dtype=np.int32)), name=self._pd_name)

    year = property(lambda self: self._pd_field("year"))
    month = property(lambda self: self._pd_field("month"))
    day = property(lambda self: self._pd_field("day"))

    @property
    def freq(self):
        return None

    def strftime(self, date_format):
        from ._pd_dtypes import STR
        return Index(Column(STR, [float("nan") if t is NaT else t.strftime(date_format) for t in self.tolist()]), name=self._pd_name)


def from_key(us):
    # (the lookup map's key for a time: its Timestamp, as the map's labels are)
    from ._pd_datetime import from_us
    return from_us(us)


def _label_us(label):
    from ._pd_datetime import Timestamp as _T
    if isinstance(label, str):
        t = _T(label)
        if t is NaT:
            return NAT_INT
        return as_us(t)
    if is_time(label):
        return as_us(label)
    raise TypeError(label)


def _key(v):
    # (NaN labels compare equal to each other in lookups, as pandas')
    if is_missing(v):
        return ("NaN",)
    return v


class RangeIndex(Index):
    """range(start, stop, step) as an index, never materialized."""

    __slots__ = ("_pd_start", "_pd_stop", "_pd_step")

    def __init__(self, start=None, stop=None, step=None, dtype=None, copy=False, name=None):
        if stop is None:
            start, stop = 0, (0 if start is None else start)
        if start is None:
            start = 0
        if step is None:
            step = 1
        if step == 0:
            raise ValueError("Step must not be zero")
        self._pd_start, self._pd_stop, self._pd_step = int(start), int(stop), int(step)
        self._pd_col = None
        self._pd_name = name
        self._pd_map = None
        self._pd_budget = None

    @property
    def start(self):
        return self._pd_start

    @property
    def stop(self):
        return self._pd_stop

    @property
    def step(self):
        return self._pd_step

    def __len__(self):
        return len(range(self._pd_start, self._pd_stop, self._pd_step))

    def _pd_column(self):
        if self._pd_col is None:
            self._pd_col = column_from(list(range(self._pd_start, self._pd_stop, self._pd_step)), "int64")
        return self._pd_col

    def _pd_positions(self, label):
        r = range(self._pd_start, self._pd_stop, self._pd_step)
        if isinstance(label, bool) or not isinstance(label, int):
            raise KeyError(label)
        try:
            return r.index(label)
        except ValueError:
            raise KeyError(label) from None

    @property
    def is_unique(self):
        return True

    def _pd_take(self, positions):
        # (a RangeIndex stays one where the labels taken are evenly spaced,
        # as pandas 3's)
        r = range(self._pd_start, self._pd_stop, self._pd_step)
        labels = [r[p] for p in positions]
        if not labels:
            return RangeIndex(0, 0, name=self._pd_name)
        if len(labels) == 1:
            return RangeIndex(labels[0], labels[0] + 1, name=self._pd_name)
        step = labels[1] - labels[0]
        if step != 0 and all(labels[i + 1] - labels[i] == step for i in range(len(labels) - 1)):
            return RangeIndex(labels[0], labels[-1] + step, step, name=self._pd_name)
        return Index(column_from(labels, "int64"), name=self._pd_name)

    def copy(self, name=None):
        return RangeIndex(self._pd_start, self._pd_stop, self._pd_step, name=self._pd_name if name is None else name)

    def tolist(self):
        return list(range(self._pd_start, self._pd_stop, self._pd_step))


def default_index(n):
    return RangeIndex(0, n)


def ensure_index(data, n=None):
    if data is None:
        return default_index(n or 0)
    if isinstance(data, Index):
        return data.copy()
    return Index(data)
