# A long parse for test/expat.test.ts's Stop pins (#849 r2; design note r3 section 4a): MODE "parse" (one Parse call
# over 28 MB of elements) or "expansion" (one Parse call whose entity references expand to 50 MB of text). It prints
# "begun" once the parse is well under way (from a handler), the caller sends SIGINT, and it prints one JSON line:
# the outcome, the events delivered and after the interrupt, both ledgers and what the parser still holds, and what
# a later Parse gives. (Sagebrush has no signal module: the interrupt comes from outside, as Ctrl-C does.)
import json
import sys

import pyexpat

mode = sys.argv[1]
seen = [0]
p = pyexpat.ParserCreate()
if mode == "parse":
    total = 2000000
    doc = b"<r>" + b"<a x='1'>t</a>" * total + b"</r>"

    def start(name, attrs):
        seen[0] += 1
        if seen[0] == 1000:
            print("begun", flush=True)

    p.StartElementHandler = start
else:
    total = 400000
    doc = b"<!DOCTYPE r [<!ENTITY e '" + b"x\ty " * 31 + b"'>]><r>" + b"&e;" * total + b"</r>"

    def data(text):
        seen[0] += 1
        if seen[0] == 1000:
            print("begun", flush=True)

    p.CharacterDataHandler = data
try:
    p.Parse(doc, True)
    outcome = "finished"
except KeyboardInterrupt:
    outcome = "KeyboardInterrupt"
at = seen[0]
w = p._work_counts()
held = [len(p._raw_parts), len(p._raw), len(p._text), len(p._buffer)]
try:
    p.Parse(b"<x/>", True)
    again = "ok"
except pyexpat.ExpatError as e:
    again = e.code
print(json.dumps({"outcome": outcome, "events": at, "total": total, "events_after": seen[0] - at, "owned": w["owned"],
                  "buffers": w["buffers"], "held": held, "again": again}))
