"""help(obj), and IPython's obj? and obj?? in interactive input (notebook
cells, the console, the CLI and the Jupyter kernel rewrite a line `obj?` to
__pyjs_help__(obj, 1, "obj")).

    obj?    signature, docstring, file and type
    obj??   the same and the source code
"""

_LIB = "/$pyjs/lib/"


def _cleandoc(doc):
    """The docstring with its common indentation removed (inspect.cleandoc)."""
    lines = doc.expandtabs().split("\n")
    margin = None
    for line in lines[1:]:
        content = len(line.lstrip())
        if content:
            ind = len(line) - content
            margin = ind if margin is None else min(margin, ind)
    out = [lines[0].strip()]
    for line in lines[1:]:
        out.append(line[margin:] if margin else line)
    while out and not out[-1].strip():
        out.pop()
    while out and not out[0].strip():
        out.pop(0)
    return "\n".join(out)


def _function(obj):
    """(function, drop_first): the Python function behind obj, if any."""
    if isinstance(obj, type):
        init = obj.__dict__.get("__init__") if "__init__" in obj.__dict__ else None
        if init is None:
            for k in obj.__mro__[1:]:
                if "__init__" in k.__dict__ and k is not object:
                    init = k.__dict__["__init__"]
                    break
        return (init, True) if init is not None and hasattr(init, "__code__") else (None, False)
    f = getattr(obj, "__func__", None)
    if f is not None and hasattr(f, "__code__"):
        return f, True
    if hasattr(obj, "__code__"):
        return obj, False
    call = getattr(type(obj), "__call__", None)
    if call is not None and hasattr(call, "__code__") and not isinstance(obj, type(_cleandoc)):
        return call, True
    return None, False


def signature(obj):
    """The signature "(a, b=1, *c, d, **e)", or None if unknown."""
    f, drop = _function(obj)
    if f is None:
        return None
    c = f.__code__
    names = list(c.co_varnames)
    n, k = c.co_argcount, c.co_kwonlyargcount
    pos, rest = names[:n], names[n:]
    vararg = rest.pop(0) if c.co_flags & 4 else None
    kwonly = rest[:k]
    kwarg = rest[k] if c.co_flags & 8 else None
    defaults = list(f.__defaults__ or ())
    kwdefaults = f.__kwdefaults__ or {}
    parts = []
    first = len(pos) - len(defaults)
    for i, p in enumerate(pos):
        parts.append(p if i < first else "%s=%r" % (p, defaults[i - first]))
    if drop and parts:
        parts.pop(0)
    if vararg:
        parts.append("*" + vararg)
    elif kwonly:
        parts.append("*")
    for p in kwonly:
        parts.append("%s=%r" % (p, kwdefaults[p]) if p in kwdefaults else p)
    if kwarg:
        parts.append("**" + kwarg)
    return "(" + ", ".join(parts) + ")"


def _file(obj):
    f, _ = _function(obj)
    fn = None
    if f is not None:
        fn = f.__code__.co_filename
    elif isinstance(obj, type) or hasattr(obj, "__module__"):
        import sys
        mod = sys.modules.get(getattr(obj, "__module__", None) or "")
        fn = getattr(mod, "__file__", None)
    if type(obj).__name__ == "module":
        fn = getattr(obj, "__file__", None)
    return fn


def _show_file(fn):
    if fn and fn.startswith(_LIB):
        return "lib/" + fn[len(_LIB):]
    return fn


def source(obj):
    """The source of a function, method or class, if the runtime has it."""
    f, _ = _function(obj)
    fn = _file(obj)
    lines = __pyjs_source_lines__(fn) if fn else None
    if not lines:
        return None
    if f is not None and not isinstance(obj, type):
        start = f.__code__.co_firstlineno - 1
    elif isinstance(obj, type):
        start = getattr(obj, "__firstlineno__", 1) - 1
    else:
        return "\n".join(lines)
    while start > 0 and lines[start - 1].lstrip().startswith("@"):
        start -= 1
    head = lines[start]
    ind = len(head) - len(head.lstrip())
    end = start + 1
    while end < len(lines):
        line = lines[end]
        if line.strip() and len(line) - len(line.lstrip()) <= ind:
            break
        end += 1
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    return "\n".join(l[ind:] if len(l) >= ind else l.lstrip() for l in lines[start:end])


def _kind(obj):
    if isinstance(obj, type):
        return "class"
    if hasattr(obj, "__func__"):
        return "method"
    if type(obj).__name__ == "module":
        return "module"
    if hasattr(obj, "__code__") or callable(obj):
        return "function"
    return type(obj).__name__


def inspect_object(obj, level=1, name=None):
    """What obj? (level 1) and obj?? (level 2) print, as in IPython."""
    out = []
    sig = signature(obj) if callable(obj) else None
    if name is None:
        name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None) or ""
    if sig is not None:
        out.append("Signature: " + name + sig)
    elif not callable(obj):
        r = repr(obj)
        out.append("String form: " + (r if len(r) < 500 else r[:500] + "..."))
    doc = getattr(obj, "__doc__", None)
    if not isinstance(obj, type) and not callable(obj) and doc == type(obj).__doc__:
        doc = None  # a plain value: its class's docstring is not about it
    out.append("Docstring:" + ("\n" + _cleandoc(doc) if isinstance(doc, str) and doc.strip() else " <no docstring>"))
    if level >= 2:
        src = source(obj)
        if src:
            out.append("Source:\n" + src)
    fn = _show_file(_file(obj)) if callable(obj) or _kind(obj) == "module" else None
    if fn:
        out.append("File:      " + fn)
    out.append("Type:      " + (type(obj).__name__ if _kind(obj) != "class" else "type"))
    print("\n".join(out))


def help(obj=None):
    """help(obj): the signature and docstring of obj (for a class or module,
    also its public methods with the first line of each docstring)."""
    if obj is None:
        print("Sagebrush: help(obj) shows an object's signature and documentation;\n"
              "obj? does the same, obj?? also shows its source, and obj.<Tab> lists\n"
              "its attributes.  dir(obj) lists them as a list.")
        return
    name = getattr(obj, "__qualname__", None) or getattr(obj, "__name__", None) or type(obj).__name__
    kind = _kind(obj)
    mod = getattr(obj, "__module__", None)
    head = "Help on %s %s%s:" % (kind, name, " in module " + mod if mod and kind != "module" else "")
    out = [head, ""]
    sig = signature(obj) if callable(obj) else None
    title = (getattr(obj, "__name__", None) or name)
    out.append(("class " if kind == "class" else "") + title + (sig or ""))
    doc = getattr(obj, "__doc__", None)
    if isinstance(doc, str) and doc.strip():
        out.extend("    " + l if l else "" for l in _cleandoc(doc).split("\n"))
    if kind in ("class", "module"):
        names = [n for n in dir(obj) if not n.startswith("_")]
        rows = []
        for n in names:
            try:
                v = getattr(obj, n)
            except Exception:
                continue
            d = getattr(v, "__doc__", None)
            first = _cleandoc(d).split("\n")[0] if isinstance(d, str) and d.strip() and callable(v) else ""
            rows.append("    %s%s" % (n, " -- " + first if first else ""))
        if rows:
            out += ["", "  Methods and attributes:"] + rows
    print("\n".join(out))
