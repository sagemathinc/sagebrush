"""MATLAB code on the search path: name.m defines the function `name` (or is
the script `name`), and +ns/name.m is `ns.name`, as in MATLAB.  A name is
looked for in the current folder first, then in the folders addpath added (in
the path's order), then in the program's folder (or another folder on
sys.path).  The host (the CLI, a notebook) translates each file to Python
(src/matlab.ts).  Here too: addpath, rmpath, genpath, path, which, run and
import."""

import builtins as _builtins
import os as _os
import sys as _sys

import _matlab as _m


def _dirs():
    """the folders searched, in order: the current folder, the path, sys.path"""
    out = []
    seen = set()
    try:
        cwd = _os.getcwd()
    except OSError:
        cwd = None
    for d in ([cwd] if cwd else []) + list(_m._search_path) + list(_sys.path):
        if not isinstance(d, str):
            continue
        a = _os.path.abspath(d) if d else cwd
        if a and a not in seen:
            seen.add(a)
            out.append(a)
    return out


def _rel(name):
    """a.b.f as the file it is: +a/+b/f.m"""
    parts = name.split(".")
    return _os.path.join(*(["+" + p for p in parts[:-1]] + [parts[-1] + ".m"]))


def find(name):
    """the file name.m (+ns/name.m for ns.name) is found in, or None"""
    rel = _rel(name)
    for d in _dirs():
        p = _os.path.join(d, rel)
        try:
            if _os.path.isfile(p):
                return p
        except OSError:
            continue
    return None


def _isvarname(t):
    return bool(t) and t[0].isascii() and t[0].isalpha() and all(c == "_" or (c.isascii() and c.isalnum()) for c in t)


def is_namespace(name):
    """whether a namespace folder (+a/+b for a.b) is in a searched folder"""
    parts = name.split(".")
    if not all(_isvarname(p) for p in parts):
        return False
    rel = _os.path.join(*["+" + p for p in parts])
    for d in _dirs():
        try:
            if _os.path.isdir(_os.path.join(d, rel)):
                return True
        except OSError:
            continue
    return False


# (the scripts found, for fn(): a script runs only where it can see the workspace)
scripts = set()


def _translate(p):
    """the file's Python, and its lines"""
    host = getattr(_builtins, "__pyjs_host__", None)
    if host is None:
        return None, None
    with open(p) as fh:
        src = fh.read()
    return host("matlab_path_file", src, p), src.split("\n")


def load(name):
    """the function (or the script, as a built-in that runs it) in name.m, or None"""
    p = find(name)
    if p is None:
        return None
    try:
        py, lines = _translate(p)
    except OSError:
        return None
    if py is None:
        return None
    head, _, body = py.partition("\n")
    if head.startswith("#script"):
        f = _script(name, p, body, head.split()[1:])
        scripts.add(f)
        _m._file_lines[name.split(".")[-1]] = lines
        for k in head.split()[1:]:
            _m._file_lines[k] = lines
        return f
    ns = {"__name__": "_matlab_file_" + name}
    exec(body, ns)
    # (MATLAB names the function by its file; the file's first function)
    first = None
    for v in ns.values():
        if type(v) is _m.Function:
            _m._file_lines[v.name] = lines
            if first is None:
                first = v
    return first


def _script(name, p, py, fnames):
    """the script in file p, as a built-in: it runs in the workspace"""
    code = [None]

    def run(nargout, *args):
        if args or nargout >= 1:
            raise _m._err("Attempt to execute SCRIPT %s as a function:\n%s" % (name.split(".")[-1], p),
                          "MATLAB:scriptNotAFunction")
        if code[0] is None:
            code[0] = compile(py, p, "exec")
        run_script(code[0], _m._workspace(), fnames)
        return _m.NOVAL

    return _m.Builtin(run, name, (0, None))


def run_script(code, ws, fnames):
    """a script's code run in the workspace ws.  Its local functions are its own: a
    name of the workspace they shadow is given back afterwards, as is the caller's
    line (_L), which the script's statements set."""
    keep = ["_L"] + fnames
    saved = {k: ws[k] for k in keep if k in ws}
    try:
        exec(code, ws)
    finally:
        for k in keep:
            if k in saved:
                ws[k] = saved[k]
            else:
                ws.pop(k, None)


def script_in_function(name):
    """what a script named in a function is: an error when called"""
    def refuse(nargout, *args):
        raise _m._err("Calling the script '%s' from a function is not supported in Sagebrush yet: make it a "
                      "function, or call it from the top level." % name)
    return _m.Builtin(refuse, name, (0, None))


def imported(name, imports):
    """the function an import list gives a name: an entry naming it (ns.name) first, then the
    entries importing a whole namespace (ns.*), in order"""
    for e in imports:
        if e.endswith("." + name):
            f = _m._from_path(e)
            if f is not None:
                return f
    for e in imports:
        if e.endswith(".*"):
            f = _m._from_path(e[:-1] + name)
            if f is not None:
                return f
    return None


@_m._bi("pkg")
def pkg_(nargout, *args):
    """Octave's pkg: no Octave package is loaded or installed in Sagebrush yet.  pkg says so (a warning)
    and the program goes on; pkg list gives no packages."""
    words = [_m._text(a) for a in args]
    sub = words[0] if words else ""
    names = " ".join(w for w in words[1:] if not w.startswith("-"))
    if sub == "list":
        return _m.Cell([], (1, 0)) if nargout >= 1 else _m.NOVAL
    if sub in ("load", "install", "update", "unload", "uninstall", "describe", "build", "rebuild"):
        what = {"load": "nothing was loaded", "install": "nothing was installed", "update": "nothing was updated"}.get(sub, "nothing was done")
        _m.warning_("pkg %s: Octave packages are not available in Sagebrush yet, so %s%s." % (sub, what, " (%s)" % names if names else ""),
                    "Sagebrush:pkg:unavailable")
    else:
        _m.warning_("pkg: Octave packages are not available in Sagebrush yet.", "Sagebrush:pkg:unavailable")
    return _m.NOVAL


@_m._bi("import")
def import_(nargout, *args):
    """import ns.name or import ns.*: the workspace's code may then call ns.name as name; import alone
    shows the list, L = import gives it.  (A function's or a script's own imports are its own: the
    translator gives them to its names, src/matlab.ts.)"""
    for a in args:
        t = _m._text(a, "import")
        parts = t[:-2].split(".") if t.endswith(".*") else t.split(".")
        if len(parts) < (1 if t.endswith(".*") else 2) or not all(_isvarname(p) for p in parts):
            raise _m._err("Invalid import: '%s'. Use import ns.name or import ns.*." % t, "MATLAB:import:InvalidImport")
        if t not in _m._base_imports:
            _m._base_imports.append(t)
    if not args:
        if nargout >= 1:
            return _m.Cell([_m.Char(e) for e in _m._base_imports], (len(_m._base_imports), 1))
        for e in _m._base_imports:
            _m._write(e + "\n")
    return _m.NOVAL


# ---- the search path


def _changed():
    """after the path or the current folder changes: names are looked up again"""
    _m._path_cache.clear()


def _folders(args, what):
    """the folders named by addpath's or rmpath's arguments: each argument may be a list
    of folders separated by pathsep, as genpath gives"""
    out = []
    for a in args:
        if type(a) is _m.StrArr:
            items = list(a.a)
        elif type(a) is _m.Cell:
            items = [_m._text(v, "folder") for v in a.a]
        else:
            items = [_m._text(a, "folder")]
        for t in items:
            out.extend(s for s in t.split(_os.pathsep) if s)
    return out


def _path_text():
    return _os.pathsep.join(_m._search_path)


def _absolute(d):
    return _os.path.normpath(_os.path.abspath(_os.path.expanduser(d)))


@_m._bi("addpath")
def addpath_(nargout, *args):
    """addpath(folder1, ..., folderN) puts folders at the top of the search path; with '-end', at the
    bottom.  A folder is made absolute; one that does not exist is skipped with a warning."""
    if not args:
        raise _m._err("Not enough input arguments.", "MATLAB:minrhs")
    old = _path_text()
    args = list(args)
    end = False
    while args and _m._istext(args[-1]) and _m._text(args[-1]).lower() in ("-end", "-begin", "-frozen"):
        flag = _m._text(args.pop()).lower()
        if flag == "-end":
            end = True
    if args and type(args[-1]) is float and args[-1] in (0.0, 1.0):
        end = args.pop() == 1.0
    if not args:
        raise _m._err("Not enough input arguments.", "MATLAB:minrhs")
    add = []
    for d in _folders(args, "folder"):
        a = _absolute(d)
        if not _os.path.isdir(a):
            _m.warning_("Name is nonexistent or not a directory: %s" % a, "MATLAB:mpath:nameNonexistentOrNotADirectory")
            continue
        base = _os.path.basename(a)
        if base.startswith("+") or base.startswith("@") or base == "private":
            _m.warning_("%s folders are not allowed on the path: %s (add the folder that contains it)"
                        % ("Namespace" if base[0] == "+" else "Class" if base[0] == "@" else "Private", a),
                        "MATLAB:mpath:packageDirectoriesNotAllowedOnPath")
            continue
        if a not in add:
            add.append(a)
    rest = [d for d in _m._search_path if d not in add]
    _m._search_path[:] = rest + add if end else add + rest
    _changed()
    return _m.Char(old) if nargout >= 1 else _m.NOVAL


@_m._bi("rmpath")
def rmpath_(nargout, *args):
    """rmpath(folder1, ..., folderN) takes folders off the search path; one that is not on it gives a warning."""
    if not args:
        raise _m._err("Not enough input arguments.", "MATLAB:minrhs")
    old = _path_text()
    for d in _folders(args, "folder"):
        a = _absolute(d)
        if a in _m._search_path:
            _m._search_path.remove(a)
        else:
            _m.warning_("\"%s\" not found in path." % d, "MATLAB:rmpath:DirNotFound")
    _changed()
    return _m.Char(old) if nargout >= 1 else _m.NOVAL


@_m._bs("genpath")
def genpath_(folder=None):
    """genpath(folder): the folder and every folder below it, as one path text (each followed by pathsep),
    leaving out private, resources, @class and +namespace folders and everything below them."""
    if folder is None:
        return _m.Char("")
    top = _m._text(folder, "folder")
    if not _os.path.isdir(top):
        return _m.Char("")
    out = []
    # (depth first, a folder before the folders in it, in name order; a folder reached again through a link is
    # left out, so a link to a folder above can't make it endless)
    seen = set()
    stack = [top]
    while stack:
        d = stack.pop()
        try:
            st = _os.stat(d)
            key = (st.st_dev, st.st_ino) if st.st_ino else _os.path.realpath(d)
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
        try:
            names = sorted(_os.listdir(d))
        except OSError:
            continue
        subs = [_os.path.join(d, n) for n in names if not _left_out(n)]
        stack.extend(reversed([p for p in subs if _os.path.isdir(p)]))
    return _m.Char("".join(d + _os.pathsep for d in out))


def _left_out(n):
    """the folders genpath leaves out: private, resources, @class, +namespace and hidden ones"""
    return n[:1] in ("+", "@", ".") or n in ("private", "resources")


@_m._bi("path")
def path_(nargout, *args):
    """path: the search path's folders, shown one per line; p = path gives them as one text, separated by
    pathsep.  path(newpath) sets it; path(p1, p2) sets it to the two joined."""
    old = _path_text()
    if args:
        if len(args) > 2:
            raise _m._err("Too many input arguments.", "MATLAB:TooManyInputs")
        items = []
        for a in args:
            for d in _folders([a], "path"):
                x = _absolute(d)
                if x not in items:
                    items.append(x)
        _m._search_path[:] = items
        _changed()
        return _m.Char(old) if nargout >= 1 else _m.NOVAL
    if nargout >= 1:
        return _m.Char(old)
    _m._write("\n\t\tMATLABPATH\n\n" + "".join("\t%s\n" % d for d in _m._search_path) + "\n")
    return _m.NOVAL


def ws_call(name, ns, args, nargout):
    """which and run, which see the caller's variables (lib/_matlab.py ws_call)"""
    if not args:
        raise _m._err("Not enough input arguments.", "MATLAB:minrhs")
    if name == "which":
        if len(args) > 1:
            raise _m._err("which with more than one input is not supported in Sagebrush.")
        return which(_m._text(args[0]), ns, nargout)
    if "__name__" not in ns:
        raise _m._err("run inside a function is not supported in Sagebrush yet: call the script from the top level, "
                      "or make it a function.")
    if len(args) > 1:
        raise _m._err("Too many input arguments.", "MATLAB:TooManyInputs")
    if nargout >= 1:
        raise _m._err("Too many output arguments.", "MATLAB:TooManyOutputs")
    return run(_m._text(args[0]), ns)


def which(name, ns, nargout):
    """which name: where the name is found, the caller's variables first; s = which(name) gives it as text
    ('variable' for a variable, '' for a name not found)"""
    key = "_k_" + name if name in _m._PYKW else name
    v = ns.get(key)
    if type(v) is _m.Function:
        r = shown = "%s is a function of this program." % name
    elif v is not None and not isinstance(v, _m.Undef):
        r = "variable"
        shown = "'%s' is a variable." % name
    elif name in _m._B:
        r = shown = "built-in (Sagebrush)"
    else:
        p = find(name)
        r = shown = p if p is not None else ""
        if p is None:
            shown = "'%s' not found." % name
    if nargout >= 1:
        return _m.Char(r)
    _m._write(shown + "\n")
    return _m.NOVAL


def run(target, ns):
    """run(scriptname): the script (or a function file's function, with no arguments) run in the
    caller's workspace.  With a folder in the name, run goes to that folder for the run and comes back
    (unless the script went somewhere else)."""
    d, base = _os.path.split(target)
    if base.endswith(".m"):
        base = base[:-2]
    if not d:
        f = _m._from_path(base)
        if f is None:
            raise _m._err("RUN cannot execute the file '%s'. RUN requires a valid MATLAB script" % target,
                          "MATLAB:run:FileNotFound")
        return _run_found(f, ns)
    p = _os.path.join(d, base + ".m")
    if not _os.path.isfile(p):
        raise _m._err("RUN cannot execute the file '%s'. RUN requires a valid MATLAB script" % target,
                      "MATLAB:run:FileNotFound")
    _m._latex_refuse("cd")
    old = _os.getcwd()
    there = _absolute(d)
    _os.chdir(there)
    _changed()
    try:
        f = _m._from_path(base)
        if f is None:
            raise _m._err("RUN cannot execute the file '%s'. RUN requires a valid MATLAB script" % target,
                          "MATLAB:run:FileNotFound")
        return _run_found(f, ns)
    finally:
        if _os.getcwd() == there:
            _os.chdir(old)
        _changed()


def _run_found(f, ns):
    f.call(0, [])
    return _m.NOVAL
