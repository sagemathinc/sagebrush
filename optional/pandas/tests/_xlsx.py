# A small .xlsx writer for the read_excel tests, run by both Sagebrush and the
# oracle (CPython with pandas 3.1.0 and openpyxl 3.1.5): each test writes its
# own workbooks from generic data, so no binary workbook is kept in the tree.
# workbook(sheets) gives the file's bytes for io.BytesIO.  A sheet is a list of
# rows, each a list of cells:
#   None                        no cell
#   int, float, bool, str       a number, a boolean, a shared string
#   datetime, date, time        a number styled as a date or a time
#   ("err", "#N/A")             an error cell
#   ("inline", "text")          an inline string
#   ("style", n, value)         a number in style n (see STYLES)
#   ("raw", attrs, inner)       a cell as written: <c r=".." attrs>inner</c>
# or the whole worksheet's XML as a string ("raw XML"), written as it is.
import zlib
from datetime import date, datetime, time

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "application/vnd.openxmlformats-officedocument.spreadsheetml."
# cellXfs: 0 General, 1 a built-in date (14), 2 a custom date-time, 3 a built-in time (21), 4 a percentage (no date)
STYLES = [0, 14, 164, 21, 165]
FORMATS = {164: "yyyy-mm-dd hh:mm:ss", 165: "0.00%"}


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def col_letters(j):
    s = ""
    j += 1
    while j:
        j, r = divmod(j - 1, 26)
        s = chr(65 + r) + s
    return s


def serial(v, d1904=False):
    if isinstance(v, time):
        return (v.hour * 3600 + v.minute * 60 + v.second + v.microsecond / 1e6) / 86400
    if not isinstance(v, datetime):
        v = datetime(v.year, v.month, v.day)
    base = datetime(1904, 1, 1) if d1904 else datetime(1899, 12, 30)
    d = v - base
    return d.days + (d.seconds + d.microseconds / 1e6) / 86400


def _num(x):
    return repr(x) if isinstance(x, float) else str(x)


def sheet_xml(rows, strings, d1904=False):
    out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="%s"><sheetData>' % MAIN]
    for i, row in enumerate(rows):
        out.append('<row r="%d">' % (i + 1))
        for j, v in enumerate(row):
            if v is None:
                continue
            r = "%s%d" % (col_letters(j), i + 1)
            if isinstance(v, tuple) and v[0] == "raw":
                out.append('<c r="%s"%s>%s</c>' % (r, v[1], v[2]))
            elif isinstance(v, tuple) and v[0] == "err":
                out.append('<c r="%s" t="e"><v>%s</v></c>' % (r, esc(v[1])))
            elif isinstance(v, tuple) and v[0] == "inline":
                out.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (r, esc(v[1])))
            elif isinstance(v, tuple) and v[0] == "style":
                out.append('<c r="%s" s="%d"><v>%s</v></c>' % (r, v[1], _num(v[2])))
            elif isinstance(v, bool):
                out.append('<c r="%s" t="b"><v>%d</v></c>' % (r, 1 if v else 0))
            elif isinstance(v, (int, float)):
                out.append('<c r="%s"><v>%s</v></c>' % (r, _num(v)))
            elif isinstance(v, time):
                out.append('<c r="%s" s="3"><v>%r</v></c>' % (r, serial(v)))
            elif isinstance(v, (datetime, date)):
                style = 2 if isinstance(v, datetime) and (v.hour or v.minute or v.second) else 1
                out.append('<c r="%s" s="%d"><v>%r</v></c>' % (r, style, serial(v, d1904)))
            else:
                if v not in strings:
                    strings[v] = len(strings)
                out.append('<c r="%s" t="s"><v>%d</v></c>' % (r, strings[v]))
        out.append("</row>")
    out.append("</sheetData></worksheet>")
    return "".join(out)


def styles_xml():
    fmts = "".join('<numFmt numFmtId="%d" formatCode="%s"/>' % (k, esc(v)) for k, v in sorted(FORMATS.items()))
    xfs = "".join('<xf numFmtId="%d" fontId="0" fillId="0" borderId="0" xfId="0"%s/>' % (i, ' applyNumberFormat="1"' if i else "") for i in STYLES)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="%s"><numFmts count="%d">%s</numFmts>'
            '<fonts count="1"><font/></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="%d">%s</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') % (MAIN, len(FORMATS), fmts, len(STYLES), xfs)


def workbook(sheets, d1904=False, shared_strings_xml=None, extra=()):
    """The bytes of an .xlsx with these sheets: [(name, rows or raw XML)] in order."""
    strings = {}
    parts = []
    for i, (name, rows) in enumerate(sheets):
        xml = rows if isinstance(rows, str) else sheet_xml(rows, strings, d1904)
        parts.append(("xl/worksheets/sheet%d.xml" % (i + 1), xml))
    if shared_strings_xml is None:
        items = "".join('<si><t xml:space="preserve">%s</t></si>' % esc(s) for s, _ in sorted(strings.items(), key=lambda kv: kv[1]))
        shared_strings_xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="%s" count="%d" uniqueCount="%d">%s</sst>' % (MAIN, len(strings), len(strings), items)
    n = len(sheets)
    overrides = "".join('<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="%sworksheet+xml"/>' % (i + 1, CT) for i in range(n))
    files = [
        ("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
         '<Override PartName="/xl/workbook.xml" ContentType="%ssheet.main+xml"/>%s<Override PartName="/xl/styles.xml" ContentType="%sstyles+xml"/>'
         '<Override PartName="/xl/sharedStrings.xml" ContentType="%ssharedStrings+xml"/></Types>' % (CT, overrides, CT, CT)),
        ("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>' % (PKG_REL, REL)),
        ("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="%s" xmlns:r="%s">%s<sheets>%s</sheets></workbook>' % (
            MAIN, REL, '<workbookPr date1904="1"/>' if d1904 else "<workbookPr/>",
            "".join('<sheet name="%s" sheetId="%d" r:id="rId%d"/>' % (esc(nm), i + 1, i + 1) for i, (nm, _) in enumerate(sheets)))),
        ("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="%s">%s'
         '<Relationship Id="rId%d" Type="%s/styles" Target="styles.xml"/><Relationship Id="rId%d" Type="%s/sharedStrings" Target="sharedStrings.xml"/></Relationships>' % (
             PKG_REL, "".join('<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>' % (i + 1, REL, i + 1) for i in range(n)), n + 1, REL, n + 2, REL)),
        ("xl/styles.xml", styles_xml()),
        ("xl/sharedStrings.xml", shared_strings_xml),
    ] + parts
    # (extra: (name, data[, fields]) entries, each replacing the part of its name or added)
    over = {e[0]: e for e in extra}
    files = [over.pop(f[0], f) for f in files] + list(over.values())
    return zip_bytes([(f[0], f[1].encode("utf-8") if isinstance(f[1], str) else f[1]) + tuple(f[2:]) for f in files])


def _u16(n):
    return n.to_bytes(2, "little")


def _u32(n):
    return n.to_bytes(4, "little")


def zip_bytes(files, method=8):
    """A zip of (name, bytes) or (name, bytes, {fields}): each entry deflated (method 8, raw deflate from
    zlib.compress) or stored (0); the fields, for a hand-shaped entry, replace what is written: "comp" (the
    entry's data as stored), "usize", "crc", "method", "flags"."""
    out = bytearray()
    central = bytearray()
    for f in files:
        name, data = f[0], f[1]
        o = f[2] if len(f) > 2 else {}
        nb = name.encode("utf-8")
        m = o.get("method", method)
        comp = o["comp"] if "comp" in o else (zlib.compress(data)[2:-4] if m == 8 else data)
        crc = o.get("crc", zlib.crc32(data) & 0xFFFFFFFF)
        usize = o.get("usize", len(data))
        flags = o.get("flags", 0)
        off = len(out)
        out += _u32(0x04034B50) + _u16(20) + _u16(flags) + _u16(m) + _u16(0) + _u16(0x21) + _u32(crc) + _u32(len(comp)) + _u32(usize) + _u16(len(nb)) + _u16(0) + nb + comp
        central += (_u32(0x02014B50) + _u16(20) + _u16(20) + _u16(flags) + _u16(m) + _u16(0) + _u16(0x21) + _u32(crc) + _u32(len(comp)) + _u32(usize)
                    + _u16(len(nb)) + _u16(0) + _u16(0) + _u16(0) + _u16(0) + _u32(0) + _u32(off) + nb)
    end = _u32(0x06054B50) + _u16(0) + _u16(0) + _u16(len(files)) + _u16(len(files)) + _u32(len(central)) + _u32(len(out)) + _u16(0)
    return bytes(out + central + end)


def deflate_runs(byte, n):
    """Raw deflate (fixed Huffman) of `byte` repeated n times, as matches of 258: a zip bomb's shape, written
    here bit by bit so that both sides make the same bytes (Sagebrush's zlib.compress stores, never matches)."""
    bits = []
    put = lambda v, k: bits.extend((v >> i) & 1 for i in range(k))
    code = lambda c, k: bits.extend((c >> i) & 1 for i in range(k - 1, -1, -1))
    lit = lambda x: code(0x30 + x, 8) if x < 144 else code(0x190 + x - 144, 9)
    put(1, 1); put(1, 2)
    lit(byte)
    left = n - 1
    while left >= 258 + 3:
        code(0xC5, 8)   # length 258 (symbol 285)
        code(0, 5)      # distance 1
        left -= 258
    for _ in range(left):
        lit(byte)
    code(0, 7)
    bits += [0] * (-len(bits) % 8)
    return bytes(sum(bits[i + j] << j for j in range(8)) for i in range(0, len(bits), 8))
