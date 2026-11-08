# Runs test/expat_corpus.json's cases on this Python's pyexpat and prints a JSON summary (P3c-1): test/expat.test.ts
# runs it on the CLI (every case) and with python3 (the recording replays on CPython 3.14.10's own pyexpat);
# web/test-expat-worker.mjs runs the whole-document cases in the browser's worker. On Sagebrush (--sagebrush), a case
# listed in test/expat_divergences.json must give the result stated there, and still differ from CPython's; every
# other case must give CPython's.  Usage: expat_run.py [--sagebrush] [--whole] [--all-mismatches] [corpus divergences]
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else "."
sys.path.insert(0, HERE)
from expat_trace import trace  # noqa: E402
from xml.parsers import expat  # noqa: E402


def case_key(c):
    return "|".join((c["group"], c["label"], c["config"], c["chunking"], "d" if c["deferral"] else "n"))


def chunks_of(c):
    if "recipe" in c:
        doc = "".join(piece * count for piece, count in c["recipe"])
        cut = c["cuts"]
        return [doc[a:b] for a, b in zip([0] + cut, cut + [len(doc)])]
    return [bytes.fromhex(x) for x in c["chunks"]] if c["bytes"] else c["chunks"]


def run(corpus, divergences, sagebrush, whole, all_mismatches=False):
    stated = {d["key"]: d for d in divergences["cases"]} if sagebrush else {}
    out = {"cases": 0, "mismatches": [], "diverged": 0, "stated_but_same": [], "stated_but_other": []}
    for c in corpus["cases"]:
        if whole and c["chunking"] != "whole":
            continue
        o = dict(c["options"])
        o["deferral"] = c["deferral"]
        if o.get("handlers") is not None:
            o["handlers"] = set(o["handlers"])
        try:
            got = trace(expat, chunks_of(c), **o)
        except Exception as e:  # (a crash is a mismatch, reported as such)
            got = {"crash": f"{type(e).__name__}: {e}"}
        got = json.loads(json.dumps(got))
        out["cases"] += 1
        key = case_key(c)
        if key in stated:
            if got == c["result"]:
                out["stated_but_same"].append(key)
            elif got != stated[key]["sagebrush"]:
                out["stated_but_other"].append({"key": key, "got": got})
            else:
                out["diverged"] += 1
        elif got != c["result"]:
            out["mismatches"].append({"key": key, "want": c["result"], "got": got})
    out["mismatch_count"] = len(out["mismatches"])
    if not all_mismatches:
        out["mismatches"] = out["mismatches"][:20]
    return out


def main(argv):
    sagebrush = "--sagebrush" in argv
    whole = "--whole" in argv
    paths = [a for a in argv[1:] if not a.startswith("--")]
    corpus_path = paths[0] if paths else os.path.join(HERE, "expat_corpus.json")
    div_path = paths[1] if len(paths) > 1 else os.path.join(HERE, "expat_divergences.json")
    with open(corpus_path, encoding="utf-8") as f:
        corpus = json.load(f)
    with open(div_path, encoding="utf-8") as f:
        divergences = json.load(f)
    result = run(corpus, divergences, sagebrush, whole, "--all-mismatches" in argv)
    import pyexpat
    result["tables"] = {"codes": sorted(expat.errors.codes.items(), key=lambda kv: kv[1]),
                        "messages": sorted(expat.errors.messages.items()), "version_info": list(pyexpat.version_info),
                        "EXPAT_VERSION": pyexpat.EXPAT_VERSION, "features": [list(f) for f in pyexpat.features]}
    result["tables_equal"] = json.loads(json.dumps(result["tables"])) == corpus["tables"]
    del result["tables"]
    print(json.dumps(result))


if __name__ == "__main__":
    main(sys.argv)
