# U11 engine PR's oracle: IPython (VM2, sage-conda env) as a black box.
# 1. transform_cell: how each shell form is lowered (which forms exist).
# 2. var_expand: IPython's interpolation of {expr}, $name, $$ in the
#    namespace user_ns + the caller's locals (on any error: unchanged).
# 3. SList: l, s, n, grep, fields, sort.
# Prints one JSON document on stdout.
#
# Provenance of test/shell_forms_oracle.json (Nov 3 2026): run on VM2 (sagebrush-2)
# with the Sage 10.9 conda environment's Python and IPython 9.17.1:
#   ~/sage-conda/env/bin/python3 scripts/shell-forms-oracle.py > test/shell_forms_oracle.json
# sha256 of that JSON: 4e472d2375dac7fe3a0029891bc01293f45ed05a34c8727c90dac9fa66a4dee3
import json
from IPython.core.interactiveshell import InteractiveShell
from IPython.utils.text import SList

ip = InteractiveShell.instance()
out = {"ipython": __import__("IPython").__version__, "transform": [], "expand": [], "slist": []}

for src in [
    "!ls", "  !ls -l", "!ls {x}", "x = !ls", "x=!ls", "x =  !  ls -a", "a, b = !ls", "x.y = !ls",
    "x[0] = !ls", "x = 1 if y else !ls", "%sx ls", "x = %sx ls", "%system ls", "x = %system ls",
    "if True:\n    !ls\n    y = !pwd", "!!ls", "print(1) !ls", "s = '!ls'", "x = !ls # comment",
    "!echo $HOME", "f = lambda: 0\n!ls",
]:
    out["transform"].append({"src": src, "py": ip.transform_cell(src)})

ns = {"x": 3, "name": "world", "files": ["a.txt", "b c.txt"], "d": {"k": "v"}, "obj": type("O", (), {"attr": 7})(), "s": "it's"}
ip.user_ns.update(ns)
for cmd in [
    "echo {x}", "echo {x+1}", "echo $x", "echo $name.upper", "echo $$x", "echo $$$x", "echo {{x}}",
    "echo $undefined", "echo {undefined}", "echo $x {undefined}", "echo {files}", "echo {' '.join(files)}",
    "echo {d['k']}", "echo $obj.attr", "echo '$x'", "echo \"$x\"", "echo '$x' $x", "echo $x$x", "echo ${x}",
    "echo {x:>5}", "echo {x!r}", "echo {s}", "echo $s", "echo {1/0}", "echo $", "echo $1", "echo cost: 5$",
    "echo {x}{x}", "echo a{", "echo }", "echo $x.", "echo $x.real", "echo {files[1:]}",
]:
    out["expand"].append({"cmd": cmd, "out": ip.var_expand(cmd)})

# the caller's locals win over user_ns (IPython's ns.update(frame.f_locals))
def f():
    x = "local"
    return ip.var_expand("echo $x {x}", depth=0)
out["expand_locals"] = f()

sl = SList(["  Cat 1", "dog 22 x", "", "Bird 3"])
out["slist"] = {
    "l": list(sl.l), "s": sl.s, "n": sl.n,
    "grep_c": list(sl.grep("c")), "grep_prune": list(sl.grep("c", prune=True)),
    "grep_field": list(sl.grep("^2", field=1)), "grep_callable": list(sl.grep(lambda t: t.startswith("d"))),
    "fields": [list(r) for r in sl.fields()], "fields_1_0": list(sl.fields(1, 0)), "fields_-1": list(sl.fields(-1)),
    "fields_5": list(sl.fields(5)),
    "sort1": list(SList(["b 2", "a 10", "c 1"]).sort(field=1)), "sort1n": list(SList(["b 2", "a 10", "c 1"]).sort(field=1, nums=True)),
    "sort_plain": list(SList(["b", "a", "C"]).sort()),
    "type_grep": type(sl.grep("c")).__name__, "type_fields": type(sl.fields(1)).__name__, "type_fields0": type(sl.fields()).__name__,
    "repr": repr(SList(["a", "b"])),
}
print(json.dumps(out, indent=1))
