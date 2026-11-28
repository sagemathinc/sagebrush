"""An estimator's repr, as scikit-learn 1.9.1 prints it: sklearn/utils/_pprint.py's _EstimatorPrettyPrinter over the
parts of CPython 3.14's pprint.PrettyPrinter it relies on (_format, the dict, list, tuple, set and str printers,
_safe_key), ported here because they are private to pprint. Both are under the Python Software Foundation License
(NOTICE.md)."""

import re
from io import StringIO
from inspect import signature, Parameter

from ._sk_config import get_config

_BUILTIN_SCALARS = frozenset({str, bytes, bytearray, float, complex, bool, type(None)})


class _sk_safe_key:
    # (pprint's _safe_key: sorting unorderable objects by their type's name, then their id)
    __slots__ = ["obj"]

    def __init__(self, obj):
        self.obj = obj

    def __lt__(self, other):
        try:
            return self.obj < other.obj
        except TypeError:
            return (str(type(self.obj)), id(self.obj)) < (str(type(other.obj)), id(other.obj))


def _sk_safe_tuple(t):
    return _sk_safe_key(t[0]), _sk_safe_key(t[1])


def _sk_recursion(obj):
    return "<Recursion on %s with id=%s>" % (type(obj).__name__, id(obj))


def _sk_is_scalar_nan(x):
    return isinstance(x, float) and x != x


class _SkKeyValTuple(tuple):
    """A key-value pair of a dict being printed."""

    def __repr__(self):
        return tuple.__repr__(self)


class _SkKeyValTupleParam(_SkKeyValTuple):
    """A parameter-value pair of an estimator being printed."""


def _sk_is_estimator(obj):
    from .base import BaseEstimator
    return isinstance(obj, BaseEstimator)


def _sk_changed_params(estimator):
    # (the parameters given values other than their defaults; repr compares them, as sklearn's _changed_params)
    params = estimator.get_params(deep=False)
    init_params = {name: p.default for name, p in signature(type(estimator).__init__).parameters.items()}

    def has_changed(k, v):
        if k not in init_params:
            return True
        if init_params[k] is Parameter.empty:
            return True
        if _sk_is_estimator(v) and v.__class__ != init_params[k].__class__:
            return True
        if repr(v) != repr(init_params[k]) and not (_sk_is_scalar_nan(init_params[k]) and _sk_is_scalar_nan(v)):
            return True
        return False

    return {k: v for k, v in params.items() if has_changed(k, v)}


def _sk_safe_repr(obj, context, maxlevels, level, changed_only=False):
    typ = type(obj)
    if typ in _BUILTIN_SCALARS:
        return repr(obj), True, False
    r = typ.__repr__
    if issubclass(typ, dict) and r is dict.__repr__:
        if not obj:
            return "{}", True, False
        objid = id(obj)
        if maxlevels and level >= maxlevels:
            return "{...}", False, objid in context
        if objid in context:
            return _sk_recursion(obj), False, True
        context[objid] = 1
        readable = True
        recursive = False
        components = []
        level += 1
        for k, v in sorted(obj.items(), key=_sk_safe_tuple):
            krepr, kreadable, krecur = _sk_safe_repr(k, context, maxlevels, level, changed_only)
            vrepr, vreadable, vrecur = _sk_safe_repr(v, context, maxlevels, level, changed_only)
            components.append("%s: %s" % (krepr, vrepr))
            readable = readable and kreadable and vreadable
            if krecur or vrecur:
                recursive = True
        del context[objid]
        return "{%s}" % ", ".join(components), readable, recursive
    if (issubclass(typ, list) and r is list.__repr__) or (issubclass(typ, tuple) and r is tuple.__repr__):
        if issubclass(typ, list):
            if not obj:
                return "[]", True, False
            fmt = "[%s]"
        elif len(obj) == 1:
            fmt = "(%s,)"
        else:
            if not obj:
                return "()", True, False
            fmt = "(%s)"
        objid = id(obj)
        if maxlevels and level >= maxlevels:
            return fmt % "...", False, objid in context
        if objid in context:
            return _sk_recursion(obj), False, True
        context[objid] = 1
        readable = True
        recursive = False
        components = []
        level += 1
        for o in obj:
            orepr, oreadable, orecur = _sk_safe_repr(o, context, maxlevels, level, changed_only)
            components.append(orepr)
            if not oreadable:
                readable = False
            if orecur:
                recursive = True
        del context[objid]
        return fmt % ", ".join(components), readable, recursive
    if _sk_is_estimator(obj):
        objid = id(obj)
        if maxlevels and level >= maxlevels:
            return "%s(...)" % typ.__name__, False, objid in context
        if objid in context:
            return _sk_recursion(obj), False, True
        context[objid] = 1
        readable = True
        recursive = False
        params = _sk_changed_params(obj) if changed_only else obj.get_params(deep=False)
        components = []
        level += 1
        for k, v in sorted(params.items(), key=_sk_safe_tuple):
            krepr, kreadable, krecur = _sk_safe_repr(k, context, maxlevels, level, changed_only)
            vrepr, vreadable, vrecur = _sk_safe_repr(v, context, maxlevels, level, changed_only)
            components.append("%s=%s" % (krepr.strip("'"), vrepr))
            readable = readable and kreadable and vreadable
            if krecur or vrecur:
                recursive = True
        del context[objid]
        return "%s(%s)" % (typ.__name__, ", ".join(components)), readable, recursive
    rep = repr(obj)
    return rep, bool(rep and not rep.startswith("<")), False


class _SkPrettyPrinter:
    """sklearn's _EstimatorPrettyPrinter (compact, indent at the name, ellipsis after n_max_elements_to_show items)."""

    def __init__(self, width=80, n_max_elements_to_show=None):
        self._width = width
        self._indent_per_level = 1
        self._compact = True
        self._depth = None
        self._changed_only = get_config()["print_changed_only"]
        self.n_max_elements_to_show = n_max_elements_to_show

    def pformat(self, obj):
        stream = StringIO()
        self._format(obj, stream, 0, 0, {}, 0)
        return stream.getvalue()

    def _repr(self, obj, context, level):
        rep, readable, recursive = _sk_safe_repr(obj, dict(context), self._depth, level, self._changed_only)
        return rep

    def _dispatch(self, obj):
        r = type(obj).__repr__
        if r is dict.__repr__:
            return self._pprint_dict
        if r is list.__repr__:
            return self._pprint_list
        if r is tuple.__repr__:
            return self._pprint_tuple
        if r is set.__repr__ or r is frozenset.__repr__:
            return self._pprint_set
        if r is str.__repr__:
            return self._pprint_str
        if r is _SkKeyValTuple.__repr__:
            return self._pprint_key_val_tuple
        from .base import BaseEstimator
        if r is BaseEstimator.__repr__:
            return self._pprint_estimator
        return None

    def _format(self, obj, stream, indent, allowance, context, level):
        objid = id(obj)
        if objid in context:
            stream.write(_sk_recursion(obj))
            return
        rep = self._repr(obj, context, level)
        max_width = self._width - indent - allowance
        if len(rep) > max_width:
            p = self._dispatch(obj)
            if p is not None:
                context[objid] = 1
                p(obj, stream, indent, allowance, context, level + 1)
                del context[objid]
                return
        stream.write(rep)

    def _pprint_estimator(self, obj, stream, indent, allowance, context, level):
        stream.write(obj.__class__.__name__ + "(")
        indent += len(obj.__class__.__name__)
        params = _sk_changed_params(obj) if self._changed_only else obj.get_params(deep=False)
        self._format_params_or_dict_items(sorted(params.items()), stream, indent, allowance + 1, context, level, False)
        stream.write(")")

    def _pprint_dict(self, obj, stream, indent, allowance, context, level):
        stream.write("{")
        if len(obj):
            items = sorted(obj.items(), key=_sk_safe_tuple)
            self._format_params_or_dict_items(items, stream, indent, allowance + 1, context, level, True)
        stream.write("}")

    def _pprint_list(self, obj, stream, indent, allowance, context, level):
        stream.write("[")
        self._format_items(obj, stream, indent, allowance + 1, context, level)
        stream.write("]")

    def _pprint_tuple(self, obj, stream, indent, allowance, context, level):
        stream.write("(")
        endchar = ",)" if len(obj) == 1 else ")"
        self._format_items(obj, stream, indent, allowance + len(endchar), context, level)
        stream.write(endchar)

    def _pprint_set(self, obj, stream, indent, allowance, context, level):
        if not len(obj):
            stream.write(repr(obj))
            return
        typ = obj.__class__
        if typ is set:
            stream.write("{")
            endchar = "}"
        else:
            stream.write(typ.__name__ + "({")
            endchar = "})"
            indent += len(typ.__name__) + 1
        self._format_items(sorted(obj, key=_sk_safe_key), stream, indent, allowance + len(endchar), context, level)
        stream.write(endchar)

    def _pprint_str(self, obj, stream, indent, allowance, context, level):
        write = stream.write
        if not len(obj):
            write(repr(obj))
            return
        chunks = []
        lines = obj.splitlines(True)
        if level == 1:
            indent += 1
            allowance += 1
        max_width1 = max_width = self._width - indent
        rep = ""
        for i, line in enumerate(lines):
            rep = repr(line)
            if i == len(lines) - 1:
                max_width1 -= allowance
            if len(rep) <= max_width1:
                chunks.append(rep)
            else:
                parts = re.findall(r"\S*\s*", line)
                parts.pop()
                max_width2 = max_width
                current = ""
                for j, part in enumerate(parts):
                    candidate = current + part
                    if j == len(parts) - 1 and i == len(lines) - 1:
                        max_width2 -= allowance
                    if len(repr(candidate)) > max_width2:
                        if current:
                            chunks.append(repr(current))
                        current = part
                    else:
                        current = candidate
                if current:
                    chunks.append(repr(current))
        if len(chunks) == 1:
            write(rep)
            return
        if level == 1:
            write("(")
        for i, rep in enumerate(chunks):
            if i > 0:
                write("\n" + " " * indent)
            write(rep)
        if level == 1:
            write(")")

    def _pprint_key_val_tuple(self, obj, stream, indent, allowance, context, level):
        k, v = obj
        rep = self._repr(k, context, level)
        if isinstance(obj, _SkKeyValTupleParam):
            rep = rep.strip("'")
            middle = "="
        else:
            middle = ": "
        stream.write(rep)
        stream.write(middle)
        self._format(v, stream, indent + len(rep) + len(middle), allowance, context, level)

    def _format_params_or_dict_items(self, obj, stream, indent, allowance, context, level, is_dict):
        write = stream.write
        indent += self._indent_per_level
        delimnl = ",\n" + " " * indent
        delim = ""
        width = max_width = self._width - indent + 1
        it = iter(obj)
        try:
            next_ent = next(it)
        except StopIteration:
            return
        last = False
        n_items = 0
        while not last:
            if n_items == self.n_max_elements_to_show:
                write(", ...")
                break
            n_items += 1
            ent = next_ent
            try:
                next_ent = next(it)
            except StopIteration:
                last = True
                max_width -= allowance
                width -= allowance
            k, v = ent
            krepr = self._repr(k, context, level)
            vrepr = self._repr(v, context, level)
            if not is_dict:
                krepr = krepr.strip("'")
            middle = ": " if is_dict else "="
            rep = krepr + middle + vrepr
            w = len(rep) + 2
            if width < w:
                width = max_width
                if delim:
                    delim = delimnl
            if width >= w:
                width -= w
                write(delim)
                delim = ", "
                write(rep)
                continue
            write(delim)
            delim = delimnl
            cls = _SkKeyValTuple if is_dict else _SkKeyValTupleParam
            self._format(cls(ent), stream, indent, allowance if last else 1, context, level)

    def _format_items(self, items, stream, indent, allowance, context, level):
        write = stream.write
        indent += self._indent_per_level
        delimnl = ",\n" + " " * indent
        delim = ""
        width = max_width = self._width - indent + 1
        it = iter(items)
        try:
            next_ent = next(it)
        except StopIteration:
            return
        last = False
        n_items = 0
        while not last:
            if n_items == self.n_max_elements_to_show:
                write(", ...")
                break
            n_items += 1
            ent = next_ent
            try:
                next_ent = next(it)
            except StopIteration:
                last = True
                max_width -= allowance
                width -= allowance
            rep = self._repr(ent, context, level)
            w = len(rep) + 2
            if width < w:
                width = max_width
                if delim:
                    delim = delimnl
            if width >= w:
                width -= w
                write(delim)
                delim = ", "
                write(rep)
                continue
            write(delim)
            delim = delimnl
            self._format(ent, stream, indent, allowance if last else 1, context, level)


def estimator_repr(estimator, N_CHAR_MAX=700):
    """BaseEstimator.__repr__: the pretty-printed form, cut in the middle past N_CHAR_MAX non-blank characters."""
    repr_ = _SkPrettyPrinter(n_max_elements_to_show=30).pformat(estimator)
    n_nonblank = len("".join(repr_.split()))
    if n_nonblank > N_CHAR_MAX:
        lim = N_CHAR_MAX // 2
        regex = r"^(\s*\S){%d}" % lim
        left_lim = re.match(regex, repr_).end()
        right_lim = re.match(regex, repr_[::-1]).end()
        if "\n" in repr_[left_lim:-right_lim]:
            regex += r"[^\n]*\n"
            right_lim = re.match(regex, repr_[::-1]).end()
        if left_lim + len("...") < len(repr_) - right_lim:
            repr_ = repr_[:left_lim] + "..." + repr_[-right_lim:]
    return repr_
