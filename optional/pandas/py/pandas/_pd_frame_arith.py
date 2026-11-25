"""DataFrame arithmetic (+ - * / // % ** and their reflections, divmod,
unary -, +, abs, and the named methods with axis and fill_value), as pandas
3.1 computes it: column by column with Series arithmetic, so the dtypes,
weak scalars and division by zero are the Series' (_pd_arith). Unlike a
Series' named methods, a frame's always keep pandas' zero-division masks.

- a number (or a 0-d array) is a weak scalar for every column;
- a list, tuple, range, Index or 1-D array is a row of values for the
  columns (axis='columns') or a column for the rows (axis='index'), as a
  Series of its inferred dtype: an array, not a weak scalar (int8 + [3] is
  int64, float32 + [2.5] float64); a range or a tuple warns as pandas does;
- a 2-D array of the frame's shape, or (rows, 1) or (1, columns), is
  broadcast to it;
- a Series lines up with the columns (axis='columns', the default) or, with
  axis='index', with the rows, aligned as Series arithmetic aligns;
- another frame lines up on both axes: rows on the sorted union of their
  labels when they differ, each column with the other's column of that
  label.

pandas computes a frame pair whose column sets differ on their shared columns
and then reindexes, giving the added all-missing columns a dtype that depends
on its internal blocks; such pairs (and a Series whose labels aren't the
frame's columns) are refused, as are repeated column labels where columns
are matched by label.
"""

import numpy as np

from ._pd_column import Column
from ._pd_index import Index


def _unsupported(what):
    return NotImplementedError("pandas.%s is not in Sagebrush's pandas 0.x subset" % what)


def _axis(axis):
    if axis is None:
        # (pandas' default: the columns)
        return 1
    if axis in (0, "index", "rows"):
        return 0
    if axis in (1, "columns"):
        return 1
    raise ValueError("No axis named %s for object type DataFrame" % (axis,))


def _frame(cols, columns, index):
    from ._pd_frame import DataFrame
    return DataFrame._pd_new(cols, columns, index)


def _series_of(f, j):
    return f._pd_column_series(j)


def _apply(f, op, reflected, fill_value, rights):
    """Each column's Series op its right operand (a scalar, an array of the
    frame's length, or a Series): the result frame, columns kept."""
    from ._pd_series import Series
    from . import _pd_reshape as RS
    cols = []
    index = f._pd_index.copy()
    for j, right in enumerate(rights):
        left = _series_of(f, j)
        if isinstance(right, np.ndarray):
            # (an array for the rows is a Series on them, so fill_value fills either side as pandas' does)
            right = Series(right, index=f._pd_index.copy())
        elif not isinstance(right, Series) and fill_value is not None:
            # (with a scalar, pandas fills the frame first, a missing scalar included)
            left = Series._pd_new(RS.fill_column(left._pd_col, fill_value), left._pd_index, left._pd_name)
            s = left._pd_arith(right, op, reflected)
            cols.append(s._pd_col)
            continue
        s = left._pd_arith(right, op, reflected, fill_value)
        cols.append(s._pd_col)
        index = s._pd_index
    return _frame(cols, f._pd_columns.copy(), index)


def _series_row(f, s, owner):
    # (a row for the columns, as pandas takes a Series or list-like on axis='columns': each column gets an array of
    # its value in the row's dtype, not a weak scalar)
    d = s._pd_col.dtype
    if d == "object" or not isinstance(d, str):
        raise _unsupported("%s with a row of %s values" % (owner, d))
    n = len(f)
    vals = s._pd_col._pd_values
    return [np.full(n, vals[j], dtype=d) for j in range(len(f._pd_cols))]


def _column_values(f, values):
    from ._pd_series import Series
    n = len(f)
    if len(values) != n:
        raise ValueError("Unable to coerce to Series, length must be %d: given %d" % (n, len(values)))
    return Series(values, index=f._pd_index.copy())


def _unique_columns(f, owner):
    if not f._pd_columns.is_unique:
        raise _unsupported("%s of a frame with repeated column labels" % owner)


def binary(f, other, op, reflected=False, fill_value=None, axis="columns", level=None, method=False):
    from . import _pd_arith as A
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    owner = "DataFrame.%s" % (("r" if reflected else "") + op)
    if level is not None:
        raise _unsupported("%s(level=) (a MultiIndex)" % owner)
    ax = _axis(axis)
    # (a range or a tuple warns with the operators' wording, the named methods' too; a 0-d array is its value)
    other = A.operand(other, owner, False)
    k = len(f._pd_cols)
    if isinstance(other, DataFrame):
        return _with_frame(f, other, op, reflected, fill_value, owner)
    if isinstance(other, Series):
        if ax == 0:
            if not k:
                # (no columns to carry the alignment: the rows are still the sorted union, as in pandas)
                from . import _pd_combine as CB
                rows = CB.join_labels([f._pd_index, other._pd_index], "outer", True)
                return _frame([], f._pd_columns.copy(), f._pd_index.copy() if rows is None else rows)
            return _apply(f, op, reflected, fill_value, [other] * k)
        _unique_columns(f, owner)
        if not other._pd_index.equals(f._pd_columns):
            if not other._pd_index.is_unique or set(other._pd_index.tolist()) != set(f._pd_columns.tolist()):
                raise _unsupported("%s with a Series whose labels aren't the frame's columns (pandas' added "
                                   "all-missing columns)" % owner)
            other = other._pd_reindex(f._pd_columns)
        return _apply(f, op, reflected, fill_value, _series_row(f, other, owner))
    if isinstance(other, Index):
        other = other.tolist()
    if isinstance(other, range):
        other = list(other)
    if isinstance(other, np.ndarray) and other.ndim == 2:
        return _apply(f, op, reflected, fill_value, _block_values(f, other))
    if isinstance(other, np.ndarray) and other.ndim > 2:
        raise _unsupported("%s with a %d-dimensional array" % (owner, other.ndim))
    if isinstance(other, (list, tuple, np.ndarray)):
        values = other.copy() if isinstance(other, np.ndarray) else list(other)
        if ax == 0:
            return _apply(f, op, reflected, fill_value, [_column_values(f, values)] * k)
        if len(values) != k:
            raise ValueError("Unable to coerce to Series, length must be %d: given %d" % (k, len(values)))
        return _apply(f, op, reflected, fill_value, _series_row(f, Series(values), owner))
    return _apply(f, op, reflected, fill_value, [other] * k)


def _block_values(f, arr):
    n, k = len(f), len(f._pd_cols)
    r, c = arr.shape
    if (r, c) == (n, k):
        return [arr[:, j].copy() for j in range(k)]
    if (r, c) == (n, 1):
        return [arr[:, 0].copy() for j in range(k)]
    if (r, c) == (1, k):
        return [np.full(n, arr[0, j], dtype=arr.dtype) for j in range(k)]
    raise ValueError("Unable to coerce to DataFrame, shape must be (%d, %d): given (%d, %d)" % (n, k, r, c))


def _with_frame(f, g, op, reflected, fill_value, owner):
    # (a frame with a frame: matching columns by label, each pair aligned on the rows as Series arithmetic aligns
    # them; the result's columns are the sorted union, which for equal sets is the frame's own order when they're
    # equal and sorted when they differ)
    _unique_columns(f, owner)
    _unique_columns(g, owner)
    lc, rc = f._pd_columns, g._pd_columns
    if set(lc.tolist()) != set(rc.tolist()):
        raise _unsupported("%s of frames with different columns (pandas' added all-missing columns take a dtype "
                           "from its internal blocks)" % owner)
    from . import _pd_combine as CB
    labels = CB.join_labels([lc, rc], "outer", True)
    if labels is None:
        labels = lc.copy()
    cols = []
    index = None
    lpos = dict((lab, j) for j, lab in enumerate(lc.tolist()))
    rpos = dict((lab, j) for j, lab in enumerate(rc.tolist()))
    for lab in labels.tolist():
        left = _series_of(f, lpos[lab])
        right = _series_of(g, rpos[lab])
        s = left._pd_arith(right, op, reflected, fill_value)
        cols.append(s._pd_col)
        index = s._pd_index
    if index is None:
        rows = CB.join_labels([f._pd_index, g._pd_index], "outer", True)
        index = f._pd_index.copy() if rows is None else rows
    return _frame(cols, labels, index)


def unary(f, op):
    from . import _pd_arith as A
    return _frame([A.unary(c, op) for c in f._pd_cols], f._pd_columns.copy(), f._pd_index.copy())


# --- comparisons ---------------------------------------------------------------
# (as pandas 3.1: an operator needs another frame with the same rows and columns, or a Series with exactly the
# columns' labels; a named comparison aligns, a label one side lacks comparing False, True for ne; the result is
# always bool, so there are no added all-missing columns of a block-dependent dtype here)


def _missing_series(index):
    from ._pd_series import Series
    return Series._pd_new(Column("float64", np.full(len(index), np.nan)), index.copy(), None)


def _row_compare_columns(f, s):
    # (a row for the columns: each column against an array of its value in the row's dtype)
    from ._pd_column import column_from
    n = len(f)
    d = s._pd_col.dtype
    vals = s._pd_col.tolist()
    if isinstance(d, str) and d != "object":
        return [Column(d, np.full(n, s._pd_col._pd_values[j], dtype=d)) for j in range(len(vals))]
    return [column_from([vals[j]] * n) for j in range(len(vals))]


def compare(f, other, op, axis="columns", level=None, method=False):
    from . import _pd_arith as A
    from . import _pd_combine as CB
    from . import _pd_reduce as R
    from ._pd_column import column_from
    from ._pd_frame import DataFrame
    from ._pd_series import Series
    owner = "DataFrame.%s" % op
    if level is not None:
        raise _unsupported("%s(level=) (a MultiIndex)" % owner)
    ax = _axis(axis)
    other = A.operand(A.zerodim(other), owner, False)
    k, n = len(f._pd_cols), len(f)
    if isinstance(other, DataFrame):
        same = f._pd_index.equals(other._pd_index) and f._pd_columns.equals(other._pd_columns)
        if not method or same:
            if not same:
                raise ValueError("Can only compare identically-labeled (both index and columns) DataFrame objects")
            return _frame([R.compare(a, b, op) for a, b in zip(f._pd_cols, other._pd_cols)], f._pd_columns.copy(),
                          f._pd_index.copy())
        _unique_columns(f, owner)
        _unique_columns(other, owner)
        labels = CB.join_labels([f._pd_columns, other._pd_columns], "outer", True)
        labels = f._pd_columns.copy() if labels is None else labels
        rows = CB.join_labels([f._pd_index, other._pd_index], "outer", True)
        index = f._pd_index.copy() if rows is None else rows
        lpos = dict((lab, j) for j, lab in enumerate(f._pd_columns.tolist()))
        rpos = dict((lab, j) for j, lab in enumerate(other._pd_columns.tolist()))
        cols = []
        for lab in labels.tolist():
            left = _series_of(f, lpos[lab]) if lab in lpos else _missing_series(f._pd_index)
            right = _series_of(other, rpos[lab]) if lab in rpos else _missing_series(other._pd_index)
            s = left._pd_flex_compare(right, op, None, None, 0)
            cols.append(s._pd_col)
            index = s._pd_index
        return _frame(cols, labels, index)
    if isinstance(other, Series):
        if ax == 0:
            if not k:
                rows = CB.join_labels([f._pd_index, other._pd_index], "outer", True)
                return _frame([], f._pd_columns.copy(), f._pd_index.copy() if rows is None else rows)
            cols = []
            index = f._pd_index.copy()
            for j in range(k):
                s = _series_of(f, j)._pd_flex_compare(other, op, None, None, 0)
                cols.append(s._pd_col)
                index = s._pd_index
            return _frame(cols, f._pd_columns.copy(), index)
        if not method:
            if not other._pd_index.equals(f._pd_columns):
                raise ValueError("Operands are not aligned. Do `left, right = left.align(right, axis=1)` before "
                                 "operating.")
            return _frame([R.compare(c, r, op) for c, r in zip(f._pd_cols, _row_compare_columns(f, other))],
                          f._pd_columns.copy(), f._pd_index.copy())
        _unique_columns(f, owner)
        if not other._pd_index.is_unique:
            raise _unsupported("%s with a Series of repeated labels" % owner)
        labels = CB.join_labels([f._pd_columns, other._pd_index], "outer", True)
        labels = f._pd_columns.copy() if labels is None else labels
        lpos = dict((lab, j) for j, lab in enumerate(f._pd_columns.tolist()))
        rvals = _row_compare_columns(f, other)
        rpos = dict((lab, j) for j, lab in enumerate(other._pd_index.tolist()))
        cols = []
        for lab in labels.tolist():
            if lab in lpos and lab in rpos:
                cols.append(R.compare(f._pd_cols[lpos[lab]], rvals[rpos[lab]], op))
            else:
                cols.append(Column("bool", np.full(n, op == "ne", dtype=bool)))
        return _frame(cols, labels, f._pd_index.copy())
    if isinstance(other, Index):
        other = other.tolist()
    if isinstance(other, range):
        other = list(other)
    if isinstance(other, np.ndarray) and other.ndim == 2:
        return _frame([R.compare(c, column_from(a), op) for c, a in zip(f._pd_cols, _block_values(f, other))],
                      f._pd_columns.copy(), f._pd_index.copy())
    if isinstance(other, np.ndarray) and other.ndim > 2:
        raise _unsupported("%s with a %d-dimensional array" % (owner, other.ndim))
    if isinstance(other, (list, tuple, np.ndarray)):
        values = other.copy() if isinstance(other, np.ndarray) else list(other)
        if ax == 0:
            s = _column_values(f, values)
            return _frame([R.compare(c, s._pd_col, op) for c in f._pd_cols], f._pd_columns.copy(), f._pd_index.copy())
        if len(values) != k:
            raise ValueError("Unable to coerce to Series, length must be %d: given %d" % (k, len(values)))
        rights = _row_compare_columns(f, Series(values))
        return _frame([R.compare(c, r, op) for c, r in zip(f._pd_cols, rights)], f._pd_columns.copy(),
                      f._pd_index.copy())
    return _frame([R.compare(c, other, op) for c in f._pd_cols], f._pd_columns.copy(), f._pd_index.copy())
