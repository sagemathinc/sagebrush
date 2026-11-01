"""Options: get_option, set_option, reset_option, option_context and
pd.options, ported from pandas 3.1.0 pandas/_config/config.py (BSD-3-Clause,
see THIRD-PARTY-NOTICES.txt) and the validators of
pandas/core/config_init.py.

M1 supports six keys (plan-pandas-m1-r1 §4): display.max_rows,
display.min_rows, display.max_columns, display.width, display.precision and
display.max_colwidth.  A pattern is matched against all of pandas 3.1.0's
option names, so a pattern pandas finds ambiguous is ambiguous here too; one
that names any other pandas option raises NotImplementedError.
"""

import re

from .errors import OptionError

__all__ = ["get_option", "set_option", "reset_option", "option_context", "options", "describe_option"]

# (pandas 3.1.0's registered options, by name, as the oracle lists them)
_PANDAS_KEYS = (
    "compute.use_bottleneck", "compute.use_numba", "compute.use_numexpr",
    "display.chop_threshold", "display.colheader_justify", "display.date_dayfirst",
    "display.date_yearfirst", "display.encoding", "display.expand_frame_repr",
    "display.float_format", "display.html.border", "display.html.table_schema",
    "display.html.use_mathjax", "display.large_repr", "display.max_categories",
    "display.max_columns", "display.max_colwidth", "display.max_dir_items",
    "display.max_info_columns", "display.max_info_rows", "display.max_rows",
    "display.max_seq_items", "display.memory_usage", "display.min_rows",
    "display.multi_sparse", "display.notebook_repr_html", "display.pprint_nest_depth",
    "display.precision", "display.show_dimensions", "display.unicode.ambiguous_as_wide",
    "display.unicode.east_asian_width", "display.width", "future.distinguish_nan_and_na",
    "future.infer_freq_returns_offset", "future.infer_string", "future.no_silent_downcasting",
    "future.python_scalars", "io.excel.ods.reader", "io.excel.ods.writer",
    "io.excel.xls.reader", "io.excel.xlsb.reader", "io.excel.xlsm.reader",
    "io.excel.xlsm.writer", "io.excel.xlsx.reader", "io.excel.xlsx.writer",
    "io.hdf.default_format", "io.hdf.dropna_table", "io.parquet.engine", "io.sql.engine",
    "mode.chained_assignment", "mode.copy_on_write", "mode.max_threads",
    "mode.performance_warnings", "mode.sim_interactive", "mode.string_storage",
    "plotting.backend", "plotting.matplotlib.register_converters", "styler.format.decimal",
    "styler.format.escape", "styler.format.formatter", "styler.format.na_rep",
    "styler.format.precision", "styler.format.thousands", "styler.html.mathjax",
    "styler.latex.environment", "styler.latex.hrules", "styler.latex.multicol_align",
    "styler.latex.multirow_align", "styler.render.encoding", "styler.render.max_columns",
    "styler.render.max_elements", "styler.render.max_rows", "styler.render.repr",
    "styler.sparse.columns", "styler.sparse.index",
)


def _is_nonnegative_int(value):
    if value is None:
        return
    elif isinstance(value, int):
        if value >= 0:
            return
    raise ValueError("Value must be a nonnegative integer or None")


def _is_none_or_int(x):
    if not (x is None or isinstance(x, int)):
        raise ValueError("Value must be an instance of <class 'NoneType'>|<class 'int'>")


# (key: (default, validator)); max_columns is 0, pandas' default outside a
# Jupyter kernel, the oracle's
_SUPPORTED = {
    "display.max_rows": (60, _is_nonnegative_int),
    "display.min_rows": (10, _is_none_or_int),
    "display.max_columns": (0, _is_nonnegative_int),
    "display.width": (80, _is_none_or_int),
    "display.precision": (6, _is_nonnegative_int),
    "display.max_colwidth": (50, _is_nonnegative_int),
}

_pd_values = dict((k, v[0]) for k, v in _SUPPORTED.items())


def _select_options(pat):
    if pat in _PANDAS_KEYS:
        return [pat]
    keys = sorted(_PANDAS_KEYS)
    if pat == "all":
        return keys
    return [k for k in keys if re.search(pat, k, re.I)]


def _get_single_key(pat):
    keys = _select_options(pat)
    if len(keys) == 0:
        raise OptionError("No such keys(s): %r" % (pat,))
    if len(keys) > 1:
        raise OptionError("Pattern matched multiple keys")
    return _supported(keys[0])


def _supported(key):
    if key not in _SUPPORTED:
        raise NotImplementedError("pandas option %r is not in Sagebrush's pandas 0.x subset" % (key,))
    return key


def get_option(pat):
    return _pd_values[_get_single_key(pat)]


def _set(args):
    if len(args) == 1 and isinstance(args[0], dict):
        args = tuple(kv for item in args[0].items() for kv in item)
    nargs = len(args)
    if not nargs or nargs % 2 != 0:
        raise ValueError("Must provide an even number of non-keyword arguments")
    for k, v in zip(args[::2], args[1::2]):
        key = _get_single_key(k)
        _SUPPORTED[key][1](v)
        _pd_values[key] = v


def set_option(*args):
    _set(args)


def reset_option(pat):
    keys = _select_options(pat)
    if len(keys) == 0:
        raise OptionError("No such keys(s) for pat=%r" % (pat,))
    if len(keys) > 1 and len(pat) < 4 and pat != "all":
        raise ValueError(
            "You must specify at least 4 characters when "
            "resetting multiple keys, use the special keyword "
            '"all" to reset all the options to their default value'
        )
    if pat == "all" or len(keys) > 1:
        # (pandas resets each; M1 resets the supported ones and refuses a
        # pattern that would reach others only if it names no supported key)
        sup = [k for k in keys if k in _SUPPORTED]
        if not sup:
            _supported(keys[0])
        keys = sup
    for k in keys:
        _supported(k)
        _pd_values[k] = _SUPPORTED[k][0]


def describe_option(pat="", _print_desc=True):
    raise NotImplementedError("pandas.describe_option is not in Sagebrush's pandas 0.x subset")


class option_context(object):
    """with pd.option_context(pat, val, ...): set options, restore on exit."""

    __slots__ = ("_pd_ops", "_pd_undo")

    def __init__(self, *args):
        if len(args) == 1 and isinstance(args[0], dict):
            args = tuple(kv for item in args[0].items() for kv in item)
        if len(args) % 2 != 0 or len(args) < 2:
            raise ValueError(
                "Provide an even amount of arguments as "
                "option_context(pat, val, pat, val...)."
            )
        self._pd_ops = tuple(zip(args[::2], args[1::2]))
        self._pd_undo = ()

    def __enter__(self):
        self._pd_undo = tuple((pat, get_option(pat)) for pat, val in self._pd_ops)
        for pat, val in self._pd_ops:
            _set((pat, val))

    def __exit__(self, *exc):
        for pat, val in self._pd_undo:
            _set((pat, val))
        return False


def _options(prefix):
    """pd.options at a prefix: attribute access to the options, as
    pandas' DictWrapper (a class per prefix holds it)."""

    def children():
        p = prefix + "." if prefix else ""
        return set(k[len(p):].split(".")[0] for k in _PANDAS_KEYS if k.startswith(p))

    def full(key):
        return (prefix + "." if prefix else "") + key

    class _Options(object):
        __slots__ = ()

        def __getattr__(self, key):
            if key not in children():
                raise OptionError("No such option")
            if full(key) in _PANDAS_KEYS:
                return get_option(full(key))
            return _options(full(key))

        def __setattr__(self, key, val):
            if key in children() and full(key) in _PANDAS_KEYS:
                set_option(full(key), val)
            else:
                raise OptionError("You can only set the value of existing options")

        def __dir__(self):
            return sorted(children())

    return _Options()


options = _options("")
