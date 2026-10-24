"""The work budget of one display: the text of a value IPython-style
(_pyjs_pretty.text, LIMIT-PR57-1) and its LaTeX for show() and latex()
(_sage_expr, LIMIT-SHOW87-1/2) share it.

Once user code can change a value while it is shown (a __repr__ or a
_latex_ that adds to its list at every step would keep the walk going),
one display, its nested displays included, takes at most LIMITS["steps"]
steps (a piece of the output) and LIMITS["chars"] characters; past
either, MemoryError, raised before the piece is added, and the session
goes on.  Counted from the outermost display.  LIMITS is the one setting
(a host or an administrator may lower it for a session; the tests do).
"""

LIMITS = {"steps": 1 << 23, "chars": 1 << 26}
_spent = [0, 0]
_depth = [0]


def _charge(steps, chars, by="a __repr__"):
    _spent[0] += steps
    _spent[1] += chars
    if _spent[0] > LIMITS["steps"] or _spent[1] > LIMITS["chars"]:
        raise MemoryError("displaying this value takes more than Sagebrush's limit of %d steps or %d characters (%s may be changing it as it is shown)" % (LIMITS["steps"], LIMITS["chars"], by))


class display:
    """A display's scope: the outermost one starts a new count.

        with display():
            ...  # _charge(...) as the output is built
    """

    def __enter__(self):
        if _depth[0] == 0:
            _spent[0] = _spent[1] = 0
        _depth[0] += 1
        return self

    def __exit__(self, *exc):
        _depth[0] -= 1
        return False
