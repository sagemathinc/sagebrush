# Sage graphics: a text's fontsize is its own (W03) and its default color
# blue; the aspect ratio of parametric, polar, polygon, circle, disk and
# polyhedron plots is 1.0 (W42, W21); a circle's linestyle is drawn (W11).
import os, tempfile
t = var('t')
d = tempfile.mkdtemp()
def svg(g):
    f = os.path.join(d, "g.svg")
    g.save(f)
    return open(f).read()

P = text("LARGE", (0, 0), fontsize=40)
print("fontsize:", P[0].options()["fontsize"])
print("default fontsize:", text("d", (0, 0))[0].options()["fontsize"])
print("fontsize with axes=False:", text("x", (1, 1), fontsize=40, axes=False)[0].options()["fontsize"])
print("text with a plot:", (plot(sin(x), (x, 0, 1)) + text("a", (0.5, 0.5), fontsize=30))[1].options()["fontsize"])
print("text drawn blue:", "#0000ff" in svg(text("blue", (0, 0))).lower())
s = svg(text("red", (0, 0), color="red")).lower()
print("text drawn red:", "#ff0000" in s or 'fill="red"' in s)

for name, g in [("plot", plot(sin(x), (x, 0, 1))),
                ("parametric_plot", parametric_plot((cos(t), sin(t)), (t, 0, 2*pi))),
                ("polar_plot", polar_plot(1, (t, 0, 2*pi))),
                ("polygon", polygon([(0, 0), (1, 0), (1, 1)])),
                ("polygon2d", polygon2d([(0, 0), (1, 0), (1, 1)])),
                ("circle", circle((0, 0), 1)),
                ("disk", disk((0, 0), 1, (0, pi))),
                ("line", line([(0, 0), (1, 2)])),
                ("point", point((0, 0))),
                ("text", text("a", (0, 0))),
                ("implicit_plot", implicit_plot(x^2 + t^2 - 1, (x, -1, 1), (t, -1, 1))),
                ("contour_plot", contour_plot(x*t, (x, -1, 1), (t, -1, 1))),
                ("region_plot", region_plot(x > t, (x, -1, 1), (t, -1, 1))),
                ("polyhedron", Polyhedron(vertices=[(0, 0), (1, 0), (1, 1), (0, 1)]).plot(color='green', alpha=0.5)),
                ("circle + plot", circle((0, 0), 1) + plot(sin(x), (x, 0, 1))),
                ("plot + polygon", plot(sin(x), (x, 0, 1)) + polygon([(0, 0), (1, 0), (1, 1)])),
                ("given", parametric_plot((cos(t), sin(t)), (t, 0, 2*pi), aspect_ratio=2))]:
    print("aspect", name, g.aspect_ratio())

for ls in ("--", ":", "-.", "dashed", "dotted", "-"):
    print("circle linestyle", ls, "dasharray" in svg(circle((0, 0), 1, color='teal', linestyle=ls)))
print("polygon linestyle --", "dasharray" in svg(polygon([(0, 0), (1, 0), (1, 1)], fill=False, linestyle="--")))
print("unfilled polygon outlined:", any(c in svg(polygon([(0, 0), (1, 0), (1, 1)], fill=False, color="red")).lower() for c in ("stroke: #ff0000", 'stroke="#ff0000"', 'stroke="red"')))
for name, Q in (("segment", Polyhedron(vertices=[(0, 0), (1, 1)])), ("point", Polyhedron(vertices=[(1, 2)])),
                ("ray", Polyhedron(vertices=[(0, 0)], rays=[(1, 1)])), ("square", Polyhedron(vertices=[(0, 0), (1, 0), (1, 1), (0, 1)]))):
    print("polyhedron", name, Q.plot().aspect_ratio())
