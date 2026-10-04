"""CPython's side: canonical JSON of ast.parse(), same encoding as dump.ts."""
import ast, hashlib, json, struct, sys, warnings

def fhex(x): return struct.pack(">d", x).hex()

def const_value(v):
    if isinstance(v, bool) or v is None or isinstance(v, str): return canon(v)
    if isinstance(v, int): return {"int": str(v)}
    return canon(v)

def canon(v):
    if v is None or isinstance(v, (bool, str)): return v
    if v is Ellipsis: return {"$": "Ellipsis"}
    if isinstance(v, int): return v
    if isinstance(v, float): return {"float": fhex(v)}
    if isinstance(v, complex): return {"complex": fhex(v.imag)}
    if isinstance(v, bytes): return {"bytes": v.hex()}
    if isinstance(v, list): return [canon(x) for x in v]
    if isinstance(v, ast.AST):
        t = type(v).__name__
        if not v._fields and not v._attributes: return t
        o = {"_type": t}
        for f in v._fields:
            x = getattr(v, f, None)
            o[f] = const_value(x) if f == "value" and t in ("Constant", "MatchSingleton") else canon(x)
        for a in v._attributes: o[a] = canon(getattr(v, a, None))
        return o
    raise TypeError(repr(v))

def dump(src):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        tree = ast.parse(src)
    return json.dumps(canon(tree), sort_keys=True, ensure_ascii=True, separators=(",", ":"))

def error(src):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            compile(src, "<string>", "exec", ast.PyCF_ONLY_AST)
        except SyntaxError as e:
            return [type(e).__name__, e.msg, e.lineno, e.offset, e.end_lineno, e.end_offset]
    return None
