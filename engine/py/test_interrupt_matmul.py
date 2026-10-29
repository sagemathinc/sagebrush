"""Stop during dense integer products through the public route (CPython),
within the 250 ms Stop bound (Unix; skipped on Windows).

  python engine/py/test_interrupt_matmul.py [--set small|big] [--quick] [--raw FILE]
  python engine/py/test_interrupt_matmul.py --reclassify FILE [--set small|big]

For each shape of the set, one RECORD (written to --raw as a JSON line, so
the verdicts below can be recomputed from frozen data by --reclassify):
- transport: the uninterrupted call's own intervals: the request's
  json.dumps, the native call, the reply's json.loads, and (with a test-hooks
  wheel) the native call's leading work (call entry to the first engine
  check: serde's parse) and trailing work (the last check to the return: the
  reply's serialization);
- targeted (test-hooks wheel): for each engine phase (parse, zmat-scan, the
  dot, reply), a Stop armed at that phase's median check, its latency from the
  Stop's request to the KeyboardInterrupt in Python (the hooks' clock), the
  phase it landed in, the next product, the ledger's outstanding bytes;
- sigint: a child's uninterrupted time T, then a second child's real SIGINT
  at T / 2: the time to its KeyboardInterrupt, its exit status, its next
  product (monotonic clocks, every wait bounded, timed-out children killed).

The verdicts (classify(), a pure function of a record):
- every targeted row is STRICT in every set: interrupted, landed in its
  phase, latency < 250 ms, next product exactly "11", outstanding back;
- every phase whose guaranteed work (from the shape, in the engine's poll
  units) is at least 2^16 is REQUIRED and must have a strict row; the others
  are reported N/A with their work, never silently skipped;
- a sigint row with T < 0.5 s sends no signal and is N/A (no scheduling
  evidence), never a pass; a row whose signal was sent always has its
  correctness checked; each set needs at least 2 real-signal rows;
- a sigint row passes when correct with latency < 250 ms.  Past 250 ms it
  is WAIVED only in the big set, only when the same record shows an
  authorized uninterruptible interval of at least 250 ms (json.dumps,
  json.loads, the native leading or trailing work) and every targeted row of
  that record is strict-green; the waiver names the interval and both
  measurements.  Otherwise it FAILS.

The waiver: William, Oct 27 2026 ~5:45 PM PDT (card pr241-stop250-interim),
"Yes, land #241 now with the named temporary exception": FU-MM-T, single ZZ
mat_mul calls large enough that one uninterruptible serde parse/serialize,
Python json dumps/loads or unwind drop exceeds 250 ms, until the tiling PR T
lands, which must retire it.  Nothing else is waived."""

import json
import queue
import re
import signal
import subprocess
import sys
import threading
import time

COMMON = r'''
import json, sys, time
from sagebrush import _native
from sagebrush._engine import call
shape, n = sys.argv[1], int(sys.argv[2])
def text(r, c, f):
    return ";".join(",".join(str(f(i, j)) for j in range(c)) for i in range(r))
if shape == "1xKx1":
    a, b = text(1, n, lambda i, j: 10**8 + j), text(n, 1, lambda i, j: 10**8 - i)
elif shape == "1xKxM":
    a, b = text(1, n, lambda i, j: j % 1000 + 1), text(n, 64, lambda i, j: (i * 64 + j) % 997)
elif shape == "square":
    a = b = text(n, n, lambda i, j: (i * 7919 + j * 104729) % 10**9)
elif shape == "wide":  # n x 32 times 32 x n
    a, b = text(n, 32, lambda i, j: (i * 31 + j) % 10**9), text(32, n, lambda i, j: (i + j * 17) % 10**9)
elif shape == "output-heavy":  # n x 1 times 1 x n
    a, b = text(n, 1, lambda i, j: 10**8 + i), text(1, n, lambda i, j: 10**8 + 7 * j)
elif shape == "big":  # 1 x n x 1, 300-digit entries
    a, b = text(1, n, lambda i, j: 10**299 + 7 * j), text(n, 1, lambda i, j: 10**299 - 3 * i)
elif shape == "big-square":  # n x n, 300-digit entries
    a = b = text(n, n, lambda i, j: 10**299 + 7919 * i + 104729 * j)
elif shape == "big1k-square":  # n x n, 1000-digit entries
    a = b = text(n, n, lambda i, j: 10**999 + 7919 * i + 104729 * j)
elif shape == "big2k-square":  # n x n, 2000-digit entries
    a = b = text(n, n, lambda i, j: 10**1999 + 7919 * i + 104729 * j)
elif shape == "big-1xKxM":  # 1 x n x 16, 300-digit entries
    a, b = text(1, n, lambda i, j: 10**299 + 7 * j), text(n, 16, lambda i, j: 10**299 - 3 * i - j)
else:  # huge: 1 x n x 1, 4000-digit entries (under the 4300-digit int-str limit)
    a, b = text(1, n, lambda i, j: 10**3999 + 7 * j), text(n, 1, lambda i, j: 10**3999 - 3 * i)
def nxt():
    return json.dumps(call("mat_mul", a="1,2", b="3;4", wire="csv"))
DIMS = {
    "1xKx1": lambda n: (1, n, 1), "1xKxM": lambda n: (1, n, 64), "square": lambda n: (n, n, n),
    "wide": lambda n: (n, 32, n), "output-heavy": lambda n: (n, 1, n), "big": lambda n: (1, n, 1),
    "big-square": lambda n: (n, n, n), "big-1xKxM": lambda n: (1, n, 16), "huge": lambda n: (1, n, 1),
    "big1k-square": lambda n: (n, n, n), "big2k-square": lambda n: (n, n, n),
}
'''

SIGINT_CHILD = COMMON + r'''
print("ready", flush=True)
t = time.monotonic()
try:
    call("mat_mul", a=a, b=b, wire="csv")
    print("done %.3f" % (time.monotonic() - t), flush=True)
except KeyboardInterrupt:
    print("interrupted", flush=True)
print("then: " + nxt(), flush=True)
'''

RECORD_CHILD = COMMON + r'''
hooks = hasattr(_native, "_test_arm_at")
big = shape.startswith(("big", "huge"))
dot = "zmat-big-dot" if big else "zmat-dot"
# Each phase's GUARANTEED work, in the engine's own poll units, from the shape
# alone (never from the checks observed), and so whether it must make a check
# (at least 2^16 units: the phase's counter starts at or below 2^16 - 1):
# - parse: one matrix's text bytes (each operand parses with its own counter);
# - zmat-scan: max bits of both operands, plus the i64 conversion of both on
#   the i64 path (the BigInt path skips the conversion);
# - the dot: R C (K + 1) (i64), or R C (K w + 1) (BigInt), w the word
#   products of the largest entries, bounded below from their decimal length:
#   L digits have at least 3 (L - 1) + 1 bits (log2 10 > 3);
# - reply: R C (1 + 2): the sizing pass, and at least 2 digit units per entry.
r_, k_, c_ = DIMS[shape](n)
def words_lb(t):
    digits = max(len(x.lstrip("-")) for x in t.replace(";", ",").split(","))
    return max(1, (3 * (digits - 1) + 1) // 64)
w_ = words_lb(a) * words_lb(b) if big else 1
units = {
    "parse": max(len(a), len(b)),
    "zmat-scan": (r_ * k_ + k_ * c_) * (1 if big else 2),
    dot: r_ * c_ * (k_ * w_ + 1),
    "reply": r_ * c_ * 3,
}
required = [ph for ph in ["parse", "zmat-scan", dot, "reply"] if units[ph] >= 1 << 16]
print(json.dumps(dict(phases=dict(required=required, not_applicable={ph: units[ph] for ph in units if ph not in required}))), flush=True)
phases = required
base = _native.ledger_snapshot()["outstanding"]
t0 = time.monotonic(); req = json.dumps(dict(fn="mat_mul", a=a, b=b, wire="csv")); t1 = time.monotonic()
if hooks:
    _native._test_trace()
    h0 = _native._test_now_ns()
rep = _native.call(req)
t2 = time.monotonic()
tr = dict(request_mb=len(req) / 1e6, reply_mb=len(rep) / 1e6, dumps_ms=(t1 - t0) * 1e3, native_ms=(t2 - t1) * 1e3)
if hooks:
    h1 = _native._test_now_ns()
    first, last = _native._test_first_last()
    tr["lead_ms"] = ((first or h1) - h0) / 1e6
    tr["trail_ms"] = (h1 - last) / 1e6 if last else 0.0
json.loads(rep); tr["loads_ms"] = (time.monotonic() - t2) * 1e3
print(json.dumps(dict(transport=tr)), flush=True)
del rep, req
for ph in (phases if hooks else []):
    _native._test_trace()
    call("mat_mul", a=a, b=b, wire="csv")
    idx = _native._test_traced(ph)
    row = dict(phase=ph, checks=len(idx))
    if idx:
        _native._test_arm_at(idx[len(idx) // 2])
        try:
            call("mat_mul", a=a, b=b, wire="csv")
            row["outcome"] = "not interrupted"
        except KeyboardInterrupt:
            now = _native._test_now_ns()
            landed, at = _native._test_stopped()
            row.update(outcome="interrupted", landed=landed, latency_ms=(now - at) / 1e6)
        row["then"] = nxt()
        row["outstanding_back"] = _native.ledger_snapshot()["outstanding"] == base
    print(json.dumps(dict(targeted=row)), flush=True)
print("end", flush=True)
'''

SETS = {
    # big: about 1-4 s natively on a VM, requests or replies of 25-640 MB (the FU-MM-T evidence)
    "big": [("1xKx1", 8_000_000), ("1xKxM", 600_000), ("square", 1400), ("wide", 9000), ("output-heavy", 3000), ("big", 400_000)],
    # small: every request and reply under about 8 MB (T's future per-call budget): #241's own claim.
    # big1k-square and big2k-square (requests and replies of about 7.1-7.2 MB)
    # are the most work per byte under that cap, so that a fast timing box
    # still has real-signal rows (T >= 0.5 s): VM3/VM4 gave square 630 and
    # big-square 100 T = 0.42-0.57 s, too close to 0.5 s to count on
    "small": [("1xKx1", 400_000), ("1xKxM", 20_000), ("square", 630), ("wide", 500), ("output-heavy", 500), ("big", 12_000), ("big-1xKxM", 800), ("big-square", 100), ("huge", 600),
              ("big1k-square", 60), ("big2k-square", 42)],
}
WAIT = 600.0  # the longest any child may take (a hang guard, not a limit of the computation)
WAIVER = "WAIVED FU-MM-T (William, Oct 27 2026: land #241 with the named temporary exception; retired by tiling PR T)"
AUTHORIZED = ["dumps_ms", "loads_ms", "lead_ms", "trail_ms"]  # the uninterruptible intervals FU-MM-T names


def targeted_ok(r):
    return r.get("outcome") == "interrupted" and r.get("landed") == r["phase"] and r.get("latency_ms", 1e9) < 250 and r.get("then") == '"11"' and r.get("outstanding_back") is True


def classify(rec):
    """[(verdict, text)] for one record; verdict in PASS, FAIL, WAIVED, N/A.
    A pure function of the record: the set (and so waiver eligibility) is the
    record's own required "set" field, never a command-line choice."""
    set_name = rec.get("set")
    if set_name not in SETS:
        return [("FAIL", "record without a known set (%r): no verdict can be given" % (set_name,))]
    out = []
    targeted = rec.get("targeted") or []
    ph = rec.get("phases")
    if ph is not None:
        seen = {r["phase"] for r in targeted}
        for p in ph["required"]:
            if p not in seen:
                out.append(("FAIL", "targeted: required phase %s has no row" % p))
        for p, u in sorted(ph["not_applicable"].items()):
            out.append(("N/A", "targeted %s: not applicable here (guaranteed work %d units < 2^16)" % (p, u)))
    na = set((ph or {}).get("not_applicable", {}))
    for r in targeted:
        if r["phase"] in na:
            # (a row for a phase that cannot be required here, e.g. from the
            # earlier harness's fixed phase list: reported, never judged)
            out.append(("N/A", "targeted (not applicable, reported only) " + json.dumps(r)))
        else:
            out.append(("PASS" if targeted_ok(r) else "FAIL", "targeted " + json.dumps(r)))
    s = rec.get("sigint")
    if s is None:
        return out + [("FAIL", "sigint: no sigint evidence in this record")]
    if s.get("error"):
        return out + [("FAIL", "sigint " + s["error"])]
    if s.get("sent") is False:
        return out + [("N/A", "sigint: T=%.2f s < 0.5 s, no signal sent (no scheduling evidence)" % s["T"])]
    what = "T=%.2f s, KeyboardInterrupt %.0f ms after SIGINT, rc=%s, %s" % (s["T"], s["dt_ms"], s["rc"], s.get("lines", "")[:120])
    correct = s.get("first") == "interrupted" and s["rc"] == 0 and s.get("last") == 'then: "11"'
    if correct and s["dt_ms"] < 250:
        return out + [("PASS", "sigint " + what)]
    tr = rec.get("transport") or {}
    worst = max(((tr.get(k) or 0.0), k) for k in AUTHORIZED)
    if correct and set_name == "big" and worst[0] >= 250 and targeted and all(targeted_ok(r) for r in targeted):
        return out + [("WAIVED", "sigint FAIL, waived: %s: authorized interval %s = %.0f ms >= 250 in this record, every targeted row strict-green; %s" % (WAIVER, worst[1], worst[0], what))]
    why = "incorrect" if not correct else ("small set: strict" if set_name != "big" else "no authorized interval >= 250 ms with strict-green targeted rows (worst %s = %.0f ms)" % (worst[1], worst[0]))
    return out + [("FAIL", "sigint (%s) %s" % (why, what))]


def spawn(code, shape, n):
    """The child, with a reader thread queueing its stdout lines (so every
    wait below is bounded, whatever the pipe's buffering)."""
    c = subprocess.Popen([sys.executable, "-c", code, shape, str(n)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    c.lines = queue.Queue()

    def pump():
        for line in c.stdout:
            c.lines.put(line)
        c.lines.put("")  # EOF

    threading.Thread(target=pump, daemon=True).start()
    return c


def readline(c, deadline):
    """One line of the child's stdout ("" at EOF), waiting at most until the
    deadline (monotonic); None on timeout."""
    try:
        return c.lines.get(timeout=max(0.0, deadline - time.monotonic()))
    except queue.Empty:
        return None


def finish(c, timeout=60.0):
    """The child's remaining stdout lines (joined), its stderr and its exit
    status; killed (and reaped) on timeout, status None."""
    try:
        rc = c.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        c.kill()
        c.wait()
        rc = None
    out = []
    while True:
        line = readline(c, time.monotonic() + 5)
        if not line:
            break
        out.append(line)
    err = c.stderr.read()
    return "".join(out), err + ("" if rc is not None else "\n(killed after %.0f s)" % timeout), rc


def record_part(shape, n):
    c = spawn(RECORD_CHILD, shape, n)
    rec, deadline, line = dict(targeted=[]), time.monotonic() + WAIT, None
    while True:
        line = readline(c, deadline)
        if line is None or line == "" or line == "end\n":
            break
        d = json.loads(line)
        if "transport" in d:
            rec["transport"] = d["transport"]
        elif "phases" in d:
            rec["phases"] = d["phases"]
        else:
            rec["targeted"].append(d["targeted"])
    out, err, rc = finish(c, 30)
    rec["end"] = rc == 0 and line == "end\n"
    if not rec["end"]:
        rec["record_error"] = "rc=%s, %s" % (rc, err.strip()[-300:])
    return rec


def sigint_part(shape, n):
    c = spawn(SIGINT_CHILD, shape, n)
    if readline(c, time.monotonic() + WAIT) != "ready\n":
        out, err, _ = finish(c, 5)
        return dict(error="no ready line: " + (out + err)[-300:])
    out, err, rc = finish(c, WAIT)
    if rc != 0 or not out.startswith("done "):
        return dict(error="calibration rc=%s: %s" % (rc, (out + err)[-300:]))
    T = float(out.split()[1])
    if T < 0.5:
        # (too short for a signal at T / 2 to be scheduling evidence: no
        # signal is sent, and the row is N/A, never a pass)
        return dict(T=T, sent=False)
    c = spawn(SIGINT_CHILD, shape, n)
    if readline(c, time.monotonic() + WAIT) != "ready\n":
        out, err, _ = finish(c, 5)
        return dict(error="no ready line: " + (out + err)[-300:])
    time.sleep(T / 2)
    ts = time.monotonic()
    c.send_signal(signal.SIGINT)
    first = readline(c, ts + 60)
    dt = time.monotonic() - ts
    out, err, rc = finish(c, 60)
    lines = ((first or "") + out).splitlines()
    return dict(T=T, sent=True, dt_ms=dt * 1000, rc=rc, first=(first or "").strip(), last=lines[-1] if lines else "", lines=" | ".join(lines) + err.strip()[-200:])


MIN_REAL_SIGNAL_ROWS = 2  # per set: rows where a signal was actually sent and judged


def expected_rows(set_name, quick):
    """The (shape, n) pairs a complete run of this set has, in order."""
    out = []
    for shape, n in SETS[set_name]:
        if quick:
            n = n // 2 if shape in ("1xKx1", "1xKxM", "big", "big-1xKxM", "huge") else int(n / 1.26)
        out.append((shape, n))
    return out


def report(recs, cli_set=None, errors=()):
    """Print every verdict; the number of FAILs.  Fails closed: the records
    must name one known set (a --set given on the command line must agree;
    it never decides waivers), every expected (shape, n) of that set must
    have exactly one complete record (phases, transport, sigint, end), and
    any conversion error counts."""
    fails = 0
    for e in errors:
        print("FAIL evidence: %s" % e)
        fails += 1
    sets = {r.get("set") for r in recs}
    quicks = {bool(r.get("quick")) for r in recs}
    if len(sets) != 1 or next(iter(sets)) not in SETS or len(quicks) != 1:
        print("FAIL provenance: the records name sets %r and quick %r: exactly one known set and one size are required" % (sorted(map(str, sets)), sorted(quicks)))
        return fails + 1
    set_name, quick = next(iter(sets)), next(iter(quicks))
    if cli_set is not None and cli_set != set_name:
        print("FAIL provenance: --set %s, but the records are from the %s set" % (cli_set, set_name))
        return fails + 1
    print("set %s%s (from the records)" % (set_name, " --quick" if quick else ""))
    want = expected_rows(set_name, quick)
    got = [(r.get("shape"), r.get("n")) for r in recs]
    for key in want:
        c = got.count(key)
        if c != 1:
            print("FAIL completeness: %s n=%s has %d records (exactly 1 required)" % (key[0], key[1], c))
            fails += 1
    for key in got:
        if key not in want:
            print("FAIL completeness: %s n=%s is not in the %s set" % (key[0], key[1], set_name))
            fails += 1
    real = sum(1 for r in recs if (r.get("sigint") or {}).get("sent") and not r["sigint"].get("error"))
    print("real-signal rows: %d (at least %d required)" % (real, MIN_REAL_SIGNAL_ROWS))
    if real < MIN_REAL_SIGNAL_ROWS:
        print("FAIL real-signal coverage: %d < %d" % (real, MIN_REAL_SIGNAL_ROWS))
        fails += 1
    for rec in recs:
        tag = "%-12s n=%-9s" % (rec.get("shape"), rec.get("n"))
        for part in ["phases", "transport", "sigint"]:
            if not rec.get(part):
                print("%s FAIL record: no %s" % (tag, part))
                fails += 1
        if rec.get("end") is not True:
            print("%s FAIL record: not complete (no end status)" % tag)
            fails += 1
        if rec.get("record_error"):
            print("%s FAIL record: %s" % (tag, rec["record_error"]))
            fails += 1
        if rec.get("transport"):
            print("%s transport %s" % (tag, json.dumps(rec["transport"])))
        for verdict, text in classify(rec):
            print("%s %-6s %s" % (tag, verdict, text))
            fails += verdict == "FAIL"
    return fails


# per shape: (R, K, C) from n, and the fewest decimal digits of an entry of A
# and of B (lower bounds, as the child's entry formulas give them), and BigInt
DECLARED = {
    "1xKx1": (lambda n: (1, n, 1), 9, 9, False), "1xKxM": (lambda n: (1, n, 64), 1, 1, False),
    "square": (lambda n: (n, n, n), 1, 1, False), "wide": (lambda n: (n, 32, n), 1, 1, False),
    "output-heavy": (lambda n: (n, 1, n), 9, 9, False), "big": (lambda n: (1, n, 1), 300, 300, True),
    "big-square": (lambda n: (n, n, n), 300, 300, True), "big-1xKxM": (lambda n: (1, n, 16), 300, 300, True),
    "huge": (lambda n: (1, n, 1), 4000, 4000, True),
    "big1k-square": (lambda n: (n, n, n), 1000, 1000, True), "big2k-square": (lambda n: (n, n, n), 2000, 2000, True),
}


def declared_phases(shape, n):
    """The child's required/not-applicable phases, from the shape alone with
    lower-bound entry lengths (for records from logs that carry none)."""
    dims, da, db, big = DECLARED[shape]
    r, k, c = dims(n)
    wl = lambda d: max(1, (3 * (d - 1) + 1) // 64)
    dot = "zmat-big-dot" if big else "zmat-dot"
    units = {
        "parse": max(r * k * (da + 1), k * c * (db + 1)),
        "zmat-scan": (r * k + k * c) * (1 if big else 2),
        dot: r * c * (k * (wl(da) * wl(db) if big else 1) + 1),
        "reply": r * c * 3,
    }
    req = [p for p in ["parse", "zmat-scan", dot, "reply"] if units[p] >= 1 << 16]
    return dict(required=req, not_applicable={p: units[p] for p in units if p not in req}, declared_from="shape, lower-bound entry lengths")


def from_r3_logs(targeted_log, sigint_log, set_name, quick):
    """(records, errors) from the earlier harness's two text logs (bab9c8c5's
    harness), for `set_name` (required; written into every record).  Fails
    closed: every non-blank line must parse, as a row, a known duplicate FAIL
    line, a SIGINT row or a SIGINT failure from those logs (kept as that
    record's sigint error); anything else is an error.  That harness printed
    no end status per shape, so a
    record has one when its transport row and every required phase row are
    there and its SIGINT line is."""
    recs, errors = {}, []

    def rec_for(shape, n):
        if shape not in DECLARED:
            errors.append("unknown shape %r" % shape)
        return recs.setdefault((shape, n), dict(shape=shape, n=n, set=set_name, quick=quick, targeted=[], source="r3 logs"))

    for no, line in enumerate(open(targeted_log), 1):
        line = line.rstrip("\n")
        if not line.strip():
            continue
        m = re.match(r"^(\S+)\s+n=(\d+)\s+(\{.*\})\s*$", line)
        if m:
            try:
                d = json.loads(m[3])
            except ValueError:
                errors.append("targeted log line %d: bad JSON: %s" % (no, line[:200]))
                continue
            rec = rec_for(m[1], int(m[2]))
            if "transport" in d:
                rec["transport"] = d["transport"]
            else:
                rec["targeted"].append({k: v for k, v in d.items() if k != "waiver"})
            continue
        if re.match(r"^(\S+)\s+FAIL \{.*\}\s*$", line):
            continue  # (the earlier harness repeated each bad row as "<shape> FAIL {...}": the row above has it)
        errors.append("targeted log line %d: unparsed: %s" % (no, line[:200]))
    for no, line in enumerate(open(sigint_log), 1):
        line = line.rstrip("\n")
        if not line.strip():
            continue
        m0 = re.match(r"^(\S+)\s+n=(\d+)\s+(ok|FAIL)\s+(.*)$", line)
        if not m0:
            errors.append("sigint log line %d: unparsed: %s" % (no, line[:200]))
            continue
        rec = rec_for(m0[1], int(m0[2]))
        what = m0[4]
        if "sigint" in rec:
            errors.append("sigint log line %d: a second SIGINT line for %s n=%s" % (no, m0[1], m0[2]))
        m = re.match(r"^(?:.*?: )?T=([\d.]+) s(?:: too short.*?)?[,;] KeyboardInterrupt (\d+) ms(?: after SIGINT)?, rc=(\S+?),? ?(.*)$", what)
        if m:
            parts = [p.strip() for p in m[4].split("|")]
            # (the earlier harness sent the signal in every row, also when T < 0.5 s, and then
            # printed no output lines: judged as sent, so they FAIL as unproven)
            rec["sigint"] = dict(T=float(m[1]), sent=True, dt_ms=float(m[2]), rc=None if m[3] == "None" else int(m[3]), first=parts[0] if parts else "", last=parts[-1] if parts else "", lines=m[4])
        elif what.startswith(("no ready line", "calibration rc=")):
            rec["sigint"] = dict(error=what[:300])
        else:
            rec["sigint"] = dict(error="unparsed legacy SIGINT line: " + what[:300])
            errors.append("sigint log line %d: unparsed: %s" % (no, line[:200]))
    for rec in recs.values():
        if rec["shape"] in DECLARED:
            rec["phases"] = declared_phases(rec["shape"], rec["n"])
            seen = {r["phase"] for r in rec["targeted"]}
            rec["end"] = "transport" in rec and "sigint" in rec and all(p in seen for p in rec["phases"]["required"])
    return list(recs.values()), errors


def selftest(good_targeted, good_sigint):
    """Fail-first controls for the converter, the completeness checks and the
    provenance rule, beside the good frozen-log control: each must give the
    stated outcome.  Returns the number of controls that did not."""
    import contextlib
    import io
    import os
    import tempfile

    def run(recs, errors=(), cli_set=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            n = report(recs, cli_set, errors)
        return n, buf.getvalue()

    bad = 0

    def expect(name, cond, detail=""):
        nonlocal bad
        print("%s  %s %s" % ("ok  " if cond else "BAD ", name, detail))
        bad += not cond

    good, errs = from_r3_logs(good_targeted, good_sigint, "big", True)
    n, out = run(good, errs)
    expect("good frozen logs: no conversion error", not errs, str(errs)[:200])
    expect("good frozen logs: the 454 ms row is 'FAIL, waived' via an authorized interval", "FAIL, waived" in out and "dumps_ms" in out)
    expect("good frozen logs: no FAIL", n == 0, "(%d)" % n)
    tmp = tempfile.mkdtemp()

    def write(name, text):
        path = os.path.join(tmp, name)
        open(path, "w").write(text)
        return path

    sig = open(good_sigint).read()
    tgt = open(good_targeted).read()
    # no ready line / calibration failure in place of the big row's SIGINT line
    for label, repl in [("no-ready", "big          n=200000    FAIL  no ready line: Traceback (most recent call last)"), ("calibration failure", "big          n=200000    FAIL  calibration rc=1: MemoryError")]:
        lines = [repl if l.startswith("big ") else l for l in sig.splitlines()]
        recs, errs = from_r3_logs(good_targeted, write("s.log", "\n".join(lines) + "\n"), "big", True)
        n, out = run(recs, errs)
        expect("%s: FAILs, the error kept on the record" % label, n > 0 and repl.split("FAIL  ")[1][:20] in out)
    # an omitted shape (no lines at all for 'wide')
    recs, errs = from_r3_logs(write("t.log", "\n".join(l for l in tgt.splitlines() if not l.startswith("wide ")) + "\n"), write("s.log", "\n".join(l for l in sig.splitlines() if not l.startswith("wide ")) + "\n"), "big", True)
    n, out = run(recs, errs)
    expect("omitted shape: FAILs on completeness", n > 0 and "completeness: wide" in out)
    # a missing SIGINT line for one shape
    recs, errs = from_r3_logs(good_targeted, write("s.log", "\n".join(l for l in sig.splitlines() if not l.startswith("square ")) + "\n"), "big", True)
    n, out = run(recs, errs)
    expect("missing sigint: FAILs", n > 0 and "no sigint" in out)
    # a truncated targeted log (cut inside the square shape's rows)
    lines = tgt.splitlines()
    cut = next(i for i, l in enumerate(lines) if l.startswith("square ") and '"phase": "zmat-scan"' in l)
    recs, errs = from_r3_logs(write("t.log", "\n".join(lines[:cut]) + "\n"), good_sigint, "big", True)
    n, out = run(recs, errs)
    expect("truncated record: FAILs", n > 0 and ("required phase zmat-scan has no row" in out or "not complete" in out))
    # an unparsed line
    recs, errs = from_r3_logs(write("t.log", tgt + "Traceback (most recent call last):\n"), good_sigint, "big", True)
    n, out = run(recs, errs)
    expect("unparsed line: FAILs", n > 0 and "unparsed" in out)
    # provenance: the same record as small-set cannot be waived, whatever the CLI says
    small = [dict(r, set="small") for r in good]
    for cli in [None, "big"]:
        n, out = run(small, (), cli)
        expect("small-set record under --set %s: never waived, FAILs" % cli, "FAIL, waived" not in out and n > 0)
    big_row = [r for r in good if r["shape"] == "big"]
    expect("the explicitly recorded big-set row: waivable", "FAIL, waived" in "".join(t for _, t in classify(big_row[0])))
    expect("a record without a set: FAIL", classify(dict(big_row[0], set=None))[0][0] == "FAIL")
    n, out = run(good + small)
    expect("mixed sets: FAIL provenance", n > 0 and "provenance" in out)
    return bad


if __name__ == "__main__":
    args = sys.argv[1:]
    cli_set = args[args.index("--set") + 1] if "--set" in args else None
    quick = "--quick" in args
    if "--selftest" in args:
        i = args.index("--selftest")
        sys.exit(1 if selftest(args[i + 1], args[i + 2]) else 0)
    if "--reclassify" in args:
        lines = [json.loads(l) for l in open(args[args.index("--reclassify") + 1]) if l.strip()]
        recs = [d for d in lines if "conversion_error" not in d]
        errors = [d["conversion_error"] for d in lines if "conversion_error" in d]
        sys.exit(1 if report(recs, cli_set, errors) else 0)
    if "--from-r3-logs" in args:
        if cli_set not in SETS:
            print("--from-r3-logs needs --set small|big (written into every record)")
            sys.exit(2)
        i = args.index("--from-r3-logs")
        recs, errors = from_r3_logs(args[i + 1], args[i + 2], cli_set, quick)
        for r in recs:
            print(json.dumps(r))
        for e in errors:
            print(json.dumps(dict(conversion_error=e)))
        sys.exit(1 if errors else 0)
    if sys.platform == "win32":
        print("skipped on Windows")
        sys.exit(0)
    set_name = cli_set or "big"
    raw = open(args[args.index("--raw") + 1], "w") if "--raw" in args else None
    recs = []
    for shape, n in expected_rows(set_name, quick):
        rec = dict(shape=shape, n=n, set=set_name, quick=quick)
        rec.update(record_part(shape, n))
        rec["sigint"] = sigint_part(shape, n)
        recs.append(rec)
        if raw:
            raw.write(json.dumps(rec) + "\n")
            raw.flush()
    sys.exit(1 if report(recs) else 0)
