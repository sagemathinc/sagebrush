"""MATLAB's TeX markup: the default Interpreter ('tex') of titles, subtitles,
axis labels, legends, text and tick labels, as MATLAB's documentation of the
Text properties describes it (its "TeX Markup" table):

- ^ and _: a superscript or subscript of the next character, or of the
  characters within the curly braces;
- \\bf, \\it, \\sl (oblique: drawn italic) and \\rm, and \\fontname{name},
  \\fontsize{points}, \\color{name} and \\color[rgb]{r,g,b}: modifiers, in
  effect until the end of the text (or of the braces they are in: braces
  group, as in TeX and in Octave);
- the documented special characters (\\alpha, \\leq, \\infty, ...);
- a backslash before a markup character (\\ { } _ ^) shows the character.

Anything else after a backslash, a ^ or _ with nothing to raise or lower,
unbalanced braces, and the \\color names whose colors the documentation does
not give (gray, darkGreen, orange, lightBlue) are errors, never drawn as
text.  walk() interprets a string once; svg(), plain() and runs() are its
renderings: SVG tspans (the shim's markup hook for MATLAB's figures), the
text alone (for widths and descriptions), and the runs of the 3-D viewer's
scenes."""

import math

import _matlab as _m

# the documentation's table of special characters
SYMBOLS = {
    "alpha": "\u03b1", "angle": "\u2220", "ast": "*", "beta": "\u03b2", "gamma": "\u03b3", "delta": "\u03b4",
    "epsilon": "\u03f5", "zeta": "\u03b6", "eta": "\u03b7", "theta": "\u03b8", "vartheta": "\u03d1",
    "iota": "\u03b9", "kappa": "\u03ba", "lambda": "\u03bb", "mu": "\u03bc", "nu": "\u03bd", "xi": "\u03be",
    "pi": "\u03c0", "rho": "\u03c1", "sigma": "\u03c3", "varsigma": "\u03c2", "tau": "\u03c4",
    "equiv": "\u2261", "Im": "\u2111", "otimes": "\u2297", "cap": "\u2229", "supset": "\u2283",
    "int": "\u222b", "rfloor": "\u230b", "lfloor": "\u230a", "perp": "\u22a5", "wedge": "\u2227",
    "rceil": "\u2309", "vee": "\u2228", "upsilon": "\u03c5", "phi": "\u03d5", "chi": "\u03c7",
    "psi": "\u03c8", "omega": "\u03c9", "Gamma": "\u0393", "Delta": "\u0394", "Theta": "\u0398",
    "Lambda": "\u039b", "Xi": "\u039e", "Pi": "\u03a0", "Sigma": "\u03a3", "Upsilon": "\u03d2",
    "Phi": "\u03a6", "Psi": "\u03a8", "Omega": "\u03a9", "forall": "\u2200", "exists": "\u2203",
    "ni": "\u220b", "cong": "\u2245", "approx": "\u2248", "Re": "\u211c", "oplus": "\u2295",
    "cup": "\u222a", "subseteq": "\u2286", "in": "\u2208", "lceil": "\u2308", "cdot": "\u00b7",
    "neg": "\u00ac", "times": "\u00d7", "surd": "\u221a", "varpi": "\u03d6", "rangle": "\u232a",
    "langle": "\u2329", "sim": "~", "leq": "\u2264", "infty": "\u221e", "clubsuit": "\u2663",
    "diamondsuit": "\u2666", "heartsuit": "\u2665", "spadesuit": "\u2660", "leftrightarrow": "\u2194",
    "leftarrow": "\u2190", "Leftarrow": "\u21d0", "uparrow": "\u2191", "rightarrow": "\u2192",
    "Rightarrow": "\u21d2", "downarrow": "\u2193", "circ": "\u00ba", "pm": "\u00b1", "geq": "\u2265",
    "propto": "\u221d", "partial": "\u2202", "bullet": "\u2022", "div": "\u00f7", "neq": "\u2260",
    "aleph": "\u2135", "wp": "\u2118", "oslash": "\u2205", "supseteq": "\u2287", "subset": "\u2282",
    "o": "\u03bf", "nabla": "\u2207", "ldots": "\u2026", "prime": "\u2032", "0": "\u2205",
    "mid": "|", "copyright": "\u00a9",
}
# \color's names, with the colors the documentation's color table gives them
COLORS = {"red": "#ff0000", "green": "#00ff00", "yellow": "#ffff00", "magenta": "#ff00ff",
          "blue": "#0000ff", "black": "#000000", "white": "#ffffff"}
# \color's other documented names: their colors are not documented
UNDOCUMENTED_COLORS = ("gray", "darkGreen", "orange", "lightBlue")
MODIFIERS = ("bf", "it", "sl", "rm", "fontname", "fontsize", "color")
ESCAPES = "\\{}_^"
PT = 100 / 72  # (pixels a point, as the shim's font sizes)
SUP, SUB, SCRIPT = 0.385, -0.245, 0.7  # (a script's rise, of its parent's size; its size)


def _err(s, why):
    raise _m._err("TeX markup in '%s': %s" % (s, why))


def walk(s, emit, size):
    """interpret s; emit(text, state) for each run of text in one state:
    {size (px), rise (px, up), bold, italic (True, False or None: as the
    text's own), color (#rrggbb or None), font (or None), stack}.  stack is
    the scripts the run is in, outermost first, as (id, part): a subscript
    and a superscript on the same base, one right after the other (x_1^2,
    x^2_1), are one id, parts 0 and 1, drawn at the same place (stacked, as
    Octave draws them); any other script is an id of its own, part 0"""
    s = str(s)
    n = len(s)
    st = {"size": float(size), "rise": 0.0, "bold": None, "italic": None, "color": None, "font": None, "stack": ()}
    stack = []  # (state, the script it closes or None) at each open brace
    buf = []
    pending = []  # scripts of one character or symbol: (state to restore, script)
    ids = [0]
    last = [None]  # the script that ended last: (where, kind, id, level)

    def flush():
        if buf:
            emit("".join(buf), dict(st))
            buf.clear()

    def arg(i, what):
        # {...} after a modifier: its text, and where the markup goes on
        if i >= n or s[i] != "{":
            _err(s, "\\%s needs its argument in braces" % what)
        j = s.find("}", i)
        if j < 0:
            _err(s, "\\%s's argument has no closing brace" % what)
        return s[i + 1:j], j + 1

    def script(kind, at):
        # a superscript or subscript: smaller, raised or lowered; the other
        # kind's partner when that one ended just here, on the same base
        flush()
        level = (len(stack), len(pending))
        prev = last[0]
        if prev and prev[0] == at and prev[1] != kind and prev[3] == level:
            sid, part = prev[2], 1
        else:
            ids[0] += 1
            sid, part = ids[0], 0
        old = dict(st)
        st["rise"] += (SUP if kind == "^" else SUB) * st["size"]
        st["size"] *= SCRIPT
        st["stack"] = old["stack"] + ((sid, part),)
        return old, (kind, sid, level)

    def end_char_script():
        # (after the one character or symbol a script raised)
        while pending:
            flush()
            old, info = pending.pop()
            st.clear()
            st.update(old)
            last[0] = (i, info[0], info[1], info[2])

    i = 0
    while i < n:
        c = s[i]
        if c == "\\":
            if i + 1 >= n:
                _err(s, "a backslash at the end")
            d = s[i + 1]
            if d in ESCAPES:
                buf.append(d)
                i += 2
                end_char_script()
                continue
            j = i + 1
            while j < n and (s[j].isalpha() and s[j].isascii()):
                j += 1
            name = s[i + 1:j] if j > i + 1 else (d if d == "0" else "")
            if name == "0":
                j = i + 2
            if not name:
                _err(s, "\\%s is not TeX markup (to show a backslash, write \\\\)" % d)
            if name in SYMBOLS:
                buf.append(SYMBOLS[name])
                i = j
                end_char_script()
                continue
            if name not in MODIFIERS:
                _err(s, "\\%s is not supported (MATLAB's documented TeX markup only)" % name)
            if pending:
                _err(s, "\\%s cannot be the one character of a superscript or subscript" % name)
            flush()
            if name == "bf":
                st["bold"] = True
            elif name in ("it", "sl"):
                st["italic"] = True
            elif name == "rm":
                st["bold"], st["italic"] = False, False
            elif name == "fontname":
                v, j = arg(j, name)
                v = v.strip()
                if not v or len(v) > 64 or not all(ch.isalnum() or ch in " -_" for ch in v):
                    _err(s, "\\fontname{%s}: not a font name" % v)
                st["font"] = v
            elif name == "fontsize":
                v, j = arg(j, name)
                try:
                    pt = float(v)
                except ValueError:
                    pt = float("nan")
                if not (math.isfinite(pt) and 0 < pt <= 1000):
                    _err(s, "\\fontsize{%s}: not a size in points" % v)
                st["size"] = pt * PT
            else:  # color
                if j < n and s[j] == "[":
                    k = s.find("]", j)
                    if k < 0 or s[j + 1:k] != "rgb":
                        _err(s, "\\color[...]: only [rgb] is documented")
                    v, j = arg(k + 1, "color[rgb]")
                    try:
                        rgb = [float(t) for t in v.split(",")]
                    except ValueError:
                        rgb = []
                    if len(rgb) != 3 or not all(0 <= t <= 1 for t in rgb):
                        _err(s, "\\color[rgb]{%s}: not three values from 0 to 1" % v)
                    st["color"] = "#%02x%02x%02x" % tuple(int(round(t * 255)) for t in rgb)
                else:
                    v, j = arg(j, name)
                    if v in COLORS:
                        st["color"] = COLORS[v]
                    elif v in UNDOCUMENTED_COLORS:
                        _err(s, "\\color{%s} is not supported (its color is not documented): use \\color[rgb]{r,g,b}" % v)
                    else:
                        _err(s, "\\color{%s}: not one of the documented color names" % v)
            i = j
        elif c in "^_":
            if i + 1 >= n:
                _err(s, "%s with nothing after it" % c)
            old, info = script(c, i)
            if s[i + 1] == "{":
                stack.append((old, info))
                i += 2
            else:
                pending.append((old, info))
                i += 1
                if s[i] in "{}^_":
                    _err(s, "%s%s: a superscript or subscript of a markup character" % (c, s[i]))
                if s[i] != "\\":
                    buf.append(s[i])
                    i += 1
                    end_char_script()
        elif c == "{":
            flush()
            stack.append((dict(st), None))
            i += 1
        elif c == "}":
            if not stack:
                _err(s, "a closing brace with no opening one")
            flush()
            old, info = stack.pop()
            st.clear()
            st.update(old)
            i += 1
            if info:
                last[0] = (i, info[0], info[1], info[2])
            end_char_script()
        else:
            buf.append(c)
            i += 1
            end_char_script()
    if stack:
        _err(s, "an opening brace with no closing one")
    flush()


def check(s):
    """raise an error if s is not MATLAB's documented TeX markup"""
    walk(s, lambda t, st: None, 10.0)


def literal(s):
    """s shown as it is (Interpreter 'none'), as TeX markup: its markup characters escaped"""
    return "".join("\\" + c if c in ESCAPES else c for c in str(s))


def plain(s):
    """s's text alone (for widths and descriptions)"""
    out = []
    walk(s, lambda t, st: out.append(t), 10.0)
    return "".join(out)


def _esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _num(v):
    return ("%.2f" % v).rstrip("0").rstrip(".") or "0"


# a character's width, of its font size: Sagebrush's own rough classes, for
# the advances of stacked scripts (their exact length is set, below)
_NARROW, _SEMI, _WIDE = set("ijl!'.,:;|I`"), set('ftr()[]{}-/ "'), set("mwMW%@")


def _char_em(c):
    if c in _NARROW:
        return 0.25
    if c in _SEMI:
        return 0.33
    if c in _WIDE:
        return 0.85
    if c.isascii() and c.isupper():
        return 0.68
    if c.isdigit():
        return 0.55
    return 0.52 if c.isascii() else 0.6


def svg(s, size):
    """s as SVG tspans, in a <text> of font size size (px).  A stacked
    pair's two scripts start at the same place and the text after goes on
    from the wider: SVG text cannot be measured where it is made, so each
    run of a pair is given its length (textLength, with lengthAdjust
    spacingAndGlyphs: an estimate from _char_em, its glyphs fitted to it),
    which makes the advances exact; the second script goes back by the
    first's length, and the text after forward by the difference"""
    items = []
    walk(s, lambda t, st: items.append((t, st)), size)
    paired = {sid for t, st in items for sid, part in st["stack"] if part == 1}
    paths = [tuple((sid, part) for sid, part in st["stack"] if sid in paired) for t, st in items]
    est = [sum(_char_em(c) for c in t) * st["size"] for t, st in items]
    widths = {}  # pair id -> (its first script's length, its second's)

    def width(idx, level):
        # (a run of items: plain ones' lengths, a pair's the wider of its two)
        w, k = 0.0, 0
        while k < len(idx):
            p = paths[idx[k]]
            if len(p) <= level:
                w += est[idx[k]]
                k += 1
                continue
            sid, parts = p[level][0], ([], [])
            while k < len(idx) and len(paths[idx[k]]) > level and paths[idx[k]][level][0] == sid:
                parts[paths[idx[k]][level][1]].append(idx[k])
                k += 1
            widths[sid] = (width(parts[0], level + 1), width(parts[1], level + 1))
            w += max(widths[sid])
        return w
    width(list(range(len(items))), 0)
    out = []
    at = 0.0
    for i, (t, st) in enumerate(items):
        prev, cur = paths[i - 1] if i else (), paths[i]
        was, now = dict(prev), dict(cur)
        dx = 0.0
        for sid, part in reversed(prev):
            if sid not in now:
                # (after a pair: on from its wider script)
                w0, w1 = widths[sid]
                dx += max(w0, w1) - w1
        for sid, part in cur:
            if part == 1 and was.get(sid) != 1:
                # (a pair's second script: back to where its first began)
                dx -= widths[sid][0]
        a = []
        if abs(dx) > 1e-6:
            a.append('dx="%s"' % _num(dx))
        if abs(st["size"] - size) > 1e-6:
            a.append('font-size="%s"' % _num(st["size"]))
        if abs(st["rise"] - at) > 1e-6:
            a.append('dy="%s"' % _num(at - st["rise"]))  # (SVG's y is down)
            at = st["rise"]
        if cur:
            a.append('textLength="%s" lengthAdjust="spacingAndGlyphs"' % _num(est[i]))
        if st["bold"] is not None:
            a.append('font-weight="%s"' % ("bold" if st["bold"] else "normal"))
        if st["italic"] is not None:
            a.append('font-style="%s"' % ("italic" if st["italic"] else "normal"))
        if st["color"]:
            a.append('fill="%s"' % st["color"])
        if st["font"]:
            a.append('font-family="%s"' % _esc(st["font"]))
        out.append("<tspan %s>%s</tspan>" % (" ".join(a), _esc(t)) if a else _esc(t))
    return "".join(out)


def runs(s, base):
    """s for the 3-D viewer's scene: its text when it has no markup's effect,
    else runs {t: text, s: size and r: rise (of the text's own size, base
    pixels in the viewer: a \\fontsize's points become pixels as in the SVG),
    b, i, c: #rrggbb, f: font, j: the stacked pairs it is in, [id, part]}"""
    items = []
    walk(s, lambda t, st: items.append((t, st)), float(base))
    paired = {sid for t, st in items for sid, part in st["stack"] if part == 1}
    out = []

    def emit(t, st):
        r = {"t": t}
        if abs(st["size"] - base) > 1e-9:
            r["s"] = round(st["size"] / base, 4)
        if abs(st["rise"]) > 1e-9:
            r["r"] = round(st["rise"] / base, 4)
        j = [[sid, part] for sid, part in st["stack"] if sid in paired]
        if j:
            r["j"] = j
        for k, key in (("bold", "b"), ("italic", "i")):
            if st[k] is not None:
                r[key] = st[k]
        if st["color"]:
            r["c"] = st["color"]
        if st["font"]:
            r["f"] = st["font"]
        out.append(r)
    for t, st in items:
        emit(t, st)
    if all(len(r) == 1 for r in out):
        return "".join(r["t"] for r in out)
    return out


class Markup:
    """the shim's markup hook (_graphics.Panel's markup option): MATLAB's
    figures' text, interpreted as TeX"""

    def svg(self, s, size):
        return svg(s, size)

    def plain(self, s):
        return plain(s)


MARKUP = Markup()
