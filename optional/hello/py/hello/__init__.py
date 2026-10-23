"""A tiny optional package: it proves the core is byte-identical with an
optional package present, and exercises a set's build, admission and import
end to end (plan-modular-packages-r4, M0)."""
import numpy as np

_hello_count = 0


def greet(name="world"):
    """greet() -> 'hello, world'; greet('you') -> 'hello, you'"""
    global _hello_count
    _hello_count += 1
    return f"hello, {name}"


def total(xs):
    """The sum of a list of numbers, through numpy's public API."""
    return float(np.sum(np.asarray(xs, dtype=float)))


def count():
    """How many times greet has been called in this session."""
    return _hello_count
