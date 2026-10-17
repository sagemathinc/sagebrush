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
