#!/usr/bin/env python3
"""The Terminal's python commands' oracle (plan-term-3a r1.7 §5): each case of test/term-cmd-cases.json run by CPython
3.14.10 as `exec -a ARGV0 python3.14 ARGS...` in a fresh temporary folder holding the case's files, its stdin the
case's bytes (or an empty /dev/null when not redirected), and its stdout, stderr and exit status recorded in
test/term-cmd-oracle.json, with provenance: this generator's and the cases' sha256, and sys.version.

One stated substitution: the temporary folder's absolute path becomes /w, the test workspace's folder.  Nothing else is
rewritten.  The test (web/shell/term-bridge-cases.js, through test/term-cmd-oracle.test.ts's provenance check) checks
both hashes against the committed files.

  python3 test/gen_term_cmd_cases.py /path/to/python3.14     (CPython 3.14.10; writes test/term-cmd-oracle.json)
"""
import hashlib, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = os.path.join(HERE, "term-cmd-cases.json")
OUT = os.path.join(HERE, "term-cmd-oracle.json")


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    py = os.path.realpath(sys.argv[1])
    version = subprocess.run([py, "-c", "import sys; print(sys.version)"], capture_output=True, text=True, check=True).stdout.strip()
    if not version.startswith("3.14.10"):
        sys.exit(f"the oracle is CPython 3.14.10, not {version}")
    cases = json.load(open(CASES, encoding="utf-8"))["cases"]
    records = []
    for c in cases:
        with tempfile.TemporaryDirectory() as d:
            d = os.path.realpath(d)
            for name, text in c["files"].items():
                p = os.path.join(d, name)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                with open(p, "w", encoding="utf-8") as f:
                    f.write(text)
            stdin = subprocess.DEVNULL if c["stdin"] is None else None
            data = None if c["stdin"] is None else c["stdin"].encode("utf-8")
            # (exec -a: CPython's messages name the command as typed, argv0)
            r = subprocess.run(["bash", "-c", 'exec -a "$0" "$@"', c["argv0"], py, *c["argv"]], cwd=d, input=data, stdin=stdin, capture_output=True,
                               env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "PYTHONIOENCODING": "utf-8", "COLUMNS": "100", "LINES": "30"})
            sub = lambda b: b.decode("utf-8").replace(d, "/w")
            records.append({"name": c["name"], "stdout": sub(r.stdout), "stderr": sub(r.stderr), "code": r.returncode})
    out = {
        "provenance": {"generator_sha256": sha(__file__), "cases_sha256": sha(CASES), "python": version},
        "records": records,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"{len(records)} cases recorded with {version.split()[0]}")


if __name__ == "__main__":
    main()
