"""Primitives and accelerators for the typing module.
"""
# Sagebrush's _typing: CPython 3.14's Objects/typevarobject.c (and the Union
# its _typing names), written in Python. Its types, reprs, errors and laziness
# are CPython's; what calls back into typing.py does so as CPython does, so a
# bound given by hand, a TypeVarTuple's unpacking or a generic class's
# subscription needs typing itself. The compiler's PEP 695 statements (class
# C[T], def f[T], type X = ...) make their type parameters here, through
# _make_typevar and its siblings (src/runtime/intrinsics: the compiler's only
# way in).

import sys as _sys
import types as _types

Union = _types.UnionType


def _idfunc(x, /):
    return x


def _parse(fname, args, kwargs, pos, kwonly=(), star=False):
    """CPython's Argument Clinic for these constructors: `pos` names its
    positional-or-keyword parameters, the first one a str; `kwonly` its
    keyword-only ones (name, default); `star`: the rest of the positional
    ones gathered. Returns (values by name, the gathered tuple)."""
    out = {}
    rest = ()
    n = len(pos)
    if len(args) > n:
        if star:
            rest = tuple(args[n:])
        else:
            raise TypeError(f"{fname}() takes exactly {n} positional argument{'s' if n != 1 else ''} ({len(args)} given)")
    for i, a in enumerate(args[:n]):
        out[pos[i]] = a
    names = dict(kwonly)
    for k, v in kwargs.items():
        if k in pos:
            if k in out:
                raise TypeError(f"argument for {fname}() given by name ('{k}') and position ({pos.index(k) + 1})")
            out[k] = v
        elif k in names:
            out[k] = v
        else:
            raise TypeError(f"{fname}() got an unexpected keyword argument '{k}'")
    for i, p in enumerate(pos):
        if p not in out:
            raise TypeError(f"{fname}() missing required argument '{p}' (pos {i + 1})")
    for k, d in kwonly:
        out.setdefault(k, d)
    if not isinstance(out[pos[0]], str):
        raise TypeError(f"{fname}() argument '{pos[0]}' must be str, not {type(out[pos[0]]).__name__}")
    return out, rest


# A read-only attribute of these types' instances (CPython's Py_READONLY
# members and setter-less getsets): `get` computes it
class _ReadOnly:
    __slots__ = ("name", "get", "__doc__")

    def __init__(self, get, doc=None):
        self.get = get
        self.__doc__ = doc

    def __set_name__(self, owner, name):
        self.name = name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        return self.get(obj)

    def __set__(self, obj, value):
        raise AttributeError("readonly attribute")

    def __delete__(self, obj):
        raise AttributeError("readonly attribute")


def _final(cls):
    """A type no class can subclass (CPython's: no Py_TPFLAGS_BASETYPE)."""
    def __init_subclass__(sub, **kwargs):
        name = cls.__name__ if cls.__module__ == "builtins" else f"{cls.__module__}.{cls.__name__}"
        raise TypeError(f"type '{name}' is not an acceptable base type")

    cls.__init_subclass__ = classmethod(__init_subclass__)
    return cls


def _caller():
    """The module of the code calling the constructor, as CPython's caller():
    None where there is none."""
    try:
        return _sys._getframe(2).f_globals.get("__name__")
    except (ValueError, AttributeError):
        return None


def _typing_call(name, *args):
    import typing
    return getattr(typing, name)(*args)


def _type_check(arg, msg):
    # (None is NoneType without typing, as CPython's, which calls typing.py
    # for anything else: here a bootstrapping problem it avoids for None)
    if arg is None:
        return type(None)
    return _typing_call("_type_check", arg, msg)


def _make_union(self, other):
    # (a typing.Union of the two, as CPython's make_union: Union[...]'s rules,
    # so a member that isn't a class goes through typing's _type_check)
    return Union[self, other]


def _unpack(self):
    import typing
    return typing.Unpack[self]


def _unpack_typevartuples(params):
    if any(type(p) is TypeVarTuple for p in params):
        return tuple(_unpack(p) if type(p) is TypeVarTuple else p for p in params)
    return params


@_final
class NoDefaultType:
    """The type of the NoDefault singleton."""

    __slots__ = ()

    def __new__(cls, *args, **kwargs):
        if args or kwargs:
            raise TypeError("NoDefaultType takes no arguments")
        return NoDefault

    def __repr__(self):
        return "typing.NoDefault"

    def __reduce__(self):
        return "NoDefault"

    # (its type's module is builtins, as a static type's named without one,
    # but the instance has no __module__, so pickle finds it by its name in
    # the modules, as CPython's)
    def __getattribute__(self, name):
        if name == "__module__":
            raise AttributeError("'NoDefaultType' object has no attribute '__module__'")
        return object.__getattribute__(self, name)


NoDefaultType.__module__ = "builtins"
NoDefault = object.__new__(NoDefaultType)


def _type_repr(p):
    """CPython's _Py_typing_type_repr."""
    if p is Ellipsis:
        return "..."
    if p is type(None):
        return "None"
    if hasattr(p, "__origin__") and hasattr(p, "__args__"):
        return repr(p)
    qualname = getattr(p, "__qualname__", None)
    if qualname is None:
        return repr(p)
    module = getattr(p, "__module__", None)
    if module is None:
        return repr(p)
    if module == "builtins":
        return str(qualname)
    return f"{module}.{qualname}"


@_final
class _ConstEvaluatorType:
    """Internal type for implementing evaluation functions."""

    __slots__ = ("_value",)

    def __new__(cls, *args, **kwargs):
        raise TypeError("cannot create '_typing._ConstEvaluator' instances")

    def __repr__(self):
        return f"<constevaluator {self._value!r}>"

    def __call__(self, *args, **kwargs):
        if kwargs:
            raise TypeError("constevaluator.__call__() takes no keyword arguments")
        if len(args) != 1:
            raise TypeError(f"constevaluator.__call__() takes exactly one argument ({len(args)} given)")
        fmt = args[0]
        if not isinstance(fmt, int):
            raise TypeError(f"'{type(fmt).__name__}' object cannot be interpreted as an integer")
        value = self._value
        if fmt == 4:  # annotationlib.Format.STRING
            if type(value) is tuple:
                return "(" + ", ".join(_type_repr(v) for v in value) + ")"
            return _type_repr(value)
        return value


# (named as CPython's, which isn't in the module's namespace)
_ConstEvaluatorType.__module__ = "_typing"
_ConstEvaluatorType.__name__ = _ConstEvaluatorType.__qualname__ = "_ConstEvaluator"


def _constevaluator(value):
    ce = object.__new__(_ConstEvaluatorType)
    ce._value = value
    return ce


# a lazily computed field: the value kept once computed, or the function computing it
_UNSET = object()


def _lazy(obj, value_slot, evaluate_slot, missing):
    v = getattr(obj, value_slot)
    if v is not _UNSET:
        return v
    ev = getattr(obj, evaluate_slot)
    if ev is None:
        return missing
    v = ev()
    setattr(obj, value_slot, v)
    return v


def _evaluator(obj, value_slot, evaluate_slot):
    ev = getattr(obj, evaluate_slot)
    if ev is not None:
        return ev
    v = getattr(obj, value_slot)
    if v is not _UNSET:
        return _constevaluator(v)
    return None


def _has_default(self):
    return self._evaluate_default is not None or (self._default is not _UNSET and self._default is not NoDefault)


def _variance_repr(self):
    if self._infer_variance:
        return self._name
    return ("+" if self._covariant else "-" if self._contravariant else "~") + self._name


def _check_variance(covariant, contravariant, infer_variance):
    if covariant and contravariant:
        raise ValueError("Bivariant types are not supported.")
    if infer_variance and (covariant or contravariant):
        raise ValueError("Variance cannot be specified with infer_variance.")


@_final
class TypeVar:
    __slots__ = ("_name", "_bound", "_evaluate_bound", "_constraints", "_evaluate_constraints", "_default",
                 "_evaluate_default", "_covariant", "_contravariant", "_infer_variance", "__dict__", "__weakref__")

    def __new__(cls, *args, **kwargs):
        a, constraints = _parse("typevar", args, kwargs, ("name",),
                                (("bound", None), ("default", NoDefault), ("covariant", False),
                                 ("contravariant", False), ("infer_variance", False)), star=True)
        covariant, contravariant, infer_variance = bool(a["covariant"]), bool(a["contravariant"]), bool(a["infer_variance"])
        _check_variance(covariant, contravariant, infer_variance)
        bound = a["bound"]
        if bound is not None:
            bound = _type_check(bound, "Bound must be a type.")
        else:
            bound = _UNSET
        if len(constraints) == 1:
            raise TypeError("A single constraint is not allowed")
        elif not constraints:
            constraints = _UNSET
        elif bound is not _UNSET:
            raise TypeError("Constraints cannot be combined with bound=...")
        module = _caller()
        return _new_typevar(a["name"], bound, None, constraints, None, a["default"],
                            covariant, contravariant, infer_variance, module)

    __name__ = _ReadOnly(lambda self: self._name)
    __covariant__ = _ReadOnly(lambda self: self._covariant)
    __contravariant__ = _ReadOnly(lambda self: self._contravariant)
    __infer_variance__ = _ReadOnly(lambda self: self._infer_variance)
    __bound__ = _ReadOnly(lambda self: _lazy(self, "_bound", "_evaluate_bound", None))
    __constraints__ = _ReadOnly(lambda self: _lazy(self, "_constraints", "_evaluate_constraints", ()))
    __default__ = _ReadOnly(lambda self: _lazy(self, "_default", "_evaluate_default", NoDefault))
    evaluate_bound = _ReadOnly(lambda self: _evaluator(self, "_bound", "_evaluate_bound"))
    evaluate_constraints = _ReadOnly(lambda self: _evaluator(self, "_constraints", "_evaluate_constraints"))
    evaluate_default = _ReadOnly(lambda self: _evaluator(self, "_default", "_evaluate_default"))

    def __repr__(self):
        return _variance_repr(self)

    def __or__(self, right):
        return _make_union(self, right)

    def __ror__(self, left):
        return _make_union(left, self)

    def __typing_subst__(self, arg, /):
        return _typing_call("_typevar_subst", self, arg)

    def __typing_prepare_subst__(self, alias, args, /):
        params = alias.__parameters__
        # (found by ==, as CPython's PySequence_Index)
        for i, p in enumerate(params):
            if p == self:
                break
        else:
            raise ValueError("sequence.index(x): x not in sequence")
        n = len(args)
        if i < n:
            # We already have a value for our TypeVar
            return args
        if i == n:
            # If the TypeVar has a default, use it.
            dflt = self.__default__
            if dflt is not NoDefault:
                return args + (dflt,)
        raise TypeError(f"Too few arguments for {alias}; actual {n}, expected at least {i + 1}")

    def __reduce__(self):
        return self._name

    def has_default(self):
        return _has_default(self)

    def __mro_entries__(self, bases):
        raise TypeError("Cannot subclass an instance of TypeVar")


def _new_typevar(name, bound, evaluate_bound, constraints, evaluate_constraints, default,
                 covariant, contravariant, infer_variance, module):
    tv = object.__new__(TypeVar)
    tv._name = name
    tv._bound = bound
    tv._evaluate_bound = evaluate_bound
    tv._constraints = constraints
    tv._evaluate_constraints = evaluate_constraints
    tv._default = default
    tv._evaluate_default = None
    tv._covariant = covariant
    tv._contravariant = contravariant
    tv._infer_variance = infer_variance
    if module is not None:
        tv.__module__ = module
    return tv


class _ParamSpecAttr:
    __slots__ = ("_origin", "__weakref__")

    __origin__ = _ReadOnly(lambda self: self._origin)

    def __eq__(self, other):
        if type(other) is not type(self):
            return NotImplemented
        return self._origin == other._origin

    def __ne__(self, other):
        if type(other) is not type(self):
            return NotImplemented
        return self._origin != other._origin

    __hash__ = None


def _paramspec_attr(cls, origin):
    a = object.__new__(cls)
    a._origin = origin
    return a


@_final
class ParamSpecArgs(_ParamSpecAttr):
    __slots__ = ()

    def __new__(cls, *args, **kwargs):
        a, _ = _parse_origin("paramspecargs", args, kwargs)
        return _paramspec_attr(cls, a)

    def __repr__(self):
        if type(self._origin) is ParamSpec:
            return f"{self._origin._name}.args"
        return f"{self._origin!r}.args"

    def __mro_entries__(self, bases):
        raise TypeError("Cannot subclass an instance of ParamSpecArgs")


@_final
class ParamSpecKwargs(_ParamSpecAttr):
    __slots__ = ()

    def __new__(cls, *args, **kwargs):
        a, _ = _parse_origin("paramspeckwargs", args, kwargs)
        return _paramspec_attr(cls, a)

    def __repr__(self):
        if type(self._origin) is ParamSpec:
            return f"{self._origin._name}.kwargs"
        return f"{self._origin!r}.kwargs"

    def __mro_entries__(self, bases):
        raise TypeError("Cannot subclass an instance of ParamSpecKwargs")


def _parse_origin(fname, args, kwargs):
    if len(args) + len(kwargs) != 1 or (kwargs and "origin" not in kwargs):
        if not args and not kwargs:
            raise TypeError(f"{fname}() missing required argument 'origin' (pos 1)")
        for k in kwargs:
            if k != "origin":
                raise TypeError(f"{fname}() got an unexpected keyword argument '{k}'")
        raise TypeError(f"{fname}() takes at most 1 argument ({len(args) + len(kwargs)} given)")
    return (args[0] if args else kwargs["origin"]), None


@_final
class ParamSpec:
    __slots__ = ("_name", "_bound", "_default", "_evaluate_default", "_covariant", "_contravariant",
                 "_infer_variance", "__dict__", "__weakref__")

    def __new__(cls, *args, **kwargs):
        a, _ = _parse("paramspec", args, kwargs, ("name",),
                      (("bound", None), ("default", NoDefault), ("covariant", False),
                       ("contravariant", False), ("infer_variance", False)))
        covariant, contravariant, infer_variance = bool(a["covariant"]), bool(a["contravariant"]), bool(a["infer_variance"])
        _check_variance(covariant, contravariant, infer_variance)
        # (bound is always checked, None included: it becomes NoneType, as CPython's)
        bound = _type_check(a["bound"], "Bound must be a type.")
        module = _caller()
        return _new_paramspec(a["name"], bound, a["default"], covariant, contravariant, infer_variance, module)

    __name__ = _ReadOnly(lambda self: self._name)
    __bound__ = _ReadOnly(lambda self: self._bound)
    __covariant__ = _ReadOnly(lambda self: self._covariant)
    __contravariant__ = _ReadOnly(lambda self: self._contravariant)
    __infer_variance__ = _ReadOnly(lambda self: self._infer_variance)
    args = _ReadOnly(lambda self: _paramspec_attr(ParamSpecArgs, self), "Represents positional arguments.")
    kwargs = _ReadOnly(lambda self: _paramspec_attr(ParamSpecKwargs, self), "Represents keyword arguments.")
    __default__ = _ReadOnly(lambda self: _lazy(self, "_default", "_evaluate_default", NoDefault), "The default value for this ParamSpec.")
    evaluate_default = _ReadOnly(lambda self: _evaluator(self, "_default", "_evaluate_default"))

    def __repr__(self):
        return _variance_repr(self)

    def __or__(self, right):
        return _make_union(self, right)

    def __ror__(self, left):
        return _make_union(left, self)

    def __typing_subst__(self, arg, /):
        return _typing_call("_paramspec_subst", self, arg)

    def __typing_prepare_subst__(self, alias, args, /):
        return _typing_call("_paramspec_prepare_subst", self, alias, args)

    def __reduce__(self):
        return self._name

    def has_default(self):
        return _has_default(self)

    def __mro_entries__(self, bases):
        raise TypeError("Cannot subclass an instance of ParamSpec")


def _new_paramspec(name, bound, default, covariant, contravariant, infer_variance, module):
    ps = object.__new__(ParamSpec)
    ps._name = name
    ps._bound = bound
    ps._default = default
    ps._evaluate_default = None
    ps._covariant = covariant
    ps._contravariant = contravariant
    ps._infer_variance = infer_variance
    if module is not None:
        ps.__module__ = module
    return ps


@_final
class TypeVarTuple:
    __slots__ = ("_name", "_default", "_evaluate_default", "__dict__", "__weakref__")

    def __new__(cls, *args, **kwargs):
        a, _ = _parse("typevartuple", args, kwargs, ("name",), (("default", NoDefault),))
        return _new_typevartuple(a["name"], a["default"], _caller())

    __name__ = _ReadOnly(lambda self: self._name)
    __default__ = _ReadOnly(lambda self: _lazy(self, "_default", "_evaluate_default", NoDefault))
    evaluate_default = _ReadOnly(lambda self: _evaluator(self, "_default", "_evaluate_default"))

    def __repr__(self):
        return self._name

    def __iter__(self):
        return iter((_unpack(self),))

    def __typing_subst__(self, arg, /):
        raise TypeError("Substitution of bare TypeVarTuple is not supported")

    def __typing_prepare_subst__(self, alias, args, /):
        return _typing_call("_typevartuple_prepare_subst", self, alias, args)

    def __reduce__(self):
        return self._name

    def has_default(self):
        return _has_default(self)

    def __mro_entries__(self, bases):
        raise TypeError("Cannot subclass an instance of TypeVarTuple")


def _new_typevartuple(name, default, module):
    tvt = object.__new__(TypeVarTuple)
    tvt._name = name
    tvt._default = default
    tvt._evaluate_default = None
    if module is not None:
        tvt.__module__ = module
    return tvt


def _type_param_default(tp):
    if type(tp) in (TypeVar, ParamSpec, TypeVarTuple):
        return tp.__default__
    raise TypeError(f"Expected a type param, got {tp!r}")


def _check_type_params(type_params):
    if not type_params:
        return None
    default_seen = False
    for tp in type_params:
        if _type_param_default(tp) is NoDefault:
            if default_seen:
                raise TypeError(f"non-default type parameter '{tp!r}' follows default type parameter")
        else:
            default_seen = True
    return type_params


def _ta_module(self):
    if self._module is not None:
        return self._module
    if self._compute_value is not None:
        return getattr(self._compute_value, "__module__", None)
    return None


_UNIONABLE_TYPES = (type, _types.GenericAlias, Union)


def _unionable(x):
    return x is None or isinstance(x, _UNIONABLE_TYPES) or type(x) is TypeAliasType


@_final
class TypeAliasType:
    __slots__ = ("_name", "_type_params", "_compute_value", "_value", "_module", "__weakref__")

    def __new__(cls, *args, **kwargs):
        a, _ = _parse("typealias", args, kwargs, ("name", "value"), (("type_params", None),))
        type_params = a["type_params"]
        if "type_params" in kwargs and not isinstance(type_params, tuple):
            raise TypeError("type_params must be a tuple")
        type_params = _check_type_params(type_params)
        return _new_typealias(a["name"], type_params, None, a["value"], _caller())

    def __getattribute__(self, name):
        # (its instances' __module__, computed, while the type's own stays
        # "typing": CPython's getset of that name)
        if name == "__module__":
            return _ta_module(self)
        return object.__getattribute__(self, name)

    __name__ = _ReadOnly(lambda self: self._name)
    __parameters__ = _ReadOnly(lambda self: () if self._type_params is None else _unpack_typevartuples(self._type_params))
    __type_params__ = _ReadOnly(lambda self: () if self._type_params is None else self._type_params)
    __value__ = _ReadOnly(lambda self: _ta_value(self))
    evaluate_value = _ReadOnly(lambda self: self._compute_value if self._compute_value is not None else _constevaluator(self._value))

    def __repr__(self):
        return self._name

    def __reduce__(self):
        return self._name

    def __getitem__(self, args):
        if self._type_params is None:
            raise TypeError("Only generic type aliases are subscriptable")
        return _types.GenericAlias(self, args)

    def __or__(self, right):
        if not _unionable(self) or not _unionable(right):
            return NotImplemented
        return Union[self, right]

    def __ror__(self, left):
        if not _unionable(left) or not _unionable(self):
            return NotImplemented
        return Union[left, self]

    def __iter__(self):
        return iter((_unpack(self),))


def _ta_value(self):
    v = self._value
    if v is not _UNSET:
        return v
    v = self._compute_value()
    self._value = v
    return v


def _new_typealias(name, type_params, compute_value, value, module):
    ta = object.__new__(TypeAliasType)
    ta._name = name
    ta._type_params = type_params
    ta._compute_value = compute_value
    ta._value = _UNSET if compute_value is not None else value
    ta._module = module
    return ta


class Generic:
    __slots__ = ()

    @classmethod
    def __class_getitem__(cls, *args, **kwargs):
        import typing
        return typing._generic_class_getitem(cls, *args, **kwargs)

    @classmethod
    def __init_subclass__(cls, *args, **kwargs):
        import typing
        return typing._generic_init_subclass(cls, *args, **kwargs)


# (what PEP 695's statements compile to: src/emit.ts typeParams, through the
# runtime's intrinsics; CPython's _Py_make_typevar, _Py_make_paramspec,
# _Py_make_typevartuple, _Py_set_typeparam_default, _Py_make_typealias and
# _Py_subscript_generic)
def _make_typevar(name, evaluate_bound, evaluate_constraints):
    return _new_typevar(name, _UNSET, evaluate_bound, _UNSET, evaluate_constraints, _UNSET,
                        False, False, True, None)


def _make_paramspec(name):
    return _new_paramspec(name, None, _UNSET, False, False, True, None)


def _make_typevartuple(name):
    return _new_typevartuple(name, _UNSET, None)


def _set_typeparam_default(tp, evaluate_default):
    if type(tp) not in (TypeVar, ParamSpec, TypeVarTuple):
        raise TypeError(f"Expected a type param, got {tp!r}")
    tp._evaluate_default = evaluate_default
    return tp


def _make_typealias(name, type_params, compute_value):
    if type_params is None or (type(type_params) is tuple and not type_params):
        type_params = None
    return _new_typealias(name, type_params, compute_value, _UNSET, None)


def _subscript_generic(params):
    params = _unpack_typevartuples(params)
    return _typing_call("_GenericAlias", Generic, params)


for _c in (TypeVar, ParamSpec, ParamSpecArgs, ParamSpecKwargs, TypeVarTuple, TypeAliasType, Generic):
    _c.__module__ = "typing"
del _c

TypeVar.__doc__ = """Type variable.

The preferred way to construct a type variable is via the dedicated
syntax for generic functions, classes, and type aliases::

    class Sequence[T]:  # T is a TypeVar
        ...

This syntax can also be used to create bound and constrained type
variables::

    # S is a TypeVar bound to str
    class StrSequence[S: str]:
        ...

    # A is a TypeVar constrained to str or bytes
    class StrOrBytesSequence[A: (str, bytes)]:
        ...

Type variables can also have defaults:

    class IntDefault[T = int]:
        ...

However, if desired, reusable type variables can also be constructed
manually, like so::

   T = TypeVar('T')  # Can be anything
   S = TypeVar('S', bound=str)  # Can be any subtype of str
   A = TypeVar('A', str, bytes)  # Must be exactly str or bytes
   D = TypeVar('D', default=int)  # Defaults to int

Type variables exist primarily for the benefit of static type
checkers.  They serve as the parameters for generic types as well
as for generic function and type alias definitions.

The variance of type variables is inferred by type checkers when they
are created through the type parameter syntax and when
``infer_variance=True`` is passed. Manually created type variables may
be explicitly marked covariant or contravariant by passing
``covariant=True`` or ``contravariant=True``. By default, manually
created type variables are invariant. See PEP 484 and PEP 695 for more
details.
"""

# (the types' documentation, CPython's)
ParamSpec.__doc__ = """Parameter specification variable.

The preferred way to construct a parameter specification is via the
dedicated syntax for generic functions, classes, and type aliases,
where the use of '**' creates a parameter specification::

    type IntFunc[**P] = Callable[P, int]

The following syntax creates a parameter specification that defaults
to a callable accepting two positional-only arguments of types int
and str:

    type IntFuncDefault[**P = [int, str]] = Callable[P, int]

For compatibility with Python 3.11 and earlier, ParamSpec objects
can also be created as follows::

    P = ParamSpec('P')
    DefaultP = ParamSpec('DefaultP', default=[int, str])

Parameter specification variables exist primarily for the benefit of
static type checkers.  They are used to forward the parameter types of
one callable to another callable, a pattern commonly found in
higher-order functions and decorators.  They are only valid when used
in ``Concatenate``, or as the first argument to ``Callable``, or as
parameters for user-defined Generics. See class Generic for more
information on generic types.

An example for annotating a decorator::

    def add_logging[**P, T](f: Callable[P, T]) -> Callable[P, T]:
        '''A type-safe decorator to add logging to a function.'''
        def inner(*args: P.args, **kwargs: P.kwargs) -> T:
            logging.info(f'{f.__name__} was called')
            return f(*args, **kwargs)
        return inner

    @add_logging
    def add_two(x: float, y: float) -> float:
        '''Add two numbers together.'''
        return x + y

Parameter specification variables can be introspected. e.g.::

    >>> P = ParamSpec("P")
    >>> P.__name__
    'P'

Note that only parameter specification variables defined in the global
scope can be pickled.
"""
ParamSpecArgs.__doc__ = """The args for a ParamSpec object.

Given a ParamSpec object P, P.args is an instance of ParamSpecArgs.

ParamSpecArgs objects have a reference back to their ParamSpec::

    >>> P = ParamSpec("P")
    >>> P.args.__origin__ is P
    True

This type is meant for runtime introspection and has no special meaning
to static type checkers.
"""
ParamSpecKwargs.__doc__ = """The kwargs for a ParamSpec object.

Given a ParamSpec object P, P.kwargs is an instance of ParamSpecKwargs.

ParamSpecKwargs objects have a reference back to their ParamSpec::

    >>> P = ParamSpec("P")
    >>> P.kwargs.__origin__ is P
    True

This type is meant for runtime introspection and has no special meaning
to static type checkers.
"""
TypeVarTuple.__doc__ = """Type variable tuple. A specialized form of type variable that enables
variadic generics.

The preferred way to construct a type variable tuple is via the
dedicated syntax for generic functions, classes, and type aliases,
where a single '*' indicates a type variable tuple::

    def move_first_element_to_last[T, *Ts](tup: tuple[T, *Ts]) -> tuple[*Ts, T]:
        return (*tup[1:], tup[0])

Type variables tuples can have default values:

    type AliasWithDefault[*Ts = (str, int)] = tuple[*Ts]

For compatibility with Python 3.11 and earlier, TypeVarTuple objects
can also be created as follows::

    Ts = TypeVarTuple('Ts')  # Can be given any name
    DefaultTs = TypeVarTuple('Ts', default=(str, int))

Just as a TypeVar (type variable) is a placeholder for a single type,
a TypeVarTuple is a placeholder for an *arbitrary* number of types. For
example, if we define a generic class using a TypeVarTuple::

    class C[*Ts]: ...

Then we can parameterize that class with an arbitrary number of type
arguments::

    C[int]       # Fine
    C[int, str]  # Also fine
    C[()]        # Even this is fine

For more details, see PEP 646.

Note that only TypeVarTuples defined in the global scope can be
pickled.
"""
TypeAliasType.__doc__ = """Type alias.

Type aliases are created through the type statement::

    type Alias = int

In this example, Alias and int will be treated equivalently by static
type checkers.

At runtime, Alias is an instance of TypeAliasType. The __name__
attribute holds the name of the type alias. The value of the type alias
is stored in the __value__ attribute. It is evaluated lazily, so the
value is computed only if the attribute is accessed.

Type aliases can also be generic::

    type ListOrSet[T] = list[T] | set[T]

In this case, the type parameters of the alias are stored in the
__type_params__ attribute.

See PEP 695 for more information.
"""
Generic.__doc__ = """Abstract base class for generic types.

On Python 3.12 and newer, generic classes implicitly inherit from
Generic when they declare a parameter list after the class's name::

    class Mapping[KT, VT]:
        def __getitem__(self, key: KT) -> VT:
            ...
        # Etc.

On older versions of Python, however, generic classes have to
explicitly inherit from Generic.

After a class has been declared to be generic, it can then be used as
follows::

    def lookup_name[KT, VT](mapping: Mapping[KT, VT], key: KT, default: VT) -> VT:
        try:
            return mapping[key]
        except KeyError:
            return default
"""
Generic.__class_getitem__.__func__.__doc__ = 'Parameterizes a generic class.\n\nAt least, parameterizing a generic class is the *main* thing this\nmethod does. For example, for some generic class `Foo`, this is called\nwhen we do `Foo[int]` - there, with `cls=Foo` and `params=int`.\n\nHowever, note that this method is also called when defining generic\nclasses in the first place with `class Foo[T]: ...`.\n'
Generic.__init_subclass__.__func__.__doc__ = 'Function to initialize subclasses.'
