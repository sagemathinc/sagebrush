"""sagebrush bench: rerun the benchmarks behind Sagebrush's performance
claims, against the other systems installed on this machine.

    sagebrush bench [SUITE ...] [--quick | --large] [--json OUT.json]
                    [--repeat N] [--timeout SECONDS] [--no-competitors]
    sagebrush bench --list

With no SUITE, every suite runs. The inputs are fixed (committed lists, in
sagebrush/bench/data). Each case is in a tier: --quick runs the quick cases
(a few minutes at most for everything), the default adds the standard ones,
and --large adds the largest ones (hours).

Competitors (PARI/GP, ...) run only if they are installed, each as its own
process, as a black box; a missing one shows "not installed". Each engine
times itself in its own process (see sagebrush.bench._timing), and every
answer is compared across the engines: a disagreement shows MISMATCH and
makes the exit status 1, as does an error in Sagebrush.

Times are per call: the median of --repeat samples (default 3), with the
range, as a percentage of the median; * marks a Sagebrush answer that is
not certified. A column a/b is engine a's median over engine b's: below 1 means a
is faster. Where Sagebrush has a faster mode with a weaker guarantee (the
quadratic class groups without the analytic certificate), it is a column of
its own, labelled as such; the default call is always the first. --json also writes the host (CPU, cores, OS, versions)
and every sample.

Competitors: PARI/GP is $SAGEBRUSH_BENCH_GP, else gp on the PATH. FLINT is
found by pkg-config ($SAGEBRUSH_BENCH_FLINT_PREFIX: a prefix with
lib/pkgconfig/flint.pc), and a small harness (flint_harness.c) is compiled
against it with the C compiler, into ~/.cache/sagebrush/bench. Sage is
$SAGEBRUSH_BENCH_SAGE, else sage on the PATH, running sage_driver.py.
An answer recorded in results/ (where no competitor runs) is checked too."""

import argparse
import json
import signal
import sys

from . import _timing
from ._timing import host
from .suite import TIERS, EngineTimeout

SCHEMA = "sagebrush-bench/1"


def suites():
    from . import suite_ap, suite_charpoly, suite_linalg, suite_nf, suite_quad, suite_sagelayer

    return [suite_quad.IMAG, suite_quad.REAL, suite_nf.NF, suite_linalg.LINALG,
            suite_sagelayer.SAGELAYER, suite_charpoly.CHARPOLY, suite_ap.AP]


def fmt(seconds):
    if seconds < 1e-3:
        return f"{seconds * 1e3:.4f} ms"
    if seconds < 1:
        return f"{seconds * 1e3:.3g} ms"
    return f"{seconds:.3g} s"


def _cell(r):
    if r["status"] != "ok":
        return r["status"]
    s = fmt(r["median_s"])
    if len(r["times_s"]) > 1:
        lo, hi = r["min_s"], r["max_s"]
        s += f" ({(hi - lo) / r['median_s'] * 100:.0f}%)"
    if isinstance(r["answer"], dict) and r["answer"].get("certified") is False:
        s += " *"
    return s


def run_suite(suite, tiers, repeat, timeout, competitors, out=sys.stdout):
    engines = suite.engines()
    names = [e.name for e in engines]
    ours = [e for e in engines if e.ours]
    theirs = [e for e in engines if not e.ours]
    pairs = [(a, b) for a in ours for b in theirs]
    meta = {"name": suite.name, "title": suite.title, "claim": suite.claim,
            "reproduce": f"sagebrush bench {suite.name}", "engines": {}, "results": []}
    usable = []
    for e in engines:
        m = meta["engines"][e.name] = {"label": e.label, "ours": e.ours}
        if not e.ours and not competitors:
            m["status"] = "skipped"
        elif not e.available():
            m["status"] = "not installed"
            if getattr(e, "why", None):
                m["error"] = e.why
        else:
            try:
                m.update(status="ok", version=e.version())
                usable.append(e)
            except Exception as x:
                m.update(status="error", error=str(x)[:500])
    try:
        return _run_cases(suite, tiers, repeat, timeout, out, engines, usable, meta, pairs, ours)
    finally:
        for e in engines:
            e.close()


def _run_cases(suite, tiers, repeat, timeout, out, engines, usable, meta, pairs, ours):
    names = [e.name for e in engines]
    cases = [c for c in suite.cases() if c.tier in tiers]
    print(f"\n== {suite.name}: {suite.title}", file=out)
    print(f"   claim: {suite.claim}", file=out)
    for e in engines:
        m = meta["engines"][e.name]
        v = m.get("version") or m.get("error")
        print(f"   {e.name}: {e.label}: {m['status']}{' (' + v + ')' if v else ''}", file=out)
    head = f"{'case':<36}" + "".join(f"{n:>22}" for n in names)
    widths = [max(10, len(a.short) + len(b.short) + 3) for a, b in pairs]
    head += "".join(f"{a.short + '/' + b.short:>{w}}" for (a, b), w in zip(pairs, widths))
    head += f"{'check':>10}"
    print(head, file=out)
    bad = False
    for case in cases:
        row = {"case": case.label, "params": case.params, "tier": case.tier, "engines": {},
               "ratios": {}}
        answers = []
        for e in engines:
            if e not in usable:
                row["engines"][e.name] = {"status": meta["engines"][e.name]["status"]}
                continue
            try:
                t = e.run(case, repeat, timeout)
            except EngineTimeout as x:
                row["engines"][e.name] = {"status": "timeout", "error": str(x)}
                continue
            except Exception as x:
                row["engines"][e.name] = {"status": "error", "error": f"{type(x).__name__}: {x}"[:500]}
                continue
            row["engines"][e.name] = {
                "status": "ok", "median_s": t.median, "min_s": min(t.times),
                "max_s": max(t.times), "times_s": t.times, "calls_per_sample": t.calls,
                "answer": t.answer}
            answers.append(t.answer)
        if case.expected is not None:
            row["expected"] = case.expected
            answers.append(case.expected)
        if len(answers) < 2:
            row["check"] = "-"
        elif all(suite.same(answers[0], a) for a in answers[1:]):
            row["check"] = "agree"
        else:
            row["check"] = "MISMATCH"
            bad = True
        if any(row["engines"][e.name]["status"] != "ok" for e in ours):
            bad = True
        line = f"{case.label[:35]:<36}" + "".join(f"{_cell(row['engines'][n]):>22}" for n in names)
        for (a, b), w in zip(pairs, widths):
            x, y = row["engines"][a.name], row["engines"][b.name]
            ratio = x["median_s"] / y["median_s"] if x["status"] == y["status"] == "ok" else None
            row["ratios"][f"{a.name}/{b.name}"] = ratio
            line += f"{(f'{ratio:.2f}' if ratio is not None else '-'):>{w}}"
        print(line + f"{row['check']:>10}", file=out, flush=True)
        for n in names:
            if row["engines"][n]["status"] == "error" and "error" in row["engines"][n]:
                print(f"   {n} error: {row['engines'][n]['error']}", file=out)
        meta["results"].append(row)
    return meta, bad


def markdown(report, out=sys.stdout):
    """A saved run (--json) as Markdown: the host, then a table per suite."""
    h = report["host"]
    sb = h["sagebrush"]
    print(f"{h['cpu']}, {h['cores']} cores, {h['os']}, {h['python']}; sagebrush "
          f"{sb.get('version') or '?'}{' (' + sb['git'] + ')' if sb.get('git') else ''}; "
          f"{h['date']}; load average {h.get('load_start')} at the start, {h.get('load_end')} at the end; "
          f"{report['repeat']} samples per case, the median.", file=out)
    for s in report["suites"]:
        print(f"\n### {s['name']}: {s['title']}\n", file=out)
        print(f"Reproduce with `{s['reproduce']}`.\n", file=out)
        for name, e in s["engines"].items():
            v = e.get("version") or e.get("error") or ""
            print(f"- {name}: {e['label']}{' (' + v + ')' if v else ''}{'' if e['status'] == 'ok' else ': ' + e['status']}", file=out)
        names = list(s["engines"])
        ratios = list(s["results"][0]["ratios"]) if s["results"] else []
        print("\n| case | " + " | ".join(names) + "".join(f" | {r}" for r in ratios) + " | check |", file=out)
        print("|---" + "|---:" * (len(names) + len(ratios)) + "|---|", file=out)
        for r in s["results"]:
            cells = []
            for n in names:
                e = r["engines"][n]
                c = fmt(e["median_s"]) if e["status"] == "ok" else e["status"]
                if e["status"] == "ok" and isinstance(e["answer"], dict) and e["answer"].get("certified") is False:
                    c += " *"
                cells.append(c)
            rs = [f"{r['ratios'][k]:.2f}" if r["ratios"].get(k) is not None else "-" for k in ratios]
            print(f"| {r['case']} | " + " | ".join(cells + rs) + f" | {r['check']} |", file=out)


def main(argv=None):
    p = argparse.ArgumentParser(prog="sagebrush bench", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="\n\n".join(__doc__.split("\n\n")[2:]))
    p.add_argument("suite", nargs="*", help="suites to run (default: all; see --list)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--quick", action="store_true", help="only the quick cases")
    g.add_argument("--large", action="store_true", help="also the largest cases (hours)")
    g.add_argument("--tiers", help="exactly these tiers, comma-separated (quick,standard,large)")
    p.add_argument("--json", metavar="OUT", help="also write the results as JSON to OUT")
    p.add_argument("--repeat", type=int, default=3, help="samples per case (default 3)")
    p.add_argument("--timeout", type=float, default=900,
                   help="seconds a competitor may take on one case (default 900)")
    p.add_argument("--no-competitors", action="store_true", help="time Sagebrush only")
    p.add_argument("--list", action="store_true", help="list the suites and their claims")
    p.add_argument("--markdown", metavar="RUN", help="print a saved run (--json) as Markdown tables")
    a = p.parse_args(argv)
    if a.markdown:
        with open(a.markdown) as f:
            markdown(json.load(f))
        return 0
    all_suites = suites()
    by_name = {s.name: s for s in all_suites}
    if a.list:
        for s in all_suites:
            counts = {t: sum(c.tier == t for c in s.cases()) for t in TIERS}
            print(f"{s.name:<12} {s.title}\n{'':<12} claim: {s.claim}\n{'':<12} cases: "
                  + ", ".join(f"{counts[t]} {t}" for t in TIERS))
        return 0
    unknown = [n for n in a.suite if n not in by_name]
    if unknown:
        p.error(f"unknown suite {', '.join(unknown)} (suites: {', '.join(by_name)})")
    if a.repeat < 1:
        p.error("--repeat must be at least 1")
    chosen = [by_name[n] for n in a.suite] if a.suite else all_suites
    if a.tiers:
        tiers = tuple(t for t in TIERS if t in a.tiers.split(","))
        bad_tiers = set(a.tiers.split(",")) - set(TIERS)
        if bad_tiers or not tiers:
            p.error(f"--tiers: choose from {', '.join(TIERS)}")
    else:
        tiers = TIERS[:1] if a.quick else TIERS if a.large else TIERS[:2]
    # a terminated run stops its competitors' processes too (run_suite's
    # finally closes them)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    h = host()
    print(f"host: {h['cpu']}, {h['cores']} cores ({h['usable_cores']} usable), {h['os']}, "
          f"{h['python']}; sagebrush {h['sagebrush']['version'] or '?'}"
          f"{' git ' + h['sagebrush']['git'] if h['sagebrush']['git'] else ''}")
    print(f"tiers: {', '.join(tiers)}; {a.repeat} samples per case; times per call; "
          "a/b below 1: a faster")
    report = {"schema": SCHEMA, "host": h, "tiers": list(tiers), "repeat": a.repeat,
              "timeout_s": a.timeout, "suites": []}
    bad = False
    for s in chosen:
        meta, b = run_suite(s, tiers, a.repeat, a.timeout, not a.no_competitors)
        report["suites"].append(meta)
        bad = bad or b
        if a.json:  # after each suite, so an interrupted run keeps what it has
            with open(a.json, "w") as f:
                json.dump(report, f, indent=1)
    report["host"]["load_end"] = _timing.load()
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1)
    lo, hi = h["load_start"], report["host"]["load_end"]
    if lo and hi:
        print(f"\nload average (1 min) {lo[0]} at the start, {hi[0]} at the end")
    print("\nFAILED: a mismatch or a Sagebrush error (above)" if bad else "\nall answers agree")
    return 1 if bad else 0
