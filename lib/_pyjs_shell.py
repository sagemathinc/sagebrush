"""The shell's Python side: IPython's `!cmd`, `x = !cmd`, `!!cmd`, %sx and
%system (plan-u11-shell-forms r5, plan-bash-shell r3 §7).

    !cmd           system(cmd): prints the command's output; sets _exit_code
    x = !cmd       getoutput(cmd): its output's lines, an SList
    !!cmd, %sx     the same as x = !cmd, as an expression

The command is expanded first, as IPython's var_expand does: {expr} is
evaluated, $name and $name.attr are substituted, $$ is a literal $, in the
calling code's namespace (its globals, then its locals).  Values are not
quoted.  Text inside single quotes keeps its $name.  If anything in the
command fails to expand, the whole command is left as written.

The shell itself isn't connected yet: once expanded, a command raises
ShellUnavailableError.  ShellError is an OSError; ShellLimitError,
ShellUnavailableError and BashError are its kinds."""
import re
import string

__all__ = ["ShellError", "ShellLimitError", "ShellUnavailableError", "BashError", "SList", "var_expand",
           "system", "getoutput"]


class ShellError(OSError):
    """A shell command that couldn't run to its end."""


class ShellLimitError(ShellError):
    """A command stopped at one of the shell's limits (key, value)."""

    def __init__(self, key, value):
        super().__init__("bash.%s exceeded (%s)" % (key, value))
        self.key = key
        self.value = value


class ShellUnavailableError(ShellError):
    """There is no shell to run the command in."""


class BashError(ShellError):
    """bash(..., check=True): the script exited with a nonzero status."""

    def __init__(self, result):
        super().__init__("the script exited with status %d" % result.exit_code)
        self.result = result


class SList(list):
    """IPython's SList: a list of an output's lines, with
    l (the list), s (joined with spaces), n (joined with newlines),
    grep(pattern, prune=False, field=None), fields(*fields) and
    sort(field=None, nums=False)."""

    @property
    def l(self):
        return self

    list = l

    @property
    def s(self):
        return " ".join(self)

    spstr = s

    @property
    def n(self):
        return "\n".join(self)

    nlstr = n

    def grep(self, pattern, prune=False, field=None):
        """The lines matching pattern (a regex, case-insensitive, or a
        callable); with prune, those not matching; with field, the match is
        tried on that whitespace-separated field only."""
        def target(s):
            if field is None:
                return s
            parts = s.split()
            try:
                return parts[field]
            except IndexError:
                return ""
        if isinstance(pattern, str):
            pred = lambda x: re.search(pattern, x, re.IGNORECASE)
        else:
            pred = pattern
        return type(self)([el for el in self if bool(pred(target(el))) != bool(prune)])

    def fields(self, *fields):
        """The given whitespace-separated fields of each line, joined with a
        space (lines with none of them left out); without fields, each line
        split."""
        if not fields:
            return [el.split() for el in self]
        res = SList()
        for el in [f.split() for f in self]:
            parts = []
            for fd in fields:
                try:
                    parts.append(el[fd])
                except IndexError:
                    pass
            if parts:
                res.append(" ".join(parts))
        return res

    def sort(self, field=None, nums=False):
        """The lines sorted by a field (see fields(); as numbers, with nums),
        as a new SList."""
        if field is not None:
            dsu = [[SList([line]).fields(field), line] for line in self]
        else:
            dsu = [[line, line] for line in self]
        if nums:
            for d in dsu:
                try:
                    d[0] = int("".join([ch for ch in d[0] if ch.isdigit()]))
                except ValueError:
                    d[0] = 0
        dsu.sort()
        return type(self)([d[1] for d in dsu])


class _DollarFormatter(string.Formatter):
    # $name and $name.attr in the literal text, not inside single quotes; $$ is $
    _dollar = re.compile(r"(.*?)\$(\$?[\w\.]+)(?=([^']*'[^']*')*[^']*$)")

    def parse(self, fmt):
        for literal, field, spec, conversion in string.Formatter.parse(self, fmt):
            at, txt = 0, ""
            for m in self._dollar.finditer(literal):
                before, name = m.group(1, 2)
                if name.startswith("$"):
                    txt += before + name
                else:
                    yield (txt + before, name, "", None)
                    txt = ""
                at = m.end()
            yield (txt + literal[at:], field, spec, conversion)

    def vformat(self, fmt, args, kwargs):
        out = []
        for literal, field, spec, conversion in self.parse(fmt):
            if literal:
                out.append(literal)
            if field is not None:
                if spec:
                    field = field + ":" + spec   # (a slice, not a format spec)
                obj = eval(field, dict(kwargs))
                out.append(self.format_field(self.convert_field(obj, conversion), ""))
        return "".join(out)


def var_expand(cmd, ns):
    """cmd with {expr}, $name and $$ expanded in ns, as IPython's var_expand;
    unchanged if anything fails."""
    try:
        return _DollarFormatter().vformat(cmd, [], ns)
    except Exception:
        return cmd


def _namespace(g, l):
    ns = dict(g) if g is not None else {}
    if l is not None and l is not g:
        ns.update(l)
    return ns


def _run(cmd):
    if cmd.rstrip().endswith("&"):
        raise OSError("Background processes not supported.")
    e = ShellUnavailableError("shell commands aren't available in Sagebrush yet: the shell isn't connected to "
                              "Python (it comes in a later update)")
    e.command = cmd   # (the command as expanded)
    raise e


def system(cmd, g=None, l=None):
    """!cmd: run cmd, after expanding it in the caller's namespace (g, l)."""
    _run(var_expand(cmd, _namespace(g, l)))


def getoutput(cmd, g=None, l=None):
    """x = !cmd: cmd's output, an SList of its lines."""
    _run(var_expand(cmd, _namespace(g, l)))


# (shown as sagebrush.shell's, where they are imported from)
for _c in (ShellError, ShellLimitError, ShellUnavailableError, BashError, SList):
    _c.__module__ = "sagebrush.shell"
del _c
