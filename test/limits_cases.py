# lib/_limits.py's validator, case by case (plan-ff-limits r3, section 5):
# the first failure in the plan's order, in words.  The .out was written
# under CPython (python3 -I with lib/ on sys.path); test/limits.test.ts runs
# this under the engine and compares, so the two hosts agree byte for byte.
import _limits as L

TEXTS = [
    "{}",
    '{"ff.work": 100000}',
    '{"ff.work": 100000000, "ff.embed_max": 4096, "ff.conway_work": 1000000, "ff.root_bits": 64}',
    '{"ff.wrok": 1}',
    '{"ff.work": 5, "ff.wrok": 1}',
    '{"zz": 1, "ff.work": true}',
    '{"ff.work": true}',
    '{"ff.work": false}',
    '{"ff.work": 1.5}',
    '{"ff.work": 1e7}',
    '{"ff.work": 10000000.0}',
    '{"ff.work": "big"}',
    '{"ff.work": null}',
    '{"ff.work": [1]}',
    '{"ff.work": {"a": 1}}',
    '{"ff.work": NaN}',
    '{"ff.work": -Infinity}',
    '{"ff.work": 5}',
    '{"ff.work": 99999}',
    '{"ff.work": 100000001}',
    '{"ff.embed_max": 2097152}',
    '{"ff.embed_max": 255}',
    '{"ff.conway_work": 653528896}',
    '{"ff.root_bits": 2048}',
    '{"ff.root_bits": 63}',
    '{"ff.work": 9223372036854775808}',
    '{"ff.work": -9223372036854775809}',
    '{"ff.work": 100000, "ff.work": 100000}',
    "[1]",
    "null",
    '"x"',
    "3",
    "true",
    "{",
    "",
    "﻿{}",
    '{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8, "i": 9, "j": 10, "k": 11, "l": 12, "m": 13, "n": 14, "o": 15, "p": 16, "q": 17}',
    '{"' + "k" * 100 + '": 1}',
    '{"a\\nb": 1}',
    '{"ff.work": 100000' + " " * 4100 + "}",
    '{"ff.work": "' + "é" * 2047 + '"}',
    '{"ff.work": "' + "é" * 2049 + '"}',
    # "unlimited" (plan-c0 r2): the defaults, given explicitly, mixed with
    # finite values; any other spelling is refused
    '{"ff.work": "unlimited"}',
    '{"ff.work": "unlimited", "ff.conway_work": "unlimited", "ff.embed_max": "unlimited", "ff.root_bits": "unlimited"}',
    '{"ff.work": 100000, "ff.root_bits": "unlimited"}',
    '{"ff.embed_max": 4096}',
    '{"ff.work": "Unlimited"}',
    '{"ff.work": " unlimited"}',
    '{"ff.work": "inf"}',
    '{"ff.work": Infinity}',
    '{"ff.work": "unlimited", "ff.work": 100000}',
]

class Sly(str):
    """A str whose own methods lie: read as its str value."""
    def __str__(self):
        return "unlimited"

    def __eq__(self, other):
        return True

    __hash__ = str.__hash__


MAPPINGS = [
    {},
    {"ff.work": 100000, 3: 1},
    {3: 1, "ff.work": 100000},
    {"ff.work": True, 3: 1},
    {(1, 2): 1},
    {"k" * 65: 1},
    {"ff.work": 1.5},
    {"ff.work": 2 ** 70},
    {"ff.work": 5},
    {"zz": 1},
    {str(i): 1 for i in range(17)},
    [("ff.work", 100000)],
    "x",
    b"{}",
    {"ff.work": "unlimited"},
    {"ff.work": "unlimited", "ff.root_bits": 64},
    {"ff.work": "Unlimited"},
    {"ff.work": None},
    {"ff.work": float("inf")},
    {"ff.work": Sly("unlimited")},
    {"ff.work": Sly("big")},
]


def show(source, name=None):
    try:
        s = L.validate(source, name)
        print("ok", dict(s.items()), s)
    except ValueError as e:
        print("ValueError", e)


for t in TEXTS:
    show(t)
show("{", "/etc/limits.json")
show('{"ff.work": 100000' + " " * 4100 + "}", "big.json")
for m in MAPPINGS:
    show(m)

