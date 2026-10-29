"""A control for the harness itself, not an mpmath test.

compare.py copies it next to mpmath's tests as mpmath/tests/harness_control.py
and runs it under CPython and pyjs before the real modules.  Each interpreter
must report one pass and two failures as JSON: a crash of the harness (no JSON)
fails the run.  test_seeded's failure text carries the first draw from the
seeded random stream, and the two interpreters must report the same one.
"""
import random


def test_passes():
    pass


def test_fails():
    assert 1 + 1 == 3, "harness control: an injected failing assert"


def test_seeded():
    raise AssertionError("harness control: first seeded draw %r" % random.random())
