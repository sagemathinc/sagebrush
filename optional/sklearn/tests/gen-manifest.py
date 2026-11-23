"""Write optional/sklearn/sagebrush.json: the package's manifest, every shipped file under py/ with its SHA-256 and the
Python modules they make. Run after changing any file under py/:

    python3 -I optional/sklearn/tests/gen-manifest.py optional/sklearn
"""
import hashlib
import json
import os
import sys

root = sys.argv[1]
py = os.path.join(root, "py")
files = {}
modules = []
for dirpath, dirnames, filenames in os.walk(py):
    dirnames.sort()
    for f in sorted(filenames):
        if not f.endswith(".py"):
            continue
        path = os.path.join(dirpath, f)
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        files[rel] = hashlib.sha256(open(path, "rb").read()).hexdigest()
        mod = os.path.relpath(path, py).replace(os.sep, "/")[:-3].replace("/", ".")
        if mod.endswith(".__init__"):
            mod = mod[: -len(".__init__")]
        modules.append(mod)
manifest = {
    "name": "@sagebrush/sklearn",
    "version": "0.1.0",
    "kind": "optional",
    "sagebrush": ">=0.10.0",
    "modes": ["python"],
    "python": {"root": "py", "modules": sorted(modules)},
    "requires": ["@sagebrush/pandas@0.1.0"],
    "private_prefix": "_sk_",
    "distribution": "scikit-learn",
    "files": dict(sorted(files.items())),
}
with open(os.path.join(root, "sagebrush.json"), "w") as f:
    f.write(json.dumps(manifest, indent=2) + "\n")
print(len(files), "files,", len(modules), "modules")
