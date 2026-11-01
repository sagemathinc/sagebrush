"""The engine's limits in the CPython package (plan-ff-limits r3): one state,
_sagelib/_limits.py as the top-level module _limits, set before the first
use of the finite-field layer and locked by it.

- import sagebrush with a valid SAGEBRUSH_LIMITS, and an invalid, an
  unreadable and an oversized one (ValueError from the import, before a
  marker prints);
- set_limits replaced twice before first use; a failed call keeping the
  snapshot before it; the caller's dict changed afterwards, to no effect;
- the mixed-key mapping's structural error, not a TypeError from sorting;
- first layer use locks it; set_limits then raises RuntimeError, even for
  an invalid argument; importing _limits alone doesn't lock;
- the lowered budget is the one the layer uses.

Each case runs in a fresh interpreter: the limits are read once a process.

    python engine/py/test_limits.py
"""
import os
import subprocess
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix="sb-limits-")


def run(code, env=None):
    e = dict(os.environ)
    e.pop("SAGEBRUSH_LIMITS", None)
    e.update(env or {})
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=e, timeout=600)
    return r.returncode, r.stdout, r.stderr


def file(name, text):
    p = os.path.join(TMP, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p


def test_environment_valid():
    p = file("ok.json", '{"ff.work": 123456}')
    rc, out, err = run("import sagebrush\nfrom sagebrush.sage import *\nimport _sage_ffsub, sys\nprint(_sage_ffsub.WORK, sys._sagebrush_limits['ff.work'])", {"SAGEBRUSH_LIMITS": p})
    assert rc == 0 and out == "123456 123456\n", (rc, out, err)


def test_environment_invalid_prevents_marker():
    big = file("big.json", '{"ff.work": 100000' + " " * 5000 + "}")
    cases = [
        (file("range.json", '{"ff.work": 5}'), "ValueError: limits: ff.work = 5 is outside the range this engine allows, [100000, 100000000]"),
        (file("unknown.json", '{"ff.wrok": 5}'), "ValueError: limits: ff.wrok is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work, matlab.lu_work, nf.certify_index_max, nf.certify_norm_max, nf.relation_rounds, padic.kedlaya_work, pandas.decoded_bytes, poly.work)"),
        (file("array.json", "[1]"), "ValueError: limits: the limits must be a JSON object, not an array"),
        (file("bool.json", '{"ff.work": true}'), 'ValueError: limits: ff.work must be an integer or "unlimited", not true'),
        (file("float.json", '{"ff.work": 1e7}'), 'ValueError: limits: ff.work must be an integer or "unlimited", not 10000000.0'),
        (file("bad.json", "{"), "is not JSON: "),
        (big, "ValueError: limits: %s is larger than 4096 bytes" % big),
        (os.path.join(TMP, "missing.json"), "ValueError: limits: cannot read %s: No such file or directory" % os.path.join(TMP, "missing.json")),
    ]
    for p, want in cases:
        rc, out, err = run("import sagebrush\nprint('MARKER')", {"SAGEBRUSH_LIMITS": p})
        assert rc != 0 and "MARKER" not in out and want in err, (p, rc, out, err[-300:])


def test_set_limits_lifecycle():
    code = r'''
import sagebrush, sys
L = sagebrush._limits_module()
assert not L.finalized()
sagebrush.set_limits({"ff.work": 200000})
sagebrush.set_limits({"ff.work": 300000})
d = {"ff.work": 400000}
sagebrush.set_limits(d)
d["ff.work"] = 5
for bad, want in (({"ff.work": 1}, "limits: ff.work = 1 is outside the range this engine allows, [100000, 100000000]"),
                  ({"ff.work": 100000, 3: 1}, "limits: the key 3 is not a string"),
                  ({"ff.work": True}, 'limits: ff.work must be an integer or "unlimited", not true'),
                  ([("ff.work", 100000)], "limits: the limits must be a mapping, not an array")):
    try:
        sagebrush.set_limits(bad)
    except ValueError as e:
        assert str(e) == want, (str(e), want)
    else:
        raise AssertionError("accepted %r" % (bad,))
assert L._pending["ff.work"] == 400000 and not L.finalized()
import _limits
assert _limits is L and not L.finalized()   # (importing it doesn't lock)
from sagebrush.sage import *
import _sage_ffsub
assert L.finalized() and _sage_ffsub.WORK == 400000 and sys._sagebrush_limits is L.finalize()
for arg in ({"ff.work": 500000}, {"bogus": 1}, 42):
    try:
        sagebrush.set_limits(arg)
    except RuntimeError as e:
        assert str(e) == "sagebrush limits are read once, at the first use: set them before it", str(e)
    else:
        raise AssertionError("set after the lock")
print("done")
'''
    rc, out, err = run(code)
    assert rc == 0 and out == "done\n", (rc, out, err[-2000:])


def test_lowered_budget_refuses():
    # MinimalPolynomial in GF(2^20) is charged 343620 cops: admitted at that
    # budget, refused one short (the budget is the layer's)
    code = r'''
import sagebrush, sys
sagebrush.set_limits({"ff.work": int(sys.argv[1]) if len(sys.argv) > 1 else %d})
from sagebrush.sage import *
K = GF(2**20, "z")
try:
    print((K.gen()**3 + K.gen()).minpoly().degree())
except Exception as e:
    print(type(e).__name__)
'''
    rc, out, err = run(code % 343620)
    assert rc == 0 and out == "20\n", (rc, out, err[-500:])
    rc, out, err = run(code % 343619)
    assert rc == 0 and out == "NotImplementedError\n", (rc, out, err[-500:])


def test_unlimited_by_default_and_mixed():
    # every limit unlimited by default (plan-c0 r2), infinity in the core;
    # finite values opt in key by key; with ff.work finite the effective
    # ff.embed_max is at most 2^20 (the discrete-log accounting's range);
    # unlimited, the fields' bound is the Conway search's cutoff, 10^7
    show = "import _sage_ffsub as S, sys; print(S.WORK, S.EMBED_MAX, S.ROOT_BITS, sys._sagebrush_limits)"
    cases = [
        ("", "inf 10000000 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': unlimited, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"),
        ('sagebrush.set_limits({"ff.work": 100000})', "100000 1048576 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': unlimited, 'ff.work': 100000, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"),
        ('sagebrush.set_limits({"ff.work": "unlimited", "ff.root_bits": 64})', "inf 10000000 64 Limits({'ff.conway_work': unlimited, 'ff.embed_max': unlimited, 'ff.root_bits': 64, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"),
        ('sagebrush.set_limits({"ff.embed_max": 4096})', "inf 4096 inf Limits({'ff.conway_work': unlimited, 'ff.embed_max': 4096, 'ff.root_bits': unlimited, 'ff.work': unlimited, 'matlab.lu_work': unlimited, 'nf.certify_index_max': unlimited, 'nf.certify_norm_max': unlimited, 'nf.relation_rounds': unlimited, 'padic.kedlaya_work': unlimited, 'pandas.decoded_bytes': unlimited, 'poly.work': unlimited})"),
    ]
    for setup, want in cases:
        rc, out, err = run("import sagebrush\n%s\nfrom sagebrush.sage import *\n%s" % (setup, show))
        assert rc == 0 and out == want + "\n", (setup, rc, out, err[-500:])


def test_limit_accessor():
    # sagebrush.limit(name), the public read of one limit (plan-pandas r7
    # section E (a)): unlimited (infinity) by default; a set value read
    # back; the first read locks, so set_limits after it raises
    # RuntimeError; an unknown name is ValueError listing the limits, and a
    # name that isn't a str is TypeError
    cases = [
        ("import sagebrush\nprint(sagebrush.limit('pandas.decoded_bytes'))", "inf\n"),
        ("import sagebrush\nsagebrush.set_limits({'pandas.decoded_bytes': 33554432})\nprint(sagebrush.limit('pandas.decoded_bytes'), sagebrush.limit('ff.work'))", "33554432 inf\n"),
        ("import sagebrush\nsagebrush.limit('ff.work')\ntry:\n    sagebrush.set_limits({'ff.work': 100000})\nexcept RuntimeError as e:\n    print('RuntimeError', e)",
         "RuntimeError sagebrush limits are read once, at the first use: set them before it\n"),
        ("import sagebrush\ntry:\n    sagebrush.limit('pandas.decoded')\nexcept ValueError as e:\n    print(e)",
         "limits: pandas.decoded is not a limit of this engine (its limits: ff.conway_work, ff.embed_max, ff.root_bits, ff.work, matlab.lu_work, nf.certify_index_max, nf.certify_norm_max, nf.relation_rounds, padic.kedlaya_work, pandas.decoded_bytes, poly.work)\n"),
        ("import sagebrush\ntry:\n    sagebrush.limit(1)\nexcept TypeError as e:\n    print(e)", "limit() argument must be a str, not int\n"),
        ("import sagebrush\ntry:\n    sagebrush.set_limits({'pandas.decoded_bytes': 1000})\nexcept ValueError as e:\n    print(e)",
         "limits: pandas.decoded_bytes = 1000 is outside the range this engine allows, [1048576, 1099511627776]\n"),
    ]
    for code, want in cases:
        rc, out, err = run(code)
        assert rc == 0 and out == want, (code, rc, out, err[-500:])


def test_nf_poly_keys_reach_the_engine_only_when_finite():
    # C0's per-area follow-up: sagebrush/_engine.py adds the field only when
    # the session's limit is finite, and an explicit argument wins
    probe = ("import sagebrush\n%s\nimport sagebrush._engine as E\n"
             "print(E._with_limits('bnf', {}), E._with_limits('factor', {}), E._with_limits('bnf_certify', {'norm_max': 5}), E._with_limits('nf_data', {}))")
    rc, out, err = run(probe % "")
    assert rc == 0 and out == "{} {} {'norm_max': 5} {}\n", (rc, out, err[-500:])
    setup = 'sagebrush.set_limits({"poly.work": 1048576, "nf.relation_rounds": 7, "nf.certify_index_max": 1000})'
    rc, out, err = run(probe % setup)
    assert rc == 0 and out == "{'rounds': 7} {'work': 1048576} {'norm_max': 5, 'index_max': 1000} {}\n", (rc, out, err[-500:])


def test_descent_table_memory():
    # plan-c0 r2 section 2: the worst reachable descent after plan-c0,
    # GF(7^8) down to GF(7^4) (r = 1201), builds a discrete-log table of at
    # most 35 entries, well under 64 KiB at its peak (tracemalloc)
    code = r'''
import sagebrush, math, tracemalloc
from sagebrush.sage import *
import _sage_ff as F, _sage_ffsub as S
sizes = []
real = F._bsgs
def spy(g, h, n, mul, one, power):
    sizes.append(math.isqrt(n) + 1)
    return real(g, h, n, mul, one, power)
F._bsgs = spy
K, L = F.GF(7 ** 8), F.GF(7 ** 4)
x = K.gen() ** ((7 ** 8 - 1) // (7 ** 4 - 1) * 5)
tracemalloc.start()
y = S.down(x, L, [S.WORK], ValueError)
peak = tracemalloc.get_traced_memory()[1]
tracemalloc.stop()
print(y is not None, max(sizes), peak < 64 * 1024)
'''
    rc, out, err = run(code)
    assert rc == 0 and out == "True 35 True\n", (rc, out, err[-500:])


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_") and callable(f):
            f()
            print("ok", name)
    print("all limits tests passed")
