"""The remote runner's ES256 verifier (sagebrush._native.remote.es256_verify,
engine/py/src/remote.rs; design remote-v1 §3): it must agree with WebCrypto,
which makes the page's DPoP proofs, and refuse every malformed input
(astra's r1.4 list):

- WebCrypto's own signatures, and their high/low-S twins (WebCrypto accepts
  both, so the runner must too), against WebCrypto's recorded verdict;
- a wrong key and a wrong message;
- a key off the curve, the identity, coordinates >= p, wrong lengths;
- r or s zero or >= n, a signature in DER, wrong signature lengths.

    python engine/py/test_remote_es256.py
"""
import json
import os

from sagebrush._native import remote as _remote

es256_verify = _remote.es256_verify
es256_key_ok = _remote.es256_key_ok

HERE = os.path.dirname(os.path.abspath(__file__))
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def vectors():
    with open(os.path.join(HERE, "test_remote_es256_vectors.json"), encoding="utf8") as f:
        cases = json.load(f)["cases"]
    return [{**c, **{k: bytes.fromhex(c[k]) for k in ("x", "y", "msg", "sig")}} for c in cases]


def be32(n):
    return n.to_bytes(32, "big")


def good():
    """A valid case to mutate: WebCrypto's first signature."""
    return next(c for c in vectors() if c["webcrypto"])


def test_agrees_with_webcrypto():
    cases = vectors()
    assert len(cases) >= 18 and sum(c["webcrypto"] for c in cases) >= 12, len(cases)
    assert any(c["webcrypto"] and "twin" in c["name"] for c in cases)  # (high and low S both valid)
    for c in cases:
        assert es256_verify(c["x"], c["y"], c["msg"], c["sig"]) is c["webcrypto"], c["name"]


def test_bad_keys():
    c = good()
    x, y = int.from_bytes(c["x"], "big"), int.from_bytes(c["y"], "big")
    assert es256_verify(c["x"], c["y"], c["msg"], c["sig"])  # (the control: the unmutated case passes)
    for name, kx, ky in [
        ("off the curve", c["x"], be32((y + 1) % P)),
        ("the identity (zeros)", bytes(32), bytes(32)),
        ("x >= p", be32(x + P) if x + P < 2**256 else be32(P), c["y"]),
        ("y = p - y is the negated point, not the key", c["x"], be32(P - y)),
        ("x short", c["x"][:31], c["y"]),
        ("y long", c["x"], c["y"] + b"\0"),
        ("empty", b"", b""),
    ]:
        assert es256_verify(kx, ky, c["msg"], c["sig"]) is False, name
        # (the negated point is on the curve: a valid key, just not this one)
        assert es256_key_ok(kx, ky) is name.startswith("y = p - y"), name
    assert es256_key_ok(c["x"], c["y"]) is True


def test_bad_signatures():
    c = good()
    r, s = c["sig"][:32], c["sig"][32:]
    def der(a, b):
        ia = b"\x02" + bytes([len(a)]) + a
        ib = b"\x02" + bytes([len(b)]) + b
        return b"\x30" + bytes([len(ia) + len(ib)]) + ia + ib
    for name, sig in [
        ("r zero", bytes(32) + s),
        ("s zero", r + bytes(32)),
        ("r = n", be32(N) + s),
        ("s = n", r + be32(N)),
        ("r all ones", b"\xff" * 32 + s),
        ("r and s swapped", s + r),
        ("63 bytes", c["sig"][:63]),
        ("65 bytes", c["sig"] + b"\0"),
        ("empty", b""),
        ("DER of the same r, s", der(r, s)),
        ("a flipped bit", bytes([c["sig"][0] ^ 1]) + c["sig"][1:]),
    ]:
        assert es256_verify(c["x"], c["y"], c["msg"], sig) is False, name


def test_types():
    c = good()
    for bad in (None, "text", 5):
        try:
            es256_verify(c["x"], c["y"], bad, c["sig"])
        except TypeError:
            continue
        raise AssertionError(f"accepted message {bad!r}")


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote es256 tests passed")
