"""Graphics for sagebrush: composable primitives that keep their data,
rendered to SVG.

This is the engine under both plotting APIs: Sage's (``plot``, ``point``,
``line``, ... in ``sage_all``) and ``matplotlib.pyplot``.  A figure is a list
of panels (axes); a panel is a list of primitives plus options.  The SVG is
plain text, deterministic, and self-describing:

- every panel carries its data ranges and pixel box (``data-*`` attributes),
  so a browser can show coordinates under the mouse;
- the figure has a text description (``role="img"`` and ``aria-label``),
  for screen readers and for agents that cannot see the picture;
- text and axes use ``currentColor``, so a plot follows a page's light or
  dark theme (saved files render it as black).
"""

import math

# ------------------------------------------------------------------ colors

TAB10 = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
         "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"]
_BASE = {"b": "#0000ff", "g": "#008000", "r": "#ff0000", "c": "#00bfbf",
         "m": "#bf00bf", "y": "#bfbf00", "k": "#000000", "w": "#ffffff"}
_TAB = {"tab:" + n: c for n, c in zip(
    ["blue", "orange", "green", "red", "purple", "brown", "pink", "gray", "olive", "cyan"], TAB10)}
_VIRIDIS = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e",
            "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"]


def to_color(c, default=None):
    """A CSS color from a name, hex string, matplotlib code or RGB(A) tuple."""
    if c is None or c == "automatic":
        return default
    if isinstance(c, str):
        if c in _BASE:
            return _BASE[c]
        if len(c) == 2 and c[0] == "C" and c[1].isdigit():
            return TAB10[int(c[1])]
        if c in _TAB:
            return _TAB[c]
        try:  # a grayscale level, as in matplotlib: "0.5"
            v = float(c)
            if 0 <= v <= 1:
                g = round(v * 255)
                return "#%02x%02x%02x" % (g, g, g)
        except ValueError:
            pass
        return c
    if isinstance(c, (tuple, list)) and len(c) in (3, 4):
        r, g, b = (max(0, min(255, round(float(v) * 255))) for v in c[:3])
        return "#%02x%02x%02x" % (r, g, b)
    return str(c)


_CMAPS = {
    "viridis": _VIRIDIS,
    "coolwarm": ["#3b4cc0", "#6788ee", "#9abbff", "#c9d7f0", "#edd1c2", "#f7a889", "#e26952", "#b40426"],
    "jet": ["#00007f", "#0000ff", "#007fff", "#00ffff", "#7fff7f", "#ffff00", "#ff7f00", "#ff0000", "#7f0000"],
    "hot": ["#0b0000", "#4c0000", "#8f0000", "#d10000", "#ff1500", "#ff5800", "#ff9b00", "#ffdd00", "#ffff3f", "#ffffff"],
    "rainbow": ["#7f00ff", "#3f61fa", "#00b4eb", "#40ecd3", "#80feb3", "#c0eb8d", "#ffb360", "#ff6130", "#ff0000"],
    "plasma": ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"],
    "Blues": ["#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"],
    "Spectral": ["#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2"],
    "RdBu": ["#67001f", "#b2182b", "#d6604d", "#f4a582", "#fddbc7", "#d1e5f0", "#92c5de", "#4393c3", "#2166ac", "#053061"],
}


def colormap(t, name="viridis"):
    """The color at t in [0, 1] of a colormap: viridis, gray, coolwarm, jet,
    hot, rainbow, plasma, Blues, Spectral, RdBu (a "_r" suffix reverses)."""
    t = 0.0 if t != t else max(0.0, min(1.0, t))
    if not isinstance(name, str) and hasattr(name, "_color"):  # a matplotlib.colors colormap
        return name._color(t)
    name = name if isinstance(name, str) else "viridis"
    if name.endswith("_r"):
        name, t = name[:-2], 1 - t
    if name in ("gray", "grey", "Greys_r", "binary_r"):
        g = round(t * 255)
        return "#%02x%02x%02x" % (g, g, g)
    if name in ("Greys", "binary"):
        g = round((1 - t) * 255)
        return "#%02x%02x%02x" % (g, g, g)
    stops = _CMAPS.get(name, _VIRIDIS)
    x = t * (len(stops) - 1)
    i = min(int(x), len(stops) - 2)
    f = x - i
    a, b = stops[i], stops[i + 1]
    mix = [round(int(a[k:k + 2], 16) * (1 - f) + int(b[k:k + 2], 16) * f) for k in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(mix)


DASHES = {"-": None, "solid": None, "--": "6,4", "dashed": "6,4", ":": "1.5,3",
          "dotted": "1.5,3", "-.": "6,3,1.5,3", "dashdot": "6,3,1.5,3", "": None, "None": None}


# ------------------------------------------------------------------ numbers

def _finite(v):
    try:
        v = float(v)
    except (TypeError, ValueError, OverflowError):
        return None
    if v != v or v in (math.inf, -math.inf):
        return None
    return v


def _fmt(v):
    """Coordinates in the SVG: two decimals, no trailing zeros."""
    s = "%.2f" % v
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# ------------------------------------------------------------ math in text

_TEX_SYMBOLS = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ϵ", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
    "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
    "varpi": "ϖ", "rho": "ρ", "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "ϕ",
    "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ",
    "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
    "pm": "±", "mp": "∓", "times": "×", "cdot": "·", "div": "÷", "infty": "∞", "partial": "∂", "nabla": "∇",
    "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠", "approx": "≈", "sim": "∼", "simeq": "≃",
    "equiv": "≡", "propto": "∝", "langle": "⟨", "rangle": "⟩", "prime": "′", "circ": "∘", "degree": "°",
    "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "in": "∈", "sum": "∑", "prod": "∏", "int": "∫",
    "oint": "∮", "sqrt": "√", "ell": "ℓ", "hbar": "ℏ", "Re": "ℜ", "Im": "ℑ", "ldots": "…", "cdots": "⋯", "dots": "…",
    "%": "%", "$": "$", "{": "{", "}": "}", "_": "_", "#": "#", "&": "&", ",": "\u2009", ";": "\u2005", ":": "\u2005",
    "!": "", " ": " ", "quad": "\u2003", "qquad": "\u2003\u2003", "log": "log", "ln": "ln", "exp": "exp",
    "sin": "sin", "cos": "cos", "tan": "tan", "max": "max", "min": "min", "lim": "lim", "det": "det",
}
_TEX_FUNCS = {"log", "ln", "exp", "sin", "cos", "tan", "max", "min", "lim", "det"}


def _tex_tokens(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\":
            j = i + 1
            if j < len(s) and s[j].isalpha():
                while j < len(s) and s[j].isalpha():
                    j += 1
                out.append(s[i:j])
                i = j
            else:
                out.append(s[i:i + 2])
                i += 2
        else:
            out.append(c)
            i += 1
    return out


def _tex_svg(tex):
    """A TeX math string (matplotlib's mathtext subset) as SVG tspans:
    italic letters, symbols, sub- and superscripts, \\overline, \\mathrm,
    \\mathbf, \\frac and \\sqrt (inline)."""
    toks = _tex_tokens(tex)
    pos = [0]

    def group():
        # the next argument: {...} or one token
        if pos[0] >= len(toks):
            return []
        t = toks[pos[0]]
        pos[0] += 1
        if t != "{":
            return [t]
        depth, start = 1, pos[0]
        while pos[0] < len(toks) and depth:
            if toks[pos[0]] == "{":
                depth += 1
            elif toks[pos[0]] == "}":
                depth -= 1
            pos[0] += 1
        return toks[start:pos[0] - 1]

    def render(ts, style):
        sub = list(ts)
        save = pos[0]
        nonlocal_toks = toks[:]
        toks[:] = sub
        pos[0] = 0
        out = run(style)
        toks[:] = nonlocal_toks
        pos[0] = save
        return out

    def piece(text, style):
        if not text:
            return ""
        attrs = ""
        if style.get("it"):
            attrs += ' font-style="italic"'
        if style.get("bf"):
            attrs += ' font-weight="bold"'
        if style.get("over"):
            attrs += ' text-decoration="overline"'
        return "<tspan%s>%s</tspan>" % (attrs, _esc(text)) if attrs else _esc(text)

    def run(style):
        out = []
        while pos[0] < len(toks):
            t = toks[pos[0]]
            pos[0] += 1
            if t in ("^", "_"):
                arg = group()
                up = t == "^"
                inner = render(arg, style)
                # (the shift in the script's own size, back in the base size)
                out.append('<tspan font-size="70%%" dy="%s">%s</tspan><tspan dy="%s">\u200b</tspan>' % (
                    "-0.55em" if up else "0.35em", inner, "0.385em" if up else "-0.245em"))
            elif t == "{":
                pos[0] -= 1
                out.append(render(group(), style))
            elif t == "}":
                continue
            elif t == "~":
                out.append("\u00a0")
            elif t.isspace():
                continue
            elif t.startswith("\\"):
                name = t[1:]
                if name in ("mathrm", "rm", "text", "textrm", "operatorname", "mathsf"):
                    out.append(render(group(), dict(style, it=False)))
                elif name in ("mathbf", "bf", "textbf", "boldsymbol"):
                    out.append(render(group(), dict(style, bf=True)))
                elif name in ("mathit", "textit", "it"):
                    out.append(render(group(), dict(style, it=True)))
                elif name in ("overline", "bar", "widebar"):
                    out.append(render(group(), dict(style, over=True)))
                elif name in ("hat", "widehat", "tilde", "widetilde", "vec", "dot", "ddot"):
                    mark = {"hat": "\u0302", "widehat": "\u0302", "tilde": "\u0303", "widetilde": "\u0303",
                            "vec": "\u20d7", "dot": "\u0307", "ddot": "\u0308"}[name]
                    out.append(render(group(), style) + mark)
                elif name == "frac":
                    a, b = render(group(), style), render(group(), style)
                    out.append("%s/%s" % (a, b))
                elif name == "sqrt":
                    out.append("√(" + render(group(), style) + ")")
                elif name in ("left", "right", "big", "Big", "bigg", "Bigg", "displaystyle", "textstyle", "limits"):
                    continue
                elif name in _TEX_FUNCS:
                    out.append(piece(name, dict(style, it=False)))
                elif name in ("leq", "le", "geq", "ge", "neq", "ne", "approx", "sim", "simeq", "equiv", "propto", "to", "rightarrow", "in"):
                    out.append("\u2004%s\u2004" % _TEX_SYMBOLS[name])
                elif name in ("pm", "mp", "times", "cdot", "div"):
                    out.append("\u2005%s\u2005" % _TEX_SYMBOLS[name])
                elif name in _TEX_SYMBOLS:
                    out.append(piece(_TEX_SYMBOLS[name], dict(style, it=style.get("it") and name[:1].islower() and name in (
                        "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota",
                        "kappa", "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi",
                        "psi", "omega"))))
                else:
                    out.append(piece(name, style))
            elif t in "=<>":
                out.append("\u2004%s\u2004" % _esc(t))  # (relations: spaced, as in TeX)
            elif t in "+-" and out and not out[-1].endswith(("(", "[", "\u2004", "\u2005")):
                out.append("\u2005%s\u2005" % ("\u2212" if t == "-" else t))  # (binary operators)
            elif t == "-":
                out.append("\u2212")
            else:
                out.append(piece(t, dict(style, it=style.get("it") and t.isalpha())))
        return "".join(out)

    return run({"it": True})


def _rich(s):
    """Text for SVG, its $...$ parts typeset (as matplotlib does)."""
    s = str(s)
    if "$" not in s:
        return _esc(s)
    parts, out, i = [], [], 0
    # split on unescaped $
    buf, math = "", False
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s) and s[i + 1] == "$":
            buf += "$" if not math else "\\$"
            i += 2
            continue
        if c == "$":
            parts.append((buf, math))
            buf, math = "", not math
        else:
            buf += c
        i += 1
    if math:  # an unbalanced $: plain text
        return _esc(s)
    parts.append((buf, False))
    for text, m in parts:
        out.append(_tex_svg(text) if m else _esc(text))
    return "".join(out)


def _num(v, step=None):
    """A tick label: as short as the tick spacing allows."""
    if v == 0:
        return "0"
    a = abs(v)
    if a >= 1e6 or a < 1e-4:
        s = "%.3g" % v
        m, _, ex = s.partition("e")
        return m + "e" + str(int(ex)) if ex else s
    if step is not None and step > 0:
        d = 0  # as many decimals as the step needs (0.25 -> 2)
        while d < 12 and abs(step * 10 ** d - round(step * 10 ** d)) > 1e-6 * step * 10 ** d:
            d += 1
        s = "%.*f" % (d, v)
    else:
        s = "%.6g" % v
    if "." in s and "e" not in s:
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def nice_ticks(lo, hi, target=6):
    """Round tick positions covering [lo, hi], about `target` of them."""
    if hi <= lo:
        return [lo], 1.0
    raw = (hi - lo) / target
    mag = 10 ** math.floor(math.log10(raw))
    step = mag
    for m in (1, 2, 2.5, 5, 10):
        if m * mag >= raw:
            step = m * mag
            break
    first = math.ceil(lo / step - 1e-9)
    ticks = []
    k = first
    while k * step <= hi + step * 1e-9:
        ticks.append(round(k * step, 12))
        k += 1
    return ticks, step


# ------------------------------------------------------------------ primitives

class Primitive:
    """A drawable with data coordinates and options."""
    kind = "primitive"

    def __init__(self, **options):
        self.options = options

    def bbox(self):  # (xmin, xmax, ymin, ymax) of finite data, or None
        return None

    def legend(self):
        return self.options.get("legend_label") or self.options.get("label")

    def __repr__(self):
        return "%s defined by %d points" % (type(self).__name__, len(getattr(self, "xs", ())))


def _bbox(xs, ys):
    fx = [x for x, y in zip(xs, ys) if x is not None and y is not None]
    fy = [y for x, y in zip(xs, ys) if x is not None and y is not None]
    if not fx:
        return None
    return (min(fx), max(fx), min(fy), max(fy))


def _coords(points):
    xs, ys = [], []
    for p in points:
        if p is None:
            xs.append(None)
            ys.append(None)
            continue
        x, y = p
        xs.append(_finite(x))
        ys.append(_finite(y))
    return xs, ys


class Line(Primitive):
    """A polyline; None entries (or non-finite values) break it into pieces."""
    kind = "line"

    def __init__(self, xs, ys, **options):
        super().__init__(**options)
        self.xs = [_finite(x) for x in xs]
        self.ys = [_finite(y) for y in ys]

    def bbox(self):
        return _bbox(self.xs, self.ys)

    def svg(self, P):
        o = self.options
        parts, pen = [], False
        for x, y in zip(self.xs, self.ys):
            p = P.map(x, y)
            if p is None:
                pen = False
                continue
            parts.append(("L" if pen else "M") + _fmt(p[0]) + " " + _fmt(p[1]))
            pen = True
        color = to_color(o.get("color"), "#1f77b4")
        out = ""
        if parts:
            dash = DASHES.get(o.get("linestyle", "-"), None)
            out = '<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linejoin="round" stroke-linecap="round"%s%s/>' % (
                "".join(parts), _esc(color), _fmt(o.get("thickness", 1.5)),
                ' stroke-dasharray="%s"' % dash if dash else "",
                ' stroke-opacity="%s"' % _fmt(o["alpha"]) if o.get("alpha") is not None else "")
        if o.get("marker"):
            out += _markers(P, self.xs, self.ys, o.get("marker"), o.get("markersize", 3.5), color, o.get("alpha"))
        return out

    def describe(self):
        n = sum(1 for x, y in zip(self.xs, self.ys) if x is not None and y is not None)
        return "line%s through %d points" % (_label(self), n)


class Points(Primitive):
    kind = "points"

    def __init__(self, xs, ys, **options):
        super().__init__(**options)
        self.xs = [_finite(x) for x in xs]
        self.ys = [_finite(y) for y in ys]

    def bbox(self):
        return _bbox(self.xs, self.ys)

    def svg(self, P):
        o = self.options
        return _markers(P, self.xs, self.ys, o.get("marker", "o"), o.get("size", 3.5),
                        o.get("colors") or to_color(o.get("color"), "#1f77b4"), o.get("alpha"),
                        o.get("sizes"), to_color(o.get("edgecolor")))

    def describe(self):
        n = len(self.xs)
        return "%d point%s%s" % (n, "" if n == 1 else "s", _label(self))


def _markers(P, xs, ys, marker, r, color, alpha, sizes=None, edge=None):
    out = []
    many = isinstance(color, list)
    for i, (x, y) in enumerate(zip(xs, ys)):
        p = P.map(x, y)
        if p is None:
            continue
        px, py = p
        rr = sizes[i] if sizes is not None else r
        c = color[i % len(color)] if many else color
        out.append(_marker(marker, px, py, rr, c, edge))
    if not out:
        return ""
    a = ' opacity="%s"' % _fmt(alpha) if alpha is not None else ""
    return "<g%s>%s</g>" % (a, "".join(out))


def _marker(m, x, y, r, color, edge=None):
    c = _esc(color)
    st = ' stroke="%s" stroke-width="0.8"' % _esc(edge) if edge else ""
    X, Y, R = _fmt(x), _fmt(y), _fmt(r)
    if m in ("o", ".", None, True, "circle"):
        if m == ".":
            R = _fmt(max(1.0, r * 0.45))
        return '<circle cx="%s" cy="%s" r="%s" fill="%s"%s/>' % (X, Y, R, c, st)
    if m in ("s", "square"):
        return '<rect x="%s" y="%s" width="%s" height="%s" fill="%s"%s/>' % (
            _fmt(x - r), _fmt(y - r), _fmt(2 * r), _fmt(2 * r), c, st)
    if m in ("_", "|"):
        d = "M%s %sH%s" % (_fmt(x - r), Y, _fmt(x + r)) if m == "_" else "M%s %sV%s" % (X, _fmt(y - r), _fmt(y + r))
        return '<path d="%s" stroke="%s" stroke-width="1.2" fill="none"/>' % (d, c)
    if m in ("+", "x"):
        if m == "+":
            d = "M%s %sH%sM%s %sV%s" % (_fmt(x - r), Y, _fmt(x + r), X, _fmt(y - r), _fmt(y + r))
        else:
            d = "M%s %sL%s %sM%s %sL%s %s" % (_fmt(x - r), _fmt(y - r), _fmt(x + r), _fmt(y + r),
                                            _fmt(x - r), _fmt(y + r), _fmt(x + r), _fmt(y - r))
        return '<path d="%s" stroke="%s" stroke-width="1.5" fill="none"/>' % (d, c)
    shapes = {"^": [(0, -1.2), (1.05, 0.6), (-1.05, 0.6)], "v": [(0, 1.2), (1.05, -0.6), (-1.05, -0.6)],
              "D": [(0, -1.2), (1.2, 0), (0, 1.2), (-1.2, 0)], "d": [(0, -1.2), (0.8, 0), (0, 1.2), (-0.8, 0)],
              "<": [(-1.2, 0), (0.6, -1.05), (0.6, 1.05)], ">": [(1.2, 0), (-0.6, -1.05), (-0.6, 1.05)]}
    if m == "*":
        pts = []
        for k in range(10):
            a = math.pi / 2 + k * math.pi / 5
            rad = 1.4 if k % 2 == 0 else 0.6
            pts.append((rad * math.cos(a), -rad * math.sin(a)))
    else:
        pts = shapes.get(m, shapes["D"])
    d = "M" + "L".join("%s %s" % (_fmt(x + r * a), _fmt(y + r * b)) for a, b in pts) + "Z"
    return '<path d="%s" fill="%s"%s/>' % (d, c, st)


class Polygon(Primitive):
    kind = "polygon"

    def __init__(self, xs, ys, **options):
        super().__init__(**options)
        self.xs = [_finite(x) for x in xs]
        self.ys = [_finite(y) for y in ys]

    def bbox(self):
        return _bbox(self.xs, self.ys)

    def svg(self, P):
        o = self.options
        pts = [P.map(x, y) for x, y in zip(self.xs, self.ys)]
        pts = [p for p in pts if p is not None]
        if len(pts) < 2:
            return ""
        d = "M" + "L".join(_fmt(x) + " " + _fmt(y) for x, y in pts) + "Z"
        fill = to_color(o.get("color"), "#1f77b4") if o.get("fill", True) else "none"
        edge = to_color(o.get("edgecolor"))
        a = o.get("alpha")
        return '<path d="%s" fill="%s"%s%s/>' % (
            d, _esc(fill), ' fill-opacity="%s"' % _fmt(a) if a is not None else "",
            ' stroke="%s" stroke-width="%s"' % (_esc(edge), _fmt(o.get("thickness", 1))) if edge else "")

    def describe(self):
        return "filled region%s" % _label(self)


class Rects(Primitive):
    """Bars: (x, y, width, height) in data coordinates."""
    kind = "bars"

    def __init__(self, rects, **options):
        super().__init__(**options)
        self.rects = [tuple(float(v) for v in r) for r in rects]

    def bbox(self):
        if not self.rects:
            return None
        xs = [r[0] for r in self.rects] + [r[0] + r[2] for r in self.rects]
        ys = [r[1] for r in self.rects] + [r[1] + r[3] for r in self.rects]
        return (min(xs), max(xs), min(ys), max(ys))

    def svg(self, P):
        o = self.options
        colors = o.get("colors")
        fill = to_color(o.get("color"), "#1f77b4")
        edge = to_color(o.get("edgecolor"))
        out = []
        for i, (x, y, w, h) in enumerate(self.rects):
            if P.ylog and y <= 0:  # a bar from 0 on a log axis starts at the bottom
                h, y = y + h - P.ylo, P.ylo
            if P.xlog and x <= 0:
                w, x = x + w - P.xlo, P.xlo
            a, b = P.map(x, y, clamp=True), P.map(x + w, y + h, clamp=True)
            if a is None or b is None:
                continue
            c = colors[i % len(colors)] if colors else fill
            out.append('<rect x="%s" y="%s" width="%s" height="%s" fill="%s"%s/>' % (
                _fmt(min(a[0], b[0])), _fmt(min(a[1], b[1])), _fmt(abs(b[0] - a[0])), _fmt(abs(b[1] - a[1])), _esc(c),
                ' stroke="%s" stroke-width="0.8"' % _esc(edge) if edge else ""))
        a = o.get("alpha")
        return "<g%s>%s</g>" % (' opacity="%s"' % _fmt(a) if a is not None else "", "".join(out))

    def describe(self):
        return "%d bars%s" % (len(self.rects), _label(self))


class Patches(Primitive):
    """Many filled polygons, each with its own color (contour and density
    plots).  Polygons of one color are drawn as one path."""
    kind = "patches"

    def __init__(self, polys, colors, **options):
        super().__init__(**options)
        self.polys = polys      # [[(x, y), ...], ...] in data coordinates
        self.colors = colors    # a CSS color per polygon

    def bbox(self):
        b = self.options.get("bbox")
        if b is not None:
            return b
        pts = [q for poly in self.polys for q in poly]
        if not pts:
            return None
        return (min(q[0] for q in pts), max(q[0] for q in pts), min(q[1] for q in pts), max(q[1] for q in pts))

    def svg(self, P):
        groups = {}
        for poly, c in zip(self.polys, self.colors):
            pts = [P.map(x, y) for x, y in poly]
            if any(p is None for p in pts) or len(pts) < 3:
                continue
            groups.setdefault(c, []).append("M" + "L".join(_fmt(x) + " " + _fmt(y) for x, y in pts) + "Z")
        a = self.options.get("alpha")
        out = []
        for c in sorted(groups):
            out.append('<path d="%s" fill="%s" stroke="%s" stroke-width="0.5" stroke-linejoin="round"/>' % (
                "".join(groups[c]), _esc(c), _esc(c)))
        return "<g%s>%s</g>" % (' opacity="%s"' % _fmt(a) if a is not None else "", "".join(out))

    def describe(self):
        return self.options.get("what") or "%d colored regions" % len(self.polys)


class Segments(Primitive):
    """Many short segments (slope fields), with arrowheads (vector fields)."""
    kind = "segments"

    def __init__(self, segs, **options):
        super().__init__(**options)
        self.segs = segs        # [((x0, y0), (x1, y1)), ...]

    def bbox(self):
        b = self.options.get("bbox")
        if b is not None:
            return b
        pts = [q for s in self.segs for q in s]
        if not pts:
            return None
        return (min(q[0] for q in pts), max(q[0] for q in pts), min(q[1] for q in pts), max(q[1] for q in pts))

    def svg(self, P):
        o = self.options
        color = to_color(o.get("color"), "#1f77b4")
        colors = o.get("colors")
        heads = o.get("heads", False)
        by = {}
        for i, (a, b) in enumerate(self.segs):
            pa, pb = P.map(*a), P.map(*b)
            if pa is None or pb is None:
                continue
            c = colors[i] if colors else color
            d = by.setdefault(c, [[], []])
            d[0].append("M%s %sL%s %s" % (_fmt(pa[0]), _fmt(pa[1]), _fmt(pb[0]), _fmt(pb[1])))
            if heads:
                dx, dy = pb[0] - pa[0], pb[1] - pa[1]
                L = math.hypot(dx, dy)
                if L > 0.5:
                    h = min(6.0, 0.4 * L)
                    ux, uy = dx / L, dy / L
                    bx, by_ = pb[0] - ux * h, pb[1] - uy * h
                    d[1].append("M%s %sL%s %sL%s %sZ" % (_fmt(pb[0]), _fmt(pb[1]), _fmt(bx - uy * h * 0.45), _fmt(by_ + ux * h * 0.45),
                                                       _fmt(bx + uy * h * 0.45), _fmt(by_ - ux * h * 0.45)))
        out = []
        for c in sorted(by):
            lines, hs = by[c]
            out.append('<path d="%s" stroke="%s" stroke-width="%s" stroke-linecap="round" fill="none"/>' % (
                "".join(lines), _esc(c), _fmt(o.get("thickness", 1.2))))
            if hs:
                out.append('<path d="%s" fill="%s"/>' % ("".join(hs), _esc(c)))
        return "<g>%s</g>" % "".join(out)

    def describe(self):
        return self.options.get("what") or "%d segments" % len(self.segs)


class Text(Primitive):
    kind = "text"

    def __init__(self, string, x, y, **options):
        super().__init__(**options)
        self.string, self.x, self.y = str(string), _finite(x), _finite(y)

    def bbox(self):
        if self.x is None or self.y is None or self.options.get("no_bbox"):
            return None
        return (self.x, self.x, self.y, self.y)

    def legend(self):
        return None

    def svg(self, P):
        p = P.map(self.x, self.y, clamp=False)
        if p is None:
            return ""
        o = self.options
        anchor = {"left": "start", "right": "end", "center": "middle"}.get(o.get("horizontal_alignment", "center"), "middle")
        base = {"top": "hanging", "bottom": "auto", "center": "middle", "baseline": "auto"}.get(o.get("vertical_alignment", "center"), "middle")
        color = to_color(o.get("color"))
        rot = o.get("rotation", 0)
        return '<text x="%s" y="%s" font-size="%s" text-anchor="%s" dominant-baseline="%s"%s%s>%s</text>' % (
            _fmt(p[0]), _fmt(p[1]), _fmt(o.get("fontsize", 11)), anchor, base,
            ' fill="%s"' % _esc(color) if color else "",
            ' transform="rotate(%s %s %s)"' % (_fmt(-float(rot)), _fmt(p[0]), _fmt(p[1])) if rot else "",
            _rich(self.string))

    def describe(self):
        return 'text "%s"' % self.string


class Arrow(Primitive):
    kind = "arrow"

    def __init__(self, tail, head, **options):
        super().__init__(**options)
        self.tail = (_finite(tail[0]), _finite(tail[1]))
        self.head = (_finite(head[0]), _finite(head[1]))

    def bbox(self):
        return _bbox([self.tail[0], self.head[0]], [self.tail[1], self.head[1]])

    def svg(self, P):
        a, b = P.map(*self.tail, clamp=False), P.map(*self.head, clamp=False)
        if a is None or b is None:
            return ""
        o = self.options
        c = _esc(to_color(o.get("color"), "currentColor"))
        w = float(o.get("thickness", 1.5))
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        ux, uy = dx / L, dy / L
        hl, hw = 4 + 3 * w, 2 + 1.6 * w
        bx, by = b[0] - ux * hl, b[1] - uy * hl
        head = "M%s %sL%s %sL%s %sZ" % (_fmt(b[0]), _fmt(b[1]), _fmt(bx - uy * hw), _fmt(by + ux * hw), _fmt(bx + uy * hw), _fmt(by - ux * hw))
        return '<path d="M%s %sL%s %s" stroke="%s" stroke-width="%s"/><path d="%s" fill="%s"/>' % (
            _fmt(a[0]), _fmt(a[1]), _fmt(bx), _fmt(by), c, _fmt(w), head, c)

    def describe(self):
        return "arrow from (%s, %s) to (%s, %s)" % (_num(self.tail[0]), _num(self.tail[1]), _num(self.head[0]), _num(self.head[1]))


class Image(Primitive):
    """A raster picture (a data: URL) over the data box [x0, x1] x [y0, y1]:
    contourf's and imshow's large grids, one <image> rather than a rectangle
    per cell."""
    kind = "image"

    def __init__(self, href, x0, x1, y0, y1, **options):
        super().__init__(**options)
        self.href, self.x0, self.x1, self.y0, self.y1 = href, float(x0), float(x1), float(y0), float(y1)

    def bbox(self):
        return (min(self.x0, self.x1), max(self.x0, self.x1), min(self.y0, self.y1), max(self.y0, self.y1))

    def legend(self):
        return None

    def svg(self, P):
        a, b = P.map(self.x0, self.y1, clamp=False), P.map(self.x1, self.y0, clamp=False)
        if a is None or b is None:
            return ""
        x, y = min(a[0], b[0]), min(a[1], b[1])
        w, h = abs(b[0] - a[0]), abs(b[1] - a[1])
        # (options first_row_y and first_col_x: the data coordinates of the
        # picture's first row and column; otherwise its top row is at the top)
        sx = sy = 1
        o = self.options
        if o.get("first_row_y") is not None:
            other = self.y0 if float(o["first_row_y"]) == self.y1 else self.y1
            p, q = P.map(self.x0, float(o["first_row_y"]), clamp=False), P.map(self.x0, other, clamp=False)
            if p is not None and q is not None and p[1] > q[1]:
                sy = -1
        if o.get("first_col_x") is not None:
            other = self.x1 if float(o["first_col_x"]) == self.x0 else self.x0
            p, q = P.map(float(o["first_col_x"]), self.y0, clamp=False), P.map(other, self.y0, clamp=False)
            if p is not None and q is not None and p[0] > q[0]:
                sx = -1
        flip = ""
        if sx != 1 or sy != 1:
            flip = ' transform="matrix(%d 0 0 %d %s %s)"' % (sx, sy, _fmt(2 * x + w if sx < 0 else 0), _fmt(2 * y + h if sy < 0 else 0))
        return '<image href="%s" x="%s" y="%s" width="%s" height="%s" preserveAspectRatio="none"%s%s/>' % (
            self.href, _fmt(x), _fmt(y), _fmt(w), _fmt(h),
            ' style="image-rendering:pixelated"' if o.get("pixelated") else "", flip)

    def describe(self):
        return self.options.get("what") or "image"


class AxLine(Primitive):
    """A horizontal or vertical line across the whole panel (axhline, axvline)."""
    kind = "axline"

    def __init__(self, value, vertical, **options):
        super().__init__(**options)
        self.value, self.vertical = float(value), vertical

    def bbox(self):
        return None

    def svg(self, P):
        o = self.options
        if self.vertical:
            p = P.map(self.value, P.ylo, clamp=False)
            if p is None:
                return ""
            d = "M%s %sV%s" % (_fmt(p[0]), _fmt(P.top), _fmt(P.top + P.h))
        else:
            p = P.map(P.xlo, self.value, clamp=False)
            if p is None:
                return ""
            d = "M%s %sH%s" % (_fmt(P.left), _fmt(p[1]), _fmt(P.left + P.w))
        dash = DASHES.get(o.get("linestyle", "-"))
        return '<path d="%s" stroke="%s" stroke-width="%s"%s/>' % (
            d, _esc(to_color(o.get("color"), "currentColor")), _fmt(o.get("thickness", 1)),
            ' stroke-dasharray="%s"' % dash if dash else "")

    def describe(self):
        return "%s line at %s = %s" % ("vertical" if self.vertical else "horizontal", "x" if self.vertical else "y", _num(self.value))


def _label(p):
    s = p.legend()
    return ' "%s"' % s if s else ""


# ------------------------------------------------------------------ a panel

class _Placed:
    """Data -> pixel mapping of a laid-out panel."""

    def __init__(self, left, top, w, h, xlo, xhi, ylo, yhi, xlog, ylog):
        self.left, self.top, self.w, self.h = left, top, w, h
        self.xlo, self.xhi, self.ylo, self.yhi = xlo, xhi, ylo, yhi
        self.xlog, self.ylog = xlog, ylog
        self._x0, self._x1 = self._t(xlo, xlog), self._t(xhi, xlog)
        self._y0, self._y1 = self._t(ylo, ylog), self._t(yhi, ylog)

    @staticmethod
    def _t(v, log):
        if not log:
            return v
        return math.log10(v) if v is not None and v > 0 else None

    def map(self, x, y, clamp=True):
        if x is None or y is None:
            return None
        tx, ty = self._t(x, self.xlog), self._t(y, self.ylog)
        if tx is None or ty is None:
            return None
        px = self.left + (tx - self._x0) / (self._x1 - self._x0) * self.w
        py = self.top + self.h - (ty - self._y0) / (self._y1 - self._y0) * self.h
        if clamp:  # keep huge values (tan near a pole) from overflowing the SVG
            px = max(-1e5, min(1e5, px))
            py = max(-1e5, min(1e5, py))
        return px, py


def _range(lo, hi, log):
    """the axis's range: a degenerate one widened (hi < lo stays: an inverted axis, as matplotlib's)"""
    if lo is None:
        return (1.0, 10.0) if log else (-1.0, 1.0)
    if hi == lo or (not log and abs(hi - lo) < 1e-12 * max(1.0, abs(lo))):
        d = abs(lo) * 0.1 if lo else 1.0
        return (lo / 2, lo * 2) if log and lo > 0 else (lo - d, hi + d)
    return lo, hi


def _mpl_labels(vals):
    """Tick labels as matplotlib's ScalarFormatter writes them: as many
    decimals as the ticks need, the same for all, and a true minus sign."""
    vals = [float(v) for v in vals]
    d = 0
    for v in vals:
        for k in range(0, 7):
            if abs(round(v, k) - v) <= 1e-9 * max(1.0, abs(v)):
                d = max(d, k)
                break
        else:
            d = 6
    out = []
    for v in vals:
        t = "%.*f" % (d, v)
        if float(t) == 0:
            t = t.lstrip("-")
        out.append(t.replace("-", "\u2212"))
    return out


def _log_ticks(lo, hi):
    a, b = math.floor(math.log10(lo) + 1e-9), math.ceil(math.log10(hi) - 1e-9)
    return [10.0 ** k for k in range(a, b + 1) if lo * (1 - 1e-9) <= 10.0 ** k <= hi * (1 + 1e-9)]


def _pow10_label(v):
    # (as matplotlib: 10 with the exponent raised)
    k = int(round(math.log10(v)))
    return '10<tspan font-size="70%%" dy="-0.55em">%s</tspan><tspan dy="0.385em">\u200b</tspan>' % (("\u2212%d" % -k) if k < 0 else k)


class Panel:
    """One set of axes: primitives plus options.

    Options: title, title_weight, subtitle ((text, weight), a line under the title),
    xlabel, ylabel, xmin, xmax, ymin, ymax, xscale/yscale
    ('linear' or 'log'), grid, legend (None: when labels exist; False: never),
    legend_loc, aspect_ratio (1 for equal scales), frame (a box with ticks,
    matplotlib style) or Sage's axes crossing at the origin, axes (False:
    none), xticks/yticks (positions), xticklabels/yticklabels, margins.
    """

    def __init__(self, primitives=None, **options):
        self.primitives = list(primitives or [])
        self.options = options

    def data_bbox(self):
        boxes = [b for b in (p.bbox() for p in self.primitives) if b is not None]
        if not boxes:
            return None
        return (min(b[0] for b in boxes), max(b[1] for b in boxes), min(b[2] for b in boxes), max(b[3] for b in boxes))

    def ranges(self, w, h):
        o = self.options
        xlog, ylog = o.get("xscale") == "log", o.get("yscale") == "log"
        bb = self.data_bbox()
        if xlog or ylog:  # only positive values have a place on a log axis
            xs, ys = [], []
            for p in self.primitives:
                if isinstance(p, Rects):
                    pts = [(x + dx, y + dy) for x, y, w, h in p.rects for dx in (0, w) for dy in (0, h)]
                else:
                    pts = zip(getattr(p, "xs", ()), getattr(p, "ys", ()))
                for x, y in pts:
                    if x is not None and y is not None:
                        if xlog and x <= 0 and not isinstance(p, Rects) or ylog and y <= 0 and not isinstance(p, Rects):
                            continue
                        if not (xlog and x <= 0):
                            xs.append(x)
                        if not (ylog and y <= 0):
                            ys.append(y)
            if xs and ys:
                bb = (min(xs), max(xs), min(ys), max(ys))
        xlo, xhi, ylo, yhi = bb if bb else (None, None, None, None)
        m = o.get("margins", 0.0)
        if bb and m:
            if xlog:
                f = (xhi / xlo) ** m
                xlo, xhi = xlo / f, xhi * f
            else:
                d = (xhi - xlo) * m
                xlo, xhi = xlo - d, xhi + d
            if ylog:
                f = (yhi / ylo) ** m
                ylo, yhi = ylo / f, yhi * f
            else:
                d = (yhi - ylo) * m
                ylo, yhi = ylo - d, yhi + d
        xlo, xhi = _range(xlo, xhi, xlog)
        ylo, yhi = _range(ylo, yhi, ylog)
        for k, v in (("xmin", "xlo"), ("xmax", "xhi"), ("ymin", "ylo"), ("ymax", "yhi")):
            if o.get(k) is not None:
                val = float(o[k])
                if v == "xlo":
                    xlo = val
                elif v == "xhi":
                    xhi = val
                elif v == "ylo":
                    ylo = val
                else:
                    yhi = val
        xlo, xhi = _range(xlo, xhi, xlog)
        ylo, yhi = _range(ylo, yhi, ylog)
        ar = o.get("aspect_ratio")
        # (fit_aspect with all four limits set: the box takes the shape, the limits stay, as matplotlib's adjustable='box')
        boxed = o.get("fit_aspect") and None not in (o.get("xmin"), o.get("xmax"), o.get("ymin"), o.get("ymax"))
        if ar not in (None, "automatic", "auto") and not xlog and not ylog and not boxed:
            ar = float(ar)
            # (an inverted axis keeps its direction: the spans' signs)
            gx, gy = (1.0 if xhi > xlo else -1.0), (1.0 if yhi > ylo else -1.0)
            sx, sy = w / abs(xhi - xlo), h / (abs(yhi - ylo) * ar)
            if sx > sy:
                c, half = (xlo + xhi) / 2, w / sy / 2
                xlo, xhi = c - gx * half, c + gx * half
            else:
                c, half = (ylo + yhi) / 2, h / (sx * ar) / 2
                ylo, yhi = c - gy * half, c + gy * half
        return xlo, xhi, ylo, yhi, xlog, ylog

    def ticks(self, lo, hi, log, positions, labels, target):
        mpl = self.options.get("tick_format") == "matplotlib"
        lo, hi = min(lo, hi), max(lo, hi)  # (an inverted axis has the same ticks)
        if positions is not None:
            pos = [float(v) for v in positions]
            if labels is not None:
                labs = [_rich(s) for s in labels]
            elif mpl:
                labs = _mpl_labels(pos)
            else:
                step = min((abs(b - a) for a, b in zip(pos, pos[1:]) if b != a), default=None)
                labs = [_num(v, step) for v in pos]
            return [(v, s) for v, s in zip(pos, labs) if lo - 1e-9 * abs(hi - lo) <= v <= hi + 1e-9 * abs(hi - lo)]
        if log:
            t = _log_ticks(lo, hi)
            if len(t) >= 2:
                return [(v, _pow10_label(v)) for v in t]
        ticks, step = nice_ticks(lo, hi, target)
        if mpl:
            return list(zip(ticks, _mpl_labels(ticks)))
        return [(v, _num(v, step)) for v in ticks]

    def svg(self, x, y, w, h):
        """SVG for this panel inside the box (x, y, w, h); returns (svg, description)."""
        o = self.options
        frame = o.get("frame", False)
        show_axes = o.get("axes", True)
        title, xlabel, ylabel = o.get("title"), o.get("xlabel"), o.get("ylabel")
        # font sizes (pixels): tick labels, axis labels, title
        ts, ls, tts = float(o.get("tick_size", 10.5)), float(o.get("label_size", 12)), float(o.get("title_size", 14))
        right_y = o.get("yaxis_side") == "right"
        # margins around the plot area, for tick labels, axis labels and title
        sub = o.get("subtitle") if title else None
        sub_h = tts + 4 if sub else 0  # (the subtitle's line, under the title)
        top = 10 + (tts + 8 if title else 0) + sub_h
        bottom = (ts * 1.75 + (ls * 1.3 + 4 if xlabel else 6)) if show_axes else 8
        right = 14
        guess = self.ranges(max(w - 70, 50), max(h - top - bottom, 50))
        yt = self.ticks(guess[2], guess[3], guess[5], o.get("yticks"), o.get("yticklabels"), max(3, int(h / 70)))
        lw = max([len(_strip_tags(s)) for _, s in yt] + [1]) * ts * 0.61 + 10 if yt else 4
        left = (lw + (ls + 6 if ylabel else 0)) if show_axes else 8
        if o.get("exact"):
            # (matplotlib's axes: the box is the plot area; labels and the
            # title go outside it)
            left = top = right = bottom = 0
            top = sub_h  # (except a subtitle's line: the title stays where it was)
        pw, ph = max(20, w - left - right), max(20, h - top - bottom)
        ar = o.get("aspect_ratio")
        if o.get("fit_aspect") and ar not in (None, "automatic", "auto") and None not in (
                o.get("xmin"), o.get("xmax"), o.get("ymin"), o.get("ymax")):
            # keep the ranges and shrink the plot area to their shape instead
            xr, yr = abs(float(o["xmax"]) - float(o["xmin"])), abs(float(o["ymax"]) - float(o["ymin"])) * float(ar)
            if xr > 0 and yr > 0:
                k = min(pw / xr, ph / yr)
                left += (pw - xr * k) / 2
                top += (ph - yr * k) / 2
                pw, ph = xr * k, yr * k
        xlo, xhi, ylo, yhi, xlog, ylog = self.ranges(pw, ph)
        P = _Placed(x + left, y + top, pw, ph, xlo, xhi, ylo, yhi, xlog, ylog)
        # Sage's axes carry more ticks than matplotlib's frame
        dx, dy = (85, 55) if frame else (60, 45)
        xt = self.ticks(xlo, xhi, xlog, o.get("xticks"), o.get("xticklabels"), max(3, int(pw / dx)))
        yt = self.ticks(ylo, yhi, ylog, o.get("yticks"), o.get("yticklabels"), max(3, int(ph / dy)))

        out = ['<g class="sb-panel" data-xr="%r %r" data-yr="%r %r" data-box="%s %s %s %s"%s%s>' % (
            xlo, xhi, ylo, yhi, _fmt(P.left), _fmt(P.top), _fmt(pw), _fmt(ph),
            ' data-xlog="1"' if xlog else "", ' data-ylog="1"' if ylog else "")]
        cid = "sbclip%d" % _next_id()
        out.append('<clipPath id="%s"><rect x="%s" y="%s" width="%s" height="%s"/></clipPath>' % (
            cid, _fmt(P.left - 4), _fmt(P.top - 4), _fmt(pw + 8), _fmt(ph + 8)))
        if o.get("grid"):
            g = []
            for v, _ in xt:
                p = P.map(v, ylo, clamp=False)
                if p:
                    g.append("M%s %sV%s" % (_fmt(p[0]), _fmt(P.top), _fmt(P.top + ph)))
            for v, _ in yt:
                p = P.map(xlo, v, clamp=False)
                if p:
                    g.append("M%s %sH%s" % (_fmt(P.left), _fmt(p[1]), _fmt(P.left + pw)))
            out.append('<path d="%s" stroke="currentColor" stroke-opacity="0.15" stroke-width="1"/>' % "".join(g))
        if show_axes:
            out.append(self._axes_svg(P, xt, yt, frame))
        out.append('<g clip-path="url(#%s)">' % cid)
        for p in self.primitives:
            out.append(p.svg(P))
        out.append("</g>")
        if show_axes and frame and any(isinstance(p, Patches) for p in self.primitives):
            # filled regions reach the frame: draw it again on top
            out.append('<rect x="%s" y="%s" width="%s" height="%s" fill="none" stroke="currentColor" stroke-width="0.8"/>' % (
                _fmt(P.left), _fmt(P.top), _fmt(pw), _fmt(ph)))
        if show_axes and (xlabel or ylabel):
            if xlabel:
                has_xt = bool(xt)
                out.append('<text x="%s" y="%s" text-anchor="middle" font-size="%s">%s</text>' % (
                    _fmt(P.left + pw / 2), _fmt(P.top + ph + (ts * 1.75 if has_xt else 4) + ls * 1.0), _fmt(ls), _rich(xlabel)))
            if ylabel:
                lwr = max([len(_strip_tags(s)) for _, s in yt] + [1]) * ts * 0.61 + 10 if yt else 4
                pad = float(o.get("ylabel_pad", 0))
                if right_y:
                    cx = P.left + pw + lwr + ls * 0.55 + pad
                    rot = 90 if o.get("ylabel_rotation") == 90 else -90
                else:
                    cx, rot = P.left - lwr - ls * 0.55 - pad, -90
                cy = P.top + ph / 2
                out.append('<text x="%s" y="%s" text-anchor="middle" dominant-baseline="middle" font-size="%s" transform="rotate(%s %s %s)">%s</text>' % (
                    _fmt(cx), _fmt(cy), _fmt(ls), rot, _fmt(cx), _fmt(cy), _rich(ylabel)))
        if title:
            ty = P.top - max(8, tts * 0.6 + 4)
            out.append('<text x="%s" y="%s" text-anchor="middle" font-size="%s"%s>%s</text>' % (
                _fmt(P.left + pw / 2), _fmt(ty - sub_h), _fmt(tts),
                ' font-weight="%s"' % o.get("title_weight", "600") if o.get("title_weight", "600") != "normal" else "", _rich(title)))
            if sub:
                out.append('<text x="%s" y="%s" text-anchor="middle" font-size="%s"%s>%s</text>' % (
                    _fmt(P.left + pw / 2), _fmt(ty), _fmt(tts), ' font-weight="bold"' if sub[1] == "bold" else "", _rich(sub[0])))
        out.append(self._legend_svg(P))
        out.append("</g>")
        return "".join(out), self.describe(xlo, xhi, ylo, yhi, xlog, ylog)

    def _axes_svg(self, P, xt, yt, frame):
        out = []
        tick = []
        ts = float(self.options.get("tick_size", 10.5))
        right_y = self.options.get("yaxis_side") == "right"
        if frame:
            out.append('<rect x="%s" y="%s" width="%s" height="%s" fill="none" stroke="currentColor" stroke-width="0.8"/>' % (
                _fmt(P.left), _fmt(P.top), _fmt(P.w), _fmt(P.h)))
            ax_y, ax_x = P.top + P.h, P.left
            skip_x = skip_y = None
        else:
            # Sage: axes cross at the origin when it is in view, else along an edge
            yv = 0.0 if P.ylo <= 0 <= P.yhi and not P.ylog else (P.ylo if P.ylo > 0 or P.ylog else P.yhi)
            xv = 0.0 if P.xlo <= 0 <= P.xhi and not P.xlog else (P.xlo if P.xlo > 0 or P.xlog else P.xhi)
            ax_y = P.map(P.xlo, yv, clamp=False)[1]
            ax_x = P.map(xv, P.ylo, clamp=False)[0]
            out.append('<path d="M%s %sH%sM%s %sV%s" stroke="currentColor" stroke-width="0.8"/>' % (
                _fmt(P.left), _fmt(ax_y), _fmt(P.left + P.w), _fmt(ax_x), _fmt(P.top), _fmt(P.top + P.h)))
            skip_x = xv if (P.ylo < 0 < P.yhi and xv == 0.0) else None
            skip_y = yv if (P.xlo < 0 < P.xhi and yv == 0.0) else None
        labels = []
        for v, s in xt:
            p = P.map(v, P.ylo, clamp=False)
            if p is None:
                continue
            tick.append("M%s %sv%s" % (_fmt(p[0]), _fmt(ax_y), "4" if frame else "3"))
            if skip_x is not None and abs(v - skip_x) < 1e-12:
                continue
            ly = (P.top + P.h if frame else min(max(ax_y, P.top), P.top + P.h)) + ts * 1.43
            labels.append('<text x="%s" y="%s" text-anchor="middle">%s</text>' % (_fmt(p[0]), _fmt(ly), s))
        for v, s in yt:
            p = P.map(P.xlo, v, clamp=False)
            if p is None:
                continue
            if right_y:
                tick.append("M%s %sh4" % (_fmt(P.left + P.w), _fmt(p[1])))
                labels.append('<text x="%s" y="%s" text-anchor="start" dominant-baseline="middle">%s</text>' % (_fmt(P.left + P.w + 6), _fmt(p[1]), s))
                continue
            tick.append("M%s %sh%s" % (_fmt(ax_x), _fmt(p[1]), "-4" if frame else "-3"))
            if skip_y is not None and abs(v - skip_y) < 1e-12:
                continue
            lx = (P.left if frame else min(max(ax_x, P.left), P.left + P.w)) - 6
            labels.append('<text x="%s" y="%s" text-anchor="end" dominant-baseline="middle">%s</text>' % (_fmt(lx), _fmt(p[1]), s))
        out.append('<path d="%s" stroke="currentColor" stroke-width="0.8"/>' % "".join(tick))
        out.append('<g font-size="%s">%s</g>' % (_fmt(ts), "".join(labels)))
        return "".join(out)

    def _legend_svg(self, P):
        o = self.options
        if o.get("legend") is False:
            return ""
        items = [(p, p.legend()) for p in self.primitives if p.legend()]
        if not items:
            return ""
        w = max(len(str(s)) for _, s in items) * 6.6 + 40
        h = len(items) * 18 + 8
        loc = o.get("legend_loc") or "upper right"
        if isinstance(loc, int):
            loc = {1: "upper right", 2: "upper left", 3: "lower left", 4: "lower right"}.get(loc, "upper right")
        lx = P.left + 8 if "left" in loc else P.left + P.w - w - 8
        ly = P.top + P.h - h - 8 if "lower" in loc else P.top + 8
        out = ['<g class="sb-legend"><rect x="%s" y="%s" width="%s" height="%s" rx="3" style="fill: var(--sb-legend-bg, #fff)" fill-opacity="0.85" stroke="currentColor" stroke-opacity="0.25"/>' % (
            _fmt(lx), _fmt(ly), _fmt(w), _fmt(h))]
        for i, (p, s) in enumerate(items):
            cy = ly + 13 + i * 18
            c = _esc(to_color(p.options.get("color"), "#1f77b4"))
            if p.kind == "line":
                dash = DASHES.get(p.options.get("linestyle", "-"))
                out.append('<path d="M%s %sh22" stroke="%s" stroke-width="%s"%s/>' % (
                    _fmt(lx + 7), _fmt(cy), c, _fmt(p.options.get("thickness", 1.5)), ' stroke-dasharray="%s"' % dash if dash else ""))
            elif p.kind == "points":
                out.append(_marker(p.options.get("marker", "o"), lx + 18, cy, 3.5, to_color(p.options.get("color"), "#1f77b4")))
            else:
                ec = to_color(p.options.get("legend_edge"))  # (a swatch's outline, if its entry asks for one)
                out.append('<rect x="%s" y="%s" width="22" height="10" fill="%s"%s%s/>' % (
                    _fmt(lx + 7), _fmt(cy - 5), c, ' fill-opacity="%s"' % _fmt(p.options["alpha"]) if p.options.get("alpha") is not None else "",
                    ' stroke="%s" stroke-width="1"' % _esc(ec) if ec else ""))
            out.append('<text x="%s" y="%s" dominant-baseline="middle" font-size="11">%s</text>' % (_fmt(lx + 35), _fmt(cy), _rich(s)))
        out.append("</g>")
        return "".join(out)

    def describe(self, xlo, xhi, ylo, yhi, xlog, ylog):
        o = self.options
        parts = []
        if o.get("title"):
            parts.append('"%s"' % (o["title"] + ("\n" + o["subtitle"][0] if o.get("subtitle") else "")))
        shown = [p.describe() for p in self.primitives[:8]]
        if len(self.primitives) > 8:
            shown.append("%d more" % (len(self.primitives) - 8))
        parts.append(", ".join(shown) if shown else "empty")
        xl = (" (%s)" % o["xlabel"]) if o.get("xlabel") else ""
        yl = (" (%s)" % o["ylabel"]) if o.get("ylabel") else ""
        parts.append("x%s from %s to %s%s, y%s from %s to %s%s" % (
            xl, _short(xlo), _short(xhi), " log scale" if xlog else "", yl, _short(ylo), _short(yhi), " log scale" if ylog else ""))
        return "; ".join(parts)


def _short(v):
    s = "%.4g" % v
    return "0" if s == "-0" else s


_ids = [0]


def _next_id():
    _ids[0] += 1
    return _ids[0]


def _strip_tags(s):
    out, inside = [], False
    for ch in s:
        if ch == "<":
            inside = True
        elif ch == ">":
            inside = False
        elif not inside:
            out.append(ch)
    return "".join(out)


def render_frame(panels, width=640, height=480, title=None):
    """The SVG body (without the <svg> element) and description of panels laid
    out as [(panel, (fx, fy, fw, fh)), ...] in fractions of the figure."""
    width, height = float(width), float(height)
    top = 30 if title else 0
    body, descs = [], []
    for panel, (fx, fy, fw, fh) in panels:
        if panel.options.get("exact"):
            s, d = panel.svg(fx * width, top + fy * (height - top), fw * width, fh * (height - top))
        else:
            s, d = panel.svg(fx * width + 4, top + fy * (height - top) + 2, fw * width - 8, fh * (height - top) - 4)
        body.append(s)
        descs.append(d)
    if title:
        body.insert(0, '<text x="%s" y="20" text-anchor="middle" font-size="15" font-weight="600">%s</text>' % (_fmt(width / 2), _rich(title)))
    kind = "Plot" if len(panels) == 1 else "Figure with %d plots" % len(panels)
    desc = kind + (' "%s"' % title if title else "") + ": " + " | ".join(descs)
    return "".join(body), desc


def _svg_open(width, height, desc, cls="sb-plot", extra=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" width="%s" height="%s" role="img" aria-label="%s" '
            'font-family="system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="11" fill="currentColor" class="%s"%s>'
            '<title>%s</title>') % (_fmt(width), _fmt(height), _fmt(width), _fmt(height), _esc(desc), cls, extra, _esc(desc))


def render_svg(panels, width=640, height=480, title=None):
    """SVG for panels laid out as [(panel, (fx, fy, fw, fh)), ...] in fractions of the figure."""
    body, desc = render_frame(panels, width, height, title)
    return _svg_open(float(width), float(height), desc) + body + "</svg>"


def render_animation(frames, width=640, height=480, delay=200, iterations=0):
    """An animated SVG from frames [(body, description), ...] shown `delay`
    milliseconds each.  It plays by itself in a browser (CSS animation, looping;
    `iterations` is a hint for players); a page can instead drive it by
    showing one <g class="sb-frame"> at a time."""
    n = len(frames)
    if n == 0:
        return render_svg([], width, height)
    total = n * delay / 1000.0
    desc = "Animation of %d frames, %s s each; first frame: %s; last frame: %s" % (
        n, _short(delay / 1000.0), frames[0][1], frames[-1][1])
    style = ("<style>.sb-frame{visibility:hidden;animation:sb-frame %ss step-end infinite}"
             "@keyframes sb-frame{0%%{visibility:visible}%s%%{visibility:hidden}}</style>") % (
                 _short(total), _short(100.0 / n))
    out = [_svg_open(float(width), float(height), desc, "sb-plot sb-anim",
                     ' data-frames="%d" data-delay="%d" data-iterations="%d"' % (n, int(delay), int(iterations or 0))), style]
    for k, (body, _) in enumerate(frames):
        out.append('<g class="sb-frame" style="animation-delay:%ss">%s</g>' % (_short(k * delay / 1000.0), body))
    out.append("</svg>")
    return "".join(out)


def describe_svg(svg):
    """The description stored in an SVG made by render_svg."""
    i = svg.find("<title>")
    j = svg.find("</title>")
    if i < 0 or j < 0:
        return ""
    return svg[i + 7:j].replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")


# ------------------------------------------------------------------ output

def host_display(obj):
    """Display obj richly if the host can: the browser (pyjs), or under
    CPython a Jupyter kernel (obj has _repr_svg_).  True if displayed."""
    import builtins
    d = getattr(builtins, "__pyjs_display__", None)
    if d is not None:
        return d(obj)
    import sys
    ip = sys.modules.get("IPython")
    shell = ip.get_ipython() if ip is not None and hasattr(ip, "get_ipython") else None
    if shell is not None and getattr(shell, "kernel", None) is not None:
        from IPython.display import display
        display(obj)
        return True
    return False


def show(obj, save_name="plot"):
    """Display obj richly when the host can (the browser, Jupyter); else
    write an SVG file and print its path (the command line)."""
    import builtins
    if getattr(builtins, "__sagebrush_doctest__", False):
        return None  # doctests show the repr only, as Sage's do
    shown = host_display(obj)
    if shown:
        return None
    svg = obj._repr_svg_()
    try:
        import tempfile, os
        fd, path = tempfile.mkstemp(prefix="sagebrush-" + save_name + "-", suffix=".svg")
        os.close(fd)
        with open(path, "w") as f:
            f.write(svg)
    except OSError:  # e.g. a sandbox that may not write files (display printed the repr)
        print("(%s)" % describe_svg(svg)[:300])
        return None
    print("Saved %s (%s)" % (path, describe_svg(svg)[:300]))
    return None


def save_svg(svg, filename):
    if hasattr(filename, "write"):
        filename.write(svg)
        return
    name = str(filename)
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else "svg"
    if ext != "svg":
        raise ValueError("only SVG files can be written (got .%s); use a .svg file name" % ext)
    with open(name, "w") as f:
        f.write(svg)


# ------------------------------------------------------------------ sampling

def adaptive_sample(f, a, b, plot_points=200, adaptive_tolerance=0.01, adaptive_recursion=5):
    """Sage's plot sampling: plot_points uniform points, then recursive
    midpoint refinement where the curve bends more than the tolerance (as a
    fraction of the y range).  Failed or non-finite values break the line."""
    def ev(x):
        try:
            y = f(x)
        except (ValueError, ZeroDivisionError, OverflowError, ArithmeticError):
            return None
        if isinstance(y, complex):
            return None if abs(y.imag) > 1e-12 else _finite(y.real)
        return _finite(y)

    a, b = float(a), float(b)
    n = max(2, int(plot_points))
    xs = [a + (b - a) * i / (n - 1) for i in range(n)]
    pts = [(x, ev(x)) for x in xs]
    ys = [y for _, y in pts if y is not None]
    if not ys:
        return [x for x, _ in pts], [None] * len(pts)
    tol = (max(ys) - min(ys)) * adaptive_tolerance

    def refine(p, q, level):
        if level >= adaptive_recursion or p[1] is None or q[1] is None:
            return []
        x = (p[0] + q[0]) / 2
        y = ev(x)
        if y is None:
            return [(x, None)]  # undefined here (a pole): break the line
        if abs((p[1] + q[1]) / 2 - y) > tol:
            m = (x, y)
            return refine(p, m, level + 1) + [m] + refine(m, q, level + 1)
        return []

    out = [pts[0]]
    for i in range(len(pts) - 1):
        out.extend(refine(pts[i], pts[i + 1], 0))
        out.append(pts[i + 1])
    return [p[0] for p in out], [p[1] for p in out]
