"""The library never imports the public name of its own sagebrush package.

    python3 scripts/library_imports.py        # lists any such import; exit status 1 if there is one

Sagebrush's library (lib/, packages/*/py, optional/*/py) imports its own package, lib/sagebrush/, by the private
name _sagebrush_lib, which the runtime binds to the library's files whatever a user's sagebrush.py or sagebrush/
folder (src/compile.ts libraryPackage; engine/py/python/sagebrush/__init__.py under CPython).  An import of the public
name from library code would find a user's file instead.  This checks the code, not the docstrings (whose examples
are a user's and use the public name): every `import sagebrush[.x]`, `from sagebrush[.x] import ...`, and the string
forms importlib.import_module("sagebrush...") and __import__("sagebrush...").
"""
import ast
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PUBLIC = "sagebrush"


def library_files():
    yield from _py_under("lib")
    for kind in ("packages", "optional"):
        base = os.path.join(ROOT, kind)
        for d in sorted(os.listdir(base)) if os.path.isdir(base) else []:
            if os.path.isdir(os.path.join(base, d, "py")):
                yield from _py_under(os.path.join(kind, d, "py"))


def _py_under(rel):
    for dirpath, dirs, files in os.walk(os.path.join(ROOT, rel)):
        dirs.sort()
        for f in sorted(files):
            if f.endswith(".py"):
                yield os.path.join(dirpath, f)


def public(name):
    return name == PUBLIC or name.startswith(PUBLIC + ".")


def violations(path):
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except SyntaxError:
        return []
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and n.level == 0 and n.module and public(n.module):
            out.append((n.lineno, "from %s import ..." % n.module))
        elif isinstance(n, ast.Import):
            out += [(n.lineno, "import %s" % a.name) for a in n.names if public(a.name)]
        elif isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str) and public(n.args[0].value):
            f = n.func
            name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else None
            if name in ("import_module", "__import__"):
                out.append((n.lineno, "%s(%r)" % (name, n.args[0].value)))
    return out


def main():
    bad = []
    for p in library_files():
        for line, what in violations(p):
            bad.append("%s:%d: %s (the library imports its own package as _sagebrush_lib)" % (os.path.relpath(p, ROOT), line, what))
    for b in bad:
        print(b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
