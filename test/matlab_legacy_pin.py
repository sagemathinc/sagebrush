"""Ruling (d2)'s interim, checked statically (CPython, by test/matlab-band.test.ts):
1. the legacy bodies are master's, pinned: _legacy_full_arr is master's
   full_arr, _legacy_band_solve master's _band_solve, _legacy_mldivide master's
   mldivide after its dimension check (which mldivide still makes first),
   compared as normalized source (ast.unparse) without docstrings, _band_solve read as _legacy_band_solve;
   the pins are the sha256 of master d3617031's normalized functions;
2. MAX_FULL and MAX_BAND_WORK are read only inside the legacy functions, and by
   legacy_band_route, the routing floor (William's D-W1, Oct 27 2026), whose body
   must be exactly master's band predicate;
3. each legacy function is called only from the unmeasured branch of its
   measured twin (or from the other legacy functions)."""
import ast
import hashlib
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "lib/_matlab_sparse.py"


def normalized(fn, skip=0, rename=None):
    body = list(fn.body)
    if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
            and isinstance(body[0].value.value, str):
        body = body[1:]
    body = body[skip:]
    mod = ast.Module(body=body, type_ignores=[])
    for node in ast.walk(mod):
        if isinstance(node, ast.Name) and rename and node.id in rename:
            node.id = rename[node.id]
    # (ast.unparse's text, which Python 3.9+ write alike, unlike ast.dump's)
    return hashlib.sha256(ast.unparse(mod).encode()).hexdigest()


def functions(tree):
    return {f.name: f for f in tree.body if isinstance(f, ast.FunctionDef)}


def pins_from(master_src):
    f = functions(ast.parse(master_src))
    return {
        "_legacy_full_arr": normalized(f["full_arr"]),
        "_legacy_band_solve": normalized(f["_band_solve"], rename={"_band_solve": "_legacy_band_solve"}),
        # (master's mldivide: A = a, then its dimension check, then the rest)
        "_legacy_mldivide": normalized(f["mldivide"], skip=2, rename={"_band_solve": "_legacy_band_solve"}),
    }


def main():
    tree = ast.parse(open(SRC).read())
    f = functions(tree)
    got = {
        "_legacy_full_arr": normalized(f["_legacy_full_arr"]),
        "_legacy_band_solve": normalized(f["_legacy_band_solve"]),
        "_legacy_mldivide": normalized(f["_legacy_mldivide"], skip=1),
    }
    for name, h in got.items():
        assert h == MASTER_PINS[name], "%s is not master's: %s != %s" % (name, h, MASTER_PINS[name])
    print("ok the legacy bodies are master's (pinned)")
    legacy = {"_legacy_full_arr", "_legacy_band_solve", "_legacy_mldivide", "_legacy_lu"}
    for name, fn in f.items():
        reads = {n.id for n in ast.walk(fn) if isinstance(n, ast.Name) and n.id in ("MAX_FULL", "MAX_BAND_WORK")}
        if reads:
            assert name in legacy or name == "legacy_band_route", "%s reads %s" % (name, sorted(reads))
    # (the floor: one return of master's mldivide predicate, nothing else)
    fl = [s for s in f["legacy_band_route"].body if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
    assert len(fl) == 1 and isinstance(fl[0], ast.Return) and ast.unparse(fl[0].value) == \
        "(2 * kl + ku + 1) * n <= MAX_FULL and n * (kl + 1) * (kl + ku + 1) <= MAX_BAND_WORK", ast.unparse(f["legacy_band_route"])
    print("ok MAX_FULL and MAX_BAND_WORK are read only by the legacy functions and the floor (master's predicate)")
    twin = {"_legacy_full_arr": "full_arr", "_legacy_mldivide": "mldivide", "_legacy_band_solve": "_legacy_mldivide"}
    for leg, owner in twin.items():
        callers = [name for name, fn in f.items() if any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                                                         and n.func.id == leg for n in ast.walk(fn))]
        assert callers == [owner], (leg, callers)
        # (in the measured twin, the call sits under `if unmeasured_reason(...) is not None:`)
        if not owner.startswith("_legacy"):
            ok = False
            for node in ast.walk(f[owner]):
                if isinstance(node, ast.If) and "unmeasured_reason" in ast.dump(node.test) and "IsNot" in ast.dump(node.test):
                    ok = ok or any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == leg
                                   for s in node.body for n in ast.walk(s))
            assert ok, "%s calls %s outside its unmeasured branch" % (owner, leg)
    print("ok each legacy function is called only from its twin's unmeasured branch")


MASTER_PINS = None
if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "--pins":
        print(pins_from(open(sys.argv[3]).read()))
        sys.exit(0)
    # (computed from master d3617031 by --pins)
    MASTER_PINS = {
        "_legacy_band_solve": "9dee9b594193d929e5f3faaa53d68bc1d88b5b7e25cc09c73fa9547152c19aec",
        "_legacy_full_arr": "c18b9d147bb1a14ebe02f8d13d6fcc61daeb3db70ad1ff0ffd697272479909ca",
        "_legacy_mldivide": "979cb249056a2b15b6c4f571bb1945712ed545c06230c1b280016c8511796637",
    }
    main()
