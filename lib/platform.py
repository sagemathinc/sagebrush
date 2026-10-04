"""Minimal platform module for the pyjs runtime."""
import sys


def python_implementation():
    return "CPython"


def python_version():
    v = sys.version_info
    return "%d.%d.%d" % (v[0], v[1], v[2])


def python_version_tuple():
    v = sys.version_info
    return (str(v[0]), str(v[1]), str(v[2]))


def system():
    return "pyjs"


def machine():
    return "js"


def platform(aliased=False, terse=False):
    return "pyjs"
