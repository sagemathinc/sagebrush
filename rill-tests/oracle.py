"""Rill's oracle runner (design/rill.md §7.1): run on the oracle host by run.py --regen, never in CI.

usage: python3 oracle.py RSCRIPT cases.json > results.json

Each case runs in a fresh `Rscript --vanilla -` with the pinned environment
(LC_ALL=C.UTF-8, TZ=UTC), its code on stdin after PRELUDE. PRELUDE pins the
printing options and, from inside that same R run, writes the environment
that output depends on (R version, platform, locale, time zone, options,
loaded namespaces' versions) to a side file named by RILL_PROV, which is
returned with the case's stdout, stderr and exit status.

R is used only as a black box: cases call functions and print values; no R
function's source is printed, deparsed or read.
"""
import json
import os
import subprocess
import sys
import tempfile

ENV = {"LC_ALL": "C.UTF-8", "TZ": "UTC"}

PRELUDE = r'''local({
  options(width = 80, digits = 7, scipen = 0, OutDec = ".")
  .p <- Sys.getenv("RILL_PROV")
  if (nzchar(.p)) {
    q <- function(s) encodeString(as.character(s), quote = '"')
    ns <- sort(loadedNamespaces())
    v <- vapply(ns, function(n) as.character(packageVersion(n)), "")
    kv <- c(
      sprintf('"R.version.string": %s', q(R.version.string)),
      sprintf('"platform": %s', q(R.version$platform)),
      sprintf('"locale": %s', q(Sys.getlocale())),
      sprintf('"timezone": %s', q(Sys.timezone())),
      sprintf('"options": {"width": %d, "digits": %d, "scipen": %d, "OutDec": %s}',
              getOption("width"), getOption("digits"), as.integer(getOption("scipen")), q(getOption("OutDec"))),
      sprintf('"namespaces": {%s}', paste(sprintf('%s: %s', q(ns), q(v)), collapse = ", "))
    )
    writeLines(c("{", paste(kv, collapse = ",\n"), "}"), .p)
  }
  invisible(NULL)
})
'''


def main():
    rscript, cases_path = sys.argv[1], sys.argv[2]
    cases = json.load(open(cases_path, encoding="utf-8"))
    out = []
    with tempfile.TemporaryDirectory() as d:
        for c in cases:
            prov = os.path.join(d, "prov.json")
            if os.path.exists(prov):
                os.unlink(prov)
            env = dict(os.environ, RILL_PROV=prov, **ENV)
            p = subprocess.run([rscript, "--vanilla", "-"], input=PRELUDE + c["code"], capture_output=True,
                               text=True, timeout=120, env=env)
            record = open(prov, encoding="utf-8").read() if os.path.exists(prov) else None
            out.append({"file": c["file"], "id": c["id"], "stdout": p.stdout, "stderr": p.stderr,
                        "status": p.returncode, "provenance": record})
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
