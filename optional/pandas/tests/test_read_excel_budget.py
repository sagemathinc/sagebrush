# read_excel under a finite decoded budget (test_read_excel_budget.limits.json:
# 1 MiB), Sagebrush's own (its .out is Sagebrush's): a sheet's dense size, its
# rows by its columns from its highest cell, is charged before any row is made,
# so a few bytes of XML naming a far cell are refused under the limit, and a
# sheet whose cells fit reads.  The rows pandas doesn't ask for (nrows) are
# dropped before the charge.
import io

import pandas as pd
import sagebrush
from _cases import case
from _xlsx import workbook, MAIN


def one_cell(ref, row, extra=""):
    xml = '<worksheet xmlns="%s"><sheetData>%s<row r="%d"><c r="%s"><v>1</v></c></row></sheetData></worksheet>' % (MAIN, extra, row, ref)
    return workbook([("S", [["a"]])], extra=[("xl/worksheets/sheet1.xml", xml)])


def read(data, **kw):
    try:
        df = pd.read_excel(io.BytesIO(data), **kw)
    except ValueError as e:
        m = str(e)
        return ("refused", m.startswith("read_excel: "), "'pandas.decoded_bytes'" in m, m)
    return df.shape


case("limit", lambda: sagebrush.limit("pandas.decoded_bytes"))
# astra's: one cell at SF500, 500 rows by 500 columns
case("SF500", lambda: read(one_cell("SF500", 500)))
case("SF500 bytes", lambda: len(one_cell("SF500", 500)))
# a far row: 1,048,576 rows of one column, refused before a row is made
case("A1048576", lambda: read(one_cell("A1048576", 1048576)))
# what fits reads: one cell at SF1 (one row of 500 columns), at J10, and a far cell past the rows nrows asks for
case("SF1", lambda: read(one_cell("SF1", 1)))
case("J10", lambda: read(one_cell("J10", 10)))
near = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>'
# an entry's declared size is charged before it is inflated: a stored sheet of 1,200,000 bytes is refused
big_xml = (" " * 1200000 + '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>' % MAIN).encode()
case("entry past the budget", lambda: read(workbook([("S", [["a"]])], extra=[("xl/worksheets/sheet1.xml", big_xml, {"method": 0, "comp": big_xml})])))
case("SF500 past nrows", lambda: read(one_cell("SF500", 500, near), nrows=1))
case("SF500 without nrows", lambda: read(one_cell("SF500", 500, near)))
