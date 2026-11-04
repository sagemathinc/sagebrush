# read_csv's errors, as pandas 3.1.0 raises them: their class, module and
# message (plan-pandas-m1-r1 §3.2).
import io
import pandas as pd


def err(label, text, **kw):
    print("== " + label)
    try:
        df = pd.read_csv(io.StringIO(text), **kw)
        print(repr(df))
    except Exception as e:
        print("!! %s.%s: %s" % (type(e).__module__, type(e).__name__, e))


err("empty", "")
err("blank-only", "\n\n  \n")
err("later-too-many", "a,b\n1,2\n3,4,5\n")
err("later-too-many-blank-lines", "a,b\n\n1,2\n\n3,4,5\n")
err("too-many-quoted", 'a,b\n"x",2\n"y",4,5\n')
err("unterminated-quote", 'a,b\n"x,1\n')
err("unterminated-quote-later", 'a,b\n1,2\n3,"x\n4,5\n')
err("usecols-missing", "a,b,c\n1,2,3\n", usecols=["z"])
err("dtype-int-text", "a,b\nx,2\n", dtype={"a": "int64"})
err("dtype-int-na", "a\n1\nNA\n", dtype={"a": "int64"})
err("dtype-float-text", "a\n1\nx\n", dtype={"a": "float64"})
err("nrows-negative", "a\n1\n", nrows=-1)
err("names-duplicate", "1,2\n", names=["x", "x"])
err("index-col-missing", "a,b\n1,2\n", index_col="z")
err("header-past-end", "a\n1\n", header=5)
