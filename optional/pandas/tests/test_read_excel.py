# pandas.read_excel on workbooks this program writes (tests/_xlsx.py), compared
# with pandas 3.1.0 and openpyxl 3.1.5: values and their types, dates in both
# systems and times, the parser's inference of each column, the header and the
# reading options, and the parts of the format a sheet may be written in.
import io
from datetime import date, datetime, time
import pandas as pd
from _cases import case, dtypes
from _xlsx import workbook, MAIN

B = lambda *a, **k: io.BytesIO(workbook(*a, **k))


def show(df):
    return (dtypes(df), [[repr(v) for v in df[c].tolist()] for c in df.columns], df)


basic = [["n", "f", "s", "b", "d"],
         [1, 1.5, "x", True, date(2020, 1, 31)],
         [2, -2.25, "y", False, date(1999, 12, 31)],
         [3, 1e300, "zz z", True, datetime(2021, 6, 1, 12, 30, 15)]]
case("basic", lambda: show(pd.read_excel(B([("S", basic)]))))
case("basic.index", lambda: pd.read_excel(B([("S", basic)])).index)
case("basic.columns", lambda: pd.read_excel(B([("S", basic)])).columns)

# numbers: an integral float is an int; a fraction, a float; a huge one exact
case("numbers", lambda: show(pd.read_excel(B([("S", [["a", "b", "c"], [1.0, 0.1, 123456789012345], [2, 3.0, -7], [10 ** 15, 2.5e-10, 0]])]))))
# missing cells: NaN; a column of ints with one missing, float64; trailing empties trimmed
case("missing", lambda: show(pd.read_excel(B([("S", [["a", "b", "c"], [1, None, "x"], [None, None, None], [3, 4, None], [None]])]))))
# bools: alone a bool column; with a gap, float64; with ints, int64
case("bools", lambda: show(pd.read_excel(B([("S", [["a", "b", "c"], [True, True, 1], [False, None, True], [True, False, 2]])]))))
# errors are NaN; an inline string; a string cell with a formula's cached value
case("cell types", lambda: show(pd.read_excel(B([("S", [["e", "i", "f"], [("err", "#N/A"), ("inline", "in line"), ("raw", ' t="str"', "<f>A1&amp;B1</f><v>ab</v>")],
                                                          [("err", "#DIV/0!"), ("inline", "two"), ("raw", "", "<f>1+1</f><v>2</v>")]])]))))
# dates: the 1900 system (Excel's 29 February 1900 serial 60), the 1904 system, times, a non-date style
case("dates 1900", lambda: show(pd.read_excel(B([("S", [["d"], [("style", 1, 59)], [("style", 1, 61)], [("style", 1, 1)], [("style", 2, 44197.75)]])]))))
case("dates 1904", lambda: show(pd.read_excel(B([("S", [["d", "t"], [date(2020, 2, 29), time(6, 30)], [date(1904, 1, 2), time(23, 59, 59)]])], d1904=True))))
case("times", lambda: show(pd.read_excel(B([("S", [["t", "p"], [time(0, 0, 1), ("style", 4, 0.125)], [time(12, 0), ("style", 4, 1)]])]))))
case("date gap", lambda: show(pd.read_excel(B([("S", [["d"], [date(2020, 1, 1)], [None], [date(2020, 1, 3)]])]))))

# the parser's inference on the reader's values (pandas' _infer_types)
infer = {
    "empty": [None] * 4,
    "numstr": ["1.5", "2", " 3 ", "1e3"],
    "mixnum": [1, "2.5", 3, "4"],
    "na": ["N/A", "NA", "null", "nan"],
    "mixna": [1, "N/A", 2, "#N/A"],
    "bad": ["1,000", "0x10", "inf", "1_000"],
    "boolstr": ["True", "FALSE", "true", "TRUE"],
    "strtext": ["1", "abc", 2, None],
    "spaces": [" ", "  ", None, "1"],
    "onena": [None, "N/A", None, None],
    "intstr": ["1", "2", "3", "-4"],
    "boolmix": [True, "N/A", False, None],
    "numbool": [1, True, 2.5, None],
    "nanstr": ["-NaN", "-nan", "1.#IND", "<NA>"],
    "infs": ["inf", "-Infinity", "INF", "1"],
    "points": ["1.", ".5", "+3", "1E5"],
}
rows = [list(infer)] + [[infer[k][i] for k in infer] for i in range(4)]
case("inference", lambda: show(pd.read_excel(B([("S", rows)]))))

# the header: Unnamed for an empty one, duplicates numbered, numbers kept as numbers, header=None and header=1
hdr = [["a", None, "a", 7, "a.1", 2.5], [1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]]
case("header", lambda: list(pd.read_excel(B([("S", hdr)])).columns))
case("header=None", lambda: show(pd.read_excel(B([("S", hdr)]), header=None)))
case("header=1", lambda: show(pd.read_excel(B([("S", hdr)]), header=1)))
case("header-only", lambda: show(pd.read_excel(B([("S", [["a", "b"]])]))))
case("empty sheet", lambda: show(pd.read_excel(B([("S", [])]))))
case("header gap", lambda: show(pd.read_excel(B([("S", [["a", None, "c"], [None, None, None]])]))))

# the options: nrows, skiprows, usecols, index_col, sheet_name
long = [["k", "v", "w"]] + [[i, i * 1.5, "r%d" % i] for i in range(12)]
case("nrows", lambda: show(pd.read_excel(B([("S", long)]), nrows=3)))
case("nrows=0", lambda: show(pd.read_excel(B([("S", long)]), nrows=0)))
case("skiprows int", lambda: show(pd.read_excel(B([("S", long)]), skiprows=4, nrows=2)))
case("skiprows list", lambda: show(pd.read_excel(B([("S", long)]), skiprows=[1, 3, 5])))
case("usecols letters", lambda: show(pd.read_excel(B([("S", long)]), usecols="A,C", nrows=2)))
case("usecols range", lambda: show(pd.read_excel(B([("S", long)]), usecols="B:C", nrows=2)))
case("usecols ints", lambda: show(pd.read_excel(B([("S", long)]), usecols=[0, 2], nrows=2)))
case("usecols names", lambda: show(pd.read_excel(B([("S", long)]), usecols=["w", "k"], nrows=2)))
case("index_col", lambda: show(pd.read_excel(B([("S", long)]), index_col=0, nrows=3)))
case("index_col dates", lambda: pd.read_excel(B([("S", [["d", "x"], [date(2020, 1, 1), 1], [date(2020, 2, 1), 2]])]), index_col=0))
two = [("First", [["a"], [1]]), ("Second", [["b"], ["x"], ["y"]]), ("Third", [])]
case("sheet_name int", lambda: show(pd.read_excel(B(two), sheet_name=1)))
case("sheet_name str", lambda: show(pd.read_excel(B(two), sheet_name="Second")))
case("sheet_name list", lambda: {k: show(v) for k, v in pd.read_excel(B(two), sheet_name=[0, "Second"]).items()})
case("sheet_name None", lambda: sorted((k, v.shape) for k, v in pd.read_excel(B(two), sheet_name=None).items()))
case("sheet_name missing", lambda: pd.read_excel(B(two), sheet_name="Nope"))
case("sheet_name past", lambda: pd.read_excel(B(two), sheet_name=5))

# the format: shared strings with rich text and phonetic runs, entities, CR LF, a reference, xml:space
sst = ('<?xml version="1.0" encoding="UTF-8"?>\r\n<sst xmlns="%s"><si><t>h</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t>ch</t></r></si>'
       '<si><t>ph</t><rPh sb="0" eb="1"><t>XX</t></rPh></si><si><t>a &amp; b &lt;c&gt; &#233;&#x4E2D;</t></si><si><t>line1\r\nline2\rline3</t></si>'
       '<si><t xml:space="preserve">  pad  </t></si><si><t>&#13;cr</t></si></sst>') % MAIN
cells = "".join('<row r="%d"><c r="A%d" t="s"><v>%d</v></c></row>' % (i + 1, i + 1, i) for i in range(7))
case("strings", lambda: show(pd.read_excel(B([("S", '<worksheet xmlns="%s"><sheetData>%s</sheetData></worksheet>' % (MAIN, cells))], shared_strings_xml=sst))))
# the same cells in the forms the fast path leaves to the scanner: a prefix, other attribute orders, no references
forms = ('<x:worksheet xmlns:x="%s"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>k</x:t></x:is></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>v</x:t></x:is></x:c></x:row>'
         '<x:row r="2"><x:c r="A2"><x:v>1</x:v></x:c><x:c r="B2"><x:v>2.5</x:v></x:c></x:row></x:sheetData></x:worksheet>') % MAIN
case("prefixed", lambda: show(pd.read_excel(B([("S", forms)]))))
order = ('<worksheet xmlns="%s"><sheetData><row r="1" spans="1:2"><c t="inlineStr" r="A1"><is><t>k</t></is></c><c t="inlineStr" r="B1"><is><t>v</t></is></c></row>'
         "<row r='2'><c s='0' r='A2'><v>1</v></c><c r='B2' s='0' t='n'><v>2.5</v></c></row><row><c><v>3</v></c><c><v>4</v></c></row></sheetData></worksheet>") % MAIN
case("attribute orders", lambda: show(pd.read_excel(B([("S", order)]))))
gaps = ('<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="C1" t="inlineStr"><is><t>c</t></is></c></row>'
        '<row r="4"><c r="B4"><v>2</v></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>') % MAIN
case("row and column gaps", lambda: show(pd.read_excel(B([("S", gaps)]))))
# (the same sheet read by the scanner: "<sheetData >" isn't the fast path's form)
case("row and column gaps, scanner", lambda: show(pd.read_excel(B([("S", gaps.replace("<sheetData>", "<sheetData >"))]))))
# a cell whose reference names another row than its row element: a plain cell, and one in the form the fast
# path's general pattern reads (t before r); both paths read them as openpyxl does
moved = ('<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c></row>'
         '<row r="2"><c r="A2"><v>1</v></c><c r="B4"><v>2</v></c></row><row r="3"><c t="inlineStr" r="A5"><is><t>x</t></is></c><c r="B3"><v>3</v></c></row>'
         '</sheetData></worksheet>') % MAIN
case("cell in another row", lambda: show(pd.read_excel(B([("S", moved)]))))
case("cell in another row, scanner", lambda: show(pd.read_excel(B([("S", moved.replace("<sheetData>", "<sheetData >"))]))))

# what isn't a workbook: pandas' errors
case("bytes", lambda: pd.read_excel(workbook([("S", [["a"]])])))
case("not a file", lambda: pd.read_excel(12))
case("encrypted", lambda: pd.read_excel(B([("S", [["a"]])], extra=[("xl/worksheets/sheet1.xml", b"x", {"flags": 1})])))
