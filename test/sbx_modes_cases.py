# sbx (lib/_sbx.py) between the four modes: each mode's own values, made
# as that mode makes them, encoded, decoded in every mode and encoded again.
# What comes back is what the target mode holds of it: the same tags,
# except where its natural type differs, which `expect` says (a matrix in
# Python is a list of rows; an integer in MATLAB a double); or an error that
# says what to do (a rational into MATLAB).  Run by test/sbx.test.ts.
import json
from fractions import Fraction

import numpy as np
import _sbx
import sage_all as S
import _magma as M
import _matlab as L

failed = 0


def report(ok, *what):
    global failed
    if not ok:
        failed += 1
    print("ok  " if ok else "FAIL", *what)


def entries_as_tags(es, ring):
    return [{"t": "rat" if ring == "QQ" else "int", "v": e} for e in es]


def rows(shape, xs):
    if len(shape) == 1:
        return list(xs)
    m, n = shape
    return [{"t": "list", "v": xs[i * n:(i + 1) * n]} for i in range(m)]


def expect(e, mode):
    """what encoding `e` decoded in `mode` gives back, or an Exception (the error expected)"""
    t = e["t"]
    # (a container of something refused: refused)
    if t == "list":
        xs = [expect(x, mode) for x in e["v"]]
        return next((x for x in xs if isinstance(x, Exception)), {"t": "list", "v": xs})
    if t == "dict":
        if mode == "magma":
            return Exception("dict")
        xs = [[k, expect(x, mode)] for k, x in e["v"]]
        return next((x for _, x in xs if isinstance(x, Exception)), {"t": "dict", "v": xs})
    if mode == "python":
        if t == "matrix":
            return {"t": "list", "v": rows(e["shape"], entries_as_tags(e["v"], e["ring"]))}
        return e
    if mode == "sage":
        if t == "array" and e["dtype"] == "int64" and len(e["shape"]) in (1, 2):
            return {"t": "matrix", "ring": "ZZ", "shape": e["shape"], "v": e["v"]}
        return e
    if mode == "magma":
        if t == "complex" or (t == "float" and isinstance(e["v"], str)):
            return Exception(t)
        if t == "poly" and len(e["vars"]) != 1:
            return Exception("poly")
        if t == "array":
            if e["dtype"] in ("complex128", "bool") or len(e["shape"]) not in (1, 2) or any(isinstance(x, str) and x in ("inf", "-inf", "nan") for x in e["v"]):
                return Exception("array")
            if len(e["shape"]) == 1:
                return {"t": "list", "v": [{"t": "int", "v": x} if e["dtype"] == "int64" else {"t": "float", "v": x} for x in e["v"]]}
            if e["dtype"] == "int64":
                return {"t": "matrix", "ring": "ZZ", "shape": e["shape"], "v": e["v"]}
        if t == "matrix" and len(e["shape"]) == 1:
            return {"t": "list", "v": entries_as_tags(e["v"], e["ring"])}
        return e
    if mode == "matlab":
        if t == "int":
            return {"t": "float", "v": float(int(e["v"]))} if abs(int(e["v"])) <= 2 ** 53 else Exception("int")
        if t in ("rat", "matrix", "poly"):
            return Exception(t)
        if t == "array":
            shape = e["shape"]
            if len(shape) == 1:
                shape = [1] + shape
            size = 1
            for n in shape:
                size *= n
            if size == 1 and e["dtype"] != "int64":
                x = e["v"][0]
                return {"t": {"float64": "float", "bool": "bool"}.get(e["dtype"], "complex"), **({"v": x} if e["dtype"] != "complex128" else {"re": x[0], "im": x[1]})}
            while len(shape) > 2 and shape[-1] == 1:
                shape = shape[:-1]
            return {**e, "shape": shape}
        return e


def roundtrip(label, value, source, override=None):
    try:
        e = _sbx.encode(value, source)
    except _sbx.SbxError as err:
        report(False, label, "can't be encoded:", err)
        return
    text = _sbx.dumps(value, source)
    report(json.loads(text)["value"] == e, label, "dumps as it encodes")
    for target in _sbx.MODES:
        want = (override or {}).get(target, expect(e, target))
        try:
            got = _sbx.encode(_sbx.loads(text, target), target)
        except _sbx.SbxError as err:
            report(isinstance(want, Exception), "%s: %s -> %s refused: %s" % (label, source, target, err))
            continue
        report(not isinstance(want, Exception) and got == want, "%s: %s -> %s" % (label, source, target), "" if got == want else "got %s, want %s" % (json.dumps(got)[:200], want))


def refused(label, value, source, words):
    try:
        _sbx.encode(value, source)
        report(False, label, "was encoded")
    except _sbx.SbxError as err:
        report(words in str(err), label, "refused:", err)


# ---- Python's
for label, v in [
    ("an int", 2 ** 70), ("a small int", -5), ("a rational", Fraction(-3, 4)), ("a float", 0.1), ("nan", float("nan")), ("a complex", complex(1.5, -2)),
    ("a bool", True), ("a str", "x = $\\alpha$"), ("a list", [1, "a", [2.5]]), ("a dict", {"a": 1, "b": [Fraction(1, 2)]}),
    ("a float array", np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])), ("an int64 array", np.array([1, -2, 2 ** 40], dtype=np.int64)),
    ("a complex array", np.array([[1 + 2j, 3j]])), ("a bool array", np.array([True, False])), ("a 3-d array", np.arange(24.0).reshape((2, 3, 4))),
    ("a 1-element array", np.array([2.5])), ("an int64 1x1 array", np.array([[7]], dtype=np.int64)),
]:
    # (a list of kinds Magma can't put in one sequence: refused there, CORR-695-3)
    roundtrip("Python " + label, v, "python", {"magma": Exception("universe")} if label == "a list" else None)
roundtrip("Python a list of integers and rationals", [1, Fraction(1, 3), [2]], "python", {"magma": Exception("universe")})
roundtrip("Python a list of an integer and a rational", [1, Fraction(1, 3)], "python", {"magma": {"t": "list", "v": [{"t": "rat", "v": "1"}, {"t": "rat", "v": "1/3"}]}})

# ---- Sage's
x, y = S.PolynomialRing(S.QQ, "x,y").gens()
t = S.PolynomialRing(S.ZZ, "t").gen()
u = S.PolynomialRing(S.QQ, "u").gen()
for label, v in [
    ("an Integer", S.Integer(2) ** 80), ("a Rational", S.QQ(22) / 7), ("an RDF", S.RDF(2.5)), ("a CDF", S.CDF(1, -1)),
    ("a matrix over ZZ", S.matrix(S.ZZ, [[1, 2], [3, 4]])), ("a matrix over QQ", S.matrix(S.QQ, [[S.QQ(1) / 2, 0], [3, -4]])),
    ("a matrix over RDF", S.matrix(S.RDF, [[1.5, 2], [3, 4]])), ("a matrix over CDF", S.matrix(S.CDF, [[1, S.CDF(0, 1)]])),
    ("a vector over QQ", S.vector(S.QQ, [1, S.QQ(2) / 3])), ("a vector over ZZ", S.vector([1, 2, 3])), ("a vector over RDF", S.vector(S.RDF, [1, 2])),
    ("a polynomial over QQ", u ** 3 - S.QQ(3) / 4 * u + 1), ("a polynomial over ZZ", 2 * t ** 3 - t - 7),
    ("a polynomial in two variables", x ** 2 - S.QQ(3) / 4 * y + x * y ** 3), ("the zero polynomial", u - u),
    ("a sparse polynomial in one variable", u ** 7 - S.QQ(1) / 3 * u ** 2 + 5),
]:
    roundtrip("Sage " + label, v, "sage")
# (a univariate polynomial's dict() is keyed by int exponents, as in Sage's)
v = _sbx.encode(u ** 7 - S.QQ(1) / 3 * u ** 2 + 5, "sage")
report(v == {"t": "poly", "ring": "QQ", "vars": ["u"], "v": "u^7 - 1/3*u^2 + 5"}, "Sage a univariate polynomial, term by term from dict(),", v)
v = _sbx.encode(2 * t ** 3 - t - 7, "sage")
report(v == {"t": "poly", "ring": "ZZ", "vars": ["t"], "v": "2*t^3 - t - 7"}, "Sage a univariate polynomial over ZZ,", v)
# a dense univariate polynomial costs its degree + 1 of the element budget
# (dict() scans every coefficient), however few its terms. Cheaply: u^10^4 + 1
# under a limit of 10^5 elements, lowered for the check only. One copy is
# carried; twenty references are refused after at most ten scans.
report(_sbx.LIMITS["elements"] == 10 ** 7, "the element limit is 10^7 by default,", _sbx.LIMITS["elements"])
big = u ** 10000 + 1
v = _sbx.encode(big, "sage")
report(v["v"] == "u^10000 + 1", "Sage u^10000 + 1, one of them,", v["v"])
scans = [0]
_dict = type(big).dict


def _counted(self):
    scans[0] += 1
    return _dict(self)


_limit = _sbx.LIMITS["elements"]
_sbx.LIMITS["elements"] = 10 ** 5
type(big).dict = _counted
try:
    refused("Sage twenty references to u^10000 + 1 under a limit of 10^5", [big] * 20, "sage", "more than 100000 elements")
finally:
    type(big).dict = _dict
    _sbx.LIMITS["elements"] = _limit
report(scans[0] <= 10, "twenty references to u^10000 + 1 refused after at most ten scans:", scans[0])
refused("Sage a symbolic expression", S.var("z") ** 2 + 1, "sage", "symbolic")
refused("Sage a matrix over the Symbolic Ring", S.matrix([[S.var("z"), 1]]), "sage", "Symbolic Ring")
refused("Sage a matrix over GF(7)", S.matrix(S.GF(7), [[1, 2]]), "sage", "Finite Field of size 7")
refused("Sage an element of GF(7)", S.GF(7)(3), "sage", "lift")

# ---- Magma's
R = M.PolynomialRing(M.Rationals())
M._assign_gen_names(R, ["w"])
w = R.gen()
for label, v in [
    ("an integer", 10 ** 20), ("a rational", S.QQ(5) / 3), ("a real a double holds", M.MReal.of(1.5)),
    ("a matrix over the integers", M.Matrix(M.Integers(), [[1, 2], [3, 4]])), ("a matrix over the rationals", M.Matrix(M.Rationals(), [[S.QQ(1) / 3, 1]])),
    ("a sequence", M.MSeq([1, 2, 3])), ("a polynomial", w ** 2 - 2),
    ("a matrix of reals", M.Matrix([[M.MReal.of(1.5), M.MReal.of(2)], [M.MReal.of(3), M.MReal.of(4)]])),
]:
    roundtrip("Magma " + label, v, "magma")
roundtrip("Magma a tuple", M.MTuple((1, "a")), "magma", {"magma": Exception("universe")})
refused("Magma a real of RealField(30) a double can't hold", M.MReal.of(S.QQ(1) / 3, 30), "magma", "RealField(15)")
refused("Magma a polynomial in an unnamed variable", M.PolynomialRing(M.Rationals()).gen(), "magma", "name the ring's variables")

# ---- MATLAB's (arrays stored with their axes reversed: [1 2 3; 4 5 6] is stored (3, 2))
A = L._box(np.ascontiguousarray(np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]).T))
for label, v in [
    ("a double", 2.5), ("a logical", False), ("a complex", complex(0, 1)), ("a 2x3 matrix", A),
    ("an int64 array", L._box(np.ascontiguousarray(np.array([[1, 2]], dtype=np.int64).T))),
    ("a char row", L.Char("hello")), ("a string", L.Str("hi")), ("a cell row", L.Cell([1.0, L.Char("a")], (1, 2))),
    ("a struct", L._struct1({"a": 1.0, "b": L.Char("x")})), ("a string array", L.StrArr(["a", "b"], (1, 2))),
]:
    roundtrip("MATLAB " + label, v, "matlab", {"magma": Exception("universe")} if label == "a cell row" else None)
e = _sbx.encode(A, "matlab")
report(e["shape"] == [2, 3] and e["v"] == [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], "MATLAB [1 2 3; 4 5 6] is sent as MATLAB shows it, 2 by 3, row-major:", json.dumps(e))
back = _sbx.decode({"t": "array", "dtype": "float64", "shape": [2, 3], "v": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]}, "matlab")
report(L.class_(back) == "double" and back.shape == (3, 2) and float(back[2, 0]) == 3.0 and float(back[0, 1]) == 4.0, "a 2 by 3 array into MATLAB: stored (3, 2), MATLAB's A(1,3) = 3 and A(2,1) = 4")
refused("MATLAB a char matrix", L._rows_char(["ab", "cd"]), "matlab", "cellstr")
refused("MATLAB a 2x2 cell", L.Cell([1.0, 2.0, 3.0, 4.0], (2, 2)), "matlab", "c(:)'")

# ---- what one language can't hold exactly: refused, unless asked for as a double
for label, data, target, words in [
    ("a rational into MATLAB", {"t": "rat", "v": "1/3"}, "matlab", '"as": "double"'),
    ("an integer past 2^53 into MATLAB", {"t": "int", "v": str(2 ** 53 + 1)}, "matlab", "2^53"),
    ("a matrix over QQ into MATLAB", {"t": "matrix", "ring": "QQ", "shape": [1, 1], "v": ["1/2"]}, "matlab", '"as": "double"'),
    ("a polynomial into MATLAB", {"t": "poly", "ring": "QQ", "vars": ["x"], "v": "x"}, "matlab", "coefficients"),
    ("a dict with a key MATLAB can't name", {"t": "dict", "v": [["2nd", {"t": "bool", "v": True}]]}, "matlab", "field name"),
    ("a complex into Magma", {"t": "complex", "re": 1.0, "im": 1.0}, "magma", "real and imaginary parts"),
    ("inf into Magma", {"t": "float", "v": "inf"}, "magma", "finite"),
    ("a polynomial in two variables into Magma", {"t": "poly", "ring": "QQ", "vars": ["x", "y"], "v": "x*y"}, "magma", "one variable"),
]:
    try:
        _sbx.decode(data, target)
        report(False, label, "was read")
    except _sbx.SbxError as err:
        report(words in str(err), label, "refused:", err)
# ---- Magma's sequences: one universe, exact coercions, or refused as Magma refuses (astra's CORR-695-3)
def seq(items):
    return _sbx.decode(_sbx.encode(items), "magma")
for label, items in [("an integer and a string", [1, "a"]), ("a bool and an integer", [True, 1]), ("an integer and a double", [1, 2.5]), ("a rational and a double", [Fraction(1, 2), 0.5]), ("sequences of an integer and of a string", [[1], ["a"]])]:
    try:
        seq(items)
        report(False, "Magma sequence of", label, "was made")
    except _sbx.SbxError as err:
        report("valid universe" in str(err), "Magma sequence of", label, "refused:", err)
a = seq([1, Fraction(1, 3)])
report([str(M.Type(z)) for z in a] == ["FldRatElt", "FldRatElt"], "[1, 1/3] in Magma: the integer coerced into Q, exactly:", [str(M.Type(z)) for z in a], list(a))
a = seq([[1, 2], [Fraction(1, 3)], []])
report([str(M.Type(z)) for z in a[0]] == ["FldRatElt", "FldRatElt"] and len(a[2]) == 0, "[[1, 2], [1/3], []] in Magma: the inner sequences in one universe, Q")
a = seq([2.5, 0.125])
report(all(isinstance(z, M.MReal) for z in a), "a sequence of doubles in Magma: reals")

# ---- each sequence keeps its universe, an empty one's too, as Magma does (astra's CORR-695-3 at 9b49a99f)
U = lambda q: str(M.Universe(q))
a = seq([[1, 2], [Fraction(1, 3)], []])
report([U(z) for z in a] == ["Rational Field"] * 3, "[[1, 2], [1/3], []]: each inner sequence's universe the Rational Field, the empty one's too:", [U(z) for z in a])
b = M.Append(a[2], 1)
report(str(M.Type(b[0])) == "FldRatElt" and U(b) == "Rational Field", "Append(the empty one, 1): a rational, FldRatElt, as Magma gives")
for ring, want, el in [("QQ", "Rational Field", "FldRatElt"), ("ZZ", "Integer Ring", "RngIntElt")]:
    z = _sbx.decode({"t": "matrix", "ring": ring, "shape": [0], "v": []}, "magma")
    zb = M.Append(z, 1)
    report(len(z) == 0 and U(z) == want and str(M.Type(zb[0])) == el, "an empty %s vector into Magma: its universe %s kept; Append(it, 1) is %s" % (ring, want, el))
z = _sbx.decode({"t": "array", "dtype": "int64", "shape": [0], "v": []}, "magma")
report(U(z) == "Integer Ring", "an empty int64 array into Magma: the Integer Ring")
try:
    M.Universe(_sbx.decode({"t": "list", "v": []}, "magma"))
    report(False, "[] in Magma has a universe")
except M.MagmaError as err:
    report("Illegal null sequence" in str(err), "[] in Magma: a null sequence, as Magma's [ ] is:", err)
for label, data in [("of reals", [[1.5], []]), ("of strings", [["a"], []]), ("of sequences", [[[1]], []])]:
    try:
        seq(data)
        report(False, "an empty sequence", label, "beside a full one was made")
    except _sbx.SbxError as err:
        report("can't keep that universe" in str(err), "an empty sequence", label, "beside a full one: refused:", err)
try:
    _sbx.decode({"t": "array", "dtype": "float64", "shape": [0], "v": []}, "magma")
    report(False, "an empty float64 array into Magma was made")
except _sbx.SbxError as err:
    report("can't keep that universe" in str(err), "an empty float64 array into Magma: refused:", err)

# ---- linear in the checked data: universes found once, bottom-up, each
# node built once (daybreak2's HARD-9B4-1).  A depth-32 nest: at its bottom
# 10^5 integers (32 lists deep, the most _check admits), beside another of one rational, so that every
# level unifies Z with Q and the integers are coerced into Q, once each.
import time
def nest(depth, inner):
    for _ in range(depth):
        inner = {"t": "list", "v": [inner]}
    return inner
N = 10 ** 5
ints = {"t": "list", "v": [{"t": "int", "v": str(k)} for k in range(N)]}
data = {"t": "list", "v": [nest(30, ints), nest(30, {"t": "list", "v": [{"t": "rat", "v": "1/3"}]})]}
nodes = N + 2 * 31 + 2


def flat_decode_time():
    # (the same N integers, flat, into Magma: no universe to unify, no
    # coercion; a measure of this machine's speed, taken in this process;
    # CPU time, so that waiting for a CPU another test holds doesn't count)
    t = time.process_time()
    _sbx.decode(ints, "magma")
    return time.process_time() - t


# (diagnostics, for CI's record, shard-7 proposal r1: each decode's window on
# the clock GC performance entries use, time.perf_counter() in pyjs, and its
# user and system CPU apart (pyjs's private _fs.cpu_times()); test/sbx.test.ts
# matches GC entries to them)
import _fs
windows = []


def timed(label, f):
    w0, c0 = time.perf_counter(), _fs.cpu_times()
    r = f()
    w1, c1 = time.perf_counter(), _fs.cpu_times()
    windows.append({"label": label, "start_ms": w0 * 1000, "end_ms": w1 * 1000, "user_s": c1[0] - c0[0], "system_s": c1[1] - c0[1]})
    return r


base = timed("flat before", flat_decode_time)
t0 = time.process_time()
a = timed("nested", lambda: _sbx.decode(data, "magma"))
took = time.process_time() - t0
work = _sbx._magma_work
base = (base + timed("flat after", flat_decode_time)) / 2
print("SBXDIAG " + json.dumps({"took_s": took, "base_s": base, "ratio": took / base, "windows": windows}))
inner = a[0]
for _ in range(30):
    inner = inner[0]
report(len(inner) == N and str(M.Type(inner[7])) == "FldRatElt" and inner[7] == 7, "a depth-32 nest of 10^5 integers beside one of a rational: the integers coerced into Q")
report(work <= 2 * nodes + 64, "its work linear: %d node visits for %d nodes (at most 2 x nodes + 64)" % (work, nodes))
# Its CPU time, two ways.  Relative: at most 25 times the flat decode of the
# same integers measured around it, so that a slower per-node step fails on
# any machine (on the test VMs the ratio is 10 to 11, and 10 to 12 with 4 or
# 8 copies sharing 2 CPUs, whose CPU times stay 5 to 6 s; the coercion into Q
# made 3 times as costly gives 29, 10 times 92).
# Absolute: a ceiling for a hang, 60 s scaled by SAGEBRUSH_TIME_SCALE as the
# other limits are.  (It was 60 s of wall-clock time: on GitHub's 4-CPU
# runners, where the test runner runs this beside catalog gate 3 and other
# tests, the decode took up to 62.6 s of wall-clock time, against 3.8 s on
# the test VMs.)
import os
limit = 60 * (float(os.environ.get("SAGEBRUSH_TIME_SCALE") or 1))
report(took <= 25 * base, "and at most 25 times the CPU time of the flat decode of its integers (here %.1f s, %.1f times %.2f s)" % (took, took / base, base))
report(took < limit, "and within %d s of CPU time (here %.1f s)" % (limit, took))
# (a list refused early: its first two elements already have no universe, the rest never visited)
bad = {"t": "list", "v": [{"t": "int", "v": "1"}, {"t": "str", "v": "a"}, ints]}
try:
    _sbx.decode(bad, "magma")
    report(False, "[1, \"a\", 10^5 integers] in Magma was made")
except _sbx.SbxError as err:
    report("valid universe" in str(err) and _sbx._magma_work <= 4, "[1, \"a\", 10^5 integers] refused after %d node visits:" % _sbx._magma_work, err)

# ---- empty matrices: their shape and parent kept, or refused (astra's CORR-695-2)
for data in [{"t": "matrix", "ring": "QQ", "shape": [0, 3], "v": []}, {"t": "matrix", "ring": "ZZ", "shape": [3, 0], "v": []}, {"t": "array", "dtype": "int64", "shape": [0, 3], "v": []}, {"t": "array", "dtype": "float64", "shape": [0, 0], "v": []}, {"t": "array", "dtype": "float64", "shape": [2, 0], "v": []}]:
    try:
        _sbx.decode(data, "magma")
        report(False, "an empty %s %s into Magma was made" % (data["t"], data["shape"]))
    except _sbx.SbxError as err:
        report("empty matrix" in str(err), "an empty %s %s into Magma: refused:" % (data["t"], data["shape"]), err)
    if data["t"] == "matrix" or data["dtype"] != "float64":
        got = _sbx.encode(_sbx.decode(data, "sage"), "sage")
        report(got["shape"] == data["shape"], "the same into Sage: its shape kept,", got["shape"])
    got = _sbx.encode(_sbx.decode(data, "matlab", as_="double"), "matlab")
    report(got.get("shape") == data["shape"], "the same into MATLAB (as doubles): its shape kept,", got.get("shape"))

v = _sbx.decode({"t": "rat", "v": "1/3"}, "matlab", as_="double")
report(type(v) is float and v == 1 / 3, "a rational into MATLAB as a double:", repr(v))
v = _sbx.decode({"t": "matrix", "ring": "QQ", "shape": [1, 2], "v": ["1/2", "3"]}, "matlab", as_="double")
report(L.class_(v) == "double" and v.shape == (2, 1) and float(v[0, 0]) == 0.5, "a matrix over QQ into MATLAB as doubles")
v = _sbx.decode({"t": "float", "v": 0.1}, "magma")
report(isinstance(v, M.MReal) and v.frac() == Fraction(0.1), "a double into Magma: exactly that double, in RealField(16)")
v = _sbx.decode({"t": "poly", "ring": "QQ", "vars": ["x", "y"], "v": "x^2 - 3/4*y"}, "sage")
report(str(v) == "x^2 - 3/4*y" and str(v.parent()) == "Multivariate Polynomial Ring in x, y over Rational Field", "a polynomial into Sage: its ring's element,", v)
v = _sbx.decode({"t": "poly", "ring": "ZZ", "vars": ["t"], "v": "2*t^3 - 1"}, "magma")
report(str(v) == "2*t^3 - 1" and M.Type(v) == "RngUPolElt", "a polynomial into Magma: a univariate polynomial named t,", v)
print("%d failed" % failed if failed else "all passed")
