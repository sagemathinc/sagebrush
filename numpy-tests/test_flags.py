# ndarray.flags (NumPy's flagsobj) and setflags: contiguity, ownership,
# writeability, the keys and attributes, what may be set and the errors,
# read-only arrays (a write raises), views of them, broadcast_to's, and
# frombuffer of bytes (read-only for good) and of a bytearray; np.load's and
# loadmat's arrays are writeable.  Every printed line is one t() case, and
# each case builds its own arrays.
import io

import numpy as np


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__ + ":", e)


def base():
    return np.arange(6.0).reshape(2, 3)


SHAPES = {
    "C": lambda: base(),
    "F": lambda: np.asfortranarray(base()),
    "strided": lambda: base()[:, ::2],
    "1-d": lambda: np.arange(4),
    "0-d": lambda: np.array(5.0),
    "empty": lambda: np.zeros((0, 3)),
    "transpose": lambda: base().T,
    "column": lambda: base()[:, 1],
    "row": lambda: base()[1],
    "copy": lambda: base().copy(),
    "F-ro": lambda: (lambda x: (x.setflags(write=False), x)[1])(np.asfortranarray(base())),
    "strided-ro": lambda: (lambda x: (x.setflags(write=False), x)[1])(base()[:, ::2]),
}
NAMES = ["c_contiguous", "f_contiguous", "owndata", "writeable", "aligned", "writebackifcopy",
         "fnc", "forc", "behaved", "carray", "farray"]


def flags_row(x):
    fl = x.flags
    return [getattr(fl, k) for k in NAMES], fl.num


for name in SHAPES:
    t("shape " + name, lambda: flags_row(SHAPES[name]()))
t("repr", lambda: repr(np.arange(3).flags))
t("str", lambda: str(base().T.flags))
t("type", lambda: type(base().flags).__name__)
t("eq", lambda: (base().flags == base().flags, base().flags == base().T.flags))
for k in ["C", "F", "O", "W", "A", "X", "CONTIGUOUS", "C_CONTIGUOUS", "FORTRAN", "F_CONTIGUOUS", "OWNDATA", "WRITEABLE", "ALIGNED",
          "WRITEBACKIFCOPY", "FNC", "FORC", "B", "BEHAVED", "CA", "CARRAY", "FA", "FARRAY", "nope", "w"]:
    t("key " + k, lambda: base().flags[k])


# read-only, and views of a read-only array: a fresh read-only array per case
def ro():
    r = np.arange(4.0)
    r.flags.writeable = False
    return r


t("ro flag", lambda: ro().flags.writeable)
t("ro write", lambda: ro().__setitem__(0, 1.0))
t("ro slice write", lambda: ro().__setitem__(slice(0, 2), 1.0))
t("ro iadd", lambda: ro().__iadd__(1))
t("ro ufunc out", lambda: np.add(np.arange(4.0), 1, out=ro()))
t("view of ro", lambda: ro()[1:].flags.writeable)
t("view write", lambda: ro()[1:].__setitem__(0, 1.0))


def view_set_writeable():
    v = ro()[1:]
    v.flags.writeable = True
    return v.flags.writeable


t("view set writeable", view_set_writeable)
t("ro copy writeable", lambda: ro().copy().flags.writeable)
t("ro arithmetic result", lambda: (ro() + 1).flags.writeable)


def back():
    r = ro()
    r.flags.writeable = True
    r[0] = 7.0
    return r[0], r.flags.writeable


t("writeable again", back)


def view_made_before():
    w = np.arange(3.0)
    x = w[1:]
    w.flags.writeable = False
    x[0] = 9.0
    return x.flags.writeable, w[1]


t("view made before", view_made_before)


# setitem and setattr: only writeable, aligned and writebackifcopy may be set
def set_key(k, val):
    d = np.arange(3.0)
    d.flags[k] = val
    return d.flags.writeable, d.flags.aligned


for k, val in [("W", False), ("WRITEABLE", False), ("A", False), ("ALIGNED", True), ("X", False), ("X", True),
               ("C", True), ("F", False), ("O", False), ("nope", True)]:
    t("setitem %s=%s" % (k, val), lambda: set_key(k, val))


def set_attr(name, val):
    d = np.arange(3.0)
    setattr(d.flags, name, val)
    return d.flags.writeable, d.flags.aligned


for name, val in [("writeable", False), ("aligned", False), ("writebackifcopy", False), ("writebackifcopy", True),
                  ("c_contiguous", False), ("f_contiguous", True), ("owndata", True), ("carray", False)]:
    t("setattr %s=%s" % (name, val), lambda: set_attr(name, val))


# setflags
def sf(**kw):
    d = np.arange(3.0)
    d.setflags(**kw)
    return d.flags.writeable, d.flags.aligned


for kw in [{"write": False}, {"write": True}, {"align": False}, {"uic": False}, {"uic": True}, {}]:
    t("setflags %s" % kw, lambda: sf(**kw))


def sf_view():
    d = np.arange(3.0)
    d.setflags(write=False)
    e = d[1:]
    e.setflags(write=True)
    return e.flags.writeable


t("setflags view of ro", sf_view)


# broadcast_to: read-only, but may be made writeable (as in NumPy)
def bcast():
    return np.broadcast_to(np.arange(3.0), (2, 3))


t("broadcast", lambda: (bcast().flags.writeable, bcast().flags.owndata))
t("broadcast write", lambda: bcast().__setitem__((0, 0), 1.0))


def bcast_set_writeable():
    b = bcast()
    b.flags.writeable = True
    return b.flags.writeable


t("broadcast set writeable", bcast_set_writeable)


# frombuffer: of bytes, read-only for good; of a bytearray, writeable
def fb():
    return np.frombuffer(b"\x01\x02\x03\x04", dtype=np.uint8)


t("frombuffer bytes", lambda: (fb().flags.writeable, fb().flags.owndata, type(fb().base).__name__))
t("frombuffer write", lambda: fb().__setitem__(0, 9))


def fb_set():
    a = fb()
    a.flags.writeable = True
    return a.flags.writeable


t("frombuffer set writeable", fb_set)
t("frombuffer bytearray", lambda: (lambda a: (a.flags.writeable, a.flags.owndata, type(a.base).__name__))(
    np.frombuffer(bytearray(b"\x01\x02\x03\x04"), dtype=np.uint8)))
t("frombuffer f8", lambda: np.frombuffer(np.arange(2.0).tobytes()).flags.writeable)


# np.load and scipy.io.loadmat give writeable arrays
def loaded():
    buf = io.BytesIO()
    np.save(buf, np.arange(3.0))
    buf.seek(0)
    return np.load(buf)


t("load", lambda: (loaded().flags.writeable, loaded().flags.owndata))


def load_write():
    a = loaded()
    a[0] = 5.0
    return a[0]


t("load write", load_write)


def matloaded():
    from scipy.io import loadmat, savemat
    buf = io.BytesIO()
    savemat(buf, {"x": np.arange(3.0)})
    buf.seek(0)
    return loadmat(buf)["x"]


t("loadmat writeable", lambda: matloaded().flags.writeable)


def loadmat_write():
    a = matloaded()
    a[0, 0] = 5.0
    return a[0, 0]


t("loadmat write", loadmat_write)


# complex component views of a read-only array are read-only (a fresh array
# per case, and its bytes printed after the write)
def zro():
    z = np.array([1 + 2j, 3 + 4j])
    z.flags.writeable = False
    return z


def after(z, f):
    try:
        f(z)
        r = "no error"
    except Exception as e:
        r = type(e).__name__ + ": " + str(e)
    return r, z.tobytes().hex()


t("real flag", lambda: zro().real.flags.writeable)
t("imag flag", lambda: zro().imag.flags.writeable)
t("real item write", lambda: after(zro(), lambda z: z.real.__setitem__(0, 7.0)))
t("imag item write", lambda: after(zro(), lambda z: z.imag.__setitem__(0, 8.0)))
t("real whole write", lambda: after(zro(), lambda z: setattr(z, "real", 0.0)))
t("imag whole write", lambda: after(zro(), lambda z: setattr(z, "imag", 0.0)))
t("real view set writeable", lambda: after(zro(), lambda z: setattr(z.real.flags, "writeable", True)))


def zfb():
    return np.frombuffer(np.array([1 + 2j]).tobytes(), dtype=complex)


t("complex frombuffer flags", lambda: (zfb().flags.writeable, zfb().real.flags.writeable, zfb().imag.flags.writeable))
t("complex frombuffer real write", lambda: after(zfb(), lambda z: z.real.__setitem__(0, 7.0)))
t("complex frombuffer imag write", lambda: after(zfb(), lambda z: z.imag.__setitem__(0, 8.0)))
t("real-dtype imag flag", lambda: np.arange(3.0).imag.flags.writeable)


# a flags object is a snapshot of the array's flags when it was made
def retained(change):
    a = np.arange(3.0)
    f = a.flags
    change(a, f)
    return a, f


def unlock(a, f):
    a.setflags(write=False)
    a.setflags(write=True)


for cname, change in [("setflags write=False", lambda a, f: a.setflags(write=False)),
                      ("writeable = False on the array", lambda a, f: setattr(a.flags, "writeable", False)),
                      ("writeable = False through f", lambda a, f: setattr(f, "writeable", False)),
                      ("locked, then writeable = True", unlock)]:
    t("retained %s: f.writeable" % cname, lambda: retained(change)[1].writeable)
    t("retained %s: f.num" % cname, lambda: retained(change)[1].num)
    t("retained %s: repr(f)" % cname, lambda: repr(retained(change)[1]))
    t("retained %s: f == a.flags" % cname, lambda: (lambda a, f: f == a.flags)(*retained(change)))
    t("retained %s: a.flags.writeable" % cname, lambda: retained(change)[0].flags.writeable)
    t("retained %s: a.flags.num" % cname, lambda: retained(change)[0].flags.num)


# a read-only out= on the public ufunc path, and in-place targets: refused
# before any computing, and the array unchanged
def rout(f):
    r = ro()
    try:
        f(r)
        e = "no error"
    except Exception as x:
        e = type(x).__name__ + ": " + str(x)
    return e, r.tolist()


t("out unary", lambda: rout(lambda r: np.negative(np.arange(4.0), out=r)))
t("out binary", lambda: rout(lambda r: np.add(np.arange(4.0), 1.0, out=r)))
t("out binary positional", lambda: rout(lambda r: np.multiply(np.arange(4.0), 2.0, r)))
t("out tuple", lambda: rout(lambda r: np.add(np.arange(4.0), 1.0, out=(r,))))
t("out where", lambda: rout(lambda r: np.add(np.arange(4.0), 1.0, out=r, where=np.array([True, False, True, False]))))
t("out dtype", lambda: rout(lambda r: np.add(np.arange(4), 1, out=r, dtype="float64")))
t("out reduce", lambda: rout(lambda r: np.add.reduce(np.ones((2, 4)), axis=0, out=r)))
t("out accumulate", lambda: rout(lambda r: np.add.accumulate(np.ones(4), out=r)))
t("inplace pow", lambda: rout(lambda r: r.__ipow__(2)))
t("inplace pow half", lambda: rout(lambda r: r.__ipow__(0.5)))
t("inplace mul", lambda: rout(lambda r: r.__imul__(2)))
t("inplace floordiv", lambda: rout(lambda r: r.__ifloordiv__(2)))


def overlap(r):
    r[1:] += r[:-1]


t("inplace overlap", lambda: rout(overlap))
t("sort", lambda: rout(lambda r: r.sort()))
t("fill", lambda: rout(lambda r: r.fill(1.0)))
t("out writeable reduce", lambda: (lambda o: (np.add.reduce(np.ones((2, 3)), axis=0, out=o), o.tolist())[1])(np.zeros(3)))
t("out writeable accumulate", lambda: (lambda o: (np.multiply.accumulate(np.arange(1.0, 4.0), out=o), o.tolist())[1])(np.zeros(3)))
