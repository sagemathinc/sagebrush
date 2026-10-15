"""ctypes for Sagebrush: only its simple number types (c_int32, c_uint8,
c_double, c_bool, c_char, ...), which hold a value with C's size and
wraparound, as on 64-bit Linux (c_long is 8 bytes), and sizeof().

Everything that reaches C memory or libraries (CDLL, pointers, arrays,
structures, c_char_p, byref, cast, ...) raises NotImplementedError: Python
runs in the browser, compiled to JavaScript, with no C libraries or memory
addresses."""
import struct as _struct

__all__ = ["c_bool", "c_char", "c_wchar", "c_byte", "c_ubyte", "c_short", "c_ushort", "c_int", "c_uint",
           "c_long", "c_ulong", "c_longlong", "c_ulonglong", "c_int8", "c_uint8", "c_int16", "c_uint16",
           "c_int32", "c_uint32", "c_int64", "c_uint64", "c_size_t", "c_ssize_t", "c_time_t",
           "c_float", "c_double", "sizeof", "alignment"]

_UNAVAILABLE = ("is not available in Sagebrush: Python runs in the browser, compiled to JavaScript, with no C "
                "libraries or memory addresses; its ctypes has only the simple number types (c_int32, c_double, ...)")


class _CDataType(type):
    def __mul__(cls, n):
        raise NotImplementedError("ctypes arrays (%s * %r) %s" % (cls.__name__, n, _UNAVAILABLE))

    __rmul__ = __mul__


class _SimpleCData(metaclass=_CDataType):
    _type_ = None
    _size_ = 0
    _zero = 0

    def __init__(self, *args):
        if len(args) > 1:
            raise TypeError("__init__ expected at most 1 argument, got %d" % len(args))
        self._value = self._convert(args[0]) if args else self._zero

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        self._value = self._convert(v)

    def __bool__(self):
        # (a char is true when it is not the zero byte)
        return self._value not in (0, b"\x00", "\x00")

    def __repr__(self):
        if type(self) is not _BASES.get(type(self).__name__):
            return "<%s object at %#x>" % (type(self).__name__, id(self))
        return "%s(%r)" % (type(self).__name__, self._value)


def _index(v):
    """operator.index, with CPython's error"""
    if not hasattr(type(v), "__index__"):
        raise TypeError("'%s' object cannot be interpreted as an integer" % type(v).__name__)
    return type(v).__index__(v)


def _int_type(name, code, size, signed):
    bits = 8 * size
    mask = (1 << bits) - 1
    half = 1 << (bits - 1)

    def convert(v):
        v = _index(v) & mask
        return v - (1 << bits) if signed and v >= half else v
    return _CDataType(name, (_SimpleCData,), {"_type_": code, "_size_": size, "_convert": staticmethod(convert),
                                              "__doc__": "C's %s: a %d-bit %s integer" % (
                                                  name[2:], bits, "signed" if signed else "unsigned")})


def _real(v):
    if isinstance(v, (int, float)) or hasattr(type(v), "__float__") or hasattr(type(v), "__index__"):
        return float(v)
    raise TypeError("must be real number, not %s" % type(v).__name__)


def _float32(v):
    x = _real(v)
    try:
        return _struct.unpack("f", _struct.pack("f", x))[0]
    except OverflowError:
        return float("inf") if x > 0 else float("-inf")


def _char(v):
    if isinstance(v, (bytes, bytearray)):
        if len(v) == 1:
            return bytes(v)
        what = "%s of length %d" % (type(v).__name__, len(v))
    elif isinstance(v, int):
        if 0 <= v < 256:
            return bytes([v])
        raise TypeError("integer not in range(256)")
    else:
        what = type(v).__name__
    raise TypeError("one character bytes, bytearray, or an integer in range(256) expected, not %s" % what)


def _wchar(v):
    if isinstance(v, str):
        if len(v) == 1:
            return v
        raise TypeError("a unicode character expected, not a string of length %d" % len(v))
    raise TypeError("a unicode character expected, not instance of %s" % type(v).__name__)


c_byte = _int_type("c_byte", "b", 1, True)
c_ubyte = _int_type("c_ubyte", "B", 1, False)
c_short = _int_type("c_short", "h", 2, True)
c_ushort = _int_type("c_ushort", "H", 2, False)
c_int = _int_type("c_int", "i", 4, True)
c_uint = _int_type("c_uint", "I", 4, False)
c_long = _int_type("c_long", "l", 8, True)
c_ulong = _int_type("c_ulong", "L", 8, False)
c_float = _CDataType("c_float", (_SimpleCData,), {"_type_": "f", "_size_": 4, "_zero": 0.0,
                                                  "_convert": staticmethod(_float32),
                                                  "__doc__": "C's float: a 32-bit floating-point number"})
c_double = _CDataType("c_double", (_SimpleCData,), {"_type_": "d", "_size_": 8, "_zero": 0.0,
                                                    "_convert": staticmethod(_real),
                                                    "__doc__": "C's double: a 64-bit floating-point number"})
c_bool = _CDataType("c_bool", (_SimpleCData,), {"_type_": "?", "_size_": 1, "_zero": False,
                                                "_convert": staticmethod(bool), "__doc__": "C's bool"})
c_char = _CDataType("c_char", (_SimpleCData,), {"_type_": "c", "_size_": 1, "_zero": b"\x00",
                                                "_convert": staticmethod(_char), "__doc__": "C's char: one byte"})
c_wchar = _CDataType("c_wchar", (_SimpleCData,), {"_type_": "u", "_size_": 4, "_zero": "\x00",
                                                  "_convert": staticmethod(_wchar), "__doc__": "C's wchar_t: one character"})
for _t in (c_byte, c_ubyte, c_short, c_ushort, c_int, c_uint, c_long, c_ulong, c_float, c_double, c_bool,
           c_char, c_wchar):
    _t.__module__ = "ctypes"
_BASES = {t.__name__: t for t in (c_byte, c_ubyte, c_short, c_ushort, c_int, c_uint, c_long, c_ulong, c_float,
                                  c_double, c_bool, c_char, c_wchar)}

# the sized names, as on 64-bit Linux
c_int8, c_uint8 = c_byte, c_ubyte
c_int16, c_uint16 = c_short, c_ushort
c_int32, c_uint32 = c_int, c_uint
c_int64, c_uint64 = c_long, c_ulong
c_longlong, c_ulonglong = c_long, c_ulong
c_size_t, c_ssize_t, c_time_t = c_ulong, c_long, c_long


def sizeof(obj_or_type):
    """The size in bytes of a ctypes type or instance."""
    t = obj_or_type if isinstance(obj_or_type, type) else type(obj_or_type)
    if isinstance(t, _CDataType) and t._size_:
        return t._size_
    raise TypeError("this type has no size")


def alignment(obj_or_type):
    """The alignment of a ctypes type or instance (its size, for these types)."""
    t = obj_or_type if isinstance(obj_or_type, type) else type(obj_or_type)
    if isinstance(t, _CDataType) and t._size_:
        return t._size_
    raise TypeError("no alignment info")


_NOT_HERE = {"CDLL", "PyDLL", "cdll", "pydll", "pythonapi", "LibraryLoader", "Structure", "Union",
             "BigEndianStructure", "LittleEndianStructure", "BigEndianUnion", "LittleEndianUnion", "Array",
             "POINTER", "pointer", "byref", "cast", "addressof", "create_string_buffer", "create_unicode_buffer",
             "memmove", "memset", "string_at", "wstring_at", "c_char_p", "c_wchar_p", "c_void_p", "c_longdouble",
             "CFUNCTYPE", "PYFUNCTYPE", "py_object", "resize", "get_errno", "set_errno", "ArgumentError",
             "windll", "oledll", "WinDLL", "OleDLL", "WINFUNCTYPE", "HRESULT", "FormatError", "GetLastError",
             "WinError", "DEFAULT_MODE", "RTLD_GLOBAL", "RTLD_LOCAL", "SetPointerType", "ARRAY"}


def __getattr__(name):
    if name in _NOT_HERE:
        raise NotImplementedError("ctypes.%s %s" % (name, _UNAVAILABLE))
    raise AttributeError("module 'ctypes' has no attribute %r" % name)
