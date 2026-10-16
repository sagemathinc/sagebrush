# __future__, pprint and textwrap (CPython 3.14's, copied unchanged): what
# CPython prints for the same calls (test/stdlib-small.test.ts).
from __future__ import annotations, division
import __future__
print(__future__.annotations, sorted(__future__.all_feature_names))


import pprint
data = {"z": [1, 2, {"deep": list(range(30))}], "a": ("t",) * 12, "m": {1, 2, 3}, "s": "x" * 90}
pprint.pprint(data)
pprint.pprint(data, width=40, depth=2)
pprint.pprint(data, compact=True, sort_dicts=False)
print(pprint.pformat([[1, 2], [3, 4]] * 10, indent=2, width=30))
print(pprint.saferepr({"r": [1, [2, [3]]]}), pprint.isreadable([1, 2]), pprint.isrecursive([1]))
r = [1, 2]
r.append(r)
pprint.pprint(r)
pp = pprint.PrettyPrinter(width=20)
pp.pprint(list(range(12)))
pprint.pp({"b": 1, "a": 2})

import textwrap
t = "The wrap() method is just like fill() except that it returns a list of strings instead of one big string with newlines to separate the wrapped lines."
print(textwrap.wrap(t, 30))
print(textwrap.fill(t, width=40, initial_indent="* ", subsequent_indent="  "))
print(textwrap.shorten(t, width=50, placeholder=" [...]"))
print(repr(textwrap.dedent("    a\n      b\n    c\n")))
print(repr(textwrap.indent("a\nb\n\nc", "> ")))
w = textwrap.TextWrapper(width=12, break_long_words=False, max_lines=3)
print(w.wrap("supercalifragilistic expialidocious words go here and there"))
print(textwrap.wrap("tab\there and a-hyphenated-word-to-break", 10, tabsize=4))
