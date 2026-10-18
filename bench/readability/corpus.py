#!/usr/bin/env python3
"""VM-only, fixed JSON-ABI before/after corpus; retain exact public outputs."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent


def run(case, args):
    path = args.out / (case["id"] + ".json")
    if path.exists():
        raise RuntimeError(f"refusing to overwrite {path}")
    env = {k: v for k, v in os.environ.items() if not k.startswith("QCL_")}
    start = time.monotonic()
    try:
        p = subprocess.run([str(args.binary.resolve()), json.dumps(case["request"])],
                           capture_output=True, text=True, env=env, timeout=args.timeout)
        result = {"exit_code": p.returncode, "stdout": p.stdout, "stderr": p.stderr}
        if p.returncode == 0:
            result["response"] = json.loads(p.stdout)
    except subprocess.TimeoutExpired:
        result = {"timed_out": True}
    record = {"id": case["id"], "request": case["request"], "sha": args.sha,
              "seconds": round(time.monotonic() - start, 3), **result}
    path.write_text(json.dumps(record, indent=2) + "\n")
    print(case["id"], record["seconds"], "timeout" if result.get("timed_out") else result.get("exit_code"), flush=True)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=HERE / "corpus.json")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--sha")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--jobs", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--compare", nargs=2, type=Path)
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text())
    if args.compare:
        mismatches, incomplete = [], []
        for case in cases:
            name = case["id"] + ".json"
            paths = [d / name for d in args.compare]
            if not all(p.exists() for p in paths):
                incomplete.append(case["id"])
                continue
            left, right = [json.loads(p.read_text()) for p in paths]
            if "response" not in left or "response" not in right:
                incomplete.append(case["id"])
            elif left["response"] != right["response"]:
                mismatches.append({"id": case["id"], "before": left["response"], "after": right["response"]})
        print(json.dumps({"cases": len(cases), "identical": len(cases)-len(mismatches)-len(incomplete),
                          "mismatches": mismatches, "incomplete": incomplete}, indent=2))
        raise SystemExit(bool(mismatches or incomplete))
    if not args.binary or not args.out or not args.sha:
        parser.error("running requires --binary, --out and --sha")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "manifest.json").write_text(json.dumps({"sha": args.sha, "cases": len(cases),
        "corpus_sha256": hashlib.sha256(args.cases.read_bytes()).hexdigest()}, indent=2))
    with ThreadPoolExecutor(max_workers=args.jobs) as executor:
        futures = [executor.submit(run, case, args) for case in cases]
        for future in as_completed(futures):
            future.result()


if __name__ == "__main__":
    main()
