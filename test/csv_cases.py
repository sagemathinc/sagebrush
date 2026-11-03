# csv (CPython 3.14's lib/csv.py over lib/_csv.py, the port of Modules/_csv.c)
# and io.StringIO's newline: run by test/stdlib-csv.test.ts, which compares
# what this prints with what python3 prints.
import csv, io

def show(f):
    try:
        print(repr(f()))
    except Exception as e:
        print(type(e).__name__, e)

# reading: quotes, doubled quotes, embedded newlines, empty lines, dialects
data = 'a,b,c\r\n1,"two, 2","th""ree"\r\n\r\n"multi\nline",,x\r\n'
print(list(csv.reader(io.StringIO(data, newline=""))))
print(list(csv.reader(["a;b;'c;d'"], delimiter=";", quotechar="'")))
print(list(csv.reader(["a, b,  c"], skipinitialspace=True)))
print(list(csv.reader(['a\\,b,c'], escapechar="\\", quoting=csv.QUOTE_NONE)))
print(list(csv.reader(["1,2.5,'x'"], quoting=csv.QUOTE_NONNUMERIC, quotechar="'")))
print(list(csv.reader(['1,,"",2e3'], quoting=csv.QUOTE_STRINGS)))
show(lambda: list(csv.reader(['1,,"",x'], quoting=csv.QUOTE_STRINGS)))
print(list(csv.reader([',"",a'], quoting=csv.QUOTE_NOTNULL)))
print(list(csv.reader(["a\tb"], dialect="excel-tab")))
print(list(csv.reader(['"abc"def,g'])))
show(lambda: list(csv.reader(['"abc"def,g'], strict=True)))
show(lambda: list(csv.reader(['"unterminated'], strict=True)))
print(list(csv.reader(['"unterminated'])))
show(lambda: list(csv.reader(["a\rb"])))
show(lambda: list(csv.reader([b"x"])))
show(lambda: list(csv.reader(["1,x"], quoting=csv.QUOTE_NONNUMERIC)))
r = csv.reader(["a,b\n", "c,d\n"])
print(next(r), r.line_num, next(r), r.line_num, r.dialect.delimiter)

# writing
for q in (csv.QUOTE_MINIMAL, csv.QUOTE_ALL, csv.QUOTE_NONNUMERIC, csv.QUOTE_STRINGS, csv.QUOTE_NOTNULL):
    s = io.StringIO()
    w = csv.writer(s, quoting=q)
    w.writerow(["a", 'b"c', "d,e", "f\ng", 1, 2.5, None, "", True])
    w.writerows([[], [""], ["x"]] if q not in (csv.QUOTE_STRINGS, csv.QUOTE_NOTNULL) else [[], ["x"]])
    print(q, repr(s.getvalue()))
s = io.StringIO()
w = csv.writer(s, quoting=csv.QUOTE_NONE, escapechar="\\", lineterminator="\n")
w.writerow(["a,b", 'c"d', "e\\f"])
print(repr(s.getvalue()))
show(lambda: csv.writer(io.StringIO(), quoting=csv.QUOTE_NONE).writerow(["a,b"]))
show(lambda: csv.writer(io.StringIO(), quoting=csv.QUOTE_NONE).writerow([""]))
show(lambda: csv.writer(io.StringIO(), delimiter=" ", skipinitialspace=True, quoting=csv.QUOTE_NONE).writerow(["", "a"]))
show(lambda: csv.writer(io.StringIO()).writerow(5))
show(lambda: csv.writer(io.StringIO(), doublequote=False).writerow(['a"b']))
s = io.StringIO()
csv.writer(s, doublequote=False, escapechar="!").writerow(['a"b', "c!d"])
print(repr(s.getvalue()))

# dialects: classes, registry, validation and their messages
class Semi(csv.Dialect):
    delimiter = ";"
    quotechar = '"'
    doublequote = True
    skipinitialspace = False
    lineterminator = "\n"
    quoting = csv.QUOTE_MINIMAL
csv.register_dialect("semi", Semi)
print(sorted(csv.list_dialects()))
d = csv.get_dialect("semi")
print(d.delimiter, repr(d.lineterminator), d.quoting, d.doublequote, d.escapechar, d.strict)
csv.unregister_dialect("semi")
show(lambda: csv.get_dialect("semi"))
show(lambda: csv.unregister_dialect("semi"))
show(lambda: csv.register_dialect(1))
show(lambda: setattr(d, "delimiter", ","))
show(lambda: setattr(d, "strict", True))
for kw in ({"delimiter": ""}, {"delimiter": "ab"}, {"delimiter": 1}, {"delimiter": "\n"}, {"quotechar": None},
           {"quotechar": None, "quoting": csv.QUOTE_ALL}, {"quoting": 9}, {"quoting": True}, {"quoting": 2**40},
           {"escapechar": ","}, {"delimiter": ";", "quotechar": ";"}, {"lineterminator": 1},
           {"delimiter": "x", "lineterminator": "x"}, {"quotechar": " ", "skipinitialspace": True}, {"foo": 1}):
    show(lambda: csv.reader([], **kw).dialect.quoting)
show(lambda: csv.reader())
show(lambda: csv.writer(1))
show(lambda: csv.field_size_limit(1.0))
old = csv.field_size_limit(5)
show(lambda: list(csv.reader(["abcdef"])))
print(csv.field_size_limit(old), csv.field_size_limit())
show(lambda: csv.Dialect())

# DictReader, DictWriter and Sniffer (csv.py's own)
rows = list(csv.DictReader(io.StringIO("name,age\r\nann,3\r\nbob,4,extra\r\ncy\r\n", newline=""), restval="?"))
print(rows)
s = io.StringIO()
dw = csv.DictWriter(s, fieldnames=["x", "y"], extrasaction="ignore")
dw.writeheader()
dw.writerows([{"x": 1, "y": 2, "z": 3}, {"x": "a,b"}])
print(repr(s.getvalue()))
show(lambda: csv.DictWriter(io.StringIO(), ["x"]).writerow({"q": 1}))
sample = "id;name;score\n1;ann;3.5\n2;bob;4\n3;'c;y';5\n"
sn = csv.Sniffer()
dia = sn.sniff(sample)
print(dia.delimiter, repr(dia.quotechar), sn.has_header(sample))

# io.StringIO's newline, as CPython's
for nl in ("", None, "\n", "\r", "\r\n"):
    f = io.StringIO("i\rj\r\n", newline=nl)
    f.seek(0, 2)
    print(repr(nl), f.write("a\r\nb\rc\nd\r"), f.write("\ne"))
    f.seek(0)
    print(list(f), repr(f.getvalue()), f.tell())
for nl in (1, "x"):
    show(lambda: io.StringIO(newline=nl))

# round trips over a deterministic sample of awkward fields
seed = 12345
def rnd(n):
    global seed
    seed = (seed * 1103515245 + 12345) % 2**31
    return seed % n
alphabet = ['a', ',', '"', '\n', '\r', ' ', ';', '\\', "'", 'é', '\U0001F600']
bad = 0
for dialect in (dict(), dict(delimiter=";", quotechar="'"), dict(quoting=csv.QUOTE_ALL), dict(doublequote=False, escapechar="\\"),
                dict(quoting=csv.QUOTE_NONE, escapechar="\\")):
    for _ in range(150):
        row = ["".join(alphabet[rnd(len(alphabet))] for _ in range(rnd(6))) for _ in range(1 + rnd(4))]
        s = io.StringIO(newline="")
        csv.writer(s, **dialect).writerow(row)
        s.seek(0)
        back = list(csv.reader(s, **dialect))
        if back != [row] and not (row == [""] and back == [[""]]):
            bad += 1
print("round trips that differ:", bad)
