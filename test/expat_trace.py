# The handler trace of one parse with pyexpat (P3c-1): every handler call in order, a mark after each Parse call
# that delivered events (so when an event arrives is recorded too, for reparse deferral), and the error if one is
# raised. The generator (test/gen_expat_corpus.py) records CPython 3.14.10's own pyexpat with it; test/expat.test.ts
# runs the same function on Sagebrush's and compares. JSON-safe: bytes appear as {"hex": ...}.
import hashlib
import json

# ElementTree's handlers, and the rest of the ones this slice implements (with extra=True)
HANDLERS = {
    "StartElementHandler": "SE", "EndElementHandler": "EE", "CharacterDataHandler": "CD",
    "StartNamespaceDeclHandler": "SN", "EndNamespaceDeclHandler": "EN", "CommentHandler": "CM",
    "ProcessingInstructionHandler": "PI", "DefaultHandlerExpand": "DH", "StartDoctypeDeclHandler": "SD",
}
EXTRA = {
    "XmlDeclHandler": "XD", "StartCdataSectionHandler": "CS", "EndCdataSectionHandler": "CE",
    "EndDoctypeDeclHandler": "DE", "EntityDeclHandler": "ED", "AttlistDeclHandler": "AD",
    "NotationDeclHandler": "ND", "UnparsedEntityDeclHandler": "UD", "SkippedEntityHandler": "SK",
    "NotStandaloneHandler": "NS",
}


def _j(v):
    if isinstance(v, bytes):
        return {"hex": v.hex()}
    if isinstance(v, (list, tuple)):
        return [_j(x) for x in v]
    if isinstance(v, dict):
        return [[_j(k), _j(x)] for k, x in v.items()]
    if isinstance(v, float):
        return repr(v)
    return v


def trace(expat, chunks, encoding=None, sep="}", buffer_text=True, ordered=True, deferral=True, handlers=None,
          limits=None, extra=False, noexpand=False, triplets=False, specified=False, standalone_rc=1, digest=False):
    """Parse `chunks` (a list of str or bytes) with final=False, then a final empty Parse; returns a dict."""
    p = expat.ParserCreate(encoding, sep) if sep is not None else expat.ParserCreate(encoding)
    events = []

    def handler(tag):
        if tag == "NS":
            return lambda *a: (events.append([tag] + _j(list(a))), standalone_rc)[1]
        return lambda *a: events.append([tag] + _j(list(a)))

    table = dict(HANDLERS)
    if extra:
        table.update(EXTRA)
    if noexpand:
        del table["DefaultHandlerExpand"]
        table["DefaultHandler"] = "D0"
    for name, tag in table.items():
        if handlers is not None and tag not in handlers:
            continue
        setattr(p, name, handler(tag))
    p.buffer_text = buffer_text
    p.ordered_attributes = ordered
    p.namespace_prefixes = triplets
    p.specified_attributes = specified
    p.SetReparseDeferralEnabled(deferral)
    for setter, value in (limits or {}).items():
        getattr(p, setter)(value)
    out = {"events": events, "error": None}
    empty = b"" if chunks and isinstance(chunks[0], bytes) else ""
    try:
        # (a mark only after a Parse call that delivered events: which call delivered each event is recorded)
        seen = 0
        for i, c in enumerate(chunks):
            p.Parse(c, False)
            if len(events) > seen:
                events.append(["P", i])
                seen = len(events)
        p.Parse(empty, True)
        events.append(["F"])
    except expat.ExpatError as e:
        out["error"] = {"type": "ExpatError", "code": e.code, "msg": str(e), "lineno": e.lineno, "offset": e.offset,
                        "line": p.ErrorLineNumber, "column": p.ErrorColumnNumber, "byte": p.ErrorByteIndex}
    except (LookupError, ValueError, TypeError) as e:
        out["error"] = {"type": type(e).__name__, "msg": str(e)}
    if digest:
        out["events"] = {"n": len(events), "sha256": hashlib.sha256(json.dumps(events).encode()).hexdigest()}
    return out
