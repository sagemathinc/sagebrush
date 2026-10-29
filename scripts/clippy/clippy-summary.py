#!/usr/bin/env python3
"""Summarize one `cargo clippy --message-format=json` run (FU-CI-CLIPPY r3).

Usage: python3 -I clippy-summary.py CLIPPY_JSON CARGO_RC PACKAGE_MANIFEST_SUFFIX
  e.g. ... out/clippy-all.json 101 engine/py/Cargo.toml

Everything is counted from the JSON, never from text. It prints three separate verdicts:
  COLLECTION complete | INCOMPLETE (...)  every line parses; exactly one build-finished record, whose
                                          `success` agrees with cargo's rc (rc 0 <=> success true)
  SUMMARY consistent | INCONSISTENT (...) rc 0 <=> no error anywhere; every error classified; no lint code with
                                          two groups
  CLEAN yes | no                          rc 0, no errors, collection complete and summary consistent
Exit status: 0 only if COLLECTION is complete and SUMMARY is consistent (a valid record; its findings can still
make CLEAN "no"). 1 otherwise. A run with errors is never called a pass: CLEAN says so.

Groups (python's R1): rustc emits a lint's level note ("`-D clippy::x` implied by `-D clippy::<group>`", or
"... (part of `#[warn(clippy::<group>)]`) on by default") only on that lint's FIRST diagnostic in each compile. So
pass 1 builds code -> group from every note, and pass 2 classifies each finding by its code. An error whose code
never carried a note is UNCLASSIFIED. A rustc lint (a code without `clippy::`) is group "rustc".

Attribution (python's R2, astra's binding): each finding is keyed by its package. Its package is the one whose
manifest_path ends with PACKAGE_MANIFEST_SUFFIX; the others are listed separately, as the record. --all-targets
checks the lib twice (the lib and its test build). Cargo gives both compiles the same `target` object, so the
multiplicity is the only record of them: identical findings (package, level, code, file, line, col, message) print
once, with xN.
"""
import json
import re
import sys
from collections import defaultdict

path, rc, suffix = sys.argv[1], int(sys.argv[2]), sys.argv[3]
implied = re.compile(r"implied by `-D clippy::([a-z_]+)`")
part_of = re.compile(r"part of `#\[(?:warn|deny|forbid)\(clippy::([a-z_]+)\)\]`")
SUMMARY_LINES = ("aborting due to", "could not compile", "warning emitted", "warnings emitted",
                 "error emitted", "errors emitted")

problems, records, finished = [], [], []
with open(path, encoding="utf-8", errors="strict") as f:
    for n, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except ValueError:
            problems.append(f"line {n} isn't JSON")
            continue
        if m.get("reason") == "build-finished":
            finished.append(m.get("success"))
        elif m.get("reason") == "compiler-message":
            records.append(m)

# pass 1: code -> groups, from every note in the run
groups_of = defaultdict(set)
for m in records:
    msg = m.get("message") or {}
    code = (msg.get("code") or {}).get("code") or ""
    for c in msg.get("children") or []:
        text = c.get("message") or ""
        for rx in (implied, part_of):
            g = rx.search(text)
            if g and code:
                groups_of[code].add(g.group(1))
two_groups = {c: sorted(g) for c, g in groups_of.items() if len(g) > 1}

# pass 2: classify and attribute
findings = {}  # key -> {"n": count, "targets": set, "group": g}
errors_all = 0
unclassified = []
for m in records:
    msg = m.get("message") or {}
    level = msg.get("level")
    if level not in ("error", "warning"):
        continue
    code = (msg.get("code") or {}).get("code") or ""
    text = (msg.get("message") or "-").splitlines()[0] if (msg.get("message") or "") else "-"
    if not code and text.startswith(SUMMARY_LINES):
        continue  # (cargo's and rustc's own tallies, not findings)
    if code in groups_of:
        group = "/".join(sorted(groups_of[code]))
    elif code.startswith("clippy::"):
        group = "default-warn" if level == "warning" else None
    elif code:
        group = "rustc"
    else:
        group = None
    if level == "error":
        errors_all += 1
        if group is None:
            group = "UNCLASSIFIED"
            unclassified.append(text[:120])
    elif group is None:
        group = "unclassified-warning"
    manifest = m.get("manifest_path") or ""
    pkg = "OURS" if manifest.endswith("/" + suffix) or manifest == suffix else (m.get("package_id") or manifest or "?")
    tgt = m.get("target") or {}
    target = "%s:%s" % (",".join(tgt.get("kind") or ["?"]), tgt.get("name") or "?")
    spans = msg.get("spans") or []
    span = next((s for s in spans if s.get("is_primary")), spans[0] if spans else {})
    key = (pkg, level, code or "-", span.get("file_name", "?"), span.get("line_start", "?"),
           span.get("column_start", "?"), text[:160])
    f = findings.setdefault(key, {"n": 0, "targets": set(), "group": group})
    f["n"] += 1
    f["targets"].add(target)

def tally(pkgsel):
    by = defaultdict(int)
    for (pkg, level, code, *_), f in findings.items():
        if pkgsel(pkg):
            by[(level, f["group"], code)] += 1
    return by

for scope, sel in (("sagebrush-py (OURS)", lambda p: p == "OURS"), ("other packages (record only)", lambda p: p != "OURS")):
    print(f"== {scope}")
    rows = [(k, f) for k, f in sorted(findings.items(), key=lambda kv: (kv[0][1], kv[0][2], kv[0][3], str(kv[0][4]))) if sel(k[0])]
    for (pkg, level, code, file, line, col, text), f in rows:
        who = "" if pkg == "OURS" else f" [{pkg}]"
        print(f"  {level:7} {code:42} {f['group']:14} {file}:{line}:{col} x{f['n']} ({' '.join(sorted(f['targets']))}){who}  {text}")
    t = tally(sel)
    print("  distinct findings by (level, group, code):", ", ".join(f"{lv}/{g}/{c} x{n}" for (lv, g, c), n in sorted(t.items())) or "none")

if two_groups:
    problems.append(f"codes with two groups: {two_groups}")
if len(finished) != 1:
    problems.append(f"{len(finished)} build-finished records")
elif finished[0] is not (rc == 0):
    problems.append(f"build-finished success={finished[0]} but cargo rc {rc}")
collection = not [p for p in problems if "two groups" not in p]
consistent = ((rc == 0) == (errors_all == 0)) and not unclassified and not two_groups
clean = collection and consistent and rc == 0 and errors_all == 0
print(f"cargo rc {rc}; error diagnostics (all packages, before de-duplication) {errors_all}; unclassified errors {len(unclassified)}")
print("COLLECTION " + ("complete" if collection else "INCOMPLETE (" + "; ".join(p for p in problems if "two groups" not in p) + ")"))
why = []
if (rc == 0) != (errors_all == 0):
    why.append(f"rc {rc} with {errors_all} errors")
if unclassified:
    why.append(f"unclassified: {unclassified[:3]}")
if two_groups:
    why.append(f"two groups: {two_groups}")
print("SUMMARY " + ("consistent" if consistent else "INCONSISTENT (" + "; ".join(why) + ")"))
print("CLEAN " + ("yes" if clean else "no"))
sys.exit(0 if collection and consistent else 1)
