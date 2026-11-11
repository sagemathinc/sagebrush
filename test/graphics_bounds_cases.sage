# Graphics bounds as drawn, Sagebrush only (test/graphics-bounds.test.ts; grader's r918 P10, G2, G1): a range set with
# set_axes_range or xmin(v) is the drawn x range (the SVG's data-xr), a graph's picture drawn before a range change
# drops its canvas view after it (the SVG is redrawn), and a graph's picture keeps the margin range its plot set.
import re
def xr(svg):
    m = re.search(r'data-xr="([^"]*)"', svg)
    return m.group(1) if m else None
G = line([(0, 0), (2, 3)])
print("plain", xr(G._svg()))
G.set_axes_range(xmin=-5)
print("set_axes_range(xmin=-5)", xr(G._svg()))
H = line([(0, 0), (2, 3)]); H.xmin(-5)
print("xmin(-5)", xr(H._svg()))
P = graphs.PathGraph(3).plot()
print("graph range set", P.get_axes_range()["xmin"] < P.get_minmax_data()["xmin"] and P.get_axes_range()["xmax"] > P.get_minmax_data()["xmax"])
print("graph view before", "application/vnd.sagebrush.graph+json" in P._repr_mimebundle_())
P.xmin(-5)
b = P._repr_mimebundle_()
print("graph view after xmin(-5)", "application/vnd.sagebrush.graph+json" in b, xr(b["image/svg+xml"]).split()[0])
