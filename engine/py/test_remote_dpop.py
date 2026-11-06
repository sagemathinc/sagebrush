"""The remote runner's DPoP proof check (sagebrush/remote/dpop.py; design
remote-v1 §3): the local gateway's proof cases (test/local-gateway.test.ts
L1-L10, cases v3 §2) with proofs WebCrypto made, as the page makes them
(gen_remote_dpop_cases.mjs), each refused for its own reason:

- the token, the header (typ, alg, the jwk's members, kty, crv, the point,
  the coordinates), the thumbprint, the signature and its length, parsing,
  the proof's and a segment's size;
- htm, htu (with a query too), ath, claim types;
- iat at and past 60 s old and 5 s ahead, iat by type (1e999 included);
- jti reuse at exactly 120 s and 1 ms later, its length, charset and type;
- a stale or missing nonce (use_dpop_nonce), and a full jti store (503).

A passing proof records its jti; a refused one records nothing.

    python engine/py/test_remote_dpop.py
"""
import json
import os

from sagebrush.remote import dpop

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    with open(os.path.join(HERE, "test_remote_dpop_cases.json"), encoding="utf8") as f:
        return json.load(f)


def run(data, c, **over):
    jtis = dict(c["jtis"])
    for i in range(c["jtisFill"]):
        jtis[f"fill-{i:05d}-xxxxxxxxxxxxxxx"] = data["now_ms"]
    before = dict(jtis)
    args = dict(token=data["token"], jkt=data["jkt"], method=c["method"], htu=c["htu"], now_ms=data["now_ms"], jtis=jtis, nonce=data["nonce"])
    args.update(over)
    return dpop.check(c["auth"], c["dpop"], **args), before, jtis


def test_cases():
    data = load()
    assert len(data["cases"]) >= 59, len(data["cases"])
    for c in data["cases"]:
        got, before, after = run(data, c)
        if c["expect"] is None:
            assert got is None, (c["name"], got)
            claims = json.loads(dpop.unb64url(c["dpop"].split(".")[1]))
            assert after.get(claims["jti"]) == data["now_ms"], c["name"]  # (recorded)
        else:
            assert got is not None, c["name"]
            assert list(got[:3]) == c["expect"], (c["name"], got)
            assert {k: v for k, v in after.items() if k in before} == {k: v for k, v in before.items() if k in after}, c["name"]
            assert not (set(after) - set(before)), c["name"]  # (a refusal records no jti)


def test_nonce_challenge_header():
    data = load()
    c = next(c for c in data["cases"] if c["name"] == "L10a a stale nonce")
    got, _, _ = run(data, c)
    assert got[3] == {"www-authenticate": 'DPoP error="use_dpop_nonce"'}, got


def test_same_proof_twice():
    """The good proof passes once; replayed at once, it is jti-reused."""
    data = load()
    c = data["cases"][0]
    jtis = {}
    args = dict(token=data["token"], jkt=data["jkt"], method=c["method"], htu=c["htu"], now_ms=data["now_ms"], jtis=jtis, nonce=data["nonce"])
    assert dpop.check(c["auth"], c["dpop"], **args) is None
    assert dpop.check(c["auth"], c["dpop"], **args)[2] == "jti-reused"


def test_controls():
    """Each good proof fails when one input the check binds is changed: the
    socket's key, its token, the method, the htu, the clock, the nonce."""
    data = load()
    c = data["cases"][0]
    for over, reason in [
        ({"jkt": dpop.b64url(b"\0" * 32)}, "thumbprint"),
        ({"token": "another-token"}, "token"),
        ({"method": "GET"}, "htm"),
        ({"htu": c["htu"] + "/x"}, "htu"),
        ({"now_ms": data["now_ms"] + 61_000}, "iat-past"),
        ({"nonce": "another-nonce"}, "nonce"),
    ]:
        got, _, _ = run(data, c, **over)
        assert got is not None and got[2] == reason, (over, got)


def test_size_boundary_and_exact_htm():
    """grader's D2 and D19 on #761: a proof of exactly proofMax bytes isn't refused for its size (whatever else is
    wrong with it), and proofMax + 1 is; and htm is compared exactly (RFC 9449 §4.3): a proof whose htm is "GET",
    validly signed, doesn't pass for a request whose method is "get"."""
    data = load()
    c = data["cases"][0]
    m = dpop.LIMITS["proofMax"]
    for n, size_refused in ((m, False), (m + 1, True)):
        p = c["dpop"] + "A" * (n - len(c["dpop"]))
        assert len(p) == n
        got, before, after = run(data, dict(c, dpop=p))
        assert got is not None and (got[2] == "proof-size") == size_refused, (n, got)
        assert after == before, n
    g = next(x for x in data["cases"] if x["name"] == "L1 a good g.events proof (GET)")
    assert run(data, g)[0] is None  # (the control: as it is, it passes)
    got, _, after = run(data, g, method="get")
    assert got is not None and got[2] == "htm", got


def _remade(c, header=None, claims=None):
    """The case's proof with its header or claims changed (the signature left as it was: these refusals come first)."""
    h, cl, sig = c["dpop"].split(".")
    hj, cj = json.loads(dpop.unb64url(h)), json.loads(dpop.unb64url(cl))
    if header:
        header(hj)
    if claims:
        claims(cj)
    return "%s.%s.%s" % (dpop.b64url(json.dumps(hj).encode()), dpop.b64url(json.dumps(cj).encode()), sig)


def test_trailing_newlines():
    """astra's R761-PARSE-1: Python's `$` matches before a final LF, so every closed alphabet is fullmatched and every
    decode guarded.  A key coordinate, a jti or a proof segment ending in LF is refused for its own reason, with no
    exception and no jti recorded; the unchanged proof (the positive control) still passes."""
    data = load()
    c = data["cases"][0]
    for name, proof, reason in [
        ("x + LF", _remade(c, header=lambda h: h["jwk"].update(x=h["jwk"]["x"] + "\n")), "coords"),
        ("y + LF", _remade(c, header=lambda h: h["jwk"].update(y=h["jwk"]["y"] + "\n")), "coords"),
        ("jti + LF", _remade(c, claims=lambda cl: cl.update(jti=cl["jti"] + "\n")), "jti-charset"),
        ("the proof + LF", c["dpop"] + "\n", "parse"),
        ("a segment + LF", c["dpop"].replace(".", "\n.", 1), "parse"),
    ]:
        got, before, after = run(data, dict(c, dpop=proof))
        assert got is not None and got[2] == reason, (name, got)
        assert after == before, name  # (no jti recorded)
    got, _, after = run(data, c)
    assert got is None and len(after) == 1, got


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all remote dpop tests passed")
