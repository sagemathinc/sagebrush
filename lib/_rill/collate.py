"""How R 4.5.3 orders strings (sort, factor levels, table), as the oracle does: R built with ICU, in C.UTF-8, which
orders by ICU's root collation (rill-tests/fac/; observed by sorting every printable ASCII character and pairs of
them).  For ASCII text that is:

- first, character by character, by a primary weight that ignores case: space, then the punctuation and symbols
  in the order below, then the digits, then the letters a..z (a shorter string that begins a longer one first);
- then, where those tie, character by character, a lowercase letter before its uppercase one.

Text outside ASCII (accents, other scripts) is ordered by rules Rill doesn't model yet, and is refused.
"""

from .eval import NotSupported

# the printable ASCII characters that aren't letters, in the oracle's order (R 4.5.3: sort() of each as a string)
_ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789"
_PRIMARY = {c: k for k, c in enumerate(_ORDER)}
for _k, _c in enumerate("abcdefghijklmnopqrstuvwxyz"):
    _PRIMARY[_c] = len(_ORDER) + _k
    _PRIMARY[_c.upper()] = len(_ORDER) + _k


def key(s):
    """A sort key for s: (primary weights, case weights)."""
    try:
        primary = tuple(_PRIMARY[c] for c in s)
    except KeyError:
        raise NotSupported("ordering strings with characters other than printable ASCII")
    return primary, tuple(1 if c.isupper() else 0 for c in s)
