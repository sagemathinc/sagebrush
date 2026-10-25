"""The memory guards' message in the CPython package (item D, D1): the
same module and class as in the engine (_sagelib/_memguard.py as the
top-level module _memguard), where() is "package", its routes are those
the package can still take, and a fixed limit names none (astra's
PR114-SEM-1).

    python engine/py/test_memguard.py
"""
import subprocess
import sys


def run(code):
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600)
    return r.returncode, r.stdout, r.stderr


def test_package_message():
    code = '''import sagebrush
from sagebrush.sage import *
import _memguard, _sage_ffmat as FM
print(_memguard.where())
try:
    matrix(QQ, 10**5, 10**5)
except MemoryError as e:
    print(type(e) is _memguard.SagebrushMemoryError, e.fixed, e.need_bytes, e.limit_bytes)
    print(e)
FM._heap_limit = lambda: FM._HEAP_SHARE * FM._entry_cost(GF(7)) * 1000
try:
    matrix(GF(7), 10, 101)
except MemoryError as e:
    print(type(e) is _memguard.SagebrushMemoryError, e.fixed)
    print("\\n".join(str(e).splitlines()[:1] + str(e).splitlines()[2:]))
'''
    rc, out, err = run(code)
    assert rc == 0, (rc, out, err[-2000:])
    assert out == "\n".join([
        "package",
        "True True 80000000000 33554432",
        "This computation is larger than Sagebrush allows.",
        "A 100000 x 100000 matrix needs about 80 GB, but Sagebrush has a fixed limit of about 33 MB for one matrix.",
        "This limit is the same whatever memory there is: more memory or a larger",
        "machine won't help.",
        "True False",
        "Not enough memory for this computation.",
        "To run it with more memory:",
        "- in a cocalc.ai project, with the same package;",
        "- on a dedicated machine with as much memory as it needs, rented through",
        "  cocalc.ai.",
        "",
    ]), out


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all memguard tests passed")
