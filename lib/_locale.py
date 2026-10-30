"""Sagebrush: _locale, CPython's C locale module, for its locale.py (which
calendar.py imports), with the one locale Sagebrush has: the C locale.

What CPython's _locale does under the C locale (glibc), it does here:
setlocale accepts "C", "POSIX" and "" (the default, the C locale here) and
answers 'C'; any other name is locale.Error("unsupported locale setting"),
as for a locale the host doesn't have; localeconv() is the C locale's;
strcoll compares code points and strxfrm returns its argument.  Not here:
nl_langinfo and the gettext functions (so locale lacks them, as on Windows).
"""

from operator import index as _index

LC_CTYPE = 0
LC_NUMERIC = 1
LC_TIME = 2
LC_COLLATE = 3
LC_MONETARY = 4
LC_MESSAGES = 5
LC_ALL = 6
CHAR_MAX = 127

# (glibc's categories: the seven above and LC_PAPER .. LC_IDENTIFICATION,
# 7 to 12, which _locale doesn't name but setlocale accepts)
_CATEGORIES = range(13)
_C_NAMES = ("C", "POSIX", "")


class Error(Exception):
    pass


Error.__module__ = "locale"


def _c_int(n):
    # (a category is a C int: out of its range, CPython's OverflowError)
    n = _index(n)
    if not -0x80000000 <= n <= 0x7FFFFFFF:
        raise OverflowError("Python int too large to convert to C int")
    return n


def _c_string(s):
    # (a C string: the str's own characters, whatever a subclass's hooks
    # say, and no NUL)
    s = str.__str__(s)
    if "\0" in s:
        raise ValueError("embedded null character")
    return s


def setlocale(category, locale=None, /):
    category = _c_int(category)
    if locale is not None and not isinstance(locale, str):
        raise TypeError("setlocale() argument 2 must be str or None, not %s" % type(locale).__name__)
    if locale is not None:
        locale = _c_string(locale)
    if locale is None:
        if category not in _CATEGORIES:
            raise Error("locale query failed")
        return "C"
    if category not in _CATEGORIES or locale not in _C_NAMES:
        raise Error("unsupported locale setting")
    return "C"


def localeconv():
    return {
        "int_curr_symbol": "", "currency_symbol": "", "mon_decimal_point": "",
        "mon_thousands_sep": "", "mon_grouping": [], "positive_sign": "",
        "negative_sign": "", "int_frac_digits": CHAR_MAX, "frac_digits": CHAR_MAX,
        "p_cs_precedes": CHAR_MAX, "p_sep_by_space": CHAR_MAX,
        "n_cs_precedes": CHAR_MAX, "n_sep_by_space": CHAR_MAX,
        "p_sign_posn": CHAR_MAX, "n_sign_posn": CHAR_MAX,
        "decimal_point": ".", "thousands_sep": "", "grouping": [],
    }


def strcoll(os1, os2, /):
    for i, s in ((1, os1), (2, os2)):
        if not isinstance(s, str):
            raise TypeError("strcoll() argument %d must be str, not %s" % (i, type(s).__name__))
    os1, os2 = _c_string(os1), _c_string(os2)
    return (os1 > os2) - (os1 < os2)


def strxfrm(string, /):
    if not isinstance(string, str):
        raise TypeError("strxfrm() argument must be str, not %s" % type(string).__name__)
    return _c_string(string)


def getencoding():
    # (Sagebrush's text is UTF-8: what CPython's UTF-8 mode reports)
    return "UTF-8"
