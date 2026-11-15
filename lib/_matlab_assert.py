"""Octave's assert(observed, expected[, tol]), which MATLAB doesn't have (its assert's second argument is a message):
loaded by assert (lib/_matlab.py) when that form is used.  Written from Octave's documented behavior and checked
against what Octave 11.1 prints: the values are compared (class, size, then each element; text as text; cells and
structs element by element); a numeric-array mismatch lists its failing elements in an Octave-style table; cell and struct
comparisons stop at the first failing nested comparison."""

import cmath

import numpy as np

import _matlab as _m

_HEAD = "ASSERT errors for:  assert (%s)\n\n  Location  |  Observed  |  Expected  |  Reason\n"


def _center(s, w):
    pad = max(0, w - len(s))
    left = (pad + 1) // 2
    return " " * left + s + " " * (pad - left)


def _row(loc, obs, exp, why):
    return _center(loc, 11) + " " + _center(obs, 13) + _center(exp, 13) + "   " + why


def _fail(rows, call="cond,expected,tol"):
    raise _m.MatlabError(_HEAD % call + "\n".join(rows))


def _dimtext(d):
    return "x".join(str(int(x)) for x in d)


def _num(x):
    """an element as Octave's table shows it (num2str's text)"""
    if type(x) is int:
        x = float(x)
    return _m._text(_m.num2str_(x))


def _istext(v):
    return type(v) is _m.Char or type(v) is _m.Str


def _class(v):
    c = _m.class_(v)
    c = c if type(c) is str else _m._text(c)
    return "char" if c == "string" else c


def check(obs, exp, tol=0.0):
    """raise Octave's assertion error unless obs matches exp (within tol)"""
    if _istext(exp):
        if not _istext(obs):
            if _class(obs) in ("double", "single", "logical") or _class(obs).startswith(("int", "uint")):
                _fail([_row(".", _num(obs) if _m._numel(obs) == 1 else "O", "'%s'" % _m._text(exp),
                            "Expected string, but observed number")], "cond,expected,tol")
            _fail([_row(".", "O", "E", "Class %s != char" % _class(obs))])
        if _m._text(obs) != _m._text(exp) or _m._dims(obs) != _m._dims(exp):
            _fail([_row("[]", "'%s'" % _m._text(obs), "'%s'" % _m._text(exp), "Strings don't match")])
        return
    if _class(obs) != _class(exp):
        _fail([_row("()", "O", "E", "Class %s != %s" % (_class(obs), _class(exp)))])
    if _m._dims(obs) != _m._dims(exp):
        _fail([_row(".", "O(%s)" % _dimtext(_m._dims(obs)), "E(%s)" % _dimtext(_m._dims(exp)), "Dimensions don't match")])
    t = type(exp)
    if t is _m.Cell:
        for o, e in zip(obs.a, exp.a):
            check(o, e, tol)
        return
    if t is _m.Struct:
        if list(obs.fields) != list(exp.fields):
            _fail([_row(".", "O", "E", "Structure fieldname mismatch")])
        for do, de in zip(obs.a, exp.a):
            for f in exp.fields:
                check(do[f], de[f], tol)
        return
    _numeric(obs, exp, tol)


def _numeric(obs, exp, tol):
    O = [x.item() if hasattr(x, "item") else x for x in _m._arr(obs).ravel()]
    E = [x.item() if hasattr(x, "item") else x for x in _m._arr(exp).ravel()]
    n = len(E)
    if n == 0:
        return
    T = [float(x) for x in np.ravel(_m._farr(tol))]
    if len(T) == 1:
        T = T * n
    elif len(T) != n:
        raise _m._err("assert: the tolerance must be a scalar or have as many elements as the expected value.")
    d = [int(x) for x in _m._dims(exp)]
    vec = len(d) == 2 and min(d) == 1
    kind = _m._arr(exp).dtype.kind
    info = np.iinfo(_m._arr(exp).dtype) if kind in "iu" else None

    def loc(k):
        if n == 1:
            return "()"
        if vec:
            return "(%d)" % (k + 1)
        sub = []
        for m in d:
            sub.append(str(k % m + 1))
            k //= m
        return "(" + ",".join(sub) + ")"

    nan_rows, inf_rows, val_rows = [], [], []
    for k in range(n):
        ok, ek = O[k], E[k]
        o, e = complex(ok), complex(ek)
        if cmath.isnan(o) or cmath.isnan(e):
            if cmath.isnan(o) != cmath.isnan(e):
                nan_rows.append(_row(loc(k), _num(ok), _num(ek), "'NaN' mismatch"))
            continue
        if cmath.isinf(o) or cmath.isinf(e):
            if o != e:
                inf_rows.append(_row(loc(k), _num(ok), _num(ek), "'Inf' mismatch"))
            continue
        err = abs(o - e)
        if info is not None:
            # (in the integer class, as Octave subtracts: saturated)
            err = abs(min(max(float(ok) - float(ek), info.min), info.max))
        tk = T[k]
        if tk < 0 and e != 0:
            rel = abs(o - e) / abs(e)
            if rel > -tk:
                val_rows.append(_row(loc(k), _num(ok), _num(ek),
                                     "Rel err %s exceeds tol %s by %s" % (_g(rel, 5), _g(-tk, 5), _g(rel + tk, 1))))
        elif (o != e) if tk == 0 else (abs(o - e) > abs(tk)):
            val_rows.append(_row(loc(k), _num(ok), _num(ek),
                                 "Abs err %s exceeds tol %s by %s" % (_g(err, 5), _g(abs(tk), 5), _g(err - abs(tk), 1))))
    rows = nan_rows + inf_rows + val_rows
    if rows:
        _fail(rows)


def _g(x, p):
    return _m._text(_m.num2str_(float(x), _m.Char("%%.%dg" % p)))
