"""A value probe for MATLAB mode's catalog entries (catalog/SCHEMA.md), as
scripts/catalog-probe.py is for Python mode's: before an entry is "full", its
function must give MATLAB's answer on edge values of each argument, not only
on its examples. GNU Octave is the black-box oracle where it agrees with
MATLAB's documented behaviour; where it doesn't, the documentation wins and
the case is listed in the probe file's `octave_differs` with the reason.

    python3 scripts/catalog-probe-matlab.py --generate OUT [NAME...]   under Octave: the calls, and
                                                                     Octave's answer to each
    python3 scripts/catalog-probe-matlab.py --run PROBES SB            the same calls in Sagebrush
    python3 scripts/catalog-probe-matlab.py --compare PROBES SB OUT [RULES]
                                                                     each name's calls and the ones
                                                                     whose answers differ; RULES
                                                                     (catalog/matlab/probes/octave-differs.json)
                                                                     lists Octave's documented differences
    python3 scripts/catalog-probe-matlab.py --apply OUT                from compare's OUT, the probe file
                                                                     catalog/matlab/probes/octave.json, and
                                                                     the statuses and differs of the entries

The calls come from each entry's examples of one call, NAME(a, b, ...): each
argument in turn is varied over VALUES, the others kept. An answer is
{"printed": what the call printed, "value": what matlab-tests/show.m prints for
the result (class, size and contents; for a number, to 17 significant digits)},
or {"printed": ..., "error": the message}. The program's markers carry a random
token per run, so no output can be taken for them. Two answers agree when their
outcomes and printed texts are the same and their values are, but for the
numbers of numeric payloads, which agree to about 12 significant digits, as
Octave's last bits are not MATLAB's (an error's message is not compared).

Time bounds: a name's calls run in one process with a deadline of
NAME_SECONDS; past it, each call runs in a process of its own with
CALL_SECONDS. A call Octave gives no outcome for (it does not finish) is kept
without an oracle, and only a rule can decide it; one Sagebrush does not
finish is recorded as "timeout", a difference. A process that prints more than
OUTPUT_BYTES (stdout and stderr together) is killed and counts as one that
did not finish.

Scope: the probe runs only the catalog's own example calls and the values
above, so it does not defend against code that inspects the harness (the run's
token is visible to the code it runs). It fails closed on structure all the
same: a call whose records are duplicated, out of order or not in the
harness's shape is incomplete, and an index that was not asked for makes the
whole run's answers incomplete.
"""
import codecs
import glob
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OCTAVE = os.environ.get("OCTAVE", "/usr/bin/octave")
CLI = os.path.join(ROOT, "dist", "src", "cli.js")
NAME_SECONDS = 300
CALL_SECONDS = 5

# (each argument in turn is replaced by each of these)
VALUES = ["0", "-1", "1", "2", "7", "2.5", "-0", "NaN", "Inf", "-Inf", "[]", "zeros(1, 0)", "zeros(0, 3)",
          "[3 1 2]", "[3; 1; 2]", "[1 2; 3 4]", "magic(3)", "[1 NaN 3]", "int8(-5)", "uint8(200)", "int32([1 2 3])",
          "single(2.5)", "single([1 2])", "true", "[true false true]", "'abc'", "''", "\"abc\"", "[\"a\" \"b\"]",
          "1 + 2i", "[1+2i 3]", "{1, 2}", "{'a', 'b'}", "@sin", "@(x) x + 1", "struct('a', 1)", "'all'", "'omitnan'"]

# (names not probed: Octave is no oracle for them)
SKIP = {
    "rand": "Octave's generator streams differ from MATLAB's",
    "randn": "Octave's generator streams differ from MATLAB's",
    "randi": "Octave's generator streams differ from MATLAB's",
    "rng": "Octave's generator streams differ from MATLAB's",
    "disp": "it prints: MATLAB's and Octave's displays differ",
    "ode45": "the solver's own step points differ between implementations",
}


def entries():
    out = []
    for f in sorted(glob.glob(os.path.join(ROOT, "catalog", "matlab", "*.json"))):
        out.extend(e for e in json.load(open(f, encoding="utf-8")) if e.get("status") != "absent")
    return out


def split_args(s):
    """the top-level, comma-separated arguments of a call's text"""
    out, depth, cur, quote = [], 0, "", None
    for i, c in enumerate(s):
        if quote:
            cur += c
            if c == quote:
                quote = None
            continue
        if c in "\"" or (c == "'" and (not cur.strip() or cur.rstrip()[-1] in "([{,;= ")):
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
            continue
        cur += c
    if cur.strip():
        out.append(cur.strip())
    return out


def _closes_at_end(inner):
    """whether the call's parentheses enclose all of inner: no statement after it"""
    depth, quote = 0, None
    for i, c in enumerate(inner):
        if quote:
            if c == quote:
                quote = None
            continue
        if c == '"' or (c == "'" and (i == 0 or inner[i - 1] in "([{,;= ")):
            quote = c
        elif c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth < 0:
                return False
    return depth == 0 and quote is None


def bases(e):
    """the argument lists of the entry's examples that are one call of it"""
    name = e["name"]
    out = []
    for x in e.get("examples", []):
        code = x["code"].strip()
        m = re.match(r"^(?:\[[^\]]*\]\s*=\s*|\w+\s*=\s*)?" + re.escape(name) + r"\((.*)\)$", code, re.S)
        if m and "\n" not in code and _closes_at_end(m.group(1)):
            args = split_args(m.group(1))
            if args not in out:
                out.append(args)
    return out


def calls(e):
    out = []
    for b in bases(e):
        out.append(", ".join(b))
        for i in range(len(b)):
            for v in VALUES:
                a = list(b)
                a[i] = v
                out.append(", ".join(a))
    seen = set()
    return [c for c in out if not (c in seen or seen.add(c))]


def program_exprs(exprs, nonce):
    """the program for exprs; its markers carry nonce, a random token the calls' output cannot
    contain, so they are never confused with what a call prints or returns"""
    lines = []
    for k, x in enumerate(exprs):
        lines.append("fprintf('@@%s call %d@@\\n');" % (nonce, k))
        lines.append("try\n  r__ = %s;\n  fprintf('@@%s value@@\\n');\n  show(r__);\ncatch err__\n"
                     "  fprintf('@@%s error@@\\n');\n  disp(err__.message);\nend\nfprintf('@@%s end@@\\n');\nclear r__" % (x, nonce, nonce, nonce))
    return "\n".join(lines) + "\n"


def _latin1_fallback(e):
    """a byte that is not UTF-8 (Octave prints char(200) as one raw byte) as its Latin-1 character"""
    return "".join(chr(b) for b in e.object[e.start:e.end]), e.end


codecs.register_error("latin1-fallback", _latin1_fallback)


# (the most a program may print, stdout and stderr together: past it the process is killed and
# its output counts as cut off)
OUTPUT_BYTES = 64 << 20


def _capture(cmd, cwd, timeout, cap=OUTPUT_BYTES):
    """(stdout's bytes, None) for a process that exits with status 0 within timeout and prints
    at most cap bytes in all; (None, "timeout") or (None, "overflow") once it has been killed,
    and (None, "exit") for any other end (a crash, a signal, a nonzero status). Both pipes are
    read as they fill, so neither the memory used nor the time waited exceeds its bound"""
    p = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, total, over = [], [0], threading.Event()
    lock = threading.Lock()

    def pump(pipe, keep):
        while True:
            b = pipe.read1(1 << 16)
            if not b:
                return
            with lock:
                total[0] += len(b)
                if total[0] > cap:
                    over.set()
                    p.kill()
                    return
                if keep:
                    out.append(b)
    ts = [threading.Thread(target=pump, args=(p.stdout, True), daemon=True),
          threading.Thread(target=pump, args=(p.stderr, False), daemon=True)]
    for t in ts:
        t.start()
    try:
        p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
        for t in ts:
            t.join()
        return None, "timeout"
    for t in ts:
        t.join()
    if over.is_set():
        return None, "overflow"
    if p.returncode != 0:
        return None, "exit"
    return b"".join(out), None


def run_program(kind, src, timeout):
    """what the program prints, under Octave or Sagebrush: its exact text (UTF-8, a byte that is
    not UTF-8 as its Latin-1 character, and no newline translation: a CR stays a CR), or None
    past timeout or OUTPUT_BYTES, or when the process did not exit with status 0"""
    d = tempfile.mkdtemp(prefix="catalog-probe-")
    try:
        shutil.copy(os.path.join(ROOT, "matlab-tests", "show.m"), d)
        path = os.path.join(d, "probe_calls.m")
        open(path, "w").write(src)
        cmd = [OCTAVE, "--norc", "--quiet", "--no-history", "--no-window-system", "probe_calls.m"] if kind == "octave" else ["node", CLI, "--matlab", path]
        raw, _ = _capture(cmd, d, timeout)
        return None if raw is None else raw.decode("utf-8", "latin1-fallback")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _parse(part, nonce):
    """one call's output as an answer: {"printed": what it printed, "value": show.m's line} or
    {"printed": ..., "error": the message}. Anything else is {"printed": ..., "incomplete": true},
    which never matches: a record not closed by its end marker (the process died or was killed
    mid-record), no outcome marker, or a structure the harness does not write (more than one of
    a marker, an error marker before the value marker)"""
    vmark, emark, end = "@@%s value@@\n" % nonce, "@@%s error@@\n" % nonce, "@@%s end@@\n" % nonce
    if part.count(end) != 1 or not part.endswith(end):
        return {"printed": part, "incomplete": True}
    part = part[:-len(end)]
    nv, ne = part.count(vmark), part.count(emark)
    if nv > 1 or ne > 1 or (nv and ne and part.index(emark) < part.index(vmark)):
        return {"printed": part, "incomplete": True}
    if ne:
        # (the catch ran: the call failed, or show.m did after the value marker)
        before, _, rest = part.partition(emark)
        return {"printed": before.partition(vmark)[0], "error": rest[:-1] if rest.endswith("\n") else rest}
    if nv:
        printed, _, rest = part.partition(vmark)
        return {"printed": printed, "value": rest[:-1] if rest.endswith("\n") else rest}
    return {"printed": part, "incomplete": True}


def _records(out, nonce, n):
    """the n calls' answers from a program's output, in one pass over it. Calls must appear once
    each, in order: a call that appears twice or out of place is incomplete. An index that was
    not asked for, or that is not one the harness writes (a canonical number of at most 9 digits),
    makes every answer of the run incomplete. Text before the first call marker is ignored"""
    pieces = re.split(r"@@%s call ([^@\n]*)@@\n" % re.escape(nonce), out)
    untrusted = [{"printed": "", "incomplete": True} for _ in range(n)]
    count, at = [0] * n, [-1] * n
    for pos, text in enumerate(pieces[1::2]):
        if not re.fullmatch(r"0|[1-9][0-9]{0,8}", text):
            return untrusted
        k = int(text)
        if k >= n:
            return untrusted
        count[k] += 1
        if at[k] < 0:
            at[k] = pos
    return [_parse(pieces[2 * k + 2], nonce) if count[k] == 1 and at[k] == k else {"printed": "", "incomplete": True}
            for k in range(n)]


def answers(kind, name, cs):
    """[answer or None] for each call: one process for the name, else one per call"""
    return answers_exprs(kind, ["%s(%s)" % (name, c) for c in cs])


def answers_exprs(kind, exprs):
    """[answer or None] for each expression: one process for all, else one per expression"""
    nonce = secrets.token_hex(16)
    out = run_program(kind, program_exprs(exprs, nonce), NAME_SECONDS)
    if out is not None:
        got = _records(out, nonce, len(exprs))
        if not any("incomplete" in g for g in got):
            return got
    res = []
    for x in exprs:
        nonce = secrets.token_hex(16)
        o = run_program(kind, program_exprs([x], nonce), CALL_SECONDS)
        res.append(None if o is None else _records(o, nonce, 1)[0])
    return res


def generate(out_file, names):
    es = [e for e in entries() if not names or e["name"] in names]
    probes = []
    skipped = {}
    for e in es:
        if e["name"] in SKIP:
            skipped[e["name"]] = SKIP[e["name"]]
            continue
        cs = calls(e)
        if not cs:
            skipped[e["name"]] = "no example of one call to vary"
            continue
        for c, a in zip(cs, answers("octave", e["name"], cs)):
            # (an Octave call with no outcome, cut off or in a process that timed out, died or
            # printed too much, is kept: it has no oracle, but a rule may still decide it, and
            # Sagebrush must still answer it)
            probes.append({"name": e["name"], "args": c, "octave": a if a is not None else {"printed": "", "incomplete": True}})
    v = subprocess.run([OCTAVE, "--version"], capture_output=True, text=True).stdout.split("\n")[0]
    m = re.search(r"version (\S+)", v)
    json.dump({"octave_version": m.group(1) if m else None, "probes": probes, "skipped": skipped}, open(out_file, "w"), indent=1)
    print("%d calls of %d functions; %d not probed" % (len(probes), len(es) - len(skipped), len(skipped)))


def _template(rule, name, args):
    """a rule's "matlab" template filled in: {name}, and {0}, {1}, ... the call's arguments"""
    return rule["matlab"].format(*split_args(args), name=name)


def _rule_matches(u, name, args):
    """a rule covers a call: its name; "args", a regular expression searched in the whole
    argument list; "arg" and "value", the argument at that position (from 0) matching the
    regular expression whole; "nargs", the number of arguments"""
    if u["name"] != name:
        return False
    if "args" in u and not re.search(u["args"], args):
        return False
    a = split_args(args)
    if "nargs" in u and len(a) not in (u["nargs"] if isinstance(u["nargs"], list) else [u["nargs"]]):
        return False
    if "arg" in u:
        ks = u["arg"] if isinstance(u["arg"], list) else [u["arg"]]
        if not any(k < len(a) and re.fullmatch(u["value"], a[k]) for k in ks):
            return False
    return True


def _rule_for(rules, name, args):
    # (a template is Octave's evaluation, so it says nothing about a call with a string argument,
    # Octave having no string class: such a call stays without an oracle)
    return next((u for u in rules if _rule_matches(u, name, args) and not ("matlab" in u and NO_ORACLE.search(args))), None)


def oracle(probes_file, rules_file):
    """under Octave: for each call a rule with a "matlab" template covers, the template's
    answer, which is MATLAB's documented answer to the call, kept in the probe as its "matlab" field"""
    data = json.load(open(probes_file))
    rules = _rules(rules_file)
    todo = []
    for p in data["probes"]:
        p.pop("matlab", None)
        u = _rule_for(rules, p["name"], p["args"])
        if u and "matlab" in u:
            todo.append((p, _template(u, p["name"], p["args"])))
    by = {}
    for p, x in todo:
        by.setdefault(p["name"], []).append((p, x))
    for name, items in by.items():
        got = answers_exprs("octave", [x for _, x in items])
        for (p, x), g in zip(items, got):
            if g is not None:
                p["matlab"] = g
    json.dump(data, open(probes_file, "w"), indent=1)
    bad = [(p["name"], x) for p, x in todo if "matlab" not in p or _is_error(p["matlab"]) or _no_answer(p["matlab"])]
    print("%d calls given MATLAB's documented answer by a rule's template; %d templates gave no answer%s" % (
        len(todo) - len(bad), len(bad), "".join("\n  %s: %s" % b for b in bad[:20])))


def run(probes_file, sb_file):
    data = json.load(open(probes_file))
    by = {}
    for p in data["probes"]:
        by.setdefault(p["name"], []).append(p["args"])
    sb = {}
    for name, cs in by.items():
        got = answers("sagebrush", name, cs)
        sb[name] = [{"args": c, "sagebrush": "timeout" if g is None else g} for c, g in zip(cs, got)]
    json.dump(sb, open(sb_file, "w"), indent=1)
    print("%d functions run" % len(sb))


_NUM = re.compile(r"-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?", re.I)
# (per name, the relative tolerance of a comparison: integral's default RelTol, fzero's
# last iterate, which the catalog says can differ)
TOLERANCE = {"integral": 1e-6, "fzero": 1e-6}


# (a numeric value as show.m prints it: its class and size, then a number or a bracketed list)
_NUMERIC = re.compile(r"\b(?:double|single|u?int(?:8|16|32|64)) \d+(?:x\d+)+ (\[[^\]]*\]|[^ ,;}\n]+)")


def _numbers(v):
    """show.m's line as compared: (its text with each number of a numeric value's payload as a
    NUL, those numbers). Char contents (show.m's quoted '...' literals, with '' for a quote)
    stay exact; the numbers of numeric payloads outside them are read; Octave's NA is NaN"""
    out, nums = [], []
    for k, part in enumerate(re.split(r"('(?:[^']|'')*')", v)):
        if k % 2:
            out.append(part)
            continue
        last = 0
        for m in _NUMERIC.finditer(part):
            out.append(part[last:m.start(1)])
            payload = re.sub(r"\bNA\b", "NaN", m.group(1))
            nums.extend(float(x) for x in _NUM.findall(payload))
            out.append(_NUM.sub("\0", payload))
            last = m.end(1)
        out.append(part[last:])
    return "".join(out), nums


def _answer(a):
    """an answer as a structure: a rule's "expect" (show.m's line of a call that printed nothing)
    becomes one; None (missing) and "timeout" stay"""
    return {"printed": "", "value": a} if isinstance(a, str) and a != "timeout" else a


def _is_error(a):
    return isinstance(a, dict) and "error" in a


def _no_answer(a):
    """missing, timed out, or cut off before its outcome"""
    return a is None or a == "timeout" or (isinstance(a, dict) and "incomplete" in a)


def _render(a, n=70):
    """an answer as a differs line shows it"""
    a = _answer(a)
    if a is None or a == "timeout":
        return "no answer"
    if "error" in a:
        s = "an error"
    elif "incomplete" in a:
        s = "no result"
    else:
        s = a["value"]
    if a["printed"]:
        s = "printed %r, then %s" % (a["printed"], s)
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n - 3] + "..."


# (per name, an absolute tolerance for numbers near zero: round-off of an exact zero in a
# least-squares or iterative result, which the catalog says can show (-0.0000))
ABS_TOLERANCE = {"polyfit": 1e-12, "integral": 1e-10, "fzero": 1e-12}


def _close(a, b, tol, atol=0.0):
    """two answers alike: the same outcome (a value or an error; an error's message is not
    compared), exactly the same printed text, and values whose texts are the same but for
    numbers within a relative tolerance tol or an absolute one atol"""
    a, b = _answer(a), _answer(b)
    if not (isinstance(a, dict) and isinstance(b, dict)):
        return False
    if "incomplete" in a or "incomplete" in b or a["printed"] != b["printed"]:
        return False
    if _is_error(a) or _is_error(b):
        return _is_error(a) and _is_error(b)
    (ta, na), (tb, nb) = _numbers(a["value"]), _numbers(b["value"])
    if ta != tb or len(na) != len(nb):
        return False

    def eq(x, y):
        if x != x or y != y:
            return x != x and y != y
        if x == y:
            return True
        return abs(x - y) <= max(tol * max(abs(x), abs(y)), atol)
    return all(eq(x, y) for x, y in zip(na, nb))


# (an argument Octave has no oracle for: its "..." is a char vector, as it has no string
# class; such calls' Sagebrush answers are listed for review, not compared)
NO_ORACLE = re.compile(r'"')


def _base_of(args, bs):
    """the example call a probe varies (one argument changed at most), or None"""
    a = split_args(args)
    return next((", ".join(b) for b in bs if len(b) == len(a) and sum(1 for i in range(len(a)) if a[i] != b[i]) <= 1), None)


def _rules(path):
    """the documented differences between Octave and MATLAB: [{name, args (a regular
    expression for the call's arguments), reason, and what MATLAB does: "when": "refused"
    (its page says the call is an error), or "expect", {args: MATLAB's answer as show.m
    prints it}; a rule with neither marks calls Octave is no oracle for (_rule_holds)}]"""
    return json.load(open(path)) if path and os.path.exists(path) else []


def _same(name, mine, theirs):
    """two answers alike (_close): numbers to 12 significant digits, or within the name's
    tolerances"""
    if name in TOLERANCE or name in ABS_TOLERANCE:
        return _close(mine, theirs, TOLERANCE.get(name, 0.0), ABS_TOLERANCE.get(name, 0.0))
    return _close(mine, theirs, 5e-13)


def _rule_holds(rule, p, mine):
    """how a matching rule classifies a call Octave answers differently: "documented" when
    Sagebrush does what the rule says MATLAB does (refuses, for "when": "refused"; gives the
    answer of the rule's "matlab" template, from --oracle, or of its "expect" for these
    arguments), "no_oracle" for a rule with none of these, when Sagebrush answers (an error
    or a timeout stays a difference), else None (a difference)"""
    if _no_answer(mine):
        return None
    if rule.get("when") == "refused":
        return "documented" if _is_error(mine) else None
    if "matlab" in rule or "expect" in rule:
        want = _answer(p.get("matlab") if "matlab" in rule else rule["expect"].get(p["args"]))
        if _no_answer(want) or _is_error(want):
            return None
        return "documented" if _same(p["name"], mine, want) else None
    return None if _is_error(mine) else "no_oracle"


def compare(probes_file, sb_file, out_file, rules_file=None):
    data = json.load(open(probes_file))
    sb = json.load(open(sb_file))
    rules = _rules(rules_file)
    es = {e["name"]: e for e in entries()}
    octave = {(p["name"], p["args"]): p["octave"] for p in data["probes"]}
    report = {}
    for p in data["probes"]:
        name = p["name"]
        r = report.setdefault(name, {"calls": 0, "differ": [], "octave_differs": [], "no_oracle": []})
        mine = next((g["sagebrush"] for g in sb.get(name, []) if g["args"] == p["args"]), None)
        base = _base_of(p["args"], bases(es[name])) if name in es else None
        # (no oracle: Octave has no string class, or it refuses the example call itself)
        rule = _rule_for(rules, name, p["args"])
        if rule is None and (NO_ORACLE.search(p["args"]) or _no_answer(p["octave"])
                             or (base is not None and _is_error(octave.get((name, base))))):
            if _no_answer(mine):
                # (no answer is a failure, oracle or not)
                r["differ"].append({"args": p["args"], "octave": p["octave"], "sagebrush": mine})
            else:
                r["no_oracle"].append({"args": p["args"], "sagebrush": mine})
            continue
        r["calls"] += 1
        d = {"args": p["args"], "octave": p["octave"], "sagebrush": mine}
        # (a rule covering the call decides it, whatever Octave says: it is there because
        # Octave is not MATLAB here; without one, Octave's answer is MATLAB's)
        if rule is None:
            if not _same(name, mine, p["octave"]):
                r["differ"].append(d)
            continue
        kind = _rule_holds(rule, p, mine)
        if kind == "documented":
            if not _same(name, mine, p["octave"]):
                r["octave_differs"].append(dict(d, reason=rule["reason"]))
        elif kind == "no_oracle":
            # (Octave is no oracle here and MATLAB's answer is not given: Sagebrush's answer is
            # listed, not counted as a match)
            r["calls"] -= 1
            r["no_oracle"].append({"args": p["args"], "sagebrush": mine, "reason": rule["reason"]})
        else:
            r["differ"].append(d)
    report = {"octave_version": data.get("octave_version"), "skipped": data.get("skipped", {}), "functions": report}
    json.dump(report, open(out_file, "w"), indent=1, sort_keys=True)
    report = report["functions"]
    bad = sorted(n for n, r in report.items() if r["differ"])
    print("%d functions, %d calls; %d differ (%d calls), %d documented Octave differences, %d calls without an oracle: %s" % (
        len(report), sum(r["calls"] for r in report.values()), len(bad), sum(len(r["differ"]) for r in report.values()),
        sum(len(r["octave_differs"]) for r in report.values()), sum(len(r["no_oracle"]) for r in report.values()), ", ".join(bad)))


# (the lines apply writes into an entry's differs, recognized when it writes them again)
GENERATED = ("It refuses some inputs Octave accepts", "It accepts some inputs Octave refuses",
             "On some inputs its answer differs from Octave's", "Some probe calls did not finish",
             "Found by a probe of edge values against GNU Octave")
PROBE_FILE = os.path.join("catalog", "matlab", "probes", "octave.json")


def _kind(d):
    mine, theirs = d["sagebrush"], d["octave"]
    if _no_answer(mine):
        return "timeout"
    if _is_error(mine) and not _is_error(theirs):
        return "refuses"
    if _is_error(theirs) and not _is_error(mine):
        return "accepts"
    return "value"


def apply(report_file):
    """from compare's report: catalog/matlab/probes/octave.json (each name's counts, its
    first differing calls, its documented Octave differences), and each probed entry's
    differs and status: an entry with an undocumented difference is partial, its differs
    saying how, with an example call of each kind"""
    rep = json.load(open(report_file))
    fns = rep["functions"]
    version = rep.get("octave_version") or "?"
    path = os.path.join(ROOT, PROBE_FILE)
    # (the entries an earlier apply made partial: full again once nothing differs)
    earlier = set(json.load(open(path)).get("made_partial", [])) if os.path.exists(path) else set()
    made = set()
    out = {"octave_version": version, "skipped": rep.get("skipped", {}), "functions": {}}
    for name, r in sorted(fns.items()):
        out["functions"][name] = {
            "calls": r["calls"], "differ": len(r["differ"]), "no_oracle": len(r["no_oracle"]),
            "first": [{"args": d["args"], "octave": d["octave"], "sagebrush": d["sagebrush"], "kind": _kind(d)}
                      for k in ("value", "refuses", "accepts", "timeout") for d in [x for x in r["differ"] if _kind(x) == k][:3]],
            "octave_differs": [{"args": d["args"], "reason": d["reason"]} for d in r["octave_differs"]]}
    changed = []
    for f in sorted(glob.glob(os.path.join(ROOT, "catalog", "matlab", "*.json"))):
        es = json.load(open(f, encoding="utf-8"))
        text = json.dumps(es)
        for e in es:
            r = fns.get(e["name"])
            if r is None:
                continue
            lines = [x for x in e.get("differs", []) if not x.startswith(GENERATED)]
            first = {}
            for d in r["differ"]:
                first.setdefault(_kind(d), d)
            n = e["name"]
            if "value" in first:
                d = first["value"]
                lines.append("On some inputs its answer differs from Octave's: %s(%s) gives %s where Octave gives %s." % (
                    n, d["args"], _render(d["sagebrush"]), _render(d["octave"])))
            if "refuses" in first:
                lines.append("It refuses some inputs Octave accepts, e.g. %s(%s)." % (n, first["refuses"]["args"]))
            if "accepts" in first:
                d = first["accepts"]
                lines.append("It accepts some inputs Octave refuses: %s(%s) gives %s." % (n, d["args"], _render(d["sagebrush"])))
            if "timeout" in first:
                lines.append("Some probe calls did not finish within the probe's time bound, e.g. %s(%s)." % (n, first["timeout"]["args"]))
            if first:
                lines.append("Found by a probe of edge values against GNU Octave %s (scripts/catalog-probe-matlab.py; %s)." % (version, PROBE_FILE))
                if e.get("status") == "full" or (n in earlier and e.get("status") == "partial"):
                    e["status"] = "partial"
                    made.add(n)
            elif n in earlier and e.get("status") == "partial":
                e["status"] = "full"
            e["differs"] = lines
        if json.dumps(es) != text:
            changed.append(os.path.basename(f))
            json.dump(es, open(f, "w", encoding="utf-8"), indent=2, ensure_ascii=False)
            open(f, "a").write("\n")
    out["made_partial"] = sorted(made)
    json.dump(out, open(path, "w"), indent=1, sort_keys=True, ensure_ascii=False)
    open(path, "a").write("\n")
    print("wrote %s; changed %s" % (PROBE_FILE, ", ".join(changed) or "nothing"))


def _timed(f, seconds):
    """f()'s result, or None when f takes longer than seconds"""
    t = time.monotonic()
    r = f()
    return r if time.monotonic() - t <= seconds else None


def self_test():
    """the comparison's own checks, among them the reviews' false matches; exits nonzero on a failure"""
    n = secrets.token_hex(16)
    end = "@@%s end@@\n" % n

    def rec(printed, kind, rest):
        return "%s@@%s %s@@\n%s\n%s" % (printed, n, kind, rest, end)

    def out(printed, kind, rest):
        return _parse(rec(printed, kind, rest), n)

    def call(k, body):
        return "@@%s call %d@@\n%s" % (n, k, body)

    def producer(text, tail=""):
        # (a process that prints text, then runs tail)
        return [sys.executable, "-c", "import sys, os; sys.stdout.write(%r); sys.stdout.flush(); %s" % (text, tail or "pass")]
    ok_hello = out("error\nhello\n", "value", "double 1x1 12")
    ok_world = out("error\nworld\n", "value", "double 1x1 12")
    refusal = out("", "error", "boom")
    char_10 = out("", "value", "char 1x23 ['@@show@@\ndouble 1x1 1.0']")
    char_1e0 = out("", "value", "char 1x23 ['@@show@@\ndouble 1x1 1e0']")
    good = call(0, rec("", "value", "double 1x1 1"))
    checks = [
        ("printed text that starts with error is not an error", not _is_error(ok_hello)),
        ("different printed texts differ", not _same("fprintf", ok_hello, ok_world)),
        ("a success is not a refusal", not _same("fprintf", ok_hello, refusal)),
        ("a marker-like text inside a char value stays char text", not _same("sprintf", char_10, char_1e0)),
        ("printed '1.0' and '1e0' differ", not _same("fprintf", out("1.0", "value", "double 1x1 3"), out("1e0", "value", "double 1x1 3"))),
        ("numbers agree to 12 significant digits", _same("sum", out("", "value", "double 1x2 [1 2.0000000000001]"), out("", "value", "double 1x2 [1 2]"))),
        ("a tiny number is not zero", not _same("sum", out("", "value", "double 1x1 1e-17"), out("", "value", "double 1x1 0"))),
        ("errors agree whatever their messages", _same("sum", refusal, out("", "error", "other"))),
        ("show.m failing after the value marker is an error", _is_error(_parse("@@%s value@@\npartial@@%s error@@\nboom\n%s" % (n, n, end), n))),
        ("output cut off before an outcome never matches", not _same("sum", _parse("half", n), _parse("half", n))),
        ("another run's marker is just text", "incomplete" in _parse("@@%s value@@\ndouble 1x1 1\n@@%s end@@\n" % ((secrets.token_hex(16),) * 2), n)),
        ("a rule's expect is a value that printed nothing", _same("mode", out("", "value", "double 1x1 NaN"), "double 1x1 NaN")),
        ("a refusal rule fails a value", _rule_holds({"when": "refused"}, {"args": "x"}, ok_hello) is None),
        ("a no-oracle rule never matches", _rule_holds({}, {"args": "x"}, ok_hello) == "no_oracle"),
        ("a printed CR is not an LF", not _same("fprintf", out("\r", "value", "double 1x1 1"), out("\n", "value", "double 1x1 1"))),
        ("a char CR is not an LF", not _same("sprintf", out("", "value", "char 1x1 ['\r']"), out("", "value", "char 1x1 ['\n']"))),
        ("a process's CR reaches the answer", _capture(producer("a\r\nb"), ".", 30)[0] == b"a\r\nb"),
        ("output past the cap kills the process", _capture(producer("", "sys.stdout.write('x' * 3000000)"), ".", 30, cap=1 << 20) == (None, "overflow")),
        ("stderr counts toward the cap", _capture([sys.executable, "-c", "import sys; sys.stderr.write('x' * 3000000)"], ".", 30, cap=1 << 20) == (None, "overflow")),
        ("an endless producer is stopped by the cap", _capture([sys.executable, "-c", "while True: print('x' * 1000)"], ".", 30, cap=1 << 20) == (None, "overflow")),
        ("a kill past the cap after the value marker leaves no answer", _capture(
            producer("@@%s call 0@@\n@@%s value@@\ndouble 1x1 " % (n, n), "sys.stdout.write('1' * 3000000)"), ".", 30, cap=1 << 20) == (None, "overflow")),
        ("a complete record from a process that then fails is no answer", _capture(producer(good, "sys.exit(3)"), ".", 30) == (None, "exit")),
        ("a process killed by a signal is no answer", _capture(producer(good, "os.kill(os.getpid(), 9)"), ".", 30) == (None, "exit")),
        ("a complete record from a successful process parses", _records(_capture(producer(good), ".", 30)[0].decode(), n, 1)[0].get("value") == "double 1x1 1"),
        ("an empty tail after the value marker is incomplete", "incomplete" in _parse("@@%s value@@\n" % n, n)),
        ("a partial show line without the end marker is incomplete", "incomplete" in _parse("@@%s value@@\ndouble 1x2 [1" % n, n)),
        ("text after the end marker is incomplete", "incomplete" in _parse(rec("", "value", "double 1x1 1") + "more", n)),
        ("two end markers are incomplete", "incomplete" in _parse(rec("", "value", "double 1x1 1") + end, n)),
        ("two value markers are incomplete", "incomplete" in _parse("@@%s value@@\nA\n@@%s value@@\nB\n%s" % (n, n, end), n)),
        ("an error marker before the value marker is incomplete", "incomplete" in _parse("@@%s error@@\nE\n@@%s value@@\nB\n%s" % (n, n, end), n)),
        ("two error markers are incomplete", "incomplete" in _parse("@@%s error@@\nE\n@@%s error@@\nF\n%s" % (n, n, end), n)),
        ("a duplicated call record is incomplete", ["incomplete" in r for r in _records(
            call(0, rec("", "value", "A")) + call(0, rec("", "value", "B")) + call(1, rec("", "value", "C")), n, 2)] == [True, True]),
        ("calls out of order are incomplete", all("incomplete" in r for r in _records(
            call(1, rec("", "value", "A")) + call(0, rec("", "value", "B")), n, 2))),
        ("an index not asked for makes the whole run incomplete", all("incomplete" in r for r in _records(
            call(0, rec("", "value", "A")) + call(1, rec("", "value", "B")) + call(7, ""), n, 2))),
        ("well-formed records parse", [r.get("value") for r in _records(
            "noise" + call(0, rec("", "value", "A")) + call(1, rec("hi", "error", "E")), n, 2)] == ["A", None]),
        ("an index longer than the harness writes makes the run incomplete, not a crash", all("incomplete" in r for r in _records(
            call(0, rec("", "value", "A")) + "@@%s call %s@@\n" % (n, "9" * 5000), n, 1))),
        ("a noncanonical index makes the run incomplete", all("incomplete" in r for r in _records(
            "@@%s call 00@@\n" % n + rec("", "value", "A"), n, 1))),
        ("a large well-formed run parses in linear time", (lambda r: r is not None and r[-1].get("value") == "double 1x1 99999"
                                                            and not any("incomplete" in x for x in r))(_timed(lambda: _records(
            "".join(call(k, rec("", "value", "double 1x1 %d" % k)) for k in range(100000)), n, 100000), 10))),
        ("a stream full of marker-shaped text parses in linear time", (lambda r: r is not None and all("incomplete" in x for x in r))(
            _timed(lambda: _records(call(0, rec("", "value", "A")) + call(0, "") * 200000, n, 100000), 10))),
        ("a template does not cover a string argument", _rule_for([{"name": "f", "args": ".", "matlab": "t"}], "f", '"abc"') is None),
        ("no answer fails every rule", all(_rule_holds(u, {"args": "x", "matlab": ok_hello}, a) is None
                                           for u in ({"when": "refused"}, {}, {"matlab": "t"}) for a in (None, "timeout", _parse("x", n)))),
    ]
    bad = [name for name, ok in checks if not ok]
    for name in bad:
        print("FAIL: " + name)
    print("%d of %d checks pass" % (len(checks) - len(bad), len(checks)))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["--generate"]:
        generate(a[1], a[2:])
    elif a[:1] == ["--run"]:
        run(a[1], a[2])
    elif a[:1] == ["--compare"]:
        compare(a[1], a[2], a[3], a[4] if len(a) > 4 else os.path.join(ROOT, "catalog", "matlab", "probes", "octave-differs.json"))
    elif a[:1] == ["--oracle"]:
        oracle(a[1], a[2] if len(a) > 2 else os.path.join(ROOT, "catalog", "matlab", "probes", "octave-differs.json"))
    elif a[:1] == ["--self-test"]:
        self_test()
    elif a[:1] == ["--apply"]:
        apply(a[1])
    else:
        print(__doc__)
