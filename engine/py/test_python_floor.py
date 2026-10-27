"""The Python floor (William, Oct 27 2026: "Yes, drop 3.9 (require Python
3.10+)"): both packages require 3.10, the wheel's abi3 floor is the same, and
the installed wheel says so.

    python engine/py/test_python_floor.py
"""

import os
import re
import sys
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
FLOOR = (3, 10)


def load(path):
    with open(path, "rb") as f:
        return tomllib.load(f)


def floor_of(spec):
    m = re.fullmatch(r">=\s*3\.(\d+)", spec.strip())
    assert m, "requires-python %r is not a plain >=3.N floor" % spec
    return (3, int(m.group(1)))


py = load(os.path.join(HERE, "pyproject.toml"))
mcp = load(os.path.join(HERE, "..", "py-mcp", "pyproject.toml"))
assert floor_of(py["project"]["requires-python"]) == FLOOR, py["project"]["requires-python"]
assert floor_of(mcp["project"]["requires-python"]) == FLOOR, mcp["project"]["requires-python"]

# (the extension's abi3 floor is the same: one abi3 feature, for 3.10)
abi3 = [f for f in py["tool"]["maturin"]["features"] if "abi3" in f]
assert abi3 == ["pyo3/abi3-py%d%d" % FLOOR], abi3
print("python floor: pyproject.toml and py-mcp require %d.%d; the wheel is abi3-py%d%d" % (FLOOR + FLOOR))

# (and the installed wheel, when there is one, carries that tag and requirement)
try:
    from importlib import metadata
    dist = metadata.distribution("sagebrush")
except Exception:
    dist = None
if dist is not None and dist.read_text("WHEEL"):
    tags = re.findall(r"^Tag: (\S+)$", dist.read_text("WHEEL"), re.M)
    assert tags and all(t.startswith("cp%d%d-abi3-" % FLOOR) for t in tags), tags
    assert floor_of(dist.metadata["Requires-Python"]) == FLOOR, dist.metadata["Requires-Python"]
    print("python floor: the installed wheel is %s, Requires-Python %s" % (tags[0], dist.metadata["Requires-Python"]))
else:
    print("python floor: no installed wheel to check (skipped)")
assert sys.version_info[:2] >= FLOOR
print("python floor: ok")
