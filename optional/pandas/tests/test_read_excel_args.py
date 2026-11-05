# pandas.read_excel's checks of its reading options, compared with pandas 3.1.0
# and openpyxl 3.1.5: each invalid header, nrows, skiprows, usecols, index_col
# and sheet_name gives pandas' error, never a frame, and the valid boundaries
# beside them still read.  (A usecols of a negative position or of no column
# at all, where pandas reads an empty frame, is refused: test_unsupported.)
import io
import pandas as pd
from _cases import case, dtypes
from _xlsx import workbook

wb = workbook([("S", [["a", "b"], [1, "x"], [2, "y"], [3, "z"]]), ("T", [["c"], [9]])])


def x(**kw):
    df = pd.read_excel(io.BytesIO(wb), **kw)
    if isinstance(df, dict):
        return {k: (dtypes(v), v.shape) for k, v in df.items()}
    return (dtypes(df), df)


case("header=-1", lambda: x(header=-1))
case("header=0", lambda: x(header=0))
case("header=3", lambda: x(header=3))
case("header=4", lambda: x(header=4))
case("header=1.5", lambda: x(header=1.5))
case("header='a'", lambda: x(header="a"))
case("header=True", lambda: x(header=True))
case("nrows=-1", lambda: x(nrows=-1))
case("nrows=0", lambda: x(nrows=0))
case("nrows=1.5", lambda: x(nrows=1.5))
case("nrows=2.0", lambda: x(nrows=2.0))
case("nrows='2'", lambda: x(nrows="2"))
case("nrows=True", lambda: x(nrows=True))
case("nrows=99", lambda: x(nrows=99))
case("skiprows=-1", lambda: x(skiprows=-1))
case("skiprows=0", lambda: x(skiprows=0))
case("skiprows=[-1]", lambda: x(skiprows=[-1]))
case("skiprows=[9]", lambda: x(skiprows=[9]))
case("skiprows=4", lambda: x(skiprows=4))
case("skiprows=9", lambda: x(skiprows=9))
case("skiprows=1.5", lambda: x(skiprows=1.5))
case("usecols=['missing']", lambda: x(usecols=["missing"]))
case("usecols=['a', 'missing']", lambda: x(usecols=["a", "missing"]))
case("usecols=[5]", lambda: x(usecols=[5]))
case("usecols=[0, 5]", lambda: x(usecols=[0, 5]))
case("usecols=[1]", lambda: x(usecols=[1]))
case("usecols=[0, 'b']", lambda: x(usecols=[0, "b"]))
case("usecols=[0, 0]", lambda: x(usecols=[0, 0]))
case("usecols='A:Z'", lambda: x(usecols="A:Z"))
case("usecols='C'", lambda: x(usecols="C"))
case("usecols='B'", lambda: x(usecols="B"))
case("usecols='1'", lambda: x(usecols="1"))
case("usecols='b'", lambda: x(usecols="b"))
case("index_col=1", lambda: x(index_col=1))
case("index_col=2", lambda: x(index_col=2))
case("index_col=-1", lambda: x(index_col=-1))
case("index_col=True", lambda: x(index_col=True))
case("sheet_name=-1", lambda: x(sheet_name=-1))
case("sheet_name=1", lambda: x(sheet_name=1))
case("sheet_name=1.5", lambda: x(sheet_name=1.5))
case("sheet_name=[0, 0]", lambda: x(sheet_name=[0, 0]))
case("sheet_name=[]", lambda: x(sheet_name=[]))
case("sheet_name=True", lambda: x(sheet_name=True))
