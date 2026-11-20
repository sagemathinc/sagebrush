# Adapted from CPython 3.14 Lib/inspect.py (PSF License; see cdn/LICENSE-CPython.txt), by Ka-Ping Yee and
# Yury Selivanov.  The parts below are CPython's, unchanged: the type predicates (ismodule ... isabstract),
# getmembers, unwrap, getdoc and cleandoc, getfullargspec, formatannotation, getattr_static, and the whole of
# the signature section (Parameter, Signature, BoundArguments, signature), but for three marked places
# (isabstract; object's own __init__ and __new__ in _signature_get_user_defined_method; object's signature).  Left out, since Sagebrush has no
# source text, bytecode or frames to read: getsource and its family, getframeinfo, stack, the generator and
# coroutine states, and the module's command line.  Sagebrush's own: the few names CPython takes from
# annotationlib, dis and keyword, which Sagebrush doesn't have, defined just below; and builtins, which carry
# no __text_signature__ here, so signature() of one is a ValueError, as CPython's is for a builtin without one.

"""Get useful information from live Python objects.

This module encapsulates the interface provided by the internal special
attributes (co_*, tb_*, etc.) in a friendlier fashion.
It also provides some help for examining source code and class layout.
"""

import abc
import collections.abc
import enum
import itertools
import re
import sys
import types
import functools
import builtins
from operator import attrgetter
from collections import namedtuple, OrderedDict
from weakref import ref as make_weakref

# (dis.COMPILER_FLAG_NAMES's flags, as CPython 3.14 defines them)
CO_OPTIMIZED = 1
CO_NEWLOCALS = 2
CO_VARARGS = 4
CO_VARKEYWORDS = 8
CO_NESTED = 16
CO_GENERATOR = 32
CO_NOFREE = 64
CO_COROUTINE = 128
CO_ITERABLE_COROUTINE = 256
CO_ASYNC_GENERATOR = 512
CO_HAS_DOCSTRING = 67108864
CO_METHOD = 134217728

# (keyword.iskeyword: Python 3.14's keywords)
_KEYWORDS = frozenset([
    'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
    'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield'])
iskeyword = _KEYWORDS.__contains__


# (annotationlib's Format, ForwardRef and get_annotations, as far as the signature code uses them: a function's
# __annotations__, copied; with eval_str, its string annotations evaluated in its globals)
class Format(enum.IntEnum):
    VALUE = 1
    VALUE_WITH_FAKE_GLOBALS = 2
    FORWARDREF = 3
    STRING = 4


class ForwardRef:
    __slots__ = ('__forward_arg__',)

    def __init__(self, arg):
        if not isinstance(arg, str):
            raise TypeError(f"Forward reference must be a string -- got {arg!r}")
        self.__forward_arg__ = arg

    def __repr__(self):
        return f"ForwardRef({self.__forward_arg__!r})"


def _type_repr(value):
    if isinstance(value, (type, types.FunctionType, types.BuiltinFunctionType)):
        if value.__module__ == "builtins":
            return value.__qualname__
        return f"{value.__module__}.{value.__qualname__}"
    if value is ...:
        return "..."
    return repr(value)


def get_annotations(obj, *, globals=None, locals=None, eval_str=False, format=Format.VALUE):
    if eval_str and format != Format.VALUE:
        raise ValueError("eval_str=True is only supported with format=Format.VALUE")
    ann = getattr(obj, '__annotations__', None)
    if ann is None:
        return {}
    if not isinstance(ann, dict):
        raise ValueError(f"{obj!r}.__annotations__ is neither a dict nor None")
    ann = dict(ann)
    if format == Format.STRING:
        return {k: v if isinstance(v, str) else _type_repr(v) for k, v in ann.items()}
    if not eval_str:
        return ann
    unwrapped = obj
    while hasattr(unwrapped, '__wrapped__'):
        unwrapped = unwrapped.__wrapped__
    if isinstance(unwrapped, functools.partial):
        unwrapped = unwrapped.func
    if globals is None:
        globals = getattr(unwrapped, '__globals__', None)
    return {k: v if not isinstance(v, str) else eval(v, globals, locals) for k, v in ann.items()}


def _signature_fromstr(cls, obj, s, skip_bound_arg=True):
    # (CPython parses a builtin's text signature with ast, which Sagebrush doesn't have)
    raise ValueError("{!r} builtin has invalid signature".format(obj))

TPFLAGS_IS_ABSTRACT = 1 << 20


# ----------------------------------------------------------- type-checking
def ismodule(object):
    """Return true if the object is a module."""
    return isinstance(object, types.ModuleType)

def isclass(object):
    """Return true if the object is a class."""
    return isinstance(object, type)

def ismethod(object):
    """Return true if the object is an instance method."""
    return isinstance(object, types.MethodType)

def ispackage(object):
    """Return true if the object is a package."""
    return ismodule(object) and hasattr(object, "__path__")

def ismethoddescriptor(object):
    """Return true if the object is a method descriptor.

    But not if ismethod(), isclass() or isfunction() is true.

    An object passing this test (for example, int.__add__) has a __get__
    attribute, but not a __set__ attribute or a __delete__ attribute.
    Beyond that, the set of attributes varies; __name__ is usually
    sensible, and __doc__ often is.

    Methods implemented via descriptors that also pass one of the other
    tests (ismethod(), isclass(), isfunction()) make this function return
    false, simply because those other tests promise more -- you can, for
    example, count on having the __func__ attribute when an object passes
    ismethod()."""
    if isclass(object) or ismethod(object) or isfunction(object):
        # mutual exclusion
        return False
    tp = type(object)
    return (hasattr(tp, "__get__")
            and not hasattr(tp, "__set__")
            and not hasattr(tp, "__delete__"))

def isdatadescriptor(object):
    """Return true if the object is a data descriptor.

    But not if ismethod(), isclass() or isfunction() is true.

    Data descriptors have a __set__ or a __delete__ attribute.  Examples are
    properties, getsets, and members.  For the latter two (defined only in C
    extension modules) more specific tests are available as well:
    isgetsetdescriptor() and ismemberdescriptor(), respectively.

    Typically, data descriptors will also have __name__ and __doc__ attributes
    (properties, getsets, and members have both of these attributes), but this
    is not guaranteed."""
    if isclass(object) or ismethod(object) or isfunction(object):
        # mutual exclusion
        return False
    tp = type(object)
    return hasattr(tp, "__set__") or hasattr(tp, "__delete__")

if hasattr(types, 'MemberDescriptorType'):
    # CPython and equivalent
    def ismemberdescriptor(object):
        """Return true if the object is a member descriptor.

        Member descriptors are specialized descriptors defined in extension
        modules."""
        return isinstance(object, types.MemberDescriptorType)
else:
    # Other implementations
    def ismemberdescriptor(object):
        """Return true if the object is a member descriptor.

        Member descriptors are specialized descriptors defined in extension
        modules."""
        return False

if hasattr(types, 'GetSetDescriptorType'):
    # CPython and equivalent
    def isgetsetdescriptor(object):
        """Return true if the object is a getset descriptor.

        getset descriptors are specialized descriptors defined in extension
        modules."""
        return isinstance(object, types.GetSetDescriptorType)
else:
    # Other implementations
    def isgetsetdescriptor(object):
        """Return true if the object is a getset descriptor.

        getset descriptors are specialized descriptors defined in extension
        modules."""
        return False

def isfunction(object):
    """Return true if the object is a user-defined function.

    Function objects provide these attributes:
        __doc__         documentation string
        __name__        name with which this function was defined
        __qualname__    qualified name of this function
        __module__      name of the module the function was defined in or None
        __code__        code object containing compiled function bytecode
        __defaults__    tuple of any default values for arguments
        __globals__     global namespace in which this function was defined
        __annotations__ dict of parameter annotations
        __kwdefaults__  dict of keyword only parameters with defaults
        __dict__        namespace which is supporting arbitrary function attributes
        __closure__     a tuple of cells or None
        __type_params__ tuple of type parameters"""
    return isinstance(object, types.FunctionType)

def _has_code_flag(f, flag):
    """Return true if ``f`` is a function (or a method or functools.partial
    wrapper wrapping a function or a functools.partialmethod wrapping a
    function) whose code object has the given ``flag``
    set in its flags."""
    f = functools._unwrap_partialmethod(f)
    while ismethod(f):
        f = f.__func__
    f = functools._unwrap_partial(f)
    if not (isfunction(f) or _signature_is_functionlike(f)):
        return False
    # If it's a pure Python function, or an object that is duck type
    # of a Python function (Cython and Mock functions, for instance), then:
    return bool(f.__code__.co_flags & flag)

def isgeneratorfunction(obj):
    """Return true if the object is a user-defined generator function.

    Generator function objects provide the same attributes as functions.
    See help(isfunction) for a list of attributes."""
    return _has_code_flag(obj, CO_GENERATOR)

# A marker for markcoroutinefunction and iscoroutinefunction.
_is_coroutine_mark = object()

def _has_coroutine_mark(f):
    while ismethod(f):
        f = f.__func__
    f = functools._unwrap_partial(f)
    return getattr(f, "_is_coroutine_marker", None) is _is_coroutine_mark

def markcoroutinefunction(func):
    """
    Decorator to ensure callable is recognised as a coroutine function.
    """
    if hasattr(func, '__func__'):
        func = func.__func__
    func._is_coroutine_marker = _is_coroutine_mark
    return func

def iscoroutinefunction(obj):
    """Return true if the object is a coroutine function.

    Coroutine functions are normally defined with "async def" syntax, but may
    be marked via markcoroutinefunction.
    """
    return _has_code_flag(obj, CO_COROUTINE) or _has_coroutine_mark(obj)

def isasyncgenfunction(obj):
    """Return true if the object is an asynchronous generator function.

    Asynchronous generator functions are defined with "async def"
    syntax and have "yield" expressions in their body.
    """
    return _has_code_flag(obj, CO_ASYNC_GENERATOR)

def isasyncgen(object):
    """Return true if the object is an asynchronous generator."""
    return isinstance(object, types.AsyncGeneratorType)

def isgenerator(object):
    """Return true if the object is a generator.

    Generator objects provide these attributes:
        gi_code         code object
        gi_frame        frame object or possibly None once the generator has
                        been exhausted
        gi_running      set to 1 when generator is executing, 0 otherwise
        gi_suspended    set to 1 when the generator is suspended at a yield point, 0 otherwise
        gi_yieldfrom    object being iterated by yield from or None

        __iter__()      defined to support iteration over container
        close()         raises a new GeneratorExit exception inside the
                        generator to terminate the iteration
        send()          resumes the generator and "sends" a value that becomes
                        the result of the current yield-expression
        throw()         used to raise an exception inside the generator"""
    return isinstance(object, types.GeneratorType)

def iscoroutine(object):
    """Return true if the object is a coroutine."""
    return isinstance(object, types.CoroutineType)

def isawaitable(object):
    """Return true if object can be passed to an ``await`` expression."""
    return (isinstance(object, types.CoroutineType) or
            isinstance(object, types.GeneratorType) and
                bool(object.gi_code.co_flags & CO_ITERABLE_COROUTINE) or
            isinstance(object, collections.abc.Awaitable))

def istraceback(object):
    """Return true if the object is a traceback.

    Traceback objects provide these attributes:
        tb_frame        frame object at this level
        tb_lasti        index of last attempted instruction in bytecode
        tb_lineno       current line number in Python source code
        tb_next         next inner traceback object (called by this level)"""
    return isinstance(object, types.TracebackType)

def isframe(object):
    """Return true if the object is a frame object.

    Frame objects provide these attributes:
        f_back          next outer frame object (this frame's caller)
        f_builtins      built-in namespace seen by this frame
        f_code          code object being executed in this frame
        f_globals       global namespace seen by this frame
        f_lasti         index of last attempted instruction in bytecode
        f_lineno        current line number in Python source code
        f_locals        local namespace seen by this frame
        f_trace         tracing function for this frame, or None
        f_trace_lines   is a tracing event triggered for each source line?
        f_trace_opcodes are per-opcode events being requested?

        clear()          used to clear all references to local variables"""
    return isinstance(object, types.FrameType)

def iscode(object):
    """Return true if the object is a code object.

    Code objects provide these attributes:
        co_argcount         number of arguments (not including *, ** args
                            or keyword only arguments)
        co_code             string of raw compiled bytecode
        co_cellvars         tuple of names of cell variables
        co_consts           tuple of constants used in the bytecode
        co_filename         name of file in which this code object was created
        co_firstlineno      number of first line in Python source code
        co_flags            bitmap: 1=optimized | 2=newlocals | 4=*arg | 8=**arg
                            | 16=nested | 32=generator | 64=nofree | 128=coroutine
                            | 256=iterable_coroutine | 512=async_generator
                            | 0x4000000=has_docstring
        co_freevars         tuple of names of free variables
        co_posonlyargcount  number of positional only arguments
        co_kwonlyargcount   number of keyword only arguments (not including ** arg)
        co_lnotab           encoded mapping of line numbers to bytecode indices
        co_name             name with which this code object was defined
        co_names            tuple of names other than arguments and function locals
        co_nlocals          number of local variables
        co_stacksize        virtual machine stack space required
        co_varnames         tuple of names of arguments and local variables
        co_qualname         fully qualified function name

        co_lines()          returns an iterator that yields successive bytecode ranges
        co_positions()      returns an iterator of source code positions for each bytecode instruction
        replace()           returns a copy of the code object with a new values"""
    return isinstance(object, types.CodeType)

def isbuiltin(object):
    """Return true if the object is a built-in function or method.

    Built-in functions and methods provide these attributes:
        __doc__         documentation string
        __name__        original name of this function or method
        __self__        instance to which a method is bound, or module object
                        a function was defined in, or None"""
    return isinstance(object, types.BuiltinFunctionType)

def ismethodwrapper(object):
    """Return true if the object is a method wrapper."""
    return isinstance(object, types.MethodWrapperType)

def isroutine(object):
    """Return true if the object is any kind of function or method."""
    return (isbuiltin(object)
            or isfunction(object)
            or ismethod(object)
            or ismethoddescriptor(object)
            or ismethodwrapper(object)
            or isinstance(object, functools._singledispatchmethod_get))

def isabstract(object):
    """Return true if the object is an abstract base class (ABC)."""
    # (Sagebrush's: a class is abstract when its __abstractmethods__ is not empty, which is what CPython's
    # TPFLAGS_IS_ABSTRACT records; Sagebrush's types have no __flags__)
    if not isinstance(object, type):
        return False
    return bool(getattr(object, '__abstractmethods__', None))

def _getmembers(object, predicate, getter):
    results = []
    processed = set()
    names = dir(object)
    if isclass(object):
        mro = getmro(object)
        # add any DynamicClassAttributes to the list of names if object is a class;
        # this may result in duplicate entries if, for example, a virtual
        # attribute with the same name as a DynamicClassAttribute exists
        try:
            for base in object.__bases__:
                for k, v in base.__dict__.items():
                    if isinstance(v, types.DynamicClassAttribute):
                        names.append(k)
        except AttributeError:
            pass
    else:
        mro = ()
    for key in names:
        # First try to get the value via getattr.  Some descriptors don't
        # like calling their __get__ (see bug #1785), so fall back to
        # looking in the __dict__.
        try:
            value = getter(object, key)
            # handle the duplicate key
            if key in processed:
                raise AttributeError
        except AttributeError:
            for base in mro:
                if key in base.__dict__:
                    value = base.__dict__[key]
                    break
            else:
                # could be a (currently) missing slot member, or a buggy
                # __dir__; discard and move on
                continue
        if not predicate or predicate(value):
            results.append((key, value))
        processed.add(key)
    results.sort(key=lambda pair: pair[0])
    return results

def getmembers(object, predicate=None):
    """Return all members of an object as (name, value) pairs sorted by name.
    Optionally, only return members that satisfy a given predicate."""
    return _getmembers(object, predicate, getattr)

def getmembers_static(object, predicate=None):
    """Return all members of an object as (name, value) pairs sorted by name
    without triggering dynamic lookup via the descriptor protocol,
    __getattr__ or __getattribute__. Optionally, only return members that
    satisfy a given predicate.

    Note: this function may not be able to retrieve all members
       that getmembers can fetch (like dynamically created attributes)
       and may find members that getmembers can't (like descriptors
       that raise AttributeError). It can also return descriptor objects
       instead of instance members in some cases.
    """
    return _getmembers(object, predicate, getattr_static)


def getmro(cls):
    "Return tuple of base classes (including cls) in method resolution order."
    return cls.__mro__

# -------------------------------------------------------- function helpers

def unwrap(func, *, stop=None):
    """Get the object wrapped by *func*.

   Follows the chain of :attr:`__wrapped__` attributes returning the last
   object in the chain.

   *stop* is an optional callback accepting an object in the wrapper chain
   as its sole argument that allows the unwrapping to be terminated early if
   the callback returns a true value. If the callback never returns a true
   value, the last object in the chain is returned as usual. For example,
   :func:`signature` uses this to stop unwrapping if any object in the
   chain has a ``__signature__`` attribute defined.

   :exc:`ValueError` is raised if a cycle is encountered.

    """
    f = func  # remember the original func for error reporting
    # Memoise by id to tolerate non-hashable objects, but store objects to
    # ensure they aren't destroyed, which would allow their IDs to be reused.
    memo = {id(f): f}
    recursion_limit = sys.getrecursionlimit()
    while not isinstance(func, type) and hasattr(func, '__wrapped__'):
        if stop is not None and stop(func):
            break
        func = func.__wrapped__
        id_func = id(func)
        if (id_func in memo) or (len(memo) >= recursion_limit):
            raise ValueError('wrapper loop when unwrapping {!r}'.format(f))
        memo[id_func] = func
    return func

# -------------------------------------------------- source code extraction
def indentsize(line):
    """Return the indent size, in spaces, at the start of a line of text."""
    expline = line.expandtabs()
    return len(expline) - len(expline.lstrip())

def _findclass(func):
    cls = sys.modules.get(func.__module__)
    if cls is None:
        return None
    for name in func.__qualname__.split('.')[:-1]:
        cls = getattr(cls, name)
    if not isclass(cls):
        return None
    return cls

def _finddoc(obj):
    if isclass(obj):
        for base in obj.__mro__:
            if base is not object:
                try:
                    doc = base.__doc__
                except AttributeError:
                    continue
                if doc is not None:
                    return doc
        return None

    if ismethod(obj):
        name = obj.__func__.__name__
        self = obj.__self__
        if (isclass(self) and
            getattr(getattr(self, name, None), '__func__') is obj.__func__):
            # classmethod
            cls = self
        else:
            cls = self.__class__
    elif isfunction(obj):
        name = obj.__name__
        cls = _findclass(obj)
        if cls is None or getattr(cls, name) is not obj:
            return None
    elif isbuiltin(obj):
        name = obj.__name__
        self = obj.__self__
        if (isclass(self) and
            self.__qualname__ + '.' + name == obj.__qualname__):
            # classmethod
            cls = self
        else:
            cls = self.__class__
    # Should be tested before isdatadescriptor().
    elif isinstance(obj, property):
        name = obj.__name__
        cls = _findclass(obj.fget)
        if cls is None or getattr(cls, name) is not obj:
            return None
    elif ismethoddescriptor(obj) or isdatadescriptor(obj):
        name = obj.__name__
        cls = obj.__objclass__
        if getattr(cls, name) is not obj:
            return None
        if ismemberdescriptor(obj):
            slots = getattr(cls, '__slots__', None)
            if isinstance(slots, dict) and name in slots:
                return slots[name]
    else:
        return None
    for base in cls.__mro__:
        try:
            doc = getattr(base, name).__doc__
        except AttributeError:
            continue
        if doc is not None:
            return doc
    return None

def getdoc(object):
    """Get the documentation string for an object.

    All tabs are expanded to spaces.  To clean up docstrings that are
    indented to line up with blocks of code, any whitespace than can be
    uniformly removed from the second line onwards is removed."""
    try:
        doc = object.__doc__
    except AttributeError:
        return None
    if doc is None:
        try:
            doc = _finddoc(object)
        except (AttributeError, TypeError):
            return None
    if not isinstance(doc, str):
        return None
    return cleandoc(doc)

def cleandoc(doc):
    """Clean up indentation from docstrings.

    Any whitespace that can be uniformly removed from the second line
    onwards is removed."""
    lines = doc.expandtabs().split('\n')

    # Find minimum indentation of any non-blank lines after first line.
    margin = sys.maxsize
    for line in lines[1:]:
        content = len(line.lstrip(' '))
        if content:
            indent = len(line) - content
            margin = min(margin, indent)
    # Remove indentation.
    if lines:
        lines[0] = lines[0].lstrip(' ')
    if margin < sys.maxsize:
        for i in range(1, len(lines)):
            lines[i] = lines[i][margin:]
    # Remove any trailing or leading blank lines.
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return '\n'.join(lines)



Arguments = namedtuple('Arguments', 'args, varargs, varkw')

def getargs(co):
    """Get information about the arguments accepted by a code object.

    Three things are returned: (args, varargs, varkw), where
    'args' is the list of argument names. Keyword-only arguments are
    appended. 'varargs' and 'varkw' are the names of the * and **
    arguments or None."""
    if not iscode(co):
        raise TypeError('{!r} is not a code object'.format(co))

    names = co.co_varnames
    nargs = co.co_argcount
    nkwargs = co.co_kwonlyargcount
    args = list(names[:nargs])
    kwonlyargs = list(names[nargs:nargs+nkwargs])

    nargs += nkwargs
    varargs = None
    if co.co_flags & CO_VARARGS:
        varargs = co.co_varnames[nargs]
        nargs = nargs + 1
    varkw = None
    if co.co_flags & CO_VARKEYWORDS:
        varkw = co.co_varnames[nargs]
    return Arguments(args + kwonlyargs, varargs, varkw)


FullArgSpec = namedtuple('FullArgSpec',
    'args, varargs, varkw, defaults, kwonlyargs, kwonlydefaults, annotations')

def getfullargspec(func):
    """Get the names and default values of a callable object's parameters.

    A tuple of seven things is returned:
    (args, varargs, varkw, defaults, kwonlyargs, kwonlydefaults, annotations).
    'args' is a list of the parameter names.
    'varargs' and 'varkw' are the names of the * and ** parameters or None.
    'defaults' is an n-tuple of the default values of the last n parameters.
    'kwonlyargs' is a list of keyword-only parameter names.
    'kwonlydefaults' is a dictionary mapping names from kwonlyargs to defaults.
    'annotations' is a dictionary mapping parameter names to annotations.

    Notable differences from inspect.signature():
      - the "self" parameter is always reported, even for bound methods
      - wrapper chains defined by __wrapped__ *not* unwrapped automatically
    """
    try:
        # Re: `skip_bound_arg=False`
        #
        # There is a notable difference in behaviour between getfullargspec
        # and Signature: the former always returns 'self' parameter for bound
        # methods, whereas the Signature always shows the actual calling
        # signature of the passed object.
        #
        # To simulate this behaviour, we "unbind" bound methods, to trick
        # inspect.signature to always return their first parameter ("self",
        # usually)

        # Re: `follow_wrapper_chains=False`
        #
        # getfullargspec() historically ignored __wrapped__ attributes,
        # so we ensure that remains the case in 3.3+

        sig = _signature_from_callable(func,
                                       follow_wrapper_chains=False,
                                       skip_bound_arg=False,
                                       sigcls=Signature,
                                       eval_str=False)
    except Exception as ex:
        # Most of the times 'signature' will raise ValueError.
        # But, it can also raise AttributeError, and, maybe something
        # else. So to be fully backwards compatible, we catch all
        # possible exceptions here, and reraise a TypeError.
        raise TypeError('unsupported callable') from ex

    args = []
    varargs = None
    varkw = None
    posonlyargs = []
    kwonlyargs = []
    annotations = {}
    defaults = ()
    kwdefaults = {}

    if sig.return_annotation is not sig.empty:
        annotations['return'] = sig.return_annotation

    for param in sig.parameters.values():
        kind = param.kind
        name = param.name

        if kind is _POSITIONAL_ONLY:
            posonlyargs.append(name)
            if param.default is not param.empty:
                defaults += (param.default,)
        elif kind is _POSITIONAL_OR_KEYWORD:
            args.append(name)
            if param.default is not param.empty:
                defaults += (param.default,)
        elif kind is _VAR_POSITIONAL:
            varargs = name
        elif kind is _KEYWORD_ONLY:
            kwonlyargs.append(name)
            if param.default is not param.empty:
                kwdefaults[name] = param.default
        elif kind is _VAR_KEYWORD:
            varkw = name

        if param.annotation is not param.empty:
            annotations[name] = param.annotation

    if not kwdefaults:
        # compatibility with 'func.__kwdefaults__'
        kwdefaults = None

    if not defaults:
        # compatibility with 'func.__defaults__'
        defaults = None

    return FullArgSpec(posonlyargs + args, varargs, varkw, defaults,
                       kwonlyargs, kwdefaults, annotations)


ArgInfo = namedtuple('ArgInfo', 'args varargs keywords locals')

def getargvalues(frame):
    """Get information about arguments passed into a particular frame.

    A tuple of four things is returned: (args, varargs, varkw, locals).
    'args' is a list of the argument names.
    'varargs' and 'varkw' are the names of the * and ** arguments or None.
    'locals' is the locals dictionary of the given frame."""
    args, varargs, varkw = getargs(frame.f_code)
    return ArgInfo(args, varargs, varkw, frame.f_locals)

def formatannotation(annotation, base_module=None, *, quote_annotation_strings=True):
    if not quote_annotation_strings and isinstance(annotation, str):
        return annotation
    if getattr(annotation, '__module__', None) == 'typing':
        def repl(match):
            text = match.group()
            return text.removeprefix('typing.')
        return re.sub(r'[\w\.]+', repl, repr(annotation))
    if isinstance(annotation, types.GenericAlias):
        return str(annotation)
    if isinstance(annotation, type):
        if annotation.__module__ in ('builtins', base_module):
            return annotation.__qualname__
        return annotation.__module__+'.'+annotation.__qualname__
    if isinstance(annotation, ForwardRef):
        return annotation.__forward_arg__
    return repr(annotation)

def formatannotationrelativeto(object):
    module = getattr(object, '__module__', None)
    def _formatannotation(annotation):
        return formatannotation(annotation, module)
    return _formatannotation



_sentinel = object()
_static_getmro = type.__dict__['__mro__'].__get__
_get_dunder_dict_of_class = type.__dict__["__dict__"].__get__


def _check_instance(obj, attr):
    instance_dict = {}
    try:
        instance_dict = object.__getattribute__(obj, "__dict__")
    except AttributeError:
        pass
    return dict.get(instance_dict, attr, _sentinel)


def _check_class(klass, attr):
    for entry in _static_getmro(klass):
        if _shadowed_dict(type(entry)) is _sentinel and attr in entry.__dict__:
            return entry.__dict__[attr]
    return _sentinel


@functools.lru_cache()
def _shadowed_dict_from_weakref_mro_tuple(*weakref_mro):
    for weakref_entry in weakref_mro:
        # Normally we'd have to check whether the result of weakref_entry()
        # is None here, in case the object the weakref is pointing to has died.
        # In this specific case, however, we know that the only caller of this
        # function is `_shadowed_dict()`, and that therefore this weakref is
        # guaranteed to point to an object that is still alive.
        entry = weakref_entry()
        dunder_dict = _get_dunder_dict_of_class(entry)
        if '__dict__' in dunder_dict:
            class_dict = dunder_dict['__dict__']
            if not (type(class_dict) is types.GetSetDescriptorType and
                    class_dict.__name__ == "__dict__" and
                    class_dict.__objclass__ is entry):
                return class_dict
    return _sentinel


def _shadowed_dict(klass):
    # gh-118013: the inner function here is decorated with lru_cache for
    # performance reasons, *but* make sure not to pass strong references
    # to the items in the mro. Doing so can lead to unexpected memory
    # consumption in cases where classes are dynamically created and
    # destroyed, and the dynamically created classes happen to be the only
    # objects that hold strong references to other objects that take up a
    # significant amount of memory.
    return _shadowed_dict_from_weakref_mro_tuple(
        *[make_weakref(entry) for entry in _static_getmro(klass)]
    )


def getattr_static(obj, attr, default=_sentinel):
    """Retrieve attributes without triggering dynamic lookup via the
       descriptor protocol,  __getattr__ or __getattribute__.

       Note: this function may not be able to retrieve all attributes
       that getattr can fetch (like dynamically created attributes)
       and may find attributes that getattr can't (like descriptors
       that raise AttributeError). It can also return descriptor objects
       instead of instance members in some cases. See the
       documentation for details.
    """
    instance_result = _sentinel

    objtype = type(obj)
    if type not in _static_getmro(objtype):
        klass = objtype
        dict_attr = _shadowed_dict(klass)
        if (dict_attr is _sentinel or
            type(dict_attr) is types.MemberDescriptorType):
            instance_result = _check_instance(obj, attr)
    else:
        klass = obj

    klass_result = _check_class(klass, attr)

    if instance_result is not _sentinel and klass_result is not _sentinel:
        if _check_class(type(klass_result), "__get__") is not _sentinel and (
            _check_class(type(klass_result), "__set__") is not _sentinel
            or _check_class(type(klass_result), "__delete__") is not _sentinel
        ):
            return klass_result

    if instance_result is not _sentinel:
        return instance_result
    if klass_result is not _sentinel:
        return klass_result

    if obj is klass:
        # for types we check the metaclass too
        for entry in _static_getmro(type(klass)):
            if (
                _shadowed_dict(type(entry)) is _sentinel
                and attr in entry.__dict__
            ):
                return entry.__dict__[attr]
    if default is not _sentinel:
        return default
    raise AttributeError(attr)


# ------------------------------------------------ generator introspection


_NonUserDefinedCallables = (types.WrapperDescriptorType,
                            types.MethodWrapperType,
                            types.ClassMethodDescriptorType,
                            types.BuiltinFunctionType)


_OBJECT_SLOTS = (object.__init__, object.__new__)


def _signature_get_user_defined_method(cls, method_name, *, follow_wrapper_chains=True):
    """Private helper. Checks if ``cls`` has an attribute
    named ``method_name`` and returns it only if it is a
    pure python function.
    """
    if method_name == '__new__':
        meth = getattr(cls, method_name, None)
    else:
        meth = getattr_static(cls, method_name, None)
    if meth is None:
        return None

    # NOTE: The meth may wraps a non-user-defined callable.
    # In this case, we treat the meth as non-user-defined callable too.
    # (e.g. cls.__new__ generated by @warnings.deprecated)
    unwrapped_meth = None
    if follow_wrapper_chains:
        unwrapped_meth = unwrap(meth, stop=(lambda m: hasattr(m, "__signature__")
                                  or _signature_is_builtin(m)))

    # (Sagebrush's: object.__init__ and object.__new__ are the runtime's own functions here, not CPython's
    # wrapper_descriptor and builtin, and are not user-defined either)
    if (isinstance(meth, _NonUserDefinedCallables)
          or isinstance(unwrapped_meth, _NonUserDefinedCallables)
          or any(meth is o or unwrapped_meth is o for o in _OBJECT_SLOTS)):
        # Once '__signature__' will be added to 'C'-level
        # callables, this check won't be necessary
        return None
    if method_name != '__new__':
        meth = _descriptor_get(meth, cls)
    return meth


def _signature_get_partial(wrapped_sig, partial, extra_args=()):
    """Private helper to calculate how 'wrapped_sig' signature will
    look like after applying a 'functools.partial' object (or alike)
    on it.
    """

    old_params = wrapped_sig.parameters
    new_params = OrderedDict(old_params.items())

    partial_args = partial.args or ()
    partial_keywords = partial.keywords or {}

    if extra_args:
        partial_args = extra_args + partial_args

    try:
        ba = wrapped_sig.bind_partial(*partial_args, **partial_keywords)
    except TypeError as ex:
        msg = 'partial object {!r} has incorrect arguments'.format(partial)
        raise ValueError(msg) from ex


    transform_to_kwonly = False
    for param_name, param in old_params.items():
        try:
            arg_value = ba.arguments[param_name]
        except KeyError:
            pass
        else:
            if param.kind is _POSITIONAL_ONLY:
                # If positional-only parameter is bound by partial,
                # it effectively disappears from the signature
                # However, if it is a Placeholder it is not removed
                # And also looses default value
                if arg_value is functools.Placeholder:
                    new_params[param_name] = param.replace(default=_empty)
                else:
                    new_params.pop(param_name)
                continue

            if param.kind is _POSITIONAL_OR_KEYWORD:
                if param_name in partial_keywords:
                    # This means that this parameter, and all parameters
                    # after it should be keyword-only (and var-positional
                    # should be removed). Here's why. Consider the following
                    # function:
                    #     foo(a, b, *args, c):
                    #         pass
                    #
                    # "partial(foo, a='spam')" will have the following
                    # signature: "(*, a='spam', b, c)". Because attempting
                    # to call that partial with "(10, 20)" arguments will
                    # raise a TypeError, saying that "a" argument received
                    # multiple values.
                    transform_to_kwonly = True
                    # Set the new default value
                    new_params[param_name] = param.replace(default=arg_value)
                else:
                    # was passed as a positional argument
                    # Do not pop if it is a Placeholder
                    #   also change kind to positional only
                    #   and remove default
                    if arg_value is functools.Placeholder:
                        new_param = param.replace(
                            kind=_POSITIONAL_ONLY,
                            default=_empty
                        )
                        new_params[param_name] = new_param
                    else:
                        new_params.pop(param_name)
                    continue

            if param.kind is _KEYWORD_ONLY:
                # Set the new default value
                new_params[param_name] = param.replace(default=arg_value)

        if transform_to_kwonly:
            assert param.kind is not _POSITIONAL_ONLY

            if param.kind is _POSITIONAL_OR_KEYWORD:
                new_param = new_params[param_name].replace(kind=_KEYWORD_ONLY)
                new_params[param_name] = new_param
                new_params.move_to_end(param_name)
            elif param.kind in (_KEYWORD_ONLY, _VAR_KEYWORD):
                new_params.move_to_end(param_name)
            elif param.kind is _VAR_POSITIONAL:
                new_params.pop(param.name)

    return wrapped_sig.replace(parameters=new_params.values())


def _signature_bound_method(sig):
    """Private helper to transform signatures for unbound
    functions to bound methods.
    """

    params = tuple(sig.parameters.values())

    if not params or params[0].kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
        raise ValueError('invalid method signature')

    kind = params[0].kind
    if kind in (_POSITIONAL_OR_KEYWORD, _POSITIONAL_ONLY):
        # Drop first parameter:
        # '(p1, p2[, ...])' -> '(p2[, ...])'
        params = params[1:]
    else:
        if kind is not _VAR_POSITIONAL:
            # Unless we add a new parameter type we never
            # get here
            raise ValueError('invalid argument type')
        # It's a var-positional parameter.
        # Do nothing. '(*args[, ...])' -> '(*args[, ...])'

    return sig.replace(parameters=params)


def _signature_is_builtin(obj):
    """Private helper to test if `obj` is a callable that might
    support Argument Clinic's __text_signature__ protocol.
    """
    return (isbuiltin(obj) or
            ismethoddescriptor(obj) or
            isinstance(obj, _NonUserDefinedCallables) or
            # Can't test 'isinstance(type)' here, as it would
            # also be True for regular python classes.
            # Can't use the `in` operator here, as it would
            # invoke the custom __eq__ method.
            obj is type or obj is object)


def _signature_is_functionlike(obj):
    """Private helper to test if `obj` is a duck type of FunctionType.
    A good example of such objects are functions compiled with
    Cython, which have all attributes that a pure Python function
    would have, but have their code statically compiled.
    """

    if not callable(obj) or isclass(obj):
        # All function-like objects are obviously callables,
        # and not classes.
        return False

    name = getattr(obj, '__name__', None)
    code = getattr(obj, '__code__', None)
    defaults = getattr(obj, '__defaults__', _void) # Important to use _void ...
    kwdefaults = getattr(obj, '__kwdefaults__', _void) # ... and not None here

    return (isinstance(code, types.CodeType) and
            isinstance(name, str) and
            (defaults is None or isinstance(defaults, tuple)) and
            (kwdefaults is None or isinstance(kwdefaults, dict)))



def _signature_from_builtin(cls, func, skip_bound_arg=True):
    """Private helper function to get signature for
    builtin callables.
    """

    if not _signature_is_builtin(func):
        raise TypeError("{!r} is not a Python builtin "
                        "function".format(func))

    s = getattr(func, "__text_signature__", None)
    if not s:
        raise ValueError("no signature found for builtin {!r}".format(func))

    return _signature_fromstr(cls, func, s, skip_bound_arg)


def _signature_from_function(cls, func, skip_bound_arg=True,
                             globals=None, locals=None, eval_str=False,
                             *, annotation_format=Format.VALUE):
    """Private helper: constructs Signature for the given python function."""

    is_duck_function = False
    if not isfunction(func):
        if _signature_is_functionlike(func):
            is_duck_function = True
        else:
            # If it's not a pure Python function, and not a duck type
            # of pure function (Cython and Mock functions, for instance), then:
            raise TypeError('{!r} is not a Python function'.format(func))

    s = getattr(func, "__text_signature__", None)
    if s:
        return _signature_fromstr(cls, func, s, skip_bound_arg)

    Parameter = cls._parameter_cls

    # Parameter information.
    func_code = func.__code__
    pos_count = func_code.co_argcount
    arg_names = func_code.co_varnames
    posonly_count = func_code.co_posonlyargcount
    positional = arg_names[:pos_count]
    keyword_only_count = func_code.co_kwonlyargcount
    keyword_only = arg_names[pos_count:pos_count + keyword_only_count]
    annotations = get_annotations(func, globals=globals, locals=locals, eval_str=eval_str,
                                  format=annotation_format)
    defaults = func.__defaults__
    kwdefaults = func.__kwdefaults__

    if defaults:
        pos_default_count = len(defaults)
    else:
        pos_default_count = 0

    parameters = []

    non_default_count = pos_count - pos_default_count
    posonly_left = posonly_count

    # Non-keyword-only parameters w/o defaults.
    for name in positional[:non_default_count]:
        kind = _POSITIONAL_ONLY if posonly_left else _POSITIONAL_OR_KEYWORD
        annotation = annotations.get(name, _empty)
        parameters.append(Parameter(name, annotation=annotation,
                                    kind=kind))
        if posonly_left:
            posonly_left -= 1

    # ... w/ defaults.
    for offset, name in enumerate(positional[non_default_count:]):
        kind = _POSITIONAL_ONLY if posonly_left else _POSITIONAL_OR_KEYWORD
        annotation = annotations.get(name, _empty)
        parameters.append(Parameter(name, annotation=annotation,
                                    kind=kind,
                                    default=defaults[offset]))
        if posonly_left:
            posonly_left -= 1

    # *args
    if func_code.co_flags & CO_VARARGS:
        name = arg_names[pos_count + keyword_only_count]
        annotation = annotations.get(name, _empty)
        parameters.append(Parameter(name, annotation=annotation,
                                    kind=_VAR_POSITIONAL))

    # Keyword-only parameters.
    for name in keyword_only:
        default = _empty
        if kwdefaults is not None:
            default = kwdefaults.get(name, _empty)

        annotation = annotations.get(name, _empty)
        parameters.append(Parameter(name, annotation=annotation,
                                    kind=_KEYWORD_ONLY,
                                    default=default))
    # **kwargs
    if func_code.co_flags & CO_VARKEYWORDS:
        index = pos_count + keyword_only_count
        if func_code.co_flags & CO_VARARGS:
            index += 1

        name = arg_names[index]
        annotation = annotations.get(name, _empty)
        parameters.append(Parameter(name, annotation=annotation,
                                    kind=_VAR_KEYWORD))

    # Is 'func' is a pure Python function - don't validate the
    # parameters list (for correct order and defaults), it should be OK.
    return cls(parameters,
               return_annotation=annotations.get('return', _empty),
               __validate_parameters__=is_duck_function)


def _descriptor_get(descriptor, obj):
    if isclass(descriptor):
        return descriptor
    get = getattr(type(descriptor), '__get__', _sentinel)
    if get is _sentinel:
        return descriptor
    return get(descriptor, obj, type(obj))


def _signature_from_callable(obj, *,
                             follow_wrapper_chains=True,
                             skip_bound_arg=True,
                             globals=None,
                             locals=None,
                             eval_str=False,
                             sigcls,
                             annotation_format=Format.VALUE):

    """Private helper function to get signature for arbitrary
    callable objects.
    """

    _get_signature_of = functools.partial(_signature_from_callable,
                                follow_wrapper_chains=follow_wrapper_chains,
                                skip_bound_arg=skip_bound_arg,
                                globals=globals,
                                locals=locals,
                                sigcls=sigcls,
                                eval_str=eval_str,
                                annotation_format=annotation_format)

    if not callable(obj):
        raise TypeError('{!r} is not a callable object'.format(obj))

    if isinstance(obj, types.MethodType):
        # In this case we skip the first parameter of the underlying
        # function (usually `self` or `cls`).
        sig = _get_signature_of(obj.__func__)

        if skip_bound_arg:
            return _signature_bound_method(sig)
        else:
            return sig

    # Was this function wrapped by a decorator?
    if follow_wrapper_chains:
        # Unwrap until we find an explicit signature or a MethodType (which will be
        # handled explicitly below).
        obj = unwrap(obj, stop=(lambda f: hasattr(f, "__signature__")
                                or isinstance(f, types.MethodType)))
        if isinstance(obj, types.MethodType):
            # If the unwrapped object is a *method*, we might want to
            # skip its first parameter (self).
            # See test_signature_wrapped_bound_method for details.
            return _get_signature_of(obj)

    try:
        sig = obj.__signature__
    except AttributeError:
        pass
    else:
        if sig is not None:
            if not isinstance(sig, Signature):
                raise TypeError(
                    'unexpected object {!r} in __signature__ '
                    'attribute'.format(sig))
            return sig

    try:
        partialmethod = obj.__partialmethod__
    except AttributeError:
        pass
    else:
        if isinstance(partialmethod, functools.partialmethod):
            # Unbound partialmethod (see functools.partialmethod)
            # This means, that we need to calculate the signature
            # as if it's a regular partial object, but taking into
            # account that the first positional argument
            # (usually `self`, or `cls`) will not be passed
            # automatically (as for boundmethods)

            wrapped_sig = _get_signature_of(partialmethod.func)

            sig = _signature_get_partial(wrapped_sig, partialmethod, (None,))
            first_wrapped_param = tuple(wrapped_sig.parameters.values())[0]
            if first_wrapped_param.kind is Parameter.VAR_POSITIONAL:
                # First argument of the wrapped callable is `*args`, as in
                # `partialmethod(lambda *args)`.
                return sig
            else:
                sig_params = tuple(sig.parameters.values())
                assert (not sig_params or
                        first_wrapped_param is not sig_params[0])
                # If there were placeholders set,
                #   first param is transformed to positional only
                if partialmethod.args.count(functools.Placeholder):
                    first_wrapped_param = first_wrapped_param.replace(
                        kind=Parameter.POSITIONAL_ONLY)
                new_params = (first_wrapped_param,) + sig_params
                return sig.replace(parameters=new_params)

    if isinstance(obj, functools.partial):
        wrapped_sig = _get_signature_of(obj.func)
        return _signature_get_partial(wrapped_sig, obj)

    if isfunction(obj) or _signature_is_functionlike(obj):
        # If it's a pure Python function, or an object that is duck type
        # of a Python function (Cython and Mock functions, for instance), then:
        return _signature_from_function(sigcls, obj,
                                        skip_bound_arg=skip_bound_arg,
                                        globals=globals, locals=locals, eval_str=eval_str,
                                        annotation_format=annotation_format)

    if _signature_is_builtin(obj):
        return _signature_from_builtin(sigcls, obj,
                                       skip_bound_arg=skip_bound_arg)

    if isinstance(obj, type):
        # obj is a class or a metaclass

        # First, let's see if it has an overloaded __call__ defined
        # in its metaclass
        call = _signature_get_user_defined_method(
            type(obj),
            '__call__',
            follow_wrapper_chains=follow_wrapper_chains,
        )
        if call is not None:
            return _get_signature_of(call)

        # NOTE: The user-defined method can be a function with a thin wrapper
        # around object.__new__ (e.g., generated by `@warnings.deprecated`)
        new = _signature_get_user_defined_method(
            obj,
            '__new__',
            follow_wrapper_chains=follow_wrapper_chains,
        )
        init = _signature_get_user_defined_method(
            obj,
            '__init__',
            follow_wrapper_chains=follow_wrapper_chains,
        )

        # Go through the MRO and see if any class has user-defined
        # pure Python __new__ or __init__ method
        for base in obj.__mro__:
            # Now we check if the 'obj' class has an own '__new__' method
            if new is not None and '__new__' in base.__dict__:
                sig = _get_signature_of(new)
                if skip_bound_arg:
                    sig = _signature_bound_method(sig)
                return sig
            # or an own '__init__' method
            elif init is not None and '__init__' in base.__dict__:
                return _get_signature_of(init)

        # At this point we know, that `obj` is a class, with no user-
        # defined '__init__', '__new__', or class-level '__call__'

        for base in obj.__mro__[:-1]:
            # Since '__text_signature__' is implemented as a
            # descriptor that extracts text signature from the
            # class docstring, if 'obj' is derived from a builtin
            # class, its own '__text_signature__' may be 'None'.
            # Therefore, we go through the MRO (except the last
            # class in there, which is 'object') to find the first
            # class with non-empty text signature.
            try:
                text_sig = base.__text_signature__
            except AttributeError:
                pass
            else:
                if text_sig:
                    # If 'base' class has a __text_signature__ attribute:
                    # return a signature based on it
                    return _signature_fromstr(sigcls, base, text_sig)

        # No '__text_signature__' was found for the 'obj' class.
        # Last option is to check if its '__init__' is
        # object.__init__ or type.__init__.
        if type not in obj.__mro__:
            obj_init = obj.__init__
            obj_new = obj.__new__
            if follow_wrapper_chains:
                obj_init = unwrap(obj_init)
                obj_new = unwrap(obj_new)
            # We have a class (not metaclass), but no user-defined
            # __init__ or __new__ for it
            if obj_init is object.__init__ and obj_new is object.__new__:
                # Return a signature of 'object' builtin.
                # (Sagebrush's: object's signature, (), made here: Sagebrush's object has no text signature)
                return sigcls()
            else:
                raise ValueError(
                    'no signature found for builtin type {!r}'.format(obj))

    else:
        # An object with __call__
        call = getattr_static(type(obj), '__call__', None)
        if call is not None:
            try:
                text_sig = obj.__text_signature__
            except AttributeError:
                pass
            else:
                if text_sig:
                    return _signature_fromstr(sigcls, obj, text_sig)
            call = _descriptor_get(call, obj)
            return _get_signature_of(call)

    raise ValueError('callable {!r} is not supported by signature'.format(obj))


class _void:
    """A private marker - used in Parameter & Signature."""


class _empty:
    """Marker object for Signature.empty and Parameter.empty."""


class _ParameterKind(enum.IntEnum):
    POSITIONAL_ONLY = 'positional-only'
    POSITIONAL_OR_KEYWORD = 'positional or keyword'
    VAR_POSITIONAL = 'variadic positional'
    KEYWORD_ONLY = 'keyword-only'
    VAR_KEYWORD = 'variadic keyword'

    def __new__(cls, description):
        value = len(cls.__members__)
        member = int.__new__(cls, value)
        member._value_ = value
        member.description = description
        return member

    def __str__(self):
        return self.name

_POSITIONAL_ONLY         = _ParameterKind.POSITIONAL_ONLY
_POSITIONAL_OR_KEYWORD   = _ParameterKind.POSITIONAL_OR_KEYWORD
_VAR_POSITIONAL          = _ParameterKind.VAR_POSITIONAL
_KEYWORD_ONLY            = _ParameterKind.KEYWORD_ONLY
_VAR_KEYWORD             = _ParameterKind.VAR_KEYWORD


class Parameter:
    """Represents a parameter in a function signature.

    Has the following public attributes:

    * name : str
        The name of the parameter as a string.
    * default : object
        The default value for the parameter if specified.  If the
        parameter has no default value, this attribute is set to
        `Parameter.empty`.
    * annotation
        The annotation for the parameter if specified.  If the
        parameter has no annotation, this attribute is set to
        `Parameter.empty`.
    * kind
        Describes how argument values are bound to the parameter.
        Possible values: `Parameter.POSITIONAL_ONLY`,
        `Parameter.POSITIONAL_OR_KEYWORD`, `Parameter.VAR_POSITIONAL`,
        `Parameter.KEYWORD_ONLY`, `Parameter.VAR_KEYWORD`.
        Every value has a `description` attribute describing meaning.
    """

    __slots__ = ('_name', '_kind', '_default', '_annotation')

    POSITIONAL_ONLY         = _POSITIONAL_ONLY
    POSITIONAL_OR_KEYWORD   = _POSITIONAL_OR_KEYWORD
    VAR_POSITIONAL          = _VAR_POSITIONAL
    KEYWORD_ONLY            = _KEYWORD_ONLY
    VAR_KEYWORD             = _VAR_KEYWORD

    empty = _empty

    def __init__(self, name, kind, *, default=_empty, annotation=_empty):
        try:
            self._kind = _ParameterKind(kind)
        except ValueError:
            raise ValueError(f'value {kind!r} is not a valid Parameter.kind')
        if default is not _empty:
            if self._kind in (_VAR_POSITIONAL, _VAR_KEYWORD):
                msg = '{} parameters cannot have default values'
                msg = msg.format(self._kind.description)
                raise ValueError(msg)
        self._default = default
        self._annotation = annotation

        if name is _empty:
            raise ValueError('name is a required attribute for Parameter')

        if not isinstance(name, str):
            msg = 'name must be a str, not a {}'.format(type(name).__name__)
            raise TypeError(msg)

        if name[0] == '.' and name[1:].isdigit():
            # These are implicit arguments generated by comprehensions. In
            # order to provide a friendlier interface to users, we recast
            # their name as "implicitN" and treat them as positional-only.
            # See issue 19611.
            if self._kind != _POSITIONAL_OR_KEYWORD:
                msg = (
                    'implicit arguments must be passed as '
                    'positional or keyword arguments, not {}'
                )
                msg = msg.format(self._kind.description)
                raise ValueError(msg)
            self._kind = _POSITIONAL_ONLY
            name = 'implicit{}'.format(name[1:])
        elif name == '.format':
            # gh-151665: Hidden parameter of compiler-generated annotation and type
            # alias/typevar evaluators. Show it as "format".
            name = 'format'

        # It's possible for C functions to have a positional-only parameter
        # where the name is a keyword, so for compatibility we'll allow it.
        is_keyword = iskeyword(name) and self._kind is not _POSITIONAL_ONLY
        if is_keyword or not name.isidentifier():
            raise ValueError('{!r} is not a valid parameter name'.format(name))

        self._name = name

    def __reduce__(self):
        return (type(self),
                (self._name, self._kind),
                {'_default': self._default,
                 '_annotation': self._annotation})

    def __setstate__(self, state):
        self._default = state['_default']
        self._annotation = state['_annotation']

    @property
    def name(self):
        return self._name

    @property
    def default(self):
        return self._default

    @property
    def annotation(self):
        return self._annotation

    @property
    def kind(self):
        return self._kind

    def replace(self, *, name=_void, kind=_void,
                annotation=_void, default=_void):
        """Creates a customized copy of the Parameter."""

        if name is _void:
            name = self._name

        if kind is _void:
            kind = self._kind

        if annotation is _void:
            annotation = self._annotation

        if default is _void:
            default = self._default

        return type(self)(name, kind, default=default, annotation=annotation)

    def __str__(self):
        return self._format()

    def _format(self, *, quote_annotation_strings=True):
        kind = self.kind
        formatted = self._name

        # Add annotation and default value
        if self._annotation is not _empty:
            annotation = formatannotation(self._annotation,
                                          quote_annotation_strings=quote_annotation_strings)
            formatted = '{}: {}'.format(formatted, annotation)

        if self._default is not _empty:
            if self._annotation is not _empty:
                formatted = '{} = {}'.format(formatted, repr(self._default))
            else:
                formatted = '{}={}'.format(formatted, repr(self._default))

        if kind == _VAR_POSITIONAL:
            formatted = '*' + formatted
        elif kind == _VAR_KEYWORD:
            formatted = '**' + formatted

        return formatted

    __replace__ = replace

    def __repr__(self):
        return '<{} "{}">'.format(self.__class__.__name__, self)

    def __hash__(self):
        return hash((self._name, self._kind, self._annotation, self._default))

    def __eq__(self, other):
        if self is other:
            return True
        if not isinstance(other, Parameter):
            return NotImplemented
        return (self._name == other._name and
                self._kind == other._kind and
                self._default == other._default and
                self._annotation == other._annotation)


class BoundArguments:
    """Result of `Signature.bind` call.  Holds the mapping of arguments
    to the function's parameters.

    Has the following public attributes:

    * arguments : dict
        An ordered mutable mapping of parameters' names to arguments' values.
        Does not contain arguments' default values.
    * signature : Signature
        The Signature object that created this instance.
    * args : tuple
        Tuple of positional arguments values.
    * kwargs : dict
        Dict of keyword arguments values.
    """

    __slots__ = ('arguments', '_signature', '__weakref__')

    def __init__(self, signature, arguments):
        self.arguments = arguments
        self._signature = signature

    @property
    def signature(self):
        return self._signature

    @property
    def args(self):
        args = []
        for param_name, param in self._signature.parameters.items():
            if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                break

            try:
                arg = self.arguments[param_name]
            except KeyError:
                # We're done here. Other arguments
                # will be mapped in 'BoundArguments.kwargs'
                break
            else:
                if param.kind == _VAR_POSITIONAL:
                    # *args
                    args.extend(arg)
                else:
                    # plain argument
                    args.append(arg)

        return tuple(args)

    @property
    def kwargs(self):
        kwargs = {}
        kwargs_started = False
        for param_name, param in self._signature.parameters.items():
            if not kwargs_started:
                if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                    kwargs_started = True
                else:
                    if param_name not in self.arguments:
                        kwargs_started = True
                        continue

            if not kwargs_started:
                continue

            try:
                arg = self.arguments[param_name]
            except KeyError:
                pass
            else:
                if param.kind == _VAR_KEYWORD:
                    # **kwargs
                    kwargs.update(arg)
                else:
                    # plain keyword argument
                    kwargs[param_name] = arg

        return kwargs

    def apply_defaults(self):
        """Set default values for missing arguments.

        For variable-positional arguments (*args) the default is an
        empty tuple.

        For variable-keyword arguments (**kwargs) the default is an
        empty dict.
        """
        arguments = self.arguments
        new_arguments = []
        for name, param in self._signature.parameters.items():
            try:
                new_arguments.append((name, arguments[name]))
            except KeyError:
                if param.default is not _empty:
                    val = param.default
                elif param.kind is _VAR_POSITIONAL:
                    val = ()
                elif param.kind is _VAR_KEYWORD:
                    val = {}
                else:
                    # This BoundArguments was likely produced by
                    # Signature.bind_partial().
                    continue
                new_arguments.append((name, val))
        self.arguments = dict(new_arguments)

    def __eq__(self, other):
        if self is other:
            return True
        if not isinstance(other, BoundArguments):
            return NotImplemented
        return (self.signature == other.signature and
                self.arguments == other.arguments)

    def __setstate__(self, state):
        self._signature = state['_signature']
        self.arguments = state['arguments']

    def __getstate__(self):
        return {'_signature': self._signature, 'arguments': self.arguments}

    def __repr__(self):
        args = []
        for arg, value in self.arguments.items():
            args.append('{}={!r}'.format(arg, value))
        return '<{} ({})>'.format(self.__class__.__name__, ', '.join(args))


class Signature:
    """A Signature object represents the overall signature of a function.
    It stores a Parameter object for each parameter accepted by the
    function, as well as information specific to the function itself.

    A Signature object has the following public attributes and methods:

    * parameters : OrderedDict
        An ordered mapping of parameters' names to the corresponding
        Parameter objects (keyword-only arguments are in the same order
        as listed in `code.co_varnames`).
    * return_annotation : object
        The annotation for the return type of the function if specified.
        If the function has no annotation for its return type, this
        attribute is set to `Signature.empty`.
    * bind(*args, **kwargs) -> BoundArguments
        Creates a mapping from positional and keyword arguments to
        parameters.
    * bind_partial(*args, **kwargs) -> BoundArguments
        Creates a partial mapping from positional and keyword arguments
        to parameters (simulating 'functools.partial' behavior.)
    """

    __slots__ = ('_return_annotation', '_parameters')

    _parameter_cls = Parameter
    _bound_arguments_cls = BoundArguments

    empty = _empty

    def __init__(self, parameters=None, *, return_annotation=_empty,
                 __validate_parameters__=True):
        """Constructs Signature from the given list of Parameter
        objects and 'return_annotation'.  All arguments are optional.
        """

        if parameters is None:
            params = OrderedDict()
        else:
            if __validate_parameters__:
                params = OrderedDict()
                top_kind = _POSITIONAL_ONLY
                seen_default = False
                seen_var_parameters = set()

                for param in parameters:
                    kind = param.kind
                    name = param.name

                    if kind in (_VAR_POSITIONAL, _VAR_KEYWORD):
                        if kind in seen_var_parameters:
                            msg = f'more than one {kind.description} parameter'
                            raise ValueError(msg)

                        seen_var_parameters.add(kind)

                    if kind < top_kind:
                        msg = (
                            'wrong parameter order: {} parameter before {} '
                            'parameter'
                        )
                        msg = msg.format(top_kind.description,
                                         kind.description)
                        raise ValueError(msg)
                    elif kind > top_kind:
                        top_kind = kind

                    if kind in (_POSITIONAL_ONLY, _POSITIONAL_OR_KEYWORD):
                        if param.default is _empty:
                            if seen_default:
                                # No default for this parameter, but the
                                # previous parameter of had a default
                                msg = 'non-default argument follows default ' \
                                      'argument'
                                raise ValueError(msg)
                        else:
                            # There is a default for this parameter.
                            seen_default = True

                    if name in params:
                        msg = 'duplicate parameter name: {!r}'.format(name)
                        raise ValueError(msg)

                    params[name] = param
            else:
                params = OrderedDict((param.name, param) for param in parameters)

        self._parameters = types.MappingProxyType(params)
        self._return_annotation = return_annotation

    @classmethod
    def from_callable(cls, obj, *,
                      follow_wrapped=True, globals=None, locals=None, eval_str=False,
                      annotation_format=Format.VALUE):
        """Constructs Signature for the given callable object."""
        return _signature_from_callable(obj, sigcls=cls,
                                        follow_wrapper_chains=follow_wrapped,
                                        globals=globals, locals=locals, eval_str=eval_str,
                                        annotation_format=annotation_format)

    @property
    def parameters(self):
        return self._parameters

    @property
    def return_annotation(self):
        return self._return_annotation

    def replace(self, *, parameters=_void, return_annotation=_void):
        """Creates a customized copy of the Signature.
        Pass 'parameters' and/or 'return_annotation' arguments
        to override them in the new copy.
        """

        if parameters is _void:
            parameters = self.parameters.values()

        if return_annotation is _void:
            return_annotation = self._return_annotation

        return type(self)(parameters,
                          return_annotation=return_annotation)

    __replace__ = replace

    def _hash_basis(self):
        params = tuple(param for param in self.parameters.values()
                             if param.kind != _KEYWORD_ONLY)

        kwo_params = {param.name: param for param in self.parameters.values()
                                        if param.kind == _KEYWORD_ONLY}

        return params, kwo_params, self.return_annotation

    def __hash__(self):
        params, kwo_params, return_annotation = self._hash_basis()
        kwo_params = frozenset(kwo_params.values())
        return hash((params, kwo_params, return_annotation))

    def __eq__(self, other):
        if self is other:
            return True
        if not isinstance(other, Signature):
            return NotImplemented
        return self._hash_basis() == other._hash_basis()

    def _bind(self, args, kwargs, *, partial=False):
        """Private method. Don't use directly."""

        arguments = {}

        parameters = iter(self.parameters.values())
        parameters_ex = ()
        arg_vals = iter(args)

        pos_only_param_in_kwargs = []

        while True:
            # Let's iterate through the positional arguments and corresponding
            # parameters
            try:
                arg_val = next(arg_vals)
            except StopIteration:
                # No more positional arguments
                try:
                    param = next(parameters)
                except StopIteration:
                    # No more parameters. That's it. Just need to check that
                    # we have no `kwargs` after this while loop
                    break
                else:
                    if param.kind == _VAR_POSITIONAL:
                        # That's OK, just empty *args.  Let's start parsing
                        # kwargs
                        break
                    elif param.name in kwargs:
                        if param.kind == _POSITIONAL_ONLY:
                            if param.default is _empty:
                                msg = f'missing a required positional-only argument: {param.name!r}'
                                raise TypeError(msg)
                            # Raise a TypeError once we are sure there is no
                            # **kwargs param later.
                            pos_only_param_in_kwargs.append(param)
                            continue
                        parameters_ex = (param,)
                        break
                    elif (param.kind == _VAR_KEYWORD or
                                                param.default is not _empty):
                        # That's fine too - we have a default value for this
                        # parameter.  So, lets start parsing `kwargs`, starting
                        # with the current parameter
                        parameters_ex = (param,)
                        break
                    else:
                        # No default, not VAR_KEYWORD, not VAR_POSITIONAL,
                        # not in `kwargs`
                        if partial:
                            parameters_ex = (param,)
                            break
                        else:
                            if param.kind == _KEYWORD_ONLY:
                                argtype = ' keyword-only'
                            else:
                                argtype = ''
                            msg = 'missing a required{argtype} argument: {arg!r}'
                            msg = msg.format(arg=param.name, argtype=argtype)
                            raise TypeError(msg) from None
            else:
                # We have a positional argument to process
                try:
                    param = next(parameters)
                except StopIteration:
                    raise TypeError('too many positional arguments') from None
                else:
                    if param.kind in (_VAR_KEYWORD, _KEYWORD_ONLY):
                        # Looks like we have no parameter for this positional
                        # argument
                        raise TypeError(
                            'too many positional arguments') from None

                    if param.kind == _VAR_POSITIONAL:
                        # We have an '*args'-like argument, let's fill it with
                        # all positional arguments we have left and move on to
                        # the next phase
                        values = [arg_val]
                        values.extend(arg_vals)
                        arguments[param.name] = tuple(values)
                        break

                    if param.name in kwargs and param.kind != _POSITIONAL_ONLY:
                        raise TypeError(
                            'multiple values for argument {arg!r}'.format(
                                arg=param.name)) from None

                    arguments[param.name] = arg_val

        # Now, we iterate through the remaining parameters to process
        # keyword arguments
        kwargs_param = None
        for param in itertools.chain(parameters_ex, parameters):
            if param.kind == _VAR_KEYWORD:
                # Memorize that we have a '**kwargs'-like parameter
                kwargs_param = param
                continue

            if param.kind == _VAR_POSITIONAL:
                # Named arguments don't refer to '*args'-like parameters.
                # We only arrive here if the positional arguments ended
                # before reaching the last parameter before *args.
                continue

            param_name = param.name
            try:
                arg_val = kwargs.pop(param_name)
            except KeyError:
                # We have no value for this parameter.  It's fine though,
                # if it has a default value, or it is an '*args'-like
                # parameter, left alone by the processing of positional
                # arguments.
                if (not partial and param.kind != _VAR_POSITIONAL and
                                                    param.default is _empty):
                    raise TypeError('missing a required argument: {arg!r}'. \
                                    format(arg=param_name)) from None

            else:
                arguments[param_name] = arg_val

        if kwargs:
            if kwargs_param is not None:
                # Process our '**kwargs'-like parameter
                arguments[kwargs_param.name] = kwargs
            elif pos_only_param_in_kwargs:
                raise TypeError(
                    'got some positional-only arguments passed as '
                    'keyword arguments: {arg!r}'.format(
                        arg=', '.join(
                            param.name
                            for param in pos_only_param_in_kwargs
                        ),
                    ),
                )
            else:
                raise TypeError(
                    'got an unexpected keyword argument {arg!r}'.format(
                        arg=next(iter(kwargs))))

        return self._bound_arguments_cls(self, arguments)

    def bind(self, /, *args, **kwargs):
        """Get a BoundArguments object, that maps the passed `args`
        and `kwargs` to the function's signature.  Raises `TypeError`
        if the passed arguments can not be bound.
        """
        return self._bind(args, kwargs)

    def bind_partial(self, /, *args, **kwargs):
        """Get a BoundArguments object, that partially maps the
        passed `args` and `kwargs` to the function's signature.
        Raises `TypeError` if the passed arguments can not be bound.
        """
        return self._bind(args, kwargs, partial=True)

    def __reduce__(self):
        return (type(self),
                (tuple(self._parameters.values()),),
                {'_return_annotation': self._return_annotation})

    def __setstate__(self, state):
        self._return_annotation = state['_return_annotation']

    def __repr__(self):
        return '<{} {}>'.format(self.__class__.__name__, self)

    def __str__(self):
        return self.format()

    def format(self, *, max_width=None, quote_annotation_strings=True):
        """Create a string representation of the Signature object.

        If *max_width* integer is passed,
        signature will try to fit into the *max_width*.
        If signature is longer than *max_width*,
        all parameters will be on separate lines.

        If *quote_annotation_strings* is False, annotations
        in the signature are displayed without opening and closing quotation
        marks. This is useful when the signature was created with the
        STRING format or when ``from __future__ import annotations`` was used.
        """
        result = []
        render_pos_only_separator = False
        render_kw_only_separator = True
        for param in self.parameters.values():
            formatted = param._format(quote_annotation_strings=quote_annotation_strings)

            kind = param.kind

            if kind == _POSITIONAL_ONLY:
                render_pos_only_separator = True
            elif render_pos_only_separator:
                # It's not a positional-only parameter, and the flag
                # is set to 'True' (there were pos-only params before.)
                result.append('/')
                render_pos_only_separator = False

            if kind == _VAR_POSITIONAL:
                # OK, we have an '*args'-like parameter, so we won't need
                # a '*' to separate keyword-only arguments
                render_kw_only_separator = False
            elif kind == _KEYWORD_ONLY and render_kw_only_separator:
                # We have a keyword-only parameter to render and we haven't
                # rendered an '*args'-like parameter before, so add a '*'
                # separator to the parameters list ("foo(arg1, *, arg2)" case)
                result.append('*')
                # This condition should be only triggered once, so
                # reset the flag
                render_kw_only_separator = False

            result.append(formatted)

        if render_pos_only_separator:
            # There were only positional-only parameters, hence the
            # flag was not reset to 'False'
            result.append('/')

        rendered = '({})'.format(', '.join(result))
        if max_width is not None and len(rendered) > max_width:
            rendered = '(\n    {}\n)'.format(',\n    '.join(result))

        if self.return_annotation is not _empty:
            anno = formatannotation(self.return_annotation,
                                    quote_annotation_strings=quote_annotation_strings)
            rendered += ' -> {}'.format(anno)

        return rendered


def signature(obj, *, follow_wrapped=True, globals=None, locals=None, eval_str=False,
              annotation_format=Format.VALUE):
    """Get a signature object for the passed callable."""
    return Signature.from_callable(obj, follow_wrapped=follow_wrapped,
                                   globals=globals, locals=locals, eval_str=eval_str,
                                   annotation_format=annotation_format)
