"""The shell's errors and IPython's SList, for !cmd and x = !cmd (the code
is lib/_pyjs_shell.py, a module of its own: see there)."""
from _pyjs_shell import (ShellError, ShellLimitError, ShellUnavailableError, BashError, SList, var_expand,
                         system, getoutput)

__all__ = ["ShellError", "ShellLimitError", "ShellUnavailableError", "BashError", "SList", "var_expand",
           "system", "getoutput"]
