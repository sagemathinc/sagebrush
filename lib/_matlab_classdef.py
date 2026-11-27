"""MATLAB's classdef value classes, for lib/_matlab.py: a class file's definition (src/matlab.ts emits it, with
its methods and its properties' defaults as Python functions), its objects (_m.Obj), their construction, their
properties' and methods' access, method dispatch, display, and the built-ins on objects.  Loaded with the first class
file, or the first call of a built-in only objects have (properties, methods, isobject, isprop).

What a class file uses that Sagebrush doesn't do yet is refused when the class loads, with a clear error, never
ignored: superclasses (handle classes and inheritance), events, enumerations, property validation, Dependent and
Abstract members, and property get and set methods.
"""

import os as _os

import _matlab as _m
from _matlab import _err, Obj, ObjArr, Char, Cell, Builtin, NOVAL


class ClassDef:
    """a class: its name, its properties in order with their attributes, their defaults (evaluated once, when the
    class is first used), its constants, its methods by name (with their attributes), and its constructor"""
    __slots__ = ("name", "file", "props", "attrs", "defaults", "dvals", "consts", "cvals", "methods", "ctor_fn",
                 "ctor", "folder_methods")

    def __init__(self, name, file):
        self.name = name
        self.file = file
        self.props = []          # names of the instance properties, in order
        self.attrs = {}          # property name -> its block's attributes
        self.defaults = {}       # property name -> function giving its default
        self.dvals = None        # property name -> its default, once evaluated
        self.consts = []         # names of the Constant properties
        self.cvals = None
        self.methods = {}        # name -> (Function, attributes, static)
        self.ctor_fn = None
        self.ctor = None
        self.folder_methods = set()


_CLASSES = {}
_STACK = []   # objects being constructed, innermost last (_m.cd_self)


def _attr(attrs, *names):
    """an attribute's value (names case-insensitive, the first given that is set), lowercased, or None"""
    low = {k.lower(): v for k, v in attrs.items()}
    for n in names:
        v = low.get(n.lower())
        if v is not None:
            return v.strip().strip("'\"").lower()
    return None


def _true(attrs, name):
    v = _attr(attrs, name)
    return v is not None and v != "false"


def _refuse(cls, what):
    raise _err("%s: %s %s not supported in Sagebrush yet." % (cls, what, "are" if what.endswith("s") else "is"))


def define(meta, methods, defaults):
    """the class a class file defines (src/matlab.ts's classFile): checked, then built"""
    name = meta["name"]
    for u in meta["later"]:
        _refuse(name, u["what"])
    if meta["supers"]:
        _refuse(name, "superclasses (handle classes and inheritance, classdef %s < %s)" % (name, " & ".join(meta["supers"])))
    for a in ("Abstract", "InferiorClasses", "AllowedSubclasses"):
        if _true(meta["attrs"], a) or (a != "Abstract" and _attr(meta["attrs"], a) is not None):
            _refuse(name, "the class attribute %s" % a)
    cd = ClassDef(name, meta["file"])
    for p in meta["props"]:
        if p["validated"]:
            _refuse(name, "property validation (the size, class or validators of '%s')" % p["name"])
        for a in ("Dependent", "Abstract"):
            if _true(p["attrs"], a):
                _refuse(name, "%s properties" % a)
        if p["name"] in cd.attrs:
            raise _err("Property '%s' is defined more than once in class '%s'." % (p["name"], name))
        cd.attrs[p["name"]] = p["attrs"]
        if _true(p["attrs"], "Constant"):
            cd.consts.append(p["name"])
        else:
            cd.props.append(p["name"])
        if p["name"] in defaults:
            cd.defaults[p["name"]] = defaults[p["name"]]
    # (a method the class file declares, with a body or as a signature, with a property's name: MATLAB's class
    # definition error, when the class is first used; a method file of the @-folder alone may share it)
    declared = [m[0] for m in methods] + [s["name"] for s in meta["sigs"]]
    for m in declared:
        if m in cd.attrs:
            raise _err("'%s' is already defined as a property in the '%s' class." % (m, name), "MATLAB:class:PropertyInUse")
    for mname, fn, attrs, _line, _col in methods:
        if _true(attrs, "Abstract"):
            _refuse(name, "Abstract methods")
        if mname == name:
            cd.ctor_fn = fn
            continue
        cd.methods[mname] = (fn, attrs, _true(attrs, "Static"))
    sig_attrs = {s["name"]: s["attrs"] for s in meta["sigs"]}
    for s in meta["sigs"]:
        if _true(s["attrs"], "Abstract"):
            _refuse(name, "Abstract methods")
    _PENDING.append((cd, sig_attrs))
    return cd


_PENDING = []


def load(name, path, body, function_file):
    """the class in the classdef file at path (its Python, body): defined, with the method files of its @-folder,
    and registered; its constructor, a built-in"""
    del _PENDING[:]
    ns = {"__name__": "_matlab_class_" + name}
    exec(body, ns)
    if not _PENDING:
        raise _err("%s: the file defines no class." % name)
    cd, sig_attrs = _PENDING.pop()
    del _PENDING[:]
    folder = _os.path.dirname(path)
    if _os.path.basename(folder) == "@" + cd.name.split(".")[-1]:
        try:
            entries = sorted(_os.listdir(folder))
        except OSError:
            entries = []
        for e in entries:
            if not e.endswith(".m") or e[:-2] == cd.name.split(".")[-1]:
                continue
            mname = e[:-2]
            fn = function_file(_os.path.join(folder, e))
            if fn is None:
                continue
            attrs = sig_attrs.get(mname, {})
            if mname not in cd.methods:
                cd.methods[mname] = (fn, attrs, _true(attrs, "Static"))
                cd.folder_methods.add(mname)
    qual = name
    cd.name = cd.name if "." not in qual else qual
    _CLASSES[cd.name] = cd

    def construct(nargout, *args):
        return _construct(cd, args)
    cd.ctor = Builtin(construct, cd.name, (0, None))
    _m._CD_CTORS[cd.ctor] = cd
    for mname, (fn, attrs, static) in cd.methods.items():
        if not static:
            _m._CDM[mname] = True
    _m._CD_GEN[0] += 1
    return cd.ctor


def _defaults(cd):
    """the class's property defaults, evaluated once, when the class is first used"""
    if cd.dvals is None:
        vals = {}
        for p in cd.props + cd.consts:
            f = cd.defaults.get(p)
            vals[p] = f() if f is not None else _m._empty_double()
        cd.cvals = {p: vals[p] for p in cd.consts}
        cd.dvals = {p: vals[p] for p in cd.props}
    return cd.dvals


def _construct(cd, args):
    """Name(args): an object with the defaults, then the constructor run with it as its output"""
    obj = Obj(cd, {k: _m.cp(v) for k, v in _defaults(cd).items()})
    if cd.ctor_fn is None:
        if args:
            raise _err("Too many input arguments.", "MATLAB:TooManyInputs")
        return obj
    _STACK.append(obj)
    try:
        r = cd.ctor_fn.call(1, list(args))
    finally:
        _STACK.pop()
    if type(r) is not Obj or r.cls is not cd:
        raise _err("The constructor of class '%s' must return an object of the class." % cd.name)
    return r


def constructing():
    if not _STACK:
        raise _err("An object can only be constructed by its class's constructor.")
    return _STACK[-1]


def _get_access(cd, name):
    return _attr(cd.attrs.get(name, {}), "GetAccess", "Access") or "public"


def _set_access(cd, name):
    return _attr(cd.attrs.get(name, {}), "SetAccess", "Access") or "public"


def _bound(fn, obj, name):
    """obj.name, a method, as a callable: called with obj first"""
    return Builtin(lambda nargout, *a: fn.call(nargout, [obj] + list(a)), name, (0, None))


def _check_get(cd, name, ctx):
    if _get_access(cd, name) != "public" and ctx != cd.name:
        raise _err("No public property '%s' for class '%s'." % (name, cd.name), "MATLAB:class:GetProhibited")


def _check_method(cd, name, attrs, ctx):
    if (_attr(attrs, "Access") or "public") != "public" and ctx != cd.name:
        raise _err("Cannot access method '%s' in class '%s'." % (name, cd.name), "MATLAB:class:MethodRestricted")


def get(obj, name, ctx, call):
    """obj.name: a property's value, or a method, called (call) or as a callable, with the access of class ctx"""
    cd = obj.cls
    if name in obj.props:
        _check_get(cd, name, ctx)
        return obj.props[name]
    if name in cd.consts:
        _check_get(cd, name, ctx)
        _defaults(cd)
        return cd.cvals[name]
    m = cd.methods.get(name)
    if m is not None:
        fn, attrs, static = m
        _check_method(cd, name, attrs, ctx)
        if static:
            return fn.call(1, []) if call else fn
        return fn.call(1, [obj]) if call else _bound(fn, obj, name)
    raise _err("Unrecognized method, property, or field '%s' for class '%s'." % (name, cd.name), "MATLAB:noSuchMethodOrField")


def default_object(cd):
    """an object the class's constructor makes with no arguments: a grown array's gap, as MATLAB fills it"""
    return _construct(cd, ())


def get_array(arr, name, ctx, call):
    """arr.name for an array of objects: a property's values, the first as one value (all of them as arr.name in a
    comma-separated list, _m.field_cs); a method called with the array"""
    cd = arr.cls
    if name in cd.props or name in cd.consts:
        if not arr.a:
            raise _err("Expected one output from a curly brace or dot indexing expression, but there were 0 results.")
        return get(arr.a[0], name, ctx, True)
    m = cd.methods.get(name)
    if m is not None:
        fn, attrs, static_ = m
        _check_method(cd, name, attrs, ctx)
        if static_:
            return fn.call(1, []) if call else fn
        return fn.call(1, [arr]) if call else Builtin(lambda nargout, *a: fn.call(nargout, [arr] + list(a)), name, (0, None))
    raise _err("Unrecognized method, property, or field '%s' for class '%s'." % (name, cd.name), "MATLAB:noSuchMethodOrField")


def static(cd, name, call, ctx=None):
    """Name.name: a static method (called, or as a callable) or a Constant property, with the access of class ctx;
    Name.empty, an empty array of the class (Name.empty(m, n, ...): of that size, one of whose dimensions is 0)"""
    if name == "empty" and name not in cd.methods:
        def empty(nargout, *dims):
            shape = tuple(int(_m._scalar(d)) for d in dims) if len(dims) > 1 else \
                (tuple(int(x) for x in _m._farr(dims[0]).real.reshape(-1)) if dims else (0, 0))
            if len(shape) == 1:
                shape = (shape[0], shape[0])
            if 0 not in shape:
                raise _err("At least one dimension must be zero.", "MATLAB:class:emptyMustBeZero")
            return ObjArr(cd, [], shape)
        b = Builtin(empty, "empty", (0, None))
        return b.call(1, []) if call else b
    if name in cd.consts:
        _check_get(cd, name, ctx)
        _defaults(cd)
        return cd.cvals[name]
    m = cd.methods.get(name)
    if m is not None and m[2]:
        _check_method(cd, name, m[1], ctx)
        return m[0].call(1, []) if call else m[0]
    raise _err("The class %s has no Constant property or Static method named '%s'." % (cd.name, name),
               "MATLAB:subscripting:classHasNoPropertyOrMethod")


def set_member(obj, name, path, i, v, ctx):
    """obj.name = v (or deeper: obj.name.x = v, obj.name(k) = v), with the access of class ctx"""
    cd = obj.cls
    if name not in obj.props:
        if name in cd.consts:
            raise _err("Unable to set the '%s' property of class '%s' because it is read-only." % (name, cd.name),
                       "MATLAB:class:SetProhibited")
        raise _err("Unrecognized property '%s' for class '%s'." % (name, cd.name), "MATLAB:noPublicFieldForClass")
    if _set_access(cd, name) != "public" and ctx != cd.name:
        raise _err("Unable to set the '%s' property of class '%s' because it is read-only." % (name, cd.name),
                   "MATLAB:class:SetProhibited")
    if i == len(path) - 1:
        obj.props[name] = v
    else:
        cur = obj.props[name]
        obj.props[name] = _m._asg(cur if not _m._isempty_double(cur) else None, path, i + 1, v)
    return obj


# ------------------------------------------------------------------ dispatch

_DISPATCH = {}


def dispatcher(name, top, imports, cls=None):
    """the callee a method's name resolves to: the method of the dominant argument's class (the leftmost object, as
    MATLAB picks it among classes of equal precedence), the arguments in their order; without one, what the name is
    otherwise"""
    key = (name, top, tuple(imports) if imports else None, cls)
    d = _DISPATCH.get(key)
    if d is None:
        def call(nargout, *args):
            for a in args:
                if type(a) is Obj or type(a) is ObjArr:
                    m = a.cls.methods.get(name)
                    if m is not None and not m[2]:
                        # (a private method: only in its class's own methods, cls)
                        _check_method(a.cls, name, m[1], cls)
                        return m[0].call(nargout, list(args))
                    break
            return _m._fn_tail(name, top, imports).call(nargout, list(args))
        d = _DISPATCH[key] = Builtin(call, name, (0, None))
    return d


# ------------------------------------------------------------------ display and the built-ins on objects

def _public(cd):
    """the properties code outside the class can read, in order"""
    return [p for p in cd.props if _get_access(cd, p) == "public" and not _true(cd.attrs.get(p, {}), "Hidden")]


def blocks(obj):
    cd = obj.cls
    names = _public(cd)
    short = cd.name.split(".")[-1]
    if type(obj) is ObjArr:
        # (an array: its size and class, then its properties' names, as MATLAB shows it)
        head = "  %s %s array with %s" % (_m._dimstr(obj.shape), short, "properties:" if names else "no properties.")
        return [head], ["\n".join("    " + n for n in names)] if names else []
    if not names:
        return ["  %s with no properties." % short], []
    return ["  %s with properties:" % short], [_m._struct_fields_text(obj.props, names)]


def isa(obj, n):
    return n == obj.cls.name


def _class_of(x, fname):
    if type(x) is Obj:
        return x.cls
    if _m._istext(x):
        n = _m._text(x)
        f = _m.fn(n)
        cd = _m._CD_CTORS.get(f)
        if cd is not None:
            return cd
        raise _err("%s: '%s' is not a class." % (fname, n))
    return None


def properties_(nargout, x):
    cd = _class_of(x, "properties")
    names = _public(cd) + [c for c in cd.consts if _get_access(cd, c) == "public"] if cd is not None else []
    if nargout >= 1:
        return Cell([Char(n) for n in names], (len(names), 1))
    if cd is None:
        return NOVAL
    short = cd.name.split(".")[-1]
    _m._write("\nProperties for class %s:\n\n%s\n\n" % (short, "\n".join("    " + n for n in names)))
    return NOVAL


def _method_names(cd):
    """(the instance methods with the constructor, the static methods), each sorted, public ones"""
    pub = [(n, s) for n, (f, a, s) in cd.methods.items() if (_attr(a, "Access") or "public") == "public"]
    inst = sorted([n for n, s in pub if not s] + [cd.name.split(".")[-1]])
    stat = sorted([n for n, s in pub if s])
    return inst, stat


def methods_(nargout, x):
    cd = _class_of(x, "methods")
    if cd is None:
        if nargout >= 1:
            return Cell([], (0, 1))
        return NOVAL
    inst, stat = _method_names(cd)
    if nargout >= 1:
        names = sorted(inst + stat)
        return Cell([Char(n) for n in names], (len(names), 1))
    w = max(len(n) for n in inst + stat) + 2
    out = "\nMethods for class %s:\n\n%s\n\n" % (cd.name.split(".")[-1], "".join(n.ljust(w) for n in inst))
    if stat:
        out += "Static methods:\n\n%s\n\n" % "".join(n.ljust(w) for n in stat)
    _m._write(out)
    return NOVAL


def isprop_(x, name):
    """whether the class has the property, whatever its access"""
    if type(x) is not Obj:
        return False
    n = _m._text(name) if _m._istext(name) else None
    return n is not None and (n in x.props or n in x.cls.consts)


def _ones(args):
    """whether subscripts all address the one element of a 1-by-1 value (1, 1, or :)"""
    for a in args:
        if _m._istext(a) and _m._text(a) == ":":
            continue
        if _m._isnumlike(a) and _m._numel(a) == 1 and float(_m._scalar(a)) == 1.0:
            continue
        return False
    return True


def fieldnames(obj):
    names = _public(obj.cls)
    return Cell([Char(n) for n in names], (len(names), 1))


def to_struct(obj):
    """struct(obj): every property, with MATLAB's warning"""
    _m.warning_("Calling STRUCT on an object prevents the object from hiding its implementation details and should "
                "thus be avoided. Use DISP or DISPLAY to see the visible public details of an object. See 'help "
                "struct' for more information.", "MATLAB:structOnObject")
    return _m.Struct([{k: _m.cp(v) for k, v in obj.props.items()}], (1, 1), list(obj.props))


def isequal(a, b, eq):
    """two objects are equal when of the same class with equal properties (eq: the elements' comparison); two arrays
    of them, when of one size with equal elements"""
    if type(a) is ObjArr or type(b) is ObjArr:
        if type(a) is not ObjArr or type(b) is not ObjArr or a.cls is not b.cls or tuple(a.shape) != tuple(b.shape):
            return False
        return all(isequal(x, y, eq) for x, y in zip(a.a, b.a))
    if type(a) is not Obj or type(b) is not Obj or a.cls is not b.cls:
        return False
    return all(eq(a.props[k], b.props[k]) for k in a.props)


# ---------------------------------------------------------------- arrays of objects (_m.ObjArr), loaded with classes


def objs(cls, a, shape):
    """objects of class cls as one MATLAB value: an Obj when there is one, 1-by-1"""
    if len(a) == 1 and tuple(_m._canon_dims(shape)) == (1, 1):
        return a[0]
    return ObjArr(cls, a, shape)


# the bytes Sagebrush spends on one object of an array beyond its properties' values: the Obj, its dict and its place
# in the list (measured on node: about 230 bytes an object for a class of one scalar property, its value included, and
# about 1450 for three properties, 1, [] and 'x'; each property's value is charged as a cell's element holding it)
_OBJ_ELEMENT_BYTES = 256


def _object_bytes(obj):
    """an object's estimated memory here: its shell, and each property's value as a cell element holding it"""
    n = _OBJ_ELEMENT_BYTES
    for v in obj.props.values():
        t = type(v)
        n += _object_bytes(v) if t is Obj else sum(_object_bytes(o) for o in v.a) if t is ObjArr else \
            _m._CELL_ELEMENT_BYTES + _m._bytes(v)
    return n


def _admit_objects(need, n, cls):
    """n objects of class cls, need bytes, admitted before any is made (_matlab's _admit_bytes)"""
    _m._admit_bytes(need, "An array of %d %s objects" % (n, cls.name))


def admit_copies(arr, pos):
    """copies of an object array's elements at pos (an index, repelem) admitted before any is made"""
    costs = _m.np.array([_object_bytes(o) for o in arr.a], dtype=_m.np.float64)
    _admit_objects(int(costs[pos.reshape(-1)].sum()) if pos.size else 0, pos.size, arr.cls)


def resize_array(cur, o, nw, total):
    """an object array grown to nw (from o): the gap's elements one object the class's constructor makes with no
    arguments, copied into each, as MATLAB's object arrays page says it fills them; the gap's copies admitted at their
    measured cost before any is made"""
    gap = total - len(cur.a)
    dflt = default_object(cur.cls) if gap else None
    if gap:
        _admit_objects(gap * _object_bytes(dflt), total, cur.cls)
    items = [None] * total
    if cur.a:
        vecs = [_m.np.arange(x, dtype=_m.np.int64) for x in o]
        pos = _m._combine(vecs, nw).reshape(-1)
        for k, p in enumerate(pos):
            items[int(p)] = cur.a[k]
    items = [x if x is not None else _m.cp(dflt) for x in items]
    return ObjArr(cur.cls, items, tuple(nw))


def assign_array(cur, pos, v, nv):
    """arr(...) = v: objects of the array's class, each element its own copy"""
    tv = type(v)
    if (tv is not Obj and tv is not ObjArr) or v.cls is not cur.cls:
        raise _err("Unable to perform assignment because value of type '%s' is not convertible to '%s'."
                   % (_m.class_(v), cur.cls.name), "MATLAB:UnableToConvert")
    items = [v] if tv is Obj else v.a
    for k, p in enumerate(pos):
        cur.a[int(p)] = _m.cp(items[0 if nv == 1 else k])
    return objs(cur.cls, cur.a, cur.shape)


def cat_class(vals):
    """a concatenation with objects in it: objects, of the leftmost object's class"""
    return "objects"


def _converted(oc, v):
    """v as an object of class oc for a concatenation: the class's constructor called with it, as MATLAB converts to
    the dominant (leftmost) object's class; its error, if it fails, after MATLAB's line naming the conversion"""
    try:
        return _construct(oc, [v])
    except _m.MatlabError as e:
        raise _err("The following error occurred converting from %s to %s:\n%s" % (_m.class_(v), oc.name, e.message),
                   "MATLAB:UnableToConvert")


def cat_objects(vals, parts, dim):
    """[a b] or [a; b] with objects: each value of another class converted to the leftmost object's class (an empty
    double, [], is left out)"""
    oc = next(v.cls for v in vals if type(v) is Obj or type(v) is ObjArr)
    items = []
    for v in parts:
        if (type(v) is Obj or type(v) is ObjArr) and v.cls is oc:
            items.append(ObjArr(oc, [v], (1, 1)) if type(v) is Obj else v)
        elif not _m._isempty_double(v):
            c = _converted(oc, v)
            items.append(ObjArr(oc, [c], (1, 1)) if type(c) is Obj else c)
    if not items:
        return ObjArr(oc, [], (0, 0))
    r = _m._cat_containers(items, dim, Cell)
    return objs(oc, r.a, r.shape)


def isprop_array(x, name):
    """isprop of an object array: the class's answer, for each element"""
    return _m._box(_m.np.full(tuple(reversed(x.shape)), bool(len(x.a)) and isprop_(x.a[0], name), dtype=bool))
