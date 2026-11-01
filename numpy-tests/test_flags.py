# ndarray.flags (NumPy's flagsobj) and setflags: contiguity, ownership,
# writeability, the keys and attributes, what may be set and the errors,
# read-only arrays (a write raises), views of them, broadcast_to's, and
# frombuffer of bytes (read-only for good) and of a bytearray.
import numpy as np


def t(label, f):
    try:
        print(label, repr(f()))
    except Exception as e:
        print(label, type(e).__name__ + ":", e)


a = np.arange(6.0).reshape(2, 3)
shapes = {
    "C": a,
    "F": np.asfortranarray(a),
    "strided": a[:, ::2],
    "1-d": np.arange(4),
    "0-d": np.array(5.0),
    "empty": np.zeros((0, 3)),
    "transpose": a.T,
    "column": a[:, 1],
    "row": a[1],
    "copy": a.copy(),
}
for name, x in shapes.items():
    fl = x.flags
    print(name, [getattr(fl, k) for k in ["c_contiguous", "f_contiguous", "owndata", "writeable", "aligned", "writebackifcopy",
                                          "fnc", "forc", "behaved", "carray", "farray"]], fl.num)
print(repr(np.arange(3).flags))
print(str(a.T.flags))
print(type(a.flags).__name__)
for k in ["C", "F", "O", "W", "A", "X", "CONTIGUOUS", "C_CONTIGUOUS", "FORTRAN", "F_CONTIGUOUS", "OWNDATA", "WRITEABLE", "ALIGNED",
          "WRITEBACKIFCOPY", "FNC", "FORC", "B", "BEHAVED", "CA", "CARRAY", "FA", "FARRAY", "nope", "w"]:
    t("key " + k, lambda: a.flags[k])

# read-only, and views of a read-only array
r = np.arange(4.0)
r.flags.writeable = False
t("ro flag", lambda: r.flags.writeable)
t("ro write", lambda: r.__setitem__(0, 1.0))
t("ro slice write", lambda: r.__setitem__(slice(0, 2), 1.0))
t("ro iadd", lambda: r.__iadd__(1))
v = r[1:]
t("view of ro", lambda: v.flags.writeable)
t("view write", lambda: v.__setitem__(0, 1.0))
def make_view_writeable():
    v.flags.writeable = True
t("view set writeable", make_view_writeable)
t("ro copy writeable", lambda: r.copy().flags.writeable)
t("ro arithmetic result", lambda: (r + 1).flags.writeable)
def back():
    r.flags.writeable = True
    r[0] = 7.0
    return r[0], r.flags.writeable
t("writeable again", back)
w = np.arange(3.0)
x = w[1:]
w.flags.writeable = False
t("view made before", lambda: (x.flags.writeable, x.__setitem__(0, 9.0), w[1]))

# setitem and setattr
def set_key(k, val):
    d = np.arange(3.0)
    d.flags[k] = val
    return d.flags.writeable, d.flags.aligned
for k, val in [("W", False), ("WRITEABLE", False), ("A", False), ("ALIGNED", True), ("X", False), ("X", True), ("C", True), ("O", False), ("nope", True)]:
    t("setitem %s=%s" % (k, val), lambda: set_key(k, val))
def set_attr(name, val):
    d = np.arange(3.0)
    setattr(d.flags, name, val)
    return d.flags.writeable, d.flags.aligned
for name, val in [("writeable", False), ("aligned", False), ("writebackifcopy", False), ("writebackifcopy", True), ("c_contiguous", False), ("owndata", True)]:
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
t("setflags view of ro", sf_view)

# broadcast_to: read-only, but may be made writeable (as in NumPy)
b = np.broadcast_to(np.arange(3.0), (2, 3))
t("broadcast", lambda: (b.flags.writeable, b.flags.owndata))
t("broadcast write", lambda: b.__setitem__((0, 0), 1.0))

# frombuffer: of bytes, read-only for good; of a bytearray, writeable
fb = np.frombuffer(b"\x01\x02\x03\x04", dtype=np.uint8)
t("frombuffer bytes", lambda: (fb.flags.writeable, fb.flags.owndata, type(fb.base).__name__))
t("frombuffer write", lambda: fb.__setitem__(0, 9))
def fb_set():
    fb.flags.writeable = True
t("frombuffer set writeable", fb_set)
fba = np.frombuffer(bytearray(b"\x01\x02\x03\x04"), dtype=np.uint8)
t("frombuffer bytearray", lambda: (fba.flags.writeable, fba.flags.owndata, type(fba.base).__name__))
t("frombuffer f8", lambda: np.frombuffer(np.arange(2.0).tobytes()).flags.writeable)

# np.load gives a writeable array
import io
buf = io.BytesIO()
np.save(buf, np.arange(3.0))
buf.seek(0)
ld = np.load(buf)
t("load", lambda: (ld.flags.writeable, ld.flags.owndata))
ld[0] = 5.0
t("load write", lambda: ld[0])
