"""TOML to JSON with a real parser (Python's tomllib), for scripts/unsafe-inventory.mjs (#234 r3 U2-TOML):
manifests and cargo configs are read as TOML, never by regular expressions.

stdin: {"path": "text", ...}; stdout: {"path": parsed-table-or-{"__error__": message}, ...}.
"""
import json
import sys
import tomllib

out = {}
for path, text in json.load(sys.stdin).items():
    try:
        out[path] = tomllib.loads(text)
    except Exception as e:  # a file the parser rejects is reported, never skipped
        out[path] = {"__error__": f"{type(e).__name__}: {e}"}
json.dump(out, sys.stdout, default=str)
