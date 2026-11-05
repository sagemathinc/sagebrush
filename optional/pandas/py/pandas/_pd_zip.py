"""A zip archive's entries, for read_excel (design-pandas-xlsx-timeseries r1,
PR B): written from the zip format's specification (PKWARE's APPNOTE),
stored and deflated entries only.

Bounded before anything is inflated: at most 2,000 entries; an entry at most
64 MiB, and at most 200 times its compressed size (or 1 MiB); 256 MiB in
all.  Each entry's declared size is checked against those bounds and charged
to pandas' decoded-memory budget when one is set (as read_csv's is); the
inflater (zlib.decompressobj) then stops at that size plus one byte, so an
entry whose data inflates past what it declares is refused without making
more.  Every entry's CRC-32 is checked.  ZIP64, encryption, multi-disk
archives and other compression methods raise NotImplementedError, as every
other gap in the subset does.
"""

import zlib

__all__ = ["ZipArchive", "BadZipFile"]

MAX_ENTRIES = 2000
MAX_ENTRY = 64 << 20
MAX_TOTAL = 256 << 20
MAX_RATIO = 200
SMALL = 1 << 20


class BadZipFile(Exception):
    """zipfile.BadZipFile: not a zip archive, or a damaged one."""


def _u16(b, i):
    return b[i] | (b[i + 1] << 8)


def _u32(b, i):
    return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)


# (zip's names without the UTF-8 flag are code page 437, as zipfile reads them; its upper half)
_CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\xa0'


def _cp437(raw):
    return "".join(chr(b) if b < 128 else _CP437_HIGH[b - 128] for b in raw)


def _subset(what):
    return NotImplementedError("pandas: %s is not in Sagebrush's pandas 0.x subset" % what)


class _Entry(object):
    __slots__ = ("name", "method", "flags", "crc", "csize", "usize", "offset")


class ZipArchive(object):
    """The entries of a zip archive held in `data` (bytes)."""

    def __init__(self, data, budget=None):
        if not isinstance(data, (bytes, bytearray)):
            raise TypeError("a zip archive is bytes")
        self._data = bytes(data)
        self._budget = budget
        self._total = 0
        self._entries = {}
        self._order = []
        self._read_directory()

    def _read_directory(self):
        d = self._data
        # (the end-of-central-directory record: in the last 65,557 bytes, its comment at most 65,535)
        start = max(0, len(d) - 65557)
        e = d.rfind(b"PK\x05\x06", start)
        if e < 0 or e + 22 > len(d):
            raise BadZipFile("File is not a zip file")
        disk, cd_disk = _u16(d, e + 4), _u16(d, e + 6)
        n, total = _u16(d, e + 8), _u16(d, e + 10)
        cd_size, cd_off = _u32(d, e + 12), _u32(d, e + 16)
        if disk or cd_disk or n != total:
            raise _subset("a zip archive spread over several disks")
        if n == 0xFFFF or cd_size == 0xFFFFFFFF or cd_off == 0xFFFFFFFF:
            raise _subset("a ZIP64 archive")
        if n > MAX_ENTRIES:
            raise ValueError("read_excel: the workbook has %d entries, more than Sagebrush's %d" % (n, MAX_ENTRIES))
        if cd_off + cd_size > e:
            raise BadZipFile("Bad offset for central directory")
        p = cd_off
        for _ in range(n):
            if p + 46 > len(d) or d[p:p + 4] != b"PK\x01\x02":
                raise BadZipFile("Bad magic number for central directory")
            ent = _Entry()
            ent.flags = _u16(d, p + 8)
            ent.method = _u16(d, p + 10)
            ent.crc = _u32(d, p + 16)
            ent.csize = _u32(d, p + 20)
            ent.usize = _u32(d, p + 24)
            nlen, xlen, clen = _u16(d, p + 28), _u16(d, p + 30), _u16(d, p + 32)
            ent.offset = _u32(d, p + 42)
            raw = d[p + 46:p + 46 + nlen]
            ent.name = raw.decode("utf-8", "replace") if ent.flags & 0x800 else _cp437(raw)
            if ent.csize == 0xFFFFFFFF or ent.usize == 0xFFFFFFFF or ent.offset == 0xFFFFFFFF:
                raise _subset("a ZIP64 archive")
            p += 46 + nlen + xlen + clen
            if ent.name not in self._entries:
                self._order.append(ent.name)
            self._entries[ent.name] = ent

    def namelist(self):
        return list(self._order)

    def __contains__(self, name):
        return name in self._entries

    def read(self, name):
        """An entry's bytes, bounded and checked (see the module's note)."""
        ent = self._entries.get(name)
        if ent is None:
            raise KeyError("There is no item named %r in the archive" % name)
        if ent.flags & 1:
            raise _subset("an encrypted workbook")
        if ent.method not in (0, 8):
            raise _subset("a zip entry compressed with method %d" % ent.method)
        bound = min(MAX_ENTRY, max(MAX_RATIO * ent.csize, SMALL))
        if ent.usize > bound:
            raise ValueError("read_excel: the workbook's entry %r would inflate to %d bytes, past Sagebrush's bound of %d"
                             % (name, ent.usize, bound))
        if self._total + ent.usize > MAX_TOTAL:
            raise ValueError("read_excel: the workbook's entries would inflate to more than %d bytes in all" % MAX_TOTAL)
        d = self._data
        o = ent.offset
        if o + 30 > len(d) or d[o:o + 4] != b"PK\x03\x04":
            raise BadZipFile("Bad magic number for file header")
        start = o + 30 + _u16(d, o + 26) + _u16(d, o + 28)
        comp = d[start:start + ent.csize]
        if len(comp) != ent.csize:
            raise BadZipFile("Truncated file header")
        if self._budget is not None:
            self._budget.charge(ent.usize, "a workbook entry")
        if ent.method == 0:
            out = comp
        else:
            z = zlib.decompressobj(-15)
            # (one byte past the declared size: an entry that inflates past it is refused, nothing more made)
            out = z.decompress(comp, ent.usize + 1)
            if len(out) > ent.usize or (not z.eof and len(out) == ent.usize):
                raise BadZipFile("The workbook's entry %r inflates past its declared size" % name)
            if not z.eof:
                raise BadZipFile("The workbook's entry %r is truncated" % name)
        if len(out) != ent.usize:
            raise BadZipFile("The workbook's entry %r is not its declared size" % name)
        if zlib.crc32(out) & 0xFFFFFFFF != ent.crc:
            raise BadZipFile("Bad CRC-32 for file %r" % name)
        self._total += ent.usize
        return out
