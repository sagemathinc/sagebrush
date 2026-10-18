"""sagebrush bench's framework, with fake engines (python engine/py/test_bench.py):
the timing procedure, answers compared across engines (MISMATCH fails the
run), missing and failing competitors, timeouts, the JSON report and the
answer fingerprints shared with the FLINT harness."""

import io
import json
import os
import sys
import tempfile
from fractions import Fraction

from sagebrush import bench
from sagebrush.bench import _bench_common, _timing
from sagebrush.bench._proc import LineProcess
from sagebrush.bench.suite import Case, EngineTimeout, Suite

# the timing procedure: answers come from the last call; at least 0.1 s
# per sample; calls of 10 s or more once (patched to 0.05 s here)
calls = []
t = _timing.sample(lambda: calls.append(1) or len(calls), 3)
assert len(t.times) == 3 and t.calls >= 1 and t.answer == len(calls)
assert all(x * t.calls >= 0.09 for x in t.times), t.times
old = _timing.ONCE
_timing.ONCE = 0.05
try:
    import time

    t = _timing.sample(lambda: time.sleep(0.06) or "slow", 5)
    assert t.times and len(t.times) == 1 and t.calls == 1 and t.answer == "slow"
finally:
    _timing.ONCE = old
assert _timing.Timing([3, 1, 2], 1, None).median == 2
assert _timing.Timing([4, 1, 2, 3], 1, None).median == 2.5


class Fake:
    def __init__(self, name, ours, answer=None, installed=True, fail=None):
        self.name = self.short = name
        self.label = name
        self.ours, self.answer, self.installed, self.fail = ours, answer, installed, fail
        self.closed = False

    def available(self):
        return self.installed

    def version(self):
        return None if self.ours else "1.0"

    def run(self, case, repeat, timeout):
        if self.fail:
            raise self.fail
        a = self.answer(case) if callable(self.answer) else self.answer
        return _timing.Timing([0.002] * repeat, 1, a)

    def close(self):
        self.closed = True


class FakeSuite(Suite):
    name, title, claim = "fake", "a fake suite", "none"

    def __init__(self, engines):
        self._engines = engines

    def cases(self):
        c = Case("expected 7", {"x": 7}, "standard")
        c.expected = 7
        return [Case("one", {"x": 1}, "quick"), Case("two", {"x": 2}, "standard"),
                Case("big", {"x": 3}, "large"), c]

    def engines(self):
        return self._engines


def run(engines, tiers=("quick", "standard"), competitors=True):
    out = io.StringIO()
    meta, bad = bench.run_suite(FakeSuite(engines), tiers, 2, 5, competitors, out=out)
    return meta, bad, out.getvalue()


ident = lambda c: c.params["x"]  # noqa: E731

# agreement, and the tiers chosen
meta, bad, text = run([Fake("sb", True, ident), Fake("other", False, ident)])
assert not bad, text
assert [r["case"] for r in meta["results"]] == ["one", "two", "expected 7"]
assert [r["check"] for r in meta["results"]] == ["agree"] * 3
assert meta["results"][0]["ratios"] == {"sb/other": 1.0}
assert meta["engines"]["other"] == {"label": "other", "ours": False, "status": "ok", "version": "1.0"}

# a wrong answer from any engine, or against a recorded one, is a MISMATCH
meta, bad, text = run([Fake("sb", True, ident), Fake("other", False, lambda c: c.params["x"] + (c.params["x"] == 2))])
assert bad and [r["check"] for r in meta["results"]] == ["agree", "MISMATCH", "agree"], text
assert "MISMATCH" in text
meta, bad, text = run([Fake("sb", True, 1)])
assert bad and [r["check"] for r in meta["results"]] == ["-", "-", "MISMATCH"], text

# a missing competitor: "not installed", and the run is fine
missing = Fake("gone", False, ident, installed=False)
missing.why = "not here"
meta, bad, text = run([Fake("sb", True, ident), missing])
assert not bad and meta["engines"]["gone"]["status"] == "not installed", meta
assert meta["engines"]["gone"]["error"] == "not here"
assert all(r["engines"]["gone"] == {"status": "not installed"} for r in meta["results"])
assert "not installed" in text

# --no-competitors: skipped
meta, bad, text = run([Fake("sb", True, ident), Fake("other", False, ident)], competitors=False)
assert not bad and meta["engines"]["other"]["status"] == "skipped"

# a competitor's timeout or error is reported, not fatal; Sagebrush's error is fatal
meta, bad, text = run([Fake("sb", True, ident), Fake("slow", False, fail=EngineTimeout("over 5 s"))])
assert not bad and meta["results"][0]["engines"]["slow"] == {"status": "timeout", "error": "over 5 s"}
meta, bad, text = run([Fake("sb", True, ident), Fake("broken", False, fail=RuntimeError("boom"))])
assert not bad and meta["results"][0]["engines"]["broken"]["error"] == "RuntimeError: boom"
meta, bad, text = run([Fake("sb", True, fail=RuntimeError("ours broke")), Fake("other", False, ident)])
assert bad and "ours broke" in text

# every engine is closed
engines = [Fake("sb", True, ident), Fake("other", False, ident)]
run(engines)
assert all(e.closed for e in engines)

# the command: --list, unknown suites, and the JSON report
saved = bench.suites
bench.suites = lambda: [FakeSuite([Fake("sb", True, ident), Fake("other", False, ident)])]
try:
    real_stdout, real_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = io.StringIO(), io.StringIO()
    try:
        assert bench.main(["--list"]) == 0
        listing = sys.stdout.getvalue()
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "r.json")
            assert bench.main(["fake", "--quick", "--json", out, "--repeat", "2"]) == 0
            with open(out) as f:
                report = json.load(f)
        for bad_args in (["nosuch"], ["--repeat", "0"], ["--tiers", "huge"], ["--quick", "--large"]):
            try:
                bench.main(bad_args)
            except SystemExit as e:
                assert e.code == 2, bad_args
            else:
                raise AssertionError(f"{bad_args} accepted")
    finally:
        sys.stdout, sys.stderr = real_stdout, real_stderr
finally:
    bench.suites = saved
assert "fake" in listing and "1 quick, 2 standard, 1 large" in listing, listing
assert report["schema"] == "sagebrush-bench/1" and report["tiers"] == ["quick"] and report["repeat"] == 2
for k in ("cpu", "cores", "usable_cores", "os", "python", "sagebrush", "date"):
    assert k in report["host"], k
(s,) = report["suites"]
assert s["name"] == "fake" and s["reproduce"] == "sagebrush bench fake"
(r,) = s["results"]
assert r["case"] == "one" and r["check"] == "agree"
e = r["engines"]["sb"]
assert e["status"] == "ok" and e["times_s"] == [0.002, 0.002] and e["median_s"] == 0.002 and e["answer"] == 1

# the report as Markdown
md = io.StringIO()
bench.markdown(report, out=md)
md = md.getvalue()
assert "### fake: a fake suite" in md and "`sagebrush bench fake`" in md, md
assert "| case | sb | other | sb/other | check |" in md and "| one | 2 ms | 2 ms | 1.00 | agree |" in md, md
assert report["host"]["load_end"] is None or len(report["host"]["load_end"]) == 3

# a competitor process that does not answer in time is killed
p = LineProcess([sys.executable, "-c", "import time; time.sleep(30)"], "END")
try:
    p.request("x\n", 0.5)
except EngineTimeout:
    assert p.proc is None
else:
    raise AssertionError("no timeout")

# the fingerprints (the FLINT harness computes the same; checked there by
# hand: det [[1,2],[3,4]], x^2 + 1, (1/5, 3/5))
P = 2**61 - 1
assert _bench_common.fingerprint([(-2, 1)]) == f"1:{P - 2}"
assert _bench_common.fpq([1, 0, 1]) == "3:1000006000010"
assert _bench_common.fpq([Fraction(1, 5), Fraction(3, 5)]) == "2:600002"
assert _bench_common.fpq([Fraction(2, 10)]) == _bench_common.fpq([Fraction(1, 5)])

print("test_bench: ok")
