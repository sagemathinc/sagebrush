"""The Sage-mode name index, lib/_sage_names.py: which library module supplies
each public name of Sage mode's namespace, so a name can be loaded the first
time it is used.

    python3 scripts/sage_names.py --write    rewrite lib/_sage_names.py
    python3 scripts/sage_names.py --check    fail if it is stale or inconsistent (CI)

lib/_sage_names.py is the source of truth: pure data, no imports.

  NAMES      public name -> the module that defines it
  DEPS       module -> the Sage-layer modules it imports when it is imported
             (module level), for every module NAMES reaches, closed under DEPS
  OVERRIDES  public name -> the module that wins, for each name that more than
             one Sage-layer module defines (the others define their own
             variant, used inside their domain)
  ALIASES    public name -> the NAMES name it is bound to in sage_all
             (`Matrix = matrix`): the same object under a second name
  ALL        the names `from sage_all import *` gives: sage_all.__all__
  SHIM_NAMES public name -> module, for the names that only Sage's module
             paths reach (`from sage.schemes.elliptic_curves.ell_rational_field
             import EllipticCurve_rational_field`): every public name, not in
             ALL, that one of _sage_shim._SOURCES binds at module level (the
             first of them in that order, as the shim's lookup finds it)

--write keeps the file's NAMES and OVERRIDES (adding the names sage_all still
imports from a domain, while it does) and recomputes DEPS and ALL from the
sources.  --check fails when:
  - the file differs from what --write would write (a byte compare);
  - a name's module isn't a Sage-layer module in lib/, or doesn't define the
    name at module level;
  - a name is defined by more than one Sage-layer module and isn't in
    OVERRIDES with its NAMES module as the winner (or OVERRIDES lists a name
    that isn't such a duplicate);
  - sage_all imports a public name from a domain module that NAMES doesn't
    map to that module, or itself (re)defines a name NAMES maps to a domain.
"""
import ast
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB = os.path.join(ROOT, "lib")
OUT = os.path.join(LIB, "_sage_names.py")


def is_sage_module(m):
    return m.startswith(("_sage_", "sage_")) and m not in ("sage_all", "_sage_names")


def parse(m):
    with open(os.path.join(LIB, m + ".py"), encoding="utf-8") as f:
        return ast.parse(f.read())


def module_body(tree):
    """Statements run at import: the module body and its if/try/with blocks."""
    stack = list(tree.body)
    while stack:
        n = stack.pop(0)
        yield n
        if isinstance(n, (ast.If, ast.Try, ast.With)):
            kids = []
            for field in ("body", "orelse", "finalbody"):
                kids += list(getattr(n, field, []) or [])
            for h in getattr(n, "handlers", []) or []:
                kids += list(h.body)
            stack = kids + stack


def defined(m, imports=True, modules=True):
    """Names a module binds at module level: def, class, assignment, and (with
    imports) the names it imports, which re-export another module's object
    (with modules, also the module objects of `import x`)."""
    out = set()
    for n in module_body(parse(m)):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(n.name)
        elif isinstance(n, ast.Assign):
            for t in n.targets:
                for e in (t.elts if isinstance(t, (ast.Tuple, ast.List)) else [t]):
                    if isinstance(e, ast.Name):
                        out.add(e.id)
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)) and isinstance(n.target, ast.Name):
            out.add(n.target.id)
        elif imports and isinstance(n, ast.ImportFrom):
            for a in n.names:
                out.add(a.asname or a.name)
        elif imports and modules and isinstance(n, ast.Import):
            for a in n.names:
                out.add((a.asname or a.name).split(".")[0])
    return out


def shim_sources():
    """_sage_shim._SOURCES (a literal list), read without importing it."""
    for n in parse("_sage_shim").body:
        if isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "_SOURCES" for t in n.targets):
            vals = literal_strs(n.value)
            if vals is None:
                raise SystemExit("sage_names: _sage_shim._SOURCES isn't a literal list")
            return vals
    raise SystemExit("sage_names: _sage_shim has no _SOURCES")


def import_edges(m):
    """The Sage-layer modules m imports at import time."""
    out = set()
    for n in module_body(parse(m)):
        if isinstance(n, ast.ImportFrom) and n.module and n.level == 0:
            top = n.module.split(".")[0]
            if is_sage_module(top):
                out.add(top)
        elif isinstance(n, ast.Import):
            for a in n.names:
                top = a.name.split(".")[0]
                if is_sage_module(top):
                    out.add(top)
    out.discard(m)
    return out


def sage_all_imports():
    """public name -> module, for sage_all's module-level `from <domain> import ...`
    and its global lazy_import stubs."""
    out = {}
    for n in module_body(parse("sage_all")):
        if isinstance(n, ast.ImportFrom) and n.module and is_sage_module(n.module):
            for a in n.names:
                local = a.asname or a.name
                if not local.startswith("_"):
                    out[local] = n.module
        elif (isinstance(n, ast.Expr) and isinstance(n.value, ast.Call)
              and getattr(n.value.func, "id", "") == "_lazy_import"
              and isinstance(n.value.args[0], ast.Constant)):
            arg = n.value.args[1]
            for v in ([arg] if isinstance(arg, ast.Constant) else getattr(arg, "elts", [])):
                if isinstance(v, ast.Constant):
                    out[v.value] = n.value.args[0].value
    return out


def literal_strs(node):
    if isinstance(node, (ast.List, ast.Tuple)):
        return [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return None


def sage_all_all():
    """sage_all.__all__, evaluated statically: the literal list, its .append and
    += of literals at module level, and the loop over a literal dict's keys.
    An append under a condition (the pyjs-only `sage`) is left out."""
    tree = parse("sage_all")
    literal_dicts = {}
    out = []
    for n in tree.body:
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            name = n.targets[0].id
            if name == "__all__":
                vals = literal_strs(n.value)
                if vals is None:
                    raise SystemExit("sage_names: sage_all's __all__ isn't a literal list")
                out = list(vals)
            elif isinstance(n.value, ast.Dict):
                literal_dicts[name] = [k.value for k in n.value.keys if isinstance(k, ast.Constant)]
        elif (isinstance(n, ast.AugAssign) and isinstance(n.target, ast.Name) and n.target.id == "__all__"):
            vals = literal_strs(n.value)
            if vals is None:
                raise SystemExit("sage_names: sage_all extends __all__ with a non-literal (line %d)" % n.lineno)
            out += vals
        elif isinstance(n, ast.Expr) and isinstance(n.value, ast.Call):
            f = n.value.func
            if (isinstance(f, ast.Attribute) and f.attr == "append" and getattr(f.value, "id", "") == "__all__"):
                a = n.value.args[0]
                if not (isinstance(a, ast.Constant) and isinstance(a.value, str)):
                    raise SystemExit("sage_names: sage_all appends a non-literal to __all__ (line %d)" % n.lineno)
                out.append(a.value)
        elif isinstance(n, ast.For):
            # for _n, (...) in <dict>.items(): ... __all__.append(_n)
            appends = [c for c in ast.walk(n) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
                       and c.func.attr == "append" and getattr(c.func.value, "id", "") == "__all__"]
            if appends:
                it = n.iter
                src = None
                if isinstance(it, ast.Call) and isinstance(it.func, ast.Attribute) and it.func.attr in ("items", "keys"):
                    src = getattr(it.func.value, "id", None)
                elif isinstance(it, ast.Name):
                    src = it.id
                if src not in literal_dicts:
                    raise SystemExit("sage_names: sage_all appends to __all__ in a loop it can't read (line %d)" % n.lineno)
                out += literal_dicts[src]
    return out


def current():
    """The file's NAMES and OVERRIDES (empty if it doesn't exist yet)."""
    if not os.path.exists(OUT):
        return {}, {}
    ns = {}
    with open(OUT, encoding="utf-8") as f:
        exec(compile(f.read(), OUT, "exec"), ns)
    return dict(ns.get("NAMES", {})), dict(ns.get("OVERRIDES", {}))


HEADER = '''"""The Sage-mode name index: which library module supplies each public name
of Sage mode's namespace, for loading a domain the first time one of its
names is used.  Pure data, no imports.

NAMES and OVERRIDES are maintained by hand (--write adds to NAMES the names
sage_all imports from a domain); DEPS, ALIASES, ALL and SHIM_NAMES are
written from the sources by `python3 scripts/sage_names.py --write`.  CI
runs --check (see that script for what it verifies).
"""
'''


def render(names, deps, overrides, aliases, all_names, shim_names):
    lines = [HEADER]
    lines.append("# public name -> the module that defines it")
    lines.append("NAMES = {")
    lines += ["    %r: %r," % (k, names[k]) for k in sorted(names)]
    lines.append("}")
    lines.append("")
    lines.append("# module -> the Sage-layer modules it imports at module level")
    lines.append("DEPS = {")
    lines += ["    %r: (%s)," % (k, ", ".join(repr(d) for d in deps[k]) + ("," if len(deps[k]) == 1 else "")) for k in sorted(deps)]
    lines.append("}")
    lines.append("")
    lines.append("# public name -> the winning module, for names more than one Sage-layer module defines")
    lines.append("OVERRIDES = {")
    lines += ["    %r: %r," % (k, overrides[k]) for k in sorted(overrides)]
    lines.append("}")
    lines.append("")
    lines.append("# public name -> the NAMES name sage_all binds it to (the same object)")
    lines.append("ALIASES = {")
    lines += ["    %r: %r," % (k, aliases[k]) for k in sorted(aliases)]
    lines.append("}")
    lines.append("")
    lines.append("# the names `from sage_all import *` gives (sage_all.__all__)")
    lines.append("ALL = (")
    lines += ["    %r," % k for k in sorted(set(all_names))]
    lines.append(")")
    lines.append("")
    lines.append("# public name -> module, for the names only Sage's module paths (sage.*) reach")
    lines.append("SHIM_NAMES = {")
    lines += ["    %r: %r," % (k, shim_names[k]) for k in sorted(shim_names)]
    lines.append("}")
    return "\n".join(lines) + "\n"


def compute():
    """(text, problems) for what --write would write."""
    problems = []
    names, overrides = current()
    all_names = sage_all_all()
    # (a name sage_all imports but leaves out of __all__ is its own helper,
    # not a name of the session's namespace)
    imported = {k: m for k, m in sage_all_imports().items() if k in set(all_names)}
    for k, m in imported.items():
        if k not in names:
            names[k] = m
        elif names[k] != m:
            problems.append("%s: sage_all imports it from %s, NAMES says %s" % (k, m, names[k]))
    sage_mods = sorted(f[:-3] for f in os.listdir(LIB) if f.endswith(".py") and is_sage_module(f[:-3]))
    defs = {m: defined(m) for m in sage_mods}
    own = {m: defined(m, imports=False) for m in sage_mods}
    for k, m in sorted(names.items()):
        if m not in defs:
            problems.append("%s: %s isn't a Sage-layer module in lib/" % (k, m))
        elif k not in defs[m]:
            problems.append("%s: %s doesn't define it at module level" % (k, m))
    dup = {}
    for k, m in names.items():
        # (a module that imports the name re-exports the same object: not a duplicate)
        cands = sorted(x for x in sage_mods if k in own[x])
        if len(cands) > 1:
            dup[k] = cands
    for k, cands in sorted(dup.items()):
        if k not in overrides:
            problems.append("%s: defined by %s; add it to OVERRIDES with its winner" % (k, ", ".join(cands)))
        elif overrides[k] != names[k]:
            problems.append("%s: OVERRIDES says %s, NAMES says %s" % (k, overrides[k], names[k]))
    for k in sorted(set(overrides) - set(dup)):
        problems.append("%s: in OVERRIDES, but only one Sage-layer module defines it" % k)
    deps, todo = {}, sorted(set(names.values()))
    while todo:
        m = todo.pop()
        if m in deps or m not in defs:
            continue
        deps[m] = sorted(import_edges(m))
        todo += [d for d in deps[m] if d not in deps]
    deps = {m: d for m, d in deps.items() if d}
    for k in sorted(set(names) - set(all_names)):
        problems.append("%s: in NAMES but not in sage_all.__all__" % k)
    sage_all_own = defined("sage_all", imports=False)
    for k in sorted(set(names) & sage_all_own):
        problems.append("%s: sage_all (re)defines it, but NAMES maps it to %s" % (k, names[k]))
    aliases = {}
    for n in module_body(parse("sage_all")):
        if isinstance(n, ast.Assign) and isinstance(n.value, ast.Name) and n.value.id in names:
            for t in n.targets:
                if isinstance(t, ast.Name) and not t.id.startswith("_") and t.id in set(all_names):
                    aliases[t.id] = n.value.id
    shim_names = {}
    allset = set(all_names)
    for m in shim_sources():
        if m != "sage_all" and m not in defs:
            problems.append("_sage_shim._SOURCES names %s, which isn't a Sage-layer module in lib/" % m)
            continue
        for k in sorted(defined(m, modules=False)):
            if not k.startswith("_") and k not in allset and k not in shim_names:
                shim_names[k] = m
    # (DEPS covers the modules SHIM_NAMES reaches too)
    todo = sorted(set(shim_names.values()) - {"sage_all"})
    while todo:
        m = todo.pop()
        if m in deps or m not in defs:
            continue
        e = sorted(import_edges(m))
        if e:
            deps[m] = e
        todo += [d for d in e if d not in deps]
    return render(names, deps, overrides, aliases, all_names, shim_names), problems


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    text, problems = compute()
    if mode == "--write":
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(text)
        for p in problems:
            print("sage_names:", p)
        print("sage_names: wrote %s" % os.path.relpath(OUT, ROOT))
        sys.exit(1 if problems else 0)
    if mode != "--check":
        raise SystemExit("usage: sage_names.py --write | --check")
    old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
    if old != text:
        problems.append("lib/_sage_names.py is out of date: run python3 scripts/sage_names.py --write")
    for p in problems:
        print("sage_names:", p)
    if problems:
        sys.exit(1)
    print("sage_names: lib/_sage_names.py is current")


if __name__ == "__main__":
    main()
