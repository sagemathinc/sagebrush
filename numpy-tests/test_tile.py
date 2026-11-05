# np.tile, as NumPy 2.5.1's: the result is always a new array, never the input or a view of it (every count 1
# included: writing to the result leaves the input alone); a zero count empties its axis; a negative count is
# refused while the input has elements; a float count only where every count is 1.
import numpy as np
def show(tag, f):
    try:
        r = f()
    except Exception as e:
        print(tag, "->", type(e).__name__, str(e)[:80]); return
    a = np.asarray(r)
    print(tag, "->", type(r).__name__, a.shape, a.dtype, a.tolist())
a = np.array([1, 2]); m = np.array([[1, 2], [3, 4]])
for reps in (0, (0,), (0, 1), (1, 0), (2, 0), (0, 2), (0, 0), (0, 1, 1), (3, 0, 2), (1, 1, 0), [0], [2, 0]):
    show("tile 1-d %r" % (reps,), lambda: np.tile(a, reps))
    show("tile 2-d %r" % (reps,), lambda: np.tile(m, reps))
show("tile empty (0,3) x (2,1)", lambda: np.tile(np.zeros((0, 3)), (2, 1)))
show("tile empty (0,3) x 0", lambda: np.tile(np.zeros((0, 3)), 0))
show("tile 0-d x 0", lambda: np.tile(np.array(5), 0))
show("tile 0-d x ()", lambda: np.tile(np.array(5), ()))
show("tile scalar x 0", lambda: np.tile(5, 0))
show("tile scalar x (0, 2)", lambda: np.tile(5.0, (0, 2)))
show("tile float32 x 0", lambda: np.tile(np.array([1.5], np.float32), 0))
show("tile bool x (2, 0)", lambda: np.tile(np.array([True]), (2, 0)))
show("tile complex x 0", lambda: np.tile(np.array([1j]), 0))
show("tile str x 0", lambda: np.tile(np.array(["ab"]), 0))
show("tile np.int64(0)", lambda: np.tile(a, np.int64(0)))
show("tile (np.int64(0), 1)", lambda: np.tile(m, (np.int64(0), 1)))
show("tile True", lambda: np.tile(a, True))
show("tile False", lambda: np.tile(a, False))
show("tile -1", lambda: np.tile(a, -1))
show("tile (2, -1)", lambda: np.tile(m, (2, -1)))
show("tile (-1, 0)", lambda: np.tile(m, (-1, 0)))
show("tile 1.0", lambda: np.tile(a, 1.0))
show("tile 0.0", lambda: np.tile(a, 0.0))
show("tile ()", lambda: np.tile(m, ()))
r = np.tile(m, (0, 1)); show("tile 0 base None", lambda: r.base is None)
show("tile 0 writeable", lambda: r.flags.writeable)
show("tile 0 contiguous", lambda: r.flags.c_contiguous)
nc = np.arange(6).reshape(2, 3).T
show("tile non-contiguous x (0, 2)", lambda: np.tile(nc, (0, 2)))
show("tile non-contiguous x (2, 1)", lambda: np.tile(nc, (2, 1)))
# (the copy: write to the result, then read the input)
for tag, mk in [("tile(m, 1)", lambda: np.tile(m, 1)), ("tile(m, (1, 1))", lambda: np.tile(m, (1, 1))),
                ("tile(m, ())", lambda: np.tile(m, ())), ("tile(m, 1.0)", lambda: np.tile(m, 1.0)),
                ("tile(m, True)", lambda: np.tile(m, True)), ("tile(m, np.int64(1))", lambda: np.tile(m, np.int64(1))),
                ("tile(m, [1, 1, 1])", lambda: np.tile(m, [1, 1, 1])), ("tile(m, (2, 1))", lambda: np.tile(m, (2, 1))),
                ("tile(m.T, 1)", lambda: np.tile(m.T, 1)), ("tile(a, (1, 1))", lambda: np.tile(a, (1, 1)))]:
    m = np.array([[1, 2], [3, 4]]); a = np.array([1, 2])
    r = mk()
    r.flat[0] = 99
    print(tag, "->", r.shape, "input after writing the result:", m.tolist(), a.tolist())
# (negative and float counts)
for tag, f in [("-1", lambda: np.tile(a, -1)), ("(2, -1)", lambda: np.tile(m, (2, -1))), ("(-1, 0)", lambda: np.tile(m, (-1, 0))),
               ("(2.0, -1)", lambda: np.tile(m, (2.0, -1))), ("2.0", lambda: np.tile(a, 2.0)), ("0.0", lambda: np.tile(a, 0.0)),
               ("1.0 of a list", lambda: np.tile([1, 2], 1.0)), ("(1.0, 2)", lambda: np.tile(m, (1.0, 2))),
               ("empty x -1", lambda: np.tile(np.zeros(0), -1)), ("empty (0,2) x (-1, 1)", lambda: np.tile(np.zeros((0, 2)), (-1, 1))),
               ("np.array([2, 2])", lambda: np.tile(a, np.array([2, 2])))]:
    show("tile " + tag, f)
# (an empty input with a negative count: NumPy only reshapes, a negative length being its one unknown dimension;
# grader's A8 cases first)
for s, r in [((0, 3), (1, -1)), ((3, 0), (-2, 1)), ((0, 3), (-1, 1)), ((0, 3), (1, -2)), ((0, 2, 3), (1, 1, -1)),
             ((0, 2, 3), (1, -1, 1)), ((0, 2, 3), (1, -1, -1)), ((2, 0), (-1, -1)), ((2, 0, 3), (-1, 1, 1)),
             ((0, 3), (2, -1)), ((0,), (-1,)), ((0, 5), (-1, -1)), ((4, 0), (1, -3)), ((0, 3), (-1,)), ((0, 3), (3, 1, -1))]:
    show("tile zeros%r x %r" % (s, r), lambda: np.tile(np.zeros(s), r))
