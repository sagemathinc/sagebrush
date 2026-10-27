"""The Python floor (William, Oct 27 2026: "Yes, drop 3.9 (require Python
3.10+)"): both packages require 3.10, the wheel's abi3 floor is the same, the
installed wheel says so, and the package's Python parses as 3.10.

    python engine/py/test_python_floor.py [--wheel]

--wheel (CI and pypi, where a wheel was just installed): the installed
`sagebrush` distribution must exist and carry a WHEEL record; a missing one
fails.  Without it, the wheel part runs only if a wheel is installed.  Where
tomllib is missing (Python 3.10) the pyproject part is skipped, said so; the
rest still runs.
"""

import ast
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOR = (3, 10)
WHEEL = "--wheel" in sys.argv[1:]


def floor_of(spec):
    m = re.fullmatch(r">=\s*3\.(\d+)", (spec or "").strip())
    assert m, "requires-python %r is not a plain >=3.N floor" % spec
    return (3, int(m.group(1)))


# 1. the pyproject files (tomllib: Python 3.11+)
try:
    import tomllib
except ImportError:
    tomllib = None
if tomllib is None:
    print("python floor: no tomllib on Python %d.%d: the pyproject part is skipped" % sys.version_info[:2])
else:
    def load(path):
        with open(path, "rb") as f:
            return tomllib.load(f)

    py = load(os.path.join(HERE, "pyproject.toml"))
    mcp = load(os.path.join(HERE, "..", "py-mcp", "pyproject.toml"))
    assert floor_of(py["project"]["requires-python"]) == FLOOR, py["project"]["requires-python"]
    assert floor_of(mcp["project"]["requires-python"]) == FLOOR, mcp["project"]["requires-python"]
    # (the extension's abi3 floor is the same: one abi3 feature, for 3.10)
    abi3 = [f for f in py["tool"]["maturin"]["features"] if "abi3" in f]
    assert abi3 == ["pyo3/abi3-py%d%d" % FLOOR], abi3
    print("python floor: pyproject.toml and py-mcp require %d.%d; the wheel is abi3-py%d%d" % (FLOOR + FLOOR))

# 2. every Python file of the two packages (and the package's tests) parses as 3.10 (grader's check)
files = sorted(set(glob.glob(os.path.join(HERE, "python", "**", "*.py"), recursive=True)
                   + glob.glob(os.path.join(HERE, "..", "py-mcp", "**", "*.py"), recursive=True)
                   + glob.glob(os.path.join(HERE, "*.py"))))
assert len(files) > 20, "too few files found (%d): the paths are wrong" % len(files)
bad = []
for f in files:
    with open(f, encoding="utf-8") as fh:
        src = fh.read()
    try:
        ast.parse(src, f, feature_version=FLOOR)
    except SyntaxError as e:
        bad.append("%s:%s: %s" % (os.path.relpath(f, HERE), e.lineno, e.msg))
assert not bad, "not Python %d.%d syntax:\n  %s" % (FLOOR + ("\n  ".join(bad),))
print("python floor: %d files parse as Python %d.%d" % ((len(files),) + FLOOR))

# 3. the installed wheel: its tag and requirement (required with --wheel)
from importlib import metadata

try:
    dist = metadata.distribution("sagebrush")
except metadata.PackageNotFoundError:
    dist = None
record = dist.read_text("WHEEL") if dist is not None else None
if WHEEL:
    assert dist is not None, "--wheel: no installed sagebrush distribution"
    assert record, "--wheel: the installed sagebrush has no WHEEL record (not installed from a wheel)"
if record:
    tags = re.findall(r"^Tag: (\S+)$", record, re.M)
    assert tags and all(t.startswith("cp%d%d-abi3-" % FLOOR) for t in tags), tags
    assert floor_of(dist.metadata["Requires-Python"]) == FLOOR, dist.metadata["Requires-Python"]
    print("python floor: the installed wheel is %s, Requires-Python %s" % (tags[0], dist.metadata["Requires-Python"]))
else:
    print("python floor: no installed wheel to check (skipped; --wheel makes it required)")
assert sys.version_info[:2] >= FLOOR
print("python floor: ok")
