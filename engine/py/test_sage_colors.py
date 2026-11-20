"""Sage's named colors, in 3D as in 2D, against Sage's own table recorded once
(sage.plot.colors.colors_dict: fixtures/sage_colors.json): all 148 names are
accepted, and the 147 named colors have Sage's values ("automatic" keeps the
existing 3D default color, not Sage's lightblue).  The same file runs on the native wheel and in pyjs (the
site's Sage worker), so the two builds take the same set of names: each run
prints that set's size and digest, and both must equal Sage's.  (3D once took
only 37 names: cube(color='seagreen') was "unknown color" when drawn.)

    python engine/py/test_sage_colors.py
    node dist/src/cli.js engine/py/test_sage_colors.py   (the same cases in pyjs)
"""
import hashlib
import json
import os

try:
    import sagebrush.sage as S  # the native wheel
except ImportError:
    import sage_all as S  # pyjs, through the CLI: node dist/src/cli.js engine/py/test_sage_colors.py
import sage_plot3d

HERE = os.path.dirname(os.path.abspath(__file__))
SAGE = json.load(open(os.path.join(HERE, "fixtures", "sage_colors.json")))["colors"]


def main():
    bad = []
    taken = []
    checked = agree = 0
    for name, want in SAGE.items():
        try:
            got = sage_plot3d._hex(sage_plot3d._rgb(name))
        except Exception as e:
            bad.append("%s: %s" % (name, e))
            continue
        taken.append(name)
        if name == "automatic":  # (the existing 3D default color is kept: no value check)
            continue
        checked += 1
        if got == want.lower():
            agree += 1
        else:
            bad.append("%s: %s, Sage's is %s" % (name, got, want))
    # drawn, in 3D and in 2D: the name's color is in the picture
    try:
        g = S.cube(color="seagreen")
        g._repr_svg_()  # (shaded: the faces are darker or lighter than the color itself)
        if [o.get("color") for o in g._scene()["objects"]] != ["#2e8b57"]:
            bad.append("cube(color='seagreen'): its scene's color is not #2e8b57")
    except Exception as e:
        bad.append("cube(color='seagreen') not drawn: %s" % (e,))
    try:
        x = S.var("x")
        svg2 = S.plot(x ** 2, (x, 0, 1), color="seagreen")._repr_svg_()
        if "seagreen" not in svg2.lower() and "#2e8b57" not in svg2.lower():
            bad.append("plot(..., color='seagreen'): neither seagreen nor #2e8b57 in its SVG")
    except Exception as e:
        bad.append("plot(..., color='seagreen') not drawn: %s" % (e,))
    names = sorted(taken)
    digest = hashlib.sha256("\n".join(names).encode()).hexdigest()[:16]
    want_digest = hashlib.sha256("\n".join(sorted(SAGE)).encode()).hexdigest()[:16]
    print("names accepted: %d of Sage's %d, digest %s (Sage's %s)" % (len(names), len(SAGE), digest, want_digest))
    print("values: %d of %d named colors have Sage's value (\"automatic\" keeps the 3D default, not checked)" % (agree, checked))
    for b in bad:
        print("FAIL", b)
    if bad or digest != want_digest:
        raise SystemExit(1)


main()
