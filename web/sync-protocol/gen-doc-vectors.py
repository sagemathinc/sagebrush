#!/usr/bin/env python3
# Makes doc-vectors.json: the shared vectors of the documents' sync protocol
# (doc-protocol.ts; the plan's §5.1, §6.7.1, §6.7.2, §7.1), computed by an
# implementation independent of the TypeScript one: Python's hashlib, struct
# and its own RFC 8785 serializer.  The core client, the reference server
# and the cloud server all run these.
#   python3 -I web/sync-protocol/gen-doc-vectors.py > web/sync-protocol/doc-vectors.json
import base64
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
    if isinstance(x, bool):
        raise TypeError
    if isinstance(x, int):
        return str(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non-finite")
    if x == int(x) and abs(x) < 1e21:
        return str(int(x))
    r = repr(x)  # shortest round-trip, as ES6's Number.prototype.toString
    if "e" in r:
        m, e = r.split("e")
        e = int(e)
        return "%se%s%d" % (m, "+" if e > 0 else "-", abs(e))
    return r


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
    json.dump(v, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


main()
