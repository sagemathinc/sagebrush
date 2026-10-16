# numpy functions given the wrong number of arguments raise as NumPy's do
# (a probe of every public numpy callable with 12 and with 0 arguments found
# these two answering)
import numpy as np


def kind(f):
    try:
        r = f()
    except Exception as e:
        return type(e).__name__ + ': ' + str(e)
    return repr(r)


a = np.arange(6.0).reshape(2, 3)
for label, f in [
    ('gradient 12', lambda: np.gradient(*[1] * 12)),
    ('gradient 1-D, two spacings', lambda: np.gradient(np.arange(5.0), 1, 1)),
    ('gradient 2-D, three spacings', lambda: np.gradient(a, 1, 2, 3)),
    ('gradient 2-D, an array for both axes', lambda: np.gradient(a, np.arange(2.0))),
    ('gradient 1-D', lambda: np.gradient(np.array([1.0, 4.0, 9.0, 16.0]))),
    ('gradient 1-D, scalar', lambda: np.gradient(np.array([1.0, 4.0, 9.0, 16.0]), 2.0)),
    ('gradient 1-D, coordinates', lambda: np.gradient(np.array([1.0, 4.0, 9.0, 16.0]), np.array([0.0, 1.0, 3.0, 6.0]))),
    ('gradient 2-D, one scalar', lambda: [g.tolist() for g in np.gradient(a, 2.0)]),
    ('gradient 2-D, two spacings', lambda: [g.tolist() for g in np.gradient(a, 1.0, 0.5)]),
    ('result_type none', lambda: np.result_type()),
    ('result_type', lambda: np.result_type(np.int8, 1.5)),
]:
    print(label, kind(f))
# coordinates must be 1-D and as long as their axis; edge_order 1 or 2 (CORR-CDE-1)
y = np.arange(4.0) ** 2
m = np.arange(12.0).reshape(3, 4) ** 2
for label, f in [
    ('coords too short', lambda: np.gradient(y, np.arange(3.0))),
    ('coords too long', lambda: np.gradient(y, np.arange(5.0))),
    ('coords 2-D', lambda: np.gradient(y, np.arange(4.0).reshape(2, 2))),
    ('axis 1 short', lambda: np.gradient(m, np.arange(3.0), axis=1)),
    ('axis -1 short', lambda: np.gradient(m, np.arange(3.0), axis=-1)),
    ('axis 1 coords', lambda: np.gradient(m, np.array([0.0, 1.0, 3.0, 4.0]), axis=1).tolist()),
    ('axis 0 coords', lambda: np.gradient(m, np.array([0.0, 2.0, 3.0]), axis=0).tolist()),
    ('even coords', lambda: np.gradient(y, np.array([0.0, 0.5, 1.0, 1.5])).tolist()),
    ('edge 2', lambda: np.gradient(y, edge_order=2).tolist()),
    ('edge 2 scalar', lambda: np.gradient(y, 0.5, edge_order=2).tolist()),
    ('edge 2 coords', lambda: np.gradient(y, np.array([0.0, 1.0, 3.0, 6.0]), edge_order=2).tolist()),
    ('edge 2, 2-D', lambda: [g.tolist() for g in np.gradient(m, edge_order=2)]),
    ('edge 3', lambda: np.gradient(y, edge_order=3)),
    ('edge 2, too short', lambda: np.gradient(np.array([1.0, 2.0]), edge_order=2)),
]:
    print(label, kind(f))
