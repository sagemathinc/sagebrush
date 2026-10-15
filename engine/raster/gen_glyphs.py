"""Write engine/raster/glyphs-*.bin: the outlines of DejaVu Sans and DejaVu
Sans Bold (Bitstream Vera license and public domain; see NOTICE.md) for the
characters PNG text is drawn with, as compact paths for src/font.rs.

    python3 engine/raster/gen_glyphs.py [FONTS_DIR]

FONTS_DIR has DejaVuSans.ttf and DejaVuSans-Bold.ttf (default: matplotlib's
mpl-data/fonts/ttf, the fonts matplotlib draws with).  Needs fontTools; the
output is committed, so building Sagebrush does not.

Format (little-endian): b"SBGL", u16 version (2), u16 unitsPerEm, i16
ascender, i16 descender, u32 count; then count glyphs sorted by code point:
u32 code point, u16 advance width, u32 byte length of its commands, and the
commands: b"M" p, b"L" p, b"Q" p1 p, b"Z", each point (font units, y up) as
the zigzag varints of its x and y less the glyph's previous point's (0, 0
at its start).
Kerning is a second table: u32 count, then (u32 left, u32 right, i16 value)
sorted by (left, right).  Character 0 is the .notdef glyph."""
import os
import struct
import sys

from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

# printable ASCII, Latin-1, Greek, and the blocks of symbols plots and
# matplotlib's mathtext use: general punctuation (spaces such as \, 's thin
# space, dashes, quotes, primes), super- and subscripts, currency, letterlike
# symbols (ℏ, ℝ), arrows, mathematical operators, and a few technical
# and geometric shapes (markers); those the font has.
CHARS = (list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + list(range(0x370, 0x400))
         + list(range(0x2000, 0x2070)) + list(range(0x2070, 0x20A0)) + list(range(0x20A0, 0x20D0))
         + list(range(0x2100, 0x2150)) + list(range(0x2190, 0x2200)) + list(range(0x2200, 0x2300))
         + [0x2300, 0x2308, 0x2309, 0x230A, 0x230B, 0x25A0, 0x25A1, 0x25B2, 0x25B3, 0x25BC, 0x25BD, 0x25C6, 0x25C7,
            0x25CB, 0x25CF, 0x2605, 0x2606])


def varint(v):
    """v zigzag-encoded, 7 bits a byte, low first"""
    v = (v << 1) ^ (v >> 31)
    out = bytearray()
    while v >= 128:
        out.append((v & 127) | 128)
        v >>= 7
    out.append(v)
    return bytes(out)


class Recorder(BasePen):

    def __init__(self, glyphset):
        super().__init__(glyphset)
        self.out = bytearray()
        self.last = (0, 0)

    def _xy(self, p):
        x, y = round(p[0]), round(p[1])
        d = varint(x - self.last[0]) + varint(y - self.last[1])
        self.last = (x, y)
        return d

    def _moveTo(self, p):
        self.out += b"M" + self._xy(p)

    def _lineTo(self, p):
        self.out += b"L" + self._xy(p)

    def _qCurveToOne(self, p1, p2):
        self.out += b"Q" + self._xy(p1) + self._xy(p2)

    def _curveToOne(self, p1, p2, p3):
        raise ValueError("a cubic curve in a TrueType font")

    def _closePath(self):
        self.out += b"Z"

    def _endPath(self):
        self.out += b"Z"


def kerning(font, glyph_of):
    """(left, right) -> value from the font's GPOS pair adjustments (class
    pairs too), for the characters kept"""
    out = {}
    if "GPOS" not in font:
        return out
    by_glyph = {}
    for c, g in glyph_of.items():
        by_glyph.setdefault(g, []).append(c)
    gpos = font["GPOS"].table
    for lookup in gpos.LookupList.Lookup:
        subtables = lookup.SubTable
        if lookup.LookupType == 9:
            subtables = [s.ExtSubTable for s in subtables]
        for st in subtables:
            if getattr(st, "LookupType", 2) != 2:
                continue
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for i, first in enumerate(cov):
                    for pvr in st.PairSet[i].PairValueRecord:
                        v = getattr(pvr.Value1, "XAdvance", 0) if pvr.Value1 else 0
                        if v:
                            for a in by_glyph.get(first, ()):
                                for b in by_glyph.get(pvr.SecondGlyph, ()):
                                    out.setdefault((a, b), v)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs if st.ClassDef1 else {}
                c2 = st.ClassDef2.classDefs if st.ClassDef2 else {}
                for first in cov:
                    k1 = c1.get(first, 0)
                    row = st.Class1Record[k1].Class2Record
                    for a in by_glyph.get(first, ()):
                        for second, cs in glyph_of.items():
                            k2 = c2.get(cs, 0)
                            v = getattr(row[k2].Value1, "XAdvance", 0) if row[k2].Value1 else 0
                            if v:
                                out.setdefault((a, second), v)
    return out


# Bold text is words: its symbols are drawn with the regular face's
BOLD_CHARS = [c for c in CHARS if c < 0x2070 or 0x20A0 <= c < 0x20D0]


def write(ttf, path, chars):
    font = TTFont(ttf)
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    glyph_of = {0: ".notdef"}
    for c in chars:
        if c in cmap:
            glyph_of[c] = cmap[c]
    body = bytearray()
    for c in sorted(glyph_of):
        name = glyph_of[c]
        pen = Recorder(gs)
        gs[name].draw(pen)
        body += struct.pack("<IHI", c, hmtx[name][0], len(pen.out)) + pen.out
    hhea = font["hhea"]
    head = b"SBGL" + struct.pack("<HHhhI", 2, font["head"].unitsPerEm, hhea.ascent, hhea.descent, len(glyph_of))
    kern = kerning(font, glyph_of)
    ktab = struct.pack("<I", len(kern)) + b"".join(struct.pack("<IIh", a, b, v) for (a, b), v in sorted(kern.items()))
    with open(path, "wb") as f:
        f.write(head + body + ktab)
    print("%s: %d glyphs, %d kerning pairs, %d bytes; %d of the characters asked for are not in the font"
          % (os.path.basename(path), len(glyph_of), len(kern), len(head) + len(body) + len(ktab), sum(c not in cmap for c in chars)))


def main():
    if len(sys.argv) > 1:
        d = sys.argv[1]
    else:
        import matplotlib
        d = os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf")
    here = os.path.dirname(os.path.abspath(__file__))
    write(os.path.join(d, "DejaVuSans.ttf"), os.path.join(here, "glyphs-dejavu-sans.bin"), CHARS)
    write(os.path.join(d, "DejaVuSans-Bold.ttf"), os.path.join(here, "glyphs-dejavu-sans-bold.bin"), BOLD_CHARS)


main()
