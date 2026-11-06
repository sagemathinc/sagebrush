"""Generate lib/_cmap_data.py: matplotlib 3.11.1's colormaps, exactly.

    python3 test/cmap_data_gen.py lib/_cmap_data.py    (needs CPython with matplotlib 3.11.1)

matplotlib is the oracle, run as a black box: its colormaps' tables, segment
data and colors; nothing of its source.  Writes the module, with _FIX the
few entries where matplotlib's libm differs from the correctly rounded sin,
cos or cube, then checks that the module's tables equal matplotlib's bit for
bit, for every map and its reverse.  (test/colormaps.test.ts checks the same
in Sagebrush.)"""
import sys
import numpy as np
import matplotlib
from matplotlib import colormaps

assert matplotlib.__version__ == "3.11.1", matplotlib.__version__
OUT = sys.argv[1]
names = [n for n in colormaps if not n.endswith("_r")]
FORMULA = {"afmhot", "cubehelix", "flag", "gist_gray", "gist_grey", "gist_heat", "gist_yarg", "gist_yerg",
           "gnuplot", "gnuplot2", "ocean", "prism", "rainbow"}
DERIVED = {"twilight_shifted"}  # (twilight rotated by half and reversed)


def rgb(m):
    return [tuple(float(v) for v in c[:3]) for c in m(np.arange(m.N))]


def digits(v):
    r = repr(v)
    return 99 if "e" in r else len(r.split(".")[1])


listed_dec, listed_hex, listed_full, seg = {}, {}, {}, {}
for n in names:
    m = colormaps[n]
    kind = type(m).__name__
    if n in FORMULA or n in DERIVED:
        continue
    if kind == "LinearSegmentedColormap":
        sd = m._segmentdata
        seg[n] = tuple(tuple(tuple(float(v) for v in row) for row in sd[c]) for c in ("red", "green", "blue"))
        continue
    vals = [tuple(float(v) for v in c[:3]) for c in m.colors]
    flat = [v for c in vals for v in c]
    if all(round(v * 255) / 255 == v for v in flat):
        listed_hex[n] = " ".join("%02x%02x%02x" % tuple(round(v * 255) for v in c) for c in vals)
        continue
    d = max(digits(v) for v in flat)
    if d <= 7 and all(round(v * 10 ** d) / 10 ** d == v for v in flat):
        # (each channel's differences, the channels one after another)
        out = []
        for j in range(3):
            prev = 0
            for c in vals:
                k = round(c[j] * 10 ** d)
                out.append(k - prev)
                prev = k
        listed_dec[n] = (d, " ".join(str(k) for k in out))
        continue
    listed_full[n] = " ".join(repr(v) for v in flat)


def lit(x):
    return repr(x)


lines = ['"""matplotlib 3.11.1\'s colormaps, exactly: each one\'s table of N colors',
         "(256, or 510 for twilight), as matplotlib computes it, for",
         "_graphics.colormap and matplotlib.colors.Colormap.  Imported when a",
         "colormap is first drawn or looked up, not when a mode starts.  Generated",
         "from matplotlib 3.11.1 run as a black box (its tables, segment data and",
         'colors), and checked against it value for value."""',
         "import math", "",
         "# the names, in matplotlib.colormaps' order; each is there reversed too,",
         "# as name + \"_r\", after all of these (NAMES_ALL)",
         "NAMES = %r" % (tuple(names),),
         "NAMES_ALL = NAMES + tuple(n + \"_r\" for n in NAMES)",
         "KNOWN = frozenset(NAMES_ALL)", "",
         "# listed colors: decimals of D digits, as integers; each channel's differences in turn",
         "_DEC = {"]
for n, (d, s) in listed_dec.items():
    lines.append("    %r: (%d, %r)," % (n, d, s))
lines += ["}", "# listed colors that are bytes (RRGGBB)", "_HEX = {"]
for n, s in listed_hex.items():
    lines.append("    %r: %r," % (n, s))
lines += ["}", "# listed colors given in full", "_FULL = {"]
for n, s in listed_full.items():
    lines.append("    %r: %r," % (n, s))
lines += ["}", "# segment data: per channel, rows (x, value from the left, value to the right)", "_SEG = {"]
for n, t in seg.items():
    lines.append("    %r: %r," % (n, t))
lines += ["}", ""]
lines += r'''
_pi = math.pi
# sin, cos and cubes in double-double arithmetic (+, -, *, / only, each
# rounded the same in every engine), then rounded: the correctly rounded
# value, wherever this runs.  (math.sin differs between engines in the last
# bit.)  matplotlib's own values differ from these in a few entries (its
# libm's last bit): _FIX has them.
_SPLIT = 134217729.0


def _two_sum(a, b):
    s = a + b
    bb = s - a
    return s, (a - (s - bb)) + (b - bb)


def _two_prod(a, b):
    p = a * b
    c = _SPLIT * a
    ah = c - (c - a)
    al = a - ah
    c = _SPLIT * b
    bh = c - (c - b)
    bl = b - bh
    return p, ((ah * bh - p) + ah * bl + al * bh) + al * bl


def _add(a, b):
    s, e = _two_sum(a[0], b[0])
    t, f = _two_sum(a[1], b[1])
    e += t
    u = s + e
    e = e - (u - s) + f
    s = u + e
    return s, e - (s - u)


def _mul(a, b):
    p, e = _two_prod(a[0], b[0])
    e += a[0] * b[1] + a[1] * b[0]
    s = p + e
    return s, e - (s - p)


_P = (float.fromhex("0x1.921fb54400000p+0"), float.fromhex("0x1.0b4611a600000p-34"),
      float.fromhex("0x1.3198a2e037073p-69"), float.fromhex("0x1.b839a252049c1p-122"))
_INV = float.fromhex("0x1.45f306dc9c883p-1")  # 2/pi
_SINC = %SINC%  # (+-1/(2n+1)!, n = 0..13, as double-doubles)
_COSC = %COSC%  # (+-1/(2n)!, n = 0..13)


def _poly(r, z, coef):
    acc = coef[-1]
    for c in coef[-2::-1]:
        acc = _add(_mul(acc, z), c)
    return acc if r is None else _mul(acc, r)


def _sincos(x, cos):
    k = math.floor(x * _INV + 0.5)
    r = (x - k * _P[0], 0.0)
    r = _add(r, _two_prod(-k, _P[1]))
    r = _add(r, _two_prod(-k, _P[2]))
    r = _add(r, (-k * _P[3], 0.0))
    q = (int(k) + cos) % 4
    z = _mul(r, r)
    v = _poly(None, z, _COSC) if q % 2 else _poly(r, z, _SINC)
    return (v[0] + v[1]) * (1.0 if q < 2 else -1.0)


def _sin(x):
    return _sincos(x, 0)


def _cos(x):
    return _sincos(x, 1)


def _cube(x):
    v = _mul(_two_prod(x, x), (x, 0.0))
    return v[0] + v[1]


def _helix(p0, p1):
    # (D. A. Green's cubehelix, Bull. Astr. Soc. India 39 (2011) 289, with
    # gamma 1, s 0.5, r -1.5 and h 1)
    def f(x):
        a = x * (1 - x) / 2
        phi = 2 * _pi * (0.5 / 3 + -1.5 * x)
        return x + a * (p0 * _cos(phi) + p1 * _sin(phi))
    return f


def _g32(x):
    if x < 0.25:
        return 4 * x
    if x < 0.42:
        return 1.0
    if x < 0.92:
        return -2 * x + 1.84
    return x / 0.08 - 11.5


# gnuplot's rgbformulae (gnuplot's documentation, `help palette rgbformulae`)
_G = {3: lambda x: x, 5: _cube, 7: math.sqrt, 10: lambda x: _cos(x * _pi / 2),
      13: lambda x: _sin(x * _pi), 15: lambda x: _sin(x * 2 * _pi), 23: lambda x: 3 * x - 2,
      28: lambda x: abs((3 * x - 1) / 2), 30: lambda x: x / 0.32 - 0.78125, 31: lambda x: 2 * x - 0.84,
      32: _g32, 33: lambda x: abs(2 * x - 0.5), 34: lambda x: 2 * x, 35: lambda x: 2 * x - 0.5,
      36: lambda x: 2 * x - 1}
_FORMULA = {
    "afmhot": (_G[34], _G[35], _G[36]), "gnuplot": (_G[7], _G[5], _G[15]), "gnuplot2": (_G[30], _G[31], _G[32]),
    "ocean": (_G[23], _G[28], _G[3]), "rainbow": (_G[33], _G[13], _G[10]),
    "gist_gray": (_G[3],) * 3, "gist_grey": (_G[3],) * 3,
    "gist_heat": (lambda x: 1.5 * x, lambda x: 2 * x - 1, lambda x: 4 * x - 3),
    "gist_yarg": (lambda x: 1 - x,) * 3, "gist_yerg": (lambda x: 1 - x,) * 3,
    "flag": (lambda x: 0.75 * _sin((x * 31.5 + 0.25) * _pi) + 0.5, lambda x: _sin(x * 31.5 * _pi),
             lambda x: 0.75 * _sin((x * 31.5 - 0.25) * _pi) + 0.5),
    "prism": (lambda x: 0.75 * _sin((x * 20.9 + 0.25) * _pi) + 0.67,
              lambda x: 0.75 * _sin((x * 20.9 - 0.25) * _pi) + 0.33, lambda x: -1.1 * _sin((x * 20.9) * _pi)),
    "cubehelix": (_helix(-0.14861, 1.78277), _helix(-0.29227, -0.90649), _helix(1.97294, 0.0)),
}


def _grid(n):
    step = 1.0 / (n - 1)
    g = [i * step for i in range(n)]
    g[-1] = 1.0
    return g


def _clip(v):
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def _segment(rows, n):
    # (matplotlib's table: the x's and the grid scaled by n - 1; an entry on
    # a row's x takes the value from its left; the ends the outer values)
    xs = [r[0] * (n - 1) for r in rows]
    out = [rows[0][2]]
    k = 1
    for g in _grid(n)[1:-1]:
        g = (n - 1) * g
        while xs[k] < g:
            k += 1
        d = (g - xs[k - 1]) / (xs[k] - xs[k - 1])
        out.append(d * (rows[k][1] - rows[k - 1][2]) + rows[k - 1][2])
    out.append(rows[-1][1])
    return [_clip(v) for v in out]


_FIX = %FIX%  # (name: entries (index, channel, matplotlib's value))


def _fixed(name, t):
    for i, j, v in _FIX.get(name, ()):
        c = list(t[i])
        c[j] = v
        t[i] = tuple(c)
    return t


_made = {}


def table(name):
    """The colormap's N colors, (r, g, b) floats, for a name of matplotlib's
    (a "_r" suffix reverses); made the first time it is asked for."""
    t = _made.get(name)
    if t is not None:
        return t
    if name.endswith("_r") and name[:-2] in _SEG:
        # (reversed as matplotlib reverses one: its segment data, x to 1 - x)
        r, g, b = (_segment([(1 - x, y1, y0) for x, y0, y1 in rows[::-1]], 256) for rows in _SEG[name[:-2]])
        t = list(zip(r, g, b))
    elif name.endswith("_r") and name[:-2] in _FORMULA:
        g = _grid(256)
        t = [tuple(_clip(float(f(1 - x))) for f in _FORMULA[name[:-2]]) for x in g]
        t = _fixed(name, t)
    elif name.endswith("_r"):
        t = table(name[:-2])[::-1]
    elif name in _DEC:
        d, s = _DEC[name]
        scale, ks = 10 ** d, s.split()
        n = len(ks) // 3
        chans = []
        for j in range(3):
            k, col = 0, []
            for v in ks[j * n:(j + 1) * n]:
                k += int(v)
                col.append(k / scale)
            chans.append(col)
        t = list(zip(*chans))
    elif name in _HEX:
        t = [tuple(int(h[j:j + 2], 16) / 255 for j in (0, 2, 4)) for h in _HEX[name].split()]
    elif name in _FULL:
        vals = [float(v) for v in _FULL[name].split()]
        t = [tuple(vals[i:i + 3]) for i in range(0, len(vals), 3)]
    elif name in _SEG:
        r, g, b = (_segment(rows, 256) for rows in _SEG[name])
        t = list(zip(r, g, b))
    elif name in _FORMULA:
        g = _grid(256)
        t = [tuple(_clip(float(f(x))) for f in _FORMULA[name]) for x in g]
        t = _fixed(name, t)
    elif name == "twilight_shifted":
        tw = table("twilight")
        n = len(tw) // 2
        t = (tw[n:] + tw[:n])[::-1]
    else:
        raise KeyError(name)
    _made[name] = t
    return t
'''.split("\n")
from fractions import Fraction
from math import factorial


def ddc(fr):
    hi = float(fr)
    return (hi, float(fr - Fraction(hi)))


SINC = tuple(ddc(Fraction((-1) ** n, factorial(2 * n + 1))) for n in range(14))
COSC = tuple(ddc(Fraction((-1) ** n, factorial(2 * n))) for n in range(14))
text = "\n".join(lines).rstrip("\n") + "\n"
text = text.replace("%SINC%", repr(SINC)).replace("%COSC%", repr(COSC))
ns0 = {}
exec(compile(text.replace("%FIX%", "{}"), OUT, "exec"), ns0)
fix = {}
for n in sorted(FORMULA):
    for nn in (n, n + "_r"):
        mine, want = ns0["table"](nn), rgb(colormaps[nn])
        d = [(i, j, want[i][j]) for i in range(len(want)) for j in range(3) if mine[i][j] != want[i][j]]
        if d:
            fix[nn] = tuple(d)
print("fixes:", {k: len(v) for k, v in fix.items()})
open(OUT, "w").write(text.replace("%FIX%", repr(fix)))

# the check: every map and its reverse, against the oracle
ns = {}
exec(compile(open(OUT).read(), OUT, "exec"), ns)
bad = []
for n in names + [n + "_r" for n in names]:
    m = colormaps[n]
    if ns["table"](n) != rgb(m):
        bad.append(n)
print("maps checked:", 2 * len(names), "differ:", bad)
src = open(OUT).read()
import gzip
print("module bytes:", len(src.encode("latin-1")), "gzip:", len(gzip.compress(src.encode("latin-1"), 9)))
print("kinds: dec", len(listed_dec), "hex", len(listed_hex), "full", len(listed_full), "seg", len(seg), "formula", len(FORMULA), "derived", len(DERIVED))
