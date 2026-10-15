"""More of MATLAB's built-ins, for lib/_matlab.py: split, join and replace, the
conversions between numbers and binary or hexadecimal text (dec2bin,
dec2hex, bin2dec, hex2dec), sub2ind and ind2sub, and mat2cell, as their
documentation pages describe them.  Where a page leaves a case open,
these give an error rather than a guess (design/matlab.md).
"""

import math as _math

import numpy as np

import _matlab as _m
from _matlab import _bi, _err, Cell, Char, Str, StrArr

_WSPACE = " \t\n\r\f\v"  # (isspace's characters)


# ------------------------------------------------------------------ text: split and replace


def _texts(v, name, what="str"):
    """v's elements as Python strings, its dimensions, and whether it is a
    string (or string array): a character vector, string, string array or
    cell array of character vectors"""
    t = type(v)
    if t is Char:
        d = _m._dims(v)
        if len(d) > 2 or (d[0] > 1 and _m._numel(v) > 0):
            raise _err("%s: %s must be a character vector, not a character matrix." % (name, what))
        return [v.text()], (1, 1), False
    if t is Str:
        if v.s is None:
            raise _err("%s: %s must not be a missing string." % (name, what))
        return [v.s], (1, 1), True
    if t is StrArr:
        if any(s is None for s in v.a):
            raise _err("%s: %s must not contain missing strings." % (name, what))
        return list(v.a), v.shape, True
    if t is Cell:
        out = []
        for e in v.a:
            if type(e) is not Char:
                raise _err("%s: %s must be text: a cell array's elements must be character vectors." % (name, what))
            out.append(_texts(e, name, what)[0][0])
        return out, v.shape, False
    raise _err("%s: %s must be a string array, character vector or cell array of character vectors, not %s." % (name, what, _m.class_(v)))


def _as(strings, dims, isstr):
    """Python strings, column-major, as a string array or a cell array of
    character vectors, without trailing singleton dimensions (as Cell's are)"""
    dims = _m._canon_dims(dims)
    if isstr:
        return _m._strarr(list(strings), dims) if _m._prod(dims) != 1 else Str(strings[0])
    return Cell([Char(s) for s in strings], dims)


def _linear(sub, dims):
    k, stride = 0, 1
    for s, d in zip(sub, dims):
        k += s * stride
        stride *= d
    return k


def _subs(k, dims):
    out = []
    for d in dims:
        out.append(k % d)
        k //= d
    return out


@_bi("split")
def split_(nargout, *args):
    """newStr = split(str), split(str, delimiter), split(str, delimiter, dim):
    str divided at the delimiters (whitespace characters when there is none),
    which the pieces do not include; [newStr, match] = split(...) also
    returns the delimiters found.

    With several delimiters the leftmost match is taken, and of those that
    begin at the same character the first listed.  Consecutive delimiters
    give empty pieces.  The pieces go along the first trailing dimension of
    str of size 1, or along dim.  With the default delimiter, Sagebrush
    refuses text that begins or ends with whitespace or has adjacent
    whitespace characters (MATLAB's documentation does not say what split
    makes of them): give the delimiter."""
    if not 1 <= len(args) <= 3:
        raise _err("Not enough input arguments." if not args else "Too many input arguments.")
    if nargout > 2:
        raise _err("Too many output arguments.", "MATLAB:TooManyOutputs")
    texts, dims, isstr = _texts(args[0], "split")
    if len(args) >= 2:
        delims, _, _ = _texts(args[1], "split", "delimiter")
        if any(d == "" for d in delims):
            raise _err("split: a delimiter must not be empty.")
        if not delims:
            raise _err("split: delimiter must not be empty.")
    else:
        delims = list(_WSPACE)
        for t in texts:
            if t and (t[0] in _WSPACE or t[-1] in _WSPACE or any(a in _WSPACE and b in _WSPACE for a, b in zip(t, t[1:]))):
                raise _err("split: Sagebrush splits at whitespace only where it separates text, one whitespace character at a time; "
                           "for text that begins or ends with whitespace, or has adjacent whitespace characters, give the delimiter.")
    pieces, matches = [], []
    for t in texts:
        p, mt = [], []
        start = i = 0
        while i < len(t):
            for d in delims:
                if t.startswith(d, i):
                    p.append(t[start:i])
                    mt.append(d)
                    i += len(d)
                    start = i
                    break
            else:
                i += 1
        p.append(t[start:])
        pieces.append(p)
        matches.append(mt)
    n = len(pieces[0]) if pieces else 1
    if any(len(p) != n for p in pieces):
        raise _err("split: every element of str must split into the same number of pieces; split them one at a time.")
    dims = list(dims)
    nonsingle = [k for k, d in enumerate(dims) if d != 1]
    transpose = False
    if len(args) == 3:
        dim = _m._int_arg(args[2], "dimension")
        if dim < 1:
            raise _err("split: dim must be a positive integer.")
        dim -= 1
        if dim < len(dims) and dims[dim] != 1:
            # (the documented case: an M-by-1 array's pieces along the rows, an N-by-M result)
            if dim == 0 and len(dims) == 2 and dims[1] == 1:
                transpose = True
                dims = [1, dims[0]]
            else:
                raise _err("split: str has more than one element along dimension %d, so the pieces cannot go along it." % (dim + 1))
    else:
        dim = nonsingle[-1] + 1 if nonsingle else 0
    while len(dims) <= dim:
        dims.append(1)

    def place(lists, count):
        od = list(dims)
        od[dim] = count
        out = [None] * _m._prod(od)
        for k, lst in enumerate(lists):
            sub = _subs(k, dims)
            for j, s in enumerate(lst):
                sub[dim] = j
                out[_linear(sub, od)] = s
        return _as(out, od, isstr)
    r = place(pieces, n)
    return r if nargout < 2 else [r, place(matches, n - 1)]


@_bi("replace")
def replace_(nargout, *args):
    """newStr = replace(str, old, new): every occurrence of old in str
    replaced by new, scanning from the left; occurrences do not overlap.
    old can list several substrings, new one or as many as old.  Where two
    of them begin at the same character the first listed is replaced if it
    is also the longest; otherwise Sagebrush gives an error, as MATLAB's
    documentation does not say which wins."""
    if len(args) != 3:
        raise _err("Not enough input arguments." if len(args) < 3 else "Too many input arguments.")
    texts, dims, _ = _texts(args[0], "replace")
    olds, odims, _ = _texts(args[1], "replace", "old")
    news, ndims, _ = _texts(args[2], "replace", "new")
    if any(o == "" for o in olds):
        raise _err("replace: old must not be empty text.")
    if len(news) != 1 and (len(news) != len(olds) or tuple(ndims) != tuple(odims)):
        raise _err("replace: new must be one piece of text or the same size as old.")
    if len(news) == 1:
        news = news * len(olds)

    def one(t):
        out = []
        i = 0
        while i < len(t):
            hits = [k for k, o in enumerate(olds) if t.startswith(o, i)]
            if not hits:
                out.append(t[i])
                i += 1
                continue
            k = hits[0]
            if any(len(olds[h]) > len(olds[k]) for h in hits):
                raise _err("replace: '%s' and '%s' both begin at character %d; Sagebrush does not choose between them." % (olds[k], olds[max(hits, key=lambda h: len(olds[h]))], i + 1))
            out.append(news[k])
            i += len(olds[k])
        return "".join(out)
    v = args[0]
    res = [one(t) for t in texts]
    if type(v) is Char:
        return Char(res[0])
    if type(v) is Str:
        return Str(res[0])
    return _as(res, dims, type(v) is StrArr)


@_bi("join")
def join_(nargout, *args):
    """newStr = join(str), join(str, delimiter), join(str, dim),
    join(str, delimiter, dim): the text of a string array or cell array of
    character vectors joined along dim (by default the last dimension whose
    size is not 1), with a space or the delimiter between the elements; the
    result has str's type and size 1 along dim.  An array of delimiters has
    one fewer element than str along dim, and along each other dimension
    either str's size or 1.  Delimiters are literal text."""
    if not 1 <= len(args) <= 3:
        raise _err("Not enough input arguments." if not args else "Too many input arguments.")
    v = args[0]
    if type(v) not in (Str, StrArr, Cell):
        raise _err("join: str must be a string array or a cell array of character vectors, not %s." % _m.class_(v))
    texts, dims, isstr = _texts(v, "join")
    rest = list(args[1:])
    dim = None
    if rest and _m._isnumlike(rest[-1]) and type(rest[-1]) is not Char:
        dim = _m._int_arg(rest.pop(), "dimension")
        if dim < 1:
            raise _err("join: dim must be a positive integer.")
        dim -= 1
    if len(rest) > 1:
        raise _err("join: the arguments are str, then a delimiter, then dim.")
    S = list(dims)
    if dim is None:
        nonsingle = [k for k, d in enumerate(S) if d != 1]
        dim = nonsingle[-1] if nonsingle else 0
    while len(S) <= dim:
        S.append(1)
    n = S[dim]
    if n == 0:
        raise _err("join: str has no elements along dimension %d; Sagebrush does not join nothing (the page leaves the result open)." % (dim + 1))
    if rest:
        delims, ddims, _ = _texts(rest[0], "join", "delimiter")
        D = list(ddims)
    else:
        delims, D = [" "], [1, 1]
    while len(D) < len(S):
        D.append(1)
    if len(D) > len(S) and any(d != 1 for d in D[len(S):]):
        raise _err("join: delimiter has more dimensions than str.")
    D = D[:len(S)]
    single = len(delims) == 1
    if not single:
        bad = D[dim] != n - 1 or any(D[k] not in (1, S[k]) for k in range(len(S)) if k != dim)
        if bad:
            raise _err("join: delimiter must have %d element%s along dimension %d (one fewer than str), and along each other dimension str's size or 1." % (n - 1, "" if n == 2 else "s", dim + 1))
    O = list(S)
    O[dim] = 1
    out = []
    for k in range(_m._prod(O)):
        sub = _subs(k, O)
        parts = []
        for j in range(n):
            if j:
                if single:
                    parts.append(delims[0])
                else:
                    ds = [0 if D[q] == 1 else sub[q] for q in range(len(S))]
                    ds[dim] = j - 1
                    parts.append(delims[_linear(ds, D)])
            sub[dim] = j
            parts.append(texts[_linear(sub, S)])
            sub[dim] = 0
        out.append("".join(parts))
    return _as(out, O, isstr)


# ------------------------------------------------------------------ numbers as binary and hexadecimal text


def _base_text(name, args, radix):
    if not 1 <= len(args) <= 2:
        raise _err("Not enough input arguments." if not args else "Too many input arguments.")
    D = args[0]
    cls = _m.class_(D)
    if not (_m._isnumlike(D) and type(D) is not _m.Sparse) or cls in ("cell", "struct", "string"):
        raise _err("%s: D must be a numeric, logical or char array, not %s." % (name, cls))
    mind = 0
    if len(args) == 2:
        x = _m._scalar(args[1], "minDigits")
        if not (x >= 0 and x == _math.floor(x) and _math.isfinite(x)):
            raise _err("%s: minDigits must be a nonnegative integer." % name)
        mind = int(x)
    A = _m._arr(D)
    if A.dtype.kind == "c":
        raise _err("%s: D must be real." % name)
    if A.size == 0:
        raise _err("%s: Sagebrush does not convert an empty array (MATLAB's documentation leaves the result open)." % name)
    vals = []
    for x in A.reshape(-1):  # (column-major: one row per element)
        if A.dtype.kind in "iu":
            v = int(x)
            if v < 0:
                raise _err("%s: Sagebrush does not convert negative values of an integer class (MATLAB's documentation leaves their width open); convert them to double first." % name)
        else:
            x = float(x)
            if not _math.isfinite(x):
                raise _err("%s: D must contain finite values." % name)
            if radix == 16 and x != _math.floor(x):
                raise _err("dec2hex: D must contain integers: %s has a fractional part." % _m._num2str_g(x))
            v = int(_math.floor(x))  # (dec2bin: the integer at most x)
        if not -(1 << 63) <= v < (1 << 64):
            raise _err("%s: D's values must be at least intmin('int64') and less than 2^64." % name)
        vals.append(v)
    lo = min(vals)
    pad = "0"
    if lo < 0:
        # (two's complement in the narrowest of 8, 16, 32 and 64 bits that holds every value)
        hi = max(vals)
        for w in (8, 16, 32, 64):
            if -(1 << (w - 1)) <= lo and hi < (1 << (w - 1)):
                break
        else:
            raise _err("%s: with negative values, D's values must fit in a signed 64-bit integer." % name)
        vals = [v + (1 << w) if v < 0 else v for v in vals]
        bits = w
    else:
        bits = 0
    digits = [format(v, "b" if radix == 2 else "X") for v in vals]
    per = 1 if radix == 2 else 4
    width = max(max(len(s) for s in digits), mind, bits // per)
    rows = []
    for s, v0 in zip(digits, vals):
        neg = bits and v0 >= (1 << (bits - 1))
        rows.append(("1" if radix == 2 else "F") * (width - len(s)) + s if neg else s.rjust(width, pad))
    return _m._rows_char(rows)


@_bi("dec2bin")
def dec2bin_(nargout, *args):
    """binStr = dec2bin(D), dec2bin(D, minDigits): the binary digits of the
    integers in D, one row per element, at least minDigits of them.
    Fractions are rounded down; negative numbers are two's complement in
    the narrowest of 8, 16, 32 and 64 bits that holds every element, and
    are padded with ones."""
    return _base_text("dec2bin", args, 2)


@_bi("dec2hex")
def dec2hex_(nargout, *args):
    """hexStr = dec2hex(D), dec2hex(D, minDigits): the hexadecimal digits
    (0-9, A-F) of the integers in D, one row per element, at least
    minDigits of them.  D must hold integers; negative numbers are two's
    complement in the narrowest of 8, 16, 32 and 64 bits that holds every
    element, and are padded with F."""
    return _base_text("dec2hex", args, 16)


_SUFFIX = {"u8": ("uint", 8), "u16": ("uint", 16), "u32": ("uint", 32), "u64": ("uint", 64),
           "s8": ("int", 8), "s16": ("int", 16), "s32": ("int", 32), "s64": ("int", 64)}


def _parse_base(name, t, radix):
    s = t.strip(" ")
    prefix = "0b" if radix == 2 else "0x"
    ok = "01" if radix == 2 else "0123456789abcdefABCDEF"
    kind = None
    if s[:2].lower() == prefix:
        s = s[2:]
        for suf in sorted(_SUFFIX, key=len, reverse=True):
            if s.endswith(suf) and len(s) > len(suf):
                kind = _SUFFIX[suf]
                s = s[:-len(suf)]
                break
    if not s or any(c not in ok for c in s):
        raise _err("%s: '%s' is not %s text." % (name, t, "binary" if radix == 2 else "hexadecimal"))
    if radix == 2 and len(s) > 53:
        raise _err("bin2dec: '%s' has more than 53 binary digits." % t)
    v = int(s, radix)
    if kind:
        sign, w = kind
        if v >= (1 << w):
            raise _err("%s: '%s' does not fit in its %s%d suffix's %d bits." % (name, t, sign, w, w))
        if sign == "int" and v >= (1 << (w - 1)):
            v -= 1 << w
    return v


def _from_base(name, args, radix):
    if len(args) != 1:
        raise _err("Not enough input arguments." if not args else "Too many input arguments.")
    v = args[0]
    t = type(v)
    if t is Char:
        d = _m._dims(v)
        if len(d) > 2:
            raise _err("%s: the text must be a character vector or matrix." % name)
        if _m._numel(v) == 0:
            raise _err("%s: Sagebrush does not convert empty text (MATLAB's documentation leaves the result open)." % name)
        texts, shape = v.rows(), (d[0], 1)
    elif t is Cell:
        texts = []
        for e in v.a:
            if type(e) is not Char or _m._dims(e)[0] > 1 and _m._numel(e) > 0:
                raise _err("%s: a cell array's elements must be character vectors." % name)
            texts.append(e.text())
        shape = (len(texts), 1)
    elif t is Str or t is StrArr:
        texts = [v.s] if t is Str else list(v.a)
        if any(s is None for s in texts):
            raise _err("%s: the text must not contain missing strings." % name)
        shape = (1, 1) if t is Str else v.shape
    else:
        raise _err("%s: the text must be a character array, cell array of character vectors or string array, not %s." % (name, _m.class_(v)))
    vals = [_parse_base(name, s, radix) for s in texts]
    if any(abs(x) >= 2 ** 53 for x in vals):
        _m.warning_("%s: a value of at least flintmax (2^53) might not be represented exactly as a double." % name)
    return _m._box(np.array([float(x) for x in vals], dtype=float).reshape(_m._stored(shape)))


@_bi("bin2dec")
def bin2dec_(nargout, *args):
    """D = bin2dec(binStr): the binary integers that binStr's text
    represents, as doubles: one per row of a character matrix or element
    of a cell array (a column), or per element of a string array (its
    shape).  The text may have the prefix 0b and a type suffix of binary
    literals (0b11111111s8 is -1); at most 53 digits.  Spaces around the
    digits are ignored; any other character is an error."""
    return _from_base("bin2dec", args, 2)


@_bi("hex2dec")
def hex2dec_(nargout, *args):
    """D = hex2dec(hexStr): the hexadecimal integers (0-9 and A-F or a-f)
    that hexStr's text represents, as doubles: one per row of a character
    matrix or element of a cell array (a column), or per element of a
    string array (its shape).  The text may have the prefix 0x and a type
    suffix of hexadecimal literals (0xFFs8 is -1).  Spaces around the
    digits are ignored; any other character is an error.  A value of at
    least flintmax gives a warning: it might not be exact."""
    return _from_base("hex2dec", args, 16)


# ------------------------------------------------------------------ subscripts and linear indices


def _size_vec(name, sz):
    a = _m._farr(sz, name) if _m._isnumlike(sz) and type(sz) is not Char else None
    if a is None or a.dtype.kind == "c" or a.size == 0 or min(_m._dims(sz)) != 1 and a.size != 1 or len(_m._dims(sz)) > 2:
        raise _err("%s: sz must be a vector of positive integers." % name)
    d = [float(x) for x in a.reshape(-1)]
    if any(not (x >= 1 and x == _math.floor(x) and _math.isfinite(x)) for x in d):
        raise _err("%s: sz must be a vector of positive integers." % name)
    return [int(x) for x in d]


def _int_array(name, v, what):
    if not _m._isnumlike(v) or type(v) is Char or type(v) is _m.Sparse:
        raise _err("%s: %s must be numeric, not %s." % (name, what, _m.class_(v)))
    a = _m._arr(v)
    if a.dtype.kind == "c":
        raise _err("%s: %s must be real." % (name, what))
    f = a.astype(float) if a.dtype.kind != "f" else a
    if f.size and (not np.all(np.isfinite(f)) or np.any(f != np.floor(f)) or np.any(f < 1)):
        raise _err("%s: %s must be positive integers." % (name, what))
    return a, _m._dims(v)


_EXACT = 2 ** 53  # (every integer up to it is a double)


def _exact(name, vals):
    """Python integers as doubles, refused unless each is one exactly"""
    out = np.array([float(v) for v in vals], dtype=float)
    for v, f in zip(vals, out.reshape(-1)):
        if int(f) != v:
            raise _err("%s: the result %d is not exactly a double (above 2^53); Sagebrush does not round it." % (name, v))
    return out


@_bi("sub2ind")
def sub2ind_(nargout, *args):
    """ind = sub2ind(sz, I1, ..., In): the linear indices of the elements
    at subscripts I1, ..., In of an array of size sz: one subscript for
    each element of sz (trailing ones may be added).  The subscripts are
    arrays of the same size, or scalars, which expand.  The arithmetic is
    exact; an index above 2^53 that is not exactly a double is an error."""
    if len(args) < 2:
        raise _err("Not enough input arguments.")
    d = _size_vec("sub2ind", args[0])
    subs = [_int_array("sub2ind", v, "the subscripts") for v in args[1:]]
    n = len(subs)
    if n < len(d):
        raise _err("sub2ind: give one subscript for each of sz's %d dimensions." % len(d))
    d = d + [1] * (n - len(d))
    shapes = {dims for a, dims in subs if a.size != 1}
    if len(shapes) > 1:
        raise _err("sub2ind: the subscripts must be the same size, or scalars.")
    shape = shapes.pop() if shapes else (1, 1)
    count = _m._prod(shape)
    for k, ((a, _), dk) in enumerate(zip(subs, d)):
        if a.size and float(np.max(a)) > dk:
            raise _err("sub2ind: subscript %d is out of range: at most %d." % (k + 1, dk))
    if _m._prod(d) <= _EXACT:
        # (every partial sum is an integer of at most prod(sz): exact in doubles)
        ind = np.zeros(count)
        stride = 1
        for (a, _), dk in zip(subs, d):
            ind = ind + (a.reshape(-1).astype(float) - 1) * stride
            stride *= dk
        return _m._box((ind + 1).reshape(_m._stored(shape)))
    # (larger arrays: in integers, then refused if a result is not a double exactly)
    cols = [[int(x) for x in a.reshape(-1)] for a, _ in subs]
    out = []
    for i in range(count):
        v, stride = 0, 1
        for col, dk in zip(cols, d):
            v += (col[i if len(col) > 1 else 0] - 1) * stride
            stride *= dk
        out.append(v + 1)
    return _m._box(_exact("sub2ind", out).reshape(_m._stored(shape)))


@_bi("ind2sub")
def ind2sub_(nargout, *args):
    """[I1, ..., In] = ind2sub(sz, ind): the subscripts of the elements at
    linear indices ind of an array of size sz, each the size of ind.  With
    fewer outputs than sz has elements, the last output counts along the
    remaining dimensions taken together; the last subscript is not bounded,
    the array growing along its last dimension as indexing would.  sz has
    two or more elements (a scalar is an error since R2024b: [n 1] for a
    column).  The arithmetic is exact; a subscript above 2^53 that is not
    exactly a double is an error."""
    if len(args) != 2:
        raise _err("Not enough input arguments." if len(args) < 2 else "Too many input arguments.")
    d = _size_vec("ind2sub", args[0])
    if len(d) < 2:
        # (R2024b: "a scalar input for sz results in an error")
        raise _err("ind2sub: sz must be a vector of positive integers with two or more elements; for a column of n elements, give [n 1].")
    a, shape = _int_array("ind2sub", args[1], "ind")
    k = max(1, nargout)
    if k < len(d):
        d = d[:k - 1] + [_m._prod(d[k - 1:])]
    d = d + [1] * (k - len(d))
    if not a.size or float(np.max(a)) + max(d) < 2.0 ** 52:
        # (then r // d and r mod d of doubles are exact: r/d rounds to no integer above it)
        r = a.reshape(-1).astype(float) - 1
        outs = []
        for j in range(k - 1):
            outs.append(np.mod(r, d[j]) + 1)
            r = np.floor(r / d[j])
        outs.append(r + 1)
    else:
        # (in integers, then refused if a subscript is not a double exactly)
        rs = [int(x) - 1 for x in a.reshape(-1)]
        cols = []
        for j in range(k - 1):
            cols.append([x % d[j] + 1 for x in rs])
            rs = [x // d[j] for x in rs]
        cols.append([x + 1 for x in rs])
        outs = [_exact("ind2sub", c) for c in cols]
    outs = [_m._box(o.reshape(_m._stored(shape))) for o in outs]
    return outs[0] if k == 1 else outs


# ------------------------------------------------------------------ mat2cell


@_bi("mat2cell")
def mat2cell_(nargout, *args):
    """C = mat2cell(A, dim1Dist, ..., dimNDist): A divided into the cells of
    C, dimKDist giving the sizes of the pieces along dimension K, which
    must add up to A's size there.  Dimensions without a distribution are
    not divided: C = mat2cell(A, rowDist) is a column of cells."""
    if len(args) < 2:
        raise _err("Not enough input arguments.")
    A = args[0]
    if _m._iscallable(A):
        raise _err("mat2cell: A must be an array, not a function handle.")
    D = list(_m._dims(A))
    dists = []
    for k, v in enumerate(args[1:]):
        if not _m._isnumlike(v) or type(v) is Char or type(v) is _m.Sparse:
            raise _err("mat2cell: the distributions must be numeric vectors.")
        a = _m._farr(v, "mat2cell")
        f = [float(x) for x in a.reshape(-1)] if a.dtype.kind != "c" else None
        if f is None or a.size and min(_m._dims(v)) != 1 or any(not (x >= 0 and x == _math.floor(x)) for x in f):
            raise _err("mat2cell: the distribution for dimension %d must be a vector of nonnegative integers." % (k + 1))
        dists.append([int(x) for x in f])
    nd = max(len(D), len(dists))
    D = D + [1] * (nd - len(D))
    dists = dists + [[D[k]] for k in range(len(dists), nd)]
    for k in range(nd):
        if sum(dists[k]) != D[k]:
            raise _err("mat2cell: the distribution for dimension %d adds up to %d, not to A's size there, %d." % (k + 1, sum(dists[k]), D[k]))
    starts = [np.concatenate([[0], np.cumsum(dk)[:-1]]).astype(int) if dk else [] for dk in dists]
    cdims = [len(dk) for dk in dists]
    out = []
    for c in range(_m._prod(cdims)):
        sub = _subs(c, cdims)
        idx = []
        for k in range(nd):
            s, n = int(starts[k][sub[k]]), dists[k][sub[k]]
            idx.append(np.arange(s + 1, s + n + 1, dtype=float).reshape((n, 1)) if n != 1 else float(s + 1))
        out.append(_m.index(A, idx))
    return Cell(out, cdims)
