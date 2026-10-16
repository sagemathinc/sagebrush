"""src/runtime/casefold-data.ts: Python 3.14's str.casefold() as a table, from
CPython's own (run under CPython 3.14: python3.14 scripts/gen-casefold.py > src/runtime/casefold-data.ts)."""
import sys, unicodedata
out = []
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    c = chr(cp)
    f = c.casefold()
    if f != c:
        out.append("%x:%s" % (cp, ",".join("%x" % ord(x) for x in f)))
body = ";".join(out)
print("// Python 3.14's str.casefold() (Unicode %s full case folding, CaseFolding.txt's\n// C and F mappings), generated from CPython's own str.casefold: each code point\n// whose folding differs from it, as hex `cp:folded,...`, `;` between\n// (src/runtime/types.ts casefold). Regenerate: python3.14 scripts/gen-casefold.py\nexport const CASEFOLD =\n  %s;" % (unicodedata.unidata_version, repr(body).replace("'", '"')))
print(len(out), file=sys.stderr)
