"""Sage's named colors, in 3D as in 2D, against Sage's own table recorded once
(sage.plot.colors.colors_dict: fixtures/sage_colors.json): every name is taken,
with Sage's value.  The same file runs on the native wheel and in pyjs (the
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
    for name, want in SAGE.items():
        try:
            got = sage_plot3d._hex(sage_plot3d._rgb(name))
        except Exception as e:
            bad.append("%s: %s" % (name, e))
            continue
        taken.append(name)
        # ("automatic" is the 3D default color here, as plot3d's own default; Sage's alias of lightblue is a 2D one)
        if name != "automatic" and got != want.lower():
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
    print("names taken: %d of Sage's %d, digest %s (Sage's %s)" % (len(names), len(SAGE), digest, want_digest))
    for b in bad:
        print("FAIL", b)
    print("%d/%d Sage colors agree" % (len(SAGE) - len([b for b in bad if b.split(":")[0] in SAGE]), len(SAGE)))
    if bad or digest != want_digest:
        raise SystemExit(1)


main()
