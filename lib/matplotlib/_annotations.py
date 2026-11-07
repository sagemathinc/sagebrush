"""matplotlib's annotations, imported when the first is made: annotate()'s
coordinates, a text's box (bbox=) and arrows (arrowprops=), drawn as
matplotlib 3.11.1 draws them.

An arrow is matplotlib's FancyArrowPatch: an arc3 connection (a quadratic
Bezier curve, rad its bend), clipped where it leaves the text's box and
shrunk by shrinkA and shrinkB points at its ends, then given its heads.  The
styles are "-", "->", "-|>", "<-", "<->", "<|-", "<|-|>" and "simple" (an
arrow without arrowstyle is matplotlib's YAArrow look-alike, a "simple" one
from width, headwidth, headlength and shrink).  The geometry follows
matplotlib's (patches.ArrowStyle, bezier), in display coordinates (y up)."""

import math
import re
from _graphics import Text, _anchor, _fmt, _esc, to_color, DASHES

PT = 100 / 72  # pixels per point at 100 dpi
# (a bisection's steps: past the 1075 halvings that bring two doubles in [0, 1]
# together, so never reached; it only bounds the loop)
_HALVINGS = 2200

# coordinates: (for _anchor, pixels per unit, whether an offset from xy)
_COORDS = {"data": (None, 1, False), "axes fraction": ("axes fraction", 1, False),
           "figure fraction": ("figure fraction", 1, False), "axes pixels": ("axes pixels", 1, False),
           "figure pixels": ("figure pixels", 1, False), "axes points": ("axes pixels", PT, False),
           "figure points": ("figure pixels", PT, False), "offset points": (None, PT, True),
           "offset pixels": (None, 1, True), "offset fontsize": (None, None, True)}
# (arrow styles: a head at the begin, at the end; whether they are filled)
_CURVES = {"-": (False, False, False), "->": (False, True, False), "-|>": (False, True, True), "<-": (True, False, False),
           "<->": (True, True, False), "<|-": (True, False, True), "<|-|>": (True, True, True)}
# (properties that don't change the drawing)
_IGNORED = {"zorder", "antialiased", "aa", "visible", "picker", "label", "gid", "url", "snap", "rasterized", "joinstyle",
            "capstyle", "clip_on"}


# (matplotlib's coordinate names, the "offset" units excepted)
_MPL_COORDS = {"data", "polar", "figure points", "figure pixels", "figure fraction", "subfigure points",
               "subfigure pixels", "subfigure fraction", "axes points", "axes pixels", "axes fraction"}


class _Later(Exception):
    """An error matplotlib raises only when the annotation is drawn, kept as
    its class and arguments (args): Text.svg raises a fresh one each draw."""


class _ArrowStyleLater(_Later):
    """_Later from an arrow's arrowstyle, which matplotlib calls last."""


def _coords(c, size_pt, textcoords):
    if hasattr(c, "_axes_fraction"):  # ax.transAxes
        return "axes fraction", 1, False
    if isinstance(c, str) and c.startswith("offset") and not textcoords:
        raise ValueError("xycoords cannot be an offset coordinate")
    r = _COORDS.get(c) if isinstance(c, str) else None
    if r is None and isinstance(c, str):
        if c.startswith("offset "):
            if c[7:] not in ("points", "pixels", "fontsize"):
                raise _Later(ValueError, "%r is not a recognized unit" % c[7:])
        elif c not in _MPL_COORDS:
            raise _Later(ValueError, "%r is not a valid coordinate" % c)
    if r is None:
        raise NotImplementedError("annotate: the coordinates %r are not implemented in Sagebrush" % (c,))
    return r if r[1] is not None else (None, size_pt * PT, True)


# (matplotlib's style names, and the parameters each class takes)
_CURVE_PARAMS = ("head_length", "head_width", "widthA", "widthB", "lengthA", "lengthB", "angleA", "angleB", "scaleA", "scaleB")
_STYLES = {
    "arrowstyle": ("- <- -> <-> <|- -|> <|-|> ]- -[ ]-[ |-| ]-> <-[ simple fancy wedge",
                   {"simple": ("ArrowStyle.Simple", ("head_length", "head_width", "tail_width"))}),
    "connectionstyle": ("arc3 angle3 angle arc bar", {"arc3": ("ConnectionStyle.Arc3", ("rad",))}),
    "boxstyle": ("square circle ellipse larrow rarrow darrow round round4 sawtooth roundtooth",
                 {"square": ("BoxStyle.Square", ("pad",)), "round": ("BoxStyle.Round", ("pad", "rounding_size"))}),
}


def _style(s, what, supported):
    """A style string 'name,key=value,...' as (name, {key: float}), checked
    as matplotlib checks it (an unknown name, a bad value, a parameter its
    class doesn't take); a style of matplotlib's not in `supported` is
    refused as not implemented here."""
    if not isinstance(s, str) and not callable(s):
        # (matplotlib calls a style that isn't a string, when it is drawn)
        raise _Later(TypeError, "'%s' object is not callable" % type(s).__name__)
    if not isinstance(s, str):
        raise NotImplementedError("a %s object is not implemented in Sagebrush; give the style as a string, such as %s"
                                  % (what, {"arrowstyle": "'->'", "connectionstyle": "'arc3,rad=0.2'"}.get(what, "'round,pad=0.3'")))
    name, *rest = [p.strip() for p in s.split(",")]
    names, classes = _STYLES[what]
    if name not in names.split():
        raise ValueError("Unknown style: %r" % s)
    params = {}
    try:
        for p in rest:
            k, _, v = p.partition("=")
            params[k.strip()] = float(v)
    except ValueError:
        raise ValueError("Incorrect style argument: %r" % s) from None
    if name not in supported:
        raise NotImplementedError("the %s %r is not implemented in Sagebrush" % (what, name))
    cls, allowed = classes.get(name, ("ArrowStyle._Curve", _CURVE_PARAMS))
    for k in params:
        if k not in allowed:
            raise TypeError("%s.__init__() got an unexpected keyword argument %r" % (cls, k))
    return name, params


def annotation(text, xy, xytext, xycoords, textcoords, arrowprops, annotation_clip, kw, size_pt, **text_options):
    """The Text of ax.annotate(...): its anchor, an offset, its box and arrow."""
    if textcoords is None:
        textcoords = xycoords
    if xytext is None:
        xytext = xy
    # (each coordinate system is resolved as matplotlib uses it, when the
    # annotation is drawn: a bad one raises only where it is needed)
    xerr = terr = None
    try:
        xc, xk, _ = _coords(xycoords, size_pt, False)
    except _Later as e:
        xerr, xc, xk = e.args, None, 1
    try:
        tc, tk, offset = _coords(textcoords, size_pt, True)
    except _Later as e:
        terr, tc, tk, offset = e.args, None, 1, False
    x, y = float(xy[0]) * xk, float(xy[1]) * xk
    if offset:  # (the text placed from xy)
        o = dict(coords=xc, offset=(float(xytext[0]) * tk, float(xytext[1]) * tk))
        tx, ty = x, y
        terr = terr or xerr
    else:
        o = dict(coords=tc)
        tx, ty = float(xytext[0]) * tk, float(xytext[1]) * tk
    # (as matplotlib's annotation_clip: by default an annotation of data
    # coordinates is drawn only while its point is inside the axes; the
    # check needs xy, so bad xycoords raise there)
    if annotation_clip or (annotation_clip is None and xycoords == "data"):
        if xerr:
            o["error"] = xerr
        else:
            o["only_inside"] = (x, y, {"coords": xc})
    # (then, if drawn: the text's place, the arrow's point, its style, the box)
    # (in matplotlib's order: the connection's style, its search for the
    # text's edge, the box, the arrow's style)
    later, head = terr, None
    if arrowprops is not None:
        later = later or xerr
        try:
            o["arrow"] = _arrow_options(arrowprops, (x, y, xc), size_pt)
        except _ArrowStyleLater as e:
            head = e.args
        except _Later as e:
            later = later or e.args
        if not all(math.isfinite(float(v)) for v in xytext):
            later = later or (StopIteration,)  # (as matplotlib, whose arrow search finds no point of such a text)
    try:
        if kw.get("bbox") is not None:
            o["box"] = text_box(kw["bbox"], size_pt)
    except _Later as e:
        later = later or e.args
    later = later or head
    if later:  # (it raises if drawn: nothing of it is drawn)
        o["later"] = later
        o.pop("arrow", None)
    if terr:
        tx = ty = 0.0  # (no place for the text: it raises first)
    # (an annotation has no clip box: it is drawn wherever it is)
    return Text(text, tx, ty, no_bbox=True, clip=False, **dict(text_options, **o))


def text_box(props, size_pt):
    """bbox=dict(...) as matplotlib's set_bbox reads it: a square box padded
    4 points by default, its pad otherwise a fraction of the font size (0.3
    with a boxstyle); facecolor C0, edgecolor black, linewidth 1."""
    props = dict(props)
    style, pad = props.pop("boxstyle", None), props.pop("pad", None)
    if style is None:
        style, pad = "square", (4 if pad is None else pad) / size_pt
    elif pad is None:
        pad = 0.3
    # (matplotlib writes the pad into the style, with two decimals)
    if isinstance(style, str) and "pad" not in style:
        style += ",pad=%0.2f" % pad
    name, params = _style(style, "boxstyle", ("square", "round"))
    pad = params["pad"] if "pad" in params else pad
    b = _paint(props, "bbox")
    b.update(style=name, pad=pad * size_pt * PT, rounding=params.get("rounding_size", pad) * size_pt * PT)
    return b


def _paint(props, what):
    color = props.pop("color", None)
    fc = props.pop("facecolor", props.pop("fc", color if color is not None else "C0"))
    ec = props.pop("edgecolor", props.pop("ec", color if color is not None else "k"))
    if props.pop("fill", True) is False:
        fc = "none"
    lw = props.pop("linewidth", props.pop("lw", 1.0))
    ls = props.pop("linestyle", props.pop("ls", "-"))
    alpha = props.pop("alpha", None)
    extra = sorted(k for k in props if k not in _IGNORED)
    if extra:
        raise NotImplementedError("%s: not implemented in Sagebrush: %s" % (what, ", ".join(extra)))
    none = lambda c: c is None or (isinstance(c, str) and c.lower() == "none")
    return {"fc": None if none(fc) else to_color(fc), "ec": None if none(ec) or not lw else to_color(ec),
            "lw": float(lw or 0) * PT, "dash": DASHES.get(ls), "alpha": alpha}


def _arrow_options(props, end, size_pt):
    props = dict(props)
    ms = float(props.pop("mutation_scale", size_pt))
    style = props.pop("arrowstyle", None)
    relpos = props.pop("relpos", (0.5, 0.5))
    rad = 0.0
    cs = props.pop("connectionstyle", "arc3")
    name, params = _style(cs, "connectionstyle", ("arc3",))
    rad = params.get("rad", 0.0)
    if style is None:  # (matplotlib's YAArrow look-alike)
        a = dict(style="simple", yaarrow=True, shrink=float(props.pop("shrink", 0.0)),
                 head_length=props.pop("headlength", 12) / ms, head_width=props.pop("headwidth", 12) / ms,
                 tail_width=props.pop("width", 4) / ms)
        props.pop("shrinkA", None), props.pop("shrinkB", None)
    else:
        try:
            name, params = _style(style, "arrowstyle", ("simple",) + tuple(_CURVES))
        except _Later as e:  # (matplotlib calls the arrow's style last, after the box's)
            raise _ArrowStyleLater(*e.args) from None
        if name == "simple":
            a = dict(style="simple", head_length=params.get("head_length", 0.5), head_width=params.get("head_width", 0.5),
                     tail_width=params.get("tail_width", 0.2))
        elif name in _CURVES:
            a = dict(style=name, head_length=params.get("head_length", 0.4), head_width=params.get("head_width", 0.2))
        else:  # (not reached: _style refused it)
            raise NotImplementedError("the arrowstyle %r is not implemented in Sagebrush" % name)
        a.update(shrinkA=float(props.pop("shrinkA", 2)) * PT, shrinkB=float(props.pop("shrinkB", 2)) * PT)
    a.update(_paint(props, "arrowprops"), end=end, ms=ms * PT, rad=float(rad), relpos=tuple(relpos))
    return a


# ------------------------------------------------------------------ drawing

def annotation_svg(t, P, p):
    """A text with its box and arrow: the arrow under the box under the text."""
    o = t.options
    x0, y0, x1, y1 = t._extent(p)
    out, rect = [], None
    b = o.get("box")
    rot = float(o.get("rotation", 0) or 0)
    if b:
        pad = b["pad"]
        rect = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        out.append('<rect x="%s" y="%s" width="%s" height="%s"%s%s%s/>' % (
            _fmt(rect[0]), _fmt(rect[1]), _fmt(rect[2] - rect[0]), _fmt(rect[3] - rect[1]),
            ' rx="%s"' % _fmt(b["rounding"]) if b["style"] == "round" else "", _paint_svg(b, True),
            ' transform="rotate(%s %s %s)"' % (_fmt(-rot), _fmt(p[0]), _fmt(p[1])) if rot else ""))
    a = o.get("arrow")
    if a:
        out.insert(0, _arrow_svg(a, P, (x0, y0, x1, y1), rect, t.string))
    out.append(t._svg_at(P, p))
    return "".join(out)


def _paint_svg(a, fill):
    s = ' fill="%s"' % _esc(a["fc"]) if fill and a["fc"] else ' fill="none"'
    if a["ec"]:
        s += ' stroke="%s" stroke-width="%s"' % (_esc(a["ec"]), _fmt(a["lw"]))
        if a["dash"]:
            s += ' stroke-dasharray="%s"' % a["dash"]
    if a["alpha"] is not None:
        s += ' opacity="%s"' % _fmt(float(a["alpha"]))
    return s


def _arrow_svg(a, P, ext, rect, string):
    s = _arrow_paths(a, P, ext, rect, string)
    # (a point that overflowed on the way, from a finite curve near the double
    # limit: no arrow either, as matplotlib draws nothing of it, "simple" too)
    if any(not math.isfinite(float(v)) for d in re.findall(r' d="([^"]*)"', s) for v in re.findall(r'[-+]?(?:[0-9.]+(?:e[-+]?[0-9]+)?|nan|inf)', d)):
        return ""
    return s


def _no_arrow(a):
    """An arrow with a non-finite point: matplotlib draws nothing of a curve
    arrow, and refuses a "simple" one."""
    if a["style"] == "simple":
        raise ValueError("'path' is not a valid quadratic Bezier curve")
    return ""


def _arrow_paths(a, P, ext, rect, string):
    end = _anchor(P, a["end"][0], a["end"][1], {"coords": a["end"][2]})
    if end is None:
        return ""
    x0, y0, x1, y1 = ext
    # in display coordinates (y up) from here on
    X1, Y1 = end[0], -end[1]
    if a.get("yaarrow"):
        # (from the corner, or the middle of a side, of the text nearest the point)
        bx, rx = min(((x0, 0), ((x0 + x1) / 2, 0.5), (x1, 1)), key=lambda v: abs(v[0] - X1))
        by, ry = min(((-y1, 0), (-(y0 + y1) / 2, 0.5), (-y0, 1)), key=lambda v: abs(v[0] - Y1))
        shrinkA = shrinkB = a["shrink"] * math.hypot(by - Y1, bx - X1)
        relpos = (rx, ry)
    else:
        shrinkA, shrinkB, relpos = a["shrinkA"], a["shrinkB"], a["relpos"]
    X0, Y0 = x0 + (x1 - x0) * relpos[0], -y1 + (y1 - y0) * relpos[1]
    # the arc3 connection: the control point off the middle by rad times the length
    bez = [(X0, Y0), ((X0 + X1) / 2 + a["rad"] * (Y1 - Y0), (Y0 + Y1) / 2 - a["rad"] * (X1 - X0)), (X1, Y1)]
    if not all(math.isfinite(v) for q in bez for v in q):
        return _no_arrow(a)  # (an infinite or NaN point)
    # clipped at the text's box (the bbox, or the text padded 2 points), then shrunk
    if rect is None and string:
        q = 2 * PT
        rect = (x0 - q, y0 - q, x1 + q, y1 + q)
    if rect is not None:
        r = (rect[0], -rect[3], rect[2], -rect[1])
        bez = _clip(bez, lambda x, y: r[0] <= x <= r[2] and r[1] <= y <= r[3], True)
    if shrinkA:
        c = bez[0]
        bez = _clip(bez, lambda x, y: (x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) < shrinkA * shrinkA, True)
    if shrinkB:
        c = bez[2]
        bez = _clip(bez, lambda x, y: (x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) < shrinkB * shrinkB, False)
    ms, lw = a["ms"], a["lw"]
    if a["style"] == "simple":
        d = _simple(bez, a["head_length"] * ms, a["head_width"] * ms, a["tail_width"] * ms)
        return '<path d="%s"%s stroke-linejoin="round"/>' % (d, _paint_svg(a, True))
    begin, endh, filled = _CURVES[a["style"]]
    paths = []
    (ax0, ay0), (cx, cy), (ax3, ay3) = bez
    dA = dB = (0.0, 0.0)
    if begin or endh:
        hl, hw = a["head_length"] * ms, a["head_width"] * ms
        hd = math.hypot(hl, hw)
        cos_t, sin_t = hl / hd, hw / hd
        if begin and (ax0, ay0) != (cx, cy):
            v, dA = _wedge(cx, cy, ax0, ay0, hd, cos_t, sin_t, lw)
            paths.append(v)
        if endh and (cx, cy) != (ax3, ay3):
            v, dB = _wedge(cx, cy, ax3, ay3, hd, cos_t, sin_t, lw)
            paths.append(v)
    line = "M%s %sQ%s %s %s %s" % (_fmt(ax0 + dA[0]), _fmt(-(ay0 + dA[1])), _fmt(cx), _fmt(-cy),
                                    _fmt(ax3 + dB[0]), _fmt(-(ay3 + dB[1])))
    out = ['<path d="%s"%s stroke-linejoin="round" stroke-linecap="round"/>' % (line, _paint_svg(a, False))]
    for v in paths:
        d = "M" + "L".join("%s %s" % (_fmt(x), _fmt(-y)) for x, y in v) + ("Z" if filled else "")
        out.append('<path d="%s"%s stroke-linejoin="round" stroke-linecap="round"/>' % (d, _paint_svg(a, filled)))
    return "".join(out)


def _point(bez, t):
    (x0, y0), (x1, y1), (x2, y2) = bez
    u = 1 - t
    return u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2


def _split(bez, t):
    """The two halves of a quadratic Bezier curve at t (de Casteljau)."""
    (x0, y0), (x1, y1), (x2, y2) = bez
    # (as matplotlib's (1 - t) p + t q: no difference of two points, which
    # overflows for points near the double limit on either side)
    u = 1 - t
    a = (x0 * u + x1 * t, y0 * u + y1 * t)
    b = (x1 * u + x2 * t, y1 * u + y2 * t)
    m = (a[0] * u + b[0] * t, a[1] * u + b[1] * t)
    return [(x0, y0), a, m], [m, b, (x2, y2)]


def _clip(bez, inside, at_start):
    """The curve from where it leaves the region `inside` (at_start), or up to
    where it enters it; unchanged if both ends are on the same side."""
    if inside(*bez[0]) == inside(*bez[2]):
        return bez
    left, right = _clip_parts(bez, inside)
    return right if at_start else left


def _wedge(x0, y0, x1, y1, head_dist, cos_t, sin_t, lw):
    """A head at (x1, y1) for a line coming from (x0, y0), moved back so that
    its stroke ends at the point (matplotlib's _get_arrow_wedge)."""
    dx, dy = x0 - x1, y0 - y1
    d = math.hypot(dx, dy) or 1
    pad = 0.5 * lw / sin_t
    ddx, ddy = pad * dx / d, pad * dy / d
    dx, dy = dx / d * head_dist, dy / d * head_dist
    dx1, dy1 = cos_t * dx + sin_t * dy, -sin_t * dx + cos_t * dy
    dx2, dy2 = cos_t * dx - sin_t * dy, sin_t * dx + cos_t * dy
    return [(x1 + ddx + dx1, y1 + ddy + dy1), (x1 + ddx, y1 + ddy), (x1 + ddx + dx2, y1 + ddy + dy2)], (ddx, ddy)


def _cos_sin(x0, y0, x1, y1):
    d = math.hypot(x1 - x0, y1 - y0)
    return (0.0, 0.0) if d == 0 else ((x1 - x0) / d, (y1 - y0) / d)


def _normals(cx, cy, cos_t, sin_t, length):
    return (cx + length * sin_t, cy - length * cos_t), (cx - length * sin_t, cy + length * cos_t)


def _parallels(bez, width):
    """Two quadratic curves `width` either side of bez (matplotlib's get_parallels)."""
    (c1x, c1y), (cmx, cmy), (c2x, c2y) = bez
    t1 = _cos_sin(c1x, c1y, cmx, cmy)
    t2 = _cos_sin(cmx, cmy, c2x, c2y)
    a1 = math.atan2(c1x - cmx, c1y - cmy)
    a2 = math.atan2(cmx - c2x, cmy - c2y)
    if abs(abs(a1 - a2) - math.pi) < 1e-5:  # (folded back on itself: a straight line)
        t1 = t2 = _cos_sin(c1x, c1y, c2x, c2y)
    l1, r1 = _normals(c1x, c1y, t1[0], t1[1], width)
    l2, r2 = _normals(c2x, c2y, t2[0], t2[1], width)
    sides = []
    for p1, p2 in ((l1, l2), (r1, r2)):
        m = _intersection(p1, t1, p2, t2)
        sides.append([p1, m if m else ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2), p2])
    return sides


def _intersection(p1, t1, p2, t2):
    a, b, c, d = t1[1], -t1[0], t2[1], -t2[0]
    det = a * d - b * c
    if abs(det) < 1e-12:
        return None
    r1, r2 = t1[1] * p1[0] - t1[0] * p1[1], t2[1] * p2[0] - t2[0] * p2[1]
    return (d * r1 - b * r2) / det, (-c * r1 + a * r2) / det


def _wedged(bez, width, w1=1.0, wm=0.5, w2=0.0):
    """Two quadratic curves narrowing from width*w1 to width*w2 either side
    of bez (matplotlib's make_wedged_bezier2)."""
    (c1x, c1y), (cmx, cmy), (c3x, c3y) = bez
    t1 = _cos_sin(c1x, c1y, cmx, cmy)
    t2 = _cos_sin(cmx, cmy, c3x, c3y)
    l1, r1 = _normals(c1x, c1y, t1[0], t1[1], width * w1)
    l3, r3 = _normals(c3x, c3y, t2[0], t2[1], width * w2)
    c12, c23 = ((c1x + cmx) / 2, (c1y + cmy) / 2), ((cmx + c3x) / 2, (cmy + c3y) / 2)
    c123 = ((c12[0] + c23[0]) / 2, (c12[1] + c23[1]) / 2)
    t123 = _cos_sin(c12[0], c12[1], c23[0], c23[1])
    l2, r2 = _normals(c123[0], c123[1], t123[0], t123[1], width * wm)
    # (the control point of the curve through the three points at t = 0, 1/2, 1)
    ctl = lambda p, m, q: [p, (0.5 * (4 * m[0] - (p[0] + q[0])), 0.5 * (4 * m[1] - (p[1] + q[1]))), q]
    return ctl(l1, l2, l3), ctl(r1, r2, r3)


def _simple(bez, head_length, head_width, tail_width):
    """The "simple" arrow's outline (matplotlib's ArrowStyle.Simple)."""
    x2, y2 = bez[2]
    tail = None
    inside = lambda x, y: (x - x2) * (x - x2) + (y - y2) * (y - y2) < head_length * head_length
    if inside(*bez[0]) != inside(*bez[2]):
        tail, head = _clip_parts(bez, inside)
    else:  # (shorter than its head: a straight head, head_length long)
        (x1, y1) = bez[1]
        d = math.hypot(x1 - x2, y1 - y2) or 1
        x0, y0 = x2 + (x1 - x2) / d * head_length, y2 + (y1 - y2) / d * head_length
        head = [(x0, y0), ((x0 + x2) / 2, (y0 + y2) / 2), (x2, y2)]
    hl, hr = _wedged(head, head_width / 2)
    q = lambda p: "%s %s" % (_fmt(p[0]), _fmt(-p[1]))
    if tail is not None:
        tl, tr = _parallels(tail, tail_width / 2)
        return "M%sQ%s %sL%sQ%s %sQ%s %sL%sQ%s %sZ" % (q(tr[0]), q(tr[1]), q(tr[2]), q(hr[0]), q(hr[1]), q(hr[2]),
                                                      q(hl[1]), q(hl[0]), q(tl[2]), q(tl[1]), q(tl[0]))
    return "M%sQ%s %sQ%s %sZ" % (q(hr[0]), q(hr[1]), q(hr[2]), q(hl[1]), q(hl[0]))


def _clip_parts(bez, inside):
    """bez split where it crosses the region's edge, found by bisection to
    0.01 pixels, as matplotlib's split_bezier_intersecting_with_closedpath:
    it also stops when the middle point is an end's (huge coordinates, where
    halving no longer moves the point), so that the interval always shrinks;
    and after _HALVINGS steps at most, more than a double's parameter can be
    halved."""
    t0, t1 = 0.0, 1.0
    s, e = _point(bez, t0), _point(bez, t1)
    s_in = inside(*s)
    for _ in range(_HALVINGS):
        if math.hypot(s[0] - e[0], s[1] - e[1]) < 0.01:
            break
        tm = (t0 + t1) / 2
        m = _point(bez, tm)
        m_in = inside(*m)
        if s_in != m_in:
            t1 = tm
            if e == m:
                break
            e = m
        else:
            t0 = tm
            if s == m:
                break
            s, s_in = m, m_in
    return _split(bez, (t0 + t1) / 2)
