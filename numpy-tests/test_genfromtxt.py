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
