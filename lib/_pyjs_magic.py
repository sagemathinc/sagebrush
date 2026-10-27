"""IPython's magics in Sagebrush's notebooks, kernel and console: the
supported ones, and an error for every other.  src/magic-syntax.ts turns
`%name args` into __pyjs_magic__("name", "args"), and puts the code that
%time, %timeit, %%time and %%timeit run into the cell itself, calling API
below.

Line magics:
    %matplotlib [inline]      figures are shown inline already
    %load_ext autoreload, %reload_ext autoreload, %unload_ext autoreload
    %autoreload [0|1|2|off|explicit|all|now], %aimport [mod, -mod]
    %time STATEMENT           the wall time (Sagebrush cannot measure CPU time)
    %timeit [-n N -r R -p P -q -o] STATEMENT
Cell magics: %%time (nothing after it on its line), %%timeit [options] [setup].
Shell commands (!cmd, %system, %pip, ...) are errors: Sagebrush runs in the
browser and has no shell or package installer.

%autoreload reloads the changed modules of your files before each cell, as
importlib.reload does.  A class keeps its identity: the class first loaded
gets the new version's attributes, so existing instances, and every name
bound to it, follow the new code (as IPython's does).  Unlike IPython,
Sagebrush cannot change a function's code in place; it rebinds the names in
your notebook and in your other modules that referred to the old function,
but an old function kept elsewhere (in a list, a closure, a default
argument) keeps its old code, and a class whose code may use the __class__
cell (found in the parsed source: super() without arguments, any use of
super other than super(Name, obj), or the name __class__) is not updated:
autoreload says so."""
import math
import sys
import time

__all__ = ["UsageError", "run_line_magic", "run_cell_magic", "get_ipython"]


# Sagebrush's library (this file's directory): never reloaded
_LIB = __file__.rsplit("/", 1)[0] + "/"


class UsageError(Exception):
    """A magic used wrongly, or one Sagebrush does not have (IPython's UsageError)."""


def _user_ns():
    import __main__
    return __main__.__dict__


# ---------------------------------------------------------------- times, as IPython prints them

def _format_time(seconds, precision=3):
    if seconds >= 60.0:
        parts = []
        left = seconds
        for suffix, length in (("d", 86400), ("h", 3600), ("min", 60), ("s", 1)):
            value = int(left / length)
            if value > 0:
                left = left % length
                parts.append("%d%s" % (value, suffix))
            if left < 1:
                break
        return " ".join(parts)
    units = ["s", "ms", "µs", "ns"]
    order = min(-int(math.floor(math.log10(seconds)) // 3), 3) if seconds > 0.0 else 3
    return "%.*g %s" % (precision, seconds * (1, 1e3, 1e6, 1e9)[order], units[order])


class _Timer:
    """`with` this: the wall time of the block, printed as it ends (also when it raises)."""

    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, *exc):
        print("Wall time: %s" % _format_time(time.perf_counter() - self.t0))
        return False


_kept = [None]


def _keep(value):
    """%time EXPR and %%time: the value, shown after the time (kept()).
    Kept inside the timed block, so the expression stays in its own scope."""
    _kept[0] = value


def _take_kept():
    v = _kept[0]
    _kept[0] = None
    return v


class TimeitResult:
    """%timeit -o's result: loops, repeat, best, worst, all_runs, timings, average, stdev."""

    def __init__(self, loops, repeat, best, worst, all_runs, precision):
        self.loops = loops
        self.repeat = repeat
        self.best = best
        self.worst = worst
        self.all_runs = all_runs
        self.timings = [t / loops for t in all_runs]
        self._precision = precision
        self.average = math.fsum(self.timings) / len(self.timings)
        self.stdev = math.sqrt(math.fsum([(t - self.average) ** 2 for t in self.timings]) / len(self.timings))

    def __str__(self):
        p = self._precision
        runs = "%d run%s" % (self.repeat, "" if self.repeat == 1 else "s")
        loops = "{:,} loop{}".format(self.loops, "" if self.loops == 1 else "s")
        return "%s ± %s per loop (mean ± std. dev. of %s, %s each)" % (
            _format_time(self.average, p), _format_time(self.stdev, p), runs, loops)

    def __repr__(self):
        return "<TimeitResult : " + str(self) + ">"


def _timeit_options(line):
    """(number, repeat, precision, quiet, ret, rest) from %timeit's line
    (src/magic-syntax.ts splitTimeit splits it the same way)."""
    number, repeat, precision, quiet, ret = 0, 7, 3, False, False
    words = line.split(" ")
    i = 0
    while i < len(words):
        w = words[i]
        if w == "":
            i += 1
            continue
        if not (len(w) > 1 and w[0] == "-" and w[1].isalpha()):
            break
        flag, val = w[:2], w[2:]
        if flag in ("-n", "-r", "-p"):
            if val == "":
                i += 1
                if i >= len(words):
                    raise UsageError("%%timeit: option %s needs a value" % flag)
                val = words[i]
            try:
                v = int(val)
            except ValueError:
                raise UsageError("%%timeit: option %s needs an integer, not %r" % (flag, val)) from None
            if v < 1:
                raise UsageError("%%timeit: option %s must be at least 1" % flag)
            if flag == "-n":
                number = v
            elif flag == "-r":
                repeat = v
            else:
                precision = v
        elif w == "-q":
            quiet = True
        elif w == "-o":
            ret = True
        else:
            raise UsageError("%%timeit: option %s is not supported in Sagebrush (it has -n, -r, -p, -q and -o)" % w)
        i += 1
    return number, repeat, precision, quiet, ret, " ".join(words[i:])


def _timeit_run(opts, inner, top=False):
    """%timeit: inner(iterable, clock) runs the statement once per item and
    returns the time taken; as IPython, -n's default is the smallest power of
    10 taking at least 0.2 s.  top: inner was bound in the cell's namespace,
    under a fresh name (src/magic-syntax.ts): the binding is removed if it is
    still inner."""
    try:
        number, repeat, precision, quiet, ret, rest = _timeit_options(opts)
        if rest:
            raise UsageError("%%timeit: unexpected %r among its options" % rest)
        return _measure(inner, number, repeat, precision, quiet, ret)
    finally:
        if top:
            g = inner.__globals__
            if g.get(inner.__name__) is inner:
                del g[inner.__name__]


def _measure(inner, number, repeat, precision, quiet, ret):
    timer = time.perf_counter
    if number == 0:
        for k in range(10):
            number = 10 ** k
            if inner(range(number), timer) >= 0.2:
                break
    runs = [inner(range(number), timer) for _ in range(repeat)]
    best, worst = min(runs) / number, max(runs) / number
    result = TimeitResult(number, repeat, best, worst, runs, precision)
    if not quiet:
        if worst > 4 * best and best > 0 and worst > 1e-6:
            print("The slowest run took %0.2f times longer than the fastest. This could mean that an "
                  "intermediate result is being cached." % (worst / best))
        print(result)
    return result if ret else None


class API:
    """What the expanded %time and %timeit code calls (__pyjs_magic_api__)."""
    timer = _Timer
    keep = staticmethod(_keep)
    kept = staticmethod(_take_kept)
    timeit_run = staticmethod(_timeit_run)


# %time and %timeit by name (get_ipython().run_line_magic("time", ...), or a
# magic whose code does not parse: the error is the compiler's), in the
# notebook's namespace

def _compile_either(code, name):
    """(code object, whether it is an expression)"""
    try:
        return compile(code, name, "eval"), True
    except SyntaxError:
        return compile(code, name, "exec"), False


def _time(line, body=None):
    if body is not None and line.strip():
        raise UsageError("Can't use statement directly after '%%time'!")
    code = line if body is None else body
    if not code.strip():
        raise UsageError("%time needs a statement to time" if body is None else "%%time needs a cell body")
    obj, is_expr = _compile_either(code, "<timed eval>" if body is None else "<cell>")
    ns = _user_ns()
    with _Timer():
        out = eval(obj, ns) if is_expr else exec(obj, ns)
    return out if is_expr and body is None else None


def _timeit(line, body=None):
    number, repeat, precision, quiet, ret, rest = _timeit_options(line)
    setup, stmt = ("pass", rest) if body is None else (rest or "pass", body)
    if not stmt.strip():
        raise UsageError("%timeit needs a statement to time" if body is None else "%%timeit needs a cell body")
    lines = ["def _pyjs_timeit(_pyjs_it, _pyjs_clock):"]
    lines += ["    " + l for l in setup.split("\n")]
    lines += ["    _pyjs_t0 = _pyjs_clock()", "    for _pyjs_i in _pyjs_it:"]
    lines += ["        " + l for l in stmt.strip("\n").split("\n")]
    lines += ["        pass", "    return _pyjs_clock() - _pyjs_t0"]
    local = {}
    exec(compile("\n".join(lines) + "\n", "<magic-timeit>", "exec"), _user_ns(), local)
    return _measure(local["_pyjs_timeit"], number, repeat, precision, quiet, ret)


# ---------------------------------------------------------------- autoreload

def _class_report(src):
    """{name: whether autoreload may update it} for the module's top-level
    classes, from its parsed source (src/magic-syntax.ts classCellReport): a
    class whose code may use the __class__ cell (super() without arguments,
    __class__) may not.  None if the source does not parse."""
    import json
    return json.loads(__pyjs_class_cells__(src))


def _refusal(mod, k, after, report):
    """None if the new class `after` (bound to k in mod) may replace the old
    one's methods: it is the one top-level class statement named k, which
    does not use the __class__ cell.  Else why not."""
    if report is None:
        return "its source does not parse here"
    if not (after.__name__ == k and getattr(after, "__qualname__", None) == k
            and getattr(after, "__module__", None) == mod.__name__ and k in report):
        return ("class %s cannot be tied to a class statement of %s (its name, qualified name or module differ), "
                "so Sagebrush does not move its methods" % (k, mod.__name__))
    if not report[k]:
        return ("class %s uses super() without arguments (or __class__), which Sagebrush cannot move to the "
                "existing class" % k)
    return None


class _Autoreload:
    def __init__(self):
        self.mode = 0          # 0 off, 1 only %aimport'ed modules, 2 all but the excluded
        self.mtimes = {}       # module name -> mtime when last loaded or seen
        self.aimported = set()
        self.skipped = set()

    @staticmethod
    def user_modules():
        """sys.modules' modules loaded from the user's files (not Sagebrush's library)"""
        out = []
        for name, m in list(sys.modules.items()):
            f = getattr(m, "__file__", None)
            if name == "__main__" or not isinstance(f, str) or not f.endswith(".py") or f.startswith(_LIB):
                continue
            out.append((name, m, f))
        return out

    @staticmethod
    def mtime(path):
        import os
        try:
            return os.stat(path).st_mtime
        except OSError:
            return None

    def record(self):
        for name, m, f in self.user_modules():
            if name not in self.mtimes:
                self.mtimes[name] = self.mtime(f)

    def check(self, force=False):
        if self.mode == 0 and not force:
            return
        for name, m, f in self.user_modules():
            if self.mode == 1 and not force and name not in self.aimported:
                continue
            if name in self.skipped:
                continue
            t = self.mtime(f)
            old = self.mtimes.get(name)
            if old is None:
                self.mtimes[name] = t
                continue
            if t is None or t <= old:
                continue
            self.mtimes[name] = t
            try:
                notes = _reload(m, f)
            except BaseException:
                import traceback
                print("[autoreload of %s failed: %s]" % (name, traceback.format_exc()), file=sys.stderr)
                continue
            for n in notes:
                print("[autoreload of %s: %s]" % (name, n), file=sys.stderr)


def _reload(mod, path):
    """Run the module's file again in its namespace, as importlib.reload does,
    then keep its classes (updated) and rebind names bound to its old
    functions.  Returns notes on what could not be updated."""
    with open(path) as fh:
        src = fh.read()
    old = dict(mod.__dict__)
    exec(compile(src, path, "exec"), mod.__dict__)
    notes = []
    functions = {}
    report = _class_report(src)
    for k, before in old.items():
        after = mod.__dict__.get(k, before)
        if after is before:
            continue
        if isinstance(before, type) and isinstance(after, type) and getattr(after, "__module__", None) == mod.__name__:
            why = _refusal(mod, k, after, report)
            if why:
                notes.append("%s: its existing instances keep the old methods, and %s.%s is the new class"
                             % (why, mod.__name__, k))
                functions[id(before)] = (before, after)
                continue
            _update_class(before, after)
            # (the class first loaded stays the module's: its instances and names follow)
            mod.__dict__[k] = before
            functions[id(after)] = (after, before)
        elif callable(before) and not isinstance(before, type):
            functions[id(before)] = (before, after)
    if functions:
        # names bound to the old objects, in the notebook and in the user's modules
        spaces = [_user_ns()] + [m.__dict__ for _, m, _ in _Autoreload.user_modules() if m is not mod]
        for d in spaces:
            for k, v in list(d.items()):
                hit = functions.get(id(v))
                if hit is not None and hit[0] is v:
                    d[k] = hit[1]
    return notes


_SKIP_CLASS_ATTRS = {"__dict__", "__weakref__", "__module__", "__qualname__"}


def _update_class(old, new):
    """Give the old class the new one's attributes (IPython's update_class)."""
    for k in list(old.__dict__):
        if k not in _SKIP_CLASS_ATTRS and k not in new.__dict__:
            try:
                delattr(old, k)
            except (AttributeError, TypeError):
                pass
    for k, v in list(new.__dict__.items()):
        if k in _SKIP_CLASS_ATTRS:
            continue
        try:
            setattr(old, k, v)
        except (AttributeError, TypeError):
            pass


_autoreload = None


def _need_autoreload(magic):
    if _autoreload is None:
        raise UsageError("Line magic function `%%%s` not found (load it first: %%load_ext autoreload)." % magic)
    return _autoreload


def _autoreload_magic(line):
    ar = _need_autoreload("autoreload")
    arg = line.strip()
    modes = {"": 2, "0": 0, "off": 0, "1": 1, "explicit": 1, "2": 2, "all": 2}
    if arg == "now":
        ar.check(force=True)
    elif arg in modes:
        ar.mode = modes[arg]
        ar.record()
    elif arg in ("3", "complete"):
        raise UsageError("%autoreload 3 (complete) is not supported in Sagebrush: use %autoreload 2")
    else:
        raise UsageError("%%autoreload: %r is not supported in Sagebrush (it has 0, 1, 2, off, explicit, all and now)"
                         % arg)


def _aimport(line):
    ar = _need_autoreload("aimport")
    names = [n.strip() for n in line.replace(",", " ").split() if n.strip()]
    if not names:
        print("Modules to reload:\n%s\n\nModules to skip:\n%s"
              % (" ".join(sorted(ar.aimported)) if ar.mode != 2 else "all-except-skipped",
                 " ".join(sorted(ar.skipped))))
        return
    ns = _user_ns()
    for n in names:
        if n.startswith("-"):
            ar.skipped.add(n[1:])
            ar.aimported.discard(n[1:])
        else:
            ar.skipped.discard(n)
            ar.aimported.add(n)
            top = __import__(n)
            ns[n.split(".")[0]] = top
    ar.record()


def _load_ext(line, reload=False):
    global _autoreload
    name = line.strip()
    if name != "autoreload":
        raise UsageError("%%%s %s: Sagebrush has only the autoreload extension"
                         % ("reload_ext" if reload else "load_ext", name or "(no name)"))
    if _autoreload is None:
        _autoreload = _Autoreload()
        _autoreload.record()
    elif not reload:
        print("The autoreload extension is already loaded. To reload it, use:\n  %reload_ext autoreload")


def _unload_ext(line):
    global _autoreload
    if line.strip() != "autoreload":
        raise UsageError("%%unload_ext %s: Sagebrush has only the autoreload extension" % line.strip())
    _autoreload = None


def _matplotlib(line):
    gui = line.strip()
    if gui not in ("", "inline"):
        raise UsageError("%%matplotlib %s is not supported in Sagebrush: figures are shown inline (%%matplotlib inline)"
                         % gui)


def _no_shell(line):
    raise UsageError("shell commands are not available in Sagebrush: Python runs in the browser, with no shell")


def _no_install(line):
    raise UsageError("packages cannot be installed in Sagebrush: Python runs in the browser, compiled to JavaScript, "
                     "with the modules it comes with")


def _estimate(line):
    """%estimate f(args): sagebrush.estimate(f, args) for the outermost call
    only, when its arguments are names or literals (design-estimates-progress
    r4 §3); it never runs a nested call, so anything else is declined.  (A
    small parser of its own: the runtime has no ast module.)"""
    import re
    code = line.strip()
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\((.*)\)$", code, re.S)
    if not m:
        raise UsageError("%estimate needs a call, f(args)")
    func, inner = m.group(1), m.group(2)
    decline = UsageError("%estimate estimates only the outermost call, with names or literals as its "
                         "arguments: evaluate the arguments first")
    # the top-level arguments: split at commas outside string literals; any
    # bracket outside one is a nested expression, declined
    parts, cur, quote = [], "", None
    for ch in inner:
        if quote:
            cur += ch
            if ch == "\\":
                raise decline
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            cur += ch
        elif ch in "()[]{}":
            raise decline
        elif ch == ",":
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    if quote:
        raise decline
    parts.append(cur)
    parts = [p.strip() for p in parts]
    if parts == [""]:
        parts = []
    elif parts and parts[-1] == "":
        parts.pop()
    ns = _user_ns()

    def value(t):
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", t):
            if t in ("True", "False", "None"):
                return {"True": True, "False": False, "None": None}[t]
            if t in ns:
                return ns[t]
            import builtins
            if hasattr(builtins, t):
                return getattr(builtins, t)
            raise NameError("name '%s' is not defined" % t)
        if re.match(r"^-?[0-9]+$", t):
            return int(t)
        if re.match(r"^-?([0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)([eE][-+]?[0-9]+)?$", t):
            return float(t)
        if len(t) >= 2 and t[0] == t[-1] and t[0] in "'\"" and t[0] not in t[1:-1]:
            return t[1:-1]
        raise decline

    args, kwds = [], {}
    for p in parts:
        k = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$", p, re.S)
        if k:
            kwds[k.group(1)] = value(k.group(2).strip())
        elif kwds:
            raise decline
        else:
            args.append(value(p))
    names = func.split(".")
    f = value(names[0])
    for n in names[1:]:
        f = getattr(f, n)
    import sagebrush
    return sagebrush.estimate(f, *args, **kwds)


_LINE = {
    "estimate": _estimate,
    "matplotlib": _matplotlib,
    "load_ext": _load_ext,
    "reload_ext": lambda line: _load_ext(line, True),
    "unload_ext": _unload_ext,
    "autoreload": _autoreload_magic,
    "aimport": _aimport,
    "time": _time,
    "timeit": _timeit,
}
_NO_SHELL = {"system", "sx", "sc", "cd", "ls", "pwd", "env", "set_env", "bash", "sh", "script"}
_NO_INSTALL = {"pip", "conda", "mamba", "micromamba", "uv"}
_CELL = {"time": _time, "timeit": _timeit}


def run_line_magic(name, line):
    """Run the line magic %name with its argument line (IPython's run_line_magic)."""
    if name in _NO_SHELL:
        _no_shell(line)
    if name in _NO_INSTALL:
        _no_install(line)
    f = _LINE.get(name)
    if f is None:
        raise UsageError("Line magic function `%%%s` not found (Sagebrush has %s)."
                         % (name, ", ".join("%" + k for k in sorted(_LINE))))
    return f(line)


def run_cell_magic(name, line, body=None):
    """Run the cell magic %%name with its line and body (IPython's run_cell_magic)."""
    if name in _NO_SHELL:
        _no_shell(line)
    f = _CELL.get(name)
    if f is None:
        raise UsageError("Cell magic `%%%%%s` not found (Sagebrush has %s)."
                         % (name, ", ".join("%%" + k for k in sorted(_CELL))))
    return f(line, body if body is not None else "")


def pre_run_cell():
    """Before a cell runs: autoreload's check."""
    if _autoreload is not None:
        _autoreload.check()


def post_run_cell():
    """After a cell ran: the mtimes of modules it imported."""
    if _autoreload is not None:
        _autoreload.record()


class _Shell:
    """What get_ipython() returns: the magics' entry points."""

    def run_line_magic(self, magic_name, line, _stack_depth=1):
        return run_line_magic(magic_name, line)

    def run_cell_magic(self, magic_name, line, cell):
        return run_cell_magic(magic_name, line, cell)

    def system(self, cmd):
        _no_shell(cmd)

    @property
    def user_ns(self):
        return _user_ns()


_shell = _Shell()


def get_ipython():
    """The shell object, for get_ipython().run_line_magic(...) as Jupyter exports write it."""
    return _shell
