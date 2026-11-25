"""The category dtype (pandas' CategoricalDtype and Categorical), as pandas
3.1 builds and prints it:

- the categories are the distinct values present, sorted (numbers before
  strings when they mix, as pandas' safe sort orders them), or the ones
  given; a value outside them is missing;
- a column holds int codes into the categories, -1 for a missing value, in
  the smallest signed integer type that fits (int8 for fewer than 127
  categories);
- a Series prints the values as objects, then the dtype and a line of the
  categories ("Categories (3, str): ['a', 'b', 'c']", at most 8 shown,
  wrapped at display.width).

Only some operations take a category column: indexing and selection, isna,
== and != (order comparisons raise: pandas' TypeError for an unordered
category, NotImplementedError for an ordered one), astype, unique,
.cat.categories, .cat.codes and .cat.ordered, tolist and printing. Any other
operation raises NotImplementedError rather than computing on the codes: a
category column's values are not readable as an array (CatColumn).
"""

import numpy as np

from ._pd_column import Column, column_from
from ._pd_dtypes import STR, SMALL_INTS, INTS, FLOATS, is_missing


def refuse(what):
    """The refusal of an operation on a category column."""
    return NotImplementedError("pandas: %s is not in Sagebrush's pandas 0.x subset" % what)


def _codes_dtype(n):
    # (pandas' coerce_indexer_dtype: the smallest signed integer type holding the codes)
    if n < 127:
        return "int8"
    if n < 32767:
        return "int16"
    if n < 2 ** 31 - 1:
        return "int32"
    return "int64"


class CategoricalDtype(object):
    """pandas' CategoricalDtype: its categories (an Index, or None when they
    are to be inferred) and whether they are ordered."""

    name = "category"
    kind = "O"

    def __init__(self, categories=None, ordered=False):
        from ._pd_index import Index
        if categories is not None:
            categories = categories if isinstance(categories, Index) else Index(list(categories))
            if not categories.is_unique:
                raise ValueError("Categorical categories must be unique")
            if any(is_missing(v) for v in categories.tolist()):
                raise ValueError("Categorical categories cannot be null")
        self._pd_categories = categories
        self._pd_ordered = bool(ordered) if ordered is not None else False

    @property
    def categories(self):
        return self._pd_categories

    @property
    def ordered(self):
        return self._pd_ordered

    def __str__(self):
        return "category"

    def __repr__(self):
        if self._pd_categories is None:
            return "CategoricalDtype(categories=None, ordered=%s, categories_dtype=None)" % self._pd_ordered
        cats = self._pd_categories.tolist()
        return "CategoricalDtype(categories=%r, ordered=%s, categories_dtype=%s)" % (
            cats, self._pd_ordered, self._pd_categories.dtype)

    def __eq__(self, other):
        if isinstance(other, str):
            return other == "category"
        if not isinstance(other, CategoricalDtype):
            return False
        if self._pd_categories is None or other._pd_categories is None:
            # (pandas: a dtype without categories equals only another without them)
            return self._pd_categories is None and other._pd_categories is None
        if self._pd_ordered != other._pd_ordered:
            return False
        if self._pd_ordered:
            return self._pd_categories.tolist() == other._pd_categories.tolist()
        return set(self._pd_categories.tolist()) == set(other._pd_categories.tolist())

    def __ne__(self, other):
        return not self == other

    def __hash__(self):
        return hash("category")


def is_category(dtype):
    return isinstance(dtype, CategoricalDtype) or (isinstance(dtype, str) and dtype == "category")


class CatColumn(Column):
    """A category column: int codes (-1 for missing) and a CategoricalDtype
    with its categories. Its values are not readable as an array
    (_pd_values raises), so an operation not written for categories refuses
    rather than computing on the codes."""

    __slots__ = ("_pd_codes",)

    def __init__(self, dtype, codes):
        self._pd_dtype = dtype
        self._pd_codes = codes

    @property
    def _pd_values(self):
        raise refuse("this operation on a category column")

    def __len__(self):
        return len(self._pd_codes)

    @property
    def is_numeric(self):
        return False

    @property
    def is_list(self):
        return False

    def copy(self):
        return CatColumn(self._pd_dtype, self._pd_codes.copy())

    def take(self, positions):
        c = self._pd_codes
        return CatColumn(self._pd_dtype, c[np.asarray(positions, dtype=np.int64)] if positions else c[:0].copy())

    def slice(self, start, stop, step):
        return CatColumn(self._pd_dtype, self._pd_codes[start:stop:step].copy())

    def value(self, i):
        k = int(self._pd_codes[i])
        return float("nan") if k < 0 else self._pd_dtype.categories._pd_column().value(k)

    def isna(self):
        return self._pd_codes < 0

    def tolist(self):
        cats = self._pd_dtype.categories.tolist()
        return [float("nan") if k < 0 else cats[k] for k in self._pd_codes.tolist()]

    def decoded(self):
        """The values as a column of the categories' dtype (missing values as
        that dtype holds them)."""
        return column_from(self.tolist(), _decoded_dtype(self._pd_dtype.categories.dtype))


def _decoded_dtype(d):
    # (a missing value turns int and bool categories into float and object values)
    return None if d in INTS or d == "bool" else d


def _sorted_unique(values):
    seen = []
    known = set()
    for v in values:
        if is_missing(v) or v in known:
            continue
        known.add(v)
        seen.append(v)
    try:
        return sorted(seen)
    except TypeError:
        # (pandas' safe_sort of mixed values: the non-strings sorted, then the strings sorted)
        others = [v for v in seen if not isinstance(v, str)]
        strs = [v for v in seen if isinstance(v, str)]
        try:
            return sorted(others) + sorted(strs)
        except TypeError:
            return seen


def encode(values, dtype=None):
    """A CatColumn of values (a list), with dtype's categories, or the
    distinct values present, sorted."""
    from ._pd_index import Index
    ordered = dtype.ordered if isinstance(dtype, CategoricalDtype) else False
    cats = dtype.categories if isinstance(dtype, CategoricalDtype) else None
    if cats is None:
        cats = Index(_sorted_unique(values)) if values else Index([], dtype=object)
        if cats.dtype == "object" and not len(cats):
            cats = Index([], dtype=object)
    lookup = dict((v, i) for i, v in enumerate(cats.tolist()))
    codes = np.array([-1 if is_missing(v) else lookup.get(v, -1) for v in values], dtype=_codes_dtype(len(cats)))
    return CatColumn(CategoricalDtype(cats, ordered), codes)


def column_to_category(col, dtype=None):
    if isinstance(col, CatColumn):
        if dtype is None or not isinstance(dtype, CategoricalDtype) or dtype.categories is None:
            if isinstance(dtype, CategoricalDtype) and dtype.ordered != col.dtype.ordered:
                return CatColumn(CategoricalDtype(col.dtype.categories, dtype.ordered), col._pd_codes.copy())
            return col.copy()
        return encode(col.tolist(), dtype)
    if col.dtype == "float32" or col.dtype in SMALL_INTS:
        # (pandas keeps the column's own dtype for the categories, which the subset's Index doesn't hold)
        raise refuse("astype('category') of %s %s column" % ("an" if col.dtype[0] in "aeiou" else "a", col.dtype))
    from ._pd_datetime import DT
    if col.dtype is DT:
        raise refuse("astype('category') of a datetime64[us] column")
    return encode(col.tolist(), dtype if isinstance(dtype, CategoricalDtype) else None)


# --- printing --------------------------------------------------------------------


def _quoted_strings(values, dtype):
    """format_array with QUOTE_NONNUMERIC, stripped: str values quoted,
    numbers as pandas prints them, missing values NaN."""
    from ._pd_repr import _float_strings, _opt, _ESCAPES, pprint_thing
    if dtype in FLOATS:
        return [x.strip() for x in _float_strings([float("nan") if is_missing(v) else v for v in values], "NaN", True,
                                                  "right", _opt("precision"))]
    out = []
    for v in values:
        if is_missing(v):
            out.append("NaN")
        elif isinstance(v, str):
            out.append(str(pprint_thing(v, escape_chars=_ESCAPES, quote_strings=True)))
        else:
            out.append(str(pprint_thing(v)))
    return out


def _max_width():
    from ._pd_repr import _opt
    return _opt("width")


def categories_line(dtype):
    """pandas' _get_repr_footer: 'Categories (n, dtype): [...]'."""
    from ._pd_repr import _opt
    cats = dtype.categories
    try:
        max_categories = _opt("max_categories") or 10
    except KeyError:
        # (display.max_categories isn't among the subset's options: pandas' default)
        max_categories = 8
    vals = cats.tolist()
    if len(vals) > max_categories:
        num = max_categories // 2
        strs = _quoted_strings(vals[:num], cats.dtype) + ["..."] + _quoted_strings(vals[-num:], cats.dtype)
    else:
        strs = _quoted_strings(vals, cats.dtype)
    levheader = "Categories (%d, %s): " % (len(vals), cats.dtype)
    max_width = _max_width()
    parts = []
    start = True
    cur = len(levheader)
    sep_len, sep = (3, " < ") if dtype.ordered else (2, ", ")
    linesep = sep.rstrip() + "\n"
    for val in strs:
        if max_width != 0 and cur + sep_len + len(val) > max_width:
            parts.append(linesep + " " * (len(levheader) + 1))
            cur = len(levheader) + 1
        elif not start:
            parts.append(sep)
            cur += sep_len
        parts.append(val)
        cur += len(val)
        start = False
    return "%s[%s]" % (levheader, "".join(parts).replace(" < ... < ", " ... "))


def _values_line(strs, max_width):
    if max_width == 0:
        return "[" + ", ".join(strs) + "]"
    parts = ["["]
    cur = 1
    start = True
    for val in strs:
        if not start:
            if cur + 2 + len(val) > max_width:
                parts.append(",\n ")
                cur = 1
            else:
                parts.append(", ")
                cur += 2
        parts.append(val)
        cur += len(val)
        start = False
    parts.append("]")
    return "".join(parts)


def categorical_repr(col):
    footer = categories_line(col.dtype)
    n = len(col)
    width = _max_width()
    cd = col.dtype.categories.dtype
    if n > 10:
        head = _quoted_strings(col.slice(0, 5, 1).tolist(), cd)
        tail = _quoted_strings(col.slice(n - 5, n, 1).tolist(), cd)
        return "%s\nLength: %d\n%s" % (_values_line(head + ["..."] + tail, width), n, footer)
    if n:
        return "%s\n%s" % (_values_line(_quoted_strings(col.tolist(), cd), width), footer)
    return "[], %s" % footer


class Categorical(object):
    """pandas.Categorical: values held as codes into categories."""

    def __init__(self, values=None, categories=None, ordered=None, dtype=None, fastpath=False, copy=True):
        if fastpath:
            raise refuse("Categorical(fastpath=)")
        # (a CategoricalDtype, or ordered=, sets whether an existing categorical's categories are ordered; the string
        # "category" keeps its flag)
        explicit = isinstance(dtype, CategoricalDtype)
        if dtype is not None:
            if isinstance(dtype, str) and dtype == "category":
                dtype = CategoricalDtype(categories, ordered)
            elif not isinstance(dtype, CategoricalDtype):
                raise refuse("Categorical(dtype=%r)" % (dtype,))
        else:
            dtype = CategoricalDtype(categories, ordered)
        from ._pd_series import Series
        from ._pd_index import Index
        if values is None:
            values = []
        source = values._pd_col if isinstance(values, (Categorical, Series)) else None
        if isinstance(source, CatColumn):
            col = column_to_category(source, dtype if dtype.categories is not None else None)
            # (only ordered= or a CategoricalDtype sets the flag; otherwise the source's stays, categories= or not)
            keep = dtype.ordered if (explicit or ordered is not None) else source.dtype.ordered
            if col.dtype.ordered != keep:
                col = CatColumn(CategoricalDtype(col.dtype.categories, keep), col._pd_codes)
        elif isinstance(values, Series):
            col = column_to_category(values._pd_col, dtype)
        else:
            if isinstance(values, Index):
                values = values.tolist()
            col = encode(column_from(values).tolist() if not isinstance(values, list) else list(values), dtype)
        self._pd_col = col

    @classmethod
    def _pd_from_column(cls, col):
        c = cls.__new__(cls)
        c._pd_col = col
        return c

    @property
    def categories(self):
        return self._pd_col.dtype.categories.copy()

    @property
    def codes(self):
        return self._pd_col._pd_codes.copy()

    @property
    def ordered(self):
        return self._pd_col.dtype.ordered

    @property
    def dtype(self):
        return self._pd_col.dtype

    def __len__(self):
        return len(self._pd_col)

    def __iter__(self):
        return iter(self._pd_col.tolist())

    def tolist(self):
        return self._pd_col.tolist()

    def isna(self):
        return self._pd_col.isna().copy()

    def __repr__(self):
        return categorical_repr(self._pd_col)

    __str__ = __repr__

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        from ._pd_errors import unsupported_name
        raise unsupported_name("Categorical.%s" % name)


class CategoricalAccessor(object):
    """Series.cat: a category Series' categories, codes and ordered."""

    def __init__(self, s):
        self._pd_s = s

    @property
    def categories(self):
        return self._pd_s._pd_col.dtype.categories.copy()

    @property
    def codes(self):
        from ._pd_series import Series
        c = self._pd_s._pd_col._pd_codes
        return Series._pd_new(Column(str(c.dtype), c.copy()), self._pd_s._pd_index.copy(), self._pd_s._pd_name)

    @property
    def ordered(self):
        return self._pd_s._pd_col.dtype.ordered

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        from ._pd_errors import unsupported_name
        raise unsupported_name("Series.cat.%s" % name)


def _category_position(cats, value):
    if is_missing(value):
        return None
    for k, c in enumerate(cats):
        if isinstance(c, bool) != isinstance(value, (bool, np.bool_)):
            continue
        try:
            if c == value:
                return k
        except TypeError:
            continue
    return None


def compare(col, right, op):
    """A category column compared: == and != on the values; an order
    comparison raises (pandas' TypeError for an unordered category; an
    ordered one isn't in the subset yet)."""
    from . import _pd_reduce as R
    if op in ("eq", "ne"):
        if isinstance(right, CatColumn):
            a, b = col.dtype, right.dtype
            la, lb = a.categories.tolist(), b.categories.tolist()
            same = a.ordered == b.ordered and (la == lb if a.ordered else (len(la) == len(lb) and set(la) == set(lb)))
            if not same:
                raise TypeError("Categoricals can only be compared if 'categories' are the same.")
            right = right.decoded()
        elif not isinstance(right, (Column, list, tuple, range, np.ndarray)):
            # (a scalar is looked up among the categories, as pandas looks it up: by value and type, so True is
            # not the category 1; then the codes are compared)
            k = _category_position(col.dtype.categories.tolist(), right)
            codes = col._pd_codes
            hit = codes == k if k is not None else np.zeros(len(codes), dtype=bool)
            return Column("bool", ~hit if op == "ne" else hit)
        return R.compare(col.decoded(), right, op)
    if not col.dtype.ordered:
        raise TypeError("Unordered Categoricals can only compare equality or not")
    raise refuse("an order comparison of an ordered category column")


# --- operations pandas refuses on a category, with its errors ----------------------

_SYMBOLS = {"add": "+", "sub": "-", "mul": "*", "truediv": "/", "floordiv": "//", "mod": "%", "pow": "** or pow()"}
_NUMPY_OPS = {"add": "add", "sub": "subtract", "mul": "multiply", "truediv": "divide", "floordiv": "floor_divide",
              "mod": "remainder", "pow": "power"}


def arith_error(op, reflected, other, self_cat, other_cat):
    """pandas' TypeError for arithmetic with a category Series."""
    if self_cat and other_cat:
        return TypeError("unsupported operand type(s) for %s: 'Categorical' and 'Categorical'" % _SYMBOLS[op])
    from ._pd_series import Series
    if isinstance(other, (Series, list, tuple, range, np.ndarray)):
        return TypeError("Object with dtype category cannot perform the numpy op %s" % _NUMPY_OPS[op])
    names = ("Categorical", type(other).__name__)
    if reflected:
        names = names[::-1]
    return TypeError("unsupported operand type(s) for %s: '%s' and '%s'" % ((_SYMBOLS[op],) + names))


def unary_error(op):
    if op == "abs":
        return TypeError("Object with dtype category cannot perform the numpy op absolute")
    return TypeError("bad operand type for unary %s: 'Categorical'" % ("-" if op == "neg" else "+"))


def reduce(col, op, skipna):
    """A reduction of a category column: min and max of an ordered one (by
    position in its categories), else pandas' TypeError."""
    if op in ("min", "max"):
        if not col.dtype.ordered:
            raise TypeError("Categorical is not ordered for operation %s\nyou can use .as_ordered() to change the "
                            "Categorical to an ordered one\n" % op)
        codes = col._pd_codes.tolist()
        present = [k for k in codes if k >= 0]
        if not present or (not skipna and len(present) < len(codes)):
            return float("nan")
        return col.dtype.categories.tolist()[min(present) if op == "min" else max(present)]
    raise TypeError("'Categorical' with dtype category does not support operation '%s'" % op)
