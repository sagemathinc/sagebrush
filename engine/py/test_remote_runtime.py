"""The remote's runtime fetch, verify and activate (sagebrush/remote/runtime.py; remote r3.7, design amendment B with
SEC's bundle conditions and B1; step P2c-1), against a fake origin serving a release built here:

- the manifest: pinned by its canonical bytes' sha256 (a self-declared digest is never trusted); exactly this version;
  strict relative, duplicate-free paths; sizes, hashes and modes; only node's executable extracted;
- the platform: glibc Linux and macOS keys; musl and unknown machines refused in words;
- Node's archive: verified, then every member against the expected list (traversal, absolute, duplicate, links,
  special files and unexpected members refused); only bin/node written;
- install: a fresh private staging tree, exclusive no-follow creates, the bound set verified, one atomic activate;
  the prior version kept on any failure; no downgrade; a reinstall refused; leftovers cleaned;
- every launch: the whole bound set again (node, a bundle file, the addon), refused after any change.

    python engine/py/test_remote_runtime.py
"""
import hashlib
import io
import json
import os
import shutil
import stat
import tarfile
import tempfile

from sagebrush.remote import runtime as T

V = "0.11.0"
PLAT = "linux-x64-gnu"
NODEDIR = "node-v24.11.1-linux-x64"
NODE_BIN = b"\x7fELF fake node " * 100


def sha(b):
    return hashlib.sha256(b).hexdigest()


def tarxz(members):
    """A tar.xz of [(name, kind, data_or_target)]: kind file, dir, symlink, link, fifo."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz") as t:
        for name, kind, data in members:
            ti = tarfile.TarInfo(name)
            if kind == "file":
                ti.size = len(data)
                t.addfile(ti, io.BytesIO(data))
                continue
            ti.type = {"dir": tarfile.DIRTYPE, "symlink": tarfile.SYMTYPE, "link": tarfile.LNKTYPE, "fifo": tarfile.FIFOTYPE}[kind]
            if kind in ("symlink", "link"):
                ti.linkname = data
            t.addfile(ti)
    return buf.getvalue()


GOOD_MEMBERS = [(NODEDIR, "dir", None), (NODEDIR + "/bin", "dir", None), (NODEDIR + "/bin/node", "file", NODE_BIN),
                (NODEDIR + "/include", "dir", None), (NODEDIR + "/include/node.h", "file", b"/* h */"), (NODEDIR + "/LICENSE", "file", b"MIT")]


class Release:
    """A release as the release step would publish it: files by path, the manifest, and its pin."""

    def __init__(self, members=GOOD_MEMBERS, addon=True, mutate=None):
        self.files = {}
        arch = tarxz(members)
        bundle = {"main.mjs": b"// main", "root/sagebrush-worker.js": b"// worker", "root/engine.wasm": b"\0asm" + b"\1" * 100}
        bfiles = []
        for path, data in bundle.items():
            self.files["bundle/" + path] = data
            bfiles.append({"path": path, "size": len(data), "sha256": sha(data), "mode": 0o644})
        self.files["node-%s.tar.xz" % PLAT] = arch
        plat = {"node": {"version": "24.11.1", "archive": {"path": "node-%s.tar.xz" % PLAT, "size": len(arch), "sha256": sha(arch)},
                         "bin": {"path": NODEDIR + "/bin/node", "size": len(NODE_BIN), "sha256": sha(NODE_BIN), "mode": 0o755},
                         "members": [{"name": n, "type": k} for n, k, _ in GOOD_MEMBERS], "extract": [NODEDIR + "/bin/node"]}}
        if addon:
            a = b"\x7fELF addon"
            self.files["addon/%s/sagebrush-engine.node" % PLAT] = a
            plat["addon"] = {"path": "sagebrush-engine.node", "size": len(a), "sha256": sha(a), "mode": 0o755, "build": "b1", "napi": 9}
        self.m = {"version": V, "bundle": {"build": "b1", "files": bfiles}, "platforms": {PLAT: plat}}
        if mutate:
            mutate(self)
        self.raw = json.dumps(self.m, separators=(",", ":")).encode()
        self.pins = {self.m["version"]: sha(self.raw)}
        self.gets = []

    def get(self, path, max_bytes, sink=None):
        self.gets.append(path)
        prefix = "%s%s/" % (T.RUNTIME_PATH, V)
        assert path.startswith(prefix), path
        rel = path[len(prefix):]
        data = self.raw if rel == "manifest.json" else self.files.get(rel)
        if data is None:
            T.refuse("404 %s" % rel)
        if len(data) > max_bytes:
            T.refuse("a runtime file is larger than the manifest says")
        if sink is None:
            return data
        sink(data)
        return len(data)


def refused(f, *a, contains="", **k):
    try:
        f(*a, **k)
    except T.RuntimeError_ as e:
        assert contains in str(e), (contains, str(e))
        return str(e)
    raise AssertionError("not refused")


def fresh_root():
    d = tempfile.mkdtemp()
    r = os.path.join(d, "runtime")
    return d, r


def test_platform():
    assert T.this_platform("Linux", "x86_64", "glibc") == "linux-x64-gnu"
    assert T.this_platform("Linux", "aarch64", "glibc") == "linux-arm64-gnu"
    assert T.this_platform("Darwin", "arm64") == "darwin-arm64" and T.this_platform("Darwin", "x86_64") == "darwin-x64"
    refused(T.this_platform, "Linux", "x86_64", "other", contains="musl")
    refused(T.this_platform, "Linux", "riscv64", "glibc", contains="aren't built")
    refused(T.this_platform, "Windows", "AMD64", contains="aren't built")


def test_manifest():
    r = Release()
    m = T.parse_manifest(r.raw, V, r.pins)
    assert m["version"] == V
    refused(T.parse_manifest, r.raw, V, {}, contains="no pinned runtime")
    refused(T.parse_manifest, r.raw + b" ", V, r.pins, contains="pin")
    refused(T.parse_manifest, r.raw, "0.11.1", {"0.11.1": r.pins[V]}, contains="isn't for this")
    for what, mutate in [
        ("absolute", lambda x: x.m["bundle"]["files"][0].update(path="/etc/x")),
        ("dot-dot", lambda x: x.m["bundle"]["files"][0].update(path="a/../b")),
        ("backslash", lambda x: x.m["bundle"]["files"][0].update(path="a\\b")),
        ("duplicate", lambda x: x.m["bundle"]["files"].append(dict(x.m["bundle"]["files"][0]))),
        ("bad sha", lambda x: x.m["bundle"]["files"][0].update(sha256="xx")),
        ("bad mode", lambda x: x.m["bundle"]["files"][0].update(mode=0o777)),
        ("extract more", lambda x: x.m["platforms"][PLAT]["node"].update(extract=[NODEDIR + "/bin/node", NODEDIR + "/LICENSE"])),
        ("unknown platform", lambda x: x.m["platforms"].update({"win-x64": {}})),
        ("extra field", lambda x: x.m["bundle"]["files"][0].update(url="https://evil")),
    ]:
        b = Release(mutate=mutate)
        refused(T.parse_manifest, b.raw, V, b.pins)
    # (a key twice: not the one serialization, refused)
    dup = r.raw.replace(b'{"version"', b'{"version":"0.0.1","version"', 1)
    refused(T.parse_manifest, dup, V, {V: sha(dup)}, contains="JSON")


def test_install_and_launch():
    d, root = fresh_root()
    try:
        r = Release()
        final = T.install(V, PLAT, r.get, root, r.pins)
        assert T.read_current(root) == V and os.path.isdir(final)
        st = os.stat(os.path.join(final, "node", NODEDIR, "bin", "node"))
        assert stat.S_IMODE(st.st_mode) == 0o755
        # (only bin/node was written from Node's archive: no headers, no LICENSE)
        assert not os.path.exists(os.path.join(final, "node", NODEDIR, "include"))
        assert not os.path.exists(os.path.join(final, "node", NODEDIR, "LICENSE"))
        assert stat.S_IMODE(os.stat(root).st_mode) == 0o700
        got = T.launch_check(V, PLAT, root, r.pins)
        assert got["node"].endswith("/bin/node") and got["addon"].endswith("sagebrush-engine.node")
        # (no reinstall over it; no downgrade)
        refused(T.install, V, PLAT, r.get, root, r.pins, contains="already installed")
        refused(T.install, "0.10.9", PLAT, r.get, root, {"0.10.9": "0" * 64}, contains="no downgrade")
        # (every launch: any member changed after activation is refused: node, a bundle file, the addon)
        for rel in ("node/%s/bin/node" % NODEDIR, "bundle/root/engine.wasm", "addon/sagebrush-engine.node"):
            path = os.path.join(final, rel)
            keep = open(path, "rb").read()
            os.chmod(path, 0o755 if rel.startswith(("node", "addon")) else 0o644)
            with open(path, "ab") as f:
                f.write(b"!")
            refused(T.launch_check, V, PLAT, root, r.pins)
            with open(path, "wb") as f:
                f.write(keep)
            T.launch_check(V, PLAT, root, r.pins)
        # (a mode loosened, and a member swapped for a link: refused)
        bpath = os.path.join(final, "bundle", "main.mjs")
        os.chmod(bpath, 0o666)
        refused(T.launch_check, V, PLAT, root, r.pins)
        os.chmod(bpath, 0o644)
        os.rename(bpath, bpath + ".real")
        os.symlink(bpath + ".real", bpath)
        refused(T.launch_check, V, PLAT, root, r.pins, contains="link")
        os.unlink(bpath)
        os.rename(bpath + ".real", bpath)
        T.launch_check(V, PLAT, root, r.pins)
    finally:
        shutil.rmtree(d)


def test_archive_refusals():
    cases = [
        ("traversal", GOOD_MEMBERS + [("../evil", "file", b"x")], "leaves its folder"),
        ("absolute", GOOD_MEMBERS + [("/etc/evil", "file", b"x")], "leaves its folder"),
        ("duplicate", GOOD_MEMBERS + [(NODEDIR + "/LICENSE", "file", b"again")], "twice"),
        ("symlink", GOOD_MEMBERS[:-1] + [(NODEDIR + "/LICENSE", "symlink", "/etc/passwd")], "link or special"),
        ("hardlink", GOOD_MEMBERS[:-1] + [(NODEDIR + "/LICENSE", "link", "/etc/passwd")], "link or special"),
        ("special", GOOD_MEMBERS[:-1] + [(NODEDIR + "/LICENSE", "fifo", None)], "link or special"),
        ("unexpected", GOOD_MEMBERS + [(NODEDIR + "/bin/npm", "file", b"#!")], "doesn't expect"),
        ("missing", [m for m in GOOD_MEMBERS if m[0] != NODEDIR + "/LICENSE"], "exactly the members"),
    ]
    for what, members, why in cases:
        d, root = fresh_root()
        try:
            # (the manifest lists the good members, as Release always does: the archive is what's wrong)
            r = Release(members=members)
            refused(T.install, V, PLAT, r.get, root, r.pins, contains=why)
            assert T.read_current(root) is None, what
            assert not os.path.exists(os.path.join(root, "versions", V)), what
            assert not [n for n in os.listdir(root) if n.startswith("staging-")], (what, "staging left behind")
        finally:
            shutil.rmtree(d)


def test_prior_version_kept_and_staging_cleaned():
    d, root = fresh_root()
    try:
        r = Release()
        T.install(V, PLAT, r.get, root, r.pins)
        # (a newer version whose bundle file doesn't match: refused; the prior stays current and runnable)
        V2 = "0.11.1"

        def newer(x):
            x.m["version"] = V2
        r2 = Release(mutate=newer)
        r2.files["bundle/main.mjs"] = b"// mAin"  # (the same size, other bytes)
        get2 = lambda path, n, sink=None: r2.get(path.replace(V2, V), n, sink)
        refused(T.install, V2, PLAT, get2, root, r2.pins, contains="main.mjs")
        assert T.read_current(root) == V and not os.path.exists(os.path.join(root, "versions", V2))
        T.launch_check(V, PLAT, root, r.pins)
        # (a crash's leftover staging tree is removed at the next install)
        os.mkdir(os.path.join(root, "staging-0.11.1-999"), 0o700)
        r3 = Release(mutate=newer)
        get3 = lambda path, n, sink=None: r3.get(path.replace(V2, V), n, sink)
        T.install(V2, PLAT, get3, root, r3.pins)
        assert T.read_current(root) == V2 and not [n for n in os.listdir(root) if n.startswith("staging-")]
    finally:
        shutil.rmtree(d)


def test_staged_member_replaced_before_activate():
    """SEC B1: a loadable member other than node, replaced between its write and the verify, refuses the version."""
    d, root = fresh_root()
    try:
        r = Release()
        real = T.verify_tree

        def tamper(fd, m, plat, uid=None):
            p = os.path.join(root, [n for n in os.listdir(root) if n.startswith("staging-")][0], "bundle", "root", "sagebrush-worker.js")
            with open(p, "wb") as f:
                f.write(b"// swapped")
            return real(fd, m, plat, uid)
        T.verify_tree = tamper
        try:
            refused(T.install, V, PLAT, r.get, root, r.pins)
        finally:
            T.verify_tree = real
        assert T.read_current(root) is None and not os.path.exists(os.path.join(root, "versions", V))
    finally:
        shutil.rmtree(d)


def test_changed_between_verify_and_activate():
    """TESTS T3 / SEC S3: the exact seam: the staged tree verified, THEN a member replaced (the same size, other
    bytes), then the rename: node, a bundle file and the addon in turn.  The activated tree is verified again before
    "current" names it: the version is taken out and nothing is current."""
    for rel, why in (("node/%s/bin/node" % NODEDIR, "bin/node"), ("bundle/main.mjs", "main.mjs"), ("addon/sagebrush-engine.node", "sagebrush-engine.node")):
        d, root = fresh_root()
        try:
            r = Release()
            real = T.verify_tree
            calls = []

            def verify_then_replace(fd, m, plat, uid=None):
                calls.append(1)
                out = real(fd, m, plat, uid)
                if len(calls) == 1:
                    st = [n for n in os.listdir(root) if n.startswith("staging-")][0]
                    p = os.path.join(root, st, rel)
                    data = open(p, "rb").read()
                    # (a replacement, not an edit in place: a new file of the same size renamed over it)
                    with open(p + ".new", "wb") as f:
                        f.write(b"!" + data[1:])
                    os.chmod(p + ".new", stat.S_IMODE(os.stat(p).st_mode))
                    os.replace(p + ".new", p)
                return out
            T.verify_tree = verify_then_replace
            try:
                refused(T.install, V, PLAT, r.get, root, r.pins, contains=why)
            finally:
                T.verify_tree = real
            assert len(calls) == 2, (rel, "verified again after the rename")
            assert T.read_current(root) is None and not os.path.exists(os.path.join(root, "versions", V)), rel
        finally:
            shutil.rmtree(d)


def test_directories_checked():
    """TESTS T1: every directory on the way to a bound member: ours, not group- or world-writable, at launch (and so at
    activation, the same walk)."""
    d, root = fresh_root()
    try:
        r = Release()
        final = T.install(V, PLAT, r.get, root, r.pins)
        T.launch_check(V, PLAT, root, r.pins)  # (the control)
        for rel in ("bundle/root", "bundle", "node/%s/bin" % NODEDIR, "."):
            p = os.path.join(final, rel)
            mode = stat.S_IMODE(os.stat(p).st_mode)
            os.chmod(p, 0o777)
            refused(T.launch_check, V, PLAT, root, r.pins, contains="isn't private")
            os.chmod(p, mode)
        T.launch_check(V, PLAT, root, r.pins)
        # (a directory owned by someone else: the walk with another uid sees every directory as not ours)
        vfd = os.open(final, os.O_RDONLY | os.O_DIRECTORY)
        try:
            m = json.loads(open(os.path.join(final, "manifest.json"), "rb").read())
            refused(T.verify_tree, vfd, m, PLAT, os.getuid() + 1, contains="isn't private")
        finally:
            os.close(vfd)
    finally:
        shutil.rmtree(d)


def test_only_the_current_version_launches():
    """TESTS T2: no downgrade at launch either: an older version kept on disk is refused once a newer one is current."""
    d, root = fresh_root()
    try:
        r = Release()
        T.install(V, PLAT, r.get, root, r.pins)
        V2 = "0.11.1"

        def newer(x):
            x.m["version"] = V2
        r2 = Release(mutate=newer)
        T.install(V2, PLAT, lambda path, n, sink=None: r2.get(path.replace(V2, V), n, sink), root, r2.pins)
        assert os.path.isdir(os.path.join(root, "versions", V)), "the older version is still on disk"
        refused(T.launch_check, V, PLAT, root, r.pins, contains="no downgrade")
        T.launch_check(V2, PLAT, root, r2.pins)
        refused(T.launch_check, "0.12.0", PLAT, root, {"0.12.0": "0" * 64}, contains="isn't the runtime installed")
    finally:
        shutil.rmtree(d)


def test_fetching():
    """https_get's rules, against a local server: the origin must be HTTPS; a body over its cap refused; a redirect
    within the origin followed, one away from it refused; a body trickling past the deadline refused."""
    import http.server
    import threading
    import time as _t

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path == "/small":
                self._send(b"hello")
            elif self.path == "/big":
                self._send(b"x" * 100)
            elif self.path == "/here":
                self.send_response(302)
                self.send_header("Location", "/small")
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif self.path == "/away":
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.2:%d/small" % self.server.server_port)
                self.send_header("Content-Length", "0")
                self.end_headers()
            elif self.path == "/slow":
                self.send_response(200)
                self.send_header("Content-Length", "10")
                self.end_headers()
                try:
                    for _ in range(10):
                        self.wfile.write(b"s")
                        self.wfile.flush()
                        _t.sleep(0.2)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # (the client gave up at its deadline: what the row is about)

        def _send(self, b):
            self.send_response(200)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:%d" % srv.server_port
    saved_origin, saved_deadline = T.RUNTIME_ORIGIN, T.LIMITS["deadlineS"]
    try:
        T.RUNTIME_ORIGIN = origin
        refused(T.https_get, "/small", 100, contains="isn't HTTPS")
        assert T._get(origin, "/small", 100) == b"hello"
        refused(T._get, origin, "/big", 99, contains="larger")
        assert T._get(origin, "/big", 100) == b"x" * 100
        assert T._get(origin, "/here", 100) == b"hello", "a redirect within the origin"
        refused(T._get, origin, "/away", 100, contains="can't fetch")
        T.LIMITS["deadlineS"] = 0.5
        refused(T._get, origin, "/slow", 100, contains="too long")
        T.LIMITS["deadlineS"] = 10
        assert T._get(origin, "/slow", 100) == b"s" * 10
    finally:
        T.RUNTIME_ORIGIN, T.LIMITS["deadlineS"] = saved_origin, saved_deadline
        srv.shutdown()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote runtime tests passed")
