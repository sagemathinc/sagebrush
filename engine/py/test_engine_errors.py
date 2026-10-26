"""The engine's error replies in the CPython package (rank-3 plan r3,
section 3.5): a failed proved invariant of the factoring engine comes back as
{"error": ..., "internal": true} and is raised as RuntimeError, never as the
ValueError of a resource limit or a user error.

- a reply flagged internal: RuntimeError, with the engine's message;
- the same message without the flag, and an ordinary error: ValueError;
- a real resource refusal (factor with work = 1): ValueError, "resource
  limit exceeded", and the reply has no "internal" field.

    python engine/py/test_engine_errors.py
"""
import json

from sagebrush import _engine

INTERNAL = "factor: internal error (x divides the residual after the pre-pass in small-subset pre-pass); please report it; not factored"


def raised(reply):
    real = _engine._native.call
    _engine._native.call = lambda req: json.dumps(reply)
    try:
        _engine.call("factor", f=["-1", "0", "1"])
    except Exception as e:  # noqa: BLE001 (the type is what is tested)
        return type(e), str(e)
    finally:
        _engine._native.call = real
    return None, None


def main():
    assert raised({"error": INTERNAL, "internal": True}) == (RuntimeError, INTERNAL)
    assert raised({"error": INTERNAL}) == (ValueError, INTERNAL)
    assert raised({"error": "factor of the zero polynomial"}) == (ValueError, "factor of the zero polynomial")
    # a real refusal from the engine: a resource limit, not flagged
    r = json.loads(_engine._native.call(json.dumps({"fn": "factor", "f": ["1", "1", "0", "0", "1"], "work": 1})))
    assert "resource limit exceeded" in r["error"] and "internal" not in r, r
    try:
        _engine.call("factor", f=["1", "1", "0", "0", "1"], work=1)
        raise AssertionError("no refusal")
    except ValueError as e:
        assert "resource limit exceeded" in str(e), e
    print("engine errors: ok")


if __name__ == "__main__":
    main()
