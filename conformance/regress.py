"""Compare the latest run (/tmp/conformance-results.json) to a saved one.
    python3 conformance/regress.py /tmp/conf-prev.json"""
import json, sys
old = {r["id"]: r["status"] for r in json.load(open(sys.argv[1]))}
new = {r["id"]: r["status"] for r in json.load(open(sys.argv[2] if len(sys.argv) > 2 else "/tmp/conformance-results.json"))}
lost = sorted(k for k in new if old.get(k) == "pass" and new[k] != "pass")
gained = sorted(k for k in new if old.get(k) != "pass" and new[k] == "pass")
print("gained", len(gained), " ".join(x.split("/")[-1] for x in gained))
print("LOST", len(lost), " ".join(lost))
