"""The runner's enrollment (design remote-v1 §3): its key (sagebrush._native.remote.es256_public / es256_sign, p256;
sagebrush/remote/keys.py, the key file) and `sagebrush remote login` (sagebrush/remote/enroll.py, the device flow).

- the native signer: RFC 6979's P-256/SHA-256 vector exactly; Node's public point for each secret; WebCrypto
  verifying the runner's signatures under the JWK the runner sends (remote_test_verify.mjs); invalid secrets refused;
- the key file: 0600 in a 0700 directory, written atomically; a symlink, loose permissions, another format refused;
  the secret never in repr;
- the device flow against a fake enrollment server (the cloud's /api/remote/v1/device[/poll] answers, b1): pending,
  slow_down, approved, denied, expired, an approval page on another site, an inert cloud (404, not JSON), origins;
- the CLI: login writes the key file; a second login without --force refuses.

    python engine/py/test_remote_enroll.py
"""
import http.server
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading

from sagebrush._native import remote as _native
from sagebrush.remote import enroll, keys

HERE = os.path.dirname(os.path.abspath(__file__))
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
NODE = shutil.which("node")


def be32(n):
    return n.to_bytes(32, "big")


def node_check(cases):
    p = subprocess.run([NODE, os.path.join(HERE, "remote_test_verify.mjs")], input=json.dumps(cases).encode(),
                       stdout=subprocess.PIPE, check=True, timeout=60)
    return json.loads(p.stdout)


# ---- the native signer

def test_rfc6979_vector():
    # RFC 6979 A.2.5, P-256 with SHA-256, message "sample": deterministic, so exactly this r || s
    d = bytes.fromhex("C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721")
    x, y = _native.es256_public(d)
    assert x.hex().upper() == "60FED4BA255A9D31C961EB74C6356D68C049B8923B61FA6CE669622E60F29FB6"
    assert y.hex().upper() == "7903FE1008B8BC99A41AE9E95628BC64F2F1B20C2D7E9F5177A3C294D4462299"
    sig = _native.es256_sign(d, b"sample")
    assert sig.hex().upper() == (
        "EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716"
        "F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8"), sig.hex()
    assert _native.es256_verify(x, y, b"sample", sig)
    assert _native.es256_sign(d, b"sample") == sig  # (no randomness in signing)


def test_invalid_secrets():
    for d in (bytes(32), be32(N), be32(N + 1), b"\xff" * 32, bytes(31) + b"\x01"[:0], b"\x01" * 31, b"\x01" * 33, b""):
        assert _native.es256_public(d) is None, d.hex()
        assert _native.es256_sign(d, b"m") is None, d.hex()
    assert _native.es256_public(be32(1)) is not None and _native.es256_public(be32(N - 1)) is not None
    gx, gy = _native.es256_public(be32(1))
    assert gx.hex() == "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"
    assert gy.hex() == "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"


def test_webcrypto_agrees():
    if not NODE:
        print("  (no node: WebCrypto agreement skipped)")
        return
    cases, expect = [], []
    for i in range(12):
        k = keys.RunnerKey.generate()
        msg = os.urandom(i * 7) if i % 3 else b"sb-remote-chal/1\n" + os.urandom(20)
        sig = k.sign(msg)
        assert len(sig) == 64
        cases.append({"d": k._d.hex(), "jwk": k.jwk(), "msg": msg.hex(), "sig": keys.b64url(sig)})
        expect.append((k.x + k.y).hex())
        # the same signature over another message, and a flipped bit: WebCrypto refuses both
        cases.append({"jwk": k.jwk(), "msg": (msg + b"!").hex(), "sig": keys.b64url(sig)})
        bad = bytearray(sig)
        bad[i % 64] ^= 1
        cases.append({"jwk": k.jwk(), "msg": msg.hex(), "sig": keys.b64url(bytes(bad))})
    got = node_check(cases)
    for i in range(12):
        assert got[3 * i]["pub"] == expect[i], i
        assert got[3 * i]["ok"] is True, i
        assert got[3 * i + 1]["ok"] is False and got[3 * i + 2]["ok"] is False, i


def test_generate_distinct():
    a, b = keys.RunnerKey.generate(), keys.RunnerKey.generate()
    assert a._d != b._d and a.x != b.x
    j = a.jwk()
    assert sorted(j) == ["crv", "kty", "x", "y"] and len(j["x"]) == 43 and len(j["y"]) == 43
    for r in (repr(a), str(a)):
        assert a._d.hex() not in r and keys.b64url(a._d) not in r and repr(a._d) not in r, r


# ---- the key file

class TmpHome:
    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="sb-enroll-")
        self.old = os.environ.get("XDG_CONFIG_HOME")
        os.environ["XDG_CONFIG_HOME"] = self.dir
        return self

    def __exit__(self, *a):
        if self.old is None:
            os.environ.pop("XDG_CONFIG_HOME", None)
        else:
            os.environ["XDG_CONFIG_HOME"] = self.old
        shutil.rmtree(self.dir, ignore_errors=True)


def refused(path=None):
    try:
        keys.load(path)
    except keys.KeyFileError as e:
        return str(e)
    raise AssertionError("loaded")


def enrolled():
    k = keys.RunnerKey.generate()
    k.remote_id, k.origin, k.name = "r" + "A" * 20, "https://sagebrush.space", "box"
    return k


def test_key_file_roundtrip():
    with TmpHome() as h:
        assert keys.load() is None
        k = enrolled()
        path = keys.save(k)
        assert path == os.path.join(h.dir, "sagebrush", "remote", "key.json")
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode) == 0o700
        assert os.listdir(os.path.dirname(path)) == ["key.json"]  # (no temporary left)
        got = keys.load()
        assert (got._d, got.x, got.y, got.remote_id, got.origin, got.name) == (
            k._d, k.x, k.y, k.remote_id, k.origin, k.name)
        # a second save replaces it, exactly 0600 whatever the umask (permissive, or taking the owner's bits)
        for mask in (0, 0o277):
            old = os.umask(mask)
            try:
                k2 = enrolled()
                keys.save(k2)
            finally:
                os.umask(old)
            assert stat.S_IMODE(os.stat(path).st_mode) == 0o600 and keys.load()._d == k2._d


def test_key_file_refusals():
    with TmpHome() as h:
        path = keys.save(enrolled())
        d = os.path.dirname(path)
        os.chmod(path, 0o644)
        assert "others" in refused()
        os.chmod(path, 0o600)
        os.chmod(d, 0o755)
        assert "others" in refused()
        os.chmod(d, 0o700)
        # a file (or directory) another user owns
        real_uid = os.getuid
        os.getuid = lambda: real_uid() + 1
        try:
            assert "owned" in refused()
        finally:
            os.getuid = real_uid
        # a symlink to a good file is still refused (O_NOFOLLOW)
        real = os.path.join(h.dir, "elsewhere.json")
        os.replace(path, real)
        os.symlink(real, path)
        assert "symlink" in refused() or "can't be opened" in refused()
        os.unlink(path)
        os.replace(real, path)
        keys.load()
        good = open(path, "rb").read()
        secret = json.loads(good)["d"]
        for body in (b"", b"[]", b"{", b'{"v": 2}', good.replace(b'"v": 1', b'"v": 2'),
                     json.dumps({**json.loads(good), "d": "AAAA"}).encode(),
                     json.dumps({**json.loads(good), "d": keys.b64url(bytes(32))}).encode(),
                     json.dumps({**json.loads(good), "d": keys.b64url(os.urandom(32)) + "="}).encode(),
                     # (the same 32 bytes, but a spare low bit set in the last character: not canonical)
                     json.dumps({**json.loads(good), "d": secret[:-1] + keys._B64[keys._B64.index(secret[-1]) ^ 1]}).encode(),
                     json.dumps({**json.loads(good), "remote_id": None}).encode(),
                     b" " * 9000):
            with open(path, "wb") as f:
                f.write(body)
            assert secret not in refused()
        # saving into a directory others can write is refused
        os.chmod(d, 0o777)
        try:
            keys.save(enrolled())
            raise AssertionError("saved")
        except keys.KeyFileError:
            pass
        os.chmod(d, 0o700)


# ---- the device flow

class FakeCloud:
    """The b1 enrollment answers, scripted: each poll takes the next answer."""

    def __init__(self, polls, device=None, origin_override=None):
        self.polls, self.device, self.origin_override = list(polls), device, origin_override
        self.requests = []

    def post(self, origin, path, body, timeout=30.0):
        self.requests.append((path, body))
        if path == "/api/remote/v1/device":
            if self.device is not None:
                return self.device
            o = self.origin_override or origin
            return 200, {"device_code": "D" * 43, "user_code": "BCDF-GHJK", "verification_uri": o + "/remote/activate",
                         "verification_uri_complete": o + "/remote/activate?code=BCDFGHJK", "interval": 5,
                         "expires_in": 600}
        assert path == "/api/remote/v1/device/poll" and body == {"device_code": "D" * 43}
        return self.polls.pop(0)


def run_login(cloud, clock=None, kind="runner"):
    slept, said = [], []
    t = [0.0]

    def sleep(s):
        slept.append(s)
        t[0] += s

    k = enroll.login("https://sagebrush.space", "box", kind=kind, out=said.append, sleep=sleep,
                     clock=clock or (lambda: t[0]), post=cloud.post)
    return k, slept, "".join(said)


def login_error(cloud, **kw):
    try:
        run_login(cloud, **kw)
    except enroll.EnrollError as e:
        return str(e)
    raise AssertionError("enrolled")


PENDING = (400, {"error": "authorization_pending"})
SLOW = (400, {"error": "slow_down"})
OK = (200, {"remote_id": "r" + "B" * 20, "kind": "runner", "name": "box (2)"})


def test_login_approved():
    cloud = FakeCloud([PENDING, SLOW, PENDING, OK])
    k, slept, said = run_login(cloud)
    assert slept == [5, 5, 10, 10]  # (slow_down: 5 s more from then on)
    assert (k.remote_id, k.origin, k.name) == ("r" + "B" * 20, "https://sagebrush.space", "box (2)")
    assert "https://sagebrush.space/remote/activate?code=BCDFGHJK" in said and "BCDF-GHJK" in said
    path, body = cloud.requests[0]
    assert path == "/api/remote/v1/device"
    assert body == {"kind": "runner", "name": "box", "pub": k.jwk()}  # (the public key only)
    assert keys.b64url(k._d) not in json.dumps(cloud.requests)


def test_login_refusals():
    assert "was denied" in login_error(FakeCloud([PENDING, (400, {"error": "access_denied"})]))
    assert "expired" in login_error(FakeCloud([(400, {"error": "expired_token"})]))
    assert "refused: weird" in login_error(FakeCloud([(400, {"error": "weird"})]))
    # the client's own clock: pending forever stops at expires_in
    e = login_error(FakeCloud([PENDING] * 200))
    assert "expired" in e
    # an approval of another kind, or without a remote id
    assert "unexpectedly" in login_error(FakeCloud([(200, {"remote_id": "r" + "B" * 20, "kind": "agent"})]))
    assert "unexpectedly" in login_error(FakeCloud([(200, {"kind": "runner"})]))
    # the start refused, or answered oddly
    assert "invalid_name" in login_error(FakeCloud([], device=(400, {"error": "invalid_name"})))
    assert "unexpectedly" in login_error(FakeCloud([], device=(200, {"device_code": "x"})))
    assert "unexpectedly" in login_error(FakeCloud([], device=(200, {
        "device_code": "D" * 43, "user_code": "B", "verification_uri": "https://sagebrush.space/a", "interval": 0,
        "expires_in": 600})))
    # an approval page on another site, or with control characters, is never shown
    assert "approval page" in login_error(FakeCloud([OK], origin_override="https://evil.example"))
    assert "approval page" in login_error(FakeCloud([OK], device=(200, {
        "device_code": "D" * 43, "user_code": "BCDF-GHJK\x1b[2J", "verification_uri": "https://sagebrush.space/a",
        "interval": 5, "expires_in": 600})))


def test_origins():
    assert enroll.check_origin("https://sagebrush.space/") == "https://sagebrush.space"
    assert enroll.check_origin("http://127.0.0.1:8787") == "http://127.0.0.1:8787"
    for bad in ("http://sagebrush.space", "ftp://x", "https://", "https://a/b", "https://a?x", "https://u:p@a",
                "javascript:x", None):
        try:
            enroll.check_origin(bad)
            raise AssertionError(bad)
        except enroll.EnrollError:
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    inert = False
    polls = 0

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if Handler.inert:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return
        if self.path == "/api/remote/v1/device":
            assert body["pub"]["kty"] == "EC" and body["kind"] == "runner"
            o = "http://127.0.0.1:%d" % self.server.server_port
            v, code = {"device_code": "E" * 43, "user_code": "BCDF-GHJK", "verification_uri": o + "/remote/activate",
                       "interval": 1, "expires_in": 60}, 200
        else:
            Handler.polls += 1
            v, code = ((OK[1], 200) if Handler.polls > 1 else ({"error": "authorization_pending"}, 400))
        b = json.dumps(v).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


def test_cli_against_http():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:%d" % srv.server_port
    old_err, old_origin = sys.stderr, os.environ.get("SAGEBRUSH_REMOTE_ORIGIN")
    try:
        with TmpHome():
            os.environ["SAGEBRUSH_REMOTE_ORIGIN"] = origin
            sys.stderr = io.StringIO()
            from sagebrush.remote.pair import main
            assert main(["login", "--name", "box"]) == 0, sys.stderr.getvalue()
            k = keys.load()
            assert k.remote_id == "r" + "B" * 20 and k.origin == origin and Handler.polls == 2
            assert keys.b64url(k._d) not in sys.stderr.getvalue()
            sys.stderr = io.StringIO()
            assert main(["login"]) == 1 and "already enrolled" in sys.stderr.getvalue()
            assert keys.load()._d == k._d
            # an inert cloud (remote compute not enabled there): a clear error, the old key kept
            Handler.inert = True
            sys.stderr = io.StringIO()
            assert main(["login", "--force"]) == 1 and "without JSON" in sys.stderr.getvalue()
            assert keys.load()._d == k._d
            sys.stderr = io.StringIO()
            assert main(["login", "--origin", "http://example.com"]) == 1
            assert main(["login", "--bogus"]) == 2
    finally:
        sys.stderr = old_err
        if old_origin is None:
            os.environ.pop("SAGEBRUSH_REMOTE_ORIGIN", None)
        else:
            os.environ["SAGEBRUSH_REMOTE_ORIGIN"] = old_origin
        srv.shutdown()
        srv.server_close()


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote enrollment tests passed")
