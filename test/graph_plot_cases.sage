# Graph.plot (lib/_sage_graph.py): checked by test/graph-plot.test.ts
import math, re, _graph_spring
# named graphs at their positions; others laid out by _graph_spring
C = graphs.CycleGraph(4)
assert C.get_pos()[0] == (0.0, 1.0) and C.get_pos()[1] == (-1.0, 0.0), C.get_pos()
assert graphs.PetersenGraph().get_pos()[5] == (0.0, 0.5)
assert C.copy().get_pos() == C.get_pos() and Graph(C).get_pos() == C.get_pos()
print(repr(C.plot()))
G = Graph([(0, 1), (1, 2), (2, 0), (2, 3)])
assert G.get_pos() is None
G.plot(save_pos=True)
pos = G.get_pos()
raw = _graph_spring.spring_layout([("v%d" % i, 20, 20, None) for i in range(4)], [("v0", "v1"), ("v0", "v2"), ("v1", "v2"), ("v2", "v3")], 0, None)
for i in range(4):
    assert pos[i] == ((raw["v%d" % i][0] + 10) / 64, -(raw["v%d" % i][1] + 10) / 64), (i, pos[i])
# the same every time
same = lambda: re.sub(r"sbclip\d+", "", Graph([(0, 1), (1, 2), (2, 0), (2, 3)]).plot()._svg())
assert same() == same()
# layout='circular' and pos
assert G.plot(layout='circular', save_pos=True) and G.get_pos()[0] == (0.0, 1.0)
P = G.plot(pos={0: (0, 0), 1: (1, 0), 2: (1, 1), 3: (0, 1)})
print(P.get_minmax_data())
# primitives: an edge each, a points per colour, a text per label
print(repr(digraphs.Circuit(3).plot(edge_labels=True)))
print(repr(Graph([(0, 1), (1, 2)]).plot(partition=[[0, 2], [1]])))
print(repr(Graph([(0, 1), (1, 2)]).plot(vertex_colors={'red': [0], 'blue': [1, 2]}, vertex_labels=False)))
L = Graph([(0, 0), (0, 1)], loops=True)
print(repr(L.plot(edge_labels=True)))
# colours: color_by_label, edge_colors, partition
svg = Graph([(0, 1, 'a'), (1, 2, 'b')]).plot(color_by_label=True)._svg()
assert 'stroke="#ff0000"' in svg and 'stroke="#00ffff"' in svg, svg[:300]
svg = Graph([(0, 1), (1, 2)]).plot(edge_colors={'green': [(1, 2)]})._svg()
assert svg.count('stroke="green"') == 1 or svg.count('stroke="#008000"') == 1, svg
svg = Graph([(0, 1), (1, 2)]).plot(partition=[[0, 2], [1]])._svg()
assert svg.count('fill="#ff0000"') == 2 and svg.count('fill="#00ffff"') == 1
# a digraph's arrow stops at its head's marker (12.73 + 1 pixels short)
svg = DiGraph([(0, 1)]).plot(pos={0: (0, 0), 1: (1, 0)})._svg()
cx = [float(c) for c in re.findall(r'<circle cx="([-0-9.]+)"', svg)]
tip = float(re.search(r'<path d="M([-0-9.]+) [-0-9.]+L[-0-9.]+ [-0-9.]+L[-0-9.]+ [-0-9.]+Z" fill', svg).group(1))
assert abs((max(cx) - tip) - (math.sqrt(200) * 0.9 + 1)) < 0.02, (cx, tip)
# edge labels on a white box (edge_labels_background), or none
_rects = lambda **kw: Graph([(0, 1, 'a')]).plot(edge_labels=True, **kw)._svg().count('<rect')
assert _rects() == _rects(edge_labels_background='transparent') + 1, (_rects(), _rects(edge_labels_background='transparent'))
# a directed edge and its reverse: two arrows apart, not one on the other
svg = DiGraph([(0, 1), (1, 0)]).plot(pos={0: (0, 0), 1: (1, 0)})._svg()
ys = sorted({m for m in re.findall(r'<path d="M[-0-9.]+ ([-0-9.]+)L', svg)})
assert len(ys) >= 2 and abs(float(ys[0]) - float(ys[-1])) > 5, ys
# astra's CORR-896: callables (1), vertex_colors over partition (2),
# unhashable labels (3), loop_size the radius (4), arrowshorten at both
# ends (5), text backgrounds with any alignment and rotation (6)
from _graphics import to_color
G3 = Graph([(0, 1, 'x'), (1, 2, 'y')])
p3 = {0: (0, 0), 1: (4, 0), 2: (4, 2)}
svg = G3.plot(pos=p3, vertex_labels=lambda v: 'VERTEX' + str(v))._svg()
assert all('VERTEX%d' % i in svg for i in range(3)), "CORR-896-1 labels"
svg = G3.plot(pos=p3, color_by_label=lambda l: 'green')._svg()
assert svg.count('stroke="%s"' % to_color('green')) == 2, "CORR-896-1 colours"
svg = G3.plot(pos=p3, partition=[[0, 1, 2]], vertex_colors={'blue': [0, 1, 2]})._svg()
assert svg.count('fill="%s"' % to_color('blue')) == 3 and 'fill="#ff0000"' not in svg, "CORR-896-2"
print(repr(Graph([(0, 1, [1, 2])]).plot()), repr(Graph([(0, 1, [1, 2])]).plot(color_by_label={'a': 'red'}, edge_labels=True)))
try:
    Graph([(0, 1, [1, 2])]).plot(color_by_label=True)
except NotImplementedError as e:
    print("refused:", e)
L2 = Graph([(0, 0)], loops=True).plot(pos={0: (0, 0)}, loop_size=0.2)
ring = [q for q in L2 if q.kind == "line" and len(q.xs) == 49][0]
assert abs((max(ring.xs) - min(ring.xs)) / 2 - 0.2) < 1e-9 and abs((max(ring.ys) - min(ring.ys)) / 2 - 0.2) < 1e-9, "CORR-896-4"
assert min(abs(math.hypot(x, y)) for x, y in zip(ring.xs, ring.ys)) < 0.02, "CORR-896-4: the loop passes by its vertex"
def _shaft(svg):
    m = re.search(r'<path d="M([-0-9.]+) [-0-9.]+L([-0-9.]+) [-0-9.]+" stroke', svg)
    tip = re.search(r'<path d="M([-0-9.]+) [-0-9.]+L[-0-9.]+ [-0-9.]+L[-0-9.]+ [-0-9.]+Z" fill', svg)
    return float(m.group(1)), float(tip.group(1))
t0, h0 = _shaft(arrow((0, 0), (1, 0))._svg())
t1, h1 = _shaft(arrow((0, 0), (1, 0), arrowshorten=20)._svg())
assert abs((t1 - t0) - 20 * 100 / 72 / 2) < 0.02 and abs((h0 - h1) - 20 * 100 / 72 / 2) < 0.02, ("CORR-896-5", t0, t1, h0, h1)
for kw in [dict(), dict(rotation=45), dict(horizontal_alignment='left'), dict(horizontal_alignment='right'), dict(vertical_alignment='top'), dict(vertical_alignment='bottom')]:
    with_bg = text('hello', (0, 0), background_color='yellow', **kw)._svg()
    assert with_bg.count('<rect') == text('hello', (0, 0), **kw)._svg().count('<rect') + 1, ("CORR-896-6", kw)
    assert ('rotate(' in with_bg.split('<rect')[-1].split('/>')[0]) == ('rotation' in kw), ("CORR-896-6 rotation", kw)
# edge_style
assert 'stroke-dasharray' in Graph([(0, 1)]).plot(edge_style='dashed')._svg()
for bad in [dict(vertex_shape='s'), dict(layout='planar'), dict(heights={0: [0]}), dict(by_component=False)]:
    try:
        G.plot(**bad)
        print("not refused", bad)
    except NotImplementedError as e:
        print("refused:", e)
try:
    G.plot(edge_style='wavy')
except ValueError as e:
    print("ValueError:", e)
try:
    G.show3d()
except NotImplementedError as e:
    print("refused:", e)
# a graph beyond the caps is refused, not drawn wrong, whatever its layout
# (HARD-856-1)
import itertools
B = Graph(1501)
for kw in [{}, dict(layout='circular'), dict(pos={v: (v, 0) for v in range(1501)})]:
    try:
        B.plot(**kw)
        print("not refused", list(kw))
    except NotImplementedError as e:
        print("refused:", e)
B.set_pos({v: (v, 0) for v in range(1501)})
try:
    B.plot()
except NotImplementedError as e:
    print("refused (stored positions):", e)
# endless or too many items in the colour options are refused, not read
# forever (HARD-856-2, HARD-856-3)
T = Graph([(0, 1), (1, 2)])
for kw in [dict(edge_colors={'red': itertools.repeat((0, 1))}), dict(partition=[itertools.count()]),
           dict(partition=itertools.repeat([0])), dict(vertex_colors={'red': itertools.count()}),
           dict(edge_colors={'red': [(0, 1)] * 20001})]:
    try:
        T.plot(**kw)
        print("not refused", list(kw))
    except NotImplementedError as e:
        print("refused:", e)
# within them, repeats are fine
print(repr(T.plot(edge_colors={'red': [(0, 1)] * 100}, partition=[[0, 0, 2], [1]])))
print("ok")
