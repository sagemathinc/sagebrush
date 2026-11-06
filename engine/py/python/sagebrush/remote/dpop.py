"""The runner's DPoP proof check (RFC 9449), step for step as the local
gateway's (src/local-gateway.ts verify, cases v3 §2): cheap checks before any
crypto, the key's thumbprint the socket's, then the signature, then the
claims' values.  `check` returns None for a good proof, else (status, error,
reason, headers).

The replay store (jti -> when seen) and the nonce belong to the caller; this
function only reads them, and the caller records the jti after a None.
"""

import base64
import hashlib
import json
import re

from sagebrush._native import remote as _es256  # ES256 in Rust (p256), design remote-v1 §3

LIMITS = {
    "proofMax": 4096,
    "segmentMax": 1024,
    "jtis": 4096,
    "jtiMs": 120_000,
    "jtiMin": 22,
    "jtiMax": 64,
    "iatPast": 60,
    "iatFuture": 5,
    "nonceMs": 5 * 60_000,
}

_B64URL = re.compile(r"^[A-Za-z0-9_-]+$")
_B64URL43 = re.compile(r"^[A-Za-z0-9_-]{43}$")
_JTI = re.compile(r"^[A-Za-z0-9_-]*$")


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def unb64url(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def thumbprint(x, y):
    """RFC 7638: the SHA-256 of the key's canonical JWK, base64url."""
    canon = json.dumps({"crv": "P-256", "kty": "EC", "x": x, "y": y}, separators=(",", ":"))
    return b64url(hashlib.sha256(canon.encode("ascii")).digest())


def _is_safe_int(v):
    return type(v) is int and -(2**53 - 1) <= v <= 2**53 - 1


def _refused(reason, error="invalid_dpop_proof"):
    return (401, error, reason, {})


def _loads_object(raw):
    """A JSON object, or None (a duplicate key keeps the last, as JSON.parse does)."""
    try:
        v = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return v if isinstance(v, dict) else None


def check(auth, proof, *, token, jkt, method, htu, now_ms, jtis, nonce):
    """auth: the request's Authorization ("DPoP <token>"); proof: its DPoP header;
    token, jkt: the socket's; method, htu: rebuilt by the runner, never the page's;
    jtis: {jti: ms seen}, pruned here; nonce: the current one."""
    if not (isinstance(auth, str) and auth.startswith("DPoP ") and token is not None and auth[5:] == token):
        return _refused("token", "invalid_token")
    if not isinstance(proof, str):
        return _refused("parse")
    # 1. sizes
    if len(proof) > LIMITS["proofMax"]:
        return _refused("proof-size")
    parts = proof.split(".")
    # 2. three base64url segments, the first two JSON objects
    if len(parts) != 3 or not all(_B64URL.match(p) for p in parts):
        return _refused("parse")
    try:
        hb, cb, sig = unb64url(parts[0]), unb64url(parts[1]), unb64url(parts[2])
    except ValueError:
        return _refused("parse")
    if len(hb) > LIMITS["segmentMax"] or len(cb) > LIMITS["segmentMax"]:
        return _refused("segment-size")
    header, claims = _loads_object(hb), _loads_object(cb)
    if header is None or claims is None:
        return _refused("parse")
    if len(sig) != 64:
        return _refused("sig-length")
    # 3. the header
    if "typ" not in header:
        return _refused("typ-missing")
    if header["typ"] != "dpop+jwt":
        return _refused("typ")
    if header.get("alg") != "ES256":
        return _refused("alg")
    jwk = header.get("jwk")
    if not isinstance(jwk, dict):
        return _refused("jwk-members")
    if "d" in jwk:
        return _refused("jwk-private")
    if any(k not in ("kty", "crv", "x", "y", "d") for k in jwk):
        return _refused("jwk-extra")
    if not all(k in jwk for k in ("kty", "crv", "x", "y")):
        return _refused("jwk-members")
    if jwk["kty"] != "EC":
        return _refused("kty")
    if jwk["crv"] != "P-256":
        return _refused("crv")
    x, y = jwk["x"], jwk["y"]
    if not (isinstance(x, str) and isinstance(y, str) and _B64URL43.match(x) and _B64URL43.match(y)):
        return _refused("coords")
    xb, yb = unb64url(x), unb64url(y)
    if len(xb) != 32 or len(yb) != 32:
        return _refused("coords")
    # 4. the claims, by type, no coercion
    if not _is_safe_int(claims.get("iat")):
        return _refused("iat-type")
    jti = claims.get("jti")
    if not isinstance(jti, str):
        return _refused("jti-type")
    if not _JTI.match(jti):
        return _refused("jti-charset")
    if len(jti) < LIMITS["jtiMin"]:
        return _refused("jti-min")
    if len(jti) > LIMITS["jtiMax"]:
        return _refused("jti-max")
    if not all(isinstance(claims.get(k), str) for k in ("htm", "htu", "ath")):
        return _refused("claim-types")
    if "nonce" in claims and not isinstance(claims["nonce"], str):
        return _refused("claim-types")
    # 5. the key: on the curve, its thumbprint the socket's
    if not _es256.es256_key_ok(xb, yb):
        return _refused("curve")
    if thumbprint(x, y) != jkt:
        return _refused("thumbprint")
    # 6. the signature
    if not _es256.es256_verify(xb, yb, (parts[0] + "." + parts[1]).encode("ascii"), sig):
        return _refused("signature")
    # 7. the claims' values
    if claims["htm"] != method:
        return _refused("htm")
    if claims["htu"] != htu:
        return _refused("htu")
    if claims["ath"] != b64url(hashlib.sha256(token.encode("utf-8")).digest()):
        return _refused("ath")
    now = now_ms // 1000
    if claims["iat"] < now - LIMITS["iatPast"]:
        return _refused("iat-past")
    if claims["iat"] > now + LIMITS["iatFuture"]:
        return _refused("iat-future")
    for j in [j for j, at in jtis.items() if now_ms - at > LIMITS["jtiMs"]]:
        del jtis[j]
    if jti in jtis:
        return _refused("jti-reused")
    if claims.get("nonce") != nonce:
        return (401, "use_dpop_nonce", "nonce", {"www-authenticate": 'DPoP error="use_dpop_nonce"'})
    if len(jtis) >= LIMITS["jtis"]:
        return (503, "limit", "jti-store", {"retry-after": "1"})
    jtis[jti] = now_ms
    return None
