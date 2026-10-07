#!/usr/bin/env python3
"""Summarize a scripts/doctest-oracle.py report: each failing example with
Sagebrush's expected output and what Sage printed."""
import re, sys
t = open(sys.argv[1]).read()
for b in t.split("*" * 70):
    if "Failed example" not in b:
        continue
    m = re.search(r"in \w+\.t\d+_(\S+)", b)
    ex = re.search(r"Failed example:\n(.*?)\n(Expected|Exception raised)", b, re.S)
    exp = re.search(r"Expected:\n(.*?)\nGot:\n(.*)", b, re.S)
    print("==", m.group(1) if m else "?", "|", ex.group(1).strip()[:110] if ex else "")
    if exp:
        print("  ours:", exp.group(1).strip()[:400].replace("\n", "\n        "))
        print("  sage:", exp.group(2).strip()[:400].replace("\n", "\n        "))
    else:
        last = [l for l in b.split("\n") if l.strip()][-1]
        print("  sage raised:", last.strip()[:200])
