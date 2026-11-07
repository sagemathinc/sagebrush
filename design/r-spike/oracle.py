"""Run each corpus case in a fresh real-R session (black box) and record its output.

usage: python3 oracle.py RSCRIPT corpus.R > oracle.json

Cases are separated by lines starting "#-- <id>". Each case is fed to
`Rscript --vanilla -` on stdin; stdout and stderr are recorded verbatim.
Only outputs are recorded: no R function is printed or deparsed.
"""
import json, subprocess, sys


def cases(path):
    out, cur, name = [], [], None
    for line in open(path, encoding="utf-8"):
        if line.startswith("#--"):
            if name is not None:
                out.append((name, "".join(cur)))
            name, cur = line[3:].strip(), []
        elif name is not None:
            cur.append(line)
    if name is not None:
        out.append((name, "".join(cur)))
    return out


def main():
    rscript, corpus = sys.argv[1], sys.argv[2]
    res = []
    for name, code in cases(corpus):
        p = subprocess.run([rscript, "--vanilla", "-"], input=code, capture_output=True, text=True, timeout=60)
        res.append({"id": name, "code": code, "stdout": p.stdout, "stderr": p.stderr, "rc": p.returncode})
    json.dump(res, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
