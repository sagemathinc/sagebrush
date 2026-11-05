# read_excel's bounds and refusals, Sagebrush's own (the oracle has none of
# them, so this test's .out is Sagebrush's): the zip archive's (_pd_zip.py,
# checked before anything is inflated), the XML scanner's closed grammar and
# depth (_pd_xml.py), Excel's rows and columns, and the sheet's fast path
# agreeing with the scanner, its work linear and its attributes the scanner's.
# (The decoded budget's charge for a sheet's cells: test_read_excel_budget.py.)
import io
import zlib

import pandas as pd
from pandas import _pd_excel as X
from pandas import _pd_xml as XML
from pandas import _pd_zip as Z
from pandas._pd_csv import _NoBudget
from _cases import case
from _xlsx import workbook, zip_bytes, deflate_runs, MAIN

ok_sheet = [["a", "b"], [1, "x"], [2, "y"]]


def read(data, **kw):
    df = pd.read_excel(io.BytesIO(data), **kw)
    return df.shape, list(df.columns)


def with_sheet(xml, fields=None):
    e = ("xl/worksheets/sheet1.xml", xml) + ((fields,) if fields else ())
    return workbook([("S", ok_sheet)], extra=[e])


case("control", lambda: read(workbook([("S", ok_sheet)])))

# the archive: an entry declared past 200 times its compressed size (and past 1 MiB), refused before inflating
bomb = deflate_runs(32, 3_000_000)
case("bomb data", lambda: (len(bomb), len(zlib.decompressobj(-15).decompress(bomb))))
case("ratio", lambda: read(with_sheet(b"", {"comp": bomb, "usize": 201 * len(bomb), "crc": 0})))
# an entry declared at its size inflates (3,000,000 bytes from 19,130: ratio 157), but isn't a worksheet
case("ratio 157, not XML", lambda: read(with_sheet(b"", {"comp": bomb, "usize": 3_000_000, "crc": zlib.crc32(b" " * 3_000_000) & 0xFFFFFFFF})))
# an entry that inflates past what it declares: refused at the declared size plus one byte, nothing more made
case("inflates past", lambda: read(with_sheet(b"", {"comp": bomb, "usize": 1000, "crc": 0})))
case("past 64 MiB", lambda: read(with_sheet(b"", {"comp": b"\0" * 400_000, "usize": (64 << 20) + 1, "crc": 0})))
case("entries", lambda: read(workbook([("S", ok_sheet)], extra=[("pad/%d" % i, b"") for i in range(2000)])))
# the total: with the bound lowered for the test (the workbook's own parts, then its sheet)
def total(bound):
    saved = Z.MAX_TOTAL
    Z.MAX_TOTAL = bound
    try:
        return read(workbook([("S", ok_sheet)]))
    finally:
        Z.MAX_TOTAL = saved
parts = sum(len(Z.ZipArchive(workbook([("S", ok_sheet)])).read(n)) for n in ("xl/_rels/workbook.xml.rels", "xl/workbook.xml", "xl/sharedStrings.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"))
case("total under", lambda: total(parts - 1))
case("total at", lambda: total(parts))
good = workbook([("S", ok_sheet)])
case("crc", lambda: read(with_sheet("<worksheet xmlns=\"%s\"><sheetData/></worksheet>" % MAIN, {"crc": 1})))
case("truncated", lambda: read(good[:len(good) // 2]))
case("not a zip", lambda: read(b"PK\x03\x04" + b"\0" * 100))
case("xls", lambda: read(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 100))
case("text", lambda: read(b"a,b\n1,2\n"))
case("bzip2", lambda: read(with_sheet(b"x", {"method": 12})))
case("zip64 size", lambda: read(with_sheet(b"x", {"usize": 0xFFFFFFFF})))
case("no workbook", lambda: read(zip_bytes([("[Content_Types].xml", b"<Types/>")])))

# the XML: a DOCTYPE (so no entity can be declared), another entity, CDATA, a processing instruction, and
# malformed structure, each refused with its reason
for name, xml in [
    ("doctype", '<?xml version="1.0"?><!DOCTYPE w [<!ENTITY e "x">]><worksheet xmlns="%s"><sheetData/></worksheet>' % MAIN),
    ("entity", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>' % MAIN),
    ("cdata", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[x]]></t></is></c></row></sheetData></worksheet>' % MAIN),
    ("pi", '<worksheet xmlns="%s"><?php x?><sheetData/></worksheet>' % MAIN),
    ("unclosed", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1"><v>1</v></c></sheetData></worksheet>' % MAIN),
    ("mismatched", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1"><v>1</c></v></row></sheetData></worksheet>' % MAIN),
    ("outside", '<worksheet xmlns="%s"><sheetData/></worksheet>trailing' % MAIN),
    ("char ref", '<worksheet xmlns="%s"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&#0;</t></is></c></row></sheetData></worksheet>' % MAIN),
    ("no element", "   "),
    ("two roots", '<worksheet xmlns="%s"><sheetData/></worksheet><worksheet/>' % MAIN),
    ("bad attribute", '<worksheet xmlns="%s"><sheetData><row r="1"><c r=A1><v>1</v></c></row></sheetData></worksheet>' % MAIN),
]:
    case("xml " + name, lambda xml=xml: read(with_sheet(xml)))

# the fast path and the scanner read a sheet the same, cell for cell, on every kind of cell
cells = [["n", "s", "b", "e", "i", "d", "f"]] + [[i, "s%d" % (i % 7), i % 2 == 0, ("err", "#N/A"), ("inline", "in%d" % i), ("style", 1, 40000 + i),
                                                 ("raw", "", "<f>A%d*2</f><v>%d</v>" % (i + 2, 2 * i))] for i in range(200)]
data = workbook([("S", cells)])
z = Z.ZipArchive(data)
sheets, d1904 = X._workbook(z)
strings, xfs = X._shared_strings(z), X._styles(z)
text = X._xml(z, sheets[0][1])
# (compared by repr: NaN, an error cell's value, is never equal to itself)
case("paths agree", lambda: (repr(sorted(X._fast_rows(text, strings, xfs, d1904).items())) == repr(sorted(X._scan_rows(text, strings, xfs, d1904).items())), len(X._scan_rows(text, strings, xfs, d1904))))
case("fast path taken", lambda: X._fast_rows(text, strings, xfs, d1904) is not None)
prefixed = text.replace("<sheetData>", "<sheetData >")
case("fallback taken", lambda: (X._fast_rows(prefixed, strings, xfs, d1904) is None, X._sheet_rows(z, sheets[0][1], strings, xfs, d1904, _NoBudget(), None)[:2]))


def sheet(rows_xml, open_tag="<sheetData>"):
    return '<worksheet xmlns="%s">%s%s</sheetData></worksheet>' % (MAIN, open_tag, rows_xml)


# Excel's rows and columns: a cell past either is refused before any row is made, whatever the budget
case("row past Excel's", lambda: read(with_sheet(sheet('<row r="1048577"><c r="A1048577"><v>1</v></c></row>'))))
case("column past Excel's", lambda: read(with_sheet(sheet('<row r="1"><c r="XFE1"><v>1</v></c></row>'))))
case("row past Excel's, scanner", lambda: read(with_sheet(sheet('<row r="1048577"><c r="A1048577"><v>1</v></c></row>', "<sheetData >"))))

# the fast path's work: sheetData found by find and rfind, so 200,000 openings and no close take one pass
# (a quadratic search would take minutes here), and the scanner then refuses the nesting
opens = '<worksheet xmlns="%s">' % MAIN + "<sheetData>" * 200000
case("openings, fast path", lambda: X._fast_rows(opens, strings, xfs, d1904))
case("openings, scanner", lambda: X._scan_rows(opens, strings, xfs, d1904))
closed = opens + "</sheetData>"
case("openings and one close, fast path", lambda: X._fast_rows(closed, strings, xfs, d1904))

# the scanner's depth: MAX_DEPTH elements nest, one more is refused, as are 10,000
nest = lambda n: "<a>" * n + "</a>" * n
case("max depth", lambda: XML.MAX_DEPTH)
case("depth at", lambda: len(list(XML.events(nest(XML.MAX_DEPTH)))))
case("depth past", lambda: len(list(XML.events(nest(XML.MAX_DEPTH + 1)))))
case("depth 10000", lambda: len(list(XML.events(nest(10000)))))

# the attributes: a reference in a row's or a cell's attribute, even one read nowhere, is decided by the
# scanner's grammar on both paths; the predefined and numeric ones read
ext_row = '<row r="1" ignored="&external;"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'
ext_cell = '<row r="1"><c r="A1" ignored="&external;"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>'
ok_row = '<row r="1" ignored="&amp;&#65;"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2" ignored="&lt;&#x42;"><v>2</v></c></row>'
for name, rows_xml in [("row entity", ext_row), ("cell entity", ext_cell), ("predefined", ok_row)]:
    case(name + ", fast path", lambda rows_xml=rows_xml: read(with_sheet(sheet(rows_xml))))
    case(name + ", scanner", lambda rows_xml=rows_xml: read(with_sheet(sheet(rows_xml, "<sheetData >"))))
    case(name + ", fast path falls back", lambda rows_xml=rows_xml: X._fast_rows(sheet(rows_xml), strings, xfs, d1904) is None)
