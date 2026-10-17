# Sagebrush: _datetime, CPython's C datetime module, as the pure-Python
# _pydatetime (lib/datetime.py imports it first, as CPython's): its types
# named as the C ones are, 'datetime.date' in messages and datetime for
# __module__, so that their errors and pickles are CPython's.
from _pydatetime import *
from _pydatetime import __all__
import _pyjs_types

for _c in (date, datetime, time, timedelta, timezone, tzinfo):
    _c.__module__ = "datetime"
    _pyjs_types.c_name(_c, "datetime." + _c.__name__)
del _c


# (a timezone reduces as the C type's: its constructor's arguments, no
# state; _pydatetime's tzinfo.__reduce__ would add its __slots__' values)
def _timezone_reduce(self):
    return (type(self), self.__getinitargs__())


timezone.__reduce__ = _timezone_reduce
del _timezone_reduce
