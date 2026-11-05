"""A closed-grammar XML scanner for a workbook's parts (design-pandas-xlsx-
timeseries r1, PR B): elements, attributes, text, the five predefined
entities and numeric character references, comments, and the XML
declaration.  A DOCTYPE, an entity of any other name, CDATA and any other
processing instruction are refused (ValueError), so there is no external
entity and no entity expansion.  It holds no tree: `events(text)` yields
("start", name, attrs), ("end", name) and ("text", str) in order, an empty
element giving its start and end.  Names keep their prefix ("x:c"); `local`
drops it.
"""

import re

__all__ = ["events", "local"]

# (a tag, its quoted attribute values allowed to hold ">", as XML lets them; text; or a stray "<")
_TOKEN = re.compile(r"<(?:[^<>\"']|\"[^\"]*\"|'[^']*')*>|[^<]+|<")
_NAME = r"[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?"
_START = re.compile(r"<(" + _NAME + r")((?:\s+" + _NAME + r"\s*=\s*(?:\"[^\"<]*\"|'[^'<]*'))*)\s*(/?)>")
_END = re.compile(r"</(" + _NAME + r")\s*>")
_ATTR = re.compile(r"(" + _NAME + r")\s*=\s*(?:\"([^\"<]*)\"|'([^'<]*)')")
_REF = re.compile(r"&(?:(lt|gt|amp|quot|apos)|#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6}));")
_NAMED = {"lt": "<", "gt": ">", "amp": "&", "quot": '"', "apos": "'"}


def _bad(what):
    return ValueError("read_excel: the workbook's XML has %s, which Sagebrush doesn't read" % what)


def _unescape(s):
    if "&" not in s:
        return s
    out = []
    i = 0
    while True:
        j = s.find("&", i)
        if j < 0:
            out.append(s[i:])
            return "".join(out)
        out.append(s[i:j])
        m = _REF.match(s, j)
        if not m:
            raise _bad("an entity other than the five predefined ones")
        if m.group(1):
            out.append(_NAMED[m.group(1)])
        else:
            cp = int(m.group(2)) if m.group(2) else int(m.group(3), 16)
            if cp == 0 or cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
                raise _bad("a character reference to no character")
            out.append(chr(cp))
        i = m.end()


def local(name):
    i = name.find(":")
    return name if i < 0 else name[i + 1:]


def events(text):
    """The scanner's events over a decoded document (see the module's note)."""
    stack = []
    pos = 0
    # (XML's end-of-line handling, before anything is read: CR LF and a lone CR are LF; a character
    # reference &#13; is decoded later, so it stays a CR)
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("﻿"):
        pos = 1
    if text.startswith("<?xml", pos):
        end = text.find("?>", pos)
        if end < 0:
            raise _bad("an unterminated XML declaration")
        pos = end + 2
    n = len(text)
    while pos < n:
        if text.startswith("<!--", pos):
            end = text.find("-->", pos + 4)
            if end < 0:
                raise _bad("an unterminated comment")
            pos = end + 3
            continue
        if text.startswith("<!", pos):
            raise _bad("a DOCTYPE, a CDATA section or another declaration")
        if text.startswith("<?", pos):
            raise _bad("a processing instruction")
        m = _TOKEN.match(text, pos)
        tok = m.group(0)
        pos = m.end()
        if tok[0] != "<":
            if stack:
                yield ("text", _unescape(tok))
            elif tok.strip():
                raise _bad("text outside the document element")
            continue
        if tok.startswith("</"):
            e = _END.fullmatch(tok)
            if not e:
                raise _bad("a malformed end tag")
            if not stack or stack.pop() != e.group(1):
                raise _bad("an end tag that closes no start tag of its name")
            yield ("end", e.group(1))
            continue
        s = _START.fullmatch(tok)
        if not s:
            raise _bad("a malformed tag")
        attrs = {}
        for a in _ATTR.finditer(s.group(2)):
            v = a.group(2) if a.group(2) is not None else a.group(3)
            attrs[a.group(1)] = _unescape(v)
        yield ("start", s.group(1), attrs)
        if s.group(3):
            yield ("end", s.group(1))
        else:
            stack.append(s.group(1))
    if stack:
        raise _bad("an element with no end")
