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
    # small: every request and reply under about 8 MB (T's future per-call budget): #241's own claim
    "small": [("1xKx1", 400_000), ("1xKxM", 20_000), ("square", 630), ("wide", 500), ("output-heavy", 500), ("big", 12_000), ("big-1xKxM", 800), ("big-square", 100), ("huge", 600)],
}
WAIT = 600.0  # the longest any child may take (a hang guard, not a limit of the computation)
WAIVER = "WAIVED FU-MM-T (William, Oct 27 2026: land #241 with the named temporary exception; retired by tiling PR T)"
AUTHORIZED = ["dumps_ms", "loads_ms", "lead_ms", "trail_ms"]  # the uninterruptible intervals FU-MM-T names


def targeted_ok(r):
    return r.get("outcome") == "interrupted" and r.get("landed") == r["phase"] and r.get("latency_ms", 1e9) < 250 and r.get("then") == '"11"' and r.get("outstanding_back") is True


def classify(rec, set_name):
    """[(verdict, text)] for one record; verdict in PASS, FAIL, WAIVED, N/A."""
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
            # (a row for a phase that cannot be required here, e.g. from r3's
            # fixed phase list: reported, never judged)
            out.append(("N/A", "targeted (not applicable, reported only) " + json.dumps(r)))
        else:
            out.append(("PASS" if targeted_ok(r) else "FAIL", "targeted " + json.dumps(r)))
    s = rec.get("sigint")
    if s is None:
        return out
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
        return out + [("WAIVED", "sigint %s: authorized interval %s = %.0f ms >= 250 in this record, every targeted row strict-green; %s" % (WAIVER, worst[1], worst[0], what))]
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
    if rc != 0 or line != "end\n":
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


def report(recs, set_name):
    fails = 0
    real = sum(1 for r in recs if (r.get("sigint") or {}).get("sent") and not r["sigint"].get("error"))
    print("real-signal rows: %d (at least %d required)" % (real, MIN_REAL_SIGNAL_ROWS))
    if real < MIN_REAL_SIGNAL_ROWS:
        print("FAIL real-signal coverage: %d < %d" % (real, MIN_REAL_SIGNAL_ROWS))
        fails += 1
    for rec in recs:
        if rec.get("record_error"):
            print("%-12s n=%-9d FAIL record: %s" % (rec["shape"], rec["n"], rec["record_error"]))
            fails += 1
        if rec.get("transport"):
            print("%-12s n=%-9d transport %s" % (rec["shape"], rec["n"], json.dumps(rec["transport"])))
        for verdict, text in classify(rec, set_name):
            print("%-12s n=%-9d %-6s %s" % (rec["shape"], rec["n"], verdict, text))
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


def from_r3_logs(targeted_log, sigint_log):
    """Records from r3's two logs (bab9c8c5's harness printed them as text):
    the targeted log's transport and phase rows (no leading/trailing split:
    that wheel had no _test_first_last) and the SIGINT log's lines."""
    recs = {}
    for line in open(targeted_log):
        m = re.match(r"^(\S+)\s+n=(\d+)\s+(\{.*\})\s*$", line)
        if not m:
            continue
        rec = recs.setdefault((m[1], int(m[2])), dict(shape=m[1], n=int(m[2]), targeted=[]))
        d = json.loads(m[3])
        if "transport" in d:
            rec["transport"] = d["transport"]
        else:
            rec["targeted"].append({k: v for k, v in d.items() if k != "waiver"})
    for line in open(sigint_log):
        m = re.match(r"^(\S+)\s+n=(\d+)\s+\S+\s+(?:.*?: )?T=([\d.]+) s(?:: too short.*?)?[,;] KeyboardInterrupt (\d+) ms(?: after SIGINT)?, rc=(\S+?),? ?(.*)$", line.rstrip("\n"))
        if not m:
            continue
        rec = recs.setdefault((m[1], int(m[2])), dict(shape=m[1], n=int(m[2]), targeted=[]))
        rest = m[6]
        parts = [p.strip() for p in rest.split("|")]
        # (r3 sent the signal in every row, also when T < 0.5 s, and printed no
        # output lines for those: they are judged as sent, so their correctness
        # cannot be shown and they FAIL unless the lines are there)
        rec["sigint"] = dict(T=float(m[3]), sent=True, dt_ms=float(m[4]), rc=None if m[5] == "None" else int(m[5]), first=parts[0] if parts else "", last=parts[-1] if parts else "", lines=rest)
    for rec in recs.values():
        rec["phases"] = declared_phases(rec["shape"], rec["n"])
    return list(recs.values())


if __name__ == "__main__":
    args = sys.argv[1:]
    set_name = args[args.index("--set") + 1] if "--set" in args else "big"
    if "--reclassify" in args:
        recs = [json.loads(l) for l in open(args[args.index("--reclassify") + 1]) if l.strip()]
        sys.exit(1 if report(recs, set_name) else 0)
    if "--from-r3-logs" in args:
        i = args.index("--from-r3-logs")
        recs = from_r3_logs(args[i + 1], args[i + 2])
        for r in recs:
            print(json.dumps(r))
        sys.exit(0)
    if sys.platform == "win32":
        print("skipped on Windows")
        sys.exit(0)
    quick = "--quick" in args
    raw = open(args[args.index("--raw") + 1], "w") if "--raw" in args else None
    recs = []
    for shape, n in SETS[set_name]:
        if quick:
            n = n // 2 if shape in ("1xKx1", "1xKxM", "big", "big-1xKxM", "huge") else int(n / 1.26)
        rec = dict(shape=shape, n=n, set=set_name)
        rec.update(record_part(shape, n))
        rec["sigint"] = sigint_part(shape, n)
        recs.append(rec)
        if raw:
            raw.write(json.dumps(rec) + "\n")
            raw.flush()
    sys.exit(1 if report(recs, set_name) else 0)
