r"""Write a public corpus summary for the function search's area lines (web/coverage-areas.mts) from a corpus run's results.

    python3 scripts/coverage-summary.py RESULTS.json --id ID --mode MODE --title TITLE --source URL \\
        --licence LICENCE --oracle ORACLE --commit SHA --date YYYY-MM-DD [--sections REGEX | --whole] \
        > web/docs/coverage/corpora/ID.json

RESULTS is a run's JSON, as the corpus runners write it: {"cases": [{"id": ..., "outcome": ...}, ...]}.  A case's
section is the first group of REGEX matched against its id (default: what comes before a final ":<n>" or "-<n>",
as in "classes:309" or "ch01-000"; the Magma Handbook's "H1E1" needs '^(H\d+)E\d+$').  An id that doesn't match,
or every id with --whole, is in the section "all".  The summary has numbers only, per section: how many examples ran, how
many matched and how many gave a wrong answer.  It never holds a case's code or output, so it can be public whatever
the corpus's licence.  Only corpora whose sources are public go on the page (W7 ruling 2).
"""
import argparse, collections, json, re, sys

# ("design": a reviewed deliberate difference, corpus/<name>/design.txt in the Sage runner: it ran, and counts as
# neither a match nor a wrong answer)
OUTCOMES = {"match", "refused", "wrong", "error", "timeout", "design"}

a = argparse.ArgumentParser()
a.add_argument("results")
for k in ("id", "mode", "title", "source", "licence", "oracle", "commit", "date"):
    a.add_argument("--" + k, required=True)
a.add_argument("--sections", default=r"^(.*?)[:-]\d+$")
a.add_argument("--whole", action="store_true")
o = a.parse_args()
section_re = re.compile(o.sections)

cases = json.load(open(o.results))["cases"]
sections = collections.defaultdict(lambda: {"run": 0, "match": 0, "wrong": 0})
for c in cases:
    if c["outcome"] == "excluded":  # (not scored: the corpus's own reasons, in its README)
        continue
    if c["outcome"] not in OUTCOMES:
        sys.exit(f"coverage-summary: case {c['id']}: unknown outcome {c['outcome']!r}")
    m = None if o.whole else section_re.match(c["id"])
    s = sections[m.group(1) if m else "all"]
    s["run"] += 1
    if c["outcome"] in ("match", "wrong"):
        s[c["outcome"]] += 1

out = {"id": o.id, "mode": o.mode, "title": o.title, "source": o.source, "licence": o.licence, "oracle": o.oracle,
       "commit": o.commit, "date": o.date, "sections": dict(sorted(sections.items()))}
json.dump(out, sys.stdout, indent=1)
sys.stdout.write("\n")
