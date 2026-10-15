"""The part of IPython that programs use: IPython.display, and get_ipython()
for magics (lib/_pyjs_magic.py)."""
from IPython.display import display


def get_ipython():
    """The shell: get_ipython().run_line_magic("time", "...") and the like."""
    from _pyjs_magic import get_ipython as g
    return g()
