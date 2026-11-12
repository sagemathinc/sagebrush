# Docstrings as CPython 3.13+'s compiler keeps them: tabs expanded, the first
# line's leading spaces dropped, the later lines' common indentation dropped
# (test/corpus-fixes.test.ts compares this file's output with CPython's).


def a():
    """First line.

    Indented by four.
        Eight here.
    """


def b():
    """   leading spaces on the first line
      two
    four"""


def c():
    """\tTab first
\tsecond with a tab
        eight spaces
    """


def d():
    """
    starts on the second line
      deeper
    """


def e():
    """single"""


def f():
    """trailing spaces   
    next   
       
    end"""


def g():
    """only a first line   """


class K:
    """Class doc.
        indented
    """

    def m(self):
        """method doc
            deeper
        """


def h():
    """x
  
    y"""


def i():
    """
    
    """


def j():
    "\n    a\n\n    b\n"


def k():
    """first
\x0b    a vertical tab is not indentation
    z"""


def l():
    """x\ty
    p\tq
    """


def m():
    """\x0b first line's vertical tab stays
    z"""


def n():
    """\x0c  first line's form feed stays
      two
    one"""


def o():
    """a
\ttab-indented
    space-indented"""


def p():
    """a
    \t
    b"""


def q():
    r"""raw \t stays two characters
        x
    """


async def r():
    """async doc
        line
    """


def s():
    """t
\x0c
    a form feed alone counts as text at column 0
    """


def t():
    """t
    x
  \x0c
    """


def u():
    """t
        
    """


def v():
    "   x  "


def w():
    """\U0001f600\ty
    \U0001f600\tz"""


def x():
    """é\tq
      é\tr
    s"""


def y():
    def inner():
        """inner
            doc
        """
    return inner


def cr():
    "a\r\tb\n\tc"


def z():
    pass


for fn in (a, b, c, d, e, f, g, K, K.m, h, i, j, k, l, m, n, o, p, q, r, s, t, u, v, w, x, y(), cr, z, lambda: 0):
    print(repr(fn.__doc__))
