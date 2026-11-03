# The shell forms' Python side (lib/_pyjs_shell.py, imported as sagebrush.shell) against IPython's own
# results, frozen in test/shell_forms_oracle.json by scripts/shell-forms-oracle.py
# (IPython 9.17.1): var_expand's {expr}, $name and $$, and SList.  Run by
# test/shell-forms.test.ts; prints one JSON document.
import json
import sys
from sagebrush.shell import var_expand, SList, ShellError, ShellUnavailableError, ShellLimitError, BashError
import _pyjs_shell
from _pyjs_shell import _namespace
assert _pyjs_shell.SList is SList and _pyjs_shell.ShellError is ShellError and ShellError.__module__ == "sagebrush.shell"

oracle = json.load(open(sys.argv[1]))
ns = {"x": 3, "name": "world", "files": ["a.txt", "b c.txt"], "d": {"k": "v"}, "obj": type("O", (), {"attr": 7})(), "s": "it's"}
out = {"expand": [], "slist": {}}
for e in oracle["expand"]:
    out["expand"].append({"cmd": e["cmd"], "out": var_expand(e["cmd"], ns)})
# the calling code's locals over its globals
out["expand_locals"] = var_expand("echo $x {x}", _namespace(dict(ns), {"x": "local"}))

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
out["errors"] = [issubclass(ShellError, OSError), issubclass(ShellUnavailableError, ShellError),
                 issubclass(ShellLimitError, ShellError), issubclass(BashError, ShellError),
                 str(ShellLimitError("ops", 5))]
print(json.dumps(out))
