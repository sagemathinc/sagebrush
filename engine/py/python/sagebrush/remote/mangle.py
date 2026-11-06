"""A cell's `_` names made its own, in CPython's ast: the native runner's
port of the reactive notebook's mangleLocals (src/dataflow.ts).  A name is
local to a cell when it is `__` or starts with one `_` (isLocal); the cell's
uses of such a name *as a global* become `_cell_<id>_name`, so two cells'
`_tmp` never meet.  Names a function, lambda, comprehension or class binds
for itself are left alone (a class's `_cache = {}` stays `self._cache`), as
are attributes, keyword names and strings.

A cell with `from m import *` isn't mangled at all (the browser refuses to
analyze it the same way: ImportStarError).

    mangle(tree, cell_id, sage=False)   # in place; the ast of the cell's code
    local_prefix(cell_id)   # "_cell_<id>_": the prefix of its renamed names
"""

import ast
import re


def is_local(name):
    return name == "__" or (name.startswith("_") and not name.startswith("__"))


def local_prefix(cell_id):
    return "_cell_%s_" % cell_id


class _Scope:
    def __init__(self, kind, parent):
        self.kind = kind  # "module", "function", "class", "comprehension"
        self.parent = parent
        self.bound = set()
        self.globals = set()
        self.nonlocals = set()


def _targets(node, out):
    """Names a target expression binds."""
    if isinstance(node, ast.Name):
        out.add(node.id)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for e in node.elts:
            _targets(e, out)
    elif isinstance(node, ast.Starred):
        _targets(node.value, out)


class _Binder(ast.NodeVisitor):
    """The names one scope binds (not descending into nested scopes)."""

    def __init__(self, scope):
        self.s = scope

    def bind(self, name):
        self.s.bound.add(name)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bind(node.id)

    def visit_FunctionDef(self, node):
        self.bind(node.name)
        for d in node.decorator_list:
            self.visit(d)
        self._outside_args(node.args)
        if node.returns:
            self.visit(node.returns)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.bind(node.name)
        for d in node.decorator_list + node.bases + [k.value for k in node.keywords]:
            self.visit(d)

    def visit_Lambda(self, node):
        self._outside_args(node.args)

    def _outside_args(self, a):
        for d in a.defaults + [d for d in a.kw_defaults if d is not None]:
            self.visit(d)

    def _comp(self, node):
        # (the first iterable is evaluated outside; a walrus inside binds here)
        self.visit(node.generators[0].iter)
        for n in ast.walk(node):
            if isinstance(n, ast.NamedExpr) and isinstance(n.target, ast.Name):
                self.bind(n.target.id)

    visit_ListComp = visit_SetComp = visit_GeneratorExp = visit_DictComp = _comp

    def visit_Import(self, node):
        for a in node.names:
            self.bind(a.asname or a.name.split(".")[0])

    def visit_ImportFrom(self, node):
        for a in node.names:
            if a.name != "*":
                self.bind(a.asname or a.name)

    def visit_Global(self, node):
        self.s.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.s.nonlocals.update(node.names)

    def visit_ExceptHandler(self, node):
        if node.name:
            self.bind(node.name)
        self.generic_visit(node)

    def visit_MatchAs(self, node):
        if node.name:
            self.bind(node.name)
        self.generic_visit(node)

    def visit_MatchStar(self, node):
        if node.name:
            self.bind(node.name)

    def visit_MatchMapping(self, node):
        if node.rest:
            self.bind(node.rest)
        self.generic_visit(node)

    def visit_NamedExpr(self, node):
        if isinstance(node.target, ast.Name):
            self.bind(node.target.id)
        self.visit(node.value)


def _args_names(a):
    names = [x.arg for x in a.posonlyargs + a.args + a.kwonlyargs]
    if a.vararg:
        names.append(a.vararg.arg)
    if a.kwarg:
        names.append(a.kwarg.arg)
    return names


class _Renamer(ast.NodeVisitor):
    def __init__(self, prefix):
        self.prefix = prefix

    # ---- resolution: does `name`, used in scope s, mean the module's global?
    def is_global(self, s, name):
        if s.kind == "module":
            return True
        if name in s.globals:
            return True
        if name in s.nonlocals:
            return False
        if name in s.bound:
            return False
        p = s.parent
        while p is not None:
            if p.kind == "class":  # (a class's names aren't seen from the scopes inside it)
                p = p.parent
                continue
            if p.kind == "module":
                return True
            if name in p.globals:
                return True
            if name in p.bound or name in p.nonlocals:
                return False
            p = p.parent
        return True

    def ren(self, s, name):
        return self.prefix + name[1:] if is_local(name) and self.is_global(s, name) else name

    # ---- scopes
    def scope(self, kind, parent, body_nodes, extra_bound=()):
        s = _Scope(kind, parent)
        s.bound.update(extra_bound)
        b = _Binder(s)
        for n in body_nodes:
            b.visit(n)
        return s

    def run_module(self, tree):
        s = self.scope("module", None, tree.body)
        self.body(s, tree.body)

    def body(self, s, nodes):
        for n in nodes:
            self.node(s, n)

    def node(self, s, n):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for d in n.decorator_list:
                self.node(s, d)
            self.args_outside(s, n.args)
            if n.returns:
                self.node(s, n.returns)
            n.name = self.ren(s, n.name)
            inner = self.scope("function", s, n.body, _args_names(n.args))
            self.args_annotations(s, n.args)
            self.body(inner, n.body)
            return
        if isinstance(n, ast.Lambda):
            self.args_outside(s, n.args)
            inner = self.scope("function", s, [n.body], _args_names(n.args))
            self.node(inner, n.body)
            return
        if isinstance(n, ast.ClassDef):
            for d in n.decorator_list + n.bases:
                self.node(s, d)
            for k in n.keywords:
                self.node(s, k.value)
            n.name = self.ren(s, n.name)
            inner = self.scope("class", s, n.body)
            self.body(inner, n.body)
            return
        if isinstance(n, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            self.node(s, n.generators[0].iter)
            bound = set()
            for g in n.generators:
                _targets(g.target, bound)
            inner = _Scope("comprehension", s)
            inner.bound.update(bound)
            for i, g in enumerate(n.generators):
                self.node(inner, g.target)
                if i:
                    self.node(inner, g.iter)
                for c in g.ifs:
                    self.node(inner, c)
            for part in ("elt", "key", "value"):
                if getattr(n, part, None) is not None:
                    self.node(inner, getattr(n, part))
            return
        if isinstance(n, ast.NamedExpr):
            # (a walrus in a comprehension binds in the scope around it)
            t = s
            while t.kind == "comprehension":
                t = t.parent
            if isinstance(n.target, ast.Name):
                n.target.id = self.ren(t, n.target.id)
            self.node(s, n.value)
            return
        if isinstance(n, ast.Name):
            n.id = self.ren(s, n.id)
            return
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            if isinstance(n, ast.Global):
                n.names = [self.prefix + x[1:] if is_local(x) else x for x in n.names]
            return
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            for a in n.names:
                if a.name == "*":
                    continue
                bound = a.asname or (a.name.split(".")[0] if isinstance(n, ast.Import) else a.name)
                new = self.ren(s, bound)
                if new != bound:
                    if isinstance(n, ast.Import) and a.asname is None and "." in a.name:
                        continue  # (import _a.b binds _a: left as is, a rare case)
                    a.asname = new
            return
        if isinstance(n, ast.ExceptHandler):
            if n.type is not None:
                self.node(s, n.type)
            if n.name:
                n.name = self.ren(s, n.name)
            self.body(s, n.body)
            return
        if isinstance(n, ast.MatchAs) or isinstance(n, ast.MatchStar):
            if getattr(n, "pattern", None) is not None:
                self.node(s, n.pattern)
            if n.name:
                n.name = self.ren(s, n.name)
            return
        if isinstance(n, ast.MatchMapping):
            for k in n.keys:
                self.node(s, k)
            for p in n.patterns:
                self.node(s, p)
            if n.rest:
                n.rest = self.ren(s, n.rest)
            return
        if isinstance(n, ast.keyword):
            self.node(s, n.value)  # (the keyword's name is never renamed)
            return
        for child in ast.iter_child_nodes(n):
            self.node(s, child)

    def args_outside(self, s, a):
        for d in a.defaults + [d for d in a.kw_defaults if d is not None]:
            self.node(s, d)

    def args_annotations(self, s, a):
        for x in a.posonlyargs + a.args + a.kwonlyargs + [v for v in (a.vararg, a.kwarg) if v]:
            if x.annotation is not None:
                self.node(s, x.annotation)


_IDENT = re.compile(r"^[^\W\d]\w*$")


def _private_vars(tree):
    """A Sage cell's top-level `var('_x ...')` naming private names would set the global _x, shared by every cell;
    as `_x, ... = SR.var('_x ...')` (which sets no global) it binds the cell's own _x, renamed as the cell's other
    private names are (src/dataflow.ts privateVars).  In place."""
    body = []
    for st in tree.body:
        call = st.value if isinstance(st, ast.Expr) else None
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "var" and call.args
                and all(isinstance(a, ast.Constant) and isinstance(a.value, str) for a in call.args)):
            body.append(st)
            continue
        names = [n for a in call.args for n in re.split(r"[\s,]+", a.value) if n]
        if not any(is_local(n) for n in names) or not all(_IDENT.match(n) for n in names):
            body.append(st)
            continue
        pos = dict(lineno=st.lineno, col_offset=st.col_offset, end_lineno=st.end_lineno, end_col_offset=st.end_col_offset)
        targets = [ast.Name(id=n, ctx=ast.Store(), **pos) for n in names]
        target = targets[0] if len(targets) == 1 else ast.Tuple(elts=targets, ctx=ast.Store(), **pos)
        func = ast.Attribute(value=ast.Name(id="SR", ctx=ast.Load(), **pos), attr="var", ctx=ast.Load(), **pos)
        # (one string: SR.var('a b') gives a tuple for several names; keywords such as domain= kept)
        value = ast.Call(func=func, args=[ast.Constant(value=" ".join(names), **pos)], keywords=call.keywords, **pos)
        body.append(ast.Assign(targets=[target], value=value, **pos))
    tree.body = body


def mangle(tree, cell_id, sage=False):
    """Rename the cell's global `_` names, in place (in Sage mode, its private var() names first).  Returns False
    (and changes nothing) for a cell with `from m import *`."""
    for n in ast.walk(tree):
        if isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names):
            return False
    if sage:
        _private_vars(tree)
    _Renamer(local_prefix(cell_id)).run_module(tree)
    return True
