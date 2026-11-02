# The replay layer's test vectors (replay-layer r2, 3973f5ae, plus the
# grader's X1-X5): ONE source for every fixture and for expected.json.
# Synthetic only: no corpus data, no real credentials.  Run under CPython:
#   python3 -I test/sbdata/make.py OUTDIR
# OUTDIR/expected.json: {row: {"family", "root", "cwd", "program", "expect"}},
# "root" and "cwd" relative to OUTDIR/<row>/ (each row its own tree);
# "program" is the Python the CLI runs (with the probe prelude, PRELUDE),
# "expect" its exact one-line output.  H rows are checked by the test itself.
import hashlib
import json
import os
import shutil
import sys

OUT = sys.argv[1]
CANARY = "SBCANARY0123456789abcdef"
U = "https://example.org/data.csv"
rows = {}

# (the probe prelude: one result line per program, exact grammar:
#   KEY <key> | REFUSED <code> | OK <n> | SERVED <sha256> <extra> |
#   URLERROR <code> canary=<0|1> | HTTPERROR <code> <ctype> <sha256> canary=<0|1>)
PRELUDE = r'''
import hashlib, urllib.request, urllib.error, _sbdata
CANARY = "SBCANARY0123456789abcdef"
def _canary(e):
    parts = [str(e), repr(e), str(getattr(e, "reason", "")), str(getattr(e, "url", "")), str(getattr(e, "filename", "")), repr(getattr(e, "args", ""))]
    return int(any(CANARY in p for p in parts))
def fetch(url, extra=lambda r: "", **kw):
    try:
        req = urllib.request.Request(url, **kw) if kw else url
        with urllib.request.urlopen(req) as r:
            b = r.read()
            print("SERVED", hashlib.sha256(b).hexdigest(), extra(r))
    except urllib.error.HTTPError as e:
        print("HTTPERROR", e.code, e.headers.get("Content-Type"), hashlib.sha256(e.read()).hexdigest(), "canary=%d" % _canary(e))
    except urllib.error.URLError as e:
        print("URLERROR", str(e.reason).split(":", 1)[0], "canary=%d" % _canary(e))
def key(m, u):
    try:
        print("KEY", _sbdata.key(m, u))
    except _sbdata.Refused as e:
        print("REFUSED", e.code)
def load(d):
    try:
        print("OK", len(_sbdata.load(d)))
    except _sbdata.Refused as e:
        print("REFUSED", e.code)
'''


def sha(b):
    return hashlib.sha256(b).hexdigest()


def entry(url, body=b"x", method="GET", status=200, **over):
    from urllib.parse import urlsplit
    e = {"endpoint": "import", "url": url, "method": method, "status": status, "fetched_at": "2026-11-01T00:00:00Z",
         "sha256": sha(body), "size": len(body), "content_type": "text/csv", "via": "import",
         "source": urlsplit(url).hostname, "terms": "test-terms", "recorded_by": "fixture"}
    e.update(over)
    return e


def manifest(entries, **top):
    m = {"format": "sagebrush-data", "version": 1, "revision": 1, "entries": entries}
    m.update(top)
    return m


def keyof(e):
    # (the fixtures are written with keys the rules give; B14 overrides)
    return "%s %s" % (e["method"], e["url"])


def write_snapshot(d, entries, blobs=(), raw=None):
    os.makedirs(os.path.join(d, ".sagebrush-data", "blobs", "sha256"), exist_ok=True)
    p = os.path.join(d, ".sagebrush-data", "snapshot.json")
    if raw is not None:
        open(p, "wb").write(raw)
    else:
        open(p, "w").write(json.dumps(manifest({keyof(e): e for e in entries})))
    for b in blobs:
        h = sha(b)
        os.makedirs(os.path.join(d, ".sagebrush-data", "blobs", "sha256", h[:2]), exist_ok=True)
        open(os.path.join(d, ".sagebrush-data", "blobs", "sha256", h[:2], h), "wb").write(b)


def row(rid, family, program, expect, root="root", cwd="root", setup=None):
    base = os.path.join(OUT, rid)
    os.makedirs(os.path.join(base, "root"), exist_ok=True)
    if setup:
        setup(base)
    rows[rid] = {"family": family, "root": root, "cwd": cwd, "program": PRELUDE + program, "expect": expect}


# ---------------------------------------------------------------- A: keys
A = [
    ("A1", "GET", "HTTPS://Example.ORG/a?x=1", "KEY GET https://example.org/a?x=1"),
    ("A2", "GET", "https://example.org./a", "KEY GET https://example.org/a"),
    ("A3", "GET", "https://example.org:443/a", "KEY GET https://example.org/a"),
    ("A4", "GET", "http://example.org:80/a", "KEY GET http://example.org/a"),
    ("A5", "GET", "https://example.org:8443/a", "KEY GET https://example.org:8443/a"),
    ("A6", "GET", "https://example.org/a#frag", "KEY GET https://example.org/a"),
    ("A7", "GET", "https://example.org/a?b=2&a=1&b=1&c=", "KEY GET https://example.org/a?b=2&a=1&b=1&c="),
    ("A8", "GET", "https://example.org/%7euser/x", "KEY GET https://example.org/~user/x"),
    ("A9", "GET", "https://example.org/%41b", "KEY GET https://example.org/Ab"),
    ("A10", "GET", "https://example.org/a%2fb", "KEY GET https://example.org/a%2Fb"),
    ("A11", "GET", "https://example.org/a?q=%7e%2f", "KEY GET https://example.org/a?q=~%2F"),
    ("A12", "GET", "https://example.org/a%zz", "REFUSED url"),
    ("A13", "GET", "https://example.org/a%", "REFUSED url"),
    ("A14", "GET", "https://example.org", "KEY GET https://example.org/"),
    ("A15", "GET", "https://example.org/a/./b", "REFUSED url"),
    ("A16", "GET", "https://example.org/a/../c", "REFUSED url"),
    ("A17", "GET", "https://example.org/../a", "REFUSED url"),
    ("A18", "GET", "https://example.org/a/%2E%2E/b", "REFUSED url"),
    ("A19", "GET", "https://user:pw@example.org/a", "REFUSED url"),
    ("A20", "GET", "https:///a", "REFUSED url"),
    ("A21", "GET", "https://example.org../a", "REFUSED url"),
    ("A22", "GET", "https://127.0.0.1/a", "REFUSED url"),
    ("A23", "GET", "https://[::1]/a", "REFUSED url"),
    ("A24a", "GET", "https://example.org:0/a", "REFUSED url"),
    ("A24b", "GET", "https://example.org:65536/a", "REFUSED url"),
    ("A25", "GET", "https://example.org/a b", "REFUSED url"),
    ("A26", "GET", "https://example.org/a\x00", "REFUSED url"),
    ("A27", "GET", "https://b\u00fccher.example/a", "REFUSED url"),
    ("A28", "HEAD", "https://example.org/a", "KEY HEAD https://example.org/a"),
    ("A29a", "POST", "https://example.org/a", "REFUSED method"),
    ("A29b", "PUT", "https://example.org/a", "REFUSED method"),
    ("A29c", "DELETE", "https://example.org/a", "REFUSED method"),
    ("A30a", "GET", "ftp://example.org/a", "REFUSED url"),
    ("A30b", "GET", "file:///etc/passwd", "REFUSED url"),
    ("A30c", "GET", "data:,x", "REFUSED url"),
]
for rid, m, u, exp in A:
    row(rid, "A", "key(%r, %r)\n" % (m, u), exp)

# ---------------------------------------------------------------- B: manifests
GOOD = [entry(U, b"one"), entry("https://example.org/two.csv", b"two")]


def B(rid, exp, entries=None, raw=None, top=None):
    def setup(base):
        d = os.path.join(base, "root")
        if raw is not None:
            write_snapshot(d, [], raw=raw)
        else:
            es = entries if entries is not None else GOOD
            m = manifest({keyof(e): e for e in es})
            if top:
                m.update(top)
            write_snapshot(d, [], raw=json.dumps(m).encode())
    row(rid, "B", "load('.sagebrush-data')\n", exp, setup=setup)


def without(field):
    e = entry(U)
    del e[field]
    return [e]


B("B1", "OK 2")
B("B2", "REFUSED unknown-key", top={"extra": "x"})
B("B3", "REFUSED unknown-key", entries=[entry(U, extra="x")])
B("B4", "REFUSED bad-value:version", top={"version": 2})
B("B5", "REFUSED bad-value:format", top={"format": "x"})
for f in ["endpoint", "url", "method", "status", "fetched_at", "sha256", "size", "content_type", "via", "source", "terms", "recorded_by"]:
    if f in ("url", "method"):
        # (the entry's key is still written from the fixture values)
        e = entry(U)
        k = keyof(e)
        del e[f]
        B("B6-" + f, "REFUSED missing:" + f, raw=json.dumps(manifest({k: e})).encode())
    else:
        B("B6-" + f, "REFUSED missing:" + f, entries=without(f))
B("B7a", "REFUSED bad-value:sha256", entries=[entry(U, sha256=sha(b"x").upper())])
B("B7b", "REFUSED bad-value:sha256", entries=[entry(U, sha256=sha(b"x")[:63])])
B("B7c", "REFUSED bad-value:sha256", entries=[entry(U, sha256="../" + sha(b"x")[3:])])
B("B8a", "REFUSED bad-value:size", entries=[entry(U, size=-1)])
B("B8b", "REFUSED bad-value:size", entries=[entry(U, size="5")])
B("B8c", "REFUSED literal", raw=json.dumps(manifest({"GET " + U: entry(U, size=1)})).replace('"size": 1', '"size": true').encode())
B("B8d", "REFUSED number", raw=json.dumps(manifest({"GET " + U: entry(U, size=1)})).replace('"size": 1', '"size": 1.0').encode())
B("B8e", "REFUSED number", raw=json.dumps(manifest({"GET " + U: entry(U, size=1)})).replace('"size": 1', '"size": 1e3').encode())
many = [entry("https://example.org/f%d" % i) for i in range(2001)]
B("B9a", "OK 2000", entries=many[:2000])
B("B9b", "REFUSED cap:entries", entries=many)
long_url = lambda n: "https://example.org/" + "a" * (n - len("https://example.org/"))
B("B10a", "OK 1", entries=[entry(long_url(2048))])
B("B10b", "REFUSED cap:url", entries=[entry(long_url(2049))])
B("B10c", "OK 1", entries=[entry(long_url(2048), method="HEAD")])
B("B10d", "REFUSED cap:url", entries=[entry(long_url(2049), method="HEAD")])
# (B10e: the url at its cap, its entry key one byte over the DERIVED key bound,
# len("HEAD") + 1 + 2048 = 2053: the key alone is refused, X6)
B("B10e", "REFUSED cap:key", raw=json.dumps(manifest({"HEAD " + long_url(2048) + "x": entry(long_url(2048), method="HEAD")})).encode())
B("B11a", "OK 1", entries=[entry(U, recorded_by="r" * 512)])
B("B11b", "REFUSED cap:recorded_by", entries=[entry(U, recorded_by="r" * 513)])
B("B11c", "OK 1", entries=[entry(U, content_type="t" * 512)])
B("B11d", "REFUSED cap:content_type", entries=[entry(U, content_type="t" * 513)])
B("B12", "REFUSED duplicate-key", raw=json.dumps(manifest({})).replace('"entries": {}', '"entries": {}, "entries": {}').encode())
dup_entry = json.dumps(manifest({"GET " + U: entry(U)})).replace('"via": "import"', '"via": "import", "via": "import"').encode()
B("B13", "REFUSED duplicate-key", raw=dup_entry)
B("B14", "REFUSED key-mismatch", raw=json.dumps(manifest({"GET https://example.org/other": entry(U)})).encode())
B("B15a", "REFUSED bad-value:via", entries=[entry(U, via="x")])
B("B15b", "REFUSED missing:converted_from", entries=[entry(U, via="converted")])
B("B16a", "OK 10", entries=[entry("https://example.org/b%d" % i, size=50_000_000) for i in range(10)])
B("B16b", "REFUSED cap:folder", entries=[entry("https://example.org/b%d" % i, size=50_000_000) for i in range(10)] + [entry("https://example.org/b10", size=1)])
B("B17a", "OK 1", entries=[entry(U, size=50_000_000)])
B("B17b", "REFUSED cap:size", entries=[entry(U, size=50_000_001)])
base_m = json.dumps(manifest({"GET " + U: entry(U)})).encode()
B("B18a", "OK 1", raw=base_m + b" " * (8_000_000 - len(base_m)))
B("B18b", "REFUSED too-large", raw=base_m + b" " * (8_000_001 - len(base_m)))
B("B19", "REFUSED depth", raw=json.dumps(manifest({"GET " + U: entry(U)})).replace('"etag_placeholder"', '').replace('"via": "import"', '"via": "import", "etag": {"x": "y"}').encode())
B("B20", "REFUSED array", raw=json.dumps(manifest({})).replace('"entries": {}', '"entries": []').encode())
B("B21a", "REFUSED encoding", raw=b"\xef\xbb\xbf" + base_m)
B("B21b", "REFUSED encoding", raw=base_m.replace(b'"fixture"', b'"fix\xffture"'))
B("B22a", "REFUSED not-json", raw=b"{")
B("B22b", "REFUSED array", raw=b"[]")
B("B23a", "REFUSED bad-value:url", raw=json.dumps(manifest({"GET " + U: entry(U)})).replace('"url": "%s"' % U, '"url": "%s\\n"' % U).encode())
B("B23b", "REFUSED bad-value:url", raw=json.dumps(manifest({"GET " + U: entry(U)})).replace('"url": "%s"' % U, '"url": "%s\\u0000"' % U).encode())
B("B24", "REFUSED bad-value:source", entries=[entry(U, source="other.example")])
B("B25a", "REFUSED fred", entries=[entry("https://api.stlouisfed.org/fred/series/observations?series_id=X")])
B("B25b", "REFUSED fred", entries=[entry("https://fred.stlouisfed.org/graph/fredgraph.csv?id=X")])
B("B26", "REFUSED number", raw=json.dumps(manifest({"GET " + U: entry(U, size=1)})).replace('"size": 1', '"size": ' + "9" * 10000).encode())
B("B27", "REFUSED bad-value:revision", top={"revision": 0})
B("B28", "REFUSED bad-value:url", entries=[entry("https://example.org/a?api_key=x")])

# ---------------------------------------------------------------- C: blobs
BODY = b"a,b\n1,2\n"


def C(rid, exp, mutate=None, body=BODY, entries=None, program=None):
    def setup(base):
        d = os.path.join(base, "root")
        write_snapshot(d, entries or [entry(U, body)], [body])
        if mutate:
            mutate(d, sha(body))
    row(rid, "C", program or "fetch(%r)\n" % U, exp, setup=setup)


def blobp(d, h):
    return os.path.join(d, ".sagebrush-data", "blobs", "sha256", h[:2], h)


def flip(d, h):
    p = blobp(d, h)
    b = bytearray(open(p, "rb").read()); b[0] ^= 1; open(p, "wb").write(bytes(b))


def trunc(d, h):
    p = blobp(d, h)
    open(p, "wb").write(open(p, "rb").read()[:-1])


def extend(d, h):
    p = blobp(d, h)
    open(p, "ab").write(b"!")


def missing(d, h):
    os.remove(blobp(d, h))


def blob_symlink(d, h):
    p = blobp(d, h)
    outside = os.path.join(d, "..", "outside-copy")
    shutil.copyfile(p, outside)
    os.remove(p)
    os.symlink(os.path.abspath(outside), p)


def blobs_dir_symlink(d, h):
    b = os.path.join(d, ".sagebrush-data", "blobs")
    shutil.move(b, os.path.join(d, "..", "blobs-real"))
    os.symlink(os.path.abspath(os.path.join(d, "..", "blobs-real")), b)


def xx_dir_symlink(d, h):
    x = os.path.join(d, ".sagebrush-data", "blobs", "sha256", h[:2])
    shutil.move(x, os.path.join(d, "..", "xx-real"))
    os.symlink(os.path.abspath(os.path.join(d, "..", "xx-real")), x)


def blob_dir(d, h):
    os.remove(blobp(d, h))
    os.mkdir(blobp(d, h))


def fifo(d, h):
    os.remove(blobp(d, h))
    os.mkfifo(blobp(d, h))


def hardlink_inside(d, h):
    p = blobp(d, h)
    other = os.path.join(d, "same-bytes")
    os.rename(p, other)
    os.link(other, p)


def hardlink_outside(d, h):
    p = blobp(d, h)
    other = os.path.join(d, "..", "outside-same-bytes")
    os.rename(p, other)
    os.link(other, p)


S = sha(BODY)
# (C1 installs the test hook: production never calls it (H5); the re-read
# mutant calls it between verify and a second read, which then serves b"swapped")
C("C1", "SERVED %s " % S, program="_sbdata._test_after_verify = lambda p: open(p, 'wb').write(b'swapped')\nfetch(%r)\n" % U)
C("C2", "URLERROR invalid-blob canary=0", flip)
C("C3", "URLERROR invalid-blob canary=0", trunc)
C("C4", "URLERROR invalid-blob canary=0", extend)
C("C5", "URLERROR invalid-blob canary=0", missing)
C("C6", "URLERROR invalid-blob canary=0", blob_symlink)
C("C7", "URLERROR invalid-blob canary=0", blobs_dir_symlink)
C("C8", "URLERROR invalid-blob canary=0", xx_dir_symlink)
C("C9", "URLERROR invalid-blob canary=0", blob_dir)
# (C10a: a FIFO, no writer: the test's 5 s deadline turns a hang into FAIL;
# C10b: a FIFO whose writer, started by the test, sends exactly BODY: only
# the regular-file check refuses it)
C("C10a", "URLERROR invalid-blob canary=0", fifo)
C("C10b", "URLERROR invalid-blob canary=0", fifo)
rows["C10b"]["fifo_writer"] = BODY.decode()
C("C11", "SERVED %s " % sha(b""), body=b"")
C("C12", "SERVED %s " % S, hardlink_inside)
C("C13", "URLERROR invalid-blob canary=0", entries=[entry(U, BODY, size=len(BODY) + 1)])
# (C14a/b: astra X3 937c14f9: an outside-root hard link is served when the
# bytes verify (inode provenance not guaranteed, disclosed); changed, a miss)
C("C14a", "SERVED %s " % S, hardlink_outside)
C("C14b", "URLERROR invalid-blob canary=0", lambda d, h: (hardlink_outside(d, h), open(os.path.join(d, "..", "outside-same-bytes"), "r+b").write(b"Z")))

# ---------------------------------------------------------------- D: scope


def D(rid, exp, setup, root="root", cwd="root"):
    row(rid, "D", "fetch(%r)\n" % U, exp, root=root, cwd=cwd, setup=setup)


def snap_at(path, body=BODY):
    os.makedirs(path, exist_ok=True)
    write_snapshot(path, [entry(U, body)], [body])


D("D1", "SERVED %s " % S, lambda b: (os.makedirs(os.path.join(b, "root/a/b")), snap_at(os.path.join(b, "root/a"))), cwd="root/a/b")
NEAR = b"near\n"
D("D2", "SERVED %s " % sha(NEAR), lambda b: (snap_at(os.path.join(b, "root/a")), snap_at(os.path.join(b, "root/a/b"), NEAR)), cwd="root/a/b")
D("D3", "SERVED %s " % S, lambda b: snap_at(os.path.join(b, "root")))
D("D4", "URLERROR no-snapshot canary=0", lambda b: (snap_at(b), os.makedirs(os.path.join(b, "root/a"))), cwd="root/a")


def poisoned(kind):
    def setup(b):
        snap_at(os.path.join(b, "root"))
        a = os.path.join(b, "root/a")
        os.makedirs(a)
        t = os.path.join(a, ".sagebrush-data")
        if kind == "symlink":
            snap_at(os.path.join(b, "elsewhere"))
            os.symlink(os.path.join(b, "elsewhere/.sagebrush-data"), t)
        elif kind == "file":
            open(t, "w").write("x")
        elif kind == "badjson":
            os.makedirs(t)
            open(os.path.join(t, "snapshot.json"), "w").write("{")
        elif kind == "nomanifest":
            os.makedirs(t)
        elif kind == "manifest-symlink":
            os.makedirs(t)
            snap_at(os.path.join(b, "elsewhere"))
            os.symlink(os.path.join(b, "elsewhere/.sagebrush-data/snapshot.json"), os.path.join(t, "snapshot.json"))
    return setup


D("D5", "URLERROR invalid-snapshot canary=0", poisoned("symlink"), cwd="root/a")
D("D6", "URLERROR invalid-snapshot canary=0", poisoned("file"), cwd="root/a")
D("D7", "URLERROR invalid-snapshot canary=0", poisoned("badjson"), cwd="root/a")
D("D8", "URLERROR invalid-snapshot canary=0", poisoned("nomanifest"), cwd="root/a")
D("D9", "URLERROR invalid-snapshot canary=0", poisoned("manifest-symlink"), cwd="root/a")
D("D10", "URLERROR no-snapshot canary=0", lambda b: (snap_at(os.path.join(b, "root/c")), os.makedirs(os.path.join(b, "root/a"))), cwd="root/a")
D("D11", "URLERROR outside-root canary=0", lambda b: (snap_at(os.path.join(b, "root")), snap_at(os.path.join(b, "out"))), cwd="out")
D("D12", "URLERROR outside-root canary=0", lambda b: (snap_at(os.path.join(b, "root")), snap_at(os.path.join(b, "out")), os.symlink(os.path.join(b, "out"), os.path.join(b, "root/link"))), cwd="root/link")
# (D12w: D12's layout run in the launcher's worker realm, where os.chdir keeps
# a LOGICAL cwd (no process.chdir in a Worker): realpath decides containment;
# the test runs rows marked "worker" as H2b does; grader ruling pending)
row("D12w", "D", "import os\nos.chdir('link')\nfetch(%r)\n" % U, "URLERROR outside-root canary=0",
    setup=lambda b: (snap_at(os.path.join(b, "root")), snap_at(os.path.join(b, "out")), os.symlink(os.path.join(b, "out"), os.path.join(b, "root/link"))))
rows["D12w"]["worker"] = True
D("D13", "URLERROR outside-root canary=0", lambda b: (os.makedirs(os.path.join(b, "x/ab")), snap_at(os.path.join(b, "x/abc"))), root="x/ab", cwd="x/abc")

# ---------------------------------------------------------------- E: misses, FRED, redaction
FRED_API = "https://api.stlouisfed.org/fred/series/observations?series_id=X&api_key=" + CANARY


def E(rid, url, exp, setup=None, program=None):
    def s(base):
        snap_at(os.path.join(base, "root"))
        if setup:
            setup(base)
    row(rid, "E", program or "fetch(%r)\n" % url, exp, setup=s)


E("E1", "https://example.org/missing", "URLERROR not-pinned canary=0")
E("E2", FRED_API, "URLERROR fred canary=0")


def pin_fred(base):
    d = os.path.join(base, "root")
    shutil.rmtree(os.path.join(d, ".sagebrush-data"))
    write_snapshot(d, [entry("https://api.stlouisfed.org/fred/series/observations?series_id=X")], [b"x"])


E("E3", "https://api.stlouisfed.org/fred/series/observations?series_id=X", "URLERROR fred canary=0", setup=pin_fred)
E("E4", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=X", "URLERROR fred canary=0")
E("E5", "https://alfred.stlouisfed.org/graph/alfredgraph.csv?id=X", "URLERROR fred canary=0")
q = "https://example.org/missing?"
E("E6", q + "api_key=" + CANARY, "URLERROR not-pinned canary=0")
E("E7", q + "API_KEY=" + CANARY, "URLERROR not-pinned canary=0")
E("E8", q + "Token=" + CANARY, "URLERROR not-pinned canary=0")
E("E9", q + "api%5Fkey=" + CANARY, "URLERROR not-pinned canary=0")
E("E10", q + "api_key=a&api_key=" + CANARY, "URLERROR not-pinned canary=0")
# (E11: a blank value, then the canary in a second, redacted parameter
# whose blank form must also print as <redacted>: the program prints the reason)
E("E11", None, "api_key=<redacted>&x=1", program="try:\n    urllib.request.urlopen(%r)\nexcept urllib.error.URLError as e:\n    print(str(e.reason).split('?', 1)[1])\n" % (q + "api_key=&x=1"))
E("E12", q + "keyword=" + CANARY, "URLERROR not-pinned canary=1")
E("E13", q + "monkey=" + CANARY, "URLERROR not-pinned canary=1")
E("E14", q + "tokens=" + CANARY, "URLERROR not-pinned canary=1")
E("E15", "https://u:" + CANARY + "@example.org/a", "URLERROR url-refused canary=0")
E("E16", "https://example.org/missing#" + CANARY, "URLERROR not-pinned canary=0")
E("E17", "http://[" + CANARY, "URLERROR url-refused canary=0")
NF = b"not found\n"


def pin_404(base):
    d = os.path.join(base, "root")
    shutil.rmtree(os.path.join(d, ".sagebrush-data"))
    write_snapshot(d, [entry("https://example.org/gone", NF, status=404, content_type="text/plain")], [NF])


E("E18", "https://example.org/gone", "HTTPERROR 404 text/plain %s canary=0" % sha(NF), setup=pin_404)
E("E19", None, "https://example.org/gone https://example.org/gone",
  setup=pin_404, program="try:\n    urllib.request.urlopen('https://example.org/gone')\nexcept urllib.error.HTTPError as e:\n    print(e.url, e.filename)\n")
E("E20", None, "%s %s" % (U, U), program="r = urllib.request.urlopen(%r)\nprint(r.geturl(), r.url)\n" % U)


def no_snap(base):
    shutil.rmtree(os.path.join(base, "root", ".sagebrush-data"))


def bad_snap(base):
    open(os.path.join(base, "root", ".sagebrush-data", "snapshot.json"), "w").write("{")


E("E21", U, "URLERROR no-snapshot canary=0", setup=no_snap)
E("E22", U, "URLERROR invalid-snapshot canary=0", setup=bad_snap)

# ---------------------------------------------------------------- F: requests


def F(rid, program, exp, setup=None):
    def s(base):
        snap_at(os.path.join(base, "root"))
        if setup:
            setup(base)
    row(rid, "F", program, exp, setup=s)


F("F1", "fetch(%r)\n" % U, "SERVED %s " % S)
F("F2", "with urllib.request.urlopen(%r) as r:\n    b = r.read()\nprint(hashlib.sha256(b).hexdigest(), r.closed)\n" % U, "%s True" % S)
F("F3", "r = urllib.request.urlopen(%r)\nb = r.read(3) + r.read()\nprint(hashlib.sha256(b).hexdigest())\n" % U, S)
F("F4", "r = urllib.request.urlopen(%r)\nprint(r.getcode(), r.status, r.headers['Content-Type'])\n" % U, "200 200 text/csv")
F("F5", "fetch(%r, headers={'User-Agent': 'x', 'Referer': 'y', 'Accept': 'z'})\n" % U, "SERVED %s " % S)
for rid, h, cls in [("F6", "Range", "range"), ("F7", "If-None-Match", "conditional"), ("F8", "If-Modified-Since", "conditional"),
                    ("F9", "Authorization", "credential"), ("F10", "Cookie", "credential"), ("F11", "range", "range")]:
    F(rid, "fetch(%r, headers={%r: 'v'})\n" % (U, h), "URLERROR header canary=0")
F("F12", "try:\n    urllib.request.urlopen(%r, data=b'x')\nexcept urllib.error.URLError as e:\n    print('URLERROR', str(e.reason).split(':', 1)[0])\n" % U, "URLERROR method")


def pin_head(base):
    d = os.path.join(base, "root")
    shutil.rmtree(os.path.join(d, ".sagebrush-data"))
    write_snapshot(d, [entry(U, b"", method="HEAD")], [b""])


F("F13", "fetch(%r, method='HEAD')\n" % U, "SERVED %s " % sha(b""), setup=pin_head)
F("F14", "fetch(%r, method='HEAD')\n" % U, "URLERROR not-pinned canary=0")

json.dump(rows, open(os.path.join(OUT, "expected.json"), "w"), indent=1, sort_keys=True)
fam = {}
for r in rows.values():
    fam[r["family"]] = fam.get(r["family"], 0) + 1
print(json.dumps(fam, sort_keys=True), sum(fam.values()), "rows")
