#!/usr/bin/env python3
# Makes doc-vectors.json: the shared vectors of the documents' sync protocol
# (doc-protocol.ts; the plan's §5.1, §6.7.1, §6.7.2, §7.1), computed by an
# implementation independent of the TypeScript one: Python's hashlib, struct
# and its own RFC 8785 serializer.  The core client, the reference server
# and the cloud server all run these.
#   python3 -I web/sync-protocol/gen-doc-vectors.py > web/sync-protocol/doc-vectors.json
import base64
import decimal
import hashlib
import json
import struct
import sys


def utf8(s):
    return s.encode("utf-8")


def enc(s):
    b = utf8(s) if isinstance(s, str) else s
    return struct.pack(">I", len(b)) + b


def u64(n):
    return struct.pack(">Q", n)


def sha(b):
    return hashlib.sha256(b).digest()


# ---- RFC 8785, written from the RFC, not from the TypeScript


def jcs_string(s):
    out = ['"']
    for ch in s:
        c = ord(ch)
        if 0xD800 <= c <= 0xDFFF:
            raise ValueError("lone surrogate")
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif c < 0x20:
            out.append("\\u%04x" % c)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs_number(x):
    """ECMAScript's Number::toString (ES2023 §6.1.6.1.20), which RFC 8785 §3.2.2.3 requires.

    The digits are the shortest that round-trip (Python's repr gives the same
    digits: both are the shortest correctly rounded decimal), then ES's
    layout rules for where the point and exponent go."""
    if isinstance(x, bool):
        raise TypeError
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non-finite")
    if x == 0:
        return "0"
    if x < 0:
        return "-" + jcs_number(-x)
    t = decimal.Decimal(repr(x)).normalize().as_tuple()
    s = "".join(map(str, t.digits))
    k = len(s)
    n = k + t.exponent  # the value is 0.s x 10^n
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    return (s if k == 1 else s[0] + "." + s[1:]) + "e" + ("+" if e > 0 else "-") + str(abs(e))


# RFC 8785 Appendix B's IEEE-754 cases (and astra's from the PR #62 review): the oracle checks itself against them.
RFC8785_NUMBERS = [
    ("0000000000000000", "0"),
    ("8000000000000000", "0"),
    ("0000000000000001", "5e-324"),
    ("8000000000000001", "-5e-324"),
    ("7fefffffffffffff", "1.7976931348623157e+308"),
    ("ffefffffffffffff", "-1.7976931348623157e+308"),
    ("4340000000000000", "9007199254740992"),
    ("c340000000000000", "-9007199254740992"),
    ("4430000000000000", "295147905179352830000"),
    ("44b52d02c7e14af5", "9.999999999999997e+22"),
    ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"),
    ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"),
    ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
    ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("3ee4f8b588e368f1", "0.00001"),
    ("41b3de4355555553", "333333333.3333332"),
    ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"),
    ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"),
    ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),
]


def bits(h):
    return struct.unpack(">d", bytes.fromhex(h))[0]


for h, want in RFC8785_NUMBERS:
    got = jcs_number(bits(h))
    if got != want:
        raise SystemExit("the JCS oracle is wrong on %s: %s, not %s" % (h, got, want))


def utf16_key(k):
    return k.encode("utf-16-be")


def jcs(v):
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return jcs_number(v)
    if isinstance(v, str):
        return jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        return "{" + ",".join(jcs_string(k) + ":" + jcs(v[k]) for k in sorted(v, key=utf16_key)) + "}"
    raise TypeError(type(v))


def key16(s):
    return s.encode("utf-16-be")


# ---- the sealed value, the census, the digest


def project(kind, records):
    if kind == "notebook":
        out = []
        for r in records:
            if r.get("type") == "settings":
                o = {"type": "settings"}
                if "kernel" in r:
                    o["kernel"] = r["kernel"]
                out.append(o)
            elif r.get("type") == "cell":
                o = {k: r[k] for k in ("type", "id", "pos", "input", "cell_type") if k in r}
                if "attachments" in r:
                    o["attachments"] = r["attachments"]
                out.append(o)
        return out
    return [r for r in records if r.get("type") in ("doc", "page", "item", "edge")]


def rkey(kind, r):
    parts = ("type", "id") if kind == "notebook" else ("type", "page", "id")
    return tuple(key16("" if r.get(p) is None else str(r.get(p))) for p in parts)


def sealed(kind, records):
    rs = sorted(project(kind, records), key=lambda r: rkey(kind, r))
    return utf8("sb-sync-value-v1\n" + "".join(jcs(r) + "\n" for r in rs))


def census(kind, records):
    if kind == "board":
        return []
    cells = [{"id": str(r["id"]), "cell_type": str(r["cell_type"])} for r in project(kind, records) if r["type"] == "cell"]
    return sorted(cells, key=lambda c: key16(c["id"]))


def census_bytes(cells):
    return utf8("sb-sync-census-v1\n" + "".join(jcs({"cell_type": c["cell_type"], "id": c["id"]}) + "\n" for c in cells))


def blob(b, kind=None):
    if b is None:
        return b"\x00"
    out = b"\x01" + enc(b["sha256"]) + u64(b["size"]) + u64(b["rev"])
    if kind is not None:
        out += enc(kind)
    return out


def digest(entries):
    m = utf8("sb-sync-outputs-v2")
    for e in entries:
        p = e.get("preview")
        m += enc(e["cell"]) + enc(e["state"]) + blob(e.get("full")) + blob(p, p["kind"] if p else None)
    return sha(m).hex()


# ---- the chain


def batch_hash(envs, body):
    return sha(utf8("sb-sync-batch-v1") + enc(envs) + body)


def seed(owner, doc, epoch):
    return sha(utf8("sb-sync-chain-v1") + enc(owner) + enc(doc) + u64(epoch))


def nxt(prev, b, hb):
    return sha(utf8("sb-sync-chain-v1") + prev + u64(b["seq"]) + u64(b["recv"]) + u64(b["epoch"]) + enc(b["author"]) + enc(b["writer"]) + hb)


def claims(c):
    out = struct.pack(">BB", 1, 1 if c["recovery_copy"] else 0)
    out += struct.pack(">HHHHH", c["cells_total"], c["cells_run"], c["cells_error"], c["tests_passed"], c["tests_total"])
    out += struct.pack(">I", c["outbox_waiting"]) + u64(c["device_t"]) + b"\x00" * 8
    return base64.b64encode(out).decode()


# ---- LRE, the lossless record encoding (plan-sync-slice2-client-r4 §1b), written again here

NUL, SIDECAR = "\u0000", "\u0000n:"
SCHEMAS = {"notebook": (["type", "id"], ["input"]), "board": (["type", "page", "id"], ["title", "text", "code", "detail", "label", "intro"])}


class Refused(Exception):
    def __init__(self, field):
        self.field = field


def lre_key(k):
    return NUL + k if k.startswith(NUL) else k


def lre_value(v, field):
    if v is None:
        return {NUL: "n"}
    if isinstance(v, bool) or isinstance(v, str) or isinstance(v, (int, float)):
        return v
    if isinstance(v, list):
        return [lre_value(x, field) for x in v]
    if isinstance(v, dict):
        return {lre_key(k): lre_value(x, field) for k, x in v.items()}
    raise Refused(field)


def lre_encode(kind, rec):
    pks, cols = SCHEMAS[kind]
    for k in pks:
        if k in rec and not isinstance(rec[k], str):
            raise Refused(k)
    out = {}
    for k, v in rec.items():
        if k in cols:
            if v is None:
                out[SIDECAR + k] = True
            elif isinstance(v, str):
                out[k] = v
            else:
                raise Refused(k)
        else:
            out[lre_key(k)] = lre_value(v, k)
    return out


def lre_decode_value(v, field):
    if v is None:
        raise Refused(field)
    if isinstance(v, bool) or isinstance(v, str) or isinstance(v, (int, float)):
        return v
    if isinstance(v, list):
        return [lre_decode_value(x, field) for x in v]
    if NUL in v:
        if v[NUL] != "n":
            raise Refused(field)
        if len(v) == 1:
            return None
    out = {}
    for k, x in v.items():
        if k == NUL:
            continue
        if k.startswith(NUL):
            if not k.startswith(NUL + NUL):
                raise Refused(field)
            out[k[1:]] = lre_decode_value(x, field)
        else:
            out[k] = lre_decode_value(x, field)
    return out


def lre_decode(kind, enc):
    pks, cols = SCHEMAS[kind]
    out, sidecars = {}, []
    for k, v in enc.items():
        if k.startswith(SIDECAR):
            f = k[len(SIDECAR):]
            if f not in cols or v is not True:
                raise Refused(f)
            sidecars.append(f)
        elif k.startswith(NUL):
            if not k.startswith(NUL + NUL):
                raise Refused(k)
            out[k[1:]] = lre_decode_value(v, k[1:])
        elif k in cols:
            if not isinstance(v, str):
                raise Refused(k)
            out[k] = v
        else:
            out[k] = lre_decode_value(v, k)
    for f in sidecars:
        if f not in out:
            out[f] = None
    for k in pks:
        if k in out and not isinstance(out[k], str):
            raise Refused(k)
    return out


def refused(f, *a):
    try:
        f(*a)
    except Refused as e:
        return e.field
    raise AssertionError("not refused: " + repr(a))


def main():
    v = {"comment": "made by gen-doc-vectors.py; do not edit by hand", "version": 1}
    v["sha256"] = [{"hex_in": b.hex(), "out": sha(b).hex()} for b in [b"", b"abc", b"a" * 55, b"a" * 56, b"a" * 64, bytes(range(256)) * 5]]
    v["enc"] = [{"in": s, "out": enc(s).hex()} for s in ["", "doc", "é😀"]]
    v["u64"] = [{"in": n, "out": u64(n).hex()} for n in [0, 1, 2**32, 2**53 - 1]]
    v["jcs"] = [
        {"in": x, "out": jcs(x)}
        for x in [
            {"b": 2, "a": 1, "c": [3, {"z": None, "y": True}]},
            {"￿": 1, "\U0001F600": 2, "é": 3, "a": 4},
            {"s": "q\"\\/\b\f\n\r\t\u0001\u001f\u007f é😀"},
            [0, -1, 1.5, -0.25, 1e21, 123456789012, 0.1],
        ]
    ]
    # (each as its IEEE-754 bits, so no decimal parsing stands between the double and its form)
    v["jcs_numbers"] = [{"bits": h, "out": jcs_number(bits(h))} for h, _ in RFC8785_NUMBERS] + [
        {"bits": struct.pack(">d", x).hex(), "out": jcs_number(x)} for x in [1e-6, 1e-7, 1e21, 1e20, 123456789012345680000.0, 2.0**70, 0.1 + 0.2, 5e-7, 1.5e-6, 2.0**-1074 * 3]
    ]
    v["jcs_invalid"] = ['{"a":"\\ud800"}', '["\\udc00x"]']
    owner, doc = "ab" * 32, "0123456789ab"
    batches = []
    prev = seed(owner, doc, 1)
    v["chain_seed"] = {"owner_hash": owner, "doc": doc, "epoch": 1, "out": prev.hex()}
    for i, (recv, author, writer, envs, body) in enumerate(
        [
            (1000, "acct1", "session:devAAAAA", '[{"cseq":1,"id":"0000000000a_c1","parents":[],"size":3}]', b"abc"),
            (1000, "acct1", "session:devAAAAA", '[{"cseq":2,"id":"0000000000b_c1","parents":["0000000000a_c1"],"size":0}]', b""),
            (2500, "lti:x", "session:devBBBBB", '[{"cseq":1,"id":"0000000000c_c2","parents":["0000000000b_c1"],"size":5}]', "héllo".encode()[:5]),
        ]
    ):
        b = {"seq": i + 1, "recv": recv, "epoch": 1, "author": author, "writer": writer, "envs": envs, "body_hex": body.hex()}
        hb = batch_hash(envs, body)
        prev = nxt(prev, b, hb)
        b["hb"] = hb.hex()
        b["chain"] = prev.hex()
        batches.append(b)
    v["chain"] = batches
    # (a cleared document's epoch 2, whose root is stored at seq 5: the seq keeps counting across the clear)
    prev = seed(owner, doc, 2)
    e2 = []
    for seq, recv, writer, envs, body in [
        (5, 3000, "session:devAAAAA", '[{"cseq":1,"id":"0000000000d_c3","parents":[],"size":4}]', b"root"),
        (6, 3000, "session:devAAAAA", '[{"cseq":2,"id":"0000000000e_c3","parents":["0000000000d_c3"],"size":1}]', b"!"),
    ]:
        b = {"seq": seq, "recv": recv, "epoch": 2, "author": "person", "writer": writer, "envs": envs, "body_hex": body.hex()}
        hb = batch_hash(envs, body)
        prev = nxt(prev, b, hb)
        b["hb"] = hb.hex()
        b["chain"] = prev.hex()
        e2.append(b)
    v["chain_epoch2"] = {"owner_hash": owner, "doc": doc, "epoch": 2, "first_seq": 5, "seed": seed(owner, doc, 2).hex(), "batches": e2}
    nb = [
        {"type": "run", "id": "s1:1", "sid": "s1", "n": 1, "src": "x"},
        {"type": "cell", "id": "c2", "pos": 1, "input": "print('é')", "cell_type": "code", "extra": "dropped"},
        {"type": "settings", "kernel": "python3"},
        {"type": "cell", "id": "c1", "pos": 0, "input": "# Q1\n", "cell_type": "markdown", "attachments": {"a.png": {"image/png": "AAAA"}}},
        {"type": "session", "id": "s1", "t": 5},
        {"type": "cell", "id": "C0", "pos": 2, "input": "", "cell_type": "raw"},
    ]
    board = [
        {"type": "item", "page": "p1", "id": "i2", "x": 10, "text": "b"},
        {"type": "doc", "title": "T"},
        {"type": "edge", "page": "p1", "id": "e1", "from": "i1", "to": "i2"},
        {"type": "page", "page": "p1", "title": "P"},
        {"type": "item", "page": "p1", "id": "i1", "x": 1.5, "text": "😀"},
        {"type": "tool", "id": "pen"},
    ]
    v["sealed"] = []
    for kind, recs in [("notebook", nb), ("board", board)]:
        b = sealed(kind, recs)
        cs = census(kind, recs)
        cb = census_bytes(cs)
        v["sealed"].append({"kind": kind, "records": recs, "text": b.decode(), "sha256": sha(b).hex(), "census": cs, "census_text": cb.decode(), "census_sha256": sha(cb).hex()})
    s = lambda c: c * 64
    entries = [
        {"cell": "C0", "state": "not_code"},
        {"cell": "c1", "state": "not_code"},
        {"cell": "c2", "state": "captured", "full": {"sha256": s("a"), "size": 12, "rev": 3}},
        {"cell": "c3", "state": "captured", "preview": {"sha256": s("b"), "size": 900, "rev": 4, "kind": "png"}},
        {"cell": "c4", "state": "captured", "full": {"sha256": s("c"), "size": 5, "rev": 5}, "preview": {"sha256": s("d"), "size": 2, "rev": 5, "kind": "text"}},
        {"cell": "c5", "state": "written_after_deadline"},
        {"cell": "c6", "state": "not_run"},
    ]
    v["outputs_digest"] = [{"entries": entries, "out": digest(entries)}, {"entries": [], "out": digest([])}]
    c = {"cells_total": 12, "cells_run": 7, "cells_error": 1, "tests_passed": 3, "tests_total": 5, "outbox_waiting": 70000, "device_t": 1792720000123, "recovery_copy": True}
    v["claims"] = [{"in": c, "out": claims(c)}]
    # (LRE: each record as stored and back; the forms a concurrent merge makes, as decoded; and every refusal, with its field)
    encs = [
        ("notebook", {"type": "settings", "kernel": "python3"}),
        ("notebook", {"type": "cell", "id": "c1", "pos": 0, "input": None, "cell_type": "code", "execution_count": None}),
        ("notebook", {"type": "cell", "id": "c2", "input": "x = 1", "meta": {"a": None, "b": {"c": None, "d": [None, 1, "s"]}, NUL + "k": 1, NUL: 2}}),
        ("notebook", {"type": "file", "id": "s1:1", "sid": "s1", "n": 1, "t": 5, "path": "/a", "hash": None}),
        ("notebook", {"type": "cell", "id": "c3", NUL + "top": None, "e": [], "o": {}}),
        ("board", {"type": "item", "page": "", "id": "i1", "text": None, "x": None, "title": "T", "tags": [None]}),
        ("board", {"type": "doc", "page": "", "id": "", "title": "é😀", "intro": None}),
        # (astra's CORR-175-1: "__proto__" is an ordinary JSON key, at the record and nested; constructor and prototype the controls)
        ("notebook", {"type": "cell", "id": "c", "__proto__": {"kept": 7, "n": None}, "x": {"__proto__": {"kept": 7}, "other": 2}}),
        ("notebook", {"type": "cell", "id": "c", "constructor": 1, "prototype": {"a": None}, "toString": "s"}),
    ]
    v["lre_encode"] = []
    for kind, r in encs:
        e = lre_encode(kind, r)
        assert lre_decode(kind, e) == r, r
        v["lre_encode"].append({"schema": kind, "in": r, "out": e})
    decs = [
        ("notebook", {"type": "cell", "id": "c1", "x": {NUL: "n", "q": 2}}, {"type": "cell", "id": "c1", "x": {"q": 2}}),
        ("notebook", {"type": "cell", "id": "c1", "input": "abc", SIDECAR + "input": True}, {"type": "cell", "id": "c1", "input": "abc"}),
        ("notebook", {"type": "cell", "id": "c1", SIDECAR + "input": True}, {"type": "cell", "id": "c1", "input": None}),
        ("notebook", {"type": "cell", "id": "c1", "m": {NUL + NUL: {NUL: "n"}, "z": [{NUL: "n", "p": 3}]}}, {"type": "cell", "id": "c1", "m": {NUL: None, "z": [{"p": 3}]}}),
        ("board", {"type": "edge", "page": "p", "id": "e", "label": "L", SIDECAR + "label": True, "w": {NUL: "n"}}, {"type": "edge", "page": "p", "id": "e", "label": "L", "w": None}),
        # (incoming: an encoded record with "__proto__" keys decodes to own keys, never to a prototype)
        ("notebook", {"type": "cell", "id": "c", "__proto__": {"inherited": True}, "x": {"__proto__": {NUL: "n"}}}, {"type": "cell", "id": "c", "__proto__": {"inherited": True}, "x": {"__proto__": None}}),
    ]
    v["lre_decode"] = []
    for kind, e, want in decs:
        assert lre_decode(kind, e) == want, e
        v["lre_decode"].append({"schema": kind, "in": e, "out": want})
    v["lre_refused_encode"] = [
        {"schema": kind, "in": r, "field": refused(lre_encode, kind, r)}
        for kind, r in [
            ("notebook", {"type": "cell", "id": None}),
            ("notebook", {"type": "cell", "id": 5}),
            ("notebook", {"type": "cell", "id": "c", "input": 5}),
            ("notebook", {"type": "cell", "id": "c", "input": {}}),
            ("board", {"type": "item", "page": None, "id": "i"}),
            ("board", {"type": "item", "page": "", "id": "i", "text": ["a"]}),
        ]
    ]
    v["lre_refused_decode"] = [
        {"schema": kind, "in": e, "field": refused(lre_decode, kind, e)}
        for kind, e in [
            ("notebook", {"type": "cell", "id": None}),
            ("notebook", {"type": "cell", "id": {NUL: "n"}}),
            ("notebook", {"type": "cell", "id": 5}),
            ("notebook", {"type": "cell", "id": "c", "input": 5}),
            ("notebook", {"type": "cell", "id": "c", "input": 5, SIDECAR + "input": True}),
            ("notebook", {"type": "cell", "id": "c", "input": None}),
            ("notebook", {"type": "cell", "id": "c", "x": None}),
            ("notebook", {"type": "cell", "id": "c", "x": {"y": [1, None]}}),
            ("notebook", {"type": "cell", "id": "c", "x": {NUL: "x"}}),
            ("notebook", {"type": "cell", "id": "c", "x": {NUL + "k": 1}}),
            ("notebook", {"type": "cell", "id": "c", NUL + "k": 1}),
            ("notebook", {"type": "cell", "id": "c", SIDECAR + "x": True}),
            ("notebook", {"type": "cell", "id": "c", SIDECAR + "input": False}),
            ("board", {"type": "item", "page": "", "id": "i", "text": {NUL: "n"}}),
        ]
    ]
    # (refusals whose shape the servers and the client agree on by vector: the code, its detail, and whether the client
    # may send it again; the snapshot's, agreed for 2b-7 by @sagebrush-sync-docs and @sagebrush-sync-client, Oct 27)
    v["refusals"] = [
        {"for": "snapshot", "when": "the deployment's snapshot switch is off", "error": {"code": "unavailable", "detail": {"why": "snapshots_off"}}, "again": "never in this session"},
        # (the cadence (plan-sync-slice2-client r4 §2.5): (500 batches OR 4 MiB) since the epoch's last snapshot AND 1 h
        # since it.  Each field is what is left of its own condition: retry_after_batches = max(0, 500 - batches since),
        # retry_after_bytes = max(0, 4 MiB - body bytes since), retry_after_ms = max(0, 1 h - time since; 0 with no earlier
        # snapshot in the epoch).  The server refuses unless (batches = 0 or bytes = 0) and ms = 0; the client offers again
        # once that holds)
        {"for": "snapshot", "when": "too little history since the last snapshot", "error": {"code": "limit", "detail": {"limit": "snapshot_cadence", "retry_after_batches": 12, "retry_after_bytes": 1048576, "retry_after_ms": 60000}}, "again": "when (retry_after_batches = 0 or retry_after_bytes = 0) and retry_after_ms = 0"},
        {"for": "snapshot", "when": "enough history, within the hour", "error": {"code": "limit", "detail": {"limit": "snapshot_cadence", "retry_after_batches": 0, "retry_after_bytes": 2097152, "retry_after_ms": 60000}}, "again": "when (retry_after_batches = 0 or retry_after_bytes = 0) and retry_after_ms = 0"},
        {"for": "snapshot", "when": "another sha256 or byte count at an at_seq already taken", "error": {"code": "conflict"}, "again": "never at that at_seq"},
        {"for": "snapshot", "when": "an at_seq at or before the epoch's latest snapshot", "error": {"code": "conflict", "detail": {"latest_at_seq": 1500}}, "again": "only past latest_at_seq"},
    ]
    # (answers whose shape the servers and the client agree on by vector (sync-docs and sync-client, Oct 28): each a
    # `shape`, matched by doc-protocol.ts's shapeMismatch: an object has exactly these keys; {"*": s} is a map whose
    # every value is s; [s] an array whose every element is s; "number", "string", "boolean", "null", "string|null" and
    # "array" a value of that type; "=x" exactly the string x)
    head = {"epoch": "number", "seq": "number"}
    chained = {"epoch": "number", "seq": "number", "chain": "string|null"}
    refusal_shape = lambda code, detail: {"t": "=error", "req": "number", "code": "=" + code, "detail": detail}
    v["answers"] = [
        {"for": "pull", "when": "a page of batches (never a snapshot key)", "shape": {"t": "=batches", "req": "number", "owner": "string", "doc": "string", "epoch": "number", "head": chained, "items": [{"seq": "number", "author": "string", "writer": "string", "device": "string", "recv": "number", "chain": "string|null", "patches": "array", "body": "string"}], "more": "boolean"}},
        {"for": "batch", "when": "a new patch stored", "shape": {"t": "=ack", "req": "number", "batch": {"seq": "number", "new": "number", "resent": {"*": "number"}, "head": chained}}},
        {"for": "batch", "when": "every patch a resend: no seq", "shape": {"t": "=ack", "req": "number", "batch": {"new": "number", "resent": {"*": "number"}, "head": chained}}},
        {"for": "batch", "when": "another epoch than the document's (its history was cleared)", "shape": refusal_shape("epoch", {"message": "string", "epoch": "number", "head": head})},
        {"for": "pull", "when": "another epoch than the document's (its history was cleared)", "shape": refusal_shape("epoch", {"message": "string", "epoch": "number", "head": head})},
        {"for": "doc_claim", "when": "another epoch than the document's", "shape": refusal_shape("stale_epoch", {"message": "string", "epoch": "number", "head": head})},
    ]
    json.dump(v, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


main()
