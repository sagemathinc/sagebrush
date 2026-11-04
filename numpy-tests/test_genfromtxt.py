# np.genfromtxt (sim gap ENG-csv): missing and invalid fields, filling values, skipped rows, column checks.
import io
import os
import re
import tempfile
import warnings

import numpy as np

S = io.StringIO


def show(n, f):
    # (warnings as text here, so that their location doesn't matter)
    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")
        try:
            r = f()
            print("S%02d" % n, repr(r), r.dtype)
        except Exception as e:
            print("S%02d ERR %s: %s" % (n, type(e).__name__, e))
        for x in w:
            # (an empty input's warning names the file object: its address and module path vary)
            print("   W", x.category.__name__, re.sub(r'"<[^>]*>"', '"<file>"', str(x.message)).replace("\n", "|"))


d = tempfile.mkdtemp()
p = os.path.join(d, "d.csv")
with open(p, "w") as f:
    f.write("x,y\n1,2.5\n3,4\n5,6.25\n")
show(1, lambda: np.genfromtxt(p, delimiter=",", skip_header=1))
show(2, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=","))
show(3, lambda: np.genfromtxt(S("1,2,3\n4,N/A,6\n"), delimiter=",", missing_values="N/A"))
show(4, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", filling_values=-9))
show(5, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", filling_values={1: 99}))
show(6, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", filling_values=[7, 8, 9]))
show(7, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", dtype=int))
show(8, lambda: np.genfromtxt(S("1,abc,3\n"), delimiter=","))
show(9, lambda: np.genfromtxt(S("1,abc,3\n"), delimiter=",", filling_values=-9))
show(10, lambda: np.genfromtxt(S("1,2\n3,x\n"), delimiter=",", dtype=int))
show(11, lambda: np.genfromtxt(S("1,2.5\n3,4\n"), delimiter=",", dtype=int))
show(12, lambda: np.genfromtxt(S("1,2,3\n4,5\n7,8,9\n"), delimiter=","))
show(13, lambda: np.genfromtxt(S("1,2,3\n4,5\n6,7\n"), delimiter=","))
show(14, lambda: np.genfromtxt(S("h1\nh2\n1,2,3\n4,5\n"), delimiter=",", skip_header=2))
show(15, lambda: np.genfromtxt(S("1,2,3\n4,5\n7,8,9\n"), delimiter=",", invalid_raise=False))
show(16, lambda: np.genfromtxt(S("h\n1,2\n3,4\nfoot\n"), delimiter=",", skip_header=1, skip_footer=1))
show(17, lambda: np.genfromtxt(S("1,2\n3,4\n5,6\n"), delimiter=",", max_rows=2))
show(18, lambda: np.genfromtxt(S("h\n1,2\n3,4\n5,6\n"), delimiter=",", skip_header=1, max_rows=1))
show(19, lambda: np.genfromtxt(S("# c\n1 2 # x\n3   4\n")))
show(20, lambda: np.genfromtxt(S(" 1 , 2 \n 3 , 4 \n"), delimiter=",", autostrip=True))
show(21, lambda: np.genfromtxt(S("1,2,3\n4,5,6\n"), delimiter=",", usecols=(0, 2), unpack=True))
show(22, lambda: np.genfromtxt(S("1,2,3\n4,5,6\n"), delimiter=",", usecols=-1))
show(23, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", usecols=(1, 2), filling_values={1: 99}))
show(24, lambda: np.genfromtxt(S("1,2,3\n4,,6\n"), delimiter=",", usecols=(1, 2), filling_values=[7, 8]))
show(25, lambda: np.genfromtxt(S("1,2,3\n4,5\n"), delimiter=",", usecols=(0, 1)))
show(26, lambda: np.genfromtxt(S("1,2,3\n"), delimiter=","))
show(27, lambda: np.genfromtxt(S("5\n6\n"), delimiter=","))
show(28, lambda: np.genfromtxt(S("1,2\n"), delimiter=",", ndmin=2))
show(29, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", dtype=None))
show(30, lambda: np.genfromtxt(S("1,2\n3,\n"), delimiter=",", dtype=None))
show(31, lambda: np.genfromtxt(S("1,-,3\n4,5,NA\n"), delimiter=",", missing_values=["-", "NA"]))
show(32, lambda: np.genfromtxt(S("1,-,3\n4,5,NA\n"), delimiter=",", missing_values="-,NA"))
show(33, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", comments=None))
show(34, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", skip_footer=5))
show(35, lambda: np.genfromtxt(S("1 2\n\n3 4\n")))
show(36, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", dtype=np.float32))
show(37, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", converters={0: lambda s: float(s) * 10}))
show(38, lambda: np.genfromtxt(S("1+2j,3\n"), delimiter=",", dtype=complex))
show(39, lambda: np.genfromtxt(S("1,2;3\n"), delimiter=","))
show(40, lambda: np.genfromtxt(S("1\t2\n3\t4\n"), delimiter="\t"))
show(41, lambda: np.genfromtxt(["1,2", "3,4"], delimiter=","))
show(42, lambda: np.genfromtxt(S("1.5e3,-2\n inf,nan\n"), delimiter=","))
# the boundaries of the arguments (daybreak3's GENFROMTXT-ENG-1)
show(43, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", dtype=int, loose=False))
show(44, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", dtype=float, loose=False))
show(45, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", dtype=complex, loose=False))
show(46, lambda: np.genfromtxt(S("1,\n"), delimiter=",", loose=False))
show(47, lambda: np.genfromtxt(S("True,False\n1,0\n"), delimiter=",", dtype=bool))
show(48, lambda: np.genfromtxt(S("true,FALSE\nyes,t\n"), delimiter=",", dtype=bool))
show(49, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", dtype=bool))
show(50, lambda: np.genfromtxt(S("010203\n040506\n"), delimiter=2))
show(51, lambda: np.genfromtxt(S("1 23\n4 56\n"), delimiter=(1, 3)))
show(52, lambda: np.genfromtxt(S("1,2\n"), delimiter=",", max_rows=0))
show(53, lambda: np.genfromtxt(S("1,2\n"), delimiter=",", max_rows=-1))
show(54, lambda: np.genfromtxt(S("1,2\n3,4\n5,6\n"), delimiter=",", skip_footer=1, max_rows=2))
show(55, lambda: np.genfromtxt(S("1\n2\n"), skip_header=-1))
show(56, lambda: np.genfromtxt(S("1,2\n3,4\n"), delimiter=",", skip_footer=-1))
show(57, lambda: np.genfromtxt(S("\n\n")))
show(58, lambda: np.genfromtxt(S("# only\n# c\n")))
show(59, lambda: np.genfromtxt(S(""), ndmin=2, unpack=True))
show(60, lambda: np.genfromtxt(S(""), ndmin=2))
show(61, lambda: np.genfromtxt(S(""), ndmin=1))
show(62, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", missing_values={0: "NA"}, loose=False))
show(63, lambda: np.genfromtxt(S("NA,NA\n"), delimiter=",", missing_values={0: "NA"}, loose=False))
show(64, lambda: np.genfromtxt(S("NA,NA\n"), delimiter=",", missing_values={None: "NA"}, loose=False))
show(65, lambda: np.genfromtxt(S("NA,-\n"), delimiter=",", missing_values={1: ["-"], -2: "NA"}, loose=False))
for k, mv in enumerate([{1: "2"}, {1: ["2"]}, ["2"], {None: ["2"]}, {1: "x,2"}]):
    show(66 + k, lambda: np.genfromtxt(S("1,2\n"), delimiter=",", missing_values=mv))
# a dictionary key's column, as NumPy's: through usecols (normalized), else a
# position in the selected columns (daybreak3's case: S71)
show(71, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", usecols=-1, missing_values={1: "NA"}, loose=False))
c5 = lambda s: 5.0
for k, (uc, key) in enumerate([(None, -1), (1, -1), (-1, 1), (-1, -1), ((0, -1), 1), ((0, -1), -1)]):
    show(72 + 3 * k, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", usecols=uc, converters={key: c5}))
    show(73 + 3 * k, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", usecols=uc, missing_values="NA", filling_values={key: 7}))
    show(74 + 3 * k, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", usecols=uc, missing_values={key: "NA"}, loose=False))
show(90, lambda: np.genfromtxt(S("NA,1\n"), delimiter=",", usecols=(1, 0), missing_values={-1: "NA"}, loose=False))
show(91, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", usecols=(1, 0), missing_values={-1: "NA"}, loose=False))
show(92, lambda: np.genfromtxt(S("NA,1\n"), delimiter=",", usecols=(1, 0), missing_values="NA", filling_values={-1: 7}))
show(93, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", converters={5: c5}))
show(94, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", missing_values="NA", filling_values={5: 7}))
# a dictionary's string is one missing string; a list gives one per column
show(95, lambda: np.genfromtxt(S("a,b\n"), delimiter=",", missing_values={0: "a,b", 1: "b"}, loose=False))
show(96, lambda: np.genfromtxt(S("a,b\n"), delimiter=",", missing_values=["a", "b"], loose=False))
show(97, lambda: np.genfromtxt(S("b,a\n"), delimiter=",", missing_values=["a", "b"], loose=False))
show(98, lambda: np.genfromtxt(S("1,NA\n"), delimiter=",", missing_values="NA", filling_values=[None, 3]))
# delimiter 0 or '' (whitespace), a negative width, widths past the line, blank lines with widths
show(99, lambda: np.genfromtxt(S("123\n"), delimiter=0))
show(100, lambda: np.genfromtxt(S("1 2 3\n4 5 6\n"), delimiter=0))
show(101, lambda: np.genfromtxt(S("1 2\n"), delimiter=""))
show(102, lambda: np.genfromtxt(S("123\n"), delimiter=-1))
show(103, lambda: np.genfromtxt(S("12\n34\n"), delimiter=[1, 1, 5]))
show(104, lambda: np.genfromtxt(S("123\n"), delimiter=[2, 0, 1]))
show(105, lambda: np.genfromtxt(S("12\n\n34\n"), delimiter=[1, 1]))
show(106, lambda: np.genfromtxt(S("12\n  \n34\n"), delimiter=[1, 1]))
show(107, lambda: np.genfromtxt(S("12\n\n34\n"), delimiter=1))
show(108, lambda: np.genfromtxt(S("12\n  \n34\n"), delimiter=1))
show(109, lambda: np.genfromtxt(S("#c\n12#x\n34"), delimiter=[1, 1]))
show(110, lambda: np.genfromtxt(S("123\n"), delimiter=3))
show(111, lambda: np.genfromtxt(["12", "", "34"], delimiter=[1, 1]))
show(112, lambda: np.genfromtxt(["12\n", "\n", "34\n"], delimiter=[1, 1]))
# grader's C1-C4: a skipped empty first line; bytes and non-string missing_values (loose=False:
# the default fills any unconvertible field anyway); a filling dict for its own column only
show(113, lambda: np.genfromtxt(["", "1 2"], skip_header=1))
show(114, lambda: np.genfromtxt(S("1,x\n"), delimiter=",", missing_values=b"x", loose=False))
show(115, lambda: np.genfromtxt(S("1,True\n"), delimiter=",", missing_values=True, loose=False))
show(116, lambda: np.genfromtxt(S("1,2\n,\n"), delimiter=",", filling_values={0: 99}))
# a column name key without names=: NumPy raises too (an AttributeError of its own code; Sagebrush's
# ValueError in words is pinned in test/numpy-genfromtxt.test.ts), so only that it raises is compared
for k, kw in enumerate([{"missing_values": {"a": "x"}}, {"filling_values": {"a": 7}}, {"converters": {"a": float}}]):
    try:
        np.genfromtxt(S("1,2\n"), delimiter=",", **kw)
        print("S%d no error" % (117 + k))
    except Exception:
        print("S%d raises" % (117 + k))
