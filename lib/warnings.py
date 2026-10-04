"""A small warnings module: warn(), filters (simplefilter, filterwarnings,
resetwarnings), catch_warnings(record=...), showwarning/formatwarning."""

import sys

filters = []
defaultaction = "default"
_onceregistry = set()


class WarningMessage:
    def __init__(self, message, category, filename, lineno, file=None, line=None, source=None):
        self.message = message
        self.category = category
        self.filename = filename
        self.lineno = lineno
        self.file = file
        self.line = line
        self.source = source
        self._category_name = category.__name__ if category else None

    def __str__(self):
        return ("{message : %r, category : %r, filename : %r, lineno : %s, line : %r}"
                % (self.message, self._category_name, self.filename, self.lineno, self.line))


def formatwarning(message, category, filename, lineno, line=None):
    return "%s:%s: %s: %s\n" % (filename, lineno, category.__name__, message)


def showwarning(message, category, filename, lineno, file=None, line=None):
    if file is None:
        file = sys.stderr
    try:
        file.write(formatwarning(message, category, filename, lineno, line))
    except OSError:
        pass


def _action(category, text, module):
    for action, msg, cat, mod, lineno in filters:
        if (msg is None or msg.match(text)) and issubclass(category, cat) and (mod is None or mod.match(module)):
            return action
    return defaultaction


def warn(message, category=None, stacklevel=1, source=None, *, skip_file_prefixes=()):
    if isinstance(message, Warning):
        category = message.__class__
    if category is None:
        category = UserWarning
    if not (isinstance(category, type) and issubclass(category, Warning)):
        raise TypeError("category must be a Warning subclass, not '%s'" % type(category).__name__)
    text = str(message)
    if not isinstance(message, Warning):
        message = category(message)
    filename = sys.argv[0] if sys.argv else "<string>"
    warn_explicit(message, category, filename, 0, "__main__")


def warn_explicit(message, category, filename, lineno, module=None, registry=None, module_globals=None, source=None):
    text = str(message)
    action = _action(category, text, module or "")
    if action == "ignore":
        return
    if action == "error":
        raise message if isinstance(message, Warning) else category(message)
    key = (text, category, lineno)
    if action in ("default", "once", "module"):
        if key in _onceregistry:
            return
        _onceregistry.add(key)
    showwarning(message, category, filename, lineno)


def _compile(s, flags=0):
    if not s:
        return None
    import re
    return re.compile(s, flags)


def filterwarnings(action, message="", category=Warning, module="", lineno=0, append=False):
    import re
    item = (action, _compile(message, re.I), category, _compile(module), lineno)
    if item in filters:
        filters.remove(item)
    if append:
        filters.append(item)
    else:
        filters.insert(0, item)
    _onceregistry.clear()


def simplefilter(action, category=Warning, lineno=0, append=False):
    item = (action, None, category, None, lineno)
    if item in filters:
        filters.remove(item)
    if append:
        filters.append(item)
    else:
        filters.insert(0, item)
    _onceregistry.clear()


def resetwarnings():
    filters[:] = []
    _onceregistry.clear()


class catch_warnings:
    def __init__(self, *, record=False, module=None, action=None, category=Warning, lineno=0, append=False):
        self._record = record
        self._action = action
        self._category = category
        self._lineno = lineno
        self._append = append

    def __enter__(self):
        global showwarning
        self._filters = filters[:]
        self._showwarning = showwarning
        self._registry = set(_onceregistry)
        _onceregistry.clear()
        if self._action is not None:
            simplefilter(self._action, self._category, self._lineno, self._append)
        if self._record:
            log = []

            def record(message, category, filename, lineno, file=None, line=None):
                log.append(WarningMessage(message, category, filename, lineno, file, line))
            showwarning = record
            return log
        return None

    def __exit__(self, *exc):
        global showwarning
        filters[:] = self._filters
        showwarning = self._showwarning
        _onceregistry.clear()
        _onceregistry.update(self._registry)


def deprecated(msg, /, *, category=DeprecationWarning, stacklevel=1):
    def deco(f):
        return f
    return deco


# Default filters as in CPython (ignore deprecation warnings outside __main__).
filters.append(("ignore", None, DeprecationWarning, None, 0))
filters.append(("ignore", None, PendingDeprecationWarning, None, 0))
filters.append(("ignore", None, ImportWarning, None, 0))
filters.append(("ignore", None, ResourceWarning, None, 0))
